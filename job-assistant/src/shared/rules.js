/*
 * Shared rules for the Job Application Assistant.
 *
 * Loaded three ways: as a classic script in the side panel, injected into a
 * page ahead of filler.js, and via require() from the Node unit tests.
 *
 * Everything that decides "may the assistant touch this?" lives here so it can
 * be reviewed and tested in one place.
 */
(function (root) {
  'use strict';

  // ---------------------------------------------------------------------------
  // Job statuses
  // ---------------------------------------------------------------------------
  const STATUS = {
    SELECTED: 'selected',
    IN_PROGRESS: 'in_progress',
    AWAITING_BRUNO: 'awaiting_bruno',
    SUBMITTED: 'submitted',
    MANUAL: 'manual_action_required',
    SKIPPED: 'skipped',
    CLOSED: 'closed',
  };

  const STATUS_LABEL = {
    selected: 'Selected',
    in_progress: 'In progress',
    awaiting_bruno: 'Ready for Bruno to review & submit',
    submitted: 'Submitted by Bruno',
    manual_action_required: 'Manual action required',
    skipped: 'Skipped',
    closed: 'Posting closed',
  };

  // ---------------------------------------------------------------------------
  // Platform policy
  //
  // "blocked": the assistant will not fill forms on this site. The platform's
  //            terms restrict third-party automation, so Bruno fills by hand
  //            (the side panel offers copy-to-clipboard buttons instead).
  // "consent": like "review", but only after Bruno has accepted, in the side
  //            panel, the risk that the site may restrict his account.
  // "review":  routine fields may be filled on Bruno's click; he reviews and
  //            submits himself.
  //
  // Terms change. This table reflects a conservative reading at the time of
  // writing and is NOT a guarantee of compliance. Bruno should check the
  // current terms of any site he uses.
  // ---------------------------------------------------------------------------
  const PLATFORM_RULES = [
    {
      id: 'linkedin',
      name: 'LinkedIn',
      hosts: ['linkedin.com'],
      fill: 'blocked',
      notice:
        "LinkedIn's User Agreement prohibits browser extensions and other software that automate activity on LinkedIn. " +
        'The assistant will not fill, click, or send anything on LinkedIn. Use the copy buttons in the Profile tab and complete the form yourself. ' +
        'Connection requests and messages are drafted in the Outreach queue for you to send by hand.',
    },
    {
      id: 'indeed',
      name: 'Indeed',
      hosts: ['indeed.com'],
      fill: 'consent',
      notice:
        "Indeed's terms restrict automated tools, and Indeed can restrict accounts it thinks use them. " +
        'With your OK, the assistant fills routine fields on Indeed application forms when you click Fill, like on company sites. ' +
        'It never searches Indeed for you or clicks Submit, and it stops at any security check.',
    },
    {
      id: 'glassdoor',
      name: 'Glassdoor',
      hosts: ['glassdoor.com'],
      fill: 'consent',
      notice:
        "Glassdoor's terms restrict automated tools, and Glassdoor can restrict accounts it thinks use them. " +
        'With your OK, the assistant fills routine fields on Glassdoor application forms when you click Fill. ' +
        'It never searches Glassdoor for you or clicks Submit, and it stops at any security check.',
    },
  ];

  const GENERIC_NOTICE =
    "Employer and applicant-tracking sites have their own terms, and some don't allow automated form filling. " +
    'The assistant fills routine fields only when you click Fill, never clicks Submit, and stops at anything unusual. ' +
    'You are responsible for reviewing every answer and for the final submission.';

  function hostOf(url) {
    try {
      return new URL(url).hostname.toLowerCase();
    } catch (_) {
      return '';
    }
  }

  function hostMatches(host, domain) {
    return host === domain || host.endsWith('.' + domain);
  }

  function platformFor(url) {
    const host = hostOf(url);
    for (const rule of PLATFORM_RULES) {
      if (rule.hosts.some((d) => hostMatches(host, d))) return rule;
    }
    return { id: 'other', name: host || 'Unknown site', hosts: [], fill: 'review', notice: GENERIC_NOTICE };
  }

  /** May the assistant fill forms on this platform, given Bruno's consents? */
  function canFill(platform, consents) {
    if (platform.fill === 'blocked') return false;
    if (platform.fill === 'consent') return !!(consents && consents[platform.id]);
    return true;
  }

  // Actions Bruno might ask for that the assistant deliberately does not do.
  const UNSUPPORTED_ACTIONS = {
    auto_submit: 'The assistant never clicks Submit. You make the final Submit click on every application.',
    auto_send_outreach:
      'The assistant never sends connection requests or messages. Approve a draft, then send it yourself on LinkedIn.',
    bulk_open: 'Only one application can be open at a time. Finish, skip, or release the current one first.',
    scrape: 'The assistant does not collect listings from job boards. Add jobs one at a time or import a list you made.',
    captcha: 'The assistant does not solve CAPTCHAs or security checks. Complete them yourself, then resume.',
  };

  // ---------------------------------------------------------------------------
  // Field classification
  // ---------------------------------------------------------------------------

  // Never filled, whatever the field looks like. Checked before anything else.
  const SENSITIVE_PATTERNS = [
    ['demographic', /\b(gender|sex|pronoun|race|racial|ethnic|ethnicity|hispanic|latino|sexual orientation|lgbt|transgender)\b/i],
    ['veteran / disability', /\b(veteran|military|disab|handicap|accommodation)/i],
    ['date of birth / age', /\b(date of birth|birth ?date|dob|birthday|your age|age range|over (the age of )?18|at least 18)\b/i],
    ['government ID', /\b(ssn|social security|national (id|insurance)|passport|driver'?s? licen[cs]e|tax (id|number)|sin number)\b/i],
    ['compensation', /\b(salary|compensation|pay (expectation|range|rate)|desired pay|expected pay|current pay|wage|hourly rate)\b/i],
    ['work authorization', /\b(visa|sponsor|work authori[sz]|authori[sz]ed to work|legally (authori[sz]ed|eligible)|citizenship|citizen|immigration|work permit|right to work)\b/i],
    ['background / legal', /\b(criminal|convict|felony|misdemeanou?r|arrest|background check|drug (test|screen))\b/i],
    ['personal', /\b(religio|marital|married|spouse|union member|political)\b/i],
    ['attestation / consent', /\b(signature|e-?sign|i (certify|agree|acknowledge|consent|attest)|terms (and|&) conditions|privacy (policy|notice)|consent)\b/i],
    ['credentials / financial', /\b(password|passcode|pin code|security question|bank|routing number|account number|credit card)\b/i],
  ];

  // Screening questions Bruno can answer once in the Profile tab. They're only
  // filled with his own saved wording, never guessed, and outlined for review.
  // Checked before the sensitive list so "Do you need visa sponsorship?" uses
  // his saved answer instead of always stopping. Demographic, disability,
  // veteran, criminal-history and attestation questions are never answered.
  const ANSWER_FIELDS = [
    { key: 'sponsorship', label: 'Need visa sponsorship?', pattern: /\bsponsor/i },
    { key: 'workAuthorization', label: 'Authorized to work in the US?', pattern: /\b(authori[sz]ed to work|legally (authori[sz]ed|eligible|able) to work|eligible to work|right to work|work authori[sz]ation)\b/i },
    { key: 'relocate', label: 'Willing to relocate?', pattern: /\brelocat/i },
    { key: 'salaryExpectation', label: 'Salary expectation', pattern: /\b((desired|expected|target|expectation|requirements?).{0,25}(salary|compensation|pay)|(salary|compensation|pay).{0,15}(expectation|requirement|desired|expected))/i },
    { key: 'startDate', label: 'Earliest start date / notice', pattern: /\b(start date|when can you start|available to start|availability|notice period)\b/i },
    { key: 'referralSource', label: 'How did you hear about us?', pattern: /\bhow did you (hear|find|learn)\b/i },
  ];
  const NEVER_ANSWER = /\b(gender|sex|race|ethnic|hispanic|veteran|disab|criminal|convict|felony|signature|i (certify|agree|attest))/i;

  // Profile keys the assistant is allowed to fill, and how to recognise them.
  // Order matters: more specific patterns first.
  const ROUTINE_FIELDS = [
    { key: 'email', label: 'Email', autocomplete: ['email'], types: ['email'], pattern: /\be-?mail\b/i },
    { key: 'phone', label: 'Phone', autocomplete: ['tel', 'tel-national'], types: ['tel'], pattern: /\b(phone|mobile|cell|telephone)\b/i },
    { key: 'linkedinUrl', label: 'LinkedIn URL', pattern: /\blinked ?in\b/i },
    { key: 'githubUrl', label: 'GitHub URL', pattern: /\bgit ?hub\b/i },
    { key: 'websiteUrl', label: 'Website / portfolio', autocomplete: ['url'], types: ['url'], pattern: /\b(website|portfolio|personal (site|url)|homepage)\b/i },
    { key: 'firstName', label: 'First name', autocomplete: ['given-name'], pattern: /\b(first|given|fore) ?name\b|\bfname\b/i },
    { key: 'lastName', label: 'Last name', autocomplete: ['family-name'], pattern: /\b(last|family|sur) ?name\b|\bsurname\b|\blname\b/i },
    { key: 'fullName', label: 'Full name', autocomplete: ['name'], pattern: /\b(full|legal) ?name\b|^\s*(your )?name\s*\*?\s*$/i },
    { key: 'addressLine1', label: 'Street address', autocomplete: ['address-line1', 'street-address'], pattern: /\b(street|address( line)? ?1?)\b/i },
    { key: 'city', label: 'City', autocomplete: ['address-level2'], pattern: /\b(city|town)\b/i },
    { key: 'state', label: 'State / province', autocomplete: ['address-level1'], pattern: /\b(state|province|region)\b/i },
    { key: 'postalCode', label: 'ZIP / postal code', autocomplete: ['postal-code'], pattern: /\b(zip|postal|post) ?code\b|\bzip\b/i },
    { key: 'country', label: 'Country', autocomplete: ['country', 'country-name'], pattern: /\bcountry\b/i },
    { key: 'currentCompany', label: 'Current company', autocomplete: ['organization'], pattern: /\b(current|present|most recent) (company|employer)\b/i },
    { key: 'currentTitle', label: 'Current title', autocomplete: ['organization-title'], pattern: /\b(current|present|most recent) (job )?(title|role|position)\b/i },
  ];

  const PROFILE_KEYS = ROUTINE_FIELDS.map((f) => ({ key: f.key, label: f.label }));

  // Labels longer than this read like questions, not routine fields.
  const MAX_ROUTINE_LABEL_LENGTH = 60;

  /**
   * Decide what to do with one form control.
   *
   * @param {object} d  descriptor collected from the page:
   *   { tag, type, label, name, id, placeholder, ariaLabel, autocomplete }
   * @returns {{kind: 'routine'|'resume'|'sensitive'|'unclear', key?: string, reason: string}}
   */
  function classifyField(d) {
    const tag = (d.tag || '').toLowerCase();
    const type = (d.type || '').toLowerCase();
    const autocomplete = (d.autocomplete || '').toLowerCase().trim();
    const label = norm(d.label);
    const text = norm([d.label, d.ariaLabel, d.placeholder, humanize(d.name), humanize(d.id)].filter(Boolean).join(' '));

    if (!NEVER_ANSWER.test(text) && type !== 'file' && type !== 'password') {
      for (const a of ANSWER_FIELDS) if (a.pattern.test(text)) return { kind: 'answer', key: a.key, reason: 'saved answer: ' + a.label };
    }
    for (const [reason, re] of SENSITIVE_PATTERNS) {
      if (re.test(text)) return { kind: 'sensitive', reason };
    }
    if (type === 'password') return { kind: 'sensitive', reason: 'credentials / financial' };

    if (type === 'file') {
      if (/\b(resume|résumé|cv|curriculum)\b/i.test(text) && !/\bcover\b/i.test(text)) {
        return { kind: 'resume', reason: 'resume upload' };
      }
      return { kind: 'unclear', reason: 'document upload other than resume' };
    }

    // Yes/no questions, consents and multi-choice answers need Bruno's judgement.
    if (type === 'checkbox' || type === 'radio') return { kind: 'unclear', reason: 'choice question' };
    // Free-text boxes are almost always questions ("Why do you want...").
    if (tag === 'textarea') return { kind: 'unclear', reason: 'free-text question' };
    if (label.length > MAX_ROUTINE_LABEL_LENGTH) return { kind: 'unclear', reason: 'long or question-style label' };
    if (/\?/.test(label)) return { kind: 'unclear', reason: 'question' };

    for (const f of ROUTINE_FIELDS) {
      if (f.autocomplete && f.autocomplete.includes(autocomplete)) return { kind: 'routine', key: f.key, reason: 'autocomplete=' + autocomplete };
    }
    for (const f of ROUTINE_FIELDS) {
      if (f.types && f.types.includes(type)) return { kind: 'routine', key: f.key, reason: 'type=' + type };
    }
    for (const f of ROUTINE_FIELDS) {
      if (f.pattern.test(text)) return { kind: 'routine', key: f.key, reason: 'label match' };
    }
    return { kind: 'unclear', reason: 'not a recognised routine field' };
  }

  function norm(s) {
    return String(s || '').replace(/\s+/g, ' ').trim();
  }

  // "first_name" / "firstName" -> "first name"
  function humanize(s) {
    return String(s || '')
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/[_\-.[\]]+/g, ' ');
  }

  // ---------------------------------------------------------------------------
  // Page safety checks
  // ---------------------------------------------------------------------------

  const CAPTCHA_SRC = /recaptcha|hcaptcha|challenges\.cloudflare\.com|turnstile|arkoselabs|funcaptcha|captcha/i;
  const CAPTCHA_SELECTORS = [
    '.g-recaptcha',
    '.h-captcha',
    '.cf-turnstile',
    '[data-sitekey]',
    '#captcha',
    '[id*="captcha" i]',
    '[class*="captcha" i]',
  ];

  const SECURITY_TEXT = [
    ['unusual activity', /\bunusual (activity|sign[- ]?in|login|traffic)\b/i],
    ['suspicious activity', /\bsuspicious (activity|login|sign[- ]?in)\b/i],
    ['identity verification', /\b(verify (it'?s|that it'?s|that you'?re|you'?re) (really )?you|verify your identity|confirm your identity|identity verification)\b/i],
    ['security check', /\b(security (check|verification|challenge)|quick security check)\b/i],
    ['bot check', /\b(are you a (robot|human)|confirm you'?re (not a robot|human)|i'?m not a robot|prove you'?re human)\b/i],
    ['account restricted', /\b(account (has been |is |was )?(restricted|suspended|locked|limited|temporarily (restricted|blocked)))\b/i],
    ['automation warning', /\b(detected|suspect(ed)?) (automated|bot|automation)\b|\bautomated (activity|behaviou?r|requests) (has been |was |were )?detected\b/i],
    ['rate limit', /\b(too many requests|rate limit(ed)?|you'?ve reached the limit)\b/i],
    ['access denied', /\b(access denied|you have been blocked|temporarily blocked|request (was )?blocked)\b/i],
    ['verification code', /\b(enter the (code|pin) (we|that we) (sent|texted|emailed)|two[- ]?(step|factor) (verification|authentication)|one[- ]?time (code|passcode))\b/i],
  ];

  // Posting no longer open.
  const EXPIRED_TEXT = /\b(no longer (accepting applications|available|open|active)|(job|position|posting|role) (is|has been) (closed|filled|removed)|this job (has )?expired|job not found|page (you('re| are) looking for )?(could not be|can'?t be|was not) found|(error )?404 (error|not found|page)|error 404)\b/i;

  // The site's own "application received" page.
  const CONFIRMATION_TEXT = /\b(thank(s| you) for (applying|your application|your interest)|application (has been |was )?(received|submitted)|we('ve| have) received your application|your application (is|has been) (complete|submitted|on its way))\b/i;

  function isConfirmation(text) {
    return CONFIRMATION_TEXT.test(String(text || '').replace(/[\u2018\u2019]/g, "'"));
  }

  /**
   * Look at a snapshot of the page and decide whether the assistant must stop.
   *
   * @param {object} snap
   *   { url, text, iframeSrcs: string[], captchaElementCount, visiblePasswordFields,
   *     fillableFieldCount, crossOriginFormFrames }
   * @returns {{stop: boolean, reasons: string[]}}
   */
  function assessPage(snap, consents) {
    const reasons = [];
    const platform = platformFor(snap.url || '');
    if (platform.fill === 'blocked') reasons.push('Platform rules: ' + platform.name + ' does not allow automated form filling');
    else if (!canFill(platform, consents)) reasons.push('Platform rules: filling on ' + platform.name + ' needs your OK in the side panel first');

    if ((snap.iframeSrcs || []).some((s) => CAPTCHA_SRC.test(s)) || (snap.captchaElementCount || 0) > 0) {
      reasons.push('CAPTCHA detected');
    }
    const text = String(snap.text || '').replace(/[\u2018\u2019]/g, "'");
    for (const [label, re] of SECURITY_TEXT) {
      if (re.test(text)) reasons.push('Security or account message: ' + label);
    }
    const expired = EXPIRED_TEXT.test(text);
    if (expired) reasons.push('Posting closed: the page says this job is no longer open');
    if ((snap.visiblePasswordFields || 0) > 0) reasons.push('Sign-in or verification prompt detected');
    if ((snap.fillableFieldCount || 0) === 0) {
      reasons.push(
        (snap.crossOriginFormFrames || 0) > 0
          ? 'Unsupported page: the form is inside an embedded frame from another site'
          : 'Unsupported page: no application form found'
      );
    }
    return { stop: reasons.length > 0, reasons, expired };
  }

  // ---------------------------------------------------------------------------
  // Import parsing (jobs Bruno selected elsewhere, e.g. a spreadsheet)
  // ---------------------------------------------------------------------------

  const MAX_IMPORT = 200;

  function parseCsv(text) {
    const rows = [];
    let row = [];
    let field = '';
    let quoted = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (quoted) {
        if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
        else if (c === '"') quoted = false;
        else field += c;
      } else if (c === '"') quoted = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(field); rows.push(row); row = []; field = '';
      } else field += c;
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows.filter((r) => r.some((v) => v.trim() !== ''));
  }

  /**
   * Turn an imported file into job records. Accepts JSON (array of objects) or
   * CSV with a header row containing at least "url". Invalid rows are reported,
   * not silently dropped.
   */
  function parseJobImport(text, filename) {
    let records;
    const errors = [];
    if (/\.json$/i.test(filename || '') || /^\s*[[{]/.test(text)) {
      const data = JSON.parse(text);
      records = Array.isArray(data) ? data : [data];
    } else {
      const rows = parseCsv(text);
      if (!rows.length) return { jobs: [], errors: ['File is empty'] };
      const header = rows[0].map((h) => h.trim().toLowerCase());
      records = rows.slice(1).map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] || '').trim()])));
    }
    if (records.length > MAX_IMPORT) {
      errors.push('Only the first ' + MAX_IMPORT + ' rows were imported. Import a shorter list of jobs you have chosen.');
      records = records.slice(0, MAX_IMPORT);
    }
    const jobs = [];
    records.forEach((r, i) => {
      const url = String(r.url || r.link || '').trim();
      if (!/^https?:\/\//i.test(url)) {
        errors.push('Row ' + (i + 1) + ': missing or invalid url');
        return;
      }
      jobs.push({
        url,
        title: String(r.title || r.job || r.position || '').trim(),
        company: String(r.company || r.employer || '').trim(),
        notes: String(r.notes || '').trim(),
      });
    });
    return { jobs, errors };
  }

  /**
   * Job title and company from a browser tab title, e.g.
   * "Account Executive | KnowBe4 | LinkedIn" or
   * "Account Executive - KnowBe4 - Clearwater, FL - Indeed.com".
   * Uses only the tab title, never the page contents.
   */
  function jobFromTabTitle(title) {
    const t = String(title || '').replace(/^\(\d+\)\s*/, '').replace(/^(job application for|apply for|apply to|application for)\s+/i, '').trim();
    const parts = t.split(/\s+[|–—-]\s+/).map((s) => s.trim()).filter(Boolean);
    const site = /^(linkedin|indeed(\.com)?|glassdoor|careers?|jobs?)$/i;
    while (parts.length > 1 && site.test(parts[parts.length - 1])) parts.pop();
    if (parts.length >= 2) {
      const location = parts.length >= 3 && /,\s*[A-Z]{2}\b|remote/i.test(parts[2]) ? parts[2] : '';
      return { title: parts[0], company: parts[1].replace(/^at\s+/i, ''), location };
    }
    const at = t.match(/^(.*?)\s+at\s+(.+)$/i);
    return at ? { title: at[1], company: at[2], location: '' } : { title: t, company: '', location: '' };
  }

  const api = {
    STATUS,
    STATUS_LABEL,
    PLATFORM_RULES,
    UNSUPPORTED_ACTIONS,
    ROUTINE_FIELDS,
    PROFILE_KEYS,
    ANSWER_FIELDS,
    isConfirmation,
    jobFromTabTitle,
    CAPTCHA_SRC,
    CAPTCHA_SELECTORS,
    platformFor,
    canFill,
    hostOf,
    classifyField,
    assessPage,
    parseCsv,
    parseJobImport,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.JobAssistRules = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
