// fx.mjs
// EUR -> ISK rates for the EU shops (Brickshop, Brickmo). Fetched once per run and
// shared, so every EU price in a run is converted at the same rate.
//
//   card  Íslandsbanki's card selling rate ("Greiðslukort — Sala"): what a Mastercard
//         purchase in EUR is actually charged at on an Íslandsbanki card — Mastercard's
//         conversion plus the bank's margin. Used for every Brickshop/Brickmo ISK price.
//         Public, unauthenticated JSON behind islandsbanki.is's currency page:
//           /publicapi/bank/currencies/v2/card?currencies=EUR -> card.today.selected
//           .currencies[0].sellRate   (updated daily)
//   mid   mid-market rate (open.er-api.com, Frankfurter as backup). Used for the BrickLink
//         EUR figures, and as the base of the estimate if Íslandsbanki can't be reached.
//
// If Íslandsbanki doesn't answer, card = mid * (1 + CARD_FALLBACK_SPREAD), flagged as
// src: 'estimate' so the page can say so. The default spread (3.2%) is the gap between
// Íslandsbanki's card selling rate and mid-market observed on 10.10.2026
// (141.15 vs 136.80).
//
// Env:
//   CARD_FALLBACK_SPREAD  fraction over mid used when the bank can't be reached (default 0.032)
//   EUR_ISK_CARD          pin the card rate (testing)
//   EUR_ISK_MID           pin the mid rate (testing)

const ISB_URL = 'https://www.islandsbanki.is/publicapi/bank/currencies/v2/card' +
  '?currencies=EUR&simple=false&continent=selected&date=today&lang=is';
const FALLBACK_SPREAD = Number(process.env.CARD_FALLBACK_SPREAD ?? 0.032);
const MID_FALLBACK = 145;

async function getJson(url, ms = 10000) {
  const ctl = new AbortController();
  const to = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (brick-garage price tracker)', Accept: 'application/json' },
      signal: ctl.signal,
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally { clearTimeout(to); }
}

async function fetchMid() {
  if (process.env.EUR_ISK_MID) return Number(process.env.EUR_ISK_MID);
  const sources = [
    ['https://open.er-api.com/v6/latest/EUR', (d) => d?.rates?.ISK],
    ['https://api.frankfurter.app/latest?from=EUR&to=ISK', (d) => d?.rates?.ISK],
  ];
  for (const [url, pick] of sources) {
    try {
      const v = Number(pick(await getJson(url)));
      if (Number.isFinite(v) && v > 0) return v;
    } catch { /* next */ }
  }
  return null;
}

// Sanity-checked against mid so a malformed response can't price everything at 1 kr.
async function fetchCard(mid) {
  if (process.env.EUR_ISK_CARD) return { rate: Number(process.env.EUR_ISK_CARD), date: null, src: 'pinned' };
  try {
    const d = await getJson(ISB_URL);
    const sel = d?.card?.today?.selected;
    const eur = (sel?.currencies || []).find((c) => c.currencyCode === 'EUR');
    const rate = Number(eur?.sellRate);
    if (!Number.isFinite(rate) || rate <= 0) throw new Error('no EUR sellRate in response');
    if (mid && Math.abs(rate / mid - 1) > 0.10) throw new Error(`implausible rate ${rate} vs mid ${mid}`);
    return { rate, date: (eur.rateDate || sel.date || '').slice(0, 10) || null, src: 'islandsbanki' };
  } catch (e) {
    console.error(`[fx] Íslandsbanki card rate failed: ${e.message}`);
    return null;
  }
}

let _rates = null;
/**
 * @returns {Promise<{mid:number, card:number, src:'islandsbanki'|'estimate'|'pinned', date:string|null}>}
 * Never throws; always returns usable numbers.
 */
export function getRates() {
  _rates ??= (async () => {
    const mid = (await fetchMid()) ?? MID_FALLBACK;
    const card = await fetchCard(mid);
    const out = card
      ? { mid, card: card.rate, src: card.src, date: card.date }
      : { mid, card: Math.round(mid * (1 + FALLBACK_SPREAD) * 10000) / 10000, src: 'estimate', date: null };
    console.error(`[fx] EUR->ISK mid ${out.mid}, card ${out.card} (${out.src}${out.date ? `, ${out.date}` : ''})`);
    return out;
  })();
  return _rates;
}

export default getRates;
