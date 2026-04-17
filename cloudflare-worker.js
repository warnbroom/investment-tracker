/**
 * Cloudflare Worker — CORS proxy cho Sổ Cái Portfolio Tracker
 *
 * ============================================================================
 * CÁCH DEPLOY (5 phút, một lần duy nhất)
 * ============================================================================
 *
 * 1. Vào https://dash.cloudflare.com → Workers & Pages
 * 2. Bấm "Create" → "Start with Hello World!"
 * 3. Đặt tên (ví dụ: so-cai-proxy) → bấm "Deploy"
 * 4. Bấm "Edit code" (góc trên phải)
 * 5. *** XOÁ SẠCH *** code mặc định trong editor
 * 6. Dán TOÀN BỘ nội dung file này vào (từ dòng `export default` xuống hết)
 *    KHÔNG dán phần comment này vào Worker — không bắt buộc nhưng gọn hơn.
 * 7. Bấm "Save and deploy" (góc trên phải)
 * 8. Copy URL Worker hiển thị phía trên (dạng https://so-cai-proxy.xxx.workers.dev)
 * 9. Mở Sổ Cái → trang Phân tích → dán URL với format:
 *    https://so-cai-proxy.xxx.workers.dev/?url={URL}
 *    (PHẢI có phần ?url={URL} ở cuối)
 *
 * ============================================================================
 * KIỂM TRA WORKER CÓ HOẠT ĐỘNG
 * ============================================================================
 *
 * Mở URL Worker trong browser (không thêm tham số):
 *   https://so-cai-proxy.xxx.workers.dev/
 *
 * Kỳ vọng thấy: {"error":"Missing ?url= parameter","hint":"..."}
 * Nếu thấy "Worker threw exception" → code bị copy lỗi, dán lại.
 * Nếu thấy "Worker not found" → URL sai hoặc chưa deploy.
 *
 * ============================================================================
 */

const ALLOWED_HOSTS = [
  'giavang.doji.vn',
  'api.fmarket.vn',
  'fmarket.vn',
];

// Để '*' cho phép mọi domain. Sau khi deploy Sổ Cái có thể đổi thành
// ['https://yourname.github.io'] để chặn bên thứ ba dùng proxy của bạn.
const ALLOWED_ORIGINS = '*';

export default {
  async fetch(request) {
    const origin = request.headers.get('Origin') || '*';
    const corsHeaders = {
      'Access-Control-Allow-Origin': ALLOWED_ORIGINS === '*' ? '*' : (
        Array.isArray(ALLOWED_ORIGINS) && ALLOWED_ORIGINS.includes(origin) ? origin : 'null'
      ),
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Accept',
      'Access-Control-Max-Age': '86400',
    };

    // Handle CORS preflight — QUAN TRỌNG, nếu thiếu sẽ lỗi "Failed to fetch"
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const url = new URL(request.url);
    const target = url.searchParams.get('url');

    // Trường hợp không có ?url= — show hướng dẫn ngắn
    if (!target) {
      return new Response(JSON.stringify({
        error: 'Missing ?url= parameter',
        hint: 'Gọi proxy kiểu: ' + url.origin + '/?url=https://giavang.doji.vn/',
        status: 'Worker đang hoạt động OK',
        version: '1.0.0',
      }, null, 2), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' },
      });
    }

    // Validate target URL
    let targetUrl;
    try {
      targetUrl = new URL(target);
    } catch {
      return jsonError('Invalid target URL: ' + target, 400, corsHeaders);
    }

    // Host allowlist
    const hostOk = ALLOWED_HOSTS.some(h =>
      targetUrl.hostname === h || targetUrl.hostname.endsWith('.' + h)
    );
    if (!hostOk) {
      return jsonError(
        `Host not allowed: ${targetUrl.hostname}. Allowed: ${ALLOWED_HOSTS.join(', ')}`,
        403, corsHeaders
      );
    }

    // Forward request
    const init = {
      method: request.method,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
        'Accept': request.headers.get('Accept') || '*/*',
        'Accept-Language': 'vi-VN,vi;q=0.9,en;q=0.8',
      },
    };

    if (request.method === 'POST') {
      init.body = await request.text();
      const ct = request.headers.get('Content-Type');
      if (ct) init.headers['Content-Type'] = ct;
    }

    try {
      const upstream = await fetch(targetUrl.toString(), init);
      const body = await upstream.arrayBuffer();
      const responseHeaders = new Headers(corsHeaders);
      const contentType = upstream.headers.get('Content-Type');
      if (contentType) responseHeaders.set('Content-Type', contentType);
      return new Response(body, {
        status: upstream.status,
        headers: responseHeaders,
      });
    } catch (e) {
      return jsonError(
        'Upstream fetch failed: ' + (e.message || String(e)),
        502, corsHeaders
      );
    }
  },
};

function jsonError(message, status, headers) {
  return new Response(JSON.stringify({ error: message }, null, 2), {
    status,
    headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8' },
  });
}
