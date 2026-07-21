# Sổ Cái — Personal Investment Tracker

Portfolio tracker chạy trên GitHub Pages (`warnbroom.github.io`). Track 4 loại tài sản: tiền gửi, quỹ mở, vàng, ngoại tệ. Live sync giữa các thiết bị qua Supabase.

## Stack

- **Frontend:** Vanilla HTML/CSS/JS (không framework). Deploy: GitHub Pages
- **Backend/Auth:** Supabase (project: `waaggtdhsxphowyjmlqj.supabase.co`)
- **Proxy scraping:** Cloudflare Worker (project: `so-cai-proxy.warnbroom.workers.dev`)
- **Data sources:** banggia.doji.vn (vàng DOJI, API chính chủ — payload AES-256-CBC, giải bằng Web Crypto; fallback giavang.org), webgia.com (tỷ giá VCB), api.fmarket.vn (NAV quỹ)

## Files structure

| File | Vai trò |
|------|---------|
| `index.html` | Dashboard tổng quan (4 pillars, alloc chart, recent entries) |
| `entries.html` | Form nhập liệu + bảng quản lý các mục đã ghi |
| `analytics.html` | Cấu hình proxy, tài khoản Supabase, top/weak performers, benchmark |
| `test-proxy.html` | Trang debug Cloudflare Worker |
| `styles.css` | Toàn bộ style (editorial finance aesthetic) |
| `app.js` | Core logic: CRUD entries, computeEntryValues, computePortfolio, CAGR |
| `price-updater.js` | Scrape giá vàng/NAV/tỷ giá qua Worker proxy |
| `supabase-sync.js` | Auth (email/password) + realtime sync với Supabase |
| `supabase-config.js` | URL + anon key Supabase (public, safe to commit) |
| `cloudflare-worker.js` | Worker code (deploy manual sang Cloudflare dashboard) |
| `manifest.webmanifest` + `icon-*.png` | PWA / add to homescreen |

## Data model

Mỗi entry lưu trong Supabase table `entries`:
```
id          TEXT PK
user_id     UUID (auth.users)
type        TEXT ('deposit'|'fund'|'gold'|'usd')
data        JSONB (fields tuỳ theo type)
deleted     BOOLEAN (tombstone soft-delete)
created_at  TIMESTAMPTZ
updated_at  TIMESTAMPTZ
```

Fields trong `data` theo type:
- `deposit`: `{name, bank, amount, rate, termMonths, startDate, interestType, note}`
- `fund`: `{name, fundCode, fundCompany, buyAmount, units, buyNav, currentNav, startDate, note}`
- `gold`: `{name, goldType, weight, buyPrice, currentPrice, store, startDate, note}`
- `usd` (dù tên type là 'usd', giờ đã generalize thành ngoại tệ): `{name, currency, usdAmount, buyRate, currentRate, source, startDate, note}`

## Key conventions

- **Cache busting:** mỗi khi sửa `.js` hoặc `.css`, tăng `?v=N` trong `<script src>` / `<link href>` của TẤT CẢ file HTML để user không bị cache cũ. Version hiện tại: `?v=18` cho JS, `?v=1` cho supabase-* files
- **Tiếng Việt:** UI text tiếng Việt (Sổ Cái, Nhập liệu, Phân tích, Quản lý...). Log/comment kỹ thuật OK dùng tiếng Anh
- **Currency:** VND làm mặc định. `formatMoney(x)` → làm tròn. `formatMoney(x, {decimals: 2})` → giữ 2 chữ số cho đơn giá NAV/tỷ giá
- **Testing:** kiểm tra syntax `node --check` cho JS, parse `<script>` block trong HTML bằng `new Function()` để verify không có JS lỗi
- **Persist rule:** MỌI thay đổi trên entry phải đi qua `updateEntry(id, {...})` — không được mutate object trực tiếp. `updateEntry` tự set `updatedAt` và push lên Supabase

## Common tasks

**Update giá tự động (khi nguồn scraping đổi format):**
1. Fetch HTML mẫu từ nguồn để xem cấu trúc
2. Sửa parser trong `price-updater.js` (`parseGoldHtml`, `parseForexRate`, `fetchFmarketFunds`)
3. Test unit với sample HTML: `parseGoldHtml(sample)` → phải trả về ≥5 rows với giá đúng đơn vị (VND/chỉ cho vàng, VND/đơn-vị-currency cho forex)
4. Nếu đổi URL → update `ALLOWED_HOSTS` trong `cloudflare-worker.js` + deploy lại Worker
5. Bump cache version tất cả HTML

**Add tính năng UI mới:**
1. HTML markup vào file phù hợp (index/entries/analytics)
2. JS logic thường viết inline trong `<script>` block cuối HTML
3. Style vào `styles.css`, dùng CSS variables đã có (`--accent`, `--paper`, `--ink`, `--font-display`, etc.)
4. Bump cache version

**Debug Supabase issues:**
- Check Supabase dashboard → Logs → API/Realtime
- Verify RLS policy: user chỉ đọc/ghi được row của mình
- Realtime subscription: `entries` table đã trong publication `supabase_realtime`

## Design system

- **Palette:**
  - `--paper: #f4f1ea` (cream nền)
  - `--ink: #1a1613` (đen)
  - `--accent: #b8471f` (burnt sienna)
  - `--gold: #c9974a`, `--usd: #2d5a52` (teal)
  - `--green: #3d6b4a`, `--red: #a53a2a` (delta)
- **Typography:**
  - `--font-display: 'Fraunces', Georgia, serif` (heading)
  - `--font-body: 'Inter Tight'` (body)
  - `--font-mono: 'JetBrains Mono'` (numbers, code, labels)
- **Style keyword:** "editorial finance / warm paper" — không dùng shadow đậm, không màu neon, prefer rule lines + tabular nums

## Workflow expected

1. User yêu cầu tính năng / báo bug
2. Đọc code liên quan (Read tool), verify với `node --check`
3. Sửa file bằng Edit tool
4. Chạy test nhỏ để verify logic (nếu có logic mới)
5. Bump cache version trên HTML files
6. `git add . && git commit -m "..."` (Claude Code tự làm)
7. `git push` để deploy (GitHub Pages tự publish)
8. Nếu đụng Worker: chỉ hướng dẫn user deploy tay qua dashboard, hoặc dùng Cloudflare MCP nếu đã cài
9. Nếu đụng Supabase schema: dùng Supabase MCP để chạy migration

## Anti-patterns cần tránh

- ❌ Mutate entry object rồi gọi `saveEntries()` — không set `updatedAt`, Supabase không sync
- ❌ Thêm `<script>` mới nhưng quên cache-bust
- ❌ Fetch trực tiếp API bên thứ 3 từ browser (CORS) — luôn phải qua Cloudflare Worker
- ❌ Trigger `location.reload()` trong handler `INITIAL_SESSION` mà không check điều kiện → infinite loop
- ❌ `pullEntries` overwrite localStorage khi cloud trống nhưng local có data
