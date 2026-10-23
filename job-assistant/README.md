# Job Application Assistant (user-controlled)

A Chrome extension that helps Bruno fill out job applications **he has chosen**, inside **his own signed-in Chrome**, one application at a time. It's a browser assistant, not a bot: it does nothing until Bruno clicks a button, it never clicks Submit, and it never sends a connection request or message.

> **Disclosure.** This tool doesn't guarantee that any website allows its use, and it isn't built to be "undetectable". Websites can change their terms and page layouts at any time, and field detection can be wrong. Bruno is responsible for checking every answer, for each final submission, and for every outreach message. Check the current terms of each site before using the assistant there.

## What it does

| Area | Behaviour |
|---|---|
| Session | Runs in Bruno's normal Chrome profile. No proxies, fingerprint masking, copied cookies, extra accounts, or anything that hides automation. |
| Job selection | Bruno adds jobs one at a time ("Add the job in my current tab", or by URL), or imports a CSV/JSON list he made (up to 200 rows). The assistant never searches or collects listings from job boards. |
| One at a time | Only one application can be open at a time. "Open application" opens that one tab. Opening a second job is refused until the first is submitted, skipped, or closed out. |
| Filling | Only on Bruno's click of **Fill routine fields**, only in that job's tab, and only after Bruno has verified his profile. Fills **empty** routine fields only: name, email, phone, address, city/state/ZIP/country, LinkedIn/GitHub/website, current company/title. Never overwrites what Bruno typed. Chrome asks Bruno to allow each site the first time. |
| Documents | Attaches the resume version Bruno chose for that job to a field clearly labelled resume/CV. Any other upload, such as a cover letter, is left for Bruno. |
| Left for Bruno | All free-text questions, yes/no and multiple-choice questions, consent and attestation boxes, and every sensitive topic: gender, race/ethnicity, veteran status, disability, date of birth/age, government IDs, salary, work authorization/visa, criminal/background, religion/marital status, signatures, passwords, banking. These are outlined in orange or red on the page. |
| Submit | **Never** clicked by the assistant. When Bruno clicks Submit himself, the click is logged, and Bruno confirms "Mark submitted" (two clicks) once the site shows a confirmation. |
| Outreach | LinkedIn connection notes and messages are saved as **drafts awaiting approval**. Even after approval, the assistant only opens the profile and copies the text. Bruno pastes it and clicks Send himself, then marks it sent. Nothing is ever typed or clicked on LinkedIn. |
| Safety stop | Before filling, and while watching the page afterwards, the assistant stops if it sees a visible CAPTCHA, a security or identity check, an "unusual activity", restricted-account, automation or rate-limit message, a sign-in or password prompt, a verification-code prompt, or a page with no recognisable form (including forms embedded from another site). It then labels the job **Manual action required**, pauses everything, and shows the reason. It never tries to solve or get around any of these. Bruno handles it, then clicks "I've handled it myself — resume". |
| Activity log | Every action is logged with the job, resume version, fields completed, fields left for Bruno, documents uploaded, and submission status. It can be exported as CSV or JSON. |

### Platform rules

| Site | Assistant behaviour | Why |
|---|---|---|
| LinkedIn | **Will not fill.** Use the Copy buttons in the Profile tab. Outreach is drafts only. | LinkedIn's User Agreement prohibits extensions and software that automate activity on LinkedIn. |
| Indeed | **Will not fill.** | Indeed's terms restrict automated tools. If the listing redirects to the employer's site, the assistant can help there. |
| Glassdoor | **Will not fill.** | Terms restrict automated tools. |
| Other sites (employer careers pages, Greenhouse, Lever, Workday, etc.) | Fills routine fields on Bruno's click, with a reminder that the site's own terms apply. | — |

When Bruno asks for something the assistant doesn't support (filling on a blocked platform, opening a second application, sending outreach), it shows a warning and does nothing. The table lives in `src/shared/rules.js` (`PLATFORM_RULES`). It's a conservative reading of current terms and should be reviewed as those terms change.

## Install (unpacked, for Bruno's own use)

1. Open `chrome://extensions` in Chrome (version 116 or later) and turn on **Developer mode**.
2. Click **Load unpacked** and choose the `job-assistant` folder.
3. Pin the extension and click its icon to open the side panel.
4. **Profile tab:** enter your details, save one or more resume versions, and click **I've checked these details are correct**. Editing any field clears this verification.
5. **Jobs tab:** add a job, choose its resume version, and click **Open application**. Click **Fill routine fields**, answer everything outlined on the page, review the whole form, and click Submit yourself.

All data (profile, resumes, jobs, drafts, log) is stored only in this Chrome profile (`chrome.storage.local`). Nothing is sent anywhere.

## Layout

```
manifest.json            MV3 manifest. Site access is optional and granted per site by Bruno.
src/shared/rules.js      Field classification, sensitive-topic list, safety checks, platform rules, import parsing
src/shared/store.js      Storage and activity-log helpers
src/content/filler.js    Injected into the active application tab only when Bruno clicks Fill
src/background.js        Opens the side panel; records safety stops and Bruno's submit clicks
src/panel/               Side panel UI
tests/                   Unit tests (rules) and browser tests (filler on sample pages)
```

## Tests

```sh
npm test            # unit tests for classification, safety checks, platform rules, import
npm install && npm run test:e2e   # runs the filler against fixture pages in Chromium (Playwright)
```

The browser tests check that routine fields are filled, Bruno's own input isn't overwritten, sensitive and unclear questions are left empty, the resume is attached, the form is never submitted, and the filler stops on CAPTCHAs, security messages, sign-in prompts, unsupported pages, and LinkedIn.
