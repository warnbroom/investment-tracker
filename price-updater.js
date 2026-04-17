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

/* -------- GOLD TYPE MAPPING -------- */

const DOJI_GOLD_PATTERNS = {
  'SJC':   [/SJC\s*-?\s*B[áa]n\s*L[ẻe]/i, /^SJC\b/im],
  '9999':  [/NH[ẪẪẬ]N\s+TR[ÒOÓ]N\s+9999/i, /9999.*H[ƯƯỪ]NG\s*TH[ỊỊ]NH/i],
  '24k':   [/N[ữữ]\s+trang\s+99[\.,]99/i, /99[\.,]99\s*-?\s*B[áa]n\s*L[ẻe]/i],
  '18k':   [/N[ữữ]\s+trang\s+99[\.,]9\s*-/i, /99[\.,]9\s*-?\s*B[áa]n\s*L[ẻe]/i],
  'other': [/N[ữữ]\s+trang\s+99\s*-/i],
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

/** Test proxy — gọi thử tới DOJI */
async function testProxy() {
  const { text } = await fetchViaProxy('https://giavang.doji.vn/');
  const rows = parseDojiHtml(text);
  if (rows.length === 0) throw new Error('Proxy OK nhưng không parse được HTML DOJI.');
  return { rowCount: rows.length, sampleName: rows[0].name };
}

/* ==========================================================================
   GOLD — scrape giavang.doji.vn
   ========================================================================== */

async function fetchDojiGoldPrices() {
  const { text: html } = await fetchViaProxy('https://giavang.doji.vn/');
  return parseDojiHtml(html);
}

function parseDojiHtml(html) {
  const rows = [];
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');

  const trs = doc.querySelectorAll('tr');
  trs.forEach(tr => {
    const tds = tr.querySelectorAll('td');
    if (tds.length !== 3) return;
    const name = tds[0].textContent.trim();
    const buyRaw = tds[1].textContent.trim().replace(/[.,\s]/g, '');
    const sellRaw = tds[2].textContent.trim().replace(/[.,\s]/g, '');
    const buy = parseInt(buyRaw, 10);
    const sell = parseInt(sellRaw, 10);
    if (!name || isNaN(buy) || isNaN(sell) || buy < 100) return;
    rows.push({
      name,
      buy: buy * 1000,   // DOJI: nghìn/chỉ → VND/chỉ
      sell: sell * 1000,
    });
  });

  return rows;
}

function matchGoldPrice(dojiRows, goldType) {
  const patterns = DOJI_GOLD_PATTERNS[goldType] || DOJI_GOLD_PATTERNS['SJC'];
  for (const pattern of patterns) {
    const match = dojiRows.find(row => pattern.test(row.name));
    if (match) return { buy: match.buy, sell: match.sell, matchedName: match.name };
  }
  return null;
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

  const summary = {
    fundOk: 0, fundFail: 0,
    goldOk: 0, goldFail: 0,
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
