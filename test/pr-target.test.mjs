import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseTarget, PrUsageError } from '../src/pr/target.mjs';

const OWNER_REPO = 'fixture-org/fixture-repo';
const URL42 = 'https://github.com/fixture-org/fixture-repo/pull/42';

test('a canonical URL and a number with --repo name the same PR', () => {
  const expected = { owner: 'fixture-org', repo: 'fixture-repo', number: 42, url: URL42, repository: OWNER_REPO };
  assert.deepEqual(parseTarget(URL42), expected);
  assert.deepEqual(parseTarget(URL42 + '/'), expected, 'a trailing slash is harmless');
  assert.deepEqual(parseTarget('42', { repo: OWNER_REPO }), expected);
});

test('every rejected target is a usage error (exit 2) before any provider call', () => {
  const cases = [
    ['', undefined, 'empty'],
    ['42', undefined, 'number without --repo is always an error in V1'],
    ['-42', { repo: OWNER_REPO }, 'flag-like input'],
    ['--repo=-x/y', undefined, 'flag-like input passed as a target'],
    ['42', { repo: '-x/y' }, 'owner starting with a dash'],
    ['42', { repo: 'o r/x' }, 'whitespace in --repo'],
    ['42', { repo: 'owner' }, 'repo without a slash'],
    ['42', { repo: 'owner/..' }, 'dot-dot repository name'],
    ['42', { repo: 'ow@ner/repo' }, 'non-owner character'],
    ['42', { repo: 'é/repo' }, 'non-ASCII owner'],
    ['42', { repo: 'a'.repeat(40) + '/x' }, 'owner longer than 39 characters'],
    ['0', { repo: OWNER_REPO }, 'zero'],
    ['-1', { repo: OWNER_REPO }, 'negative'],
    ['4.2', { repo: OWNER_REPO }, 'non-integer'],
    ['1e3', { repo: OWNER_REPO }, 'exponent notation'],
    ['42abc', { repo: OWNER_REPO }, 'trailing text'],
    ['+42', { repo: OWNER_REPO }, 'explicit plus sign'],
    ['٤٢', { repo: OWNER_REPO }, 'non-ASCII digits'],
    ['9999999999999999999999', { repo: OWNER_REPO }, 'beyond safe integers'],
    ['owner/repo#42', undefined, 'shorthand with # is not accepted in V1'],
    ['HEAD:42', { repo: OWNER_REPO }, 'revision syntax'],
    ['^42', { repo: OWNER_REPO }, 'revision syntax with caret'],
    ['~1', { repo: OWNER_REPO }, 'revision syntax with tilde'],
    ['main', { repo: OWNER_REPO }, 'a branch name'],
    ['https://evil.example/fixture-org/fixture-repo/pull/42', undefined, 'another host'],
    ['https://github.example.com/fixture-org/fixture-repo/pull/42', undefined, 'GitHub Enterprise is out of V1 scope'],
    ['http://github.com/fixture-org/fixture-repo/pull/42', undefined, 'plain http'],
    ['https://user:secret@github.com/fixture-org/fixture-repo/pull/42', undefined, 'credentials in the URL'],
    ['https://github.com/fixture-org/fixture-repo/issues/42', undefined, 'an issue, not a pull request'],
    ['https://github.com/fixture-org/fixture-repo/pull/42/files', undefined, 'a sub-page of the PR'],
    ['https://github.com/fixture-org/fixture-repo/pull/0', undefined, 'PR number zero'],
    ['https://github.com/fixture-org/fixture-repo/pull/42?x=1', undefined, 'a query string'],
    ['https://github.com/fixture-org/fixture-repo/pull/42#x', undefined, 'a fragment'],
    [URL42, { repo: OWNER_REPO }, 'a URL and --repo together are ambiguous'],
    ['x'.repeat(3000), undefined, 'very long input'],
    ['https://github.com/' + 'o'.repeat(41) + '/repo/pull/1', undefined, 'owner too long in a URL'],
    ['https://github.com/o/' + 'r'.repeat(101) + '/pull/1', undefined, 'repository too long in a URL'],
  ];
  for (const [arg, opts, why] of cases) {
    assert.throws(() => parseTarget(arg, opts), (error) => {
      assert.ok(error instanceof PrUsageError, `${why}: is a PrUsageError`);
      assert.equal(error.exitCode, 2, `${why}: exit code 2`);
      assert.match(error.message, /https:\/\/github\.com\/OWNER\/REPO\/pull\/NUMBER|NUMBER with --repo OWNER\/REPO/, `${why}: names the accepted forms`);
      return true;
    }, why);
  }
});

test('the rejection message does not echo a credential from the URL', () => {
  assert.throws(
    () => parseTarget('https://user:secret@github.com/fixture-org/fixture-repo/pull/42'),
    (error) => !/secret/.test(error.message),
  );
});
