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

Vì GitHub Pages là static hosting (không có backend), request phải đi qua **CORS proxy công cộng**. Mặc định dùng chuỗi fallback: `corsproxy.io` → `allorigins.win` → `codetabs.com`. Nếu proxy đầu fail, tự động thử proxy sau.

**Hai cách dùng:**

1. **Nút "Tự lấy" trong form nhập liệu** — điền mã quỹ / chọn loại vàng rồi bấm nút nhỏ cạnh field giá → tự fill.
2. **Nút "Cập nhật giá ngay" trên trang Phân tích** — quét tất cả mục `fund` + `gold` trong sổ, cập nhật hàng loạt, hiển thị log tiến trình.
3. **Tự động ngầm khi mở trang Tổng quan** — nếu lần cập nhật gần nhất đã hơn 4 giờ, website tự fetch ngầm và hiện thông báo nhỏ ở góc trái dưới cùng. Bấm "Tải lại" để áp dụng giá mới.

**Giới hạn cần biết:**

- Proxy công cộng có thể bị rate-limit hoặc xuống bất chợt. Nếu bạn cần ổn định hơn, tự host một Cloudflare Worker proxy (free tier dư dùng) và sửa `PROXY_CHAIN` đầu file `price-updater.js`.
- DOJI trả giá theo **nghìn đồng/chỉ** — code đã tự nhân 1000 ra VND/chỉ thực.
- Fmarket chỉ có các quỹ đang giao dịch trên nền tảng này. Quỹ ngoài Fmarket (nếu có) phải nhập tay.

### Tuỳ chọn — tự host CORS proxy bằng Cloudflare Worker

Nếu muốn proxy ổn định hơn (free tier CF Worker: 100.000 request/ngày, thừa cho cá nhân):

1. Đăng nhập [dash.cloudflare.com](https://dash.cloudflare.com) → Workers & Pages → Create → Hello World.
2. Dán code sau vào editor:

```js
export default {
  async fetch(request) {
    const url = new URL(request.url);
    const target = url.searchParams.get('url');
    if (!target) return new Response('Missing ?url=', { status: 400 });

    const init = {
      method: request.method,
      headers: { 'User-Agent': 'Mozilla/5.0' },
    };
    if (request.method === 'POST') {
      init.body = await request.text();
      init.headers['Content-Type'] = request.headers.get('Content-Type') || 'application/json';
    }

    const res = await fetch(target, init);
    const body = await res.text();
    return new Response(body, {
      status: res.status,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Content-Type': res.headers.get('Content-Type') || 'text/plain',
      },
    });
  },
};
```

3. Deploy → copy URL worker (ví dụ `https://my-proxy.your-name.workers.dev`).
4. Mở `price-updater.js`, thêm lên đầu `PROXY_CHAIN`:

```js
{
  name: 'my-cf-worker',
  wrap: (url) => `https://my-proxy.your-name.workers.dev/?url=${encodeURIComponent(url)}`,
  supportsPost: true,
},
```

## Cấu trúc

```
/
├── index.html         # Landing / Dashboard
├── entries.html       # Nhập liệu & quản lý mục
├── analytics.html     # Phân tích chi tiết + cập nhật giá
├── styles.css         # Thiết kế chung (editorial / warm paper)
├── app.js             # Logic & tính toán
├── price-updater.js   # Scrape DOJI + Fmarket qua CORS proxy
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
