/* ==========================================================================
   Portfolio Tracker — Price Updater
   Scrape giá vàng từ giavang.doji.vn và NAV quỹ mở từ fmarket.vn
   Chạy qua CORS proxy công cộng (có fallback giữa nhiều proxy)
   ========================================================================== */

const PRICE_STORAGE_KEY = 'portfolio_price_cache_v1';

/* -------- CORS proxy fallback chain --------
   Mỗi proxy được thử theo thứ tự. Nếu bạn tự host CF Worker,
   thêm URL của bạn lên đầu danh sách này.                             */
const PROXY_CHAIN = [
  {
    name: 'corsproxy.io',
    wrap: (url) => `https://corsproxy.io/?url=${encodeURIComponent(url)}`,
    supportsPost: true,
  },
  {
    name: 'allorigins',
    wrap: (url) => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
    supportsPost: false, // allorigins chỉ GET
  },
  {
    name: 'codetabs',
    wrap: (url) => `https://api.codetabs.com/v1/proxy/?quest=${encodeURIComponent(url)}`,
    supportsPost: false,
  },
];

/* -------- GOLD TYPE MAPPING --------
   Map loại vàng trong sổ cái → regex để tìm trong HTML DOJI.
   Bảng DOJI có các dòng:
     - "SJC - Bán Lẻ"           → cho loại SJC
     - "NHẪN TRÒN 9999 HƯNG THỊNH VƯỢNG" → cho nhẫn 9999
     - "Nữ trang 99.99 - Bán Lẻ" → cho nữ trang 24k
     - "Nữ trang 99.9 - Bán Lẻ"  → cho vàng tây cao cấp
     - "Nữ trang 99 - Bán Lẻ"    → cho nữ trang thường
   Đơn vị DOJI: nghìn đồng / chỉ (giá hiển thị 16770 = 16.770.000 đ/chỉ)
*/
const DOJI_GOLD_PATTERNS = {
  // goldType trong sổ cái → mảng regex fallback (thử lần lượt)
  'SJC':   [/SJC\s*-?\s*B[áa]n\s*L[ẻe]/i, /^SJC\b/im],
  '9999':  [/NH[ẪẪẬ]N\s+TR[ÒOÓ]N\s+9999/i, /9999.*H[ƯƯỪ]NG\s*TH[ỊỊ]NH/i],
  '24k':   [/N[ữữ]\s+trang\s+99[\.,]99/i, /99[\.,]99\s*-?\s*B[áa]n\s*L[ẻe]/i],
  '18k':   [/N[ữữ]\s+trang\s+99[\.,]9\s*-/i, /99[\.,]9\s*-?\s*B[áa]n\s*L[ẻe]/i], // 99.9 (không phải 99.99)
  'other': [/N[ữữ]\s+trang\s+99\s*-/i],
};

/* -------- FETCH VIA PROXY CHAIN -------- */

async function fetchViaProxy(targetUrl, options = {}) {
  const errors = [];
  const needsPost = options.method === 'POST';

  for (const proxy of PROXY_CHAIN) {
    if (needsPost && !proxy.supportsPost) continue;
    try {
      const proxiedUrl = proxy.wrap(targetUrl);
      const res = await fetch(proxiedUrl, {
        method: options.method || 'GET',
        headers: options.headers || {},
        body: options.body,
      });
      if (!res.ok) {
        errors.push(`${proxy.name}: HTTP ${res.status}`);
        continue;
      }
      const text = await res.text();
      return { text, proxy: proxy.name };
    } catch (e) {
      errors.push(`${proxy.name}: ${e.message}`);
    }
  }
  throw new Error('Tất cả CORS proxy đều fail. Chi tiết: ' + errors.join(' | '));
}

/* ==========================================================================
   GOLD — scrape giavang.doji.vn
   ========================================================================== */

async function fetchDojiGoldPrices() {
  const { text: html } = await fetchViaProxy('https://giavang.doji.vn/');
  return parseDojiHtml(html);
}

/**
 * Parse HTML DOJI để lấy tất cả cặp (tên loại, giá mua, giá bán).
 * HTML DOJI có dạng bảng với các <tr> chứa 3 <td>: tên | mua | bán
 * Trả về mảng: [{ name, buy, sell }] — giá đã nhân 1000 (ra VND/chỉ thực)
 */
function parseDojiHtml(html) {
  const rows = [];
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');

  // Tìm tất cả <tr> có đúng 3 <td> (bảng giá)
  const trs = doc.querySelectorAll('tr');
  trs.forEach(tr => {
    const tds = tr.querySelectorAll('td');
    if (tds.length !== 3) return;
    const name = tds[0].textContent.trim();
    const buyRaw = tds[1].textContent.trim().replace(/[.,\s]/g, '');
    const sellRaw = tds[2].textContent.trim().replace(/[.,\s]/g, '');
    const buy = parseInt(buyRaw, 10);
    const sell = parseInt(sellRaw, 10);
    if (!name || isNaN(buy) || isNaN(sell) || buy < 100) return; // skip header rows
    rows.push({
      name,
      buy: buy * 1000,   // DOJI đơn vị: nghìn / chỉ → VND / chỉ
      sell: sell * 1000,
    });
  });

  return rows;
}

/**
 * Tìm giá khớp với loại vàng trong sổ cái.
 * @param {Array} dojiRows  - parsed từ parseDojiHtml
 * @param {string} goldType - giá trị goldType trong entry (SJC, 9999, 24k, 18k, other)
 * @returns {Object|null}   - { buy, sell, matchedName } hoặc null
 */
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
   Endpoint public: POST https://api.fmarket.vn/res/products/filter
   Trả về danh sách tất cả quỹ với field `nav` và `shortName`
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
  catch (e) { throw new Error('Fmarket API trả về không phải JSON: ' + text.slice(0, 200)); }

  const rows = data?.data?.rows || [];
  // Mỗi row: { shortName, name, nav, navDate, ... }
  return rows.map(r => ({
    shortName: (r.shortName || '').toUpperCase(),
    name: r.name,
    nav: Number(r.nav) || 0,
    navDate: r.navDate || null,
  }));
}

/**
 * Tìm NAV của 1 quỹ theo mã
 * @param {Array} funds - parsed từ fetchFmarketFunds
 * @param {string} code - mã quỹ (VESAF, DCDS,...)
 */
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

/**
 * Cập nhật giá cho tất cả entry fund + gold.
 * Báo tiến trình qua callback onProgress(msg, kind).
 * kind: 'info' | 'ok' | 'warn' | 'error'
 */
async function updateAllPrices(onProgress = () => {}) {
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
        // DOJI trả giá theo chỉ. Dùng giá MUA VÀO (giá cửa hàng mua từ khách
        // = giá khách có thể bán được — realistic cho định giá tài sản)
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

  // Save back all entries
  saveEntries(entries);

  // Save last-update timestamp
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
