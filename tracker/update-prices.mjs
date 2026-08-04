// update-prices.mjs
// Scrapes the 7 retailers for every catalog set, writes prices.json (what the page
// reads), and — by diffing against the PREVIOUS committed prices.json — detects price
// drops / new sales / restocks / all-time lows on your watched (missing) sets and
// writes price-alerts.md for the workflow to raise a GitHub issue. Runs on Actions.
//
// Files (relative to this script):
//   ../index.html        catalog source (CATALOG array)
//   ../prices.json       output + previous-run history (committed)
//   ../ignore-skus.json  sets to skip entirely
//   ../watch-skus.json   OPTIONAL: only alert on these sets (missing list). Absent = all.
//   ../price-alerts.md   output: the alert report (only when there are changes)

import { readFile, writeFile } from 'node:fs/promises';
import { scrapeKubbabudin } from './kubbabudin-adapter.mjs';
import { scrapeBrickshop } from './brickshop-adapter.mjs';
import { scrapeCoolshop } from './coolshop-adapter.mjs';
import { scrapeBoozt, scrapeBooztlet } from './boozt-adapter.mjs';
import { scrapeKidsworld } from './kidsworld-adapter.mjs';
import { scrapeElko } from './elko-adapter.mjs';
import { scrapeTrekk } from './trekk-adapter.mjs';

const rel = (p) => new URL(p, import.meta.url);
const CATALOG_PATH = rel(process.env.PRICES_CATALOG || '../index.html');
const OUT_PATH     = rel(process.env.PRICES_OUT || '../prices.json');
const IGNORE_PATH  = rel(process.env.PRICES_IGNORE || '../ignore-skus.json');
const WATCH_PATH   = rel(process.env.PRICES_WATCH || '../watch-skus.json');
const ALERTS_PATH  = rel(process.env.PRICES_ALERTS || '../price-alerts.md');

// Alert thresholds (Brickshop moves slightly with live FX, so ignore tiny drifts).
const MIN_DROP_PCT = Number(process.env.PRICES_MIN_DROP_PCT || 0.05); // 5%
const MIN_DROP_ISK = Number(process.env.PRICES_MIN_DROP_ISK || 1000);

const ADAPTERS = [
  ['Kubbabúðin', scrapeKubbabudin], ['Coolshop', scrapeCoolshop],
  ['Boozt', scrapeBoozt], ['Booztlet', scrapeBooztlet],
  ['Kids-world', scrapeKidsworld], ['ELKO', scrapeElko], ['Trekk', scrapeTrekk],
  ['Brickshop', scrapeBrickshop],
];

async function readJson(url, fallback) { try { return JSON.parse(await readFile(url, 'utf8')); } catch { return fallback; } }
const fmt = (n) => (n == null ? '—' : Number(n).toLocaleString('de-DE'));

async function catalog() {
  const html = await readFile(CATALOG_PATH, 'utf8');
  const m = html.match(/const CATALOG = (\[[\s\S]*?\]);/);
  if (!m) throw new Error('CATALOG not found');
  return JSON.parse(m[1]);
}

async function main() {
  const cat = await catalog();
  const nameOf = Object.fromEntries(cat.map((e) => [String(e.n), e.name]));
  const ignore = new Set((await readJson(IGNORE_PATH, [])).map(String));
  const watchArr = await readJson(WATCH_PATH, null);
  const watch = watchArr ? new Set(watchArr.map(String)) : null; // null = watch all
  const prev = (await readJson(OUT_PATH, {})).sets || {};

  const skus = cat.map((e) => String(e.n)).filter((s) => !ignore.has(s));
  console.error(`[prices] tracking ${skus.length} sets; watching ${watch ? watch.size : 'all'}`);

  const t0 = Date.now();
  const results = await Promise.all(ADAPTERS.map(async ([label, fn]) => {
    try { const rows = await fn(skus); console.error(`  ${label}: ${rows.length}`); return [label, rows]; }
    catch (e) { console.error(`  ${label} FAILED: ${e.message}`); return [label, []]; }
  }));

  const sets = {}; let fx = null;
  for (const [label, rows] of results) for (const r of rows) {
    if (label === 'Brickshop' && r.fx_rate) fx = r.fx_rate;
    const e = (sets[r.sku] ??= { shops: {} });
    e.shops[label] = {
      p: r.price_isk, sale: !!r.on_sale, was: r.rrp_isk ?? null,
      stock: r.in_stock !== false, url: r.url || null,
      ...(label === 'Brickshop' && r.bundled_isk != null ? { bundled: r.bundled_isk } : {}),
    };
    if (r.pieces && !e.pieces) e.pieces = r.pieces;   // real piece count (from Brickshop spec table)
  }

  const alerts = [];
  const today = new Date().toISOString().slice(0, 10);
  for (const [n, e] of Object.entries(sets)) {
    let best = null;
    for (const [shop, d] of Object.entries(e.shops)) {
      if (d.p == null || !d.stock) continue;
      if (!best || d.p < best.p) best = { p: d.p, shop, url: d.url, sale: d.sale };
    }
    e.cheapest = best ? best.p : null;
    e.shop = best ? best.shop : null;
    e.url = best ? best.url : null;
    e.on_sale = best ? best.sale : false;

    // carry forward / update all-time low
    const pv = prev[n] || {};
    e.low = pv.low != null ? pv.low : null;
    e.low_date = pv.low_date || null;
    if (e.cheapest != null && (e.low == null || e.cheapest < e.low)) { e.low = e.cheapest; e.low_date = today; }

    // ---- alert logic (only for watched sets, and only on a real change) ----
    if (watch && !watch.has(n)) continue;
    if (e.cheapest == null) continue;
    const prevCheap = pv.cheapest ?? null;
    const isNewLow = pv.low != null && e.cheapest < pv.low;               // beat the old record
    const isRestock = prevCheap == null;                                  // had nothing before
    const dropIsk = prevCheap != null ? prevCheap - e.cheapest : 0;
    const dropPct = prevCheap ? dropIsk / prevCheap : 0;
    const bigDrop = dropIsk > 0 && (dropPct >= MIN_DROP_PCT || dropIsk >= MIN_DROP_ISK);
    const newSale = e.on_sale && !(pv.on_sale === true);

    let kind = null;
    if (isNewLow) kind = 'lowest';
    else if (isRestock && pv.low != null) kind = 'restock';   // only if we'd seen it before as unavailable-with-history
    else if (bigDrop) kind = 'drop';
    else if (newSale) kind = 'sale';
    if (kind) alerts.push({ n, name: nameOf[n] || n, kind, now: e.cheapest, prev: prevCheap, shop: e.shop, url: e.url, pct: Math.round(dropPct * 100), low: e.low });
  }

  const out = { updated: new Date().toISOString(), fx, count: Object.keys(sets).length, sets };
  await writeFile(OUT_PATH, JSON.stringify(out));

  // ---- alert report ----
  const ICON = { lowest: '⭐ lowest ever', drop: '▼ price drop', sale: '🏷️ new sale', restock: '🔄 back in stock' };
  const order = { lowest: 0, drop: 1, sale: 2, restock: 3 };
  alerts.sort((a, b) => order[a.kind] - order[b.kind] || (b.pct - a.pct));
  let md;
  if (alerts.length) {
    md = `# 💸 Brick Garage price watch — ${today}\n\n**${alerts.length}** change(s) on your watched sets${fx ? ` _(FX ${fx.toFixed(2)} kr/€)_` : ''}:\n\n`;
    md += `| | Set | Name | Now | Was | Shop |\n|---|---|---|---|---|---|\n`;
    for (const a of alerts) {
      const was = a.prev != null ? `${fmt(a.prev)} kr${a.pct > 0 ? ` (−${a.pct}%)` : ''}` : '—';
      const link = a.url ? `[${a.shop}](${a.url})` : a.shop;
      md += `| ${ICON[a.kind]} | ${a.n} | ${a.name} | **${fmt(a.now)} kr** | ${was} | ${link} |\n`;
    }
    md += `\n_Watching ${watch ? watch.size : 'all'} sets across 7 retailers. Only changes since the last run are shown._\n`;
  } else {
    md = `# 💸 Brick Garage price watch — ${today}\n\nNo price drops or new sales on your watched sets today.\n`;
  }
  await writeFile(ALERTS_PATH, md);
  console.error(`[prices] ${out.count} sets, ${alerts.length} alert(s), in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  if (process.env.GITHUB_OUTPUT) await writeFile(process.env.GITHUB_OUTPUT, `alert_count=${alerts.length}\n`, { flag: 'a' });
}

main().catch((e) => { console.error(e); process.exit(1); });
