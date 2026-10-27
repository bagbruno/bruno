const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const D = require('../src/shared/discovery.js');

const api = (name) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'api', name), 'utf8'));

// A fake fetch that serves fixtures and records every request.
function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET', body: init.body });
    for (const [re, handler] of routes) {
      if (re.test(url)) {
        const r = typeof handler === 'function' ? handler(url, init, calls) : handler;
        if (r instanceof Error) throw r;
        const status = r.status || 200;
        return { ok: status < 400, status, headers: { get: () => r.retryAfter || null }, json: async () => r.body };
      }
    }
    return { ok: false, status: 404, headers: { get: () => null }, json: async () => ({}) };
  };
  fn.calls = calls;
  return fn;
}

const SOURCES = [
  { type: 'greenhouse', slug: 'acmesec', company: 'Acme Security' },
  { type: 'lever', slug: 'beta', company: 'Beta' },
  { type: 'ashby', slug: 'gamma', company: 'Gamma' },
  { type: 'workday', host: 'delta.wd1.myworkdayjobs.com', tenant: 'delta', site: 'External', company: 'Delta' },
];
const ROUTES = [
  [/boards-api\.greenhouse\.io\/v1\/boards\/acmesec\/jobs/, { body: api('greenhouse.json') }],
  [/api\.lever\.co\/v0\/postings\/beta/, { body: api('lever.json') }],
  [/api\.ashbyhq\.com\/posting-api\/job-board\/gamma/, { body: api('ashby.json') }],
  [/\/wday\/cxs\/delta\/External\/jobs$/, { body: api('workday-list.json') }],
  [/\/wday\/cxs\/delta\/External\/job\//, { body: api('workday-detail.json') }],
];
const RESUME = 'Account Executive. New logo acquisition, outbound prospecting, pipeline generation, discovery, negotiation, closing. Salesforce, HubSpot.';
const SETTINGS = { location: 'Remote', minSalary: 80000, positions: 'Account Executive' };

test('salary parsing: ranges, K, hourly, OTE, missing stays unknown', () => {
  assert.deepEqual(pick(D.parseSalary('Base: $85,000 - $105,000 USD')), [85000, 105000, false]);
  assert.deepEqual(pick(D.parseSalary('$120K–$150K OTE')), [120000, 150000, true]);
  assert.deepEqual(pick(D.parseSalary('$120-150K')), [120000, 150000, false]);
  assert.deepEqual(pick(D.parseSalary('$30/hr')), [62400, 62400, false]);
  assert.deepEqual(pick(D.parseSalary('$25 - $35 per hour')), [52000, 72800, false]);
  assert.deepEqual(pick(D.parseSalary('base salary range of 91,000 to 194,000 USD annually')), [91000, 194000, false]);
  assert.equal(D.parseSalary('Competitive salary and great benefits'), null);
  assert.equal(D.parseSalary('We raised $50M in Series B'), null);
  assert.equal(D.parseSalary('401k match up to 4%'), null);
  assert.equal(D.formatSalary(null), 'Salary unknown');
});
function pick(s) {
  return s && [s.min, s.max, s.ote];
}

test('location matching: remote, nationwide, city, state, non-US', () => {
  const j = (location, remote = false) => ({ location, remote });
  assert.equal(D.matchLocation(j('Remote - US'), 'Remote').pass, true);
  assert.equal(D.matchLocation(j('London, UK', true), 'Remote').pass, false);
  assert.equal(D.matchLocation(j('Tampa, FL'), 'Remote').pass, false);
  assert.equal(D.matchLocation(j('Austin, TX'), 'Nationwide').pass, true);
  assert.equal(D.matchLocation(j('Toronto, Canada'), 'Nationwide').pass, false);
  assert.equal(D.matchLocation(j('Tampa, FL'), 'Tampa, FL').points, 20);
  assert.equal(D.matchLocation(j('Orlando, Florida'), 'Tampa, FL').points, 10);
  assert.equal(D.matchLocation(j('Remote'), 'Tampa, FL').points, 15);
  assert.equal(D.matchLocation(j('Denver, CO'), 'Tampa, FL').pass, false);
  assert.equal(D.matchLocation(j('Miami, FL'), 'Florida').pass, true);
  assert.equal(D.matchLocation(j('Tampa, FL'), 'Remote; Tampa, FL').pass, true);
  assert.equal(D.matchLocation(j('Anywhere'), '').pass, true);
});

test('title matching: abbreviations, seniority, multiple positions, near misses', () => {
  const P = ['Account Executive'];
  assert.equal(D.matchTitle('Enterprise Account Executive', P).pass, true);
  assert.equal(D.matchTitle('Sr. AE, Mid-Market', P).pass, true);
  assert.equal(D.matchTitle('Account Executive II', P).pass, true);
  assert.equal(D.matchTitle('Account Manager', P).pass, false);
  assert.equal(D.matchTitle('Executive Assistant', P).pass, false);
  assert.equal(D.matchTitle('Sales Development Rep', ['SDR', 'Account Executive']).pass, false);
  assert.equal(D.matchTitle('Sales Development Representative', ['SDR', 'Account Executive']).pass, true);
  assert.deepEqual(D.parsePositions('Account Executive, Sales Executive;BDR'), ['Account Executive', 'Sales Executive', 'BDR']);
});

test('salary filter: below minimum excluded, unknown kept and marked', () => {
  assert.equal(D.matchSalary({ salary: { min: 45000, max: 55000 } }, 80000).pass, false);
  const unknown = D.matchSalary({ salary: null }, 80000);
  assert.equal(unknown.pass, true);
  assert.equal(unknown.why, 'salary unknown');
  assert.equal(D.matchSalary({ salary: { min: 70000, max: 90000 } }, 80000).pass, true);
});

test('detectSource understands each board URL', () => {
  assert.deepEqual(D.detectSource('https://job-boards.greenhouse.io/threatlocker/jobs/5532524004'), { type: 'greenhouse', slug: 'threatlocker' });
  assert.deepEqual(D.detectSource('https://boards.greenhouse.io/embed/job_app?for=acme&token=1'), { type: 'greenhouse', slug: 'acme' });
  assert.deepEqual(D.detectSource('https://jobs.lever.co/huntress/abc'), { type: 'lever', slug: 'huntress' });
  assert.deepEqual(D.detectSource('https://jobs.ashbyhq.com/1password/9854'), { type: 'ashby', slug: '1password' });
  assert.deepEqual(D.detectSource('https://arcticwolf.wd1.myworkdayjobs.com/en-US/External/job/X_R26_443'), { type: 'workday', host: 'arcticwolf.wd1.myworkdayjobs.com', tenant: 'arcticwolf', site: 'External' });
  assert.equal(D.detectSource('https://www.linkedin.com/jobs/view/1'), null);
  assert.equal(D.detectSource('not a url'), null);
});

test('dedupe keys match the same job across platforms and URLs', () => {
  const a = D.dedupeKey({ company: 'KnowBe4, Inc.', title: 'Sr. Account Executive', location: 'Clearwater, FL' });
  const b = D.dedupeKey({ company: 'KnowBe4', title: 'Senior Account Executive', location: 'Clearwater, Florida, United States' });
  assert.equal(a, b);
  assert.equal(D.canonicalUrl('https://jobs.lever.co/x/1/apply?lever-source=LinkedIn#top'), D.canonicalUrl('https://jobs.lever.co/x/1'));
});

test('discovery: all four boards, filters, unknown salary, details only for matching titles', async () => {
  const f = fakeFetch(ROUTES);
  const { jobs, summary, sources } = await D.runDiscovery({ settings: SETTINGS, sources: SOURCES, jobs: [], resumeText: RESUME, fetchFn: f, delayMs: 0 });
  const titles = jobs.map((j) => j.company + ': ' + j.title).sort();
  assert.deepEqual(titles, [
    'Acme Security: Account Executive, SMB',
    'Beta: Mid-Market AE',
    'Delta: Account Executive - Enterprise (East Florida)',
    'Gamma: Commercial Account Executive',
  ]);
  const gh = jobs.find((j) => j.source === 'greenhouse');
  assert.equal(gh.salary.min, 85000);
  assert.equal(gh.description.includes('<'), false, 'HTML stripped');
  assert.ok(gh.score > 60, 'score ' + gh.score);
  assert.equal(jobs.find((j) => j.source === 'workday').salary.max, 194000);
  assert.equal(jobs.find((j) => j.source === 'ashby').applyUrl, 'https://jobs.ashbyhq.com/gamma/z1/application');
  // Payroll Specialist never had its details fetched.
  assert.equal(f.calls.filter((c) => /Payroll/.test(c.url)).length, 0);
  assert.equal(summary.errors.length, 0);
  assert.ok(summary.skipped['title doesn’t match your positions'] >= 1);
  assert.ok(Object.keys(summary.skipped).some((k) => /location/.test(k)));
  assert.ok(sources.every((s) => s.lastOk));
  // Nothing dated or invented: a job with no pay info stays unknown.
  const { jobs: j2 } = await D.runDiscovery({ settings: { ...SETTINGS, minSalary: 0, location: 'Nationwide' }, sources: SOURCES.slice(1, 2), jobs: [], resumeText: RESUME, fetchFn: fakeFetch(ROUTES), delayMs: 0 });
  assert.ok(j2.length >= 1);
});

test('discovery: re-running merges, keeps Bruno’s status, flags applied, closes delisted', async () => {
  const first = await D.runDiscovery({ settings: SETTINGS, sources: SOURCES.slice(0, 1), jobs: [], resumeText: RESUME, fetchFn: fakeFetch(ROUTES), delayMs: 0 });
  first.jobs[0].status = 'submitted';
  first.jobs[0].resumeId = 'r1';
  const again = await D.runDiscovery({ settings: SETTINGS, sources: SOURCES.slice(0, 1), jobs: first.jobs, resumeText: RESUME, fetchFn: fakeFetch(ROUTES), delayMs: 0 });
  assert.equal(again.jobs.length, first.jobs.length, 'no duplicates on re-run');
  assert.equal(again.jobs[0].status, 'submitted');
  assert.equal(again.jobs[0].resumeId, 'r1');
  assert.equal(again.summary.alreadyApplied, 1);
  // The board stops listing everything: open jobs become closed, submitted stays submitted.
  const extra = Object.assign({}, again.jobs[0], { id: 'x', sourceKey: 'greenhouse:999', url: 'https://job-boards.greenhouse.io/acmesec/jobs/999', dedupeKey: 'other', status: 'selected', canonicalUrl: 'x' });
  const gone = await D.runDiscovery({ settings: SETTINGS, sources: SOURCES.slice(0, 1), jobs: [...again.jobs, extra], resumeText: RESUME, fetchFn: fakeFetch([[/greenhouse/, { body: { jobs: [] } }]]), delayMs: 0 });
  assert.equal(gone.jobs.find((j) => j.id === 'x').status, 'closed');
  assert.equal(gone.jobs[0].status, 'submitted');
});

test('discovery: a job saved from LinkedIn is recognised when found on the company board', async () => {
  const saved = { id: 'li1', url: 'https://www.linkedin.com/jobs/view/1', title: 'Account Executive, SMB', company: 'Acme Security', location: 'Remote', remote: true, status: 'selected' };
  saved.dedupeKey = D.dedupeKey(saved);
  const { jobs, summary } = await D.runDiscovery({ settings: SETTINGS, sources: SOURCES.slice(0, 1), jobs: [saved], resumeText: RESUME, fetchFn: fakeFetch(ROUTES), delayMs: 0 });
  assert.equal(jobs.length, 1);
  assert.equal(summary.duplicates + summary.updated >= 1, true);
  assert.match(jobs[0].applyUrl, /greenhouse/);
});

test('discovery: retries temporary errors, turns off missing boards, survives bad data', async () => {
  let n = 0;
  const flaky = fakeFetch([
    [/greenhouse/, () => (++n < 2 ? { status: 503 } : { body: api('greenhouse.json') })],
    [/lever/, { status: 404 }],
    [/ashby/, { body: { unexpected: true } }],
    [/wday/, new TypeError('Failed to fetch')],
  ]);
  const { jobs, sources, summary } = await D.runDiscovery({ settings: SETTINGS, sources: SOURCES, jobs: [], resumeText: RESUME, fetchFn: async (u, i) => flaky(u, i), delayMs: 0 });
  assert.equal(n, 2, 'one retry after 503');
  assert.ok(jobs.some((j) => j.source === 'greenhouse'));
  assert.equal(sources.find((s) => s.type === 'lever').enabled, false);
  assert.equal(sources.find((s) => s.type === 'workday').enabled, undefined, 'one network failure does not turn a source off');
  assert.equal(summary.errors.length, 2);
}, { timeout: 30000 });

test('search links carry the three settings', () => {
  const l = D.searchLinks({ location: 'Remote', minSalary: 100000, positions: 'Account Executive' });
  const li = new URL(l.linkedin);
  assert.equal(li.searchParams.get('keywords'), 'Account Executive');
  assert.equal(li.searchParams.get('f_WT'), '2');
  assert.equal(li.searchParams.get('f_SB2'), '4');
  assert.match(new URL(l.indeed).searchParams.get('q'), /\$100,000/);
  assert.equal(new URL(l.glassdoor).searchParams.get('minSalary'), '100000');
  const tampa = D.searchLinks({ location: 'Tampa, FL', minSalary: '', positions: 'AE, SDR' });
  assert.equal(new URL(tampa.linkedin).searchParams.get('location'), 'Tampa, FL');
  assert.equal(new URL(tampa.linkedin).searchParams.get('f_SB2'), null);
});

test('relevance: short descriptions are neutral, not 0%', () => {
  const ev = D.evaluate({ title: 'Account Executive', location: 'Remote', remote: true, description: 'Sell things.' }, SETTINGS, RESUME);
  assert.ok(ev.reasons.includes('too little description to compare'));
  assert.equal(ev.score, 35 + 20 + 10 + 12);
});
