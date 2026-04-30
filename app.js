/* ==========================================================================
   Portfolio Tracker — Core logic
   ========================================================================== */

const STORAGE_KEY = 'portfolio_entries_v1';

/* -------------------- Data layer --------------------
   Hỗ trợ tombstone: entry bị xoá có deleted=true,
   vẫn lưu lại để sync với Gist (sẽ cleanup sau TTL).
   - loadEntriesRaw / saveEntriesRaw: data thô, có tombstone
   - loadEntries / saveEntries: data đã filter, chỉ entry active
*/

function loadEntriesRaw() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch (e) {
    console.error('Failed to load entries:', e);
    return [];
  }
}

function saveEntriesRaw(entries) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
    // Trigger gist sync nếu đã cấu hình
    if (typeof schedulePushToGist === 'function') {
      schedulePushToGist();
    }
    return true;
  } catch (e) {
    console.error('Failed to save entries:', e);
    return false;
  }
}

function loadEntries() {
  // Trả về chỉ entries không bị xoá
  return loadEntriesRaw().filter(e => !e.deleted);
}

function saveEntries(entries) {
  // Khi save danh sách live, ghi đè raw nhưng giữ tombstones cũ
  const oldRaw = loadEntriesRaw();
  const tombstones = oldRaw.filter(e => e.deleted);
  const liveIds = new Set(entries.map(e => e.id));
  const keptTombstones = tombstones.filter(t => !liveIds.has(t.id));
  return saveEntriesRaw([...entries, ...keptTombstones]);
}

function addEntry(entry) {
  const raw = loadEntriesRaw();
  entry.id = 'e_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  entry.createdAt = new Date().toISOString();
  entry.updatedAt = entry.createdAt;
  raw.push(entry);
  saveEntriesRaw(raw);
  return entry;
}

function deleteEntry(id) {
  // Tombstone thay vì xoá hẳn — để sync với Gist biết entry này đã bị xoá
  const raw = loadEntriesRaw();
  const idx = raw.findIndex(e => e.id === id);
  if (idx === -1) return;
  raw[idx] = {
    id: raw[idx].id,
    createdAt: raw[idx].createdAt,
    updatedAt: new Date().toISOString(),
    deleted: true,
  };
  saveEntriesRaw(raw);
}

function getEntryById(id) {
  return loadEntries().find(e => e.id === id) || null;
}

/**
 * Cập nhật một entry đã có. Giữ nguyên id và createdAt,
 * thay thế các field khác bằng dữ liệu mới.
 */
function updateEntry(id, newData) {
  const raw = loadEntriesRaw();
  const idx = raw.findIndex(e => e.id === id);
  if (idx === -1) return null;
  // Merge: giữ id, createdAt; cho phép newData ghi đè mọi thứ khác
  const updated = {
    ...raw[idx],
    ...newData,
    id: raw[idx].id,
    createdAt: raw[idx].createdAt,
    updatedAt: new Date().toISOString(),
  };
  delete updated.deleted; // un-delete nếu đang là tombstone
  raw[idx] = updated;
  saveEntriesRaw(raw);
  return updated;
}

/* -------------------- Calculations -------------------- */

// For each entry, compute principal (vốn) and current value (giá trị hiện tại)
function computeEntryValues(entry) {
  const type = entry.type;
  let principal = 0;      // amount originally invested (VND)
  let currentValue = 0;   // current value (VND)

  if (type === 'deposit') {
    // Tiền gửi: principal = amount; currentValue = amount + estimated interest
    principal = Number(entry.amount) || 0;
    const rate = (Number(entry.rate) || 0) / 100;          // annual rate
    const term = Number(entry.termMonths) || 0;            // months
    // simple interest estimate for the locked term (pro-rata by elapsed time)
    const start = new Date(entry.startDate);
    const now = new Date();
    const monthsElapsed = Math.max(0, Math.min(term, monthsBetween(start, now)));
    const interest = principal * rate * (monthsElapsed / 12);
    currentValue = principal + interest;
  }
  else if (type === 'fund') {
    // Quỹ mở: principal = units * buyNav; currentValue = units * currentNav
    const units = Number(entry.units) || 0;
    const buyNav = Number(entry.buyNav) || 0;
    const currentNav = Number(entry.currentNav) || buyNav;
    principal = units * buyNav;
    currentValue = units * currentNav;
  }
  else if (type === 'gold') {
    // Vàng: principal = weight * buyPrice; currentValue = weight * currentPrice
    const weight = Number(entry.weight) || 0;
    const buyPrice = Number(entry.buyPrice) || 0;
    const currentPrice = Number(entry.currentPrice) || buyPrice;
    principal = weight * buyPrice;
    currentValue = weight * currentPrice;
  }
  else if (type === 'usd') {
    // USD: principal = usdAmount * buyRate (VND chi ra để mua USD)
    //      currentValue = usdAmount * currentRate (VND nếu bán USD bây giờ)
    const usdAmount = Number(entry.usdAmount) || 0;
    const buyRate = Number(entry.buyRate) || 0;
    const currentRate = Number(entry.currentRate) || buyRate;
    principal = usdAmount * buyRate;
    currentValue = usdAmount * currentRate;
  }

  return {
    principal,
    currentValue,
    gain: currentValue - principal,
    gainPct: principal > 0 ? ((currentValue - principal) / principal) * 100 : 0,
  };
}

function monthsBetween(d1, d2) {
  if (!d1 || !d2 || isNaN(d1) || isNaN(d2)) return 0;
  const years = d2.getFullYear() - d1.getFullYear();
  const months = d2.getMonth() - d1.getMonth();
  const days = d2.getDate() - d1.getDate();
  return years * 12 + months + days / 30;
}

// Portfolio aggregates
function computePortfolio(entries) {
  const byType = { deposit: [], fund: [], gold: [], usd: [] };
  entries.forEach(e => {
    if (byType[e.type]) byType[e.type].push(e);
  });

  const summary = {
    totalPrincipal: 0,
    totalValue: 0,
    totalGain: 0,
    totalGainPct: 0,
    byType: {},
    count: entries.length,
  };

  ['deposit', 'fund', 'gold', 'usd'].forEach(type => {
    let principal = 0, value = 0;
    byType[type].forEach(e => {
      const v = computeEntryValues(e);
      principal += v.principal;
      value += v.currentValue;
    });
    summary.byType[type] = {
      principal,
      value,
      gain: value - principal,
      gainPct: principal > 0 ? ((value - principal) / principal) * 100 : 0,
      count: byType[type].length,
      share: 0, // filled below
    };
    summary.totalPrincipal += principal;
    summary.totalValue += value;
  });

  summary.totalGain = summary.totalValue - summary.totalPrincipal;
  summary.totalGainPct = summary.totalPrincipal > 0
    ? (summary.totalGain / summary.totalPrincipal) * 100
    : 0;

  // Share per type (% of total current value)
  ['deposit', 'fund', 'gold', 'usd'].forEach(type => {
    summary.byType[type].share = summary.totalValue > 0
      ? (summary.byType[type].value / summary.totalValue) * 100
      : 0;
  });

  return summary;
}

/* -------------------- Formatting -------------------- */

function formatMoney(n, opts = {}) {
  const value = Number(n) || 0;
  const abs = Math.abs(value);
  const decimals = opts.decimals;
  let formatted;
  if (opts.compact && abs >= 1e9) {
    formatted = (value / 1e9).toFixed(2).replace(/\.00$/, '') + ' tỷ';
  } else if (opts.compact && abs >= 1e6) {
    formatted = (value / 1e6).toFixed(1).replace(/\.0$/, '') + ' tr';
  } else if (typeof decimals === 'number') {
    formatted = new Intl.NumberFormat('vi-VN', {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    }).format(value);
  } else {
    formatted = new Intl.NumberFormat('vi-VN', {
      maximumFractionDigits: 0,
    }).format(Math.round(value));
  }
  return formatted;
}

function formatPct(n, withSign = true) {
  const value = Number(n) || 0;
  const sign = withSign && value > 0 ? '+' : '';
  return sign + value.toFixed(2) + '%';
}

function formatDate(iso) {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    return d.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' });
  } catch { return iso; }
}

function typeLabel(type) {
  return {
    deposit: 'Tiền gửi',
    fund: 'Quỹ mở',
    gold: 'Vàng',
    usd: 'USD',
  }[type] || type;
}

/* -------------------- UI helpers -------------------- */

function toast(msg) {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 2400);
}

function updateMastheadDate() {
  const el = document.getElementById('masthead-date');
  if (!el) return;
  const now = new Date();
  const months = ['Tháng 1','Tháng 2','Tháng 3','Tháng 4','Tháng 5','Tháng 6',
                  'Tháng 7','Tháng 8','Tháng 9','Tháng 10','Tháng 11','Tháng 12'];
  el.textContent = `${now.getDate()} ${months[now.getMonth()]} ${now.getFullYear()}`;
}

// Run on every page
document.addEventListener('DOMContentLoaded', updateMastheadDate);
