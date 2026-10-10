// brickmo-adapter.mjs
// Retailer adapter for BRICKMO (brickmo.com — SCALEMO GmbH, Gunskirchen, Austria).
// Node 18+ (global fetch). No dependencies.
//
// Brickmo is a Shopware 5 store with no public JSON API, so this is an HTML scraper.
// It prices both LEGO sets (numeric set numbers) and Mattel Brick Shop sets (toy
// numbers such as JKG40). Anchors it relies on:
//   1. Listing boxes:  <div class="product--box ..." data-ordernumber="6471558_LE">
//        LEGO ordernumbers are LEGO item numbers (useless), but the box title ends in
//        the set number ("LEGO Technic 42172 McLaren P1 42172"). Mattel ordernumbers
//        are "<toy number>_MA".
//   2. Product pages:  a "Product no: <set number>" row (authoritative — every match
//        is verified against it, because site search is fuzzy: "42172" redirects to
//        the 1x14 brick part 4217), plus Schema.org microdata inside the buybox:
//          <meta itemprop="price" content="49.99">
//          <link itemprop="availability" href="https://schema.org/PreOrder">
//   3. A real buy button (buybox--button) only when the item can be ordered. Pre-order
//      items without one show a "will be released at <date>" line and a notify form.
//
// Pricing — item price only (no shipping, no fees, no Icelandic import VAT):
//     eur_ex_vat = listed / EU_VAT       (Iceland is outside the EU, so EU VAT is not
//                                          charged — the checkout shows exactly this)
//     price_isk  = round(eur_ex_vat * Íslandsbanki card selling rate)   (see fx.mjs)
//
// EU_VAT is Brickmo's 20% Austrian VAT, confirmed against real checkouts with Iceland
// as the delivery country (Oct 2026): €49.95 -> €41.63 (42153), €259.00 -> €215.83
// (76968), both exactly /1.20.

const BASE = (process.env.BRICKMO_BASE || 'https://www.brickmo.com/en').replace(/\/+$/, '');

import { getRates } from './fx.mjs';

const EU_VAT      = Number(process.env.BRICKMO_EU_VAT || 1.20);      // Austrian VAT baked into the listed price
let FX = { mid: 145, card: 145, src: 'estimate' };                     // set at scrape() start
const toIsk = (eur) => (eur == null ? null : Math.round(eur * FX.card));
const round2 = (n) => Math.round(n * 100) / 100;

const PAGE_SIZE   = Number(process.env.BRICKMO_PAGE_SIZE || 100);    // Shopware caps n at 100
const MAX_PAGES   = Number(process.env.BRICKMO_MAX_PAGES || 15);
const REQ_DELAY   = Number(process.env.BRICKMO_REQ_DELAY_MS || 300);
const CONCURRENCY = Number(process.env.BRICKMO_CONCURRENCY || 4);

// Category listings crawled for the set -> URL map. Anything not found here falls back
// to site search, so this only needs to cover where most tracked sets live.
const CATEGORIES = (process.env.BRICKMO_CATEGORIES || [
  'lego/lego-technic', 'lego/lego-speed-champions', 'lego/lego-icons',
  'lego/lego-creator-expert', 'lego/lego-ideas', 'lego/lego-architecture',
  'lego/lego-batman-dc', 'lego/lego-jurassic-world', 'mattel-brick-shop',
].join(',')).split(',').map((s) => s.trim()).filter(Boolean);

const RETAILER = 'brickmo';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)';
const MATTEL_RE = /^[A-Z]{3}\d{2}$/;
const isMattel = (s) => MATTEL_RE.test(String(s));

// --- helpers ---------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Returns { html, url } — url is the final URL after redirects, which matters for
// search: Shopware redirects straight to the product when there is a single hit.
async function getPage(url, { tries = 2 } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), 25000);
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, 'Accept-Language': 'en,de;q=0.8' },
        signal: ctl.signal,
      });
      clearTimeout(to);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return { html: await res.text(), url: res.url || url };
    } catch (e) {
      clearTimeout(to);
      lastErr = e;
      if (i < tries - 1) await sleep(800);
    }
  }
  throw lastErr;
}

function decodeEntities(s) {
  return String(s || '')
    .replace(/&amp;/g, '&').replace(/&#0?39;/g, "'").replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
    .replace(/&euro;/g, '€').trim();
}

const num = (s) => {
  const n = parseFloat(String(s ?? '').replace(/[^\d.]/g, ''));
  return Number.isFinite(n) ? n : null;
};

// "€1,299.95" / "€49.99" (the /en shop uses dot decimals, comma thousands)
const parseEnPrice = (s) => num(String(s || '').replace(/,/g, ''));

// The set number a listing box or title belongs to. Mattel ordernumbers carry it
// directly; LEGO titles end with it ("... McLaren P1 42172").
function skuFromBox(ordernumber, title) {
  const o = String(ordernumber || '').match(/^([A-Z]{3}\d{2})_MA$/);
  if (o) return o[1];
  const t = String(title || '').trim().match(/(?:^|\s)(\d{4,6}|[A-Z]{3}\d{2})$/);
  return t ? t[1] : null;
}

function parseBoxes(html) {
  const out = [];
  for (const chunk of html.split('<div class="product--box ').slice(1)) {
    const ordernumber = (chunk.match(/data-ordernumber="([^"]+)"/) || [])[1] || '';
    const title = decodeEntities((chunk.match(/class="product--title"\s+title="([^"]+)"/) || [])[1] || '');
    const url = decodeEntities((chunk.match(/href="([^"]+)"\s+class="product--title"/) || [])[1] || '');
    const price = num((chunk.match(/data-price="([^"]+)"/) || [])[1]);
    const sku = skuFromBox(ordernumber, title);
    if (sku && url) out.push({ sku, url: url.replace(/\?c=\d+$/, ''), title, price, ordernumber });
  }
  return out;
}

// --- discovery -------------------------------------------------------------

async function crawlCategory(cat) {
  const pairs = [];
  const seen = new Set();
  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = `${BASE}/${cat}/?p=${page}&n=${PAGE_SIZE}`;
    let html;
    try { ({ html } = await getPage(url)); }
    catch (e) { console.warn(`[${RETAILER}] category fetch failed ${url}: ${e.message}`); break; }
    const boxes = parseBoxes(html);
    let fresh = 0;
    for (const b of boxes) {
      if (seen.has(b.ordernumber)) continue;   // Shopware repeats the last page past the end
      seen.add(b.ordernumber); fresh++;
      pairs.push(b);
    }
    if (!fresh || boxes.length < PAGE_SIZE) break;
    if (REQ_DELAY) await sleep(REQ_DELAY);
  }
  return pairs;
}

async function buildSkuMap() {
  const results = await Promise.all(CATEGORIES.map(crawlCategory));
  const map = new Map();
  for (const list of results) for (const b of list) if (!map.has(b.sku)) map.set(b.sku, b.url);
  return map;
}

// Site search fallback. Numeric queries are prefixed with "LEGO" — a bare number is
// matched against loose bricks first and often redirects to a part page.
async function searchResolve(sku) {
  const q = isMattel(sku) ? sku : `LEGO ${sku}`;
  let page;
  try { page = await getPage(`${BASE}/search?sSearch=${encodeURIComponent(q)}`); }
  catch { return null; }
  if (!/\/search\?/.test(page.url)) {
    // Single hit -> Shopware redirected to the product. Verified later via Product no.
    return { url: page.url, html: page.html };
  }
  const hit = parseBoxes(page.html).find((b) => b.sku === sku);
  return hit ? { url: hit.url } : null;
}

// --- product page ----------------------------------------------------------

const MONTHS = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7,
  august: 8, september: 9, october: 10, november: 11, december: 12 };

function parseProduct(html, sku, url) {
  const productNo = ((html.match(/Product no:\s*<\/td>\s*<td[^>]*>\s*([^<\s]+)\s*</i) || [])[1] || '').trim();
  if (productNo.toUpperCase() !== String(sku).toUpperCase()) return null;   // wrong product

  // Price/availability from the buybox only — cross-sell sliders further down the
  // page carry their own prices.
  const offerIdx = html.indexOf('itemprop="offers"');
  const buy = offerIdx >= 0 ? html.slice(offerIdx, offerIdx + 12000) : html;
  const price_eur = num((buy.match(/itemprop="price"\s+content="([^"]+)"/) || [])[1]);
  const availRaw = (buy.match(/itemprop="availability"\s+href="[^"]*schema\.org\/([A-Za-z]+)"/) || [])[1] || '';
  const orderable = /class="buybox--button\b/.test(html);
  const preorder = /PreOrder|PreSale/i.test(availRaw);
  const in_stock = orderable && !/OutOfStock|SoldOut|Discontinued/i.test(availRaw);

  let release = null;
  const rel = buy.match(/will be released (?:at|on)\s+(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/i);
  if (rel && MONTHS[rel[2].toLowerCase()]) {
    release = `${rel[3]}-${String(MONTHS[rel[2].toLowerCase()]).padStart(2, '0')}-${rel[1].padStart(2, '0')}`;
  }

  // Shopware pseudo price ("was") — Brickmo rarely uses it, but read it when present.
  const was = parseEnPrice((buy.match(/price--line-through[^>]*>\s*([^<]+)</) || [])[1]);
  const on_sale = was != null && price_eur != null && was > price_eur + 0.01;

  const name = decodeEntities(((html.match(/<h1[^>]*itemprop="name"[^>]*>([\s\S]*?)<\/h1>/i) || [])[1] || '')
    .replace(/<[^>]+>/g, '')) || null;
  const img = (html.match(/property="og:image"\s+content="([^"]+)"/) || [])[1] || null;

  const ex = price_eur == null ? null : round2(price_eur / EU_VAT);
  return {
    retailer: RETAILER,
    sku: String(sku),
    name,
    price_isk: toIsk(ex),                                  // ex-VAT item price at Íslandsbanki card rate
    rrp_isk: on_sale ? toIsk(round2(was / EU_VAT)) : null,
    on_sale,
    in_stock,
    preorder,
    release,                        // ISO date when the page announces one
    url: url.replace(/\?c=\d+$/, ''),
    scraped_at: new Date().toISOString(),
    price_eur,                      // listed, incl. EU VAT
    currency: 'EUR',
    eur_ex_vat: ex,                 // what the Iceland checkout charges for the item
    fx_rate: FX.mid,                // mid-market, for reference
    fx_card: FX.card, fx_src: FX.src,   // card rate price_isk was converted at
    img,
  };
}

// --- main ------------------------------------------------------------------

/**
 * scrape(skus) — landed price/stock for LEGO set numbers and Mattel toy numbers.
 * @returns {Promise<Array>} records for the SKUs Brickmo carries; `.stats.error` counts
 *          request failures so carry-forward can patch just those holes.
 */
export async function scrape(skus = []) {
  const wanted = [...new Set(skus.map((s) => String(s).trim().toUpperCase()))];

  FX = await getRates();

  let map;
  try { map = await buildSkuMap(); }
  catch (e) { console.warn(`[${RETAILER}] could not build SKU map: ${e.message}`); map = new Map(); }
  console.error(`[${RETAILER}] listing map: ${map.size} sets from ${CATEGORIES.length} categories`);

  const out = [];
  const stats = { error: 0, searched: 0, mismatched: 0 };
  let i = 0;
  async function worker() {
    while (i < wanted.length) {
      const sku = wanted[i++];
      try {
        let url = map.get(sku) || null, html = null;
        if (!url) {
          stats.searched++;
          const hit = await searchResolve(sku);
          if (!hit) continue;                     // not carried
          url = hit.url; html = hit.html || null;
        }
        if (!html) ({ html } = await getPage(url));
        const rec = parseProduct(html, sku, url);
        if (!rec) { stats.mismatched++; continue; }
        if (rec.price_eur != null) out.push(rec);
      } catch (e) {
        stats.error++;
        console.warn(`[${RETAILER}] failed ${sku}: ${e.message}`);
      }
      if (REQ_DELAY) await sleep(REQ_DELAY);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, wanted.length || 1) }, worker));
  console.error(`[${RETAILER}] ${out.length} priced, ${stats.searched} searched, ` +
    `${stats.mismatched} rejected (Product no mismatch), ${stats.error} errors`);
  out.stats = stats;
  return out;
}

export const scrapeBrickmo = scrape;
export default scrape;

// CLI: `node brickmo-adapter.mjs 42172 JKG40 JHF61`
if (import.meta.url === `file://${process.argv[1]}`) {
  const skus = process.argv.slice(2);
  if (!skus.length) { console.error('usage: node brickmo-adapter.mjs <sku> [sku...]'); process.exit(1); }
  scrape(skus).then((rows) => console.log(JSON.stringify(rows, null, 2)))
    .catch((e) => { console.error(e); process.exit(1); });
}
