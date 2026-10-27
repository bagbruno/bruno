/*
 * Drives the real extension in Chromium: side panel, background worker and
 * filler together.
 *   npm run test:extension
 *
 * Chrome would normally ask Bruno to allow each site the first time he clicks
 * Fill. A test can't click that prompt, so this test loads a copy of the
 * extension with the fixture site pre-allowed. Nothing else is changed.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');

// Tabs opened by the extension bypass Playwright's request routing, so serve
// the fixture pages from a real local server.
function startServer() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(fixture('application.html'));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function extensionCopy() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'job-assistant-'));
  fs.cpSync(path.join(ROOT, 'manifest.json'), path.join(dir, 'manifest.json'));
  fs.cpSync(path.join(ROOT, 'src'), path.join(dir, 'src'), { recursive: true });
  const m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  m.host_permissions = ['http://127.0.0.1/*'];
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(m));
  return dir;
}

(async () => {
  const server = await startServer();
  const BASE = 'http://127.0.0.1:' + server.address().port;
  const ext = extensionCopy();
  const ctx = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: true,
    acceptDownloads: true,
    args: ['--disable-extensions-except=' + ext, '--load-extension=' + ext],
  });
  const errors = [];
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const id = sw.url().split('/')[2];


  const panel = await ctx.newPage();
  panel.on('pageerror', (e) => errors.push('panel: ' + e.message));
  panel.on('console', (m) => m.type() === 'error' && errors.push('panel console: ' + m.text()));
  await panel.goto(`chrome-extension://${id}/src/panel/panel.html`);
  // "Add a job you chose" is collapsed under the job search card.
  await panel.click('summary:has-text("Add a job you chose")');

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
  const logTitles = async () => {
    await tab('log');
    const t = await panel.$$eval('#log-list > li .title', (e) => e.map((x) => x.textContent));
    await tab('jobs');
    return t;
  };
  const openJob = async (title) => {
    const [page] = await Promise.all([ctx.waitForEvent('page'), panel.locator('#job-list > li', { hasText: title }).locator('button', { hasText: 'Open application' }).click()]);
    await page.waitForLoadState();
    await panel.waitForTimeout(500);
    return page;
  };
  const clickFill = async () => {
    await panel.click('#active-job button.primary');
    await panel.waitForTimeout(1200);
  };

  await step('Fill is refused until the profile is verified', async () => {
    await panel.fill('#add-job-form [name=url]', BASE + '/apply');
    await panel.fill('#add-job-form [name=title]', 'Account Executive');
    await panel.fill('#add-job-form [name=company]', 'KnowBe4');
    await panel.click('#add-job-form button[type=submit]');
    await panel.waitForTimeout(300);
    const page = await openJob('KnowBe4');
    await clickFill();
    assert.match(await panel.textContent('#toast'), /verify your profile/);
    assert.equal(await page.$eval('#fn', (el) => el.value), '');
    await panel.click('#active-job button:has-text("Close out")');
    await page.close();
  });

  await step('profile, resume version and job setup', async () => {
    await tab('profile');
    const values = { firstName: 'Bruno', lastName: 'Garcia', email: 'bruno.jobs@example.com', phone: '832-890-0003', linkedinUrl: 'https://www.linkedin.com/in/bruno-a-garcia', city: 'Tampa', country: 'United States' };
    for (const [k, v] of Object.entries(values)) await panel.fill(`#profile-form [name=${k}]`, v);
    await panel.waitForTimeout(600);
    await panel.click('#verify-btn');
    await panel.fill('#resume-form [name=label]', 'AE — Cybersecurity');
    await panel.setInputFiles('#resume-form [name=file]', { name: 'Bruno_Garcia_Resume_AE_Cybersecurity.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n%test\n') });
    await panel.click('#resume-form button[type=submit]');
    await panel.waitForTimeout(500);
    assert.match(await panel.textContent('#verify-status'), /Verified by you/);
    assert.match(await panel.textContent('#resume-list'), /AE — Cybersecurity/);
    await tab('jobs');
    await panel.locator('#job-list > li', { hasText: 'KnowBe4' }).locator('select').selectOption({ label: 'AE — Cybersecurity' });
    await panel.waitForTimeout(300);
  });

  let page1;
  await step('Fill from the side panel fills the job tab and logs it', async () => {
    page1 = await openJob('KnowBe4');
    await clickFill();
    assert.equal(await page1.$eval('#fn', (el) => el.value), 'Bruno');
    assert.equal(await page1.$eval('#em', (el) => el.value), 'bruno.jobs@example.com');
    assert.equal(await page1.$eval('#country', (el) => el.value), 'US');
    assert.equal(await page1.$eval('#cv', (el) => el.files[0] && el.files[0].name), 'Bruno_Garcia_Resume_AE_Cybersecurity.pdf');
    assert.equal(await page1.$eval('#sal', (el) => el.value), '');
    assert.equal(await page1.evaluate(() => window.__submitted), 0);
    assert.match(await panel.textContent('#active-job'), /Ready for Bruno to review & submit/);
    await tab('log');
    const entry = panel.locator('#log-list > li', { hasText: 'Routine fields filled' }).first();
    const text = await entry.textContent();
    for (const s of ['Resume version: AE — Cybersecurity', 'Fields completed: First Name', 'Documents uploaded: Bruno_Garcia_Resume_AE_Cybersecurity.pdf', 'Desired salary', 'Not submitted — awaiting Bruno']) {
      assert.ok(text.includes(s), 'log missing: ' + s);
    }
    await tab('jobs');
  });

  await step('only one application open at a time', async () => {
    await panel.fill('#add-job-form [name=url]', BASE + '/second');
    await panel.fill('#add-job-form [name=title]', 'Account Executive');
    await panel.fill('#add-job-form [name=company]', 'Arctic Wolf');
    await panel.click('#add-job-form button[type=submit]');
    await panel.waitForTimeout(300);
    const before = ctx.pages().length;
    await panel.locator('#job-list > li', { hasText: 'Arctic Wolf' }).locator('button', { hasText: 'Open application' }).click();
    await panel.waitForTimeout(500);
    assert.equal(ctx.pages().length, before);
    assert.match(await panel.textContent('#toast'), /one application/);
  });

  await step("Bruno's own Submit click is logged; he confirms submission", async () => {
    await page1.click('#submit');
    await panel.waitForTimeout(800);
    assert.ok((await logTitles()).some((t) => t.startsWith('Submit click by Bruno observed')));
    assert.match(await panel.textContent('#active-job'), /You clicked Submit/);
    await panel.click('#active-job button:has-text("Mark submitted")');
    await panel.click('#active-job button:has-text("Confirm: I clicked Submit myself")');
    await panel.waitForTimeout(500);
    assert.equal(await panel.isHidden('#active-job'), true);
    await panel.selectOption('#job-filter', 'submitted');
    assert.match(await panel.textContent('#job-list'), /KnowBe4/);
    await panel.selectOption('#job-filter', 'open');
  });

  await step('CAPTCHA appearing mid-application pauses everything', async () => {
    const page2 = await openJob('Arctic Wolf');
    await clickFill();
    await page2.evaluate(() => {
      const f = document.createElement('iframe');
      f.src = 'https://www.google.com/recaptcha/api2/bframe?k=x';
      f.width = 400;
      f.height = 580;
      document.body.append(f);
    });
    await panel.waitForTimeout(1500);
    assert.equal(await panel.isVisible('#pause-banner'), true);
    assert.match(await panel.textContent('#pause-reason'), /CAPTCHA/);
    assert.match(await panel.textContent('#active-job'), /Manual action required/);
    assert.equal(await panel.isDisabled('#active-job button.primary'), true);
    // Bruno says he dealt with it, but the CAPTCHA is still there: Fill stops again.
    await panel.click('#resume-btn');
    await panel.waitForTimeout(500);
    await clickFill();
    assert.equal(await panel.isVisible('#pause-banner'), true);
    assert.ok((await logTitles()).some((t) => t.startsWith('Stopped before filling')));
    await panel.click('#resume-btn');
    await panel.click('#active-job button:has-text("Close out")');
    await page2.close();
  });

  await step('LinkedIn job: Fill disabled, platform warning shown', async () => {
    await panel.fill('#add-job-form [name=url]', 'https://www.linkedin.com/jobs/view/123');
    await panel.fill('#add-job-form [name=title]', 'Account Executive');
    await panel.fill('#add-job-form [name=company]', 'Darktrace');
    await panel.click('#add-job-form button[type=submit]');
    await panel.waitForTimeout(300);
    assert.match(await panel.textContent('#job-list'), /LinkedIn: fill by hand/);
    const page3 = await openJob('Darktrace');
    assert.equal(await panel.isDisabled('#active-job button.primary'), true);
    assert.match(await panel.textContent('#active-job'), /User Agreement prohibits/);
    await page3.close();
    await panel.click('#active-job button:has-text("Close out")');
  });

  await step('import list, outreach approval, CSV export', async () => {
    const csv = 'title,company,url\nAccount Executive,ReliaQuest,' + BASE + '/rq\nBad row,,not-a-url\n';
    await panel.setInputFiles('#import-file', { name: 'jobs.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
    await panel.waitForTimeout(500);
    assert.match(await panel.textContent('#job-list'), /ReliaQuest/);
    await tab('outreach');
    await panel.fill('#outreach-form [name=personName]', 'Jane Recruiter');
    await panel.fill('#outreach-form [name=profileUrl]', 'https://www.linkedin.com/in/jane');
    await panel.fill('#outreach-form [name=text]', 'Hi Jane, I just applied for the Account Executive role at KnowBe4.');
    await panel.click('#outreach-form button[type=submit]');
    await panel.waitForTimeout(300);
    await panel.click('#outreach-list button:has-text("Approve")');
    await panel.waitForTimeout(300);
    assert.match(await panel.textContent('#outreach-list'), /Approved — send it yourself/);
    await tab('log');
    const [dl] = await Promise.all([panel.waitForEvent('download'), panel.click('#export-csv')]);
    const out = fs.readFileSync(await dl.path(), 'utf8');
    assert.match(out.split('\r\n')[0], /ts,job,url,action,resumeVersion,fieldsCompleted,fieldsForBruno,documentsUploaded,submissionStatus,details/);
    assert.ok(out.includes('Bruno confirmed he submitted the application'));
    assert.ok(out.includes('missing or invalid url'));
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
