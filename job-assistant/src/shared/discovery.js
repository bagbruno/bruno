/*
 * Job discovery: finds jobs on company career boards through the boards' own
 * public job-listing feeds, then filters, scores and de-duplicates them.
 *
 * Sources and why they're used:
 *   Greenhouse  boards-api.greenhouse.io  (official public Job Board API)
 *   Lever       api.lever.co/v0/postings  (official public Postings API)
 *   Ashby       api.ashbyhq.com/posting-api (official public Job Postings API)
 *   Workday     the JSON feed each company's own Workday careers site uses
 *
 * LinkedIn, Indeed and Glassdoor don't offer a public jobs feed and their
 * terms prohibit scraping, so for those the assistant builds a search link
 * from Bruno's settings and he saves jobs he likes with "Add current tab".
 *
 * Scoring weights follow AutoApply's job filter (MIT, github.com/
 * AbhishekMandapmalvi/AutoApply core/filter.py): title 35, salary 20,
 * location 20, keywords 25. Rewritten here; salary parsing is stricter.
 *
 * Loaded as a classic script (side panel, background worker) or require()d by
 * the Node tests.
 */
(function (root) {
  'use strict';

  // ---------------------------------------------------------------------------
  // Text helpers
  // ---------------------------------------------------------------------------

  const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', hellip: '…' };

  function decodeEntities(s) {
    return String(s || '').replace(/&(#x?[0-9a-f]+|[a-z0-9]+);/gi, (m, e) => {
      if (e[0] === '#') {
        const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : m;
      }
      return ENTITIES[e.toLowerCase()] !== undefined ? ENTITIES[e.toLowerCase()] : m;
    });
  }

  function htmlToText(html) {
    // Greenhouse returns HTML that is itself entity-encoded, so decode first.
    let s = decodeEntities(html);
    s = s.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ');
    s = s.replace(/<\s*(br|\/p|\/div|\/li|\/h\d|li)[^>]*>/gi, '\n');
    s = s.replace(/<[^>]+>/g, ' ');
    s = decodeEntities(s);
    return s.replace(/[ \t ]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
  }

  function norm(s) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  }

  // ---------------------------------------------------------------------------
  // Locations
  // ---------------------------------------------------------------------------

  const STATES = {
    AL: 'alabama', AK: 'alaska', AZ: 'arizona', AR: 'arkansas', CA: 'california', CO: 'colorado', CT: 'connecticut', DE: 'delaware',
    FL: 'florida', GA: 'georgia', HI: 'hawaii', ID: 'idaho', IL: 'illinois', IN: 'indiana', IA: 'iowa', KS: 'kansas', KY: 'kentucky',
    LA: 'louisiana', ME: 'maine', MD: 'maryland', MA: 'massachusetts', MI: 'michigan', MN: 'minnesota', MS: 'mississippi', MO: 'missouri',
    MT: 'montana', NE: 'nebraska', NV: 'nevada', NH: 'new hampshire', NJ: 'new jersey', NM: 'new mexico', NY: 'new york',
    NC: 'north carolina', ND: 'north dakota', OH: 'ohio', OK: 'oklahoma', OR: 'oregon', PA: 'pennsylvania', RI: 'rhode island',
    SC: 'south carolina', SD: 'south dakota', TN: 'tennessee', TX: 'texas', UT: 'utah', VT: 'vermont', VA: 'virginia', WA: 'washington',
    WV: 'west virginia', WI: 'wisconsin', WY: 'wyoming', DC: 'district of columbia',
  };
  const STATE_NAMES = Object.fromEntries(Object.entries(STATES).map(([a, n]) => [n, a]));
  const NON_US = /\b(canada|uk|united kingdom|england|london|ireland|dublin|germany|berlin|france|paris|spain|netherlands|amsterdam|india|bangalore|bengaluru|singapore|australia|sydney|japan|tokyo|brazil|mexico|israel|tel aviv|emea|apac|latam|europe|poland|romania|portugal|toronto|vancouver|ontario)\b/i;

  /** States mentioned in a location string, as 2-letter codes. */
  function statesIn(text) {
    const out = new Set();
    const t = String(text || '');
    for (const m of t.matchAll(/(?:^|[\s,(/-])([A-Z]{2})(?=$|[\s,)/-])/g)) if (STATES[m[1]]) out.add(m[1]);
    const low = t.toLowerCase();
    for (const [name, abbr] of Object.entries(STATE_NAMES)) if (new RegExp('\\b' + name + '\\b').test(low)) out.add(abbr);
    return out;
  }

  function isRemoteText(text) {
    return /\b(remote|work from home|wfh|anywhere|distributed)\b/i.test(text || '');
  }

  function isUS(text) {
    const t = String(text || '');
    if (NON_US.test(t) && !/\b(us|usa|united states)\b/i.test(t)) return false;
    return /\b(us|usa|u\.s\.|united states|america)\b/i.test(t) || statesIn(t).size > 0 || isRemoteText(t);
  }

  /**
   * Turn Bruno's one location box into a matcher.
   * "Remote", "Nationwide" / "United States", "Tampa, FL", "Florida".
   * Several can be separated by ";" or " or ".
   */
  function parseLocationSetting(text) {
    const parts = String(text || '').split(/;|\bor\b|\//i).map((s) => s.trim()).filter(Boolean);
    if (!parts.length) return [{ kind: 'any' }];
    return parts.map((p) => {
      if (/^(remote|anywhere|work from home)$/i.test(p)) return { kind: 'remote' };
      if (/^(nationwide|us|usa|united states|anywhere in (the )?us)$/i.test(p)) return { kind: 'nationwide' };
      const [cityPart, statePart] = p.split(',').map((s) => s.trim());
      const st = statesIn(statePart || cityPart);
      const state = st.size ? [...st][0] : null;
      if (!statePart && state && (STATES[cityPart.toUpperCase()] || STATE_NAMES[cityPart.toLowerCase()])) return { kind: 'state', state };
      return { kind: 'city', city: norm(cityPart), state };
    });
  }

  /** @returns {{pass: boolean, points: number, why: string}} points out of 20 */
  function matchLocation(job, locSetting) {
    const where = [job.location, job.remote ? 'remote' : ''].join(' ');
    const remote = job.remote || isRemoteText(job.location);
    let best = { pass: false, points: 0, why: 'location outside your search' };
    for (const want of parseLocationSetting(locSetting)) {
      let r = null;
      if (want.kind === 'any') r = { pass: true, points: 20, why: 'any location' };
      else if (want.kind === 'remote') r = remote && isUS(where) ? { pass: true, points: 20, why: 'remote' } : null;
      else if (want.kind === 'nationwide') r = isUS(where) ? { pass: true, points: 20, why: 'in the US' } : null;
      else if (want.kind === 'state') r = statesIn(where).has(want.state) ? { pass: true, points: 20, why: 'in ' + want.state } : remote && isUS(where) ? { pass: true, points: 15, why: 'remote' } : null;
      else if (want.kind === 'city') {
        if (norm(where).includes(want.city)) r = { pass: true, points: 20, why: 'in ' + want.city };
        else if (remote && isUS(where)) r = { pass: true, points: 15, why: 'remote' };
        else if (want.state && statesIn(where).has(want.state)) r = { pass: true, points: 10, why: 'same state (' + want.state + ')' };
      }
      if (r && r.points > best.points) best = r;
    }
    return best;
  }

  // ---------------------------------------------------------------------------
  // Salary
  // ---------------------------------------------------------------------------

  const HOURS_PER_YEAR = 2080;

  function money(numStr, suffix) {
    let n = parseFloat(String(numStr).replace(/,/g, ''));
    if (!Number.isFinite(n)) return null;
    if (/^k$/i.test(suffix || '')) n *= 1000;
    if (/^m$/i.test(suffix || '')) n *= 1000000;
    return n;
  }

  /**
   * Find a pay range in free text. Returns null when there isn't one: a
   * missing salary stays unknown and is never guessed.
   * @returns {{min:number, max:number, period:'year', currency:string, ote:boolean, text:string}|null}
   */
  function parseSalary(text) {
    const t = String(text || '').replace(/–|—/g, '-');
    const cur = '(?:\\$|USD\\s?|US\\$)';
    const amt = '(\\d{1,3}(?:,\\d{3})+|\\d+(?:\\.\\d+)?)\\s?([kKmM])?';
    const range = new RegExp(cur + '\\s?' + amt + '\\s*(?:-|to)\\s*' + cur + '?\\s?' + amt + '(?:\\s?(?:USD))?\\s*(\\/\\s?(?:hr|hour)|per hour|hourly|an hour|\\/\\s?(?:yr|year)|per year|annually|a year)?', 'i');
    const single = new RegExp(cur + '\\s?' + amt + '\\s*(\\/\\s?(?:hr|hour)|per hour|hourly|an hour|\\/\\s?(?:yr|year)|per year|annually|a year)?', 'i');
    // "91,000 to 194,000 USD annually": currency written after the numbers.
    const suffixed = new RegExp(amt + '\\s*(?:-|to)\\s*' + amt + '\\s?(?:USD|US dollars|dollars)\\s*(per year|annually|a year|\\/\\s?(?:yr|year))?', 'i');
    let min, max, unit, raw;
    let m = t.match(range) || t.match(suffixed);
    if (m) {
      min = money(m[1], m[2]);
      max = money(m[3], m[4] || m[2]);
      // "$120-150K": the K on the high end applies to both.
      if (!m[2] && m[4] && min < 1000) min = money(m[1], m[4]);
      unit = m[5];
      raw = m[0];
    } else {
      m = t.match(single);
      if (!m) return null;
      min = max = money(m[1], m[2]);
      unit = m[3];
      raw = m[0];
    }
    if (!min || !max) return null;
    if (min > max) [min, max] = [max, min];
    const hourly = /hr|hour/i.test(unit || '') || (max < 500 && !/k/i.test(raw));
    if (hourly) {
      if (max < 7 || max > 500) return null;
      min *= HOURS_PER_YEAR;
      max *= HOURS_PER_YEAR;
    }
    if (max < 15000 || max > 3000000) return null;
    const before = t.slice(Math.max(0, t.indexOf(raw) - 60), t.indexOf(raw) + raw.length + 40);
    return { min: Math.round(min), max: Math.round(max), period: 'year', currency: 'USD', ote: /\bOTE\b|on[- ]target/i.test(before), text: raw.trim() };
  }

  function formatSalary(s) {
    if (!s) return 'Salary unknown';
    const k = (n) => '$' + Math.round(n / 1000) + 'K';
    return (s.min === s.max ? k(s.min) : k(s.min) + '–' + k(s.max)) + (s.ote ? ' OTE' : '');
  }

  /** @returns {{pass:boolean, points:number, why:string}} points out of 20 */
  function matchSalary(job, minSalary) {
    const floor = Number(minSalary) || 0;
    if (!floor) return { pass: true, points: 20, why: 'no minimum set' };
    if (!job.salary) return { pass: true, points: 10, why: 'salary unknown' };
    if (job.salary.max >= floor) return { pass: true, points: 20, why: 'pays up to ' + formatSalary({ min: job.salary.max, max: job.salary.max }) };
    return { pass: false, points: 0, why: 'pays at most ' + formatSalary({ min: job.salary.max, max: job.salary.max }) + ', below your minimum' };
  }

  // ---------------------------------------------------------------------------
  // Titles
  // ---------------------------------------------------------------------------

  const ABBREV = [
    [/\bae\b/g, 'account executive'], [/\bsr\b\.?/g, 'senior'], [/\bjr\b\.?/g, 'junior'], [/\bmgr\b/g, 'manager'],
    [/\bsdr\b/g, 'sales development representative'], [/\bbdr\b/g, 'business development representative'],
    [/\bam\b/g, 'account manager'], [/\bsmb\b/g, 'small business'], [/\bvp\b/g, 'vice president'],
  ];
  const SENIORITY = new Set(['senior', 'junior', 'lead', 'principal', 'staff', 'associate', 'i', 'ii', 'iii', 'iv', 'mid', 'level']);

  function normTitle(s) {
    let t = ' ' + norm(s) + ' ';
    for (const [re, rep] of ABBREV) t = t.replace(re, rep);
    return t.replace(/\s+/g, ' ').trim();
  }

  function parsePositions(text) {
    return String(text || '').split(/[,;\n]/).map((s) => s.trim()).filter(Boolean);
  }

  /** @returns {{pass:boolean, points:number, why:string}} points out of 35 */
  function matchTitle(title, positions) {
    const t = normTitle(title);
    const tw = new Set(t.split(' '));
    let best = { pass: false, points: 0, why: 'title doesn’t match your positions' };
    for (const p of positions) {
      const pn = normTitle(p);
      if (!pn) continue;
      const words = pn.split(' ').filter((w) => !SENIORITY.has(w));
      let r;
      if ((' ' + t + ' ').includes(' ' + pn + ' ')) r = { pass: true, points: 35, why: 'title matches “' + p + '”' };
      else if (words.length && words.every((w) => tw.has(w))) r = { pass: true, points: 28, why: 'title contains all of “' + p + '”' };
      else continue;
      if (r.points > best.points) best = r;
    }
    return best;
  }

  // ---------------------------------------------------------------------------
  // Keyword relevance against the resume
  // ---------------------------------------------------------------------------

  const STOP = new Set(('a an and are as at be by for from has have in is it its of on or our that the their this to we with you your will who what ' +
    'can all any more about into than other also more such they them us across within role team work working company job ' +
    'experience ability strong including help new year years plus well using use based must should may etc ideal candidate ' +
    'skills responsibilities requirements qualifications benefits opportunity position please apply equal employer').split(' '));

  function terms(text) {
    const words = norm(text).split(' ').filter((w) => w.length > 2 && !STOP.has(w) && !/^\d+$/.test(w));
    const counts = new Map();
    for (let i = 0; i < words.length; i++) {
      counts.set(words[i], (counts.get(words[i]) || 0) + 1);
      if (i + 1 < words.length) {
        const bi = words[i] + ' ' + words[i + 1];
        counts.set(bi, (counts.get(bi) || 0) + 1.5);
      }
    }
    return counts;
  }

  /** Top terms in a job description and which of them the resume covers. */
  function keywordMatch(description, resumeText, limit = 25) {
    const jd = [...terms(description).entries()].filter(([, c]) => c >= 2).sort((a, b) => b[1] - a[1]).slice(0, limit).map(([w]) => w);
    const res = ' ' + norm(resumeText) + ' ';
    const matched = jd.filter((w) => res.includes(' ' + w + ' '));
    const missing = jd.filter((w) => !matched.includes(w));
    return { keywords: jd, matched, missing, ratio: jd.length ? matched.length / jd.length : 0 };
  }

  // ---------------------------------------------------------------------------
  // Filter + score
  // ---------------------------------------------------------------------------

  /**
   * @param job       normalized job
   * @param settings  { location, minSalary, positions }
   * @param resumeText plain text of Bruno's main resume ('' if none)
   */
  function evaluate(job, settings, resumeText) {
    const title = matchTitle(job.title, parsePositions(settings.positions));
    const loc = matchLocation(job, settings.location);
    const pay = matchSalary(job, settings.minSalary);
    const kw = job.description && resumeText ? keywordMatch(job.description, resumeText) : null;
    const kwPoints = kw ? Math.round(kw.ratio * 25) : 12;
    const pass = title.pass && loc.pass && pay.pass;
    const reasons = [title.why, loc.why, pay.why, kw ? Math.round(kw.ratio * 100) + '% of key terms are on your resume' : 'no description to compare'];
    return {
      pass,
      score: title.points + loc.points + pay.points + kwPoints,
      reasons,
      skipReason: pass ? '' : [title, loc, pay].find((x) => !x.pass).why,
      keywords: kw,
    };
  }

  // ---------------------------------------------------------------------------
  // Duplicates
  // ---------------------------------------------------------------------------

  const COMPANY_SUFFIX = /\b(inc|llc|ltd|corp|corporation|co|company|gmbh|plc|holdings|technologies|technology|security|networks|software)\b/g;

  function dedupeKey(job) {
    const company = norm(job.company).replace(COMPANY_SUFFIX, '').replace(/\s+/g, '');
    const title = normTitle(job.title).replace(/\s+/g, '');
    const city = norm(String(job.location || '').split(/[,;(]/)[0]).replace(/\s+/g, '');
    return company + '|' + title + '|' + (job.remote ? 'remote' : city);
  }

  function canonicalUrl(url) {
    try {
      const u = new URL(url);
      u.hash = '';
      for (const p of [...u.searchParams.keys()]) if (/^(utm_|gh_src|source|ref|trk|lever-source)/i.test(p)) u.searchParams.delete(p);
      return (u.origin + u.pathname.replace(/\/(apply|application)\/?$/i, '').replace(/\/$/, '') + (u.search || '')).toLowerCase();
    } catch (_) {
      return String(url || '').toLowerCase();
    }
  }

  // ---------------------------------------------------------------------------
  // Sources
  // ---------------------------------------------------------------------------

  /** Work out which job board a careers URL belongs to. */
  function detectSource(url) {
    let u;
    try {
      u = new URL(url);
    } catch (_) {
      return null;
    }
    const host = u.hostname.toLowerCase();
    const seg = u.pathname.split('/').filter(Boolean);
    if (/(^|\.)greenhouse\.io$/.test(host)) {
      if (host === 'boards-api.greenhouse.io') return seg[2] ? { type: 'greenhouse', slug: seg[2] } : null;
      const slug = seg[0] === 'embed' ? u.searchParams.get('for') : seg[0];
      return slug ? { type: 'greenhouse', slug } : null;
    }
    if (host === 'jobs.lever.co' && seg[0]) return { type: 'lever', slug: seg[0] };
    if (host === 'jobs.ashbyhq.com' && seg[0]) return { type: 'ashby', slug: seg[0] };
    const wd = host.match(/^([a-z0-9-]+)\.(wd\d+)\.myworkdayjobs\.com$/);
    if (wd) {
      const parts = seg.filter((s) => !/^[a-z]{2}-[A-Z]{2}$/.test(s));
      const site = parts[0];
      return site ? { type: 'workday', host, tenant: wd[1], site } : null;
    }
    return null;
  }

  function sourceId(src) {
    return src.type === 'workday' ? 'workday:' + src.host + '/' + src.site : src.type + ':' + src.slug;
  }

  function sourceOrigins(src) {
    return {
      greenhouse: ['https://boards-api.greenhouse.io/*'],
      lever: ['https://api.lever.co/*'],
      ashby: ['https://api.ashbyhq.com/*'],
      workday: src.host ? ['https://' + src.host + '/*'] : [],
    }[src.type] || [];
  }

  // A starting list of security companies whose career boards were confirmed
  // during research (Oct 2026). Any that stop responding are switched off
  // automatically and reported; Bruno can add more from any careers page.
  const DEFAULT_SOURCES = [
    { type: 'greenhouse', slug: 'guidepointsecurity', company: 'GuidePoint Security' },
    { type: 'greenhouse', slug: 'threatlocker', company: 'ThreatLocker' },
    { type: 'greenhouse', slug: 'cybersheath', company: 'CyberSheath' },
    { type: 'ashby', slug: '1password', company: '1Password' },
    { type: 'workday', host: 'arcticwolf.wd1.myworkdayjobs.com', tenant: 'arcticwolf', site: 'External', company: 'Arctic Wolf' },
  ];

  // ---------------------------------------------------------------------------
  // Fetching with retries
  // ---------------------------------------------------------------------------

  class HttpError extends Error {
    constructor(status, url) {
      super('HTTP ' + status + ' from ' + new URL(url).hostname);
      this.status = status;
    }
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /**
   * GET/POST JSON with a timeout and up to `retries` retries for network
   * errors, 429 and 5xx. 4xx errors (e.g. a board that no longer exists) are
   * not retried.
   */
  async function fetchJson(fetchFn, url, init = {}, { retries = 2, timeoutMs = 20000, baseDelay = 1000 } = {}) {
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
      const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
      try {
        const res = await fetchFn(url, Object.assign({}, init, ctrl ? { signal: ctrl.signal } : {}));
        if (res.ok) return await res.json();
        lastErr = new HttpError(res.status, url);
        if (res.status !== 429 && res.status < 500) throw lastErr;
        const ra = Number(res.headers && res.headers.get && res.headers.get('retry-after'));
        if (attempt < retries) await sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra, 30) * 1000 : baseDelay * 3 ** attempt);
      } catch (err) {
        if (err instanceof HttpError && err.status !== 429 && err.status < 500) throw err;
        lastErr = err.name === 'AbortError' ? new Error('Timed out contacting ' + new URL(url).hostname) : err;
        if (attempt < retries) await sleep(baseDelay * 3 ** attempt);
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    throw lastErr;
  }

  // ---------------------------------------------------------------------------
  // Per-board adapters → common job shape
  // ---------------------------------------------------------------------------

  function job(fields) {
    const j = Object.assign({ remote: false, salary: null, description: '', postedAt: null }, fields);
    j.description = String(j.description || '').slice(0, 20000);
    if (!j.salary && j.description) j.salary = parseSalary(j.description);
    if (!j.remote) j.remote = isRemoteText(j.location);
    j.dedupeKey = dedupeKey(j);
    j.canonicalUrl = canonicalUrl(j.url);
    return j;
  }

  const ADAPTERS = {
    async greenhouse(src, f) {
      const data = await fetchJson(f, 'https://boards-api.greenhouse.io/v1/boards/' + encodeURIComponent(src.slug) + '/jobs?content=true');
      return (data.jobs || []).map((g) =>
        job({
          source: 'greenhouse', sourceKey: 'greenhouse:' + g.id, company: src.company || (g.company_name || src.slug),
          title: g.title, location: g.location && g.location.name, url: g.absolute_url, applyUrl: g.absolute_url,
          description: htmlToText(g.content), postedAt: g.first_published || g.updated_at || null,
        })
      );
    },
    async lever(src, f) {
      const data = await fetchJson(f, 'https://api.lever.co/v0/postings/' + encodeURIComponent(src.slug) + '?mode=json');
      return (Array.isArray(data) ? data : []).map((p) => {
        const c = p.categories || {};
        const sr = p.salaryRange;
        const yearly = sr && /year|annual/i.test(sr.interval || '');
        return job({
          source: 'lever', sourceKey: 'lever:' + p.id, company: src.company || src.slug, title: p.text,
          location: c.location || (c.allLocations || []).join('; '), remote: p.workplaceType === 'remote',
          url: p.hostedUrl, applyUrl: p.applyUrl || (p.hostedUrl ? p.hostedUrl + '/apply' : ''),
          description: [p.descriptionPlain, ...(p.lists || []).map((l) => l.text + '\n' + htmlToText(l.content)), p.additionalPlain].filter(Boolean).join('\n'),
          salary: yearly && sr.max ? { min: sr.min || sr.max, max: sr.max, period: 'year', currency: sr.currency || 'USD', ote: false, text: 'listed range' } : null,
          postedAt: p.createdAt ? new Date(p.createdAt).toISOString() : null,
        });
      });
    },
    async ashby(src, f) {
      const data = await fetchJson(f, 'https://api.ashbyhq.com/posting-api/job-board/' + encodeURIComponent(src.slug) + '?includeCompensation=true');
      return (data.jobs || []).filter((a) => a.isListed !== false).map((a) => {
        const comp = ((a.compensation || {}).summaryComponents || []).find((c) => /salary/i.test(c.compensationType || '') && /year/i.test(c.interval || ''));
        return job({
          source: 'ashby', sourceKey: 'ashby:' + a.id, company: src.company || src.slug, title: a.title,
          location: [a.location, ...((a.secondaryLocations || []).map((l) => l.location))].filter(Boolean).join('; '),
          remote: a.isRemote === true || a.workplaceType === 'Remote', url: a.jobUrl, applyUrl: a.applyUrl || a.jobUrl,
          description: a.descriptionPlain || htmlToText(a.descriptionHtml),
          salary: comp && comp.maxValue ? { min: comp.minValue || comp.maxValue, max: comp.maxValue, period: 'year', currency: comp.currencyCode || 'USD', ote: false, text: (a.compensation || {}).compensationTierSummary || 'listed range' } : null,
          postedAt: a.publishedAt || null,
        });
      });
    },
    async workday(src, f, ctx) {
      const base = 'https://' + src.host + '/wday/cxs/' + src.tenant + '/' + src.site;
      const out = [];
      const searches = ctx.positions.length ? ctx.positions : [''];
      const seen = new Set();
      for (const q of searches) {
        const data = await fetchJson(f, base + '/jobs', {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ appliedFacets: {}, limit: 20, offset: 0, searchText: q }),
        });
        for (const p of data.jobPostings || []) {
          if (!p.externalPath || seen.has(p.externalPath)) continue;
          seen.add(p.externalPath);
          // Only fetch full details for titles worth considering, to keep the
          // number of requests to the company's site small.
          if (ctx.positions.length && !matchTitle(p.title, ctx.positions).pass) continue;
          if (out.length >= 15) break;
          let info = {};
          try {
            info = (await fetchJson(f, base + p.externalPath, { headers: { accept: 'application/json' } })).jobPostingInfo || {};
          } catch (_) {
            // Keep the listing without a description rather than drop it.
          }
          const url = info.externalUrl || 'https://' + src.host + '/' + src.site + p.externalPath;
          out.push(job({
            source: 'workday', sourceKey: 'workday:' + src.host + p.externalPath, company: src.company || src.tenant,
            title: p.title, location: info.location || p.locationsText || '', remote: /remote/i.test((info.remoteType || '') + ' ' + (p.locationsText || '')),
            url, applyUrl: url.replace(/\/?$/, '/apply'), description: htmlToText(info.jobDescription || ''), postedAt: info.startDate || null,
          }));
        }
      }
      return out;
    },
  };

  // ---------------------------------------------------------------------------
  // Discovery run
  // ---------------------------------------------------------------------------

  /**
   * Fetch every enabled source, filter and score, and merge into the job list.
   * Pure apart from fetchFn, so it runs the same in the panel, the background
   * worker and the tests.
   *
   * @returns {{jobs, sources, summary}} new arrays; inputs are not mutated
   */
  async function runDiscovery({ settings, sources, jobs, resumeText, fetchFn, now = new Date(), delayMs = 400 }) {
    const positions = parsePositions(settings.positions);
    const outJobs = jobs.map((j) => Object.assign({}, j));
    const outSources = sources.map((s) => Object.assign({}, s));
    const byKey = new Map();
    const byUrl = new Map();
    for (const j of outJobs) {
      if (j.dedupeKey) byKey.set(j.dedupeKey, j);
      if (j.url) byUrl.set(canonicalUrl(j.url), j);
    }
    const summary = { checked: 0, found: 0, added: 0, updated: 0, duplicates: 0, alreadyApplied: 0, skipped: {}, closed: 0, errors: [] };
    const iso = now.toISOString();

    for (const src of outSources) {
      if (src.enabled === false) continue;
      summary.checked++;
      let listings;
      try {
        listings = await ADAPTERS[src.type](src, fetchFn, { positions });
        src.lastOk = iso;
        src.lastError = '';
        src.failures = 0;
        src.lastCount = listings.length;
      } catch (err) {
        src.failures = (src.failures || 0) + 1;
        src.lastError = err.message;
        // A board that's gone (404) or keeps failing is switched off and reported.
        if (err.status === 404 || src.failures >= 3) src.enabled = false;
        summary.errors.push((src.company || sourceId(src)) + ': ' + err.message + (src.enabled === false ? ' — source turned off' : ''));
        continue;
      }
      summary.found += listings.length;
      const live = new Set();
      for (const l of listings) {
        live.add(l.sourceKey);
        const ev = evaluate(l, settings, resumeText);
        const existing = byUrl.get(l.canonicalUrl) || byKey.get(l.dedupeKey);
        if (existing) {
          if (existing.sourceKey && existing.sourceKey !== l.sourceKey && existing.dedupeKey === l.dedupeKey) summary.duplicates++;
          if (existing.status === 'submitted') summary.alreadyApplied++;
          // Refresh details but never touch Bruno's status, resume or notes.
          Object.assign(existing, {
            description: existing.description || l.description, salary: existing.salary || l.salary,
            applyUrl: existing.applyUrl || l.applyUrl, lastSeenAt: iso, score: ev.score, matchReasons: ev.reasons,
            sourceKey: existing.sourceKey || l.sourceKey, source: existing.source || l.source,
          });
          if (existing.status === 'closed') existing.status = 'selected';
          summary.updated++;
          continue;
        }
        if (!ev.pass) {
          summary.skipped[ev.skipReason] = (summary.skipped[ev.skipReason] || 0) + 1;
          continue;
        }
        const added = Object.assign({}, l, {
          id: 'j' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
          status: 'selected', resumeId: null, notes: '', origin: 'discovered', addedAt: iso, updatedAt: iso, lastSeenAt: iso,
          score: ev.score, matchReasons: ev.reasons,
        });
        outJobs.push(added);
        byKey.set(added.dedupeKey, added);
        byUrl.set(added.canonicalUrl, added);
        summary.added++;
      }
      // Postings this board no longer lists have closed.
      for (const j of outJobs) {
        if (j.sourceKey && j.sourceKey.startsWith(src.type + ':') && sourceOwns(src, j) && !live.has(j.sourceKey) && !['submitted', 'closed', 'skipped'].includes(j.status)) {
          j.status = 'closed';
          j.manualReason = 'No longer listed on the company’s job board';
          summary.closed++;
        }
      }
      if (delayMs) await sleep(delayMs);
    }
    return { jobs: outJobs, sources: outSources, summary };
  }

  function sourceOwns(src, j) {
    if (src.type === 'workday') return j.sourceKey.startsWith('workday:' + src.host);
    return norm(j.company) === norm(src.company || src.slug);
  }

  // ---------------------------------------------------------------------------
  // Search links for boards without a public feed
  // ---------------------------------------------------------------------------

  const LINKEDIN_SALARY = [[200000, 9], [180000, 8], [160000, 7], [140000, 6], [120000, 5], [100000, 4], [80000, 3], [60000, 2], [40000, 1]];

  function searchLinks(settings) {
    const q = parsePositions(settings.positions).join(' OR ');
    const loc = parseLocationSetting(settings.location)[0];
    const remote = loc.kind === 'remote';
    const place = remote || loc.kind === 'nationwide' || loc.kind === 'any' ? 'United States' : String(settings.location).split(/;|\bor\b/i)[0].trim();
    const min = Number(settings.minSalary) || 0;
    const li = new URL('https://www.linkedin.com/jobs/search/');
    li.searchParams.set('keywords', q);
    li.searchParams.set('location', place);
    if (remote) li.searchParams.set('f_WT', '2');
    const bucket = LINKEDIN_SALARY.find(([v]) => min >= v);
    if (bucket) li.searchParams.set('f_SB2', String(bucket[1]));
    const indeed = new URL('https://www.indeed.com/jobs');
    indeed.searchParams.set('q', q + (min ? ' $' + min.toLocaleString('en-US') : ''));
    indeed.searchParams.set('l', remote ? 'Remote' : place);
    const gd = new URL('https://www.glassdoor.com/Job/jobs.htm');
    gd.searchParams.set('sc.keyword', q);
    gd.searchParams.set('locKeyword', remote ? 'Remote' : place);
    if (min) gd.searchParams.set('minSalary', String(min));
    if (remote) gd.searchParams.set('remoteWorkType', '1');
    return { linkedin: li.toString(), indeed: indeed.toString(), glassdoor: gd.toString() };
  }

  const api = {
    htmlToText, decodeEntities, statesIn, isUS, parseLocationSetting, matchLocation, parseSalary, formatSalary, matchSalary,
    normTitle, parsePositions, matchTitle, keywordMatch, evaluate, dedupeKey, canonicalUrl, detectSource, sourceId,
    sourceOrigins, DEFAULT_SOURCES, fetchJson, HttpError, ADAPTERS, runDiscovery, searchLinks,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.JobAssistDiscovery = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
