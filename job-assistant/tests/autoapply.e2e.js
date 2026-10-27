/*
 * Unattended Auto-apply in the real extension: approval, the queue, automatic
 * submission with site confirmation, applications held back for Bruno,
 * an unconfirmed submit, platforms that are never auto-submitted, and the
 * approval being cancelled when details change.
 *   npm run test:autoapply
 *
 * Application pages come from a local server. The test copy of the extension
 * treats that server as an auto-submit site and pre-allows it, because a test
 * can't click Chrome's permission prompt. Nothing real is submitted.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const GH = fs.readFileSync(path.join(__dirname, 'fixtures', 'gh-apply.html'), 'utf8');

function startServer() {
  const submissions = [];
  const pages = {
    '/gh/1': GH,
    '/gh/2': GH.replace('Account Executive, SMB</h1>', 'Account Executive, Mid-Market</h1>').replace('<title>Job Application for Account Executive, SMB', '<title>Job Application for Account Executive, Mid-Market').replace('<!--EXTRA-->', '<label for="why">Why do you want to work here? *</label><textarea id="why" name="why" required></textarea>'),
    '/gh/3': GH.replace(/Account Executive, SMB/g, 'Account Executive, Enterprise').replace('action="confirmation"', 'action="/gh/3/error"'),
    '/gh/3/error': '<!doctype html><h1>Account Executive, Enterprise</h1><p class="error">Something went wrong. Please try again.</p>',
  };
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (/\/confirmation$/.test(u.pathname)) {
      submissions.push({ path: u.pathname, fields: Object.fromEntries(u.searchParams) });
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end('<!doctype html><h1>Thank you for applying!</h1><p>Your application has been received.</p>');
    }
    if (u.pathname === '/gh/3/error') submissions.push({ path: u.pathname });
    res.writeHead(pages[u.pathname] ? 200 : 404, { 'content-type': 'text/html' });
    res.end(pages[u.pathname] || 'not found');
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, submissions })));
}

function extensionCopy() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'job-assistant-auto-'));
  fs.cpSync(path.join(ROOT, 'manifest.json'), path.join(dir, 'manifest.json'));
  fs.cpSync(path.join(ROOT, 'src'), path.join(dir, 'src'), { recursive: true });
  const m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  m.host_permissions = [...m.host_permissions, 'http://127.0.0.1/*', 'https://job-boards.greenhouse.io/*', 'https://boards.greenhouse.io/*', 'https://jobs.lever.co/*', 'https://jobs.ashbyhq.com/*'];
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(m));
  const rules = path.join(dir, 'src/shared/rules.js');
  const src = fs.readFileSync(rules, 'utf8');
  const patched = src.replace("    { host: 'jobs.ashbyhq.com', name: 'Ashby' },", "    { host: 'jobs.ashbyhq.com', name: 'Ashby' },\n    { host: '127.0.0.1', name: 'Test server' },");
  assert.notEqual(patched, src, 'test patch applied');
  fs.writeFileSync(rules, patched);
  return dir;
}

(async () => {
  const { server, submissions } = await startServer();
  const BASE = 'http://127.0.0.1:' + server.address().port;
  const ext = extensionCopy();
  const ctx = await chromium.launchPersistentContext('', { channel: 'chromium', headless: true, args: ['--disable-extensions-except=' + ext, '--load-extension=' + ext] });
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const panel = await ctx.newPage();
  const errors = [];
  panel.on('pageerror', (e) => errors.push(e.message));
  await panel.goto(`chrome-extension://${sw.url().split('/')[2]}/src/panel/panel.html`);
  await panel.waitForTimeout(500);

  const docx = 'data:application/vnd.openxmlformats-officedocument.wordprocessingml.document;base64,' + fs.readFileSync(path.join(__dirname, 'fixtures', 'resume-sample.docx')).toString('base64');
  const job = (id, title, url, extra = {}) => Object.assign({ id, title, company: 'Acme Security', location: 'Remote', remote: true, url, applyUrl: url, status: 'selected', score: 85, description: 'Outbound prospecting, pipeline generation, closing, negotiation. Closing deals.', addedAt: new Date().toISOString() }, extra);
  await panel.evaluate((d) => chrome.storage.local.set(d), {
    profile: { values: { firstName: 'Alex', lastName: 'Sample', email: 'alex.jobs@example.com', phone: '555-0100' }, verifiedAt: new Date().toISOString() },
    answers: { workAuthorization: 'Yes', sponsorship: 'No', relocate: 'No' },
    resumes: [{ id: 'r1', label: 'Main resume', fileName: 'alex-resume.docx', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', size: 1000, dataUrl: docx, text: 'Outbound prospecting pipeline generation closing negotiation', addedAt: new Date().toISOString() }],
    settings: { apiKey: '', autoDiscover: false, mainResumeId: 'r1' },
    sources: [],
    jobs: [
      job('a', 'Account Executive, SMB', BASE + '/gh/1'),
      job('b', 'Account Executive, Mid-Market', BASE + '/gh/2'),
      job('c', 'Account Executive, Enterprise', BASE + '/gh/3'),
      job('d', 'Account Executive', 'https://www.indeed.com/viewjob?jk=1'),
      job('e', 'Account Executive, Federal', BASE + '/gh/1', { score: 40 }),
    ],
  });
  await panel.waitForTimeout(500);
  const storage = (key) => panel.evaluate((k) => chrome.storage.local.get(k).then((o) => o[k]), key);
  const jobsById = async () => Object.fromEntries((await storage('jobs')).map((j) => [j.id, j]));

  const steps = [];
  const step = async (name, fn) => {
    try {
      await fn();
      steps.push(['ok', name]);
    } catch (err) {
      steps.push(['FAIL', name, err.message.split('\n')[0]]);
    }
  };

  await step('Auto-apply is off until Bruno approves', async () => {
    assert.equal(await panel.isDisabled('#autoapply-start'), true);
    assert.match(await panel.textContent('#autoapply-status'), /Approve automatic submission/);
  });

  await step('approval shows what will be submitted and records the declarations', async () => {
    await panel.click('nav button[data-tab=profile]');
    const summary = await panel.textContent('#approval-summary');
    for (const s of ['First name: Alex', 'Email: alex.jobs@example.com', 'Authorized to work in the US?: Yes', 'Main resume (tailored per job): alex-resume.docx']) assert.ok(summary.includes(s), s);
    await panel.locator('#approval-summary label', { hasText: 'privacy notice' }).locator('input').check();
    await panel.click('#approval-actions button:has-text("Approve automatic submission")');
    await panel.click('#approval-actions button:has-text("Confirm: submit applications for me")');
    await panel.waitForTimeout(500);
    const a = (await storage('settings')).autoApproval;
    assert.deepEqual(a.declarations, ['privacy']);
    assert.match(await panel.textContent('#approval-summary'), /Approved on/);
    await panel.click('nav button[data-tab=jobs]');
    // Only Greenhouse-style jobs with a good match: a, b, c (not Indeed, not score 40).
    assert.equal(await panel.textContent('#autoapply-start'), 'Auto-apply to 3 jobs');
    assert.match(await panel.textContent('#autoapply-status'), /2 other job\(s\) need you to submit|1 other job\(s\) need you to submit/);
  });

  await step('unattended run: submits and confirms, holds back, never claims unconfirmed', async () => {
    await panel.evaluate(() => {
      globalThis.JOB_ASSIST_PACE_MS = 200;
      globalThis.JOB_ASSIST_CONFIRM_MS = 6000;
    });
    await panel.click('#autoapply-start');
    try {
      await panel.waitForFunction(() => /^Done:/.test(document.querySelector('#autoapply-status').textContent), null, { timeout: 90000 });
    } catch (err) {
      const where = await panel.textContent('#autoapply-status');
      const log = (await storage('log')).slice(-6).map((e) => e.action + (e.details ? ' (' + e.details + ')' : ''));
      throw new Error('Run did not finish. Status: "' + where + '". Last log: ' + log.join(' | '));
    }
    const status = await panel.textContent('#autoapply-status');
    assert.match(status, /1 submitted and confirmed, 1 need you, 0 closed, 1 unconfirmed/);
    const j = await jobsById();
    // a: submitted, confirmed, full record kept.
    assert.equal(j.a.status, 'submitted');
    assert.equal(j.a.submission.confirmed, true);
    assert.equal(j.a.submission.employer, 'Acme Security');
    assert.match(j.a.submission.resume, /alex-resume_Acme_Security\.docx/, 'the tailored resume was used');
    assert.ok(j.a.submission.fields.some((f) => /legally authorized/.test(f.label) && f.value === 'Yes'));
    assert.deepEqual(j.a.submission.declarations, ['I have read and agree to the Applicant Privacy Notice']);
    const sent = submissions.find((s) => s.path === '/gh/confirmation');
    assert.equal(sent.fields.email, 'alex.jobs@example.com');
    assert.equal(sent.fields.gender, '');
    // b: unknown required question → prepared, left for Bruno, nothing sent.
    assert.equal(j.b.status, 'awaiting_bruno');
    assert.match(j.b.manualReason, /Why do you want to work here/);
    // c: submit clicked, site never confirmed → not marked submitted.
    assert.equal(j.c.status, 'manual_action_required');
    assert.match(j.c.manualReason, /didn’t confirm/);
    assert.equal(j.c.submission.confirmed, false);
    // d (Indeed) and e (low match) untouched.
    assert.equal(j.d.status, 'selected');
    assert.equal(j.e.status, 'selected');
    assert.equal(submissions.filter((s) => s.path === '/gh/confirmation').length, 1, 'exactly one real submission');
    const log = (await storage('log')).map((e) => e.action);
    assert.ok(log.some((a) => /^Submitted automatically — confirmed/.test(a)));
    assert.ok(log.includes('Not submitted — needs Bruno'));
    assert.ok(log.includes('Submit clicked automatically — NOT confirmed by the site'));
    assert.equal((await storage('session')).activeJobId, null);
    await panel.waitForTimeout(500);
    assert.deepEqual(ctx.pages().map((p) => p.url()).filter((u) => !u.startsWith('chrome-extension://') && u !== 'about:blank'), [], 'application tabs tidied up');
  });

  await step('running again does not resubmit anything', async () => {
    assert.equal(await panel.isDisabled('#autoapply-start'), true, 'nothing eligible left');
    assert.match(await panel.textContent('#autoapply-start'), /Auto-apply to 0 jobs/);
  });

  await step('changing a detail cancels the approval', async () => {
    await panel.click('nav button[data-tab=profile]');
    await panel.fill('#answers-form [name=relocate]', 'Yes');
    await panel.waitForTimeout(800);
    assert.match(await panel.textContent('#approval-summary'), /changed since you approved/);
    await panel.evaluate(() => chrome.storage.local.get('jobs').then(({ jobs }) => chrome.storage.local.set({ jobs: jobs.map((j) => (j.id === 'e' ? Object.assign(j, { score: 90 }) : j)) })));
    await panel.waitForTimeout(400);
    await panel.click('nav button[data-tab=jobs]');
    assert.equal(await panel.isDisabled('#autoapply-start'), true);
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
