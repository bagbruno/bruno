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

  // Fill a screening question with Bruno's saved wording. Choices must match
  // his answer clearly; otherwise it's left for him.
  function fillAnswer(el, answer) {
    const want = String(answer).trim().toLowerCase();
    const same = (t) => {
      const x = String(t || '').trim().toLowerCase();
      return x === want || (want.length >= 2 && (x.startsWith(want + ' ') || x.startsWith(want + ',') || x.startsWith(want + '.')));
    };
    if (el.tagName === 'SELECT') {
      const opt = Array.from(el.options).find((o) => o.value && (same(o.text) || same(o.value)));
      if (!opt) return false;
      setNativeValue(el, opt.value);
      return true;
    }
    if (el.type === 'radio') {
      const group = el.name ? Array.from(document.querySelectorAll('input[type="radio"][name="' + CSS.escape(el.name) + '"]')) : [el];
      const pick = group.find((r) => same(r.labels && r.labels[0] ? textOf(r.labels[0]) : '') || same(r.value));
      if (!pick) return false;
      pick.click();
      return pick.checked;
    }
    if (el.type === 'checkbox') return false;
    setNativeValue(el, answer);
    return true;
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
  let consents = {};
  let submitClicked = false;
  let confirmed = false;

  function startWatching() {
    if (watcher) return;
    let timer = null;
    watcher = new MutationObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        // After submission the form disappears; that's expected, so only the
        // CAPTCHA / security / sign-in checks apply here.
        const snap = snapshot(1);
        if (submitClicked && !confirmed && R.isConfirmation(snap.text)) {
          confirmed = true;
          send({ type: 'submit-confirmed', jobId: activeJobId, url: location.href });
          banner('info', 'Application submitted', ['The site confirmed your application. It’s marked submitted in the log.']);
          return;
        }
        const result = R.assessPage(Object.assign(snap, { url: location.href }), consents);
        const reasons = result.reasons.filter((r) => !/^Posting closed/.test(r));
        if (reasons.length) safetyStop(reasons);
      }, 400);
    });
    watcher.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    if (listening) return;
    listening = true;

    const onSubmit = (e) => {
      if (!e.isTrusted || stopped) return; // only Bruno's own action counts
      submitClicked = true;
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

  function isRequired(el, label) {
    if (el.type === 'radio' && el.name) {
      const group = Array.from(document.querySelectorAll('input[type="radio"][name="' + CSS.escape(el.name) + '"]'));
      if (group.some((r) => r.required || r.getAttribute('aria-required') === 'true')) return true;
    }
    return !!(el.required || el.getAttribute('aria-required') === 'true' || /\*\s*$|\(required\)/i.test(label));
  }

  // What a field currently holds, as Bruno would read it.
  function shownValue(el) {
    if (el.type === 'file') return el.files && el.files[0] ? el.files[0].name : '';
    if (el.type === 'checkbox') return el.checked ? 'Checked' : '';
    if (el.type === 'radio') {
      const group = el.name ? Array.from(document.querySelectorAll('input[type="radio"][name="' + CSS.escape(el.name) + '"]')) : [el];
      const on = group.find((r) => r.checked);
      return on ? (on.labels && on.labels[0] ? textOf(on.labels[0]) : on.value) : '';
    }
    if (el.tagName === 'SELECT') return el.value ? textOf(el.options[el.selectedIndex]) || el.value : '';
    return el.value || '';
  }

  const same = (a, b) => String(a || '').trim().toLowerCase().replace(/\s+/g, ' ') === String(b || '').trim().toLowerCase().replace(/\s+/g, ' ');

  /**
   * @param {object} payload { jobId, profile: {key: value}, answers, consents,
   *   resume: {label, fileName, type, dataUrl} | null,
   *   autoSubmit?: { jobTitle, company, declarations: ['privacy', 'accuracy'] } }
   */
  async function run(payload) {
    activeJobId = payload.jobId;
    consents = payload.consents || {};
    stopped = false;
    const els = controls();
    const check = R.assessPage(snapshot(els.length), consents);
    if (check.stop) {
      stopped = true;
      banner('stop', check.expired ? 'Job Assistant stopped — this posting looks closed' : 'Job Assistant stopped — manual action required', check.reasons);
      return { ok: false, reasons: check.reasons, expired: !!check.expired };
    }

    const report = { ok: true, filled: [], uploaded: [], needsBruno: [], alreadyAnswered: [] };
    // Every field and what happened to it, for the pre-submit checks.
    const items = [];
    const track = (el, label, c, status, reason) => items.push({ el, label, kind: c.kind, key: c.key, status, reason, required: isRequired(el, label) });
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

      if (c.kind === 'answer') {
        const answer = (payload.answers || {})[c.key];
        if (!isEmpty(el)) {
          report.alreadyAnswered.push(label);
          track(el, label, c, 'prefilled');
        } else if (!answer) {
          mark(el, OUTLINE.attention, 'no saved answer — answer this yourself');
          report.needsBruno.push({ label, reason: 'No saved answer for this question' });
          track(el, label, c, 'left', 'no saved answer');
        } else if (fillAnswer(el, answer)) {
          mark(el, OUTLINE.attention, 'filled from your saved answer — check it');
          report.filled.push(label + ' (your saved answer)');
          track(el, label, c, 'filled');
        } else {
          mark(el, OUTLINE.attention, 'your saved answer doesn’t match the choices');
          report.needsBruno.push({ label, reason: 'Your saved answer doesn’t match the choices here' });
          track(el, label, c, 'left', 'saved answer doesn’t match the choices');
        }
        continue;
      }
      if (c.kind === 'sensitive') {
        mark(el, OUTLINE.sensitive, 'sensitive (' + c.reason + ') — answer this yourself');
        report.needsBruno.push({ label, reason: 'Sensitive: ' + c.reason });
        track(el, label, c, isEmpty(el) ? 'left' : 'prefilled', c.reason);
        continue;
      }
      if (c.kind === 'unclear') {
        if (isEmpty(el)) {
          mark(el, OUTLINE.attention, c.reason + ' — answer this yourself');
          report.needsBruno.push({ label, reason: c.reason });
          track(el, label, c, 'left', c.reason);
        } else track(el, label, c, 'prefilled');
        continue;
      }
      if (!isEmpty(el)) {
        report.alreadyAnswered.push(label);
        track(el, label, c, 'prefilled');
        continue;
      }
      if (c.kind === 'resume') {
        if (!payload.resume) {
          mark(el, OUTLINE.attention, 'no resume version chosen for this job');
          report.needsBruno.push({ label, reason: 'No resume version selected for this job' });
          track(el, label, c, 'left', 'no resume chosen');
          continue;
        }
        try {
          await attachFile(el, payload.resume);
          mark(el, OUTLINE.filled, 'attached ' + payload.resume.fileName);
          report.uploaded.push(payload.resume.fileName + ' (' + payload.resume.label + ')');
          track(el, label, c, 'filled');
        } catch (err) {
          mark(el, OUTLINE.attention, 'could not attach resume');
          report.needsBruno.push({ label, reason: 'Could not attach resume automatically — upload it yourself' });
          track(el, label, c, 'left', 'resume upload failed');
        }
        continue;
      }
      // routine
      const value = payload.profile[c.key];
      if (!value) {
        mark(el, OUTLINE.attention, 'no profile value for ' + c.key);
        report.needsBruno.push({ label, reason: 'No value in your profile for this field' });
        track(el, label, c, 'left', 'no profile value');
        continue;
      }
      const ok = el.tagName === 'SELECT' ? fillSelect(el, value) : (setNativeValue(el, value), true);
      if (ok) {
        mark(el, OUTLINE.filled, 'filled from your profile — please check');
        report.filled.push(label);
        track(el, label, c, 'filled');
      } else {
        mark(el, OUTLINE.attention, 'no matching option');
        report.needsBruno.push({ label, reason: 'No option matches your profile value' });
        track(el, label, c, 'left', 'no matching option');
      }
    }

    startWatching();
    if (payload.autoSubmit) {
      report.autoSubmit = verifyAndSubmit(payload, items);
      if (!report.autoSubmit.ok) {
        banner('stop', 'Not submitted — needs you', report.autoSubmit.problems.concat(['Fix these yourself and click Submit, or skip this job.']));
      } else {
        banner('info', 'Submitting under your approval', ['The application is being sent. The log records exactly what was submitted.']);
      }
      return report;
    }
    banner('info', 'Job Assistant filled ' + report.filled.length + ' routine field(s)', [
      report.needsBruno.length + ' field(s) outlined in orange/red need your answer.',
      report.uploaded.length ? 'Attached: ' + report.uploaded.join(', ') : 'No documents attached.',
      'Check every answer. You make the final Submit click.',
    ]);
    return report;
  }

  // ---------------------------------------------------------------------------
  // Automatic submission: every check must pass, or nothing is submitted.
  // ---------------------------------------------------------------------------

  function verifyAndSubmit(payload, items) {
    const auto = payload.autoSubmit;
    const problems = [];
    const approved = new Set(auto.declarations || []);

    // The page must be for this job.
    const pageText = (document.title + ' ' + Array.from(document.querySelectorAll('h1, h2')).map(textOf).join(' ')).toLowerCase();
    const words = String(auto.jobTitle || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter((w) => w.length > 2 && !/^(senior|junior|remote|the|and|for)$/.test(w));
    const seen = words.filter((w) => pageText.includes(w));
    if (!words.length || seen.length / words.length < 0.7) problems.push('This page doesn’t look like the “' + auto.jobTitle + '” application');

    // Every field: answered reliably, approved, consistent with the profile.
    for (const it of items) {
      const el = it.el;
      if (el.type === 'checkbox' && it.kind === 'sensitive' && it.status === 'left') {
        const decl = R.declarationFor(it.label);
        if (decl && approved.has(decl)) {
          el.click();
          it.status = 'declaration';
          it.declaration = decl;
          continue;
        }
        if (it.required) problems.push('Declaration you haven’t approved: “' + it.label + '”');
        else it.status = 'left-optional';
        continue;
      }
      if (it.status === 'left') {
        if (it.required) problems.push('Required question it can’t answer reliably: “' + it.label + '” (' + it.reason + ')');
        else it.status = 'left-optional';
        continue;
      }
      if (it.status === 'prefilled') {
        const expected = it.kind === 'routine' ? payload.profile[it.key] : it.kind === 'answer' ? (payload.answers || {})[it.key] : null;
        const shown = shownValue(el);
        if (expected && !same(shown, expected) && !(el.tagName === 'SELECT' && same(el.value, expected))) {
          problems.push('Conflicting information: “' + it.label + '” already says “' + shown + '” but your profile says “' + expected + '”');
        }
        if (it.kind !== 'routine' && it.kind !== 'answer' && it.kind !== 'resume') problems.push('A field was already filled in and can’t be checked: “' + it.label + '”');
      }
    }

    // The right resume.
    const files = items.filter((it) => it.kind === 'resume');
    if (!files.length) problems.push('No resume upload field found');
    for (const it of files) {
      const name = shownValue(it.el);
      if (!payload.resume || name !== payload.resume.fileName) problems.push('Resume on the form (“' + (name || 'none') + '”) isn’t the one chosen for this job');
    }

    // The form's own validation, and exactly one Submit button.
    const form = (files[0] && files[0].el.form) || document.querySelector('form');
    if (!form) problems.push('No application form found');
    if (form && !problems.length && !form.checkValidity()) {
      const bad = Array.from(form.elements).filter((e) => e.willValidate && !e.checkValidity()).map((e) => labelFor(e) || e.name);
      problems.push('The form reports missing or invalid answers: ' + bad.join(', '));
    }
    const buttons = form
      ? Array.from(form.querySelectorAll('button, input[type="submit"]')).filter((b) => isVisible(b) && !b.disabled && (b.type === 'submit' || /^(submit|submit application|apply|apply now|send application)$/i.test(textOf(b) || b.value || '')))
      : [];
    if (form && buttons.length !== 1) problems.push(buttons.length ? 'More than one possible Submit button' : 'No Submit button found');

    if (problems.length) {
      for (const it of items) if (problems.some((p) => p.includes('“' + it.label + '”'))) mark(it.el, OUTLINE.sensitive, 'needs you before submitting');
      return { ok: false, problems };
    }

    const fields = items
      .filter((it) => it.status !== 'left-optional' || shownValue(it.el))
      .map((it) => ({ label: it.label, value: shownValue(it.el), source: it.status === 'declaration' ? 'approved declaration (' + it.declaration + ')' : it.status }));
    const declarations = items.filter((it) => it.status === 'declaration').map((it) => it.label);
    const leftBlank = items.filter((it) => it.status === 'left-optional' && !shownValue(it.el)).map((it) => it.label);

    submitClicked = true;
    send({ type: 'auto-submitted', jobId: activeJobId, url: location.href });
    // Click after this report has been returned: submitting navigates the
    // page, which would otherwise lose the report on its way to the panel.
    const button = buttons[0];
    setTimeout(() => button.click(), 300);
    return { ok: true, fields, declarations, leftBlank, button: textOf(button) || button.value || 'Submit' };
  }

  globalThis.JobAssistFiller = { run, snapshot: () => snapshot(controls().length), classifyAll: () => controls().map((el) => ({ d: describe(el), c: R.classifyField(describe(el)) })) };
})();
