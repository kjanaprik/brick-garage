// boozt-proxy-worker.js — Cloudflare Worker that fetches Boozt/Booztlet search pages
// for Brick Garage's price tracker.
//
// Boozt answers HTTP 429 to GitHub Actions' IPs from the first request of a run, while
// normal visitors get through. Cloudflare's egress is treated differently (same idea as
// the BrickLink proxy), so tracker/boozt-adapter.mjs sends its requests here when the
// BOOZT_PROXY_URL secret is set.
//
// Request:  GET <worker>/fetch?u=<url-encoded Boozt search URL>
//           header X-BG-Key: <PROXY_KEY>
// Response: Boozt's status and HTML unchanged, plus
//           X-Final-URL — the URL after redirects. A search with no hits redirects to
//           /search/no-result, and the adapter needs to see that to record a genuine
//           "not stocked" rather than a failed request.
//
// Locked down so it can't be used as an open proxy: key required, GET only, and only
// https://www.boozt.com or https://www.booztlet.com search-result pages are fetched.
//
// Deploy: Cloudflare dashboard -> Workers & Pages -> Create -> Worker -> name it e.g.
//         "brick-garage-boozt" -> Deploy -> Edit code -> paste this file -> Deploy.
//         Then Settings -> Variables and Secrets -> add Secret PROXY_KEY = a long random
//         string. Put the Worker URL and the same key in the repo secrets
//         BOOZT_PROXY_URL and BOOZT_PROXY_KEY.

const ALLOWED_HOSTS = new Set(['www.boozt.com', 'www.booztlet.com']);
const ALLOWED_PATH = /^\/is\/is\/search\/result$/;

export default {
  async fetch(request, env) {
    if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 });
    if (!env.PROXY_KEY || request.headers.get('X-BG-Key') !== env.PROXY_KEY) {
      return new Response('Forbidden', { status: 403 });
    }
    const url = new URL(request.url);
    if (url.pathname !== '/fetch') return new Response('Not found', { status: 404 });

    let target;
    try { target = new URL(url.searchParams.get('u') || ''); }
    catch { return new Response('Bad target URL', { status: 400 }); }
    if (target.protocol !== 'https:' || !ALLOWED_HOSTS.has(target.hostname) || !ALLOWED_PATH.test(target.pathname)) {
      return new Response('Target not allowed', { status: 400 });
    }

    const upstream = await fetch(target.toString(), {
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'is-IS,is;q=0.9,en;q=0.8',
      },
    });

    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        'Content-Type': upstream.headers.get('Content-Type') || 'text/html; charset=utf-8',
        'X-Final-URL': upstream.url || target.toString(),
        'Cache-Control': 'no-store',
      },
    });
  },
};
