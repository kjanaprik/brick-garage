// audit-cars.mjs
// Diffs your Brick Garage CATALOG against reliable LEGO set lists and reports any
// CAR set you don't already have. Runs anywhere with Node 18+ (global fetch), no deps.
// Designed to run unattended on GitHub Actions: writes audit-report.md, prints a
// summary, and exposes `new_count` via $GITHUB_OUTPUT for the workflow to open an issue.
//
// Sources: brickinstructions.com per-theme lists (clean, numbered, script-friendly —
// BrickLink/Brickset block scripted fetches). Speed Champions = entirely cars; Technic
// is filtered to branded cars/supercars/licensed 4x4s (machinery excluded).
//
// Suppression: sets whose numbers are in ignore-skus.json or DEFAULT_EXCLUDE (your F1
// pattern) are never flagged. When the audit flags something you don't want, add its
// number to ignore-skus.json and it won't come back.

import { readFile, writeFile } from 'node:fs/promises';

const CATALOG_PATH = process.env.AUDIT_CATALOG || './index.html';
const IGNORE_PATH  = process.env.AUDIT_IGNORE || './ignore-skus.json';

const SOURCES = [
  { theme: 'Speed Champions', url: 'https://lego.brickinstructions.com/lego_instructions/theme/speed_champions', allCars: true },
  { theme: 'Technic',         url: 'https://lego.brickinstructions.com/lego_instructions/theme/technic',         allCars: false },
];

// Only consider sets from this year onward (matches the scope of your collection).
const MIN_YEAR = Number(process.env.AUDIT_MIN_YEAR || 2015);

// Car brands/models to INCLUDE for non-"allCars" themes (Technic).
const CAR_WORDS = /\b(ferrari|lamborghini|lambo|bugatti|porsche|mclaren|koenigsegg|mercedes|benz|amg|bmw|audi|ford|mustang|gt40|bronco|chevrolet|corvette|camaro|dodge|charger|viper|challenger|jeep|wrangler|land rover|defender|aston martin|nissan|skyline|gt-r|toyota|supra|mitsubishi|eclipse|pagani|lotus|peugeot|nascar|batmobile|honda|hoonicorn|revuelto|huracan|huracán|sián|sian|daytona|bolide|jesko|valkyrie|fxx|pista|rally car|hypercar|supercar|super sports car|sports car|race car|24 hours)\b/i;

// Hard-exclude machinery / non-car vehicles even if a brand word sneaks in.
const NOT_CAR = /\b(excavator|crane|loader|bulldozer|dozer|harvester|forklift|telehandler|tractor|skidder|hauler|dump truck|garbage truck|tow truck|mixer|backhoe|forest|snow groomer|monster jam|monster truck|buggy|off-?road(er)?|quad|boat|yacht|catamaran|hovercraft|submarine|plane|jet|helicopter|osprey|rocket|rover|lunar|mars|space|spaceship|orbit|motorcycle|motorbike|ducati|kawasaki|yamaha|bike|batcycle|stunt|transformation vehicle|all-terrain vehicle|zetros|unimog|car transporter|volvo|liebherr|cat d11|claas|john deere|mack|arocs|technic guys|chassis|pull-back|1000 rr|1200 gs|panigale|ninja|mt-10|steering wheel|pit stop|pit lane|finish line|development centre|ultimate garage)\b/i;

// Formula 1 sets (you exclude these). Conservative so road cars like
// "McLaren F1 LM" (has "F1" but not "race car"/"team") are NOT caught.
const IS_F1 = /formula\s*(1|one)|\bf1\b.*(race car|team)|\bapxgp\b/i;

// Polybags (30xxx) and promos/GWP/steering wheels (40xxx) — not tracked.
const NON_MAIN_SKU = /^(30|40)\d{3}$/;

// Seeded suppressions from your known F1-exclusion pattern (extend via ignore-skus.json).
const DEFAULT_EXCLUDE = new Set([
  '42141','42165','42171','42206','42207','42228',   // Technic F1
  '10353','11375',                                   // Icons F1 tributes
  '77251','77252','77258',                           // Speed Champions F1 (movie)
]);

// ---- helpers ---------------------------------------------------------------
async function getText(url) {
  const ctl = new AbortController();
  const to = setTimeout(() => ctl.abort(), 20000);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'brick-garage-audit/1.0' }, signal: ctl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.text();
  } finally { clearTimeout(to); }
}

async function readCatalog() {
  const html = await readFile(CATALOG_PATH, 'utf8');
  const m = html.match(/const CATALOG = (\[[\s\S]*?\]);/);
  if (!m) throw new Error(`CATALOG array not found in ${CATALOG_PATH}`);
  const arr = JSON.parse(m[1]);
  return new Set(arr.map((e) => String(e.n).trim()));
}

async function readIgnore() {
  try {
    const arr = JSON.parse(await readFile(IGNORE_PATH, 'utf8'));
    return new Set(arr.map((s) => String(s).trim()));
  } catch { return new Set(); }
}

// Parse a brickinstructions theme page into [{ n, name, year }].
function parseTheme(html) {
  const out = [];
  const re = /\/lego_instructions\/set\/(\d{3,6})\/([^'"]+)['"][\s\S]{0,300}?Set:\s*\d{3,6}-1[\s\S]{0,20}?Released in (\d{4})/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const n = m[1];
    const name = decodeURIComponent(m[2]).replace(/_/g, ' ').replace(/`/g, "'").trim();
    const year = Number(m[3]);
    out.push({ n, name, year });
  }
  // de-dup by set number (keep first)
  const seen = new Set();
  return out.filter((s) => (seen.has(s.n) ? false : seen.add(s.n)));
}

function isCar(name, allCars) {
  if (IS_F1.test(name)) return false;       // you skip Formula 1
  if (NOT_CAR.test(name)) return false;
  if (allCars) return true;
  return CAR_WORDS.test(name);
}

// ---- main ------------------------------------------------------------------
async function main() {
  const [have, ignore] = await Promise.all([readCatalog(), readIgnore()]);
  const suppress = new Set([...ignore, ...DEFAULT_EXCLUDE]);

  const findings = [];
  for (const src of SOURCES) {
    let html;
    try { html = await getText(src.url); }
    catch (e) { console.error(`[audit] source failed ${src.theme}: ${e.message}`); continue; }
    for (const s of parseTheme(html)) {
      if (s.year < MIN_YEAR) continue;
      if (NON_MAIN_SKU.test(s.n)) continue;             // polybags / promos
      if (have.has(s.n) || suppress.has(s.n)) continue;
      if (!isCar(s.name, src.allCars)) continue;
      findings.push({ ...s, theme: src.theme });
    }
  }
  findings.sort((a, b) => b.year - a.year || a.n.localeCompare(b.n));

  // ---- report ----
  const today = new Date().toISOString().slice(0, 10);
  let md;
  if (findings.length === 0) {
    md = `# 🚗 Brick Garage car audit — ${today}\n\nNo new car sets missing. Your collection is complete against Technic + Speed Champions car lists. ✅\n`;
  } else {
    md = `# 🚗 Brick Garage car audit — ${today}\n\nFound **${findings.length}** car set(s) not in your catalog:\n\n`;
    md += `| Set | Name | Theme | Year |\n| --- | --- | --- | --- |\n`;
    for (const f of findings) md += `| ${f.n} | ${f.name} | ${f.theme} | ${f.year} |\n`;
    md += `\n_To stop flagging any of these (e.g. F1 sets you skip), add their numbers to \`ignore-skus.json\`._\n`;
    md += `\nCATALOG entries to paste if you want to add one:\n\n\`\`\`js\n`;
    for (const f of findings) {
      md += `{"n":"${f.n}","name":"${f.name}","theme":"${f.theme}","year":${f.year},"prod":"available"},\n`;
    }
    md += `\`\`\`\n`;
  }

  await writeFile('audit-report.md', md);
  console.log(md);
  console.log(`[audit] ${findings.length} new car set(s); catalog has ${have.size}, suppressed ${suppress.size}`);

  // expose count to the GitHub Actions workflow
  if (process.env.GITHUB_OUTPUT) {
    await writeFile(process.env.GITHUB_OUTPUT, `new_count=${findings.length}\n`, { flag: 'a' });
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
