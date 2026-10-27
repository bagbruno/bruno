# Upgrade progress

Working notes so work can resume after an interruption.

## Done
- [x] Reviewed reference repos (see "Reference review" in README)
- [x] `src/shared/discovery.js`: Greenhouse / Lever / Ashby / Workday feeds, salary parsing (unknown when missing), title / location / salary filters, 0–100 score, duplicate + already-applied detection, closed-posting detection, retries, search links for LinkedIn / Indeed / Glassdoor — `tests/discovery.test.js`
- [x] `src/shared/tailor.js`: .docx read/write, headline/summary/skills tailoring, fabrication guard — `tests/tailor.test.js`
- [x] `src/shared/ai.js`: optional Claude API client (Bruno's key)
- [x] `src/shared/contacts.js`: recruiter / manager / teammate searches, message drafts, duplicate contacts — `tests/contacts.test.js`
- [x] rules.js: saved screening answers, closed postings, confirmation pages, tab-title parsing
- [x] filler.js: fills saved answers, reports closed postings, detects confirmation after Bruno's Submit
- [x] background.js: optional daily search, confirmation-page check after submit

## Remaining
- [ ] manifest: alarms permission + job-board/API host permissions
- [ ] panel: search card (location, min salary, positions), Find jobs, results with score/salary, tailor resume, saved answers, API key, sources, people/contacts
- [ ] extension e2e: discovery → tailor → fill (with answers) → confirmation; contacts dedupe; narrow-width layout
- [ ] README update, full test run, commit
