from __future__ import annotations

import json
import math
import re
from pathlib import Path
from urllib.request import Request, urlopen


APP_DIR = Path(__file__).resolve().parent
ROOT_DIR = APP_DIR.parent
DEFAULT_EXCHANGE_RATE_CACHE_PATH = ROOT_DIR / ".listing_search_cache" / "exchange_rates.json"
EXCHANGE_RATE_SERIES = {
    "usd_to_cad": "FXUSDCAD",
    "cny_to_cad": "FXCNYCAD",
}
EXCHANGE_RATE_TIMEOUT_SECS = 20
CANONICAL_PRICE_CURRENCY = "cny"
DEFAULT_SOURCE_PRICE_CURRENCY = "cny"
SUPPORTED_PRICE_CURRENCIES = {"usd", "cad", "cny"}
PRICE_RE = re.compile(r"-?\d+(?:\.\d+)?")
COMMON_CSV_HEADERS = [
    "offer_id",
    "title",
    "price",
    "price_currency",
    "price_value",
    "price_original",
    "price_original_currency",
    "price_original_value",
    "price_exchange_source",
    "price_exchange_date",
    "sales",
    "sugargoo_url",
    "source_url",
    "source_1688_url",
    "image_url",
    "image_file",
]


def clean_text(value: object) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()


def clean_currency_code(value: object) -> str:
    normalized = clean_text(value).lower()
    return normalized if normalized in SUPPORTED_PRICE_CURRENCIES else ""


def coerce_number(value: object) -> float | None:
    if value is None:
        return None
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        numeric = float(value)
        return numeric if math.isfinite(numeric) else None

    match = PRICE_RE.search(clean_text(value).replace(",", ""))
    if not match:
        return None
    try:
        numeric = float(match.group(0))
    except ValueError:
        return None
    return numeric if math.isfinite(numeric) else None


def parse_price_value(price_text: str) -> float | None:
    return coerce_number(price_text)


def detect_price_currency_marker(price_text: object) -> str:
    text = clean_text(price_text)
    if not text:
        return ""

    upper = text.upper()
    if "CA$" in upper or "C$" in upper or "CAD" in upper:
        return "cad"
    if "￥" in text or "¥" in text or "CNY" in upper or "RMB" in upper or "CN¥" in upper:
        return "cny"
    if "US$" in upper or "USD" in upper:
        return "usd"
    if "$" in text:
        return "usd"
    return ""


def detect_price_currency(price_text: str, *, fallback: str = "") -> str:
    marker_currency = detect_price_currency_marker(price_text)
    if marker_currency:
        return marker_currency
    return clean_currency_code(fallback) or DEFAULT_SOURCE_PRICE_CURRENCY


def normalize_source_currency(price_text: object, currency: object = "") -> str:
    source_text = clean_text(price_text)
    explicit_currency = clean_currency_code(currency)
    if not source_text and not explicit_currency:
        return ""
    marker_currency = detect_price_currency_marker(source_text)
    if marker_currency:
        return marker_currency
    return explicit_currency or DEFAULT_SOURCE_PRICE_CURRENCY


def format_price_amount(value: float) -> str:
    rounded = f"{float(value):.4f}"
    if "." not in rounded:
        return f"{rounded}.00"
    whole, fraction = rounded.split(".", 1)
    fraction = fraction.rstrip("0")
    if len(fraction) < 2:
        fraction = fraction.ljust(2, "0")
    return f"{whole}.{fraction}"


def format_price_text(value: float, currency: str) -> str:
    code = clean_currency_code(currency) or CANONICAL_PRICE_CURRENCY
    prefixes = {
        "usd": "US$",
        "cad": "CA$",
        "cny": "￥",
    }
    return f"{prefixes[code]}{format_price_amount(value)}"


def convert_currency_value(value: float | None, from_currency: str, to_currency: str, rates: dict[str, object]) -> float | None:
    if value is None or not math.isfinite(value):
        return None

    source = clean_currency_code(from_currency)
    target = clean_currency_code(to_currency)
    if not source or not target:
        return None
    if source == target:
        return float(value)

    usd_to_cad = coerce_number(rates.get("usd_to_cad"))
    cny_to_cad = coerce_number(rates.get("cny_to_cad"))
    if not usd_to_cad or not cny_to_cad or usd_to_cad <= 0 or cny_to_cad <= 0:
        return None

    if source == "cad":
        value_in_cad = float(value)
    elif source == "usd":
        value_in_cad = float(value) * usd_to_cad
    else:
        value_in_cad = float(value) * cny_to_cad

    if target == "cad":
        return value_in_cad
    if target == "usd":
        return value_in_cad / usd_to_cad
    return value_in_cad / cny_to_cad


def fetch_latest_series_value(series_name: str) -> tuple[float, str]:
    request = Request(
        f"https://www.bankofcanada.ca/valet/observations/{series_name}/json",
        headers={"User-Agent": "Mozilla/5.0 ListingSearch/1.0"},
    )
    with urlopen(request, timeout=EXCHANGE_RATE_TIMEOUT_SECS) as response:
        payload = json.load(response)
    observations = payload.get("observations") if isinstance(payload, dict) else None
    if not isinstance(observations, list) or not observations:
        raise RuntimeError(f"No observations returned for {series_name}.")
    for observation in reversed(observations):
        if not isinstance(observation, dict):
            continue
        series_payload = observation.get(series_name)
        if not isinstance(series_payload, dict):
            continue
        raw_value = series_payload.get("v")
        if raw_value in {None, ""}:
            continue
        return float(raw_value), str(observation.get("d") or "")
    raise RuntimeError(f"No usable exchange-rate value returned for {series_name}.")


def fetch_bank_of_canada_exchange_rates() -> dict[str, object]:
    usd_to_cad, usd_date = fetch_latest_series_value(EXCHANGE_RATE_SERIES["usd_to_cad"])
    cny_to_cad, cny_date = fetch_latest_series_value(EXCHANGE_RATE_SERIES["cny_to_cad"])
    if cny_to_cad <= 0:
        raise RuntimeError("Received invalid CNY exchange rate.")
    return {
        "ready": True,
        "loading": False,
        "source": "Bank of Canada",
        "source_date": max(usd_date, cny_date),
        "usd_to_cad": usd_to_cad,
        "usd_to_cny": usd_to_cad / cny_to_cad,
        "cny_to_cad": cny_to_cad,
        "error": "",
    }


def read_exchange_rate_cache(cache_path: Path = DEFAULT_EXCHANGE_RATE_CACHE_PATH) -> dict[str, object]:
    if not cache_path.is_file():
        return {}
    try:
        payload = json.loads(cache_path.read_text(encoding="utf-8"))
    except Exception:
        return {}
    return payload if isinstance(payload, dict) else {}


def load_or_refresh_exchange_rates(
    cache_path: Path = DEFAULT_EXCHANGE_RATE_CACHE_PATH,
    *,
    prefer_cache: bool = False,
) -> dict[str, object]:
    cached = read_exchange_rate_cache(cache_path)
    if prefer_cache and cached.get("ready") and not cached.get("error"):
        return cached

    try:
        fresh = fetch_bank_of_canada_exchange_rates()
    except Exception:
        if cached.get("ready") and not cached.get("error"):
            return cached
        raise

    cache_path.parent.mkdir(parents=True, exist_ok=True)
    cache_path.write_text(json.dumps(fresh, ensure_ascii=False, indent=2), encoding="utf-8")
    return fresh


def collect_price_source_fields(row: dict[str, object]) -> tuple[str, str, float | None]:
    original_text = clean_text(row.get("price_original") or row.get("Price Original"))
    original_currency = clean_currency_code(row.get("price_original_currency") or row.get("Price Original Currency"))
    original_value = coerce_number(row.get("price_original_value") or row.get("Price Original Value"))

    price_text = clean_text(row.get("price") or row.get("Price"))
    price_currency = clean_currency_code(row.get("price_currency") or row.get("Price Currency"))
    price_value = coerce_number(row.get("price_value") or row.get("Price Value"))

    source_text = original_text or price_text
    source_currency = normalize_source_currency(source_text, original_currency or price_currency)
    parsed_source_value = parse_price_value(source_text)
    source_value = original_value if original_value is not None else parsed_source_value
    if source_value is None:
        source_value = price_value

    if not source_currency and price_text:
        source_currency = normalize_source_currency(price_text)
    if source_value is None and price_text:
        source_value = parse_price_value(price_text)

    return source_text, source_currency, source_value


def normalize_price_row(
    row: dict[str, object],
    rates: dict[str, object],
    *,
    canonical_currency: str = CANONICAL_PRICE_CURRENCY,
) -> dict[str, object]:
    normalized = dict(row)
    source_text, source_currency, source_value = collect_price_source_fields(normalized)
    canonical_code = clean_currency_code(canonical_currency) or CANONICAL_PRICE_CURRENCY

    if source_text:
        normalized["price_original"] = source_text
    if source_currency:
        normalized["price_original_currency"] = source_currency
    if source_value is not None:
        normalized["price_original_value"] = round(source_value, 6)

    canonical_value = convert_currency_value(source_value, source_currency or canonical_code, canonical_code, rates)
    if canonical_value is not None:
        normalized["price"] = format_price_text(canonical_value, canonical_code)
        normalized["price_currency"] = canonical_code
        normalized["price_value"] = round(canonical_value, 6)
    elif source_text:
        normalized["price"] = source_text
        if source_currency:
            normalized["price_currency"] = source_currency
        if source_value is not None:
            normalized["price_value"] = round(source_value, 6)

    if rates.get("source"):
        normalized["price_exchange_source"] = clean_text(rates.get("source"))
    if rates.get("source_date"):
        normalized["price_exchange_date"] = clean_text(rates.get("source_date"))
    return normalized


def merge_csv_headers(existing_headers: list[str] | None) -> list[str]:
    merged: list[str] = []
    for header in COMMON_CSV_HEADERS:
        if header not in merged:
            merged.append(header)
    for header in existing_headers or []:
        clean_header = clean_text(header)
        if clean_header and clean_header not in merged:
            merged.append(clean_header)
    for header in ("zip_path", "saved", "error"):
        if header not in merged:
            merged.append(header)
    return merged
