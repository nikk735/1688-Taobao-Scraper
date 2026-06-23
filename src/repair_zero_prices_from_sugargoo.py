from __future__ import annotations

import csv
import json
import re
import sys
from pathlib import Path

from listing_price_utils import (
    CANONICAL_PRICE_CURRENCY,
    DEFAULT_EXCHANGE_RATE_CACHE_PATH,
    load_or_refresh_exchange_rates,
    merge_csv_headers,
    normalize_price_row,
)
from listing_search_crawler_queue import detect_browser_executable
from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
from playwright.sync_api import sync_playwright


ROOT_DIR = Path(__file__).resolve().parents[1]
SCRAPED_DATA_DIR = ROOT_DIR / "scraped data"
CACHE_PATH = ROOT_DIR / ".listing_search_cache" / "zero_price_repair_cache.json"
PROFILE_DIR = ROOT_DIR / ".listing_search_cache" / "playwright_brave_profile"
PRICE_RE = re.compile(r"[￥¥]\s*(\d+(?:\.\d+)?)")
SOURCE_PRICE_RE = re.compile(r"[￥¥]\s*\d+(?:\.\d+)?")
ZERO_TEXTS = {"", "0", "0.0", "0.00"}
ZERO_PRICE_TEXTS = {"￥0.00", "¥0.00", "CA$0.00", "$0.00", "US$0.00"}

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass


def clean(value: object) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()


def is_bad_price(row: dict[str, object]) -> bool:
    price = clean(row.get("price"))
    price_value = clean(row.get("price_value"))
    original = clean(row.get("price_original"))
    original_value = clean(row.get("price_original_value"))
    return (
        price in ZERO_PRICE_TEXTS
        or original in ZERO_PRICE_TEXTS
        or price_value in ZERO_TEXTS
        or original_value in ZERO_TEXTS and original in ZERO_PRICE_TEXTS
    )


def row_url(row: dict[str, object]) -> str:
    return clean(row.get("sugargoo_url") or row.get("source_url") or row.get("source_1688_url"))


def row_key(row: dict[str, object]) -> str:
    return clean(row.get("offer_id")) or row_url(row)


def load_json(path: Path) -> dict[str, object]:
    if not path.is_file():
        return {}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}
    return payload if isinstance(payload, dict) else {}


def save_json(path: Path, payload: dict[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = path.with_suffix(".tmp")
    temp_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    temp_path.replace(path)


def collect_targets() -> list[dict[str, object]]:
    targets: list[dict[str, object]] = []
    seen: set[str] = set()
    for manifest_path in sorted(SCRAPED_DATA_DIR.rglob("manifest.json"), key=lambda item: str(item).lower()):
        payload = load_json(manifest_path)
        rows = payload.get("rows")
        if not isinstance(rows, list):
            continue
        for row in rows:
            if not isinstance(row, dict) or not is_bad_price(row):
                continue
            url = row_url(row)
            key = row_key(row)
            if not url or not key or key in seen:
                continue
            seen.add(key)
            targets.append(
                {
                    "key": key,
                    "offer_id": clean(row.get("offer_id")),
                    "title": clean(row.get("title")),
                    "url": url,
                }
            )
    return targets


def force_cny(page) -> None:
    page.evaluate(
        """
        () => {
          const clean = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
          const visible = (el) => {
            if (!el) return false;
            const style = getComputedStyle(el);
            const rect = el.getBoundingClientRect();
            return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
          };
          const click = (el) => {
            if (!el) return false;
            el.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true, view: window }));
            el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
            el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
            el.click();
            return true;
          };
          const clickable = (el) => el?.closest?.('button, a, [role="button"], .currency__item, .option') || el;
          const items = () => Array.from(
            document.querySelectorAll('.currency__item, [class*="currency"] .option, [class*="currency"] [role="option"], [role="option"]')
          )
            .filter(visible)
            .map((el) => clickable(el))
            .filter((el, index, arr) => el && arr.indexOf(el) === index)
            .map((el) => ({
              el,
              text: clean(el.innerText || el.textContent || el.getAttribute('aria-label') || '').toUpperCase(),
              active: /\\b(active|selected|checked)\\b/i.test(String(el.className || '')) ||
                /\\b(active|selected|checked)\\b/i.test(String(el.parentElement?.className || '')),
            }))
            .filter((item) => item.text);
          const active = items().find((item) => item.active && /\\bCNY\\b/.test(item.text));
          if (active) return true;
          let option = items().find((item) => /\\bCNY\\b/.test(item.text));
          if (option) return click(option.el);
          const trigger = Array.from(document.querySelectorAll('[class*="currency"], [aria-label*="currency" i], [class*="header"]'))
            .filter(visible)
            .map((el) => clickable(el))
            .find((el) => /\\b(CNY|CAD|USD)\\b/i.test(clean(el.innerText || el.textContent || el.getAttribute('aria-label') || '')));
          click(trigger);
          option = items().find((item) => /\\bCNY\\b/.test(item.text));
          return option ? click(option.el) : false;
        }
        """
    )


def extract_yuan_price(page, title: str = "") -> str:
    price_text = page.evaluate(
        """
        () => {
          const clean = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
          const selectors = [
            '.goods-price__top .price span',
            '.goods-price__top .price',
            '.goods-price-top .price span',
            '.goods-price-top .price',
            '.price-info .price span',
            '.price-info .price',
            '.price-wrap .price span',
            '.price-wrap .price',
          ];
          for (const selector of selectors) {
            for (const el of document.querySelectorAll(selector)) {
              const text = clean(el.innerText || el.textContent || '');
              const match = text.match(/[￥¥]\\s*\\d+(?:\\.\\d+)?/);
              if (match) return match[0];
            }
          }
          const body = clean(document.body?.innerText || '');
          const productMatch = body.match(/Product link\\s*>\\s*([￥¥]\\s*\\d+(?:\\.\\d+)?)/i);
          if (productMatch) return productMatch[1];
          return '';
        }
        """
    )
    price_text = clean(price_text)
    if price_text:
        return price_text.replace("¥", "￥").replace(" ", "")

    body = clean(page.locator("body").inner_text(timeout=10_000))
    if title:
        index = body.lower().find(title.lower()[:80])
        if index >= 0:
            match = SOURCE_PRICE_RE.search(body[index : index + 1_000])
            if match:
                return match.group(0).replace("¥", "￥").replace(" ", "")
    match = re.search(r"Product link\s*>\s*([￥¥]\s*\d+(?:\.\d+)?)", body, flags=re.I)
    return match.group(1).replace("¥", "￥").replace(" ", "") if match else ""


def fetch_prices(targets: list[dict[str, object]], cache: dict[str, object]) -> dict[str, object]:
    browser_path = detect_browser_executable()
    if not browser_path:
        raise RuntimeError("No Chromium/Brave browser executable was found.")

    prices = dict(cache.get("prices") if isinstance(cache.get("prices"), dict) else {})
    failures = dict(cache.get("failures") if isinstance(cache.get("failures"), dict) else {})
    pending = [target for target in targets if target["key"] not in prices]
    print(f"Need to load {len(pending)} listings; {len(prices)} cached prices available.", flush=True)
    if not pending:
        return {"prices": prices, "failures": failures}

    with sync_playwright() as playwright:
        context = playwright.chromium.launch_persistent_context(
            user_data_dir=str(PROFILE_DIR),
            executable_path=str(browser_path),
            headless=True,
            viewport={"width": 1400, "height": 1000},
            args=[
                "--no-first-run",
                "--no-default-browser-check",
                "--disable-session-crashed-bubble",
                "--disable-features=InfiniteSessionRestore",
            ],
        )
        page = context.pages[0] if context.pages else context.new_page()
        page.set_default_timeout(25_000)
        for index, target in enumerate(pending, start=1):
            key = str(target["key"])
            try:
                page.goto(str(target["url"]), wait_until="domcontentloaded", timeout=60_000)
                page.wait_for_timeout(4_000)
                force_cny(page)
                page.wait_for_timeout(1_000)
                price = extract_yuan_price(page, str(target.get("title") or ""))
                value_match = PRICE_RE.search(price)
                if not value_match:
                    raise RuntimeError("No yuan product price found.")
                value = float(value_match.group(1))
                if value <= 0:
                    raise RuntimeError(f"Loaded non-positive price {price}.")
                prices[key] = {"price": f"￥{value:.6f}".rstrip("0").rstrip("."), "value": value}
                failures.pop(key, None)
                print(f"[{index}/{len(pending)}] {key}: CNY {value:g}", flush=True)
            except Exception as exc:  # noqa: BLE001
                failures[key] = str(exc)
                print(f"[{index}/{len(pending)}] {key}: failed: {exc}", flush=True)
            if index % 20 == 0:
                save_json(CACHE_PATH, {"prices": prices, "failures": failures})
        context.close()
    return {"prices": prices, "failures": failures}


def apply_prices(price_cache: dict[str, object]) -> tuple[int, int, list[str]]:
    rates = load_or_refresh_exchange_rates(DEFAULT_EXCHANGE_RATE_CACHE_PATH, prefer_cache=True)
    prices = price_cache.get("prices") if isinstance(price_cache.get("prices"), dict) else {}
    manifest_updates = 0
    csv_updates = 0
    locked_csvs: list[str] = []

    for manifest_path in sorted(SCRAPED_DATA_DIR.rglob("manifest.json"), key=lambda item: str(item).lower()):
        payload = load_json(manifest_path)
        rows = payload.get("rows")
        if not isinstance(rows, list):
            continue
        changed = False
        new_rows = []
        for row in rows:
            if not isinstance(row, dict):
                new_rows.append(row)
                continue
            key = row_key(row)
            price_payload = prices.get(key)
            if isinstance(price_payload, dict) and is_bad_price(row):
                patched = dict(row)
                patched["price_original"] = str(price_payload["price"])
                patched["price_original_currency"] = "cny"
                patched["price_original_value"] = float(price_payload["value"])
                row = normalize_price_row(patched, rates)
                manifest_updates += 1
                changed = True
            new_rows.append(row)
        if changed:
            payload["rows"] = new_rows
            payload["price_common_currency"] = CANONICAL_PRICE_CURRENCY
            payload["price_exchange_source"] = rates.get("source", "")
            payload["price_exchange_date"] = rates.get("source_date", "")
            save_json(manifest_path, payload)

    for csv_path in sorted(SCRAPED_DATA_DIR.rglob("*.csv"), key=lambda item: str(item).lower()):
        try:
            with csv_path.open("r", encoding="utf-8-sig", newline="") as handle:
                reader = csv.DictReader(handle)
                fieldnames = merge_csv_headers(reader.fieldnames or [])
                rows = []
                changed = False
                for row in reader:
                    key = row_key(row)
                    price_payload = prices.get(key)
                    if isinstance(price_payload, dict) and is_bad_price(row):
                        patched = dict(row)
                        patched["price_original"] = str(price_payload["price"])
                        patched["price_original_currency"] = "cny"
                        patched["price_original_value"] = float(price_payload["value"])
                        row = normalize_price_row(patched, rates)
                        csv_updates += 1
                        changed = True
                    rows.append(row)
            if not changed:
                continue
            with csv_path.open("w", encoding="utf-8-sig", newline="") as handle:
                writer = csv.DictWriter(handle, fieldnames=fieldnames)
                writer.writeheader()
                for row in rows:
                    writer.writerow({header: row.get(header, "") for header in fieldnames})
        except PermissionError:
            locked_csvs.append(str(csv_path))
    return manifest_updates, csv_updates, locked_csvs


def main() -> int:
    targets = collect_targets()
    print(f"Found {len(targets)} unique zero/missing-price listings to repair.", flush=True)
    cache = load_json(CACHE_PATH)
    price_cache = fetch_prices(targets, cache)
    save_json(CACHE_PATH, price_cache)
    manifest_updates, csv_updates, locked_csvs = apply_prices(price_cache)
    print(
        f"Applied {manifest_updates} manifest updates and {csv_updates} CSV updates. "
        f"Cached prices: {len(price_cache.get('prices', {}))}; failures: {len(price_cache.get('failures', {}))}.",
        flush=True,
    )
    if locked_csvs:
        print("CSV files locked and not rewritten:", flush=True)
        for path in locked_csvs:
            print(f"  {path}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
