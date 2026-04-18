/**
 * Cloudflare Worker — CORS proxy cho Sổ Cái Portfolio Tracker
 *
 * Forward request từ Sổ Cái tới webgia.com (giá vàng DOJI) và fmarket.vn
 * (quỹ mở), kèm CORS headers để browser chấp nhận.
 *
 * ============================================================================
 * DEPLOY (5 phút, một lần duy nhất)
 * ============================================================================
 *
 * 1. Vào https://dash.cloudflare.com → Workers & Pages
 * 2. Create → Hello World → đặt tên (vd: so-cai-proxy) → Deploy
 * 3. Edit code → XOÁ SẠCH code mặc định → dán toàn bộ file này
 * 4. Save and deploy
 *
 * Kiểm tra: mở URL Worker trên tab mới, kỳ vọng thấy JSON
 * {"status":"Worker đang hoạt động OK", ...}
 *
 * Kết nối vào Sổ Cái: trang Phân tích → dán URL:
 *   https://so-cai-proxy.xxx.workers.dev/?url={URL}
 *
 * ============================================================================
 */

const ALLOWED_HOSTS = [
  'webgia.com',
  'api.fmarket.vn',
  'fmarket.vn',
];

const ALLOWED_ORIGINS = '*';

export default {
  async fetch(request) {
    const origin = request.headers.get('Origin') || '*';
    const corsHeaders = {
      'Access-Control-Allow-Origin': ALLOWED_ORIGINS === '*' ? '*' : origin,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Accept',
      'Access-Control-Max-Age': '86400',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const url = new URL(request.url);
    const target = url.searchParams.get('url');

    if (!target) {
      return new Response(JSON.stringify({
        status: 'Worker đang hoạt động OK',
        version: '3.0.0',
        allowedHosts: ALLOWED_HOSTS,
        hint: 'Gọi proxy: ' + url.origin + '/?url=<target_url>',
      }, null, 2), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' },
      });
    }

    let targetUrl;
    try { targetUrl = new URL(target); }
    catch { return jsonError('Invalid target URL', 400, corsHeaders); }

    const hostOk = ALLOWED_HOSTS.some(h =>
      targetUrl.hostname === h || targetUrl.hostname.endsWith('.' + h)
    );
    if (!hostOk) {
      return jsonError(
        `Host not allowed: ${targetUrl.hostname}. Allowed: ${ALLOWED_HOSTS.join(', ')}`,
        403, corsHeaders
      );
    }

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
