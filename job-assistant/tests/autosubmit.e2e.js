/*
 * Automatic submission in the filler: every pre-submit check, on a
 * Greenhouse-style application page. Requests to the board are answered by
 * the test; nothing real is submitted.
 *   npm run test:autosubmit
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const BASE_HTML = fs.readFileSync(path.join(__dirname, 'fixtures', 'gh-apply.html'), 'utf8');
const URL_ = 'https://job-boards.greenhouse.io/acmesec/jobs/101';
const PROFILE = { firstName: 'Alex', lastName: 'Sample', email: 'alex.jobs@example.com', phone: '555-0100', linkedinUrl: 'https://www.linkedin.com/in/alex-sample' };
const ANSWERS = { workAuthorization: 'Yes', sponsorship: 'No', relocate: 'No', salaryExpectation: '95000', startDate: 'Two weeks' };
const RESUME = { label: 'Tailored — Acme', fileName: 'Alex_Sample_Acme.docx', type: 'application/octet-stream', dataUrl: 'data:application/octet-stream;base64,UEsDBA==' };

async function open(browser, html) {
  const page = await browser.newPage();
  let submitted = null;
  await page.route('https://job-boards.greenhouse.io/**', (r) => {
    const u = new URL(r.request().url());
    if (/confirmation/.test(u.pathname)) {
      submitted = Object.fromEntries(u.searchParams);
      return r.fulfill({ contentType: 'text/html', body: '<h1>Thank you for applying!</h1>' });
    }
    return r.fulfill({ contentType: 'text/html', body: html });
  });
  await page.goto(URL_);
  await page.addScriptTag({ path: path.join(ROOT, 'src/shared/rules.js') });
  await page.addScriptTag({ path: path.join(ROOT, 'src/content/filler.js') });
  return { page, submitted: () => submitted };
}

const run = (page, over = {}) =>
  page.evaluate((p) => globalThis.JobAssistFiller.run(p), Object.assign({
    jobId: 'j1', profile: PROFILE, answers: ANSWERS, resume: RESUME,
    autoSubmit: { jobTitle: 'Account Executive, SMB', company: 'Acme Security', declarations: ['privacy'] },
  }, over));

(async () => {
  const browser = await chromium.launch();
  const results = [];
  const check = async (name, html, fn) => {
    const ctx = await open(browser, html);
    try {
      await fn(ctx);
      results.push(['ok', name]);
    } catch (err) {
      results.push(['FAIL', name, err.message.split('\n')[0]]);
    } finally {
      await ctx.page.close();
    }
  };
  const blocked = async ({ page, submitted }, re, over) => {
    const r = await run(page, over);
    assert.equal(r.ok, true);
    assert.equal(r.autoSubmit.ok, false, 'should not submit');
    assert.match(r.autoSubmit.problems.join(' | '), re);
    await page.waitForTimeout(400);
    assert.equal(submitted(), null, 'nothing was submitted');
    assert.equal(page.url(), URL_);
  };

  await check('all checks pass: submits, records exactly what was sent', BASE_HTML, async ({ page, submitted }) => {
    const r = await run(page);
    assert.equal(r.autoSubmit.ok, true, JSON.stringify(r.autoSubmit));
    await page.waitForURL(/confirmation/);
    const sent = submitted();
    assert.equal(sent.first_name, 'Alex');
    assert.equal(sent.email, 'alex.jobs@example.com');
    assert.equal(sent.auth, '1');
    assert.equal(sent.sponsor, 'no');
    assert.equal(sent.privacy, 'on');
    assert.equal(sent.gender, '', 'demographics never answered');
    assert.equal(sent.veteran, '');
    const f = Object.fromEntries(r.autoSubmit.fields.map((x) => [x.label, x.value]));
    assert.equal(f['Resume/CV *'], RESUME.fileName);
    assert.equal(f['Are you legally authorized to work in the United States? *'], 'Yes');
    assert.equal(f['Will you now or in the future require visa sponsorship? *'], 'No');
    assert.deepEqual(r.autoSubmit.declarations, ['I have read and agree to the Applicant Privacy Notice']);
    assert.ok(r.autoSubmit.leftBlank.includes('Gender'));
    assert.ok(r.autoSubmit.leftBlank.includes('How did you hear about us?'));
  });

  await check('unknown required question → not submitted', BASE_HTML.replace('<!--EXTRA-->', '<label for="why">Why do you want to work here? *</label><textarea id="why" name="why" required></textarea>'), (c) =>
    blocked(c, /Required question it can’t answer reliably: “Why do you want to work here\? \*”/));

  await check('declaration not approved → not submitted', BASE_HTML, (c) =>
    blocked(c, /Declaration you haven’t approved: “I have read and agree to the Applicant Privacy Notice”/, { autoSubmit: { jobTitle: 'Account Executive, SMB', declarations: [] } }));

  await check('other required declaration (arbitration) → not submitted', BASE_HTML.replace('<!--EXTRA-->', '<label><input type="checkbox" name="arb" required> I agree to binding arbitration and certify my answers are true</label>'), (c) =>
    blocked(c, /Declaration you haven’t approved: “I agree to binding arbitration/, { autoSubmit: { jobTitle: 'Account Executive, SMB', declarations: ['privacy', 'accuracy'] } }));

  await check('optional marketing opt-in is left unticked and doesn’t block', BASE_HTML.replace('<!--EXTRA-->', '<label><input type="checkbox" id="mk" name="mk"> Send me marketing emails about future opportunities</label>'), async ({ page }) => {
    const r = await run(page);
    assert.equal(r.autoSubmit.ok, true, JSON.stringify(r.autoSubmit));
    await page.waitForURL(/confirmation/);
  });

  await check('conflicting prefilled information → not submitted', BASE_HTML.replace('id="email" name="email" type="email" required', 'id="email" name="email" type="email" required value="someone.else@example.com"'), (c) =>
    blocked(c, /Conflicting information: “Email \*” already says “someone\.else@example\.com”/));

  await check('wrong position on the page → not submitted', BASE_HTML, (c) =>
    blocked(c, /doesn’t look like the “Solutions Engineer” application/, { autoSubmit: { jobTitle: 'Solutions Engineer', declarations: ['privacy'] } }));

  await check('no resume chosen → not submitted', BASE_HTML, (c) => blocked(c, /Resume on the form \(“none”\)/, { resume: null }));

  await check('saved answer doesn’t match the choices → not submitted', BASE_HTML.replace('<!--EXTRA-->', '<label for="rel">Are you willing to relocate? *</label><select id="rel" name="rel" required><option value="">Select...</option><option>Open to it</option><option>Not at this time</option></select>'), (c) =>
    blocked(c, /Required question it can’t answer reliably: “Are you willing to relocate\? \*” \(saved answer doesn’t match the choices\)/));

  await check('more than one Submit button → not submitted', BASE_HTML.replace('<!--EXTRA-->', '<button type="submit" name="draft">Save draft</button>'), (c) => blocked(c, /More than one possible Submit button/));

  await check('missing required profile value → not submitted', BASE_HTML, (c) =>
    blocked(c, /Required question it can’t answer reliably: “Last Name \*” \(no profile value\)/, { profile: Object.assign({}, PROFILE, { lastName: '' }) }));

  await check('visible CAPTCHA → stops before filling anything', BASE_HTML.replace('<!--EXTRA-->', '<div class="g-recaptcha" style="width:304px;height:78px"></div>'), async ({ page, submitted }) => {
    const r = await run(page);
    assert.equal(r.ok, false);
    assert.match(r.reasons.join(' '), /CAPTCHA/);
    assert.equal(await page.$eval('#first_name', (el) => el.value), '');
    assert.equal(submitted(), null);
  });

  await browser.close();
  for (const r of results) console.log(r.join('  '));
  if (results.some((r) => r[0] === 'FAIL')) process.exit(1);
})();
