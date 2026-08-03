// kidsworld-adapter.mjs
// Retailer adapter for Kids-world (kids-world.com), Icelandic storefront (is-is),
// prices in ISK. Node 18+ (global fetch). No dependencies.
//
// Gambio-style shop. Two steps:
//   1. Search:  GET /is-is/advanced_search_result.php?keywords=<sku>
//      Product cards embed price data-attributes and a product link whose slug
//      carries the LEGO set number and internal id:
//        <div class="product ..." data-id="365567">
//          <a href="/is-is/lego-technic-mclaren-p1-42172-3893-partar-p-365567.html">
//          data-final-product-price="58.887 kr."  data-base-product-price="58.887 kr."
//      final < base  => on sale (base = was-price).
//   2. Product page: GET the resolved URL -> Schema.org JSON-LD Product with
//        offers.price (ISK) + offers.availability (authoritative stock).
//
// Prices are ISK all-in — directly comparable to the other ISK retailers.
//
// Emits the shared retailer contract:
//   { retailer, sku, name, price_isk, rrp_isk, on_sale, in_stock, url, scraped_at }

const BASE   = (process.env.KIDSWORLD_BASE || 'https://www.kids-world.com').replace(/\/+$/, '');
const LOCALE = process.env.KIDSWORLD_LOCALE || 'is-is';
const REQ_DELAY = Number(process.env.KIDSWORLD_REQ_DELAY_MS || 250);
const RETAILER = 'kidsworld';
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

// "58.887 kr." -> 58887   (thousands separator '.', ISK has no decimals)
function parseIsk(s) {
  if (s == null) return null;
  const digits = String(s).replace(/kr\.?/i, '').replace(/[^\d]/g, '');
  if (!digits) return null;
  const n = parseInt(digits, 10);
  return Number.isFinite(n) ? n : null;
}

function decode(s) {
  return String(s || '')
    .replace(/&reg;/g, '®').replace(/&amp;/g, '&').replace(/&aring;/g, 'å')
    .replace(/&aelig;/g, 'æ').replace(/&oslash;/g, 'ø').replace(/&ouml;/g, 'ö')
    .replace(/&#?\w+;/g, ' ').replace(/\s+/g, ' ').trim();
}

// From the search HTML, find the card matching this SKU and pull its fields.
function findCard(html, sku) {
  const cards = html.split(/(?=<div class="product product-size-selection")/);
  const tok = new RegExp(`(?:^|[^0-9])${sku}(?:[^0-9])`);
  const linkRe = /href="(\/is-is\/[a-z0-9-]+-p-\d+\.html)"/i;
  // Prefer a card whose product link slug contains the SKU as a bounded token.
  const matches = cards.filter(c => {
    const l = c.match(linkRe);
    return l && tok.test(l[1]);
  });
  const card = matches.find(c => /lego/i.test((c.match(linkRe) || [])[1] || '')) || matches[0];
  if (!card) return null;

  const path = (card.match(linkRe) || [])[1];
  const final = parseIsk((card.match(/data-final-product-price="([^"]+)"/) || [])[1]);
  const base = parseIsk((card.match(/data-base-product-price="([^"]+)"/) || [])[1]);
  const alt = decode((card.match(/<img[^>]*\balt="([^"]+)"/i) || [])[1]);
  return { path, final, base, name: alt || null };
}

// Product page JSON-LD -> { price, availability, name }
function parseProductLd(html) {
  const blocks = [...html.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)];
  for (const [, raw] of blocks) {
    let parsed; try { parsed = JSON.parse(raw); } catch { continue; }
    for (const obj of (Array.isArray(parsed) ? parsed : [parsed])) {
      const t = obj && obj['@type'];
      if (t === 'Product' || (Array.isArray(t) && t.includes('Product'))) {
        const off = Array.isArray(obj.offers) ? obj.offers[0] : (obj.offers || {});
        return { price: off.price, availability: off.availability || '', name: obj.name || null };
      }
    }
  }
  return null;
}

/**
 * scrape(skus) — fetch price/stock for the given LEGO set numbers from kids-world.com.
 * @param {string[]} skus
 * @returns {Promise<Array>} normalised records (only SKUs kids-world carries)
 */
export async function scrape(skus = []) {
  const wanted = [...new Set(skus.map(s => String(s).trim()))];
  const out = [];
  for (const sku of wanted) {
    try {
      const searchUrl = `${BASE}/${LOCALE}/advanced_search_result.php?keywords=${encodeURIComponent(sku)}`;
      const card = findCard(await getText(searchUrl), sku);
      await sleep(REQ_DELAY);
      if (!card || !card.path) continue;

      // Authoritative price + availability from the product page.
      let ld = null;
      try { ld = parseProductLd(await getText(BASE + card.path)); await sleep(REQ_DELAY); } catch { /* fall back to card */ }

      // Must actually be LEGO: other brands (e.g. Petit Crabe) sometimes carry an
      // article number equal to a LEGO set number, so guard on name/slug.
      const nm = (ld && ld.name) || card.name || '';
      if (!/lego/i.test(nm) && !/lego/i.test(card.path)) continue;

      const price_isk = (ld && parseIsk(ld.price)) ?? card.final;
      const on_sale = card.base != null && card.final != null && card.base > card.final;
      const rrp_isk = on_sale ? card.base : null;
      const in_stock = ld ? /InStock/i.test(ld.availability) : true;

      out.push({
        retailer: RETAILER,
        sku,
        name: decode(ld && ld.name) || card.name,
        price_isk,
        rrp_isk,
        on_sale,
        in_stock,
        url: BASE + card.path,
        scraped_at: new Date().toISOString(),
      });
    } catch (e) {
      console.warn(`[${RETAILER}] failed for ${sku}: ${e.message}`);
    }
  }
  return out;
}

export const scrapeKidsworld = scrape;
export default scrape;

// CLI: `node kidsworld-adapter.mjs 42172 10357`
if (import.meta.url === `file://${process.argv[1]}`) {
  const skus = process.argv.slice(2);
  if (!skus.length) { console.error('usage: node kidsworld-adapter.mjs <sku> [sku...]'); process.exit(1); }
  scrape(skus).then(r => console.log(JSON.stringify(r, null, 2))).catch(e => { console.error(e); process.exit(1); });
}
