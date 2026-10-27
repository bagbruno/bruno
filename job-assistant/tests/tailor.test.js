const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const T = require('../src/shared/tailor.js');
const AI = require('../src/shared/ai.js');

const SAMPLE = fs.readFileSync(path.join(__dirname, 'fixtures', 'resume-sample.docx'));
const JOB = {
  title: 'Account Executive, SMB', company: 'Acme Security',
  description: 'Sell our cybersecurity platform. Outbound prospecting, pipeline generation, negotiation and closing. Splunk experience a plus. 5+ years of SaaS sales.',
};

test('zip round trip keeps every file byte-for-byte', async () => {
  const entries = await T.readZip(SAMPLE);
  assert.ok(entries.some((e) => e.name === 'word/document.xml'));
  const again = await T.readZip(T.writeZip(entries));
  assert.deepEqual(again.map((e) => e.name), entries.map((e) => e.name));
  for (let i = 0; i < entries.length; i++) assert.deepEqual(Buffer.from(again[i].data), Buffer.from(entries[i].data));
  assert.equal(T.crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
});

test('rejects files that are not Word documents', async () => {
  await assert.rejects(T.readDocx(new TextEncoder().encode('%PDF-1.4 not a docx')), /Not a valid/);
});

test('finds headline, summary and skills', async () => {
  const p = await T.readDocx(SAMPLE);
  const s = T.locateSections(p.paragraphs);
  assert.match(s.headline.text, /^ACCOUNT EXECUTIVE/);
  assert.match(s.summary.text, /^Full-cycle B2B/);
  assert.match(s.skills.text, /^Full-Cycle Sales/);
});

test('fabrication guard catches new numbers, years, tools; allows rewording', () => {
  const orig = 'Generated approximately $1.5M in sales, ranked #1 for two consecutive years, closed deals up to $200K. Salesforce, HubSpot. Outbound prospecting.';
  assert.deepEqual(T.fabricationCheck(orig, 'Closed deals up to $200K and generated about $1.5M through outbound prospecting in Salesforce.'), []);
  assert.ok(T.fabricationCheck(orig, 'Generated $2M in sales.').some((p) => /\$2M/.test(p)));
  assert.ok(T.fabricationCheck(orig, 'Brings 5+ years of SaaS sales.').some((p) => /years/.test(p)));
  assert.ok(T.fabricationCheck(orig, 'Expert in Splunk and Salesforce.', 'Splunk experience a plus').some((p) => /Splunk/.test(p)));
  assert.ok(T.fabricationCheck(orig, 'Holds a CISSP certification.').some((p) => /CISSP/.test(p)));
});

test('without AI: only the skills order changes, experience untouched', async () => {
  const r = await T.tailorDocx(SAMPLE, JOB, { keywords: ['negotiation', 'closing', 'pipeline generation'] });
  assert.deepEqual(r.changes, ['skills']);
  const before = await T.readDocx(SAMPLE);
  const after = await T.readDocx(r.bytes);
  const s = T.locateSections(after.paragraphs);
  assert.match(s.skills.text, /^Pipeline Generation  •  Negotiation  •  Closing/);
  // Every non-skills paragraph is identical.
  const diff = before.paragraphs.filter((p, i) => p.text !== after.paragraphs[i].text).map((p) => p.text.slice(0, 20));
  assert.deepEqual(diff, ['Full-Cycle Sales  • ']);
  // Same set of skills, just reordered.
  const set = (t) => t.split('•').map((x) => x.trim()).sort();
  assert.deepEqual(set(s.skills.text), set(T.locateSections(before.paragraphs).skills.text));
});

test('with AI: honest rewrite applied, fabricated parts rejected', async () => {
  const ai = async ({ user, schema }) => {
    assert.match(user, /<resume>/);
    assert.ok(schema.required.includes('missingQualifications'));
    return {
      headline: 'ACCOUNT EXECUTIVE  |  NEW LOGO ACQUISITION  |  B2B SALES',
      summary: 'Full-cycle B2B sales professional with 5+ years in cybersecurity who generated $3M.',
      skills: ['Outbound Prospecting', 'Pipeline Generation', 'Negotiation', 'Closing', 'Salesforce'],
      fitScore: 72, matchedQualifications: ['outbound prospecting'], missingQualifications: ['5+ years of SaaS sales', 'Splunk'],
    };
  };
  const r = await T.tailorDocx(SAMPLE, JOB, { ai });
  assert.equal(r.usedAI, true);
  assert.deepEqual(r.changes.sort(), ['headline', 'skills']);
  assert.equal(r.rejected.length, 1);
  assert.match(r.rejected[0], /^summary:.*(years|\$3M)/);
  assert.deepEqual(r.missing, ['5+ years of SaaS sales', 'Splunk']);
  const s = T.locateSections((await T.readDocx(r.bytes)).paragraphs);
  assert.match(s.headline.text, /NEW LOGO ACQUISITION/);
  assert.match(s.summary.text, /^Full-cycle B2B sales professional who generated approximately \$1.5M/, 'summary kept original');
});

test('tailored file opens in a real word processor', { skip: !hasSoffice() }, async () => {
  const r = await T.tailorDocx(SAMPLE, JOB, { keywords: ['closing'] });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tailor-'));
  fs.writeFileSync(path.join(dir, 'out.docx'), r.bytes);
  execFileSync('soffice', ['--headless', '--convert-to', 'txt:Text', '--outdir', dir, path.join(dir, 'out.docx')], { stdio: 'ignore', timeout: 60000 });
  const txt = fs.readFileSync(path.join(dir, 'out.txt'), 'utf8');
  assert.match(txt, /^Closing  [•-]  Full-Cycle Sales/m);
  assert.match(txt, /SAMPLE MEDICAL CO/);
});
function hasSoffice() {
  try {
    execFileSync('soffice', ['--version'], { stdio: 'ignore' });
    return true;
  } catch (_) {
    return false;
  }
}

test('AI client: headers, schema, refusals, bad keys, retries', async () => {
  let seen;
  const ok = async (url, init) => {
    seen = { url, init, body: JSON.parse(init.body) };
    return { ok: true, status: 200, json: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: '{"a":1}' }] }) };
  };
  assert.deepEqual(await AI.askJson({ apiKey: 'k', system: 's', user: 'u', schema: { type: 'object' }, fetchFn: ok }), { a: 1 });
  assert.equal(seen.init.headers['anthropic-dangerous-direct-browser-access'], 'true');
  assert.equal(seen.body.model, 'claude-opus-5-5');
  assert.equal(seen.body.output_config.format.type, 'json_schema');
  await assert.rejects(AI.askJson({ apiKey: '', user: 'u', schema: {} }), /No Claude API key/);
  const refuse = async () => ({ ok: true, status: 200, json: async () => ({ stop_reason: 'refusal', content: [] }) });
  await assert.rejects(AI.askJson({ apiKey: 'k', user: 'u', schema: {}, fetchFn: refuse }), /declined/);
  const bad = async () => ({ ok: false, status: 401, json: async () => ({}) });
  await assert.rejects(AI.askJson({ apiKey: 'k', user: 'u', schema: {}, fetchFn: bad }), /rejected/);
  let n = 0;
  const flaky = async (...a) => (++n === 1 ? { ok: false, status: 529, json: async () => ({}) } : ok(...a));
  assert.deepEqual(await AI.askJson({ apiKey: 'k', user: 'u', schema: {}, fetchFn: flaky }), { a: 1 });
  assert.equal(n, 2);
});
