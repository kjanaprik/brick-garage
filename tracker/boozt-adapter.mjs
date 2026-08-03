// boozt-adapter.mjs
// Retailer adapters for Boozt (boozt.com) and its outlet Booztlet (booztlet.com),
// Icelandic storefront (/is/is), prices in ISK. Node 18+ (global fetch). No deps.
//
// Both sites run the same platform and server-render the search results as a JSON
// blob in the page: `"products":[ { ... }, ... ]`. Each product carries:
//   product_name : "...Fast and Furious Mitsubishi Eclipse Car 42229"  (LEGO set no. is the trailing number)
//   brand_name   : "LEGO"
//   product_url  : absolute URL
//   prices       : { base:{price,formatted_price,reduction}, sale:{...}|null, optin:{...}|null, previous:{...}|null }
//   in_stock     : bool          stock_status: "good" | ...
//   ean_id       : internal id
//
// We search by set number, extract the embedded products array, and keep the
// product whose trailing set-number matches AND brand is LEGO. Prices are ISK
// all-in — directly comparable to the other ISK retailers.
//
// Emits the shared retailer contract:
//   { retailer, sku, name, price_isk, rrp_isk, on_sale, in_stock, url, scraped_at, optin_isk }
//
// Boozt uses `sale` for public markdowns (captured as on_sale + rrp). `optin` is a
// members-only price; surfaced separately as optin_isk but not treated as the
// headline price. Non-sale drops are still caught by the pipeline's PriceHistory.

const REQ_DELAY = Number(process.env.BOOZT_REQ_DELAY_MS || 250);
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)';

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getText(url, tries = 2) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), 25000);
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, 'Accept-Language': 'is,en;q=0.8' },
        signal: ctl.signal,
      });
      clearTimeout(to);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (e) { clearTimeout(to); lastErr = e; if (i < tries - 1) await sleep(500); }
  }
  throw lastErr;
}

function toInt(v) {
  if (v == null) return null;
  const n = Math.round(parseFloat(String(v).replace(/[^\d.]/g, '')));
  return Number.isFinite(n) ? n : null;
}

// Pull every top-level object out of the first `"products":[ ... ]` array in the SSR HTML.
function extractProducts(html) {
  const key = html.indexOf('"products":[');
  if (key < 0) return [];
  const arr = html.indexOf('[', key);
  const objs = [];
  let depth = 0, start = -1;
  for (let k = arr; k < html.length; k++) {
    const c = html[k];
    if (c === '{') { if (depth === 0) start = k; depth++; }
    else if (c === '}') { depth--; if (depth === 0) objs.push(html.slice(start, k + 1)); }
    else if (c === ']' && depth === 0) break;
  }
  const out = [];
  for (const t of objs) { try { out.push(JSON.parse(t)); } catch { /* skip */ } }
  return out;
}

// The LEGO set number is the trailing 4–6 digit group in the product name.
function trailingSetNo(name) {
  const all = String(name || '').match(/\d{4,6}/g);
  return all ? all[all.length - 1] : null;
}

function normalise(retailer, o, sku) {
  const p = o.prices || {};
  const base_isk = toInt((p.base || {}).price);
  const sale_isk = p.sale && p.sale.price != null ? toInt(p.sale.price) : null;
  const optin_isk = p.optin && p.optin.price != null ? toInt(p.optin.price) : null;

  // On the Icelandic storefront the `optin` tier is surfaced publicly as "Tilboð"
  // (a % offer splash), not a gated member price — so the effective price a shopper
  // sees is the LOWEST actively-offered tier, not just `sale`. Take the min of the
  // discount tiers vs base; base is the regular (was) price.
  const tiers = [sale_isk, optin_isk].filter(v => v != null && v > 0);
  const discounted = tiers.length ? Math.min(...tiers) : null;
  const on_sale = discounted != null && base_isk != null && discounted < base_isk;
  const price_isk = on_sale ? discounted : base_isk;
  const rrp_isk = on_sale ? base_isk : null;

  // Sale badge text if present, e.g. "25% Tilboð" (context for alerts).
  const splash = Array.isArray(o.text_splashes)
    ? (o.text_splashes.find(t => t && t.text) || {}).text || null : null;

  const in_stock = o.in_stock === true &&
    !/^(sold[_-]?out|none|out[_-]?of[_-]?stock)$/i.test(String(o.stock_status || ''));

  return {
    retailer,
    sku,
    name: o.product_name || null,
    price_isk,
    rrp_isk,
    on_sale,
    in_stock,
    url: o.product_url || null,
    scraped_at: new Date().toISOString(),
    sale_label: on_sale ? splash : null,   // extra context; DB upsert ignores
    base_isk,                              // regular price for reference
  };
}

// Factory: build a scraper bound to a specific host.
function makeScraper(retailer, host) {
  return async function scrape(skus = []) {
    const wanted = [...new Set(skus.map(s => String(s).trim()))];
    const out = [];
    for (const sku of wanted) {
      try {
        const url = `https://www.${host}/is/is/search/result?search_key=${encodeURIComponent(sku)}`;
        const html = await getText(url);
        const products = extractProducts(html);
        const hit = products.find(o =>
          trailingSetNo(o.product_name) === sku &&
          String(o.brand_name || '').toUpperCase() === 'LEGO'
        );
        if (hit) out.push(normalise(retailer, hit, sku));
        await sleep(REQ_DELAY);
      } catch (e) {
        console.warn(`[${retailer}] failed for ${sku}: ${e.message}`);
      }
    }
    return out;
  };
}

export const scrapeBoozt = makeScraper('boozt', 'boozt.com');
export const scrapeBooztlet = makeScraper('booztlet', 'booztlet.com');
export default { scrapeBoozt, scrapeBooztlet };

// CLI: `node boozt-adapter.mjs [boozt|booztlet] <sku> [sku...]`
if (import.meta.url === `file://${process.argv[1]}`) {
  const [which, ...skus] = process.argv.slice(2);
  const fn = which === 'booztlet' ? scrapeBooztlet : which === 'boozt' ? scrapeBoozt : null;
  if (!fn || !skus.length) { console.error('usage: node boozt-adapter.mjs <boozt|booztlet> <sku> [sku...]'); process.exit(1); }
  fn(skus).then(r => console.log(JSON.stringify(r, null, 2))).catch(e => { console.error(e); process.exit(1); });
}
