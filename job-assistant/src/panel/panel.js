/* Side panel: everything Bruno sees and every action he takes. */
(function () {
  'use strict';

  const R = globalThis.JobAssistRules;
  const S = globalThis.JobAssistStore;
  const ST = R.STATUS;
  const FINISHED = [ST.SUBMITTED, ST.SKIPPED];
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

  function jobName(job) {
    return [job.title || '(untitled job)', job.company].filter(Boolean).join(' — ');
  }

  function activeJob() {
    return state.jobs.find((j) => j.id === state.session.activeJobId) || null;
  }

  async function refresh() {
    state = await S.getAll();
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
    renderActive();
    renderJobs();
    renderProfile();
    renderResumes();
    renderOutreach();
    renderLog();
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
      h('div', { class: 'alert ' + (platform.fill === 'blocked' ? 'warn' : 'info') }, platform.notice)
    );
    if (job.status === ST.MANUAL && job.manualReason) box.append(h('div', { class: 'alert stop' }, 'Manual action required: ' + job.manualReason));
    if (job.submitObservedAt && job.status !== ST.SUBMITTED) {
      box.append(h('div', { class: 'alert warn' }, 'You clicked Submit on this page. Once the site shows a confirmation, mark it submitted below.'));
    }

    const canFill = !state.session.paused && state.session.activeTabId != null && platform.fill !== 'blocked' && !FINISHED.includes(job.status);
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
    const jobs = state.jobs.filter((j) => (filter === 'all' ? true : filter === 'open' ? !FINISHED.includes(j.status) : j.status === filter));
    if (!jobs.length) list.append(h('li', { class: 'meta' }, 'No jobs here yet.'));
    for (const job of jobs) {
      const platform = R.platformFor(job.url);
      const isActive = job.id === state.session.activeJobId;
      list.append(
        h('li', {},
          h('div', { class: 'title' }, jobName(job)),
          h('div', { class: 'meta' }, job.url),
          h('div', { class: 'row' },
            h('span', { class: 'chip ' + job.status }, R.STATUS_LABEL[job.status]),
            platform.fill === 'blocked' ? h('span', { class: 'chip manual_action_required', title: platform.notice }, platform.name + ': fill by hand') : null
          ),
          job.status === ST.MANUAL && job.manualReason ? h('div', { class: 'meta' }, job.manualReason) : null,
          h('label', {}, 'Resume version',
            h('select', { onchange: (e) => S.updateJob(job.id, { resumeId: e.target.value || null }) },
              h('option', { value: '' }, '— none —'),
              state.resumes.map((r) => h('option', { value: r.id, selected: r.id === job.resumeId }, r.label))
            )
          ),
          h('div', { class: 'row' },
            isActive ? h('strong', {}, 'Open now') : h('button', { type: 'button', disabled: FINISHED.includes(job.status), onclick: () => openJob(job) }, 'Open application'),
            job.status === ST.MANUAL ? h('button', { type: 'button', onclick: () => setStatus(job, ST.SELECTED, 'Bruno cleared manual-action flag') }, 'Clear flag') : null,
            confirmButton('Remove', 'Confirm remove', () => removeJob(job), 'danger')
          )
        )
      );
    }
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
          h('div', { class: 'title' }, r.label),
          h('div', { class: 'meta' }, r.fileName + ' · ' + Math.round(r.size / 1024) + ' KB · added ' + new Date(r.addedAt).toLocaleDateString()),
          confirmButton('Delete', 'Confirm delete', async () => {
            await S.set('resumes', state.resumes.filter((x) => x.id !== r.id));
          }, 'danger')
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

  async function addJobs(items, source) {
    const jobs = await S.get('jobs');
    const known = new Set(jobs.map((j) => j.url));
    const now = new Date().toISOString();
    let added = 0;
    for (const it of items) {
      if (known.has(it.url)) continue;
      known.add(it.url);
      jobs.push({ id: S.uid(), url: it.url, title: it.title || '', company: it.company || '', notes: it.notes || '', status: ST.SELECTED, resumeId: null, source, addedAt: now, updatedAt: now });
      added++;
    }
    await S.set('jobs', jobs);
    return added;
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
    const tab = await chrome.tabs.create({ url: job.url, active: true });
    await S.updateSession({ activeJobId: job.id, activeTabId: tab.id });
    if (job.status === ST.SELECTED) await S.updateJob(job.id, { status: ST.IN_PROGRESS });
    await S.addLog({ jobId: job.id, action: 'Application opened by Bruno', submissionStatus: ST.IN_PROGRESS });
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
    if (platform.fill === 'blocked') {
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
        args: [{ jobId: job.id, profile: values, resume: resume && { label: resume.label, fileName: resume.fileName, type: resume.type, dataUrl: resume.dataUrl } }],
      });
      report = res && res.result;
    } catch (err) {
      report = { ok: false, reasons: ['Unsupported page: ' + err.message] };
    }
    if (!report) report = { ok: false, reasons: ['Unsupported page: no response from the page'] };

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
      const added = await addJobs([{ url: tab.url, title: tab.title }], 'current-tab');
      if (added) await S.addLog({ job: tab.title, url: tab.url, action: 'Job added by Bruno from current tab', submissionStatus: ST.SELECTED });
      toast(added ? 'Added. Edit the company name in the list if needed.' : 'That job is already in your list.');
    });

    $('#add-job-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target.elements;
      const added = await addJobs([{ url: f.url.value.trim(), title: f.title.value.trim(), company: f.company.value.trim() }], 'manual');
      if (added) await S.addLog({ job: f.title.value, url: f.url.value, action: 'Job added by Bruno', submissionStatus: ST.SELECTED });
      e.target.reset();
      toast(added ? 'Added.' : 'That job is already in your list.');
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
      const added = await addJobs(parsed.jobs, 'import');
      await S.addLog({ job: file.name, action: 'Imported ' + added + ' job(s) selected by Bruno', details: parsed.errors.join('; ') });
      toast('Imported ' + added + ' job(s).' + (parsed.errors.length ? ' ' + parsed.errors.length + ' problem(s) — see the log.' : ''));
    });

    $('#job-filter').addEventListener('change', renderJobs);

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
      resumes.push({ id: S.uid(), label: f.label.value.trim(), fileName: file.name, type: file.type, size: file.size, dataUrl: await readAsDataUrl(file), addedAt: new Date().toISOString() });
      await S.set('resumes', resumes);
      e.target.reset();
      toast('Resume version saved.');
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
