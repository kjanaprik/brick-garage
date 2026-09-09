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
const REQ_DELAY = 1200;  // ms between SKUs (+ up to 600ms jitter)
const REQ_JITTER = 600;
const MAX_TRIES = 3;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class FetchFailure extends Error {}

async function getProducts(url) {
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
      const html = await res.text();
      const products = extractProducts(html);
      // HTTP 200 with no products array = soft block / challenge page. Retry it
      // rather than recording a false "not stocked".
      if (products === null) {
        throw new FetchFailure(`no products array (${html.length} bytes)`);
      }
      return products;
    } catch (e) {
      last = e;
      if (i < MAX_TRIES - 1) {
        await sleep(1500 * 2 ** i + Math.random() * 500);
      }
    }
  }
  throw new FetchFailure(last?.message || 'fetch failed');
}

// Returns an array of products, or NULL when the page contains no products array
// at all. Null means "this was not a search-results page" — a soft bot-block, a
// challenge interstitial or a truncated response, all of which arrive as HTTP 200.
// An empty array is a genuine zero-result search.
function extractProducts(html) {
  const anchor = html.indexOf('"products":[');
  if (anchor < 0) return null;
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
    return null;   // anchor present but unparseable — treat as a bad response
  }
}

function toInt(v) {
  if (v == null) return null;
  const n = Math.round(Number(String(v).replace(/[^\d.]/g, '')));
  return Number.isFinite(n) ? n : null;
}

// The LEGO set number is the last 4-6 digit run in the product name.
// Reliable for most Boozt products ("Icons Ford Model T Model Car Kit 11376")
// but NOT all — e.g. 42236 is listed as "Custom Garage Ford Mustang GT Car".
function trailingSetNo(name) {
  const all = String(name || '').match(/\d{4,6}/g);
  return all ? all[all.length - 1] : null;
}

// Second identity signal: Boozt's URL slug carries the set number even when the
// product name doesn't — /is/is/lego/technic-42236-42236_33059638.
// The trailing _<productId> is stripped first so its digits can't cause a match.
function urlHasSku(url, sku) {
  const slug = String(url || '').split('/').pop().replace(/_\d+$/, '');
  return new RegExp(`(?<![0-9])${sku}(?![0-9])`).test(slug);
}

// A product is the set we asked for if it's LEGO and either identity signal agrees.
function isMatch(o, sku) {
  if (String(o.brand_name || '').toUpperCase() !== 'LEGO') return false;
  return trailingSetNo(o.product_name) === sku || urlHasSku(o.product_url, sku);
}

const searchUrl = (host, q) =>
  `https://www.${host}/is/is/search/result?search_key=${encodeURIComponent(q)}`;

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
  return async function scrape(skus = [], names = null) {
    const wanted = [...new Set((skus || []).map((s) => String(s).trim()).filter(Boolean))];
    const out = [];
    const stats = { requested: wanted.length, hit: 0, byName: 0, miss: 0, error: 0, errorSkus: [] };

    for (const sku of wanted) {
      try {
        // Stage 1 — search by set number. Works whenever Boozt put the number in
        // the product name, which is most but not all of the catalogue.
        let products = await getProducts(searchUrl(host, sku));
        let hit = products.find((o) => isMatch(o, sku));

        // Stage 2 — fall back to the set's name. Boozt indexes on product_name, so
        // a set named without its number ("Custom Garage Ford Mustang GT Car") is
        // unreachable by number and only findable this way. The URL-slug check in
        // isMatch is what confirms identity, since the name carries no number.
        if (!hit && names && names[sku]) {
          await sleep(REQ_DELAY + Math.random() * REQ_JITTER);
          products = await getProducts(searchUrl(host, names[sku]));
          hit = products.find((o) => isMatch(o, sku));
          if (hit) stats.byName++;
        }

        if (hit) {
          out.push(normalise(retailer, hit, sku));
          stats.hit++;
        } else {
          // Real negative: pages loaded, no LEGO product matching this set.
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
      `[${retailer}] ${stats.hit} hit (${stats.byName} via name) / ${stats.miss} miss / ` +
        `${stats.error} error of ${stats.requested}` +
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
  // node boozt-adapter.mjs boozt 42236="Custom Garage Ford Mustang GT Car" 11376
  const [which, ...args] = process.argv.slice(2);
  const fn = which === 'booztlet' ? scrapeBooztlet : scrapeBoozt;
  const skus = [], names = {};
  for (const a of args) {
    const [n, nm] = a.split('=');
    skus.push(n);
    if (nm) names[n] = nm;
  }
  const rows = await fn(skus, names);
  console.log(JSON.stringify(rows, null, 2));
}
