# Sổ Cái — Portfolio Tracker

Website tĩnh để quản lý và theo dõi danh mục đầu tư cá nhân gồm 3 lớp tài sản: **Tiền gửi, Quỹ mở, Vàng**.

Toàn bộ dữ liệu được lưu trong `localStorage` của trình duyệt — không có backend, không có server, không rò rỉ thông tin tài chính cá nhân ra ngoài.

## Tính năng

- **Trang tổng quan** (`index.html`): tổng giá trị danh mục, vốn gốc, lợi nhuận tuyệt đối & tỷ suất, phân bổ 3 loại tài sản, thanh trực quan tỷ trọng, bảng 10 giao dịch gần nhất.
- **Trang nhập liệu** (`entries.html`): form thích ứng theo từng loại tài sản, danh sách các mục đã ghi có filter & xoá.
- **Trang phân tích** (`analytics.html`): biểu đồ donut cơ cấu, hiệu suất theo loại, top/đáy hiệu suất, xuất/nhập JSON, xoá dữ liệu.

## Cấu trúc

```
/
├── index.html         # Landing / Dashboard
├── entries.html       # Nhập liệu & quản lý mục
├── analytics.html     # Phân tích chi tiết
├── styles.css         # Thiết kế chung (editorial / warm paper)
├── app.js             # Logic & tính toán
└── README.md
```

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
