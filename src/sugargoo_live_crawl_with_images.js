async function runSugargooLiveCrawl(userConfig = {}) {
  /*
    Sugargoo shop crawler for live pages, with image support.

    Paste into DevTools Console while you are on the seller/shop page.

    This version is page-aware:
    - waits for listing content to actually change before moving on
    - only uses pagination/load-more controls, not unrelated tabs/buttons
    - backs off and retries when a rate-limit block is detected

    Output:
    - CSV with listing text + image URL + image file name
    - ZIP with CSV + downloaded images when possible
  */

  const RUN_STAMP = new Date().toISOString().replace(/[:.]/g, '-');

  const CONFIG = {
    scrollDelayMs: 250,
    stableRoundsNeeded: 1,
    maxScrollRoundsPerPage: 0,
    domQuietMs: 700,
    pageChangeTimeoutMs: 35000,
    nextClickChangeTimeoutMs: 8000,
    loadMoreChangeTimeoutMs: 12000,
    postClickSettleMs: 800,
    maxPagesToVisit: 2000,
    maxLoadMoreClicksPerPage: 50,
    maxAdvanceRetriesPerPage: 5,
    maxUnchangedNextClicksBeforeStop: 2,
    crawlSortModes: ['_coefp', '_sale', '_bid', 'bid'],
    crawlCategories: true,
    crawlCategorySortModes: ['_coefp', '_sale'],
    globalNonUniquePageLimit: 5,
    categoryNonUniquePageLimit: 3,
    maxCategoriesToCrawl: 200,
    rateLimitBaseWaitMs: 60_000,
    rateLimitMaxWaitMs: 20 * 60_000,
    rateLimitProbeMs: 5_000,
    clickLoadMore: false,
    checkpointEveryPages: 3,
    saveToFolderAsYouGo: true,
    storageRootFolderName: 'scraped data',
    folderName: `sugargoo_shop_${RUN_STAMP}`,
    downloadCsv: false,
    downloadImagesZip: true,
    csvFileName: `sugargoo_shop_${RUN_STAMP}.csv`,
    zipFileName: `sugargoo_shop_images_${RUN_STAMP}.zip`,
    ...userConfig,
  };

  const PRODUCT_SELECTOR = 'a.goods-item[href*="/products?productLink="]';
  const CANONICAL_PRICE_CURRENCY = 'cny';
  const DEFAULT_SOURCE_PRICE_CURRENCY = 'cny';
  const EXCHANGE_RATE_SERIES = {
    usd_to_cad: 'FXUSDCAD',
    cny_to_cad: 'FXCNYCAD',
  };
  const PRICE_NUMBER_RE = /-?\d+(?:\.\d+)?/;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();

  const isVisible = (el) => {
    if (!el) return false;
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
  };

  const sanitizeFilePart = (s, fallback = 'item') => {
    const out = clean(s)
      .replace(/[\\/:*?"<>|]/g, '_')
      .replace(/\s+/g, '_')
      .replace(/_+/g, '_')
      .slice(0, 80);
    return out || fallback;
  };

  const parsePriceValue = (priceText) => {
    const match = String(priceText || '').replace(/,/g, '').match(PRICE_NUMBER_RE);
    if (!match) return null;
    const value = Number(match[0]);
    return Number.isFinite(value) ? value : null;
  };

  const detectPriceCurrencyMarker = (priceText) => {
    const text = String(priceText || '');
    const upper = text.toUpperCase();
    if (upper.includes('CA$') || upper.includes('C$') || upper.includes('CAD')) return 'cad';
    if (text.includes('￥') || text.includes('¥') || upper.includes('CNY') || upper.includes('RMB')) return 'cny';
    if (upper.includes('US$') || upper.includes('USD')) return 'usd';
    if (text.includes('$')) return 'usd';
    return '';
  };

  const detectPriceCurrency = (priceText, fallback = '') => {
    const markerCurrency = detectPriceCurrencyMarker(priceText);
    if (markerCurrency) return markerCurrency;
    return fallback || DEFAULT_SOURCE_PRICE_CURRENCY;
  };

  const normalizeSourceCurrency = (priceText, currency = '') => {
    const explicitCurrency = ['usd', 'cad', 'cny'].includes(String(currency || '').toLowerCase())
      ? String(currency || '').toLowerCase()
      : '';
    if (!String(priceText || '').trim() && !explicitCurrency) return '';
    const markerCurrency = detectPriceCurrencyMarker(priceText);
    if (markerCurrency) return markerCurrency;
    return explicitCurrency || DEFAULT_SOURCE_PRICE_CURRENCY;
  };

  const formatPriceAmount = (value) => {
    const rounded = Number(value).toFixed(4);
    const [whole, fractionRaw = ''] = rounded.split('.');
    let fraction = fractionRaw.replace(/0+$/, '');
    if (fraction.length < 2) fraction = fraction.padEnd(2, '0');
    return `${whole}.${fraction}`;
  };

  const formatPriceText = (value, currency) => {
    const prefix = currency === 'cad' ? 'CA$' : currency === 'cny' ? '￥' : 'US$';
    return `${prefix}${formatPriceAmount(value)}`;
  };

  const fetchLatestSeriesValue = async (seriesName) => {
    const response = await fetch(`https://www.bankofcanada.ca/valet/observations/${seriesName}/json`, {
      headers: {
        Accept: 'application/json',
      },
    });
    if (!response.ok) {
      throw new Error(`Bank of Canada returned HTTP ${response.status} for ${seriesName}`);
    }
    const payload = await response.json();
    const observations = Array.isArray(payload?.observations) ? payload.observations : [];
    for (let index = observations.length - 1; index >= 0; index -= 1) {
      const observation = observations[index];
      const rawValue = observation?.[seriesName]?.v;
      if (rawValue === undefined || rawValue === null || rawValue === '') continue;
      const value = Number(rawValue);
      if (Number.isFinite(value) && value > 0) {
        return { value, date: String(observation?.d || '') };
      }
    }
    throw new Error(`No usable exchange-rate value returned for ${seriesName}`);
  };

  const loadExchangeRates = async () => {
    const [usdToCad, cnyToCad] = await Promise.all([
      fetchLatestSeriesValue(EXCHANGE_RATE_SERIES.usd_to_cad),
      fetchLatestSeriesValue(EXCHANGE_RATE_SERIES.cny_to_cad),
    ]);
    return {
      source: 'Bank of Canada',
      source_date: [usdToCad.date, cnyToCad.date].sort().slice(-1)[0] || '',
      usd_to_cad: usdToCad.value,
      cny_to_cad: cnyToCad.value,
    };
  };

  const convertCurrencyValue = (value, fromCurrency, toCurrency, rates) => {
    if (!Number.isFinite(value)) return null;
    if (!fromCurrency || !toCurrency || !rates) return null;
    if (fromCurrency === toCurrency) return value;

    let valueInCad = null;
    if (fromCurrency === 'cad') valueInCad = value;
    if (fromCurrency === 'usd') valueInCad = value * rates.usd_to_cad;
    if (fromCurrency === 'cny') valueInCad = value * rates.cny_to_cad;
    if (!Number.isFinite(valueInCad)) return null;

    if (toCurrency === 'cad') return valueInCad;
    if (toCurrency === 'usd') return valueInCad / rates.usd_to_cad;
    if (toCurrency === 'cny') return valueInCad / rates.cny_to_cad;
    return null;
  };

  const normalizePriceRow = (row, rates) => {
    const sourceText = clean(row.price_original || row.price || '');
    const sourceCurrency = normalizeSourceCurrency(sourceText, row.price_original_currency);
    const explicitSourceValue = Number(row.price_original_value);
    const sourceValue = Number.isFinite(explicitSourceValue) ? explicitSourceValue : parsePriceValue(sourceText);
    const normalized = {
      ...row,
      price_original: sourceText,
      price_original_currency: sourceCurrency,
      price_original_value: sourceValue,
    };

    const canonicalValue = convertCurrencyValue(sourceValue, sourceCurrency || CANONICAL_PRICE_CURRENCY, CANONICAL_PRICE_CURRENCY, rates);
    if (Number.isFinite(canonicalValue)) {
      normalized.price = formatPriceText(canonicalValue, CANONICAL_PRICE_CURRENCY);
      normalized.price_currency = CANONICAL_PRICE_CURRENCY;
      normalized.price_value = Number(canonicalValue.toFixed(6));
    } else {
      normalized.price_currency = sourceCurrency || '';
      normalized.price_value = Number.isFinite(sourceValue) ? sourceValue : '';
    }

    if (rates?.source) normalized.price_exchange_source = rates.source;
    if (rates?.source_date) normalized.price_exchange_date = rates.source_date;
    return normalized;
  };

  const decodeRepeatedly = (value) => {
    let prev = null;
    let cur = value || '';
    while (cur && cur !== prev && cur.includes('%')) {
      prev = cur;
      try {
        cur = decodeURIComponent(cur);
      } catch {
        break;
      }
    }
    return cur;
  };

  const decodeSourceUrl = (href) => {
    try {
      const url = new URL(href, location.href);
      const productLink = url.searchParams.get('productLink') || '';
      return decodeRepeatedly(productLink);
    } catch {
      return '';
    }
  };

  const getOfferId = (href, decodedSourceUrl) => {
    const joined = `${href || ''} ${decodedSourceUrl || ''}`;
    const match =
      joined.match(/offer\/(\d+)\.html/i) ||
      joined.match(/offerId=(\d+)/i) ||
      joined.match(/item\.taobao\.com\/item\.htm\?[^#\s]*\bid=(\d+)/i) ||
      joined.match(/[?&]id=(\d+)/i);
    return match ? match[1] : '';
  };

  const getShopRoot = () => document.querySelector('.shop-products') || document.body;

  const getScrollableTargets = () => {
    const root = getShopRoot();
    const targets = new Set([window]);
    for (const el of [root, ...root.querySelectorAll('*')]) {
      const style = getComputedStyle(el);
      const overflowY = style.overflowY || '';
      if ((overflowY.includes('auto') || overflowY.includes('scroll')) && el.scrollHeight > el.clientHeight + 40) {
        targets.add(el);
      }
    }
    return [...targets];
  };

  const scrollTargetsToEnd = () => {
    for (const target of getScrollableTargets()) {
      if (target === window) {
        window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' });
      } else {
        target.scrollTo({ top: target.scrollHeight, behavior: 'smooth' });
      }
    }
  };

  const pickImageUrl = (card) => {
    const img = card.querySelector('img');
    if (img) {
      const candidates = [
        img.currentSrc,
        img.src,
        img.getAttribute('src'),
        img.getAttribute('data-src'),
        img.getAttribute('data-original'),
        img.getAttribute('data-lazy-src'),
      ].filter(Boolean);

      const srcset = img.getAttribute('srcset') || img.getAttribute('data-srcset') || '';
      if (srcset) {
        const firstSrcsetUrl = srcset.split(',').map((x) => x.trim().split(/\s+/)[0]).find(Boolean);
        if (firstSrcsetUrl) candidates.push(firstSrcsetUrl);
      }

      const best = candidates.find(Boolean);
      if (best) return best;
    }

    const imgWrap = card.querySelector('.img-wrap, [class*="img"]');
    if (imgWrap) {
      const bg = getComputedStyle(imgWrap).backgroundImage || '';
      const m = bg.match(/url\(["']?(.*?)["']?\)/i);
      if (m && m[1]) return m[1];
    }

    return '';
  };

  const extensionFromMime = (mime) => {
    const m = String(mime || '').toLowerCase();
    if (m.includes('jpeg') || m.includes('jpg')) return 'jpg';
    if (m.includes('png')) return 'png';
    if (m.includes('webp')) return 'webp';
    if (m.includes('gif')) return 'gif';
    if (m.includes('bmp')) return 'bmp';
    if (m.includes('svg')) return 'svg';
    return 'bin';
  };

  const extensionFromUrl = (url) => {
    if (!url) return 'bin';
    if (url.startsWith('data:')) {
      const m = url.match(/^data:([^;,]+)[;,]/i);
      return extensionFromMime(m?.[1] || '');
    }
    try {
      const u = new URL(url, location.href);
      const m = u.pathname.match(/\.([a-zA-Z0-9]{2,5})$/);
      return m ? m[1].toLowerCase() : 'jpg';
    } catch {
      return 'jpg';
    }
  };

  const dataUrlToUint8Array = (dataUrl) => {
    const [meta, body] = dataUrl.split(',', 2);
    const isBase64 = /;base64/i.test(meta);
    const binary = isBase64 ? atob(body) : decodeURIComponent(body);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  };

  const rowKeyFor = (row) => row.offer_id || row.source_url || row.source_1688_url || row.sugargoo_url || row.title;

  const sourceUrlForApiRecord = (record) => clean(record.detailUrl || record.sourceUrl || record.url || '');

  const priceTextForApiRecord = (record) => {
    const rawPriceText = String(record.promotionPrice || record.price || '').trim();
    if (!rawPriceText) return '';
    const rawValue = parsePriceValue(rawPriceText);
    if (!Number.isFinite(rawValue)) return rawPriceText;
    const markerCurrency = detectPriceCurrencyMarker(rawPriceText);
    
    let finalValue = rawValue;
    let currency = markerCurrency || normalizeSourceCurrency(rawPriceText);
    if (!markerCurrency && rawValue > 0) {
      finalValue = rawValue / 100;
      currency = 'cny';
    }
    
    return formatPriceText(finalValue, currency);
  };

  const rowFromApiRecord = (record) => {
    const sourceUrl = sourceUrlForApiRecord(record);
    const offerId = clean(record.numIid || record.itemId || record.offerId || getOfferId('', sourceUrl));
    const title = clean(record.title || record.subject || record.name || '');
    const imageUrl = clean(record.picUrl || record.imageUrl || record.imgUrl || record.pictureUrl || '');
    const imageExt = extensionFromUrl(imageUrl);
    const imageFile = `${sanitizeFilePart(offerId || title || 'item')}.${imageExt}`;
    const price = priceTextForApiRecord(record);
    return {
      offer_id: offerId,
      title,
      price,
      price_currency: normalizeSourceCurrency(price),
      price_value: parsePriceValue(price),
      price_original: price,
      price_original_currency: normalizeSourceCurrency(price),
      price_original_value: parsePriceValue(price),
      sales: clean(record.sales || record.saleCount || record.sold || ''),
      sugargoo_url: sourceUrl ? `https://www.sugargoo.com/products?productLink=${encodeURIComponent(encodeURIComponent(sourceUrl))}` : '',
      source_url: sourceUrl,
      source_1688_url: sourceUrl,
      image_url: imageUrl,
      image_file: imageFile,
    };
  };

  const isGenericShopName = (value) => {
    const text = clean(value).toLowerCase();
    if (!text) return true;
    return (
      text === 'sugargoo' ||
      text === 'sugargoo shop' ||
      /^sugargoo shop \d{4}-\d{2}-\d{2}t/i.test(text) ||
      text === 'shop'
    );
  };

  const chooseBetterShopName = (currentValue, nextValue) => {
    const current = clean(currentValue);
    const next = clean(nextValue);
    if (!next) return current;
    if (!current) return next;
    const currentGeneric = isGenericShopName(current);
    const nextGeneric = isGenericShopName(next);
    if (currentGeneric && !nextGeneric) return next;
    if (!currentGeneric && nextGeneric) return current;
    return next.length > current.length ? next : current;
  };

  const deriveShopName = ({ includeFallback = true } = {}) => {
    const selectors = [
      '.shop-info h1',
      '.shop-info h2',
      '.shop-info .name',
      '.shop-name',
      '[class*="shop"] h1',
      '[class*="shop"] h2',
      '[data-testid="shop-name"]',
    ];

    for (const selector of selectors) {
      const value = clean(document.querySelector(selector)?.textContent || '');
      if (value) {
        return value;
      }
    }

    const titleText = clean(document.title)
      .replace(/\s*[-|]\s*sugargoo.*$/i, '')
      .replace(/\s*[-|]\s*shop.*$/i, '')
      .trim();
    if (titleText) {
      return titleText;
    }

    try {
      const url = new URL(location.href);
      const slug = clean(url.pathname.split('/').filter(Boolean).pop() || '');
      if (slug) {
        return slug.replace(/[-_]+/g, ' ');
      }
    } catch {}

    if (!includeFallback) {
      return '';
    }

    return `Sugargoo Shop ${RUN_STAMP}`;
  };

  const scrapeCards = () => {
    const cards = [...document.querySelectorAll(PRODUCT_SELECTOR)];
    return cards.map((card) => {
      const href = card.href || card.getAttribute('href') || '';
      const decodedSourceUrl = decodeSourceUrl(href);
      const title = clean(card.querySelector('.title')?.innerText) || clean(card.innerText.split('\n')[0]);
      const price = clean(card.querySelector('.price')?.innerText);
      const sales = clean(card.querySelector('.num')?.innerText);
      const offerId = getOfferId(href, decodedSourceUrl);
      const imageUrl = pickImageUrl(card);
      const imageExt = extensionFromUrl(imageUrl);
      const imageFile = `${sanitizeFilePart(offerId || title || 'item')}.${imageExt}`;
      return {
        offer_id: offerId,
        title,
        price,
        price_currency: normalizeSourceCurrency(price),
        price_value: parsePriceValue(price),
        price_original: price,
        price_original_currency: normalizeSourceCurrency(price),
        price_original_value: parsePriceValue(price),
        sales,
        sugargoo_url: href,
        source_url: decodedSourceUrl,
        source_1688_url: decodedSourceUrl,
        image_url: imageUrl,
        image_file: imageFile,
      };
    });
  };

  const getVisibleListingSnapshot = () => {
    const rows = scrapeCards();
    const keys = rows.map(rowKeyFor).filter(Boolean);
    return {
      rows,
      count: rows.length,
      firstKey: keys[0] || '',
      lastKey: keys[keys.length - 1] || '',
      signature: JSON.stringify({
        count: rows.length,
        firstKey: keys[0] || '',
        lastKey: keys[keys.length - 1] || '',
        sample: keys.slice(0, 8),
      }),
      scrollHeight: document.documentElement.scrollHeight,
    };
  };

  const rowsByKey = new Map();
  const savedImageFiles = new Set();
  const failedImageFiles = new Set();
  const runtimeState = {
    status: 'starting',
    startedAt: new Date().toISOString(),
    finishedAt: '',
    shopName: '',
    pagesVisited: 0,
    uniqueRows: 0,
    lastPageLabel: '',
    lastCheckpointPage: 0,
    exportRevision: 0,
    message: 'Starting scrape.',
    completionReason: '',
    stoppedEarly: false,
    paginationDebug: null,
  };
  const saveTarget = {
    enabled: false,
    runDirHandle: null,
    imagesDirHandle: null,
  };

  window.__SUGARGOO_CRAWLER_RUNTIME = runtimeState;

  const exportRowsSnapshot = () => [...rowsByKey.values()].sort((a, b) => {
    const aa = a.offer_id || a.title;
    const bb = b.offer_id || b.title;
    return String(aa).localeCompare(String(bb));
  });
  window.__SUGARGOO_CRAWLER_EXPORT_ROWS = () => exportRowsSnapshot();

  const updateRuntimeState = (fields = {}, { bumpRevision = false } = {}) => {
    Object.assign(runtimeState, fields);
    runtimeState.shopName = chooseBetterShopName(runtimeState.shopName, deriveShopName({ includeFallback: false }));
    runtimeState.uniqueRows = rowsByKey.size;
    runtimeState.lastPageLabel = getActivePageLabel() || runtimeState.lastPageLabel || '';
    if (bumpRevision) {
      runtimeState.exportRevision += 1;
    }
    window.__SUGARGOO_CRAWLER_RUNTIME = { ...runtimeState };
  };

  const rememberRows = () => {
    let added = 0;
    for (const row of scrapeCards()) {
      const key = rowKeyFor(row);
      if (!key) continue;
      const existing = rowsByKey.get(key) || {};
      if (!rowsByKey.has(key)) added += 1;
      rowsByKey.set(key, {
        ...existing,
        ...row,
        image_url: row.image_url || existing.image_url || '',
        image_file: row.image_file || existing.image_file || '',
      });
    }
    runtimeState.uniqueRows = rowsByKey.size;
    return added;
  };

  const rememberApiRecords = (records) => {
    if (!Array.isArray(records) || !records.length) return 0;
    let added = 0;
    for (const record of records) {
      if (!record || typeof record !== 'object') continue;
      const row = rowFromApiRecord(record);
      const key = rowKeyFor(row);
      if (!key) continue;
      const existing = rowsByKey.get(key) || {};
      if (!rowsByKey.has(key)) added += 1;
      rowsByKey.set(key, {
        ...existing,
        ...row,
        image_url: row.image_url || existing.image_url || '',
        image_file: row.image_file || existing.image_file || '',
      });
    }
    runtimeState.uniqueRows = rowsByKey.size;
    return added;
  };

  const rememberShopItemPayload = (payload) => {
    const records = payload?.data?.records;
    const added = rememberApiRecords(records);
    if (Array.isArray(records) && records.length) {
      const current = payload?.data?.current || '?';
      const total = payload?.data?.total || '?';
      console.log(`[api] captured ${records.length} records from shop API page ${current}; +${added} unique, total_unique=${rowsByKey.size}, reported_total=${total}`);
    }
  };

  const networkState = {
    activeRequests: 0,
    lastActivityAt: Date.now(),
    lastRateLimitAt: 0,
    sawRateLimit: false,
  };
  const shopItemNetworkState = {
    lastUrl: '',
    lastBody: null,
    lastOrderType: '',
    lastHeaders: {},
    requestClientPromise: null,
  };

  let domLastChangedAt = Date.now();

  const markDomActivity = () => {
    domLastChangedAt = Date.now();
  };

  const markNetworkActivity = () => {
    networkState.lastActivityAt = Date.now();
  };

  const headersToPlainObject = (headers) => {
    const out = {};
    if (!headers) return out;

    try {
      if (typeof Headers !== 'undefined' && headers instanceof Headers) {
        headers.forEach((value, key) => {
          out[String(key).toLowerCase()] = String(value);
        });
        return out;
      }
    } catch {}

    if (Array.isArray(headers)) {
      for (const pair of headers) {
        if (!Array.isArray(pair) || pair.length < 2) continue;
        out[String(pair[0]).toLowerCase()] = String(pair[1]);
      }
      return out;
    }

    if (typeof headers === 'object') {
      for (const [key, value] of Object.entries(headers)) {
        if (value === undefined || value === null) continue;
        out[String(key).toLowerCase()] = String(value);
      }
    }
    return out;
  };

  const mergeHeaders = (...headerSets) => Object.assign({}, ...headerSets.map(headersToPlainObject));

  const rememberShopItemRequest = (url, body, headers = {}) => {
    if (!String(url || '').includes('/api/datacenter/shop/anno/shopItem/page')) return;
    try {
      const parsed = typeof body === 'string' ? JSON.parse(body || '{}') : body;
      shopItemNetworkState.lastUrl = String(url || '');
      shopItemNetworkState.lastBody = parsed && typeof parsed === 'object' ? parsed : null;
      shopItemNetworkState.lastOrderType = clean(parsed?.model?.orderType || '');
      shopItemNetworkState.lastHeaders = {
        ...shopItemNetworkState.lastHeaders,
        ...headersToPlainObject(headers),
      };
    } catch {
      shopItemNetworkState.lastUrl = String(url || '');
      shopItemNetworkState.lastHeaders = {
        ...shopItemNetworkState.lastHeaders,
        ...headersToPlainObject(headers),
      };
    }
  };

  const shouldTreatAsRateLimitStatus = (status, url = '') => {
    if (status === 429) return true;
    if (status !== 403) return false;
    try {
      const parsed = new URL(url, location.href);
      if (/\.(?:png|jpe?g|gif|webp|svg|bmp)(?:$|\?)/i.test(parsed.pathname)) return false;
      return parsed.origin === location.origin || /sugargoo/i.test(parsed.hostname);
    } catch {
      return false;
    }
  };

  const recordNetworkStatus = (status, url) => {
    markNetworkActivity();
    if (shouldTreatAsRateLimitStatus(status, url)) {
      networkState.sawRateLimit = true;
      networkState.lastRateLimitAt = Date.now();
      console.warn(`[rate-limit] network response ${status}${url ? ` for ${url}` : ''}`);
    }
  };

  const installNetworkMonitors = () => {
    if (!window.__sugargooCrawlerFetchPatched) {
      const originalFetch = window.fetch.bind(window);
      window.fetch = async (...args) => {
        networkState.activeRequests += 1;
        markNetworkActivity();
        try {
          const requestUrl = args[0]?.url || args[0];
          const requestHeaders = mergeHeaders(args[0]?.headers, args[1]?.headers);
          rememberShopItemRequest(requestUrl, args[1]?.body, requestHeaders);
          const response = await originalFetch(...args);
          recordNetworkStatus(response.status, response.url || String(args[0] || ''));
          if ((response.url || '').includes('/api/datacenter/shop/anno/shopItem/page')) {
            response.clone().json().then(rememberShopItemPayload).catch(() => {});
          }
          return response;
        } catch (err) {
          markNetworkActivity();
          throw err;
        } finally {
          networkState.activeRequests = Math.max(0, networkState.activeRequests - 1);
          markNetworkActivity();
        }
      };
      window.__sugargooCrawlerFetchPatched = true;
    }

    if (!window.__sugargooCrawlerXhrPatched) {
      const originalOpen = XMLHttpRequest.prototype.open;
      const originalSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
      const originalSend = XMLHttpRequest.prototype.send;

      XMLHttpRequest.prototype.open = function (...args) {
        this.__sugargooCrawlerUrl = args[1];
        this.__sugargooCrawlerHeaders = {};
        return originalOpen.apply(this, args);
      };

      XMLHttpRequest.prototype.setRequestHeader = function (...args) {
        const [name, value] = args;
        if (!this.__sugargooCrawlerHeaders) this.__sugargooCrawlerHeaders = {};
        this.__sugargooCrawlerHeaders[String(name || '').toLowerCase()] = String(value ?? '');
        return originalSetRequestHeader.apply(this, args);
      };

      XMLHttpRequest.prototype.send = function (...args) {
        networkState.activeRequests += 1;
        markNetworkActivity();
        rememberShopItemRequest(this.__sugargooCrawlerUrl || '', args[0], this.__sugargooCrawlerHeaders || {});
        this.addEventListener('loadend', () => {
          recordNetworkStatus(this.status, this.responseURL || this.__sugargooCrawlerUrl || '');
          if (String(this.responseURL || this.__sugargooCrawlerUrl || '').includes('/api/datacenter/shop/anno/shopItem/page')) {
            try {
              rememberShopItemPayload(JSON.parse(this.responseText || '{}'));
            } catch {}
          }
          networkState.activeRequests = Math.max(0, networkState.activeRequests - 1);
          markNetworkActivity();
        }, { once: true });
        return originalSend.apply(this, args);
      };

      window.__sugargooCrawlerXhrPatched = true;
    }
  };

  const installDomMonitor = () => {
    const root = getShopRoot();
    const observer = new MutationObserver(() => markDomActivity());
    observer.observe(root, { childList: true, subtree: true, characterData: true, attributes: true });
    return observer;
  };

  const waitForDomAndNetworkToSettle = async (timeoutMs = CONFIG.pageChangeTimeoutMs) => {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const domQuiet = Date.now() - domLastChangedAt >= CONFIG.domQuietMs;
      const networkQuiet = networkState.activeRequests === 0 && Date.now() - networkState.lastActivityAt >= 400;
      if (domQuiet && networkQuiet) return true;
      await sleep(250);
    }
    return false;
  };

  const getActivePageLabel = () => {
    const el = document.querySelector(
      '.ant-pagination-item-active, [aria-current="page"], .pagination-item.active, .page-item.active, .pager-item-active',
    );
    return clean(el?.innerText);
  };

  const getRateLimitText = () => {
    const selectors = [
      '.ant-message',
      '.ant-notification',
      '.ant-modal',
      '.ant-modal-root',
      '.van-toast',
      '[role="alert"]',
      '[class*="captcha"]',
      '[class*="verify"]',
      'iframe[src*="captcha"]',
    ];

    const texts = [];
    for (const el of document.querySelectorAll(selectors.join(','))) {
      if (!isVisible(el)) continue;
      const text = clean(el.innerText || el.textContent || '');
      if (text) texts.push(text);
      const src = el.getAttribute?.('src');
      if (src) texts.push(src);
    }

    const combined = clean(texts.join(' | '));
    const patterns = [
      /too\s+many\s+requests/i,
      /rate\s*limit/i,
      /try\s+again\s+later/i,
      /request\s+too\s+frequent/i,
      /too\s+frequent/i,
      /access\s+denied/i,
      /robot/i,
      /captcha/i,
      /verify/i,
      /system\s+busy/i,
      /频繁/,
      /稍后再试/,
      /验证码/,
      /验证/,
      /风控/,
      /访问受限/,
    ];

    return patterns.find((pattern) => pattern.test(combined)) ? combined : '';
  };

  const detectRateLimitState = () => {
    const text = getRateLimitText();
    const recentNetworkSignal = networkState.lastRateLimitAt && (Date.now() - networkState.lastRateLimitAt < 2 * 60_000);
    return {
      active: Boolean(text || recentNetworkSignal),
      reason: text || (recentNetworkSignal ? 'recent HTTP 429/403 signal' : ''),
    };
  };

  const listControlCandidates = () => {
    const root = getShopRoot();
    return [...root.querySelectorAll('button, a, div[role="button"], span, li')]
      .filter(isVisible)
      .filter((el) => !el.closest(PRODUCT_SELECTOR))
      .filter((el) => !el.closest('.menu-bar, .ant-tabs, [role="tablist"], #driver-search, .search, .shop-info'));
  };

  const isDisabledControl = (el) => {
    if (!el) return true;
    if (el.disabled) return true;
    if (el.getAttribute('aria-disabled') === 'true') return true;
    const className = String(el.className || '');
    return /\bdisabled\b|\bant-pagination-disabled\b|\bis-disabled\b/i.test(className);
  };

  const getControlIconHint = (el) => clean(
    el?.querySelector?.('[aria-label]')?.getAttribute('aria-label') ||
    el?.querySelector?.('svg[data-icon]')?.getAttribute('data-icon') ||
    '',
  ).toLowerCase();

  const getNextPageButton = () => {
    const strongSelectors = [
      '.ant-pagination-next',
      '.pagination-next',
      '.pager-next',
      'button[rel="next"]',
      'a[rel="next"]',
      '[aria-label*="next" i]',
    ];

    for (const selector of strongSelectors) {
      const hit = [...document.querySelectorAll(selector)].find((el) => isVisible(el) && !isDisabledControl(el));
      if (hit) return hit;
    }

    const iconHits = [
      ...document.querySelectorAll('.anticon-right, [aria-label="right"], svg[data-icon="right"]'),
    ]
      .map((el) => el.closest('button, a, div[role="button"], span, li'))
      .filter(Boolean)
      .filter((el, index, arr) => arr.indexOf(el) === index)
      .filter((el) => isVisible(el) && !isDisabledControl(el))
      .filter((el) => !el.closest(PRODUCT_SELECTOR))
      .filter((el) => !el.closest('.menu-bar, .ant-tabs, [role="tablist"], #driver-search, .search, .shop-info'));

    if (iconHits.length > 0) {
      return iconHits[0];
    }

    const wanted = [
      /^next$/i,
      /^next\s*page$/i,
      /^>\s*$/i,
      /^›$/,
      /^»$/,
      /next/i,
      /下一页/,
      /下页/,
      /后页/,
    ];

    const textMatch = listControlCandidates()
      .filter((el) => !isDisabledControl(el))
      .find((el) => {
        const text = clean(el.innerText || el.getAttribute('aria-label') || '');
        return text && wanted.some((rx) => rx.test(text));
      });

    if (textMatch) return textMatch;

    return listControlCandidates()
      .filter((el) => !isDisabledControl(el))
      .find((el) => {
        const iconHint = getControlIconHint(el);
        return iconHint === 'right';
      }) || null;
  };

  const getLoadMoreButton = () => {
    const wanted = [
      /load\s*more/i,
      /^more$/i,
      /show\s*more/i,
      /更多/,
      /加载更多/,
      /继续/,
      /展开/,
    ];

    return listControlCandidates()
      .filter((el) => !isDisabledControl(el))
      .find((el) => {
        const text = clean(el.innerText || el.getAttribute('aria-label') || '');
        return text && wanted.some((rx) => rx.test(text));
      }) || null;
  };

  const clickableControlFor = (el) => el?.closest?.('button, a, li, div[role="button"], span') || el || null;

  const getNumericNextPageButton = (currentPageLabel) => {
    const match = clean(currentPageLabel).match(/\d+/);
    const currentPage = match ? Number(match[0]) : NaN;
    if (!Number.isFinite(currentPage)) return null;
    const wanted = String(currentPage + 1);

    return listControlCandidates()
      .map((el) => clickableControlFor(el))
      .filter(Boolean)
      .filter((el, index, arr) => arr.indexOf(el) === index)
      .filter((el) => !isDisabledControl(el))
      .find((el) => clean(el.innerText || el.getAttribute('aria-label') || '') === wanted) || null;
  };

  const getPaginationDebugInfo = () => {
    const candidates = listControlCandidates()
      .map((el) => ({
        text: clean(el.innerText || el.getAttribute('aria-label') || ''),
        tag: el.tagName,
        className: String(el.className || ''),
        ariaLabel: el.getAttribute('aria-label') || '',
        iconHint: getControlIconHint(el),
        disabled: isDisabledControl(el),
      }))
      .filter((item) => item.text || item.iconHint)
      .filter((item) => (item.text || item.iconHint).length <= 40)
      .slice(0, 25);

    return {
      activePage: getActivePageLabel() || null,
      nextFound: Boolean(getNextPageButton()),
      loadMoreFound: Boolean(getLoadMoreButton()),
      candidates,
    };
  };

  const clickElement = (el) => {
    if (!el) return false;
    el.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true, view: window }));
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
    el.click();
    markDomActivity();
    markNetworkActivity();
    return true;
  };

  const visibleCurrencyItems = () => [
    ...document.querySelectorAll('.currency__item, [class*="currency"] .option, [class*="currency"] [role="option"], [role="option"]'),
  ]
    .filter(isVisible)
    .map((el) => clickableControlFor(el) || el)
    .filter((el, index, arr) => arr.indexOf(el) === index)
    .map((el) => ({
      el,
      text: clean(el.innerText || el.textContent || el.getAttribute('aria-label') || '').toUpperCase(),
      active: /\bactive\b|\bselected\b|\bchecked\b/i.test(String(el.className || '')) ||
        /\bactive\b|\bselected\b|\bchecked\b/i.test(String(el.parentElement?.className || '')),
    }))
    .filter((item) => item.text);

  const currentCurrencyCode = () => {
    const active = visibleCurrencyItems().find((item) => item.active && /\b(CNY|CAD|USD)\b/.test(item.text));
    return active?.text.match(/\b(CNY|CAD|USD)\b/)?.[1] || '';
  };

  const findCurrencyOption = (code) => visibleCurrencyItems()
    .find((item) => new RegExp(`\\b${code}\\b`, 'i').test(item.text))?.el || null;

  const findCurrencyTrigger = () => {
    const active = visibleCurrencyItems().find((item) => item.active && /\b(CNY|CAD|USD)\b/.test(item.text));
    if (active) return active.el;
    return [...document.querySelectorAll('[class*="currency"], [aria-label*="currency" i], [class*="header"]')]
      .filter(isVisible)
      .map((el) => clickableControlFor(el) || el)
      .find((el) => /\b(CNY|CAD|USD)\b/i.test(clean(el.innerText || el.textContent || el.getAttribute('aria-label') || ''))) || null;
  };

  const ensureCnyCurrency = async () => {
    try {
      const codes = ['currency', 'user_currency', 'lang_currency', 'currencyCode', 'STORE_CURRENCY'];
      codes.forEach((c) => window.localStorage.setItem(c, 'CNY'));
      codes.forEach((c) => { document.cookie = `${c}=CNY; path=/; max-age=31536000`; });
    } catch (e) {}

    if (currentCurrencyCode() === 'CNY') {
      console.log('[currency] CNY already selected');
      return true;
    }

    let option = findCurrencyOption('CNY');
    if (!option) {
      const trigger = findCurrencyTrigger();
      if (trigger) {
        console.log('[currency] opening currency selector');
        clickElement(trigger);
        await sleep(CONFIG.postClickSettleMs);
      }
      option = findCurrencyOption('CNY');
    }

    if (!option) {
      console.warn('[currency] could not find CNY option; continuing with raw yuan normalization fallback');
      return false;
    }

    console.log('[currency] switching Sugargoo display currency to CNY');
    clickElement(option);
    await sleep(CONFIG.postClickSettleMs);
    await waitForDomAndNetworkToSettle(Math.min(CONFIG.pageChangeTimeoutMs, 8_000));
    return currentCurrencyCode() === 'CNY' || Boolean(findCurrencyOption('CNY'));
  };

  const waitForListingChange = async (before, timeoutMs = CONFIG.pageChangeTimeoutMs) => {
    const startedAt = Date.now();
    let sawDifferentState = false;

    while (Date.now() - startedAt < timeoutMs) {
      rememberRows();

      const blocker = detectRateLimitState();
      if (blocker.active) {
        return { changed: false, rateLimited: true, reason: blocker.reason };
      }

      const current = getVisibleListingSnapshot();
      const changed = (
        current.signature !== before.signature ||
        current.count !== before.count ||
        current.scrollHeight !== before.scrollHeight ||
        getActivePageLabel() !== before.pageLabel ||
        rowsByKey.size > before.uniqueCount
      );

      if (changed) sawDifferentState = true;

      if (sawDifferentState) {
        await waitForDomAndNetworkToSettle(Math.min(CONFIG.domQuietMs + 5_000, timeoutMs));
        rememberRows();
        return {
          changed: true,
          rateLimited: false,
          current: getVisibleListingSnapshot(),
        };
      }

      await sleep(300);
    }

    return {
      changed: false,
      rateLimited: false,
      current: getVisibleListingSnapshot(),
    };
  };

  const waitOutRateLimit = async (attemptIndex) => {
    const waitMs = Math.min(
      CONFIG.rateLimitBaseWaitMs * (2 ** Math.max(0, attemptIndex)),
      CONFIG.rateLimitMaxWaitMs,
    );

    console.warn(`[rate-limit] waiting ${(waitMs / 1000).toFixed(0)}s before retry`);
    const startedAt = Date.now();

    while (Date.now() - startedAt < waitMs) {
      await sleep(Math.min(CONFIG.rateLimitProbeMs, waitMs - (Date.now() - startedAt)));
      const blocker = detectRateLimitState();
      if (!blocker.active) {
        await sleep(CONFIG.postClickSettleMs);
        console.log('[rate-limit] blocker cleared, retrying');
        return;
      }
    }

    console.warn('[rate-limit] cooldown elapsed, retrying anyway');
  };

  const scrollCurrentPageToEnd = async () => {
    let stableRounds = 0;
    let lastSignature = '';

    for (let round = 0; round < CONFIG.maxScrollRoundsPerPage; round++) {
      rememberRows();
      const snapshot = getVisibleListingSnapshot();
      console.log(
        `[scroll ${round + 1}] visible=${snapshot.count} total_unique=${rowsByKey.size} last=${snapshot.lastKey || 'n/a'}`,
      );

      if (snapshot.signature === lastSignature) {
        stableRounds += 1;
      } else {
        stableRounds = 0;
        lastSignature = snapshot.signature;
      }

      if (stableRounds >= CONFIG.stableRoundsNeeded) break;

      scrollTargetsToEnd();
      await sleep(CONFIG.scrollDelayMs);
      await waitForDomAndNetworkToSettle(CONFIG.scrollDelayMs + 3_000);
    }

    rememberRows();
    await sleep(300);
    rememberRows();
  };

  const collectCurrentPage = async () => {
    const beforeCount = rowsByKey.size;
    rememberRows();
    await waitForDomAndNetworkToSettle(Math.min(CONFIG.domQuietMs + 1_500, 4_000));
    rememberRows();

    if (CONFIG.clickLoadMore) {
      for (let loadMoreClicks = 0; loadMoreClicks < CONFIG.maxLoadMoreClicksPerPage; loadMoreClicks++) {
        const btn = getLoadMoreButton();
        if (!btn) break;

        const before = {
          ...getVisibleListingSnapshot(),
          pageLabel: getActivePageLabel(),
          uniqueCount: rowsByKey.size,
        };

        const label = clean(btn.innerText || btn.getAttribute('aria-label') || 'load more');
        console.log(`[load-more ${loadMoreClicks + 1}] clicking ${label}`);
        clickElement(btn);
        await sleep(CONFIG.postClickSettleMs);

        const result = await waitForListingChange(before, CONFIG.loadMoreChangeTimeoutMs);
        if (result.rateLimited) {
          await waitOutRateLimit(loadMoreClicks);
          continue;
        }

        if (!result.changed) {
          console.log('[load-more] no listing change detected, continuing without more clicks');
          break;
        }

        rememberRows();
        await waitForDomAndNetworkToSettle(Math.min(CONFIG.domQuietMs + 1_500, 4_000));
        rememberRows();
      }
    }

    await saveDiscoveredImagesSoFar();
    return rowsByKey.size - beforeCount;
  };

  const toCsv = (rows) => {
    const headers = [
      'offer_id',
      'title',
      'price',
      'price_currency',
      'price_value',
      'price_original',
      'price_original_currency',
      'price_original_value',
      'price_exchange_source',
      'price_exchange_date',
      'sales',
      'sugargoo_url',
      'source_url',
      'source_1688_url',
      'image_url',
      'image_file',
    ];
    const esc = (value) => {
      const s = String(value ?? '');
      return `"${s.replace(/"/g, '""')}"`;
    };
    return [
      headers.join(','),
      ...rows.map((row) => headers.map((h) => esc(row[h])).join(',')),
    ].join('\n');
  };

  const downloadBlob = (blob, fileName) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  };

  const downloadCsv = (csvText) => {
    const blob = new Blob([csvText], { type: 'text/csv;charset=utf-8;' });
    downloadBlob(blob, CONFIG.csvFileName);
  };

  const loadScript = (src) => new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`Failed to load script: ${src}`));
    document.head.appendChild(s);
  });

  const ensureJsZip = async () => {
    if (window.JSZip) return window.JSZip;
    await loadScript('https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js');
    if (!window.JSZip) throw new Error('JSZip did not load');
    return window.JSZip;
  };

  const canUseFileSystemAccess = () => Boolean(
    CONFIG.saveToFolderAsYouGo &&
    window.isSecureContext &&
    typeof window.showDirectoryPicker === 'function',
  );

  const writeFileHandle = async (fileHandle, content) => {
    const writable = await fileHandle.createWritable();
    await writable.write(content);
    await writable.close();
  };

  const ensureSaveTarget = async () => {
    if (saveTarget.enabled) return true;
    if (!canUseFileSystemAccess()) return false;

    try {
      const baseDir = await window.showDirectoryPicker({ mode: 'readwrite' });
      const storageRootDirHandle = CONFIG.storageRootFolderName
        ? await baseDir.getDirectoryHandle(CONFIG.storageRootFolderName, { create: true })
        : baseDir;
      const runDirHandle = await storageRootDirHandle.getDirectoryHandle(CONFIG.folderName, { create: true });
      const imagesDirHandle = await runDirHandle.getDirectoryHandle('images', { create: true });
      saveTarget.runDirHandle = runDirHandle;
      saveTarget.imagesDirHandle = imagesDirHandle;
      saveTarget.enabled = true;
      const targetLabel = CONFIG.storageRootFolderName
        ? `${CONFIG.storageRootFolderName}/${CONFIG.folderName}`
        : CONFIG.folderName;
      console.log(`[save] writing files progressively to folder: ${targetLabel}`);
      return true;
    } catch (err) {
      console.warn('[save] folder access was not granted, falling back to end-of-run export', err);
      return false;
    }
  };

  const fetchImageBytes = async (imageUrl) => {
    if (!imageUrl) throw new Error('Missing image URL');
    if (imageUrl.startsWith('data:')) {
      return dataUrlToUint8Array(imageUrl);
    }

    const absoluteUrl = new URL(imageUrl, location.href);
    const sameOrigin = absoluteUrl.origin === location.origin;

    const response = await fetch(absoluteUrl.href, {
      mode: 'cors',
      credentials: sameOrigin ? 'include' : 'omit',
      cache: 'force-cache',
      referrerPolicy: 'no-referrer-when-downgrade',
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const buf = await response.arrayBuffer();
    return new Uint8Array(buf);
  };

  const saveImageToFolder = async (row, index) => {
    if (!saveTarget.enabled) return false;

    const imageUrl = row.image_url;
    const fileName = row.image_file || `${String(index + 1).padStart(4, '0')}.jpg`;
    if (!imageUrl || savedImageFiles.has(fileName) || failedImageFiles.has(fileName)) {
      return false;
    }

    try {
      const bytes = await fetchImageBytes(imageUrl);
      const fileHandle = await saveTarget.imagesDirHandle.getFileHandle(fileName, { create: true });
      await writeFileHandle(fileHandle, bytes);
      savedImageFiles.add(fileName);
      console.log(`[save] image ${savedImageFiles.size}: images/${fileName}`);
      return true;
    } catch (err) {
      failedImageFiles.add(fileName);
      console.warn(`[save] failed image: images/${fileName}`, err);
      return false;
    }
  };

  const saveDiscoveredImagesSoFar = async () => {
    if (!saveTarget.enabled) return;

    const rows = [...rowsByKey.values()];
    for (const [index, row] of rows.entries()) {
      await saveImageToFolder(row, index);
    }
  };

  const writeCsvToFolder = async (csvText) => {
    if (!saveTarget.enabled) return false;
    const fileHandle = await saveTarget.runDirHandle.getFileHandle(CONFIG.csvFileName, { create: true });
    await writeFileHandle(fileHandle, csvText);
    console.log(`[save] wrote CSV: ${CONFIG.csvFileName}`);
    return true;
  };

  const downloadImagesZip = async (rows, csvText) => {
    const JSZip = await ensureJsZip();
    const zip = new JSZip();
    zip.file(CONFIG.csvFileName, csvText);

    const manifest = [];
    let ok = 0;
    let fail = 0;

    for (const [index, row] of rows.entries()) {
      const imageUrl = row.image_url;
      if (!imageUrl) {
        manifest.push({ ...row, saved: false, error: 'missing image_url' });
        fail += 1;
        continue;
      }

      const fileName = `images/${row.image_file || `${String(index + 1).padStart(4, '0')}.jpg`}`;
      try {
        const bytes = await fetchImageBytes(imageUrl);
        zip.file(fileName, bytes);
        manifest.push({ ...row, saved: true, zip_path: fileName });
        ok += 1;
        console.log(`saved image ${ok}/${rows.length}: ${fileName}`);
      } catch (err) {
        manifest.push({ ...row, saved: false, error: String(err) });
        fail += 1;
        console.warn(`failed image: ${fileName}`, err);
      }
    }

    zip.file('manifest.json', JSON.stringify({ saved: ok, failed: fail, rows: manifest }, null, 2));
    const blob = await zip.generateAsync({ type: 'blob' });
    downloadBlob(blob, CONFIG.zipFileName);
    return { ok, fail };
  };

  const sortLabelFor = (sortMode) => ({
    _coefp: 'relevance',
    _sale: 'sales',
    _bid: 'price descending',
    bid: 'price ascending',
  }[sortMode] || sortMode);

  const getSortBarRoot = () => (
    document.querySelector('.sort-bar-wrap, .sort-bar') ||
    getShopRoot()
  );

  const getCategoryControls = () => {
    const root = getShopRoot();
    return [...root.querySelectorAll('.ant-tabs-tab, [role="tab"]')]
      .filter(isVisible)
      .filter((el) => !el.closest(PRODUCT_SELECTOR))
      .map((el) => clickableControlFor(el))
      .filter(Boolean)
      .filter((el, index, arr) => arr.indexOf(el) === index)
      .map((el) => ({
        el,
        label: clean(el.innerText || el.getAttribute('aria-label') || ''),
        active: /\bant-tabs-tab-active\b|\bactive\b/i.test(String(el.className || '')),
      }))
      .filter((item) => item.label && item.label.length <= 120);
  };

  const selectCategoryByLabel = async (categoryLabel) => {
    const control = getCategoryControls().find((item) => item.label === categoryLabel);
    if (!control) return false;
    if (control.active) return true;

    const before = {
      ...getVisibleListingSnapshot(),
      pageLabel: getActivePageLabel(),
      uniqueCount: rowsByKey.size,
    };

    console.log(`[category] switching to ${categoryLabel}`);
    clickElement(control.el);
    await sleep(CONFIG.postClickSettleMs);

    const changed = await waitForListingChange(before, CONFIG.pageChangeTimeoutMs);
    if (changed.rateLimited) {
      await waitOutRateLimit(0);
      return false;
    }
    await collectCurrentPage();
    return changed.changed || getCategoryControls().some((item) => item.label === categoryLabel && item.active);
  };

  const getSortControlByText = (patterns) => {
    const wanted = Array.isArray(patterns) ? patterns : [patterns];
    return [...getSortBarRoot().querySelectorAll('button, a, div, span')]
      .filter(isVisible)
      .filter((el) => !el.closest(PRODUCT_SELECTOR))
      .map((el) => clickableControlFor(el))
      .filter(Boolean)
      .filter((el, index, arr) => arr.indexOf(el) === index)
      .find((el) => {
        const text = clean(el.innerText || el.getAttribute('aria-label') || '');
        return text && text.length <= 80 && wanted.some((rx) => rx.test(text));
      }) || null;
  };

  const waitForRequestedOrderType = async (sortMode, timeoutMs = 5000) => {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      if (shopItemNetworkState.lastOrderType === sortMode) return true;
      await sleep(250);
    }
    return false;
  };

  const isForbiddenReplayHeader = (name) => {
    const lower = String(name || '').toLowerCase();
    return (
      !lower ||
      lower.startsWith('proxy-') ||
      lower.startsWith('sec-') ||
      [
        'accept-charset',
        'accept-encoding',
        'access-control-request-headers',
        'access-control-request-method',
        'connection',
        'content-length',
        'cookie',
        'cookie2',
        'date',
        'dnt',
        'expect',
        'host',
        'keep-alive',
        'origin',
        'referer',
        'te',
        'trailer',
        'transfer-encoding',
        'upgrade',
        'user-agent',
        'via',
      ].includes(lower)
    );
  };

  const buildReplayHeaders = () => {
    const headers = {};
    for (const [key, value] of Object.entries(shopItemNetworkState.lastHeaders || {})) {
      if (isForbiddenReplayHeader(key)) continue;
      headers[key] = value;
    }
    headers.accept = headers.accept || 'application/json, text/plain, */*';
    headers['content-type'] = headers['content-type'] || 'application/json;charset=UTF-8';
    return headers;
  };

  const canReplayShopItemApi = () => Boolean(
    getShopItemBodyTemplate(),
  );

  const inferShopIdentityFromLocation = () => {
    const pathMatch = location.pathname.match(/\/shops\/([^/?#]+)/i);
    const params = new URLSearchParams(location.search);
    const sellerId = params.get('sellerId');
    return {
      channel: params.get('source') || 'taobao',
      shopId: pathMatch ? decodeURIComponent(pathMatch[1]) : '',
      sellerId: sellerId || null,
    };
  };

  const getShopItemBodyTemplate = () => {
    if (
      shopItemNetworkState.lastBody &&
      typeof shopItemNetworkState.lastBody === 'object' &&
      shopItemNetworkState.lastBody.model &&
      typeof shopItemNetworkState.lastBody.model === 'object'
    ) {
      return shopItemNetworkState.lastBody;
    }

    const identity = inferShopIdentityFromLocation();
    if (!identity.shopId) return null;
    return {
      current: '1',
      size: '45',
      model: {
        orderType: '_coefp',
        lowPrice: '',
        highPrice: '',
        ...identity,
      },
    };
  };

  const buildShopItemApiBody = (sortMode, pageNumber) => {
    const template = JSON.parse(JSON.stringify(getShopItemBodyTemplate() || {}));
    template.current = String(pageNumber);
    template.size = String(template.size || 20);
    template.model = {
      ...(template.model || {}),
      orderType: sortMode,
    };
    return template;
  };

  const findSugargooRequestClient = async () => {
    const scriptUrls = [
      ...document.querySelectorAll('script[type="module"][src], link[rel="modulepreload"][href]'),
    ]
      .map((el) => el.src || el.href)
      .filter(Boolean)
      .filter((url) => /\/assets\/index-[^/]+\.js(?:$|\?)/.test(url));

    for (const scriptUrl of scriptUrls) {
      try {
        const module = await import(scriptUrl);
        for (const value of Object.values(module)) {
          if (value && typeof value === 'object' && typeof value.request === 'function') {
            return value;
          }
        }
      } catch {}
    }
    return null;
  };

  const getSugargooRequestClient = async () => {
    if (!shopItemNetworkState.requestClientPromise) {
      shopItemNetworkState.requestClientPromise = findSugargooRequestClient();
    }
    return shopItemNetworkState.requestClientPromise;
  };

  const signatureForApiRecords = (records) => records
    .map((record) => rowKeyFor(rowFromApiRecord(record)))
    .filter(Boolean)
    .join('|');

  const fetchShopItemApiPage = async (sortMode, pageNumber) => {
    const body = buildShopItemApiBody(sortMode, pageNumber);
    const requestClient = await getSugargooRequestClient();
    if (requestClient) {
      const payload = await requestClient.request({
        url: '/api/datacenter/shop/anno/shopItem/page',
        data: body,
        method: 'post',
      });
      const records = Array.isArray(payload?.data?.records) ? payload.data.records : [];
      const code = payload?.code ?? payload?.status;
      const message = clean(payload?.msg || payload?.message || payload?.error || '');
      if (!records.length && code && !['0', '200', 0, 200].includes(code)) {
        throw new Error(`API code ${code}${message ? `: ${message}` : ''}`);
      }
      return { payload, records };
    }

    if (!shopItemNetworkState.lastUrl) {
      throw new Error('missing captured shop API URL');
    }

    const response = await fetch(shopItemNetworkState.lastUrl, {
      method: 'POST',
      mode: 'cors',
      credentials: 'include',
      cache: 'no-store',
      headers: buildReplayHeaders(),
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const payload = await response.json();
    const records = Array.isArray(payload?.data?.records) ? payload.data.records : [];
    const code = payload?.code ?? payload?.status;
    const message = clean(payload?.msg || payload?.message || payload?.error || '');
    if (!records.length && code && !['0', '200', 0, 200].includes(code)) {
      throw new Error(`API code ${code}${message ? `: ${message}` : ''}`);
    }

    return { payload, records };
  };

  const crawlSortModeViaApi = async (sortMode, totalPageVisits, options = {}) => {
    const sortLabel = options.sortLabel || sortLabelFor(sortMode);
    if (!canReplayShopItemApi()) return null;

    console.log(`[crawl:${sortLabel}] using captured shop API request replay`);
    const seenPageSignatures = new Set();
    const uniqueMissLimit = Number.isFinite(options.uniqueMissLimit) ? Math.max(0, options.uniqueMissLimit) : 0;
    let consecutiveNonUniquePages = 0;
    let sortPageVisits = 0;
    let completionReason = 'API returned no more records';
    let stoppedEarly = false;
    let uniqueStopReached = false;

    for (let pageNumber = 1; totalPageVisits < CONFIG.maxPagesToVisit; pageNumber += 1) {
      let pageResult = null;
      let pageError = null;

      for (let retry = 0; retry < CONFIG.maxAdvanceRetriesPerPage; retry += 1) {
        try {
          pageResult = await fetchShopItemApiPage(sortMode, pageNumber);
          pageError = null;
          break;
        } catch (err) {
          pageError = err;
          console.warn(`[crawl:${sortLabel}] API page ${pageNumber} failed on retry ${retry + 1}:`, err);
          const blocker = detectRateLimitState();
          if (blocker.active) {
            await waitOutRateLimit(retry);
          } else {
            await sleep(Math.min(CONFIG.postClickSettleMs * (retry + 1), 5_000));
          }
        }
      }

      if (!pageResult) {
        completionReason = `API replay failed at page ${pageNumber}${pageError ? ` (${pageError.message || pageError})` : ''}`;
        stoppedEarly = true;
        break;
      }

      const { payload, records } = pageResult;
      if (!records.length) {
        completionReason = `API returned no records at page ${pageNumber}`;
        break;
      }

      const signature = signatureForApiRecords(records);
      if (signature && seenPageSignatures.has(signature)) {
        completionReason = `API page ${pageNumber} repeated a previous page`;
        break;
      }
      if (signature) seenPageSignatures.add(signature);

      const beforeCount = rowsByKey.size;
      const added = rememberApiRecords(records);
      sortPageVisits += 1;
      totalPageVisits += 1;

      const reportedTotal = payload?.data?.total ?? '?';
      console.log(
        `[crawl:${sortLabel}] API page ${pageNumber}: ${records.length} records; +${added} unique, total_unique=${rowsByKey.size}, reported_total=${reportedTotal}`,
      );

      if (uniqueMissLimit > 0) {
        if (added > 0) {
          consecutiveNonUniquePages = 0;
        } else {
          consecutiveNonUniquePages += 1;
          console.log(
            `[crawl:${sortLabel}] API page ${pageNumber} added no new unique listings (${consecutiveNonUniquePages}/${uniqueMissLimit})`,
          );
          if (consecutiveNonUniquePages >= uniqueMissLimit) {
            completionReason = `stopped after ${uniqueMissLimit} consecutive pages with no new unique listings`;
            uniqueStopReached = true;
          }
        }
      }

      updateCrawlProgress(
        sortLabel,
        sortPageVisits,
        totalPageVisits,
        false,
        completionReason,
        sortPageVisits === 1 || rowsByKey.size > beforeCount,
      );
      await saveDiscoveredImagesSoFar();

      if (uniqueStopReached) break;
    }

    if (totalPageVisits >= CONFIG.maxPagesToVisit) {
      completionReason = `hit max page limit (${CONFIG.maxPagesToVisit})`;
      stoppedEarly = true;
    }

    updateRuntimeState(
      {
        status: stoppedEarly ? 'warning' : 'running',
        pagesVisited: totalPageVisits,
        message: stoppedEarly
          ? `Stopped ${sortLabel} API replay after page ${sortPageVisits}.`
          : `Finished ${sortLabel} API replay at ${sortPageVisits} pages.`,
        completionReason,
        stoppedEarly,
        paginationDebug: getPaginationDebugInfo(),
      },
      { bumpRevision: true }
    );

    return { sortMode, sortLabel, completionReason, stoppedEarly, sortPageVisits, totalPageVisits, source: 'api', uniqueStopReached };
  };

  const clickPriceSortMode = async (sortMode) => {
    const priceContent = document.querySelector('.price-content');
    const priceDefault = document.querySelector('.price-default') || getSortControlByText([/^price$/i, /价格/]);
    const trigger = clickableControlFor(priceDefault || priceContent);
    if (!trigger) return false;

    const tryPopoverItem = async () => {
      for (const target of [priceContent, priceDefault, trigger].filter(Boolean)) {
        target.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true, view: window }));
        target.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false, cancelable: true, view: window }));
      }

      const startedAt = Date.now();
      while (Date.now() - startedAt < 2500) {
        const items = [...document.querySelectorAll('.price-popover .popover-item, .price-popover [class*="popover-item"]')]
          .filter(isVisible)
          .map((el) => clickableControlFor(el))
          .filter(Boolean)
          .filter((el, index, arr) => arr.indexOf(el) === index);
        const index = sortMode === '_bid' ? 0 : 1;
        if (items[index]) {
          clickElement(items[index]);
          return waitForRequestedOrderType(sortMode, 5000);
        }
        await sleep(150);
      }

      const fallbackItems = [...document.querySelectorAll('.price-popover *, .ant-popover *')]
        .filter(isVisible)
        .map((el) => clickableControlFor(el))
        .filter(Boolean)
        .filter((el, index, arr) => arr.indexOf(el) === index)
        .filter((el) => {
          const text = clean(el.innerText || el.getAttribute('aria-label') || '');
          return text && text.length <= 80 && !/price$/i.test(text);
        });
      const index = sortMode === '_bid' ? 0 : 1;
      if (!fallbackItems[index]) return false;
      clickElement(fallbackItems[index]);
      return waitForRequestedOrderType(sortMode, 5000);
    };

    if (await tryPopoverItem()) return true;

    clickElement(trigger);
    await sleep(CONFIG.postClickSettleMs);
    if (await waitForRequestedOrderType(sortMode, 2500)) return true;

    if (sortMode === 'bid') {
      clickElement(trigger);
      await sleep(CONFIG.postClickSettleMs);
      if (await waitForRequestedOrderType(sortMode, 2500)) return true;
    }

    return shopItemNetworkState.lastOrderType === sortMode;
  };

  const selectSortMode = async (sortMode) => {
    if (!sortMode || sortMode === shopItemNetworkState.lastOrderType) return true;
    const before = {
      ...getVisibleListingSnapshot(),
      pageLabel: getActivePageLabel(),
      uniqueCount: rowsByKey.size,
    };

    let clicked = false;
    if (sortMode === '_coefp') {
      clicked = clickElement(getSortControlByText([/sort\s*by\s*relevance/i, /relevance/i, /综合/, /默认/]));
    } else if (sortMode === '_sale') {
      clicked = clickElement(getSortControlByText([/^sales$/i, /销量/]));
    } else if (sortMode === '_bid' || sortMode === 'bid') {
      clicked = await clickPriceSortMode(sortMode);
    }

    if (!clicked) {
      console.warn(`[sort] could not find control for ${sortLabelFor(sortMode)} (${sortMode})`);
      return false;
    }

    await sleep(CONFIG.postClickSettleMs);
    const changed = await waitForListingChange(before, CONFIG.pageChangeTimeoutMs);
    if (changed.rateLimited) {
      await waitOutRateLimit(0);
      return false;
    }
    await waitForRequestedOrderType(sortMode, 3000);
    await collectCurrentPage();
    return changed.changed || shopItemNetworkState.lastOrderType === sortMode;
  };

  const updateCrawlProgress = (sortLabel, sortPageVisits, totalPageVisits, stoppedEarly, completionReason, bump = false) => {
    updateRuntimeState(
      {
        status: stoppedEarly ? 'warning' : 'running',
        message: `Captured ${sortLabel} page ${sortPageVisits}.`,
        pagesVisited: totalPageVisits,
        paginationDebug: getPaginationDebugInfo(),
        lastCheckpointPage:
          totalPageVisits - runtimeState.lastCheckpointPage >= CONFIG.checkpointEveryPages
            ? totalPageVisits
            : runtimeState.lastCheckpointPage,
        completionReason,
        stoppedEarly,
      },
      {
        bumpRevision:
          bump ||
          totalPageVisits === 1 ||
          totalPageVisits - runtimeState.lastCheckpointPage >= CONFIG.checkpointEveryPages,
      }
    );
  };

  const crawlCurrentSortMode = async (sortMode, totalPageVisits, options = {}) => {
    const sortLabel = options.sortLabel || sortLabelFor(sortMode);
    const uniqueMissLimit = Number.isFinite(options.uniqueMissLimit) ? Math.max(0, options.uniqueMissLimit) : 0;
    const initialUniqueBaseCount = Number.isFinite(options.initialUniqueBaseCount)
      ? Math.max(0, options.initialUniqueBaseCount)
      : rowsByKey.size;
    let consecutiveNonUniquePages = 0;
    let sortPageVisits = 1;
    let reachedEndOfPages = false;
    let completionReason = 'reached end of pagination';
    let stoppedEarly = false;
    let uniqueStopReached = false;

    const trackPageUniqueness = (added, pageNumber) => {
      if (uniqueMissLimit <= 0) return false;
      if (added > 0) {
        consecutiveNonUniquePages = 0;
        return false;
      }
      consecutiveNonUniquePages += 1;
      console.log(
        `[crawl:${sortLabel}] page ${pageNumber} added no new unique listings (${consecutiveNonUniquePages}/${uniqueMissLimit})`,
      );
      if (consecutiveNonUniquePages >= uniqueMissLimit) {
        completionReason = `stopped after ${uniqueMissLimit} consecutive pages with no new unique listings`;
        uniqueStopReached = true;
        reachedEndOfPages = true;
        return true;
      }
      return false;
    };

    rememberRows();
    await collectCurrentPage();
    const firstPageAdded = Math.max(0, rowsByKey.size - initialUniqueBaseCount);
    totalPageVisits += 1;
    updateCrawlProgress(sortLabel, sortPageVisits, totalPageVisits, false, '', true);
    trackPageUniqueness(firstPageAdded, sortPageVisits);

    while (totalPageVisits < CONFIG.maxPagesToVisit && !reachedEndOfPages) {
      if (!getNextPageButton()) {
        console.log(`[crawl:${sortLabel}] no next-page control found, stopping`);
        console.log('[crawl] pagination debug:', getPaginationDebugInfo());
        completionReason = 'no next-page control found';
        break;
      }

      let advanced = false;

      for (let retry = 0; retry < CONFIG.maxAdvanceRetriesPerPage; retry++) {
        const nextButton = getNextPageButton();
        if (!nextButton) {
          console.log(`[crawl:${sortLabel}] next-page control disappeared, stopping`);
          completionReason = 'next-page control disappeared';
          stoppedEarly = true;
          updateRuntimeState({
            status: 'warning',
            message: 'Next-page control disappeared before the scrape could continue.',
            completionReason,
            stoppedEarly,
            paginationDebug: getPaginationDebugInfo(),
          });
          return { sortMode, sortLabel, completionReason, stoppedEarly, sortPageVisits, totalPageVisits };
        }

        const before = {
          ...getVisibleListingSnapshot(),
          pageLabel: getActivePageLabel(),
          uniqueCount: rowsByKey.size,
        };

        const label = clean(nextButton.innerText || nextButton.getAttribute('aria-label') || 'next');
        console.log(
          `[${sortLabel} page ${sortPageVisits}] attempting next (${label}) retry ${retry + 1}/${CONFIG.maxAdvanceRetriesPerPage}`,
        );

        clickElement(nextButton);
        await sleep(CONFIG.postClickSettleMs);

        const result = await waitForListingChange(before, CONFIG.nextClickChangeTimeoutMs);
        if (result.rateLimited) {
          console.warn(`[${sortLabel} page ${sortPageVisits}] rate limit detected: ${result.reason || 'unknown reason'}`);
          await waitOutRateLimit(retry);
          continue;
        }

        if (!result.changed) {
          const numericNextButton = getNumericNextPageButton(before.pageLabel);
          if (numericNextButton && numericNextButton !== nextButton) {
            const numericLabel = clean(numericNextButton.innerText || numericNextButton.getAttribute('aria-label') || '');
            console.warn(`[${sortLabel} page ${sortPageVisits}] next control did not change; trying page ${numericLabel || 'number'} directly`);
            clickElement(numericNextButton);
            await sleep(CONFIG.postClickSettleMs);
            const numericResult = await waitForListingChange(before, CONFIG.nextClickChangeTimeoutMs);
            if (numericResult.rateLimited) {
              console.warn(`[${sortLabel} page ${sortPageVisits}] rate limit detected: ${numericResult.reason || 'unknown reason'}`);
              await waitOutRateLimit(retry);
              continue;
            }
            if (numericResult.changed) {
              sortPageVisits += 1;
              totalPageVisits += 1;
              const pageLabel = getActivePageLabel();
              console.log(`[crawl:${sortLabel}] moved to page ${pageLabel || sortPageVisits}`);
              await collectCurrentPage();
              const added = Math.max(0, rowsByKey.size - before.uniqueCount);
              updateCrawlProgress(sortLabel, sortPageVisits, totalPageVisits, false, completionReason);
              trackPageUniqueness(added, sortPageVisits);
              advanced = true;
              break;
            }
          }

          console.warn(`[${sortLabel} page ${sortPageVisits}] page did not change after clicking next`);
          if (retry + 1 >= CONFIG.maxUnchangedNextClicksBeforeStop) {
            console.log(
              `[crawl:${sortLabel}] next button produced no page change ${retry + 1} times; stopping at page ${sortPageVisits}`,
            );
            reachedEndOfPages = true;
            completionReason = 'next page stopped changing before pagination reported an end';
            stoppedEarly = true;
            break;
          }
          await sleep(Math.min(CONFIG.postClickSettleMs * (retry + 1), 5_000));
          continue;
        }

        sortPageVisits += 1;
        totalPageVisits += 1;
        const pageLabel = getActivePageLabel();
        console.log(`[crawl:${sortLabel}] moved to page ${pageLabel || sortPageVisits}`);
        await collectCurrentPage();
        const added = Math.max(0, rowsByKey.size - before.uniqueCount);
        updateCrawlProgress(sortLabel, sortPageVisits, totalPageVisits, false, completionReason);
        trackPageUniqueness(added, sortPageVisits);
        advanced = true;
        break;
      }

      if (!advanced) {
        if (reachedEndOfPages) break;
        console.warn(`[crawl:${sortLabel}] unable to advance to the next page after repeated retries; stopping`);
        completionReason = 'unable to advance after repeated retries';
        stoppedEarly = true;
        break;
      }
    }

    if (totalPageVisits >= CONFIG.maxPagesToVisit) {
      completionReason = `hit max page limit (${CONFIG.maxPagesToVisit})`;
      stoppedEarly = true;
    }

    updateRuntimeState(
      {
        status: stoppedEarly ? 'warning' : 'running',
        pagesVisited: totalPageVisits,
        message: stoppedEarly
          ? `Stopped ${sortLabel} after page ${sortPageVisits}.`
          : `Finished ${sortLabel} at ${sortPageVisits} pages.`,
        completionReason,
        stoppedEarly,
        paginationDebug: getPaginationDebugInfo(),
      },
      { bumpRevision: runtimeState.lastCheckpointPage !== totalPageVisits }
    );
    runtimeState.lastCheckpointPage = totalPageVisits;
    return { sortMode, sortLabel, completionReason, stoppedEarly, sortPageVisits, totalPageVisits, uniqueStopReached };
  };

  const crawlAllPages = async () => {
    const sortModes = [...new Set((CONFIG.crawlSortModes || ['_coefp']).filter(Boolean))];
    const globalUniqueMissLimit = Math.max(1, Number(CONFIG.globalNonUniquePageLimit) || 5);
    const summaries = [];
    let totalPageVisits = 0;
    let stoppedEarly = false;

    for (const [index, sortMode] of sortModes.entries()) {
      const sortLabel = sortLabelFor(sortMode);
      const streamStartUniqueCount = rowsByKey.size;
      if (index > 0 || sortMode !== '_coefp') {
        updateRuntimeState({
          status: 'running',
          message: `Switching to ${sortLabel} sort.`,
          pagesVisited: totalPageVisits,
          stoppedEarly,
        });
        const selected = await selectSortMode(sortMode);
        if (!selected) {
          const apiSummary = await crawlSortModeViaApi(sortMode, totalPageVisits, {
            uniqueMissLimit: globalUniqueMissLimit,
          });
          if (apiSummary && apiSummary.sortPageVisits > 0) {
            totalPageVisits = apiSummary.totalPageVisits;
            summaries.push({
              ...apiSummary,
              completionReason: `could not switch UI sort mode; ${apiSummary.completionReason}`,
            });
            stoppedEarly = stoppedEarly || apiSummary.stoppedEarly;
            if (totalPageVisits >= CONFIG.maxPagesToVisit) break;
            continue;
          }

          const failed = {
            sortMode,
            sortLabel,
            sortPageVisits: 0,
            completionReason: apiSummary?.completionReason || 'could not switch sort mode',
            stoppedEarly: true,
          };
          summaries.push(failed);
          stoppedEarly = true;
          continue;
        }
      }

      const summary = await crawlCurrentSortMode(sortMode, totalPageVisits, {
        uniqueMissLimit: globalUniqueMissLimit,
        initialUniqueBaseCount: streamStartUniqueCount,
      });
      totalPageVisits = summary.totalPageVisits;
      let finalSummary = summary;
      if (summary.stoppedEarly) {
        const apiSummary = await crawlSortModeViaApi(sortMode, totalPageVisits, {
          uniqueMissLimit: globalUniqueMissLimit,
        });
        if (apiSummary && apiSummary.sortPageVisits > 0) {
          totalPageVisits = apiSummary.totalPageVisits;
          finalSummary = {
            ...summary,
            sortPageVisits: summary.sortPageVisits + apiSummary.sortPageVisits,
            totalPageVisits,
            stoppedEarly: apiSummary.stoppedEarly,
            completionReason: `${summary.completionReason}; API replay ${apiSummary.sortPageVisits} pages (${apiSummary.completionReason})`,
          };
        }
      }
      summaries.push(finalSummary);
      stoppedEarly = stoppedEarly || finalSummary.stoppedEarly;
      if (totalPageVisits >= CONFIG.maxPagesToVisit) break;
    }

    if (CONFIG.crawlCategories && totalPageVisits < CONFIG.maxPagesToVisit) {
      const categoryLabels = getCategoryControls()
        .map((item) => item.label)
        .filter((label, index, arr) => index > 0 && arr.indexOf(label) === index)
        .slice(0, CONFIG.maxCategoriesToCrawl);
      const categorySortModes = [...new Set((CONFIG.crawlCategorySortModes || ['_coefp']).filter(Boolean))];
      const categoryUniqueMissLimit = Math.max(1, Number(CONFIG.categoryNonUniquePageLimit) || 3);

      for (const categoryLabel of categoryLabels) {
        if (totalPageVisits >= CONFIG.maxPagesToVisit) break;

        updateRuntimeState({
          status: 'running',
          message: `Switching to category ${categoryLabel}.`,
          pagesVisited: totalPageVisits,
          stoppedEarly,
        });

        const categoryStartUniqueCount = rowsByKey.size;
        const categorySelected = await selectCategoryByLabel(categoryLabel);
        if (!categorySelected) {
          summaries.push({
            categoryLabel,
            sortMode: '',
            sortLabel: `${categoryLabel} category`,
            sortPageVisits: 0,
            completionReason: 'could not switch category tab',
            stoppedEarly: true,
          });
          stoppedEarly = true;
          continue;
        }

        for (const [index, sortMode] of categorySortModes.entries()) {
          if (totalPageVisits >= CONFIG.maxPagesToVisit) break;
          const sortLabel = `${categoryLabel} / ${sortLabelFor(sortMode)}`;
          let streamStartUniqueCount = index === 0 ? categoryStartUniqueCount : rowsByKey.size;

          if (index > 0 || sortMode !== shopItemNetworkState.lastOrderType) {
            updateRuntimeState({
              status: 'running',
              message: `Switching ${categoryLabel} to ${sortLabelFor(sortMode)} sort.`,
              pagesVisited: totalPageVisits,
              stoppedEarly,
            });
            if (index > 0) {
              streamStartUniqueCount = rowsByKey.size;
            }
            const selected = await selectSortMode(sortMode);
            if (!selected) {
              const apiSummary = await crawlSortModeViaApi(sortMode, totalPageVisits, {
                sortLabel,
                uniqueMissLimit: categoryUniqueMissLimit,
              });
              if (apiSummary && apiSummary.sortPageVisits > 0) {
                totalPageVisits = apiSummary.totalPageVisits;
                summaries.push({
                  ...apiSummary,
                  categoryLabel,
                  sortLabel,
                  completionReason: `could not switch UI sort mode; ${apiSummary.completionReason}`,
                });
                stoppedEarly = stoppedEarly || apiSummary.stoppedEarly;
                if (apiSummary.uniqueStopReached) break;
                continue;
              }

              summaries.push({
                categoryLabel,
                sortMode,
                sortLabel,
                sortPageVisits: 0,
                completionReason: apiSummary?.completionReason || 'could not switch sort mode',
                stoppedEarly: true,
              });
              stoppedEarly = true;
              continue;
            }
          }

          const summary = await crawlCurrentSortMode(sortMode, totalPageVisits, {
            sortLabel,
            uniqueMissLimit: categoryUniqueMissLimit,
            initialUniqueBaseCount: streamStartUniqueCount,
          });
          totalPageVisits = summary.totalPageVisits;
          summaries.push({
            ...summary,
            categoryLabel,
            sortLabel,
          });
          stoppedEarly = stoppedEarly || summary.stoppedEarly;
          if (summary.uniqueStopReached) break;
        }
      }
    }

    const completionReason = summaries
      .map((summary) => `${summary.sortLabel}: ${summary.sortPageVisits} pages (${summary.completionReason})`)
      .join('; ');

    updateRuntimeState(
      {
        status: stoppedEarly ? 'warning' : 'running',
        pagesVisited: totalPageVisits,
        message: `Finished ${summaries.length} sort stream${summaries.length === 1 ? '' : 's'} at ${totalPageVisits} total page visits.`,
        completionReason,
        stoppedEarly,
        sortSummaries: summaries,
        paginationDebug: getPaginationDebugInfo(),
      },
      { bumpRevision: true }
    );

    return { completionReason, stoppedEarly, pageVisits: totalPageVisits, sortSummaries: summaries };
  };

  console.log('Starting Sugargoo scrape...');

  installNetworkMonitors();
  const domObserver = installDomMonitor();
  await ensureCnyCurrency();
  await ensureSaveTarget();

  try {
    const crawlSummary = await crawlAllPages();
    updateRuntimeState({
      completionReason: crawlSummary?.completionReason || runtimeState.completionReason,
      stoppedEarly: Boolean(crawlSummary?.stoppedEarly),
      pagesVisited: crawlSummary?.pageVisits || runtimeState.pagesVisited,
    });
  } finally {
    domObserver.disconnect();
  }

  const rows = exportRowsSnapshot();

  let priceRates = null;
  try {
    priceRates = await loadExchangeRates();
    console.log(`[price] normalizing saved prices to ${CANONICAL_PRICE_CURRENCY.toUpperCase()} using ${priceRates.source} ${priceRates.source_date}`);
  } catch (error) {
    console.warn('[price] could not load exchange rates; yuan prices will still be normalized, but non-CNY conversions may be unavailable', error);
  }

  const exportRows = rows.map((row) => normalizePriceRow(row, priceRates || {}));
  updateRuntimeState(
    {
      status: 'saving',
      message: `Preparing ${exportRows.length} rows for final save.`,
    },
    { bumpRevision: true }
  );

  const csvText = toCsv(exportRows);
  console.table(exportRows);
  console.log(`Done. Total unique listings: ${exportRows.length}`);

  if (saveTarget.enabled) {
    await writeCsvToFolder(csvText);
  } else if (CONFIG.downloadCsv) {
    downloadCsv(csvText);
  }

  if (!saveTarget.enabled && CONFIG.downloadImagesZip) {
    try {
      const { ok, fail } = await downloadImagesZip(exportRows, csvText);
      console.log(`ZIP complete. Images saved: ${ok}, failed: ${fail}`);
      if (fail > 0) {
        console.log('If some images failed, use the image_url column from the CSV as fallback.');
      }
    } catch (err) {
      console.warn('Could not build image ZIP. The CSV still contains image_url values.', err);
    }
  } else if (saveTarget.enabled) {
    console.log(`[save] folder export complete. Images saved: ${savedImageFiles.size}, failed: ${failedImageFiles.size}`);
  }

  return {
    shop_name: chooseBetterShopName(runtimeState.shopName, deriveShopName({ includeFallback: true })),
    scraped_at: new Date().toISOString(),
    row_count: exportRows.length,
    pages_visited: runtimeState.pagesVisited,
    completion_reason: runtimeState.completionReason,
    stopped_early: runtimeState.stoppedEarly,
    sort_summaries: runtimeState.sortSummaries || [],
    price_common_currency: CANONICAL_PRICE_CURRENCY,
    price_exchange_source: priceRates?.source || '',
    price_exchange_date: priceRates?.source_date || '',
    rows: exportRows,
    pagination_debug: getPaginationDebugInfo(),
  };
}

if (typeof window !== 'undefined') {
  window.runSugargooLiveCrawl = runSugargooLiveCrawl;
  window.runSugargooLiveScrape = runSugargooLiveCrawl;
}

if (typeof window !== 'undefined' && !window.__SUGARGOO_CRAWLER_DISABLE_AUTORUN__) {
  runSugargooLiveCrawl().catch((error) => {
    console.error('Sugargoo scrape failed.', error);
  });
}
