import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findExistingComment, reporterSignature, buildComment } from '../run-quality-gates.mjs';

test('findExistingComment: paginates until it finds the commitperclip comment', async () => {
  const seenPaths = [];
  const comment = await findExistingComment(async (path) => {
    seenPaths.push(path);
    if (path.endsWith('page=1')) {
      return Array.from({ length: 100 }, (_, index) => ({
        id: index + 1,
        user: { login: 'someone-else' },
        body: 'unrelated',
      }));
    }
    if (path.endsWith('page=2')) {
      return [{
        id: 200,
        user: { login: 'commitperclip[bot]' },
        body: 'Looks good.\n\n— commitperclip',
      }];
    }
    return [];
  }, 'token', 'paperclipai/paperclip', 6469);

  assert.equal(comment.id, 200);
  assert.deepEqual(seenPaths, [
    '/repos/paperclipai/paperclip/issues/6469/comments?per_page=100&page=1',
    '/repos/paperclipai/paperclip/issues/6469/comments?per_page=100&page=2',
  ]);
});

test('findExistingComment: returns null when no signed comment exists', async () => {
  const comment = await findExistingComment(async () => ([
    {
      id: 1,
      user: { login: 'commitperclip[bot]' },
      body: 'Unsigned status update',
    },
  ]), 'token', 'paperclipai/paperclip', 6469);

  assert.equal(comment, null);
});

const forkRepo = 'btparks904/paperclip';
const marker = '<!-- paperclip-fork-quality-gates:v1 -->';
const owned = { id: 91, user: { login: 'github-actions[bot]', type: 'Bot' }, body: `Report\n${marker}` };

test('fork reporter is explicit and repository restricted; unknown values fail closed', () => {
  assert.equal(reporterSignature(undefined, 'paperclipai/paperclip'), '— commitperclip');
  assert.equal(reporterSignature('fork-actions', forkRepo), marker);
  for (const [mode, repo] of [['', forkRepo], ['evil', forkRepo], ['fork-actions', 'other/paperclip'], ['fork-actions', 'paperclipai/paperclip']]) {
    assert.throws(() => reporterSignature(mode, repo), /Unsupported/);
  }
});

test('fork reports carry a dedicated stable marker in pass and failure cases', () => {
  for (const failures of [[], ['missing test']]) {
    const body = buildComment('author', failures, [], marker);
    assert.ok(body.endsWith(marker));
    assert.ok(!body.includes('— commitperclip'));
  }
});

test('fork comment lookup rejects human spoof, other apps, upstream and unrelated Actions comments', async () => {
  const invalid = [
    { ...owned, user: { login: 'human', type: 'User' } },
    { ...owned, user: { login: 'github-actions[bot]', type: 'User' } },
    { ...owned, user: { login: 'commitperclip[bot]', type: 'Bot' } },
    { ...owned, body: 'Other Actions workflow' },
    { ...owned, body: `${marker} quoted example, not a report` },
    { ...owned, body: null },
    { ...owned, user: null },
  ];
  assert.equal(await findExistingComment(async () => invalid, 'mock', forkRepo, 15, 'fork-actions'), null);
  const result = await findExistingComment(async () => [...invalid, owned], 'mock', forkRepo, 15, 'fork-actions');
  assert.equal(result.id, owned.id);
});

test('fork reruns find the same owned comment beyond the first page', async () => {
  for (let run = 0; run < 2; run++) {
    const paths = [];
    const found = await findExistingComment(async path => {
      paths.push(path);
      return path.endsWith('page=1') ? Array.from({length: 100}, () => ({user: {login: 'human'}, body: 'x'})) : [owned];
    }, 'mock', forkRepo, 15, 'fork-actions');
    assert.equal(found.id, owned.id);
    assert.equal(paths.length, 2);
  }
});

test('lookup rejects invalid reporter before API access and propagates API errors', async () => {
  await assert.rejects(findExistingComment(async () => { throw new Error('must not call'); }, 'mock', 'other/repo', 15, 'fork-actions'), /Unsupported/);
  await assert.rejects(findExistingComment(async () => { throw new Error('API unavailable'); }, 'mock', forkRepo, 15, 'fork-actions'), /API unavailable/);
});

// Entire orchestration uses a rejecting-by-default fake transport. No live calls.
const { runQualityGates } = await import('../run-quality-gates.mjs');
const validBody = `## Thinking Path
- Understand the application.
- Keep the trusted boundary.
- Test the intended change.
## What Changed
Documentation only.
## Verification
Synthetic tests passed.
## Risks
No runtime change.
## Model Used
Human authored.
`;
const env = { GH_TOKEN: 'synthetic', GH_REPO: forkRepo, PR_NUMBER: '15', QUALITY_GATE_REPORTER: 'fork-actions' };
function fakeApi({body = validBody, existing = [], fail = '', commits = []} = {}) {
  const writes = [];
  return { writes, fetch: async (path, token, options = {}) => {
    assert.equal(token, 'synthetic');
    if (options.method) {
      if (fail === options.method) throw new Error('write denied');
      writes.push({path, ...options}); return {id: 100};
    }
    if (fail === 'read') throw new Error('read denied');
    if (path.endsWith('/pulls/15')) return {body, title: 'docs: explain behavior', user: {login: 'author'}, head: {ref: 'docs/example'}, base: {ref: 'base'}};
    if (path.includes('/files?')) return [];
    if (path.includes('/commits?')) return commits;
    if (path.includes('/comments?')) return existing;
    throw new Error(`Unexpected mock request: ${path}`);
  }};
}

test('orchestration: clean pass is silent without an existing report', async () => {
  const api = fakeApi();
  const result = await runQualityGates(env, api.fetch);
  assert.equal(result.passed, true); assert.deepEqual(result.failures, []);
  assert.equal(api.writes.length, 0);
});

test('orchestration: failures POST, later pass PATCHes only the owned report', async () => {
  const first = fakeApi({body: ''});
  const failed = await runQualityGates(env, first.fetch);
  assert.equal(failed.passed, false); assert.ok(failed.failures.length > 0);
  assert.equal(first.writes.length, 1); assert.equal(first.writes[0].method, 'POST');
  assert.equal(first.writes[0].path, `/repos/${forkRepo}/issues/15/comments`);
  const saved = {...owned, body: JSON.parse(first.writes[0].body).body};
  const second = fakeApi({existing: [saved]});
  assert.equal((await runQualityGates(env, second.fetch)).passed, true);
  assert.equal(second.writes.length, 1); assert.equal(second.writes[0].method, 'PATCH');
  assert.equal(second.writes[0].path, `/repos/${forkRepo}/issues/comments/${owned.id}`);
  assert.match(JSON.parse(second.writes[0].body).body, /All checks passing/);
});

test('orchestration: informational coauthor report does not fail the gates', async () => {
  const api = fakeApi({commits: [{author: {login: 'contributor'}, commit: {author: {name: 'Contributor', email: 'contributor@example.test'}, message: 'docs'}}]});
  const result = await runQualityGates(env, api.fetch);
  assert.equal(result.passed, true); assert.ok(result.informational.length > 0);
  assert.equal(api.writes[0].method, 'POST');
});

test('orchestration: read and POST/PATCH errors reject rather than report success', async () => {
  for (const options of [{fail: 'read'}, {fail: 'POST', body: ''}, {fail: 'PATCH', existing: [owned]}]) {
    const api = fakeApi(options);
    await assert.rejects(runQualityGates(env, api.fetch), /denied/);
  }
});

test('CLI: missing required inputs exits nonzero before any transport', async () => {
  const {spawnSync} = await import('node:child_process');
  const {fileURLToPath} = await import('node:url');
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../run-quality-gates.mjs', import.meta.url))], {env: {}, encoding: 'utf8'});
  assert.equal(result.status, 1);
  assert.match(result.stderr, /env vars required/);
});
