/**
 * UNWIRED Mailroom/Sonya run-context authorization evaluator.
 *
 * No route, middleware, DB adapter, environment gate, or service-barrel export is
 * provided. Importing this file cannot activate it; injected enabled must be true
 * (default false). This is NOT authentication:
 * readAuthenticatedActor must read the existing verified req.actor populated by
 * middleware, never body/query/header JSON or model-supplied actor/task strings.
 * Its structural TypeScript types cannot establish that provenance.
 *
 * readSnapshot must perform ONE fresh, consistent, server-owned read containing
 * the current company/agent/run/issue/membership/identity/private-reference rows.
 * A future adapter must prove those rows share a transaction/snapshot and that
 * the private link is authoritative; descriptions and reference markers are not
 * a substitute. No current production storage integration is claimed here.
 *
 * The result is a point-in-time decision, not a reusable bearer capability. A
 * future consumer must reauthorize each read and address the snapshot-to-use
 * boundary (including cancellation/reassignment) before returning email data.
 */

export type MailroomRunContextConfig = Readonly<{
  enabled?: boolean;
  companyId: string;
  sonyaAgentId: string;
  projectId: string;
}>;

export type MailroomRunContextQuery = Readonly<{
  companyId: string;
  agentId: string;
  runId: string;
  referenceId: string;
}>;

export type MailroomRunContextDependencies = Readonly<{
  readAuthenticatedActor: () => unknown;
  readSnapshot: (query: MailroomRunContextQuery) => Promise<unknown>;
}>;

export type MailroomRunContextDecision = Readonly<{
  companyId: string;
  agentId: string;
  runId: string;
  issueId: string;
  projectId: string;
  referenceId: string;
  responsibleUserId: string;
  access: "hello_exact_context_read";
}>;

export class MailroomRunContextDenied extends Error {
  constructor() {
    super("mailroom_run_context_denied");
    this.name = "MailroomRunContextDenied";
  }
}

type Row = Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HELLO = "hello@sunspark.energy";

function deny(): never {
  throw new MailroomRunContextDenied();
}

function row(value: unknown): Row {
  if (value === null || typeof value !== "object" || Array.isArray(value)) deny();
  return value as Row;
}

function uuid(value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value)) deny();
  return value;
}

function userId(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 256
    || value !== value.trim() || /[\x00-\x1f\x7f]/.test(value)) deny();
  return value;
}

function same(actual: unknown, expected: string): void {
  if (actual !== expected) deny();
}

function absent(value: unknown): boolean {
  return value === undefined || value === null;
}

/** Default policy deliberately excludes pre-checkout and task-transition windows. */
export function createMailroomRunContextResolver(
  config: MailroomRunContextConfig,
  dependencies: MailroomRunContextDependencies,
): (referenceId: unknown) => Promise<MailroomRunContextDecision> {
  // Copy configuration so mutation of the caller's object cannot widen this resolver.
  const enabled = config.enabled === true;
  const companyId = uuid(config.companyId);
  const sonyaAgentId = uuid(config.sonyaAgentId);
  const projectId = uuid(config.projectId);
  const { readAuthenticatedActor, readSnapshot } = dependencies;
  if (typeof readAuthenticatedActor !== "function" || typeof readSnapshot !== "function") deny();

  return async (requestedReferenceId: unknown): Promise<MailroomRunContextDecision> => {
    try {
      if (!enabled) deny();
      const referenceId = uuid(requestedReferenceId);
      const actor = row(readAuthenticatedActor());
      if (actor.type !== "agent" || actor.source !== "agent_jwt" || !absent(actor.keyId)) deny();
      const scope = row(actor.keyScope);
      if (scope.kind !== "standard" || Object.keys(scope).length !== 1) deny();
      same(actor.companyId, companyId);
      same(actor.agentId, sonyaAgentId);
      const runId = uuid(actor.runId);
      const responsibleUserId = userId(actor.onBehalfOfUserId);
      // Copy trusted actor values before the asynchronous boundary.
      const actorIdentityId = absent(actor.identityContextId) ? null : uuid(actor.identityContextId);
      const query = Object.freeze({ companyId, agentId: sonyaAgentId, runId, referenceId });
      const snapshot = row(await readSnapshot(query));
      const company = row(snapshot.company);
      const agent = row(snapshot.agent);
      const run = row(snapshot.run);
      const issue = row(snapshot.issue);
      const membership = row(snapshot.membership);
      const reference = row(snapshot.reference);

      same(company.id, companyId);
      if (company.status !== "active") deny();
      same(agent.id, sonyaAgentId);
      same(agent.companyId, companyId);
      if (agent.status !== "running") deny();

      same(run.id, runId);
      same(run.companyId, companyId);
      same(run.agentId, sonyaAgentId);
      if (run.status !== "running" || run.finishedAt !== null) deny();
      same(run.responsibleUserId, responsibleUserId);
      // Conservatively deny any recorded cancellation evidence, including the
      // requested state which can precede terminal run status.
      if (!absent(run.resultJson)) {
        const result = row(run.resultJson);
        if (!absent(result.executionCancellation)) deny();
      }

      const context = absent(run.contextSnapshot) ? {} : row(run.contextSnapshot);
      const sourceIds = [run.nativeIssueId, context.issueId, context.taskId]
        .filter((value) => !absent(value)).map(uuid);
      if (sourceIds.length === 0 || sourceIds.some((id) => id !== sourceIds[0])) deny();
      const issueId = sourceIds[0]!;
      same(issue.id, issueId);
      same(issue.companyId, companyId);
      same(issue.projectId, projectId);
      same(issue.assigneeAgentId, sonyaAgentId);
      same(issue.responsibleUserId, responsibleUserId);
      if (issue.assigneeUserId !== null || issue.hiddenAt !== null
        || issue.status !== "in_progress") deny();
      same(issue.checkoutRunId, runId);
      same(issue.executionRunId, runId);

      same(membership.companyId, companyId);
      same(membership.principalId, responsibleUserId);
      if (membership.principalType !== "user" || membership.status !== "active") deny();

      // Modern accepted identities must agree across authenticated actor, run,
      // and authoritative identity row. Legacy both-null identity is accepted
      // only with all current responsible-user/task/membership checks above.
      const runIdentityId = absent(run.activeIdentityContextId) ? null : uuid(run.activeIdentityContextId);
      if (actorIdentityId !== runIdentityId) deny();
      if (runIdentityId !== null) {
        const identity = row(snapshot.identity);
        same(identity.id, runIdentityId);
        same(identity.companyId, companyId);
        same(identity.runId, runId);
        same(identity.responsibleUserId, responsibleUserId);
        if (identity.status !== "accepted") deny();
      } else if (!absent(snapshot.identity)) {
        deny();
      }

      // The adapter projects existing private-store reference_id, project_id,
      // assignee_agent_id, issue_id and state to camelCase, derives mailbox from
      // its source, and establishes companyId independently from trusted storage
      // ownership. This is not a proposed database schema or a public API.
      // A private source reference is a locator, not a grant. Every binding must
      // match the authenticated current execution; no title/description is read.
      same(reference.referenceId, referenceId);
      same(reference.companyId, companyId);
      same(reference.projectId, projectId);
      same(reference.assigneeAgentId, sonyaAgentId);
      same(reference.issueId, issueId);
      if (reference.state !== "linked" || reference.mailbox !== HELLO) deny();

      return Object.freeze({ companyId, agentId: sonyaAgentId, runId, issueId,
        projectId, referenceId, responsibleUserId, access: "hello_exact_context_read" });
    } catch {
      // No raw actor, snapshot, source identifiers, transport exception, or
      // private reference data is logged or attached as an Error cause.
      throw new MailroomRunContextDenied();
    }
  };
}
