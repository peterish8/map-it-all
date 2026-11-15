// Version-pinned library docs, saved as memory notes that flag themselves when the version changes.
//
// Sources, tried in order, all keyless:
//   1. the package's own llms.txt (the convention for "docs written for models"), at its homepage
//   2. the README in its GitHub repository
// The excerpt is chosen by relevance to the question, capped to a token budget, and stored as a memory
// note pinned to name@version. The next lookup is free until the lockfile moves to another version.
// Everything fetched is untrusted text: it is cleaned, capped and labelled as such.

import { fetchText, clean } from './net.mjs';
import { registryFor } from './advisories.mjs';

const BUDGET = 1700; // characters of excerpt, about 425 tokens
const STOP = new Set(['the', 'and', 'for', 'how', 'use', 'using', 'with', 'what', 'does', 'from', 'this', 'that', 'into', 'api']);
const tokensOf = (q) => [...new Set(String(q ?? '').toLowerCase().split(/[^a-z0-9_]+/).filter((t) => t.length > 2 && !STOP.has(t)))];
const PREFERRED = /usage|quick ?start|getting started|install|example|basic/i;

function tidy(md) {
  return md
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/^\s*\[!\[.*$/gm, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/<\/?(?:p|div|img|br|a|picture|source|sup|sub|details|summary|h\d|b|i|em|strong|center)\b[^>]*>/gi, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Markdown sections ranked by how well they answer `query`; the best ones, in document order, within the budget. */
export function excerptMarkdown(markdown, query, budget = BUDGET) {
  const text = tidy(markdown);
  const parts = text.split(/^(?=#{1,4}\s)/m).filter((p) => p.trim());
  const tokens = tokensOf(query);
  const scored = parts.map((body, i) => {
    const head = body.split('\n', 1)[0].toLowerCase();
    const low = body.toLowerCase();
    let score = i === 0 ? 1 : 0;
    for (const t of tokens) score += (head.includes(t) ? 3 : 0) + Math.min((low.split(t).length - 1), 4);
    if (!tokens.length && PREFERRED.test(head)) score += 3;
    return { i, body, score };
  });
  const picked = [];
  let used = 0;
  for (const s of [...scored].sort((a, b) => b.score - a.score || a.i - b.i)) {
    if (used >= budget || (picked.length && s.score <= 0)) break;
    const room = budget - used;
    const body = s.body.length > room ? `${s.body.slice(0, Math.max(room - 1, 0)).trimEnd()}…` : s.body;
    picked.push({ ...s, body });
    used += body.length + 2;
  }
  return picked.sort((a, b) => a.i - b.i).map((p) => p.body.trim()).join('\n\n');
}

/** llms.txt is an index of links with notes: keep the title, the summary and the lines that match. */
export function excerptLlms(text, query, budget = BUDGET) {
  const lines = tidy(text).split('\n');
  const tokens = tokensOf(query);
  const head = lines.filter((l) => /^(#|>)\s/.test(l)).slice(0, 3);
  const links = lines.filter((l) => /\[[^\]]+\]\([^)]+\)/.test(l))
    .map((l) => ({ l, score: tokens.reduce((n, t) => n + (l.toLowerCase().includes(t) ? 1 : 0), 0) }))
    .sort((a, b) => b.score - a.score);
  const out = [...head];
  let used = out.join('\n').length;
  for (const { l } of links) { if (used + l.length > budget) break; out.push(l); used += l.length + 1; }
  return out.join('\n');
}

const githubRepo = (url) => {
  const m = String(url ?? '').match(/github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[/#?].*)?$/);
  return m ? { owner: m[1], repo: m[2] } : null;
};

async function tryFetch(url, maxBytes = 400_000) {
  try { return await fetchText(url, { maxBytes, timeoutMs: 8000 }); } catch { return null; }
}

/** Fetch the best available docs text for a package. Returns { source, url, excerpt } or null. */
async function fetchDocs({ homepage, repo, query }) {
  const gh = githubRepo(repo) ?? githubRepo(homepage);
  const origins = [];
  try {
    const h = new URL(homepage);
    if (h.protocol === 'https:' && h.hostname !== 'github.com') origins.push(`${h.origin}/llms.txt`, new URL('llms.txt', h.href.endsWith('/') ? h.href : `${h.href}/`).href);
  } catch { /* no usable homepage */ }
  for (const url of new Set(origins)) {
    const r = await tryFetch(url);
    if (r && r.text.trim() && !/<html/i.test(r.text.slice(0, 300))) {
      let excerpt = excerptLlms(r.text, query);
      // llms.txt often links to Markdown pages: pull the best one for the question, within the same site.
      const link = r.text.split('\n').map((l) => l.match(/\]\((https:[^)\s]+\.md)\)/)?.[1]).filter(Boolean)
        .find((u) => tokensOf(query).some((t) => u.toLowerCase().includes(t)));
      if (link && new URL(link).host === new URL(r.url).host) {
        const page = await tryFetch(link);
        if (page) excerpt = `${excerpt}\n\n${excerptMarkdown(page.text, query, BUDGET - Math.min(excerpt.length, 600))}`;
      }
      return { source: 'llms.txt', url: r.url, excerpt };
    }
  }
  if (gh) {
    for (const file of ['README.md', 'readme.md', 'Readme.md']) {
      const url = `https://raw.githubusercontent.com/${gh.owner}/${gh.repo}/HEAD/${file}`;
      const r = await tryFetch(url);
      if (r?.text.trim()) return { source: `README (${gh.owner}/${gh.repo})`, url, excerpt: excerptMarkdown(r.text, query) };
    }
  }
  return null;
}

/**
 * The docs lookup behind `deps docs=<question>`. Reads a saved note first (free, version-checked); only
 * when there is none, or it is stale, and the network policy allows it, fetches and saves a new one.
 */
export async function docsFor({ out, memory, name, version, query = '', policy, refresh = false }) {
  const q = clean(query, 80);
  const title = `docs: ${name}@${version}${q ? ` - ${q}` : ''}`;
  const notes = memory.recall({ query: `docs ${name}`, tag: 'docs', limit: 12 }).filter((n) => n.tags.includes(name.toLowerCase()));
  const same = notes.find((n) => n.title.toLowerCase() === title.toLowerCase());
  const saved = same ?? (q ? null : notes.find((n) => n.title.startsWith(`docs: ${name}@${version}`) && n.status === 'fresh'));
  const show = (n, extra = '') => `${n.title}  [saved note ${n.id}, ${n.status}${extra}]\n(untrusted external text, excerpted. Verify against the package before relying on it.)\n\n${n.body}`;
  if (saved && saved.status === 'fresh' && !refresh) return show(saved, ', no network used');
  if (!policy.allowed) return saved ? `${show(saved)}\n\nThis note is out of date for the installed version. ${policy.why}` : `No saved docs for ${name}@${version}. ${policy.why}`;

  const reg = await registryFor({ out, targets: [{ name, version }], online: true });
  const meta = reg.byKey.get(`${name}@${version}`);
  if (!meta) return `Could not read registry details for ${name}@${version}${reg.error ? ` (${reg.error})` : ''}.`;
  const found = await fetchDocs({ homepage: meta.homepage, repo: meta.repo, query: q });
  if (!found?.excerpt) return `No llms.txt or GitHub README found for ${name}@${version}${meta.homepage ? ` (homepage ${meta.homepage})` : ''}.`;
  const body = `source: ${found.url}\n${found.excerpt}`.slice(0, 1900);
  const note = memory.remember({ title, body, kind: 'fact', tags: ['docs', name.toLowerCase()], pins: [{ pkg: name, version }] });
  return show({ ...note, body }, `, from ${found.source}, pinned to ${name}@${version}`);
}
