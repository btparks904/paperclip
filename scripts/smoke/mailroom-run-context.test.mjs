// Dedicated dependency-free qualification: node --test scripts/smoke/mailroom-run-context.test.mjs
// Node strip-types exercises runtime checks; it is NOT a substitute for tsc/Vitest/build.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createMailroomRunContextResolver, MailroomRunContextDenied } from '../../server/src/services/mailroom-run-context.ts';

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const config = { enabled: true, companyId: id(1), sonyaAgentId: id(2), projectId: id(3) };
const REF = id(4), RUN = id(5), ISSUE = id(6), IDENTITY = id(7);
const USER = 'synthetic-user';
function fixture() {
  return {
    actor: { type: 'agent', source: 'agent_jwt', companyId: id(1), agentId: id(2),
      runId: RUN, keyScope: { kind: 'standard' }, onBehalfOfUserId: USER, identityContextId: IDENTITY },
    snapshot: {
      company: { id: id(1), status: 'active' },
      agent: { id: id(2), companyId: id(1), status: 'running' },
      run: { id: RUN, companyId: id(1), agentId: id(2), status: 'running', finishedAt: null,
        responsibleUserId: USER, activeIdentityContextId: IDENTITY, nativeIssueId: ISSUE,
        contextSnapshot: { issueId: ISSUE, taskId: ISSUE }, resultJson: null },
      issue: { id: ISSUE, companyId: id(1), projectId: id(3), assigneeAgentId: id(2),
        assigneeUserId: null, hiddenAt: null, status: 'in_progress', checkoutRunId: RUN,
        executionRunId: RUN, responsibleUserId: USER },
      membership: { companyId: id(1), principalId: USER, principalType: 'user', status: 'active' },
      identity: { id: IDENTITY, companyId: id(1), runId: RUN, responsibleUserId: USER, status: 'accepted' },
      reference: { referenceId: REF, companyId: id(1), projectId: id(3), assigneeAgentId: id(2),
        issueId: ISSUE, state: 'linked', mailbox: 'hello@sunspark.energy' },
    },
  };
}
function setup(value = fixture()) {
  const calls = [];
  const resolve = createMailroomRunContextResolver(config, {
    readAuthenticatedActor: () => value.actor,
    readSnapshot: async (query) => { calls.push(query); return value.snapshot; },
  });
  return { resolve, calls, value };
}
const denied = (error) => error instanceof MailroomRunContextDenied
  && error.message === 'mailroom_run_context_denied' && error.cause === undefined;

 test('authorized exact current execution uses one snapshot and returns frozen narrow data', async () => {
  const { resolve, calls } = setup();
  const result = await resolve(REF);
  assert.deepEqual(result, { companyId: id(1), agentId: id(2), runId: RUN,
    issueId: ISSUE, projectId: id(3), referenceId: REF, responsibleUserId: USER,
    access: 'hello_exact_context_read' });
  assert.equal(Object.isFrozen(result), true);
  assert.deepEqual(calls, [{ companyId: id(1), agentId: id(2), runId: RUN, referenceId: REF }]);
});

for (const [field, values] of Object.entries({
  type: ['board', 'none', undefined], source: ['agent_key', 'board_key', 'session', undefined],
  companyId: [id(99), undefined], agentId: [id(99), undefined], runId: ['', id(99), undefined],
  keyScope: [undefined, null, { kind: 'task_bridge' }, { kind: 'skill_test' }, { kind: 'standard', extra: true }],
  onBehalfOfUserId: ['', null, 'another-user'], keyId: [id(99)], identityContextId: [id(99), null],
})) {
  for (const [index, value] of values.entries()) test(`reject actor ${field} variant ${index}`, async () => {
    const f = fixture(); f.actor[field] = value;
    await assert.rejects(setup(f).resolve(REF), denied);
  });
}

for (const name of ['company', 'agent', 'run', 'issue', 'membership', 'identity', 'reference']) {
  test(`reject missing ${name}`, async () => {
    const f = fixture(); delete f.snapshot[name];
    await assert.rejects(setup(f).resolve(REF), denied);
  });
}

const mutations = [
  ['company', 'id', id(99)], ['company', 'status', 'paused'],
  ['agent', 'id', id(99)], ['agent', 'companyId', id(99)],
  ...['paused', 'terminated', 'pending_approval', 'idle', 'error'].map((s) => ['agent', 'status', s]),
  ['run', 'id', id(99)], ['run', 'companyId', id(99)], ['run', 'agentId', id(99)],
  ...['queued', 'succeeded', 'failed', 'cancelled', 'timed_out'].map((s) => ['run', 'status', s]),
  ['run', 'finishedAt', new Date()], ['run', 'finishedAt', undefined],
  ['run', 'responsibleUserId', 'another-user'], ['run', 'activeIdentityContextId', id(99)],
  ['run', 'resultJson', { executionCancellation: { state: 'requested' } }],
  ['run', 'resultJson', { executionCancellation: 'malformed' }],
  ['run', 'contextSnapshot', { issueId: ISSUE, taskId: id(99) }],
  ['run', 'nativeIssueId', id(99)], ['run', 'nativeIssueId', 'malformed'],
  ['issue', 'id', id(99)], ['issue', 'companyId', id(99)], ['issue', 'projectId', id(99)],
  ['issue', 'assigneeAgentId', id(99)], ['issue', 'assigneeUserId', USER],
  ['issue', 'checkoutRunId', null], ['issue', 'executionRunId', null],
  ['issue', 'checkoutRunId', id(99)], ['issue', 'executionRunId', id(99)],
  ['issue', 'hiddenAt', new Date()], ['issue', 'responsibleUserId', 'another-user'],
  ...['backlog', 'todo', 'in_review', 'blocked', 'done', 'cancelled'].map((s) => ['issue', 'status', s]),
  ['membership', 'companyId', id(99)], ['membership', 'principalId', 'another-user'],
  ['membership', 'principalType', 'agent'], ['membership', 'status', 'inactive'],
  ['identity', 'id', id(99)], ['identity', 'companyId', id(99)], ['identity', 'runId', id(99)],
  ['identity', 'responsibleUserId', 'another-user'], ['identity', 'status', 'pending'],
  ['reference', 'referenceId', id(99)], ['reference', 'companyId', id(99)],
  ['reference', 'projectId', id(99)], ['reference', 'assigneeAgentId', id(99)],
  ['reference', 'issueId', id(99)], ['reference', 'state', 'reserved'],
  ['reference', 'mailbox', 'vendors@sunspark.energy'], ['reference', 'mailbox', 'bradley@sunspark.energy'],
];
for (const [index, [name, field, value]] of mutations.entries()) {
  test(`reject snapshot ${name}.${field} variant ${index}`, async () => {
    const f = fixture(); f.snapshot[name][field] = value;
    await assert.rejects(setup(f).resolve(REF), denied);
  });
}

 test('missing task source cannot be supplied through marker or request object', async () => {
  const f = fixture(); f.snapshot.run.nativeIssueId = null; f.snapshot.run.contextSnapshot = {};
  f.snapshot.issue.description = `Restricted email context reference: ${REF}`;
  await assert.rejects(setup(f).resolve(REF), denied);
  await assert.rejects(setup().resolve({ referenceId: REF, issueId: ISSUE, actor: fixture().actor }), denied);
});
 test('legacy single taskId works only with both-null identity and current user checks', async () => {
  const f = fixture(); f.actor.identityContextId = null; f.snapshot.run.activeIdentityContextId = null;
  f.snapshot.identity = null; f.snapshot.run.nativeIssueId = null;
  f.snapshot.run.contextSnapshot = { taskId: ISSUE };
  assert.equal((await setup(f).resolve(REF)).issueId, ISSUE);
  f.snapshot.membership.status = 'inactive';
  await assert.rejects(setup(f).resolve(REF), denied);
});
 test('fresh snapshot is required on every call and reassignment revokes result', async () => {
  const { resolve, calls, value } = setup();
  await resolve(REF); value.snapshot.issue.assigneeAgentId = id(99);
  await assert.rejects(resolve(REF), denied); assert.equal(calls.length, 2);
});
 test('invalid actor is denied before snapshot lookup', async () => {
  const f = fixture(); f.actor.source = 'agent_key';
  const { resolve, calls } = setup(f);
  await assert.rejects(resolve(REF), denied); assert.equal(calls.length, 0);
});
 test('lookup failure is generic with no raw cause', async () => {
  const resolve = createMailroomRunContextResolver(config, {
    readAuthenticatedActor: () => fixture().actor,
    readSnapshot: async () => { throw Error('private snapshot content'); },
  });
  await assert.rejects(resolve(REF), denied);
});
 test('configuration copied before later mutation', async () => {
  const own = { ...config }; const f = fixture();
  const resolve = createMailroomRunContextResolver(own, {
    readAuthenticatedActor: () => f.actor, readSnapshot: async () => f.snapshot,
  });
  own.companyId = id(99); assert.equal((await resolve(REF)).companyId, config.companyId);
});
 test('module has no runtime imports, environment activation, logging or transport', () => {
  const text = readFileSync(new URL('../../server/src/services/mailroom-run-context.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(text, /^import\s/m);
  assert.doesNotMatch(text, /process\.env|console\.|fetch\(/);
});

for (const enabled of [undefined, false, null, 'true', 1]) {
  test(`disabled gate ${String(enabled)} performs no actor or snapshot access`, async () => {
    let calls = 0;
    const own = { ...config, enabled };
    const resolve = createMailroomRunContextResolver(own, {
      readAuthenticatedActor: () => { calls++; return fixture().actor; },
      readSnapshot: async () => { calls++; return fixture().snapshot; },
    });
    own.enabled = true;
    await assert.rejects(resolve(REF), denied);
    await assert.rejects(resolve({ referenceId: REF, enabled: true }), denied);
    assert.equal(calls, 0);
  });
}
