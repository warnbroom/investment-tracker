/* ==========================================================================
   Portfolio Tracker — Price Updater
   Scrape giá vàng từ giavang.doji.vn và NAV quỹ mở từ fmarket.vn

   Kiến trúc: dùng Cloudflare Worker tự host làm CORS proxy.
   User cấu hình URL Worker một lần ở trang Phân tích → lưu localStorage.
   Xem cloudflare-worker.js + README để deploy (5 phút).
   ========================================================================== */

const PRICE_STORAGE_KEY = 'portfolio_price_cache_v1';
const PROXY_STORAGE_KEY = 'portfolio_proxy_url_v1';

/* -------- Proxy config --------
   User's Cloudflare Worker URL. Format phải chứa {URL} làm placeholder
   cho URL đích. Ví dụ:
     https://so-cai-proxy.myname.workers.dev/?url={URL}
*/

function getProxyUrl() {
  try { return localStorage.getItem(PROXY_STORAGE_KEY) || ''; }
  catch { return ''; }
}

function setProxyUrl(url) {
  if (url && url.trim()) {
    localStorage.setItem(PROXY_STORAGE_KEY, url.trim());
  } else {
    localStorage.removeItem(PROXY_STORAGE_KEY);
  }
}

function hasProxy() {
  return !!getProxyUrl();
}

function buildProxyUrl(targetUrl) {
  const proxy = getProxyUrl();
  if (!proxy) throw new Error('Chưa cấu hình proxy. Vào trang Phân tích → "Cấu hình proxy" để thêm Cloudflare Worker URL.');
  if (proxy.includes('{URL}')) {
    return proxy.replace('{URL}', encodeURIComponent(targetUrl));
  }
  // Fallback: assume ?url= pattern
  const sep = proxy.includes('?') ? '&' : '?';
  return proxy + sep + 'url=' + encodeURIComponent(targetUrl);
}

/* -------- GOLD TYPE MAPPING --------
   Match tên loại vàng theo cả 2 nguồn:
   - banggia.doji.vn API (materialName): "VÀNG MIẾNG SJC",
     "NHẪN TRÒN 9999 HƯNG THỊNH VƯỢNG"
   - giavang.org (fallback): "SJC Lẻ", "Nhẫn tròn 999 Hưng Thịnh Vượng"
   Sau khi đơn giản hoá dropdown chỉ còn 2 loại: SJC và 9999.            */

const GOLD_PATTERNS = {
  'SJC':   [/V[àa]ng\s+mi[ếe]ng\s+SJC/i, /SJC\s*L[ẻe]/i, /\bSJC\b/i],
  '9999':  [/Nh[ẫậ]n\s+tr[òoó]n\s+999/i, /H[ưừ]ng\s*Th[ịị]nh/i],
};

/* -------- FETCH VIA PROXY -------- */

async function fetchViaProxy(targetUrl, options = {}) {
  const proxiedUrl = buildProxyUrl(targetUrl);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);

  try {
    const res = await fetch(proxiedUrl, {
      method: options.method || 'GET',
      headers: options.headers || {},
      body: options.body,
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Proxy HTTP ${res.status}. ${errText.slice(0, 200)}`);
    }
    return { text: await res.text() };
  } catch (e) {
    clearTimeout(timeout);
    if (e.name === 'AbortError') throw new Error('Proxy timeout (>20s). Kiểm tra Worker có đang chạy không.');
    throw e;
  }
}

/** Test proxy — gọi thử bảng giá vàng DOJI (API chính chủ, fallback giavang). */
async function testProxy() {
  const rows = await fetchDojiGoldPrices();
  if (!rows || rows.length === 0) throw new Error('Proxy OK nhưng không lấy được bảng giá vàng.');
  return { rowCount: rows.length, sampleName: rows[0].name };
}

/* ==========================================================================
   GOLD — nguồn CHÍNH: API chính chủ DOJI (banggia.doji.vn)
   Nguồn phụ (fallback): scrape giavang.org/trong-nuoc/doji.

   API DOJI: GET https://banggia.doji.vn/api/TablePrice/GetTablePrice
     → { status, data: "<base64>", messageObject }
   Payload `data` mã hoá AES-256-CBC + Pkcs7, giải bằng Web Crypto API
   (không cần thêm dependency). Key hardcode trong bundle của site
   (chunk-SBJLWGHF.js), IV = 16 byte đầu của payload sau base64-decode.
   Giá trong API: nghìn-đồng/chỉ → × 1000 = VND/chỉ.
   ========================================================================== */

// Key AES-256 (hex, 32 byte) trích từ bundle banggia.doji.vn:
//   chunk-SBJLWGHF.js → class._k = [...].join('')
const DOJI_AES_KEY_HEX =
  '7a4b8c3d1e9f2a5b6c0d4e8f3a7b1c5d9e2f6a0b4c8d3e7f1a5b9c2d6e0f4a8b';
const DOJI_API_URL =
  'https://banggia.doji.vn/api/TablePrice/GetTablePrice';

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return out;
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Giải mã payload `data` của API DOJI → JSON string.
 * Layout: [ IV 16 byte ][ ciphertext ] (đều nằm trong 1 chuỗi base64).
 * AES-256-CBC, Pkcs7 padding (Web Crypto tự bỏ padding).
 */
async function decryptDojiPayload(b64) {
  if (typeof crypto === 'undefined' || !crypto.subtle) {
    throw new Error('Trình duyệt không hỗ trợ Web Crypto (crypto.subtle).');
  }
  const raw = base64ToBytes(b64);
  const iv = raw.slice(0, 16);
  const ciphertext = raw.slice(16);
  const key = await crypto.subtle.importKey(
    'raw', hexToBytes(DOJI_AES_KEY_HEX), { name: 'AES-CBC' }, false, ['decrypt']
  );
  const plain = await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, key, ciphertext);
  return new TextDecoder().decode(plain);
}

/**
 * Fetch + decrypt bảng giá vàng từ API chính chủ DOJI.
 * Trả về mảng { name, buy, sell } với đơn vị VND/chỉ.
 */
async function fetchDojiApiPrices() {
  const { text } = await fetchViaProxy(DOJI_API_URL);
  let json;
  try { json = JSON.parse(text); }
  catch { throw new Error('DOJI API: response không phải JSON'); }
  if (!json || !json.data) throw new Error('DOJI API: thiếu trường "data"');

  const decrypted = await decryptDojiPayload(json.data);
  const parsed = JSON.parse(decrypted);
  // API trả object dạng {"0": {...}, "1": {...}} hoặc array — normalize.
  const list = Array.isArray(parsed) ? parsed : Object.values(parsed);

  const rows = [];
  for (const r of list) {
    const name = (r && r.materialName ? String(r.materialName) : '').trim();
    const buy = Number(r && r.priceDojiBuyIn);
    const sell = Number(r && r.priceDojiSellOut);
    if (!name || !Number.isFinite(buy) || buy <= 0) continue;
    // nghìn-đồng/chỉ → VND/chỉ
    rows.push({ name, buy: buy * 1000, sell: Number.isFinite(sell) ? sell * 1000 : buy * 1000 });
  }
  if (rows.length === 0) throw new Error('DOJI API: decrypt OK nhưng không có dòng giá hợp lệ');
  return rows;
}

/**
 * Lấy bảng giá vàng. Thử API chính chủ DOJI trước; nếu lỗi (đổi key,
 * host chưa allow trong Worker, mã hoá đổi...) thì fallback giavang.org.
 */
async function fetchDojiGoldPrices() {
  try {
    return await fetchDojiApiPrices();
  } catch (e) {
    console.warn('[gold] DOJI API lỗi, fallback giavang.org:', e.message);
    const { text: html } = await fetchViaProxy('https://giavang.org/trong-nuoc/doji/');
    return parseGoldHtml(html);
  }
}

/**
 * Parse HTML bảng giá vàng từ giavang.org.
 *
 * Format nguồn: bảng có nhiều <tr> lồng trong nhiều khu vực (Hà Nội, Đà Nẵng, TP.HCM)
 * dùng rowspan cho cột Khu vực. Mỗi loại vàng lặp lại 3 lần (mỗi khu vực 1 dòng).
 *
 * Chiến lược: quét tất cả <td>, tìm TD có text match tên loại vàng.
 * Từ đó lấy 2 TD kế tiếp = [mua, bán]. Giá x1000đ/lượng → ×100 = VND/chỉ.
 * Skip lặp: chỉ giữ mỗi loại vàng 1 lần (lần đầu gặp).
 */
function parseGoldHtml(html) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');

  const KNOWN_TYPES = [
    'SJC Lẻ',
    'AVPL',
    'Nhẫn tròn 999 Hưng Thịnh Vượng',
    'Nữ trang 99.99',
    'Nữ trang 99.9',
    'Nữ trang 99',
  ];

  const rows = [];
  const seen = new Set();

  const tds = doc.querySelectorAll('td');
  tds.forEach(td => {
    const name = td.textContent.trim();
    if (seen.has(name)) return;

    // Match theo tên chính xác (không case-sensitive, loose match)
    const matched = KNOWN_TYPES.find(t =>
      name.toLowerCase() === t.toLowerCase() ||
      name.toLowerCase().replace(/\s+/g, ' ') === t.toLowerCase().replace(/\s+/g, ' ')
    );
    if (!matched) return;

    // Lấy 2 TD kế tiếp = mua vào, bán ra
    const buyTd = td.nextElementSibling;
    const sellTd = buyTd ? buyTd.nextElementSibling : null;
    if (!buyTd || !sellTd) return;

    // Format giá: "143.400" hoặc "143,400" — dấu chấm/phẩy là separator hàng nghìn
    const buyRaw = buyTd.textContent.trim().replace(/[.,\s]/g, '');
    const sellRaw = sellTd.textContent.trim().replace(/[.,\s]/g, '');
    const buyThousand = parseInt(buyRaw, 10); // x1000đ/lượng
    const sellThousand = parseInt(sellRaw, 10);

    if (isNaN(buyThousand) || isNaN(sellThousand) || buyThousand < 100) return;

    // Chuyển x1000đ/lượng → VND/chỉ: × 1000 ÷ 10 = × 100
    rows.push({
      name: matched,
      buy: buyThousand * 100,
      sell: sellThousand * 100,
    });
    seen.add(name);
  });

  return rows;
}

// Alias backward compat
const parseDojiHtml = parseGoldHtml;

function matchGoldPrice(dojiRows, goldType) {
  const patterns = GOLD_PATTERNS[goldType] || GOLD_PATTERNS['SJC'];
  for (const pattern of patterns) {
    const match = dojiRows.find(row => pattern.test(row.name));
    if (match) return { buy: match.buy, sell: match.sell, matchedName: match.name };
  }
  return null;
}

/* ==========================================================================
   FOREX — tỷ giá ngoại tệ từ API chính chủ Vietcombank (JSON).

   Endpoint: GET https://www.vietcombank.com.vn/api/exchangerates?date=now
     → { Count, Date, UpdatedDate, Data: [ {currencyCode, currencyName,
         cash, transfer, sell, icon}, ... ] }
   (webgia.com trước đây render bảng bằng JS client-side nên proxy chỉ nhận
   được bảng rỗng — chuyển sang API chính chủ VCB cho đáng tin cậy.)

   Lấy giá "Mua chuyển khoản" = trường `transfer`. Hỗ trợ mọi mã VCB niêm
   yết: USD, EUR, GBP, JPY, AUD, CAD, SGD, CHF, CNY, KRW, THB, HKD, ...
   ========================================================================== */

const VCB_FOREX_URL = 'https://www.vietcombank.com.vn/api/exchangerates?date=now';

/**
 * Fetch tỷ giá Mua chuyển khoản của 1 mã ngoại tệ.
 * @param {string} currencyCode - Mã ngoại tệ (vd 'USD', 'EUR', 'JPY')
 */
async function fetchForexRate(currencyCode) {
  const { text } = await fetchViaProxy(VCB_FOREX_URL);
  return parseForexRate(text, currencyCode);
}

// Backward compat: giữ tên cũ
async function fetchUsdRate() {
  return fetchForexRate('USD');
}

/**
 * Parse tỷ giá 1 mã ngoại tệ từ JSON API Vietcombank.
 * @param {string} jsonText - response body của VCB_FOREX_URL
 * @param {string} currencyCode - mã cần lấy (vd 'USD', 'AUD')
 * Trả về { currency, buyTransfer, buyCash, sellCash, bank } hoặc null.
 * Giá trị trong API là chuỗi "25950.00" (VND/đơn-vị-tiền, thập phân dấu chấm).
 */
function parseForexRate(jsonText, currencyCode) {
  const target = (currencyCode || 'USD').toUpperCase();

  let json;
  try { json = JSON.parse(jsonText); }
  catch { return null; }

  const list = (json && Array.isArray(json.Data)) ? json.Data : [];
  const row = list.find(r => (r.currencyCode || '').toUpperCase() === target);
  if (!row) return null;

  const buyTransfer = parseVcbNumber(row.transfer);
  if (!(buyTransfer > 0)) return null;

  return {
    currency: target,
    buyTransfer,
    buyCash: parseVcbNumber(row.cash),
    sellCash: parseVcbNumber(row.sell),
    bank: 'Vietcombank',
  };
}

// Backward compat alias
const parseUsdRate = parseForexRate;

function parseVcbNumber(text) {
  if (text == null) return 0;
  // API trả "25950.00" (dấu chấm thập phân). Vẫn chịu được định dạng cũ
  // kiểu "26.125,00" (dấu chấm hàng nghìn + phẩy thập phân).
  const s = String(text).trim();
  const cleaned = s.includes(',') ? s.replace(/\./g, '').replace(',', '.') : s;
  const num = parseFloat(cleaned);
  return isNaN(num) ? 0 : num;
}

/* ==========================================================================
   FUND — gọi API fmarket.vn (JSON)
   ========================================================================== */

async function fetchFmarketFunds() {
  const body = JSON.stringify({
    types: ['NEW_FUND', 'TRADING_FUND'],
    issuerIds: [],
    sortOrder: 'DESC',
    sortField: 'navTo6Months',
    page: 1,
    pageSize: 100,
    isIpo: false,
    fundAssetTypes: [],
    bondRemainPeriods: [],
    searchField: '',
    isBuyByReward: false,
    thirdAppIds: [],
  });

  const { text } = await fetchViaProxy('https://api.fmarket.vn/res/products/filter', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });

  let data;
  try { data = JSON.parse(text); }
  catch {
    throw new Error('Fmarket API trả về không phải JSON: ' + text.slice(0, 200));
  }

  const rows = data?.data?.rows || [];
  return rows.map(r => ({
    shortName: (r.shortName || '').toUpperCase(),
    name: r.name,
    nav: Number(r.nav) || 0,
    navDate: r.navDate || null,
  }));
}

function matchFundNav(funds, code) {
  if (!code) return null;
  const upper = code.trim().toUpperCase();
  const match = funds.find(f => f.shortName === upper);
  if (!match) return null;
  return { nav: match.nav, name: match.name, navDate: match.navDate };
}

/* ==========================================================================
   MAIN UPDATE FLOW
   ========================================================================== */

async function updateAllPrices(onProgress = () => {}) {
  if (!hasProxy()) {
    throw new Error('Chưa cấu hình proxy Cloudflare Worker. Vào trang Phân tích để thêm.');
  }

  const entries = loadEntries();
  const fundEntries = entries.filter(e => e.type === 'fund');
  const goldEntries = entries.filter(e => e.type === 'gold');
  const usdEntries = entries.filter(e => e.type === 'usd');

  const summary = {
    fundOk: 0, fundFail: 0,
    goldOk: 0, goldFail: 0,
    usdOk: 0, usdFail: 0,
    errors: [],
  };

  // 1) GOLD
  if (goldEntries.length > 0) {
    onProgress(`Tải bảng giá vàng DOJI…`, 'info');
    let dojiRows = [];
    try {
      dojiRows = await fetchDojiGoldPrices();
      onProgress(`DOJI: nhận ${dojiRows.length} dòng giá`, 'ok');
    } catch (e) {
      onProgress(`DOJI thất bại: ${e.message}`, 'error');
      summary.errors.push('DOJI: ' + e.message);
      summary.goldFail = goldEntries.length;
    }

    if (dojiRows.length > 0) {
      for (const entry of goldEntries) {
        const priced = matchGoldPrice(dojiRows, entry.goldType);
        if (!priced) {
          onProgress(`✗ ${entry.name}: không tìm thấy loại "${entry.goldType}" trong DOJI`, 'warn');
          summary.goldFail++;
          continue;
        }
        // Persist qua updateEntry — đảm bảo updatedAt mới + push Supabase
        updateEntry(entry.id, {
          currentPrice: priced.buy,
          _lastMatched: priced.matchedName,
        });
        onProgress(`✓ ${entry.name}: ${formatMoney(priced.buy)} đ/chỉ (từ "${priced.matchedName}")`, 'ok');
        summary.goldOk++;
      }
    }
  }

  // 2) FUND
  if (fundEntries.length > 0) {
    onProgress(`Tải danh sách quỹ Fmarket…`, 'info');
    let funds = [];
    try {
      funds = await fetchFmarketFunds();
      onProgress(`Fmarket: nhận ${funds.length} quỹ`, 'ok');
    } catch (e) {
      onProgress(`Fmarket thất bại: ${e.message}`, 'error');
      summary.errors.push('Fmarket: ' + e.message);
      summary.fundFail = fundEntries.length;
    }

    if (funds.length > 0) {
      for (const entry of fundEntries) {
        const priced = matchFundNav(funds, entry.fundCode);
        if (!priced) {
          onProgress(`✗ ${entry.name}: không tìm thấy mã "${entry.fundCode}" trên Fmarket`, 'warn');
          summary.fundFail++;
          continue;
        }
        updateEntry(entry.id, {
          currentNav: priced.nav,
          _lastNavDate: priced.navDate,
        });
        onProgress(`✓ ${entry.fundCode}: NAV ${formatMoney(priced.nav)} đ (${priced.navDate || 'không rõ ngày'})`, 'ok');
        summary.fundOk++;
      }
    }
  }

  // 3) FOREX (API chính chủ Vietcombank) — hỗ trợ mọi loại ngoại tệ
  if (usdEntries.length > 0) {
    onProgress(`Tải tỷ giá ngoại tệ Vietcombank…`, 'info');
    let forexText = null;
    try {
      const fetched = await fetchViaProxy(VCB_FOREX_URL);
      forexText = fetched.text;
      onProgress(`VCB: nhận bảng tỷ giá`, 'ok');
    } catch (e) {
      onProgress(`Tỷ giá thất bại: ${e.message}`, 'error');
      summary.errors.push('Forex: ' + e.message);
      summary.usdFail = usdEntries.length;
    }

    if (forexText) {
      // Cache parse theo từng currency để khỏi parse lại cùng payload nhiều lần
      const rateCache = {};
      for (const entry of usdEntries) {
        const currency = (entry.currency || 'USD').toUpperCase();
        if (!(currency in rateCache)) {
          rateCache[currency] = parseForexRate(forexText, currency);
        }
        const rate = rateCache[currency];
        if (!rate) {
          onProgress(`✗ ${entry.name}: không tìm thấy ${currency} trong bảng VCB`, 'warn');
          summary.usdFail++;
          continue;
        }
        updateEntry(entry.id, {
          currentRate: rate.buyTransfer,
          _lastRateSource: `Vietcombank (${currency} Mua CK)`,
        });
        onProgress(`✓ ${entry.name}: ${formatMoney(rate.buyTransfer)} đ/${currency}`, 'ok');
        summary.usdOk++;
      }
    }
  }

  // Lưu price cache (timestamp + summary) — phòng trường hợp không có Supabase
  const cache = {
    lastUpdate: new Date().toISOString(),
    summary,
  };
  try { localStorage.setItem(PRICE_STORAGE_KEY, JSON.stringify(cache)); } catch {}

  return summary;
}

function getLastPriceUpdate() {
  try {
    const raw = localStorage.getItem(PRICE_STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch { return null; }
}
