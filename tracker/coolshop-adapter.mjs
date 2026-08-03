// coolshop-adapter.mjs
// Retailer adapter for Coolshop Iceland (coolshop.is).
// Node 18+ (global fetch). No dependencies.
//
// Coolshop is a headless storefront. Two endpoints make this clean:
//   1. Keyword search:  POST /api/search?q=<term>   (body '{}')  -> JSON envelope
//      whose `results` field is an HTML fragment of product cards. Each card links
//      to /vara/<slug>/<PRODUCT_ID>/ and the slug embeds the LEGO set number.
//   2. Product page:     GET /vara/<slug>/<id>/  -> carries Schema.org JSON-LD with
//        { name, sku:<coolshop id>, mpn:<LEGO set number>, gtin13,
//          offers:{ price, priceCurrency:"ISK", availability } }
//
// We search by set number to resolve the product URL, then read the product page's
// JSON-LD as the authoritative source (price + stock + mpn match). Prices are ISK
// all-in (VAT/shipping-of-record included), directly comparable to Kubbabúðin.
//
// Emits the shared retailer contract:
//   { retailer, sku, name, price_isk, rrp_isk, on_sale, in_stock, url, scraped_at, gtin }
//
// Sale detection is left to the pipeline's PriceHistory drop-logic (Coolshop's
// JSON-LD carries no reliable was-price), consistent with the other adapters.

const BASE = (process.env.COOLSHOP_BASE || 'https://www.coolshop.is').replace(/\/+$/, '');
const REQ_DELAY = Number(process.env.COOLSHOP_REQ_DELAY_MS || 200);
const RETAILER = 'coolshop';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)';

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchWithRetry(url, opts = {}, tries = 2) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), 25000);
    try {
      const res = await fetch(url, {
        ...opts,
        headers: { 'User-Agent': UA, 'Accept-Language': 'is,en;q=0.8', ...(opts.headers || {}) },
        signal: ctl.signal,
      });
      clearTimeout(to);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res;
    } catch (e) {
      clearTimeout(to); lastErr = e;
      if (i < tries - 1) await sleep(500);
    }
  }
  throw lastErr;
}

function parseIsk(s) {
  if (s == null) return null;
  // JSON-LD price is like "77999.00"; keep integer krónur.
  const n = Math.round(parseFloat(String(s).replace(/[^\d.]/g, '')));
  return Number.isFinite(n) ? n : null;
}

// From a search `results` HTML fragment, find the product path whose slug embeds
// the exact set number. Prefers LEGO listings (other brands occasionally reuse the
// same digits as their own article number). Returns "/vara/<slug>/<id>/" or null.
function resolvePathForSku(resultsHtml, sku) {
  const links = [...resultsHtml.matchAll(/href="(\/vara\/[^"]+\/[A-Z0-9]+\/)"/g)].map(m => m[1]);
  const rx = new RegExp(`(?:^|[^0-9])${sku}(?:[^0-9]|/)`); // sku as a bounded token in the slug
  const candidates = links.filter(p => rx.test(p));
  if (!candidates.length) return null;
  return candidates.find(p => /\/vara\/lego-/i.test(p)) || candidates[0];
}

async function searchPath(sku) {
  const res = await fetchWithRetry(`${BASE}/api/search?q=${encodeURIComponent(sku)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
    body: '{}',
  });
  const data = await res.json();
  if (!data || !data.count) return null;
  return resolvePathForSku(data.results || '', sku);
}

// Parse the product page JSON-LD Product block.
function parseProductLd(html) {
  const blocks = [...html.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)];
  for (const [, raw] of blocks) {
    let parsed;
    try { parsed = JSON.parse(raw); } catch { continue; }
    const arr = Array.isArray(parsed) ? parsed : [parsed];
    for (const obj of arr) {
      const t = obj && obj['@type'];
      if (t === 'Product' || (Array.isArray(t) && t.includes('Product'))) {
        const offers = Array.isArray(obj.offers) ? obj.offers[0] : (obj.offers || {});
        return {
          name: obj.name || null,
          mpn: obj.mpn != null ? String(obj.mpn) : null,
          gtin: obj.gtin13 || obj.gtin || null,
          price: offers.price,
          currency: offers.priceCurrency,
          availability: offers.availability || '',
        };
      }
    }
  }
  return null;
}

/**
 * scrape(skus) — fetch price/stock for the given LEGO set numbers from Coolshop.is.
 * @param {string[]} skus e.g. ['42172','10357']
 * @returns {Promise<Array>} normalised records (only SKUs Coolshop actually carries)
 */
export async function scrape(skus = []) {
  const wanted = [...new Set(skus.map(s => String(s).trim()))];
  const out = [];

  for (const sku of wanted) {
    try {
      const path = await searchPath(sku);
      await sleep(REQ_DELAY);
      if (!path) continue; // not carried / no confident match

      const res = await fetchWithRetry(`${BASE}${path}`);
      const html = await res.text();
      const ld = parseProductLd(html);
      await sleep(REQ_DELAY);
      if (!ld) continue;

      // Must actually be LEGO: other brands (e.g. Gonher) sometimes reuse the same
      // digits as their own article number, so guard on brand/name.
      const isLego = /lego/i.test(ld.brand || '') || /lego/i.test(ld.name || '');
      if (!isLego) continue;
      // Defensive: the product's manufacturer part number should be the LEGO SKU.
      if (ld.mpn && ld.mpn !== sku) continue;

      out.push({
        retailer: RETAILER,
        sku,
        name: ld.name,
        price_isk: parseIsk(ld.price),
        rrp_isk: null,
        on_sale: false,               // handled by DB price-history
        in_stock: /InStock/i.test(ld.availability),
        url: `${BASE}${path}`,
        scraped_at: new Date().toISOString(),
        gtin: ld.gtin || null,        // extra context (ignored by DB upsert)
      });
    } catch (e) {
      console.warn(`[${RETAILER}] failed for ${sku}: ${e.message}`);
    }
  }
  return out;
}

export const scrapeCoolshop = scrape;
export default scrape;

// CLI: `node coolshop-adapter.mjs 42172 10357`
if (import.meta.url === `file://${process.argv[1]}`) {
  const skus = process.argv.slice(2);
  if (!skus.length) { console.error('usage: node coolshop-adapter.mjs <sku> [sku...]'); process.exit(1); }
  scrape(skus).then(rows => console.log(JSON.stringify(rows, null, 2)))
    .catch(e => { console.error(e); process.exit(1); });
}
