/*
 * People to contact about a job: the recruiter, a hiring manager or team
 * leader, and one teammate in the same role.
 *
 * LinkedIn doesn't allow automated people searches, so the assistant builds
 * the right LinkedIn search for each role; Bruno opens it, picks the person,
 * and pastes their name and profile link. From there the assistant writes a
 * short message for that person and job, keeps it for his approval, and
 * remembers who he has already contacted so nobody is messaged twice.
 */
(function (root) {
  'use strict';

  const ROLES = [
    { role: 'recruiter', label: 'Recruiter / talent acquisition' },
    { role: 'manager', label: 'Hiring manager / team leader' },
    { role: 'teammate', label: 'Someone in the same role' },
  ];

  // Who a role usually reports to, from words in the job title.
  const LEADERS = [
    [/\b(account executive|sales|business development|bdr|sdr|account manager)\b/i, 'sales director OR head of sales OR VP sales'],
    [/\b(customer success|support)\b/i, 'head of customer success OR director customer success'],
    [/\b(marketing)\b/i, 'head of marketing OR marketing director'],
    [/\b(engineer|developer|software)\b/i, 'engineering manager OR director of engineering'],
    [/\b(product)\b/i, 'head of product OR director of product'],
  ];

  function leaderQuery(title) {
    const hit = LEADERS.find(([re]) => re.test(title || ''));
    return hit ? hit[1] : 'hiring manager';
  }

  function cleanTitle(title) {
    return String(title || '').replace(/\s*[(\[].*?[)\]]\s*/g, ' ').split(/\s+[-–|,]\s+|,/)[0].trim();
  }

  function linkedinPeopleSearch(keywords) {
    return 'https://www.linkedin.com/search/results/people/?keywords=' + encodeURIComponent(keywords);
  }

  /** The three LinkedIn searches for a job. */
  function peopleSearches(job) {
    const company = String(job.company || '').trim();
    const role = cleanTitle(job.title);
    const q = {
      recruiter: company + ' recruiter OR talent acquisition',
      manager: company + ' ' + leaderQuery(job.title),
      teammate: company + ' ' + role,
    };
    return ROLES.map((r) => Object.assign({}, r, { query: q[r.role], url: linkedinPeopleSearch(q[r.role]) }));
  }

  /** linkedin.com/in/<handle> in one canonical form, or '' if not a profile link. */
  function normalizeProfileUrl(url) {
    try {
      const u = new URL(String(url).trim());
      if (!/(^|\.)linkedin\.com$/i.test(u.hostname)) return '';
      const m = u.pathname.match(/^\/in\/([^/]+)/i);
      return m ? 'https://www.linkedin.com/in/' + decodeURIComponent(m[1]).toLowerCase() : '';
    } catch (_) {
      return '';
    }
  }

  function firstName(name) {
    return String(name || '').trim().split(/\s+/)[0] || 'there';
  }

  const CONNECTION_LIMIT = 200; // LinkedIn's limit for notes on free accounts

  /**
   * A connection note (fits LinkedIn's limit) and a follow-up message for
   * after they accept. Specific to the person's role, the job and company.
   */
  function draftMessages(contact, job, applied) {
    const hi = 'Hi ' + firstName(contact.name) + ', ';
    const role = cleanTitle(job.title);
    const co = job.company;
    const did = applied ? 'I just applied for the ' + role + ' role at ' + co : 'I’m applying for the ' + role + ' role at ' + co;
    const notes = {
      recruiter: [
        hi + did + '. I’d welcome the chance to connect and learn more about the team.',
        hi + did + ' and would love to connect.',
      ],
      manager: [
        hi + did + '. I’d value your view on what success looks like on your team.',
        hi + did + ' and would love to connect.',
      ],
      teammate: [
        hi + did + '. I’d love to hear how you’ve found working there.',
        hi + did + ' — how do you like it there?',
      ],
    }[contact.role] || [hi + did + '.'];
    const connection = notes.find((n) => n.length <= CONNECTION_LIMIT) || notes[notes.length - 1].slice(0, CONNECTION_LIMIT);
    const followUp = {
      recruiter: hi + 'thanks for connecting. ' + did + ' and wanted to put a name to the application. My background is in full-cycle B2B new-business sales. Happy to share anything that would help, and I’d appreciate knowing the next steps when you have a moment.',
      manager: hi + 'thanks for connecting. ' + did + '. I’d love to understand what the team is focused on this year and what you look for in the people who do well in this role. Would you be open to a short call?',
      teammate: hi + 'thanks for connecting. ' + did + ' and would really value an insider’s view. How do you like working at ' + co + ', and what’s the team like day to day?',
    }[contact.role] || hi + 'thanks for connecting.';
    return { connection, followUp };
  }

  /**
   * Add a person to the contact list, refusing duplicates.
   * @returns {{contacts, contact, duplicate: object|null, error: string}}
   */
  function addContact(contacts, { name, profileUrl, role, job }) {
    const url = normalizeProfileUrl(profileUrl);
    if (!String(name || '').trim()) return { contacts, contact: null, duplicate: null, error: 'Enter the person’s name.' };
    if (!url) return { contacts, contact: null, duplicate: null, error: 'Paste a LinkedIn profile link (linkedin.com/in/…).' };
    const existing = contacts.find((c) => c.profileUrl === url);
    if (existing) {
      const updated = contacts.map((c) => (c === existing && !c.jobIds.includes(job.id) ? Object.assign({}, c, { jobIds: [...c.jobIds, job.id] }) : c));
      return { contacts: updated, contact: updated.find((c) => c.profileUrl === url), duplicate: existing, error: '' };
    }
    const contact = {
      id: 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      name: String(name).trim(), profileUrl: url, role, company: job.company, jobIds: [job.id],
      status: 'not_contacted', addedAt: new Date().toISOString(),
    };
    return { contacts: [...contacts, contact], contact, duplicate: null, error: '' };
  }

  const api = { ROLES, peopleSearches, normalizeProfileUrl, draftMessages, addContact, CONNECTION_LIMIT, leaderQuery };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.JobAssistContacts = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
