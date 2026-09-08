// carry-forward.mjs
//
// Guards against a degraded scrape run silently deleting shop rows from prices.json.
// A blocked/throttled request is not the same fact as "this retailer no longer
// stocks this set", but once the row is missing from the output they look identical
// to the page — the shop just vanishes from the card and `cheapest` moves to a
// worse price.
//
// Rows are reconstructed in the exact shape update-prices.mjs's merge loop expects
// (price_isk / rrp_isk / on_sale / in_stock / url / bundled_isk / pieces).

/**
 * Rebuild adapter-shaped rows for one shop out of the previous run's `sets` map.
 * @param {object} prevSets  the `.sets` object from the last committed prices.json
 * @param {string} label     display label, e.g. 'Boozt'
 * @param {string} [since]   the previous run's `updated` timestamp
 */
export function prevRowsFor(prevSets, label, since = null) {
  const rows = [];
  for (const [sku, entry] of Object.entries(prevSets || {})) {
    const shop = entry?.shops?.[label];
    if (!shop) continue;
    rows.push({
      sku,
      price_isk: shop.p ?? null,
      rrp_isk: shop.was ?? null,
      on_sale: !!shop.sale,
      in_stock: !!shop.stock,
      url: shop.url ?? null,
      ...(shop.bundled != null ? { bundled_isk: shop.bundled } : {}),
      ...(entry.pieces != null ? { pieces: entry.pieces } : {}),
      stale: true,
      stale_since: since,
    });
  }
  return rows;
}

/**
 * Decide whether to trust this run's rows for a shop, or fall back to the last
 * known good ones.
 *
 *   - adapter threw outright        -> carry everything forward
 *   - row count collapsed (< floor) -> carry everything forward
 *   - some requests errored         -> keep fresh rows, patch only the holes
 *   - otherwise                     -> use fresh rows untouched
 *
 * @returns {{rows: Array, carried: number}}  carried = how many rows came from history
 */
export function guardRows({ label, rows, prevSets, since = null, floor = 0.75, failed = false }) {
  const stats = rows?.stats;
  const prev = prevRowsFor(prevSets, label, since);

  // Nothing to compare against — first run, or a newly added retailer.
  if (!prev.length) return { rows: rows || [], carried: 0 };

  if (failed) {
    console.error(`  ${label}: adapter failed — carrying forward ${prev.length} row(s) from last run`);
    return { rows: prev, carried: prev.length };
  }

  const fresh = rows || [];

  if (fresh.length < prev.length * floor) {
    console.error(
      `  ${label}: ${fresh.length} rows vs ${prev.length} last run ` +
        `(< ${Math.round(floor * 100)}%) — carrying forward previous values`
    );
    return { rows: prev, carried: prev.length };
  }

  // Volume held up. If the adapter reported request-level errors, fill only those gaps.
  if (stats?.error > 0) {
    const seen = new Set(fresh.map((r) => String(r.sku)));
    const patch = prev.filter((r) => !seen.has(String(r.sku)));
    if (patch.length) {
      console.error(
        `  ${label}: ${stats.error} request error(s) — carrying forward ${patch.length} row(s)`
      );
      return { rows: [...fresh, ...patch], carried: patch.length };
    }
  }

  return { rows: fresh, carried: 0 };
}

export default { prevRowsFor, guardRows };
