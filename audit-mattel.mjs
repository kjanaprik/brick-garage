// audit-mattel.mjs
// Diffs the Brick Garage CATALOG against two Mattel Brick Shop sources and reports (or,
// with AUDIT_APPLY=1, adds) any vehicle set that isn't tracked yet. Node 18+, no deps.
// Companion to audit-cars.mjs; runs in the same weekly workflow.
//
// Sources (either may fail; the other still works):
//   1. Hot Wheels Wiki "Mattel Brick Shop" page (MediaWiki API, wikitext). Best data:
//      toy number, year, name, scale, piece count and tier (Premium/Elite/Speed).
//   2. Mattel's own Shopify store — the Hot Wheels Brick Shop collection's products.json.
//      Official toy numbers (variant sku), piece count in the title, product images.
//      Catches sets Mattel lists before the wiki does.
//
// Every set in that line is a vehicle, so there's no car filter. Suppression works like
// the LEGO audit: put a toy number in ignore-skus.json and it is never added.

import { readFile, writeFile } from 'node:fs/promises';

const CATALOG_PATH = process.env.AUDIT_CATALOG || './index.html';
const IGNORE_PATH  = process.env.AUDIT_IGNORE || './ignore-skus.json';
const REPORT_PATH  = process.env.AUDIT_MATTEL_REPORT || './audit-mattel-report.md';
const THEME = 'Mattel Brick Shop';

const WIKI_URL = 'https://hotwheels.fandom.com/api.php?action=parse&page=Mattel_Brick_Shop&prop=wikitext&format=json';
const SHOP_URL = 'https://shop.mattel.com/collections/mattel-brick-shop-hot-wheels/products.json?limit=250';

const TOY_RE = /\b([A-Z]{3}\d{2})\b/g;
const TIER_SCALE = { Premium: '1:12', Elite: '1:16', Speed: '1:32' };
// Non-car products that could appear on either source; never added.
const NOT_VEHICLE = /\b(xbox|console|controller|he-man|skeletor|castle grayskull|masters of the universe|motu)\b/i;

// ---- helpers ---------------------------------------------------------------
async function getJson(url) {
  const ctl = new AbortController();
  const to = setTimeout(() => ctl.abort(), 20000);
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (brick-garage-audit/1.0)', Accept: 'application/json' },
      signal: ctl.signal,
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally { clearTimeout(to); }
}

async function readCatalog() {
  const html = await readFile(CATALOG_PATH, 'utf8');
  const m = html.match(/const CATALOG = (\[[\s\S]*?\]);/);
  if (!m) throw new Error(`CATALOG array not found in ${CATALOG_PATH}`);
  return JSON.parse(m[1]);
}

async function readIgnore() {
  try { return new Set(JSON.parse(await readFile(IGNORE_PATH, 'utf8')).map((s) => String(s).trim().toUpperCase())); }
  catch { return new Set(); }
}

// [[Target|Label]] -> Label, [[Target]] -> Target, strip files/markup.
function wikiText(s) {
  return String(s || '')
    .replace(/\[\[File:[^\]]*\]\]/gi, '')
    .replace(/\[\[[^\]|]*\|([^\]]*)\]\]/g, '$1')
    .replace(/\[\[([^\]]*)\]\]/g, '$1')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/'''?/g, '')
    .replace(/\s*\(Mattel Brick Shop[^)]*\)/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---- source 1: Hot Wheels Wiki --------------------------------------------
// Rows of the tables under "==Sets==" (yearly ===subsections===), up to the next
// level-2 heading (==Multipacks== is deliberately skipped).
// Columns: Toy # | Year | Name | Scale | Piece count | Casting | Tier | Designers | Notes | photos…
function parseWiki(wikitext) {
  const start = wikitext.indexOf('==Sets==');
  if (start < 0) return [];
  const rest = wikitext.slice(start + 8);
  const end = rest.search(/\n==[^=]/);
  const section = end >= 0 ? rest.slice(0, end) : rest;
  const out = [];
  for (const row of section.split(/\n\|-/).slice(1)) {
    const cells = [];
    for (const line of row.split('\n')) {
      if (/^\|[}+]/.test(line) || /^!/.test(line)) continue;
      if (line.startsWith('|')) cells.push(line.slice(1));
      else if (cells.length) cells[cells.length - 1] += '\n' + line;
    }
    if (cells.length < 7) continue;
    const codes = [...cells[0].matchAll(TOY_RE)].map((m) => m[1]);
    if (!codes.length) continue;
    const year = Number((cells[1].match(/(20\d{2})/) || [])[1]) || null;
    const name = wikiText(cells[2]);
    const scale = (cells[3].match(/1:\d+/) || [])[0] || null;
    const pieces = Number(String(cells[4]).replace(/[^\d]/g, '')) || null;
    const tier = (wikiText(cells[6]).match(/Premium|Elite|Speed/i) || [])[0] || null;
    const notes = wikiText(cells[8] || '');
    if (!name) continue;
    out.push({ codes, year, name, scale, pieces, series: tier ? tier[0].toUpperCase() + tier.slice(1).toLowerCase() : null, notes, src: 'wiki' });
  }
  return out;
}

// ---- source 2: Mattel Shopify ---------------------------------------------
// Several regional duplicates per set (en-US, en-CA, es-MX, pt-BR, fr-CA); the en-US
// one is preferred for the name and image, any of them can supply the tier word.
function parseShop(data) {
  const by = new Map();
  for (const p of data?.products || []) {
    const sku = String(p?.variants?.[0]?.sku || '').trim().toUpperCase();
    if (!/^[A-Z]{3}\d{2}$/.test(sku)) continue;
    const title = String(p.title || '');
    const regional = /-(es-mx|pt-br|fr-ca|en-ca)$/.test(p.handle || '');
    const rec = by.get(sku) || { codes: [sku], src: 'shop' };
    const pieces = Number((title.match(/\(([\d,.]+)\s*(?:pieces|pi[eè]ces|piezas|pe[cç]as)/i) || [])[1]?.replace(/[^\d]/g, '')) || null;
    const tier = (title.match(/\b(Premium|Elite|Speed)\b/i) || [])[1];
    if (tier && !rec.series) rec.series = tier[0].toUpperCase() + tier.slice(1).toLowerCase();
    if (pieces && !rec.pieces) rec.pieces = pieces;
    if (!rec.year && p.published_at) rec.year = Number(String(p.published_at).slice(0, 4)) || null;
    const img = p.images?.[0]?.src || null;
    if (!regional || !rec.name) {
      rec.name = title
        .replace(/^Mattel Brick Shop\s+(Hot Wheels\s+)?/i, '')
        .replace(/\s*(Building Toy( Kit)?|Building Set)\b.*$/i, '')
        .replace(/\s*\(.*$/, '')
        .replace(/[’‘]/g, "'")
        .trim();
      if (img) rec.img = img + (img.includes('?') ? '&' : '?') + 'width=480';
    } else if (!rec.img && img) {
      rec.img = img + (img.includes('?') ? '&' : '?') + 'width=480';
    }
    by.set(sku, rec);
  }
  return [...by.values()];
}

// ---- main ------------------------------------------------------------------
async function main() {
  const [catalog, ignore] = await Promise.all([readCatalog(), readIgnore()]);
  const have = new Set(catalog.map((e) => String(e.n).trim().toUpperCase()));
  const known = (code) => have.has(code) || ignore.has(code);

  let wiki = [], shop = [];
  const failures = [];
  try { wiki = parseWiki((await getJson(WIKI_URL))?.parse?.wikitext?.['*'] || ''); }
  catch (e) { failures.push(`Hot Wheels Wiki: ${e.message}`); }
  try { shop = parseShop(await getJson(SHOP_URL)); }
  catch (e) { failures.push(`Mattel shop: ${e.message}`); }
  for (const f of failures) console.error(`[audit-mattel] source failed — ${f}`);
  const shopBy = new Map(shop.map((s) => [s.codes[0], s]));

  const findings = [];
  const taken = new Set();
  const names = new Set(catalog.map((e) => String(e.name || '').toLowerCase()));
  // Wiki first (richer data), enriched with the shop's image; then shop-only sets.
  for (const w of wiki) {
    if (w.codes.some(known)) continue;          // any alias already tracked/ignored -> skip row
    const code = w.codes.find((c) => shopBy.has(c)) || w.codes[0];
    if (taken.has(code) || NOT_VEHICLE.test(w.name)) continue;
    const s = shopBy.get(code) || {};
    // Variants share a wiki name (the Deluxe R8 is "'15 Audi R8 LMS" too). Disambiguate
    // from the notes column so the grid doesn't show two identical cards.
    let name = w.name;
    if (/deluxe/i.test(w.notes) && !/deluxe/i.test(name)) name += ' Deluxe Version';
    else if (names.has(name.toLowerCase())) {
      const colour = (w.notes.match(/\b(yellow|red|blue|green|black|white|orange|purple|silver|gold)\b/i) || [])[1];
      name += colour ? ` (${colour.toLowerCase()})` : ` (${code})`;
    }
    names.add(name.toLowerCase());
    findings.push({
      n: code, name, series: w.series || s.series || null,
      scale: w.scale || TIER_SCALE[w.series || s.series] || null,
      year: w.year || s.year || null, pieces: w.pieces || s.pieces || null,
      img: s.img || null, via: s.img ? 'wiki + Mattel' : 'wiki',
    });
    w.codes.forEach((c) => taken.add(c));
  }
  for (const s of shop) {
    const code = s.codes[0];
    if (known(code) || taken.has(code) || NOT_VEHICLE.test(s.name || '')) continue;
    findings.push({
      n: code, name: s.name || code, series: s.series || null,
      scale: TIER_SCALE[s.series] || null, year: s.year || null, pieces: s.pieces || null,
      img: s.img || null, via: 'Mattel',
    });
    taken.add(code);
  }
  findings.sort((a, b) => (b.year || 0) - (a.year || 0) || a.n.localeCompare(b.n));

  const applied = process.env.AUDIT_APPLY === '1' && findings.length > 0;
  if (applied) await applyToCatalog(findings);

  // ---- report ----
  const today = new Date().toISOString().slice(0, 10);
  const srcLine = `_Sources: Hot Wheels Wiki (${wiki.length} rows), Mattel shop (${shop.length} sets)` +
    (failures.length ? ` — failed: ${failures.join('; ')}` : '') + '._\n';
  let md = `# 🏎️ Mattel Brick Shop audit — ${today}\n\n`;
  if (!findings.length) {
    md += `No new Mattel Brick Shop sets. All ${have.size} catalog entries checked. ✅\n\n` + srcLine;
  } else {
    md += `${applied ? 'Added' : 'Found'} **${findings.length}** Mattel Brick Shop set(s)${applied ? ' to your catalog' : ' not in your catalog'}:\n\n`;
    md += `| Toy # | Name | Series | Scale | Pieces | Year | Source |\n| --- | --- | --- | --- | --- | --- | --- |\n`;
    for (const f of findings) md += `| ${f.n} | ${f.name} | ${f.series || '—'} | ${f.scale || '—'} | ${f.pieces || '—'} | ${f.year || '—'} | ${f.via} |\n`;
    md += `\n${srcLine}`;
    md += applied
      ? `\n_Committed automatically. To drop one, delete its entry from \`index.html\` and add the toy number to \`ignore-skus.json\`._\n`
      : `\n_Run with AUDIT_APPLY=1 to add them, or put unwanted toy numbers in \`ignore-skus.json\`._\n`;
  }
  await writeFile(REPORT_PATH, md);
  console.log(md);
  console.log(`[audit-mattel] ${applied ? 'added' : 'found'} ${findings.length}; catalog had ${have.size}`);

  if (process.env.GITHUB_OUTPUT) {
    await writeFile(process.env.GITHUB_OUTPUT, `mattel_new_count=${findings.length}\n`, { flag: 'a' });
  }
  // Both sources down is worth a red run; one down is not.
  if (failures.length === 2) process.exitCode = 1;
}

// Append to index.html's CATALOG with a minimal edit, same as audit-cars.mjs.
async function applyToCatalog(findings) {
  const html = await readFile(CATALOG_PATH, 'utf8');
  const m = html.match(/const CATALOG = \[[\s\S]*?\];/);
  if (!m) throw new Error(`CATALOG array not found in ${CATALOG_PATH} for apply`);
  const block = m[0];
  const closeIdx = block.lastIndexOf(']');
  const entries = findings.map((f) => {
    const e = { n: f.n, name: f.name, theme: THEME };
    if (f.series) e.series = f.series;
    if (f.scale) e.scale = f.scale;
    e.year = f.year || new Date().getFullYear();
    if (f.pieces) e.pieces = f.pieces;
    e.prod = 'available';
    if (f.img) e.img = f.img;
    return JSON.stringify(e);
  });
  const before = block.slice(0, closeIdx).trimEnd();
  const insert = (before.endsWith('[') ? '' : ',') + entries.join(',');
  const newBlock = block.slice(0, closeIdx) + insert + block.slice(closeIdx);
  await writeFile(CATALOG_PATH, html.replace(block, () => newBlock));
}

main().catch((e) => { console.error(e); process.exit(1); });
