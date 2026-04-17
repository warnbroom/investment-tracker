/**
 * Cloudflare Worker — CORS proxy cho Sổ Cái Portfolio Tracker
 *
 * Deploy:
 *   1. Vào https://dash.cloudflare.com/ → Workers & Pages → Create → Hello World
 *   2. Dán toàn bộ code này, Deploy
 *   3. Copy URL worker (ví dụ https://so-cai-proxy.your-name.workers.dev)
 *   4. Vào trang Phân tích → dán URL vào ô "Proxy tuỳ chỉnh" → Lưu
 *
 * Bảo mật:
 *   - ALLOWED_ORIGINS dưới đây giới hạn domain nào được phép dùng proxy.
 *     Sau khi deploy Sổ Cái lên GitHub Pages, thay '*' bằng domain của bạn.
 *     Ví dụ: ['https://yourname.github.io']
 *   - ALLOWED_HOSTS giới hạn website đích — chỉ cho phép DOJI & Fmarket,
 *     không cho phép proxy tới bất kỳ URL nào khác → tránh bị lạm dụng.
 *
 * Giới hạn free tier Cloudflare:
 *   - 100.000 request/ngày
 *   - 10ms CPU time/request
 *   - Dư xa cho tool cá nhân (1 lần refresh ≈ 2 request)
 */

const ALLOWED_ORIGINS = ['*']; // Đổi thành ['https://<user>.github.io'] sau khi deploy
const ALLOWED_HOSTS = [
  'giavang.doji.vn',
  'api.fmarket.vn',
  'fmarket.vn',
];

export default {
  async fetch(request) {
    const origin = request.headers.get('Origin') || '*';
    const corsHeaders = buildCorsHeaders(origin);

    // Preflight OPTIONS
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const url = new URL(request.url);
    const target = url.searchParams.get('url');

    if (!target) {
      return jsonResponse(
        { error: 'Missing ?url= parameter' },
        400,
        corsHeaders,
      );
    }

    let targetUrl;
    try { targetUrl = new URL(target); }
    catch {
      return jsonResponse({ error: 'Invalid target URL' }, 400, corsHeaders);
    }

    // Host allowlist — chỉ cho phép DOJI và Fmarket
    if (!ALLOWED_HOSTS.some((h) => targetUrl.hostname === h || targetUrl.hostname.endsWith('.' + h))) {
      return jsonResponse(
        { error: 'Host not allowed', host: targetUrl.hostname, allowed: ALLOWED_HOSTS },
        403,
        corsHeaders,
      );
    }

    // Build fetch options
    const init = {
      method: request.method,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': request.headers.get('Accept') || '*/*',
        'Accept-Language': 'vi,en;q=0.9',
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
      return jsonResponse(
        { error: 'Upstream fetch failed', message: e.message },
        502,
        corsHeaders,
      );
    }
  },
};

function buildCorsHeaders(origin) {
  const allow = ALLOWED_ORIGINS.includes('*') || ALLOWED_ORIGINS.includes(origin)
    ? (ALLOWED_ORIGINS.includes('*') ? '*' : origin)
    : 'null';
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

function jsonResponse(data, status, headers) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...headers, 'Content-Type': 'application/json' },
  });
}
