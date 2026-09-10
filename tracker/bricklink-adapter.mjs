// bricklink-adapter.mjs
//
// Reads BrickLink's anonymous ajax endpoints — no OAuth, no API key.
//
//   1. searchproduct.ajax?q=<setno>-1&type=S   ->  idItem  (stable forever, cached)
//   2. catalogifs.ajax?itemid=<id>&cond=N&ss=IS ->  live lots for sale
//
// Filtering, per project decisions:
//   * cond=N            server-side: new only
//   * ss=IS             server-side: seller ships to Iceland
//   * codeComplete      client-side: keep 'S' (sealed) and 'C' (complete),
//                       drop 'B' (incomplete). cond=N alone does NOT do this.
//   * seller country    client-side: geographic Europe, including UK and
//                       Switzerland. BrickLink's own reg=6 is EU-strict and
//                       excludes both, so it is deliberately NOT used.
//
// Prices are per-lot and EXCLUDE shipping, Icelandic VSK and customs handling.
// They are written to a separate `bricklink` block in prices.json, never mixed
// into `shops`, precisely because they aren't comparable to a landed retail price.

import { readFile, writeFile } from 'node:fs/promises';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const REQ_DELAY = 900;
const REQ_JITTER = 400;
const MAX_TRIES = 3;

// Geographic Europe, ISO-3166-alpha-2 as BrickLink reports them in
// strSellerCountryCode. Includes GB and CH by choice.
const EUROPE = new Set([
  'AD','AL','AM','AT','AX','AZ','BA','BE','BG','BY','CH','CY','CZ','DE','DK',
  'EE','ES','FI','FO','FR','GB','GE','GG','GI','GR','HR','HU','IE','IM','IS',
  'IT','JE','LI','LT','LU','LV','MC','MD','ME','MK','MT','NL','NO','PL','PT',
  'RO','RS','RU','SE','SI','SJ','SK','SM','TR','UA','VA','XK',
]);

const KEEP_COMPLETE = new Set(['S', 'C']);   // sealed, complete. 'B' = incomplete.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SEARCH_URL = (setno) =>
  'https://www.bricklink.com/ajax/clone/search/searchproduct.ajax?' +
  `q=${encodeURIComponent(setno)}&st=0&cond=&type=S&cat=&yf=0&yt=0&loc=&reg=0` +
  '&ca=0&ss=&pmt=&nmp=0&color=-1&min=0&max=0&minqty=0&nosuperlot=1' +
  '&incomplete=0&showempty=1&rpp=5&pi=1&ci=0';

const LOTS_URL = (itemid) =>
  `https://www.bricklink.com/ajax/clone/catalogifs.ajax?itemid=${itemid}` +
  '&rpp=500&cond=N&ss=IS';

async function getJson(url, referer) {
  let last;
  for (let i = 0; i < MAX_TRIES; i++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, Accept: 'application/json', Referer: referer },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = await res.json();
      // returnCode 0 = OK. Anything else (e.g. -1 "Invalid request!") is a failure.
      if (j.returnCode !== 0) throw new Error(j.returnMessage || `returnCode ${j.returnCode}`);
      return j;
    } catch (e) {
      last = e;
      if (i < MAX_TRIES - 1) await sleep(1200 * 2 ** i + Math.random() * 400);
    }
  }
  throw last;
}

// "US $157.30" -> 157.30
function usd(s) {
  const m = String(s || '').match(/([\d.,]+)\s*$/);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

async function usdToIsk() {
  try {
    const r = await fetch('https://open.er-api.com/v6/latest/USD');
    const j = await r.json();
    const rate = j?.rates?.ISK;
    if (rate) return rate;
  } catch { /* fall through */ }
  return null;
}

/**
 * Resolve set numbers to BrickLink idItem values, using a committed cache.
 * itemids never change, so each set costs one request exactly once.
 */
async function resolveItemIds(skus, cachePath) {
  let cache = {};
  try { cache = JSON.parse(await readFile(cachePath, 'utf8')); } catch { /* first run */ }

  const missing = skus.filter((s) => cache[s] === undefined);
  let resolved = 0, notFound = 0;

  for (const sku of missing) {
    const setno = `${sku}-1`;
    try {
      const j = await getJson(SEARCH_URL(setno), 'https://www.bricklink.com/v2/search.page');
      const items = (j.result?.typeList || []).flatMap((t) => t.items || []);
      const hit = items.find((it) => it.strItemNo === setno) || items[0];
      if (hit?.idItem) { cache[sku] = hit.idItem; resolved++; }
      else { cache[sku] = null; notFound++; }   // cache the negative too
    } catch (e) {
      console.warn(`[bricklink] itemid lookup failed for ${setno}: ${e.message}`);
      // leave uncached so it retries next run
    }
    await sleep(REQ_DELAY + Math.random() * REQ_JITTER);
  }

  if (missing.length) {
    console.error(`[bricklink] itemids: +${resolved} resolved, ${notFound} not in catalog`);
    try { await writeFile(cachePath, JSON.stringify(cache, null, 1)); }
    catch (e) { console.warn(`[bricklink] could not write id cache: ${e.message}`); }
  }
  return cache;
}

/**
 * @param {string[]} skus
 * @param {object} [opts]
 * @param {string} [opts.cachePath]  where to persist the setno->itemid map
 * @returns {Promise<object>} { sku: { min_isk, lots, ... } } with a .stats property
 */
export async function scrapeBricklink(skus = [], opts = {}) {
  const wanted = [...new Set(skus.map(String).filter(Boolean))];
  const cachePath = opts.cachePath || new URL('../bricklink-ids.json', import.meta.url);

  const ids = await resolveItemIds(wanted, cachePath);
  const fx = await usdToIsk();
  if (!fx) console.warn('[bricklink] no USD->ISK rate; prices will be USD only');

  const out = {};
  const stats = { requested: wanted.length, hit: 0, noLots: 0, noId: 0, error: 0 };

  for (const sku of wanted) {
    const itemid = ids[sku];
    if (!itemid) { stats.noId++; continue; }

    try {
      const j = await getJson(
        LOTS_URL(itemid),
        `https://www.bricklink.com/v2/catalog/catalogitem.page?S=${sku}-1`
      );
      const lots = (j.list || []).filter(
        (x) =>
          KEEP_COMPLETE.has(x.codeComplete) &&
          EUROPE.has(String(x.strSellerCountryCode || '').toUpperCase())
      );

      if (!lots.length) { stats.noLots++; continue; }

      lots.sort((a, b) => (usd(a.mDisplaySalePrice) ?? 1e9) - (usd(b.mDisplaySalePrice) ?? 1e9));
      const best = lots[0];
      const bestUsd = usd(best.mDisplaySalePrice);
      const sealed = lots.filter((x) => x.codeComplete === 'S');

      out[sku] = {
        min_usd: bestUsd,
        min_isk: bestUsd != null && fx ? Math.round(bestUsd * fx) : null,
        lots: lots.length,
        sealed_lots: sealed.length,
        seller: best.strStorename || best.strSellerUsername || null,
        country: best.strSellerCountryCode || null,
        country_name: best.strSellerCountryName || null,
        sealed: best.codeComplete === 'S',
        feedback: best.n4SellerFeedbackScore ?? null,
        qty: best.n4Qty ?? null,
        native: best.mInvSalePrice || null,     // e.g. "EUR 135.00" — seller's own currency
        url: `https://www.bricklink.com/v2/catalog/catalogitem.page?S=${sku}-1#T=S&C=new`,
        scraped_at: new Date().toISOString(),
      };
      stats.hit++;
    } catch (e) {
      stats.error++;
      console.warn(`[bricklink] lots failed for ${sku}: ${e.message}`);
    }
    await sleep(REQ_DELAY + Math.random() * REQ_JITTER);
  }

  console.error(
    `[bricklink] ${stats.hit} with lots / ${stats.noLots} none in EU+ships-IS / ` +
      `${stats.noId} not in catalog / ${stats.error} error of ${stats.requested}` +
      (fx ? ` (USD ${fx.toFixed(2)} kr)` : '')
  );

  Object.defineProperty(out, 'stats', { value: stats, enumerable: false });
  Object.defineProperty(out, 'fx_usd', { value: fx, enumerable: false });
  return out;
}

export default { scrapeBricklink };

// CLI: node bricklink-adapter.mjs 10262 11376 42236
if (import.meta.url === `file://${process.argv[1]}`) {
  const res = await scrapeBricklink(process.argv.slice(2), {
    cachePath: new URL('./bricklink-ids.json', import.meta.url),
  });
  console.log(JSON.stringify(res, null, 2));
}
