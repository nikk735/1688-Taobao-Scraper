const PAGE_SIZE = 80;
const INITIAL_BROWSE_BATCH = 240;
const IMAGE_HASH_WIDTH = 9;
const IMAGE_HASH_HEIGHT = 8;
const IMAGE_HISTOGRAM_SIZE = 16;
const IMAGE_SAMPLE_SIZE = 32;
const IMAGE_SEARCH_CONCURRENCY = 6;
const IMAGE_WORKER_POOL_SIZE = Math.min(8, Math.max(2, Math.floor((navigator.hardwareConcurrency || 6) / 2)));
const AI_TEXT_SEARCH_TOP_K = 2000;
const AI_TEXT_SEARCH_INCLUDE_LIMIT = 300;
const SEARCH_CHUNK_SIZE = 900;
const INLINE_FILTER_RE = /\b(min|max|minprice|maxprice|price|has|shop|offer|id):(?:"([^"]+)"|'([^']+)'|(\S+))/gi;
const CURRENCY_INFO = {
  usd: { code: "USD", label: "USD", locale: "en-US" },
  cad: { code: "CAD", label: "CAD", locale: "en-CA" },
  cny: { code: "CNY", label: "CNY", locale: "zh-CN" },
};
const STORAGE_KEYS = {
  displayCurrency: "listingSearch.displayCurrency",
  crawlerQueueDraft: "listingSearch.crawlerQueueDraft",
  shopFavorites: "listingSearch.shopFavorites",
  disabledShops: "listingSearch.disabledShops",
};
const BIGRAM_CACHE = new Map();
const MAX_BIGRAM_CACHE_SIZE = 30000;
const IMAGE_SIGNATURE_CACHE = new Map();
const AI_TEXT_MAX_TOKEN_CANDIDATES = 700;
const AI_TEXT_MAX_FUZZY_TOKENS_PER_TERM = 24;
const AI_TEXT_MAX_CANDIDATE_ROWS = 9000;
const AI_TEXT_LOW_INFORMATION_TERMS = new Set([
  "ic",
  "chip",
  "module",
  "board",
  "original",
  "new",
  "brand",
  "package",
  "power",
  "supply",
  "dc",
]);
const AI_TEXT_SYNONYM_GROUPS = [
  ["lithium", "liion", "lion", "lipo", "battery", "batteries", "cell"],
  ["charge", "charger", "charging", "recharge", "recharger"],
  ["buck", "stepdown", "down", "dc", "dcdc", "converter", "regulator"],
  ["boost", "stepup", "up", "converter", "regulator"],
  ["output", "voltage", "vout", "power", "supply"],
  ["input", "vin", "supply"],
  ["ic", "chip", "module", "board", "controller", "driver"],
  ["mosfet", "fet", "transistor", "field", "effect", "tube"],
  ["led", "light", "diode", "lamp"],
  ["capacitor", "cap", "condensator"],
  ["resistor", "resistance"],
  ["inductor", "coil"],
];
const AI_TEXT_SYNONYMS = new Map();
for (const group of AI_TEXT_SYNONYM_GROUPS) {
  const normalizedGroup = uniqueTokens(group.map((token) => normalizeForSearch(token)).filter(Boolean));
  for (const token of normalizedGroup) {
    AI_TEXT_SYNONYMS.set(token, normalizedGroup);
  }
}
let aiTextIndex = null;
const CURRENCY_FORMATTERS = Object.fromEntries(
  Object.entries(CURRENCY_INFO).map(([key, meta]) => [
    key,
    new Intl.NumberFormat(meta.locale, {
      style: "currency",
      currency: meta.code,
      minimumFractionDigits: 2,
      maximumFractionDigits: 4,
    }),
  ])
);
const SMALL_CURRENCY_FORMATTERS = Object.fromEntries(
  Object.entries(CURRENCY_INFO).map(([key, meta]) => [
    key,
    new Intl.NumberFormat(meta.locale, {
      style: "currency",
      currency: meta.code,
      minimumFractionDigits: 3,
      maximumFractionDigits: 6,
    }),
  ])
);
const POPCOUNT_TABLE = Array.from({ length: 256 }, (_, value) => {
  let count = 0;
  let current = value;
  while (current) {
    count += current & 1;
    current >>= 1;
  }
  return count;
});
const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "at",
  "be",
  "by",
  "for",
  "from",
  "in",
  "is",
  "of",
  "on",
  "or",
  "that",
  "the",
  "this",
  "to",
  "with",
]);

const state = {
  rows: [],
  filteredRows: [],
  renderedCount: 0,
  query: "",
  shop: "all",
  shops: [],
  shopCounts: new Map(),
  shopUrls: new Map(),
  shopFavorites: new Set(),
  disabledShops: new Set(),
  shopSearch: "",
  sort: "match",
  minPrice: null,
  maxPrice: null,
  displayCurrency: "cny",
  priceBaseCurrency: "cny",
  exchangeRates: null,
  hasImageOnly: false,
  smartSearch: true,
  aiTextSearch: false,
  loading: false,
  meta: null,
  filterRunToken: 0,
  idleStatusText: "",
  imageIndexStatus: null,
  imageQueryFile: null,
  imageQueryPreviewUrl: "",
  imageQueryLabel: "",
  browseLimit: INITIAL_BROWSE_BATCH,
  browseRows: [],
  browseTotalRows: 0,
  browsePreviewActive: false,
  serverSearchRequest: null,
  serverSearchLoadingMore: false,
  lastResultsScrollTop: 0,
  crawlerQueueStatus: null,
  lastCrawlerRefreshAt: "",
};

const elements = {
  searchInput: document.getElementById("searchInput"),
  searchButton: document.getElementById("searchButton"),
  searchLoading: document.getElementById("searchLoading"),
  minPriceInput: document.getElementById("minPriceInput"),
  maxPriceInput: document.getElementById("maxPriceInput"),
  minPriceLabel: document.getElementById("minPriceLabel"),
  maxPriceLabel: document.getElementById("maxPriceLabel"),
  currencyFilter: document.getElementById("currencyFilter"),
  shopMenuButton: document.getElementById("shopMenuButton"),
  shopMenuModal: document.getElementById("shopMenuModal"),
  shopMenuBackdrop: document.getElementById("shopMenuBackdrop"),
  shopMenuClose: document.getElementById("shopMenuClose"),
  shopPanelSummary: document.getElementById("shopPanelSummary"),
  shopPanelSearch: document.getElementById("shopPanelSearch"),
  clearShopViewButton: document.getElementById("clearShopViewButton"),
  enableAllShopsButton: document.getElementById("enableAllShopsButton"),
  disableAllShopsButton: document.getElementById("disableAllShopsButton"),
  favoritesOnlyButton: document.getElementById("favoritesOnlyButton"),
  shopList: document.getElementById("shopList"),
  sortFilter: document.getElementById("sortFilter"),
  hasImageFilter: document.getElementById("hasImageFilter"),
  smartSearchToggle: document.getElementById("smartSearchToggle"),
  aiTextSearchToggle: document.getElementById("aiTextSearchToggle"),
  reloadButton: document.getElementById("reloadButton"),
  reindexImagesButton: document.getElementById("reindexImagesButton"),
  crawlerQueueButton: document.getElementById("crawlerQueueButton"),
  statusText: document.getElementById("statusText"),
  heroStats: document.getElementById("heroStats"),
  resultSummary: document.getElementById("resultSummary"),
  datasetSummary: document.getElementById("datasetSummary"),
  errorBanner: document.getElementById("errorBanner"),
  resultsLoading: document.getElementById("resultsLoading"),
  resultsLoadingText: document.getElementById("resultsLoadingText"),
  resultsScroll: document.getElementById("resultsScroll"),
  resultsGrid: document.getElementById("resultsGrid"),
  emptyState: document.getElementById("emptyState"),
  loadHint: document.getElementById("loadHint"),
  browseMoreButton: document.getElementById("browseMoreButton"),
  resultsSentinel: document.getElementById("resultsSentinel"),
  imageUploadInput: document.getElementById("imageUploadInput"),
  uploadImageButton: document.getElementById("uploadImageButton"),
  pasteImageButton: document.getElementById("pasteImageButton"),
  clearImageButton: document.getElementById("clearImageButton"),
  imageSearchStatus: document.getElementById("imageSearchStatus"),
  imageProgress: document.getElementById("imageProgress"),
  imageProgressFill: document.getElementById("imageProgressFill"),
  imageProgressLabel: document.getElementById("imageProgressLabel"),
  imageProgressNumbers: document.getElementById("imageProgressNumbers"),
  crawlerQueueModal: document.getElementById("crawlerQueueModal"),
  crawlerQueueBackdrop: document.getElementById("crawlerQueueBackdrop"),
  crawlerQueueClose: document.getElementById("crawlerQueueClose"),
  crawlerQueueInput: document.getElementById("crawlerQueueInput"),
  crawlerQueueLineNumbers: document.getElementById("crawlerQueueLineNumbers"),
  crawlerQueueStart: document.getElementById("crawlerQueueStart"),
  crawlerQueueMessage: document.getElementById("crawlerQueueMessage"),
  crawlerQueueStatus: document.getElementById("crawlerQueueStatus"),
};

let imageWorkerPool = null;
let imageWorkerTaskId = 0;
let imageStatusPollTimer = 0;
let dataStatusPollTimer = 0;
let exchangeRatePollTimer = 0;
let crawlerQueuePollTimer = 0;
const sleep = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));

function readStoredValue(key) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStoredValue(key, value) {
  try {
    if (value === null || value === undefined || value === "") {
      window.localStorage.removeItem(key);
    } else {
      window.localStorage.setItem(key, String(value));
    }
  } catch {}
}

function readStoredSet(key) {
  try {
    const payload = JSON.parse(window.localStorage.getItem(key) || "[]");
    return new Set(Array.isArray(payload) ? payload.filter(Boolean).map(String) : []);
  } catch {
    return new Set();
  }
}

function writeStoredSet(key, values) {
  try {
    const payload = [...values].filter(Boolean).sort((left, right) => compareText(left, right));
    window.localStorage.setItem(key, JSON.stringify(payload));
  } catch {}
}

function mergeShopPreferencesFromPayload(payload) {
  const serverFavorites = Array.isArray(payload?.favorites) ? payload.favorites.filter(Boolean).map(String) : [];
  const serverDisabled = Array.isArray(payload?.disabled) ? payload.disabled.filter(Boolean).map(String) : [];
  state.shopFavorites = new Set([...state.shopFavorites, ...serverFavorites]);
  state.disabledShops = new Set(serverDisabled);
  writeStoredSet(STORAGE_KEYS.shopFavorites, state.shopFavorites);
  writeStoredSet(STORAGE_KEYS.disabledShops, state.disabledShops);
}

async function saveShopPreferencesToServer() {
  await fetchJson("/api/shop-preferences", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      favorites: [...state.shopFavorites],
      disabled: [...state.disabledShops],
    }),
  });
}

function beaconShopPreferencesToServer() {
  if (!navigator.sendBeacon) {
    return false;
  }
  const payload = JSON.stringify({
    favorites: [...state.shopFavorites],
    disabled: [...state.disabledShops],
  });
  return navigator.sendBeacon("/api/shop-preferences", new Blob([payload], { type: "application/json" }));
}

async function persistShopPreferences({ showError = false } = {}) {
  writeStoredSet(STORAGE_KEYS.shopFavorites, state.shopFavorites);
  writeStoredSet(STORAGE_KEYS.disabledShops, state.disabledShops);
  try {
    await saveShopPreferencesToServer();
  } catch (error) {
    if (showError) {
      setShopPanelMessage(`Shop settings saved in this browser, but server save failed: ${error.message || error}`);
    }
  }
}

async function loadShopPreferences() {
  try {
    const payload = await fetchJson("/api/shop-preferences");
    if (payload?.exists) {
      mergeShopPreferencesFromPayload(payload);
    }
    if (state.shopFavorites.size || state.disabledShops.size) {
      await saveShopPreferencesToServer();
    }
  } catch {
    // Local storage remains the fallback if the server preference file is unavailable.
  }
}

function restoreUiPreferences() {
  state.shopFavorites = readStoredSet(STORAGE_KEYS.shopFavorites);
  state.disabledShops = readStoredSet(STORAGE_KEYS.disabledShops);

  const storedCurrency = readStoredValue(STORAGE_KEYS.displayCurrency);
  if (storedCurrency && Object.hasOwn(CURRENCY_INFO, storedCurrency)) {
    state.displayCurrency = storedCurrency;
  }
  elements.currencyFilter.value = state.displayCurrency;

  const queueDraft = readStoredValue(STORAGE_KEYS.crawlerQueueDraft);
  if (queueDraft !== null) {
    elements.crawlerQueueInput.value = queueDraft;
  }
}

function formatNumber(value) {
  return new Intl.NumberFormat().format(value);
}

function formatTimestamp(isoText) {
  if (!isoText) {
    return "unknown time";
  }
  const stamp = new Date(isoText);
  if (Number.isNaN(stamp.getTime())) {
    return isoText;
  }
  return stamp.toLocaleString();
}

function activeCurrencyMeta() {
  return CURRENCY_INFO[state.displayCurrency] || CURRENCY_INFO.cny;
}

function baseCurrencyKey() {
  return CURRENCY_INFO[state.priceBaseCurrency] ? state.priceBaseCurrency : "cny";
}

function formatCurrencyValue(value, currencyKey = state.displayCurrency) {
  if (!Number.isFinite(value)) {
    return "";
  }
  const absValue = Math.abs(value);
  const formatter =
    absValue > 0 && absValue < 0.01
      ? (SMALL_CURRENCY_FORMATTERS[currencyKey] || SMALL_CURRENCY_FORMATTERS.cny)
      : (CURRENCY_FORMATTERS[currencyKey] || CURRENCY_FORMATTERS.cny);
  return formatter.format(value);
}

function convertCurrencyValue(value, fromCurrency, toCurrency) {
  if (!Number.isFinite(value)) {
    return null;
  }
  const source = CURRENCY_INFO[fromCurrency] ? fromCurrency : "cny";
  const target = CURRENCY_INFO[toCurrency] ? toCurrency : "cny";
  if (source === target) {
    return value;
  }
  const rates = state.exchangeRates;
  const usdToCad = Number(rates?.usd_to_cad);
  const cnyToCad = Number(rates?.cny_to_cad);
  if (!Number.isFinite(usdToCad) || usdToCad <= 0 || !Number.isFinite(cnyToCad) || cnyToCad <= 0) {
    return null;
  }

  let valueInCad = null;
  if (source === "cad") {
    valueInCad = value;
  } else if (source === "usd") {
    valueInCad = value * usdToCad;
  } else if (source === "cny") {
    valueInCad = value * cnyToCad;
  }
  if (!Number.isFinite(valueInCad)) {
    return null;
  }

  if (target === "cad") return valueInCad;
  if (target === "usd") return valueInCad / usdToCad;
  if (target === "cny") return valueInCad / cnyToCad;
  return null;
}

function convertBaseToCurrency(value, currencyKey = state.displayCurrency) {
  return convertCurrencyValue(value, baseCurrencyKey(), currencyKey);
}

function convertCurrencyToBase(value, currencyKey = state.displayCurrency) {
  return convertCurrencyValue(value, currencyKey, baseCurrencyKey());
}

function formatNumberInput(value) {
  if (!Number.isFinite(value)) {
    return "";
  }
  const rounded = Math.round(value * 10000) / 10000;
  return String(rounded).replace(/\.?0+$/, "");
}

function updateCurrencyLabels() {
  const currency = activeCurrencyMeta();
  elements.minPriceLabel.textContent = `Min Cost (${currency.label})`;
  elements.maxPriceLabel.textContent = `Max Cost (${currency.label})`;
}

function syncPriceInputsFromState() {
  const minDisplay = convertBaseToCurrency(state.minPrice, state.displayCurrency);
  const maxDisplay = convertBaseToCurrency(state.maxPrice, state.displayCurrency);
  elements.minPriceInput.value = formatNumberInput(minDisplay);
  elements.maxPriceInput.value = formatNumberInput(maxDisplay);
}

function currentSearchDraft() {
  return elements.searchInput.value || "";
}

function isSearchDirty() {
  return currentSearchDraft() !== state.query;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function buildStats(meta) {
  const indexedValue = meta?.ready === false ? "Indexing..." : formatTimestamp(meta.generated_at);
  const cards = [
    ["Listings", formatNumber(meta.total_rows || 0)],
    ["Shops", formatNumber(meta.total_shops || 0)],
    ["Files", formatNumber(meta.total_sources || 0)],
    ["Indexed", indexedValue],
  ];

  elements.heroStats.innerHTML = cards
    .map(
      ([label, value]) => `
        <article class="stat-card">
          <span>${escapeHtml(label)}</span>
          <strong>${escapeHtml(value)}</strong>
        </article>
      `
    )
    .join("");
}

function refreshShopCounts(meta = state.meta) {
  if (meta?.shop_counts && typeof meta.shop_counts === "object") {
    state.shopCounts = new Map(
      Object.entries(meta.shop_counts).map(([shop, count]) => [String(shop), Number(count) || 0])
    );
    return;
  }
  const counts = new Map();
  for (const row of state.rows) {
    const shop = String(row.shop || "").trim();
    if (!shop) {
      continue;
    }
    counts.set(shop, (counts.get(shop) || 0) + 1);
  }
  state.shopCounts = counts;
}

function refreshShopUrls(meta) {
  const urls = new Map();
  const payload = meta?.shop_urls && typeof meta.shop_urls === "object" ? meta.shop_urls : {};
  for (const [shop, url] of Object.entries(payload)) {
    if (shop && url) {
      urls.set(String(shop), String(url));
    }
  }
  state.shopUrls = urls;
}

function cleanShopPreferences(shops) {
  if (!shops.length) {
    return;
  }
  const valid = new Set(shops);
  let changed = false;
  for (const shop of [...state.shopFavorites]) {
    if (!valid.has(shop)) {
      state.shopFavorites.delete(shop);
      changed = true;
    }
  }
  for (const shop of [...state.disabledShops]) {
    if (!valid.has(shop)) {
      state.disabledShops.delete(shop);
      changed = true;
    }
  }
  if (changed) {
    persistShopPreferences({ showError: true });
  }
}

function sortedShopsForControls(shops) {
  return [...shops].sort((left, right) => {
    const leftFavorite = state.shopFavorites.has(left) ? 1 : 0;
    const rightFavorite = state.shopFavorites.has(right) ? 1 : 0;
    if (leftFavorite !== rightFavorite) {
      return rightFavorite - leftFavorite;
    }
    return compareText(left, right);
  });
}

function activeShopCount() {
  return state.shops.reduce((count, shop) => count + (state.disabledShops.has(shop) ? 0 : 1), 0);
}

function updateShopSummaries() {
  const total = state.shops.length;
  const active = activeShopCount();
  const favorites = state.shops.filter((shop) => state.shopFavorites.has(shop)).length;
  const summary = total
    ? `${formatNumber(active)}/${formatNumber(total)} active · ${formatNumber(favorites)} favorite${favorites === 1 ? "" : "s"}`
    : "No shops loaded";
  const buttonText = state.shop !== "all"
    ? `Viewing ${state.shop}`
    : total && active !== total
      ? `${formatNumber(active)}/${formatNumber(total)} Active Shops`
      : "Manage Shops";
  elements.shopMenuButton.textContent = buttonText;
  elements.shopMenuButton.title = summary;
  elements.shopPanelSummary.textContent = state.shop !== "all" ? `Viewing only ${state.shop}. ${summary}` : summary;
}

function renderShopPanel() {
  updateShopSummaries();
  const search = normalizeForSearch(state.shopSearch);
  const shops = sortedShopsForControls(state.shops).filter((shop) => {
    if (!search) {
      return true;
    }
    return normalizeForSearch(shop).includes(search);
  });

  if (!shops.length) {
    const emptyText = state.shops.length ? "No stores match this search." : "No shops loaded.";
    elements.shopList.innerHTML = `<tr><td class="shop-list-empty" colspan="7">${escapeHtml(emptyText)}</td></tr>`;
    return;
  }

  elements.shopList.innerHTML = shops
    .map((shop) => {
      const favorite = state.shopFavorites.has(shop);
      const disabled = state.disabledShops.has(shop);
      const selected = state.shop === shop;
      const count = state.shopCounts.get(shop) || 0;
      const shopUrl = state.shopUrls.get(shop) || "";
      return `
        <tr class="${disabled ? "is-disabled" : ""}">
          <td>
            <button
              type="button"
              class="shop-copy-button"
              data-shop-copy="${escapeHtml(shop)}"
              ${shopUrl ? "" : "disabled"}
              title="${shopUrl ? "Copy store link" : "No saved store link"}"
            >${escapeHtml(shop)}</button>
          </td>
          <td class="shop-list-count">${formatNumber(count)}</td>
          <td>
            <button
              type="button"
              class="shop-favorite-button ${favorite ? "is-favorite" : ""}"
              data-shop-favorite="${escapeHtml(shop)}"
              title="${favorite ? "Remove favorite" : "Add favorite"}"
              aria-label="${favorite ? "Remove favorite" : "Add favorite"}: ${escapeHtml(shop)}"
            >${favorite ? "★" : "☆"}</button>
          </td>
          <td>
            <label class="shop-active-toggle">
              <input type="checkbox" data-shop-toggle="${escapeHtml(shop)}" ${disabled ? "" : "checked"}>
              <span>${disabled ? "Off" : "On"}</span>
            </label>
          </td>
          <td>
            <button
              type="button"
              class="secondary-button compact-button shop-view-button ${selected ? "is-viewing" : ""}"
              data-shop-view="${escapeHtml(shop)}"
              ${disabled ? "disabled" : ""}
              title="${disabled ? "Turn this store on to view it" : selected ? "Clear store view" : "View this store"}"
            >${selected ? "Viewing" : "View"}</button>
          </td>
          <td>
            <button
              type="button"
              class="secondary-button compact-button shop-recrawl-button"
              data-shop-recrawl="${escapeHtml(shop)}"
              ${shopUrl ? "" : "disabled"}
              title="${shopUrl ? "Queue a full recrawl and redownload images" : "No saved store link"}"
            >Recrawl</button>
          </td>
          <td>
            <button
              type="button"
              class="secondary-button compact-button shop-delete-button"
              data-shop-delete="${escapeHtml(shop)}"
              title="Delete this store and all its data"
            >Delete</button>
          </td>
        </tr>
      `;
    })
    .join("");
}

function syncShopSelectionAfterPreferences() {
  if (state.shop !== "all" && (!state.shops.includes(state.shop) || state.disabledShops.has(state.shop))) {
    state.shop = "all";
  }
}

function populateShopFilter(shops) {
  state.shops = [...new Set((shops || []).filter(Boolean).map(String))];
  if (state.shops.length) {
    cleanShopPreferences(state.shops);
  }
  syncShopSelectionAfterPreferences();
  renderShopPanel();
}

function openShopMenuModal() {
  elements.shopMenuModal.classList.remove("hidden");
  renderShopPanel();
  window.requestAnimationFrame(() => elements.shopPanelSearch.focus());
}

function closeShopMenuModal() {
  elements.shopMenuModal.classList.add("hidden");
}

async function copyTextToClipboard(text) {
  if (!text) {
    throw new Error("No store link is available for this shop.");
  }
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  document.body.append(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) {
    throw new Error("Clipboard copy failed.");
  }
}

function setShopPanelMessage(message, restore = true) {
  elements.shopPanelSummary.textContent = message;
  if (restore) {
    window.setTimeout(updateShopSummaries, 1800);
  }
}

function setStatus(text, isBusy = false) {
  state.loading = isBusy;
  elements.statusText.textContent = text;
  elements.reloadButton.disabled = isBusy;
}

function setSearchLoading(isLoading) {
  elements.searchLoading.classList.toggle("hidden", !isLoading);
  elements.resultsLoading.classList.toggle("hidden", !isLoading);
  elements.resultsLoadingText.textContent = "Searching listings...";
  elements.searchInput.setAttribute("aria-busy", isLoading ? "true" : "false");
  elements.searchButton.disabled = Boolean(isLoading);
}

function updateSearchLoadingText(text) {
  if (!elements.resultsLoading.classList.contains("hidden")) {
    elements.resultsLoadingText.textContent = text;
  }
}

function yieldToBrowser() {
  return new Promise((resolve) => window.setTimeout(resolve, 0));
}

function setImageSearchStatus(summary, detail) {
  elements.imageSearchStatus.textContent = detail ? `${summary} ${detail}` : summary;
}

function setImageProgress({ visible, indeterminate = false, ratio = 0, label = "", numbers = "" }) {
  elements.imageProgress.classList.toggle("hidden", !visible);
  elements.imageProgress.classList.toggle("indeterminate", Boolean(indeterminate && visible));
  elements.imageProgressFill.style.width = `${Math.max(0, Math.min(100, ratio * 100))}%`;
  elements.imageProgressLabel.textContent = label;
  elements.imageProgressNumbers.textContent = numbers;
}

function defaultImageSearchStatus() {
  if (state.imageIndexStatus?.building || state.imageIndexStatus?.ready || state.imageIndexStatus?.error) {
    updateImageSearchStatusFromServer(state.imageIndexStatus);
  } else {
    setImageProgress({ visible: false, ratio: 0, label: "", numbers: "" });
  }
  if (state.imageQueryPreviewUrl) {
    setImageSearchStatus(
      `Image search ready: ${state.imageQueryLabel || "query image"}.`,
      "Text search still supports AND by default, plus OR, !term, and smart part-number matching."
    );
    return;
  }
  setImageSearchStatus(
    "Text search uses AND by default.",
    "Press Enter to search. Use OR, quotes, !term, Smart Search for best-guess text, or AI Title Search for ranked title/name matching."
  );
}

function normalizeForSearch(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function compactNormalized(text) {
  return String(text || "").replaceAll(" ", "");
}

function looksLikePartNumber(value) {
  const normalized = normalizeForSearch(value);
  const tokens = tokenizeNormalized(normalized);
  const compact = compactNormalized(normalized);
  if (compact.length < 5 || compact.length > 40 || !/[a-z]/.test(compact) || !/\d/.test(compact)) {
    return false;
  }
  if (tokens.length > 3) {
    return false;
  }
  if (tokens.length <= 1) {
    return true;
  }

  const hasMixedAlphaNumericToken = tokens.some((token) => /[a-z]/.test(token) && /\d/.test(token));
  const hasLongPlainWord = tokens.some((token) => token.length >= 5 && /^[a-z]+$/.test(token));
  return hasMixedAlphaNumericToken && !hasLongPlainWord;
}

function clauseLooksLikePartNumber(clause) {
  const terms = [...clause.includePhrases, ...clause.includeTokens].filter(Boolean);
  if (terms.length === 1) {
    return looksLikePartNumber(terms[0]);
  }
  return looksLikePartNumber(terms.join(" "));
}

function tokenizeNormalized(text) {
  return String(text || "")
    .split(" ")
    .map((token) => token.trim())
    .filter(Boolean);
}

function uniqueTokens(tokens) {
  return [...new Set(tokens)];
}

function parseQuotedValue(value) {
  const trimmed = String(value || "").trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseNumberValue(value) {
  const match = String(value ?? "")
    .replaceAll(",", "")
    .match(/-?\d+(?:\.\d+)?/);
  if (!match) {
    return null;
  }
  const parsed = Number(match[0]);
  return Number.isFinite(parsed) ? parsed : null;
}

function parsePriceRange(value) {
  const normalized = String(value || "").trim();
  const rangeMatch = normalized.match(/^\s*(\d+(?:\.\d+)?)\s*(?:-|\.\.)\s*(\d+(?:\.\d+)?)\s*$/);
  if (rangeMatch) {
    const left = Number(rangeMatch[1]);
    const right = Number(rangeMatch[2]);
    return {
      minPrice: Math.min(left, right),
      maxPrice: Math.max(left, right),
    };
  }

  const single = parseNumberValue(normalized);
  if (single === null) {
    return { minPrice: null, maxPrice: null };
  }
  return { minPrice: single, maxPrice: null };
}

function extractInlineFilters(rawQuery) {
  const filters = {
    minPrice: null,
    maxPrice: null,
    hasImage: false,
    shopNormalized: "",
    offerCompact: "",
  };
  const queryText = String(rawQuery || "");
  let remaining = "";
  let lastIndex = 0;
  let match;

  INLINE_FILTER_RE.lastIndex = 0;
  while ((match = INLINE_FILTER_RE.exec(queryText))) {
    remaining += `${queryText.slice(lastIndex, match.index)} `;
    lastIndex = match.index + match[0].length;

    const key = String(match[1] || "").toLowerCase();
    const value = String(match[2] || match[3] || match[4] || "").trim();

    if (!value) {
      continue;
    }

    if (key === "min" || key === "minprice") {
      const parsed = parseNumberValue(value);
      if (parsed !== null) {
        filters.minPrice = parsed;
      }
      continue;
    }

    if (key === "max" || key === "maxprice") {
      const parsed = parseNumberValue(value);
      if (parsed !== null) {
        filters.maxPrice = parsed;
      }
      continue;
    }

    if (key === "price") {
      const range = parsePriceRange(value);
      if (range.minPrice !== null) {
        filters.minPrice = range.minPrice;
      }
      if (range.maxPrice !== null) {
        filters.maxPrice = range.maxPrice;
      }
      continue;
    }

    if (key === "has") {
      const normalizedValue = normalizeForSearch(value);
      if (["image", "images", "img", "photo", "photos", "picture", "pictures"].includes(normalizedValue)) {
        filters.hasImage = true;
      }
      continue;
    }

    if (key === "shop") {
      filters.shopNormalized = normalizeForSearch(value);
      continue;
    }

    if (key === "offer" || key === "id") {
      filters.offerCompact = compactNormalized(normalizeForSearch(value));
    }
  }

  remaining += queryText.slice(lastIndex);
  return {
    cleanedRaw: remaining.replace(/\s+/g, " ").trim(),
    filters,
  };
}

function tokenizeQuerySyntax(queryText) {
  return String(queryText || "").match(/(?:[!-])?"[^"]+"|(?:[!-])?'[^']+'|\|\||\||\S+/g) || [];
}

function normalizeQueryTerm(value) {
  return normalizeForSearch(parseQuotedValue(value));
}

function buildClause() {
  return {
    includeTokens: [],
    includePhrases: [],
    excludeTokens: [],
    excludePhrases: [],
  };
}

function finalizeClause(clause) {
  clause.includeTokens = uniqueTokens(clause.includeTokens);
  clause.excludeTokens = uniqueTokens(clause.excludeTokens);
  clause.includePhrases = uniqueTokens(clause.includePhrases);
  clause.excludePhrases = uniqueTokens(clause.excludePhrases);
  clause.smartTokens = uniqueTokens([
    ...clause.includeTokens,
    ...clause.includePhrases.flatMap((phrase) => tokenizeNormalized(phrase)),
  ]);
  clause.compact = compactNormalized([...clause.includePhrases, ...clause.includeTokens].join(" "));
  return clause;
}

function clauseHasTerms(clause) {
  return Boolean(
    clause.includeTokens.length ||
      clause.includePhrases.length ||
      clause.excludeTokens.length ||
      clause.excludePhrases.length
  );
}

function parseBooleanClauses(rawQuery) {
  const clauses = [];
  let clause = buildClause();

  for (const rawToken of tokenizeQuerySyntax(rawQuery)) {
    if (/^(?:\|\|?|\bOR\b)$/i.test(rawToken)) {
      if (clauseHasTerms(clause)) {
        clauses.push(finalizeClause(clause));
      }
      clause = buildClause();
      continue;
    }

    let token = rawToken;
    let negate = false;
    if ((token.startsWith("!") || token.startsWith("-")) && token.length > 1) {
      negate = true;
      token = token.slice(1);
    }

    const isPhrase =
      (token.startsWith('"') && token.endsWith('"')) ||
      (token.startsWith("'") && token.endsWith("'"));
    const normalized = normalizeQueryTerm(token);
    if (!normalized) {
      continue;
    }

    if (isPhrase) {
      if (negate) {
        clause.excludePhrases.push(normalized);
      } else {
        clause.includePhrases.push(normalized);
      }
      continue;
    }

    const rawTokens = tokenizeNormalized(normalized);
    const filteredTokens = uniqueTokens(
      rawTokens.filter((item) => item.length > 1 && (!STOP_WORDS.has(item) || rawTokens.length === 1))
    );
    const normalizedTokens = filteredTokens.length ? filteredTokens : uniqueTokens(rawTokens);
    for (const normalizedToken of normalizedTokens) {
      if (negate) {
        clause.excludeTokens.push(normalizedToken);
      } else {
        clause.includeTokens.push(normalizedToken);
      }
    }
  }

  if (clauseHasTerms(clause)) {
    clauses.push(finalizeClause(clause));
  }
  if (!clauses.length) {
    clauses.push(buildClause());
  }
  return clauses;
}

function parseQuery(query) {
  const extracted = extractInlineFilters(query);
  const normalized = normalizeForSearch(extracted.cleanedRaw);
  const clauses = parseBooleanClauses(extracted.cleanedRaw);
  const allIncludeTokens = uniqueTokens(clauses.flatMap((clause) => clause.includeTokens));

  return {
    raw: String(query || ""),
    cleanedRaw: extracted.cleanedRaw,
    normalized,
    compact: compactNormalized(normalized),
    tokens: allIncludeTokens,
    clauses,
    hasSearchTerms: clauses.some(clauseHasTerms),
    filters: extracted.filters,
  };
}

function buildSearchIndex(row) {
  const titleNormalized = normalizeForSearch(row.title);
  const shopNormalized = normalizeForSearch(row.shop);
  const offerNormalized = normalizeForSearch(row.offer_id);
  const blobNormalized = normalizeForSearch(
    [
      row.search_blob,
      row.title,
      row.shop,
      row.offer_id,
      row.price_text,
      row.sales,
    ].join(" ")
  );

  const titleTokens = uniqueTokens(tokenizeNormalized(titleNormalized));
  const shopTokens = uniqueTokens(tokenizeNormalized(shopNormalized));
  const offerTokens = uniqueTokens(tokenizeNormalized(offerNormalized));
  const blobTokens = uniqueTokens(tokenizeNormalized(blobNormalized));
  const partNumberTokens = uniqueTokens(
    [...offerTokens, ...titleTokens, ...blobTokens].filter((token) => looksLikePartNumber(token))
  );

  return {
    ...row,
    _search: {
      titleNormalized,
      titleCompact: compactNormalized(titleNormalized),
      titleTokens,
      titleSequence: tokenizeNormalized(titleNormalized),
      shopNormalized,
      shopCompact: compactNormalized(shopNormalized),
      shopTokens,
      offerNormalized,
      offerCompact: compactNormalized(offerNormalized),
      offerTokens,
      blobNormalized,
      blobCompact: compactNormalized(blobNormalized),
      blobTokens,
      blobSequence: tokenizeNormalized(blobNormalized),
      partNumberTokens,
    },
  };
}

function addIndexValue(indexMap, token, rowIndex) {
  if (!token) {
    return;
  }
  let values = indexMap.get(token);
  if (!values) {
    values = [];
    indexMap.set(token, values);
  }
  const last = values[values.length - 1];
  if (last !== rowIndex) {
    values.push(rowIndex);
  }
}

function buildAiTextIndex(rows) {
  const tokenToRows = new Map();
  const titleTokenToRows = new Map();
  const partTokenToRows = new Map();
  const partPrefixToTokens = new Map();
  const tokenSet = new Set();
  const partTokenSet = new Set();

  rows.forEach((row, rowIndex) => {
    addRowToAiTextIndex(row, rowIndex, {
      tokenToRows,
      titleTokenToRows,
      partTokenToRows,
      partPrefixToTokens,
      tokenSet,
      partTokenSet,
    });
  });

  return finalizeAiTextIndex({
    tokenToRows,
    titleTokenToRows,
    partTokenToRows,
    partPrefixToTokens,
    tokenSet,
    partTokenSet,
  });
}

function addRowToAiTextIndex(row, rowIndex, indexParts) {
  const search = row._search;
  for (const token of search.titleTokens) {
    indexParts.tokenSet.add(token);
    addIndexValue(indexParts.tokenToRows, token, rowIndex);
    addIndexValue(indexParts.titleTokenToRows, token, rowIndex);
  }
  for (const token of search.offerTokens) {
    indexParts.tokenSet.add(token);
    addIndexValue(indexParts.tokenToRows, token, rowIndex);
  }
  for (const token of search.partNumberTokens || []) {
    indexParts.partTokenSet.add(token);
    addIndexValue(indexParts.partTokenToRows, token, rowIndex);
    for (const length of [3, 4, 5]) {
      if (token.length >= length) {
        const prefix = token.slice(0, length);
        let prefixTokens = indexParts.partPrefixToTokens.get(prefix);
        if (!prefixTokens) {
          prefixTokens = new Set();
          indexParts.partPrefixToTokens.set(prefix, prefixTokens);
        }
        prefixTokens.add(token);
      }
    }
  }
}

function finalizeAiTextIndex(indexParts) {
  return {
    tokenToRows: indexParts.tokenToRows,
    titleTokenToRows: indexParts.titleTokenToRows,
    partTokenToRows: indexParts.partTokenToRows,
    partPrefixToTokens: new Map([...indexParts.partPrefixToTokens].map(([prefix, tokens]) => [prefix, [...tokens]])),
    tokens: [...indexParts.tokenSet],
    partTokens: [...indexParts.partTokenSet],
  };
}

async function buildAiTextIndexAsync(rows, runToken) {
  const indexParts = {
    tokenToRows: new Map(),
    titleTokenToRows: new Map(),
    partTokenToRows: new Map(),
    partPrefixToTokens: new Map(),
    tokenSet: new Set(),
    partTokenSet: new Set(),
  };

  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    if (runToken !== state.filterRunToken) {
      return null;
    }
    addRowToAiTextIndex(rows[rowIndex], rowIndex, indexParts);
    if (rowIndex > 0 && rowIndex % 2500 === 0) {
      updateSearchLoadingText(`Building title index ${formatNumber(rowIndex)} of ${formatNumber(rows.length)} listings...`);
      await yieldToBrowser();
    }
  }

  return finalizeAiTextIndex(indexParts);
}

function getBigramProfile(token) {
  if (BIGRAM_CACHE.has(token)) {
    return BIGRAM_CACHE.get(token);
  }

  if (BIGRAM_CACHE.size >= MAX_BIGRAM_CACHE_SIZE) {
    BIGRAM_CACHE.clear();
  }

  const profile = new Map();
  for (let index = 0; index < token.length - 1; index += 1) {
    const bigram = token.slice(index, index + 2);
    profile.set(bigram, (profile.get(bigram) || 0) + 1);
  }
  BIGRAM_CACHE.set(token, profile);
  return profile;
}

function diceCoefficient(left, right) {
  if (!left || !right) {
    return 0;
  }
  if (left === right) {
    return 1;
  }
  if (left.length < 2 || right.length < 2) {
    return 0;
  }

  const leftProfile = getBigramProfile(left);
  const rightProfile = getBigramProfile(right);
  let overlap = 0;

  for (const [bigram, count] of leftProfile) {
    if (!rightProfile.has(bigram)) {
      continue;
    }
    overlap += Math.min(count, rightProfile.get(bigram));
  }

  return (2 * overlap) / (left.length + right.length - 2);
}

function boundedEditDistance(left, right, maxDistance = 2) {
  if (left === right) {
    return 0;
  }
  if (Math.abs(left.length - right.length) > maxDistance) {
    return maxDistance + 1;
  }

  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);

  for (let row = 1; row <= left.length; row += 1) {
    const current = new Array(right.length + 1);
    current[0] = row;

    const from = Math.max(1, row - maxDistance);
    const to = Math.min(right.length, row + maxDistance);

    for (let column = 1; column < from; column += 1) {
      current[column] = maxDistance + 1;
    }

    let rowMinimum = current[0];
    for (let column = from; column <= to; column += 1) {
      const substitutionCost = left[row - 1] === right[column - 1] ? 0 : 1;
      current[column] = Math.min(
        previous[column] + 1,
        current[column - 1] + 1,
        previous[column - 1] + substitutionCost
      );
      rowMinimum = Math.min(rowMinimum, current[column]);
    }

    for (let column = to + 1; column <= right.length; column += 1) {
      current[column] = maxDistance + 1;
    }

    if (rowMinimum > maxDistance) {
      return maxDistance + 1;
    }

    previous = current;
  }

  return previous[right.length];
}

function tokenSimilarity(queryToken, candidateToken) {
  if (!queryToken || !candidateToken) {
    return 0;
  }
  if (queryToken === candidateToken) {
    return 1;
  }

  const shorter = Math.min(queryToken.length, candidateToken.length);
  const longer = Math.max(queryToken.length, candidateToken.length);
  const lengthRatio = shorter / longer;
  const reverseFriendlyCandidate =
    candidateToken.length >= 2 && (candidateToken.length >= 3 || /\d/.test(candidateToken));

  if (candidateToken.startsWith(queryToken) || (reverseFriendlyCandidate && queryToken.startsWith(candidateToken))) {
    return 0.82 + lengthRatio * 0.12;
  }

  if (queryToken.length >= 3 && candidateToken.length >= 3) {
    if (candidateToken.includes(queryToken) || (reverseFriendlyCandidate && queryToken.includes(candidateToken))) {
      return 0.68 + lengthRatio * 0.18;
    }

    if (queryToken[0] === candidateToken[0] && Math.abs(queryToken.length - candidateToken.length) <= 2) {
      const distance = boundedEditDistance(queryToken, candidateToken, 2);
      if (distance <= 2) {
        return 0.72 + ((2 - distance) / 2) * 0.16;
      }
    }

    const dice = diceCoefficient(queryToken, candidateToken);
    if (dice >= 0.72) {
      return 0.58 + (dice - 0.72) * 0.9;
    }
  }

  return 0;
}

function compactContainsSupport(queryToken, compactText) {
  if (!queryToken || !compactText) {
    return 0;
  }
  if (queryToken === compactText) {
    return 1;
  }

  const allowLooseCompact = queryToken.length >= 3 || /\d/.test(queryToken);
  const reverseFriendlyCompact = compactText.length >= 2 && (compactText.length >= 3 || /\d/.test(compactText));
  if (!allowLooseCompact) {
    return 0;
  }

  const shorter = Math.min(queryToken.length, compactText.length);
  const longer = Math.max(queryToken.length, compactText.length);
  const lengthRatio = shorter / longer;

  if (compactText.startsWith(queryToken) || (reverseFriendlyCompact && queryToken.startsWith(compactText))) {
    return 0.84 + lengthRatio * 0.12;
  }

  if (compactText.includes(queryToken) || (reverseFriendlyCompact && queryToken.includes(compactText))) {
    return 0.76 + lengthRatio * 0.16;
  }

  const maxDistance = Math.min(3, Math.max(2, Math.floor(longer / 4)));
  const distance = boundedEditDistance(queryToken, compactText, maxDistance);
  if (distance <= maxDistance) {
    return 0.62 + ((maxDistance - distance) / maxDistance) * 0.18;
  }

  const dice = diceCoefficient(queryToken, compactText);
  if (dice >= 0.72) {
    return 0.58 + (dice - 0.72) * 0.9;
  }

  return 0;
}

function minimumSupport(queryToken) {
  if (queryToken.length <= 2) {
    return /\d/.test(queryToken) ? 0.76 : 1;
  }
  if (queryToken.length <= 3) {
    return /\d/.test(queryToken) ? 0.74 : 1;
  }
  if (queryToken.length <= 5) {
    return 0.78;
  }
  return 0.58;
}

function hasToken(tokens, token) {
  return Array.isArray(tokens) && tokens.includes(token);
}

function bestTokenSupport(queryToken, tokens) {
  if (!queryToken) {
    return 0;
  }
  if (hasToken(tokens, queryToken)) {
    return 1;
  }

  let best = 0;
  for (const candidateToken of tokens) {
    const candidateScore = tokenSimilarity(queryToken, candidateToken);
    if (candidateScore > best) {
      best = candidateScore;
    }
    if (best >= 0.98) {
      break;
    }
  }
  return best;
}

function tokenSupportAcrossSearch(token, search) {
  const offerSupport = Math.max(
    bestTokenSupport(token, search.offerTokens),
    compactContainsSupport(token, search.offerCompact)
  );
  const titleSupport = Math.max(
    bestTokenSupport(token, search.titleTokens),
    compactContainsSupport(token, search.titleCompact)
  );
  const shopSupport = Math.max(
    bestTokenSupport(token, search.shopTokens),
    compactContainsSupport(token, search.shopCompact)
  );
  const blobSupport = Math.max(
    hasToken(search.blobTokens, token) ? 0.84 : 0,
    compactContainsSupport(token, search.blobCompact)
  );

  return {
    offerSupport,
    titleSupport,
    shopSupport,
    blobSupport,
    bestSupport: Math.max(offerSupport, titleSupport, shopSupport, blobSupport),
  };
}

function countOrderedTokenHits(queryTokens, tokenSequence) {
  let tokenIndex = 0;
  for (const candidate of tokenSequence) {
    if (candidate !== queryTokens[tokenIndex]) {
      continue;
    }
    tokenIndex += 1;
    if (tokenIndex >= queryTokens.length) {
      break;
    }
  }
  return tokenIndex;
}

function bestCompactWindowSupport(queryCompact, tokenSequence, maxWindowSize) {
  if (!queryCompact || !tokenSequence.length) {
    return 0;
  }

  let best = 0;
  const windowCap = Math.min(tokenSequence.length, Math.max(1, maxWindowSize));
  for (let start = 0; start < tokenSequence.length; start += 1) {
    let compactWindow = "";
    for (let width = 1; width <= windowCap && start + width <= tokenSequence.length; width += 1) {
      compactWindow += tokenSequence[start + width - 1];
      const support = Math.max(
        compactContainsSupport(queryCompact, compactWindow),
        tokenSimilarity(queryCompact, compactWindow)
      );
      if (support > best) {
        best = support;
      }
      if (best >= 0.999) {
        return 1;
      }
    }
  }
  return best;
}

function clauseCompactSupport(clause, search) {
  if (!clause.compact) {
    return { titleSupport: 0, blobSupport: 0, bestSupport: 0 };
  }

  const directTitleSupport = compactContainsSupport(clause.compact, search.titleCompact);
  const directBlobSupport = compactContainsSupport(clause.compact, search.blobCompact);
  const partCount = Math.max(1, clause.smartTokens.length);

  const titleSupport =
    partCount > 1 && directTitleSupport < 0.999
      ? Math.max(directTitleSupport, bestCompactWindowSupport(clause.compact, search.titleSequence, partCount + 1))
      : directTitleSupport;
  const blobSupport =
    partCount > 1 && directBlobSupport < 0.999
      ? Math.max(directBlobSupport, bestCompactWindowSupport(clause.compact, search.blobSequence, partCount + 1))
      : directBlobSupport;

  return {
    titleSupport,
    blobSupport,
    bestSupport: Math.max(titleSupport, blobSupport),
  };
}

function phraseMatches(phrase, search) {
  const phraseCompact = compactNormalized(phrase);
  return (
    search.titleNormalized.includes(phrase) ||
    search.blobNormalized.includes(phrase) ||
    compactContainsSupport(phraseCompact, search.titleCompact) >= 0.84 ||
    compactContainsSupport(phraseCompact, search.blobCompact) >= 0.84
  );
}

function phraseScore(phrase, search) {
  const titleHit = search.titleNormalized.includes(phrase);
  const blobHit = search.blobNormalized.includes(phrase);
  const phraseCompact = compactNormalized(phrase);
  const titleCompactHit = compactContainsSupport(phraseCompact, search.titleCompact) >= 0.84;
  const blobCompactHit = compactContainsSupport(phraseCompact, search.blobCompact) >= 0.84;

  if ((titleHit || titleCompactHit) && (blobHit || blobCompactHit)) {
    return 320;
  }
  if (titleHit) {
    return 260;
  }
  if (titleCompactHit) {
    return 235;
  }
  if (blobHit) {
    return 140;
  }
  if (blobCompactHit) {
    return 125;
  }
  return 0;
}

function partNumberSimilarity(queryCompact, candidateCompact) {
  if (!queryCompact || !candidateCompact) {
    return 0;
  }
  if (queryCompact === candidateCompact) {
    return 1;
  }

  const shorter = Math.min(queryCompact.length, candidateCompact.length);
  const longer = Math.max(queryCompact.length, candidateCompact.length);
  const lengthRatio = shorter / longer;

  if (candidateCompact.startsWith(queryCompact)) {
    return 0.92 + lengthRatio * 0.06;
  }
  if (queryCompact.startsWith(candidateCompact) && candidateCompact.length >= 5) {
    return 0.82 + lengthRatio * 0.08;
  }
  if (candidateCompact.includes(queryCompact)) {
    return 0.86 + lengthRatio * 0.06;
  }
  if (queryCompact.includes(candidateCompact) && candidateCompact.length >= 5) {
    return 0.76 + lengthRatio * 0.08;
  }

  let prefixLength = 0;
  while (
    prefixLength < queryCompact.length &&
    prefixLength < candidateCompact.length &&
    queryCompact[prefixLength] === candidateCompact[prefixLength]
  ) {
    prefixLength += 1;
  }
  const prefixRatio = prefixLength / Math.max(1, Math.min(queryCompact.length, candidateCompact.length));
  const maxDistance = Math.min(4, Math.max(2, Math.floor(longer / 4)));
  const distance = boundedEditDistance(queryCompact, candidateCompact, maxDistance);
  const editSupport = distance <= maxDistance ? 1 - distance / Math.max(longer, 1) : 0;
  const dice = diceCoefficient(queryCompact, candidateCompact);

  if (prefixLength >= 5 && editSupport >= 0.72) {
    return Math.max(0.68, Math.min(0.91, editSupport * 0.68 + prefixRatio * 0.23 + dice * 0.09));
  }
  if (prefixLength >= 5 && dice >= 0.72) {
    return Math.max(0.62, Math.min(0.84, prefixRatio * 0.48 + dice * 0.34));
  }
  if (prefixLength >= 5) {
    return Math.max(0.54, Math.min(0.82, prefixRatio * 0.62 + lengthRatio * 0.12 + dice * 0.08));
  }
  if (prefixLength >= 4 && shorter <= 6) {
    return Math.max(0.6, Math.min(0.82, prefixRatio * 0.7 + lengthRatio * 0.1));
  }
  if (dice >= 0.82 && prefixLength >= 3) {
    return Math.min(0.78, dice * 0.72 + prefixRatio * 0.08);
  }

  return 0;
}

function partNumberSupport(clause, search) {
  const compact = clause.compact;
  if (!compact) {
    return { support: 0, exact: false, titleHit: false, candidate: "" };
  }

  let best = { support: 0, exact: false, titleHit: false, candidate: "" };
  const candidates = search.partNumberTokens?.length
    ? search.partNumberTokens
    : uniqueTokens([...search.offerTokens, ...search.titleTokens, ...search.blobTokens].filter((token) => looksLikePartNumber(token)));

  for (const candidate of candidates) {
    const support = partNumberSimilarity(compact, candidate);
    if (support <= best.support) {
      continue;
    }
    best = {
      support,
      exact: compact === candidate,
      titleHit: hasToken(search.titleTokens, candidate) || search.titleCompact.includes(candidate),
      candidate,
    };
  }

  const compactTitleSupport = compactContainsSupport(compact, search.titleCompact);
  if (compactTitleSupport > best.support) {
    best = {
      support: compactTitleSupport,
      exact: search.titleCompact === compact,
      titleHit: true,
      candidate: compact,
    };
  }
  const compactBlobSupport = compactContainsSupport(compact, search.blobCompact);
  if (compactBlobSupport > best.support) {
    best = {
      support: compactBlobSupport,
      exact: search.blobCompact === compact,
      titleHit: best.titleHit,
      candidate: compact,
    };
  }

  return best;
}

function partNumberPrefixStats(queryCompact, candidateCompact) {
  let prefixLength = 0;
  while (
    prefixLength < queryCompact.length &&
    prefixLength < candidateCompact.length &&
    queryCompact[prefixLength] === candidateCompact[prefixLength]
  ) {
    prefixLength += 1;
  }
  const queryAlpha = queryCompact.match(/^[a-z]+/)?.[0] || "";
  const candidateAlpha = candidateCompact.match(/^[a-z]+/)?.[0] || "";
  const sameAlphaPrefix = Boolean(queryAlpha && candidateAlpha && queryAlpha === candidateAlpha);
  return { prefixLength, sameAlphaPrefix };
}

function minimumPartNumberSupport(queryCompact) {
  if (queryCompact.length <= 5) {
    return 0.5;
  }
  if (queryCompact.length <= 8) {
    return 0.52;
  }
  return 0.46;
}

function exactPartNumberSupportThreshold(queryCompact) {
  if (queryCompact.length <= 5) {
    return 0.82;
  }
  if (queryCompact.length <= 8) {
    return 0.7;
  }
  return 0.62;
}

function strictPhraseMatches(phrase, search) {
  const compact = compactNormalized(phrase);
  return (
    search.titleNormalized.includes(phrase) ||
    search.blobNormalized.includes(phrase) ||
    (compact.length >= 4 && (search.titleCompact.includes(compact) || search.blobCompact.includes(compact)))
  );
}

function strictPartNumberMatches(clause, search) {
  const support = partNumberSupport(clause, search);
  return support.support >= exactPartNumberSupportThreshold(clause.compact || "");
}

function strictTokenMatches(token, search) {
  return (
    hasToken(search.offerTokens, token) ||
    hasToken(search.titleTokens, token) ||
    hasToken(search.shopTokens, token) ||
    hasToken(search.blobTokens, token)
  );
}

function buildStrictClauseMatch(row, clause) {
  const search = row._search;

  for (const token of clause.excludeTokens) {
    if (strictTokenMatches(token, search)) {
      return null;
    }
  }

  for (const phrase of clause.excludePhrases) {
    if (strictPhraseMatches(phrase, search)) {
      return null;
    }
  }

  if (!clauseHasTerms(clause)) {
    return { row, score: 0, exactTerms: 0, matchedTerms: 0, titleTerms: 0, imageScore: 0 };
  }

  const partNumberQuery = clauseLooksLikePartNumber(clause);
  if (partNumberQuery && !strictPartNumberMatches(clause, search)) {
    return null;
  }

  let score = 0;
  let matchedTerms = 0;
  let exactTerms = 0;
  let titleTerms = 0;

  for (const phrase of clause.includePhrases) {
    if (!strictPhraseMatches(phrase, search) && !partNumberQuery) {
      return null;
    }
    if (!strictPhraseMatches(phrase, search) && partNumberQuery) {
      continue;
    }
    const compact = compactNormalized(phrase);
    matchedTerms += 1;
    exactTerms += search.titleCompact === compact || search.offerCompact === compact ? 1 : 0;
    titleTerms += search.titleNormalized.includes(phrase) || search.titleCompact.includes(compact) ? 1 : 0;
    score += titleTerms ? 360 : 180;
  }

  for (const token of clause.includeTokens) {
    if (!strictTokenMatches(token, search) && !partNumberQuery) {
      return null;
    }
    if (!strictTokenMatches(token, search) && partNumberQuery) {
      continue;
    }
    matchedTerms += 1;
    const offerHit = hasToken(search.offerTokens, token);
    const titleHit = hasToken(search.titleTokens, token);
    const shopHit = hasToken(search.shopTokens, token);
    exactTerms += offerHit || titleHit ? 1 : 0;
    titleTerms += titleHit ? 1 : 0;
    score += offerHit ? 520 : titleHit ? 360 : shopHit ? 120 : 160;
  }

  if (partNumberQuery) {
    const compact = clause.compact;
    const support = partNumberSupport(clause, search);
    score += support.support * 1600;
    if (support.exact) score += 1100;
    if (support.titleHit) score += 420;
    if (search.offerCompact.includes(compact)) score += 900;
    if (search.titleCompact.includes(compact)) score += 700;
    if (search.blobCompact.includes(compact)) score += 220;
    if (search.offerCompact === compact || search.titleCompact === compact) score += 500;
    matchedTerms = Math.max(matchedTerms, 1);
    exactTerms += support.exact ? 1 : 0;
    titleTerms += support.titleHit ? 1 : 0;
  }

  return { row, score, exactTerms, matchedTerms, titleTerms, imageScore: 0, smartGuess: false };
}

function buildClauseMatch(row, clause) {
  const search = row._search;
  const partNumberQuery = clauseLooksLikePartNumber(clause);

  if (partNumberQuery && !strictPartNumberMatches(clause, search)) {
    return null;
  }

  for (const token of clause.excludeTokens) {
    const support = tokenSupportAcrossSearch(token, search).bestSupport;
    if (support >= minimumSupport(token)) {
      return null;
    }
  }

  for (const phrase of clause.excludePhrases) {
    if (phraseMatches(phrase, search)) {
      return null;
    }
  }

  if (!clauseHasTerms(clause)) {
    return { row, score: 0, exactTerms: 0, matchedTerms: 0, titleTerms: 0, imageScore: 0 };
  }

  let score = 0;
  let matchedTerms = 0;
  let exactTerms = 0;
  let titleTerms = 0;
  let smartGuess = false;
  const compactSupport = clauseCompactSupport(clause, search);

  for (const phrase of clause.includePhrases) {
    const phraseHit = phraseScore(phrase, search);
    if (!phraseHit) {
      return null;
    }
    matchedTerms += 1;
    exactTerms += search.titleCompact === compactNormalized(phrase) ? 1 : 0;
    titleTerms += search.titleNormalized.includes(phrase) ? 1 : 0;
    score += phraseHit;
  }

  const tokenStats = clause.includeTokens.map((token) => ({
    token,
    ...tokenSupportAcrossSearch(token, search),
  }));
  const failedTokens = tokenStats.filter(({ token, bestSupport }) => bestSupport < minimumSupport(token));
  if (failedTokens.length) {
    if (!state.smartSearch) {
      return null;
    }

    if (tokenStats.length === 1 && !clause.includePhrases.length) {
      const [{ token, bestSupport }] = tokenStats;
      const relaxedSupport = Math.max(0.56, minimumSupport(token) - 0.22);
      if (bestSupport < relaxedSupport && compactSupport.bestSupport < 0.78) {
        return null;
      }
      smartGuess = true;
    } else {
      const relaxedFailures = tokenStats.filter(
        ({ token, bestSupport }) => bestSupport < Math.max(0.42, minimumSupport(token) - 0.18)
      );
      const supportedCount = tokenStats.length - failedTokens.length + clause.includePhrases.length;
      const strongTokenCount = tokenStats.filter(({ bestSupport }) => bestSupport >= 0.84).length;
      const averageTokenSupport =
        tokenStats.reduce((sum, item) => sum + item.bestSupport, 0) / Math.max(tokenStats.length, 1);
      const totalRequiredTerms = clause.includeTokens.length + clause.includePhrases.length;
      const requiredCoverage = tokenStats.length >= 4 ? 0.75 : 0.67;
      const compactBestGuessRescue =
        compactSupport.bestSupport >= 0.66 && strongTokenCount >= Math.max(1, tokenStats.length - 1);

      if (
        relaxedFailures.length > 1 ||
        (!compactBestGuessRescue && supportedCount / Math.max(totalRequiredTerms, 1) < requiredCoverage) ||
        strongTokenCount < Math.max(1, tokenStats.length - 1) ||
        (!compactBestGuessRescue && compactSupport.bestSupport < 0.84 && averageTokenSupport < 0.73)
      ) {
        return null;
      }

      smartGuess = true;
    }
  }

  for (const { token, offerSupport, titleSupport, shopSupport, blobSupport, bestSupport } of tokenStats) {
    if (bestSupport >= minimumSupport(token)) {
      matchedTerms += 1;
    }
    exactTerms += bestSupport === 1 ? 1 : 0;
    if (titleSupport >= minimumSupport(token)) {
      titleTerms += 1;
    }

    score += Math.max(offerSupport * 480, titleSupport * 320, blobSupport * 170, shopSupport * 110);
    score += bestSupport * 45;
  }

  if (clause.smartTokens.length > 1) {
    const orderedTitleHits = countOrderedTokenHits(clause.smartTokens, search.titleSequence);
    const orderedBlobHits = countOrderedTokenHits(clause.smartTokens, search.blobSequence);

    if (orderedTitleHits === clause.smartTokens.length) {
      score += 190;
    } else {
      score += orderedTitleHits * 30;
    }

    if (orderedBlobHits === clause.smartTokens.length) {
      score += 80;
    }
  }

  if (compactSupport.titleSupport >= 0.78) {
    score += compactSupport.titleSupport * (smartGuess ? 150 : 230);
  }
  if (compactSupport.blobSupport >= 0.78) {
    score += compactSupport.blobSupport * (smartGuess ? 70 : 120);
  }

  if (
    search.titleSequence[0] &&
    clause.smartTokens[0] &&
    Math.max(
      tokenSimilarity(clause.smartTokens[0], search.titleSequence[0]),
      compactContainsSupport(clause.smartTokens[0], search.titleSequence[0])
    ) >= 0.88
  ) {
    score += 85;
  }

  if (partNumberQuery) {
    const support = partNumberSupport(clause, search);
    score += support.support * 1900;
    if (support.exact) score += 1300;
    if (support.titleHit) score += 520;
    matchedTerms = Math.max(matchedTerms, 1);
    exactTerms += support.exact ? 1 : 0;
    titleTerms += support.titleHit ? 1 : 0;
    smartGuess = smartGuess || (!support.exact && support.support < 0.98);
  }

  const totalRequiredTerms = clause.includeTokens.length + clause.includePhrases.length;
  if (!smartGuess) {
    if (titleTerms === totalRequiredTerms && totalRequiredTerms > 0) {
      score += 140;
    }
    if (exactTerms === totalRequiredTerms && totalRequiredTerms > 0) {
      score += 220;
    } else if (matchedTerms === totalRequiredTerms && totalRequiredTerms > 0) {
      score += 140;
    }
  } else {
    score = score * 0.76 + compactSupport.bestSupport * 120;
  }

  return { row, score, exactTerms, matchedTerms, titleTerms, imageScore: 0, smartGuess };
}

function buildMatch(row, query) {
  if (!query.hasSearchTerms) {
    return { row, score: 0, exactTerms: 0, matchedTerms: 0, titleTerms: 0, imageScore: 0 };
  }

  let bestMatch = null;
  for (const clause of query.clauses) {
    const clauseMatch = state.smartSearch ? buildClauseMatch(row, clause) : buildStrictClauseMatch(row, clause);
    if (!clauseMatch) {
      continue;
    }
    if (!bestMatch || clauseMatch.score > bestMatch.score) {
      bestMatch = clauseMatch;
    }
  }

  return bestMatch;
}

function buildStrictMatch(row, query) {
  if (!query.hasSearchTerms) {
    return { row, score: 0, exactTerms: 0, matchedTerms: 0, titleTerms: 0, imageScore: 0 };
  }

  let bestMatch = null;
  for (const clause of query.clauses) {
    const clauseMatch = buildStrictClauseMatch(row, clause);
    if (!clauseMatch) {
      continue;
    }
    if (!bestMatch || clauseMatch.score > bestMatch.score) {
      bestMatch = clauseMatch;
    }
  }

  return bestMatch;
}

function buildRelatedPartNumberMatch(row, query) {
  if (!query.hasSearchTerms) {
    return null;
  }

  const search = row._search;
  let bestMatch = null;
  for (const clause of query.clauses) {
    if (!clauseLooksLikePartNumber(clause)) {
      continue;
    }

    let excluded = false;
    for (const token of clause.excludeTokens) {
      if (strictTokenMatches(token, search)) {
        excluded = true;
        break;
      }
    }
    if (excluded) {
      continue;
    }
    for (const phrase of clause.excludePhrases) {
      if (strictPhraseMatches(phrase, search)) {
        excluded = true;
        break;
      }
    }
    if (excluded) {
      continue;
    }

    const support = partNumberSupport(clause, search);
    const compact = clause.compact || "";
    if (support.support < minimumPartNumberSupport(compact)) {
      continue;
    }

    const prefix = partNumberPrefixStats(compact, support.candidate || "");
    const titleText = `${search.titleNormalized} ${search.blobNormalized}`;
    const componentContext =
      /\b(mosfet|field effect|fet|transistor|tube|chip|ic|power)\b/.test(titleText) ||
      /场效应|晶体管|芯片/.test(titleText);
    const familyBoost = prefix.sameAlphaPrefix ? 420 : 0;
    const prefixBoost = prefix.prefixLength * 680;
    const exactBoost = support.exact ? 2600 : 0;
    const titleBoost = support.titleHit ? 760 : 0;
    const contextBoost = componentContext ? 260 : 0;
    const containmentBoost =
      compact && (search.titleCompact.includes(compact) || search.offerCompact.includes(compact)) ? 1400 : 0;

    const score =
      support.support * 3600 +
      exactBoost +
      containmentBoost +
      titleBoost +
      familyBoost +
      prefixBoost +
      contextBoost;

    const match = {
      row,
      score,
      exactTerms: support.exact || containmentBoost > 0 ? 1 : 0,
      matchedTerms: 1,
      titleTerms: support.titleHit ? 1 : 0,
      imageScore: 0,
      smartGuess: !support.exact,
    };
    if (!bestMatch || match.score > bestMatch.score) {
      bestMatch = match;
    }
  }

  return bestMatch;
}

function queryTextTerms(query) {
  if (query._textTerms) {
    return query._textTerms;
  }
  query._textTerms = uniqueTokens(
    query.clauses
      .flatMap((clause) => [
        ...clause.includeTokens,
        ...clause.includePhrases.flatMap((phrase) => tokenizeNormalized(phrase)),
      ])
      .filter(Boolean)
  );
  return query._textTerms;
}

function expandedSemanticTerms(token) {
  return AI_TEXT_SYNONYMS.get(token) || [token];
}

function aiTextTermWeight(token) {
  if (!token) {
    return 0;
  }
  if (clauseLooksLikePartNumber({ compact: compactNormalized(token), includeTokens: [token], includePhrases: [] })) {
    return 2.2;
  }
  if (/\d/.test(token)) {
    return 1.55;
  }
  if (AI_TEXT_LOW_INFORMATION_TERMS.has(token)) {
    return 0.35;
  }
  if (token.length <= 2) {
    return 0.45;
  }
  return 1;
}

function minimumAiTextMatchedWeight(terms) {
  const totalWeight = terms.reduce((sum, term) => sum + aiTextTermWeight(term), 0);
  if (terms.length <= 1) {
    return Math.min(totalWeight, 0.35);
  }
  if (terms.length === 2) {
    return Math.min(totalWeight, 1.1);
  }
  return Math.min(totalWeight, Math.max(1.75, totalWeight * 0.45));
}

function shouldSeedAiCandidatesFromTerm(term, termCount, partNumberMode) {
  if (partNumberMode || termCount <= 1) {
    return true;
  }
  return aiTextTermWeight(term) >= 0.8;
}

function addRowsFromPosting(candidateRows, posting) {
  if (!posting) {
    return 0;
  }
  let added = 0;
  for (const rowIndex of posting) {
    if (!candidateRows.has(rowIndex)) {
      added += 1;
    }
    candidateRows.add(rowIndex);
    if (candidateRows.size >= AI_TEXT_MAX_CANDIDATE_ROWS) {
      break;
    }
  }
  return added;
}

function fuzzyTokenCandidates(token, tokens, limit) {
  if (token.length <= 2) {
    return [];
  }
  const threshold = token.length <= 4 ? 0.82 : token.length <= 6 ? 0.72 : 0.62;
  const matches = [];
  for (const candidate of tokens) {
    if (candidate === token) {
      continue;
    }
    let support = tokenSimilarity(token, candidate);
    if (support < threshold && token.length >= 4) {
      support = Math.max(support, compactContainsSupport(token, candidate));
    }
    if (support >= threshold) {
      matches.push({ token: candidate, support });
    }
  }
  matches.sort((left, right) => right.support - left.support || left.token.length - right.token.length);
  return matches.slice(0, limit);
}

function indexedTextCandidateRows(query) {
  const index = aiTextIndex;
  const candidateRows = new Set();
  if (!index) {
    return candidateRows;
  }

  const terms = queryTextTerms(query);
  const partNumberMode = query.clauses.some(clauseLooksLikePartNumber);
  for (const term of terms) {
    let exactAdded = 0;
    if (shouldSeedAiCandidatesFromTerm(term, terms.length, partNumberMode)) {
      for (const expanded of expandedSemanticTerms(term)) {
        exactAdded += addRowsFromPosting(candidateRows, index.tokenToRows.get(expanded));
        exactAdded += addRowsFromPosting(candidateRows, index.titleTokenToRows.get(expanded));
        if (candidateRows.size >= AI_TEXT_MAX_CANDIDATE_ROWS) {
          break;
        }
      }
    }

    const fuzzyLimit =
      partNumberMode ||
      exactAdded > 0 ||
      !shouldSeedAiCandidatesFromTerm(term, terms.length, partNumberMode)
        ? 0
        : AI_TEXT_MAX_FUZZY_TOKENS_PER_TERM;
    for (const match of fuzzyTokenCandidates(term, index.tokens, fuzzyLimit)) {
      addRowsFromPosting(candidateRows, index.tokenToRows.get(match.token));
      if (candidateRows.size >= AI_TEXT_MAX_CANDIDATE_ROWS) {
        break;
      }
    }
    if (candidateRows.size >= AI_TEXT_MAX_CANDIDATE_ROWS) {
      break;
    }
  }

  if (!candidateRows.size && terms.length) {
    for (const term of terms) {
      for (const expanded of expandedSemanticTerms(term)) {
        addRowsFromPosting(candidateRows, index.tokenToRows.get(expanded));
        addRowsFromPosting(candidateRows, index.titleTokenToRows.get(expanded));
        if (candidateRows.size >= AI_TEXT_MAX_CANDIDATE_ROWS) {
          break;
        }
      }
      if (candidateRows.size >= AI_TEXT_MAX_CANDIDATE_ROWS) {
        break;
      }
    }
  }

  for (const clause of query.clauses) {
    if (!clauseLooksLikePartNumber(clause)) {
      continue;
    }
    const compact = clause.compact || "";
    const threshold = minimumPartNumberSupport(compact);
    const partMatches = [];
    const prefix =
      compact.length >= 5 ? compact.slice(0, 5) : compact.length >= 4 ? compact.slice(0, 4) : compact.slice(0, 3);
    const partCandidates = prefix ? index.partPrefixToTokens.get(prefix) || [] : index.partTokens;
    for (const candidate of partCandidates) {
      const support = partNumberSimilarity(compact, candidate);
      if (support >= threshold) {
        partMatches.push({ token: candidate, support });
      }
    }
    partMatches.sort((left, right) => right.support - left.support || left.token.length - right.token.length);
    for (const match of partMatches.slice(0, AI_TEXT_MAX_TOKEN_CANDIDATES)) {
      addRowsFromPosting(candidateRows, index.partTokenToRows.get(match.token));
    }
  }

  return candidateRows;
}

function aiIndexedTextScore(row, query) {
  const search = row._search;
  const terms = queryTextTerms(query);
  const totalTerms = Math.max(terms.length, 1);
  let score = 0;
  let matchedTerms = 0;
  let exactTerms = 0;
  let titleTerms = 0;
  let matchedWeight = 0;
  const totalWeight = terms.reduce((sum, term) => sum + aiTextTermWeight(term), 0);

  for (const term of terms) {
    const termWeight = aiTextTermWeight(term);
    let best = { support: 0, titleSupport: 0, exact: false, synonym: false };
    for (const expanded of expandedSemanticTerms(term)) {
      const support = tokenSupportAcrossSearch(expanded, search);
      const exact = hasToken(search.titleTokens, expanded) || hasToken(search.offerTokens, expanded);
      const candidate = {
        support: support.bestSupport,
        titleSupport: support.titleSupport,
        exact,
        synonym: expanded !== term,
      };
      if (candidate.support > best.support || (candidate.support === best.support && candidate.titleSupport > best.titleSupport)) {
        best = candidate;
      }
    }

    if (best.support >= minimumSupport(term) || best.titleSupport >= 0.58) {
      matchedTerms += 1;
      matchedWeight += termWeight;
      exactTerms += best.exact ? 1 : 0;
      titleTerms += best.titleSupport >= minimumSupport(term) ? 1 : 0;
      score += best.support * (best.synonym ? 260 : 380) * Math.max(termWeight, 0.4);
      score += best.titleSupport * (best.synonym ? 300 : 520) * Math.max(termWeight, 0.4);
      if (best.exact) {
        score += 260 * Math.max(termWeight, 0.4);
      }
    }
  }

  for (const clause of query.clauses) {
    if (clauseLooksLikePartNumber(clause)) {
      const support = partNumberSupport(clause, search);
      if (support.support >= minimumPartNumberSupport(clause.compact || "")) {
        const prefix = partNumberPrefixStats(clause.compact || "", support.candidate || "");
        matchedTerms = Math.max(matchedTerms, 1);
        matchedWeight = Math.max(matchedWeight, 2.2);
        exactTerms += support.exact ? 1 : 0;
        titleTerms += support.titleHit ? 1 : 0;
        score += support.support * 4200 + prefix.prefixLength * 620;
        if (support.exact) score += 2600;
        if (support.titleHit) score += 700;
      }
      continue;
    }

    if (clause.smartTokens.length > 1) {
      const orderedTitleHits = countOrderedTokenHits(clause.smartTokens, search.titleSequence);
      const orderedBlobHits = countOrderedTokenHits(clause.smartTokens, search.blobSequence);
      const coverage = Math.max(orderedTitleHits, orderedBlobHits) / Math.max(clause.smartTokens.length, 1);
      score += orderedTitleHits * 130 + orderedBlobHits * 40;
      if (coverage >= 0.8) {
        score += 520;
      }
    }

    const compactSupport = clauseCompactSupport(clause, search);
    if (compactSupport.titleSupport >= 0.76) {
      score += compactSupport.titleSupport * 360;
      titleTerms += 1;
    }
  }

  const coverageRatio = matchedTerms / totalTerms;
  const matchedWeightTarget = minimumAiTextMatchedWeight(terms);
  if (matchedWeight < matchedWeightTarget) {
    score = 0;
  } else if (totalTerms >= 3 && matchedTerms < 2) {
    score *= 0.2;
  } else if (coverageRatio >= 0.8) {
    score += 900;
  } else if (coverageRatio >= 0.55) {
    score += 420;
  }
  if (titleTerms >= Math.min(totalTerms, 3)) {
    score += 600;
  }

  return {
    score,
    exactTerms,
    matchedTerms,
    titleTerms,
    imageScore: 0,
    matchedWeight,
    totalWeight,
    smartGuess: exactTerms < totalTerms,
  };
}

async function searchMatchesByIndexedText(query, structuredFilters, runToken) {
  setImageProgress({
    visible: true,
    indeterminate: true,
    ratio: 0.18,
    label: "AI title search",
    numbers: `${formatNumber(state.rows.length)} listings indexed`,
  });
  if (!aiTextIndex) {
    updateSearchLoadingText("Building title index...");
    await yieldToBrowser();
    aiTextIndex = await buildAiTextIndexAsync(state.rows, runToken);
    if (!aiTextIndex || runToken !== state.filterRunToken) {
      return null;
    }
  }

  updateSearchLoadingText("Reading listing titles and names...");
  await yieldToBrowser();

  const candidateRows = indexedTextCandidateRows(query);
  if (runToken !== state.filterRunToken) {
    return null;
  }
  updateSearchLoadingText(`Ranking ${formatNumber(candidateRows.size)} title candidates...`);
  await yieldToBrowser();

  const matches = [];
  let inspected = 0;
  for (const rowIndex of candidateRows) {
    if (runToken !== state.filterRunToken) {
      return null;
    }
    inspected += 1;
    if (inspected % SEARCH_CHUNK_SIZE === 0) {
      updateSearchLoadingText(`Ranking ${formatNumber(inspected)} of ${formatNumber(candidateRows.size)} candidates...`);
      await yieldToBrowser();
    }

    const row = state.rows[rowIndex];
    if (!row || !rowPassesStructuredFilters(row, structuredFilters)) {
      continue;
    }
    const ranked = aiIndexedTextScore(row, query);
    if (ranked.score <= 0 || ranked.matchedTerms <= 0) {
      continue;
    }
    matches.push({ row, ...ranked });
  }

  setImageProgress({ visible: false, ratio: 0, label: "", numbers: "" });
  setImageSearchStatus(
    `AI title search active: ${formatNumber(matches.length)} ranked matches.`,
    "Exact title/part matches rank first, followed by close fuzzy and contextual wording matches."
  );
  return matches;
}

function numericPriceOrInfinity(row) {
  return typeof row.price_value === "number" ? row.price_value : Number.POSITIVE_INFINITY;
}

function compareText(left, right) {
  return String(left || "").localeCompare(String(right || ""), undefined, {
    sensitivity: "base",
    numeric: true,
  });
}

function rowHasImage(row) {
  return Boolean(imageSrcFor(row));
}

function imageSrcFor(row) {
  if (row.image_src) {
    return row.image_src;
  }
  if (!row.image_path) {
    return "";
  }
  const encodedPath = String(row.image_path)
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
  return `/files/${encodedPath}`;
}

function resolveStructuredFilters(query) {
  const queryMinBase = Number.isFinite(query.filters.minPrice)
    ? convertCurrencyToBase(query.filters.minPrice, state.displayCurrency)
    : null;
  const queryMaxBase = Number.isFinite(query.filters.maxPrice)
    ? convertCurrencyToBase(query.filters.maxPrice, state.displayCurrency)
    : null;

  let minPrice = Number.isFinite(state.minPrice) ? state.minPrice : queryMinBase;
  let maxPrice = Number.isFinite(state.maxPrice) ? state.maxPrice : queryMaxBase;

  if (Number.isFinite(minPrice) && Number.isFinite(maxPrice) && minPrice > maxPrice) {
    const swappedMin = maxPrice;
    maxPrice = minPrice;
    minPrice = swappedMin;
  }

  return {
    minPrice,
    maxPrice,
    hasImage: Boolean(state.hasImageOnly || query.filters.hasImage || state.imageQueryPreviewUrl),
    shopNormalized: query.filters.shopNormalized,
    offerCompact: query.filters.offerCompact,
  };
}

function rowPassesStructuredFilters(row, filters) {
  if (state.disabledShops.has(row.shop)) {
    return false;
  }

  if (state.shop !== "all" && row.shop !== state.shop) {
    return false;
  }

  if (filters.shopNormalized && !row._search.shopNormalized.includes(filters.shopNormalized)) {
    return false;
  }

  if (filters.offerCompact && !row._search.offerCompact.includes(filters.offerCompact)) {
    return false;
  }

  if (filters.hasImage && !rowHasImage(row)) {
    return false;
  }

  const priceValue = typeof row.price_value === "number" ? row.price_value : null;
  if (Number.isFinite(filters.minPrice) && (priceValue === null || priceValue < filters.minPrice)) {
    return false;
  }
  if (Number.isFinite(filters.maxPrice) && (priceValue === null || priceValue > filters.maxPrice)) {
    return false;
  }

  return true;
}

function hammingDistance(left, right) {
  let distance = 0;
  for (let index = 0; index < left.length; index += 1) {
    distance += POPCOUNT_TABLE[left[index] ^ right[index]];
  }
  return distance;
}

function histogramIntersection(left, right) {
  let overlap = 0;
  for (let index = 0; index < left.length; index += 1) {
    overlap += Math.min(left[index], right[index]);
  }
  return overlap;
}

function aspectSimilarity(leftRatio, rightRatio) {
  const safeLeft = Math.max(leftRatio || 1, 0.01);
  const safeRight = Math.max(rightRatio || 1, 0.01);
  const diff = Math.abs(Math.log(safeLeft / safeRight));
  return Math.max(0, 1 - diff / Math.log(2.4));
}

function compareImageSignatures(left, right) {
  const hashScore = 1 - hammingDistance(left.hash, right.hash) / 64;
  const histogramScore = histogramIntersection(left.histogram, right.histogram);
  const ratioScore = aspectSimilarity(left.aspectRatio, right.aspectRatio);
  return hashScore * 0.74 + histogramScore * 0.21 + ratioScore * 0.05;
}

function supportsWorkerImagePipeline() {
  return (
    typeof Worker !== "undefined" &&
    typeof OffscreenCanvas !== "undefined" &&
    typeof createImageBitmap === "function"
  );
}

function normalizeWorkerSignature(signature) {
  if (!signature) {
    return null;
  }
  return {
    hash: signature.hash instanceof Uint8Array ? signature.hash : new Uint8Array(signature.hash || []),
    histogram:
      signature.histogram instanceof Float32Array ? signature.histogram : new Float32Array(signature.histogram || []),
    aspectRatio: Number(signature.aspectRatio) || 1,
  };
}

function createImageWorkerState() {
  const worker = new Worker("/image-worker.js");
  const state = {
    worker,
    pendingCount: 0,
    resolvers: new Map(),
  };

  worker.addEventListener("message", (event) => {
    const { taskId, ok, signature, error } = event.data || {};
    const resolver = state.resolvers.get(taskId);
    if (!resolver) {
      return;
    }
    state.resolvers.delete(taskId);
    state.pendingCount = Math.max(0, state.pendingCount - 1);
    if (ok) {
      resolver.resolve(normalizeWorkerSignature(signature));
    } else {
      resolver.reject(new Error(error || "Image worker task failed."));
    }
  });

  worker.addEventListener("error", (event) => {
    const pending = [...state.resolvers.values()];
    state.resolvers.clear();
    state.pendingCount = 0;
    for (const resolver of pending) {
      resolver.reject(new Error(event.message || "Image worker crashed."));
    }
  });

  return state;
}

function ensureImageWorkerPool() {
  if (!supportsWorkerImagePipeline()) {
    return null;
  }
  if (!imageWorkerPool) {
    imageWorkerPool = Array.from({ length: IMAGE_WORKER_POOL_SIZE }, () => createImageWorkerState());
  }
  return imageWorkerPool;
}

function runImageWorkerTask(source) {
  const pool = ensureImageWorkerPool();
  if (!pool) {
    return null;
  }

  const workerState = pool.reduce((best, current) =>
    current.pendingCount < best.pendingCount ? current : best
  );
  const taskId = `image-task-${++imageWorkerTaskId}`;

  return new Promise((resolve, reject) => {
    workerState.pendingCount += 1;
    workerState.resolvers.set(taskId, { resolve, reject });
    workerState.worker.postMessage({ taskId, source });
  });
}

function loadImageElement(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.decoding = "async";
    image.referrerPolicy = "no-referrer";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`Could not load image: ${src}`));
    image.src = src;
  });
}

function imageSourceDimensions(image) {
  return {
    width: image.naturalWidth || image.width || 1,
    height: image.naturalHeight || image.height || 1,
  };
}

async function loadImageSource(source) {
  if (source instanceof Blob) {
    if (typeof createImageBitmap === "function") {
      return createImageBitmap(source);
    }

    const objectUrl = URL.createObjectURL(source);
    try {
      return await loadImageElement(objectUrl);
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
  }

  return loadImageElement(source);
}

async function computeImageSignature(source) {
  const image = await loadImageSource(source);
  try {
    const dimensions = imageSourceDimensions(image);

    const hashCanvas = document.createElement("canvas");
    hashCanvas.width = IMAGE_HASH_WIDTH;
    hashCanvas.height = IMAGE_HASH_HEIGHT;
    const hashContext = hashCanvas.getContext("2d", { willReadFrequently: true });
    hashContext.drawImage(image, 0, 0, IMAGE_HASH_WIDTH, IMAGE_HASH_HEIGHT);
    const hashPixels = hashContext.getImageData(0, 0, IMAGE_HASH_WIDTH, IMAGE_HASH_HEIGHT).data;

    const hash = new Uint8Array(8);
    let bitIndex = 0;
    for (let y = 0; y < IMAGE_HASH_HEIGHT; y += 1) {
      for (let x = 0; x < IMAGE_HASH_WIDTH - 1; x += 1) {
        const leftOffset = (y * IMAGE_HASH_WIDTH + x) * 4;
        const rightOffset = leftOffset + 4;
        const leftLuma =
          hashPixels[leftOffset] * 0.299 +
          hashPixels[leftOffset + 1] * 0.587 +
          hashPixels[leftOffset + 2] * 0.114;
        const rightLuma =
          hashPixels[rightOffset] * 0.299 +
          hashPixels[rightOffset + 1] * 0.587 +
          hashPixels[rightOffset + 2] * 0.114;
        if (leftLuma > rightLuma) {
          hash[bitIndex >> 3] |= 1 << (bitIndex & 7);
        }
        bitIndex += 1;
      }
    }

    const histogramCanvas = document.createElement("canvas");
    histogramCanvas.width = IMAGE_SAMPLE_SIZE;
    histogramCanvas.height = IMAGE_SAMPLE_SIZE;
    const histogramContext = histogramCanvas.getContext("2d", { willReadFrequently: true });
    histogramContext.drawImage(image, 0, 0, IMAGE_SAMPLE_SIZE, IMAGE_SAMPLE_SIZE);
    const histogramPixels = histogramContext.getImageData(0, 0, IMAGE_SAMPLE_SIZE, IMAGE_SAMPLE_SIZE).data;

    const histogram = new Float32Array(IMAGE_HISTOGRAM_SIZE);
    const totalPixels = IMAGE_SAMPLE_SIZE * IMAGE_SAMPLE_SIZE;
    for (let offset = 0; offset < histogramPixels.length; offset += 4) {
      const luma =
        histogramPixels[offset] * 0.299 +
        histogramPixels[offset + 1] * 0.587 +
        histogramPixels[offset + 2] * 0.114;
      const bucket = Math.min(IMAGE_HISTOGRAM_SIZE - 1, Math.floor((luma / 256) * IMAGE_HISTOGRAM_SIZE));
      histogram[bucket] += 1 / totalPixels;
    }

    return {
      hash,
      histogram,
      aspectRatio: dimensions.width > 0 && dimensions.height > 0 ? dimensions.width / dimensions.height : 1,
    };
  } finally {
    image.close?.();
  }
}

async function computeImageSignatureFast(source) {
  const workerPromise = runImageWorkerTask(
    source instanceof Blob ? { file: source } : { src: source }
  );
  if (!workerPromise) {
    return computeImageSignature(source);
  }

  try {
    return await workerPromise;
  } catch {
    return computeImageSignature(source);
  }
}

function getImageSignature(source) {
  if (!source) {
    return Promise.resolve(null);
  }

  if (!IMAGE_SIGNATURE_CACHE.has(source)) {
    IMAGE_SIGNATURE_CACHE.set(
      source,
      computeImageSignatureFast(source).catch(() => null)
    );
  }
  return IMAGE_SIGNATURE_CACHE.get(source);
}

async function rankMatchesByImage(matches, runToken) {
  if (!state.imageQueryPreviewUrl) {
    return matches;
  }
  if (!state.imageQueryFile) {
    throw new Error("The query image is no longer available.");
  }

  const candidates = matches.filter((entry) => entry.row.image_path);
  if (!candidates.length) {
    setImageSearchStatus(
      "Image search active, but no local images are available.",
      "Clear some filters or reload if you added saved listing images."
    );
    return [];
  }

  setImageProgress({
    visible: true,
    indeterminate: true,
    ratio: 0.18,
    label: "Contacting local image index",
    numbers: `${formatNumber(candidates.length)} filtered candidates`,
  });

  const statusResponse = ensureImageSearchApiAvailable(
    await fetchJsonDetailedWithRetry("/api/image-search/status")
  );
  updateImageSearchStatusFromServer(statusResponse.data);
  if (runToken !== state.filterRunToken) {
    return null;
  }

  if (!statusResponse.data?.ready) {
    const readyStatus = await waitForImageSearchReady(runToken);
    if (readyStatus === null || runToken !== state.filterRunToken) {
      return null;
    }
  }

  const imageBase64 = await imageFileToDataUrl(state.imageQueryFile);
  if (runToken !== state.filterRunToken) {
    return null;
  }

  const response = ensureImageSearchApiAvailable(
    await fetchJsonDetailedWithRetry("/api/image-search/query", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        image_base64: imageBase64,
        top_k: 2000,
      }),
    })
  );

  if (runToken !== state.filterRunToken) {
    return null;
  }

  if (response.status === 202) {
    const readyStatus = await waitForImageSearchReady(runToken);
    if (readyStatus === null || runToken !== state.filterRunToken) {
      return null;
    }
    return rankMatchesByImage(matches, runToken);
  }

  if (!response.ok || response.data?.error) {
    throw new Error(response.data?.error || `Image search request failed with ${response.status}`);
  }

  updateImageSearchStatusFromServer(response.data?.status);
  const results = Array.isArray(response.data?.results) ? response.data.results : [];
  if (!results.length) {
    setImageSearchStatus(
      "No visual matches found.",
      "Try a clearer product image, or loosen the text and price filters."
    );
    return [];
  }

  const scoreById = new Map(results.map((item) => [String(item.id), Number(item.score) || 0]));
  const filtered = candidates
    .filter((entry) => scoreById.has(entry.row.id))
    .map((entry) => {
      const imageScore = scoreById.get(entry.row.id) || 0;
      return {
        ...entry,
        imageScore,
        row: {
          ...entry.row,
          _imageScore: imageScore,
        },
      };
    });

  if (!filtered.length) {
    return [];
  }

  const bestScore = filtered[0]?.imageScore ?? Math.max(...filtered.map((entry) => entry.imageScore));
  setImageSearchStatus(
    `Image search active: ${formatNumber(filtered.length)} CLIP match${filtered.length === 1 ? "" : "es"}.`,
    `Top similarity ${Math.round(bestScore * 100)}%. Results are ranked by the CUDA image index.`
  );

  return filtered;
}

async function rankMatchesByAiText(query, structuredRows, textMatches, runToken) {
  if (
    !state.smartSearch ||
    state.imageQueryPreviewUrl ||
    !query.hasSearchTerms ||
    !query.raw.trim() ||
    query.clauses.some(clauseLooksLikePartNumber)
  ) {
    return textMatches;
  }

  const candidateIds = structuredRows
    .filter((row) => row.image_path)
    .map((row) => String(row.id || ""))
    .filter(Boolean);
  if (!candidateIds.length) {
    return textMatches;
  }

  try {
    setImageProgress({
      visible: true,
      indeterminate: true,
      ratio: 0.28,
      label: "GPU AI text search",
      numbers: `${formatNumber(candidateIds.length)} image embeddings`,
    });
    updateSearchLoadingText("GPU AI ranking...");

    const response = ensureImageSearchApiAvailable(
      await fetchJsonDetailedWithRetry("/api/image-search/text-query", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          query: query.raw,
          candidate_ids: candidateIds,
          top_k: AI_TEXT_SEARCH_TOP_K,
        }),
      }, 1)
    );

    if (runToken !== state.filterRunToken || response.status === 202 || !response.ok) {
      defaultImageSearchStatus();
      return textMatches;
    }

    updateImageSearchStatusFromServer(response.data?.status);
    const aiResults = Array.isArray(response.data?.results) ? response.data.results : [];
    if (!aiResults.length) {
      defaultImageSearchStatus();
      return textMatches;
    }

    const rowById = new Map(structuredRows.map((row) => [String(row.id), row]));
    const matchById = new Map(textMatches.map((entry) => [String(entry.row.id), { ...entry }]));
    const scores = aiResults.map((item) => Number(item.score) || 0);
    const bestScore = Math.max(...scores);
    const worstScore = Math.min(...scores);
    const spread = Math.max(0.0001, bestScore - worstScore);

    aiResults.forEach((item, index) => {
      const id = String(item.id || "");
      const row = rowById.get(id);
      if (!row) {
        return;
      }
      const rawScore = Number(item.score) || 0;
      const normalized = Math.max(0, Math.min(1, (rawScore - worstScore) / spread));
      const rankBoost = 1 - index / Math.max(aiResults.length, 1);
      const aiBoost = normalized * 300 + rankBoost * 60;
      const existing = matchById.get(id);
      if (existing) {
        existing.score += aiBoost;
        existing.imageScore = rawScore;
        existing.smartGuess = existing.smartGuess || normalized >= 0.62;
        matchById.set(id, existing);
        return;
      }
      if (index < AI_TEXT_SEARCH_INCLUDE_LIMIT && normalized >= 0.72) {
        matchById.set(id, {
          row,
          score: aiBoost,
          exactTerms: 0,
          matchedTerms: 0,
          titleTerms: 0,
          imageScore: rawScore,
          smartGuess: true,
        });
      }
    });

    setImageSearchStatus(
      `GPU AI Search active: ${formatNumber(aiResults.length)} semantic image matches.`,
      `Running on ${String(response.data?.status?.device || "GPU").toUpperCase()} with CLIP text-to-image ranking.`
    );
    return [...matchById.values()];
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("missing the image search API")) {
      setImageSearchStatus("GPU AI Search unavailable.", error.message || String(error));
    }
    defaultImageSearchStatus();
    return textMatches;
  }
}

function aiTextRelevanceForRow(row, query) {
  const search = row._search;
  let best = {
    score: 0,
    matchedTerms: 0,
    exactTerms: 0,
    titleTerms: 0,
  };

  for (const clause of query.clauses) {
    let excluded = false;
    for (const token of clause.excludeTokens) {
      if (tokenSupportAcrossSearch(token, search).bestSupport >= minimumSupport(token)) {
        excluded = true;
        break;
      }
    }
    if (excluded) {
      continue;
    }
    for (const phrase of clause.excludePhrases) {
      if (phraseMatches(phrase, search)) {
        excluded = true;
        break;
      }
    }
    if (excluded) {
      continue;
    }

    let score = 0;
    let matchedTerms = 0;
    let exactTerms = 0;
    let titleTerms = 0;

    for (const phrase of clause.includePhrases) {
      if (!phraseMatches(phrase, search)) {
        continue;
      }
      const compact = compactNormalized(phrase);
      const titleHit = search.titleNormalized.includes(phrase) || search.titleCompact.includes(compact);
      const exactHit = search.titleCompact === compact || search.offerCompact === compact;
      matchedTerms += 1;
      titleTerms += titleHit ? 1 : 0;
      exactTerms += exactHit ? 1 : 0;
      score += titleHit ? 460 : 220;
      if (exactHit) {
        score += 360;
      }
    }

    for (const token of clause.includeTokens) {
      const support = tokenSupportAcrossSearch(token, search);
      const threshold = minimumSupport(token);
      if (support.bestSupport < threshold) {
        continue;
      }
      const titleHit = support.titleSupport >= threshold;
      const exactHit = hasToken(search.offerTokens, token) || hasToken(search.titleTokens, token);
      matchedTerms += 1;
      titleTerms += titleHit ? 1 : 0;
      exactTerms += exactHit ? 1 : 0;
      score += Math.max(
        support.offerSupport * 460,
        support.titleSupport * 420,
        support.blobSupport * 180,
        support.shopSupport * 90
      );
      if (exactHit) {
        score += 140;
      }
    }

    if (matchedTerms > 0) {
      score += matchedTerms * 160 + titleTerms * 120 + exactTerms * 90;
      const totalTerms = clause.includeTokens.length + clause.includePhrases.length;
      if (totalTerms > 0 && matchedTerms >= Math.ceil(totalTerms * 0.6)) {
        score += 360;
      }
    }

    if (score > best.score) {
      best = { score, matchedTerms, exactTerms, titleTerms };
    }
  }

  return best;
}

async function searchMatchesByAiText(query, structuredRows, runToken) {
  if (!query.hasSearchTerms || !query.raw.trim()) {
    return null;
  }

  const candidateIds = structuredRows
    .filter((row) => row.image_path)
    .map((row) => String(row.id || ""))
    .filter(Boolean);
  if (!candidateIds.length) {
    setImageSearchStatus(
      "GPU AI Search active, but no local images are available.",
      "Clear the image filter or reload if you added saved listing images."
    );
    return [];
  }

  setImageProgress({
    visible: true,
    indeterminate: true,
    ratio: 0.22,
    label: "GPU AI text search",
    numbers: `${formatNumber(candidateIds.length)} image embeddings`,
  });
  updateSearchLoadingText(`GPU AI searching ${formatNumber(candidateIds.length)} listings...`);

  try {
    let response = ensureImageSearchApiAvailable(
      await fetchJsonDetailedWithRetry("/api/image-search/text-query", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          query: query.raw,
          candidate_ids: candidateIds,
          top_k: AI_TEXT_SEARCH_TOP_K,
        }),
      }, 1)
    );

    if (runToken !== state.filterRunToken) {
      return null;
    }

    if (response.status === 202) {
      const readyStatus = await waitForImageSearchReady(runToken);
      if (readyStatus === null || runToken !== state.filterRunToken) {
        return null;
      }
      response = ensureImageSearchApiAvailable(
        await fetchJsonDetailedWithRetry("/api/image-search/text-query", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            query: query.raw,
            candidate_ids: candidateIds,
            top_k: AI_TEXT_SEARCH_TOP_K,
          }),
        }, 1)
      );
    }

    if (runToken !== state.filterRunToken) {
      return null;
    }

    if (!response.ok || response.data?.error) {
      throw new Error(response.data?.error || `GPU AI Search request failed with ${response.status}`);
    }

    updateImageSearchStatusFromServer(response.data?.status);
    const aiResults = Array.isArray(response.data?.results) ? response.data.results : [];
    if (!aiResults.length) {
      setImageSearchStatus(
        "GPU AI Search found no matches.",
        "Try a broader visual description, or switch GPU AI Search off for exact text matching."
      );
      return [];
    }

    const rowById = new Map(structuredRows.map((row) => [String(row.id), row]));
    const scores = aiResults.map((item) => Number(item.score) || 0);
    const bestScore = Math.max(...scores);
    const worstScore = Math.min(...scores);
    const spread = Math.max(0.0001, bestScore - worstScore);
    const matches = [];

    const scoredMatches = [];

    aiResults.forEach((item, index) => {
      const id = String(item.id || "");
      const row = rowById.get(id);
      if (!row) {
        return;
      }
      const rawScore = Number(item.score) || 0;
      const normalized = Math.max(0, Math.min(1, (rawScore - worstScore) / spread));
      const rankBoost = 1 - index / Math.max(aiResults.length, 1);
      const textRelevance = aiTextRelevanceForRow(row, query);
      scoredMatches.push({
        row: {
          ...row,
          _imageScore: rawScore,
        },
        score: textRelevance.score + normalized * 260 + rankBoost * 70,
        exactTerms: textRelevance.exactTerms,
        matchedTerms: textRelevance.matchedTerms,
        titleTerms: textRelevance.titleTerms,
        imageScore: rawScore,
        smartGuess: true,
      });
    });

    const hasTextRelevantMatches = scoredMatches.some((entry) => entry.matchedTerms > 0);
    matches.push(
      ...(hasTextRelevantMatches
        ? scoredMatches.filter((entry) => entry.matchedTerms > 0 || entry.score >= 260)
        : scoredMatches)
    );

    setImageSearchStatus(
      `GPU AI Search active: ${formatNumber(matches.length)} hybrid matches.`,
      `Running on ${String(response.data?.status?.device || "GPU").toUpperCase()} with CLIP candidates plus title/text reranking.`
    );
    return matches;
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("missing the image search API")) {
      setImageSearchStatus("GPU AI Search unavailable.", error.message || String(error));
    }
    return [];
  }
}

function sortMatches(matches, query, imageSearchActive) {
  matches.sort((left, right) => {
    switch (state.sort) {
      case "price-asc":
        return (
          numericPriceOrInfinity(left.row) - numericPriceOrInfinity(right.row) ||
          right.imageScore - left.imageScore ||
          compareText(left.row.title, right.row.title)
        );
      case "price-desc":
        return (
          numericPriceOrInfinity(right.row) - numericPriceOrInfinity(left.row) ||
          right.imageScore - left.imageScore ||
          compareText(left.row.title, right.row.title)
        );
      case "title":
        return compareText(left.row.title, right.row.title) || right.imageScore - left.imageScore;
      case "shop":
        return (
          compareText(left.row.shop, right.row.shop) ||
          compareText(left.row.title, right.row.title) ||
          right.imageScore - left.imageScore
        );
      default:
        if (imageSearchActive) {
          return (
            right.imageScore - left.imageScore ||
            right.score - left.score ||
            right.exactTerms - left.exactTerms ||
            right.titleTerms - left.titleTerms ||
            compareText(left.row.title, right.row.title)
          );
        }
        if (query.hasSearchTerms) {
          return (
            right.score - left.score ||
            right.exactTerms - left.exactTerms ||
            right.titleTerms - left.titleTerms ||
            compareText(left.row.title, right.row.title)
          );
        }
        return compareText(left.row.shop, right.row.shop) || compareText(left.row.title, right.row.title);
    }
  });
}

function isBrowsePreviewMode(query, filters) {
  return (
    !state.imageQueryPreviewUrl &&
    !query.hasSearchTerms &&
    state.shop === "all" &&
    !filters.shopNormalized &&
    !filters.offerCompact &&
    !filters.hasImage &&
    !Number.isFinite(filters.minPrice) &&
    !Number.isFinite(filters.maxPrice)
  );
}

async function applyFilters({ resetScroll = false } = {}) {
  const runToken = state.filterRunToken + 1;
  state.filterRunToken = runToken;
  setSearchLoading(true);

  try {
    const query = parseQuery(state.query);
    const structuredFilters = resolveStructuredFilters(query);
    const requestPayload = {
      query: query.cleanedRaw,
      sort: state.sort,
      offset: 0,
      limit: INITIAL_BROWSE_BATCH,
      min_price: Number.isFinite(structuredFilters.minPrice) ? structuredFilters.minPrice : null,
      max_price: Number.isFinite(structuredFilters.maxPrice) ? structuredFilters.maxPrice : null,
      has_image: Boolean(structuredFilters.hasImage),
      shop_exact: state.shop !== "all" ? state.shop : "",
      shop_filter: structuredFilters.shopNormalized || "",
      offer_filter: structuredFilters.offerCompact || "",
      disabled_shops: [...state.disabledShops],
    };
    state.serverSearchRequest = requestPayload;
    updateSearchLoadingText("Searching server index...");
    const response = await fetchJson("/api/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestPayload),
    });
    if (runToken !== state.filterRunToken) {
      return;
    }
    if (response.ready === false) {
      state.filteredRows = [];
      state.browseTotalRows = 0;
      state.browsePreviewActive = false;
      setImageSearchStatus("Search index is still loading.", response.message || "");
      renderResults({ resetScroll });
      return;
    }
    state.browseLimit = INITIAL_BROWSE_BATCH;
    state.browseRows = [];
    state.filteredRows = Array.isArray(response.rows) ? response.rows.map(buildSearchIndex) : [];
    state.browseTotalRows = Number(response.total || state.filteredRows.length);
    state.browsePreviewActive = state.filteredRows.length < state.browseTotalRows;
    defaultImageSearchStatus();
    renderResults({ resetScroll });
    refreshIdleStatus();
  } catch (error) {
    if (runToken === state.filterRunToken) {
      setImageSearchStatus("Search failed.", error.message || String(error));
    }
  } finally {
    if (runToken === state.filterRunToken) {
      setSearchLoading(false);
    }
  }
}

function sugargooUrlFor(row) {
  if (row.sugargoo_url) {
    return row.sugargoo_url;
  }
  const sourceUrl = row.source_url || row.source_1688_url;
  if (!sourceUrl) {
    return "";
  }
  return `https://www.sugargoo.com/products?productLink=${encodeURIComponent(encodeURIComponent(sourceUrl))}`;
}

function listingLinks(row) {
  const links = [];
  const sugargooUrl = sugargooUrlFor(row);
  if (sugargooUrl) {
    links.push(`<a href="${escapeHtml(sugargooUrl)}" target="_blank" rel="noreferrer" data-open-external="browser">Sugargoo</a>`);
  }
  const sourceUrl = row.source_url || row.source_1688_url;
  if (sourceUrl) {
    links.push(`<a href="${escapeHtml(sourceUrl)}" target="_blank" rel="noreferrer" data-open-external="browser">Source</a>`);
  }
  const imageSrc = imageSrcFor(row);
  if (imageSrc) {
    links.push(`<a href="${escapeHtml(imageSrc)}" target="_blank" rel="noreferrer">Image</a>`);
  }
  return links.join("");
}

async function openExternalUrl(url) {
  await fetchJson("/api/open-url", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ url }),
  });
}

function listingPriceDisplay(row) {
  if (typeof row.price_value !== "number") {
    return {
      primary: row.price_text || "No price",
      secondary: "",
    };
  }

  const primaryValue = convertBaseToCurrency(row.price_value, state.displayCurrency);
  const primary = primaryValue === null ? (row.price_text || "No price") : formatCurrencyValue(primaryValue, state.displayCurrency);
  const secondaryParts = ["usd", "cad", "cny"]
    .filter((currencyKey) => currencyKey !== state.displayCurrency)
    .map((currencyKey) => {
      const converted = convertBaseToCurrency(row.price_value, currencyKey);
      return converted === null ? "" : formatCurrencyValue(converted, currencyKey);
    })
    .filter(Boolean);

  if (row.price_original_text && row.price_original_text !== row.price_text) {
    secondaryParts.push(`Original ${row.price_original_text}`);
  }

  const secondary = secondaryParts.join(" · ");

  return { primary, secondary };
}

function makeCardMarkup(row) {
  const imageSrc = imageSrcFor(row);
  const imageMarkup = imageSrc
    ? `<img src="${escapeHtml(imageSrc)}" alt="${escapeHtml(row.title)}" loading="lazy" referrerpolicy="no-referrer">`
    : `<div class="image-fallback">No image saved for this listing.</div>`;

  const offerBits = [];
  if (row.offer_id) {
    offerBits.push(`Offer ${escapeHtml(row.offer_id)}`);
  }
  if (row.sales) {
    offerBits.push(escapeHtml(row.sales));
  }
  if (!offerBits.length) {
    offerBits.push("No offer ID or sales text");
  }

  const similarityMarkup =
    typeof row._imageScore === "number"
      ? `<span class="similarity-pill">${Math.round(row._imageScore * 100)}% similar</span>`
      : "";
  const smartGuessMarkup = row._smartGuess ? `<span class="smart-pill">Best guess</span>` : "";
  const priceDisplay = listingPriceDisplay(row);

  return `
    <article class="listing-card">
      <div class="image-wrap">${imageMarkup}</div>
      <div class="card-body">
        <div class="card-topline">
          <div class="card-pill-row">
            <span class="price-pill">${escapeHtml(priceDisplay.primary)}</span>
            ${similarityMarkup}
            ${smartGuessMarkup}
          </div>
          <span class="shop-tag">${escapeHtml(row.shop)}</span>
        </div>
        <h2>${escapeHtml(row.title)}</h2>
        ${priceDisplay.secondary ? `<div class="price-conversions">${escapeHtml(priceDisplay.secondary)}</div>` : ""}
        <div class="card-subline">${offerBits.join(" · ")}</div>
        <div class="card-links">${listingLinks(row)}</div>
        <div class="card-footline">${escapeHtml(row.source_file)}</div>
      </div>
    </article>
  `;
}

function attachImageFallbacks(scope) {
  const images = scope.querySelectorAll("img");
  for (const image of images) {
    image.addEventListener(
      "error",
      () => {
        image.replaceWith(
          Object.assign(document.createElement("div"), {
            className: "image-fallback",
            textContent: "Image could not be loaded.",
          })
        );
      },
      { once: true }
    );
  }
}

function updateSummaries() {
  if (state.meta?.ready === false) {
    elements.resultSummary.textContent = state.meta.building === false ? "Listings unavailable" : "Indexing listings...";
    elements.datasetSummary.textContent =
      state.meta.message || "Scanning collection folders in the background.";
    elements.browseMoreButton.classList.add("hidden");
    elements.loadHint.textContent = "";
    return;
  }

  const shown = state.renderedCount;
  const total = state.filteredRows.length;
  const overall = state.browsePreviewActive ? state.browseTotalRows : state.meta?.total_rows || 0;
  elements.resultSummary.textContent =
    total === overall
      ? `Showing all ${formatNumber(total)} listings`
      : `Showing ${formatNumber(total)} matches`;
  elements.datasetSummary.textContent = `${formatNumber(shown)} currently rendered for smooth scrolling.`;

  const canExpandBrowse = state.browsePreviewActive && state.filteredRows.length < state.browseTotalRows;
  elements.browseMoreButton.classList.add("hidden");

  if (canExpandBrowse) {
    elements.loadHint.textContent =
      `Previewing ${formatNumber(total)} of ${formatNumber(state.browseTotalRows)} listings. Scroll to load more.`;
  } else if (shown < total) {
    elements.loadHint.textContent = `Scroll to load ${formatNumber(total - shown)} more results.`;
  } else if (total > 0) {
    elements.loadHint.textContent = `Loaded ${formatNumber(total)} result${total === 1 ? "" : "s"}.`;
  } else {
    elements.loadHint.textContent = "";
  }
}

function renderMore() {
  const start = state.renderedCount;
  const end = Math.min(start + PAGE_SIZE, state.filteredRows.length);
  if (start >= end) {
    return false;
  }

  const html = state.filteredRows.slice(start, end).map(makeCardMarkup).join("");
  const template = document.createElement("template");
  template.innerHTML = html;
  attachImageFallbacks(template.content);
  elements.resultsGrid.append(template.content);
  state.renderedCount = end;
  updateSummaries();
  return true;
}

function renderResults({ resetScroll = false } = {}) {
  state.renderedCount = 0;
  elements.resultsGrid.innerHTML = "";

  if (resetScroll) {
    elements.resultsScroll.scrollTop = 0;
  }
  state.lastResultsScrollTop = elements.resultsScroll.scrollTop;

  const indexing = state.meta?.ready === false;
  const hasResults = state.filteredRows.length > 0;
  elements.emptyState.classList.toggle("hidden", hasResults || indexing);
  if (!hasResults) {
    updateSummaries();
    return;
  }

  renderMore();
}

async function loadMoreServerResults() {
  if (
    state.serverSearchLoadingMore ||
    !state.browsePreviewActive ||
    !state.serverSearchRequest ||
    state.filteredRows.length >= state.browseTotalRows
  ) {
    return false;
  }
  state.serverSearchLoadingMore = true;
  try {
    const payload = {
      ...state.serverSearchRequest,
      offset: state.filteredRows.length,
      limit: INITIAL_BROWSE_BATCH,
    };
    const response = await fetchJson("/api/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const nextRows = Array.isArray(response.rows) ? response.rows.map(buildSearchIndex) : [];
    if (!nextRows.length) {
      state.browsePreviewActive = false;
      updateSummaries();
      return false;
    }
    state.filteredRows.push(...nextRows);
    state.browseTotalRows = Number(response.total || state.browseTotalRows);
    state.browsePreviewActive = state.filteredRows.length < state.browseTotalRows;
    updateSummaries();
    return true;
  } finally {
    state.serverSearchLoadingMore = false;
  }
}

function updateErrorBanner(errors) {
  if (!errors || !errors.length) {
    elements.errorBanner.classList.add("hidden");
    elements.errorBanner.textContent = "";
    return;
  }
  elements.errorBanner.classList.remove("hidden");
  elements.errorBanner.textContent = `Some files could not be indexed: ${errors.slice(0, 3).join(" | ")}`;
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  if (!response.ok) {
    throw new Error(`Request failed with ${response.status}`);
  }
  return response.json();
}

async function fetchJsonDetailed(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let data = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = {};
    }
  }
  return { ok: response.ok, status: response.status, data };
}

async function fetchJsonDetailedWithRetry(url, options = {}, retries = 3, waitMs = 800) {
  let lastError = null;
  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      return await fetchJsonDetailed(url, options);
    } catch (error) {
      lastError = error;
      if (attempt + 1 >= retries) {
        throw error;
      }
      await sleep(waitMs);
    }
  }
  throw lastError || new Error("Request failed.");
}

function isImageSearchApiUnavailableResponse(response) {
  const status = Number(response?.status || 0);
  return status === 404 || status === 405 || status === 501;
}

function buildImageSearchApiUnavailableError(response) {
  const status = Number(response?.status || 0);
  return new Error(
    `The running Python server is missing the image search API (HTTP ${status}). Restart src/listing_search_server.py and reload this page.`
  );
}

function ensureImageSearchApiAvailable(response) {
  if (!isImageSearchApiUnavailableResponse(response)) {
    return response;
  }
  const error = buildImageSearchApiUnavailableError(response);
  setImageProgress({
    visible: true,
    ratio: 1,
    label: "Image search backend unavailable",
    numbers: "Restart src/listing_search_server.py",
  });
  setImageSearchStatus("Image search cannot run.", error.message);
  throw error;
}

async function imageFileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("Could not read image file."));
    reader.readAsDataURL(file);
  });
}

function updateImageSearchStatusFromServer(status) {
  if (!status || typeof status !== "object") {
    return;
  }
  state.imageIndexStatus = status;
  if (elements.reindexImagesButton) {
    elements.reindexImagesButton.disabled = Boolean(status.building);
  }

  if (status.error) {
    setImageProgress({ visible: true, ratio: 1, label: "Image index failed.", numbers: "" });
    setImageSearchStatus("Image search failed.", String(status.error));
    return;
  }

  const total = Number(status.total_images || 0);
  const processed = Number(status.processed_images || 0);
  const device = status.device ? String(status.device).toUpperCase() : "GPU";
  const message = String(status.message || "");

  if (status.stale) {
    setImageProgress({
      visible: true,
      ratio: status.ready ? 1 : 0,
      label: status.ready ? `Image index stale on ${device}` : "Image index waiting for manual reindex",
      numbers: "Click Reindex Images",
    });
    setImageSearchStatus(
      status.ready ? `Image index is stale on ${device}.` : "Image index is waiting for manual reindex.",
      message || "New images were added during collection. Click Reindex Images when you want to refresh visual search."
    );
    return;
  }

  if (status.ready) {
    setImageProgress({
      visible: true,
      ratio: 1,
      label: `Local image index ready on ${device}`,
      numbers: total ? `${formatNumber(total)} / ${formatNumber(total)}` : "",
    });
    setImageSearchStatus(
      `Image index ready on ${device}.`,
      message || `Indexed ${formatNumber(total)} local listing images.`
    );
    return;
  }

  if (status.building) {
    setImageProgress({
      visible: true,
      indeterminate: total <= 0,
      ratio: total > 0 ? processed / total : 0.18,
      label: message || `Building local image index on ${device}`,
      numbers: total > 0 ? `${formatNumber(processed)} / ${formatNumber(total)}` : device,
    });
    setImageSearchStatus(
      `Building ${device} image index...`,
      `${formatNumber(processed)} of ${formatNumber(total)} images processed. ${message}`.trim()
    );
    return;
  }

  state.imageIndexStatus = null;
  setImageProgress({ visible: false, ratio: 0, label: "", numbers: "" });
}

async function waitForImageSearchReady(runToken) {
  while (true) {
    const response = ensureImageSearchApiAvailable(
      await fetchJsonDetailedWithRetry("/api/image-search/status")
    );
    updateImageSearchStatusFromServer(response.data);
    if (runToken !== state.filterRunToken) {
      return null;
    }

    if (response.data?.error) {
      throw new Error(response.data.error);
    }

    if (!response.data?.building && !response.data?.ready && response.data?.manual_reindex_required) {
      throw new Error(response.data.message || "Image index is waiting for manual reindex.");
    }

    if (response.data?.ready) {
      return response.data;
    }

    await sleep(1000);
  }
}

function scheduleImageStatusPoll(delayMs = 1000) {
  window.clearTimeout(imageStatusPollTimer);
  imageStatusPollTimer = window.setTimeout(async () => {
    try {
      const response = ensureImageSearchApiAvailable(
        await fetchJsonDetailedWithRetry("/api/image-search/status")
      );
      updateImageSearchStatusFromServer(response.data);
      if (response.data?.building && !response.data?.ready) {
        scheduleImageStatusPoll(1000);
      }
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("missing the image search API")) {
        scheduleImageStatusPoll(2000);
      }
    }
  }, delayMs);
}

function scheduleDataStatusPoll(delayMs = 1000) {
  window.clearTimeout(dataStatusPollTimer);
  dataStatusPollTimer = window.setTimeout(async () => {
    try {
      await loadData({ polling: true });
    } catch {
      scheduleDataStatusPoll(1500);
    }
  }, delayMs);
}

function scheduleExchangeRatePoll(delayMs = 1500) {
  window.clearTimeout(exchangeRatePollTimer);
  exchangeRatePollTimer = window.setTimeout(async () => {
    try {
      await loadExchangeRates({ polling: true });
    } catch {
      scheduleExchangeRatePoll(2500);
    }
  }, delayMs);
}

async function loadExchangeRates({ polling = false } = {}) {
  const status = await fetchJson("/api/exchange-rates");
  const wasReady = Boolean(state.exchangeRates?.ready);
  state.exchangeRates = status;
  updateCurrencyLabels();
  if (elements.currencyFilter.value !== state.displayCurrency) {
    elements.currencyFilter.value = state.displayCurrency;
  }
  syncPriceInputsFromState();

  if (status.loading) {
    scheduleExchangeRatePoll(1500);
  } else {
    window.clearTimeout(exchangeRatePollTimer);
  }

  if (status.ready && (!wasReady || !polling)) {
    renderResults({ resetScroll: false });
    refreshIdleStatus();
  }
}

async function requestImageReindex() {
  const response = ensureImageSearchApiAvailable(
    await fetchJsonDetailedWithRetry("/api/image-search/reindex", {
      method: "POST",
    })
  );
  updateImageSearchStatusFromServer(response.data?.status);
  scheduleImageStatusPoll(700);
}

function queueStatusShouldPoll(status) {
  return Boolean(status?.busy || Number(status?.queue_length || 0) > 0);
}

function scheduleCrawlerQueuePoll(delayMs = 1800) {
  window.clearTimeout(crawlerQueuePollTimer);
  crawlerQueuePollTimer = window.setTimeout(async () => {
    try {
      await loadCrawlerQueueStatus({ polling: true });
    } catch {
      scheduleCrawlerQueuePoll(2500);
    }
  }, delayMs);
}

function setCrawlerQueueMessage(text) {
  elements.crawlerQueueMessage.textContent = text;
}

function formatQueueStatusLabel(status) {
  if (status === "running") {
    return "Running";
  }
  if (status === "completed") {
    return "Completed";
  }
  if (status === "error") {
    return "Error";
  }
  return "Queued";
}

function formatQueueProgressPhase(phase) {
  const labels = {
    queued: "Queued",
    opening: "Opening page",
    "resolving-store": "Finding store",
    "loading-store": "Loading store",
    ready: "Preparing collection",
    scraping: "Collecting",
    collecting: "Collecting",
    saving: "Saving",
    images: "Downloading images",
    completed: "Complete",
    error: "Stopped",
  };
  return labels[phase] || phase || "Working";
}

function renderQueueProgress(item) {
  const status = item.status || "queued";
  const phase = item.progress_phase || status;
  const current = Number(item.progress_current || 0);
  const total = Number(item.progress_total || 0);
  let percent = Number(item.progress_percent || 0);
  if (status === "completed") {
    percent = 100;
  }
  percent = Math.max(0, Math.min(100, Number.isFinite(percent) ? percent : 0));
  const indeterminate = status === "running" && percent <= 0;
  const width = indeterminate ? 35 : percent;
  const metaLeft = formatQueueProgressPhase(phase);
  let metaRight = "";
  if (total > 0) {
    metaRight = `${formatNumber(current)}/${formatNumber(total)}`;
  } else if ((phase === "scraping" || phase === "collecting") && current > 0) {
    metaRight = `Page ${formatNumber(current)}`;
  } else if (!indeterminate) {
    metaRight = `${Math.round(percent)}%`;
  }

  return `
    <div class="queue-progress ${indeterminate ? "indeterminate" : ""}" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(percent)}">
      <div class="queue-progress-bar">
        <div class="queue-progress-fill" style="width: ${width}%"></div>
      </div>
      <div class="queue-progress-meta">
        <span>${escapeHtml(metaLeft)}</span>
        <span>${escapeHtml(metaRight)}</span>
      </div>
    </div>
  `;
}

function renderCrawlerQueueStatus(status) {
  state.crawlerQueueStatus = status;
  const items = Array.isArray(status?.items) ? [...status.items].reverse() : [];
  elements.crawlerQueueStart.textContent = queueStatusShouldPoll(status) ? "Add More URLs" : "Add To Queue";

  if (!status?.enabled) {
    elements.crawlerQueueStatus.innerHTML = `
      <article class="queue-item">
        <div class="queue-item-title">Browser automation is not available.</div>
        <div class="queue-item-message">Install Brave Browser on this machine to enable the collection queue.</div>
      </article>
    `;
    setCrawlerQueueMessage("Queue unavailable on this machine.");
    return;
  }

  if (!items.length) {
    elements.crawlerQueueStatus.innerHTML = `
      <article class="queue-item">
        <div class="queue-item-title">Queue idle.</div>
        <div class="queue-item-message">Paste seller URLs above, then start the queue.</div>
      </article>
    `;
  } else {
    elements.crawlerQueueStatus.innerHTML = items
      .map((item) => {
        const cssStatus = escapeHtml(item.status || "queued");
        const metaBits = [];
        if (item.shop_name) {
          metaBits.push(`Shop: ${escapeHtml(item.shop_name)}`);
        }
        if (item.listing_count) {
          metaBits.push(`${formatNumber(item.listing_count)} listings`);
        }
        if (item.images_saved || item.images_failed) {
          metaBits.push(`Images ${formatNumber(item.images_saved || 0)} saved / ${formatNumber(item.images_failed || 0)} failed`);
        }
        if (item.retry_count) {
          metaBits.push(`Retry ${formatNumber(item.retry_count)}`);
        }
        if (item.finished_at) {
          metaBits.push(`Finished ${escapeHtml(formatTimestamp(item.finished_at))}`);
        }
        const canRetry = item.status === "error" || item.status === "completed";
        const retryLabel = item.status === "completed" ? "Requeue" : "Retry";
        return `
          <article class="queue-item">
            <div class="queue-item-top">
              <div class="queue-item-title">${escapeHtml(item.shop_name || item.url || "Queued shop")}</div>
              <span class="queue-item-status ${cssStatus}">${escapeHtml(formatQueueStatusLabel(item.status))}</span>
            </div>
            <div class="queue-item-url">${escapeHtml(item.url || "")}</div>
            <div class="queue-item-message">${escapeHtml(item.message || "")}</div>
            ${renderQueueProgress(item)}
            ${metaBits.length ? `<div class="queue-item-meta">${metaBits.join(" · ")}</div>` : ""}
            ${canRetry ? `<div class="queue-item-actions"><button type="button" class="secondary-button queue-retry-button" data-queue-retry="${escapeHtml(item.id || "")}">${retryLabel}</button></div>` : ""}
            ${item.error ? `<div class="queue-item-message">${escapeHtml(item.error)}</div>` : ""}
          </article>
        `;
      })
      .join("");
  }

  if (queueStatusShouldPoll(status)) {
    setCrawlerQueueMessage(
      status.busy
        ? "Queue running. You can paste more seller URLs and add them now."
        : "Queue updating..."
    );
    scheduleCrawlerQueuePoll(1800);
  } else {
    window.clearTimeout(crawlerQueuePollTimer);
    setCrawlerQueueMessage("Queue idle.");
  }

  const latestFinished = items
    .filter((item) => item.status === "completed" && item.finished_at)
    .map((item) => String(item.finished_at))
    .sort()
    .pop();
  if (latestFinished && latestFinished !== state.lastCrawlerRefreshAt) {
    state.lastCrawlerRefreshAt = latestFinished;
    loadData({ polling: true }).catch(() => {});
  }
}

async function loadCrawlerQueueStatus({ polling = false } = {}) {
  const status = await fetchJson("/api/crawler-queue/status");
  renderCrawlerQueueStatus(status);
  if (!polling && status?.last_error) {
    setCrawlerQueueMessage(status.last_error);
  }
}

async function retryCrawlerQueueItem(itemId) {
  const response = await fetchJson("/api/crawler-queue/retry", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ item_id: itemId }),
  });
  renderCrawlerQueueStatus(response.status || null);
  const queuedUrl = response.queued?.url ? ` ${response.queued.url}` : "";
  setCrawlerQueueMessage(`Queued retry.${queuedUrl}`);
}

async function recrawlShop(shop) {
  const url = state.shopUrls.get(shop) || "";
  if (!url) {
    throw new Error("No saved store link is available for this shop.");
  }
  const response = await fetchJson("/api/crawler-queue/enqueue", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ urls: [url], force: true }),
  });
  renderCrawlerQueueStatus(response.status || null);
  const queuedCount = response.queued?.length || 0;
  setShopPanelMessage(
    queuedCount
      ? `Queued full recrawl for ${shop}.`
      : `No recrawl was queued for ${shop}.`,
  );
  setCrawlerQueueMessage(`Queued full recrawl for ${shop}.`);
  scheduleCrawlerQueuePoll(900);
}

function updateCrawlerQueueLineNumbers() {
  const totalLines = Math.max(1, elements.crawlerQueueInput.value.split("\n").length);
  elements.crawlerQueueLineNumbers.textContent = Array.from({ length: totalLines }, (_, index) => String(index + 1)).join("\n");
  elements.crawlerQueueLineNumbers.scrollTop = elements.crawlerQueueInput.scrollTop;
}

function openCrawlerQueueModal() {
  elements.crawlerQueueModal.classList.remove("hidden");
  updateCrawlerQueueLineNumbers();
  loadCrawlerQueueStatus().catch(() => {});
  window.requestAnimationFrame(() => elements.crawlerQueueInput.focus());
}

function closeCrawlerQueueModal() {
  elements.crawlerQueueModal.classList.add("hidden");
}

async function startCrawlerQueue() {
  const urls = elements.crawlerQueueInput.value
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*\d+[\).\-\s]+/, "").trim())
    .filter(Boolean);

  if (!urls.length) {
    setCrawlerQueueMessage("Paste at least one product or shop URL first.");
    return;
  }

  setCrawlerQueueMessage(`Queueing ${urls.length} URL${urls.length === 1 ? "" : "s"}...`);
  const response = await fetchJson("/api/crawler-queue/enqueue", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ urls }),
  });
  elements.crawlerQueueInput.value = "";
  writeStoredValue(STORAGE_KEYS.crawlerQueueDraft, "");
  updateCrawlerQueueLineNumbers();
  renderCrawlerQueueStatus(response.status || null);
  setCrawlerQueueMessage(`Queued ${response.queued?.length || 0} URL${response.queued?.length === 1 ? "" : "s"}.`);
}

function refreshIdleStatus() {
  if (!state.meta) {
    return;
  }

  const fragments = [
    `Indexed ${formatNumber(state.meta.total_rows || 0)} listings from ${formatNumber(state.meta.total_sources || 0)} files at ${formatTimestamp(state.meta.generated_at)}.`,
    `${formatNumber(state.filteredRows.length)} current match${state.filteredRows.length === 1 ? "" : "es"}.`,
  ];

  if (state.imageQueryPreviewUrl) {
    fragments.push("Image ranking enabled.");
  }

  if (state.exchangeRates?.ready) {
    fragments.push(`Rates: Bank of Canada ${state.exchangeRates.source_date || ""}.`.trim());
  }

  state.idleStatusText = fragments.join(" ");
  setStatus(state.idleStatusText, false);
}

async function loadData({ reload = false, polling = false } = {}) {
  if (!polling) {
    setStatus(reload ? "Re-indexing collection folders..." : "Loading local listing index...", true);
  }
  if (reload) {
    await fetchJson("/api/reload");
  }

  const meta = await fetchJson("/api/data");
  state.meta = meta;
  if (Object.hasOwn(CURRENCY_INFO, meta.price_common_currency)) {
    state.priceBaseCurrency = meta.price_common_currency;
  }
  buildStats(meta);
  updateErrorBanner(meta.errors || []);

  if (meta.ready === false) {
    state.rows = [];
    refreshShopCounts(meta);
    refreshShopUrls(meta);
    state.filteredRows = [];
    state.renderedCount = 0;
    state.browseRows = [];
    state.browseTotalRows = 0;
    state.browsePreviewActive = false;
    if (Array.isArray(meta.shops) && meta.shops.length) {
      populateShopFilter(meta.shops);
    } else {
      renderShopPanel();
    }
    setStatus(meta.message || "Indexing current workspace in the background...", Boolean(meta.building !== false));
    if (!state.imageQueryPreviewUrl) {
      setImageSearchStatus(
        "Starting local listing search...",
        meta.message || "Scanning collection folders in the background."
      );
      setImageProgress({ visible: false, ratio: 0, label: "", numbers: "" });
    }
    renderResults({ resetScroll: true });
    if (meta.building !== false) {
      scheduleDataStatusPoll(900);
    }
    return;
  }

  window.clearTimeout(dataStatusPollTimer);
  IMAGE_SIGNATURE_CACHE.clear();
  state.rows = [];
  refreshShopCounts(meta);
  refreshShopUrls(meta);
  aiTextIndex = null;
  populateShopFilter(meta.shops || []);
  if (!state.query) {
    state.query = elements.searchInput.value || "";
  } else {
    elements.searchInput.value = state.query;
  }
  state.displayCurrency = elements.currencyFilter.value || state.displayCurrency;
  state.sort = elements.sortFilter.value || "match";
  syncShopSelectionAfterPreferences();
  state.minPrice = convertCurrencyToBase(parseNumberValue(elements.minPriceInput.value), state.displayCurrency);
  state.maxPrice = convertCurrencyToBase(parseNumberValue(elements.maxPriceInput.value), state.displayCurrency);
  state.hasImageOnly = Boolean(elements.hasImageFilter.checked);
  state.smartSearch = elements.smartSearchToggle ? Boolean(elements.smartSearchToggle.checked) : true;
  state.aiTextSearch = elements.aiTextSearchToggle ? Boolean(elements.aiTextSearchToggle.checked) : false;
  updateCurrencyLabels();
  syncPriceInputsFromState();
  try {
    const imageStatus = ensureImageSearchApiAvailable(
      await fetchJsonDetailedWithRetry("/api/image-search/status")
    );
    updateImageSearchStatusFromServer(imageStatus.data);
    if (imageStatus.data?.building && !imageStatus.data?.ready) {
      scheduleImageStatusPoll();
    }
  } catch (error) {
    state.imageIndexStatus = null;
    setImageSearchStatus("Image search unavailable.", error.message || String(error));
  }
  await applyFilters({ resetScroll: true });
}

function maybeLoadMore(event) {
  if (state.renderedCount < state.filteredRows.length) {
    renderMore();
    return;
  }

  loadMoreServerResults()
    .then((expanded) => {
      if (expanded) {
        renderMore();
      } else {
        elements.loadHint.textContent = "DEBUG: loadMoreServerResults returned false. State: " + JSON.stringify({
          loading: state.serverSearchLoadingMore,
          previewActive: state.browsePreviewActive,
          req: !!state.serverSearchRequest,
          len: state.filteredRows.length,
          total: state.browseTotalRows
        });
      }
    })
    .catch((error) => {
       elements.loadHint.textContent = "DEBUG ERROR: " + String(error);
    });
}

function revokeImagePreviewUrl() {
  if (state.imageQueryPreviewUrl && state.imageQueryPreviewUrl.startsWith("blob:")) {
    URL.revokeObjectURL(state.imageQueryPreviewUrl);
  }
}

function updateImageControls() {
  elements.clearImageButton.classList.toggle("hidden", !state.imageQueryPreviewUrl);
}

async function setQueryImage(file, label) {
  if (!file) {
    return;
  }

  revokeImagePreviewUrl();
  state.imageQueryFile = file;
  state.imageQueryLabel = label || file.name || "query image";
  state.imageQueryPreviewUrl = URL.createObjectURL(file);
  updateImageControls();
  setImageProgress({
    visible: true,
    indeterminate: true,
    ratio: 0.15,
    label: "Preparing local image search",
    numbers: state.imageQueryLabel,
  });
  setImageSearchStatus(
    `Reading ${state.imageQueryLabel}...`,
    "Preparing the query image and rescoring matching listings."
  );
  await applyFilters({ resetScroll: true });
}

async function clearQueryImage() {
  revokeImagePreviewUrl();
  state.imageQueryFile = null;
  state.imageQueryLabel = "";
  state.imageQueryPreviewUrl = "";
  updateImageControls();
  defaultImageSearchStatus();
  await applyFilters({ resetScroll: true });
}

function firstImageFile(fileList) {
  if (!fileList) {
    return null;
  }
  return [...fileList].find((file) => String(file.type || "").startsWith("image/")) || null;
}

function extensionFromMimeType(mimeType) {
  const normalized = String(mimeType || "").toLowerCase();
  if (normalized.includes("png")) {
    return "png";
  }
  if (normalized.includes("webp")) {
    return "webp";
  }
  if (normalized.includes("gif")) {
    return "gif";
  }
  return "jpg";
}

async function readClipboardImage() {
  if (!navigator.clipboard?.read) {
    throw new Error("Clipboard image reading is not available here. Press Ctrl+V in the search box instead.");
  }

  const items = await navigator.clipboard.read();
  for (const item of items) {
    const imageType = item.types.find((type) => type.startsWith("image/"));
    if (!imageType) {
      continue;
    }
    const blob = await item.getType(imageType);
    return new File([blob], `clipboard-search.${extensionFromMimeType(imageType)}`, { type: imageType });
  }

  throw new Error("No image was found in the clipboard.");
}

function extractClipboardImage(event) {
  const items = [...(event.clipboardData?.items || [])];
  for (const item of items) {
    if (!String(item.type || "").startsWith("image/")) {
      continue;
    }
    return item.getAsFile();
  }
  return null;
}

function onPriceInputChanged() {
  state.minPrice = convertCurrencyToBase(parseNumberValue(elements.minPriceInput.value), state.displayCurrency);
  state.maxPrice = convertCurrencyToBase(parseNumberValue(elements.maxPriceInput.value), state.displayCurrency);
  applyFilters({ resetScroll: true });
}

function commitSearchInput({ resetScroll = true } = {}) {
  state.query = currentSearchDraft();
  return applyFilters({ resetScroll });
}

elements.searchInput.addEventListener("input", () => {
  elements.searchButton.classList.toggle("primary-button", true);
});

elements.searchInput.addEventListener("keydown", (event) => {
  if (event.key !== "Enter") {
    return;
  }
  event.preventDefault();
  commitSearchInput({ resetScroll: true });
});

elements.searchButton.addEventListener("click", () => {
  commitSearchInput({ resetScroll: true });
});

elements.minPriceInput.addEventListener("input", onPriceInputChanged);
elements.maxPriceInput.addEventListener("input", onPriceInputChanged);

elements.currencyFilter.addEventListener("change", () => {
  state.displayCurrency = elements.currencyFilter.value || "cny";
  writeStoredValue(STORAGE_KEYS.displayCurrency, state.displayCurrency);
  updateCurrencyLabels();
  syncPriceInputsFromState();
  applyFilters({ resetScroll: true });
});

elements.shopMenuButton.addEventListener("click", openShopMenuModal);
elements.shopMenuClose.addEventListener("click", closeShopMenuModal);
elements.shopMenuBackdrop.addEventListener("click", closeShopMenuModal);

elements.shopPanelSearch.addEventListener("input", () => {
  state.shopSearch = elements.shopPanelSearch.value || "";
  renderShopPanel();
});

elements.clearShopViewButton.addEventListener("click", () => {
  state.shop = "all";
  renderShopPanel();
  applyFilters({ resetScroll: true });
});

elements.enableAllShopsButton.addEventListener("click", () => {
  state.disabledShops.clear();
  persistShopPreferences({ showError: true });
  populateShopFilter(state.shops);
  applyFilters({ resetScroll: true });
});

elements.disableAllShopsButton.addEventListener("click", () => {
  state.disabledShops = new Set(state.shops);
  persistShopPreferences({ showError: true });
  populateShopFilter(state.shops);
  applyFilters({ resetScroll: true });
});

elements.favoritesOnlyButton.addEventListener("click", () => {
  const favorites = state.shops.filter((shop) => state.shopFavorites.has(shop));
  if (!favorites.length) {
    return;
  }
  state.disabledShops = new Set(state.shops.filter((shop) => !state.shopFavorites.has(shop)));
  persistShopPreferences({ showError: true });
  populateShopFilter(state.shops);
  applyFilters({ resetScroll: true });
});

elements.shopList.addEventListener("change", (event) => {
  const target = event.target instanceof Element ? event.target : null;
  const checkbox = target?.closest("[data-shop-toggle]");
  if (!checkbox) {
    return;
  }
  const shop = checkbox.dataset.shopToggle || "";
  if (!shop) {
    return;
  }
  if (checkbox.checked) {
    state.disabledShops.delete(shop);
  } else {
    state.disabledShops.add(shop);
  }
  persistShopPreferences({ showError: true });
  populateShopFilter(state.shops);
  applyFilters({ resetScroll: true });
});

elements.shopList.addEventListener("click", (event) => {
  const target = event.target instanceof Element ? event.target : null;
  const favoriteButton = target?.closest("[data-shop-favorite]");
  const copyButton = target?.closest("[data-shop-copy]");
  const viewButton = target?.closest("[data-shop-view]");
  const recrawlButton = target?.closest("[data-shop-recrawl]");
  const deleteButton = target?.closest("[data-shop-delete]");
  if (!favoriteButton && !copyButton && !viewButton && !recrawlButton && !deleteButton) {
    return;
  }
  event.preventDefault();
  const shop =
    favoriteButton?.dataset.shopFavorite ||
    copyButton?.dataset.shopCopy ||
    viewButton?.dataset.shopView ||
    recrawlButton?.dataset.shopRecrawl ||
    deleteButton?.dataset.shopDelete ||
    "";
  if (!shop) {
    return;
  }
  if (recrawlButton) {
    recrawlShop(shop).catch((error) => setShopPanelMessage(error.message || String(error)));
    return;
  }
  if (deleteButton) {
    if (window.confirm(`Are you sure you want to permanently delete the shop "${shop}" and all its scraped data? This cannot be undone.`)) {
      setShopPanelMessage(`Deleting shop "${shop}"...`);
      fetchJson(`/api/shops/${encodeURIComponent(shop)}`, { method: "DELETE" })
        .then(() => {
          state.shops = state.shops.filter((s) => s !== shop);
          state.shopFavorites.delete(shop);
          state.disabledShops.delete(shop);
          if (state.shop === shop) state.shop = "all";
          renderShopPanel();
          elements.reloadButton.click();
        })
        .catch((err) => setShopPanelMessage(`Failed to delete shop: ${err.message}`));
    }
    return;
  }
  if (viewButton) {
    state.shop = state.shop === shop ? "all" : shop;
    renderShopPanel();
    applyFilters({ resetScroll: true });
    closeShopMenuModal();
    return;
  }
  if (copyButton) {
    const url = state.shopUrls.get(shop) || "";
    copyTextToClipboard(url)
      .then(() => setShopPanelMessage(`Copied store link for ${shop}.`))
      .catch((error) => setShopPanelMessage(error.message || String(error)));
    return;
  }
  if (state.shopFavorites.has(shop)) {
    state.shopFavorites.delete(shop);
  } else {
    state.shopFavorites.add(shop);
  }
  persistShopPreferences({ showError: true });
  populateShopFilter(state.shops);
});

elements.resultsGrid.addEventListener("click", (event) => {
  const target = event.target instanceof Element ? event.target : null;
  const link = target?.closest("a[data-open-external='browser']");
  if (!(link instanceof HTMLAnchorElement)) {
    return;
  }
  const url = link.href || "";
  if (!url) {
    return;
  }
  event.preventDefault();
  openExternalUrl(url).catch(() => {
    window.open(url, "_blank", "noopener,noreferrer");
  });
});

elements.sortFilter.addEventListener("change", () => {
  state.sort = elements.sortFilter.value;
  applyFilters({ resetScroll: true });
});

elements.hasImageFilter.addEventListener("change", () => {
  state.hasImageOnly = Boolean(elements.hasImageFilter.checked);
  applyFilters({ resetScroll: true });
});

if (elements.smartSearchToggle) {
  elements.smartSearchToggle.addEventListener("change", () => {
    state.smartSearch = Boolean(elements.smartSearchToggle.checked);
    applyFilters({ resetScroll: true });
  });
}

if (elements.aiTextSearchToggle) {
  elements.aiTextSearchToggle.addEventListener("change", () => {
    state.aiTextSearch = Boolean(elements.aiTextSearchToggle.checked);
    applyFilters({ resetScroll: true });
  });
}

elements.reloadButton.addEventListener("click", async () => {
  try {
    state.browseLimit = INITIAL_BROWSE_BATCH;
    await loadData({ reload: true });
  } catch (error) {
    setStatus(`Reload failed: ${error.message || error}`, false);
  }
});

elements.reindexImagesButton.addEventListener("click", async () => {
  try {
    await requestImageReindex();
  } catch (error) {
    setImageSearchStatus("Image reindex failed.", error.message || String(error));
  }
});

elements.browseMoreButton.addEventListener("click", () => {
  loadMoreServerResults()
    .then((expanded) => {
      if (expanded) {
        renderMore();
      }
    })
    .catch((error) => setImageSearchStatus("Loading more results failed.", error.message || String(error)));
});

const loadMoreObserver = new IntersectionObserver(
  (entries) => {
    if (entries[0].isIntersecting) {
      maybeLoadMore();
    }
  },
  {
    root: null,
    rootMargin: "420px",
  }
);
loadMoreObserver.observe(elements.resultsSentinel);
window.addEventListener("beforeunload", () => {
  beaconShopPreferencesToServer();
});

elements.uploadImageButton.addEventListener("click", () => {
  elements.imageUploadInput.click();
});

elements.searchInput.addEventListener("dragover", (event) => {
  if (!event.dataTransfer?.files?.length) {
    return;
  }
  event.preventDefault();
});

elements.searchInput.addEventListener("drop", async (event) => {
  const file = firstImageFile(event.dataTransfer?.files);
  if (!file) {
    return;
  }
  event.preventDefault();
  try {
    await setQueryImage(file, file.name || "dropped image");
  } catch (error) {
    setImageSearchStatus("Image search failed.", error.message || String(error));
  }
});

elements.searchInput.addEventListener("paste", async (event) => {
  const file = extractClipboardImage(event);
  if (!file) {
    return;
  }
  event.preventDefault();
  try {
    await setQueryImage(file, "clipboard image");
  } catch (error) {
    setImageSearchStatus("Image search failed.", error.message || String(error));
  }
});

elements.pasteImageButton.addEventListener("click", async () => {
  try {
    const file = await readClipboardImage();
    await setQueryImage(file, "clipboard image");
  } catch (error) {
    setImageSearchStatus("Clipboard paste failed.", error.message || String(error));
  }
});

elements.imageUploadInput.addEventListener("change", async () => {
  const file = firstImageFile(elements.imageUploadInput.files);
  if (!file) {
    return;
  }
  try {
    await setQueryImage(file, file.name || "selected image");
  } catch (error) {
    setImageSearchStatus("Image search failed.", error.message || String(error));
  }
  elements.imageUploadInput.value = "";
});

elements.clearImageButton.addEventListener("click", () => {
  clearQueryImage().catch((error) => {
    setImageSearchStatus("Image search failed.", error.message || String(error));
  });
});

elements.crawlerQueueButton.addEventListener("click", openCrawlerQueueModal);
elements.crawlerQueueClose.addEventListener("click", closeCrawlerQueueModal);
elements.crawlerQueueBackdrop.addEventListener("click", closeCrawlerQueueModal);
elements.crawlerQueueStart.addEventListener("click", () => {
  startCrawlerQueue().catch((error) => {
    setCrawlerQueueMessage(error.message || String(error));
  });
});
elements.crawlerQueueStatus.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) {
    return;
  }
  const button = target.closest("[data-queue-retry]");
  if (!(button instanceof HTMLElement)) {
    return;
  }
  const itemId = button.getAttribute("data-queue-retry") || "";
  if (!itemId) {
    return;
  }
  retryCrawlerQueueItem(itemId).catch((error) => {
    setCrawlerQueueMessage(error.message || String(error));
  });
});
elements.crawlerQueueInput.addEventListener("input", () => {
  writeStoredValue(STORAGE_KEYS.crawlerQueueDraft, elements.crawlerQueueInput.value);
  updateCrawlerQueueLineNumbers();
});
elements.crawlerQueueInput.addEventListener("scroll", updateCrawlerQueueLineNumbers);

document.addEventListener("paste", async (event) => {
  const active = document.activeElement;
  if (
    active instanceof HTMLElement &&
    (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.isContentEditable)
  ) {
    return;
  }
  const file = extractClipboardImage(event);
  if (!file) {
    return;
  }
  event.preventDefault();
  try {
    await setQueryImage(file, "clipboard image");
  } catch (error) {
    setImageSearchStatus("Image search failed.", error.message || String(error));
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !elements.shopMenuModal.classList.contains("hidden")) {
    closeShopMenuModal();
    return;
  }
  if (event.key === "Escape" && !elements.crawlerQueueModal.classList.contains("hidden")) {
    closeCrawlerQueueModal();
  }
});

async function startApp() {
  restoreUiPreferences();
  await loadShopPreferences();
  updateImageControls();
  defaultImageSearchStatus();
  updateCurrencyLabels();
  updateCrawlerQueueLineNumbers();
  loadExchangeRates().catch(() => {});
  loadCrawlerQueueStatus().catch(() => {});
  await loadData();
}

startApp().catch((error) => {
  setStatus(`Failed to load the search UI data: ${error.message || error}`, false);
});
