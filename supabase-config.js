/**
 * supabase-config.js — cấu hình kết nối Supabase
 *
 * SETUP (1 lần duy nhất):
 * 1. Tạo project tại https://app.supabase.com (free tier OK)
 * 2. Settings → API → copy Project URL và anon public key
 * 3. Dán vào 2 biến bên dưới
 *
 * Hai giá trị này là PUBLIC, an toàn để commit vào Git.
 * Bảo mật thực sự nằm ở Row Level Security (RLS) đã setup trên Supabase.
 */

const SUPABASE_URL = 'https://waaggtdhsxphowyjmlqj.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndhYWdndGRoc3hwaG93eWptbHFqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc3ODE5ODUsImV4cCI6MjA5MzM1Nzk4NX0.a5MSCVXsOv-g3Wl3u4aBFz2rJmfjv6omjl6PSJ5kHB4';

// Disable Supabase nếu chưa cấu hình (để app vẫn chạy với localStorage)
const SUPABASE_ENABLED = !SUPABASE_URL.includes('YOUR_PROJECT') && !SUPABASE_ANON_KEY.includes('YOUR_ANON');
