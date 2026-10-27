# Upgrade progress

Working notes so work can resume after an interruption.

## Done (v0.2.0)
- [x] Reviewed reference repos (see "Reference review" in README)
- [x] Job discovery (Greenhouse / Lever / Ashby / Workday), filters, scoring, duplicates, closed postings, retries, daily search — `src/shared/discovery.js`
- [x] Resume tailoring (.docx) with fabrication guard and optional Claude API — `src/shared/tailor.js`, `src/shared/ai.js`
- [x] People to contact and message drafts, duplicate contacts — `src/shared/contacts.js`
- [x] Saved screening answers, closed-posting and confirmation-page detection
- [x] Side panel: three search settings, results, tailoring, answers, API key, job boards, people, setup file
- [x] Indeed / Glassdoor filling after Bruno's explicit OK (LinkedIn stays blocked)

## v0.3.0 — automatic submission (in progress)
- [x] rules.js: `AUTO_SUBMIT_HOSTS`, `autoSubmitPolicy`, `DECLARATIONS`, `declarationFor`, wider confirmation text
- [x] filler.js: per-field tracking, `verifyAndSubmit` (position, resume, required answers, conflicts, declarations, form validity, single Submit button); click deferred 300 ms so the report reaches the panel
- [x] background.js: `auto-submitted` message sets `submitObservedAt` / `submittedBy`
- [x] panel: Profile › Automatic submission approval (fingerprint of profile + answers + main resume; changes cancel it), Jobs › Auto-apply runner (score ≥ 60, 20 s spacing, 25/day, confirmation required, held-back and unconfirmed outcomes, safety stop)
- [x] tests/autosubmit.e2e.js — 12/12 passing
- [ ] tests/autoapply.e2e.js — runner verified working (1 confirmed, 1 held back, 1 unconfirmed); last fix keeps the "Done:" summary visible; rerun to confirm all steps pass
- [ ] Run full suite (`npm run test:all`), commit, push, rebuild zip
