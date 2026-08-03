// elko-adapter.mjs
// Retailer adapter for ELKO (elko.is), Icelandic electronics retailer that also
// carries LEGO. Node 18+ (global fetch). No dependencies.
//
// ELKO is a Next.js site backed by Algolia (same clean pattern as Kubbabúðin).
// Search-only credentials (public, safe to ship):
//   app id 9LGLXP4YCH, index prod_elko_products.
//
// Hit schema (relevant fields):
//   name: "LEGO Technic BMW M4 GT3 EVO kappakstursbíll 42226"  (set no. = trailing number)
//   sku / objectID: "LEGO42226"  (NB: sometimes an internal code like "LEGO407321",
//                                  so we match on the trailing number in `name`)
//   isInStockWeb: bool           inStock: bool
//   listings.webshop.price: { price, discountedPrice|null, lowestPrice, discountAmount }
//   product.slug, categoryLevels: {0:"...-3",1:"lego-67009"}  (PDP path not cleanly
//                                  derivable + no sitemap, so url = search deep-link)
//
// Prices are ISK all-in — directly comparable to the other ISK retailers.
// Emits the shared retailer contract:
//   { retailer, sku, name, price_isk, rrp_isk, on_sale, in_stock, url, scraped_at }

const APP_ID = process.env.ELKO_ALGOLIA_APP_ID || '9LGLXP4YCH';
const API_KEY = process.env.ELKO_ALGOLIA_API_KEY || 'dfdb7b6d367c3580a1465cc307b31cfd';
const INDEX  = process.env.ELKO_ALGOLIA_INDEX  || 'prod_elko_products';
const REQ_DELAY = Number(process.env.ELKO_REQ_DELAY_MS || 0);

const RETAILER = 'elko';
const QUERY_URL = `https://${APP_ID.toLowerCase()}-dsn.algolia.net/1/indexes/${encodeURIComponent(INDEX)}/query`;

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Last 4–6 digit group in the product name = the LEGO set number.
function trailingSetNo(name) {
  const all = String(name || '').match(/\d{4,6}/g);
  return all ? all[all.length - 1] : null;
}

async function algolia(query, tries = 2) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), 20000);
    try {
      const res = await fetch(QUERY_URL, {
        method: 'POST',
        headers: {
          'X-Algolia-Application-Id': APP_ID,
          'X-Algolia-API-Key': API_KEY,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query, hitsPerPage: 8 }),
        signal: ctl.signal,
      });
      clearTimeout(to);
      if (!res.ok) throw new Error(`Algolia ${res.status}`);
      return await res.json();
    } catch (e) { clearTimeout(to); lastErr = e; if (i < tries - 1) await sleep(400); }
  }
  throw lastErr;
}

function normalise(hit, sku) {
  const price = ((hit.listings || {}).webshop || {}).price || {};
  const base = Number.isFinite(price.price) ? price.price : null;
  const disc = Number.isFinite(price.discountedPrice) ? price.discountedPrice : null;
  const on_sale = disc != null && base != null && disc < base;
  const price_isk = on_sale ? disc : base;
  const rrp_isk = on_sale ? base : null;
  const in_stock = hit.isInStockWeb === true || (hit.isInStockWeb == null && hit.inStock === true);
  return {
    retailer: RETAILER,
    sku,
    name: hit.name || null,
    price_isk,
    rrp_isk,
    on_sale,
    in_stock,
    // PDP path isn't cleanly derivable from the API; search deep-link lands on the product.
    url: `https://elko.is/leit?q=${encodeURIComponent(sku)}`,
    scraped_at: new Date().toISOString(),
  };
}

/**
 * scrape(skus) — fetch price/stock for the given LEGO set numbers from elko.is.
 * @param {string[]} skus
 * @returns {Promise<Array>} normalised records (only SKUs ELKO carries)
 */
export async function scrape(skus = []) {
  const wanted = [...new Set(skus.map(s => String(s).trim()))];
  const out = [];
  for (const sku of wanted) {
    try {
      const data = await algolia(sku);
      const hit = (data.hits || []).find(h => trailingSetNo(h.name) === sku && /lego/i.test(h.name || ''));
      if (hit && ((hit.listings || {}).webshop || {}).price) out.push(normalise(hit, sku));
      if (REQ_DELAY) await sleep(REQ_DELAY);
    } catch (e) {
      console.warn(`[${RETAILER}] failed for ${sku}: ${e.message}`);
    }
  }
  return out;
}

export const scrapeElko = scrape;
export default scrape;

// CLI: `node elko-adapter.mjs 42226 42143`
if (import.meta.url === `file://${process.argv[1]}`) {
  const skus = process.argv.slice(2);
  if (!skus.length) { console.error('usage: node elko-adapter.mjs <sku> [sku...]'); process.exit(1); }
  scrape(skus).then(r => console.log(JSON.stringify(r, null, 2))).catch(e => { console.error(e); process.exit(1); });
}
