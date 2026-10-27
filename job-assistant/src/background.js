/*
 * Background service worker. It does no browsing of its own: it opens the side
 * panel and records events reported by the filler in the one tab Bruno is
 * working on.
 */
importScripts('shared/rules.js', 'shared/store.js', 'shared/discovery.js');

const R = globalThis.JobAssistRules;
const S = globalThis.JobAssistStore;
const D = globalThis.JobAssistDiscovery;
const ALARM = 'daily-discovery';

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  syncAlarm();
});
chrome.runtime.onStartup.addListener(syncAlarm);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings) syncAlarm();
});

// Optional daily search of the company job boards (off by default). It only
// reads public job listings; it never opens, fills or submits anything.
async function syncAlarm() {
  const settings = await S.get('settings');
  const existing = await chrome.alarms.get(ALARM);
  if (settings.autoDiscover && !existing) chrome.alarms.create(ALARM, { periodInMinutes: 24 * 60, delayInMinutes: 1 });
  if (!settings.autoDiscover && existing) chrome.alarms.clear(ALARM);
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM) discover().catch((err) => console.error('Job Assistant discovery:', err));
});

async function discover() {
  const [search, sources, jobs, resumes, settings] = await Promise.all([S.get('search'), S.get('sources'), S.get('jobs'), S.get('resumes'), S.get('settings')]);
  if (!search.positions || !sources || !sources.length) return;
  const main = resumes.find((r) => r.id === settings.mainResumeId) || resumes[0];
  const out = await D.runDiscovery({ settings: search, sources, jobs, resumeText: (main && main.text) || '', fetchFn: fetch.bind(globalThis) });
  await chrome.storage.local.set({ jobs: out.jobs, sources: out.sources, discovery: { lastRun: new Date().toISOString(), summary: out.summary } });
  await S.addLog({ action: 'Daily job search: ' + out.summary.added + ' new match(es)', details: out.summary.errors.join('; '), submissionStatus: '' });
  if (out.summary.added) chrome.action.setBadgeText({ text: String(out.summary.added) });
}

chrome.runtime.onMessage.addListener((msg, sender) => {
  // Only accept reports from the tab Bruno opened for the active job.
  handle(msg, sender).catch((err) => console.error('Job Assistant:', err));
});

async function handle(msg, sender) {
  const session = await S.get('session');
  if (!sender.tab || sender.tab.id !== session.activeTabId || msg.jobId !== session.activeJobId) return;

  if (msg.type === 'safety-stop') {
    await S.updateJob(msg.jobId, { status: R.STATUS.MANUAL, manualReason: msg.reasons.join('; ') });
    await S.updateSession({ paused: true, pauseReason: msg.reasons.join('; ') });
    await S.addLog({
      jobId: msg.jobId,
      url: msg.url,
      action: 'Paused — manual action required',
      submissionStatus: R.STATUS_LABEL[R.STATUS.MANUAL],
      details: msg.reasons.join('; '),
    });
  } else if (msg.type === 'submit-confirmed') {
    await confirmSubmitted(msg.jobId, msg.url);
  } else if (msg.type === 'auto-submitted') {
    // The assistant clicked Submit under Bruno's approval. Not "submitted"
    // until the site confirms; the side panel waits for that.
    await S.updateJob(msg.jobId, { submitObservedAt: new Date().toISOString(), submittedBy: 'assistant (automatic submission you approved)' });
  } else if (msg.type === 'submit-observed') {
    const jobs = await S.get('jobs');
    const job = jobs.find((j) => j.id === msg.jobId);
    // A single click can produce both a click and a submit event; log once per minute.
    if (job && job.submitObservedAt && Date.now() - Date.parse(job.submitObservedAt) < 60000) return;
    await S.updateJob(msg.jobId, { submitObservedAt: new Date().toISOString() });
    await S.addLog({
      jobId: msg.jobId,
      url: msg.url,
      action: 'Submit click by Bruno observed',
      submissionStatus: 'Awaiting Bruno’s confirmation',
      details: 'Bruno clicked a Submit control. Confirm in the side panel once the site shows a confirmation.',
    });
  }
}

async function confirmSubmitted(jobId, url) {
  const jobs = await S.get('jobs');
  const job = jobs.find((j) => j.id === jobId);
  if (!job || job.status === R.STATUS.SUBMITTED) return;
  await S.updateJob(jobId, { status: R.STATUS.SUBMITTED, submittedAt: new Date().toISOString(), confirmedBy: 'the site’s confirmation page' });
  const who = job.submittedBy || 'Bruno';
  await S.addLog({ jobId, url, action: 'Submission confirmed by the site', submissionStatus: R.STATUS.SUBMITTED, details: 'Submitted by ' + who + '; the site showed an application-received page.' });
}

// After Bruno clicks Submit the site usually loads a new "thank you" page,
// where the filler is no longer running. Check that page's text once.
chrome.tabs.onUpdated.addListener(async (tabId, info) => {
  if (info.status !== 'complete') return;
  const session = await S.get('session');
  if (tabId !== session.activeTabId || !session.activeJobId) return;
  const jobs = await S.get('jobs');
  const job = jobs.find((j) => j.id === session.activeJobId);
  if (!job || !job.submitObservedAt || job.status === R.STATUS.SUBMITTED) return;
  if (Date.now() - Date.parse(job.submitObservedAt) > 15 * 60 * 1000) return;
  try {
    const [res] = await chrome.scripting.executeScript({ target: { tabId }, func: () => (document.body ? document.body.innerText.slice(0, 5000) : '') });
    if (res && R.isConfirmation(res.result)) await confirmSubmitted(job.id, (await chrome.tabs.get(tabId)).url);
  } catch (_) {
    // No access to that page (different site); Bruno confirms by hand.
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const session = await S.get('session');
  if (session.activeTabId === tabId) await S.updateSession({ activeTabId: null });
});
