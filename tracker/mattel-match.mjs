// mattel-match.mjs
// Identify which Mattel Brick Shop set a retailer's product title refers to, for shops
// that don't publish Mattel's toy number (JGR31 etc.). Used by Boozt and Kids-world;
// Coolshop, Brickshop and Brickmo expose the toy number and don't need this.
//
// Signals, strongest first:
//   1. Piece count, when the title carries one ("… (918 Pieces)"). Every catalog car
//      has a distinct count, so a count plus one car-name word is decisive.
//   2. Series — Premium / Elite / Speed. Kids-world machine-translates these
//      ("Úrvalssería", "Elite serían", "Speed sería"), so the Icelandic forms are mapped.
//   3. Car-name words, prefix-tolerant at the end of the title because Kids-world cuts
//      names off ("Corvette Gra…", "'90 Acura NS…").
//
// Variant guard: a catalog name's parenthetical/qualifier words — "(yellow)",
// "Deluxe Version" — must appear in the title, so the plain listing never matches the
// variant. When two sets still tie, nothing is returned: a missing price is better
// than a price on the wrong car.

export const MATTEL_RE = /^[A-Z]{3}\d{2}$/;
export const isMattel = (n) => MATTEL_RE.test(String(n));

const STOP = new Set(['the', 'and', 'for', 'with', 'version', 'building', 'toy', 'kit', 'set',
  'sett', 'hot', 'wheels', 'mattel', 'brick', 'shop', 'series', 'collectors', 'pieces', 'pcs']);
const QUALIFIER_WORDS = new Set(['deluxe']);   // words that make a set a variant of another

// Lowercase, strip accents (Icelandic letters included), drop apostrophes, split on the rest.
export function tokens(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/ð/g, 'd').replace(/þ/g, 'th').replace(/æ/g, 'ae').replace(/ø/g, 'o')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/(\w)\.(\w)/g, '$1$2')            // c8.r -> c8r
    .replace(/['’‘`´]/g, '')
    .split(/[^a-z0-9]+/).filter(Boolean);
}

// Kids-world's Icelandic translations -> the English words the catalog uses.
function canonicalise(toks) {
  const out = [...toks];
  for (const t of toks) {
    if (t.startsWith('sersmi')) out.push('custom');                    // Sérsmíður = Custom
    if (/^u?rvals/.test(t)) out.push('premium');                       // Úrvalssería = Premium
    if (t === 'serian' || t === 'seria') out.push('series');
    const colour = { gul: 'yellow', gulur: 'yellow', raud: 'red', raudur: 'red', blar: 'blue',
      graenn: 'green', svartur: 'black', svart: 'black', hvitur: 'white', hvit: 'white' }[t];
    if (colour) out.push(colour);
  }
  return out;
}

function seriesOf(toks) {
  if (toks.includes('premium')) return 'Premium';
  if (toks.includes('elite')) return 'Elite';
  if (toks.includes('speed')) return 'Speed';
  return null;
}

// "1,600 Pieces" / "(918 Pieces)" / "257 pcs" / "264 stk" -> number
export function piecesIn(title) {
  const m = String(title || '').match(/\(?\s*([\d][\d.,\s]{1,6})\s*(?:pieces|pcs|stk|stykki|dele|bitar|osaa|teile|partar)\b/i);
  if (!m) return null;
  const n = Number(m[1].replace(/[^\d]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function prepEntry(e) {
  const name = String(e.name || '');
  const qualText = (name.match(/\(([^)]*)\)/g) || []).join(' ');
  const qualifiers = [...tokens(qualText), ...tokens(name).filter((t) => QUALIFIER_WORDS.has(t))];
  const words = tokens(name.replace(/\([^)]*\)/g, ' ')).filter((t) => !STOP.has(t) && !QUALIFIER_WORDS.has(t));
  return { n: String(e.n), series: e.series || null, pieces: e.pieces ?? null, words, qualifiers: [...new Set(qualifiers)] };
}

/**
 * @param {string} title   product title (and/or URL slug — pass both joined with a space)
 * @param {Array<{n,name,series?,pieces?}>} catalog  Mattel catalog entries
 * @returns {{n:string, via:string}|null}
 */
export function matchMattel(title, catalog) {
  const raw = tokens(title);
  if (!raw.length) return null;
  const tt = canonicalise(raw);
  const last = raw[raw.length - 1];
  const tSeries = seriesOf(tt);
  const tPieces = piecesIn(title);
  const has = (w) => tt.includes(w) ||
    tt.some((t) => t.length >= 4 && t.startsWith(w) && w.length >= 4) ||       // mercedesbenz ⊃ mercedes
    (last.length >= 2 && w.startsWith(last) && w !== last);                     // truncated tail: "gra" -> grand

  const scored = [];
  for (const e of catalog.map(prepEntry)) {
    if (tSeries && e.series && tSeries !== e.series) continue;
    if (e.qualifiers.length && !e.qualifiers.every((q) => tt.includes(q))) continue;
    const hits = e.words.filter(has);
    const strong = hits.filter((w) => !/^\d{2}$/.test(w));                      // a model year alone proves little
    if (!strong.length) continue;
    // A matched qualifier ("yellow", "deluxe") counts extra, so a variant listing goes to
    // the variant rather than tying with the plain set.
    scored.push({ e, score: hits.length + e.qualifiers.length, strong: strong.length });
  }
  if (!scored.length) return null;

  // Piece count is decisive when the title has one and exactly one candidate shares it.
  if (tPieces) {
    const byPieces = scored.filter((s) => s.e.pieces === tPieces);
    if (byPieces.length === 1) return { n: byPieces[0].e.n, via: 'pieces' };
  }
  scored.sort((a, b) => b.score - a.score || b.strong - a.strong);
  if (scored.length > 1 && scored[0].score === scored[1].score && scored[0].strong === scored[1].strong) return null;
  return { n: scored[0].e.n, via: tSeries ? 'series+name' : 'name' };
}

export default matchMattel;
