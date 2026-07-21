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
// normalize department names from Gem (fixes typos + aliases)
const DEPT_MAP = {
  'comunications/pr': 'Communications/PR',
  'comms/pr':         'Communications/PR',
  'communications/pr':'Communications/PR',
  'trust & safety':   'Trust & Safety',
  'exploration team': 'Exploration',
};
function normalizeDept(name) {
  if (!name) return '';
  return DEPT_MAP[name.toLowerCase().trim()] || name.trim();
}

const SOURCE_MAP = {
  'gem sequence':       'Sourced',
  'direct outbound':    'Sourced',
  'eng outbound':       'Sourced',
  'linkedin':           'Sourced',
  'linkedin sourced':   'Sourced',
  'gem':                'Sourced',
  'gem outreach':       'Sourced',
  'sourced':            'Sourced',
  'direct referral':    'Referral',
  'referral':           'Referral',
  'employee referral':  'Referral',
  'company career site':'Inbound',
  'inbound':            'Inbound',
  'applied':            'Inbound',
  'careers page':       'Inbound',
  'job board':          'Inbound',
  'agency':             'Agency',
};
function normalizeSource(sourceObj) {
  if (!sourceObj) return 'Other';
  const name = typeof sourceObj === 'string' ? sourceObj : (sourceObj.public_name || '');
  if (!name) return 'Other';
  return SOURCE_MAP[name.toLowerCase().trim()] || name.trim();
}

// canonical pipeline stages in display order (derived from live Gem stage names)
const PIPELINE_STAGES = [
  { key: 'app_review',   label: 'Application Review'  },
  { key: 'recruiter',    label: 'Recruiter Interview'  },
  { key: 'hm_review',    label: 'HM Review'            },
  { key: 'hm_interview', label: 'HM Interview'         },
  { key: 'technical',    label: 'Technical Assessment' },
  { key: 'culture',      label: 'Culture Interview'    },
  { key: 'trial',        label: 'Trial Day'            },
  { key: 'offer',        label: 'Offer'                },
];

function pipelineBucket(name) {
  if (!name) return null;
  const n = name.toLowerCase().trim();
  if (n.includes('application') || n === 'app review')
    return 'app_review';
  if (n.includes('recruiter') || n.includes('phone') || n.includes('screen') ||
      n.startsWith('intro'))
    return 'recruiter';
  // async HM-review / executive-review gates (not a live interview)
  if (n === 'hm review' || n.includes('for rose') || n.includes('for hm') ||
      n.includes('for aaron') || n === 'hm hold' || n === 'top picks' ||
      n.includes('hiring manager review'))
    return 'hm_review';
  if (n.includes('hiring manager') || n === 'hm interview')
    return 'hm_interview';
  if (n.includes('technical') || n.includes('take home') || n.includes('take-home') ||
      n.includes('written') || n.includes('linux') || n.includes('assessment') ||
      n.includes('platform') || n.includes('regulatory') || n.includes('portfolio') ||
      n.includes('pair') || n.includes('deep dive') || n.includes('hands-on') ||
      n.includes('mgmt deep') || n.includes('team deep') || n.includes('design deep') ||
      n.includes('case stud') || n.includes('onsite'))
    return 'technical';
  if (n.includes('culture') || n.includes('team fit') || n.includes('executive') ||
      n.includes('leadership') || n.includes('exec'))
    return 'culture';
  if (n.includes('trial'))
    return 'trial';
  if (n.includes('offer') || n.includes('comp call') || n.includes('compensation') ||
      n.includes('ref') || n.includes('reference'))
    return 'offer';
  return null;
}

function stageBucket(name) {
  if (!name) return null;
  const n = name.toLowerCase().trim();
  if (n.includes('application') || n === 'app review')           return 'app_review';
  if (n.includes('recruiter') || n.includes('phone') || n.includes('screen') || n.startsWith('intro')) return 'recruiter';
  if (n === 'hm review' || n === 'hm interview' || n === 'hm hold' || n === 'top picks' ||
      n.includes('for rose') || n.includes('for hm') || n.includes('for aaron') ||
      n.includes('hiring manager'))                                               return 'hm_interview';
  if (n.includes('technical') || n.includes('take home') || n.includes('take-home') ||
      n.includes('pair') || n.includes('deep dive') || n.includes('culture') ||
      n.includes('portfolio') || n.includes('trial') || n.includes('written') ||
      n.includes('linux') || n.includes('assessment') || n.includes('platform') ||
      n.includes('regulatory') || n.includes('hands-on') || n.includes('mgmt deep') ||
      n.includes('team deep') || n.includes('design deep') || n.includes('case stud') ||
      n.includes('onsite'))                                                        return 'technical';
  if (n.includes('offer') || n.includes('comp call') || n.includes('compensation')) return 'offer';
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
  const prev = existing.kpis || {};

  // 1. Jobs (open)
  console.log('  → jobs');
  const allJobs = await getAll('/ats/v0/jobs?status=open');

  // Fetch closed jobs too — needed for team/role lookup on past hires
  console.log('  → closed jobs (for hire lookup)');
  const closedJobs = await getAll('/ats/v0/jobs?status=closed');

  // 2. All active applications (for pipeline counts)
  console.log('  → active applications');
  const activeApps = await getAll('/ats/v0/applications?status=active');

  // 3. Hired applications (YTD + all time)
  console.log('  → hired applications');
  const hiredApps = await getAll('/ats/v0/applications?status=hired');

  // 3b. Rejected applications that reached offer stage (for offer acceptance detail)
  console.log('  → offer-stage rejections');
  const rejectedApps = await getAll('/ats/v0/applications?status=rejected');
  const offerRejected = rejectedApps.filter(a => {
    const d = a.last_activity_at || a.applied_at;
    return d && fyYear(d) === new Date().getFullYear() && stageBucket(a.current_stage?.name) === 'offer';
  });

  // 4. Candidate names for hired + offer-rejected apps (batch lookup)
  console.log('  → candidate names for hires');
  const candidateCache = {};
  const hiredThisYear = hiredApps.filter(a => {
    const d = a.last_activity_at || a.applied_at;
    return d && fyYear(d) === new Date().getFullYear();
  });
  const offerApps = [...hiredThisYear, ...offerRejected];
  // fetch names in parallel (batched 10 at a time)
  const batch = 10;
  for (let i = 0; i < offerApps.length; i += batch) {
    const slice = offerApps.slice(i, i + batch);
    await Promise.all(slice.map(async a => {
      if (!a.candidate_id || candidateCache[a.candidate_id]) return;
      try {
        const c = await get(`/ats/v0/candidates/${a.candidate_id}`);
        candidateCache[a.candidate_id] = `${c.first_name || ''} ${c.last_name || ''}`.trim();
      } catch(e) { candidateCache[a.candidate_id] = ''; }
    }));
  }

  // ── build pipeline stage counts + per-app records for DR filtering ──────
  const stageCounts = { app_review: 0, recruiter: 0, hm_interview: 0, technical: 0, offer: 0, hired: 0 };
  const pipelineApps = [];
  for (const app of activeApps) {
    const b = stageBucket(app.current_stage?.name);
    if (b) {
      stageCounts[b]++;
      const date = (app.current_stage?.entered_at || app.last_activity_at || app.applied_at || '').slice(0, 10);
      if (date) pipelineApps.push({ stage: b, date });
    }
  }
  stageCounts.hired = hiredApps.filter(a => {
    const d = a.last_activity_at || a.applied_at;
    return d && fyYear(d) === new Date().getFullYear();
  }).length;

  // passthrough rates — offer→hired uses acceptance rate from offers array (not snapshot/YTD ratio)
  // NOTE: offers array is built later; compute offer acceptance inline here
  const offersTotal    = hiredThisYear.length + offerRejected.length;
  const offerAccepted  = hiredThisYear.length;
  const passthrough = {
    app_to_recruiter:       stageCounts.app_review    ? Math.round(stageCounts.recruiter    / stageCounts.app_review    * 100) : 0,
    recruiter_to_hm:        stageCounts.recruiter     ? Math.round(stageCounts.hm_interview / stageCounts.recruiter     * 100) : 0,
    hm_to_technical:        stageCounts.hm_interview  ? Math.round(stageCounts.technical    / stageCounts.hm_interview  * 100) : 0,
    technical_to_offer:     stageCounts.technical     ? Math.round(stageCounts.offer        / stageCounts.technical     * 100) : 0,
    offer_to_hired:         offersTotal               ? Math.round(offerAccepted            / offersTotal               * 100) : 0,
  };

  // ── build roles from open jobs ───────────────────────────────────────────
  const existingRoleMap = {};
  (existing.roles || []).forEach(r => { existingRoleMap[r.req_id] = r; });

  const roles = allJobs.map(job => {
    const reqId = job.requisition_id || '';
    const prev  = existingRoleMap[reqId] || {};

    // active applications for this job
    const jobApps = activeApps.filter(a => a.jobs?.some(j => j.id === job.id));
    // group by canonical pipeline bucket, then emit in defined order
    const bucketCounts = {};
    for (const app of jobApps) {
      const bucket = pipelineBucket(app.current_stage?.name) || 'other';
      bucketCounts[bucket] = (bucketCounts[bucket] || 0) + 1;
    }
    const stages = PIPELINE_STAGES
      .filter(s => bucketCounts[s.key] > 0)
      .map(s => ({
        label: `${s.label} ${bucketCounts[s.key]}`,
        type:  s.key === 'offer' ? 'offer' : s.key === 'deep_dive' ? 'dd' : 'default',
      }));
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
  // build job lookup for role/team on hired apps (open + closed)
  const jobLookup = {};
  for (const job of [...allJobs, ...closedJobs]) { jobLookup[job.id] = job; }

  const ytdHires = hiredThisYear
    .sort((a, b) => new Date(b.last_activity_at) - new Date(a.last_activity_at))
    .map(a => {
      const jobId = a.jobs?.[0]?.id;
      const job   = jobId ? jobLookup[jobId] : null;
      return {
        name:   candidateCache[a.candidate_id] || '',
        role:   job?.name?.trim() || '',
        team:   normalizeDept(job?.departments?.[0]?.name) || '',
        date:   (a.last_activity_at || a.applied_at || '').slice(0, 10),
        status: 'Accepted',
        source: normalizeSource(a.source || ''),
      };
    });

  // ── offers detail (accepted = hired this year, declined = offer-stage rejections) ──
  const offers = [...hiredThisYear.map(a => {
    const jobId = a.jobs?.[0]?.id;
    const job   = jobId ? jobLookup[jobId] : null;
    return {
      name:   candidateCache[a.candidate_id] || '',
      role:   job?.name?.trim() || '',
      team:   normalizeDept(job?.departments?.[0]?.name) || '',
      status: 'Accepted',
      date:   (a.last_activity_at || '').slice(0, 10),
    };
  }), ...offerRejected.map(a => {
    const jobId = a.jobs?.[0]?.id;
    const job   = jobId ? jobLookup[jobId] : null;
    const candidateName = candidateCache[a.candidate_id] || '';
    const prevOffer = (prev.offers || []).find(o => o.name === candidateName && o.status === 'Declined');
    return {
      name:           candidateName,
      role:           job?.name?.trim() || '',
      team:           normalizeDept(job?.departments?.[0]?.name) || '',
      status:         'Declined',
      date:           (a.last_activity_at || '').slice(0, 10),
      decline_reason: prevOffer?.decline_reason || '',
    };
  })].sort((a, b) => b.date.localeCompare(a.date));

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

  const kpis = {
    hires:                q2Hires,
    hires_target:         prev.hires_target         || 5,
    hires_target_annual:  prev.hires_target_annual  || 20,
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
      app_review:   { count: stageCounts.app_review,   avg_days: existing.pipeline?.app_review?.avg_days   || 0 },
      recruiter:    { count: stageCounts.recruiter,    avg_days: existing.pipeline?.recruiter?.avg_days    || 0 },
      hm_interview: { count: stageCounts.hm_interview, avg_days: existing.pipeline?.hm_interview?.avg_days || 0 },
      technical:    { count: stageCounts.technical,    avg_days: existing.pipeline?.technical?.avg_days    || 0 },
      offer:        { count: stageCounts.offer,        avg_days: existing.pipeline?.offer?.avg_days        || 0 },
      hired:        { count: stageCounts.hired,        avg_days: existing.pipeline?.hired?.avg_days        || 0 },
    },
    pipeline_apps: pipelineApps,
    passthrough,
    outreach:       existing.outreach       || [],
    ytd_hires:      ytdHires,
    offers,
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
  console.log(`  Pipeline counts: App ${stageCounts.app_review} | Recruiter ${stageCounts.recruiter} | HM ${stageCounts.hm_interview} | Technical ${stageCounts.technical} | Offer ${stageCounts.offer}`);
}

main().catch(e => { console.error(e); process.exit(1); });
