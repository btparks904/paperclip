// PG-4: the shared guarded hire-approval path. Real routes and services on
// embedded PostgreSQL, mkdtemp homes, and synthetic actors and sentinel values
// only. The actor is injected by a test middleware; real session
// authentication is not exercised.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import {
  activityLog, agents, approvals, authUsers, companies, companyMemberships, companySecretBindings, companySecrets, createDb,
  instanceUserRoles, principalPermissionGrants,
} from "@paperclipai/db";
import { agentRoutes } from "../routes/agents.js";
import { approvalRoutes } from "../routes/approvals.js";
import { errorHandler } from "../middleware/index.js";
import { approvalService } from "../services/approvals.js";
import { resolveInstructionVersionRoot, resolveManagedInstructionsRoot } from "../services/agent-instructions.js";
import { INSTRUCTION_ROOT_IN_USE, resolveManagedAgentArea } from "../services/instruction-root-exclusivity.js";
import { HIRE_INSTRUCTION_AMENDMENT_ACTION } from "../services/hire-approval-authorization.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

// The hire-approved hook is an outward success effect: it must fire only for a committed approval.
const hireHook = vi.hoisted(() => ({ notifyHireApproved: vi.fn() }));
vi.mock("../services/hire-hook.js", () => hireHook);

type Actor = Record<string, unknown>;
type Config = Record<string, unknown>;
const RAW_API_KEY = "SENTINEL-SYNTHETIC-RAW-API-KEY-PG4";
const STALE = "hire_approval_instruction_config_stale";
const AGENT_AUTHORED = "hire_approval_agent_authored_protected_config";
// An adapter with an instructions bundle, so the hire route materializes a managed snapshot.
const MANAGED_ADAPTER = "claude_local";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("PG-4: guarded hire-approval path", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let home: string, companyId: string, otherCompanyId: string, userId: string, otherUserId: string;

  const board = (overrides: Actor = {}): Actor => ({
    type: "board", userId, companyIds: [companyId], source: "session", isInstanceAdmin: false, ...overrides });
  const localBoard = (): Actor => ({ type: "board", userId, companyIds: [companyId], source: "local_implicit", isInstanceAdmin: true });
  const agentActor = (agentId: string, company = companyId): Actor => ({ type: "agent", agentId, companyId: company, source: "agent_key" });
  const app = (actor: Actor) => {
    const server = express();
    server.use(express.json());
    server.use((req, _res, next) => { (req as any).actor = { ...actor }; next(); });
    server.use("/api", agentRoutes(db as any));
    server.use("/api", approvalRoutes(db as any));
    server.use(errorHandler);
    return server;
  };
  const send = (actor: Actor, method: "post" | "patch", url: string, body: Record<string, unknown> = {}) =>
    request(app(actor))[method](url).send(body).then((res) => res);

  const ext = (label: string) => {
    const root = path.join(home, "external", `${label}-${randomUUID()}`);
    return { instructionsBundleMode: "external", instructionsRootPath: root, instructionsEntryFile: "AGENTS.md", instructionsFilePath: path.join(root, "AGENTS.md") };
  };
  const base = (name = `PG4-${randomUUID().slice(0, 8)}`) => ({ name, role: "general", adapterType: "hermes_gateway" });

  const grant = (principalType: "user" | "agent", principalId: string, company = companyId) => db.insert(principalPermissionGrants)
    .values({ companyId: company, principalType, principalId, permissionKey: "agents:create", scope: null });
  const revoke = (principalId: string) => db.delete(principalPermissionGrants)
    .where(and(eq(principalPermissionGrants.principalId, principalId), eq(principalPermissionGrants.permissionKey, "agents:create")));
  const makeInstanceAdmin = (id: string) => db.insert(instanceUserRoles).values({ userId: id, role: "instance_admin" });
  async function seedAgent(values: Partial<typeof agents.$inferInsert> = {}) {
    const id = values.id ?? randomUUID();
    await db.insert(agents).values({ id, companyId, name: `A-${id.slice(0, 8)}`, role: "general", adapterType: "hermes_gateway",
      adapterConfig: { model: "m0" }, ...values });
    return id;
  }
  const requireApproval = () => db.update(companies).set({ requireBoardApprovalForNewAgents: true }).where(eq(companies.id, companyId));
  const loadAgent = async (id: string) => (await db.select().from(agents).where(eq(agents.id, id)))[0];
  const loadApproval = async (id: string) => (await db.select().from(approvals).where(eq(approvals.id, id)))[0]!;
  const insertApproval = async (payload: Config, values: Partial<typeof approvals.$inferInsert> = {}) =>
    (await db.insert(approvals).values({ companyId, type: "hire_agent", status: "pending", payload, ...values }).returning())[0]!;

  /** Every persistent effect a denied operation must not produce. */
  async function effects() {
    const companyAgentsDir = path.dirname(resolveManagedAgentArea({ id: randomUUID(), companyId }));
    return {
      agents: (await db.select({ id: agents.id, status: agents.status, adapterConfig: agents.adapterConfig, instructionBundleId: agents.instructionBundleId })
        .from(agents).where(eq(agents.companyId, companyId))).sort((a, b) => a.id.localeCompare(b.id)),
      approvals: (await db.select({ id: approvals.id, status: approvals.status, payload: approvals.payload, updatedAt: approvals.updatedAt })
        .from(approvals).where(eq(approvals.companyId, companyId))).sort((a, b) => a.id.localeCompare(b.id)),
      secrets: (await db.select({ id: companySecrets.id }).from(companySecrets).where(eq(companySecrets.companyId, companyId))).length,
      bindings: (await db.select({ id: companySecretBindings.id }).from(companySecretBindings).where(eq(companySecretBindings.companyId, companyId))).length,
      agentFolders: (await fs.readdir(companyAgentsDir).catch(() => [] as string[])).sort(),
    };
  }
  async function expectNoEffects(before: Awaited<ReturnType<typeof effects>>) {
    expect(await effects()).toEqual(before);
    expect(hireHook.notifyHireApproved).not.toHaveBeenCalled();
  }

  /** A managed pending hire through the real hire route (server-generated snapshot). */
  async function managedPendingHire(actor: Actor = localBoard(), extra: Config = {}) {
    await requireApproval();
    const res = await send(actor, "post", `/api/companies/${companyId}/agent-hires`, { ...base(), adapterType: MANAGED_ADAPTER, adapterConfig: {}, ...extra });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return { agentId: res.body.agent.id as string, approvalId: res.body.approval.id as string, payload: res.body.approval.payload as Config };
  }

  const rowLockWaiters = async () => {
    const rows = await db.execute(sql`select count(*)::int as n from pg_stat_activity
      where datname = current_database() and wait_event_type = 'Lock' and wait_event in ('tuple', 'transactionid')`);
    return Number((rows as unknown as Array<{ n: number }>)[0]?.n ?? 0);
  };
  async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 5_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await predicate()) return true;
      await sleep(20);
    }
    return false;
  }
  /** Holds a row lock in its own transaction, after optional work on it, until release(). */
  async function holdRow(lock: (tx: any) => Promise<unknown>) {
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    let held!: () => void;
    const isHeld = new Promise<void>((resolve) => { held = resolve; });
    const done = db.transaction(async (tx) => { await lock(tx); held(); await released; });
    await isHeld;
    return { release, done };
  }
  const settle = (promise: Promise<unknown>) => promise.then(
    (value) => ({ ok: true as const, value }),
    (error: any) => ({ ok: false as const, status: error?.status as number | undefined, code: error?.details?.code as string | undefined, message: String(error?.message) }));

  beforeAll(async () => {
    home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pg4-hire-")));
    process.env.PAPERCLIP_HOME = home;
    database = await startEmbeddedPostgresTestDatabase("pg4-hire-db-");
    db = createDb(database.connectionString);
  }, 90_000);
  afterAll(async () => { await database?.cleanup(); await fs.rm(home, { recursive: true, force: true }); });
  beforeEach(async () => {
    hireHook.notifyHireApproved.mockReset();
    hireHook.notifyHireApproved.mockResolvedValue(undefined);
    companyId = randomUUID(); otherCompanyId = randomUUID(); userId = randomUUID(); otherUserId = randomUUID();
    await db.insert(companies).values([
      { id: companyId, name: "PG4", issuePrefix: randomUUID().slice(0, 8) },
      { id: otherCompanyId, name: "PG4-other", issuePrefix: randomUUID().slice(0, 8) },
    ]);
    await db.insert(authUsers).values([
      { id: userId, name: "Operator", email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() },
      { id: otherUserId, name: "Other", email: `${otherUserId}@example.test`, createdAt: new Date(), updatedAt: new Date() },
    ]);
    await db.insert(companyMemberships).values([
      { companyId, principalType: "user", principalId: userId, membershipRole: "operator" },
      { companyId: otherCompanyId, principalType: "user", principalId: otherUserId, membershipRole: "operator" },
    ]);
  });

  describe("request: create and resubmit need current agents:create", () => {
    it("board without agents:create: 403; no approval, secret, binding, agent or folder is created", async () => {
      const before = await effects();
      const res = await send(board(), "post", `/api/companies/${companyId}/approvals`,
        { type: "hire_agent", payload: { ...base(), adapterConfig: { env: { API_KEY: RAW_API_KEY } } } });
      expect(res.status).toBe(403);
      await expectNoEffects(before);
    });

    it("board with agents:create: 201, attributed to the authenticated user", async () => {
      await grant("user", userId);
      const res = await send(board(), "post", `/api/companies/${companyId}/approvals`,
        { type: "hire_agent", payload: { ...base(), adapterConfig: { env: { API_KEY: RAW_API_KEY } } } });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body.requestedByUserId).toBe(userId);
      expect(res.body.requestedByAgentId).toBeNull();
    });

    it("a board user of another company: 403, nothing created", async () => {
      await grant("user", otherUserId, otherCompanyId);
      const before = await effects();
      const res = await send(board({ userId: otherUserId, companyIds: [otherCompanyId] }), "post", `/api/companies/${companyId}/approvals`,
        { type: "hire_agent", payload: base() });
      expect(res.status).toBe(403);
      await expectNoEffects(before);
    });

    it("agent actors: allowed with the hiring permission, denied without it, denied from another company", async () => {
      const hirer = await seedAgent({ permissions: { canCreateAgents: true } });
      const plain = await seedAgent({ permissions: { canCreateAgents: false } });
      const foreign = await seedAgent({ companyId: otherCompanyId, permissions: { canCreateAgents: true } });
      const before = await effects();
      const denied = await send(agentActor(plain), "post", `/api/companies/${companyId}/approvals`, { type: "hire_agent", payload: base() });
      expect(denied.status).toBe(403);
      const cross = await send(agentActor(foreign, otherCompanyId), "post", `/api/companies/${companyId}/approvals`, { type: "hire_agent", payload: base() });
      expect(cross.status).toBe(403);
      await expectNoEffects(before);
      const allowed = await send(agentActor(hirer), "post", `/api/companies/${companyId}/approvals`, { type: "hire_agent", payload: base() });
      expect(allowed.status, JSON.stringify(allowed.body)).toBe(201);
      expect(allowed.body.requestedByAgentId).toBe(hirer);
    });

    it("requester attribution is checked, never trusted: an agent cannot request as another agent; a board requester must be in the company", async () => {
      await grant("user", userId);
      const hirer = await seedAgent({ permissions: { canCreateAgents: true } });
      const other = await seedAgent();
      const foreign = await seedAgent({ companyId: otherCompanyId });
      const before = await effects();
      const spoofed = await send(agentActor(hirer), "post", `/api/companies/${companyId}/approvals`,
        { type: "hire_agent", requestedByAgentId: other, payload: base() });
      expect(spoofed.status).toBe(403);
      const crossRequester = await send(board(), "post", `/api/companies/${companyId}/approvals`,
        { type: "hire_agent", requestedByAgentId: foreign, payload: base() });
      expect(crossRequester.status).toBe(422);
      await expectNoEffects(before);
    });

    it("non-hire approvals keep the existing company_scope:read rule", async () => {
      const res = await send(board(), "post", `/api/companies/${companyId}/approvals`,
        { type: "approve_ceo_strategy", payload: { plan: "SENTINEL" } });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
    });

    it("resubmit: the requesting agent only, with current agents:create; a revoked requester cannot resubmit even the unchanged payload", async () => {
      const hirer = await seedAgent({ permissions: { canCreateAgents: true } });
      const other = await seedAgent({ permissions: { canCreateAgents: true } });
      const created = await send(agentActor(hirer), "post", `/api/companies/${companyId}/approvals`, { type: "hire_agent", payload: base("Resubmit") });
      expect(created.status).toBe(201);
      await send(localBoard(), "post", `/api/approvals/${created.body.id}/request-revision`, {});
      const notRequester = await send(agentActor(other), "post", `/api/approvals/${created.body.id}/resubmit`, {});
      expect(notRequester.status).toBe(403);
      await db.update(agents).set({ permissions: { canCreateAgents: false } }).where(eq(agents.id, hirer));
      const before = await effects();
      const revoked = await send(agentActor(hirer), "post", `/api/approvals/${created.body.id}/resubmit`, {});
      expect(revoked.status).toBe(403);
      await expectNoEffects(before);
      await db.update(agents).set({ permissions: { canCreateAgents: true } }).where(eq(agents.id, hirer));
      const ok = await send(agentActor(hirer), "post", `/api/approvals/${created.body.id}/resubmit`, { payload: base("Resubmitted") });
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
      expect(ok.body.status).toBe("pending");
    });
  });

  describe("agent-authored requests: no instruction or host-command changes", () => {
    it.each([
      ["a managed-mode root", () => ({ instructionsBundleMode: "managed", instructionsRootPath: path.join(home, "claimed") })],
      ["a legacy instructions file", () => ({ instructionsFilePath: path.join(home, "legacy", "AGENTS.md") })],
      ["the legacy agentsMdPath key", () => ({ agentsMdPath: "AGENTS.md" })],
      ["a host-executed workspace command", () => ({ workspaceStrategy: { provisionCommand: "echo SENTINEL" } })],
    ])("an agent cannot create a new-agent request carrying %s (403, nothing created)", async (_label, config) => {
      const hirer = await seedAgent({ permissions: { canCreateAgents: true } });
      const before = await effects();
      const res = await send(agentActor(hirer), "post", `/api/companies/${companyId}/approvals`,
        { type: "hire_agent", payload: { ...base(), adapterConfig: config() } });
      expect(res.status).toBe(403);
      await expectNoEffects(before);
    });

    it("an agent may resubmit the server-generated managed snapshot unchanged, but not an instruction delta", async () => {
      const hirer = await seedAgent({ permissions: { canCreateAgents: true } });
      const hire = await send(agentActor(hirer), "post", `/api/companies/${companyId}/agent-hires`, { ...base(), adapterType: MANAGED_ADAPTER, adapterConfig: {} })
        .then(async (res) => { expect(res.status).toBe(201); return res; });
      await requireApproval();
      const pending = await send(agentActor(hirer), "post", `/api/companies/${companyId}/agent-hires`, { ...base(), adapterType: MANAGED_ADAPTER, adapterConfig: {} });
      expect(pending.status, JSON.stringify(pending.body)).toBe(201);
      expect(hire.body.agent.status).toBe("idle");
      const approvalId = pending.body.approval.id as string;
      const snapshot = (await loadApproval(approvalId)).payload as Config;
      expect((snapshot.adapterConfig as Config).instructionsBundleMode).toBe("managed");
      await send(localBoard(), "post", `/api/approvals/${approvalId}/request-revision`, {});
      const before = await effects();
      const delta = await send(agentActor(hirer), "post", `/api/approvals/${approvalId}/resubmit`,
        { payload: { ...snapshot, adapterConfig: { ...(snapshot.adapterConfig as Config), ...ext("agent-delta") } } });
      expect(delta.status).toBe(409);
      expect(delta.body.details?.code ?? delta.body.code).toBe(STALE);
      await expectNoEffects(before);
      const flagged = await send(agentActor(hirer), "post", `/api/approvals/${approvalId}/resubmit`,
        { payload: { ...snapshot, adapterConfig: { ...(snapshot.adapterConfig as Config), instructionsEntryFile: "MAIN.md" } }, instructionAmendment: true });
      expect(flagged.status).toBe(403);
      await expectNoEffects(before);
      const same = await send(agentActor(hirer), "post", `/api/approvals/${approvalId}/resubmit`, { payload: snapshot });
      expect(same.status, JSON.stringify(same.body)).toBe(200);
    });
  });

  describe("external roots need instance-admin authorization (effective root, not the claimed mode)", () => {
    it.each([
      ["an explicit external root", () => ext("explicit")],
      ["a legacy absolute instructions file with no mode", () => ({ instructionsFilePath: path.join(home, "legacy-ext", randomUUID(), "AGENTS.md") })],
      ["a misleading managed mode naming an outside folder", () => ({ instructionsBundleMode: "managed", instructionsRootPath: path.join(home, "outside", randomUUID()) })],
    ])("request with %s: a non-admin board user with agents:create gets 403 and nothing is created", async (_label, config) => {
      await grant("user", userId);
      const before = await effects();
      const res = await send(board(), "post", `/api/companies/${companyId}/approvals`,
        { type: "hire_agent", payload: { ...base(), adapterConfig: config() } });
      expect(res.status).toBe(403);
      expect(res.body.error).toBe("Instance admin access required");
      await expectNoEffects(before);
    });

    it("an instance admin (database role) may request it; a non-admin decider is refused at approval; an admin decider creates it", async () => {
      await makeInstanceAdmin(userId);
      const root = ext("admin");
      const created = await send(board(), "post", `/api/companies/${companyId}/approvals`,
        { type: "hire_agent", payload: { ...base("Ext"), adapterConfig: root } });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      // A different board user with agents:create but no instance-admin role decides.
      await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: otherUserId, membershipRole: "operator" });
      await grant("user", otherUserId);
      const before = await effects();
      const refused = await send(board({ userId: otherUserId }), "post", `/api/approvals/${created.body.id}/approve`, {});
      expect(refused.status).toBe(403);
      await expectNoEffects(before);
      const approved = await send(board(), "post", `/api/approvals/${created.body.id}/approve`, {});
      expect(approved.status, JSON.stringify(approved.body)).toBe(200);
      const [agent] = await db.select().from(agents).where(and(eq(agents.companyId, companyId), eq(agents.name, "Ext")));
      expect(agent!.status).toBe("idle");
      expect((agent!.adapterConfig as Config).instructionsRootPath).toBe(root.instructionsRootPath);
      expect(hireHook.notifyHireApproved).toHaveBeenCalledTimes(1);
    });

    it("the decision re-reads instance-admin status: a stale request-time admin flag is not trusted", async () => {
      const created = await send(localBoard(), "post", `/api/companies/${companyId}/approvals`,
        { type: "hire_agent", payload: { ...base(), adapterConfig: ext("stale-flag") } });
      expect(created.status).toBe(201);
      await grant("user", userId);
      const before = await effects();
      const res = await send(board({ isInstanceAdmin: true }), "post", `/api/approvals/${created.body.id}/approve`, {});
      expect(res.status).toBe(403);
      await expectNoEffects(before);
    });
  });

  describe("decision and activation: every branch", () => {
    it("ordinary managed hiring: a board user with agents:create hires and self-approves (linked activation)", async () => {
      await grant("user", userId);
      const { agentId, approvalId } = await managedPendingHire(board());
      expect((await loadApproval(approvalId)).requestedByUserId).toBe(userId);
      const res = await send(board(), "post", `/api/approvals/${approvalId}/approve`, {});
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const agent = (await loadAgent(agentId))!;
      expect(agent.status).toBe("idle");
      expect((agent.adapterConfig as Config).instructionsBundleMode).toBe("managed");
      expect((agent.adapterConfig as Config).instructionsRootPath).toBe(resolveManagedInstructionsRoot(agent));
      expect((await loadApproval(approvalId)).decidedByUserId).toBe(userId);
      expect(hireHook.notifyHireApproved).toHaveBeenCalledTimes(1);
    });

    it("an agent can never approve, even with the hiring permission", async () => {
      const hirer = await seedAgent({ permissions: { canCreateAgents: true } });
      const { approvalId } = await managedPendingHire();
      const before = await effects();
      const res = await send(agentActor(hirer), "post", `/api/approvals/${approvalId}/approve`, {});
      expect(res.status).toBe(403);
      const direct = await send(agentActor(hirer), "post", `/api/agents/${(await loadApproval(approvalId)).payload.agentId}/approve`, {});
      expect(direct.status).toBe(403);
      await expectNoEffects(before);
    });

    it("generic approval without agents:create: 403; the agent stays pending and the approval open", async () => {
      const { approvalId } = await managedPendingHire();
      const before = await effects();
      const res = await send(board(), "post", `/api/approvals/${approvalId}/approve`, {});
      expect(res.status).toBe(403);
      await expectNoEffects(before);
    });

    it("direct agent approval (linked): needs agents:create; allowed with it", async () => {
      const { agentId, approvalId } = await managedPendingHire();
      const before = await effects();
      const denied = await send(board(), "post", `/api/agents/${agentId}/approve`, {});
      expect(denied.status).toBe(403);
      await expectNoEffects(before);
      await grant("user", userId);
      const ok = await send(board(), "post", `/api/agents/${agentId}/approve`, {});
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
      expect((await loadAgent(agentId))!.status).toBe("idle");
      expect((await loadApproval(approvalId)).status).toBe("approved");
    });

    it("unlinked historical fallback: needs agents:create, and instance admin for an external current root", async () => {
      const managed = await seedAgent({ status: "pending_approval" });
      const external = await seedAgent({ status: "pending_approval", adapterConfig: { ...ext("fallback"), model: "m0" } });
      const before = await effects();
      expect((await send(board(), "post", `/api/agents/${managed}/approve`, {})).status).toBe(403);
      await grant("user", userId);
      expect((await send(board(), "post", `/api/agents/${external}/approve`, {})).status).toBe(403);
      await expectNoEffects(before);
      expect((await send(board(), "post", `/api/agents/${managed}/approve`, {})).status).toBe(200);
      expect((await loadAgent(managed))!.status).toBe("idle");
      expect((await send(localBoard(), "post", `/api/agents/${external}/approve`, {})).status).toBe(200);
      expect((await loadAgent(external))!.status).toBe("idle");
    });

    it("no-agentId branch: a denied decision creates nothing; an authorized one creates one idle agent with the approved budget", async () => {
      const approval = await insertApproval({ ...base("Fresh"), budgetMonthlyCents: 500, adapterConfig: { model: "m1" } });
      const before = await effects();
      expect((await send(board(), "post", `/api/approvals/${approval.id}/approve`, {})).status).toBe(403);
      await expectNoEffects(before);
      await grant("user", userId);
      const res = await send(board(), "post", `/api/approvals/${approval.id}/approve`, {});
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const created = (await db.select().from(agents).where(and(eq(agents.companyId, companyId), eq(agents.name, "Fresh"))));
      expect(created).toHaveLength(1);
      expect(created[0]!.status).toBe("idle");
      expect(hireHook.notifyHireApproved).toHaveBeenCalledTimes(1);
    });

    it("the subject must be in the approval's company: a request naming another company's agent is 422; a historical one is refused at approval", async () => {
      await grant("user", userId);
      const foreignPending = await seedAgent({ companyId: otherCompanyId, status: "pending_approval" });
      const before = await effects();
      const res = await send(board(), "post", `/api/companies/${companyId}/approvals`,
        { type: "hire_agent", payload: { ...base(), agentId: foreignPending } });
      expect(res.status).toBe(422);
      await expectNoEffects(before);
      const historical = await insertApproval({ ...base(), agentId: foreignPending });
      const afterInsert = await effects();
      const approve = await send(localBoard(), "post", `/api/approvals/${historical.id}/approve`, {});
      expect(approve.status).toBe(409);
      await expectNoEffects(afterInsert);
      expect((await loadAgent(foreignPending))!.status).toBe("pending_approval");
    });

    it("a linked approval whose agent is no longer pending is refused (no false success, no hook)", async () => {
      const idle = await seedAgent({ status: "idle" });
      const approval = await insertApproval({ ...base(), agentId: idle, adapterConfig: { model: "m0" } });
      const before = await effects();
      const res = await send(localBoard(), "post", `/api/approvals/${approval.id}/approve`, {});
      expect(res.status).toBe(409);
      await expectNoEffects(before);
    });

    it("the plugin decision path uses the member's company grants only", async () => {
      const { approvalId } = await managedPendingHire();
      const svc = approvalService(db as any);
      const decider = { type: "board" as const, userId, isInstanceAdmin: false, ignoreInstanceAdmin: true };
      await makeInstanceAdmin(userId);
      const before = await effects();
      const refused = await settle(svc.approve(approvalId, userId, null, { decider }));
      expect(refused).toMatchObject({ ok: false, status: 403 });
      await expectNoEffects(before);
      await grant("user", userId);
      const ok = await settle(svc.approve(approvalId, userId, null, { decider }));
      expect(ok).toMatchObject({ ok: true, value: { applied: true } });
    });

    it("the service refuses a hire decision without a board decider", async () => {
      const { approvalId } = await managedPendingHire();
      const before = await effects();
      const res = await settle(approvalService(db as any).approve(approvalId, userId));
      expect(res).toMatchObject({ ok: false, status: 403 });
      await expectNoEffects(before);
    });
  });

  describe("pending and historical requests: no grandfathering, stale instructions refused", () => {
    it("a historical linked payload that changes the root is refused even for an instance admin; the evidence is kept", async () => {
      const { agentId, approvalId, payload } = await managedPendingHire();
      const stalePayload = { ...payload, adapterConfig: { ...(payload.adapterConfig as Config), ...ext("historical") } };
      await db.update(approvals).set({ payload: stalePayload }).where(eq(approvals.id, approvalId));
      const before = await effects();
      const res = await send(localBoard(), "post", `/api/approvals/${approvalId}/approve`, {});
      expect(res.status).toBe(409);
      expect(res.body.details?.code).toBe(STALE);
      await expectNoEffects(before);
      expect((await loadApproval(approvalId)).payload).toEqual(stalePayload);
      expect((await loadAgent(agentId))!.status).toBe("pending_approval");
    });

    it("a resubmit without a payload revalidates the kept payload (stale: 409, nothing changes)", async () => {
      const { approvalId, payload } = await managedPendingHire();
      await send(localBoard(), "post", `/api/approvals/${approvalId}/request-revision`, {});
      const stalePayload = { ...payload, adapterConfig: { ...(payload.adapterConfig as Config), ...ext("kept") } };
      await db.update(approvals).set({ payload: stalePayload }).where(eq(approvals.id, approvalId));
      const before = await effects();
      const res = await send(localBoard(), "post", `/api/approvals/${approvalId}/resubmit`, {});
      expect(res.status).toBe(409);
      await expectNoEffects(before);
    });

    it("a historical agent-requested new-agent payload with instruction keys is refused at approval; a fresh authorized resubmission is needed", async () => {
      const hirer = await seedAgent({ permissions: { canCreateAgents: true } });
      const approval = await insertApproval({ ...base("Hist"), adapterConfig: { instructionsBundleMode: "managed", instructionsEntryFile: "AGENTS.md" } },
        { requestedByAgentId: hirer });
      const before = await effects();
      const res = await send(localBoard(), "post", `/api/approvals/${approval.id}/approve`, {});
      expect(res.status).toBe(409);
      expect(res.body.details?.code).toBe(AGENT_AUTHORED);
      await expectNoEffects(before);
    });

    it("W2: a payload naming the legacy root after the agent moved to a versioned generation is refused; root and generation are kept", async () => {
      const { agentId, approvalId } = await managedPendingHire();
      const agent = (await loadAgent(agentId))!;
      const generation = randomUUID();
      const versionRoot = resolveInstructionVersionRoot(agent, generation);
      const movedConfig = { ...(agent.adapterConfig as Config), instructionsRootPath: versionRoot, instructionsFilePath: path.join(versionRoot, "AGENTS.md") };
      await db.update(agents).set({ instructionBundleId: generation, adapterConfig: movedConfig }).where(eq(agents.id, agentId));
      const before = await effects();
      const res = await send(localBoard(), "post", `/api/approvals/${approvalId}/approve`, {});
      expect(res.status).toBe(409);
      expect(res.body.details?.code).toBe(STALE);
      await expectNoEffects(before);
      const after = (await loadAgent(agentId))!;
      expect(after.instructionBundleId).toBe(generation);
      expect((after.adapterConfig as Config).instructionsRootPath).toBe(versionRoot);
    });
  });

  describe("board amendment of a linked hire's instructions (explicit, attributable, bound to the exact payload)", () => {
    /** Pending managed hire, revision requested, then resubmitted through the route by `actor`. */
    async function amend(actor: Actor, change: (config: Config) => Config, body: Record<string, unknown> = { instructionAmendment: true }) {
      const hire = await managedPendingHire();
      await send(localBoard(), "post", `/api/approvals/${hire.approvalId}/request-revision`, {});
      const payload = { ...hire.payload, adapterConfig: change(hire.payload.adapterConfig as Config) };
      const res = await send(actor, "post", `/api/approvals/${hire.approvalId}/resubmit`, { payload, ...body });
      return { ...hire, payload, res };
    }
    const amendments = (approvalId: string) => db.select().from(activityLog)
      .where(and(eq(activityLog.entityId, approvalId), eq(activityLog.action, HIRE_INSTRUCTION_AMENDMENT_ACTION)));

    it("a non-admin board user with agents:create amends a managed entry file and self-approves; the amendment is attributed", async () => {
      await grant("user", userId);
      const { agentId, approvalId, res } = await amend(board(), (config) => ({ ...config, instructionsEntryFile: "MAIN.md" }));
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const records = await amendments(approvalId);
      expect(records).toHaveLength(1);
      expect(records[0]!.actorType).toBe("user");
      expect(records[0]!.actorId).toBe(userId);
      expect(records[0]!.details).toMatchObject({ agentId, fields: ["adapterConfig.instructionsEntryFile"] });
      const approved = await send(board(), "post", `/api/approvals/${approvalId}/approve`, {});
      expect(approved.status, JSON.stringify(approved.body)).toBe(200);
      const agent = (await loadAgent(agentId))!;
      expect(agent.status).toBe("idle");
      expect((agent.adapterConfig as Config).instructionsEntryFile).toBe("MAIN.md");
      expect(hireHook.notifyHireApproved).toHaveBeenCalledTimes(1);
    });

    it("without the explicit flag, the same change is refused as stale and nothing is recorded", async () => {
      await grant("user", userId);
      const before = await effects();
      const { approvalId, res } = await amend(board(), (config) => ({ ...config, instructionsEntryFile: "MAIN.md" }), {});
      expect(res.status).toBe(409);
      expect(res.body.details?.code).toBe(STALE);
      expect(await amendments(approvalId)).toHaveLength(0);
      expect((await loadApproval(approvalId)).status).toBe("revision_requested");
      expect(before.secrets).toBe((await effects()).secrets);
    });

    it("an external root needs instance admin to amend, and again to decide", async () => {
      await grant("user", userId);
      const nonAdmin = await amend(board(), (config) => ({ ...config, ...ext("amend-nonadmin") }));
      expect(nonAdmin.res.status).toBe(403);
      expect(await amendments(nonAdmin.approvalId)).toHaveLength(0);

      const root = ext("amend-admin");
      const admin = await amend(localBoard(), (config) => ({ ...config, ...root }));
      expect(admin.res.status, JSON.stringify(admin.res.body)).toBe(200);
      const before = await effects();
      const refused = await send(board(), "post", `/api/approvals/${admin.approvalId}/approve`, {});
      expect(refused.status).toBe(403);
      await expectNoEffects(before);
      const approved = await send(localBoard(), "post", `/api/approvals/${admin.approvalId}/approve`, {});
      expect(approved.status, JSON.stringify(approved.body)).toBe(200);
      expect((await loadAgent(admin.agentId))!.adapterConfig).toMatchObject({ instructionsRootPath: root.instructionsRootPath });
    });

    it("stale amendment: a root or generation change after the amendment refuses the decision; the current root is kept", async () => {
      const { agentId, approvalId, res } = await amend(localBoard(), (config) => ({ ...config, ...ext("amend-stale") }));
      expect(res.status).toBe(200);
      const agent = (await loadAgent(agentId))!;
      const generation = randomUUID();
      const versionRoot = resolveInstructionVersionRoot(agent, generation);
      await db.update(agents).set({ instructionBundleId: generation,
        adapterConfig: { ...(agent.adapterConfig as Config), instructionsRootPath: versionRoot, instructionsFilePath: path.join(versionRoot, "AGENTS.md") } })
        .where(eq(agents.id, agentId));
      const before = await effects();
      const approved = await send(localBoard(), "post", `/api/approvals/${approvalId}/approve`, {});
      expect(approved.status).toBe(409);
      expect(approved.body.details?.code).toBe(STALE);
      await expectNoEffects(before);
    });

    it("the amendment is bound to the exact payload: a payload changed afterwards is refused", async () => {
      const { approvalId, payload, res } = await amend(localBoard(), (config) => ({ ...config, instructionsEntryFile: "MAIN.md" }));
      expect(res.status).toBe(200);
      await db.update(approvals).set({ payload: { ...payload, adapterConfig: { ...(payload.adapterConfig as Config), instructionsEntryFile: "OTHER.md" } } })
        .where(eq(approvals.id, approvalId));
      const before = await effects();
      const approved = await send(localBoard(), "post", `/api/approvals/${approvalId}/approve`, {});
      expect(approved.status).toBe(409);
      await expectNoEffects(before);
    });

    it("only a server-written user record counts: a matching row attributed to a plugin is not an amendment", async () => {
      const { approvalId, res } = await amend(localBoard(), (config) => ({ ...config, instructionsEntryFile: "MAIN.md" }));
      expect(res.status).toBe(200);
      await db.update(activityLog).set({ actorType: "plugin" })
        .where(and(eq(activityLog.entityId, approvalId), eq(activityLog.action, HIRE_INSTRUCTION_AMENDMENT_ACTION)));
      const before = await effects();
      const approved = await send(localBoard(), "post", `/api/approvals/${approvalId}/approve`, {});
      expect(approved.status).toBe(409);
      await expectNoEffects(before);
    });

    it("a board amendment of an agent-requested hire is board-authored and can be approved", async () => {
      const hirer = await seedAgent({ permissions: { canCreateAgents: true } });
      await requireApproval();
      const pending = await send(agentActor(hirer), "post", `/api/companies/${companyId}/agent-hires`, { ...base(), adapterType: MANAGED_ADAPTER, adapterConfig: {} });
      expect(pending.status).toBe(201);
      const approvalId = pending.body.approval.id as string;
      const snapshot = (await loadApproval(approvalId)).payload as Config;
      await send(localBoard(), "post", `/api/approvals/${approvalId}/request-revision`, {});
      const res = await send(localBoard(), "post", `/api/approvals/${approvalId}/resubmit`,
        { payload: { ...snapshot, adapterConfig: { ...(snapshot.adapterConfig as Config), instructionsEntryFile: "MAIN.md" } }, instructionAmendment: true });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const approved = await send(localBoard(), "post", `/api/approvals/${approvalId}/approve`, {});
      expect(approved.status, JSON.stringify(approved.body)).toBe(200);
      expect(((await loadAgent(pending.body.agent.id))!.adapterConfig as Config).instructionsEntryFile).toBe("MAIN.md");
    });

    it("W1 still applies: an amended root that overlaps another agent's root is refused at approval and the decision rolls back", async () => {
      const owner = ext("owner");
      await seedAgent({ adapterConfig: { ...owner, model: "m0" } });
      const { agentId, approvalId, res } = await amend(localBoard(), (config) => ({ ...config, ...owner }));
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const before = await effects();
      const approved = await send(localBoard(), "post", `/api/approvals/${approvalId}/approve`, {});
      expect(approved.status).toBe(409);
      expect(approved.body.details?.code).toBe(INSTRUCTION_ROOT_IN_USE);
      await expectNoEffects(before);
      expect((await loadAgent(agentId))!.status).toBe("pending_approval");
    });

    it("reviewer version: a decision on an outdated version is refused; the current version approves", async () => {
      await grant("user", userId);
      const { approvalId } = await managedPendingHire(board());
      const reviewed = await loadApproval(approvalId);
      await send(board(), "post", `/api/approvals/${approvalId}/request-revision`, {});
      await send(board(), "post", `/api/approvals/${approvalId}/resubmit`, {});
      const before = await effects();
      const outdated = await send(board(), "post", `/api/approvals/${approvalId}/approve`, { expectedUpdatedAt: reviewed.updatedAt.toISOString() });
      expect(outdated.status).toBe(409);
      expect(outdated.body.details?.code).toBe("approval_changed_since_review");
      await expectNoEffects(before);
      const current = await loadApproval(approvalId);
      const ok = await send(board(), "post", `/api/approvals/${approvalId}/approve`, { expectedUpdatedAt: current.updatedAt.toISOString() });
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    });
  });

  describe("PostgreSQL races", () => {
    it("a resubmit that commits while a reviewed decision waits is not approved in its place", async () => {
      await grant("user", userId);
      const { agentId, approvalId, payload } = await managedPendingHire(board());
      await send(board(), "post", `/api/approvals/${approvalId}/request-revision`, {});
      const reviewed = await loadApproval(approvalId);
      const holder = await holdRow((tx) => tx.select().from(approvals).where(eq(approvals.id, approvalId)).for("update"));
      let approve: Promise<any> | null = null, resubmit: Promise<any> | null = null;
      try {
        resubmit = settle(approvalService(db as any).resubmit(approvalId, { ...payload, budgetMonthlyCents: 777 },
          { updatedAt: reviewed.updatedAt, payload: reviewed.payload as Config }));
        expect(await waitFor(async () => (await rowLockWaiters()) >= 1)).toBe(true);
        approve = send(board(), "post", `/api/approvals/${approvalId}/approve`, { expectedUpdatedAt: reviewed.updatedAt.toISOString() });
        expect(await waitFor(async () => (await rowLockWaiters()) >= 2)).toBe(true);
      } finally {
        holder.release();
        await holder.done;
      }
      expect(await resubmit!).toMatchObject({ ok: true });
      const approved = await approve!;
      expect(approved.status).toBe(409);
      expect(approved.body.details?.code).toBe("approval_changed_since_review");
      expect((await loadApproval(approvalId)).status).toBe("pending");
      expect((await loadAgent(agentId))!.status).toBe("pending_approval");
      expect(hireHook.notifyHireApproved).not.toHaveBeenCalled();
    });

    it("approve versus resubmit, approve first: the decision stands and the resubmit cannot replace the payload or reopen it", async () => {
      await grant("user", userId);
      const { agentId, approvalId, payload } = await managedPendingHire(board());
      await send(board(), "post", `/api/approvals/${approvalId}/request-revision`, {});
      const read = await loadApproval(approvalId);
      const holder = await holdRow((tx) => tx.select().from(approvals).where(eq(approvals.id, approvalId)).for("update"));
      let approve: Promise<any> | null = null, resubmit: Promise<any> | null = null;
      try {
        approve = send(board(), "post", `/api/approvals/${approvalId}/approve`, {});
        expect(await waitFor(async () => (await rowLockWaiters()) >= 1)).toBe(true);
        resubmit = settle(approvalService(db as any).resubmit(approvalId, { ...payload, budgetMonthlyCents: 999 },
          { updatedAt: read.updatedAt, payload: read.payload as Config }));
        expect(await waitFor(async () => (await rowLockWaiters()) >= 2)).toBe(true);
      } finally {
        holder.release();
        await holder.done;
      }
      expect((await approve!).status).toBe(200);
      expect(await resubmit!).toMatchObject({ ok: false, status: 409 });
      const after = await loadApproval(approvalId);
      expect(after.status).toBe("approved");
      expect(after.payload).toEqual(read.payload);
      expect((await loadAgent(agentId))!.status).toBe("idle");
      expect(hireHook.notifyHireApproved).toHaveBeenCalledTimes(1);
    });

    it("resubmit versus approve, resubmit first: the approval authorizes the resubmitted payload it reads, and refuses its root change", async () => {
      await grant("user", userId);
      await makeInstanceAdmin(userId);
      const { agentId, approvalId, payload } = await managedPendingHire(board());
      await send(board(), "post", `/api/approvals/${approvalId}/request-revision`, {});
      const read = await loadApproval(approvalId);
      const changed = { ...payload, adapterConfig: { ...(payload.adapterConfig as Config), ...ext("race") } };
      const agentBefore = (await loadAgent(agentId))!;
      const holder = await holdRow((tx) => tx.select().from(approvals).where(eq(approvals.id, approvalId)).for("update"));
      let approve: Promise<any> | null = null, resubmit: Promise<any> | null = null;
      try {
        resubmit = settle(approvalService(db as any).resubmit(approvalId, changed, { updatedAt: read.updatedAt, payload: read.payload as Config }));
        expect(await waitFor(async () => (await rowLockWaiters()) >= 1)).toBe(true);
        approve = send(board(), "post", `/api/approvals/${approvalId}/approve`, {});
        expect(await waitFor(async () => (await rowLockWaiters()) >= 2)).toBe(true);
      } finally {
        holder.release();
        await holder.done;
      }
      expect(await resubmit!).toMatchObject({ ok: true });
      const approved = await approve!;
      expect(approved.status).toBe(409);
      expect(approved.body.details?.code).toBe(STALE);
      const after = await loadApproval(approvalId);
      expect(after.status).toBe("pending");
      expect(after.payload).toEqual(changed);
      expect((await loadAgent(agentId))!.adapterConfig).toEqual(agentBefore.adapterConfig);
      expect((await loadAgent(agentId))!.status).toBe("pending_approval");
      expect(hireHook.notifyHireApproved).not.toHaveBeenCalled();
    });

    it("duplicate approval: two concurrent decisions, exactly one applies, one activation, one hook", async () => {
      await grant("user", userId);
      const { agentId, approvalId } = await managedPendingHire(board());
      const holder = await holdRow((tx) => tx.select().from(approvals).where(eq(approvals.id, approvalId)).for("update"));
      let both: Promise<any[]> | null = null;
      try {
        both = Promise.all([
          send(board(), "post", `/api/approvals/${approvalId}/approve`, {}),
          send(board(), "post", `/api/agents/${agentId}/approve`, {}),
        ]);
        expect(await waitFor(async () => (await rowLockWaiters()) >= 2)).toBe(true);
      } finally {
        holder.release();
        await holder.done;
      }
      const statuses = (await both!).map((res) => res.status);
      expect(statuses.filter((status) => status === 200).length).toBeGreaterThanOrEqual(1);
      expect((await loadAgent(agentId))!.status).toBe("idle");
      expect((await loadApproval(approvalId)).status).toBe("approved");
      expect(hireHook.notifyHireApproved).toHaveBeenCalledTimes(1);
    });

    it("root change versus activation: a root committed while the approval waits on the agent row makes the payload stale (409, nothing changed)", async () => {
      await grant("user", userId);
      const { agentId, approvalId } = await managedPendingHire(board());
      const moved = { ...((await loadAgent(agentId))!.adapterConfig as Config), ...ext("moved") };
      const holder = await holdRow(async (tx) => {
        await tx.select({ id: agents.id }).from(agents).where(eq(agents.id, agentId)).for("no key update");
        await tx.update(agents).set({ adapterConfig: moved }).where(eq(agents.id, agentId));
      });
      let approve: Promise<any> | null = null;
      try {
        approve = send(localBoard(), "post", `/api/approvals/${approvalId}/approve`, {});
        expect(await waitFor(async () => (await rowLockWaiters()) >= 1)).toBe(true);
      } finally {
        holder.release();
        await holder.done;
      }
      const res = await approve!;
      expect(res.status).toBe(409);
      expect(res.body.details?.code).toBe(STALE);
      expect((await loadApproval(approvalId)).status).toBe("pending");
      expect((await loadAgent(agentId))!.status).toBe("pending_approval");
      expect((await loadAgent(agentId))!.adapterConfig).toEqual(moved);
      expect(hireHook.notifyHireApproved).not.toHaveBeenCalled();
    });

    it("revocation committed before the in-transaction check is honored: agents:create revoked while the decision waits", async () => {
      await grant("user", userId);
      const { agentId, approvalId } = await managedPendingHire(board());
      const holder = await holdRow((tx) => tx.select().from(approvals).where(eq(approvals.id, approvalId)).for("update"));
      let approve: Promise<any> | null = null;
      try {
        approve = send(board(), "post", `/api/approvals/${approvalId}/approve`, {});
        expect(await waitFor(async () => (await rowLockWaiters()) >= 1)).toBe(true);
        await revoke(userId);
      } finally {
        holder.release();
        await holder.done;
      }
      expect((await approve!).status).toBe(403);
      expect((await loadApproval(approvalId)).status).toBe("pending");
      expect((await loadAgent(agentId))!.status).toBe("pending_approval");
      expect(hireHook.notifyHireApproved).not.toHaveBeenCalled();
    });

    it("instance-admin revocation committed before the in-transaction check is honored for an external root", async () => {
      await grant("user", userId);
      await makeInstanceAdmin(userId);
      const created = await send(board(), "post", `/api/companies/${companyId}/approvals`,
        { type: "hire_agent", payload: { ...base("RevokedAdmin"), adapterConfig: ext("revoked-admin") } });
      expect(created.status).toBe(201);
      const before = await effects();
      const holder = await holdRow((tx) => tx.select().from(approvals).where(eq(approvals.id, created.body.id)).for("update"));
      let approve: Promise<any> | null = null;
      try {
        approve = send(board({ isInstanceAdmin: true }), "post", `/api/approvals/${created.body.id}/approve`, {});
        expect(await waitFor(async () => (await rowLockWaiters()) >= 1)).toBe(true);
        await db.delete(instanceUserRoles).where(eq(instanceUserRoles.userId, userId));
      } finally {
        holder.release();
        await holder.done;
      }
      expect((await approve!).status).toBe(403);
      await expectNoEffects(before);
    });
  });
});
