#!/usr/bin/env node
/**
 * gem-api.js — pulls live data from the Gem ATS API and regenerates data.js
 *
 * Usage: node scripts/gem-api.js
 * Requires: GEM_API_KEY in .env (project root) or environment
 */

const fs   = require('fs');
const path = require('path');
const https = require('https');

// ── load .env ──────────────────────────────────────────────────────────────
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
    const [k, ...rest] = line.split('=');
    if (k && rest.length) process.env[k.trim()] = rest.join('=').trim();
  });
}

const API_KEY  = process.env.GEM_API_KEY;
const BASE_URL = 'https://api.gem.com';

if (!API_KEY) { console.error('GEM_API_KEY not set'); process.exit(1); }

// ── HTTP helper ────────────────────────────────────────────────────────────
function get(path) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: 'api.gem.com',
      path,
      headers: { 'X-API-Key': API_KEY, 'Accept': 'application/json' }
    };
    https.get(opts, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch(e) { reject(new Error(`JSON parse error on ${path}: ${body.slice(0,200)}`)); }
      });
    }).on('error', reject);
  });
}

// paginate until we get everything
async function getAll(endpoint) {
  const results = [];
  let page = 1;
  while (true) {
    const sep = endpoint.includes('?') ? '&' : '?';
    const data = await get(`${endpoint}${sep}per_page=500&page=${page}`);
    if (!Array.isArray(data) || data.length === 0) break;
    results.push(...data);
    if (data.length < 500) break;
    page++;
  }
  return results;
}

// ── stage name → dashboard bucket ─────────────────────────────────────────
function stageBucket(name) {
  if (!name) return null;
  const n = name.toLowerCase().trim();
  if (n.includes('application') || n.includes('app review'))    return 'app_review';
  if (n.includes('recruiter') || n.includes('phone') || n.includes('screen')) return 'phone_screen';
  if (n.includes('onsite') || n.includes('pair') || n.includes('deep dive') ||
      n.includes('technical') || n.includes('hm') || n.includes('hiring manager') ||
      n.includes('rose') || n.includes('take home') || n.includes('for '))      return 'onsite';
  if (n.includes('offer'))  return 'offer';
  return null;
}

// ── days between two ISO date strings ─────────────────────────────────────
function daysBetween(a, b) {
  if (!a || !b) return null;
  return Math.round(Math.abs(new Date(b) - new Date(a)) / 86400000);
}

// ── fiscal year helpers ────────────────────────────────────────────────────
// Bluesky FY = calendar year (Jan–Dec assumption; adjust if different)
function fyYear(dateStr) { return new Date(dateStr).getFullYear(); }
function quarter(dateStr) {
  const m = new Date(dateStr).getMonth(); // 0-indexed
  return Math.floor(m / 3) + 1;
}

// ── read existing data.js to preserve manual fields ────────────────────────
function readExisting() {
  const p = path.join(__dirname, '..', 'data.js');
  if (!fs.existsSync(p)) return {};
  try {
    const src = fs.readFileSync(p, 'utf8')
      .replace(/^var DASHBOARD_DATA\s*=\s*/, '')
      .replace(/;\s*$/, '');
    return JSON.parse(src);
  } catch(e) { return {}; }
}

// ── main ───────────────────────────────────────────────────────────────────
async function main() {
  console.log('Fetching data from Gem ATS API…');

  const existing = readExisting();

  // 1. Jobs (open)
  console.log('  → jobs');
  const allJobs = await getAll('/ats/v0/jobs?status=open');

  // 2. All active applications (for pipeline counts)
  console.log('  → active applications');
  const activeApps = await getAll('/ats/v0/applications?status=active');

  // 3. Hired applications (YTD + all time)
  console.log('  → hired applications');
  const hiredApps = await getAll('/ats/v0/applications?status=hired');

  // 4. Candidate names for hired apps (batch lookup)
  console.log('  → candidate names for hires');
  const candidateCache = {};
  const hiredThisYear = hiredApps.filter(a => {
    const d = a.last_activity_at || a.applied_at;
    return d && fyYear(d) === new Date().getFullYear();
  });
  // fetch names in parallel (batched 10 at a time)
  const batch = 10;
  for (let i = 0; i < hiredThisYear.length; i += batch) {
    const slice = hiredThisYear.slice(i, i + batch);
    await Promise.all(slice.map(async a => {
      if (!a.candidate_id || candidateCache[a.candidate_id]) return;
      try {
        const c = await get(`/ats/v0/candidates/${a.candidate_id}`);
        candidateCache[a.candidate_id] = `${c.first_name || ''} ${c.last_name || ''}`.trim();
      } catch(e) { candidateCache[a.candidate_id] = ''; }
    }));
  }

  // ── build pipeline stage counts ──────────────────────────────────────────
  const stageCounts = { app_review: 0, phone_screen: 0, onsite: 0, offer: 0, hired: 0 };
  for (const app of activeApps) {
    const b = stageBucket(app.current_stage?.name);
    if (b) stageCounts[b]++;
  }
  stageCounts.hired = hiredApps.filter(a => {
    const d = a.last_activity_at || a.applied_at;
    return d && fyYear(d) === new Date().getFullYear();
  }).length;

  // passthrough rates
  const passthrough = {
    app_to_phone:    stageCounts.app_review  ? Math.round(stageCounts.phone_screen / stageCounts.app_review  * 100) : 0,
    phone_to_onsite: stageCounts.phone_screen ? Math.round(stageCounts.onsite       / stageCounts.phone_screen * 100) : 0,
    onsite_to_offer: stageCounts.onsite       ? Math.round(stageCounts.offer        / stageCounts.onsite       * 100) : 0,
    offer_to_hired:  stageCounts.offer        ? Math.round(stageCounts.hired        / stageCounts.offer        * 100) : 0,
  };

  // ── build roles from open jobs ───────────────────────────────────────────
  const existingRoleMap = {};
  (existing.roles || []).forEach(r => { existingRoleMap[r.req_id] = r; });

  const roles = allJobs.map(job => {
    const reqId = job.requisition_id || '';
    const prev  = existingRoleMap[reqId] || {};

    // active applications for this job
    const jobApps = activeApps.filter(a => a.jobs?.some(j => j.id === job.id));
    const stages  = [];
    const stageGroups = {};
    for (const app of jobApps) {
      const sName = app.current_stage?.name?.trim() || '—';
      stageGroups[sName] = (stageGroups[sName] || 0) + 1;
    }
    for (const [label, count] of Object.entries(stageGroups)) {
      stages.push({ label: `${label.split(' ')[0]} ${count}`, type: 'default' });
    }
    if (stages.length === 0) stages.push({ label: '—', type: 'default' });

    const recruiter = job.hiring_team?.recruiters?.[0]?.name?.split(' ')[0] || '';
    const dateOpened = (job.opened_at || '').slice(0, 10);
    const daysOpen = dateOpened ? daysBetween(dateOpened, new Date().toISOString()) : null;
    const autoStatus = (daysOpen !== null && daysOpen > 75) ? 'risk' : (prev.status || 'progress');

    return {
      title:      job.name?.trim() || '',
      req_id:     reqId,
      recruiter:  recruiter,
      date_opened: prev.date_opened || dateOpened,
      headcount:  prev.headcount || (job.openings?.length || 1),
      meta:       `${reqId ? reqId + ' · ' : ''}${recruiter}`,
      priority:   prev.priority   || 'normal',
      stages:     stages,
      status:     prev.status_overridden ? prev.status : autoStatus,
      status_overridden: prev.status_overridden || false,
      status_label: prev.status_label || 'In progress',
      note:       prev.note || '',
    };
  });

  // ── build YTD hires ───────────────────────────────────────────────────────
  const currentYear = new Date().getFullYear();
  const ytdHires = hiredThisYear
    .sort((a, b) => new Date(b.last_activity_at) - new Date(a.last_activity_at))
    .map(a => ({
      name:   candidateCache[a.candidate_id] || '',
      date:   (a.last_activity_at || a.applied_at || '').slice(0, 10),
      status: 'Accepted',
    }));

  // ── KPIs ──────────────────────────────────────────────────────────────────
  const q2Hires = hiredApps.filter(a => {
    const d = a.last_activity_at || a.applied_at;
    return d && fyYear(d) === currentYear && quarter(d) === 2;
  }).length;

  // Avg time to hire: applied_at → last_activity_at for YTD hires
  const tthSamples = hiredThisYear
    .map(a => daysBetween(a.applied_at, a.last_activity_at))
    .filter(d => d !== null && d > 0 && d < 365);
  const avgTTH = tthSamples.length
    ? Math.round(tthSamples.reduce((s, v) => s + v, 0) / tthSamples.length)
    : 0;

  const prev = existing.kpis || {};
  const kpis = {
    hires:                q2Hires,
    hires_target:         prev.hires_target         || 5,
    avg_time_to_hire:     avgTTH || prev.avg_time_to_hire || 0,
    avg_time_to_hire_prev:prev.avg_time_to_hire_prev|| 0,
    bench_time_to_hire:   prev.bench_time_to_hire   || 44,
    open_roles:           allJobs.length,
    offer_acceptance_pct: prev.offer_acceptance_pct || 0,
    offers_extended:      prev.offers_extended      || 0,
    active_candidates:    activeApps.length,
  };

  // ── assemble final data ───────────────────────────────────────────────────
  const today = new Date();
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const updated = `${months[today.getMonth()]} ${today.getDate()}`;

  const data = {
    _meta: {
      quarter:      existing._meta?.quarter      || 'Q2 2026',
      period:       existing._meta?.period       || 'Apr 1 – Jun 30',
      period_label: existing._meta?.period_label || updated,
      updated,
    },
    kpis,
    pipeline: {
      app_review:   { count: stageCounts.app_review,  avg_days: existing.pipeline?.app_review?.avg_days  || 0 },
      phone_screen: { count: stageCounts.phone_screen, avg_days: existing.pipeline?.phone_screen?.avg_days || 0 },
      onsite:       { count: stageCounts.onsite,       avg_days: existing.pipeline?.onsite?.avg_days       || 0 },
      offer:        { count: stageCounts.offer,        avg_days: existing.pipeline?.offer?.avg_days        || 0 },
      hired:        { count: stageCounts.hired,        avg_days: existing.pipeline?.hired?.avg_days        || 0 },
    },
    passthrough,
    outreach:       existing.outreach       || [],
    ytd_hires:      ytdHires,
    recruiter_tth:  existing.recruiter_tth  || [],
    flags:          existing.flags          || [],
    roles,
    hires_ytd:      existing.hires_ytd      || [],
  };

  // ── write data.js ─────────────────────────────────────────────────────────
  const outPath = path.join(__dirname, '..', 'data.js');
  fs.writeFileSync(outPath, `var DASHBOARD_DATA = ${JSON.stringify(data, null, 2)};\n`);
  console.log(`\nWrote ${outPath}`);
  console.log(`  Open roles:      ${allJobs.length}`);
  console.log(`  Active apps:     ${activeApps.length}`);
  console.log(`  YTD hires:       ${ytdHires.length}`);
  console.log(`  Pipeline counts: App ${stageCounts.app_review} | Screen ${stageCounts.phone_screen} | Onsite ${stageCounts.onsite} | Offer ${stageCounts.offer}`);
}

main().catch(e => { console.error(e); process.exit(1); });
