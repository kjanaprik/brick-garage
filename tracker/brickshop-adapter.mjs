// brickshop-adapter.mjs
// Retailer adapter for BRICKshop (brickshop.eu — BRICKshop Holland, Gorinchem).
// Node 18+ (global fetch). No dependencies.
//
// Brickshop is a Joomla/VirtueMart store with NO JSON API, so this is an HTML
// scraper. It's inherently more fragile than the Kubbabúðin Algolia feed — if
// they retheme or change URL structure it will need attention. Two stable-ish
// anchors it relies on:
//   1. Product URLs embed the LEGO set number: /lego/<cat>/lego-<SKU>-<slug>.html
//   2. Product pages carry Schema.org microdata:
//        <span itemprop="price" content="23.79">
//        <meta itemprop="priceCurrency" content="EUR">
//        <link itemprop="availability" href="https://schema.org/InStock">
//
// Emits the shared retailer contract:
//   { retailer, sku, name, price_isk, rrp_isk, on_sale, in_stock, url, scraped_at,
//     price_eur, currency }   // last two are extra context; DB upsert ignores them
//
// Prices are converted to a LANDED-to-Iceland ISK estimate so they're comparable
// to the ISK retailers (Kubbabúðin). The scraped itemprop price includes Dutch (EU)
// VAT; Iceland is outside the EU, so that's stripped, then weight-based shipping and
// Icelandic import VAT apply:
//     ex_eu_vat  = eur / EU_VAT                          (EU_VAT = 1.21, Dutch VAT)
//     ship_eur   = max(28.05, 18.79 + 4.88 * weight_kg)  (fitted to real IS checkout)
//     landed_isk = round( (ex_eu_vat + ship_eur) * VAT * EUR_ISK )   (VAT = 1.24 IS)
// weight_kg is scraped from the product page ("Weight … g"); falls back to 1.5 kg.
// This is "buy-alone" shipping (one set ~= the €28 minimum); bundling lowers per-set.
// Sale detection is intentionally NOT attempted from the page (no reliable
// was-price marker); the pipeline's own PriceHistory drop-detection covers that.

const BASE       = (process.env.BRICKSHOP_BASE || 'https://www.brickshop.eu').replace(/\/+$/, '');
// EUR->ISK: pin with BRICKSHOP_EUR_ISK, else fetched live at scrape() start (fallback 145).
const EUR_ISK_ENV = process.env.BRICKSHOP_EUR_ISK ? Number(process.env.BRICKSHOP_EUR_ISK) : null;
let EUR_ISK       = EUR_ISK_ENV ?? 145;
const VAT        = Number(process.env.BRICKSHOP_VAT || 1.24);      // Icelandic import VAT
const EU_VAT     = Number(process.env.BRICKSHOP_EU_VAT || 1.21);   // Dutch VAT baked into the listed price
// Weight-based shipping to Iceland (buy-alone), fitted to real checkout data:
//   ship(EUR) = max(FLOOR, BASE + PER_KG * weight_kg)
const SHIP_FLOOR  = Number(process.env.BRICKSHOP_SHIP_FLOOR || 28.05);
const SHIP_BASE   = Number(process.env.BRICKSHOP_SHIP_BASE || 18.79);
const SHIP_PER_KG = Number(process.env.BRICKSHOP_SHIP_PER_KG || 4.88);
const SHIP_FALLBACK_KG = Number(process.env.BRICKSHOP_SHIP_FALLBACK_KG || 1.5); // if weight not on page
const PAGE_SIZE  = Number(process.env.BRICKSHOP_PAGE_SIZE || 40);
const MAX_PAGES  = Number(process.env.BRICKSHOP_MAX_PAGES || 12);
const REQ_DELAY  = Number(process.env.BRICKSHOP_REQ_DELAY_MS || 250);

// Category landing pages to crawl for the SKU->URL map. Defaults to the car
// themes Brick Garage tracks (F1 deliberately excluded, matching EXCLUDE_F1).
const CATEGORIES = (process.env.BRICKSHOP_CATEGORIES ||
  'lego-technichtml.html,lego-speed-championshtml.html,lego-iconshtml.html'
).split(',').map(s => s.trim()).filter(Boolean);

const RETAILER = 'brickshop';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)';

const PRODUCT_RE = /(\/lego\/[a-z0-9/-]+\/lego-(\d{3,6})[a-z0-9/-]*\.html)/gi;

// --- helpers ---------------------------------------------------------------

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getText(url, { tries = 2 } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), 25000);
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, 'Accept-Language': 'en,nl;q=0.8' },
        signal: ctl.signal,
      });
      clearTimeout(to);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (e) {
      clearTimeout(to);
      lastErr = e;
      if (i < tries - 1) await sleep(500);
    }
  }
  throw lastErr;
}

function decodeEntities(s) {
  return String(s || '')
    .replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').trim();
}

// "23.79" (dot decimal from microdata) -> 23.79
function parseEur(s) {
  if (s == null) return null;
  const n = parseFloat(String(s).replace(/[^\d.]/g, ''));
  return Number.isFinite(n) ? n : null;
}

// "119,99" / "1.199,99" (European display: comma decimal, dot thousands) -> number
function parseEuDisplay(s) {
  if (s == null) return null;
  let t = String(s).replace(/[^\d.,]/g, '');
  if (t.includes(',')) t = t.replace(/\./g, '').replace(',', '.');
  const n = parseFloat(t);
  return Number.isFinite(n) ? n : null;
}

// Parse the set's shipping weight (kg) from the product page. Brickshop lists it
// in European format, e.g. "Weight 7371 grams" or "Weight 404,67 grams" (comma =
// decimal). Returns kg or null.
function parseWeightKg(html) {
  const text = html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
  const m = text.match(/(?:weight|gewicht)\b[^0-9]{0,20}([\d.,]+)\s*(kilograms?|kilo|kg|grams?|gr|g)\b/i);
  if (!m) return null;
  const raw = m[1], unit = m[2].toLowerCase();
  // European number: comma = decimal, dot = thousands.
  //   "404,67" -> 404.67   "7371" -> 7371   "1.680" -> 1680   "1.234,56" -> 1234.56
  const num = raw.includes(',')
    ? parseFloat(raw.replace(/\./g, '').replace(',', '.'))
    : parseFloat(raw.replace(/\./g, ''));
  if (!Number.isFinite(num)) return null;
  return unit[0] === 'k' ? num : num / 1000;   // grams -> kg
}

function shippingEur(kg) {
  const w = (kg == null || !Number.isFinite(kg)) ? SHIP_FALLBACK_KG : kg;
  return Math.max(SHIP_FLOOR, SHIP_BASE + SHIP_PER_KG * w);
}

function landedIsk(eur, kg) {
  if (eur == null) return null;
  // Strip Dutch (EU) VAT (Iceland is outside the EU), add weight-based shipping,
  // then apply Icelandic import VAT and convert to ISK.
  const exEuVat = eur / EU_VAT;
  return Math.round((exEuVat + shippingEur(kg)) * VAT * EUR_ISK);
}

/**
 * Build a { sku -> productPath } map by crawling the configured category
 * listings with pagination. Deduped; stops a category when a page yields no
 * new SKUs or the page cap is hit.
 */
async function crawlCategory(cat) {
  const pairs = [];
  let seenNew = true;
  for (let page = 0; page < MAX_PAGES && seenNew; page++) {
    const url = `${BASE}/lego/${cat}?limit=${PAGE_SIZE}&limitstart=${page * PAGE_SIZE}`;
    let html;
    try { html = await getText(url); }
    catch (e) { console.warn(`[${RETAILER}] category fetch failed ${url}: ${e.message}`); break; }

    seenNew = false;
    let m;
    const re = new RegExp(PRODUCT_RE.source, PRODUCT_RE.flags); // local regex (parallel-safe)
    while ((m = re.exec(html)) !== null) {
      pairs.push([m[2], m[1]]);   // [sku, path]
      seenNew = true;
    }
    if (REQ_DELAY) await sleep(REQ_DELAY);
  }
  return pairs;
}

async function buildSkuMap() {
  // Categories are independent -> crawl them concurrently (pagination within a
  // category stays sequential since it stops once a page yields no new SKUs).
  const results = await Promise.all(CATEGORIES.map(crawlCategory));
  const map = new Map();
  for (const pairs of results) for (const [sku, path] of pairs) if (!map.has(sku)) map.set(sku, path);
  return map;
}

// Parse a single product page into a normalised record.
function parseProduct(html, sku, path) {
  const price_eur = parseEur((html.match(/itemprop=["']price["'][^>]*content=["']([^"']+)["']/i) || [])[1]);
  const currency = (html.match(/itemprop=["']priceCurrency["'][^>]*content=["']([^"']+)["']/i) || [])[1] || 'EUR';
  const availRaw = (html.match(/itemprop=["']availability["'][^>]*href=["']([^"']+)["']/i) || [])[1] || '';
  const in_stock = /InStock/i.test(availRaw);
  let name = decodeEntities((html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || [])[1] || '')
    .replace(/<[^>]+>/g, '').trim() || null;
  const weight_kg = parseWeightKg(html);

  // Sale detection: each product's price selector carries data-eur = its current
  // price. The main product's pre-discount price is the `product-Old-Price` whose
  // adjacent selector's data-eur matches itemprop=price — this ignores the
  // cross-sell items further down the page (which have their own old-prices).
  let base_eur = null;
  if (price_eur != null) {
    const pairRe = /product-Old-Price["']?[^>]*>\s*(?:&#8364;|€|&euro;)?\s*([\d.,]+)<\/span>\s*<br\s*\/?>\s*<select[^>]*class=["']productPrice multiCurrency["'][^>]*data-eur=["']([\d.,]+)["']/gi;
    for (const m of html.matchAll(pairRe)) {
      if (Math.abs(parseFloat(m[2]) - price_eur) < 0.02) { base_eur = parseEuDisplay(m[1]); break; }
    }
  }
  const on_sale = base_eur != null && base_eur > price_eur + 0.01;
  const discount_pct = on_sale ? Math.round((1 - price_eur / base_eur) * 100) : 0;

  // Piece count from the spec table ("Amount of parts: 358" / "Aantal onderdelen").
  const pieces = (() => {
    const t = html.replace(/<[^>]+>/g, ' ');
    const m = t.match(/(?:amount of parts|number of parts|aantal onderdelen)[^0-9]{0,25}(\d{2,5})/i);
    return m ? Number(m[1]) : null;
  })();

  // Bundled landed price: marginal shipping only (per-kg, shared floor/base dropped),
  // i.e. the cost when this set rides along in a larger order.
  const bundled_isk = price_eur == null ? null
    : Math.round((price_eur / EU_VAT + SHIP_PER_KG * (weight_kg ?? SHIP_FALLBACK_KG)) * VAT * EUR_ISK);

  return {
    retailer: RETAILER,
    sku,
    name,
    price_isk: landedIsk(price_eur, weight_kg),
    rrp_isk: on_sale ? landedIsk(base_eur, weight_kg) : null,
    on_sale,
    in_stock,
    url: BASE + path,
    scraped_at: new Date().toISOString(),
    price_eur,                      // extra context (ignored by DB upsert)
    currency,
    weight_kg,                      // scraped shipping weight
    shipping_eur: Math.round(shippingEur(weight_kg) * 100) / 100,
    fx_rate: EUR_ISK,               // EUR->ISK used for this landed price
    base_eur,                       // pre-discount EUR (incl. NL VAT), null if not on sale
    discount_pct,                   // % off vs base, 0 if not on sale
    bundled_isk,                    // landed price when bundled in a larger order
    pieces,                         // piece count from the spec table (or null)
  };
}

/**
 * Fetch a live EUR->ISK rate. ECB dropped ISK in 2008, so ECB-based feeds are
 * unreliable; open.er-api.com is primary, Frankfurter a secondary. Returns a
 * positive number or null (caller keeps the previous/fallback rate).
 */
async function fetchEurIsk() {
  const sources = [
    ['https://open.er-api.com/v6/latest/EUR', (d) => d && d.rates && d.rates.ISK],
    ['https://api.frankfurter.app/latest?from=EUR&to=ISK', (d) => d && d.rates && d.rates.ISK],
  ];
  for (const [url, pick] of sources) {
    try {
      const ctl = new AbortController();
      const to = setTimeout(() => ctl.abort(), 8000);
      const r = await fetch(url, { signal: ctl.signal });
      clearTimeout(to);
      if (!r.ok) continue;
      const v = Number(pick(await r.json()));
      if (Number.isFinite(v) && v > 0) return v;
    } catch { /* try next source */ }
  }
  return null;
}

/**
 * Resolve a single SKU to its product path via Brickshop's site search.
 * Catches sets in categories the crawl doesn't cover (e.g. lego-exclusives,
 * lego-creator) and retired sets. Returns "/lego/.../lego-<sku>-...html" or null.
 */
async function searchResolve(sku) {
  const url = `${BASE}/component/search/?searchword=${encodeURIComponent(sku)}&searchphrase=all`;
  let html;
  try { html = await getText(url); } catch { return null; }
  // exact-SKU product link only (avoid fuzzy name matches)
  const re = new RegExp(`(/lego/[a-z0-9/-]+/lego-${sku}(?:[^0-9][a-z0-9/-]*)?\\.html)`, 'i');
  const m = html.match(re);
  return m ? m[1] : null;
}

/**
 * scrape(skus) — fetch landed price/stock for the given LEGO set numbers.
 * @param {string[]} skus e.g. ['42172','10357']
 * @returns {Promise<Array>} normalised records (only SKUs Brickshop actually carries)
 */
export async function scrape(skus = []) {
  const wanted = [...new Set(skus.map(s => String(s).trim()))];

  // Live EUR->ISK once per run (unless pinned via env).
  if (EUR_ISK_ENV == null) {
    const live = await fetchEurIsk();
    if (live) EUR_ISK = live;
    console.error(`[${RETAILER}] EUR->ISK = ${EUR_ISK}${live ? ' (live)' : ' (fallback)'}`);
  }

  let map;
  try { map = await buildSkuMap(); }
  catch (e) { console.warn(`[${RETAILER}] could not build SKU map: ${e.message}`); map = new Map(); }

  // Resolve each SKU to a product path (crawl map first, else site search),
  // then fetch the product page. Runs with bounded concurrency so the per-SKU
  // search fallback isn't sequential (was the slow part of the daily run).
  const CONCURRENCY = Number(process.env.BRICKSHOP_CONCURRENCY || 6);
  const out = [];
  let i = 0;
  async function worker() {
    while (i < wanted.length) {
      const sku = wanted[i++];
      try {
        const path = map.get(sku) || await searchResolve(sku);
        if (!path) continue;                       // not carried anywhere on the site
        const html = await getText(BASE + path);
        const rec = parseProduct(html, sku, path);
        if (rec.price_eur != null || rec.name) out.push(rec);
      } catch (e) {
        console.warn(`[${RETAILER}] failed ${sku}: ${e.message}`);
      }
      if (REQ_DELAY) await sleep(REQ_DELAY);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, wanted.length || 1) }, worker));
  return out;
}

export const scrapeBrickshop = scrape;
export default scrape;

// CLI: `node brickshop-adapter.mjs 77261 42172 10357`
if (import.meta.url === `file://${process.argv[1]}`) {
  const skus = process.argv.slice(2);
  if (!skus.length) { console.error('usage: node brickshop-adapter.mjs <sku> [sku...]'); process.exit(1); }
  scrape(skus).then(rows => console.log(JSON.stringify(rows, null, 2)))
    .catch(e => { console.error(e); process.exit(1); });
}
