/**
 * gist-sync.js — đồng bộ dữ liệu Sổ Cái với GitHub Gist
 *
 * Dùng GitHub Personal Access Token (scope: gist) để PATCH/GET
 * một gist private chứa file `portfolio.json`.
 *
 * Mô hình: AUTO-SYNC 2 chiều, last-write-wins theo updatedAt từng entry.
 * - Load page → mergeFromGist() → merge entry-by-entry theo updatedAt
 * - Save entry → debounce 2s → pushToGist()
 * - Tombstone cho entries đã xoá (deleted: true)
 *
 * Token và Gist ID lưu localStorage. Token KHÔNG được commit vào source.
 */

const GIST_TOKEN_KEY = 'portfolio_gist_token_v1';
const GIST_ID_KEY = 'portfolio_gist_id_v1';
const GIST_LAST_SYNC_KEY = 'portfolio_gist_last_sync_v1';
const GIST_FILENAME = 'portfolio.json';

const PUSH_DEBOUNCE_MS = 2000; // Đợi 2s sau lần thay đổi cuối rồi mới push
const TOMBSTONE_TTL_DAYS = 30;

let pushTimer = null;
let isPushing = false;
let pushQueued = false;
let syncStatusListeners = [];

/* ==========================================================================
   Token & Gist ID storage
   ========================================================================== */

function getGistToken() {
  try { return localStorage.getItem(GIST_TOKEN_KEY) || ''; }
  catch { return ''; }
}

function setGistToken(token) {
  if (token && token.trim()) {
    localStorage.setItem(GIST_TOKEN_KEY, token.trim());
  } else {
    localStorage.removeItem(GIST_TOKEN_KEY);
  }
}

function getGistId() {
  try { return localStorage.getItem(GIST_ID_KEY) || ''; }
  catch { return ''; }
}

function setGistId(id) {
  if (id) localStorage.setItem(GIST_ID_KEY, id);
  else localStorage.removeItem(GIST_ID_KEY);
}

function hasGistConfig() {
  return !!getGistToken() && !!getGistId();
}

function getLastSyncTime() {
  try { return localStorage.getItem(GIST_LAST_SYNC_KEY) || ''; }
  catch { return ''; }
}

function setLastSyncTime(iso) {
  localStorage.setItem(GIST_LAST_SYNC_KEY, iso);
}

/* ==========================================================================
   Sync status events
   ========================================================================== */

function onSyncStatus(fn) { syncStatusListeners.push(fn); }
function emitSyncStatus(status, detail) {
  syncStatusListeners.forEach(fn => {
    try { fn(status, detail); } catch (e) { console.error(e); }
  });
}

/* ==========================================================================
   GitHub Gist API
   ========================================================================== */

async function gistApiRequest(path, options = {}) {
  const token = getGistToken();
  if (!token) throw new Error('Chưa có Gist token. Cấu hình ở trang Phân tích.');

  const url = 'https://api.github.com' + path;
  const headers = {
    'Accept': 'application/vnd.github+json',
    'Authorization': 'Bearer ' + token,
    'X-GitHub-Api-Version': '2022-11-28',
    ...(options.headers || {}),
  };
  if (options.body) headers['Content-Type'] = 'application/json';

  const res = await fetch(url, {
    method: options.method || 'GET',
    headers,
    body: options.body,
  });

  if (!res.ok) {
    let errMsg = `HTTP ${res.status}`;
    try {
      const err = await res.json();
      if (err.message) errMsg += ': ' + err.message;
    } catch {}
    if (res.status === 401) errMsg = 'Token không hợp lệ hoặc thiếu scope `gist`';
    if (res.status === 404) errMsg = 'Không tìm thấy gist (có thể đã bị xoá)';
    throw new Error(errMsg);
  }

  return res.json();
}

/** Test token bằng cách gọi /user và /gists để verify quyền */
async function testGistToken(token) {
  // 1) Verify token hợp lệ qua /user
  const userRes = await fetch('https://api.github.com/user', {
    headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/vnd.github+json' },
  });
  if (!userRes.ok) {
    if (userRes.status === 401) throw new Error('Token không hợp lệ');
    throw new Error('HTTP ' + userRes.status + ' khi xác thực token');
  }
  const user = await userRes.json();

  // 2) Verify quyền gist
  // - Classic PAT: trả về header X-OAuth-Scopes
  // - Fine-grained PAT: KHÔNG trả về header này, phải test bằng cách gọi /gists thật
  const scopesHeader = userRes.headers.get('X-OAuth-Scopes');
  if (scopesHeader !== null) {
    // Classic PAT → check scope qua header
    const scopes = scopesHeader.split(',').map(s => s.trim());
    if (!scopes.includes('gist')) {
      throw new Error('Token Classic thiếu scope "gist". Vào GitHub Settings → Tokens, edit token và tick "gist".');
    }
  } else {
    // Fine-grained PAT → thử gọi GET /gists để verify quyền read
    const gistsRes = await fetch('https://api.github.com/gists?per_page=1', {
      headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/vnd.github+json' },
    });
    if (gistsRes.status === 401 || gistsRes.status === 403 || gistsRes.status === 404) {
      throw new Error('Token Fine-grained không có quyền Gists. Vào GitHub Settings → Fine-grained tokens, edit token và bật "Account permissions → Gists: Read and write".');
    }
    if (!gistsRes.ok) {
      throw new Error('Không kiểm tra được quyền Gist (HTTP ' + gistsRes.status + ')');
    }
  }

  return { login: user.login, type: scopesHeader !== null ? 'classic' : 'fine-grained' };
}

/** Tạo gist mới với data hiện tại */
async function createGist(initialData) {
  const body = JSON.stringify({
    description: 'Sổ Cái — Portfolio Tracker Data (auto-managed)',
    public: false,
    files: {
      [GIST_FILENAME]: {
        content: JSON.stringify(initialData, null, 2),
      },
    },
  });
  const result = await gistApiRequest('/gists', { method: 'POST', body });
  setGistId(result.id);
  return result;
}

/** Lấy nội dung gist hiện tại */
async function fetchGistData() {
  const id = getGistId();
  if (!id) throw new Error('Chưa có gist ID');
  const gist = await gistApiRequest('/gists/' + id);
  const file = gist.files && gist.files[GIST_FILENAME];
  if (!file) throw new Error(`Gist không có file ${GIST_FILENAME}`);
  // Nếu file lớn (>1MB), GitHub trả raw_url thay vì content
  let content = file.content;
  if (file.truncated && file.raw_url) {
    const res = await fetch(file.raw_url);
    content = await res.text();
  }
  try {
    return JSON.parse(content);
  } catch (e) {
    throw new Error('Gist content không phải JSON hợp lệ: ' + e.message);
  }
}

/** Cập nhật gist (PATCH) */
async function updateGist(data) {
  const id = getGistId();
  if (!id) throw new Error('Chưa có gist ID');
  const body = JSON.stringify({
    files: {
      [GIST_FILENAME]: {
        content: JSON.stringify(data, null, 2),
      },
    },
  });
  return gistApiRequest('/gists/' + id, { method: 'PATCH', body });
}

/* ==========================================================================
   Merge logic — last-write-wins per entry
   ========================================================================== */

/**
 * Merge 2 list entries theo updatedAt (hoặc createdAt nếu không có updatedAt).
 * Dùng "tombstone" để xử lý xoá: entry bị xoá có deleted=true, vẫn giữ trong list
 * cho đến khi cleanup theo TTL.
 *
 * Trả về { merged, changed } — changed = true nếu kết quả khác local.
 */
function mergeEntries(localEntries, remoteEntries) {
  const map = new Map();

  // Index local
  localEntries.forEach(e => {
    map.set(e.id, { ...e, _source: 'local' });
  });

  // Merge remote
  remoteEntries.forEach(re => {
    const local = map.get(re.id);
    if (!local) {
      // Chỉ có ở remote
      map.set(re.id, { ...re, _source: 'remote' });
      return;
    }
    const localTime = new Date(local.updatedAt || local.createdAt || 0).getTime();
    const remoteTime = new Date(re.updatedAt || re.createdAt || 0).getTime();
    if (remoteTime > localTime) {
      map.set(re.id, { ...re, _source: 'remote' });
    }
    // Nếu local mới hơn → giữ local (đã có trong map)
  });

  // Cleanup tombstone cũ
  const tombstoneCutoff = Date.now() - TOMBSTONE_TTL_DAYS * 24 * 3600 * 1000;
  const merged = [];
  map.forEach(e => {
    if (e.deleted) {
      const t = new Date(e.updatedAt || e.createdAt || 0).getTime();
      if (t < tombstoneCutoff) return; // skip — quá cũ, cleanup
    }
    delete e._source;
    merged.push(e);
  });

  // Detect changed: số lượng khác hoặc bất kỳ entry nào có updatedAt khác local
  let changed = merged.length !== localEntries.length;
  if (!changed) {
    const localById = new Map(localEntries.map(e => [e.id, e]));
    for (const me of merged) {
      const le = localById.get(me.id);
      if (!le || (le.updatedAt || le.createdAt) !== (me.updatedAt || me.createdAt)) {
        changed = true;
        break;
      }
    }
  }

  return { merged, changed };
}

/* ==========================================================================
   Public sync API
   ========================================================================== */

/**
 * Pull từ gist + merge với local. Gọi khi load page hoặc manual refresh.
 * Returns: { success, merged, changes: {added, updated, deleted} }
 */
async function syncFromGist() {
  if (!hasGistConfig()) return { success: false, reason: 'no_config' };
  emitSyncStatus('syncing', 'Đang tải từ Gist…');

  try {
    const remoteData = await fetchGistData();
    const remoteEntries = (remoteData.entries || []);

    // Loại tombstone đã ngầm trong loadEntries() trả về (vì localStorage cũng có thể lưu deleted=true)
    const localRaw = loadEntriesRaw();
    const { merged, changed } = mergeEntries(localRaw, remoteEntries);

    if (changed) {
      saveEntriesRaw(merged);
    }

    // Cũng merge price cache (lấy cái mới hơn)
    if (remoteData.priceCache) {
      const localCache = getLastPriceUpdate();
      const remoteTime = new Date(remoteData.priceCache.lastUpdate || 0).getTime();
      const localTime = new Date(localCache?.lastUpdate || 0).getTime();
      if (remoteTime > localTime) {
        try { localStorage.setItem('portfolio_price_cache_v1', JSON.stringify(remoteData.priceCache)); } catch {}
      }
    }

    setLastSyncTime(new Date().toISOString());
    emitSyncStatus('synced', `Đã đồng bộ`);
    return { success: true, changed };
  } catch (e) {
    emitSyncStatus('error', e.message);
    console.error('[Gist sync] Pull failed:', e);
    return { success: false, error: e.message };
  }
}

/**
 * Push local lên gist. Debounced để tránh spam API.
 */
function schedulePushToGist() {
  if (!hasGistConfig()) return;
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    pushTimer = null;
    pushToGistNow();
  }, PUSH_DEBOUNCE_MS);
}

async function pushToGistNow() {
  if (!hasGistConfig()) return;
  if (isPushing) {
    pushQueued = true;
    return;
  }

  isPushing = true;
  emitSyncStatus('syncing', 'Đang lưu lên Gist…');

  try {
    const data = {
      entries: loadEntriesRaw(),
      priceCache: getLastPriceUpdate() || null,
      lastSync: new Date().toISOString(),
    };
    await updateGist(data);
    setLastSyncTime(new Date().toISOString());
    emitSyncStatus('synced', 'Đã đồng bộ');
  } catch (e) {
    emitSyncStatus('error', e.message);
    console.error('[Gist sync] Push failed:', e);
  } finally {
    isPushing = false;
    if (pushQueued) {
      pushQueued = false;
      schedulePushToGist();
    }
  }
}

/* ==========================================================================
   Setup helper — dùng từ trang Phân tích
   ========================================================================== */

/**
 * Setup gist mới: test token, tạo gist private, lưu config.
 */
async function setupGist(token) {
  // Validate token
  const userInfo = await testGistToken(token);

  // Save token tạm để createGist có thể dùng
  setGistToken(token);

  // Tạo gist mới với data hiện tại
  const initialData = {
    entries: loadEntriesRaw(),
    priceCache: getLastPriceUpdate() || null,
    lastSync: new Date().toISOString(),
  };
  let gist;
  try {
    gist = await createGist(initialData);
  } catch (e) {
    // Nếu fail (thường vì fine-grained PAT chỉ có read), xoá token đã lưu để giữ state sạch
    setGistToken('');
    if (e.message && e.message.includes('403')) {
      throw new Error('Token có thể đọc Gist nhưng không có quyền tạo. Đảm bảo Fine-grained PAT có "Gists: Read and write" (không phải Read-only).');
    }
    throw e;
  }
  setLastSyncTime(new Date().toISOString());

  return { user: userInfo.login, gistId: gist.id, gistUrl: gist.html_url, tokenType: userInfo.type };
}

/**
 * Disconnect: xoá token và gist ID khỏi local (gist trên GitHub vẫn còn).
 */
function disconnectGist() {
  setGistToken('');
  setGistId('');
  localStorage.removeItem(GIST_LAST_SYNC_KEY);
}

/**
 * Liên kết với gist đã tồn tại (advanced — user paste gist ID).
 */
async function linkExistingGist(token, gistId) {
  setGistToken(token);
  setGistId(gistId);
  // Test bằng cách fetch
  const data = await fetchGistData();
  return data;
}

/* ==========================================================================
   Auto-pull on page load
   ========================================================================== */

/**
 * Tự động pull khi load trang nếu có config.
 * Gọi sau khi DOM sẵn sàng. Nếu data thay đổi → emit event để UI re-render.
 */
async function autoPullOnLoad() {
  if (!hasGistConfig()) return null;

  // Throttle: chỉ auto-pull nếu lần sync cuối > 30s trước
  const lastSync = getLastSyncTime();
  if (lastSync) {
    const elapsed = Date.now() - new Date(lastSync).getTime();
    if (elapsed < 30000) return null; // < 30s, skip
  }

  const result = await syncFromGist();
  if (result.success && result.changed) {
    // Tell UI to re-render (custom event)
    window.dispatchEvent(new CustomEvent('gist-synced', { detail: result }));
  }
  return result;
}

// Auto-trigger khi script load (sau document ready)
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      autoPullOnLoad().catch(e => console.error('[Gist auto-pull] failed:', e));
    });
  } else {
    setTimeout(() => autoPullOnLoad().catch(e => console.error('[Gist auto-pull] failed:', e)), 100);
  }
}
