// trekk-adapter.mjs
// Retailer adapter for Trekk (trekk.is), an Icelandic Odoo eCommerce shop that carries
// LEGO. Prices are all-in ISK (incl. VAT, shipping and customs — per their own terms)
// and recalculated daily from the EUR rate, so they're directly comparable to the other
// ISK retailers. Node 18+ (global fetch), no dependencies.
//
// Odoo renders the shop listing server-side. /shop?search=<sku> returns product cards;
// each has itemprop="price" (clean numeric ISK) and a name link /shop/<slug>-<id>.
// We match the card whose slug contains "lego" + the set number (Odoo's search also
// returns unrelated items whose internal ref contains the digits, e.g. Epson "S042154").
//
// Emits the shared contract:
//   { retailer, sku, name, price_isk, rrp_isk, on_sale, in_stock, url, scraped_at }

const BASE = (process.env.TREKK_BASE || 'https://trekk.is').replace(/\/+$/, '');
const REQ_DELAY = Number(process.env.TREKK_REQ_DELAY_MS || 40);
const RETAILER = 'trekk';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getText(url, tries = 2) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), 20000);
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'is,en;q=0.8' }, signal: ctl.signal, redirect: 'follow' });
      clearTimeout(to);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (e) { clearTimeout(to); lastErr = e; if (i < tries - 1) await sleep(400); }
  }
  throw lastErr;
}

const decode = (s) => String(s || '')
  .replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').trim();

function normalise(sku, name, priceStr, url, window) {
  const price_isk = priceStr != null ? Math.round(parseFloat(priceStr)) : null;
  // sale: Odoo shows a struck list price when reduced (price_reduce < list price)
  const listM = window.match(/text-decoration:\s*line-through[^>]*>\s*<span class="oe_currency_value">([\d.,]+)/i);
  const list_isk = listM ? Math.round(parseFloat(listM[1].replace(/\./g, '').replace(',', '.'))) : null;
  const on_sale = list_isk != null && price_isk != null && list_isk > price_isk;
  // in_stock: orderable unless clearly sold out (Trekk orders from supplier otherwise)
  const in_stock = !/uppselt|out of stock|ekki fáanleg/i.test(window);
  return {
    retailer: RETAILER, sku,
    name: name || null,
    price_isk,
    rrp_isk: on_sale ? list_isk : null,
    on_sale,
    in_stock,
    url: url ? BASE + url : `${BASE}/shop?search=${encodeURIComponent(sku)}`,
    scraped_at: new Date().toISOString(),
  };
}

/**
 * scrape(skus) — fetch price/stock for the given LEGO set numbers from trekk.is.
 * @param {string[]} skus
 * @returns {Promise<Array>} normalised records (only SKUs Trekk carries)
 */
export async function scrape(skus = []) {
  const wanted = [...new Set(skus.map((s) => String(s).trim()))];
  const out = [];
  for (const sku of wanted) {
    try {
      const html = await getText(`${BASE}/shop?search=${encodeURIComponent(sku)}`);
      // candidate product links; keep only LEGO ones whose slug carries the set number
      const links = [...html.matchAll(/href="(\/shop\/[A-Za-z0-9%-]+-\d+)(?:\?[^"]*)?"/g)].map((m) => m[1]);
      const url = links.find((u) => /lego/i.test(u) && new RegExp(`(^|[^0-9])${sku}([^0-9]|$)`).test(u));
      if (!url) { if (REQ_DELAY) await sleep(REQ_DELAY); continue; }

      const pos = html.indexOf(url);
      const window = html.slice(pos, pos + 3000);
      const priceStr = (window.match(/itemprop="price"[^>]*content="([\d.]+)"/i)
        || window.match(/itemprop="price"[^>]*>\s*([\d.]+)/i) || [])[1];
      const name = decode((window.match(/itemprop="name"[^>]*>\s*([^<]{3,120})/i) || [])[1])
        || decode(url.split('-').slice(1, -1).join(' '));

      if (priceStr != null) out.push(normalise(sku, name, priceStr, url, window));
      if (REQ_DELAY) await sleep(REQ_DELAY);
    } catch (e) {
      console.warn(`[${RETAILER}] failed for ${sku}: ${e.message}`);
    }
  }
  return out;
}

export const scrapeTrekk = scrape;
export default scrape;

if (import.meta.url === `file://${process.argv[1]}`) {
  const skus = process.argv.slice(2);
  if (!skus.length) { console.error('usage: node trekk-adapter.mjs <sku> [sku...]'); process.exit(1); }
  scrape(skus).then((r) => console.log(JSON.stringify(r, null, 2))).catch((e) => { console.error(e); process.exit(1); });
}
