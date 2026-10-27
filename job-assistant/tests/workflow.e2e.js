/*
 * The whole workflow in the real extension, against stand-in job boards:
 *   find jobs → filter/score → tailor resume → open → fill (with saved
 *   answers) → Bruno submits → site confirms → re-search sees it as applied
 * plus contacts and duplicate outreach, AI tailoring with a fabricated
 * answer, closed postings, a failing job board, phone-width layout and a
 * panel reload in the middle of the work.
 *   npm run test:workflow
 *
 * Nothing real is contacted: job-board and Claude API requests are answered
 * by the test, and application pages come from a local server.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const fx = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');

function startServer() {
  const pages = {
    '/gh/101': fx('apply-real.html'),
    '/thanks': '<!doctype html><h1>Thank you for applying!</h1><p>We have received your application.</p>',
    '/closed': '<!doctype html><h1>Sorry</h1><p>This job is no longer accepting applications.</p>',
  };
  const server = http.createServer((req, res) => {
    const p = new URL(req.url, 'http://x').pathname;
    res.writeHead(pages[p] ? 200 : 404, { 'content-type': 'text/html' });
    res.end(pages[p] || 'not found');
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function extensionCopy() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'job-assistant-wf-'));
  fs.cpSync(path.join(ROOT, 'manifest.json'), path.join(dir, 'manifest.json'));
  fs.cpSync(path.join(ROOT, 'src'), path.join(dir, 'src'), { recursive: true });
  const m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  // A test can't click Chrome's per-site permission prompt; pre-allow the local site.
  m.host_permissions = [...m.host_permissions, 'http://127.0.0.1/*'];
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(m));
  return dir;
}

(async () => {
  const server = await startServer();
  const BASE = 'http://127.0.0.1:' + server.address().port;
  const ext = extensionCopy();
  const ctx = await chromium.launchPersistentContext('', { channel: 'chromium', headless: true, args: ['--disable-extensions-except=' + ext, '--load-extension=' + ext] });
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const id = sw.url().split('/')[2];

  // Stand-in job boards.
  const gh = JSON.parse(fx('api/greenhouse.json'));
  gh.jobs[0].absolute_url = BASE + '/gh/101';
  gh.jobs[3].absolute_url = BASE + '/closed';
  gh.jobs[3].title = 'Account Executive, Commercial';
  gh.jobs[3].location.name = 'Remote';
  gh.jobs[3].content = '&lt;p&gt;Sell security. Pay $90,000 - $110,000.&lt;/p&gt;';
  // A hostile title must show as text, never run.
  gh.jobs.push({ id: 105, title: 'Account Executive <img src=x onerror="window.__xss=1">', location: { name: 'Remote' }, absolute_url: BASE + '/gh/105', content: 'Sell.' });
  let ghCalls = 0;
  await ctx.route('https://boards-api.greenhouse.io/**', (r) => {
    ghCalls++;
    return r.fulfill({ contentType: 'application/json', body: JSON.stringify(gh) });
  });
  await ctx.route('https://api.lever.co/**', (r) => r.fulfill({ contentType: 'application/json', body: fx('api/lever.json') }));
  await ctx.route('https://api.ashbyhq.com/**', (r) => r.fulfill({ status: 500, body: 'down' }));
  let aiCalls = 0;
  await ctx.route('https://api.anthropic.com/**', (r) => {
    aiCalls++;
    const out = {
      headline: 'ALEX SAMPLE',
      summary: 'Full-cycle B2B sales professional with 7 years in cybersecurity who generated $4M.',
      skills: ['Outbound Prospecting', 'Pipeline Generation', 'Closing'],
      fitScore: 64, matchedQualifications: ['outbound prospecting'], missingQualifications: ['Cybersecurity sales experience'],
    };
    return r.fulfill({ contentType: 'application/json', body: JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(out) }] }) });
  });

  let panel = await ctx.newPage();
  const errors = [];
  const watch = (p) => {
    p.on('pageerror', (e) => errors.push('panel: ' + e.message));
    // The stand-in Ashby board fails on purpose; Chrome logs each attempt.
    p.on('console', (m) => m.type() === 'error' && !/status of 500/.test(m.text()) && errors.push('panel console: ' + m.text()));
  };
  watch(panel);
  const PANEL = `chrome-extension://${id}/src/panel/panel.html`;
  await panel.goto(PANEL);
  await panel.waitForTimeout(500);
  await panel.evaluate((sources) => chrome.storage.local.set({ sources }), [
    { type: 'greenhouse', slug: 'acmesec', company: 'Acme Security', enabled: true },
    { type: 'lever', slug: 'beta', company: 'Beta', enabled: true },
    { type: 'ashby', slug: 'gamma', company: 'Gamma', enabled: true },
  ]);

  const steps = [];
  const step = async (name, fn) => {
    try {
      await fn();
      steps.push(['ok', name]);
    } catch (err) {
      steps.push(['FAIL', name, err.message.split('\n')[0]]);
    }
  };
  const tab = (name) => panel.click(`nav button[data-tab=${name}]`);
  const jobItem = (text) => panel.locator('#job-list > li').filter({ has: panel.locator('.title', { hasText: new RegExp('^' + text) }) });
  const storage = (key) => panel.evaluate((k) => chrome.storage.local.get(k).then((o) => o[k]), key);
  const logTitles = async () => (await storage('log')).map((e) => e.action);

  await step('profile, Word resume, saved answers', async () => {
    await tab('profile');
    for (const [k, v] of Object.entries({ firstName: 'Alex', lastName: 'Sample', email: 'alex.jobs@example.com' })) await panel.fill(`#profile-form [name=${k}]`, v);
    await panel.waitForTimeout(600);
    await panel.click('#verify-btn');
    await panel.fill('#resume-form [name=label]', 'Main resume');
    await panel.setInputFiles('#resume-form [name=file]', path.join(__dirname, 'fixtures', 'resume-sample.docx'));
    await panel.click('#resume-form button[type=submit]');
    await panel.waitForTimeout(600);
    assert.match(await panel.textContent('#resume-list'), /Main resume\s*Main/);
    const resumes = await storage('resumes');
    assert.match(resumes[0].text, /Full-cycle B2B sales professional/);
    await panel.fill('#answers-form [name=workAuthorization]', 'Yes');
    await panel.fill('#answers-form [name=sponsorship]', 'No');
    await panel.fill('#answers-form [name=salaryExpectation]', '85000');
    await panel.waitForTimeout(700);
    assert.deepEqual(await storage('answers'), { workAuthorization: 'Yes', sponsorship: 'No', salaryExpectation: '85000' });
  });

  await step('the three search settings validate and build search links', async () => {
    await tab('jobs');
    await panel.fill('#s-positions', '');
    await panel.click('#find-jobs');
    assert.match(await panel.textContent('#toast'), /at least one job position/);
    await panel.fill('#s-location', 'Remote');
    await panel.fill('#s-salary', '80k');
    await panel.fill('#s-positions', 'Account Executive');
    await panel.waitForTimeout(400);
    const li = new URL(await panel.getAttribute('#link-linkedin', 'href'));
    assert.equal(li.searchParams.get('f_WT'), '2');
    assert.equal(li.searchParams.get('f_SB2'), '3');
    await panel.fill('#s-salary', 'lots');
    await panel.click('#find-jobs');
    assert.match(await panel.textContent('#toast'), /should be a number/);
    await panel.fill('#s-salary', '80000');
  });

  await step('Find jobs: filters, scores, shows salary or "unknown", survives a failing board', async () => {
    // Double-click: the second click is ignored while the first search runs.
    await panel.click('#find-jobs');
    await panel.click('#find-jobs', { force: true });
    await panel.waitForFunction(() => !document.querySelector('#find-jobs').disabled, null, { timeout: 30000 });
    const list = await panel.textContent('#job-list');
    const keys = (await storage('jobs')).map((j) => j.dedupeKey);
    assert.equal(new Set(keys).size, keys.length, 'no duplicate jobs');
    assert.match(list, /Account Executive <img src=x onerror/);
    assert.equal(await panel.evaluate(() => window.__xss), undefined);
    assert.equal(await panel.$$eval('#job-list img', (e) => e.length), 0);
    assert.match(list, /Account Executive, SMB/);
    assert.match(list, /\$85K–\$105K OTE/);
    assert.match(list, /Mid-Market AE/);
    assert.match(list, /Match \d+/);
    assert.doesNotMatch(list, /Senior Software Engineer|London|Toronto/);
    assert.match(await panel.textContent('#find-status'), /new match/);
    assert.match(await panel.textContent('#find-status'), /had problems/);
    const sources = await storage('sources');
    assert.match(sources.find((x) => x.type === 'ashby').lastError, /HTTP 500/);
    assert.equal((await storage('search')).positions, 'Account Executive');
    // Highest score first.
    const scores = await panel.$$eval('#job-list .chip.score', (els) => els.map((e) => +e.textContent.replace(/\D/g, '')));
    assert.deepEqual(scores, [...scores].sort((a, b) => b - a));
  });

  await step('phone-width layout has no sideways scrolling', async () => {
    await panel.setViewportSize({ width: 360, height: 760 });
    for (const t of ['jobs', 'profile', 'outreach', 'log', 'about']) {
      await tab(t);
      const over = await panel.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      assert.ok(over <= 0, t + ' overflows by ' + over + 'px');
    }
    await panel.setViewportSize({ width: 1200, height: 900 });
    await tab('jobs');
  });

  let app;
  await step('opening a job tailors the resume, then Fill uses it and the saved answers', async () => {
    [app] = await Promise.all([ctx.waitForEvent('page'), jobItem('Account Executive, SMB').locator('button', { hasText: 'Open application' }).click()]);
    await app.waitForLoadState();
    await panel.waitForTimeout(1500);
    const jobs = await storage('jobs');
    const job = jobs.find((j) => j.title === 'Account Executive, SMB');
    assert.ok(job.tailored, 'tailored');
    assert.equal(job.tailored.usedAI, false);
    const resumes = await storage('resumes');
    const tailored = resumes.find((r) => r.id === job.resumeId);
    assert.equal(tailored.forJobId, job.id);
    assert.match(tailored.fileName, /resume-sample_Acme_Security\.docx/);
    await panel.click('#active-job button.primary');
    await panel.waitForTimeout(1200);
    assert.equal(await app.$eval('#fn', (el) => el.value), 'Alex');
    assert.equal(await app.$eval('#cv', (el) => el.files[0] && el.files[0].name), tailored.fileName);
    assert.equal(await app.$eval('input[name=auth][value="1"]', (el) => el.checked), true);
    assert.equal(await app.$eval('#sp', (el) => el.value), 'n');
    assert.equal(await app.$eval('#sal', (el) => el.value), '85000');
    assert.equal(await app.$eval('#vet', (el) => el.value), '', 'veteran status never answered');
    const fill = (await storage('log')).reverse().find((e) => /Routine fields filled/.test(e.action));
    assert.match(fill.resumeVersion, /^Tailored — /);
    assert.ok(fill.fieldsCompleted.some((f) => /your saved answer/.test(f)));
    assert.ok(fill.documentsUploaded[0].startsWith(tailored.fileName));
  });

  await step('a panel reload mid-application keeps everything', async () => {
    await panel.reload();
    await panel.waitForTimeout(800);
    assert.match(await panel.textContent('#active-job'), /Account Executive, SMB/);
    assert.match(await panel.textContent('#active-job'), /Ready for Bruno to review/);
    assert.equal(await panel.inputValue('#s-positions'), 'Account Executive');
  });

  await step('Bruno submits; the site’s thank-you page confirms it', async () => {
    await Promise.all([app.waitForURL(/\/thanks/), app.click('#submit')]);
    await panel.waitForTimeout(2000);
    const job = (await storage('jobs')).find((j) => j.title === 'Account Executive, SMB');
    assert.equal(job.status, 'submitted');
    assert.equal(job.confirmedBy, 'the site’s confirmation page');
    assert.ok((await logTitles()).includes('Submission confirmed by the site'));
  });

  await step('searching again does not re-add or reopen an applied job', async () => {
    const before = (await storage('jobs')).length;
    await panel.click('#find-jobs');
    await panel.waitForFunction(() => !document.querySelector('#find-jobs').disabled, null, { timeout: 30000 });
    const jobs = await storage('jobs');
    assert.equal(jobs.length, before);
    assert.equal(jobs.find((j) => j.title === 'Account Executive, SMB').status, 'submitted');
    assert.match(await panel.textContent('#find-status'), /1 you already applied to/);
    assert.ok(ghCalls >= 2);
  });

  await step('people: drafts for approval, no duplicate outreach to the same person', async () => {
    await panel.selectOption('#job-filter', 'all');
    const item = jobItem('Account Executive, SMB');
    await item.locator('summary', { hasText: 'People to contact' }).click();
    const recruiter = item.locator('.person-role').first();
    assert.match(await recruiter.locator('a').first().getAttribute('href'), /keywords=Acme%20Security%20recruiter/);
    await recruiter.locator('[name=name]').fill('Jane Recruiter');
    await recruiter.locator('[name=url]').fill('https://linkedin.com/in/Jane-Recruiter/');
    await recruiter.locator('button', { hasText: 'Add' }).click();
    await panel.waitForTimeout(600);
    let outreach = await storage('outreach');
    assert.equal(outreach.length, 2);
    assert.match(outreach[0].text, /^Hi Jane, I just applied for the Account Executive role at Acme Security/);
    assert.ok(outreach[0].text.length <= 200);
    // Same person again from another job: no new drafts.
    const other = jobItem('Mid-Market AE');
    await other.locator('summary', { hasText: 'People to contact' }).click();
    const r2 = other.locator('.person-role').first();
    await r2.locator('[name=name]').fill('Jane R');
    await r2.locator('[name=url]').fill('https://www.linkedin.com/in/jane-recruiter');
    await r2.locator('button', { hasText: 'Add' }).click();
    await panel.waitForTimeout(600);
    assert.match(await panel.textContent('#toast'), /already in your contacts/);
    outreach = await storage('outreach');
    assert.equal(outreach.length, 2);
    const contacts = await storage('contacts');
    assert.equal(contacts.length, 1);
    assert.equal(contacts[0].jobIds.length, 2);
    // Approve and mark sent: contact is recorded as contacted.
    await tab('outreach');
    await panel.locator('#outreach-list button', { hasText: 'Approve' }).last().click();
    await panel.waitForTimeout(300);
    await panel.locator('#outreach-list button', { hasText: 'I sent it myself' }).first().click();
    await panel.locator('#outreach-list button', { hasText: 'Confirm: I clicked Send' }).first().click();
    await panel.waitForTimeout(400);
    assert.equal((await storage('contacts'))[0].status, 'sent_by_bruno');
    await tab('jobs');
  });

  await step('AI tailoring: fabricated summary rejected, honest parts kept', async () => {
    await tab('profile');
    await panel.fill('#api-key', 'sk-ant-test-key');
    await panel.click('#save-key');
    await panel.waitForTimeout(300);
    assert.match(await panel.inputValue('#api-key'), /^••••/);
    await tab('jobs');
    await panel.selectOption('#job-filter', 'open');
    await jobItem('Mid-Market AE').locator('button', { hasText: 'Tailor resume' }).click();
    await panel.waitForTimeout(1500);
    assert.equal(aiCalls, 1);
    const job = (await storage('jobs')).find((j) => j.title === 'Mid-Market AE');
    assert.equal(job.tailored.usedAI, true);
    assert.ok(job.tailored.rejected.some((r) => /^summary/.test(r)));
    assert.match(await jobItem('Mid-Market AE').textContent(), /AI fit 64\/100.*AI change\(s\) rejected/);
  });

  await step('a closed posting is detected and filed away', async () => {
    const [page] = await Promise.all([ctx.waitForEvent('page'), jobItem('Account Executive, Commercial').locator('button', { hasText: 'Open application' }).click()]);
    await page.waitForLoadState();
    await panel.waitForTimeout(1500);
    await panel.click('#active-job button.primary');
    await panel.waitForTimeout(1200);
    const job = (await storage('jobs')).find((j) => j.title === 'Account Executive, Commercial');
    assert.equal(job.status, 'closed');
    assert.equal((await storage('session')).paused, false, 'a closed posting is not a security stop');
    assert.equal(await panel.isHidden('#active-job'), true);
  });

  await step('job boards list shows the failing board and can turn it off', async () => {
    await tab('profile');
    await panel.click('summary:has-text("Job boards searched")');
    const row = panel.locator('#source-list > li', { hasText: 'Gamma' });
    assert.match(await row.textContent(), /Problem: HTTP 500/);
    await row.locator('button', { hasText: 'Turn off' }).click();
    await panel.waitForTimeout(300);
    assert.equal((await storage('sources')).find((x) => x.type === 'ashby').enabled, false);
    await panel.fill('#source-form [name=url]', 'https://example.com/careers');
    await panel.click('#source-form button[type=submit]');
    assert.match(await panel.textContent('#toast'), /isn’t a Greenhouse, Lever, Ashby or Workday/);
  });

  await step('optional daily search runs in the background and only adds new matches', async () => {
    await panel.check('#auto-discover');
    await panel.waitForTimeout(800);
    assert.ok(await sw.evaluate(() => chrome.alarms.get('daily-discovery')), 'alarm scheduled');
    // Background requests aren't routed by the test, so give the worker a stand-in fetch.
    const added = await sw.evaluate(async (lever) => {
      const before = (await chrome.storage.local.get('jobs')).jobs.length;
      const lev = JSON.parse(lever);
      lev.push({ id: 'new-1', text: 'Account Executive, Federal', categories: { location: 'Remote' }, workplaceType: 'remote', hostedUrl: 'https://jobs.lever.co/beta/new-1', descriptionPlain: 'Sell.', lists: [] });
      globalThis.fetch = async (url) => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => (/lever/.test(url) ? lev : { jobs: [] }) });
      await discover();
      return (await chrome.storage.local.get('jobs')).jobs.length - before;
    }, fx('api/lever.json'));
    assert.equal(added, 1);
    assert.ok((await logTitles()).some((t) => /^Daily job search: 1 new match/.test(t)));
    await panel.uncheck('#auto-discover');
    await panel.waitForTimeout(800);
    assert.equal(await sw.evaluate(() => chrome.alarms.get('daily-discovery')), undefined, 'alarm removed');
  });

  await step('setup file loads profile, answers, search and resume in one go', async () => {
    const setup = {
      kind: 'job-assistant-setup',
      profile: { firstName: 'Sam', email: 'sam.jobs@example.com', notAField: 'ignored' },
      answers: { relocate: 'No', startDate: 'Two weeks', bogus: 'x' },
      search: { location: 'Tampa, FL', minSalary: '90000', positions: 'Account Executive' },
      resumes: [{ label: 'Setup resume', fileName: 'setup-resume.docx', main: true, dataUrl: 'data:application/vnd.openxmlformats-officedocument.wordprocessingml.document;base64,' + fs.readFileSync(path.join(__dirname, 'fixtures', 'resume-sample.docx')).toString('base64') }],
    };
    await tab('profile');
    await panel.setInputFiles('#setup-file', { name: 'setup.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(setup)) });
    await panel.waitForTimeout(800);
    const profile = await storage('profile');
    assert.equal(profile.values.firstName, 'Sam');
    assert.equal(profile.values.lastName, 'Sample', 'existing fields kept');
    assert.equal(profile.values.notAField, undefined);
    assert.equal(profile.verifiedAt, null, 'must be re-checked');
    const answers = await storage('answers');
    assert.equal(answers.relocate, 'No');
    assert.equal(answers.workAuthorization, 'Yes', 'existing answers kept');
    assert.equal(answers.bogus, undefined);
    assert.equal((await storage('search')).location, 'Tampa, FL');
    const settings = await storage('settings');
    const main = (await storage('resumes')).find((r) => r.id === settings.mainResumeId);
    assert.equal(main.fileName, 'setup-resume.docx');
    assert.match(main.text, /Full-cycle B2B/);
    // Loading the same file twice doesn't duplicate the resume.
    await panel.setInputFiles('#setup-file', { name: 'setup.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(setup)) });
    await panel.waitForTimeout(800);
    assert.equal((await storage('resumes')).filter((r) => r.fileName === 'setup-resume.docx').length, 1);
    await panel.setInputFiles('#setup-file', { name: 'x.json', mimeType: 'application/json', buffer: Buffer.from('{"kind":"other"}') });
    assert.match(await panel.textContent('#toast'), /isn’t a Job Assistant setup file/);
  });

  await ctx.close();
  server.close();
  fs.rmSync(ext, { recursive: true, force: true });
  for (const s of steps) console.log(s.join('  '));
  if (errors.length) console.log('errors:', errors);
  if (steps.some((s) => s[0] === 'FAIL') || errors.length) process.exit(1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
