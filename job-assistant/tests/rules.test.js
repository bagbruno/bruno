const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../src/shared/rules.js');

const field = (o) => R.classifyField(Object.assign({ tag: 'input', type: 'text' }, o));

test('routine fields map to profile keys', () => {
  assert.deepEqual(field({ label: 'First Name' }).key, 'firstName');
  assert.deepEqual(field({ label: 'Last name *' }).key, 'lastName');
  assert.deepEqual(field({ name: 'last_name' }).key, 'lastName');
  assert.deepEqual(field({ type: 'email', label: 'Contact' }).key, 'email');
  assert.deepEqual(field({ label: 'Phone' }).key, 'phone');
  assert.deepEqual(field({ label: 'LinkedIn Profile' }).key, 'linkedinUrl');
  assert.deepEqual(field({ autocomplete: 'postal-code' }).key, 'postalCode');
  assert.deepEqual(field({ tag: 'select', type: 'select', label: 'Country' }).key, 'country');
  assert.deepEqual(field({ label: 'Name' }).key, 'fullName');
});

test('sensitive fields are never routine', () => {
  for (const label of [
    'Gender', 'Race / Ethnicity', 'Are you a protected veteran?', 'Disability status', 'Date of birth',
    'Have you ever been convicted of a felony?', 'Citizenship',
    'Social Security Number', 'Signature', 'I agree to the privacy policy', 'Password',
    'Email me about salary updates', // mixed: sensitive wins over routine
  ]) {
    assert.equal(field({ label }).kind, 'sensitive', label);
  }
  assert.equal(field({ type: 'password', label: 'Create account' }).kind, 'sensitive');
});

test('questions and free text are left for Bruno', () => {
  assert.equal(field({ tag: 'textarea', label: 'Cover letter' }).kind, 'unclear');
  assert.equal(field({ label: 'Why do you want to work at our company?' }).kind, 'unclear');
  assert.equal(field({ type: 'checkbox', label: 'Email' }).kind, 'unclear');
  assert.equal(field({ type: 'radio', label: 'City' }).kind, 'unclear');
  assert.equal(field({ label: 'Please describe a project where you had to manage a difficult city stakeholder' }).kind, 'unclear');
});

test('file uploads: resume only', () => {
  assert.equal(field({ type: 'file', label: 'Resume/CV' }).kind, 'resume');
  assert.equal(field({ type: 'file', label: 'Cover Letter' }).kind, 'unclear');
  assert.equal(field({ type: 'file', label: 'Resume or cover letter' }).kind, 'unclear');
});

test('platform rules', () => {
  assert.equal(R.platformFor('https://www.linkedin.com/jobs/view/1').fill, 'blocked');
  assert.equal(R.platformFor('https://uk.indeed.com/viewjob?jk=1').fill, 'blocked');
  assert.equal(R.platformFor('https://boards.greenhouse.io/acme/jobs/1').fill, 'review');
  assert.equal(R.platformFor('https://notlinkedin.com/x').fill, 'review');
});

const base = { url: 'https://jobs.example.com/apply', text: '', iframeSrcs: [], captchaElementCount: 0, visiblePasswordFields: 0, fillableFieldCount: 5 };

test('assessPage passes a normal form', () => {
  assert.deepEqual(R.assessPage(base), { stop: false, reasons: [], expired: false });
});

test('assessPage stops on captcha, security text, sign-in, unsupported, blocked platform', () => {
  const cases = [
    { iframeSrcs: ['https://www.google.com/recaptcha/api2/bframe'] },
    { captchaElementCount: 1 },
    { text: "We've noticed unusual activity on your account" },
    { text: 'Please verify it’s you' },
    { text: "Let's do a quick security check" },
    { text: 'Your account has been restricted' },
    { text: 'We detected automated behavior from your browser' },
    { text: 'Too many requests' },
    { text: 'Enter the code we sent to your phone' },
    { visiblePasswordFields: 1 },
    { fillableFieldCount: 0 },
    { url: 'https://www.linkedin.com/jobs/view/123' },
  ];
  for (const c of cases) {
    const r = R.assessPage(Object.assign({}, base, c));
    assert.equal(r.stop, true, JSON.stringify(c));
  }
});

test('assessPage ignores ordinary job-description wording', () => {
  for (const text of ['Experience with automated testing tools', 'Try again later if the upload fails', 'You will perform code reviews']) {
    assert.equal(R.assessPage(Object.assign({}, base, { text })).stop, false, text);
  }
});

test('import parsing requires urls and caps size', () => {
  const csv = 'Title,Company,URL\n"PM, Growth",Acme,https://acme.com/jobs/1\nNo url,Foo,\n';
  const out = R.parseJobImport(csv, 'jobs.csv');
  assert.equal(out.jobs.length, 1);
  assert.equal(out.jobs[0].title, 'PM, Growth');
  assert.equal(out.errors.length, 1);

  const json = JSON.stringify([{ url: 'https://a.com/1', title: 'A' }, { url: 'ftp://x' }]);
  assert.equal(R.parseJobImport(json, 'jobs.json').jobs.length, 1);

  const many = 'url\n' + Array.from({ length: 250 }, (_, i) => 'https://a.com/' + i).join('\n');
  const capped = R.parseJobImport(many, 'many.csv');
  assert.equal(capped.jobs.length, 200);
  assert.match(capped.errors[0], /first 200/);
});

test('screening questions use saved answers; demographics and attestations never do', () => {
  const cases = {
    'Desired salary': 'salaryExpectation', 'What are your salary expectations?': 'salaryExpectation',
    'Will you now or in the future require visa sponsorship?': 'sponsorship',
    'Are you legally authorized to work in the United States?': 'workAuthorization',
    'Are you willing to relocate?': 'relocate', 'When can you start?': 'startDate', 'How did you hear about us?': 'referralSource',
  };
  for (const [label, key] of Object.entries(cases)) {
    const c = field({ label });
    assert.equal(c.kind, 'answer', label);
    assert.equal(c.key, key, label);
  }
  for (const label of ['Are you a protected veteran?', 'Disability status', 'Gender', 'I certify that the information is accurate', 'Have you been convicted of a crime? (relocation not required)']) {
    assert.notEqual(field({ label }).kind, 'answer', label);
  }
  assert.equal(field({ type: 'file', label: 'Relocation document' }).kind, 'unclear');
});

test('closed postings and confirmation pages are recognised', () => {
  for (const text of ['This job is no longer accepting applications', 'Sorry, this position has been filled', 'The page you are looking for could not be found']) {
    const r = R.assessPage(Object.assign({}, base, { text }));
    assert.equal(r.expired, true, text);
    assert.equal(r.stop, true);
  }
  assert.equal(R.assessPage(Object.assign({}, base, { text: 'Call our Atlanta office at 404-555-0100' })).expired, false);
  assert.equal(R.isConfirmation('Thank you for applying to Acme!'), true);
  assert.equal(R.isConfirmation('We’ve received your application'), true);
  assert.equal(R.isConfirmation('Submit your application below'), false);
});

test('job details from a tab title only', () => {
  assert.deepEqual(R.jobFromTabTitle('(3) Account Executive | KnowBe4 | LinkedIn'), { title: 'Account Executive', company: 'KnowBe4', location: '' });
  assert.deepEqual(R.jobFromTabTitle('Account Executive - KnowBe4 - Clearwater, FL - Indeed.com'), { title: 'Account Executive', company: 'KnowBe4', location: 'Clearwater, FL' });
  assert.deepEqual(R.jobFromTabTitle('Job Application for Account Executive at ThreatLocker'), { title: 'Account Executive', company: 'ThreatLocker', location: '' });
  assert.equal(R.jobFromTabTitle('').title, '');
});
