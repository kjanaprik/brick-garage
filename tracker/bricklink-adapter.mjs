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
//
// LOT RETENTION (for bricklink-consolidate.mjs)
// The cheapest lot answers "what does this set cost". It cannot answer "does one
// seller have three of my missing sets", which is the question that actually saves
// money, because every extra parcel from the EU costs shipping + VSK on shipping +
// a flat customs handling fee. So the qualifying lots are also written, compacted,
// to bricklink-lots.json when `lotsPath` is given. This costs zero extra requests —
// catalogifs already returns up to rpp=500 lots per call and we were discarding them.
//
// Grouping key is `strSellerUsername`, NOT `strStorename`. Those two differ for the
// large majority of lots (the account 'PandaRabbit' trades as 'The Rabbit Hole'),
// and storename is a mutable display field. Username is the account handle and is
// what store.bricklink.com/<username> resolves against.

import { readFile, writeFile } from 'node:fs/promises';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// BrickLink throttles GitHub Actions egress hard: roughly 85% of lot fetches fail
// from a runner while succeeding reliably elsewhere. Long retry chains are therefore
// a trap — they multiply the cost of the common case (failure) and blew the job's
// 30-minute budget. Instead: short retries, a per-run set budget, a wall-clock
// deadline, and a circuit breaker that abandons the pass when it's clearly blocked.
// Coverage accumulates across runs, so a partial pass every day still converges.
// Through the Worker, BrickLink allowed ~21 sets before refusing in a burst, so
// pace it rather than sprinting. The Worker also retries once on 429 internally.
const REQ_DELAY = 2500;
const REQ_JITTER = 1000;
const MAX_TRIES = 2;
const CONSECUTIVE_FAIL_LIMIT = 12;   // give up on the run after this many in a row

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

// BrickLink 403s GitHub Actions' egress but answers Cloudflare's. When BL_PROXY_URL
// is set, requests go through the brick-garage-bl Worker instead of direct. Unset,
// the adapter behaves exactly as before, so this is safe to deploy ahead of the
// Worker and to fall back to if the Worker is ever down.
const PROXY = (process.env.BL_PROXY_URL || '').replace(/\/$/, '');
const PROXY_KEY = process.env.BL_PROXY_KEY || '';
const viaProxy = () => !!PROXY;

const SEARCH_URL = (setno) =>
  viaProxy()
    ? `${PROXY}/resolve?setno=${encodeURIComponent(setno)}`
    : 'https://www.bricklink.com/ajax/clone/search/searchproduct.ajax?' +
  `q=${encodeURIComponent(setno)}&st=0&cond=&type=S&cat=&yf=0&yt=0&loc=&reg=0` +
  '&ca=0&ss=&pmt=&nmp=0&color=-1&min=0&max=0&minqty=0&nosuperlot=1' +
      '&incomplete=0&showempty=1&rpp=5&pi=1&ci=0';

const LOTS_URL = (itemid, sku) =>
  viaProxy()
    ? `${PROXY}/lots?sku=${encodeURIComponent(sku)}&itemid=${itemid}`
    : `https://www.bricklink.com/ajax/clone/catalogifs.ajax?itemid=${itemid}` +
      '&rpp=500&cond=N&ss=IS';

async function getJson(url, referer) {
  let last;
  for (let i = 0; i < MAX_TRIES; i++) {
    try {
      const headers = PROXY_KEY && viaProxy()
        ? { 'X-BG-Key': PROXY_KEY }
        : { 'User-Agent': UA, Accept: 'application/json', Referer: referer };
      const res = await fetch(url, { headers });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = await res.json();
      if (j.error) throw new Error(j.error);
      // returnCode 0 = OK. Anything else (e.g. -1 "Invalid request!") is a failure.
      // The proxy strips returnCode, so only check it on direct responses.
      if (!viaProxy() && j.returnCode !== 0) {
        throw new Error(j.returnMessage || `returnCode ${j.returnCode}`);
      }
      return j;
    } catch (e) {
      last = e;
      if (i < MAX_TRIES - 1) await sleep(1500 + Math.random() * 500);
    }
  }
  throw last;
}

// "US $157.30" -> 157.30 ; "None" -> null
function usd(s) {
  const str = String(s ?? '');
  if (!str || str === 'None') return null;
  const m = str.match(/([\d.,]+)\s*$/);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

// open.er-api publishes the mid-market rate, but nothing is ever bought at mid.
// Paying a European seller by card settles at the card scheme's sell rate plus the
// issuer's FX fee — on 12.09.2026 Visa's EUR sölugengi was 143.1939 against a
// mid of 140.42, a spread of 1.97%. That spread is contractual and stable even as
// the underlying rate moves daily, so applying it as a multiplier tracks the real
// cost far better than mid does. Override with PRICES_FX_SPREAD (e.g. '0' for mid).
const FX_SPREAD = Number(process.env.PRICES_FX_SPREAD ?? 0.02);

async function usdToIsk() {
  try {
    const r = await fetch('https://open.er-api.com/v6/latest/USD');
    const j = await r.json();
    const mid = j?.rates?.ISK;
    if (mid) return mid * (1 + FX_SPREAD);
  } catch { /* fall through */ }
  return null;
}

/**
 * Resolve set numbers to BrickLink idItem values, using a committed cache.
 * itemids never change, so each set costs one request exactly once.
 */
async function resolveItemIds(skus, cachePath, deadline = Infinity) {
  let cache = {};
  try { cache = JSON.parse(await readFile(cachePath, 'utf8')); } catch { /* first run */ }

  const missing = skus.filter((s) => cache[s] === undefined);
  let resolved = 0, notFound = 0;

  for (const sku of missing) {
    if (Date.now() > deadline) { console.error('[bricklink] id resolution hit the time budget'); break; }
    const setno = `${sku}-1`;
    try {
      const j = await getJson(SEARCH_URL(setno), 'https://www.bricklink.com/v2/search.page');
      let idItem = null;
      if (viaProxy()) {
        idItem = j.idItem ?? null;
      } else {
        const items = (j.result?.typeList || []).flatMap((t) => t.items || []);
        idItem = (items.find((it) => it.strItemNo === setno) || items[0])?.idItem ?? null;
      }
      if (idItem) { cache[sku] = idItem; resolved++; }
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

// Strip a raw catalogifs lot down to what the consolidator needs. Keeping the full
// record would make bricklink-lots.json ~15x larger for fields nothing reads.
function compactLot(x) {
  return {
    u: x.strSellerUsername || null,          // grouping key — see header note
    store: x.strStorename || x.strSellerUsername || null,
    cc: (x.strSellerCountryCode || '').toUpperCase() || null,
    usd: usd(x.mDisplaySalePrice),
    native: x.mInvSalePrice || null,         // "EUR 135.00" — the seller's own price
    c: x.codeComplete || null,               // 'S' sealed | 'C' complete
    qty: x.n4Qty ?? null,
    fb: x.n4SellerFeedbackScore ?? null,
    minbuy: usd(x.mMinBuy),                  // null when the store has no minimum
  };
}

/**
 * @param {string[]} skus
 * @param {object} [opts]
 * @param {string} [opts.cachePath]  where to persist the setno->itemid map
 * @param {string} [opts.lotsPath]   where to persist per-sku lot lists for the
 *                                   consolidator. Omit to skip lot retention
 *                                   entirely (behaviour identical to before).
 * @param {number} [opts.keepLots]   max lots retained per set (default 40). Beyond
 *                                   the cheapest ~40 a seller is never going to be
 *                                   part of a sensible basket.
 * @returns {Promise<object>} { sku: { min_isk, lots, ... } } with a .stats property
 */
export async function scrapeBricklink(skus = [], opts = {}) {
  const all = [...new Set(skus.map(String).filter(Boolean))];
  const cachePath = opts.cachePath || new URL('../bricklink-ids.json', import.meta.url);
  const lotsPath = opts.lotsPath || null;
  const keepLots = opts.keepLots ?? 40;
  const maxPerRun = opts.maxPerRun ?? 45;
  const deadline = Date.now() + (opts.budgetMs ?? 8 * 60 * 1000);
  const prev = opts.prev || {};

  // Prioritise sets we have nothing for, then the ones fetched longest ago, so
  // repeated partial runs converge on full coverage instead of re-checking the
  // same head of the list every day.
  const wanted = [...all].sort((a, b) => {
    const ta = prev[a]?.scraped_at ? Date.parse(prev[a].scraped_at) : 0;
    const tb = prev[b]?.scraped_at ? Date.parse(prev[b].scraped_at) : 0;
    return ta - tb;
  }).slice(0, maxPerRun);

  const ids = await resolveItemIds(wanted, cachePath, deadline);
  const fx = await usdToIsk();
  if (!fx) console.warn('[bricklink] no USD->ISK rate; prices will be USD only');

  // Lot retention merges into whatever is already on disk rather than replacing it,
  // for the same reason carry-forward.mjs exists: a throttled run covering 12 sets
  // must not wipe the other 90. Staleness is handled downstream — each sku carries
  // its own fetch time and the consolidator refuses to plan on old lots.
  let lotStore = {};
  if (lotsPath) {
    try { lotStore = JSON.parse(await readFile(lotsPath, 'utf8')); } catch { /* first run */ }
  }

  const out = {};
  const stats = { requested: wanted.length, ofTotal: all.length, hit: 0, noLots: 0, noId: 0, error: 0, aborted: false };
  let consecutiveFails = 0;
  let noUsername = 0;

  for (const sku of wanted) {
    if (Date.now() > deadline) {
      stats.aborted = 'deadline';
      console.error('[bricklink] time budget reached — stopping this run');
      break;
    }
    if (consecutiveFails >= CONSECUTIVE_FAIL_LIMIT) {
      stats.aborted = 'blocked';
      console.error(`[bricklink] ${consecutiveFails} failures in a row — abandoning this run`);
      break;
    }
    const itemid = ids[sku];
    if (!itemid) { stats.noId++; continue; }

    try {
      const j = await getJson(
        LOTS_URL(itemid, sku),
        `https://www.bricklink.com/v2/catalog/catalogitem.page?S=${sku}-1`
      );
      // The Worker applies the same completeness/Europe filter before responding,
      // so proxied results arrive ready to use.
      const lots = viaProxy()
        ? (j.lots || [])
        : (j.list || []).filter(
            (x) =>
              KEEP_COMPLETE.has(x.codeComplete) &&
              EUROPE.has(String(x.strSellerCountryCode || '').toUpperCase())
          );

      if (!lots.length) { stats.noLots++; consecutiveFails = 0; continue; }

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
      consecutiveFails = 0;

      if (lotsPath) {
        const compact = lots.slice(0, keepLots).map(compactLot).filter((l) => l.usd != null);
        if (compact.length && !compact.some((l) => l.u)) noUsername++;
        lotStore[sku] = { scraped_at: out[sku].scraped_at, lots: compact };
      }
    } catch (e) {
      stats.error++;
      consecutiveFails++;
      console.warn(`[bricklink] lots failed for ${sku}: ${e.message}`);
    }
    await sleep(REQ_DELAY + Math.random() * REQ_JITTER);
  }

  if (lotsPath) {
    if (noUsername) {
      // Only reachable via the Worker. If it ever compacts lots server-side it must
      // keep strSellerUsername, or seller grouping degrades to storename and is wrong.
      console.warn(
        `[bricklink] ${noUsername} sets returned lots with no strSellerUsername — ` +
        'the proxy is stripping the seller handle; consolidation will be unreliable'
      );
    }
    try {
      await writeFile(lotsPath, JSON.stringify(lotStore, null, 0));
      const n = Object.keys(lotStore).length;
      console.error(`[bricklink] lot store: ${n} sets on file`);
    } catch (e) {
      console.warn(`[bricklink] could not write lot store: ${e.message}`);
    }
  }

  console.error(
    `[bricklink] ${stats.hit} with lots / ${stats.noLots} none in EU+ships-IS / ` +
      `${stats.noId} not in catalog / ${stats.error} error of ${stats.requested} ` +
      `(${stats.ofTotal} tracked)` + (stats.aborted ? ` [ABORTED: ${stats.aborted}]` : '') +
      (fx ? ` (USD ${fx.toFixed(2)} kr)` : '') + (viaProxy() ? ' [via worker]' : '')
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
    lotsPath: new URL('./bricklink-lots.json', import.meta.url),
  });
  console.log(JSON.stringify(res, null, 2));
}
