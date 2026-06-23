from __future__ import annotations

import csv
import json
import re
import shutil
import threading
import time
import urllib.error
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable
from urllib.parse import parse_qs, quote, unquote, urlsplit
from urllib.request import Request, urlopen

from listing_price_utils import (
    CANONICAL_PRICE_CURRENCY,
    COMMON_CSV_HEADERS,
    DEFAULT_EXCHANGE_RATE_CACHE_PATH,
    load_or_refresh_exchange_rates,
    merge_csv_headers,
    normalize_price_row,
)
from playwright.sync_api import BrowserContext, Playwright, sync_playwright


APP_DIR = Path(__file__).resolve().parent
BRAVE_CANDIDATES = [
    Path(r"C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe"),
    Path(r"C:\Program Files (x86)\BraveSoftware\Brave-Browser\Application\brave.exe"),
    Path.home() / "AppData/Local/BraveSoftware/Brave-Browser/Application/brave.exe",
]
EDGE_CANDIDATES = [
    Path(r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"),
    Path(r"C:\Program Files\Microsoft\Edge\Application\msedge.exe"),
    Path.home() / "AppData/Local/Microsoft/Edge/Application/msedge.exe",
]
CHROME_CANDIDATES = [
    Path(r"C:\Program Files\Google\Chrome\Application\chrome.exe"),
    Path(r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"),
    Path.home() / "AppData/Local/Google/Chrome/Application/chrome.exe",
]
CRAWLER_SCRIPT_PATH = APP_DIR / "sugargoo_live_crawl_with_images.js"
QUEUE_CACHE_DIR = ".listing_search_cache"
PROFILE_DIR_NAME = "playwright_brave_profile"
PROFILE_CLONE_VERSION = "2026-04-27-single-tab-v2"
QUEUE_STATE_FILE_NAME = "crawler_queue_state.json"
LEGACY_QUEUE_STATE_FILE_NAME = "scra" + "per_queue_state.json"
SCRAPED_DATA_DIR_NAME = "scraped data"
IMAGE_DOWNLOAD_MAX_BYTES = 24 * 1024 * 1024
CRAWLER_WAIT_TIMEOUT_MS = 90_000
LOGIN_WAIT_TIMEOUT_SECS = 20 * 60
SHOP_READY_TIMEOUT_SECS = 75
STORE_NAVIGATION_TIMEOUT_SECS = 90
PRODUCT_SELECTOR = 'a.goods-item[href*="/products?productLink="]'
OFFER_ID_RE = re.compile(r"(?:offer/|item-1688-|id=)(\d+)", re.IGNORECASE)
TAOBAO_ITEM_ID_RE = re.compile(r"(?:[?&]id=|item\.htm\?id=)(\d+)", re.IGNORECASE)
CRAWLER_PROGRESS_POLL_MS = 1_500
SUSPICIOUS_PAGINATION_ROW_FLOOR = 1_800
SUSPICIOUS_PAGINATION_PAGE_FLOOR = 90
LOGIN_URL_HINTS = ("/register", "/login", "/signin", "/account/login")
LOGIN_TEXT_HINTS = (
    "welcome to login",
    "sign in",
    "register",
    "hello!",
)
BRAVE_USER_DATA_CANDIDATES = [
    Path.home() / "AppData/Local/BraveSoftware/Brave-Browser/User Data",
]
BRAVE_ROOT_FILES_TO_COPY = ("Local State", "First Run")
PROFILE_SKIP_PARTS = {
    "Cache",
    "Code Cache",
    "GPUCache",
    "ShaderCache",
    "GrShaderCache",
    "DawnCache",
    "DawnGraphiteCache",
    "Crashpad",
    "optimization_guide_model_store",
}
PROFILE_SKIP_NAMES = {
    "SingletonCookie",
    "SingletonLock",
    "SingletonSocket",
    "LOCK",
    "lockfile",
    "Current Session",
    "Current Tabs",
    "Last Session",
    "Last Tabs",
    "Cookies-journal",
    "Web Data-journal",
    "History-journal",
    "Login Data-journal",
}


def iso_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def sanitize_file_part(value: str, fallback: str = "shop") -> str:
    text = re.sub(r"\s+", " ", str(value or "")).strip()
    text = re.sub(r'[\\/:*?"<>|]+', "_", text)
    text = re.sub(r"\s+", " ", text).strip(" .")
    text = text[:96].strip()
    return text or fallback


def is_generic_shop_name(value: str) -> bool:
    text = clean_row_value(value).lower()
    if not text:
        return True
    return (
        text == "sugargoo"
        or text == "sugargoo shop"
        or text == "shop"
        or bool(re.match(r"^sugargoo shop \d{4}-\d{2}-\d{2}t", text))
    )


def preferred_shop_dir_name(*values: object, fallback: str = "Sugargoo Shop") -> str:
    best = ""
    for value in values:
        candidate = clean_row_value(value)
        if not candidate:
            continue
        if not best:
            best = candidate
            continue
        best_is_generic = is_generic_shop_name(best)
        candidate_is_generic = is_generic_shop_name(candidate)
        if best_is_generic and not candidate_is_generic:
            best = candidate
            continue
        if candidate_is_generic and not best_is_generic:
            continue
        if len(candidate) > len(best):
            best = candidate
    if not best:
        best = fallback
    return sanitize_file_part(best, fallback=fallback)


def ensure_within_root(root_dir: Path, candidate: Path) -> Path:
    resolved_root = root_dir.resolve()
    resolved = candidate.resolve()
    if not resolved.is_relative_to(resolved_root):
        raise ValueError(f"Path escaped workspace root: {resolved}")
    return resolved


def detect_browser_executable() -> Path | None:
    for candidate in [*BRAVE_CANDIDATES, *CHROME_CANDIDATES, *EDGE_CANDIDATES]:
        if candidate.is_file():
            return candidate
    return None


def detect_brave_user_data_dir() -> Path | None:
    for candidate in BRAVE_USER_DATA_CANDIDATES:
        if candidate.is_dir():
            return candidate
    return None


def detect_brave_profile_name(user_data_dir: Path) -> str:
    local_state_path = user_data_dir / "Local State"
    if local_state_path.is_file():
        try:
            payload = json.loads(local_state_path.read_text(encoding="utf-8"))
            profile_payload = payload.get("profile", {}) if isinstance(payload, dict) else {}
            last_used = clean_row_value(profile_payload.get("last_used"))
            if last_used and (user_data_dir / last_used).is_dir():
                return last_used
        except Exception:
            pass

    if (user_data_dir / "Default").is_dir():
        return "Default"

    for entry in sorted(user_data_dir.iterdir(), key=lambda item: item.name.lower()):
        if entry.is_dir() and (entry.name == "Default" or entry.name.startswith("Profile ")):
            return entry.name

    return "Default"


def clean_row_value(value: object) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()


def first_query_value(query: str, name: str) -> str:
    values = parse_qs(query, keep_blank_values=True).get(name, [])
    for value in values:
        cleaned = clean_row_value(value)
        if cleaned:
            return cleaned
    return ""


def decode_repeatedly(value: str, max_rounds: int = 5) -> str:
    current = clean_row_value(value)
    for _ in range(max_rounds):
        if "%" not in current:
            break
        decoded = unquote(current)
        if decoded == current:
            break
        current = decoded
    return current


def extract_offer_id(*values: str) -> str:
    for value in values:
        text = decode_repeatedly(value)
        match = OFFER_ID_RE.search(text)
        if match:
            return match.group(1)
    return ""


def extract_taobao_item_id(*values: str) -> str:
    for value in values:
        text = decode_repeatedly(value)
        match = TAOBAO_ITEM_ID_RE.search(text)
        if match:
            return match.group(1)
    return ""


def sugargoo_product_url_for_source(source_url: str) -> str:
    return f"https://www.sugargoo.com/products?productLink={quote(quote(source_url, safe=''), safe='')}"


def sugargoo_product_url_for_offer(offer_id: str) -> str:
    source_url = f"https://detail.1688.com/offer/{offer_id}.html"
    return sugargoo_product_url_for_source(source_url)


def sugargoo_product_url_for_taobao_item(item_id: str) -> str:
    source_url = f"https://item.taobao.com/item.htm?id={item_id}"
    return sugargoo_product_url_for_source(source_url)


def normalize_queued_url(raw_url: str) -> str:
    url = clean_row_value(raw_url)
    if not url:
        return ""

    parsed = urlsplit(url)
    host = clean_row_value(parsed.netloc).lower()
    if "sugargoo.com" in host:
        return url

    if "1688.com" in host or "cssbuy.com" in host:
        offer_id = extract_offer_id(url)
        if offer_id:
            return sugargoo_product_url_for_offer(offer_id)

    if "taobao.com" in host:
        item_id = extract_taobao_item_id(url)
        if item_id:
            return sugargoo_product_url_for_taobao_item(item_id)

    return url


def url_detection_text(raw_url: str) -> str:
    url = clean_row_value(raw_url)
    parts = [url, decode_repeatedly(url)]
    try:
        parsed = urlsplit(url)
    except Exception:
        return " ".join(parts).lower()

    for query_text in (parsed.query, parsed.fragment.partition("?")[2]):
        values = parse_qs(query_text, keep_blank_values=True)
        for name, raw_values in values.items():
            if name.lower() == "productlink":
                parts.extend(decode_repeatedly(value) for value in raw_values)
    return " ".join(part for part in parts if part).lower()


def is_store_route_url(raw_url: str) -> bool:
    url = clean_row_value(raw_url)
    if not url:
        return False
    parsed = urlsplit(url)
    path = clean_row_value(parsed.path).lower()
    fragment = clean_row_value(parsed.fragment).lower()
    if "/shops/" in path or "/shop/home" in path or "/shops/" in fragment or "/shop/home" in fragment:
        return True

    direct_query = parse_qs(parsed.query, keep_blank_values=True)
    fragment_query = parse_qs(parsed.fragment.partition("?")[2], keep_blank_values=True)
    direct_keys = {key.lower() for key in direct_query}
    fragment_keys = {key.lower() for key in fragment_query}
    return "shopid" in direct_keys or "sellerid" in direct_keys or "shopid" in fragment_keys or "sellerid" in fragment_keys


def shop_identity_key(raw_url: str) -> str:
    url = clean_row_value(raw_url)
    if not url:
        return ""

    parsed = urlsplit(url)

    query_shop_id = first_query_value(parsed.query, "shopid")
    if query_shop_id:
        return f"shopid:{query_shop_id}"

    fragment_shop_id = first_query_value(parsed.fragment.partition("?")[2], "shopid")
    if fragment_shop_id:
        return f"shopid:{fragment_shop_id}"

    path_match = re.search(r"/shops/([^/?#]+)", parsed.path, re.IGNORECASE)
    if path_match:
        return f"shops:{clean_row_value(path_match.group(1))}"

    fragment_path_match = re.search(r"/shops/([^/?#&]+)", parsed.fragment, re.IGNORECASE)
    if fragment_path_match:
        return f"shops:{clean_row_value(fragment_path_match.group(1))}"

    seller_id = first_query_value(parsed.query, "sellerId")
    if seller_id:
        return f"sellerid:{seller_id}"

    fragment_seller_id = first_query_value(parsed.fragment.partition("?")[2], "sellerId")
    if fragment_seller_id:
        return f"sellerid:{fragment_seller_id}"

    normalized_query = "&".join(
        sorted(
            f"{key}={value}"
            for key, values in parse_qs(parsed.query, keep_blank_values=True).items()
            for value in values
            if clean_row_value(value)
        )
    )
    return "|".join(
        [
            clean_row_value(parsed.scheme).lower(),
            clean_row_value(parsed.netloc).lower(),
            clean_row_value(parsed.path),
            normalized_query,
            clean_row_value(parsed.fragment),
        ]
    )


def csv_headers() -> list[str]:
    return list(COMMON_CSV_HEADERS)


@dataclass
class QueueItem:
    item_id: str
    url: str
    status: str = "queued"
    created_at: str = field(default_factory=iso_now)
    started_at: str = ""
    finished_at: str = ""
    message: str = "Queued."
    shop_name: str = ""
    output_dir: str = ""
    listing_count: int = 0
    images_saved: int = 0
    images_failed: int = 0
    progress_phase: str = "queued"
    progress_current: int = 0
    progress_total: int = 0
    progress_percent: float = 0.0
    error: str = ""
    retry_count: int = 0
    retried_from_item_id: str = ""
    force_recrawl: bool = False

    def snapshot(self) -> dict[str, object]:
        return {
            "id": self.item_id,
            "url": self.url,
            "status": self.status,
            "created_at": self.created_at,
            "started_at": self.started_at,
            "finished_at": self.finished_at,
            "message": self.message,
            "shop_name": self.shop_name,
            "output_dir": self.output_dir,
            "listing_count": self.listing_count,
            "images_saved": self.images_saved,
            "images_failed": self.images_failed,
            "progress_phase": self.progress_phase,
            "progress_current": self.progress_current,
            "progress_total": self.progress_total,
            "progress_percent": self.progress_percent,
            "error": self.error,
            "retry_count": self.retry_count,
            "retried_from_item_id": self.retried_from_item_id,
            "force_recrawl": self.force_recrawl,
        }

    @classmethod
    def from_snapshot(cls, payload: dict[str, object]) -> "QueueItem":
        return cls(
            item_id=str(payload.get("id") or payload.get("item_id") or ""),
            url=clean_row_value(payload.get("url")),
            status=clean_row_value(payload.get("status")) or "queued",
            created_at=clean_row_value(payload.get("created_at")) or iso_now(),
            started_at=clean_row_value(payload.get("started_at")),
            finished_at=clean_row_value(payload.get("finished_at")),
            message=clean_row_value(payload.get("message")) or "Queued.",
            shop_name=clean_row_value(payload.get("shop_name")),
            output_dir=clean_row_value(payload.get("output_dir")),
            listing_count=int(payload.get("listing_count") or 0),
            images_saved=int(payload.get("images_saved") or 0),
            images_failed=int(payload.get("images_failed") or 0),
            progress_phase=clean_row_value(payload.get("progress_phase")) or "queued",
            progress_current=int(payload.get("progress_current") or 0),
            progress_total=int(payload.get("progress_total") or 0),
            progress_percent=float(payload.get("progress_percent") or 0.0),
            error=clean_row_value(payload.get("error")),
            retry_count=int(payload.get("retry_count") or 0),
            retried_from_item_id=clean_row_value(payload.get("retried_from_item_id")),
            force_recrawl=bool(payload.get("force_recrawl")),
        )


class CrawlerQueueManager:
    def __init__(self, root_dir: Path, *, refresh_callback: Callable[[], None] | None = None) -> None:
        self.root_dir = root_dir
        self.refresh_callback = refresh_callback
        self.browser_executable = detect_browser_executable()
        self.scraped_data_dir = ensure_within_root(self.root_dir, self.root_dir / SCRAPED_DATA_DIR_NAME)
        self.profile_dir = self.root_dir / QUEUE_CACHE_DIR / PROFILE_DIR_NAME
        self.exchange_rate_cache_path = DEFAULT_EXCHANGE_RATE_CACHE_PATH
        self.source_user_data_dir = detect_brave_user_data_dir()
        self.source_profile_name = (
            detect_brave_profile_name(self.source_user_data_dir) if self.source_user_data_dir else "Default"
        )
        self.state_path = self.root_dir / QUEUE_CACHE_DIR / QUEUE_STATE_FILE_NAME
        legacy_state_path = self.root_dir / QUEUE_CACHE_DIR / LEGACY_QUEUE_STATE_FILE_NAME
        if not self.state_path.exists() and legacy_state_path.is_file():
            self.state_path.parent.mkdir(parents=True, exist_ok=True)
            legacy_state_path.replace(self.state_path)
        self.crawler_script = CRAWLER_SCRIPT_PATH.read_text(encoding="utf-8")

        self._lock = threading.RLock()
        self._items: list[QueueItem] = []
        self._worker: threading.Thread | None = None
        self._stop_event = threading.Event()
        self._active_context: BrowserContext | None = None
        self._last_error = ""
        self._load_state()
        with self._lock:
            if self.browser_executable and any(item.status == "queued" for item in self._items):
                self._ensure_worker_locked()

    def status(self) -> dict[str, object]:
        with self._lock:
            active = next((item.item_id for item in self._items if item.status == "running"), "")
            return {
                "enabled": self.browser_executable is not None,
                "browser_path": str(self.browser_executable) if self.browser_executable else "",
                "browser_visible": True,
                "profile_path": str(self.profile_dir),
                "source_profile_name": self.source_profile_name,
                "source_user_data_dir": str(self.source_user_data_dir) if self.source_user_data_dir else "",
                "busy": any(item.status == "running" for item in self._items),
                "active_item_id": active,
                "queue_length": sum(1 for item in self._items if item.status == "queued"),
                "last_error": self._last_error,
                "items": [item.snapshot() for item in self._items[-40:]],
            }

    def _known_saved_store_keys(self) -> set[str]:
        keys: set[str] = set()
        if not self.scraped_data_dir.is_dir():
            return keys
        for manifest_path in self.scraped_data_dir.rglob("manifest.json"):
            info = self._read_existing_manifest_info(manifest_path)
            if not info or not self._existing_data_is_complete_enough(info):
                continue
            key = shop_identity_key(info.get("source_url"))
            if key:
                keys.add(key)
        return keys

    def enqueue(self, urls: list[str], *, force: bool = False) -> list[dict[str, object]]:
        if not self.browser_executable:
            raise RuntimeError("Brave Browser was not found on this machine.")

        saved_store_keys = self._known_saved_store_keys()
        cleaned_urls: list[str] = []
        seen: set[str] = set()
        for raw_url in urls:
            url = normalize_queued_url(str(raw_url))
            if not url or url in seen:
                continue
            parsed = urlsplit(url)
            if parsed.scheme not in {"http", "https"} or not parsed.netloc:
                continue
            cleaned_urls.append(url)
            seen.add(url)

        if not cleaned_urls:
            raise ValueError("No valid http(s) URLs were provided.")

        added: list[QueueItem] = []
        with self._lock:
            queued_store_keys = {
                key
                for item in self._items
                if item.status in {"queued", "running"}
                for key in [shop_identity_key(item.url)]
                if key
            }
            for index, url in enumerate(cleaned_urls, start=1):
                store_key = shop_identity_key(url)
                if store_key and store_key in queued_store_keys:
                    continue
                if not force and store_key and store_key in saved_store_keys:
                    continue
                item = QueueItem(
                    item_id=f"{int(datetime.now().timestamp())}-{len(self._items) + index}",
                    url=url,
                    message="Queued for full recrawl." if force else "Queued.",
                    force_recrawl=force,
                )
                self._items.append(item)
                added.append(item)
                if store_key:
                    queued_store_keys.add(store_key)
            if not added:
                if force:
                    raise ValueError("All provided store URLs are already queued or running.")
                raise ValueError("All provided store URLs are already collected or already queued.")
            self._persist_state_locked()
            self._ensure_worker_locked()
        return [item.snapshot() for item in added]

    def retry_item(self, item_id: str) -> dict[str, object]:
        with self._lock:
            original = next((item for item in self._items if item.item_id == item_id), None)
            if original is None:
                raise ValueError("Queue item was not found.")
            if original.status == "running":
                raise ValueError("That queue item is still running.")

            retried = QueueItem(
                item_id=f"{int(datetime.now().timestamp())}-{len(self._items) + 1}",
                url=original.url,
                message="Queued for retry.",
                retry_count=original.retry_count + 1,
                retried_from_item_id=original.item_id,
            )
            self._items.append(retried)
            self._persist_state_locked()
            self._ensure_worker_locked()
            return retried.snapshot()

    def _ensure_worker_locked(self) -> None:
        if self._worker and self._worker.is_alive():
            return
        self._stop_event.clear()
        self._worker = threading.Thread(target=self._worker_loop, daemon=True, name="CollectorQueueWorker")
        self._worker.start()

    def shutdown(self) -> None:
        self._stop_event.set()
        self._close_context(self._active_context)
        worker = self._worker
        if worker and worker.is_alive():
            worker.join(timeout=5)

    def _shop_target_dir(self, shop_name: str) -> Path:
        return ensure_within_root(self.root_dir, self.scraped_data_dir / shop_name)

    def _read_existing_manifest_info(self, manifest_path: Path) -> dict[str, object] | None:
        if not manifest_path.is_file():
            return None
        try:
            payload = json.loads(manifest_path.read_text(encoding="utf-8"))
        except Exception:
            return None
        if not isinstance(payload, dict):
            return None

        rows = payload.get("rows")
        if not isinstance(rows, list) or not rows:
            return None

        status = clean_row_value(payload.get("status")).lower()
        if status in {"checkpoint", "error", "failed"}:
            return None

        shop_name = preferred_shop_dir_name(payload.get("shop_name"), manifest_path.parent.name, fallback="Sugargoo Shop")
        return {
            "manifest_path": str(manifest_path),
            "target_dir": str(manifest_path.parent),
            "shop_name": shop_name,
            "row_count": len(rows),
            "source_url": clean_row_value(payload.get("source_url")),
            "pages_visited": int(payload.get("pages_visited") or 0),
            "completion_reason": clean_row_value(payload.get("completion_reason")),
            "stopped_early": bool(payload.get("stopped_early")),
            "status": status,
        }

    def _existing_data_is_complete_enough(self, info: dict[str, object]) -> bool:
        row_count = int(info.get("row_count") or 0)
        pages_visited = int(info.get("pages_visited") or 0)
        reason = clean_row_value(info.get("completion_reason")).lower()
        stopped_early = bool(info.get("stopped_early"))

        if stopped_early:
            return False

        suspicious_near_sugargoo_page_cap = (
            row_count >= SUSPICIOUS_PAGINATION_ROW_FLOOR
            and pages_visited >= SUSPICIOUS_PAGINATION_PAGE_FLOOR
            and "next page stopped changing" in reason
        )
        return not suspicious_near_sugargoo_page_cap

    def _existing_shop_data(self, shop_name: str) -> dict[str, object] | None:
        if not shop_name or is_generic_shop_name(shop_name):
            return None
        return self._read_existing_manifest_info(self._shop_target_dir(shop_name) / "manifest.json")

    def _existing_store_url_data(self, store_url: str) -> dict[str, object] | None:
        store_key = shop_identity_key(store_url)
        if not store_key or not self.scraped_data_dir.is_dir():
            return None
        for manifest_path in self.scraped_data_dir.rglob("manifest.json"):
            info = self._read_existing_manifest_info(manifest_path)
            if not info:
                continue
            if shop_identity_key(clean_row_value(info.get("source_url"))) == store_key:
                return info
        return None

    def _derive_page_shop_name(self, page, item: QueueItem) -> str:
        try:
            dom_shop_name = page.evaluate(
                """() => {
                    const clean = (value) => String(value || "").replace(/\\s+/g, " ").trim();
                    const selectors = [
                      ".shop-info h1",
                      ".shop-info h2",
                      ".shop-info .name",
                      ".shop-name",
                      '[class*="shop"] h1',
                      '[class*="shop"] h2',
                      '[data-testid="shop-name"]',
                    ];
                    for (const selector of selectors) {
                      const value = clean(document.querySelector(selector)?.textContent || "");
                      if (value) {
                        return value;
                      }
                    }
                    return "";
                  }"""
            )
        except Exception:
            dom_shop_name = ""
        return preferred_shop_dir_name(item.shop_name, dom_shop_name, fallback="Sugargoo Shop")

    def _existing_data_for_current_store(self, page, item: QueueItem, source_url: str) -> dict[str, object] | None:
        shop_name = self._derive_page_shop_name(page, item)
        if item.force_recrawl:
            if shop_name and not is_generic_shop_name(shop_name):
                self._update_item(
                    item.item_id,
                    message="Full recrawl requested; ignoring existing saved data.",
                    shop_name=shop_name,
                    output_dir=str(self._shop_target_dir(shop_name)),
                )
                item.shop_name = shop_name
            return None

        existing = self._existing_store_url_data(source_url) or self._existing_shop_data(shop_name)
        if existing and self._existing_data_is_complete_enough(existing):
            return existing
        if existing:
            self._update_item(
                item.item_id,
                message=(
                    "Existing store data looks partial near Sugargoo's pagination boundary; "
                    "collecting it again instead of skipping."
                ),
            )
        if shop_name and not is_generic_shop_name(shop_name):
            self._update_item(
                item.item_id,
                shop_name=shop_name,
                output_dir=str(self._shop_target_dir(shop_name)),
            )
            item.shop_name = shop_name
        return None

    def _pop_next_item(self) -> QueueItem | None:
        with self._lock:
            for item in self._items:
                if item.status == "queued":
                    item.status = "running"
                    item.started_at = iso_now()
                    item.message = "Launching local browser automation."
                    item.progress_phase = "opening"
                    item.progress_current = 0
                    item.progress_total = 0
                    item.progress_percent = 3.0
                    item.error = ""
                    self._last_error = ""
                    self._persist_state_locked()
                    return item
        return None

    def _update_item(self, item_id: str, **fields: object) -> None:
        with self._lock:
            for item in self._items:
                if item.item_id != item_id:
                    continue
                for key, value in fields.items():
                    setattr(item, key, value)
                self._persist_state_locked()
                return

    def _worker_loop(self) -> None:
        context: BrowserContext | None = None
        try:
            with sync_playwright() as playwright:
                while True:
                    if self._stop_event.is_set():
                        return
                    item = self._pop_next_item()
                    if not item:
                        return

                    attempts = 0
                    while True:
                        attempts += 1
                        try:
                            context = self._ensure_context(playwright, context)
                            self._run_item(context, item)
                            break
                        except Exception as exc:  # noqa: BLE001
                            self._last_error = str(exc)
                            if self._should_relaunch_context(exc) and attempts < 2:
                                self._update_item(
                                    item.item_id,
                                    message="Browser session dropped. Relaunching once and retrying.",
                                    error=str(exc),
                                )
                                context = self._relaunch_context(playwright, context)
                                continue
                            self._update_item(
                                item.item_id,
                                status="error",
                                finished_at=iso_now(),
                                message="Collection failed.",
                                progress_phase="error",
                                error=str(exc),
                            )
                            break
        except Exception as exc:  # noqa: BLE001
            self._last_error = str(exc)
            with self._lock:
                for item in self._items:
                    if item.status in {"queued", "running"}:
                        item.status = "error"
                        item.finished_at = iso_now()
                        item.message = "Collection queue stopped."
                        item.progress_phase = "error"
                        item.error = str(exc)
                self._persist_state_locked()
        finally:
            self._close_context(context)
            self._active_context = None

    def _ensure_context(self, playwright: Playwright, context: BrowserContext | None) -> BrowserContext:
        if context is not None:
            try:
                _ = context.pages
                return context
            except Exception:
                pass
        context = self._launch_context(playwright)
        self._active_context = context
        return context

    def _relaunch_context(self, playwright: Playwright, context: BrowserContext | None) -> BrowserContext:
        self._close_context(context)
        replacement = self._launch_context(playwright)
        self._active_context = replacement
        return replacement

    def _close_context(self, context: BrowserContext | None) -> None:
        if context is None:
            return
        try:
            context.close()
        except Exception:
            pass
        if context is self._active_context:
            self._active_context = None

    def _should_relaunch_context(self, exc: Exception) -> bool:
        message = clean_row_value(exc).lower()
        triggers = (
            "target page, context or browser has been closed",
            "failed to open a new tab",
            "target.createtarget",
            "browsercontext.new_page",
            "has been closed",
            "browser has been closed",
            "context closed",
            "target closed",
            "session closed",
        )
        return any(trigger in message for trigger in triggers)

    def _load_state(self) -> None:
        if not self.state_path.is_file():
            return
        try:
            payload = json.loads(self.state_path.read_text(encoding="utf-8"))
        except Exception:
            return
        if not isinstance(payload, dict):
            return

        loaded_items: list[QueueItem] = []
        for raw_item in payload.get("items", []):
            if not isinstance(raw_item, dict):
                continue
            item = QueueItem.from_snapshot(raw_item)
            if not item.item_id or not item.url:
                continue
            if item.status == "running":
                item.status = "queued"
                item.started_at = ""
                item.finished_at = ""
                item.message = "Recovered after restart. Waiting to resume."
                item.error = ""
            loaded_items.append(item)

        with self._lock:
            self._items = loaded_items[-200:]
            self._last_error = clean_row_value(payload.get("last_error"))
            self._persist_state_locked()

    def _persist_state_locked(self) -> None:
        self.state_path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "saved_at": iso_now(),
            "last_error": self._last_error,
            "items": [item.snapshot() for item in self._items[-200:]],
        }
        temp_path = self.state_path.with_suffix(".tmp")
        temp_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        temp_path.replace(self.state_path)

    def _kill_zombie_browsers(self) -> None:
        import subprocess
        try:
            cmd = [
                "powershell", "-NoProfile", "-Command",
                f"Get-WmiObject Win32_Process -Filter \"name='brave.exe' or name='chrome.exe' or name='msedge.exe'\" | Where-Object {{ $_.CommandLine -like '*{PROFILE_DIR_NAME}*' }} | ForEach-Object {{ Stop-Process -Id $_.ProcessId -Force }}"
            ]
            subprocess.run(cmd, capture_output=True, creationflags=subprocess.CREATE_NO_WINDOW)
        except Exception:
            pass

    def _launch_context(self, playwright: Playwright) -> BrowserContext:
        assert self.browser_executable is not None
        self._kill_zombie_browsers()
        self._sync_brave_profile_clone()
        context = playwright.chromium.launch_persistent_context(
            user_data_dir=str(self.profile_dir),
            executable_path=str(self.browser_executable),
            headless=False,
            viewport={"width": 1500, "height": 980},
            args=[
                "--disable-blink-features=AutomationControlled",
                "--no-first-run",
                "--no-default-browser-check",
                "--disable-session-crashed-bubble",
                "--disable-features=InfiniteSessionRestore",
                "--homepage=about:blank",
                f"--profile-directory={self.source_profile_name}",
            ],
        )
        try:
            context.add_cookies([{
                "name": "currency",
                "value": "CNY",
                "domain": ".sugargoo.com",
                "path": "/"
            }, {
                "name": "user_currency",
                "value": "CNY",
                "domain": ".sugargoo.com",
                "path": "/"
            }])
        except Exception:
            pass
        context.add_init_script("""
            try {
                const codes = ['currency', 'user_currency', 'lang_currency', 'currencyCode', 'STORE_CURRENCY'];
                codes.forEach(c => window.localStorage.setItem(c, 'CNY'));
                codes.forEach(c => { document.cookie = c + '=CNY; path=/; domain=.sugargoo.com; max-age=31536000'; });
            } catch (e) {}
        """)
        return context

    def _sync_brave_profile_clone(self) -> None:
        self.profile_dir.parent.mkdir(parents=True, exist_ok=True)
        profile_marker = self.profile_dir / ".profile_clone_ready"
        target_profile_dir = self.profile_dir / self.source_profile_name
        marker_value = ""
        try:
            if profile_marker.is_file():
                marker_value = profile_marker.read_text(encoding="utf-8").strip()
        except Exception:
            marker_value = ""
        if marker_value == PROFILE_CLONE_VERSION and target_profile_dir.is_dir():
            return

        if self.profile_dir.exists():
            shutil.rmtree(self.profile_dir, ignore_errors=True)

        self.profile_dir.mkdir(parents=True, exist_ok=True)

        if not self.source_user_data_dir or not self.source_user_data_dir.is_dir():
            return

        for root_file in BRAVE_ROOT_FILES_TO_COPY:
            source_file = self.source_user_data_dir / root_file
            target_file = self.profile_dir / root_file
            if not source_file.is_file():
                continue
            try:
                shutil.copy2(source_file, target_file)
            except Exception:
                pass

        source_profile_dir = self.source_user_data_dir / self.source_profile_name
        target_profile_dir.mkdir(parents=True, exist_ok=True)
        if not source_profile_dir.is_dir():
            return

        for source_path in source_profile_dir.rglob("*"):
            try:
                relative_path = source_path.relative_to(source_profile_dir)
            except ValueError:
                continue

            if any(part in PROFILE_SKIP_PARTS for part in relative_path.parts):
                continue
            if source_path.name in PROFILE_SKIP_NAMES:
                continue

            target_path = target_profile_dir / relative_path
            if source_path.is_dir():
                target_path.mkdir(parents=True, exist_ok=True)
                continue
            try:
                target_path.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(source_path, target_path)
            except Exception:
                continue
        profile_marker.write_text(PROFILE_CLONE_VERSION, encoding="utf-8")

    def _run_item(self, context: BrowserContext, item: QueueItem) -> None:
        page = self._acquire_crawler_page(context)
        
        crawl_logs: list[str] = []
        setattr(item, '_crawl_logs', crawl_logs)

        def handle_console(msg) -> None:
            try:
                text = f"[{iso_now()}] [{msg.type}] {msg.text}"
                print(f"[{item.shop_name or 'Crawler'}] {text}", flush=True)
                crawl_logs.append(text)
            except Exception:
                pass

        page.on("console", handle_console)

        try:
            page.set_default_timeout(CRAWLER_WAIT_TIMEOUT_MS)
            page.bring_to_front()
            page, source_url = self._prepare_shop_page(page, item)

            existing = self._existing_data_for_current_store(page, item, source_url)
            if existing:
                shop_name = clean_row_value(existing.get("shop_name")) or item.shop_name or "Sugargoo Shop"
                row_count = int(existing.get("row_count") or 0)
                output_dir = clean_row_value(existing.get("target_dir"))
                self._update_item(
                    item.item_id,
                    status="completed",
                    finished_at=iso_now(),
                    message=f"Already have data for {shop_name}; skipped collection and image downloads.",
                    shop_name=shop_name,
                    listing_count=row_count,
                    output_dir=output_dir,
                    progress_phase="completed",
                    progress_current=row_count,
                    progress_total=row_count,
                    progress_percent=100.0,
                )
                self._last_error = ""
                with self._lock:
                    self._persist_state_locked()
                return

            self._update_item(
                item.item_id,
                message="Collecting seller page listings.",
                progress_phase="collecting",
                progress_current=0,
                progress_total=0,
                progress_percent=22.0,
            )
            page.evaluate("window.__SUGARGOO_CRAWLER_DISABLE_AUTORUN__ = true;")
            page.add_script_tag(content=self.crawler_script)
            page.evaluate(
                """() => {
                    if (!window.runSugargooLiveCrawl) {
                      throw new Error("Sugargoo collector function was not injected.");
                    }
                    window.__SUGARGOO_CRAWLER_RESULT = null;
                    window.__SUGARGOO_CRAWLER_ERROR = "";
                    window.__SUGARGOO_CRAWLER_RUNNING = true;
                    window.__SUGARGOO_CRAWLER_RUNTIME = null;
                    Promise.resolve()
                      .then(() => window.runSugargooLiveCrawl({
                        saveToFolderAsYouGo: false,
                        downloadCsv: false,
                        downloadImagesZip: false,
                        clickLoadMore: false,
                        maxScrollRoundsPerPage: 0,
                        checkpointEveryPages: 1,
                      }))
                      .then((result) => {
                        window.__SUGARGOO_CRAWLER_RESULT = result;
                        window.__SUGARGOO_CRAWLER_RUNNING = false;
                      })
                      .catch((error) => {
                        window.__SUGARGOO_CRAWLER_ERROR = String(error?.message || error || "Unknown collection error.");
                        window.__SUGARGOO_CRAWLER_RUNNING = false;
                      });
                  }"""
            )

            result = self._wait_for_crawler_result(page, item)

            rows = result.get("rows") if isinstance(result, dict) else None
            if not isinstance(rows, list) or not rows:
                raise RuntimeError("No listings were collected from the page.")

            shop_name = preferred_shop_dir_name(
                result.get("resolved_shop_name"),
                result.get("shop_name"),
                item.shop_name,
                fallback="Sugargoo Shop",
            )
            target_dir = self._shop_target_dir(shop_name)
            self._update_item(
                item.item_id,
                message=f"Saving {len(rows)} listings into {SCRAPED_DATA_DIR_NAME}/{shop_name}.",
                shop_name=shop_name,
                listing_count=len(rows),
                output_dir=str(target_dir),
                progress_phase="saving",
                progress_current=0,
                progress_total=len(rows),
                progress_percent=86.0,
            )

            saved, failed = self._save_shop_output(
                item=item,
                target_dir=target_dir,
                shop_name=shop_name,
                source_url=source_url,
                scraped_at=str(result.get("scraped_at") or iso_now()),
                pages_visited=int(result.get("pages_visited") or 0),
                completion_reason=clean_row_value(result.get("completion_reason")),
                stopped_early=bool(result.get("stopped_early")),
                rows=rows,
                sort_summaries=result.get("sort_summaries") if isinstance(result.get("sort_summaries"), list) else None,
            )
            self._update_item(
                item.item_id,
                status="completed",
                finished_at=iso_now(),
                message=f"Saved {len(rows)} listings to {shop_name}.",
                images_saved=saved,
                images_failed=failed,
                progress_phase="completed",
                progress_current=len(rows),
                progress_total=len(rows),
                progress_percent=100.0,
            )

            if self.refresh_callback:
                self.refresh_callback()
            self._last_error = ""
            with self._lock:
                self._persist_state_locked()
        finally:
            if page and not page.is_closed():
                try:
                    page.goto("about:blank", wait_until="domcontentloaded")
                except Exception:
                    pass

    def _acquire_crawler_page(self, context: BrowserContext):
        page = context.new_page()
        for extra_page in [candidate for candidate in context.pages if candidate != page and not candidate.is_closed()]:
            try:
                extra_page.close()
            except Exception:
                continue
        return page

    def _wait_for_crawler_result(self, page, item: QueueItem) -> dict[str, object]:
        last_revision = -1
        checkpoint_shop_name = ""
        checkpoint_dir: Path | None = None
        checkpoint_rows = 0
        checkpoint_pages = 0
        best_shop_name = preferred_shop_dir_name(item.shop_name, fallback="")

        while True:
            snapshot = page.evaluate(
                """() => {
                    const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
                    const deriveDomShopName = () => {
                      const selectors = [
                        ".shop-info h1",
                        ".shop-info h2",
                        ".shop-info .name",
                        ".shop-name",
                        '[class*="shop"] h1',
                        '[class*="shop"] h2',
                        '[data-testid="shop-name"]',
                      ];
                      for (const selector of selectors) {
                        const value = clean(document.querySelector(selector)?.textContent || "");
                        if (value) {
                          return value;
                        }
                      }
                      return "";
                    };
                    const runtime = window.__SUGARGOO_CRAWLER_RUNTIME || null;
                    const result = window.__SUGARGOO_CRAWLER_RESULT || null;
                    return {
                      running: Boolean(window.__SUGARGOO_CRAWLER_RUNNING),
                      error: String(window.__SUGARGOO_CRAWLER_ERROR || ""),
                      runtime,
                      domShopName: deriveDomShopName(),
                      resultMeta: result ? {
                        shop_name: result.shop_name || "",
                        scraped_at: result.scraped_at || "",
                        row_count: Number(result.row_count || 0),
                        pages_visited: Number(result.pages_visited || 0),
                        completion_reason: result.completion_reason || "",
                        stopped_early: Boolean(result.stopped_early),
                      } : null,
                    };
                  }"""
            )

            runtime = snapshot.get("runtime") if isinstance(snapshot, dict) else None
            dom_shop_name = clean_row_value(snapshot.get("domShopName")) if isinstance(snapshot, dict) else ""
            if dom_shop_name and not is_generic_shop_name(dom_shop_name):
                best_shop_name = preferred_shop_dir_name(best_shop_name, dom_shop_name, fallback="")
            if best_shop_name and best_shop_name != clean_row_value(item.shop_name):
                self._update_item(
                    item.item_id,
                    shop_name=best_shop_name,
                    output_dir=str(self._shop_target_dir(best_shop_name)),
                )
                item.shop_name = best_shop_name
            if isinstance(runtime, dict):
                runtime_shop_name = clean_row_value(runtime.get("shopName"))
                shop_name = (
                    preferred_shop_dir_name(best_shop_name, runtime_shop_name, dom_shop_name, fallback="")
                    if any(
                        candidate and not is_generic_shop_name(str(candidate))
                        for candidate in (runtime_shop_name, dom_shop_name, best_shop_name)
                    )
                    else ""
                )
                pages_visited = int(runtime.get("pagesVisited") or 0)
                unique_rows = int(runtime.get("uniqueRows") or 0)
                checkpoint_page = int(runtime.get("lastCheckpointPage") or 0)
                message = clean_row_value(runtime.get("message")) or f"Collecting page {max(pages_visited, 1)}."
                message = re.sub(r"\bscraping\b", "collecting", message, flags=re.IGNORECASE)
                message = re.sub(r"\bcrawler\b", "collector", message, flags=re.IGNORECASE)
                if shop_name and not checkpoint_shop_name:
                    checkpoint_shop_name = shop_name
                    best_shop_name = preferred_shop_dir_name(best_shop_name, shop_name, fallback="")
                    checkpoint_dir = self._shop_target_dir(checkpoint_shop_name)
                    self._update_item(
                        item.item_id,
                        shop_name=checkpoint_shop_name,
                        output_dir=str(checkpoint_dir),
                    )
                self._update_item(
                    item.item_id,
                    message=f"{message} {unique_rows} unique rows across {pages_visited} pages.",
                    listing_count=unique_rows,
                    progress_phase="collecting",
                    progress_current=pages_visited,
                    progress_total=0,
                    progress_percent=min(85.0, 22.0 + max(pages_visited, 1) * 4.0),
                )

                revision = int(runtime.get("exportRevision") or 0)
                if revision > last_revision and checkpoint_page > checkpoint_pages and checkpoint_dir is not None:
                    result_meta = snapshot.get("resultMeta") if isinstance(snapshot, dict) else None
                    if not isinstance(result_meta, dict):
                        result_meta = {}
                    rows = page.evaluate(
                        """() => {
                            const result = window.__SUGARGOO_CRAWLER_RESULT;
                            if (result && Array.isArray(result.rows)) {
                              return result.rows;
                            }
                            const runtime = window.__SUGARGOO_CRAWLER_RUNTIME;
                            if (!runtime) {
                              return [];
                            }
                            return [];
                          }"""
                    )
                    if not rows:
                        rows = page.evaluate(
                            """() => {
                                const runtime = window.__SUGARGOO_CRAWLER_RUNTIME;
                                if (!runtime) {
                                  return [];
                                }
                                return Array.from(
                                  (window.__SUGARGOO_CRAWLER_EXPORT_ROWS && window.__SUGARGOO_CRAWLER_EXPORT_ROWS()) || []
                                );
                              }"""
                        )
                    if isinstance(rows, list) and rows:
                        checkpoint_scraped_at = clean_row_value(result_meta.get("scraped_at")) or iso_now()
                        self._write_shop_checkpoint(
                            item=item,
                            target_dir=checkpoint_dir,
                            shop_name=checkpoint_shop_name or shop_name,
                            source_url=item.url,
                            scraped_at=checkpoint_scraped_at,
                            pages_visited=pages_visited,
                            completion_reason=clean_row_value(runtime.get("completionReason")),
                            stopped_early=bool(runtime.get("stoppedEarly")),
                            rows=rows,
                        )
                        checkpoint_rows = len(rows)
                        checkpoint_pages = checkpoint_page
                        self._update_item(
                            item.item_id,
                            message=f"Checkpoint saved: {checkpoint_rows} rows after {checkpoint_pages} pages.",
                            listing_count=checkpoint_rows,
                        )
                    last_revision = revision

            if snapshot.get("running"):
                page.wait_for_timeout(CRAWLER_PROGRESS_POLL_MS)
                continue

            error = clean_row_value(snapshot.get("error"))
            if error:
                raise RuntimeError(error)

            result = page.evaluate("() => window.__SUGARGOO_CRAWLER_RESULT || null")
            if not isinstance(result, dict):
                raise RuntimeError("Collection ended without returning a result.")
            resolved_shop_name = preferred_shop_dir_name(
                best_shop_name,
                result.get("shop_name"),
                snapshot.get("domShopName") if isinstance(snapshot, dict) else "",
                fallback="",
            )
            if resolved_shop_name:
                result["resolved_shop_name"] = resolved_shop_name
            return result

    def _prepare_shop_page(self, page, item: QueueItem):
        self._update_item(
            item.item_id,
            message=(
                "Opening queued Sugargoo page in the collection browser. "
                "You can add more URLs to the queue while this is running."
            ),
            progress_phase="opening",
            progress_percent=5.0,
        )
        page = self._goto_queued_url(page, item)
        self._wait_for_login_if_needed(page, item)

        must_resolve_store = self._should_resolve_listing_to_store(page, item.url)
        if must_resolve_store:
            page = self._navigate_listing_to_store(page, item)
            self._wait_for_login_if_needed(page, item)

        self._wait_for_shop_results(page, item, require_store_page=must_resolve_store)
        resolved_url = clean_row_value(page.url) or item.url
        if resolved_url != item.url:
            item.url = resolved_url
            self._update_item(item.item_id, url=resolved_url)
        return page, resolved_url

    def _goto_queued_url(self, page, item: QueueItem):
        for attempt in range(2):
            try:
                if page.is_closed():
                    page = self._acquire_crawler_page(page.context)
                page.goto(item.url, wait_until="domcontentloaded")
                page.wait_for_timeout(2_500)
                return page
            except Exception as exc:  # noqa: BLE001
                if attempt >= 1 or not self._should_relaunch_context(exc):
                    raise
                self._update_item(
                    item.item_id,
                    message="Browser tab closed during startup. Opening one clean tab and retrying.",
                    error=str(exc),
                )
                page = self._acquire_crawler_page(page.context)
        return page

    def _should_resolve_listing_to_store(self, page, original_url: str) -> bool:
        if is_store_route_url(clean_row_value(page.url)):
            return False

        current_url = url_detection_text(clean_row_value(page.url))
        queued_url = url_detection_text(original_url)
        listing_markers = (
            "/products?",
            "productlink=",
            "/product/",
            "detail.1688.com/offer/",
            "item.taobao.com/item.htm",
        )
        current_is_listing = any(marker in current_url for marker in listing_markers)
        queued_is_listing = any(marker in queued_url for marker in listing_markers)
        return current_is_listing or (queued_is_listing and not self._shop_results_visible(page))

    def _shop_results_visible(self, page) -> bool:
        return page.locator(PRODUCT_SELECTOR).count() > 0

    def _is_store_page(self, page) -> bool:
        if is_store_route_url(clean_row_value(page.url)):
            return True
        try:
            current_url = url_detection_text(clean_row_value(page.url))
            listing_markers = ("/products?", "productlink=", "/product/", "item.taobao.com/item.htm")
            return page.locator(".shop-products").count() > 0 and not any(marker in current_url for marker in listing_markers)
        except Exception:
            return False

    def _navigate_listing_to_store(self, page, item: QueueItem):
        self._update_item(
            item.item_id,
            message="Queued URL is a Sugargoo listing. Looking for the store button before collecting.",
            progress_phase="resolving-store",
            progress_percent=10.0,
        )
        deadline = time.time() + STORE_NAVIGATION_TIMEOUT_SECS
        clicked = False

        while time.time() < deadline:
            if self._is_store_page(page) and self._shop_results_visible(page):
                return page

            playwright_click = self._click_visible_store_control(page)
            if playwright_click:
                clicked = True
                self._update_item(
                    item.item_id,
                    message=f"Clicked seller store control: {playwright_click}.",
                    progress_phase="loading-store",
                    progress_percent=15.0,
                )
                return self._wait_for_store_navigation(page, item)

            clicked_result = page.evaluate(
                """() => {
                    const clean = (value) => String(value || "").replace(/\\s+/g, " ").trim();
                    const isVisible = (el) => {
                      if (!el) return false;
                      const style = window.getComputedStyle(el);
                      const rect = el.getBoundingClientRect();
                      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
                    };
                    const goodTextPatterns = [
                      /go\\s*to\\s*(store|shop)/i,
                      /enter\\s*(store|shop)/i,
                      /visit\\s*(store|shop)/i,
                      /view\\s*(store|shop)/i,
                      /seller\\s*(store|shop)/i,
                      /all\\s*(store|shop)\\s*items/i,
                      /店铺|进店|进入店铺|店内商品/i,
                      /^(store|shop)$/i,
                    ];
                    const badTextPattern = /(discount|coupon|cart|buy|shipping|login|register|country|language|currency|service|review|report|like|copy|share|search|similar)/i;
                    const shopHrefPattern = /(\\/shops\\/|\\/shop\\/home|[?&#](shopid|sellerId)=)/i;
                    const textSelector = [
                      'a[href]',
                      'button',
                      '[role="button"]',
                      '.store-button',
                      '.shop-button',
                      '[class*="visit"]',
                    ].join(',');
                    const elements = Array.from(
                      document.querySelectorAll(textSelector)
                    );
                    const candidates = [];

                    for (const el of elements) {
                      if (!isVisible(el)) continue;
                      const anchor = el.closest("a[href]") || (el.matches("a[href]") ? el : null);
                      const href = anchor ? anchor.href : "";
                      const text = clean([
                        el.textContent,
                        el.getAttribute("aria-label"),
                        el.getAttribute("title"),
                        anchor?.getAttribute("aria-label"),
                        anchor?.getAttribute("title"),
                      ].filter(Boolean).join(" "));
                      let score = 0;
                      if (href && shopHrefPattern.test(href)) score += 100;
                      if (goodTextPatterns.some((pattern) => pattern.test(text))) score += 80;
                      if (text && badTextPattern.test(text) && !/go\\s*to\\s*(store|shop)/i.test(text)) score -= 80;
                      if (score < 80) continue;
                      candidates.push({ el, anchor, href, text, score });
                    }

                    candidates.sort((left, right) => right.score - left.score);
                    const best = candidates[0];
                    if (!best) return { clicked: false };

                    const target = best.anchor || best.el;
                    if (best.href) {
                      window.location.href = best.href;
                    } else {
                      target.click();
                    }
                    return {
                      clicked: true,
                      text: best.text,
                      href: best.href,
                      score: best.score,
                    };
                  }"""
            )

            if isinstance(clicked_result, dict) and clicked_result.get("clicked"):
                clicked = True
                target_href = clean_row_value(clicked_result.get("href"))
                if target_href and target_href != item.url:
                    item.url = target_href
                    self._update_item(item.item_id, url=target_href)
                target_label = clean_row_value(clicked_result.get("text")) or clean_row_value(clicked_result.get("href"))
                self._update_item(
                    item.item_id,
                    message=f"Opened seller page from listing link: {target_label or 'store button'}.",
                    progress_phase="loading-store",
                    progress_percent=15.0,
                )
                return self._wait_for_store_navigation(page, item)

            page.wait_for_timeout(1_500)

        if clicked:
            raise RuntimeError("Clicked the listing store button, but the seller page did not become ready.")
        raise RuntimeError("Could not find a visible Go To Store button on the Sugargoo listing page.")

    def _click_visible_store_control(self, page) -> str:
        patterns = [
            "Visit Shop",
            "Go to Store",
            "Go To Store",
            "Enter Shop",
            "View Shop",
            "View Store",
            "All products",
            "all products in this store",
            "店铺",
            "进店",
            "进入店铺",
        ]
        selector_templates = [
            "a:has-text({text}), button:has-text({text}), [role='button']:has-text({text})",
        ]

        for text in patterns:
            escaped = json.dumps(text)
            for template in selector_templates:
                selector = template.format(text=escaped)
                locator = page.locator(selector).first
                try:
                    if locator.count() <= 0 or not locator.is_visible(timeout=700):
                        continue
                    locator.click(timeout=2_500)
                    return text
                except Exception:
                    continue
        return ""

    def _wait_for_store_navigation(self, page, item: QueueItem):
        deadline = time.time() + STORE_NAVIGATION_TIMEOUT_SECS
        while time.time() < deadline:
            best_page = self._best_store_page(page.context)
            if best_page and best_page != page:
                self._close_other_pages(page.context, best_page)
                page = best_page
                page.bring_to_front()

            if self._is_store_page(page) and self._shop_results_visible(page):
                self._close_other_pages(page.context, page)
                return page
            if self._page_needs_login(page):
                self._wait_for_login_if_needed(page, item)
                continue
            if page.locator(".shop-products").count() > 0 or page.locator(".shop-info").count() > 0:
                self._update_item(
                    item.item_id,
                    progress_phase="loading-store",
                    progress_percent=18.0,
                )
            page.wait_for_timeout(1_500)
        current_url = clean_row_value(page.url)
        if self._shop_results_visible(page):
            raise RuntimeError(
                "The page still looks like a product listing, not a seller store. "
                f"Current URL: {current_url}"
            )
        raise RuntimeError("Opened the store from the listing page, but no seller listings became visible.")

    def _best_store_page(self, context: BrowserContext):
        pages = [page for page in context.pages if not page.is_closed()]
        for candidate in reversed(pages):
            try:
                if self._is_store_page(candidate):
                    return candidate
            except Exception:
                continue
        return None

    def _close_other_pages(self, context: BrowserContext, keep_page) -> None:
        for candidate in [page for page in context.pages if page != keep_page and not page.is_closed()]:
            try:
                candidate.close()
            except Exception:
                continue

    def _wait_for_login_if_needed(self, page, item: QueueItem) -> None:
        if not self._page_needs_login(page):
            return

        self._switch_register_to_login(page)

        self._update_item(
            item.item_id,
            message=(
                "Sugargoo redirected this collection session to sign-in. "
                "Complete login in the opened collection browser window; the queue will resume automatically."
            ),
        )
        deadline = time.time() + LOGIN_WAIT_TIMEOUT_SECS
        while time.time() < deadline:
            page.wait_for_timeout(1_500)
            if not self._page_needs_login(page):
                break
        if self._page_needs_login(page):
            raise RuntimeError(
                "Sugargoo login was not completed in the collection browser window. "
                "Sign in there, then add the shop URL again."
            )

        self._update_item(item.item_id, message="Login detected. Reloading the seller page.")
        page.goto(item.url, wait_until="domcontentloaded")
        page.wait_for_timeout(2_500)

    def _switch_register_to_login(self, page) -> None:
        current_url = clean_row_value(page.url).lower()
        if "/register" not in current_url:
            return
        for selector in [
            "a:has-text(\"Sign in\")",
            "button:has-text(\"Sign in\")",
            "a:has-text(\"Login\")",
            "button:has-text(\"Login\")",
            "text=Already have an account",
        ]:
            try:
                locator = page.locator(selector).first
                if locator.count() > 0 and locator.is_visible(timeout=800):
                    locator.click(timeout=2_000)
                    page.wait_for_timeout(1_000)
                    return
            except Exception:
                continue

    def _wait_for_shop_results(self, page, item: QueueItem, *, require_store_page: bool = False) -> None:
        deadline = time.time() + SHOP_READY_TIMEOUT_SECS
        while time.time() < deadline:
            if self._shop_results_visible(page) and (not require_store_page or self._is_store_page(page)):
                self._update_item(
                    item.item_id,
                    message="Seller page listings are visible. Preparing collection.",
                    progress_phase="ready",
                    progress_percent=20.0,
                )
                return
            if self._page_needs_login(page):
                self._wait_for_login_if_needed(page, item)
                continue
            if page.locator(".shop-products").count() > 0 or page.locator(".shop-info").count() > 0:
                pass
            page.wait_for_timeout(1_500)
        if require_store_page and self._shop_results_visible(page):
            raise RuntimeError(
                "Product cards are visible, but the browser never reached a seller store page. "
                "The queue will not collect recommendation cards from a product page."
            )
        raise RuntimeError("The shop page loaded, but no listings became visible to the collection browser.")

    def _page_needs_login(self, page) -> bool:
        current_url = str(page.url or "").lower()
        if any(hint in current_url for hint in LOGIN_URL_HINTS):
            return True
        try:
            body_text = clean_row_value(page.locator("body").inner_text(timeout=5_000)).lower()
        except Exception:
            return False
        if page.locator(".shop-products").count() > 0 or page.locator(PRODUCT_SELECTOR).count() > 0:
            return False
        hits = sum(1 for hint in LOGIN_TEXT_HINTS if hint in body_text)
        return hits >= 2

    def _save_shop_output(
        self,
        *,
        item: QueueItem,
        target_dir: Path,
        shop_name: str,
        source_url: str,
        scraped_at: str,
        pages_visited: int,
        completion_reason: str,
        stopped_early: bool,
        rows: list[dict[str, object]],
        sort_summaries: list[dict[str, object]] | None = None,
    ) -> tuple[int, int]:
        target_dir.mkdir(parents=True, exist_ok=True)
        images_dir = ensure_within_root(self.root_dir, target_dir / "images")
        images_dir.mkdir(parents=True, exist_ok=True)

        rates = load_or_refresh_exchange_rates(self.exchange_rate_cache_path)
        self._update_item(
            item.item_id,
            message=(
                f"Normalizing prices to {CANONICAL_PRICE_CURRENCY.upper()} "
                f"using {clean_row_value(rates.get('source'))} {clean_row_value(rates.get('source_date'))}."
            ),
            progress_phase="saving",
            progress_current=0,
            progress_total=len(rows),
            progress_percent=88.0,
        )
        normalized_rows = [normalize_price_row(dict(row), rates) for row in rows]
        manifest_rows, saved, failed = self._download_images(item, normalized_rows, images_dir, referer=source_url)
        csv_path = ensure_within_root(self.root_dir, target_dir / "scraped_listings.csv")
        manifest_path = ensure_within_root(self.root_dir, target_dir / "manifest.json")
        fieldnames = merge_csv_headers([key for row in manifest_rows for key in row.keys()])

        with csv_path.open("w", newline="", encoding="utf-8-sig") as handle:
            writer = csv.DictWriter(handle, fieldnames=fieldnames)
            writer.writeheader()
            for row in manifest_rows:
                writer.writerow({header: clean_row_value(row.get(header)) for header in fieldnames})

        payload = {
            "shop_name": shop_name,
            "source_url": source_url,
            "scraped_at": scraped_at,
            "pages_visited": pages_visited,
            "completion_reason": completion_reason,
            "stopped_early": stopped_early,
            "status": "completed",
            "price_common_currency": CANONICAL_PRICE_CURRENCY,
            "price_exchange_source": clean_row_value(rates.get("source")),
            "price_exchange_date": clean_row_value(rates.get("source_date")),
            "saved": saved,
            "failed": failed,
            "sort_summaries": sort_summaries or [],
            "rows": manifest_rows,
        }
        manifest_path.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")
        
        logs = getattr(item, "_crawl_logs", None)
        if logs:
            try:
                (target_dir / "crawl_log.txt").write_text("\n".join(logs), encoding="utf-8")
            except Exception:
                pass
                
        return saved, failed

    def _write_shop_checkpoint(
        self,
        *,
        item: QueueItem,
        target_dir: Path,
        shop_name: str,
        source_url: str,
        scraped_at: str,
        pages_visited: int,
        completion_reason: str,
        stopped_early: bool,
        rows: list[dict[str, object]],
    ) -> None:
        target_dir.mkdir(parents=True, exist_ok=True)
        images_dir = ensure_within_root(self.root_dir, target_dir / "images")
        images_dir.mkdir(parents=True, exist_ok=True)
        csv_path = ensure_within_root(self.root_dir, target_dir / "scraped_listings.csv")
        manifest_path = ensure_within_root(self.root_dir, target_dir / "manifest.json")
        rates = load_or_refresh_exchange_rates(self.exchange_rate_cache_path, prefer_cache=True)
        normalized_rows = [normalize_price_row(dict(row), rates) for row in rows]
        normalized_rows, saved, failed = self._download_images(
            item,
            normalized_rows,
            images_dir,
            referer=source_url,
            checkpoint=True,
        )
        fieldnames = merge_csv_headers([key for row in normalized_rows for key in row.keys()])

        with csv_path.open("w", newline="", encoding="utf-8-sig") as handle:
            writer = csv.DictWriter(handle, fieldnames=fieldnames)
            writer.writeheader()
            for row in normalized_rows:
                writer.writerow({header: clean_row_value(row.get(header)) for header in fieldnames})

        payload = {
            "shop_name": shop_name,
            "source_url": source_url,
            "scraped_at": scraped_at,
            "pages_visited": pages_visited,
            "completion_reason": completion_reason,
            "stopped_early": stopped_early,
            "status": "checkpoint",
            "price_common_currency": CANONICAL_PRICE_CURRENCY,
            "price_exchange_source": clean_row_value(rates.get("source")),
            "price_exchange_date": clean_row_value(rates.get("source_date")),
            "saved": saved,
            "failed": failed,
            "rows": normalized_rows,
        }
        manifest_path.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")
        
        logs = getattr(item, "_crawl_logs", None)
        if logs:
            try:
                (target_dir / "crawl_log.txt").write_text("\n".join(logs), encoding="utf-8")
            except Exception:
                pass

    def _download_images(
        self,
        item: QueueItem,
        rows: list[dict[str, object]],
        images_dir: Path,
        *,
        referer: str,
        checkpoint: bool = False,
    ) -> tuple[list[dict[str, object]], int, int]:
        manifest_rows: list[dict[str, object] | None] = [None] * len(rows)
        progress_lock = threading.Lock()
        saved = 0
        failed = 0
        completed = 0

        def work(index: int, raw_row: dict[str, object]) -> None:
            nonlocal saved, failed, completed
            row = {key: clean_row_value(value) for key, value in dict(raw_row).items()}
            image_url = row.get("image_url", "")
            base_name = sanitize_file_part(row.get("image_file") or row.get("offer_id") or row.get("title") or f"item-{index+1}", fallback=f"item-{index+1}")
            extension = Path(base_name).suffix.lower()
            if extension not in {".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".svg"}:
                extension = ".jpg"
                row["image_file"] = f"{base_name}{extension}"
            else:
                row["image_file"] = base_name

            if image_url:
                try:
                    file_path = ensure_within_root(self.root_dir, images_dir / row["image_file"])
                    if not file_path.is_file() or file_path.stat().st_size <= 0:
                        payload = self._fetch_image(image_url, referer=referer)
                        file_path.write_bytes(payload)
                    row["zip_path"] = f"images/{row['image_file']}"
                    with progress_lock:
                        saved += 1
                except Exception as exc:  # noqa: BLE001
                    row["error"] = str(exc)
                    with progress_lock:
                        failed += 1

            with progress_lock:
                completed += 1
                if completed == len(rows) or completed % 12 == 0:
                    if checkpoint:
                        self._update_item(
                            item.item_id,
                            message=f"Saving listing images as they are found {completed}/{len(rows)}.",
                            progress_phase="collecting",
                            progress_current=item.progress_current,
                            progress_total=item.progress_total,
                            progress_percent=min(85.0, max(float(item.progress_percent or 22.0), 22.0)),
                            images_saved=saved,
                            images_failed=failed,
                        )
                    else:
                        percent = 90.0 + (completed / max(len(rows), 1)) * 9.0
                        self._update_item(
                            item.item_id,
                            message=f"Downloading listing images {completed}/{len(rows)}.",
                            progress_phase="images",
                            progress_current=completed,
                            progress_total=len(rows),
                            progress_percent=min(99.0, percent),
                            images_saved=saved,
                            images_failed=failed,
                        )
            manifest_rows[index] = row

        max_workers = min(10, max(4, (len(rows) // 40) + 1))
        with ThreadPoolExecutor(max_workers=max_workers) as executor:
            futures = [executor.submit(work, index, row) for index, row in enumerate(rows)]
            for future in futures:
                future.result()

        return [row for row in manifest_rows if isinstance(row, dict)], saved, failed

    def _fetch_image(self, image_url: str, *, referer: str) -> bytes:
        request = Request(
            image_url,
            headers={
                "User-Agent": "Mozilla/5.0 ListingSearchCrawlerQueue/1.0",
                "Accept": "image/*,*/*;q=0.8",
                "Referer": referer,
            },
        )
        try:
            with urlopen(request, timeout=25) as response:
                payload = response.read(IMAGE_DOWNLOAD_MAX_BYTES + 1)
                if len(payload) > IMAGE_DOWNLOAD_MAX_BYTES:
                    raise RuntimeError("Image exceeded download size limit.")
                return payload
        except urllib.error.HTTPError as exc:
            raise RuntimeError(f"HTTP {exc.code}") from exc
        except urllib.error.URLError as exc:
            raise RuntimeError(str(exc.reason)) from exc
