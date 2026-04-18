/**
 * Cloudflare Worker — CORS proxy cho Sổ Cái Portfolio Tracker
 *
 * Worker này forward request tới ScraperAPI (https://www.scraperapi.com)
 * để vượt qua việc DOJI chặn IPs của Cloudflare datacenter.
 *
 * ============================================================================
 * SETUP (10 phút, một lần duy nhất)
 * ============================================================================
 *
 * BƯỚC 1 — Đăng ký ScraperAPI (miễn phí, 1000 request/tháng)
 *   1. Vào https://dashboard.scraperapi.com/signup
 *   2. Đăng ký bằng email + password (KHÔNG cần thẻ tín dụng)
 *   3. Sau khi đăng nhập, ở trang Dashboard, copy API Key
 *      (dạng chuỗi 32 ký tự chữ+số, ví dụ: "abc123def456...")
 *
 * BƯỚC 2 — Deploy Cloudflare Worker
 *   1. Vào https://dash.cloudflare.com → Workers & Pages
 *   2. Create → Start with Hello World → đặt tên (ví dụ: so-cai-proxy) → Deploy
 *   3. Edit code → XOÁ SẠCH code mặc định → dán TOÀN BỘ code file này
 *   4. Bấm "Save and deploy"
 *
 * BƯỚC 3 — Thêm ScraperAPI Key vào Worker (QUAN TRỌNG)
 *   1. Trong trang Worker, vào tab "Settings" → "Variables and Secrets"
 *   2. Bấm "Add" → chọn type "Secret"
 *      - Variable name: SCRAPER_API_KEY
 *      - Value: API key từ Bước 1
 *   3. Bấm "Save"
 *   4. Vào tab Deployments → bấm "Deploy" để áp dụng biến mới
 *
 * BƯỚC 4 — Test
 *   Mở URL Worker trực tiếp trên tab mới:
 *     https://so-cai-proxy.xxx.workers.dev/
 *   Kỳ vọng: JSON có "hasApiKey": true
 *
 * BƯỚC 5 — Kết nối vào Sổ Cái
 *   Vào trang Phân tích → dán URL:
 *     https://so-cai-proxy.xxx.workers.dev/?url={URL}
 *   Bấm Kiểm tra → Lưu
 *
 * ============================================================================
 * TIẾT KIỆM REQUEST
 * ============================================================================
 * Free tier: 1000 request/tháng. 1 lần cập nhật giá = 2 request (DOJI + Fmarket).
 * → 500 lần update/tháng = 16 lần/ngày. Quá đủ cho cá nhân.
 * Chú ý Fmarket vẫn dùng IP thường (không chặn CF), nên không cần qua ScraperAPI.
 * Worker tự detect và chỉ qua ScraperAPI với DOJI.
 *
 * ============================================================================
 */

// Domain nào cần qua ScraperAPI (bị chặn CF datacenter IPs)
const NEEDS_SCRAPER_API = [
  'giavang.doji.vn',
];

// Domain nào được phép proxy (dùng trực tiếp hoặc qua ScraperAPI)
const ALLOWED_HOSTS = [
  'giavang.doji.vn',
  'api.fmarket.vn',
  'fmarket.vn',
];

const ALLOWED_ORIGINS = '*'; // Có thể siết thành ['https://xxx.github.io'] sau

export default {
  async fetch(request, env) {
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

    // Status page khi không có ?url=
    if (!target) {
      return new Response(JSON.stringify({
        status: 'Worker đang hoạt động OK',
        hasApiKey: !!env.SCRAPER_API_KEY,
        message: env.SCRAPER_API_KEY
          ? 'SCRAPER_API_KEY đã được cấu hình. Worker sẵn sàng.'
          : 'CHƯA cấu hình SCRAPER_API_KEY. Xem Bước 3 trong file Worker để thêm.',
        version: '2.0.0',
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

    // Quyết định dùng ScraperAPI hay direct fetch
    const needsScraperApi = NEEDS_SCRAPER_API.some(h =>
      targetUrl.hostname === h || targetUrl.hostname.endsWith('.' + h)
    );

    try {
      let upstream;
      if (needsScraperApi) {
        if (!env.SCRAPER_API_KEY) {
          return jsonError(
            'Target này yêu cầu ScraperAPI nhưng Worker chưa có SCRAPER_API_KEY. ' +
            'Xem Bước 3 trong file cloudflare-worker.js.',
            500, corsHeaders
          );
        }
        // Route qua ScraperAPI
        const scraperUrl = new URL('https://api.scraperapi.com/');
        scraperUrl.searchParams.set('api_key', env.SCRAPER_API_KEY);
        scraperUrl.searchParams.set('url', targetUrl.toString());
        // ScraperAPI only supports GET
        upstream = await fetch(scraperUrl.toString(), { method: 'GET' });
      } else {
        // Direct fetch (cho Fmarket — không bị chặn)
        const init = {
          method: request.method,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Accept': request.headers.get('Accept') || '*/*',
            'Accept-Language': 'vi-VN,vi;q=0.9,en;q=0.8',
          },
        };
        if (request.method === 'POST') {
          init.body = await request.text();
          const ct = request.headers.get('Content-Type');
          if (ct) init.headers['Content-Type'] = ct;
        }
        upstream = await fetch(targetUrl.toString(), init);
      }

      const body = await upstream.arrayBuffer();
      const responseHeaders = new Headers(corsHeaders);
      const contentType = upstream.headers.get('Content-Type');
      if (contentType) responseHeaders.set('Content-Type', contentType);
      // Bỏ qua các header có thể gây vấn đề
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
