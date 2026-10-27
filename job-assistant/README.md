# Job Application Assistant (user-controlled)

A Chrome extension that finds jobs matching Bruno's search, tailors his resume for each one, fills routine fields when he opens an application, and prepares outreach to the right people — all inside **his own signed-in Chrome**. It's a browser assistant, not a bot: it never clicks Submit, never sends a connection request or message, and stops at anything unusual.

## How Bruno uses it

1. **Profile tab (once):** contact details, your resume as a Word file, your answers to common screening questions, and optionally a Claude API key.
2. **Jobs tab:** set **Location**, **Minimum salary** and **Job positions**, click **Find jobs**. Matches appear best-first with salary (or "Salary unknown") and why they matched.
3. Click **Open application** on a job. The resume is tailored for it while the page loads.
4. Click **Fill routine fields**, answer anything outlined on the page, check everything, and click **Submit** on the site yourself. When the site shows its confirmation, the job is marked submitted.
5. Open **People to contact** on the job, pick the recruiter, hiring manager and a teammate from the LinkedIn searches, and paste their names and profile links. Messages are drafted in the **Outreach** tab for your approval; you send them on LinkedIn.

> **Disclosure.** This tool doesn't guarantee that any website allows its use, and it isn't built to be "undetectable". Websites can change their terms and page layouts at any time, and field detection can be wrong. Bruno is responsible for checking every answer, for each final submission, and for every outreach message. Check the current terms of each site before using the assistant there.

## What it does

| Area | Behaviour |
|---|---|
| Session | Runs in Bruno's normal Chrome profile. No proxies, fingerprint masking, copied cookies, extra accounts, or anything that hides automation. |
| Finding jobs | **Find jobs** checks company job boards on Greenhouse, Lever, Ashby and Workday through their public job listings, keeps jobs whose title, location and salary match the three settings, and scores them 0–100 (title 35, location 20, salary 20, overlap with the resume 25). A missing salary is shown as **Salary unknown** and is never guessed. Duplicates across boards and URLs are merged; jobs already applied to are never re-added; postings that disappear are marked **Posting closed**. Temporary errors are retried; a board that's gone is switched off and reported. An optional daily search runs in the background. For LinkedIn, Indeed and Glassdoor, the assistant opens a search with the same settings and Bruno saves jobs with "Add the job in my current tab" (it reads only the tab's title and link). A CSV/JSON list can also be imported. |
| Resume tailoring | Works on the Word (.docx) resume and changes only the headline, summary and skills. Experience, dates, education and achievements are never touched. With a Claude API key, Claude rewords those parts for the job; every rewrite is then checked and **rejected if it adds a number, a years-of-experience claim, or a skill or tool that isn't already on the resume**. Without a key, the skills are reordered to put the job's priorities first. The tailored file is saved with the job and attached when filling. |
| One at a time | Only one application can be open at a time. "Open application" opens that one tab. Opening a second job is refused until the first is submitted, skipped, or closed out. |
| Filling | Only on Bruno's click of **Fill routine fields**, only in that job's tab, and only after Bruno has verified his profile. Fills **empty** routine fields only: name, email, phone, address, city/state/ZIP/country, LinkedIn/GitHub/website, current company/title. Never overwrites what Bruno typed. Chrome asks Bruno to allow each site the first time. |
| Documents | Attaches the resume version Bruno chose for that job to a field clearly labelled resume/CV. Any other upload, such as a cover letter, is left for Bruno. |
| Screening answers | Work authorization, sponsorship, relocation, salary expectation, start date and "how did you hear about us" are filled **only with Bruno's own saved wording**, and outlined for him to check. If no answer is saved, or it doesn't match the choices, the question is left for him. |
| Left for Bruno | All other free-text and multiple-choice questions, consent and attestation boxes, and every sensitive topic: gender, race/ethnicity, veteran status, disability, date of birth/age, government IDs, criminal/background, religion/marital status, signatures, passwords, banking. These are outlined in orange or red on the page. |
| Submit | **Never** clicked by the assistant. When Bruno clicks Submit himself, the click is logged. The job is marked **submitted only when confirmed**: either the site shows an "application received" page, or Bruno confirms "Mark submitted" (two clicks). |
| People | For each job, three LinkedIn searches: recruiter/talent acquisition, the likely hiring manager or team leader, and someone in the same role. Bruno picks each person himself; LinkedIn doesn't allow automated people searches, so the assistant never reads LinkedIn pages. Each person gets a short, job-specific connection note (within LinkedIn's 200-character limit) and a follow-up message. Contacts are de-duplicated by profile link across all jobs, so nobody is messaged twice. |
| Outreach | LinkedIn connection notes and messages are saved as **drafts awaiting approval**. Even after approval, the assistant only opens the profile and copies the text. Bruno pastes it and clicks Send himself, then marks it sent. Nothing is ever typed or clicked on LinkedIn. |
| Safety stop | Before filling, and while watching the page afterwards, the assistant stops if it sees a visible CAPTCHA, a security or identity check, an "unusual activity", restricted-account, automation or rate-limit message, a sign-in or password prompt, a verification-code prompt, or a page with no recognisable form (including forms embedded from another site). It then labels the job **Manual action required**, pauses everything, and shows the reason. It never tries to solve or get around any of these. Bruno handles it, then clicks "I've handled it myself — resume". |
| Activity log | Every action is logged with the job, resume version, fields completed, fields left for Bruno, documents uploaded, and submission status. It can be exported as CSV or JSON. |

### Platform rules

| Site | Assistant behaviour | Why |
|---|---|---|
| LinkedIn | **Will not fill.** Use the Copy buttons in the Profile tab. Outreach is drafts only. | LinkedIn's User Agreement prohibits extensions and software that automate activity on LinkedIn. |
| Indeed | **Fills only after Bruno's OK** (two clicks in the side panel, withdrawable), then works like company sites: fill on his click, he submits. No searching or scraping of Indeed. | Indeed's terms restrict automated tools and it can restrict accounts; Bruno accepted that risk for his own account. |
| Glassdoor | **Same as Indeed.** | Same reason. |
| Other sites (employer careers pages, Greenhouse, Lever, Workday, etc.) | Fills routine fields on Bruno's click, with a reminder that the site's own terms apply. | — |

When Bruno asks for something the assistant doesn't support (filling on a blocked platform, opening a second application, sending outreach), it shows a warning and does nothing. The table lives in `src/shared/rules.js` (`PLATFORM_RULES`). It's a conservative reading of current terms and should be reviewed as those terms change.

## Needs setting up by Bruno

- **Claude API key (optional):** for AI tailoring. Create one at console.anthropic.com, paste it in Profile › AI resume tailoring. It's stored only in this Chrome profile and used only for tailoring calls to api.anthropic.com. Each tailored resume is one API call, billed to that key.
- **Word resume:** tailoring needs a .docx file. A PDF can still be attached, unchanged.
- **Workday boards:** Chrome asks once per company to allow reading its Workday job board.
- **Per-site permission:** the first time Fill is used on a site, Chrome asks to allow it.

## Limits

- LinkedIn, Indeed and Glassdoor have no public job feed and their terms prohibit scraping and automated applying, so jobs there are found with the search links. On Indeed and Glassdoor the assistant can fill forms once Bruno allows it; LinkedIn (Easy Apply included) is always filled by hand.
- Recruiter names can't be looked up automatically for the same reason; Bruno chooses the person from the LinkedIn search.
- Only company boards on Greenhouse, Lever, Ashby and Workday are searched automatically. Others (iCIMS, Taleo, SmartRecruiters, custom pages) can be added as single jobs and filled.
- The starting list of company boards was put together from search results; the boards themselves couldn't be reached from the build environment. Any that don't respond are switched off and reported in Profile › Job boards searched.
- Field detection and page checks can be wrong when a site changes. When in doubt the assistant stops rather than guesses.

## Reference review

Five open-source projects were reviewed. What was used and why:

| Project | License | Taken | Not taken |
|---|---|---|---|
| AbhishekMandapmalvi/AutoApply | MIT | Scoring weights (title/salary/location/keywords) and URL-based board detection, rewritten in JS with stricter salary parsing | Automated LinkedIn/Indeed applying |
| yunbinbae/auto-apply-template | none stated | The idea of an answer bank and "never lie on uncategorised fields" (no code copied) | Automated LinkedIn Easy Apply, ATS account creation |
| tmwclaxton/autoapplycv | PolyForm Noncommercial | Nothing (license restricts reuse) | — |
| wodsuz/EasyApplyJobsBot | CC BY-NC-SA | Nothing: it uses selenium-stealth to avoid bot detection | Stealth and LinkedIn automation |
| zeeshaniskhan5/job-auto-apply | none stated | Nothing: it hides automation and answers questions with made-up defaults (e.g. "authorized: Yes", "disability: No") | Stealth, invented answers |

## Install (unpacked, for Bruno's own use)

1. Open `chrome://extensions` in Chrome (version 116 or later) and turn on **Developer mode**.
2. Click **Load unpacked** and choose the `job-assistant` folder.
3. Pin the extension and click its icon to open the side panel.
4. **Profile tab:** enter your details, save one or more resume versions, and click **I've checked these details are correct**. Editing any field clears this verification.
5. **Jobs tab:** add a job, choose its resume version, and click **Open application**. Click **Fill routine fields**, answer everything outlined on the page, review the whole form, and click Submit yourself.

All data (profile, resumes, jobs, contacts, drafts, log) is stored only in this Chrome profile (`chrome.storage.local`). The only outside requests are to the job boards' public listing feeds and, if a key is saved, to the Claude API for tailoring.

## Layout

```
manifest.json            MV3 manifest. Site access is optional and granted per site by Bruno.
src/shared/rules.js      Field classification, saved answers, sensitive topics, safety and closed-posting checks, platform rules, import parsing
src/shared/discovery.js  Job-board feeds, salary parsing, filters, scoring, duplicates, search links
src/shared/tailor.js     .docx reading/writing, resume tailoring, fabrication guard
src/shared/ai.js         Optional Claude API client
src/shared/contacts.js   People searches, message drafts, duplicate contacts
src/shared/store.js      Storage and activity-log helpers
src/content/filler.js    Injected into the active application tab only when Bruno clicks Fill
src/background.js        Opens the side panel; records safety stops, Bruno's submit clicks and confirmations; optional daily search
src/panel/               Side panel UI
tests/                   Unit tests (rules) and browser tests (filler on sample pages)
```

## Tests

```sh
npm test                 # unit tests: rules, discovery, tailoring, AI client, contacts, hostile inputs
npm install
npm run test:e2e         # the filler on sample application pages in Chromium
npm run test:extension   # the original side-panel flow in the real extension
npm run test:workflow    # find → tailor → fill → submit → confirm, contacts, closed postings, phone width
```

No test contacts a real job board, the Claude API or LinkedIn; they use stand-in responses and a local web server.

The browser tests check that routine fields are filled, Bruno's own input isn't overwritten, sensitive and unclear questions are left empty, the resume is attached, the form is never submitted, and the filler stops on CAPTCHAs, security messages, sign-in prompts, unsupported pages, and LinkedIn. They also cover Lever- and Workday-style forms, React-style inputs, a 400-field form, embedded and shadow-DOM forms (both stop safely), and running Fill twice.

The extension test runs the whole flow in the real extension: profile verification, resume versions, Fill from the side panel, the one-application lock, logging Bruno's own Submit click, a CAPTCHA appearing mid-application (everything pauses), LinkedIn jobs (Fill disabled), list import, outreach approval and CSV export. It loads a copy of the extension with the local test site pre-allowed, because a test can't click Chrome's site-permission prompt.
