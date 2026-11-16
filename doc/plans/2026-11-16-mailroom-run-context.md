# Mailroom Sonya run-context authorization: disabled milestone

Date: 2026-11-16. Branch: `feat/mailroom-run-context`.
Base: `8b4f6b26fdb3a5a426138cf27c8b4e9973a888f2`.

## Scope

`server/src/services/mailroom-run-context.ts` is an unwired internal evaluator.
It has no route, middleware edits, service-barrel export, DB adapter, credential
loading, environment activation or email reads. Injected `enabled` must be exactly
`true`; default, false and malformed values deny before reading actor or snapshot.
The value is copied at construction and cannot be enabled through request data.

The trusted caller must obtain the actor from existing verified `req.actor`, not
request JSON. Structural types do not authenticate an actor. Only Sonya's exact
configured company/project and `agent_jwt` with normalized standard scope qualify.
The conservative first slice requires a running agent and run, an `in_progress`
issue with both checkout and execution locks matching that run, no cancellation
evidence, and current matching responsible user, active membership and accepted
identity when present. Pre-checkout, task-transition and incomplete-identity
windows fail closed. Both-null legacy identity still requires all current
responsible-user, membership and task checks.

## Identity Intersection Preflight

Owner explicitly cleared the identified intersections for this disabled milestone.

1. **Does the task touch identity or authentication middleware? YES.** It consumes
   verified authentication identity; existing middleware is unchanged.
2. **Does it touch an RBAC resolver, role assignment, persona mapping, or operator
   identity? NO.** No existing RBAC resolver, roles or identity records change.
3. **Does it touch a route that is part of an unresolved public-hostname or
   authorization gate? NO.** No route is registered or modified.
4. **Does it change Comms access behavior? YES.** It defines a restricted future
   email-context authorization decision, disabled and unwired in this milestone.
5. **Does it change CONTRACT_VERSION or iOS API-contract semantics? NO.** No
   dashboard, shared API or iOS contract changes.
6. **Does it invalidate a pinned pc9/Identity assumption? NO.** No pinned component
   or existing behavior changes; future integration must recheck this boundary.
7. **Does it alter production behavior required by an active Identity validation
   artifact? NO.** Nothing is connected to production execution.

## Injected snapshot mapping and trust boundary

Each invocation obtains one fresh snapshot from a trusted injected reader. The
snapshot must include current company, agent, heartbeat run, issue, responsible
user membership, optional accepted run identity and private source-reference
projections. Query inputs are the validated configured company/agent, verified
actor run and requested opaque reference. No caller-selected task is accepted.

- Run task identity comes from persisted `nativeIssueId`, `contextSnapshot.issueId`
  and `contextSnapshot.taskId`; at least one is required and all present IDs must
  agree. Task/run/company/assignee and project are independently cross-checked.
- Membership uses `principalType=user`, `principalId`, `companyId`, and `status`.
- Modern identity links actor `identityContextId`, run `activeIdentityContextId`,
  and accepted identity `id`, `runId`, `companyId`, `responsibleUserId`.
- The private reference projects existing SQLite `reference_id`, `project_id`,
  `assignee_agent_id`, `issue_id` and `state` to camelCase. Mailbox is derived from
  its stored source and must equal `hello@sunspark.energy`; state must be `linked`.
- **`companyId` is not a column in that SQLite reference store.** A future adapter
  must derive it independently from trusted store ownership/configuration and
  enforce that binding. Neither an issue marker nor caller JSON establishes it.

The snapshot reader is a contract, not an implemented storage adapter. Paperclip's
DB and the private SQLite store are separate systems: **this milestone establishes
no atomic cross-store snapshot or transaction**. A production design must prove
consistent source/link and task/run observations or fail closed. The current
synthetic fixtures do not prove production isolation, authentication integration,
JWT revocation behavior or datastore freshness.

The returned frozen decision contains no email body or credential and is only a
point-in-time observation. It is not a reusable bearer capability. Every future
read must reauthorize, and its cancellation/reassignment snapshot-to-use window
must be addressed before returning email context. Injected callbacks are trusted
server code, not sandboxed plugins or untrusted input.

## Verification and remaining gates

Dedicated dependency-free harness:

```sh
node --test scripts/smoke/mailroom-run-context.test.mjs
```

Current result: **105 passed, 0 failed** on Node 25.9.0 using native type stripping.
This exercises runtime validation, not TypeScript static checking. The harness is
not registered with standard Vitest discovery. `git diff --check` also passed.
Workspace dependencies, pnpm and tsc were unavailable; repository typecheck,
standard Vitest suite and build were **not run**. No dependency installation or
production-package reuse was performed.

Before production integration, separately review and approve:

1. Independent code review and normal workspace typecheck/test/build qualification.
2. Real middleware-to-service actor binding, with no client-controlled identity.
3. Authoritative snapshot/storage adapter and cross-store consistency strategy.
4. Cancellation/reassignment reauthorization at context-read use time.
5. Narrow authenticated context transport and effective hello-only read permissions.
6. Any route registration, runtime wiring, deployment and bounded live validation.

No push, merge, deployment, permissions change or live mailbox action is included.
