/*
 * Runs the real filler against fixture pages in Chromium.
 *   npm run test:e2e
 * Uses Playwright from devDependencies (or a global install via NODE_PATH).
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');

const PROFILE = {
  firstName: 'Bruno', lastName: 'Example', email: 'bruno@example.com', phone: '555-0100',
  linkedinUrl: 'https://www.linkedin.com/in/bruno-example', city: 'Boston', country: 'United States',
  fullName: 'Bruno Example', currentCompany: 'Sample Medical Co', githubUrl: 'https://github.com/bruno',
  websiteUrl: 'https://bruno.example', addressLine1: '1 Main St', state: 'Florida', postalCode: '33602',
};
const RESUME = { label: 'PM — Oct 2026', fileName: 'bruno-resume.pdf', type: 'application/pdf', dataUrl: 'data:application/pdf;base64,JVBERi0xLjQK' };

async function load(page, url, html) {
  await page.route(url, (route) => route.fulfill({ contentType: 'text/html', body: html }));
  await page.goto(url);
  await page.addScriptTag({ path: path.join(ROOT, 'src/shared/rules.js') });
  await page.addScriptTag({ path: path.join(ROOT, 'src/content/filler.js') });
}

const run = (page) => page.evaluate((p) => globalThis.JobAssistFiller.run(p), { jobId: 'j1', profile: PROFILE, resume: RESUME });

(async () => {
  const browser = await chromium.launch();
  const results = [];
  const check = async (name, fn) => {
    const page = await browser.newPage();
    try {
      await fn(page);
      results.push(['ok', name]);
    } catch (err) {
      results.push(['FAIL', name, err.message]);
    } finally {
      await page.close();
    }
  };

  await check('fills routine fields, leaves the rest, never submits', async (page) => {
    await load(page, 'https://jobs.example.com/apply', fixture('application.html'));
    const r = await run(page);
    assert.equal(r.ok, true, JSON.stringify(r));
    const v = (sel) => page.$eval(sel, (el) => el.value);
    assert.equal(await v('#fn'), 'Bruno');
    assert.equal(await v('#ln'), 'Example');
    assert.equal(await v('#em'), 'bruno@example.com');
    assert.equal(await v('#ph'), '555-0100');
    assert.equal(await v('#li'), PROFILE.linkedinUrl);
    assert.equal(await v('#country'), 'US');
    assert.equal(await v('#city'), 'Typed by Bruno', 'must not overwrite Bruno');
    assert.equal(await v('#why'), '');
    assert.equal(await v('#sal'), '');
    assert.equal(await v('#gender'), '');
    assert.equal(await page.$eval('#consent', (el) => el.checked), false);
    assert.equal(await page.$$eval('input[name=auth]:checked', (els) => els.length), 0);
    assert.equal(await page.$eval('#cv', (el) => el.files[0] && el.files[0].name), 'bruno-resume.pdf');
    assert.equal(await page.$eval('#cl', (el) => el.files.length), 0);
    assert.deepEqual(r.uploaded, ['bruno-resume.pdf (PM — Oct 2026)']);
    assert.ok(r.alreadyAnswered.includes('City'));
    const needs = r.needsBruno.map((n) => n.label).join(' | ');
    for (const s of ['Cover Letter', 'Why do you want', 'Desired salary', 'Gender', 'privacy policy']) assert.ok(needs.includes(s), 'expected ' + s + ' in ' + needs);
    assert.equal(r.needsBruno.filter((n) => /legally authorized/.test(n.label)).length, 1, needs);
    await page.waitForTimeout(600);
    assert.equal(await page.evaluate(() => window.__submitted), 0, 'assistant must never submit');
    assert.equal(page.url(), 'https://jobs.example.com/apply');
  });

  await check('pauses when a CAPTCHA appears after filling', async (page) => {
    await load(page, 'https://jobs.example.com/apply', fixture('application.html'));
    await run(page);
    await page.evaluate(() => {
      const f = document.createElement('iframe');
      f.src = 'https://www.google.com/recaptcha/api2/bframe?k=x';
      f.width = 400; f.height = 580;
      document.body.append(f);
    });
    await page.waitForTimeout(800);
    const text = await page.evaluate(() => document.getElementById('job-assist-banner').shadowRoot.textContent);
    assert.match(text, /manual action required/i);
    assert.match(text, /CAPTCHA/);
  });

  for (const [name, file, re] of [
    ['stops on visible CAPTCHA', 'captcha.html', /CAPTCHA/],
    ['stops on security message', 'security.html', /unusual activity|identity/],
    ['stops on sign-in prompt', 'signin.html', /Sign-in/],
    ['stops on unsupported page', 'noform.html', /Unsupported page/],
  ]) {
    await check(name, async (page) => {
      await load(page, 'https://jobs.example.com/x', fixture(file));
      const r = await run(page);
      assert.equal(r.ok, false);
      assert.match(r.reasons.join(' '), re);
      assert.equal(await page.$$eval('input', (els) => els.filter((e) => e.value).length), 0, 'nothing filled');
    });
  }

  await check('refuses to fill on LinkedIn', async (page) => {
    await load(page, 'https://www.linkedin.com/jobs/view/123/apply', fixture('application.html'));
    const r = await run(page);
    assert.equal(r.ok, false);
    assert.match(r.reasons.join(' '), /LinkedIn/);
    assert.equal(await page.$eval('#fn', (el) => el.value), '');
  });

  await check('Lever-style form: full name, links, hidden resume input, invisible hCaptcha', async (page) => {
    await load(page, 'https://jobs.lever.co/acme/123/apply', fixture('lever.html'));
    const r = await run(page);
    assert.equal(r.ok, true, JSON.stringify(r));
    const v = (n) => page.$eval(`[name="${n}"]`, (el) => el.value);
    assert.equal(await v('name'), 'Bruno Example');
    assert.equal(await v('email'), 'bruno@example.com');
    assert.equal(await v('phone'), '555-0100');
    assert.equal(await v('org'), 'Sample Medical Co');
    assert.equal(await v('urls[LinkedIn]'), PROFILE.linkedinUrl);
    assert.equal(await v('urls[GitHub]'), PROFILE.githubUrl);
    assert.equal(await v('urls[Portfolio]'), PROFILE.websiteUrl);
    assert.equal(await v('comments'), '');
    assert.equal(await v('eeo[veteran]'), '');
    assert.equal(await v('source'), '', 'hidden field untouched');
    assert.equal(await v('disabled_field'), '', 'disabled field untouched');
    assert.equal(await page.$eval('#resume-upload-input', (el) => el.files.length), 1);
    await page.click('#btn-submit');
    assert.equal(page.url(), 'https://jobs.lever.co/acme/123/apply');
  });

  await check('Workday-style form: aria-labelledby labels, state select, questions left alone', async (page) => {
    await load(page, 'https://acme.wd1.myworkdayjobs.com/en-US/External/job/apply', fixture('workday.html'));
    const r = await run(page);
    assert.equal(r.ok, true, JSON.stringify(r));
    const v = (sel) => page.$eval(sel, (el) => el.value);
    assert.equal(await v('[data-automation-id="legalNameSection_firstName"]'), 'Bruno');
    assert.equal(await v('[data-automation-id="legalNameSection_lastName"]'), 'Example');
    assert.equal(await v('[data-automation-id="addressSection_addressLine1"]'), '1 Main St');
    assert.equal(await v('[data-automation-id="addressSection_city"]'), 'Boston');
    assert.equal(await v('#st'), 'FL');
    assert.equal(await v('[data-automation-id="addressSection_postalCode"]'), '33602');
    assert.equal(await v('[data-automation-id="phone-number"]'), '555-0100');
    assert.equal(await v('#ptype'), '', 'phone device type is a choice for Bruno');
    assert.equal(await v('[data-automation-id="sourcePrompt"]'), '');
    assert.equal(await v('#prev'), '');
  });

  await check('React-style controlled inputs register the filled value', async (page) => {
    await load(page, 'https://jobs.example.com/react', fixture('react.html'));
    const r = await run(page);
    assert.equal(r.ok, true);
    assert.deepEqual(await page.evaluate(() => window.state), { fn: 'Bruno', em: 'bruno@example.com' });
  });

  await check('edge cases: unmatched option, read-only, placeholder label, unlabelled, hidden password', async (page) => {
    await load(page, 'https://jobs.example.com/opts', fixture('options.html'));
    const r = await run(page);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(await page.$eval('#c', (el) => el.value), '', 'no guessing USA vs United States');
    assert.ok(r.needsBruno.some((n) => /No option matches/.test(n.reason)));
    assert.equal(await page.$eval('#ro', (el) => el.value), '', 'read-only untouched');
    assert.equal(await page.$eval('#ph', (el) => el.value), '555-0100');
    assert.equal(await page.$eval('#nolabel', (el) => el.value), '');
  });

  await check('form embedded from another site is reported as unsupported', async (page) => {
    await load(page, 'https://www.acme.com/careers/ae', fixture('embed.html'));
    const r = await run(page);
    assert.equal(r.ok, false);
    assert.match(r.reasons.join(' '), /embedded frame/);
  });

  await check('form inside shadow DOM: stops safely instead of guessing', async (page) => {
    await load(page, 'https://jobs.example.com/shadow', fixture('shadow.html'));
    const r = await run(page);
    assert.equal(r.ok, false);
    assert.match(r.reasons.join(' '), /no application form/);
  });

  await check('400-field form completes quickly and fills only routine fields', async (page) => {
    const labels = ['First name', 'Email', 'Why this role?', 'Desired salary', 'City', 'Gender', 'Tell us about a deal you lost', 'Phone'];
    let html = '<!doctype html><html><body><form>';
    for (let i = 0; i < 400; i++) html += `<label for="f${i}">${labels[i % labels.length]}</label><input id="f${i}">`;
    html += '</form></body></html>';
    await load(page, 'https://jobs.example.com/big', html);
    const t0 = Date.now();
    const r = await run(page);
    const ms = Date.now() - t0;
    assert.equal(r.ok, true);
    assert.equal(r.filled.length, 200, 'first name, email, city, phone x 50');
    assert.equal(r.needsBruno.length, 200);
    assert.ok(ms < 5000, 'took ' + ms + 'ms');
    console.log('    400-field form filled in ' + ms + 'ms');
  });

  await check('running Fill twice does not duplicate uploads or overwrite', async (page) => {
    await load(page, 'https://jobs.example.com/apply', fixture('application.html'));
    await run(page);
    await page.fill('#fn', 'Bruno-edited');
    const r2 = await run(page);
    assert.equal(r2.ok, true);
    assert.equal(await page.$eval('#fn', (el) => el.value), 'Bruno-edited');
    assert.deepEqual(r2.filled, []);
    assert.deepEqual(r2.uploaded, []);
  });

  await browser.close();
  for (const r of results) console.log(r.join('  '));
  if (results.some((r) => r[0] === 'FAIL')) process.exit(1);
})();
