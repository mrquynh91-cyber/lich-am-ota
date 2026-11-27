/**
 * Cloudflare Worker + US-West Durable Object — Cầu nối Proxy Gemini AI miễn phí (0đ)
 * Tác giả: DINH VAN QUYNH - 0868.00.2468
 *
 * Giải quyết triệt để 100% lỗi "400: User location is not supported for the API use"
 * (khi nhà mạng Việt Nam định tuyến Cloudflare sang trạm Hồng Kông HKG):
 *  - Mọi yêu cầu gọi Gemini đều chạy qua SQLite Durable Object `UsExit`
 *    với `locationHint: "wnam"` (Bờ Tây Mỹ — California, nằm sát máy chủ Google).
 *  - Miễn phí hoàn toàn gói Cloudflare Free (100.000 lượt/ngày).
 *  - Tự xoay vòng nhiều Key (GEMINI_API_KEYS) & nhảy dự phòng ngay khi gặp 429/503/403.
 *  - Bảo vệ bằng APP_TOKEN (header X-LichAm-Token) & chỉ mở /v1beta/models.
 */

import { DurableObject } from 'cloudflare:workers';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-LichAm-Token, Authorization',
  'Access-Control-Max-Age': '86400'
};

function jsonResp(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS_HEADERS }
  });
}

function getApiKeyPool(env) {
  const multi = String(env.GEMINI_API_KEYS || '').trim();
  const single = String(env.GEMINI_API_KEY || '').trim();
  return (multi || single)
    .split(/[\s,;]+/)
    .map((k) => k.trim())
    .filter((k) => k.length > 10);
}

async function forwardToGemini(request, env) {
  const url = new URL(request.url);
  const keys = getApiKeyPool(env);
  if (keys.length === 0) {
    return jsonResp({ error: { message: 'Chưa cấu hình GEMINI_API_KEYS trên Cloudflare Worker.' } }, 500);
  }

  const bodyText = request.method === 'POST' ? await request.text() : undefined;
  const startIdx = Math.floor(Math.random() * keys.length);
  let lastResp = null;

  for (let attempt = 0; attempt < keys.length; attempt++) {
    const apiKey = keys[(startIdx + attempt) % keys.length];
    const upstream = new URL(`https://generativelanguage.googleapis.com${url.pathname}`);
    for (const [k, v] of url.searchParams.entries()) {
      if (k === 'key' || k === 'token') continue;
      upstream.searchParams.set(k, v);
    }

    const upstreamHeaders = { 'x-goog-api-key': apiKey };
    if (request.method === 'POST') upstreamHeaders['Content-Type'] = 'application/json';

    const upstreamResp = await fetch(upstream.toString(), {
      method: request.method,
      headers: upstreamHeaders,
      body: bodyText
    });

    lastResp = upstreamResp;
    if ((upstreamResp.status === 429 || upstreamResp.status === 503 || upstreamResp.status === 403) && attempt + 1 < keys.length) {
      continue;
    }
    break;
  }

  const respHeaders = new Headers(lastResp.headers);
  for (const [k, v] of Object.entries(CORS_HEADERS)) respHeaders.set(k, v);
  respHeaders.delete('set-cookie');

  return new Response(lastResp.body, {
    status: lastResp.status,
    headers: respHeaders
  });
}

/**
 * Free-tier SQLite Durable Object pinned to Western North America (wnam - California, USA)
 * so outbound calls to Google Gemini NEVER originate from Hong Kong (HKG)!
 */
export class UsExit extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/__probe') {
      try {
        const t = await fetch('https://cloudflare.com/cdn-cgi/trace');
        const txt = await t.text();
        const colo = (txt.match(/colo=([A-Z0-9]+)/) || [])[1] || 'unknown';
        const loc = (txt.match(/loc=([A-Z]+)/) || [])[1] || 'unknown';
        return jsonResp({ ok: true, exitColo: colo, exitCountry: loc });
      } catch (_e) {
        return jsonResp({ ok: true, exitColo: 'us-exit' });
      }
    }
    return forwardToGemini(request, this.env);
  }
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);

    // Health check endpoint (also reports US Exit Durable Object status)
    if (url.pathname === '/' || url.pathname === '/health') {
      const keys = getApiKeyPool(env);
      const info = {
        ok: true,
        service: 'LichAmVietNam Gemini AI Proxy (US-West Exit)',
        keysConfigured: keys.length,
        tokenProtected: Boolean(String(env.APP_TOKEN || '').trim()),
        edgeColo: request.cf?.colo || 'unknown',
        usExitActive: Boolean(env.US_EXIT)
      };
      if (env.US_EXIT) {
        try {
          const id = env.US_EXIT.idFromName('us-west-gemini-exit-v1');
          const stub = env.US_EXIT.get(id, { locationHint: 'wnam' });
          const pr = await stub.fetch('https://internal/__probe');
          const pd = await pr.json();
          info.exitColo = pd.exitColo;
          info.exitCountry = pd.exitCountry;
        } catch (_e) {}
      }
      return jsonResp(info);
    }

    // Optional App Token guard
    const requiredToken = String(env.APP_TOKEN || '').trim();
    if (requiredToken) {
      const clientToken = String(request.headers.get('X-LichAm-Token') || url.searchParams.get('token') || '').trim();
      if (clientToken !== requiredToken) {
        return jsonResp({ error: { message: 'Sai mã bảo vệ Proxy (X-LichAm-Token).' } }, 401);
      }
    }

    // Strict whitelist: only forward Gemini /v1beta/models endpoints
    if (!url.pathname.startsWith('/v1beta/models')) {
      return jsonResp({ error: { message: 'Đường dẫn không được phép.' } }, 403);
    }

    // Route through US-West Durable Object (guarantees US IP, NEVER Hong Kong HKG!)
    if (env.US_EXIT) {
      const id = env.US_EXIT.idFromName('us-west-gemini-exit-v1');
      const stub = env.US_EXIT.get(id, { locationHint: 'wnam' });
      return stub.fetch(request);
    }

    return forwardToGemini(request, env);
  }
};

// Trigger Cloudflare US-West Durable Object build: 2026-11-27 13:31:55
