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
   Tên loại vàng trên giavang.org/trong-nuoc/doji (data DOJI):
     - "SJC Lẻ"
     - "AVPL" (Kim TT)
     - "Nhẫn tròn 999 Hưng Thịnh Vượng"
     - "Nữ trang 99.99"
     - "Nữ trang 99.9"
     - "Nữ trang 99"                                                    */

const GOLD_PATTERNS = {
  'SJC':   [/SJC\s*L[ẻe]/i, /^SJC\b/im],
  '9999':  [/Nh[ẫẫậ]n\s+tr[òoó]n\s+999/i, /H[ưưừ]ng\s*Th[ịị]nh/i],
  '24k':   [/N[ữữ]\s+trang\s+99[\.,]99/i],
  '18k':   [/N[ữữ]\s+trang\s+99[\.,]9(?![\.,\d])/i],
  'other': [/N[ữữ]\s+trang\s+99(?![\.,\d])/i],
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

/** Test proxy — gọi thử tới webgia.com */
async function testProxy() {
  const { text } = await fetchViaProxy('https://giavang.org/trong-nuoc/doji/');
  const rows = parseGoldHtml(text);
  if (rows.length === 0) throw new Error('Proxy OK nhưng không parse được HTML bảng giá.');
  return { rowCount: rows.length, sampleName: rows[0].name };
}

/* ==========================================================================
   GOLD — scrape webgia.com/gia-vang/doji (data từ DOJI)
   GOLD — scrape giavang.org/trong-nuoc/doji (data từ DOJI)
   Đơn vị nguồn: x1000đ/lượng → convert sang VND/chỉ (× 100).
   1 lượng = 10 chỉ; nhân 1000 rồi chia 10 = nhân 100.
   ========================================================================== */

async function fetchDojiGoldPrices() {
  const { text: html } = await fetchViaProxy('https://giavang.org/trong-nuoc/doji/');
  return parseGoldHtml(html);
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
   FOREX — tỷ giá ngoại tệ Vietcombank qua webgia.com
   Lấy giá "Mua chuyển khoản" (cột 4 trong bảng webgia VCB).
   Hỗ trợ mọi mã ngoại tệ có trên Vietcombank: USD, EUR, GBP, JPY, AUD,
   CAD, SGD, CHF, CNY, KRW, THB, HKD, NZD, ...
   ========================================================================== */

/**
 * Fetch tỷ giá Mua chuyển khoản của 1 mã ngoại tệ.
 * @param {string} currencyCode - Mã ngoại tệ (vd 'USD', 'EUR', 'JPY')
 */
async function fetchForexRate(currencyCode) {
  const { text: html } = await fetchViaProxy('https://webgia.com/ty-gia/vietcombank/');
  return parseForexRate(html, currencyCode);
}

// Backward compat: giữ tên cũ
async function fetchUsdRate() {
  return fetchForexRate('USD');
}

/**
 * Parse 1 dòng ngoại tệ cụ thể trong bảng tỷ giá Vietcombank từ webgia.
 * Format: <tr> có 5 <td>: [Mã, Tên, Mua TM, Mua CK, Bán TM]
 */
function parseForexRate(html, currencyCode) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  const target = (currencyCode || 'USD').toUpperCase();

  const trs = doc.querySelectorAll('tr');
  for (const tr of trs) {
    const tds = tr.querySelectorAll('td');
    if (tds.length !== 5) continue;

    const code = tds[0].textContent.trim().toUpperCase();
    if (code !== target) continue;

    // Cột 4 (index 3) = Mua chuyển khoản
    const buyTransferRaw = tds[3].textContent.trim();
    // Format kiểu "26.125,00" — dấu chấm là hàng nghìn, dấu phẩy là thập phân
    const cleaned = buyTransferRaw.replace(/\./g, '').replace(',', '.');
    const rate = parseFloat(cleaned);

    if (isNaN(rate) || rate <= 0) continue;

    return {
      currency: target,
      buyTransfer: rate,
      buyCash: parseVcbNumber(tds[2].textContent.trim()),
      sellCash: parseVcbNumber(tds[4].textContent.trim()),
      bank: 'Vietcombank',
    };
  }

  return null;
}

// Backward compat alias
const parseUsdRate = parseForexRate;

function parseVcbNumber(text) {
  const cleaned = text.replace(/\./g, '').replace(',', '.');
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

  // 3) FOREX (Vietcombank qua webgia) — hỗ trợ mọi loại ngoại tệ
  if (usdEntries.length > 0) {
    onProgress(`Tải tỷ giá ngoại tệ Vietcombank…`, 'info');
    let html = null;
    try {
      const fetched = await fetchViaProxy('https://webgia.com/ty-gia/vietcombank/');
      html = fetched.text;
      onProgress(`VCB: nhận bảng tỷ giá`, 'ok');
    } catch (e) {
      onProgress(`Tỷ giá thất bại: ${e.message}`, 'error');
      summary.errors.push('Forex: ' + e.message);
      summary.usdFail = usdEntries.length;
    }

    if (html) {
      // Cache parse theo từng currency để khỏi parse lại cùng HTML nhiều lần
      const rateCache = {};
      for (const entry of usdEntries) {
        const currency = (entry.currency || 'USD').toUpperCase();
        if (!(currency in rateCache)) {
          rateCache[currency] = parseForexRate(html, currency);
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
