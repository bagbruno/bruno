const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../src/shared/contacts.js');

const JOB = { id: 'j1', title: 'Account Executive - Enterprise (East Florida)', company: 'Arctic Wolf' };

test('three role-specific LinkedIn searches per job', () => {
  const s = C.peopleSearches(JOB);
  assert.deepEqual(s.map((x) => x.role), ['recruiter', 'manager', 'teammate']);
  assert.equal(s[0].query, 'Arctic Wolf recruiter OR talent acquisition');
  assert.match(s[1].query, /^Arctic Wolf sales director/);
  assert.equal(s[2].query, 'Arctic Wolf Account Executive');
  for (const x of s) assert.ok(x.url.startsWith('https://www.linkedin.com/search/results/people/?keywords='));
  assert.match(C.leaderQuery('Senior Software Engineer'), /engineering/);
  assert.equal(C.leaderQuery('Chief Wizard'), 'hiring manager');
});

test('profile URLs are normalised; non-profiles rejected', () => {
  const a = C.normalizeProfileUrl('https://linkedin.com/in/Jane-Doe-123/?originalSubdomain=us');
  assert.equal(a, 'https://www.linkedin.com/in/jane-doe-123');
  assert.equal(C.normalizeProfileUrl('https://www.linkedin.com/in/jane-doe-123'), a);
  assert.equal(C.normalizeProfileUrl('https://www.linkedin.com/company/arctic-wolf'), '');
  assert.equal(C.normalizeProfileUrl('https://evil.example/in/jane'), '');
  assert.equal(C.normalizeProfileUrl('jane'), '');
});

test('duplicate contacts are detected across jobs', () => {
  let r = C.addContact([], { name: 'Jane Doe', profileUrl: 'https://www.linkedin.com/in/jane-doe', role: 'recruiter', job: JOB });
  assert.equal(r.duplicate, null);
  r.contacts[0].status = 'sent_by_bruno';
  const r2 = C.addContact(r.contacts, { name: 'Jane D.', profileUrl: 'linkedin.com/in/JANE-DOE'.replace(/^/, 'https://'), role: 'recruiter', job: { id: 'j2', company: 'Arctic Wolf' } });
  assert.ok(r2.duplicate);
  assert.equal(r2.duplicate.status, 'sent_by_bruno');
  assert.equal(r2.contacts.length, 1);
  assert.deepEqual(r2.contacts[0].jobIds, ['j1', 'j2']);
  assert.match(C.addContact([], { name: '', profileUrl: 'x', role: 'recruiter', job: JOB }).error, /name/);
  assert.match(C.addContact([], { name: 'X', profileUrl: 'https://example.com', role: 'recruiter', job: JOB }).error, /LinkedIn profile/);
});

test('messages are specific, personal, and the note fits LinkedIn’s limit', () => {
  for (const role of ['recruiter', 'manager', 'teammate']) {
    const m = C.draftMessages({ name: 'Jane Doe', role }, JOB, true);
    assert.ok(m.connection.length <= C.CONNECTION_LIMIT, role + ' ' + m.connection.length);
    assert.match(m.connection, /^Hi Jane, I just applied for the Account Executive role at Arctic Wolf/);
    assert.match(m.followUp, /Arctic Wolf/);
  }
  const long = C.draftMessages({ name: 'Bartholomew', role: 'teammate' }, { title: 'Senior Enterprise Account Executive for Strategic Federal Healthcare and Life Sciences Accounts', company: 'An Extremely Long Company Name International Holdings' }, false);
  assert.ok(long.connection.length <= C.CONNECTION_LIMIT);
  assert.match(C.draftMessages({ name: '', role: 'teammate' }, JOB, true).connection, /^Hi there,/);
});
