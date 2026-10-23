/*
 * Background service worker. It does no browsing of its own: it opens the side
 * panel and records events reported by the filler in the one tab Bruno is
 * working on.
 */
importScripts('shared/rules.js', 'shared/store.js');

const R = globalThis.JobAssistRules;
const S = globalThis.JobAssistStore;

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

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

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const session = await S.get('session');
  if (session.activeTabId === tabId) await S.updateSession({ activeTabId: null });
});
