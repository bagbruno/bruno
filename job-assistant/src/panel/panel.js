/* Side panel: everything Bruno sees and every action he takes. */
(function () {
  'use strict';

  const R = globalThis.JobAssistRules;
  const S = globalThis.JobAssistStore;
  const D = globalThis.JobAssistDiscovery;
  const T = globalThis.JobAssistTailor;
  const AI = globalThis.JobAssistAI;
  const C = globalThis.JobAssistContacts;
  const ST = R.STATUS;
  const FINISHED = [ST.SUBMITTED, ST.SKIPPED, ST.CLOSED];
  const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  let busy = false;
  const MAX_RESUME_BYTES = 5 * 1024 * 1024;

  let state = null;
  let activeTabUrl = '';

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'class') el.className = v;
      else if (k in el && k !== 'list') el[k] = v;
      else el.setAttribute(k, v);
    }
    for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c);
    return el;
  }

  const $ = (sel) => document.querySelector(sel);

  let toastTimer = null;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.hidden = true), 5000);
  }

  // A button that needs a second click to confirm, for anything Bruno should
  // be deliberate about.
  function confirmButton(label, confirmLabel, action, cls) {
    let armed = false;
    const b = h('button', {
      type: 'button',
      class: cls,
      onclick: async () => {
        if (!armed) {
          armed = true;
          b.textContent = confirmLabel;
          setTimeout(() => {
            armed = false;
            b.textContent = label;
          }, 6000);
          return;
        }
        await action();
      },
    }, label);
    return b;
  }

  function consents() {
    return state.settings.platformConsent || {};
  }

  function setConsent(platform, on) {
    const c = Object.assign({}, consents());
    if (on) c[platform.id] = new Date().toISOString();
    else delete c[platform.id];
    return Promise.all([
      S.set('settings', Object.assign({}, state.settings, { platformConsent: c })),
      S.addLog({ action: (on ? 'Bruno allowed filling on ' : 'Bruno withdrew filling on ') + platform.name, details: on ? 'Accepted the risk that ' + platform.name + ' may restrict his account.' : '' }),
    ]);
  }

  function jobName(job) {
    return [job.title || '(untitled job)', job.company].filter(Boolean).join(' — ');
  }

  function activeJob() {
    return state.jobs.find((j) => j.id === state.session.activeJobId) || null;
  }

  async function refresh() {
    state = await S.getAll();
    if (state.sources === null) {
      // First run: start with the default list of company job boards.
      state.sources = D.DEFAULT_SOURCES.map((x) => Object.assign({ enabled: true }, x));
      await S.set('sources', state.sources);
      return;
    }
    if (state.session.activeTabId != null) {
      try {
        activeTabUrl = (await chrome.tabs.get(state.session.activeTabId)).url || '';
      } catch (_) {
        activeTabUrl = '';
      }
    } else activeTabUrl = '';
    render();
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------

  function render() {
    renderPause();
    renderSearch();
    renderActive();
    renderJobs();
    renderProfile();
    renderResumes();
    renderAnswers();
    renderSettings();
    renderApproval();
    renderAutoApply();
    renderOutreach();
    renderLog();
  }

  function renderSearch() {
    const map = { '#s-location': 'location', '#s-salary': 'minSalary', '#s-positions': 'positions' };
    for (const [sel, key] of Object.entries(map)) {
      const el = $(sel);
      if (document.activeElement !== el) el.value = state.search[key] || '';
    }
    const links = D.searchLinks(searchSettings());
    $('#link-linkedin').href = links.linkedin;
    $('#link-indeed').href = links.indeed;
    $('#link-glassdoor').href = links.glassdoor;
    $('#find-jobs').disabled = busy;
    const d = state.discovery;
    if (!busy && d && d.lastRun) $('#find-status').textContent = 'Last search ' + new Date(d.lastRun).toLocaleString() + ': ' + summaryText(d.summary);
  }

  function summaryText(sum) {
    if (!sum) return '';
    const parts = [sum.added + ' new match' + (sum.added === 1 ? '' : 'es') + ' from ' + sum.found + ' listings on ' + sum.checked + ' job board' + (sum.checked === 1 ? '' : 's')];
    if (sum.alreadyApplied) parts.push(sum.alreadyApplied + ' you already applied to');
    if (sum.closed) parts.push(sum.closed + ' closed');
    if (sum.errors && sum.errors.length) parts.push(sum.errors.length + ' board(s) had problems — see Profile › Job boards');
    return parts.join('; ') + '.';
  }

  // "80k", "$80,000" and "80000" all mean 80000.
  function parseMoney(v) {
    const t = String(v || '').replace(/[$,\s]/g, '').toLowerCase();
    if (!t) return '';
    const n = parseFloat(t) * (/k$/.test(t) ? 1000 : 1);
    return Number.isFinite(n) && n > 0 ? Math.round(n) : NaN;
  }

  function searchSettings() {
    return { location: state.search.location || '', minSalary: parseMoney(state.search.minSalary) || 0, positions: state.search.positions || '' };
  }

  function mainResume() {
    return state.resumes.find((r) => r.id === state.settings.mainResumeId) || state.resumes[0] || null;
  }

  function renderAnswers() {
    const form = $('#answers-form');
    if (form.contains(document.activeElement)) return;
    form.replaceChildren(
      ...R.ANSWER_FIELDS.map((a) =>
        h('label', {}, a.label, h('input', { name: a.key, value: state.answers[a.key] || '', placeholder: a.key === 'salaryExpectation' ? 'e.g. 85000' : a.key === 'referralSource' ? 'e.g. Company website' : a.key === 'startDate' ? 'e.g. Two weeks notice' : 'Yes or No', oninput: onAnswerInput }))
      )
    );
  }

  let answerTimer = null;
  function onAnswerInput() {
    clearTimeout(answerTimer);
    answerTimer = setTimeout(async () => {
      const answers = {};
      for (const input of $('#answers-form').querySelectorAll('input')) if (input.value.trim()) answers[input.name] = input.value.trim();
      await S.set('answers', answers);
    }, 400);
  }

  function renderSettings() {
    if (document.activeElement !== $('#api-key')) $('#api-key').value = state.settings.apiKey ? '••••••••' + state.settings.apiKey.slice(-4) : '';
    $('#auto-discover').checked = !!state.settings.autoDiscover;
    const list = $('#source-list');
    list.replaceChildren();
    for (const src of state.sources || []) {
      const status = src.enabled === false ? 'Off' + (src.lastError ? ' — ' + src.lastError : '') : src.lastError ? 'Problem: ' + src.lastError : src.lastOk ? src.lastCount + ' listings at last check' : 'Not checked yet';
      list.append(
        h('li', {},
          h('div', { class: 'title' }, (src.company || D.sourceId(src)) + ' · ' + src.type),
          h('div', { class: 'meta' }, status),
          h('div', { class: 'row' },
            h('button', { type: 'button', onclick: () => updateSource(src, { enabled: src.enabled === false, failures: 0, lastError: '' }) }, src.enabled === false ? 'Turn on' : 'Turn off'),
            confirmButton('Remove', 'Confirm remove', () => S.set('sources', state.sources.filter((x) => D.sourceId(x) !== D.sourceId(src))), 'danger')
          )
        )
      );
    }
  }

  function updateSource(src, patch) {
    return S.set('sources', state.sources.map((x) => (D.sourceId(x) === D.sourceId(src) ? Object.assign({}, x, patch) : x)));
  }

  function renderPause() {
    $('#pause-banner').hidden = !state.session.paused;
    $('#pause-reason').textContent = ' ' + (state.session.pauseReason || '');
  }

  function renderActive() {
    const box = $('#active-job');
    const job = activeJob();
    box.replaceChildren();
    box.hidden = !job;
    if (!job) return;

    const url = activeTabUrl || job.url;
    const platform = R.platformFor(url);
    const resume = state.resumes.find((r) => r.id === job.resumeId);

    box.append(
      h('h2', {}, 'Open application'),
      h('div', { class: 'title' }, jobName(job)),
      h('div', { class: 'meta' }, state.session.activeTabId == null ? 'Tab closed — reopen it from the list.' : 'Tab: ' + url),
      h('div', { class: 'row' }, h('span', { class: 'chip ' + job.status }, R.STATUS_LABEL[job.status]), h('span', { class: 'meta' }, 'Resume: ' + (resume ? resume.label : 'none chosen'))),
      h('div', { class: 'alert ' + (R.canFill(platform, consents()) ? 'info' : 'warn') }, platform.notice)
    );
    if (platform.fill === 'consent') {
      box.append(
        consents()[platform.id]
          ? h('div', { class: 'row meta' }, 'Filling on ' + platform.name + ' allowed by you on ' + new Date(consents()[platform.id]).toLocaleDateString() + '.', h('button', { type: 'button', onclick: () => setConsent(platform, false) }, 'Withdraw'))
          : h('div', { class: 'row' }, confirmButton('Allow filling on ' + platform.name, 'Confirm: I accept the risk to my ' + platform.name + ' account', () => setConsent(platform, true), 'danger'))
      );
    }
    if (job.status === ST.MANUAL && job.manualReason) box.append(h('div', { class: 'alert stop' }, 'Manual action required: ' + job.manualReason));
    if (job.submitObservedAt && job.status !== ST.SUBMITTED) {
      box.append(h('div', { class: 'alert warn' }, 'You clicked Submit on this page. Once the site shows a confirmation, mark it submitted below.'));
    }

    const canFill = !state.session.paused && state.session.activeTabId != null && R.canFill(platform, consents()) && !FINISHED.includes(job.status);
    box.append(
      h('div', { class: 'row' },
        h('button', { type: 'button', class: 'primary', disabled: !canFill, onclick: () => fillActive() }, 'Fill routine fields'),
        h('button', { type: 'button', disabled: state.session.activeTabId == null, onclick: () => chrome.tabs.update(state.session.activeTabId, { active: true }) }, 'Go to tab')
      ),
      h('p', { class: 'hint' }, 'Multi-page form? Click Fill again on each page. Review everything, then click Submit on the site yourself.'),
      h('div', { class: 'row' },
        confirmButton('Mark submitted', 'Confirm: I clicked Submit myself', () => markSubmitted(job)),
        confirmButton('Skip job', 'Confirm skip', () => setStatus(job, ST.SKIPPED, 'Skipped by Bruno')),
        h('button', { type: 'button', onclick: () => release(job) }, 'Close out (keep status)')
      )
    );
  }

  function renderJobs() {
    const filter = $('#job-filter').value;
    const list = $('#job-list');
    list.replaceChildren();
    const jobs = state.jobs
      .filter((j) => (filter === 'all' ? true : filter === 'open' ? !FINISHED.includes(j.status) : j.status === filter))
      .sort((a, b) => (b.score || 0) - (a.score || 0));
    if (!jobs.length) list.append(h('li', { class: 'meta' }, 'No jobs here yet.'));
    for (const job of jobs) {
      const platform = R.platformFor(job.url);
      const isActive = job.id === state.session.activeJobId;
      list.append(
        h('li', {},
          h('div', { class: 'title' }, jobName(job)),
          h('div', { class: 'meta' }, [job.location, D.formatSalary(job.salary), job.source ? 'via ' + job.source : ''].filter(Boolean).join(' · ')),
          h('div', { class: 'meta' }, job.url),
          h('div', { class: 'row' },
            job.score != null ? h('span', { class: 'chip score', title: (job.matchReasons || []).join('\n') }, 'Match ' + job.score) : null,
            h('span', { class: 'chip ' + job.status }, R.STATUS_LABEL[job.status]),
            platform.fill === 'blocked' ? h('span', { class: 'chip manual_action_required', title: platform.notice }, platform.name + ': fill by hand') : null,
            platform.fill === 'consent' && !consents()[platform.id] ? h('span', { class: 'chip awaiting_bruno', title: platform.notice }, platform.name + ': needs your OK to fill') : null
          ),
          job.matchReasons && job.matchReasons.length ? h('div', { class: 'meta' }, job.matchReasons.join(' · ')) : null,
          (job.status === ST.MANUAL || job.status === ST.CLOSED) && job.manualReason ? h('div', { class: 'meta' }, job.manualReason) : null,
          job.tailored ? h('div', { class: 'meta' }, tailorSummary(job.tailored)) : null,
          h('label', {}, 'Resume version',
            h('select', { onchange: (e) => S.updateJob(job.id, { resumeId: e.target.value || null }) },
              h('option', { value: '' }, '— none —'),
              state.resumes.filter((r) => !r.forJobId || r.forJobId === job.id).map((r) => h('option', { value: r.id, selected: r.id === job.resumeId }, r.label))
            )
          ),
          h('div', { class: 'row' },
            isActive ? h('strong', {}, 'Open now') : h('button', { type: 'button', disabled: FINISHED.includes(job.status), onclick: () => openJob(job) }, 'Open application'),
            !FINISHED.includes(job.status) ? h('button', { type: 'button', disabled: busy, onclick: () => tailorForJob(job, true) }, job.tailored ? 'Re-tailor resume' : 'Tailor resume') : null,
            job.status === ST.MANUAL || job.status === ST.CLOSED ? h('button', { type: 'button', onclick: () => setStatus(job, ST.SELECTED, 'Bruno cleared the flag') }, 'Clear flag') : null,
            confirmButton('Remove', 'Confirm remove', () => removeJob(job), 'danger')
          ),
          job.company ? renderPeople(job) : null
        )
      );
    }
  }

  function tailorSummary(t) {
    const bits = ['Tailored resume: ' + (t.changes.length ? 'updated ' + t.changes.join(', ') : 'no changes needed')];
    if (t.fitScore != null) bits.push('AI fit ' + t.fitScore + '/100');
    if (t.missing && t.missing.length) bits.push('Not on your resume: ' + t.missing.slice(0, 4).join(', '));
    if (t.rejected && t.rejected.length) bits.push(t.rejected.length + ' AI change(s) rejected for adding things not on your resume');
    return bits.join(' · ');
  }

  const openPeople = new Set();

  function renderPeople(job) {
    const people = state.contacts.filter((c) => c.jobIds.includes(job.id));
    const d = h('details', { class: 'people', open: openPeople.has(job.id), ontoggle: (e) => (e.target.open ? openPeople.add(job.id) : openPeople.delete(job.id)) },
      h('summary', {}, 'People to contact' + (people.length ? ' (' + people.length + ')' : '')));
    for (const s of C.peopleSearches(job)) {
      const who = people.filter((c) => c.role === s.role);
      const form = h('form', { class: 'row', onsubmit: (e) => { e.preventDefault(); addPerson(job, s.role, e.target); } },
        h('input', { name: 'name', placeholder: 'Name', required: true, style: 'flex:1;min-width:0' }),
        h('input', { name: 'url', placeholder: 'linkedin.com/in/…', required: true, style: 'flex:2;min-width:0' }),
        h('button', { type: 'submit' }, 'Add'));
      d.append(
        h('div', { class: 'person-role' },
          h('div', { class: 'title' }, s.label, ' ', h('a', { href: s.url, target: '_blank', rel: 'noopener' }, 'Search LinkedIn ↗')),
          who.map((c) => h('div', { class: 'meta' }, h('a', { href: c.profileUrl, target: '_blank', rel: 'noopener' }, c.name), ' — ', contactStatus(c))),
          who.length ? null : form
        )
      );
    }
    d.append(h('p', { class: 'hint' }, 'Pick the right person yourself from each search. Messages are drafted in the Outreach tab for your approval; you send them on LinkedIn.'));
    return d;
  }

  function contactStatus(c) {
    return { not_contacted: 'not contacted', drafted: 'message drafted', sent_by_bruno: 'contacted ' + (c.contactedAt ? new Date(c.contactedAt).toLocaleDateString() : '') }[c.status] || c.status;
  }

  async function addPerson(job, role, form) {
    const r = C.addContact(state.contacts, { name: form.elements.name.value, profileUrl: form.elements.url.value, role, job });
    if (r.error) return toast(r.error);
    await S.set('contacts', r.contacts);
    if (r.duplicate && r.duplicate.status !== 'not_contacted') {
      return toast(r.duplicate.name + ' is already in your contacts (' + contactStatus(r.duplicate) + '). No new message drafted.');
    }
    const applied = job.status === ST.SUBMITTED || !!job.submitObservedAt;
    const m = C.draftMessages(r.contact, job, applied);
    const outreach = await S.get('outreach');
    const now = new Date().toISOString();
    outreach.push(
      { id: S.uid(), contactId: r.contact.id, personName: r.contact.name, profileUrl: r.contact.profileUrl, kind: 'connection', jobId: job.id, text: m.connection, status: 'draft', createdAt: now },
      { id: S.uid(), contactId: r.contact.id, personName: r.contact.name, profileUrl: r.contact.profileUrl, kind: 'message', jobId: job.id, text: m.followUp, status: 'draft', createdAt: now }
    );
    await S.set('outreach', outreach);
    await S.set('contacts', r.contacts.map((c) => (c.id === r.contact.id ? Object.assign({}, c, { status: 'drafted' }) : c)));
    await S.addLog({ jobId: job.id, action: 'Outreach drafted for approval: ' + r.contact.name + ' (' + role + ')', details: 'Connection note and follow-up message are in the Outreach tab.', submissionStatus: 'draft' });
    toast('Drafts for ' + r.contact.name + ' are in the Outreach tab for your approval.');
  }

  function renderProfile() {
    const form = $('#profile-form');
    // Don't rebuild while Bruno is typing in it.
    if (form.contains(document.activeElement)) return renderVerify();
    form.replaceChildren(
      ...R.PROFILE_KEYS.map(({ key, label }) =>
        h('div', { class: 'profile-row' },
          h('label', {}, label, h('input', { name: key, value: state.profile.values[key] || '', oninput: onProfileInput })),
          h('button', { type: 'button', title: 'Copy to clipboard', onclick: () => copy(state.profile.values[key] || '', label) }, 'Copy')
        )
      )
    );
    renderVerify();
  }

  function renderVerify() {
    const v = state.profile.verifiedAt;
    $('#verify-status').textContent = v ? 'Verified by you on ' + new Date(v).toLocaleString() + '.' : 'Not verified. Filling is off until you check these details.';
    $('#verify-status').className = v ? 'hint' : 'alert warn';
  }

  function renderResumes() {
    const list = $('#resume-list');
    list.replaceChildren();
    if (!state.resumes.length) list.append(h('li', { class: 'meta' }, 'No resume versions saved.'));
    for (const r of state.resumes) {
      list.append(
        h('li', {},
          h('div', { class: 'title' }, r.label, mainResume() && mainResume().id === r.id ? h('span', { class: 'chip submitted', style: 'margin-left:6px' }, 'Main') : null),
          h('div', { class: 'meta' }, r.fileName + ' · ' + Math.round(r.size / 1024) + ' KB · added ' + new Date(r.addedAt).toLocaleDateString() + (r.forJobId ? ' · tailored' : '')),
          h('div', { class: 'row' },
            !r.forJobId && (!mainResume() || mainResume().id !== r.id) ? h('button', { type: 'button', onclick: () => S.set('settings', Object.assign({}, state.settings, { mainResumeId: r.id })) }, 'Make main') : null,
            h('a', { href: r.dataUrl, download: r.fileName }, 'Download'),
            confirmButton('Delete', 'Confirm delete', async () => {
              await S.set('resumes', state.resumes.filter((x) => x.id !== r.id));
            }, 'danger')
          )
        )
      );
    }
  }

  function renderOutreach() {
    const jobSel = $('#outreach-form [name=jobId]');
    const current = jobSel.value;
    jobSel.replaceChildren(h('option', { value: '' }, '— none —'), ...state.jobs.map((j) => h('option', { value: j.id, selected: j.id === current }, jobName(j))));

    const list = $('#outreach-list');
    list.replaceChildren();
    if (!state.outreach.length) list.append(h('li', { class: 'meta' }, 'No drafts.'));
    const label = { draft: 'Awaiting your approval', approved: 'Approved — send it yourself', sent_by_bruno: 'Sent by Bruno', declined: 'Declined' };
    for (const o of state.outreach.slice().reverse()) {
      const actions = [];
      if (o.status === 'draft') {
        actions.push(
          h('button', { type: 'button', class: 'primary', onclick: () => setOutreach(o, 'approved', 'Outreach approved') }, 'Approve'),
          h('button', { type: 'button', onclick: () => editOutreach(o) }, 'Edit'),
          h('button', { type: 'button', onclick: () => setOutreach(o, 'declined', 'Outreach declined') }, 'Decline')
        );
      } else if (o.status === 'approved') {
        actions.push(
          h('button', { type: 'button', class: 'primary', onclick: () => openOutreach(o) }, 'Open profile & copy text'),
          confirmButton('I sent it myself', 'Confirm: I clicked Send', () => setOutreach(o, 'sent_by_bruno', 'Outreach sent by Bruno')),
          h('button', { type: 'button', onclick: () => setOutreach(o, 'draft', 'Outreach returned to draft') }, 'Back to draft')
        );
      }
      list.append(
        h('li', {},
          h('div', { class: 'title' }, (o.kind === 'connection' ? 'Connection request: ' : 'Message: ') + o.personName),
          h('div', { class: 'meta' }, o.profileUrl),
          h('div', { class: 'row' }, h('span', { class: 'chip ' + (o.status === 'sent_by_bruno' ? 'submitted' : o.status === 'declined' ? 'skipped' : 'awaiting_bruno') }, label[o.status])),
          h('p', {}, o.text),
          h('div', { class: 'row' }, actions)
        )
      );
    }
  }

  function renderLog() {
    const list = $('#log-list');
    list.replaceChildren();
    const entries = state.log.slice(-200).reverse();
    if (!entries.length) list.append(h('li', { class: 'meta' }, 'Nothing logged yet.'));
    for (const e of entries) {
      list.append(
        h('li', {},
          h('div', { class: 'meta' }, new Date(e.ts).toLocaleString()),
          h('div', { class: 'title' }, e.action + (e.job ? ' — ' + e.job : '')),
          h('ul', {},
            e.resumeVersion ? h('li', {}, 'Resume version: ' + e.resumeVersion) : null,
            e.fieldsCompleted.length ? h('li', {}, 'Fields completed: ' + e.fieldsCompleted.join(', ')) : null,
            e.fieldsForBruno.length ? h('li', {}, 'Left for Bruno: ' + e.fieldsForBruno.join(', ')) : null,
            e.documentsUploaded.length ? h('li', {}, 'Documents uploaded: ' + e.documentsUploaded.join(', ')) : null,
            e.submissionStatus ? h('li', {}, 'Submission status: ' + (R.STATUS_LABEL[e.submissionStatus] || e.submissionStatus)) : null,
            e.details ? h('li', {}, e.details) : null
          )
        )
      );
    }
  }

  function renderRules() {
    $('#platform-rules').replaceChildren(
      ...R.PLATFORM_RULES.map((p) => h('li', {}, h('strong', {}, p.name + ': '), p.notice)),
      h('li', {}, h('strong', {}, 'Other sites: '), R.platformFor('https://example.com').notice)
    );
  }

  // ---------------------------------------------------------------------------
  // Jobs
  // ---------------------------------------------------------------------------

  // Adds jobs unless they're already in the list under any URL or platform.
  async function addJobs(items, origin) {
    const jobs = await S.get('jobs');
    const urls = new Set(jobs.map((j) => D.canonicalUrl(j.url)));
    const keys = new Map(jobs.filter((j) => j.company).map((j) => [j.dedupeKey || D.dedupeKey(j), j]));
    const now = new Date().toISOString();
    const result = { added: 0, duplicates: [] };
    for (const it of items) {
      const job = { id: S.uid(), url: it.url, title: it.title || '', company: it.company || '', location: it.location || '', notes: it.notes || '', status: ST.SELECTED, resumeId: null, origin, addedAt: now, updatedAt: now };
      job.remote = /remote/i.test(job.location);
      job.dedupeKey = D.dedupeKey(job);
      job.canonicalUrl = D.canonicalUrl(job.url);
      const dup = urls.has(job.canonicalUrl) ? jobs.find((j) => D.canonicalUrl(j.url) === job.canonicalUrl) : job.company ? keys.get(job.dedupeKey) : null;
      if (dup) {
        result.duplicates.push(dup);
        continue;
      }
      urls.add(job.canonicalUrl);
      if (job.company) keys.set(job.dedupeKey, job);
      jobs.push(job);
      result.added++;
    }
    await S.set('jobs', jobs);
    return result;
  }

  function duplicateText(d) {
    return d.status === ST.SUBMITTED ? 'You already applied to this job (' + jobName(d) + ').' : 'That job is already in your list (' + jobName(d) + ').';
  }

  // ---------------------------------------------------------------------------
  // Finding jobs
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // Automatic submission: approval
  // ---------------------------------------------------------------------------

  const AUTO_MIN_SCORE = 60; // only well-matched jobs are submitted automatically
  const AUTO_DAILY_CAP = 25;
  const AUTO_PACE_MS = 20000; // fixed gap between submissions, out of courtesy to the sites
  const AUTO_CONFIRM_MS = 45000;
  let running = false;
  let stopRequested = false;
  let lastRunSummary = '';

  // Everything an approval covers. Any change means Bruno approves again.
  function approvalFingerprint() {
    const main = mainResume();
    const text = JSON.stringify([state.profile.values, state.answers, main ? [main.id, main.fileName, main.size] : null, state.profile.verifiedAt]);
    let h = 5381;
    for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
    return String(h >>> 0);
  }

  function approval() {
    const a = state.settings.autoApproval;
    return a && state.profile.verifiedAt && a.fingerprint === approvalFingerprint() ? a : null;
  }

  const pendingDeclarations = new Set();

  function renderApproval() {
    const a = state.settings.autoApproval;
    const valid = approval();
    if (a && !pendingDeclarations.size) for (const d of a.declarations || []) pendingDeclarations.add(d);
    const main = mainResume();
    const rows = [
      ...R.PROFILE_KEYS.filter(({ key }) => state.profile.values[key]).map(({ key, label }) => [label, state.profile.values[key]]),
      ...R.ANSWER_FIELDS.filter((x) => state.answers[x.key]).map((x) => [x.label, state.answers[x.key]]),
      ['Main resume (tailored per job)', main ? main.fileName : '— none —'],
    ];
    $('#approval-summary').replaceChildren(
      h('ul', { class: 'meta' }, rows.map(([k, v]) => h('li', {}, k + ': ' + v))),
      h('div', { class: 'title' }, 'Declarations it may accept for you'),
      ...R.DECLARATIONS.map((d) =>
        h('label', { class: 'row' },
          h('input', { type: 'checkbox', style: 'width:auto', checked: pendingDeclarations.has(d.id), onchange: (e) => (e.target.checked ? pendingDeclarations.add(d.id) : pendingDeclarations.delete(d.id)) }),
          d.label)
      ),
      h('p', { class: valid ? 'hint' : 'alert warn' },
        valid ? 'Approved on ' + new Date(valid.at).toLocaleString() + '.'
          : !state.profile.verifiedAt ? 'Verify your profile above first.'
          : a ? 'Your details changed since you approved. Review them and approve again.'
          : 'Not approved. Auto-apply is off.')
    );
    $('#approval-actions').replaceChildren(
      confirmButton(valid ? 'Approve again' : 'Approve automatic submission', 'Confirm: submit applications for me with these details', approve, 'primary'),
      a ? h('button', { type: 'button', onclick: revokeApproval }, 'Turn off automatic submission') : null
    );
  }

  async function approve() {
    if (!state.profile.verifiedAt) return toast('Verify your profile first.');
    if (!mainResume()) return toast('Add your resume first.');
    const required = ['firstName', 'lastName', 'email', 'phone'].filter((k) => !state.profile.values[k]);
    if (required.length) return toast('Add these to your profile first: ' + required.join(', '));
    const autoApproval = { at: new Date().toISOString(), fingerprint: approvalFingerprint(), declarations: [...pendingDeclarations] };
    await S.set('settings', Object.assign({}, state.settings, { autoApproval }));
    await S.addLog({
      action: 'Bruno approved automatic submission',
      details: 'Profile, ' + Object.keys(state.answers).length + ' screening answers, resume “' + mainResume().fileName + '”; declarations: ' + (autoApproval.declarations.join(', ') || 'none'),
    });
    toast('Automatic submission approved.');
  }

  async function revokeApproval() {
    stopRequested = true;
    await S.set('settings', Object.assign({}, state.settings, { autoApproval: null }));
    await S.addLog({ action: 'Bruno turned off automatic submission' });
  }

  // ---------------------------------------------------------------------------
  // Automatic submission: the queue
  // ---------------------------------------------------------------------------

  function autoEligible() {
    return state.jobs.filter((j) => j.status === ST.SELECTED && (j.score || 0) >= AUTO_MIN_SCORE && R.autoSubmitPolicy(j.applyUrl || j.url).allowed);
  }

  function submittedToday() {
    const day = new Date().toDateString();
    return state.jobs.filter((j) => j.submission && new Date(j.submission.at).toDateString() === day).length;
  }

  function renderAutoApply() {
    const eligible = autoEligible();
    const manual = state.jobs.filter((j) => j.status === ST.SELECTED && !R.autoSubmitPolicy(j.applyUrl || j.url).allowed).length;
    const left = Math.max(0, AUTO_DAILY_CAP - submittedToday());
    $('#autoapply-start').textContent = 'Auto-apply to ' + Math.min(eligible.length, left) + ' job' + (Math.min(eligible.length, left) === 1 ? '' : 's');
    $('#autoapply-start').disabled = running || busy || !approval() || !eligible.length || !left;
    $('#autoapply-stop').hidden = !running;
    if (running) return;
    $('#autoapply-status').textContent = (lastRunSummary ? 'Done: ' + lastRunSummary + '. ' : '') + (!approval()
      ? 'Approve automatic submission in the Profile tab to turn this on.'
      : eligible.length + ' matching job(s) on Greenhouse, Lever or Ashby can be submitted automatically (match ' + AUTO_MIN_SCORE + '+). ' +
        (manual ? manual + ' other job(s) need you to submit. ' : '') + submittedToday() + ' of ' + AUTO_DAILY_CAP + ' submitted today.');
  }

  function waitForTab(tabId, ms) {
    return new Promise((resolve) => {
      const end = Date.now() + ms;
      const tick = async () => {
        try {
          const t = await chrome.tabs.get(tabId);
          if (t.status === 'complete') return resolve(t);
        } catch (_) {
          return resolve(null);
        }
        if (Date.now() > end) return resolve(null);
        setTimeout(tick, 300);
      };
      tick();
    });
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function autoApply() {
    if (running) return;
    const a = approval();
    if (!a) return toast('Approve automatic submission in the Profile tab first.');
    if (state.session.paused) return toast('Paused — resolve the manual action first.');
    if (activeJob() && state.session.activeTabId != null && !FINISHED.includes(activeJob().status)) return toast('Close out the open application first.');
    const queue = autoEligible().slice(0, Math.max(0, AUTO_DAILY_CAP - submittedToday()));
    // Chrome asks once for the sites in this queue (must be straight from the click).
    const origins = [...new Set(queue.map((j) => new URL(j.applyUrl || j.url).origin + '/*'))];
    if (!(await chrome.permissions.request({ origins }))) return toast('Chrome permission for the application sites is needed.');
    running = true;
    stopRequested = false;
    renderAutoApply();
    const counts = { submitted: 0, needsYou: 0, closed: 0, unconfirmed: 0 };
    await S.addLog({ action: 'Auto-apply started for ' + queue.length + ' job(s)' });
    try {
      for (let i = 0; i < queue.length; i++) {
        if (stopRequested) break;
        $('#autoapply-status').textContent = 'Applying ' + (i + 1) + ' of ' + queue.length + ': ' + jobName(queue[i]) + '…';
        const result = await applyOne(queue[i].id, a);
        counts[result] = (counts[result] || 0) + 1;
        if (result === 'paused' || !approval()) break;
        if (i < queue.length - 1 && !stopRequested) await sleep(globalThis.JOB_ASSIST_PACE_MS ?? AUTO_PACE_MS);
      }
    } finally {
      running = false;
      const summary = counts.submitted + ' submitted and confirmed, ' + counts.needsYou + ' need you, ' + counts.closed + ' closed, ' + counts.unconfirmed + ' unconfirmed' + (counts.paused ? ', stopped by a security check' : '');
      lastRunSummary = summary;
      await S.addLog({ action: 'Auto-apply finished', details: summary });
      toast('Auto-apply: ' + summary + '.');
      renderAutoApply();
    }
  }

  /** One application, start to finish. Returns how it ended. */
  async function applyOne(jobId, a) {
    let job = (await S.get('jobs')).find((j) => j.id === jobId);
    if (!job || job.status !== ST.SELECTED) return 'skipped';
    const url = job.applyUrl || job.url;
    const tab = await chrome.tabs.create({ url, active: false });
    await S.updateSession({ activeJobId: job.id, activeTabId: tab.id });
    await S.updateJob(job.id, { status: ST.IN_PROGRESS });
    await S.addLog({ jobId: job.id, action: 'Auto-apply opened the application', submissionStatus: ST.IN_PROGRESS });
    let outcome = 'needsYou';
    try {
      if (!(await waitForTab(tab.id, 30000))) {
        await S.updateJob(job.id, { status: ST.MANUAL, manualReason: 'The application page didn’t load' });
        await S.addLog({ jobId: job.id, url, action: 'Not submitted — page didn’t load', submissionStatus: ST.MANUAL });
        return (outcome = 'needsYou');
      }
      state = await S.getAll();
      job = state.jobs.find((j) => j.id === jobId);
      if (!job.tailored && job.description) {
        await tailorForJob(job, false);
        state = await S.getAll();
        job = state.jobs.find((j) => j.id === jobId);
      }
      const resume = state.resumes.find((r) => r.id === job.resumeId) || mainResume();
      const values = {};
      for (const { key } of R.PROFILE_KEYS) if (state.profile.values[key]) values[key] = state.profile.values[key].trim();
      let report;
      try {
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['src/shared/rules.js', 'src/content/filler.js'] });
        const [res] = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: (payload) => globalThis.JobAssistFiller.run(payload),
          args: [{
            jobId: job.id, profile: values, answers: state.answers, consents: consents(),
            resume: resume && { label: resume.label, fileName: resume.fileName, type: resume.type, dataUrl: resume.dataUrl },
            autoSubmit: { jobTitle: job.title, company: job.company, declarations: a.declarations },
          }],
        });
        report = res && res.result;
      } catch (err) {
        report = { ok: false, reasons: ['Unsupported page: ' + err.message] };
      }
      if (!report) report = { ok: false, reasons: ['Unsupported page: no response from the page'] };

      if (!report.ok && report.expired) {
        await S.updateJob(job.id, { status: ST.CLOSED, manualReason: report.reasons.join('; ') });
        await S.addLog({ jobId: job.id, url, action: 'Posting closed — nothing submitted', submissionStatus: ST.CLOSED });
        return (outcome = 'closed');
      }
      if (!report.ok) {
        // CAPTCHA, security check, sign-in, unsupported page: stop everything.
        const reason = report.reasons.join('; ');
        await S.updateJob(job.id, { status: ST.MANUAL, manualReason: reason });
        await S.updateSession({ paused: true, pauseReason: reason });
        await S.addLog({ jobId: job.id, url, action: 'Auto-apply stopped — manual action required', submissionStatus: ST.MANUAL, details: reason });
        return (outcome = 'paused');
      }
      const r = report.autoSubmit;
      if (!r.ok) {
        await S.updateJob(job.id, { status: ST.AWAITING_BRUNO, manualReason: 'Not submitted automatically: ' + r.problems.join('; ') });
        await S.addLog({
          jobId: job.id, url, action: 'Not submitted — needs Bruno', resumeVersion: resume ? resume.label : '',
          fieldsCompleted: report.filled, fieldsForBruno: r.problems, documentsUploaded: report.uploaded, submissionStatus: 'Prepared, not submitted',
        });
        return (outcome = 'needsYou');
      }

      // Submitted on the page; wait for the site to confirm it.
      const end = Date.now() + (globalThis.JOB_ASSIST_CONFIRM_MS ?? AUTO_CONFIRM_MS);
      let latest;
      while (Date.now() < end) {
        await sleep(500);
        latest = (await S.get('jobs')).find((j) => j.id === jobId);
        if (latest.status === ST.SUBMITTED || (await S.get('session')).paused) break;
      }
      const record = {
        at: new Date().toISOString(), employer: job.company, title: job.title, url,
        resume: resume ? resume.fileName : '', fields: r.fields, declarations: r.declarations, leftBlank: r.leftBlank,
        confirmed: latest && latest.status === ST.SUBMITTED,
      };
      await S.updateJob(job.id, { submission: record });
      const entry = {
        jobId: job.id, url, resumeVersion: resume ? resume.label : '',
        fieldsCompleted: r.fields.map((f) => f.label + ': ' + f.value), documentsUploaded: report.uploaded,
        details: 'Declarations accepted: ' + (r.declarations.join(' | ') || 'none') + '. Left blank (optional): ' + (r.leftBlank.join(', ') || 'none') + '.',
      };
      if (record.confirmed) {
        await S.addLog(Object.assign(entry, { action: 'Submitted automatically — confirmed by ' + job.company + '’s application page', submissionStatus: ST.SUBMITTED }));
        return (outcome = 'submitted');
      }
      if ((await S.get('session')).paused) return (outcome = 'paused');
      await S.updateJob(job.id, { status: ST.MANUAL, manualReason: 'Submit was clicked but the site didn’t confirm. Check this application before trying again.' });
      await S.addLog(Object.assign(entry, { action: 'Submit clicked automatically — NOT confirmed by the site', submissionStatus: ST.MANUAL }));
      return (outcome = 'unconfirmed');
    } finally {
      try {
        // Leave the tab open only when a security check stopped everything, so
        // Bruno can see it. Jobs that need him are reopened from the list.
        if (outcome !== 'paused') await chrome.tabs.remove(tab.id);
      } catch (_) {}
      if (outcome !== 'paused') await S.updateSession({ activeJobId: null, activeTabId: null });
    }
  }

  async function findJobs() {
    if (busy) return;
    const settings = searchSettings();
    if (!settings.positions.trim()) return toast('Enter at least one job position.');
    if (Number.isNaN(parseMoney(state.search.minSalary))) return toast('Minimum salary should be a number, like 80000.');
    const enabled = (state.sources || []).filter((x) => x.enabled !== false);
    if (!enabled.length) return toast('No job boards are switched on. See Profile › Job boards searched.');
    // Workday boards are on each company's own domain; Chrome asks once per company.
    const origins = [...new Set(enabled.filter((x) => x.type === 'workday').flatMap(D.sourceOrigins))];
    const granted = origins.length ? await chrome.permissions.request({ origins }) : true;
    S.set('search', Object.assign({}, state.search));
    const sources = state.sources.map((x) => (x.type === 'workday' && !granted ? Object.assign({}, x, { enabled: false, lastError: 'Permission not granted' }) : x));
    busy = true;
    $('#find-jobs').disabled = true;
    $('#find-status').textContent = 'Searching ' + enabled.length + ' job boards…';
    try {
      const main = mainResume();
      const out = await D.runDiscovery({ settings, sources, jobs: state.jobs, resumeText: (main && main.text) || '', fetchFn: (u, i) => fetch(u, i) });
      // Bruno may have changed a job while the search ran; keep his changes.
      const latest = await S.get('jobs');
      const byId = new Map(latest.map((j) => [j.id, j]));
      const merged = out.jobs.map((j) => (byId.has(j.id) ? Object.assign({}, j, pickUserFields(byId.get(j.id))) : j));
      await chrome.storage.local.set({ jobs: merged, sources: out.sources, discovery: { lastRun: new Date().toISOString(), summary: out.summary } });
      await S.addLog({ action: 'Job search: ' + out.summary.added + ' new match(es)', details: summaryText(out.summary) + (out.summary.errors.length ? ' ' + out.summary.errors.join('; ') : '') });
      toast(summaryText(out.summary));
      $('#job-filter').value = 'open';
    } catch (err) {
      toast('Search failed: ' + err.message);
    } finally {
      busy = false;
      renderSearch();
      renderJobs();
    }
  }

  function pickUserFields(j) {
    const keep = {};
    for (const k of ['status', 'resumeId', 'notes', 'manualReason', 'submitObservedAt', 'submittedAt', 'tailored', 'confirmedBy']) if (k in j) keep[k] = j[k];
    return keep;
  }

  // ---------------------------------------------------------------------------
  // Resume tailoring
  // ---------------------------------------------------------------------------

  function dataUrlBytes(dataUrl) {
    const bin = atob(dataUrl.slice(dataUrl.indexOf(',') + 1));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function bytesDataUrl(bytes, type) {
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return 'data:' + type + ';base64,' + btoa(bin);
  }

  /**
   * Make a tailored copy of the main resume for this job and attach it.
   * Returns false (with a message) when it can't, so callers can carry on.
   */
  async function tailorForJob(job, manual) {
    const main = mainResume();
    if (!main) return manual && toast('Add your resume in the Profile tab first.'), false;
    if (main.type !== DOCX && !/\.docx$/i.test(main.fileName)) return manual && toast('Tailoring needs your resume as a Word (.docx) file. Your PDF will be used as is.'), false;
    if (!job.description && !manual) return false;
    busy = true;
    renderJobs();
    toast('Tailoring your resume for ' + jobName(job) + '…');
    try {
      const keywords = job.description ? D.keywordMatch(job.description, main.text || '').keywords : [];
      const apiKey = state.settings.apiKey;
      const ai = apiKey && job.description ? (req) => AI.askJson(Object.assign({ apiKey }, req)) : null;
      let r;
      try {
        r = await T.tailorDocx(dataUrlBytes(main.dataUrl), job, { ai, keywords });
      } catch (err) {
        if (!(err instanceof AI.AIError)) throw err;
        toast(err.message + ' Used keyword tailoring instead.');
        r = await T.tailorDocx(dataUrlBytes(main.dataUrl), job, { keywords });
      }
      const safe = (s) => String(s || '').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40);
      const fileName = main.fileName.replace(/\.docx$/i, '') + '_' + safe(job.company || job.title) + '.docx';
      const resumes = (await S.get('resumes')).filter((x) => x.forJobId !== job.id);
      const version = { id: S.uid(), label: 'Tailored — ' + jobName(job), fileName, type: DOCX, size: r.bytes.length, dataUrl: bytesDataUrl(r.bytes, DOCX), text: main.text, forJobId: job.id, addedAt: new Date().toISOString() };
      resumes.push(version);
      await S.set('resumes', resumes);
      const tailored = { resumeId: version.id, changes: r.changes, rejected: r.rejected, fitScore: r.fitScore, missing: r.missing, usedAI: r.usedAI };
      await S.updateJob(job.id, { resumeId: version.id, tailored });
      await S.addLog({ jobId: job.id, action: 'Resume tailored' + (r.usedAI ? ' with AI' : ''), resumeVersion: version.label, details: tailorSummary(tailored) });
      toast(tailorSummary(tailored));
      return true;
    } catch (err) {
      toast('Could not tailor the resume: ' + err.message + ' The main resume will be used.');
      await S.addLog({ jobId: job.id, action: 'Resume tailoring failed', details: err.message });
      return false;
    } finally {
      busy = false;
      renderJobs();
    }
  }

  async function openJob(job) {
    const cur = activeJob();
    if (cur && cur.id !== job.id && !FINISHED.includes(cur.status) && state.session.activeTabId != null) {
      toast(R.UNSUPPORTED_ACTIONS.bulk_open);
      return;
    }
    if (state.session.paused) {
      toast('The assistant is paused. Resolve the manual action first.');
      return;
    }
    const tab = await chrome.tabs.create({ url: job.applyUrl || job.url, active: true });
    await S.updateSession({ activeJobId: job.id, activeTabId: tab.id });
    if (job.status === ST.SELECTED) await S.updateJob(job.id, { status: ST.IN_PROGRESS });
    await S.addLog({ jobId: job.id, action: 'Application opened by Bruno', submissionStatus: ST.IN_PROGRESS });
    // Tailor while the page loads, if it hasn't been done for this job.
    const resume = state.resumes.find((r) => r.id === job.resumeId);
    if (!job.tailored && (!resume || !resume.forJobId) && job.description) await tailorForJob(job, false);
    else if (!job.resumeId && mainResume()) await S.updateJob(job.id, { resumeId: mainResume().id });
  }

  async function release(job) {
    await S.updateSession({ activeJobId: null, activeTabId: null });
    await S.addLog({ jobId: job.id, action: 'Closed out by Bruno', submissionStatus: job.status });
  }

  async function setStatus(job, status, action) {
    await S.updateJob(job.id, { status, manualReason: status === ST.MANUAL ? job.manualReason : '' });
    await S.addLog({ jobId: job.id, action, submissionStatus: status });
    if (FINISHED.includes(status) && state.session.activeJobId === job.id) await S.updateSession({ activeJobId: null, activeTabId: null });
  }

  async function markSubmitted(job) {
    await setStatus(job, ST.SUBMITTED, 'Bruno confirmed he submitted the application');
  }

  async function removeJob(job) {
    if (state.session.activeJobId === job.id) await S.updateSession({ activeJobId: null, activeTabId: null });
    await S.set('jobs', state.jobs.filter((j) => j.id !== job.id));
    await S.addLog({ job: jobName(job), url: job.url, action: 'Job removed by Bruno', submissionStatus: job.status });
  }

  // ---------------------------------------------------------------------------
  // Filling — only on Bruno's click, only in the active job's tab.
  // ---------------------------------------------------------------------------

  async function fillActive() {
    const job = activeJob();
    if (!job || state.session.activeTabId == null) return;
    if (state.session.paused) return toast('Paused — resolve the manual action first.');
    if (!state.profile.verifiedAt) return toast('Check and verify your profile first (Profile tab).');

    const url = activeTabUrl;
    const platform = R.platformFor(url);
    if (!R.canFill(platform, consents())) {
      await S.addLog({ jobId: job.id, url, action: 'Fill not performed — platform rules', details: platform.notice });
      return toast(platform.notice);
    }
    let origin;
    try {
      origin = new URL(url).origin;
    } catch (_) {
      return toast('This tab has no web page the assistant can work with.');
    }
    if (!/^https?:/.test(origin)) return toast('The assistant only works on web pages.');

    // Must be the first await so Chrome still sees Bruno's click.
    const granted = await chrome.permissions.request({ origins: [origin + '/*'] });
    if (!granted) return toast('Permission for ' + origin + ' was not granted. Nothing was filled.');

    const resume = state.resumes.find((r) => r.id === job.resumeId) || null;
    const values = {};
    for (const { key } of R.PROFILE_KEYS) if (state.profile.values[key]) values[key] = state.profile.values[key].trim();

    let report;
    try {
      const target = { tabId: state.session.activeTabId };
      await chrome.scripting.executeScript({ target, files: ['src/shared/rules.js', 'src/content/filler.js'] });
      const [res] = await chrome.scripting.executeScript({
        target,
        func: (payload) => globalThis.JobAssistFiller.run(payload),
        args: [{ jobId: job.id, profile: values, answers: state.answers, consents: consents(), resume: resume && { label: resume.label, fileName: resume.fileName, type: resume.type, dataUrl: resume.dataUrl } }],
      });
      report = res && res.result;
    } catch (err) {
      report = { ok: false, reasons: ['Unsupported page: ' + err.message] };
    }
    if (!report) report = { ok: false, reasons: ['Unsupported page: no response from the page'] };

    if (!report.ok && report.expired) {
      const reason = report.reasons.join('; ');
      await S.updateJob(job.id, { status: ST.CLOSED, manualReason: reason });
      await S.updateSession({ activeJobId: null, activeTabId: null });
      await S.addLog({ jobId: job.id, url, action: 'Posting closed — nothing filled', submissionStatus: ST.CLOSED, details: reason });
      return toast('This posting looks closed. It’s been moved to “Posting closed”.');
    }
    if (!report.ok) {
      const reason = report.reasons.join('; ');
      await S.updateJob(job.id, { status: ST.MANUAL, manualReason: reason });
      await S.updateSession({ paused: true, pauseReason: reason });
      await S.addLog({ jobId: job.id, url, action: 'Stopped before filling — manual action required', submissionStatus: ST.MANUAL, details: reason });
      return;
    }

    await S.updateJob(job.id, { status: ST.AWAITING_BRUNO });
    await S.addLog({
      jobId: job.id,
      url,
      action: 'Routine fields filled on Bruno’s click',
      resumeVersion: resume ? resume.label : '',
      fieldsCompleted: report.filled,
      fieldsForBruno: report.needsBruno.map((n) => n.label + ' (' + n.reason + ')'),
      documentsUploaded: report.uploaded,
      submissionStatus: 'Not submitted — awaiting Bruno',
    });
    toast('Filled ' + report.filled.length + ' field(s). ' + report.needsBruno.length + ' need your answer. Review, then submit yourself.');
  }

  // ---------------------------------------------------------------------------
  // Profile & resumes
  // ---------------------------------------------------------------------------

  let profileTimer = null;
  function onProfileInput() {
    clearTimeout(profileTimer);
    profileTimer = setTimeout(async () => {
      const values = {};
      for (const input of $('#profile-form').querySelectorAll('input')) values[input.name] = input.value;
      // Any change means Bruno needs to re-check the data before it's used.
      await S.set('profile', { values, verifiedAt: null });
    }, 400);
  }

  async function copy(text, label) {
    if (!text) return toast('No value saved for ' + label + '.');
    await navigator.clipboard.writeText(text);
    toast('Copied ' + label + '.');
  }

  /**
   * Load a setup file: { kind: 'job-assistant-setup', profile, answers,
   * search, resumes: [{label, fileName, dataUrl, main}] }. Only known fields
   * are taken. The profile is left unverified so Bruno checks it first.
   */
  async function loadSetup(file) {
    let data;
    try {
      data = JSON.parse(await file.text());
    } catch (_) {
      return toast('That file isn’t a readable setup file.');
    }
    if (!data || data.kind !== 'job-assistant-setup') return toast('That file isn’t a Job Assistant setup file.');
    const str = (v) => (typeof v === 'string' || typeof v === 'number' ? String(v).trim() : '');
    const loaded = [];
    const pick = (src, keys) => {
      const out = {};
      for (const k of keys) if (src && str(src[k])) out[k] = str(src[k]);
      return out;
    };
    const profile = pick(data.profile, R.PROFILE_KEYS.map((k) => k.key));
    if (Object.keys(profile).length) {
      await S.set('profile', { values: Object.assign({}, state.profile.values, profile), verifiedAt: null });
      loaded.push(Object.keys(profile).length + ' profile fields');
    }
    const answers = pick(data.answers, R.ANSWER_FIELDS.map((a) => a.key));
    if (Object.keys(answers).length) {
      await S.set('answers', Object.assign({}, state.answers, answers));
      loaded.push(Object.keys(answers).length + ' screening answers');
    }
    const search = pick(data.search, ['location', 'minSalary', 'positions']);
    if (Object.keys(search).length) {
      await S.set('search', Object.assign({}, state.search, search));
      loaded.push('search settings');
    }
    const resumes = await S.get('resumes');
    const settings = await S.get('settings');
    for (const r of Array.isArray(data.resumes) ? data.resumes : []) {
      if (!r || typeof r.dataUrl !== 'string' || !/^data:[\w./+-]+;base64,/.test(r.dataUrl) || !str(r.fileName)) continue;
      const bytes = dataUrlBytes(r.dataUrl);
      if (bytes.length > MAX_RESUME_BYTES) continue;
      if (resumes.some((x) => x.fileName === r.fileName && x.size === bytes.length && !x.forJobId)) continue;
      const isDocx = /\.docx$/i.test(r.fileName);
      let text = '';
      if (isDocx) {
        try {
          text = T.docxText(await T.readDocx(bytes));
        } catch (err) {
          toast(r.fileName + ' could not be read: ' + err.message);
          continue;
        }
      }
      const version = { id: S.uid(), label: str(r.label) || r.fileName, fileName: str(r.fileName), type: isDocx ? DOCX : 'application/pdf', size: bytes.length, dataUrl: r.dataUrl, text, addedAt: new Date().toISOString() };
      resumes.push(version);
      if (r.main || !settings.mainResumeId) settings.mainResumeId = version.id;
      loaded.push('resume “' + version.label + '”');
    }
    await S.set('resumes', resumes);
    await S.set('settings', settings);
    await S.addLog({ action: 'Setup file loaded', details: loaded.join(', ') || 'nothing new' });
    toast(loaded.length ? 'Loaded ' + loaded.join(', ') + '. Please check your profile and click “I’ve checked these details are correct”.' : 'Nothing new in that file.');
  }

  function readAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = () => reject(fr.error);
      fr.readAsDataURL(file);
    });
  }

  // ---------------------------------------------------------------------------
  // Outreach — drafts and approvals only. Nothing is ever sent from here.
  // ---------------------------------------------------------------------------

  async function setOutreach(o, status, action) {
    const all = await S.get('outreach');
    const item = all.find((x) => x.id === o.id);
    if (!item) return;
    item.status = status;
    item.updatedAt = new Date().toISOString();
    await S.set('outreach', all);
    if (o.contactId && status === 'sent_by_bruno') {
      const contacts = await S.get('contacts');
      await S.set('contacts', contacts.map((c) => (c.id === o.contactId ? Object.assign({}, c, { status: 'sent_by_bruno', contactedAt: item.updatedAt }) : c)));
    }
    await S.addLog({ jobId: o.jobId, action: action + ': ' + o.personName, details: o.kind + ' — ' + o.profileUrl, submissionStatus: status === 'sent_by_bruno' ? 'Sent by Bruno' : status });
  }

  async function editOutreach(o) {
    const form = $('#outreach-form');
    for (const k of ['personName', 'profileUrl', 'kind', 'jobId', 'text']) form.elements[k].value = o[k] || '';
    updateCount();
    await S.set('outreach', state.outreach.filter((x) => x.id !== o.id));
    form.scrollIntoView({ behavior: 'smooth' });
  }

  async function openOutreach(o) {
    await navigator.clipboard.writeText(o.text);
    await chrome.tabs.create({ url: o.profileUrl, active: true });
    toast('Text copied. Paste it on LinkedIn and click Send yourself, then mark it sent here.');
    await S.addLog({ jobId: o.jobId, action: 'Opened profile for Bruno to send outreach: ' + o.personName, details: 'Text copied to clipboard. Not sent by the assistant.', submissionStatus: 'approved' });
  }

  function updateCount() {
    const form = $('#outreach-form');
    const n = form.elements.text.value.length;
    const note = form.elements.kind.value === 'connection' && n > 200
      ? ' LinkedIn caps connection notes (about 200 characters on free accounts, 300 on paid; check the current limit).'
      : '';
    $('#outreach-count').textContent = n + ' characters.' + note;
  }

  // ---------------------------------------------------------------------------
  // Log export
  // ---------------------------------------------------------------------------

  function download(name, text, type) {
    const a = h('a', { href: URL.createObjectURL(new Blob([text], { type })), download: name });
    document.body.append(a);
    a.click();
    a.remove();
  }

  function toCsv(rows) {
    const cols = ['ts', 'job', 'url', 'action', 'resumeVersion', 'fieldsCompleted', 'fieldsForBruno', 'documentsUploaded', 'submissionStatus', 'details'];
    const esc = (v) => '"' + String(Array.isArray(v) ? v.join('; ') : v == null ? '' : v).replace(/"/g, '""') + '"';
    return [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\r\n');
  }

  // ---------------------------------------------------------------------------
  // Wiring
  // ---------------------------------------------------------------------------

  function wire() {
    document.querySelectorAll('nav button').forEach((b) =>
      b.addEventListener('click', () => {
        document.querySelectorAll('nav button').forEach((x) => x.classList.toggle('active', x === b));
        document.querySelectorAll('.tab').forEach((t) => (t.hidden = t.id !== 'tab-' + b.dataset.tab));
      })
    );

    $('#resume-btn').addEventListener('click', async () => {
      const job = activeJob();
      await S.updateSession({ paused: false, pauseReason: '' });
      if (job && job.status === ST.MANUAL) await S.updateJob(job.id, { status: ST.IN_PROGRESS, manualReason: '' });
      await S.addLog({ jobId: job && job.id, action: 'Bruno resolved the manual action and resumed', submissionStatus: job ? ST.IN_PROGRESS : '' });
    });

    $('#add-current').addEventListener('click', async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab || !/^https?:/.test(tab.url || '')) return toast('The current tab is not a web page.');
      const parsed = R.jobFromTabTitle(tab.title);
      const r = await addJobs([Object.assign({ url: tab.url }, parsed)], 'current-tab');
      if (r.added) await S.addLog({ job: tab.title, url: tab.url, action: 'Job added by Bruno from current tab', submissionStatus: ST.SELECTED });
      toast(r.added ? 'Added ' + [parsed.title, parsed.company].filter(Boolean).join(' at ') + '.' : duplicateText(r.duplicates[0]));
    });

    $('#add-job-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target.elements;
      const r = await addJobs([{ url: f.url.value.trim(), title: f.title.value.trim(), company: f.company.value.trim() }], 'manual');
      if (r.added) await S.addLog({ job: f.title.value, url: f.url.value, action: 'Job added by Bruno', submissionStatus: ST.SELECTED });
      e.target.reset();
      toast(r.added ? 'Added.' : duplicateText(r.duplicates[0]));
    });

    $('#import-file').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      e.target.value = '';
      if (!file) return;
      let parsed;
      try {
        parsed = R.parseJobImport(await file.text(), file.name);
      } catch (err) {
        return toast('Could not read that file: ' + err.message);
      }
      const r = await addJobs(parsed.jobs, 'import');
      const notes = parsed.errors.concat(r.duplicates.length ? [r.duplicates.length + ' already in your list'] : []);
      await S.addLog({ job: file.name, action: 'Imported ' + r.added + ' job(s) selected by Bruno', details: notes.join('; ') });
      toast('Imported ' + r.added + ' job(s).' + (notes.length ? ' ' + notes.join('; ') + '.' : ''));
    });

    $('#job-filter').addEventListener('change', renderJobs);
    // autoApply must run straight from the click so Chrome can ask for permission.
    $('#autoapply-start').addEventListener('click', () => autoApply());
    $('#autoapply-stop').addEventListener('click', () => {
      stopRequested = true;
      $('#autoapply-status').textContent = 'Stopping after this application…';
    });
    $('#setup-file').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      e.target.value = '';
      if (file) await loadSetup(file);
    });

    let searchTimer = null;
    for (const [sel, key] of [['#s-location', 'location'], ['#s-salary', 'minSalary'], ['#s-positions', 'positions']]) {
      $(sel).addEventListener('input', (e) => {
        state.search[key] = e.target.value;
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => S.set('search', Object.assign({}, state.search)), 300);
        renderSearch();
      });
    }
    // findJobs must run straight from the click so Chrome can show its
    // permission prompt; it saves the settings itself.
    $('#find-jobs').addEventListener('click', () => {
      clearTimeout(searchTimer);
      findJobs();
    });

    $('#save-key').addEventListener('click', async () => {
      const v = $('#api-key').value.trim();
      if (!v || v.startsWith('••')) return toast('Paste your Claude API key first.');
      if (!/^sk-ant-/.test(v)) return toast('That doesn’t look like a Claude API key (they start with sk-ant-).');
      await S.set('settings', Object.assign({}, state.settings, { apiKey: v }));
      $('#api-key').blur();
      toast('API key saved in this browser.');
    });
    $('#clear-key').addEventListener('click', () => S.set('settings', Object.assign({}, state.settings, { apiKey: '' })));
    $('#auto-discover').addEventListener('change', (e) => S.set('settings', Object.assign({}, state.settings, { autoDiscover: e.target.checked })));
    $('#source-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target.elements;
      const src = D.detectSource(f.url.value.trim());
      if (!src) return toast('That link isn’t a Greenhouse, Lever, Ashby or Workday job board.');
      if ((state.sources || []).some((x) => D.sourceId(x) === D.sourceId(src))) return toast('That job board is already on the list.');
      if (src.type === 'workday' && !(await chrome.permissions.request({ origins: D.sourceOrigins(src) }))) return toast('Chrome permission is needed to read that company’s Workday job board.');
      src.company = f.company.value.trim() || src.slug || src.tenant;
      src.enabled = true;
      await S.set('sources', [...(state.sources || []), src]);
      e.target.reset();
      toast('Added ' + src.company + '.');
    });

    $('#verify-btn').addEventListener('click', async () => {
      clearTimeout(profileTimer);
      const values = {};
      for (const input of $('#profile-form').querySelectorAll('input')) values[input.name] = input.value.trim();
      await S.set('profile', { values, verifiedAt: new Date().toISOString() });
      await S.addLog({ action: 'Profile verified by Bruno', details: Object.keys(values).filter((k) => values[k]).join(', ') });
      toast('Profile verified.');
    });

    $('#resume-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target.elements;
      const file = f.file.files[0];
      if (!file) return;
      if (file.size > MAX_RESUME_BYTES) return toast('That file is larger than 5 MB.');
      const resumes = await S.get('resumes');
      const isDocx = file.type === DOCX || /\.docx$/i.test(file.name);
      let text = '';
      if (isDocx) {
        try {
          text = T.docxText(await T.readDocx(new Uint8Array(await file.arrayBuffer())));
        } catch (err) {
          return toast('That Word file could not be read: ' + err.message);
        }
      }
      const version = { id: S.uid(), label: f.label.value.trim(), fileName: file.name, type: isDocx ? DOCX : file.type, size: file.size, dataUrl: await readAsDataUrl(file), text, addedAt: new Date().toISOString() };
      resumes.push(version);
      await S.set('resumes', resumes);
      const settings = await S.get('settings');
      if (!settings.mainResumeId || !resumes.some((r) => r.id === settings.mainResumeId)) await S.set('settings', Object.assign(settings, { mainResumeId: version.id }));
      e.target.reset();
      toast(isDocx ? 'Resume saved. It can be tailored for each job.' : 'Resume saved. Upload a Word (.docx) version too if you want it tailored for each job.');
    });

    const of = $('#outreach-form');
    of.elements.text.addEventListener('input', updateCount);
    of.elements.kind.addEventListener('change', updateCount);
    of.addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = of.elements;
      const host = R.hostOf(f.profileUrl.value);
      if (!(host === 'linkedin.com' || host.endsWith('.linkedin.com'))) return toast('Enter a linkedin.com profile URL.');
      const all = await S.get('outreach');
      const already = all.find((x) => C.normalizeProfileUrl(x.profileUrl) === C.normalizeProfileUrl(f.profileUrl.value) && x.kind === f.kind.value && x.status !== 'declined');
      if (already) return toast('You already have a ' + (already.kind === 'connection' ? 'connection request' : 'message') + ' for ' + already.personName + ' (' + already.status.replace(/_/g, ' ') + ').');
      const item = { id: S.uid(), personName: f.personName.value.trim(), profileUrl: f.profileUrl.value.trim(), kind: f.kind.value, jobId: f.jobId.value || null, text: f.text.value.trim(), status: 'draft', createdAt: new Date().toISOString() };
      all.push(item);
      await S.set('outreach', all);
      await S.addLog({ jobId: item.jobId, action: 'Outreach draft queued for approval: ' + item.personName, details: item.kind, submissionStatus: 'draft' });
      of.reset();
      updateCount();
    });

    $('#export-json').addEventListener('click', () => download('job-assistant-log.json', JSON.stringify(state.log, null, 2), 'application/json'));
    $('#export-csv').addEventListener('click', () => download('job-assistant-log.csv', toCsv(state.log), 'text/csv'));
    $('#clear-log').replaceWith(
      confirmButton('Clear log', 'Confirm: delete the whole log', async () => {
        await S.set('log', []);
      }, 'danger')
    );

    chrome.storage.onChanged.addListener((_, area) => area === 'local' && refresh());
    chrome.tabs.onUpdated.addListener((tabId, info) => {
      if (state && tabId === state.session.activeTabId && info.url) {
        activeTabUrl = info.url;
        renderActive();
      }
    });
    chrome.tabs.onRemoved.addListener(() => refresh());
  }

  wire();
  renderRules();
  updateCount();
  refresh();
})();
