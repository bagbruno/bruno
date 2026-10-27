// Deliberately bad, odd or hostile inputs. Nothing here should throw or
// produce a wrong match.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const D = require('../src/shared/discovery.js');
const T = require('../src/shared/tailor.js');
const R = require('../src/shared/rules.js');
const C = require('../src/shared/contacts.js');

const respond = (body, status = 200) => async () => ({ ok: status < 400, status, headers: { get: () => null }, json: async () => body });
const SETTINGS = { location: 'Remote', minSalary: 80000, positions: 'Account Executive' };

test('job boards returning junk, nulls or the wrong shape', async () => {
  const cases = [
    [{ type: 'greenhouse', slug: 'x', company: 'X' }, { jobs: [{ id: 1 }, { id: 2, title: null, location: null, content: undefined }, null].filter(Boolean) }],
    [{ type: 'greenhouse', slug: 'x', company: 'X' }, { notJobs: true }],
    [{ type: 'lever', slug: 'x', company: 'X' }, { error: 'nope' }],
    [{ type: 'lever', slug: 'x', company: 'X' }, [{ id: 'a', text: 'Account Executive', categories: null, workplaceType: 'remote', hostedUrl: 'https://jobs.lever.co/x/a' }]],
    [{ type: 'ashby', slug: 'x', company: 'X' }, { jobs: [{ id: 'z', title: 'Account Executive', isRemote: true, jobUrl: 'https://jobs.ashbyhq.com/x/z', compensation: { summaryComponents: null } }] }],
  ];
  for (const [src, body] of cases) {
    const out = await D.runDiscovery({ settings: SETTINGS, sources: [src], jobs: [], resumeText: '', fetchFn: respond(body), delayMs: 0 });
    assert.equal(out.summary.errors.length, 0, JSON.stringify(out.summary.errors));
  }
});

test('huge descriptions are capped; salary stays unknown when absent', async () => {
  const big = 'Account executive prospecting. '.repeat(50000);
  const body = { jobs: [{ id: 9, title: 'Account Executive', location: { name: 'Remote - US' }, absolute_url: 'https://job-boards.greenhouse.io/x/jobs/9', content: big }] };
  const out = await D.runDiscovery({ settings: SETTINGS, sources: [{ type: 'greenhouse', slug: 'x', company: 'X' }], jobs: [], resumeText: 'prospecting', fetchFn: respond(body), delayMs: 0 });
  assert.equal(out.jobs.length, 1);
  assert.ok(out.jobs[0].description.length <= 20000);
  assert.equal(out.jobs[0].salary, null);
});

test('odd salaries and settings', () => {
  for (const s of ['$0', '$1,000,000,000', '$5/hr', 'USD', '$', '$-50,000', '1-2 years', '$100M ARR']) {
    const r = D.parseSalary(s);
    assert.ok(r === null || (r.max >= 15000 && r.max <= 3000000), s + ' → ' + JSON.stringify(r));
  }
  assert.doesNotThrow(() => D.parseLocationSetting('Tampa, FL; ; or '));
  assert.equal(D.matchLocation({ location: 'Tampa, FL' }, ' ; ').pass, true);
  assert.equal(D.matchTitle('C++ Account Executive (AE)', ['C++ (AE)', '[Account', '*']).pass, true);
  assert.equal(D.matchTitle('Nurse', ['', '   ']).pass, false);
  assert.equal(D.evaluate({ title: 'Account Executive', location: 'Remote', remote: true }, { positions: '', location: '', minSalary: '' }, '').pass, false, 'no positions means nothing matches');
});

test('hostile URLs and names', () => {
  assert.equal(D.detectSource('javascript:alert(1)'), null);
  assert.equal(D.detectSource('https://greenhouse.io.evil.example/x'), null);
  assert.equal(D.detectSource('https://evil.example/?u=https://jobs.lever.co/x'), null);
  assert.equal(C.normalizeProfileUrl('javascript:alert(1)//linkedin.com/in/x'), '');
  assert.equal(C.normalizeProfileUrl('https://linkedin.com.evil.example/in/x'), '');
  const m = C.draftMessages({ name: '<script>alert(1)</script>', role: 'recruiter' }, { title: 'AE', company: 'X' }, true);
  assert.ok(m.connection.length <= 200);
  assert.equal(R.platformFor('https://linkedin.com.evil.example/jobs').fill, 'review');
  assert.equal(R.platformFor('https://evil.example/linkedin.com').fill, 'review');
});

test('resume with no recognisable sections: unchanged, still a valid file', async () => {
  const sample = fs.readFileSync(path.join(__dirname, 'fixtures', 'resume-sample.docx'));
  const parsed = await T.readDocx(sample);
  // Strip all headings so nothing can be located.
  const xml = parsed.xml.replace(/PROFESSIONAL SUMMARY|SALES EXPERTISE|ACCOUNT EXECUTIVE {2}\| {2}B2B SALES {2}\| {2}NEW BUSINESS DEVELOPMENT/g, 'Notes');
  const bytes = T.writeZip(parsed.entries.map((e) => (e.name === 'word/document.xml' ? { name: e.name, data: new TextEncoder().encode(xml) } : e)));
  const r = await T.tailorDocx(bytes, { title: 'AE', company: 'X', description: 'closing closing' }, { keywords: ['closing'] });
  assert.deepEqual(r.changes, []);
  assert.ok((await T.readDocx(r.bytes)).paragraphs.length > 5);
  // Truncated / corrupt files are refused with a clear message.
  await assert.rejects(T.readDocx(sample.subarray(0, 2000)), /Not a valid|Corrupt/);
});

test('fabrication guard edge cases', () => {
  assert.deepEqual(T.fabricationCheck('', ''), []);
  assert.ok(T.fabricationCheck('', 'Closed $1M').length > 0);
  assert.deepEqual(T.fabricationCheck('Ranked #1 in revenue', 'Ranked #1 in revenue.'), []);
  assert.ok(T.fabricationCheck('Ranked #1', 'Ranked #1 with ten years of experience').some((p) => /years/.test(p)));
});
