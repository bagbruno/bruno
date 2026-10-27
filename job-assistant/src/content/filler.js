/*
 * Injected into the one application tab Bruno is working on, only when he
 * clicks "Fill routine fields" in the side panel. rules.js is injected first.
 *
 * This script:
 *   - checks the page for CAPTCHAs, security/account messages, sign-in prompts
 *     and unsupported layouts, and stops if it finds any;
 *   - fills empty routine fields from Bruno's verified profile;
 *   - attaches the resume version Bruno chose for this job;
 *   - outlines everything else for Bruno to answer himself;
 *   - keeps watching for security prompts and reports Bruno's own Submit click.
 *
 * It never clicks buttons, never submits, and never overwrites what Bruno typed.
 */
(function () {
  'use strict';
  if (globalThis.JobAssistFiller) return;

  const R = globalThis.JobAssistRules;
  const OUTLINE = {
    filled: '2px solid #1a7f37',
    attention: '3px solid #d97706',
    sensitive: '3px solid #b42318',
  };

  let watcher = null;
  let activeJobId = null;
  let stopped = false;

  function send(msg) {
    try {
      if (globalThis.chrome && chrome.runtime && chrome.runtime.sendMessage) chrome.runtime.sendMessage(msg);
    } catch (_) {
      // Extension reloaded or tab detached; nothing useful to do.
    }
  }

  // ---------------------------------------------------------------------------
  // Page inspection
  // ---------------------------------------------------------------------------

  function isVisible(el) {
    if (!el.getClientRects().length) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none';
  }

  function controls() {
    return Array.from(document.querySelectorAll('input, select, textarea')).filter((el) => {
      const type = (el.getAttribute('type') || '').toLowerCase();
      if (['hidden', 'submit', 'button', 'reset', 'image', 'search'].includes(type)) return false;
      if (el.disabled || el.readOnly) return false;
      // File inputs are often visually hidden behind a styled button.
      return type === 'file' || isVisible(el);
    });
  }

  function textOf(el) {
    return el ? (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim() : '';
  }

  function labelFor(el) {
    if (el.labels && el.labels.length) return textOf(el.labels[0]);
    const by = el.getAttribute('aria-labelledby');
    if (by) {
      const t = by.split(/\s+/).map((id) => textOf(document.getElementById(id))).join(' ').trim();
      if (t) return t;
    }
    // Borrow text from a wrapper only while that wrapper holds just this one
    // field; otherwise it's another field's label and must not be guessed.
    let node = el.parentElement;
    for (let i = 0; i < 3 && node; i++, node = node.parentElement) {
      if (node.querySelectorAll('input:not([type="hidden"]), select, textarea').length > 1) break;
      const lab = node.querySelector('label, legend');
      if (lab && !lab.contains(el)) return textOf(lab);
      if (el.tagName !== 'SELECT') {
        const t = textOf(node);
        if (t && t.length < 120) return t;
      }
    }
    return '';
  }

  // For a radio/checkbox inside a group, the question is the group's legend.
  function groupLabel(el) {
    const fs = el.closest('fieldset');
    const legend = fs && fs.querySelector('legend');
    return legend ? textOf(legend) : '';
  }

  function describe(el) {
    const type = (el.getAttribute('type') || (el.tagName === 'SELECT' ? 'select' : 'text')).toLowerCase();
    const group = type === 'radio' || type === 'checkbox' ? groupLabel(el) : '';
    return {
      tag: el.tagName.toLowerCase(),
      type,
      label: group || labelFor(el),
      name: el.getAttribute('name') || '',
      id: el.id || '',
      placeholder: el.getAttribute('placeholder') || '',
      ariaLabel: el.getAttribute('aria-label') || '',
      autocomplete: el.getAttribute('autocomplete') || '',
    };
  }

  // Challenge pages and account warnings are short pages or modal dialogs.
  // Scanning only those (rather than a long job description) avoids stopping
  // on a posting that merely mentions "security checks".
  function warningText() {
    const parts = [];
    document.querySelectorAll('[role="dialog"], [role="alertdialog"], [role="alert"], [aria-live], dialog[open], h1, h2, h3').forEach((n) => {
      if (isVisible(n)) parts.push(textOf(n));
    });
    const body = textOf(document.body);
    if (body.length < 3000) parts.push(body);
    return parts.join('\n');
  }

  // Many application forms load an invisible CAPTCHA that only runs if the
  // site decides to challenge. Stop when one is actually shown on screen, not
  // because the script is present. The small reCAPTCHA corner badge is a
  // notice, not a challenge.
  function presented(el) {
    if (el.closest('.grecaptcha-badge') || el.getAttribute('data-size') === 'invisible') return false;
    if (el.tagName === 'BUTTON' || el.tagName === 'INPUT') return false;
    const r = el.getBoundingClientRect();
    return r.width > 20 && r.height > 20 && isVisible(el);
  }

  function snapshot(fillable) {
    const iframes = Array.from(document.querySelectorAll('iframe'));
    let crossOrigin = 0;
    for (const f of iframes) {
      try {
        const u = new URL(f.src, location.href);
        if (u.origin !== location.origin && !R.CAPTCHA_SRC.test(f.src) && isVisible(f) && f.offsetHeight > 200) crossOrigin++;
      } catch (_) {}
    }
    return {
      url: location.href,
      text: warningText(),
      iframeSrcs: iframes.filter(presented).map((f) => f.src || ''),
      captchaElementCount: Array.from(document.querySelectorAll(R.CAPTCHA_SELECTORS.join(','))).filter(presented).length,
      visiblePasswordFields: Array.from(document.querySelectorAll('input[type="password"]')).filter(isVisible).length,
      fillableFieldCount: fillable,
      crossOriginFormFrames: crossOrigin,
    };
  }

  // ---------------------------------------------------------------------------
  // Filling
  // ---------------------------------------------------------------------------

  function setNativeValue(el, value) {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function fillSelect(el, value) {
    const want = String(value).trim().toLowerCase();
    const opt = Array.from(el.options).find((o) => o.text.trim().toLowerCase() === want || o.value.trim().toLowerCase() === want);
    if (!opt) return false;
    setNativeValue(el, opt.value);
    return true;
  }

  function attachFile(el, doc) {
    // Decode by hand rather than fetch(): some page CSPs block data: URLs.
    const b64 = doc.dataUrl.slice(doc.dataUrl.indexOf(',') + 1);
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const file = new File([bytes], doc.fileName, { type: doc.type || 'application/octet-stream' });
    const dt = new DataTransfer();
    dt.items.add(file);
    el.files = dt.files;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function isEmpty(el) {
    if (el.type === 'radio') return !document.querySelector('input[type="radio"][name="' + CSS.escape(el.name) + '"]:checked');
    if (el.type === 'checkbox') return !el.checked;
    if (el.type === 'file') return !el.files || el.files.length === 0;
    if (el.tagName === 'SELECT') return el.selectedIndex <= 0 || !el.value;
    return !el.value;
  }

  function mark(el, style, title) {
    el.style.outline = style;
    el.style.outlineOffset = '2px';
    if (title) el.title = 'Job Assistant: ' + title;
  }

  // ---------------------------------------------------------------------------
  // On-page banner
  // ---------------------------------------------------------------------------

  function banner(kind, heading, lines) {
    let host = document.getElementById('job-assist-banner');
    if (!host) {
      host = document.createElement('div');
      host.id = 'job-assist-banner';
      host.attachShadow({ mode: 'open' });
      document.documentElement.appendChild(host);
    }
    const color = kind === 'stop' ? '#b42318' : '#1d4ed8';
    const items = lines.map((l) => '<li>' + escapeHtml(l) + '</li>').join('');
    host.shadowRoot.innerHTML =
      '<style>' +
      '.b{position:fixed;right:16px;bottom:16px;z-index:2147483647;max-width:360px;font:13px/1.45 system-ui,sans-serif;' +
      'background:#fff;color:#111;border:2px solid ' + color + ';border-radius:10px;padding:12px 14px;box-shadow:0 8px 24px rgba(0,0,0,.18)}' +
      'h4{margin:0 0 6px;font-size:14px;color:' + color + '}ul{margin:0;padding-left:18px}' +
      'button{margin-top:8px;font:inherit;border:1px solid #999;background:#f5f5f5;border-radius:6px;padding:2px 10px;cursor:pointer}' +
      '</style><div class="b" role="status"><h4>' + escapeHtml(heading) + '</h4><ul>' + items + '</ul><button type="button">Dismiss</button></div>';
    host.shadowRoot.querySelector('button').addEventListener('click', () => host.remove());
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ---------------------------------------------------------------------------
  // Watching after fill
  // ---------------------------------------------------------------------------

  function safetyStop(reasons) {
    if (stopped) return;
    stopped = true;
    if (watcher) watcher.disconnect();
    watcher = null;
    banner('stop', 'Job Assistant paused — manual action required', reasons.concat(['Handle this yourself. The assistant will not continue on this page.']));
    send({ type: 'safety-stop', jobId: activeJobId, url: location.href, reasons });
  }

  let listening = false;

  function startWatching() {
    if (watcher) return;
    let timer = null;
    watcher = new MutationObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        // After submission the form disappears; that's expected, so only the
        // CAPTCHA / security / sign-in checks apply here.
        const result = R.assessPage(Object.assign(snapshot(1), { url: location.href }));
        if (result.stop) safetyStop(result.reasons);
      }, 400);
    });
    watcher.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    if (listening) return;
    listening = true;

    const onSubmit = (e) => {
      if (!e.isTrusted || stopped) return; // only Bruno's own action counts
      send({ type: 'submit-observed', jobId: activeJobId, url: location.href });
    };
    document.addEventListener('submit', onSubmit, true);
    document.addEventListener(
      'click',
      (e) => {
        const btn = e.target && e.target.closest && e.target.closest('button, input[type="submit"], [role="button"]');
        if (btn && /\bsubmit\b/i.test(textOf(btn) || btn.value || '')) onSubmit(e);
      },
      true
    );
  }

  // ---------------------------------------------------------------------------
  // Entry point
  // ---------------------------------------------------------------------------

  /**
   * @param {object} payload { jobId, profile: {key: value}, resume: {label, fileName, type, dataUrl} | null }
   */
  async function run(payload) {
    activeJobId = payload.jobId;
    stopped = false;
    const els = controls();
    const check = R.assessPage(snapshot(els.length));
    if (check.stop) {
      stopped = true;
      banner('stop', 'Job Assistant stopped — manual action required', check.reasons);
      return { ok: false, reasons: check.reasons };
    }

    const report = { ok: true, filled: [], uploaded: [], needsBruno: [], alreadyAnswered: [] };
    const seenGroups = new Set();
    for (const el of els) {
      if (el.type === 'radio' && el.name) {
        if (seenGroups.has(el.name)) {
          if (isEmpty(el)) mark(el, OUTLINE.attention, 'choice question — answer this yourself');
          continue;
        }
        seenGroups.add(el.name);
      }
      const d = describe(el);
      const label = d.label || d.ariaLabel || d.placeholder || d.name || d.id || '(unlabelled field)';
      const c = R.classifyField(d);

      if (c.kind === 'sensitive') {
        mark(el, OUTLINE.sensitive, 'sensitive (' + c.reason + ') — answer this yourself');
        report.needsBruno.push({ label, reason: 'Sensitive: ' + c.reason });
        continue;
      }
      if (c.kind === 'unclear') {
        if (isEmpty(el)) {
          mark(el, OUTLINE.attention, c.reason + ' — answer this yourself');
          report.needsBruno.push({ label, reason: c.reason });
        }
        continue;
      }
      if (!isEmpty(el)) {
        report.alreadyAnswered.push(label);
        continue;
      }
      if (c.kind === 'resume') {
        if (!payload.resume) {
          mark(el, OUTLINE.attention, 'no resume version chosen for this job');
          report.needsBruno.push({ label, reason: 'No resume version selected for this job' });
          continue;
        }
        try {
          await attachFile(el, payload.resume);
          mark(el, OUTLINE.filled, 'attached ' + payload.resume.fileName);
          report.uploaded.push(payload.resume.fileName + ' (' + payload.resume.label + ')');
        } catch (err) {
          mark(el, OUTLINE.attention, 'could not attach resume');
          report.needsBruno.push({ label, reason: 'Could not attach resume automatically — upload it yourself' });
        }
        continue;
      }
      // routine
      const value = payload.profile[c.key];
      if (!value) {
        mark(el, OUTLINE.attention, 'no profile value for ' + c.key);
        report.needsBruno.push({ label, reason: 'No value in your profile for this field' });
        continue;
      }
      const ok = el.tagName === 'SELECT' ? fillSelect(el, value) : (setNativeValue(el, value), true);
      if (ok) {
        mark(el, OUTLINE.filled, 'filled from your profile — please check');
        report.filled.push(label);
      } else {
        mark(el, OUTLINE.attention, 'no matching option');
        report.needsBruno.push({ label, reason: 'No option matches your profile value' });
      }
    }

    startWatching();
    banner('info', 'Job Assistant filled ' + report.filled.length + ' routine field(s)', [
      report.needsBruno.length + ' field(s) outlined in orange/red need your answer.',
      report.uploaded.length ? 'Attached: ' + report.uploaded.join(', ') : 'No documents attached.',
      'Check every answer. You make the final Submit click — the assistant never will.',
    ]);
    return report;
  }

  globalThis.JobAssistFiller = { run, snapshot: () => snapshot(controls().length), classifyAll: () => controls().map((el) => ({ d: describe(el), c: R.classifyField(describe(el)) })) };
})();
