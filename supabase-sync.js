/**
 * supabase-sync.js — đồng bộ dữ liệu Sổ Cái với Supabase
 *
 * Architecture:
 * - Supabase = source of truth (khi đã đăng nhập)
 * - localStorage = cache local + offline backup
 *
 * Sync model:
 * - Khi login: pull tất cả entries từ Supabase, ghi vào localStorage
 * - Khi add/edit/delete: write Supabase, sau đó write localStorage
 * - Realtime: subscribe channel, khi có change từ máy khác → cập nhật localStorage + emit event
 */

(function() {
  'use strict';

  let _supabase = null;
  let _currentUser = null;
  let _realtimeChannel = null;
  const _authStateListeners = [];
  const _syncStatusListeners = [];

  // ==========================================================================
  // Init
  // ==========================================================================

  function initSupabase() {
    if (typeof SUPABASE_ENABLED === 'undefined' || !SUPABASE_ENABLED) {
      console.log('[Supabase] Chưa cấu hình. App chạy local-only.');
      return null;
    }
    if (typeof window.supabase === 'undefined') {
      console.error('[Supabase] SDK chưa load. Kiểm tra <script> tag CDN.');
      return null;
    }
    if (_supabase) return _supabase;

    _supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    });

    _supabase.auth.onAuthStateChange(function(event, session) {
      _currentUser = session && session.user ? session.user : null;
      _authStateListeners.forEach(function(fn) {
        try { fn(event, session); } catch (e) { console.error(e); }
      });
      if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') {
        setupRealtime();
      } else if (event === 'SIGNED_OUT') {
        teardownRealtime();
      }
    });

    _supabase.auth.getSession().then(function(result) {
      const session = result.data.session;
      _currentUser = session && session.user ? session.user : null;
      if (_currentUser) {
        _authStateListeners.forEach(function(fn) { fn('INITIAL_SESSION', session); });
        setupRealtime();
      } else {
        _authStateListeners.forEach(function(fn) { fn('INITIAL_SESSION', null); });
      }
    });

    return _supabase;
  }

  // ==========================================================================
  // Auth API
  // ==========================================================================

  function getCurrentUser() { return _currentUser; }
  function isLoggedIn() { return !!_currentUser; }
  function getSupabaseClient() { return _supabase; }
  function onAuthStateChange(fn) { _authStateListeners.push(fn); }
  function onSyncStatus(fn) { _syncStatusListeners.push(fn); }

  function emitSyncStatus(status, detail) {
    _syncStatusListeners.forEach(function(fn) {
      try { fn(status, detail); } catch (e) { console.error(e); }
    });
  }

  async function signUp(email, password) {
    if (!_supabase) throw new Error('Supabase chưa init. Refresh trang và thử lại.');
    const result = await _supabase.auth.signUp({ email: email, password: password });
    if (result.error) throw result.error;
    return result.data;
  }

  async function signIn(email, password) {
    if (!_supabase) throw new Error('Supabase chưa init. Refresh trang và thử lại.');
    const result = await _supabase.auth.signInWithPassword({ email: email, password: password });
    if (result.error) throw result.error;
    return result.data;
  }

  async function signOut() {
    if (!_supabase) return;
    await _supabase.auth.signOut();
  }

  async function resetPassword(email) {
    if (!_supabase) throw new Error('Supabase chưa init.');
    const result = await _supabase.auth.resetPasswordForEmail(email, {
      redirectTo: window.location.origin + window.location.pathname,
    });
    if (result.error) throw result.error;
    return result.data;
  }

  // ==========================================================================
  // CRUD
  // ==========================================================================

  function dbRowToEntry(row) {
    return Object.assign({
      id: row.id,
      type: row.type,
      deleted: row.deleted || false,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }, row.data || {});
  }

  function entryToDbRow(entry, userId) {
    const id = entry.id;
    const type = entry.type;
    const deleted = entry.deleted || false;
    const data = Object.assign({}, entry);
    delete data.id;
    delete data.type;
    delete data.deleted;
    delete data.createdAt;
    delete data.updatedAt;
    return {
      id: id,
      user_id: userId,
      type: type,
      data: data,
      deleted: deleted,
    };
  }

  async function pullEntries() {
    if (!isLoggedIn() || !_supabase) return { success: false, reason: 'not_logged_in' };
    emitSyncStatus('syncing', 'Đang tải từ cloud…');
    try {
      const result = await _supabase
        .from('entries')
        .select('*')
        .eq('user_id', _currentUser.id);
      if (result.error) throw result.error;

      const entries = result.data.map(dbRowToEntry);

      // SAFETY: nếu cloud trả về 0 entries NHƯNG local có data → KHÔNG overwrite.
      // User có data local, có thể chưa migrate. Để Phân tích page hiển thị migrate prompt.
      if (entries.length === 0 && typeof loadEntriesRaw === 'function') {
        const localCount = loadEntriesRaw().length;
        if (localCount > 0) {
          console.warn('[Supabase] Cloud trống, local có ' + localCount + ' mục — KHÔNG overwrite. Vào Phân tích để migrate.');
          emitSyncStatus('synced', 'Cloud trống, giữ local');
          return { success: true, count: 0, skipped: true };
        }
      }

      saveEntriesRaw(entries, { skipPush: true });
      emitSyncStatus('synced', 'Đã đồng bộ');
      return { success: true, count: entries.length };
    } catch (e) {
      emitSyncStatus('error', e.message);
      console.error('[Supabase] Pull failed:', e);
      return { success: false, error: e.message };
    }
  }

  async function pushEntry(entry) {
    if (!isLoggedIn() || !_supabase) return { success: false, reason: 'not_logged_in' };
    const row = entryToDbRow(entry, _currentUser.id);
    const result = await _supabase.from('entries').upsert(row, { onConflict: 'id' });
    if (result.error) {
      console.error('[Supabase] Push entry failed:', result.error);
      return { success: false, error: result.error.message };
    }
    return { success: true };
  }

  async function pushAllEntries(entries) {
    if (!isLoggedIn() || !_supabase) return { success: false, reason: 'not_logged_in' };
    if (!entries.length) return { success: true, count: 0 };
    emitSyncStatus('syncing', 'Migrate ' + entries.length + ' mục…');
    try {
      const rows = entries.map(function(e) { return entryToDbRow(e, _currentUser.id); });
      const result = await _supabase.from('entries').upsert(rows, { onConflict: 'id' });
      if (result.error) throw result.error;
      emitSyncStatus('synced', 'Đã migrate ' + entries.length + ' mục');
      return { success: true, count: entries.length };
    } catch (e) {
      emitSyncStatus('error', e.message);
      console.error('[Supabase] Push all failed:', e);
      return { success: false, error: e.message };
    }
  }

  async function migrateLocalToCloud() {
    if (!isLoggedIn()) throw new Error('Cần đăng nhập trước');
    const local = (typeof loadEntriesRaw === 'function') ? loadEntriesRaw() : [];
    if (local.length === 0) return { success: true, count: 0, skipped: true };
    return await pushAllEntries(local);
  }

  // ==========================================================================
  // Realtime
  // ==========================================================================

  function setupRealtime() {
    if (!isLoggedIn() || !_supabase) return;
    if (_realtimeChannel) return;

    _realtimeChannel = _supabase
      .channel('entries-' + _currentUser.id)
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'entries', filter: 'user_id=eq.' + _currentUser.id },
        handleRealtimeChange
      )
      .subscribe(function(status) {
        if (status === 'SUBSCRIBED') {
          console.log('[Supabase] Realtime subscribed');
        }
      });
  }

  function teardownRealtime() {
    if (_realtimeChannel && _supabase) {
      _supabase.removeChannel(_realtimeChannel);
      _realtimeChannel = null;
    }
  }

  function handleRealtimeChange(payload) {
    const eventType = payload.eventType;
    const raw = (typeof loadEntriesRaw === 'function') ? loadEntriesRaw() : [];

    if (eventType === 'DELETE') {
      const id = payload.old && payload.old.id;
      if (id) {
        const filtered = raw.filter(function(e) { return e.id !== id; });
        if (typeof saveEntriesRaw === 'function') {
          saveEntriesRaw(filtered, { skipPush: true });
        }
      }
    } else {
      const newEntry = dbRowToEntry(payload.new);
      const idx = raw.findIndex(function(e) { return e.id === newEntry.id; });
      if (idx === -1) raw.push(newEntry);
      else raw[idx] = newEntry;
      if (typeof saveEntriesRaw === 'function') {
        saveEntriesRaw(raw, { skipPush: true });
      }
    }

    window.dispatchEvent(new CustomEvent('supabase-changed', { detail: payload }));
    emitSyncStatus('synced', 'Đồng bộ từ cloud');
  }

  // ==========================================================================
  // Export to window — bắt buộc, để inline scripts trong HTML truy cập được
  // ==========================================================================

  window.signUp = signUp;
  window.signIn = signIn;
  window.signOut = signOut;
  window.resetPassword = resetPassword;
  window.getCurrentUser = getCurrentUser;
  window.isLoggedIn = isLoggedIn;
  window.getSupabaseClient = getSupabaseClient;
  window.onAuthStateChange = onAuthStateChange;
  window.onSyncStatus = onSyncStatus;
  window.pullEntries = pullEntries;
  window.pushEntry = pushEntry;
  window.pushAllEntries = pushAllEntries;
  window.migrateLocalToCloud = migrateLocalToCloud;
  window.initSupabase = initSupabase;

  // ==========================================================================
  // Auto-init
  // ==========================================================================

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initSupabase);
  } else {
    initSupabase();
  }

  console.log('[Supabase] supabase-sync.js loaded. window.signUp =', typeof window.signUp);
})();
