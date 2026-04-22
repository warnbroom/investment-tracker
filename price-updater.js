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
   Tên loại vàng trên webgia.com/gia-vang/doji (data từ DOJI):
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
  const { text } = await fetchViaProxy('https://webgia.com/gia-vang/doji/');
  const rows = parseGoldHtml(text);
  if (rows.length === 0) throw new Error('Proxy OK nhưng không parse được HTML bảng giá.');
  return { rowCount: rows.length, sampleName: rows[0].name };
}

/* ==========================================================================
   GOLD — scrape webgia.com/gia-vang/doji (data từ DOJI)
   Dùng webgia vì giavang.doji.vn chặn datacenter IPs của Cloudflare.
   Webgia cung cấp CÙNG data từ DOJI, chỉ khác đường vào.
   ========================================================================== */

async function fetchDojiGoldPrices() {
  const { text: html } = await fetchViaProxy('https://webgia.com/gia-vang/doji/');
  return parseGoldHtml(html);
}

/**
 * Parse HTML bảng giá webgia.
 * Format: <tr> có 7 <td>: [Tên, HàNội mua, HàNội bán, ĐàNẵng mua,
 * ĐàNẵng bán, TPHCM mua, TPHCM bán]. Giá đã ở VND/chỉ.
 * Lấy giá Hà Nội (cột 2 = mua, cột 3 = bán).
 */
function parseGoldHtml(html) {
  const rows = [];
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');

  const trs = doc.querySelectorAll('tr');
  trs.forEach(tr => {
    const tds = tr.querySelectorAll('td');
    if (tds.length !== 7) return;
    const name = tds[0].textContent.trim();
    if (!name || name.toLowerCase().includes('mua vào')) return; // skip header

    const buyRaw = tds[1].textContent.trim().replace(/[.,\s]/g, '');
    const sellRaw = tds[2].textContent.trim().replace(/[.,\s]/g, '');
    const buy = parseInt(buyRaw, 10);
    const sell = parseInt(sellRaw, 10);
    if (isNaN(buy) || isNaN(sell) || buy < 1000000) return; // giá > 1tr/chỉ

    rows.push({ name, buy, sell });
  });

  return rows;
}

// Alias
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
   USD — tỷ giá Vietcombank qua webgia.com
   Lấy giá "Mua chuyển khoản" (cột thứ 4 trong bảng webgia VCB).
   ========================================================================== */

async function fetchUsdRate() {
  const { text: html } = await fetchViaProxy('https://webgia.com/ty-gia/vietcombank/');
  return parseUsdRate(html);
}

/**
 * Parse bảng tỷ giá Vietcombank từ webgia.
 * Format: <tr> có 5 <td>: [Mã, Tên, Mua TM, Mua CK, Bán TM]
 * Tìm dòng USD, lấy cột 4 (index 3) = Mua chuyển khoản.
 */
function parseUsdRate(html) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');

  const trs = doc.querySelectorAll('tr');
  for (const tr of trs) {
    const tds = tr.querySelectorAll('td');
    if (tds.length !== 5) continue;

    const code = tds[0].textContent.trim().toUpperCase();
    if (code !== 'USD') continue;

    // Cột 4 (index 3) = Mua chuyển khoản
    const buyTransferRaw = tds[3].textContent.trim();
    // Format kiểu "26.125,00" — dấu chấm là hàng nghìn, dấu phẩy là thập phân
    const cleaned = buyTransferRaw.replace(/\./g, '').replace(',', '.');
    const rate = parseFloat(cleaned);

    if (isNaN(rate) || rate < 10000) continue; // USD phải > 10k VND

    return {
      buyTransfer: Math.round(rate),
      buyCash: parseVcbNumber(tds[2].textContent.trim()),
      sellCash: parseVcbNumber(tds[4].textContent.trim()),
      bank: 'Vietcombank',
    };
  }

  return null;
}

function parseVcbNumber(text) {
  const cleaned = text.replace(/\./g, '').replace(',', '.');
  const num = parseFloat(cleaned);
  return isNaN(num) ? 0 : Math.round(num);
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
        entry.currentPrice = priced.buy;
        entry._lastMatched = priced.matchedName;
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
        entry.currentNav = priced.nav;
        entry._lastNavDate = priced.navDate;
        onProgress(`✓ ${entry.fundCode}: NAV ${formatMoney(priced.nav)} đ (${priced.navDate || 'không rõ ngày'})`, 'ok');
        summary.fundOk++;
      }
    }
  }

  // 3) USD (Vietcombank qua webgia)
  if (usdEntries.length > 0) {
    onProgress(`Tải tỷ giá USD Vietcombank…`, 'info');
    let usdData = null;
    try {
      usdData = await fetchUsdRate();
      if (!usdData) throw new Error('Không tìm thấy dòng USD trong bảng tỷ giá.');
      onProgress(`VCB: USD mua chuyển khoản = ${formatMoney(usdData.buyTransfer)} đ`, 'ok');
    } catch (e) {
      onProgress(`USD thất bại: ${e.message}`, 'error');
      summary.errors.push('USD: ' + e.message);
      summary.usdFail = usdEntries.length;
    }

    if (usdData) {
      for (const entry of usdEntries) {
        entry.currentRate = usdData.buyTransfer;
        entry._lastRateSource = 'Vietcombank (Mua CK)';
        onProgress(`✓ ${entry.name}: ${formatMoney(usdData.buyTransfer)} đ/USD`, 'ok');
        summary.usdOk++;
      }
    }
  }

  saveEntries(entries);

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
