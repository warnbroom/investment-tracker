# Sổ Cái — Portfolio Tracker

Website tĩnh để quản lý và theo dõi danh mục đầu tư cá nhân gồm 3 lớp tài sản: **Tiền gửi, Quỹ mở, Vàng**.

Toàn bộ dữ liệu được lưu trong `localStorage` của trình duyệt — không có backend, không có server, không rò rỉ thông tin tài chính cá nhân ra ngoài.

## Tính năng

- **Trang tổng quan** (`index.html`): tổng giá trị danh mục, vốn gốc, lợi nhuận tuyệt đối & tỷ suất, phân bổ 3 loại tài sản, thanh trực quan tỷ trọng, bảng 10 giao dịch gần nhất.
- **Trang nhập liệu** (`entries.html`): form thích ứng theo từng loại tài sản, danh sách các mục đã ghi có filter & xoá, nút "Tự lấy" giá cạnh field NAV/giá vàng.
- **Trang phân tích** (`analytics.html`): biểu đồ donut cơ cấu, hiệu suất theo loại, top/đáy hiệu suất, **nút cập nhật giá tự động** từ DOJI và Fmarket, xuất/nhập JSON.

## Cập nhật giá tự động

Website scrape giá trực tiếp từ 2 nguồn:

- **Vàng** — `giavang.doji.vn`: lấy giá **mua vào** theo loại (SJC, nhẫn 9999, nữ trang 99.99/99.9/99) từ bảng giá HTML.
- **Quỹ mở** — `api.fmarket.vn`: gọi API JSON public, tìm NAV hiện tại theo mã quỹ (VESAF, DCDS, VEOF...).

Vì GitHub Pages là static hosting (không backend), request phải đi qua một **CORS proxy**. Các proxy công cộng (corsproxy.io, allorigins, ...) trong giai đoạn 2025-2026 đã không còn đáng tin — rate limit khắt khe, đòi API key, hoặc chặn hosted environments. Nên giải pháp bền vững duy nhất là **tự host Cloudflare Worker miễn phí**.

### Setup Cloudflare Worker (5 phút, một lần duy nhất)

**Bước 1 — Tạo Worker:**

1. Vào [dash.cloudflare.com](https://dash.cloudflare.com/) → đăng ký / đăng nhập (miễn phí, không cần thẻ).
2. Menu trái → **Workers & Pages** → **Create** → chọn **Hello World** starter.
3. Đặt tên (ví dụ `so-cai-proxy`) → **Deploy**.
4. Bấm **Edit code** → xoá sạch code mặc định → dán toàn bộ nội dung file `cloudflare-worker.js` → **Save and deploy**.
5. Copy URL hiển thị phía trên (dạng `https://so-cai-proxy.your-name.workers.dev`).

**Bước 2 — Kết nối vào Sổ Cái:**

1. Mở trang **Phân tích** của Sổ Cái.
2. Ở ô "Cloudflare Worker Proxy", dán URL theo format: `https://so-cai-proxy.your-name.workers.dev/?url={URL}` (phải có phần `?url={URL}` ở cuối — `{URL}` là placeholder).
3. Bấm **Kiểm tra** → nếu thấy dòng xanh "✓ Proxy hoạt động tốt" là OK.
4. Bấm **Lưu**.

**Bước 3 (tùy chọn) — Giới hạn domain:**

Sau khi đã deploy Sổ Cái lên GitHub Pages, vào lại code Worker, sửa dòng đầu:

```js
const ALLOWED_ORIGINS = ['https://<username>.github.io'];
```

Làm vậy để không ai khác ngoài website của bạn có thể dùng proxy này (tránh ăn quota 100k request/ngày).

**Giới hạn free tier Cloudflare:** 100.000 request/ngày — dư xa (1 lần cập nhật Sổ Cái = 2 request: 1 tới DOJI + 1 tới Fmarket).

### Ba cách cập nhật giá

1. **Nút "Tự lấy" trong form nhập liệu** — điền mã quỹ / chọn loại vàng rồi bấm nút nhỏ cạnh field giá → tự fill.
2. **Nút "Cập nhật giá ngay" trên trang Phân tích** — quét tất cả mục `fund` + `gold` trong sổ, cập nhật hàng loạt, hiển thị log tiến trình.
3. **Tự động ngầm khi mở trang Tổng quan** — nếu lần cập nhật gần nhất đã hơn 4 giờ, website tự fetch ngầm và hiện thông báo nhỏ ở góc trái dưới cùng. Bấm "Tải lại" để áp dụng giá mới.

**Giới hạn cần biết:**

- DOJI trả giá theo **nghìn đồng/chỉ** — code đã tự nhân 1000 ra VND/chỉ thực.
- Fmarket chỉ có các quỹ đang giao dịch trên nền tảng này (~40 quỹ phổ biến). Quỹ ngoài Fmarket (nếu có) phải nhập tay.

## Cấu trúc

```
/
├── index.html             # Landing / Dashboard
├── entries.html           # Nhập liệu & quản lý mục
├── analytics.html         # Phân tích + cập nhật giá + cấu hình proxy
├── styles.css             # Thiết kế chung (editorial / warm paper)
├── app.js                 # Logic & tính toán
├── price-updater.js       # Scrape DOJI + Fmarket qua proxy
├── cloudflare-worker.js   # Code Worker để deploy (KHÔNG upload lên GitHub Pages)
└── README.md
```

**Lưu ý:** File `cloudflare-worker.js` chỉ để copy-paste vào Cloudflare dashboard, không cần đưa lên GitHub Pages cùng các file khác. Nhưng giữ trong repo để tiện tham khảo lại.

## Deploy lên GitHub Pages

### Cách 1 — qua trình duyệt (đơn giản nhất)

1. Đăng nhập GitHub và tạo repository mới, ví dụ `investment-tracker` (để Public).
2. Ở repo trống, bấm **"uploading an existing file"** → kéo-thả 6 file trong thư mục này lên → Commit.
3. Vào **Settings → Pages**.
4. Mục **Source**, chọn branch `main` và folder `/ (root)` → **Save**.
5. Chờ ~1 phút, GitHub sẽ báo URL dạng `https://<username>.github.io/investment-tracker/`.

### Cách 2 — qua git command line

```bash
cd investment-tracker
git init
git add .
git commit -m "Khởi tạo Sổ Cái"
git branch -M main
git remote add origin https://github.com/<username>/investment-tracker.git
git push -u origin main
```

Sau đó vào **Settings → Pages** và bật như bước 3-4 ở cách 1.

## Cách dùng

### 1. Nhập khoản đầu tư đầu tiên

Vào trang **Nhập liệu**, chọn loại tài sản ở cột trái:

**Tiền gửi** — cần: tên, ngân hàng, số tiền, lãi suất %/năm, kỳ hạn (tháng), ngày gửi. Hệ thống tính lãi theo công thức lãi đơn pro-rata theo thời gian đã trôi qua.

**Quỹ mở** — cần: tên, mã quỹ, số CCQ, NAV lúc mua, NAV hiện tại. Giá trị hiện tại = số CCQ × NAV hiện tại.

**Vàng** — cần: tên, loại vàng, khối lượng, giá mua, giá hiện tại. Giá trị hiện tại = khối lượng × giá hiện tại.

### 2. Cập nhật giá định kỳ

Để theo dõi lợi nhuận chính xác, định kỳ (hàng tuần/tháng) nên cập nhật:

- **Quỹ mở**: cập nhật trường `NAV hiện tại` — tra trên website quỹ hoặc Fmarket, DNSE, v.v.
- **Vàng**: cập nhật `Giá hiện tại` — tra giá vàng SJC/PNJ/DOJI trên các báo tài chính.
- **Tiền gửi**: không cần cập nhật, tự tính theo ngày.

Hiện bản v1.0 làm việc này bằng cách xoá mục cũ và tạo mới với giá cập nhật — phiên bản sau sẽ có nút "cập nhật giá" riêng.

### 3. Sao lưu

Vào **Phân tích → Quản lý dữ liệu → Xuất JSON** để tải file backup. Khi đổi máy/trình duyệt, dùng **Nhập JSON** để khôi phục.

## Lưu ý kỹ thuật

- Dữ liệu lưu trong `localStorage` trình duyệt — **xoá cookies/cache sẽ mất dữ liệu**. Hãy xuất JSON định kỳ.
- Lãi suất tiền gửi được tính đơn giản (lãi đơn, pro-rata). Không tính lãi kép hoặc xử lý tái tục tự động.
- Toàn bộ số liệu đơn vị VND. Đơn vị vàng là "chỉ" (có thể điều chỉnh nhưng tính toán thì đồng nhất giữa khối lượng và giá).
- Không có xác thực — đừng deploy lên domain dùng chung. Đây là công cụ cá nhân chạy hoàn toàn trên trình duyệt của bạn.

## Giấy phép

MIT — tự do sử dụng, sửa đổi, tái phân phối.
