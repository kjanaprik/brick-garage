// bricklink-sellers.mjs
//
// "Which BrickLink sellers have several of the sets I'm missing, at a decent price?"
//
// Reads bricklink-lots.json (written by bricklink-adapter.mjs when `lotsPath` is
// set). No network requests of its own.
//
// Item price only. No shipping, no VSK, no customs handling, no per-parcel cost
// model — those live downstream in the landed-cost thinking, not here.
//
// WHAT "LOWER TIER" MEANS
// An absolute threshold ("within $20 of the cheapest") doesn't travel between sets:
// 10265 had 122 qualifying lots and 42143 had 67, and their price spreads are
// nothing alike. So a lot qualifies by its RANK among that set's qualifying lots.
// At the default tier of 33, a seller counts toward a set only if their price is in
// the cheapest third of listings for it. A seller sitting mid-pack on everything
// therefore scores zero sets rather than topping the table on coverage alone.
//
// GROUPING KEY
// `strSellerUsername`, never `strStorename`. Those differ for the large majority of
// lots — the account 'Brickwise' trades as 'TheBelgianBrick (BE/NL)' — and storename
// is a mutable display field. Username is what store.bricklink.com/<username> takes.
//
// STALENESS
// Lots sell. Sets whose lots are older than `maxAgeHours` are excluded and listed
// separately rather than quietly planned around. For a list you intend to act on,
// fetch the missing sets in one pass first:
//
//   node tracker/bricklink-adapter.mjs 10262 42143 42115 ...
//
// The daily run deliberately covers a rotating subset, so left to itself it will
// have you comparing Monday's lots against Thursday's.

import { readFile } from 'node:fs/promises';

const storeUrl = (u) => `https://store.bricklink.com/${encodeURIComponent(u)}`;
const round2 = (n) => Math.round(n * 100) / 100;

/**
 * @param {object} lotStore           parsed bricklink-lots.json
 * @param {object} [opts]
 * @param {string[]} [opts.sets]      restrict to these skus (your missing list).
 *                                    Omit to consider everything on file.
 * @param {number} [opts.tier]        keep lots in the cheapest N% of a set's
 *                                    listings. Default 33. Use 100 for no filter.
 * @param {number} [opts.minSets]     minimum sets a seller must cover. Default 2.
 * @param {number} [opts.maxAgeHours] default 48
 * @param {boolean} [opts.sealedOnly] require codeComplete 'S'. Default false, which
 *                                    also accepts 'C' (complete, opened box).
 * @param {number} [opts.fxIsk]       USD->ISK rate, to annotate in kr
 */
export function sellerOverlap(lotStore, opts = {}) {
  const tier = opts.tier ?? 33;
  const minSets = opts.minSets ?? 2;
  const maxAgeHours = opts.maxAgeHours ?? 48;
  const sealedOnly = !!opts.sealedOnly;
  const fx = opts.fxIsk ?? null;

  const want = opts.sets?.length
    ? new Set(opts.sets.map(String))
    : new Set(Object.keys(lotStore));

  const cutoff = Date.now() - maxAgeHours * 3600 * 1000;
  const stale = [], noLots = [], covered = [];

  // sku -> username -> { usd, c, qty, native, rank, of, pctile, overFloor }
  const bySet = new Map();
  const sellerMeta = new Map();
  const floor = {};

  for (const sku of want) {
    const rec = lotStore[sku];
    if (!rec?.lots?.length) { noLots.push(sku); continue; }
    if (rec.scraped_at && Date.parse(rec.scraped_at) < cutoff) { stale.push(sku); continue; }

    // Cheapest qualifying lot per seller. A store listing the same set twice would
    // otherwise be ranked on whichever copy happened to come first.
    const perSeller = new Map();
    for (const l of rec.lots) {
      if (!l.u || l.usd == null) continue;
      if (sealedOnly && l.c !== 'S') continue;
      const cur = perSeller.get(l.u);
      if (!cur || l.usd < cur.usd) {
        perSeller.set(l.u, { usd: l.usd, c: l.c, qty: l.qty, native: l.native });
      }
      const m = sellerMeta.get(l.u);
      if (!m || (l.fb ?? 0) > (m.fb ?? 0)) {
        sellerMeta.set(l.u, { store: l.store || l.u, cc: l.cc, fb: l.fb, minbuy: l.minbuy });
      }
    }
    if (!perSeller.size) { noLots.push(sku); continue; }

    // Rank sellers cheapest-first for this set. pctile 0 = cheapest in the market.
    const ordered = [...perSeller.entries()].sort((a, b) => a[1].usd - b[1].usd);
    const n = ordered.length;
    const low = ordered[0][1].usd;
    ordered.forEach(([, v], i) => {
      v.rank = i + 1;
      v.of = n;
      v.pctile = n > 1 ? Math.round((i / (n - 1)) * 100) : 0;
      v.overFloor = round2(v.usd - low);
      v.overFloorPct = low > 0 ? round2(((v.usd - low) / low) * 100) : 0;
    });

    floor[sku] = {
      usd: round2(low),
      seller: ordered[0][0],
      store: sellerMeta.get(ordered[0][0])?.store || ordered[0][0],
      country: sellerMeta.get(ordered[0][0])?.cc || null,
      lots: n,
      median_usd: round2(ordered[Math.floor((n - 1) / 2)][1].usd),
      max_usd: round2(ordered[n - 1][1].usd),
    };
    bySet.set(sku, perSeller);
    covered.push(sku);
  }

  // Invert to seller -> sets, applying the tier filter as we go.
  const sellers = new Map();
  for (const [sku, perSeller] of bySet) {
    for (const [u, v] of perSeller) {
      if (v.pctile > tier) continue;
      if (!sellers.has(u)) sellers.set(u, {});
      sellers.get(u)[sku] = v;
    }
  }

  const ranked = [];
  for (const [u, sets] of sellers) {
    const skus = Object.keys(sets).sort();
    if (skus.length < minSets) continue;
    const subtotal = skus.reduce((a, s) => a + sets[s].usd, 0);
    const floorSub = skus.reduce((a, s) => a + floor[s].usd, 0);
    const meta = sellerMeta.get(u) || {};
    const meanPctile = Math.round(skus.reduce((a, s) => a + sets[s].pctile, 0) / skus.length);
    ranked.push({
      seller: u,
      store: meta.store || u,
      country: meta.cc || null,
      feedback: meta.fb ?? null,
      min_buy_usd: meta.minbuy ?? null,
      meets_min_buy: !meta.minbuy || subtotal >= meta.minbuy,
      set_count: skus.length,
      sets: skus,
      mean_pctile: meanPctile,
      subtotal_usd: round2(subtotal),
      subtotal_isk: fx ? Math.round(subtotal * fx) : null,
      floor_subtotal_usd: round2(floorSub),
      over_floor_usd: round2(subtotal - floorSub),
      over_floor_pct: floorSub > 0 ? round2(((subtotal - floorSub) / floorSub) * 100) : 0,
      lots: Object.fromEntries(skus.map((s) => [s, {
        usd: round2(sets[s].usd),
        isk: fx ? Math.round(sets[s].usd * fx) : null,
        native: sets[s].native,
        sealed: sets[s].c === 'S',
        qty: sets[s].qty,
        rank: sets[s].rank,
        of: sets[s].of,
        pctile: sets[s].pctile,
        over_floor_usd: sets[s].overFloor,
        over_floor_pct: sets[s].overFloorPct,
      }])),
      url: storeUrl(u),
    });
  }

  // Coverage first, then cheapness. Two sellers with the same number of sets are
  // separated by how far over the market floor they sit in aggregate, which is a
  // truer tiebreak than raw subtotal when the two cover different sets.
  ranked.sort((a, b) =>
    b.set_count - a.set_count ||
    a.over_floor_pct - b.over_floor_pct ||
    a.subtotal_usd - b.subtotal_usd
  );

  return {
    generated_at: new Date().toISOString(),
    params: { tier, min_sets: minSets, sealed_only: sealedOnly, max_age_hours: maxAgeHours },
    coverage: {
      requested: want.size,
      covered: covered.sort(),
      stale: stale.sort(),
      no_lots: noLots.sort(),
    },
    floor,
    sellers: ranked,
  };
}

export async function sellerOverlapFile(lotsPath, opts = {}) {
  return sellerOverlap(JSON.parse(await readFile(lotsPath, 'utf8')), opts);
}

export default { sellerOverlap, sellerOverlapFile };

// ---- CLI ----------------------------------------------------------------
// node bricklink-sellers.mjs [--tier 25] [--min 3] [--sealed] [--age 24] [--json] [sku...]
if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const flag = (n) => argv.includes(n);
  const val = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? Number(argv[i + 1]) : d; };
  const sets = argv.filter((a) => /^\d{4,7}$/.test(a));

  const res = await sellerOverlapFile(
    new URL('./bricklink-lots.json', import.meta.url),
    {
      sets,
      tier: val('--tier', undefined),
      minSets: val('--min', undefined),
      sealedOnly: flag('--sealed'),
      maxAgeHours: val('--age', undefined),
    }
  );

  if (flag('--json')) {
    console.log(JSON.stringify(res, null, 2));
  } else {
    const { coverage: c, sellers, floor, params } = res;
    console.log(`\n${c.covered.length} sets with fresh lots` +
      (c.stale.length ? `, ${c.stale.length} stale (${c.stale.join(' ')})` : '') +
      (c.no_lots.length ? `, ${c.no_lots.length} with none (${c.no_lots.join(' ')})` : ''));
    console.log(`cheapest ${params.tier}% of listings per set, ` +
      `${params.min_sets}+ sets per seller` + (params.sealed_only ? ', sealed only' : ''));

    if (!sellers.length) {
      console.log('\nno seller has ' + params.min_sets + ' of these sets in that tier — ' +
        'try --tier 50 or --min 2\n');
    } else {
      console.log('');
      for (const s of sellers.slice(0, 20)) {
        const mb = s.meets_min_buy ? '' : `  [under min buy $${s.min_buy_usd}]`;
        console.log(
          `${String(s.set_count).padStart(2)} sets  ${s.store.slice(0, 24).padEnd(24)} ` +
          `${s.country}  $${s.subtotal_usd.toFixed(2).padStart(9)}  ` +
          `+${s.over_floor_pct.toFixed(1)}% over floor  fb ${s.feedback}${mb}`
        );
        for (const sku of s.sets) {
          const l = s.lots[sku];
          console.log(
            `          ${sku}  $${l.usd.toFixed(2).padStart(8)}  ` +
            `#${l.rank}/${l.of}  +$${l.over_floor_usd.toFixed(2)}  ` +
            `${l.sealed ? 'sealed' : 'complete'}${l.qty > 1 ? ` x${l.qty}` : ''}`
          );
        }
        console.log(`          ${s.url}`);
      }
    }

    console.log('\nper-set price spread across retained lots');
    console.log('  (the adapter keeps only the cheapest ~40 per set, so "high" is ' +
      'the top of that slice, not of the market)');
    for (const [sku, f] of Object.entries(floor)) {
      console.log(`  ${sku}  low $${f.usd.toFixed(2).padStart(8)}  ` +
        `med $${f.median_usd.toFixed(2).padStart(8)}  high $${f.max_usd.toFixed(2).padStart(8)}  ` +
        `${f.lots} sellers`);
    }
    console.log('');
  }
}
