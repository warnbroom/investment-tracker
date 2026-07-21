# Handoff — Sổ Cái Personal Finance Tracker

Tài liệu này bàn giao dự án cho Claude Code / phiên làm việc tiếp theo. Đọc cùng với `CLAUDE.md` (context stable của dự án).

**Ngày handoff:** 21/07/2026
**Người trao:** Claude (chat interface)
**Người nhận:** Claude Code trong repo hoặc Codespace

---

## 1. Trạng thái dự án — TL;DR

Dự án Sổ Cái đang **production**, chạy tại `warnbroom.github.io`. Đã hoàn thiện các tính năng chính: 4 loại tài sản, CRUD, sortable table, live price scraping, Supabase auth + realtime sync, PWA icon, CAGR analytics, benchmark comparison, buyAmount tracking cho fund, đa ngoại tệ.

**Version files hiện tại (cache-bust):**
- `price-updater.js?v=18`
- `app.js?v=16`
- `supabase-sync.js?v=4`
- `supabase-config.js?v=1`
- HTML files (index/entries/analytics/test-proxy) `?v=15` cho HTML mới nhất — verify lại bằng `grep` trên repo

**Bug đã fix gần đây:**
- Prices sau khi bấm "Cập nhật giá" không persist khi đổi trang → fix bằng cách route qua `updateEntry(id, {...})` thay vì mutate object và save-once cuối
- Fine-grained PAT không có `X-OAuth-Scopes` header → fix bằng cách test GET /gists
- Infinite reload loop trong index.html khi `INITIAL_SESSION` fire → chỉ reload khi cloud data khác local

---

## 2. Task đang dang dở (INTERRUPTED)

### Context
User muốn chuyển nguồn giá vàng từ `giavang.org` sang `banggia.doji.vn` (nguồn chính chủ của DOJI). Đồng thời:

1. **Đơn giản hoá dropdown loại vàng** trong `entries.html` — chỉ còn 2 lựa chọn:
   - `SJC` — Vàng miếng SJC
   - `9999` — Nhẫn tròn 9999 Hưng Thịnh Vượng (DOJI)

2. **Migration tự động** cho entries cũ:
   - Entry có `goldType === 'SJC'` → giữ nguyên
   - Còn lại (bao gồm `9999`, `24k`, `18k`, `other`, `AVPL`...) → auto map thành `9999`
   - Gọi `updateEntry(id, {goldType: '9999'})` để trigger Supabase sync
   - Đánh dấu localStorage flag `gold_types_migrated_v1 = true` để không chạy lại

3. **Cloudflare Worker:** thêm `banggia.doji.vn` vào `ALLOWED_HOSTS`

### Phát hiện quan trọng khi phân tích API DOJI

**Endpoint:** `GET https://banggia.doji.vn/api/TablePrice/GetTablePrice`
**Response format:**
```json
{
  "status": true,
  "data": "/dhS1XYTQ0c+rd7iGi0Es...", // Chuỗi base64 mã hoá dài ~10KB
  "messageObject": { "code": "0000", "message": "Success", ... }
}
```

**Data bị mã hoá client-side.** Site DOJI dùng CryptoJS AES-CBC để decrypt trong browser. Đã xác định:

- Bundle files: `chunk-SBJLWGHF.js` (crypto core), `chunk-33TJFKJY.js` (CryptoJS lib), `chunk-LE6TOFQH.js` (gọi getTablePrice), `main-IFEHYYQ3.js`
- Line quan trọng trong `chunk-SBJLWGHF.js`:
  ```js
  c.Hex.parse(this._k), a=L.AES.decrypt({ciphertext:A}, t, {iv:u, mode:L.mode.CBC, pad:...})
  ```
- Key = `this._k` (hex string, chưa biết giá trị)
- IV = biến `u` (chưa biết derive từ đâu — có thể từ ciphertext prefix hoặc `_k`)
- Ciphertext = biến `A` = chuỗi base64 trong response `data`

### Bước tiếp theo user cần làm để hoàn thành task

**Trên Claude Code, đề nghị Claude làm theo thứ tự:**

1. **Reverse engineer decryption logic từ banggia.doji.vn:**
   - Cách nhanh nhất: đặt breakpoint tại dòng có `L.AES.decrypt` trong `chunk-SBJLWGHF.js` (tab Sources → search "AES.decrypt")
   - Reload trang, khi breakpoint hit → inspect biến `t` (key), `u` (IV), `this._k`
   - Alternative: dùng Console runtime dump:
     ```js
     Object.values(window).filter(x => x?._k || x?.k).map(x => ({keys: Object.keys(x), _k: x._k, k: x.k}))
     ```
   - Search source code (Ctrl+Shift+F) các từ khoá: `.k=`, `_k=`, `Utf8.parse`, `Hex.parse`, `AES.decrypt`

2. **Nếu tìm được key + IV algorithm:**
   - Viết decrypt function trong `price-updater.js`:
     ```js
     // Pseudo code
     async function fetchDojiApiPrices() {
       const { text } = await fetchViaProxy('https://banggia.doji.vn/api/TablePrice/GetTablePrice');
       const json = JSON.parse(text);
       const decrypted = decryptDojiPayload(json.data); // Return JSON string
       const data = JSON.parse(decrypted);
       // Parse: find "VÀNG MIẾNG SJC" và "NHẪN TRÒN 9999 HƯNG THỊNH VƯỢNG"
       return [...];
     }
     ```
   - Dùng SubtleCrypto (Web Crypto API) hoặc port CryptoJS decrypt. Tránh add dependency nếu có thể.

3. **Nếu decryption quá phức tạp:** fallback về giữ nguyên giavang.org (đang chạy tốt), chỉ làm phần dropdown + migration.

4. **Update files cần thiết:**
   - `price-updater.js` — thêm/replace fetch function
   - `cloudflare-worker.js` — thêm `banggia.doji.vn` vào `ALLOWED_HOSTS`, deploy lại Worker qua Cloudflare MCP
   - `entries.html` — dropdown chỉ còn 2 options (SJC, 9999)
   - `app.js` — thêm function `migrateOldGoldTypes()` chạy khi app load

5. **Test:**
   - Verify decrypt trả đúng giá SJC (~14.340.000 đ/chỉ) và nhẫn 9999 HTV (~14.320.000 đ/chỉ) tại thời điểm test
   - Verify migration: user có entries với `goldType` khác 2 giá trị mới, sau khi reload phải thành `9999`

### User's preference nếu decryption khó

Nếu Claude Code thấy decrypt banggia.doji.vn phức tạp (obfuscated JS, custom algorithm, key rotate...), **quay lại giữ giavang.org** — đó là option tôi đã suggest ban đầu. User đã đồng ý migration đơn giản:
- entries cũ chỉ có SJC hoặc Doji 9999 → phần không phải SJC map về `9999`

---

## 3. Files hiện tại trong outputs (source of truth)

Tất cả files mới nhất nằm ở `/mnt/user-data/outputs/investment-tracker/`. Trước khi làm task mới, verify các file này đã push lên GitHub repo:

```
CLAUDE.md                    — context stable của dự án
README.md                    — user-facing docs
index.html                   — dashboard
entries.html                 — form nhập liệu + bảng
analytics.html               — auth + performers + benchmark + data mgmt
test-proxy.html              — debug proxy
styles.css                   — editorial finance theme
app.js                       — CRUD + compute + CAGR
price-updater.js             — scrape vàng/NAV/tỷ giá
supabase-config.js           — Supabase URL + anon key (public, safe to commit)
supabase-sync.js             — auth + realtime sync
cloudflare-worker.js         — CORS proxy code (deploy manual sang Cloudflare)
manifest.webmanifest         — PWA
icon-*.png / icon-*.svg      — PWA icons
```

**Bug tồn tại chưa fix:** `cloudflare-worker.js` có `giavang.org` trong `ALLOWED_HOSTS`, nhưng Worker deployed trên Cloudflare **có thể** vẫn là bản cũ (chỉ có webgia.com). User đã screenshot lỗi 403 "Host not allowed: giavang.org" — cần verify bằng cách curl URL root Worker.

---

## 4. Credentials & endpoints

### Supabase
- **Project ID:** `waaggtdhsxphowyjmlqj`
- **URL:** `https://waaggtdhsxphowyjmlqj.supabase.co`
- **Anon key:** đã có trong `supabase-config.js` (public, safe to commit)
- **Table:** `entries` với RLS policy `auth.uid() = user_id`
- **Realtime:** enabled trên bảng `entries`
- **Email confirmation:** DISABLED (đăng ký xong login luôn)
- **Site URL:** `https://warnbroom.github.io`

### Cloudflare Worker
- **URL:** `https://so-cai-proxy.warnbroom.workers.dev/` (đoán, verify trong `analytics.html` → user đã config trong localStorage)
- **ALLOWED_HOSTS hiện tại (trong file source, đã push lên GitHub):**
  ```js
  ['giavang.org', 'webgia.com', 'api.fmarket.vn', 'fmarket.vn']
  ```
- **Cần thêm:** `banggia.doji.vn` (nếu quyết định dùng API DOJI)

### Data sources đang dùng
- **Vàng:** `giavang.org/trong-nuoc/doji/` (HTML scrape, đơn vị x1000đ/lượng → nhân 100 = VND/chỉ)
- **Quỹ NAV:** `api.fmarket.vn/res/products/filter` (POST, JSON)
- **Tỷ giá:** `webgia.com/ty-gia/vietcombank/` (HTML scrape, đơn vị VND/đơn-vị-tiền)

---

## 5. Workflow đề xuất cho Claude Code

1. **Đọc `CLAUDE.md` trước** — hiểu stack, conventions, anti-patterns
2. **Verify Worker đã deploy đúng version** — curl `https://so-cai-proxy.warnbroom.workers.dev/` xem JSON response có `allowedHosts` list đủ 4 hosts không
3. **Nếu chưa** — deploy Worker qua Cloudflare MCP (`wrangler deploy` hoặc via API)
4. **Bắt đầu task dang dở:**
   - a. Trong browser (không dùng Claude Code cho bước này) — mở https://banggia.doji.vn/gold-price, F12, đặt breakpoint tại `AES.decrypt`, reload, lấy key + IV
   - b. Copy giá trị key vào Claude Code, đề nghị viết decrypt function
   - c. Test decrypt với sample response (đã có trong tin nhắn cuối của chat trước)
5. **Nếu decrypt thành công:** update code, test, commit
6. **Nếu không:** giữ giavang.org, chỉ làm dropdown + migration

---

## 6. Prompts mẫu để dùng với Claude Code

**Prompt khởi động:**
> Đọc CLAUDE.md và handoff.md. Sau đó chạy `git log --oneline -10` và `ls -la` để nắm trạng thái repo.

**Prompt task dropdown + migration (nếu skip DOJI API):**
> Trong entries.html, đổi dropdown loại vàng chỉ còn 2 option: "SJC" (Vàng miếng SJC) và "9999" (Nhẫn tròn 9999 Hưng Thịnh Vượng). Trong app.js, thêm function migrateOldGoldTypes chạy khi load app: duyệt entries type=gold, nếu goldType không phải 'SJC' thì gọi updateEntry(id, {goldType: '9999'}). Dùng localStorage flag `gold_types_migrated_v1` để chỉ chạy 1 lần. Bump cache version app.js lên v=17, entries.html lên v=16. Commit và push.

**Prompt task DOJI API (nếu quyết định thử):**
> Tôi có key AES là `[USER_INPUT_KEY]` và IV là `[USER_INPUT_IV]` (hoặc derive như [algorithm]) từ site banggia.doji.vn. Thêm function fetchDojiApiPrices() vào price-updater.js: fetch endpoint https://banggia.doji.vn/api/TablePrice/GetTablePrice qua proxy, decrypt payload dùng Web Crypto API (không add CryptoJS dependency), parse JSON tìm "VÀNG MIẾNG SJC" và "NHẪN TRÒN 9999 HƯNG THỊNH VƯỢNG", trả về array {name, buy, sell}. Đơn vị x1000đ/lượng → ×100 = VND/chỉ. Cập nhật ALLOWED_HOSTS trong cloudflare-worker.js thêm banggia.doji.vn. Deploy lại Worker qua Cloudflare MCP. Test bằng cách gọi fetchDojiApiPrices() và verify kết quả.

**Prompt verify Worker deployment:**
> Curl `https://so-cai-proxy.warnbroom.workers.dev/` (không có url param), parse JSON response, verify `allowedHosts` array chứa đầy đủ 4 hosts: giavang.org, webgia.com, api.fmarket.vn, fmarket.vn. Nếu thiếu, deploy lại cloudflare-worker.js qua Cloudflare MCP.

---

## 7. Điểm cần chú ý khi tiếp tục

- **Không mutate entry object trực tiếp** — luôn qua `updateEntry(id, {...})` để trigger Supabase sync
- **Nhớ bump cache version** trên HTML sau mỗi lần sửa JS/CSS — nếu không user vẫn load bản cũ
- **Test syntax** với `node --check <file>.js` trước khi commit
- **Fine-grained PAT** cần permission "Gists: Read and write" (nếu tình cờ cần)
- **Backup dữ liệu người dùng** — nếu làm migration, đề nghị user xuất JSON trước từ trang Phân tích → Xuất JSON

---

## 8. Nếu có câu hỏi kỹ thuật

Đọc `CLAUDE.md` trước. Sau đó có thể trace qua git log để hiểu lý do các fix trước đây. Các bug fix đã comment inline trong code.

Nếu vẫn không rõ, mở lại chat interface (claude.ai), paste CLAUDE.md + handoff.md để tôi (chat) có context và giúp brainstorm.
