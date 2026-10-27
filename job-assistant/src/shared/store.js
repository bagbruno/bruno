/*
 * Thin wrapper over chrome.storage.local, shared by the background worker and
 * the side panel. All data stays on Bruno's computer.
 */
(function (root) {
  'use strict';

  const DEFAULTS = {
    profile: { values: {}, verifiedAt: null },
    resumes: [],
    jobs: [],
    outreach: [],
    log: [],
    session: { activeJobId: null, activeTabId: null, paused: false, pauseReason: '' },
    // The three search settings Bruno adjusts.
    search: { location: '', minSalary: '', positions: '' },
    // Company job boards searched by "Find jobs". Seeded once with defaults.
    sources: null,
    // Bruno's own answers to common screening questions.
    answers: {},
    // People Bruno may contact, de-duplicated by LinkedIn profile URL.
    contacts: [],
    settings: { apiKey: '', autoDiscover: false, mainResumeId: null },
    discovery: { lastRun: null, summary: null },
  };

  const MAX_LOG = 5000;

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  async function get(key) {
    const out = await chrome.storage.local.get(key);
    return out[key] === undefined || out[key] === null ? structuredClone(DEFAULTS[key]) : out[key];
  }

  async function getAll() {
    const out = await chrome.storage.local.get(Object.keys(DEFAULTS));
    for (const k of Object.keys(DEFAULTS)) if (out[k] === undefined || out[k] === null) out[k] = structuredClone(DEFAULTS[k]);
    return out;
  }

  function set(key, value) {
    return chrome.storage.local.set({ [key]: value });
  }

  async function updateJob(id, patch) {
    const jobs = await get('jobs');
    const job = jobs.find((j) => j.id === id);
    if (!job) return null;
    Object.assign(job, patch, { updatedAt: new Date().toISOString() });
    await set('jobs', jobs);
    return job;
  }

  async function updateSession(patch) {
    const s = Object.assign(await get('session'), patch);
    await set('session', s);
    return s;
  }

  /**
   * Append an activity-log entry. Every entry records the job, resume version,
   * fields completed, documents uploaded and submission status, even when some
   * of those are empty, so the log reads the same way throughout.
   */
  async function addLog(entry) {
    const [log, jobs, resumes] = await Promise.all([get('log'), get('jobs'), get('resumes')]);
    const job = jobs.find((j) => j.id === entry.jobId);
    const resume = job && resumes.find((r) => r.id === job.resumeId);
    log.push({
      id: uid(),
      ts: new Date().toISOString(),
      jobId: entry.jobId || null,
      job: job ? [job.title || '(untitled)', job.company].filter(Boolean).join(' — ') : entry.job || '',
      url: entry.url || (job && job.url) || '',
      action: entry.action,
      resumeVersion: entry.resumeVersion !== undefined ? entry.resumeVersion : resume ? resume.label : '',
      fieldsCompleted: entry.fieldsCompleted || [],
      fieldsForBruno: entry.fieldsForBruno || [],
      documentsUploaded: entry.documentsUploaded || [],
      submissionStatus: entry.submissionStatus || (job ? job.status : ''),
      details: entry.details || '',
    });
    if (log.length > MAX_LOG) log.splice(0, log.length - MAX_LOG);
    await set('log', log);
  }

  const api = { DEFAULTS, uid, get, getAll, set, updateJob, updateSession, addLog };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.JobAssistStore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
