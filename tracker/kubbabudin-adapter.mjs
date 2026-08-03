// kubbabudin-adapter.mjs
// Retailer adapter for Kubbabúðin (kubbabudin.is) — reads their Algolia index directly.
// Node 18+ (uses global fetch). No dependencies.
//
// Implements the shared retailer contract: scrape(skus) -> normalised records:
//   { retailer, sku, name, price_isk, rrp_isk, on_sale, in_stock, url, scraped_at }
//
// Schema derived live from the index (see notes at bottom). Kubbabúðin runs on the
// Roanuz "a4" Magento→Algolia stack, one Algolia app shared across several unrelated
// Icelandic retailers, so the store-specific index name matters.
//
// Config via env (defaults are the live, search-only public key — safe to ship):
//   KUBBA_ALGOLIA_APP_ID   default 664UOUZDZI
//   KUBBA_ALGOLIA_API_KEY  default b20ef708b448ea1763dfdd9fcbc8ca06  (search-only)
//   KUBBA_ALGOLIA_INDEX    default a4_prod_kubaddin_store_view_products

const APP_ID = process.env.KUBBA_ALGOLIA_APP_ID || '664UOUZDZI';
const API_KEY = process.env.KUBBA_ALGOLIA_API_KEY || 'b20ef708b448ea1763dfdd9fcbc8ca06';
const INDEX   = process.env.KUBBA_ALGOLIA_INDEX  || 'a4_prod_kubaddin_store_view_products';

const RETAILER = 'kubbabudin';
const QUERY_URL = `https://${APP_ID.toLowerCase()}-dsn.algolia.net/1/indexes/${encodeURIComponent(INDEX)}/query`;

// The store slug lives after this path segment on the Algolia-indexed backend URL.
const BACKEND_SLUG_RE = /\/kubaddin_store_view\/(.+)$/;
const PUBLIC_BASE = 'https://www.kubbabudin.is/';

// --- helpers ---------------------------------------------------------------

// "6.799,00 ISK" | "6.799,00\u00a0ISK" -> 6799  (thousands '.', decimals ',')
function parseIskFormatted(s) {
  if (s == null) return null;
  const digits = String(s).replace(/[^\d.,]/g, '').split(',')[0].replace(/\./g, '');
  if (!digits) return null;
  const n = parseInt(digits, 10);
  return Number.isFinite(n) ? n : null;
}

// epoch (int) or "" -> is this a currently-active special?
function isActiveSpecial(from, to) {
  const t = Number(to) || 0;
  if (!t) return false;
  const now = Math.floor(Date.now() / 1000);
  const f = Number(from) || 0;
  return now >= (f || 0) && now <= t;
}

function backendUrlToPublic(url) {
  if (!url) return PUBLIC_BASE;
  const m = String(url).match(BACKEND_SLUG_RE);
  return m ? PUBLIC_BASE + m[1] : url;
}

function stripLego(sku) {
  return String(sku || '').replace(/^LEGO/i, '').trim();
}

// Normalise one Algolia hit into the shared retailer record.
function normalise(hit) {
  const isk = (hit.price && hit.price.ISK) || {};
  const price_isk = Number.isFinite(isk.default) ? isk.default : parseIskFormatted(isk.default_formated);
  const on_sale = isActiveSpecial(isk.special_from_date, isk.special_to_date);
  // When on sale, `default` is the discounted price and default_original_formated is the RRP.
  const rrp_isk = on_sale ? (parseIskFormatted(isk.default_original_formated) ?? null) : null;
  const in_stock = !!(hit.in_stock || (hit.rz_stock_available && hit.rz_stock_available.web));

  return {
    retailer: RETAILER,
    sku: stripLego(hit.sku),
    name: hit.name || null,
    price_isk: price_isk ?? null,
    rrp_isk,
    on_sale,
    in_stock,
    url: backendUrlToPublic(hit.url),
    scraped_at: new Date().toISOString(),
  };
}

async function algoliaQuery(body) {
  const res = await fetch(QUERY_URL, {
    method: 'POST',
    headers: {
      'X-Algolia-Application-Id': APP_ID,
      'X-Algolia-API-Key': API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Algolia ${res.status}: ${await res.text().catch(() => '')}`);
  return res.json();
}

/**
 * scrape(skus) — fetch current price/stock for the given Brick Garage set numbers.
 * @param {string[]} skus e.g. ['42172','10317']
 * @returns {Promise<Array>} normalised records (only SKUs actually found on the site)
 */
export async function scrape(skus = []) {
  const wanted = new Set(skus.map(stripLego));
  const out = [];
  const seen = new Set();

  // Full-text search per SKU. Kubbabúðin's index isn't huge (~781 items) but
  // querying per-SKU keeps us resilient to fuzzy neighbours: we ask for the
  // number, then keep only the hit whose stripped SKU matches exactly.
  for (const sku of wanted) {
    let data;
    try {
      data = await algoliaQuery({ query: sku, hitsPerPage: 8 });
    } catch (err) {
      console.warn(`[${RETAILER}] query failed for ${sku}: ${err.message}`);
      continue;
    }
    const hit = (data.hits || []).find(h => stripLego(h.sku) === sku);
    if (hit && !seen.has(sku)) {
      seen.add(sku);
      out.push(normalise(hit));
    }
  }
  return out;
}

// Back-compat alias (older orchestrator referenced scrapeKubbabudin).
export const scrapeKubbabudin = scrape;
export default scrape;

// CLI: `node kubbabudin-adapter.mjs 42172 10317`
if (import.meta.url === `file://${process.argv[1]}`) {
  const skus = process.argv.slice(2);
  if (!skus.length) { console.error('usage: node kubbabudin-adapter.mjs <sku> [sku...]'); process.exit(1); }
  scrape(skus).then(rows => console.log(JSON.stringify(rows, null, 2)))
    .catch(e => { console.error(e); process.exit(1); });
}

/* ---------------------------------------------------------------------------
Live schema (index a4_prod_kubaddin_store_view_products, 781 products):
  sku:   "LEGO42172"            -> strip ^LEGO to match Brick Garage set number
  name:  "TECHNIC McLaren P1™"
  price: { ISK: { default: 78990, default_formated: "78.990,00 ISK",
                  special_from_date: "", special_to_date: "" } }
  on sale (13 live examples): special_from_date/special_to_date are UNIX epochs,
    default = discounted price, default_original_formated = RRP ("6.799,00 ISK").
  in_stock: 1/0   rz_stock_available: { warehouse, web }
  url: https://backend.a4.roanuz.com/kubaddin_store_view/technic-mclaren-p1.html
       -> rewrite to https://www.kubbabudin.is/technic-mclaren-p1.html
Full-text query on the bare number returns fuzzy neighbours (42172 -> 9 hits incl
42170/42177), so we exact-match stripped SKU. ~106 tracked SKUs/day = trivial load.
--------------------------------------------------------------------------- */
