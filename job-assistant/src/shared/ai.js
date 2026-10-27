/*
 * Optional AI help through the Claude API, using Bruno's own API key (entered
 * in the Profile tab, stored only in this Chrome profile). Without a key the
 * assistant still works and falls back to keyword matching.
 *
 * Plain fetch rather than the SDK because the extension has no build step.
 */
(function (root) {
  'use strict';

  const MODEL = 'claude-opus-5-5';
  const URL_ = 'https://api.anthropic.com/v1/messages';

  class AIError extends Error {}

  /**
   * Ask Claude for JSON matching `schema`.
   * @returns {Promise<object>}
   */
  async function askJson({ apiKey, system, user, schema, fetchFn = fetch, maxTokens = 16000, retries = 1 }) {
    if (!apiKey) throw new AIError('No Claude API key saved');
    const body = {
      model: MODEL,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: user }],
      output_config: { effort: 'medium', format: { type: 'json_schema', schema } },
      fallbacks: 'default',
    };
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
      let res;
      try {
        res = await fetchFn(URL_, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2026-10-21',
            'anthropic-beta': 'server-side-fallback-2026-07-01',
            // Required for calls made directly from a browser/extension.
            'anthropic-dangerous-direct-browser-access': 'true',
          },
          body: JSON.stringify(body),
        });
      } catch (err) {
        lastErr = new AIError('Could not reach the Claude API: ' + err.message);
        continue;
      }
      if (res.status === 401 || res.status === 403) throw new AIError('Your Claude API key was rejected. Check it in the Profile tab.');
      if (res.status === 429 || res.status >= 500) {
        lastErr = new AIError('The Claude API is busy (HTTP ' + res.status + '). Try again shortly.');
        if (attempt < retries) await new Promise((r) => setTimeout(r, 2000));
        continue;
      }
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new AIError('Claude API error: ' + ((data.error && data.error.message) || 'HTTP ' + res.status));
      if (data.stop_reason === 'refusal') throw new AIError('Claude declined this request.');
      if (data.stop_reason === 'max_tokens') throw new AIError('Claude’s answer was cut off. Try again.');
      const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
      try {
        return JSON.parse(text);
      } catch (_) {
        throw new AIError('Claude returned an unreadable answer.');
      }
    }
    throw lastErr;
  }

  const api = { MODEL, askJson, AIError };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.JobAssistAI = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
