// boozt-adapter.mjs — Boozt / Booztlet (shared platform, two hosts)
//
// Changes vs previous version:
//   * getText retries with exponential backoff + jitter (429/5xx/network)
//   * per-SKU outcome is classified: hit / miss / error — errors are no longer
//     silently indistinguishable from "retailer doesn't stock it"
//   * scrape() attaches a .stats summary to the returned array so run-daily
//     can detect a degraded run and carry forward the previous values
//   * optin (members/activated discount) is preferred as the headline price,
//     with base as rrp — this matches what the site actually charges you

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// update-prices.mjs runs all adapters in parallel, so the boozt and booztlet
// loops hit the same backend at once. Jitter keeps them from marching in step.
const REQ_DELAY = 700;   // ms between SKUs (+ up to 400ms jitter)
const REQ_JITTER = 400;
const MAX_TRIES = 3;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class FetchFailure extends Error {}

async function getText(url) {
  let last;
  for (let i = 0; i < MAX_TRIES; i++) {
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': UA,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'is-IS,is;q=0.9,en;q=0.8',
        },
      });
      if (!res.ok) throw new FetchFailure(`HTTP ${res.status}`);
      return await res.text();
    } catch (e) {
      last = e;
      if (i < MAX_TRIES - 1) {
        // 1.5s, 3s (+ up to 500ms jitter so retries don't align across SKUs)
        await sleep(1500 * 2 ** i + Math.random() * 500);
      }
    }
  }
  throw new FetchFailure(last?.message || 'fetch failed');
}

// Pull the server-rendered "products":[...] array out of the search page.
// Brace/bracket matching rather than regex, because product copy contains
// both quotes and brackets.
function extractProducts(html) {
  const anchor = html.indexOf('"products":[');
  if (anchor < 0) return [];
  const start = html.indexOf('[', anchor);
  let depth = 0;
  let i = start;
  for (; i < html.length; i++) {
    const c = html[i];
    if (c === '[') depth++;
    else if (c === ']') {
      depth--;
      if (depth === 0) { i++; break; }
    } else if (c === '"') {
      i++;
      while (i < html.length && html[i] !== '"') {
        if (html[i] === '\\') i++;
        i++;
      }
    }
  }
  try {
    return JSON.parse(html.slice(start, i));
  } catch {
    return [];
  }
}

function toInt(v) {
  if (v == null) return null;
  const n = Math.round(Number(String(v).replace(/[^\d.]/g, '')));
  return Number.isFinite(n) ? n : null;
}

// The LEGO set number is the last 4-6 digit run in the product name.
function trailingSetNo(name) {
  const all = String(name || '').match(/\d{4,6}/g);
  return all ? all[all.length - 1] : null;
}

function normalise(retailer, o, sku) {
  const p = o.prices || {};
  const base = toInt(p.base?.price);
  const sale = toInt(p.sale?.price);
  const optin = toInt(p.optin?.price);

  // Boozt puts most markdowns in `optin` (the "activate your discount" toggle),
  // which is on by default for signed-in accounts. `sale` is used far less
  // often. Take the lowest real price on offer, keep base as RRP.
  const candidates = [sale, optin].filter((n) => n != null && n > 0);
  const best = candidates.length ? Math.min(...candidates) : null;

  const price_isk = best ?? base;
  const on_sale = best != null && base != null && best < base;

  const in_stock =
    o.in_stock === true &&
    !/^(sold[_-]?out|none|out[_-]?of[_-]?stock)$/i.test(String(o.stock_status || ''));

  return {
    retailer,
    sku,
    name: o.product_name || null,
    price_isk,
    rrp_isk: on_sale ? base : null,
    on_sale,
    in_stock,
    url: o.product_url || null,
    scraped_at: new Date().toISOString(),
    base_isk: base,     // extra context
    optin_isk: optin,   // extra context
  };
}

function makeScraper(retailer, host) {
  return async function scrape(skus = []) {
    const wanted = [...new Set((skus || []).map((s) => String(s).trim()).filter(Boolean))];
    const out = [];
    const stats = { requested: wanted.length, hit: 0, miss: 0, error: 0, errorSkus: [] };

    for (const sku of wanted) {
      const url = `https://www.${host}/is/is/search/result?search_key=${encodeURIComponent(sku)}`;
      try {
        const html = await getText(url);
        const products = extractProducts(html);
        const hit = products.find(
          (o) =>
            trailingSetNo(o.product_name) === sku &&
            String(o.brand_name || '').toUpperCase() === 'LEGO'
        );
        if (hit) {
          out.push(normalise(retailer, hit, sku));
          stats.hit++;
        } else {
          // Real negative: page loaded, no LEGO product with that set number.
          stats.miss++;
        }
      } catch (e) {
        // Could not read the page after retries — NOT the same as "not stocked".
        stats.error++;
        stats.errorSkus.push(sku);
        console.warn(`[${retailer}] request failed for ${sku}: ${e.message}`);
      }
      await sleep(REQ_DELAY + Math.random() * REQ_JITTER);
    }

    console.log(
      `[${retailer}] ${stats.hit} hit / ${stats.miss} miss / ${stats.error} error ` +
        `of ${stats.requested}` +
        (stats.error ? ` — failed: ${stats.errorSkus.join(',')}` : '')
    );

    out.stats = stats;
    return out;
  };
}

export const scrapeBoozt = makeScraper('boozt', 'boozt.com');
export const scrapeBooztlet = makeScraper('booztlet', 'booztlet.com');
export default { scrapeBoozt, scrapeBooztlet };

// CLI: node boozt-adapter.mjs [boozt|booztlet] <sku> [sku...]
if (import.meta.url === `file://${process.argv[1]}`) {
  const [which, ...skus] = process.argv.slice(2);
  const fn = which === 'booztlet' ? scrapeBooztlet : scrapeBoozt;
  const rows = await fn(skus);
  console.log(JSON.stringify(rows, null, 2));
}
