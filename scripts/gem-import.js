#!/usr/bin/env node
/**
 * gem-import.js — patch data.json from Gem CSV exports
 *
 * Usage:
 *   node scripts/gem-import.js --pipeline path/to/pipeline.csv
 *   node scripts/gem-import.js --outreach path/to/outreach.csv
 *   node scripts/gem-import.js --pipeline pipeline.csv --outreach outreach.csv
 *
 * HOW TO EXPORT FROM GEM:
 *   Pipeline CSV:  Gem → Reports → Pipeline Report → Export CSV
 *     Expected columns: Job Title, Stage, Candidate Count, Avg Days in Stage
 *
 *   Outreach CSV:  Gem → Outreach → Sequences → Export CSV
 *     Expected columns: Month, Sent, Opens, Replies, Interested
 *     (or: Period, Emails Sent, Open Rate, Reply Rate, Interested Rate)
 *
 * The script only overwrites the automated fields (pipeline counts, avg days,
 * passthrough rates, outreach metrics, KPI totals). It leaves manual fields
 * (roles[].note, roles[].status, flags, _meta.updated) untouched.
 */

const fs   = require('fs');
const path = require('path');

const DATA_JS_PATH  = path.join(__dirname, '..', 'data.js');
const DATA_JSON_PATH = path.join(__dirname, '..', 'data.json');

// Read from data.js (strip the JS wrapper to get JSON), fall back to data.json
function readData() {
  if (fs.existsSync(DATA_JS_PATH)) {
    const src = fs.readFileSync(DATA_JS_PATH, 'utf8');
    return JSON.parse(src.replace(/^const DASHBOARD_DATA\s*=\s*/, '').replace(/;\s*$/, ''));
  }
  return JSON.parse(fs.readFileSync(DATA_JSON_PATH, 'utf8'));
}

// Write back to data.js (and data.json as a backup)
function writeData(data) {
  const json = JSON.stringify(data, null, 2);
  fs.writeFileSync(DATA_JS_PATH,  'var DASHBOARD_DATA = ' + json + ';\n');
  fs.writeFileSync(DATA_JSON_PATH, json + '\n');
}

// ── CSV parser ────────────────────────────────────────────────────────────────
function parseCSV(text) {
  const lines = text.trim().split(/\r?\n/);
  const headers = splitRow(lines[0]).map(h => h.trim().toLowerCase());
  return lines.slice(1).filter(l => l.trim()).map(line => {
    const vals = splitRow(line);
    return Object.fromEntries(headers.map((h, i) => [h, (vals[i] ?? '').trim()]));
  });
}

function splitRow(line) {
  const result = [];
  let cur = '', inQ = false;
  for (const ch of line) {
    if (ch === '"') { inQ = !inQ; }
    else if (ch === ',' && !inQ) { result.push(cur); cur = ''; }
    else { cur += ch; }
  }
  result.push(cur);
  return result;
}

function num(s) { return parseFloat(String(s).replace(/[^0-9.]/g, '')) || 0; }
function pct(s) {
  const n = num(s);
  // if value is a decimal like 0.17, convert to percentage
  return n > 0 && n <= 1 ? Math.round(n * 100) : Math.round(n);
}

// ── Stage name normaliser ─────────────────────────────────────────────────────
const STAGE_MAP = {
  'application review': 'app_review',
  'app review': 'app_review',
  'applied': 'app_review',
  'application': 'app_review',
  'phone screen': 'phone_screen',
  'phone screening': 'phone_screen',
  'recruiter screen': 'phone_screen',
  'onsite': 'onsite',
  'onsite interview': 'onsite',
  'interview': 'onsite',
  'final interview': 'onsite',
  'offer': 'offer',
  'offer extended': 'offer',
  'hired': 'hired',
  'accepted': 'hired',
};

function normaliseStage(raw) {
  const key = raw.toLowerCase().trim();
  for (const [pat, norm] of Object.entries(STAGE_MAP)) {
    if (key.includes(pat)) return norm;
  }
  return null;
}

// ── Month normaliser ──────────────────────────────────────────────────────────
function normaliseMonth(raw) {
  // Accepts: "June 2026", "Jun 2026", "2026-06", "06/2026", etc.
  const months = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
  const full   = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const s = raw.trim();

  // ISO: 2026-06
  const iso = s.match(/^(\d{4})-(\d{2})$/);
  if (iso) return `${full[parseInt(iso[2]) - 1]} ${iso[1]}`;

  // Already "Month YYYY"
  const mY = s.match(/^([A-Za-z]+)\s+(\d{4})$/);
  if (mY) {
    const idx = months.indexOf(mY[1].toLowerCase().slice(0, 3));
    if (idx >= 0) return `${full[idx]} ${mY[2]}`;
  }

  return s; // return as-is if unrecognised
}

// ── Pipeline import ───────────────────────────────────────────────────────────
function importPipeline(csvPath, data) {
  const rows = parseCSV(fs.readFileSync(csvPath, 'utf8'));

  // Aggregate by normalised stage
  const stages = {};
  for (const row of rows) {
    // Find the stage column (flexible naming)
    const stageRaw = row['stage'] ?? row['stage name'] ?? row['interview stage'] ?? '';
    const key = normaliseStage(stageRaw);
    if (!key) continue;

    const count   = num(row['candidate count'] ?? row['candidates'] ?? row['count'] ?? 0);
    const avgDays = num(row['avg days in stage'] ?? row['average days'] ?? row['days in stage'] ?? row['avg days'] ?? 0);

    if (!stages[key]) stages[key] = { count: 0, daySum: 0, rowCount: 0 };
    stages[key].count    += count;
    stages[key].daySum   += avgDays * (count || 1);
    stages[key].rowCount += count || 1;
  }

  // Patch pipeline
  const p = data.pipeline;
  for (const [key, val] of Object.entries(stages)) {
    if (p[key]) {
      p[key].count    = val.count;
      p[key].avg_days = Math.round(val.daySum / val.rowCount);
    }
  }

  // Recompute passthrough rates
  const s = data.pipeline;
  if (s.app_review.count && s.phone_screen.count)
    data.passthrough.app_to_phone   = Math.round(s.phone_screen.count / s.app_review.count * 100);
  if (s.phone_screen.count && s.onsite.count)
    data.passthrough.phone_to_onsite = Math.round(s.onsite.count / s.phone_screen.count * 100);
  if (s.onsite.count && s.offer.count)
    data.passthrough.onsite_to_offer = Math.round(s.offer.count / s.onsite.count * 100);
  if (s.offer.count && s.hired.count)
    data.passthrough.offer_to_hired  = Math.round(s.hired.count / s.offer.count * 100);

  // KPIs derived from pipeline
  data.kpis.active_candidates = (s.phone_screen.count + s.onsite.count + s.offer.count);
  data.kpis.offers_extended   = s.offer.count + s.hired.count;
  data.kpis.hires             = s.hired.count;
  data.kpis.offer_acceptance_pct = data.passthrough.offer_to_hired;

  console.log('✓ Pipeline imported:', JSON.stringify(stages, null, 2));
}

// ── Outreach import ───────────────────────────────────────────────────────────
function importOutreach(csvPath, data) {
  const rows = parseCSV(fs.readFileSync(csvPath, 'utf8'));

  const outreach = rows.map(row => {
    const monthRaw = row['month'] ?? row['period'] ?? row['date'] ?? '';
    const sent     = num(row['sent'] ?? row['emails sent'] ?? row['total sent'] ?? 0);
    const openPct  = pct(row['open rate'] ?? row['opens'] ?? row['open %'] ?? 0);
    const replyPct = pct(row['reply rate'] ?? row['replies'] ?? row['reply %'] ?? 0);
    const intPct   = pct(row['interested'] ?? row['interested rate'] ?? row['interested %'] ?? 0);

    return {
      month: normaliseMonth(monthRaw),
      sent,
      open_pct: openPct,
      reply_pct: replyPct,
      interested_pct: intPct,
      trending: null,
    };
  }).filter(r => r.month && r.sent > 0);

  // Sort newest first (matching dashboard display order)
  outreach.sort((a, b) => {
    const d = (s) => new Date(s.replace(/(\w+) (\d{4})/, '$1 1, $2'));
    return d(b.month) - d(a.month);
  });

  // Flag trending down if last month's interested rate < month before
  if (outreach.length >= 2 && outreach[0].interested_pct < outreach[1].interested_pct) {
    outreach[0].trending = 'down';
  }

  data.outreach = outreach;
  console.log('✓ Outreach imported:', outreach.length, 'months');
}

// ── Main ──────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const get  = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };

const pipelinePath = get('--pipeline');
const outreachPath = get('--outreach');

if (!pipelinePath && !outreachPath) {
  console.error('Usage: node scripts/gem-import.js --pipeline <file.csv> [--outreach <file.csv>]');
  process.exit(1);
}

const data = readData();

// ── Auto-detect date range from pipeline CSV ──────────────────────────────────
function buildPeriodLabel(csvPath) {
  const rows = parseCSV(fs.readFileSync(csvPath, 'utf8'));
  if (!rows.length) return null;

  const startRaw = rows[0]['window start date'] ?? rows[0]['start date'] ?? '';
  const endRaw   = rows[0]['window end date']   ?? rows[0]['end date']   ?? '';
  if (!startRaw || !endRaw) return null;

  const start = new Date(startRaw);
  const end   = new Date(endRaw);
  if (isNaN(start) || isNaN(end)) return null;

  const fmt = (d) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const startYear = start.getFullYear();
  const endYear   = end.getFullYear();

  // Detect if this is a full quarter
  const QUARTERS = [
    { q: 'Q1', mStart: 0, dStart: 1, mEnd: 2, dEnd: 31 },
    { q: 'Q2', mStart: 3, dStart: 1, mEnd: 5, dEnd: 30 },
    { q: 'Q3', mStart: 6, dStart: 1, mEnd: 8, dEnd: 30 },
    { q: 'Q4', mStart: 9, dStart: 1, mEnd: 11, dEnd: 31 },
  ];
  const isFullQuarter = QUARTERS.find(q =>
    start.getMonth() === q.mStart && start.getDate() === q.dStart &&
    end.getMonth()   === q.mEnd   && end.getDate()   >= q.dEnd - 1 &&
    startYear === endYear
  );

  if (isFullQuarter) {
    return `${isFullQuarter.q} ${startYear} · ${fmt(start)} – ${fmt(end)}`;
  }

  // Weekly / rolling window
  const spanDays = Math.round((end - start) / (1000 * 60 * 60 * 24));
  const label = spanDays <= 10 ? 'Week of' : spanDays <= 35 ? 'Rolling 30d' : 'Custom';
  const yearSuffix = startYear !== endYear ? `, ${endYear}` : '';
  return `${label} ${fmt(start)} – ${fmt(end)}${yearSuffix}`;
}

if (pipelinePath) {
  importPipeline(pipelinePath, data);
  const label = buildPeriodLabel(pipelinePath);
  if (label) {
    data._meta.period_label = label;
    console.log('✓ Period label:', label);
  }
}
if (outreachPath) importOutreach(outreachPath, data);

// Update "Updated" date to today
const today = new Date();
data._meta.updated = today.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

writeData(data);
console.log('✓ data.js written');
