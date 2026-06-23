from __future__ import annotations

import argparse
import atexit
import csv
import ctypes
import hashlib
import json
import mimetypes
import os
import posixpath
import re
import subprocess
import threading
import webbrowser
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path, PurePosixPath
from urllib.parse import quote, unquote, urlsplit
from urllib.request import Request, urlopen
from zipfile import ZipFile

from listing_search_image_index import ImageSearchIndex, ImageSearchNotReadyError, decode_image_payload
from listing_price_utils import (
    CANONICAL_PRICE_CURRENCY,
    DEFAULT_EXCHANGE_RATE_CACHE_PATH,
    clean_currency_code,
    coerce_number,
    fetch_bank_of_canada_exchange_rates,
    normalize_source_currency,
    parse_price_value as parse_price_number,
)
from listing_search_crawler_queue import (
    SCRAPED_DATA_DIR_NAME,
    CrawlerQueueManager,
    detect_browser_executable,
)


ROOT_DIR = Path(__file__).resolve().parents[1]
APP_DIR = Path(__file__).resolve().parent
STATIC_FILES = {
    "/": APP_DIR / "listing_search_index.html",
    "/styles.css": APP_DIR / "listing_search_styles.css",
    "/app.js": APP_DIR / "listing_search_app.js",
    "/image-worker.js": APP_DIR / "listing_search_image_worker.js",
    "/favicon.svg": APP_DIR / "listing_search_favicon.svg",
    "/favicon.ico": APP_DIR / "listing_search_favicon.svg",
}
SKIP_TOP_LEVEL = {"src", ".git", "__pycache__", ".listing_search_cache"}
XML_NS = {
    "main": "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
    "rel": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
    "pkgrel": "http://schemas.openxmlformats.org/package/2006/relationships",
}
OFFER_ID_RE = re.compile(r"(?:offer/|id=)(\d+)", re.IGNORECASE)
IMAGE_PROXY_TIMEOUT_SECS = 15
IMAGE_PROXY_MAX_BYTES = 16 * 1024 * 1024
IMAGE_PROXY_SCHEMES = {"http", "https"}
EXCHANGE_RATE_CACHE_PATH = DEFAULT_EXCHANGE_RATE_CACHE_PATH
APP_CACHE_DIR = ROOT_DIR / ".listing_search_cache"
SHOP_PREFERENCES_PATH = APP_CACHE_DIR / "shop_preferences.json"
LISTING_INDEX_CACHE_PATH = APP_CACHE_DIR / "listing_index_cache.json"
SERVER_SEARCH_DEFAULT_LIMIT = 240
SERVER_SEARCH_MAX_LIMIT = 1000
JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000
ERROR_ALREADY_EXISTS = 183


class JOBOBJECT_BASIC_LIMIT_INFORMATION(ctypes.Structure):
    _fields_ = [
        ("PerProcessUserTimeLimit", ctypes.c_longlong),
        ("PerJobUserTimeLimit", ctypes.c_longlong),
        ("LimitFlags", ctypes.c_uint32),
        ("MinimumWorkingSetSize", ctypes.c_size_t),
        ("MaximumWorkingSetSize", ctypes.c_size_t),
        ("ActiveProcessLimit", ctypes.c_uint32),
        ("Affinity", ctypes.c_size_t),
        ("PriorityClass", ctypes.c_uint32),
        ("SchedulingClass", ctypes.c_uint32),
    ]


class IO_COUNTERS(ctypes.Structure):
    _fields_ = [
        ("ReadOperationCount", ctypes.c_ulonglong),
        ("WriteOperationCount", ctypes.c_ulonglong),
        ("OtherOperationCount", ctypes.c_ulonglong),
        ("ReadTransferCount", ctypes.c_ulonglong),
        ("WriteTransferCount", ctypes.c_ulonglong),
        ("OtherTransferCount", ctypes.c_ulonglong),
    ]


class JOBOBJECT_EXTENDED_LIMIT_INFORMATION(ctypes.Structure):
    _fields_ = [
        ("BasicLimitInformation", JOBOBJECT_BASIC_LIMIT_INFORMATION),
        ("IoInfo", IO_COUNTERS),
        ("ProcessMemoryLimit", ctypes.c_size_t),
        ("JobMemoryLimit", ctypes.c_size_t),
        ("PeakProcessMemoryUsed", ctypes.c_size_t),
        ("PeakJobMemoryUsed", ctypes.c_size_t),
    ]


_WINDOWS_JOB_HANDLE: int | None = None
_WINDOWS_MUTEX_HANDLE: int | None = None


def clean(value: object) -> str:
    if value is None:
        return ""
    return re.sub(r"\s+", " ", str(value)).strip()


def normalize_for_search(value: object) -> str:
    return re.sub(r"[^a-z0-9]+", " ", str(value or "").lower().replace("&", " and ")).strip()


def compact_for_search(value: object) -> str:
    return normalize_for_search(value).replace(" ", "")


def tokenize_search(value: object) -> list[str]:
    return [token for token in normalize_for_search(value).split() if token]


def row_has_image(row: dict[str, object]) -> bool:
    return bool(clean(row.get("image_path")) or clean(row.get("image_src")))


def install_windows_child_process_job() -> None:
    global _WINDOWS_JOB_HANDLE
    if os.name != "nt" or _WINDOWS_JOB_HANDLE:
        return

    try:
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.CreateJobObjectW.restype = ctypes.c_void_p
        kernel32.SetInformationJobObject.argtypes = [
            ctypes.c_void_p,
            ctypes.c_int,
            ctypes.c_void_p,
            ctypes.c_uint32,
        ]
        kernel32.AssignProcessToJobObject.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
        kernel32.GetCurrentProcess.restype = ctypes.c_void_p
        kernel32.CloseHandle.argtypes = [ctypes.c_void_p]
        job = kernel32.CreateJobObjectW(None, None)
        if not job:
            return

        limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION()
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        ok = kernel32.SetInformationJobObject(
            job,
            9,
            ctypes.byref(limits),
            ctypes.sizeof(limits),
        )
        if not ok:
            kernel32.CloseHandle(job)
            return

        current_process = kernel32.GetCurrentProcess()
        if not kernel32.AssignProcessToJobObject(job, current_process):
            kernel32.CloseHandle(job)
            return
        _WINDOWS_JOB_HANDLE = int(job)
    except Exception:
        _WINDOWS_JOB_HANDLE = None


def acquire_single_instance_lock() -> bool:
    global _WINDOWS_MUTEX_HANDLE
    if os.name != "nt":
        return True
    if _WINDOWS_MUTEX_HANDLE:
        return True

    try:
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.CreateMutexW.restype = ctypes.c_void_p
        kernel32.GetLastError.restype = ctypes.c_uint32
        lock_name = f"Local\\ListingSearch1688Scraper-{hashlib.sha1(str(ROOT_DIR).lower().encode('utf-8')).hexdigest()}"
        mutex = kernel32.CreateMutexW(None, True, lock_name)
        if not mutex:
            return True
        if kernel32.GetLastError() == ERROR_ALREADY_EXISTS:
            kernel32.CloseHandle.argtypes = [ctypes.c_void_p]
            kernel32.CloseHandle(mutex)
            return False
        _WINDOWS_MUTEX_HANDLE = int(mutex)
        return True
    except Exception:
        return True


def open_url_in_browser(url: str, *, owned: bool = True) -> subprocess.Popen[bytes] | None:
    if owned:
        browser_path = detect_browser_executable()
        if browser_path and browser_path.is_file():
            try:
                return subprocess.Popen(
                    [
                        str(browser_path),
                        "--new-tab",
                        url,
                    ],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                )
            except Exception:
                pass
    else:
        browser_path = detect_browser_executable()
        if browser_path and browser_path.is_file():
            try:
                return subprocess.Popen(
                    [str(browser_path), "--new-tab", url],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                )
            except Exception:
                pass

    try:
        if webbrowser.open_new_tab(url):
            return None
    except Exception:
        pass

    if hasattr(os, "startfile"):
        try:
            os.startfile(url)  # type: ignore[attr-defined]
            return None
        except Exception:
            pass
    webbrowser.open(url)
    return None


def terminate_process(process: subprocess.Popen[bytes] | None) -> None:
    if process is None or process.poll() is not None:
        return
    try:
        process.terminate()
    except Exception:
        return
    try:
        process.wait(timeout=5)
    except Exception:
        try:
            process.kill()
        except Exception:
            pass


def extract_offer_id(*values: str) -> str:
    for value in values:
        match = OFFER_ID_RE.search(value or "")
        if match:
            return match.group(1)
    return ""


def relpath_for(path: Path) -> str:
    return path.relative_to(ROOT_DIR).as_posix()


def file_url_for(path: Path | None) -> str:
    if not path:
        return ""
    return f"/files/{quote(relpath_for(path))}"


def normalize_string_list(value: object) -> list[str]:
    if not isinstance(value, list):
        return []
    return sorted({clean(item) for item in value if clean(item)}, key=str.lower)


def read_shop_preferences() -> dict[str, object]:
    if not SHOP_PREFERENCES_PATH.is_file():
        return {"exists": False, "favorites": [], "disabled": []}
    try:
        payload = json.loads(SHOP_PREFERENCES_PATH.read_text(encoding="utf-8"))
    except Exception:
        return {"exists": False, "favorites": [], "disabled": []}
    if not isinstance(payload, dict):
        return {"exists": False, "favorites": [], "disabled": []}
    return {
        "exists": True,
        "favorites": normalize_string_list(payload.get("favorites")),
        "disabled": normalize_string_list(payload.get("disabled")),
    }


def write_shop_preferences(payload: dict[str, object]) -> dict[str, object]:
    preferences = {
        "favorites": normalize_string_list(payload.get("favorites")),
        "disabled": normalize_string_list(payload.get("disabled")),
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }
    APP_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    SHOP_PREFERENCES_PATH.write_text(json.dumps(preferences, indent=2, ensure_ascii=False), encoding="utf-8")
    return {"exists": True, "favorites": preferences["favorites"], "disabled": preferences["disabled"]}


def candidate_image_paths(source_path: Path, image_file: str, zip_path: str) -> list[Path]:
    candidates: list[Path] = []
    if zip_path:
        zip_candidate = source_path.parent
        for part in PurePosixPath(zip_path).parts:
            if part in {"", ".", ".."}:
                continue
            zip_candidate /= part
        candidates.append(zip_candidate)

    if image_file:
        image_name = Path(image_file).name
        candidates.extend(
            [
                source_path.parent / "images" / image_name,
                source_path.parent / image_name,
                source_path.parent.parent / "images" / image_name,
            ]
        )
        stem = source_path.stem
        if stem.startswith("sugargoo_shop_"):
            suffix = stem.removeprefix("sugargoo_shop_")
            candidates.append(source_path.parent / f"sugargoo_shop_images_{suffix}" / "images" / image_name)

    unique: list[Path] = []
    seen: set[str] = set()
    for candidate in candidates:
        key = str(candidate)
        if key in seen:
            continue
        seen.add(key)
        unique.append(candidate)
    return unique


def resolve_local_image(source_path: Path, raw_row: dict[str, object]) -> Path | None:
    image_file = clean(raw_row.get("image_file"))
    zip_path = clean(raw_row.get("zip_path"))
    for candidate in candidate_image_paths(source_path, image_file, zip_path):
        try:
            resolved = candidate.resolve()
        except OSError:
            continue
        if not resolved.is_file():
            continue
        if not resolved.is_relative_to(ROOT_DIR.resolve()):
            continue
        return resolved
    return None


def normalize_row(
    raw_row: dict[str, object],
    *,
    shop_name: str,
    source_path: Path,
    source_kind: str,
    row_number: int,
) -> dict[str, object] | None:
    title = clean(raw_row.get("title") or raw_row.get("Title"))
    price_text = clean(raw_row.get("price") or raw_row.get("Price"))
    price_currency = clean_currency_code(raw_row.get("price_currency") or raw_row.get("Price Currency"))
    price_value = coerce_number(raw_row.get("price_value") or raw_row.get("Price Value"))
    price_original_text = clean(raw_row.get("price_original") or raw_row.get("Price Original"))
    price_original_currency = clean_currency_code(
        raw_row.get("price_original_currency") or raw_row.get("Price Original Currency")
    )
    price_original_value = coerce_number(raw_row.get("price_original_value") or raw_row.get("Price Original Value"))
    sales = clean(raw_row.get("sales") or raw_row.get("Sales"))
    sugargoo_url = clean(raw_row.get("sugargoo_url") or raw_row.get("Sugargoo URL"))
    source_url = clean(raw_row.get("source_url") or raw_row.get("Source URL"))
    source_1688_url = clean(raw_row.get("source_1688_url") or raw_row.get("Source 1688 URL"))
    if not source_url:
        source_url = source_1688_url
    if not source_1688_url:
        source_1688_url = source_url
    image_url = clean(raw_row.get("image_url") or raw_row.get("Image URL"))
    image_file = clean(raw_row.get("image_file") or raw_row.get("Image File"))
    offer_id = clean(raw_row.get("offer_id") or raw_row.get("Offer ID"))

    if not any((title, sugargoo_url, source_url, source_1688_url, image_url, image_file)):
        return None

    price_currency = normalize_source_currency(price_text, price_currency) if (price_text or price_currency) else ""
    if price_value is None:
        price_value = parse_price_number(price_text)
    if not price_original_text:
        price_original_text = price_text
    price_original_currency = (
        normalize_source_currency(price_original_text, price_original_currency or price_currency)
        if (price_original_text or price_original_currency or price_currency)
        else ""
    )
    if price_original_value is None:
        price_original_value = parse_price_number(price_original_text)

    offer_id = offer_id or extract_offer_id(sugargoo_url, source_url, source_1688_url, image_file)
    local_image = resolve_local_image(source_path, raw_row)
    source_file = relpath_for(source_path)
    stable_key = "|".join(
        [
            shop_name,
            source_file,
            str(row_number),
            offer_id,
            title,
            sugargoo_url,
            source_url,
            source_1688_url,
        ]
    )
    listing_id = hashlib.sha1(stable_key.encode("utf-8")).hexdigest()[:16]
    return {
        "id": listing_id,
        "shop": shop_name,
        "title": title or "(untitled listing)",
        "price_text": price_text,
        "price_value": price_value,
        "sales": sales,
        "offer_id": offer_id,
        "source_url": source_url,
        "image_path": relpath_for(local_image) if local_image else "",
        "image_src": "" if local_image else image_url,
        "source_file": source_file,
    }


def index_search_row(row: dict[str, object]) -> dict[str, object]:
    title = clean(row.get("title"))
    shop = clean(row.get("shop"))
    offer_id = clean(row.get("offer_id"))
    blob = " ".join(
        [
            title,
            shop,
            offer_id,
            clean(row.get("price_text")),
            clean(row.get("sales")),
            clean(row.get("source_url")),
        ]
    )
    title_norm = normalize_for_search(title)
    shop_norm = normalize_for_search(shop)
    offer_norm = normalize_for_search(offer_id)
    blob_norm = normalize_for_search(blob)
    title_tokens = set(tokenize_search(title_norm))
    offer_tokens = set(tokenize_search(offer_norm))
    blob_tokens = set(tokenize_search(blob_norm))
    indexed = dict(row)
    indexed["_search"] = {
        "raw_title": title.lower(),
        "title": title_norm,
        "shop": shop_norm,
        "offer": offer_norm,
        "blob": blob_norm,
        "compact": compact_for_search(blob),
        "title_compact": compact_for_search(title),
        "offer_compact": compact_for_search(offer_id),
        "title_tokens": title_tokens,
        "offer_tokens": offer_tokens,
        "tokens": blob_tokens,
    }
    return indexed


def public_row(row: dict[str, object]) -> dict[str, object]:
    return {key: value for key, value in row.items() if not str(key).startswith("_")}


def load_manifest_rows(path: Path) -> list[dict[str, object]]:
    with path.open("r", encoding="utf-8") as handle:
        payload = json.load(handle)
    rows = payload.get("rows")
    if not isinstance(rows, list):
        return []
    return [row for row in rows if isinstance(row, dict)]


def load_manifest(path: Path) -> tuple[list[dict[str, object]], str]:
    with path.open("r", encoding="utf-8") as handle:
        payload = json.load(handle)
    rows = payload.get("rows")
    if not isinstance(rows, list):
        rows = []
    return [row for row in rows if isinstance(row, dict)], clean(payload.get("source_url"))


def load_csv_rows(path: Path) -> list[dict[str, object]]:
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        return [dict(row) for row in reader]


def cell_reference_to_index(reference: str) -> int:
    letters = "".join(ch for ch in reference if ch.isalpha()).upper()
    index = 0
    for char in letters:
        index = (index * 26) + (ord(char) - ord("A") + 1)
    return max(index - 1, 0)


def read_shared_strings(workbook: ZipFile) -> list[str]:
    if "xl/sharedStrings.xml" not in workbook.namelist():
        return []
    root = ET.fromstring(workbook.read("xl/sharedStrings.xml"))
    values: list[str] = []
    for string_item in root.findall("main:si", XML_NS):
        text = "".join(node.text or "" for node in string_item.findall(".//main:t", XML_NS))
        values.append(text)
    return values


def workbook_first_sheet_path(workbook: ZipFile) -> str | None:
    if "xl/workbook.xml" not in workbook.namelist() or "xl/_rels/workbook.xml.rels" not in workbook.namelist():
        return None
    workbook_root = ET.fromstring(workbook.read("xl/workbook.xml"))
    rel_root = ET.fromstring(workbook.read("xl/_rels/workbook.xml.rels"))
    rel_map = {
        rel.attrib.get("Id"): rel.attrib.get("Target", "")
        for rel in rel_root.findall("pkgrel:Relationship", XML_NS)
    }
    first_sheet = workbook_root.find("main:sheets/main:sheet", XML_NS)
    if first_sheet is None:
        return None
    rel_id = first_sheet.attrib.get(f"{{{XML_NS['rel']}}}id")
    target = rel_map.get(rel_id)
    if not target:
        return None
    target_path = posixpath.normpath(posixpath.join("xl", target))
    return target_path


def read_cell_value(cell: ET.Element, shared_strings: list[str]) -> str:
    cell_type = cell.attrib.get("t", "")
    if cell_type == "inlineStr":
        return "".join(node.text or "" for node in cell.findall(".//main:t", XML_NS))
    value = cell.findtext("main:v", default="", namespaces=XML_NS)
    if cell_type == "s":
        try:
            return shared_strings[int(value)]
        except (IndexError, ValueError):
            return ""
    return value or ""


def load_xlsx_rows(path: Path) -> list[dict[str, object]]:
    with ZipFile(path) as workbook:
        sheet_path = workbook_first_sheet_path(workbook)
        if not sheet_path or sheet_path not in workbook.namelist():
            return []
        shared_strings = read_shared_strings(workbook)
        sheet_root = ET.fromstring(workbook.read(sheet_path))

    row_values: list[list[str]] = []
    for row in sheet_root.findall(".//main:sheetData/main:row", XML_NS):
        values: dict[int, str] = {}
        highest_index = -1
        for cell in row.findall("main:c", XML_NS):
            reference = cell.attrib.get("r", "")
            column_index = cell_reference_to_index(reference)
            values[column_index] = clean(read_cell_value(cell, shared_strings))
            highest_index = max(highest_index, column_index)
        if highest_index < 0:
            continue
        row_values.append([values.get(index, "") for index in range(highest_index + 1)])

    if not row_values:
        return []

    headers = [clean(value) or f"column_{index + 1}" for index, value in enumerate(row_values[0])]
    records: list[dict[str, object]] = []
    for value_row in row_values[1:]:
        if not any(clean(value) for value in value_row):
            continue
        padded = value_row + [""] * max(0, len(headers) - len(value_row))
        records.append({headers[index]: padded[index] for index in range(len(headers))})
    return records


def load_tabular_rows(path: Path) -> list[dict[str, object]]:
    suffix = path.suffix.lower()
    if suffix == ".csv":
        return load_csv_rows(path)
    if suffix == ".xlsx":
        return load_xlsx_rows(path)
    return []


def collect_directory_targets(directory: Path, shop_name: str) -> list[tuple[str, Path, str]]:
    manifests = sorted(directory.rglob("manifest.json"), key=lambda path: str(path).lower())
    if manifests:
        return [("manifest", manifest, shop_name) for manifest in manifests]

    tabular_files = sorted(
        [*directory.rglob("*.csv"), *directory.rglob("*.xlsx")],
        key=lambda path: str(path).lower(),
    )
    return [("table", path, shop_name) for path in tabular_files]


def collect_top_level_targets(root_dir: Path) -> list[tuple[str, Path, str]]:
    targets: list[tuple[str, Path, str]] = []

    for entry in sorted(root_dir.iterdir(), key=lambda item: item.name.lower()):
        if entry.is_dir():
            if entry.name in SKIP_TOP_LEVEL:
                continue
            if entry.name == SCRAPED_DATA_DIR_NAME:
                for shop_entry in sorted(entry.iterdir(), key=lambda item: item.name.lower()):
                    if shop_entry.is_dir():
                        targets.extend(collect_directory_targets(shop_entry, shop_entry.name))
                        continue
                    if shop_entry.name == "manifest.json":
                        targets.append(("manifest", shop_entry, entry.name))
                        continue
                    if shop_entry.suffix.lower() in {".csv", ".xlsx"}:
                        targets.append(("table", shop_entry, entry.name))
                continue
            targets.extend(collect_directory_targets(entry, entry.name))
            continue

        if entry.suffix.lower() == ".csv":
            targets.append(("table", entry, "workspace"))
        if entry.suffix.lower() == ".xlsx":
            targets.append(("table", entry, "workspace"))
        if entry.name == "manifest.json":
            targets.append(("manifest", entry, "workspace"))

    return targets


def build_index() -> dict[str, object]:
    listings: list[dict[str, object]] = []
    sources: list[dict[str, object]] = []
    shop_urls: dict[str, str] = {}
    errors: list[str] = []

    for source_type, source_path, shop_name in collect_top_level_targets(ROOT_DIR):
        try:
            if source_type == "manifest":
                raw_rows, shop_url = load_manifest(source_path)
                if shop_url and shop_name not in shop_urls:
                    shop_urls[shop_name] = shop_url
            else:
                raw_rows = load_tabular_rows(source_path)
        except Exception as exc:  # noqa: BLE001
            errors.append(f"{relpath_for(source_path)}: {exc}")
            continue

        normalized_rows = []
        for row_number, raw_row in enumerate(raw_rows, start=1):
            listing = normalize_row(
                raw_row,
                shop_name=shop_name,
                source_path=source_path,
                source_kind=source_type,
                row_number=row_number,
            )
            if listing:
                normalized_rows.append(listing)

        listings.extend(index_search_row(row) for row in normalized_rows)
        sources.append(
            {
                "shop": shop_name,
                "path": relpath_for(source_path),
                "kind": source_type,
                "rows": len(normalized_rows),
            }
        )

    listings.sort(
        key=lambda row: (
            str(row["shop"]).lower(),
            str(row["title"]).lower(),
            row["price_value"] is None,
            row["price_value"] if row["price_value"] is not None else 999999.0,
        )
    )

    shops = sorted({str(row["shop"]) for row in listings}, key=str.lower)
    shop_counts: dict[str, int] = {}
    for row in listings:
        shop = str(row["shop"])
        shop_counts[shop] = shop_counts.get(shop, 0) + 1
    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "workspace_root": str(ROOT_DIR),
        "total_rows": len(listings),
        "total_shops": len(shops),
        "total_sources": len(sources),
        "shops": shops,
        "shop_counts": shop_counts,
        "shop_urls": shop_urls,
        "sources": sources,
        "rows": listings,
        "price_common_currency": CANONICAL_PRICE_CURRENCY,
        "errors": errors,
    }


def parse_server_query(raw_query: object) -> dict[str, object]:
    text = clean(raw_query)
    include_groups: list[list[str]] = []
    exclude: list[str] = []
    for raw_group in re.split(r"\s+(?:OR|\|\|?)\s+", text, flags=re.IGNORECASE):
        includes: list[str] = []
        for token in re.findall(r'!?\"[^\"]+\"|!?\S+', raw_group):
            negated = token.startswith("!") or token.startswith("-")
            token = token[1:] if negated else token
            normalized = normalize_for_search(token.strip("\"'"))
            if not normalized:
                continue
            if negated:
                exclude.extend(tokenize_search(normalized) or [normalized])
            else:
                includes.extend(tokenize_search(normalized) or [normalized])
        if includes:
            include_groups.append(sorted(set(includes)))
    return {
        "raw": text,
        "include_groups": include_groups,
        "exclude": sorted(set(exclude)),
        "compact": compact_for_search(text),
        "title_contains": compact_for_search(text) if re.fullmatch(r"[A-Za-z0-9_-]+", text) else "",
    }


def search_score(row: dict[str, object], query: dict[str, object]) -> float | None:
    search = row.get("_search") if isinstance(row.get("_search"), dict) else {}
    blob = str(search.get("blob") or "")
    title = str(search.get("title") or "")
    raw_title = str(search.get("raw_title") or "")
    offer = str(search.get("offer") or "")
    compact = str(search.get("compact") or "")
    title_compact = str(search.get("title_compact") or "")
    offer_compact = str(search.get("offer_compact") or "")
    title_tokens = search.get("title_tokens") if isinstance(search.get("title_tokens"), set) else set()
    offer_tokens = search.get("offer_tokens") if isinstance(search.get("offer_tokens"), set) else set()
    blob_tokens = search.get("tokens") if isinstance(search.get("tokens"), set) else set()

    def compact_token_hit(term_compact: str, tokens: set[str]) -> bool:
        return bool(term_compact and any(term_compact in token for token in tokens))

    def is_part_like(term_value: str) -> bool:
        return bool(re.search(r"[a-z]", term_value) and re.search(r"\d", term_value))

    for excluded in query["exclude"]:  # type: ignore[index]
        if excluded and excluded in blob:
            return None

    groups = query["include_groups"]  # type: ignore[index]
    if not groups:
        return 1.0

    best_score: float | None = None
    query_compact = str(query.get("compact") or "")
    title_contains = str(query.get("title_contains") or "")
    for group in groups:
        matched = 0
        score = 0.0
        for term in group:
            term_compact = compact_for_search(term)
            term_matched = False
            part_like = is_part_like(term_compact)
            offer_hit = term in offer or (
                compact_token_hit(term_compact, offer_tokens) if part_like else bool(term_compact and term_compact in offer_compact)
            )
            title_hit = term in title or (
                compact_token_hit(term_compact, title_tokens) if part_like else bool(term_compact and term_compact in title_compact)
            )
            blob_hit = term in blob or (
                compact_token_hit(term_compact, blob_tokens) if part_like else bool(term_compact and term_compact in compact)
            )
            if offer_hit:
                score += 800
                term_matched = True
            if title_hit:
                score += 500
                term_matched = True
            if blob_hit:
                score += 120
                term_matched = True
            if term_matched:
                matched += 1
            else:
                break
        if matched == len(group):
            if title_contains and title_contains in raw_title.replace("-", "").replace("_", "").replace(" ", ""):
                score += 4000
            if query_compact and (
                compact_token_hit(query_compact, title_tokens | offer_tokens)
                if is_part_like(query_compact)
                else (query_compact in title_compact or query_compact in offer_compact)
            ):
                score += 2500
            best_score = score if best_score is None else max(best_score, score)
    return best_score


def parse_float_or_none(value: object) -> float | None:
    try:
        parsed = float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
    return parsed if parsed == parsed else None


def search_rows(rows: list[object], request: dict[str, object]) -> dict[str, object]:
    query = parse_server_query(request.get("query"))
    sort_key = clean(request.get("sort")) or "match"
    offset = max(0, int(parse_float_or_none(request.get("offset")) or 0))
    limit = int(parse_float_or_none(request.get("limit")) or SERVER_SEARCH_DEFAULT_LIMIT)
    limit = max(1, min(SERVER_SEARCH_MAX_LIMIT, limit))
    disabled = set(normalize_string_list(request.get("disabled_shops")))
    min_price = parse_float_or_none(request.get("min_price"))
    max_price = parse_float_or_none(request.get("max_price"))
    has_image = bool(request.get("has_image"))
    shop_exact = clean(request.get("shop_exact"))
    shop_filter = normalize_for_search(request.get("shop_filter"))
    offer_filter = compact_for_search(request.get("offer_filter"))

    matches: list[tuple[float, dict[str, object]]] = []
    for candidate in rows:
        if not isinstance(candidate, dict):
            continue
        shop = clean(candidate.get("shop"))
        if shop in disabled:
            continue
        if shop_exact and shop != shop_exact:
            continue
        if has_image and not row_has_image(candidate):
            continue
        price = parse_float_or_none(candidate.get("price_value"))
        if min_price is not None and (price is None or price < min_price):
            continue
        if max_price is not None and (price is None or price > max_price):
            continue

        search = candidate.get("_search") if isinstance(candidate.get("_search"), dict) else {}
        if shop_filter and shop_filter not in str(search.get("shop") or ""):
            continue
        if offer_filter and offer_filter not in str(search.get("offer_compact") or ""):
            continue

        score = search_score(candidate, query)
        if score is None:
            continue
        matches.append((score, candidate))

    def price_value(row: dict[str, object], default: float) -> float:
        parsed = parse_float_or_none(row.get("price_value"))
        return parsed if parsed is not None else default

    if sort_key == "price-asc":
        matches.sort(key=lambda item: (price_value(item[1], 10**12), clean(item[1].get("title")).lower()))
    elif sort_key == "price-desc":
        matches.sort(key=lambda item: (-price_value(item[1], -1), clean(item[1].get("title")).lower()))
    elif sort_key == "title":
        matches.sort(key=lambda item: clean(item[1].get("title")).lower())
    elif sort_key == "shop":
        matches.sort(key=lambda item: (clean(item[1].get("shop")).lower(), clean(item[1].get("title")).lower()))
    else:
        matches.sort(key=lambda item: (-item[0], clean(item[1].get("shop")).lower(), clean(item[1].get("title")).lower()))

    total = len(matches)
    page = matches[offset : offset + limit]
    return {
        "ready": True,
        "rows": [public_row(row) for _, row in page],
        "total": total,
        "offset": offset,
        "limit": limit,
        "returned": len(page),
    }


class ExchangeRateProvider:
    def __init__(self, cache_path: Path) -> None:
        self.cache_path = cache_path
        self._lock = threading.RLock()
        self._refresh_thread: threading.Thread | None = None
        self._status = {
            "ready": False,
            "loading": False,
            "source": "Bank of Canada",
            "source_date": "",
            "usd_to_cad": 1.0,
            "usd_to_cny": 0.0,
            "cny_to_cad": 0.0,
            "error": "",
            "updated_at": "",
        }
        self._load_cache()

    def _load_cache(self) -> None:
        if not self.cache_path.is_file():
            return
        try:
            payload = json.loads(self.cache_path.read_text(encoding="utf-8"))
        except Exception:
            return
        if not isinstance(payload, dict):
            return
        with self._lock:
            self._status.update(payload)

    def status(self) -> dict[str, object]:
        with self._lock:
            return dict(self._status)

    def refresh_async(self, *, force: bool = False) -> None:
        with self._lock:
            if self._refresh_thread and self._refresh_thread.is_alive():
                return
            if not force and self._status.get("ready") and not self._status.get("error"):
                loading = False
            else:
                loading = True
            self._status["loading"] = loading
            self._status["error"] = ""
            self._refresh_thread = threading.Thread(target=self._refresh_worker, daemon=True, name="ExchangeRateRefresh")
            self._refresh_thread.start()

    def _refresh_worker(self) -> None:
        try:
            payload = fetch_bank_of_canada_exchange_rates()
            payload["updated_at"] = datetime.now(timezone.utc).isoformat()
            self.cache_path.parent.mkdir(parents=True, exist_ok=True)
            self.cache_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
            with self._lock:
                self._status = payload
        except Exception as exc:  # noqa: BLE001
            with self._lock:
                self._status["loading"] = False
                self._status["error"] = str(exc)


class AppState:
    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._reload_lock = threading.Lock()
        cached_data = self._load_cache()
        if cached_data:
            self._data = cached_data
            self._payload = json.dumps(self._public_data(cached_data), ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        else:
            self._data = self._placeholder_data(message="Indexing current workspace in the background.")
            self._payload = json.dumps(self._data, ensure_ascii=False, separators=(",", ":")).encode("utf-8")

    def _placeholder_data(self, *, message: str, errors: list[str] | None = None, building: bool = True) -> dict[str, object]:
        return {
            "generated_at": "",
            "workspace_root": str(ROOT_DIR),
            "total_rows": 0,
            "total_shops": 0,
            "total_sources": 0,
            "shops": [],
            "shop_counts": {},
            "shop_urls": {},
            "sources": [],
            "rows": [],
            "price_common_currency": CANONICAL_PRICE_CURRENCY,
            "errors": list(errors or []),
            "ready": False,
            "building": building,
            "message": message,
        }

    def _public_data(self, data: dict[str, object]) -> dict[str, object]:
        public = dict(data)
        public["rows"] = []
        return public

    def _set_data(self, data: dict[str, object]) -> None:
        payload = json.dumps(self._public_data(data), ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        with self._lock:
            self._data = data
            self._payload = payload

    def _load_cache(self) -> dict[str, object] | None:
        if not LISTING_INDEX_CACHE_PATH.is_file():
            return None
        try:
            payload = json.loads(LISTING_INDEX_CACHE_PATH.read_text(encoding="utf-8"))
        except Exception:
            return None
        if not isinstance(payload, dict):
            return None
        rows = payload.get("rows")
        if not isinstance(rows, list):
            return None
        if payload.get("price_common_currency") != CANONICAL_PRICE_CURRENCY:
            return None
        for row in rows:
            if not isinstance(row, dict):
                return None
            search = row.get("_search")
            if not isinstance(search, dict):
                continue
            for key in ("title_tokens", "offer_tokens", "tokens"):
                value = search.get(key)
                if isinstance(value, list):
                    search[key] = set(str(item) for item in value)
        payload["ready"] = True
        payload["building"] = True
        payload["message"] = (
            f"Loaded cached index with {len(rows)} listings; refreshing collection folders in the background."
        )
        payload.setdefault("price_common_currency", CANONICAL_PRICE_CURRENCY)
        return payload

    def _save_cache(self, data: dict[str, object]) -> None:
        try:
            APP_CACHE_DIR.mkdir(parents=True, exist_ok=True)
            temp_path = LISTING_INDEX_CACHE_PATH.with_suffix(".tmp")
            cache_data = dict(data)
            cache_rows = []
            for row in data.get("rows", []):
                if not isinstance(row, dict):
                    continue
                cache_row = dict(row)
                search = cache_row.get("_search")
                if isinstance(search, dict):
                    cache_search = dict(search)
                    for key in ("title_tokens", "offer_tokens", "tokens"):
                        value = cache_search.get(key)
                        if isinstance(value, set):
                            cache_search[key] = sorted(value)
                    cache_row["_search"] = cache_search
                cache_rows.append(cache_row)
            cache_data["rows"] = cache_rows
            temp_path.write_text(json.dumps(cache_data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
            temp_path.replace(LISTING_INDEX_CACHE_PATH)
        except Exception as exc:  # noqa: BLE001
            print(f"Could not save listing index cache: {exc}", flush=True)

    def reload(self) -> dict[str, object]:
        with self._reload_lock:
            current = self.data()
            if current.get("ready") and isinstance(current.get("rows"), list):
                self._set_data(
                    {
                        **current,
                        "building": True,
                        "message": "Refreshing collection folders in the background.",
                    }
                )
            else:
                self._set_data(self._placeholder_data(message="Indexing current workspace in the background."))
            try:
                data = build_index()
            except Exception as exc:
                error_data = self._placeholder_data(
                    message="Workspace indexing failed.",
                    errors=[str(exc)],
                    building=False,
                )
                self._set_data(error_data)
                raise

            data["ready"] = True
            data["building"] = False
            data["message"] = (
                f"Indexed {data['total_rows']} listings from {data['total_sources']} files across "
                f"{data['total_shops']} shops."
            )
            self._set_data(data)
            self._save_cache(data)
            return data

    def payload(self) -> bytes:
        with self._lock:
            return self._payload

    def data(self) -> dict[str, object]:
        with self._lock:
            return self._data

    def search(self, request: dict[str, object]) -> dict[str, object]:
        with self._lock:
            data = self._data
            rows = list(data.get("rows") or [])
            ready = bool(data.get("ready"))
        if not ready:
            return {
                "ready": False,
                "rows": [],
                "total": 0,
                "offset": 0,
                "limit": SERVER_SEARCH_DEFAULT_LIMIT,
                "message": clean(data.get("message")) or "Indexing current workspace in the background.",
            }
        return search_rows(rows, request)


class ListingSearchServer(ThreadingHTTPServer):
    allow_reuse_address = True

    def __init__(self, server_address: tuple[str, int], state: AppState) -> None:
        super().__init__(server_address, ListingSearchHandler)
        self.state = state
        self.image_index = ImageSearchIndex(ROOT_DIR, state)
        self.exchange_rates = ExchangeRateProvider(EXCHANGE_RATE_CACHE_PATH)
        self.crawler_queue = CrawlerQueueManager(ROOT_DIR, refresh_callback=self.refresh_after_scrape)

    def refresh_after_scrape(self) -> None:
        try:
            data = self.state.reload()
            print(data["message"], flush=True)
            self.image_index.mark_stale(
                message="New collected images were saved. Click Reindex Images when the queue is idle."
            )
        except Exception as exc:  # noqa: BLE001
            print(f"Post-collection reload failed: {exc}", flush=True)


class ListingSearchHandler(BaseHTTPRequestHandler):
    server_version = "ListingSearch/1.0"

    @property
    def app_state(self) -> AppState:
        return self.server.state  # type: ignore[attr-defined]

    @property
    def image_index(self) -> ImageSearchIndex:
        return self.server.image_index  # type: ignore[attr-defined]

    @property
    def exchange_rates(self) -> ExchangeRateProvider:
        return self.server.exchange_rates  # type: ignore[attr-defined]

    @property
    def crawler_queue(self) -> CrawlerQueueManager:
        return self.server.crawler_queue  # type: ignore[attr-defined]

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlsplit(self.path)
        if parsed.path == "/api/data":
            self.send_json(HTTPStatus.OK, self.app_state.payload())
            return
        if parsed.path == "/api/image-search/status":
            self.send_json(
                HTTPStatus.OK,
                json.dumps(self.image_index.status(), ensure_ascii=False, separators=(",", ":")).encode("utf-8"),
            )
            return
        if parsed.path == "/api/exchange-rates":
            self.send_json(
                HTTPStatus.OK,
                json.dumps(self.exchange_rates.status(), ensure_ascii=False, separators=(",", ":")).encode("utf-8"),
            )
            return
        if parsed.path == "/api/crawler-queue/status":
            self.send_json(
                HTTPStatus.OK,
                json.dumps(self.crawler_queue.status(), ensure_ascii=False, separators=(",", ":")).encode("utf-8"),
            )
            return
        if parsed.path == "/api/shop-preferences":
            self.send_json(
                HTTPStatus.OK,
                json.dumps(read_shop_preferences(), ensure_ascii=False, separators=(",", ":")).encode("utf-8"),
            )
            return
        if parsed.path == "/api/reload":
            data = self.app_state.reload()
            self.image_index.mark_stale(message="Listing files reloaded. Click Reindex Images to refresh visual search.")
            self.exchange_rates.refresh_async(force=True)
            self.send_json(
                HTTPStatus.OK,
                json.dumps(
                    {
                        "reloaded": True,
                        "generated_at": data["generated_at"],
                        "total_rows": data["total_rows"],
                        "total_sources": data["total_sources"],
                    },
                    ensure_ascii=False,
                    separators=(",", ":"),
                ).encode("utf-8"),
            )
            return
        if parsed.path == "/api/image-proxy":
            self.serve_remote_image(parsed.query)
            return
        if parsed.path.startswith("/files/"):
            self.serve_workspace_file(parsed.path[len("/files/") :])
            return
        self.serve_static_file(parsed.path)

    def do_POST(self) -> None:  # noqa: N802
        parsed = urlsplit(self.path)
        if parsed.path == "/api/image-search/query":
            self.handle_image_search_query()
            return
        if parsed.path == "/api/image-search/text-query":
            self.handle_image_search_text_query()
            return
        if parsed.path == "/api/search":
            self.handle_listing_search()
            return
        if parsed.path == "/api/image-search/reindex":
            self.handle_image_search_reindex()
            return
        if parsed.path == "/api/crawler-queue/retry":
            self.handle_crawler_queue_retry()
            return
        if parsed.path == "/api/crawler-queue/enqueue":
            self.handle_crawler_queue_enqueue()
            return
        if parsed.path == "/api/shop-preferences":
            self.handle_shop_preferences_update()
            return
        if parsed.path == "/api/open-url":
            self.handle_open_url()
            return
        self.send_error(HTTPStatus.NOT_FOUND, "Not found")

    def do_DELETE(self) -> None:  # noqa: N802
        parsed = urlsplit(self.path)
        if parsed.path.startswith("/api/shops/"):
            self.handle_shop_deletion()
            return
        self.send_error(HTTPStatus.NOT_FOUND, "Not found")

    def log_message(self, format_string: str, *args: object) -> None:
        print(f"[{self.log_date_time_string()}] {format_string % args}")

    def send_json(self, status: HTTPStatus, payload: bytes) -> None:
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(payload)

    def handle_image_search_query(self) -> None:
        try:
            content_length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self.send_error(HTTPStatus.BAD_REQUEST, "Invalid Content-Length")
            return

        try:
            payload = json.loads(self.rfile.read(content_length) or b"{}")
        except json.JSONDecodeError:
            self.send_error(HTTPStatus.BAD_REQUEST, "Invalid JSON payload")
            return

        image_base64 = payload.get("image_base64")
        candidate_ids = payload.get("candidate_ids")
        top_k = payload.get("top_k", 200)

        try:
            image_bytes = decode_image_payload(str(image_base64 or ""))
            candidates = [str(item) for item in candidate_ids] if isinstance(candidate_ids, list) else None
            result_rows = self.image_index.query(image_bytes, candidate_ids=candidates, top_k=int(top_k))
        except ImageSearchNotReadyError:
            response = {
                "ready": False,
                "status": self.image_index.status(),
                "results": [],
            }
            self.send_json(
                HTTPStatus.ACCEPTED,
                json.dumps(response, ensure_ascii=False, separators=(",", ":")).encode("utf-8"),
            )
            return
        except Exception as exc:  # noqa: BLE001
            self.send_json(
                HTTPStatus.BAD_REQUEST,
                json.dumps(
                    {
                        "ready": False,
                        "error": str(exc),
                        "results": [],
                    },
                    ensure_ascii=False,
                    separators=(",", ":"),
                ).encode("utf-8"),
            )
            return

        response = {
            "ready": True,
            "status": self.image_index.status(),
            "results": result_rows,
        }
        self.send_json(
            HTTPStatus.OK,
            json.dumps(response, ensure_ascii=False, separators=(",", ":")).encode("utf-8"),
        )

    def handle_shop_preferences_update(self) -> None:
        try:
            content_length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self.send_error(HTTPStatus.BAD_REQUEST, "Invalid Content-Length")
            return

        try:
            payload = json.loads(self.rfile.read(content_length) or b"{}")
        except json.JSONDecodeError:
            self.send_error(HTTPStatus.BAD_REQUEST, "Invalid JSON payload")
            return

        if not isinstance(payload, dict):
            self.send_error(HTTPStatus.BAD_REQUEST, "Expected JSON object")
            return

        try:
            preferences = write_shop_preferences(payload)
        except Exception as exc:  # noqa: BLE001
            self.send_json(
                HTTPStatus.INTERNAL_SERVER_ERROR,
                json.dumps({"error": str(exc)}, ensure_ascii=False, separators=(",", ":")).encode("utf-8"),
            )
            return

        self.send_json(
            HTTPStatus.OK,
            json.dumps(preferences, ensure_ascii=False, separators=(",", ":")).encode("utf-8"),
        )

    def handle_open_url(self) -> None:
        try:
            content_length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self.send_error(HTTPStatus.BAD_REQUEST, "Invalid Content-Length")
            return

        try:
            payload = json.loads(self.rfile.read(content_length) or b"{}")
        except json.JSONDecodeError:
            self.send_error(HTTPStatus.BAD_REQUEST, "Invalid JSON payload")
            return

        url = clean(payload.get("url") if isinstance(payload, dict) else "")
        parts = urlsplit(url)
        if parts.scheme.lower() not in {"http", "https"} or not parts.netloc:
            self.send_error(HTTPStatus.BAD_REQUEST, "Expected an http(s) URL")
            return

        open_url_in_browser(url, owned=False)
        self.send_json(
            HTTPStatus.OK,
            json.dumps({"opened": True}, ensure_ascii=False, separators=(",", ":")).encode("utf-8"),
        )

    def handle_shop_deletion(self) -> None:
        import shutil
        parsed = urlsplit(self.path)
        shop_name = clean(unquote(parsed.path[len("/api/shops/"):]))
        if not shop_name:
            self.send_error(HTTPStatus.BAD_REQUEST, "Missing shop name")
            return
        
        scraped_data_dir = (ROOT_DIR / SCRAPED_DATA_DIR_NAME).resolve()
        target_dir = (ROOT_DIR / SCRAPED_DATA_DIR_NAME / shop_name).resolve()
        
        if not target_dir.is_relative_to(scraped_data_dir) or target_dir == scraped_data_dir:
            self.send_error(HTTPStatus.FORBIDDEN, "Forbidden path")
            return
            
        if not target_dir.is_dir():
            self.send_error(HTTPStatus.NOT_FOUND, "Shop directory not found")
            return
            
        try:
            shutil.rmtree(target_dir, ignore_errors=True)
            self.app_state.reload()
        except Exception as exc:  # noqa: BLE001
            self.send_json(
                HTTPStatus.INTERNAL_SERVER_ERROR,
                json.dumps({"error": str(exc)}, ensure_ascii=False, separators=(",", ":")).encode("utf-8"),
            )
            return

        self.send_json(
            HTTPStatus.OK,
            json.dumps({"deleted": True}, ensure_ascii=False, separators=(",", ":")).encode("utf-8"),
        )

    def handle_listing_search(self) -> None:
        try:
            content_length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self.send_error(HTTPStatus.BAD_REQUEST, "Invalid Content-Length")
            return

        try:
            payload = json.loads(self.rfile.read(content_length) or b"{}")
        except json.JSONDecodeError:
            self.send_error(HTTPStatus.BAD_REQUEST, "Invalid JSON payload")
            return

        if not isinstance(payload, dict):
            self.send_error(HTTPStatus.BAD_REQUEST, "Expected JSON object")
            return

        response = self.app_state.search(payload)
        self.send_json(
            HTTPStatus.OK,
            json.dumps(response, ensure_ascii=False, separators=(",", ":")).encode("utf-8"),
        )

    def handle_image_search_text_query(self) -> None:
        try:
            content_length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self.send_error(HTTPStatus.BAD_REQUEST, "Invalid Content-Length")
            return

        try:
            payload = json.loads(self.rfile.read(content_length) or b"{}")
        except json.JSONDecodeError:
            self.send_error(HTTPStatus.BAD_REQUEST, "Invalid JSON payload")
            return

        query_text = clean(payload.get("query"))
        candidate_ids = payload.get("candidate_ids")
        top_k = payload.get("top_k", 200)

        try:
            candidates = [str(item) for item in candidate_ids] if isinstance(candidate_ids, list) else None
            result_rows = self.image_index.query_text(query_text, candidate_ids=candidates, top_k=int(top_k))
        except ImageSearchNotReadyError:
            response = {
                "ready": False,
                "status": self.image_index.status(),
                "results": [],
            }
            self.send_json(
                HTTPStatus.ACCEPTED,
                json.dumps(response, ensure_ascii=False, separators=(",", ":")).encode("utf-8"),
            )
            return
        except Exception as exc:  # noqa: BLE001
            self.send_json(
                HTTPStatus.BAD_REQUEST,
                json.dumps(
                    {
                        "ready": False,
                        "error": str(exc),
                        "results": [],
                    },
                    ensure_ascii=False,
                    separators=(",", ":"),
                ).encode("utf-8"),
            )
            return

        response = {
            "ready": True,
            "status": self.image_index.status(),
            "results": result_rows,
        }
        self.send_json(
            HTTPStatus.OK,
            json.dumps(response, ensure_ascii=False, separators=(",", ":")).encode("utf-8"),
        )

    def handle_image_search_reindex(self) -> None:
        status = self.image_index.request_rebuild()
        self.send_json(
            HTTPStatus.OK,
            json.dumps({"started": True, "status": status}, ensure_ascii=False, separators=(",", ":")).encode("utf-8"),
        )

    def handle_crawler_queue_enqueue(self) -> None:
        try:
            content_length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self.send_error(HTTPStatus.BAD_REQUEST, "Invalid Content-Length")
            return

        try:
            payload = json.loads(self.rfile.read(content_length) or b"{}")
        except json.JSONDecodeError:
            self.send_error(HTTPStatus.BAD_REQUEST, "Invalid JSON payload")
            return

        urls = payload.get("urls")
        if not isinstance(urls, list):
            self.send_error(HTTPStatus.BAD_REQUEST, "Expected `urls` list")
            return
        force = bool(payload.get("force"))

        try:
            queued = self.crawler_queue.enqueue([str(url) for url in urls], force=force)
        except ValueError as exc:
            self.send_json(
                HTTPStatus.BAD_REQUEST,
                json.dumps({"queued": [], "error": str(exc)}, ensure_ascii=False, separators=(",", ":")).encode("utf-8"),
            )
            return
        except Exception as exc:  # noqa: BLE001
            self.send_json(
                HTTPStatus.INTERNAL_SERVER_ERROR,
                json.dumps({"queued": [], "error": str(exc)}, ensure_ascii=False, separators=(",", ":")).encode("utf-8"),
            )
            return

        self.send_json(
            HTTPStatus.OK,
            json.dumps({"queued": queued, "status": self.crawler_queue.status()}, ensure_ascii=False, separators=(",", ":")).encode("utf-8"),
        )

    def handle_crawler_queue_retry(self) -> None:
        try:
            content_length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self.send_error(HTTPStatus.BAD_REQUEST, "Invalid Content-Length")
            return

        try:
            payload = json.loads(self.rfile.read(content_length) or b"{}")
        except json.JSONDecodeError:
            self.send_error(HTTPStatus.BAD_REQUEST, "Invalid JSON payload")
            return

        item_id = str(payload.get("item_id") or "").strip()
        if not item_id:
            self.send_error(HTTPStatus.BAD_REQUEST, "Expected `item_id`")
            return

        try:
            queued = self.crawler_queue.retry_item(item_id)
        except ValueError as exc:
            self.send_json(
                HTTPStatus.BAD_REQUEST,
                json.dumps({"queued": None, "error": str(exc)}, ensure_ascii=False, separators=(",", ":")).encode("utf-8"),
            )
            return
        except Exception as exc:  # noqa: BLE001
            self.send_json(
                HTTPStatus.INTERNAL_SERVER_ERROR,
                json.dumps({"queued": None, "error": str(exc)}, ensure_ascii=False, separators=(",", ":")).encode("utf-8"),
            )
            return

        self.send_json(
            HTTPStatus.OK,
            json.dumps({"queued": queued, "status": self.crawler_queue.status()}, ensure_ascii=False, separators=(",", ":")).encode("utf-8"),
        )

    def serve_static_file(self, request_path: str) -> None:
        file_path = STATIC_FILES.get(request_path or "/")
        if not file_path or not file_path.is_file():
            self.send_error(HTTPStatus.NOT_FOUND, "Not found")
            return
        self.serve_file(file_path, cache_control="no-store")

    def serve_remote_image(self, raw_query: str) -> None:
        encoded_url = raw_query.removeprefix("url=").strip()
        if not encoded_url:
            self.send_error(HTTPStatus.BAD_REQUEST, "Missing image URL")
            return

        remote_url = unquote(encoded_url)
        parts = urlsplit(remote_url)
        if parts.scheme.lower() not in IMAGE_PROXY_SCHEMES or not parts.netloc:
            self.send_error(HTTPStatus.BAD_REQUEST, "Unsupported image URL")
            return

        request = Request(
            remote_url,
            headers={
                "User-Agent": "Mozilla/5.0 ListingSearch/1.0",
                "Accept": "image/*,*/*;q=0.8",
                "Referer": remote_url,
            },
        )
        try:
            with urlopen(request, timeout=IMAGE_PROXY_TIMEOUT_SECS) as response:
                payload = response.read(IMAGE_PROXY_MAX_BYTES + 1)
                if len(payload) > IMAGE_PROXY_MAX_BYTES:
                    self.send_error(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "Image is too large")
                    return
                mime_type = response.headers.get_content_type() or "application/octet-stream"
        except Exception as exc:  # noqa: BLE001
            self.send_error(HTTPStatus.BAD_GATEWAY, f"Could not fetch image: {exc}")
            return

        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", mime_type)
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "public, max-age=3600")
        self.end_headers()
        self.wfile.write(payload)

    def serve_workspace_file(self, encoded_relative_path: str) -> None:
        relative_path = unquote(encoded_relative_path).lstrip("/")
        candidate = (ROOT_DIR / relative_path).resolve()
        if not candidate.is_relative_to(ROOT_DIR.resolve()):
            self.send_error(HTTPStatus.FORBIDDEN, "Forbidden")
            return
        if not candidate.is_file():
            self.send_error(HTTPStatus.NOT_FOUND, "File not found")
            return
        self.serve_file(candidate)

    def serve_file(self, file_path: Path, *, cache_control: str | None = None) -> None:
        try:
            payload = file_path.read_bytes()
        except OSError:
            self.send_error(HTTPStatus.NOT_FOUND, "File not found")
            return
        mime_type = mimetypes.guess_type(file_path.name)[0] or "application/octet-stream"
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", mime_type)
        self.send_header("Content-Length", str(len(payload)))
        if cache_control:
            self.send_header("Cache-Control", cache_control)
        self.end_headers()
        self.wfile.write(payload)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Browse collected Sugargoo/1688 listings in a local search UI.")
    parser.add_argument("--host", default="127.0.0.1", help="Host to bind the local server to.")
    parser.add_argument("--port", type=int, default=8766, help="Port to bind the local server to.")
    parser.add_argument("--no-browser", action="store_true", help="Do not automatically open the browser.")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    url = f"http://{args.host}:{args.port}/"
    if not acquire_single_instance_lock():
        print("Search UI is already running. Opening the existing instance.", flush=True)
        if not args.no_browser:
            open_url_in_browser(url, owned=False)
        return

    install_windows_child_process_job()
    state = AppState()
    try:
        server = ListingSearchServer((args.host, args.port), state)
    except OSError as exc:
        print(f"Search UI is already running or port {args.port} is unavailable: {exc}", flush=True)
        if not args.no_browser:
            open_url_in_browser(url, owned=False)
        return

    print(f"Serving search UI at {url}")
    browser_process: subprocess.Popen[bytes] | None = None

    def warm_workspace_index() -> None:
        try:
            data = state.reload()
        except Exception as exc:  # noqa: BLE001
            print(f"Workspace indexing failed: {exc}", flush=True)
            return

        print(data["message"], flush=True)
        server.image_index.request_rebuild()

    def cleanup() -> None:
        try:
            server.crawler_queue.shutdown()
        except Exception:
            pass
        terminate_process(browser_process)

    atexit.register(cleanup)

    if not args.no_browser:
        def open_owned_browser() -> None:
            nonlocal browser_process
            browser_process = open_url_in_browser(url, owned=True)

        threading.Timer(0.15, open_owned_browser).start()

    server.exchange_rates.refresh_async()
    threading.Thread(target=warm_workspace_index, daemon=True, name="InitialWorkspaceIndex").start()

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down...")
    finally:
        server.crawler_queue.shutdown()
        server.server_close()
        terminate_process(browser_process)


if __name__ == "__main__":
    main()
