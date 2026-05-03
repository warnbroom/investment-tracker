/**
 * supabase-sync.js — đồng bộ dữ liệu Sổ Cái với Supabase
 *
 * Architecture:
 * - Supabase = source of truth (khi đã đăng nhập)
 * - localStorage = cache local + offline backup
 *
 * Sync model:
 * - Khi login: pull tất cả entries từ Supabase, ghi vào localStorage
 * - Khi add/edit/delete: write Supabase trước, nếu OK thì write localStorage
 * - Realtime: subscribe channel, khi có change từ máy khác → cập nhật localStorage + emit event
 *
 * Khi chưa đăng nhập hoặc offline: app chạy hoàn toàn trên localStorage.
 */

let supabase = null;
let currentUser = null;
let realtimeChannel = null;
let authStateListeners = [];
let syncStatusListeners = [];

/* ==========================================================================
   Init
   ========================================================================== */

function initSupabase() {
  if (!SUPABASE_ENABLED) {
    console.log('[Supabase] Chưa cấu hình SUPABASE_URL/ANON_KEY. App chạy local-only.');
    return null;
  }
  if (typeof window.supabase === 'undefined') {
    console.error('[Supabase] SDK chưa load. Kiểm tra <script> tag.');
    return null;
  }
  if (supabase) return supabase;

  supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  });

  // Listen auth state changes
  supabase.auth.onAuthStateChange((event, session) => {
    currentUser = session?.user || null;
    authStateListeners.forEach(fn => {
      try { fn(event, session); } catch (e) { console.error(e); }
    });
    if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') {
      setupRealtime();
    } else if (event === 'SIGNED_OUT') {
      teardownRealtime();
    }
  });

  // Restore session
  supabase.auth.getSession().then(({ data }) => {
    currentUser = data.session?.user || null;
    if (currentUser) {
      authStateListeners.forEach(fn => fn('INITIAL_SESSION', data.session));
      setupRealtime();
    } else {
      authStateListeners.forEach(fn => fn('INITIAL_SESSION', null));
    }
  });

  return supabase;
}

/* ==========================================================================
   Auth API
   ========================================================================== */

function getCurrentUser() { return currentUser; }
function isLoggedIn() { return !!currentUser; }

function onAuthStateChange(fn) { authStateListeners.push(fn); }

async function signUp(email, password) {
  if (!supabase) throw new Error('Supabase chưa init');
  const { data, error } = await supabase.auth.signUp({ email, password });
  if (error) throw error;
  return data;
}

async function signIn(email, password) {
  if (!supabase) throw new Error('Supabase chưa init');
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data;
}

async function signOut() {
  if (!supabase) return;
  await supabase.auth.signOut();
}

async function resetPassword(email) {
  if (!supabase) throw new Error('Supabase chưa init');
  const { data, error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: window.location.origin + window.location.pathname,
  });
  if (error) throw error;
  return data;
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
   CRUD operations
   ========================================================================== */

/**
 * Convert entry từ format DB ({id, type, data: {...}, deleted, ...})
 * thành format app ({id, type, ...rest, deleted, createdAt, updatedAt})
 */
function dbRowToEntry(row) {
  return {
    id: row.id,
    type: row.type,
    deleted: row.deleted || false,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.data || {}),
  };
}

/** Convert entry app format → DB row */
function entryToDbRow(entry, userId) {
  const { id, type, deleted, createdAt, updatedAt, ...data } = entry;
  return {
    id,
    user_id: userId,
    type,
    data,
    deleted: deleted || false,
    // updated_at để DB tự set bằng now()
  };
}

/** Pull tất cả entries từ Supabase về localStorage */
async function pullEntries() {
  if (!isLoggedIn() || !supabase) return { success: false, reason: 'not_logged_in' };
  emitSyncStatus('syncing', 'Đang tải từ cloud…');

  try {
    const { data, error } = await supabase
      .from('entries')
      .select('*')
      .eq('user_id', currentUser.id);
    if (error) throw error;

    const entries = data.map(dbRowToEntry);
    saveEntriesRaw(entries, { skipPush: true }); // skipPush để không trigger sync ngược

    emitSyncStatus('synced', 'Đã đồng bộ');
    return { success: true, count: entries.length };
  } catch (e) {
    emitSyncStatus('error', e.message);
    console.error('[Supabase] Pull failed:', e);
    return { success: false, error: e.message };
  }
}

/** Push 1 entry lên Supabase (upsert) */
async function pushEntry(entry) {
  if (!isLoggedIn() || !supabase) return { success: false, reason: 'not_logged_in' };
  const row = entryToDbRow(entry, currentUser.id);
  const { error } = await supabase.from('entries').upsert(row, { onConflict: 'id' });
  if (error) {
    console.error('[Supabase] Push entry failed:', error);
    return { success: false, error: error.message };
  }
  return { success: true };
}

/** Push tất cả entries (dùng cho migrate ban đầu) */
async function pushAllEntries(entries) {
  if (!isLoggedIn() || !supabase) return { success: false, reason: 'not_logged_in' };
  if (!entries.length) return { success: true, count: 0 };
  emitSyncStatus('syncing', `Migrate ${entries.length} mục…`);

  try {
    const rows = entries.map(e => entryToDbRow(e, currentUser.id));
    // Batch insert via upsert
    const { error } = await supabase.from('entries').upsert(rows, { onConflict: 'id' });
    if (error) throw error;

    emitSyncStatus('synced', `Đã migrate ${entries.length} mục`);
    return { success: true, count: entries.length };
  } catch (e) {
    emitSyncStatus('error', e.message);
    console.error('[Supabase] Push all failed:', e);
    return { success: false, error: e.message };
  }
}

/* ==========================================================================
   Realtime subscription
   ========================================================================== */

function setupRealtime() {
  if (!isLoggedIn() || !supabase) return;
  if (realtimeChannel) return; // already subscribed

  realtimeChannel = supabase
    .channel('entries-' + currentUser.id)
    .on('postgres_changes',
      { event: '*', schema: 'public', table: 'entries', filter: `user_id=eq.${currentUser.id}` },
      handleRealtimeChange
    )
    .subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        console.log('[Supabase] Realtime subscribed');
      }
    });
}

function teardownRealtime() {
  if (realtimeChannel && supabase) {
    supabase.removeChannel(realtimeChannel);
    realtimeChannel = null;
  }
}

/**
 * Khi DB có thay đổi (từ máy khác), cập nhật localStorage và emit event.
 */
function handleRealtimeChange(payload) {
  const eventType = payload.eventType; // 'INSERT' | 'UPDATE' | 'DELETE'
  const raw = loadEntriesRaw();

  if (eventType === 'DELETE') {
    const id = payload.old?.id;
    if (id) {
      const filtered = raw.filter(e => e.id !== id);
      saveEntriesRaw(filtered, { skipPush: true });
    }
  } else {
    // INSERT or UPDATE
    const newEntry = dbRowToEntry(payload.new);
    const idx = raw.findIndex(e => e.id === newEntry.id);
    if (idx === -1) {
      raw.push(newEntry);
    } else {
      raw[idx] = newEntry;
    }
    saveEntriesRaw(raw, { skipPush: true });
  }

  // Báo cho UI để re-render
  window.dispatchEvent(new CustomEvent('supabase-changed', { detail: payload }));
  emitSyncStatus('synced', 'Đồng bộ từ cloud');
}

/* ==========================================================================
   Migration helper
   ========================================================================== */

/**
 * Migrate dữ liệu localStorage hiện tại lên Supabase.
 * Gọi 1 lần khi user vừa login lần đầu mà có data local.
 */
async function migrateLocalToCloud() {
  if (!isLoggedIn()) throw new Error('Cần đăng nhập trước');
  const local = loadEntriesRaw();
  if (local.length === 0) return { success: true, count: 0, skipped: true };

  // Check xem cloud đã có data chưa
  const { data: existing, error } = await supabase
    .from('entries')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', currentUser.id);
  if (error) throw error;

  return await pushAllEntries(local);
}

/* ==========================================================================
   Auto-init when script loads
   ========================================================================== */

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => initSupabase());
  } else {
    initSupabase();
  }
}

/* ==========================================================================
   Export to window — đảm bảo accessible từ inline scripts trong HTML
   ========================================================================== */

if (typeof window !== 'undefined') {
  window.signUp = signUp;
  window.signIn = signIn;
  window.signOut = signOut;
  window.resetPassword = resetPassword;
  window.getCurrentUser = getCurrentUser;
  window.isLoggedIn = isLoggedIn;
  window.onAuthStateChange = onAuthStateChange;
  window.onSyncStatus = onSyncStatus;
  window.pullEntries = pullEntries;
  window.pushEntry = pushEntry;
  window.pushAllEntries = pushAllEntries;
  window.migrateLocalToCloud = migrateLocalToCloud;
  window.initSupabase = initSupabase;
  window.getSupabaseClient = () => supabase;
}
