// Which pull request a `pr` command means. One canonical GitHub URL, or a positive number with --repo.
// Anything else is a usage error (exit 2), decided before any provider is called. GitHub Enterprise,
// other hosts, revision syntax and owner/repo#n shorthand are out of V1 scope and say so.

export class PrUsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PrUsageError';
    this.exitCode = 2;
  }
}

const ACCEPTED = 'Accepted forms: https://github.com/OWNER/REPO/pull/NUMBER, or NUMBER with --repo OWNER/REPO.';
const MAX_INPUT = 2048;
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;
const NUMBER = /^[1-9][0-9]{0,15}$/;
const URL_PATH = /^\/([^/]+)\/([^/]+)\/pull\/([^/]+)\/?$/;

const fail = (message) => { throw new PrUsageError(`${message} ${ACCEPTED}`); };

function parseNumber(text) {
  if (!NUMBER.test(text)) return null;
  const n = Number(text);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function parseRepoName(repo) {
  if (typeof repo !== 'string') return fail('--repo must be OWNER/REPO.');
  const parts = repo.split('/');
  if (parts.length !== 2) return fail('--repo must be OWNER/REPO.');
  const [owner, name] = parts;
  if (!OWNER.test(owner)) return fail('--repo owner must be a GitHub login: letters, digits and single dashes, at most 39 characters.');
  if (!REPO.test(name) || name === '.' || name === '..') return fail('--repo name may use letters, digits, dot, dash and underscore, at most 100 characters.');
  return { owner, repo: name };
}

function canonical(owner, repo, number) {
  return { owner, repo, number, url: `https://github.com/${owner}/${repo}/pull/${number}`, repository: `${owner}/${repo}` };
}

/** Parse a PR target. `repo` is the value of --repo, if any. Throws PrUsageError (exit 2). */
export function parseTarget(arg, { repo } = {}) {
  if (typeof arg !== 'string' || arg.length === 0) return fail('A pull request is required.');
  if (arg.length > MAX_INPUT) return fail('The pull request target is too long.');

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(arg)) {
    if (repo !== undefined) return fail('Pass a URL or a number with --repo, not both.');
    let url;
    try { url = new URL(arg); } catch { return fail('The pull request URL is not valid.'); }
    if (url.protocol !== 'https:') return fail('Only https URLs are accepted.');
    if (url.username || url.password) return fail('URLs with credentials are refused.');
    if (url.hostname !== 'github.com' || url.port) return fail('Only github.com is supported in V1 (GitHub Enterprise is out of scope).');
    if (url.search || url.hash) return fail('The pull request URL must not have a query or fragment.');
    const m = URL_PATH.exec(url.pathname);
    const number = m ? parseNumber(m[3]) : null;
    if (!m || number === null) return fail('That URL is not a pull request (expected /OWNER/REPO/pull/NUMBER).');
    const named = parseRepoName(`${m[1]}/${m[2]}`);
    return canonical(named.owner, named.repo, number);
  }

  const number = parseNumber(arg);
  if (number === null) return fail(`"${arg.slice(0, 40).replace(/[\x00-\x1f\x7f]/g, '?')}" is not a pull request number or URL.`);
  if (repo === undefined || repo === true) return fail('A number needs --repo OWNER/REPO.');
  const named = parseRepoName(repo);
  return canonical(named.owner, named.repo, number);
}
