/*
 * Resume tailoring.
 *
 * Works on Bruno's own .docx resume and rewrites only three parts: the
 * headline under his name, the summary, and the skills list. Experience,
 * dates, education and achievements are never touched. Every AI rewrite is
 * checked against the original resume and rejected if it adds a number, a
 * years-of-experience claim, or a name/tool that isn't already on it.
 *
 * Includes a minimal zip reader/writer (deflate via the browser's built-in
 * DecompressionStream) so no third-party library is needed.
 */
(function (root) {
  'use strict';

  // ---------------------------------------------------------------------------
  // Zip
  // ---------------------------------------------------------------------------

  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  async function inflateRaw(bytes) {
    const ds = new DecompressionStream('deflate-raw');
    const stream = new Blob([bytes]).stream().pipeThrough(ds);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  /** @returns {Promise<Array<{name:string, data:Uint8Array}>>} entries in file order */
  async function readZip(buf) {
    const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    let eocd = -1;
    for (let i = b.length - 22; i >= Math.max(0, b.length - 65557); i--) {
      if (dv.getUint32(i, true) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new Error('Not a valid .docx/zip file');
    const count = dv.getUint16(eocd + 10, true);
    let p = dv.getUint32(eocd + 16, true);
    const out = [];
    const dec = new TextDecoder();
    for (let i = 0; i < count; i++) {
      if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('Corrupt zip directory');
      const method = dv.getUint16(p + 10, true);
      const csize = dv.getUint32(p + 20, true);
      const nlen = dv.getUint16(p + 28, true);
      const xlen = dv.getUint16(p + 30, true);
      const clen = dv.getUint16(p + 32, true);
      const local = dv.getUint32(p + 42, true);
      const name = dec.decode(b.subarray(p + 46, p + 46 + nlen));
      const lnlen = dv.getUint16(local + 26, true);
      const lxlen = dv.getUint16(local + 28, true);
      const start = local + 30 + lnlen + lxlen;
      const raw = b.subarray(start, start + csize);
      let data;
      if (method === 0) data = raw.slice();
      else if (method === 8) data = await inflateRaw(raw);
      else throw new Error('Unsupported zip compression in ' + name);
      out.push({ name, data });
      p += 46 + nlen + xlen + clen;
    }
    return out;
  }

  /** Writes an uncompressed ("stored") zip, which Word opens normally. */
  function writeZip(entries) {
    const enc = new TextEncoder();
    const parts = [];
    const central = [];
    let offset = 0;
    for (const e of entries) {
      const name = enc.encode(e.name);
      const crc = crc32(e.data);
      const h = new DataView(new ArrayBuffer(30));
      h.setUint32(0, 0x04034b50, true);
      h.setUint16(4, 20, true);
      h.setUint16(6, 0x0800, true); // UTF-8 names
      h.setUint16(8, 0, true);
      h.setUint32(14, crc, true);
      h.setUint32(18, e.data.length, true);
      h.setUint32(22, e.data.length, true);
      h.setUint16(26, name.length, true);
      parts.push(new Uint8Array(h.buffer), name, e.data);
      const c = new DataView(new ArrayBuffer(46));
      c.setUint32(0, 0x02014b50, true);
      c.setUint16(4, 20, true);
      c.setUint16(6, 20, true);
      c.setUint16(8, 0x0800, true);
      c.setUint32(16, crc, true);
      c.setUint32(20, e.data.length, true);
      c.setUint32(24, e.data.length, true);
      c.setUint16(28, name.length, true);
      c.setUint32(42, offset, true);
      central.push(new Uint8Array(c.buffer), name);
      offset += 30 + name.length + e.data.length;
    }
    const csize = central.reduce((n, a) => n + a.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, entries.length, true);
    end.setUint16(10, entries.length, true);
    end.setUint32(12, csize, true);
    end.setUint32(16, offset, true);
    const all = [...parts, ...central, new Uint8Array(end.buffer)];
    const out = new Uint8Array(all.reduce((n, a) => n + a.length, 0));
    let p = 0;
    for (const a of all) {
      out.set(a, p);
      p += a.length;
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Word document text
  // ---------------------------------------------------------------------------

  const xmlDecode = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  const xmlEncode = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const PARA = /<w:p\b[^>]*>[\s\S]*?<\/w:p>|<w:p\b[^>]*\/>/g;
  const TEXT = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>|<w:t\b[^>]*\/>|<w:tab\/>/g;

  function paragraphs(xml) {
    const out = [];
    for (const m of xml.matchAll(PARA)) {
      let text = '';
      for (const t of m[0].matchAll(TEXT)) text += t[0].startsWith('<w:tab') ? '\t' : xmlDecode(t[1] || '');
      out.push({ index: out.length, start: m.index, end: m.index + m[0].length, xml: m[0], text });
    }
    return out;
  }

  /** Put newText into paragraph #index, keeping the first run's formatting. */
  function replaceParagraph(xml, para, newText) {
    let first = true;
    const body = para.xml.replace(/<w:t\b[^>]*>[\s\S]*?<\/w:t>|<w:t\b[^>]*\/>/g, () => {
      if (!first) return '<w:t/>';
      first = false;
      return '<w:t xml:space="preserve">' + xmlEncode(newText) + '</w:t>';
    });
    if (first) return xml; // paragraph had no text runs; leave it
    return xml.slice(0, para.start) + body + xml.slice(para.end);
  }

  async function readDocx(bytes) {
    const entries = await readZip(bytes);
    const doc = entries.find((e) => e.name === 'word/document.xml');
    if (!doc) throw new Error('This file is not a Word document');
    const xml = new TextDecoder().decode(doc.data);
    return { entries, xml, paragraphs: paragraphs(xml) };
  }

  function docxText(parsed) {
    return parsed.paragraphs.map((p) => p.text).filter((t) => t.trim()).join('\n');
  }

  /**
   * Find the parts of the resume that may be tailored.
   * headline: a short line near the top, usually ALL CAPS with separators.
   * summary / skills: the paragraph(s) after a "Summary" / "Skills" heading.
   */
  function locateSections(paras) {
    const nonEmpty = paras.filter((p) => p.text.trim());
    const isHeading = (t) => t.trim().length < 40 && /^[A-Z0-9 &/,.\-]+$/.test(t.trim()) && !/[|•]/.test(t);
    const out = {};
    const top = nonEmpty.slice(1, 5);
    const head = top.find((p) => /[|•]/.test(p.text) && p.text === p.text.toUpperCase() && !/@|\d{3}/.test(p.text));
    if (head) out.headline = head;
    const after = (re) => {
      const i = nonEmpty.findIndex((p) => isHeading(p.text) && re.test(p.text));
      return i >= 0 && nonEmpty[i + 1] && !isHeading(nonEmpty[i + 1].text) ? nonEmpty[i + 1] : null;
    };
    const summary = after(/summary|profile|about/i);
    const skills = after(/skill|expertise|competenc|strengths/i);
    if (summary) out.summary = summary;
    if (skills) out.skills = skills;
    return out;
  }

  // ---------------------------------------------------------------------------
  // Fabrication guard
  // ---------------------------------------------------------------------------

  function words(s) {
    return new Set(String(s).toLowerCase().match(/[a-z0-9][a-z0-9+#.&-]*/g) || []);
  }

  /**
   * Compare rewritten text with the original resume. Returns a list of
   * problems; an empty list means nothing new was claimed.
   */
  function fabricationCheck(original, rewritten, jobDescription = '') {
    const problems = [];
    const orig = String(original);
    const origWords = words(orig);
    const normNum = (n) => n.replace(/[,$\s]/g, '').toLowerCase();
    const origNums = new Set((orig.match(/\$?\d[\d,.]*\s?[kKmM%+]?/g) || []).map(normNum));
    for (const n of String(rewritten).match(/\$?\d[\d,.]*\s?[kKmM%+]?/g) || []) {
      if (!origNums.has(normNum(n)) && !origNums.has(normNum(n).replace(/[+%km]$/, ''))) problems.push('new number “' + n.trim() + '”');
    }
    if (/\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\+?\s+years?\b/i.test(rewritten) && !/\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\+?\s+years?\b/i.test(orig)) {
      problems.push('years-of-experience claim');
    }
    // Capitalised names/tools (e.g. "Splunk", "CISSP") that aren't on the resume.
    const jd = words(jobDescription);
    const allowed = new Set(['a', 'an', 'and', 'b2b', 'b2c', 'saas', 'crm', 'i']);
    for (const m of String(rewritten).match(/\b[A-Z][A-Za-z0-9+#&.-]{1,}\b/g) || []) {
      const w = m.toLowerCase().replace(/\.$/, '');
      if (origWords.has(w) || allowed.has(w)) continue;
      const atSentenceStart = new RegExp('(^|[.!?•|]\\s+)' + m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b').test(rewritten);
      if (jd.has(w) || /[A-Z].*[A-Z]/.test(m) || !atSentenceStart) problems.push('“' + m + '” isn’t on your resume');
    }
    return [...new Set(problems)];
  }

  // ---------------------------------------------------------------------------
  // Tailoring
  // ---------------------------------------------------------------------------

  /** Skills list with the ones this job asks for moved to the front. */
  function reorderSkills(skillsText, jobKeywords) {
    const sep = skillsText.includes('•') ? '•' : skillsText.includes('|') ? '|' : skillsText.includes(';') ? ';' : ',';
    const items = skillsText.split(sep).map((s) => s.trim()).filter(Boolean);
    if (items.length < 3) return skillsText;
    const kw = jobKeywords.map((k) => k.toLowerCase());
    const hit = (s) => kw.some((k) => s.toLowerCase().includes(k) || k.includes(s.toLowerCase()));
    const sorted = [...items.filter(hit), ...items.filter((s) => !hit(s))];
    const joiner = sep === '•' ? '  •  ' : sep === '|' ? '  |  ' : sep + ' ';
    return sorted.join(joiner);
  }

  const AI_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['headline', 'summary', 'skills', 'fitScore', 'matchedQualifications', 'missingQualifications'],
    properties: {
      headline: { type: 'string' },
      summary: { type: 'string' },
      skills: { type: 'array', items: { type: 'string' } },
      fitScore: { type: 'integer' },
      matchedQualifications: { type: 'array', items: { type: 'string' } },
      missingQualifications: { type: 'array', items: { type: 'string' } },
    },
  };

  const AI_SYSTEM =
    'You tailor a candidate’s resume to a job description so it reads well to applicant-tracking systems and recruiters. ' +
    'You may only reword, reorder and emphasise what the resume already says. Never add a skill, tool, certification, employer, ' +
    'industry, number, metric or years-of-experience figure that is not already in the resume; if the job asks for something the ' +
    'resume does not show, list it under missingQualifications instead of claiming it. Use the job’s wording only where the resume ' +
    'genuinely supports it. Keep the headline under 90 characters, the summary close to its current length, and the skills list ' +
    'to items that appear in the resume. fitScore is 0-100: how well the resume as written fits the job.';

  function aiPrompt(sections, resumeText, job) {
    return [
      '<resume>\n' + resumeText + '\n</resume>',
      '<job title="' + job.title + '" company="' + job.company + '">\n' + String(job.description || '').slice(0, 12000) + '\n</job>',
      'Rewrite these three parts of the resume for this job:',
      'HEADLINE: ' + (sections.headline ? sections.headline.text : '(none)'),
      'SUMMARY: ' + (sections.summary ? sections.summary.text : '(none)'),
      'SKILLS: ' + (sections.skills ? sections.skills.text : '(none)'),
    ].join('\n\n');
  }

  /**
   * Produce a tailored .docx for one job.
   * @param ai  optional async ({system, user, schema}) => object; without it
   *            the skills are reordered by job keywords and nothing else changes.
   * @returns {{bytes:Uint8Array, changes:string[], rejected:string[], fitScore:number|null, matched:string[], missing:string[], usedAI:boolean}}
   */
  async function tailorDocx(bytes, job, { ai, keywords = [] } = {}) {
    const parsed = await readDocx(bytes);
    const resumeText = docxText(parsed);
    const sections = locateSections(parsed.paragraphs);
    const proposals = {};
    const result = { changes: [], rejected: [], fitScore: null, matched: [], missing: [], usedAI: false };

    if (ai && job.description) {
      const out = await ai({ system: AI_SYSTEM, user: aiPrompt(sections, resumeText, job), schema: AI_SCHEMA });
      result.usedAI = true;
      result.fitScore = Number.isFinite(out.fitScore) ? Math.max(0, Math.min(100, out.fitScore)) : null;
      result.matched = out.matchedQualifications || [];
      result.missing = out.missingQualifications || [];
      if (sections.headline && out.headline) proposals.headline = out.headline;
      if (sections.summary && out.summary) proposals.summary = out.summary;
      if (sections.skills && out.skills && out.skills.length) {
        const sep = sections.skills.text.includes('•') ? '  •  ' : sections.skills.text.includes('|') ? '  |  ' : ', ';
        proposals.skills = out.skills.join(sep);
      }
      for (const [k, text] of Object.entries(proposals)) {
        const problems = fabricationCheck(resumeText, text, job.description);
        if (problems.length) {
          result.rejected.push(k + ': ' + problems.join(', '));
          delete proposals[k];
        }
      }
    }
    if (!proposals.skills && sections.skills && keywords.length) {
      const re = reorderSkills(sections.skills.text, keywords);
      if (re !== sections.skills.text) proposals.skills = re;
    }

    // Apply from the end of the document backwards so offsets stay valid.
    let xml = parsed.xml;
    const order = Object.keys(proposals).sort((a, b) => sections[b].start - sections[a].start);
    for (const k of order) {
      if (proposals[k].trim() === sections[k].text.trim()) continue;
      xml = replaceParagraph(xml, sections[k], proposals[k].trim());
      result.changes.push(k);
    }
    const enc = new TextEncoder();
    const entries = parsed.entries.map((e) => (e.name === 'word/document.xml' ? { name: e.name, data: enc.encode(xml) } : e));
    result.bytes = writeZip(entries);
    return result;
  }

  const api = { crc32, readZip, writeZip, readDocx, docxText, paragraphs, replaceParagraph, locateSections, fabricationCheck, reorderSkills, tailorDocx, AI_SCHEMA, AI_SYSTEM };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.JobAssistTailor = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
