# Upgrade progress

Working notes so work can resume after an interruption.

## Done (v0.2.0)
- [x] Reviewed reference repos (see "Reference review" in README)
- [x] Job discovery (Greenhouse / Lever / Ashby / Workday), filters, scoring, duplicates, closed postings, retries, daily search — `src/shared/discovery.js`
- [x] Resume tailoring (.docx) with fabrication guard and optional Claude API — `src/shared/tailor.js`, `src/shared/ai.js`
- [x] People to contact and message drafts, duplicate contacts — `src/shared/contacts.js`
- [x] Saved screening answers, closed-posting and confirmation-page detection — `rules.js`, `filler.js`, `background.js`
- [x] Side panel: three search settings, results, tailoring, answers, API key, job boards, people
- [x] Tests: `npm run test:all` (unit, filler pages, extension, full workflow) — all passing

## Possible next steps
- Confirm the default company job boards respond from a normal internet connection (couldn't be reached from the build environment)
- AI-written outreach messages (templates are used today)
