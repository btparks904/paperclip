// WS-2 PR-W1: exclusive instruction roots. Real services on embedded
// PostgreSQL, mkdtemp roots and synthetic sentinel content only.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import {
  activityLog, agentConfigRevisions, agentInstructionHeads, agentInstructionRevisions, agents, approvals, authUsers, budgetPolicies, companies, companyMemberships, companySecrets, createDb, principalPermissionGrants, type Db,
} from "@paperclipai/db";
import {
  agentInstructionsBundleMode, agentInstructionsService, instructionCopyIntentsDirectory, resolveInstructionWriteTarget, resolveManagedInstructionsRoot,
  type InstructionConfigPersist, type UpdateBundleOptions,
} from "../services/agent-instructions.js";
import {
  INSTRUCTION_ROOT_ASSIGNMENT_LOCK, INSTRUCTION_ROOT_IN_USE, INSTRUCTION_ROOT_UNVERIFIABLE,
  compareInstructionRootKeys, foldInstructionRootPath, instructionRootComparisonKey, resolveManagedAgentArea,
} from "../services/instruction-root-exclusivity.js";
import { agentService } from "../services/agents.js";
import { AGENT_FILES_CONTRACT, agentFileStore, type AgentFileConfigRepair } from "../services/agent-file-store.js";
import { agentInstructionRevisionService } from "../services/agent-instruction-revisions.js";
import { approvalService } from "../services/approvals.js";
import { secretService } from "../services/secrets.js";
import { agentRoutes } from "../routes/agents.js";
import { errorHandler } from "../middleware/index.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

// PG-4: hire approvals are decided by an authorized board actor.
const PG4_LOCAL_BOARD = { type: "board" as const, source: "local_implicit" as const };
/** PG-4: the approval version the reviewer saw (its current `updatedAt`); an open hire is approved with it. */
const reviewedVersion = async (conn: any, approvalId: string): Promise<Date> =>
  (await conn.select({ updatedAt: approvals.updatedAt }).from(approvals).where(eq(approvals.id, approvalId)))[0].updatedAt;

// The hire-approved hook is an outward effect: it must fire only for a committed decision.
const hireHook = vi.hoisted(() => ({ notifyHireApproved: vi.fn() }));
vi.mock("../services/hire-hook.js", () => hireHook);

const ENTRY = "SENTINEL-WS2-W1-ENTRY\n";
const RAW_API_KEY = "SENTINEL-SYNTHETIC-RAW-API-KEY-W1";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
type Config = Record<string, unknown>;
type Outcome = { ok: true; value: unknown } | { ok: false; status?: number; code?: string; message: string; details: Record<string, unknown> };
const settle = (promise: Promise<unknown>): Promise<Outcome> => promise.then(
  (value) => ({ ok: true as const, value }),
  (error: any) => ({ ok: false as const, status: error?.status, code: error?.details?.code ?? error?.code, message: String(error?.message), details: error?.details ?? {} }));

// Optional: a case-insensitive volume (for example `ciopfs -o use_ino,allow_other`). Unset on Linux CI.
const caseInsensitiveDir = process.env.PAPERCLIP_TEST_CASE_INSENSITIVE_DIR;

describe("WS-2 PR-W1: comparison key (pure)", () => {
  it("strips the macOS data-volume firmlink, so both spellings of one folder compare equal", () => {
    const viaFirmlink = foldInstructionRootPath("/System/Volumes/Data/Users/x/.paperclip/instances/default/companies/c/agents/a/instructions");
    const direct = foldInstructionRootPath("/Users/x/.paperclip/instances/default/companies/c/agents/a/instructions");
    expect(viaFirmlink).toEqual(direct);
    expect(foldInstructionRootPath("/System/Volumes/Data")).toEqual([]);
    expect(foldInstructionRootPath("/system/volumes/data/Users/x")).toEqual(foldInstructionRootPath("/Users/x"));
    // Only a whole leading segment run is stripped.
    expect(foldInstructionRootPath("/System/Volumes/DataX/Users/x")).toEqual(["system", "volumes", "datax", "users", "x"]);
  });

  it("folds the probe's case variants (.PAPERCLIP, AGENTS, INSTRUCTIONS) to one key", () => {
    const canonical = foldInstructionRootPath("/Users/x/.paperclip/instances/default/companies/c/agents/a/instructions");
    for (const variant of [
      "/Users/x/.PAPERCLIP/instances/default/companies/c/agents/a/instructions",
      "/Users/x/.paperclip/instances/default/companies/c/AGENTS/a/instructions",
      "/Users/x/.paperclip/instances/default/companies/c/agents/a/INSTRUCTIONS",
    ]) expect(foldInstructionRootPath(variant)).toEqual(canonical);
  });

  it("folds NFC and NFD spellings to one key", () => {
    expect(foldInstructionRootPath("/r/café/agent")).toEqual(foldInstructionRootPath("/r/café/agent"));
    expect(foldInstructionRootPath("/r/CAFÉ")).toEqual(foldInstructionRootPath("/r/café"));
  });

  it("compares whole segments, never raw string prefixes", () => {
    const key = (value: string) => foldInstructionRootPath(value);
    expect(compareInstructionRootKeys(key("/a/b"), key("/a/b"))).toBe("equal");
    expect(compareInstructionRootKeys(key("/a/b/c"), key("/a/b"))).toBe("inside");
    expect(compareInstructionRootKeys(key("/a"), key("/a/b"))).toBe("contains");
    expect(compareInstructionRootKeys(key("/a/bc"), key("/a/b"))).toBeNull();
    expect(compareInstructionRootKeys(key("/a/b"), key("/a/bc"))).toBeNull();
    expect(compareInstructionRootKeys(key("/a/b-2"), key("/a/b"))).toBeNull();
    expect(compareInstructionRootKeys(key("/"), key("/a"))).toBe("contains");
  });
});

describe("WS-2 PR-W1: exclusive instruction roots", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let granted: string[] = [];
  let home: string, companyId: string, otherCompanyId: string, agentId: string, ownerId: string, userId: string;
  let managedRoot: string, ownerRoot: string;
  const cfg = (mode: "managed" | "external", root: string, entry = "AGENTS.md") => ({
    instructionsBundleMode: mode, instructionsRootPath: root, instructionsEntryFile: entry, instructionsFilePath: path.join(root, entry) });
  const fresh = (label: string) => path.join(home, "roots", `${label}-${randomUUID()}`);
  const loadAgent = async (id = agentId) => (await db.select().from(agents).where(eq(agents.id, id)))[0];
  const configOf = async (id = agentId) => (await loadAgent(id))!.adapterConfig as Config;
  const secretCount = async () => (await db.select({ id: companySecrets.id }).from(companySecrets)
    .where(eq(companySecrets.companyId, companyId))).length;
  /** PG-3: a schema-secret field takes only an existing same-company secret reference. */
  const storedApiKeyRef = async () => {
    const stored = await secretService(db).create(companyId, {
      name: `w1-api-key-${randomUUID()}`, provider: "local_encrypted", value: RAW_API_KEY,
    });
    return { type: "secret_ref", secretId: stored.id, version: "latest" };
  };
  const agentCount = async () => (await db.select({ id: agents.id }).from(agents).where(eq(agents.companyId, companyId))).length;
  const exists = (target: string) => fs.lstat(target).then(() => true, () => false);
  const persistOn = (): InstructionConfigPersist => async (tx, current, adapterConfig) => {
    const txDb = tx as unknown as Db;
    const normalized = await secretService(txDb).normalizeAdapterConfigForPersistence(current.companyId, adapterConfig,
      { strictMode: false, adapterType: current.adapterType ?? "process" });
    await agentService(txDb).update(current.id, { adapterConfig: normalized },
      { recordRevision: { createdByAgentId: null, createdByUserId: userId, source: "instructions_bundle_patch" }, instructionConfigWrite: { keys: "all" } });
  };
  async function optionsFor(stale: NonNullable<Awaited<ReturnType<typeof loadAgent>>>, overrides: Partial<UpdateBundleOptions> = {}): Promise<UpdateBundleOptions> {
    return { expectedTarget: await resolveInstructionWriteTarget(stale), expectedConfigMode: agentInstructionsBundleMode(stale),
      persist: persistOn(), isInstanceAdmin: true, actor: { actorType: "user", actorId: userId, runId: null }, ...overrides };
  }
  async function seedAgent(id: string, adapterConfig: Config, values: Partial<typeof agents.$inferInsert> = {}) {
    await db.insert(agents).values({ id, companyId, name: `T-${id.slice(0, 4)}`, adapterConfig, ...values });
    if ((values.companyId ?? companyId) !== companyId) return;
    granted.push(id);
    await db.delete(principalPermissionGrants).where(eq(principalPermissionGrants.principalId, userId));
    await db.insert(principalPermissionGrants).values({ companyId, principalType: "user", principalId: userId, permissionKey: "agents:configure", scope: { agentIds: [...granted] } });
  }
  async function seed(root: string, files: Record<string, string>) {
    for (const [rel, content] of Object.entries(files)) {
      await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
      await fs.writeFile(path.join(root, rel), content);
    }
  }
  const actorAdmin = () => ({ type: "board", userId, companyIds: [companyId], source: "local_implicit", isInstanceAdmin: true });
  const actorOperator = () => ({ type: "board", userId, companyIds: [companyId], source: "session", isInstanceAdmin: false });
  const app = (actor: () => Record<string, unknown> = actorAdmin) => {
    const server = express();
    server.use(express.json());
    server.use((req, _res, next) => { (req as any).actor = actor(); next(); });
    server.use("/api", agentRoutes(db as any));
    server.use(errorHandler);
    return server;
  };
  /** The canonical entry commit route (PUT .../instructions-bundle/file on the entry). */
  const putEntry = (server: express.Express, id: string, body: Record<string, unknown>) =>
    request(server).put(`/api/agents/${id}/instructions-bundle/file`).send({ path: "AGENTS.md", ...body });
  const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
  const managedRootOf = (id: string) => resolveManagedInstructionsRoot({ id, companyId, name: "x", adapterConfig: {} });
  /** The adoption marker lives outside the agent files: <managed area>/file-sync/adopted.json. */
  const adoptionMarkerOf = (id: string) => path.join(resolveManagedAgentArea({ id, companyId }), "file-sync", "adopted.json");
  const filesUpdatedAudit = async (id: string) => db.select().from(activityLog)
    .where(and(eq(activityLog.entityId, id), eq(activityLog.action, "agent.files_updated")));
  /** Every entry under root, with the sha256 of each file: a byte-exact snapshot of a folder. */
  async function treeOf(root: string): Promise<Record<string, string>> {
    const result: Record<string, string> = {};
    async function walk(dir: string) {
      for (const item of await fs.readdir(path.join(root, dir), { withFileTypes: true })) {
        const rel = dir ? `${dir}/${item.name}` : item.name;
        if (item.isDirectory()) { result[rel] = "dir"; await walk(rel); }
        else result[rel] = createHash("sha256").update(await fs.readFile(path.join(root, rel))).digest("hex");
      }
    }
    await walk("");
    return result;
  }
  const advisoryWaiters = async () => {
    const rows = await db.execute(sql`select count(*)::int as n from pg_locks where locktype = 'advisory' and not granted`);
    return Number((rows as unknown as Array<{ n: number }>)[0]?.n ?? 0);
  };
  /** Sessions waiting on a row lock (tuple or transaction id), not on an advisory lock. */
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
  /** Holds the assignment lock in its own transaction (after optional work on it) until release(). */
  async function holdAssignmentLock(work?: (tx: Parameters<Parameters<Db["transaction"]>[0]>[0]) => Promise<void>) {
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    let held!: () => void;
    const isHeld = new Promise<void>((resolve) => { held = resolve; });
    const done = db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${INSTRUCTION_ROOT_ASSIGNMENT_LOCK}, 0))`);
      await work?.(tx);
      held();
      await released;
    });
    await isHeld;
    return { release, done };
  }
  const assignmentLockIsFree = () => db.transaction(async (tx) => {
    const rows = await tx.execute(sql`select pg_try_advisory_xact_lock(hashtextextended(${INSTRUCTION_ROOT_ASSIGNMENT_LOCK}, 0)) as ok`);
    return Boolean((rows as unknown as Array<{ ok: boolean }>)[0]?.ok);
  });
  /** The owner agent's root plus the ways another agent could name it or overlap it. */
  const overlapping = () => ({
    equal: ownerRoot,
    inside: path.join(ownerRoot, "nested"),
    contains: path.dirname(ownerRoot),
  });

  beforeAll(async () => {
    home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "ws2-w1-")));
    process.env.PAPERCLIP_HOME = home;
    database = await startEmbeddedPostgresTestDatabase("ws2-w1-db-");
    db = createDb(database.connectionString);
  }, 90_000);
  afterAll(async () => { await database?.cleanup(); await fs.rm(home, { recursive: true, force: true }); });
  afterEach(() => { vi.restoreAllMocks(); });
  beforeEach(async () => {
    hireHook.notifyHireApproved.mockReset();
    hireHook.notifyHireApproved.mockResolvedValue(undefined);
    granted = []; companyId = randomUUID(); otherCompanyId = randomUUID(); agentId = randomUUID(); ownerId = randomUUID(); userId = randomUUID();
    await db.insert(companies).values([
      { id: companyId, name: "W1", issuePrefix: randomUUID().slice(0, 8) },
      { id: otherCompanyId, name: "W1-other", issuePrefix: randomUUID().slice(0, 8) },
    ]);
    await db.insert(authUsers).values({ id: userId, name: "Editor", email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companyMemberships).values([{ companyId, principalType: "user", principalId: userId, membershipRole: "operator" }]);
    managedRoot = resolveManagedInstructionsRoot({ companyId, id: agentId, name: "T", adapterConfig: {} });
    await seedAgent(agentId, { ...cfg("managed", managedRoot), model: "m0" }, { adapterType: "hermes_gateway" });
    await seed(managedRoot, { "AGENTS.md": ENTRY });
    // The owner: another agent with an external root.
    ownerRoot = fresh("owner");
    await seed(ownerRoot, { "AGENTS.md": ENTRY });
    await seedAgent(ownerId, { ...cfg("external", ownerRoot), model: "m0" }, { adapterType: "hermes_gateway" });
  });

  describe("refusals: every relation, against roots and managed areas, across companies", () => {
    for (const relation of ["equal", "inside", "contains"] as const) {
      it(`updateAgent: a root ${relation} another agent's root is refused; nothing changes, no secret`, async () => {
        const before = await configOf();
        const outcome = await settle(agentService(db).update(agentId, { adapterConfig: { ...before, ...cfg("external", overlapping()[relation]), apiKey: RAW_API_KEY } },
          { instructionConfigWrite: { keys: "all" } }));
        expect(outcome).toMatchObject({ ok: false, status: 409, code: INSTRUCTION_ROOT_IN_USE });
        expect(await configOf()).toEqual(before);
        expect(await secretCount()).toBe(0);
      });
    }

    it("an external root equal to another agent's managed root is refused", async () => {
      const outcome = await settle(agentService(db).update(ownerId, { adapterConfig: cfg("external", managedRoot) }, { instructionConfigWrite: { keys: "all" } }));
      expect(outcome).toMatchObject({ ok: false, status: 409, code: INSTRUCTION_ROOT_IN_USE });
      expect((await configOf(ownerId)).instructionsRootPath).toBe(ownerRoot);
    });

    it("managed-area protection: a root inside another agent's managed area (no instructions, folder missing) is refused", async () => {
      const bare = randomUUID();
      await seedAgent(bare, { model: "m0" });
      const area = resolveManagedAgentArea({ id: bare, companyId });
      expect(await exists(area)).toBe(false);
      for (const target of [area, path.join(area, "file-sync", "runs"), path.join(area, "instruction-versions", "v1"), path.dirname(area)]) {
        const outcome = await settle(agentService(db).update(ownerId, { adapterConfig: cfg("external", target) }, { instructionConfigWrite: { keys: "all" } }));
        expect(outcome, target).toMatchObject({ ok: false, status: 409, code: INSTRUCTION_ROOT_IN_USE });
      }
      expect(await exists(area)).toBe(false);
    });

    it("cross-company: an agent in another company cannot claim a root in use", async () => {
      const foreign = randomUUID();
      const foreignRoot = fresh("foreign");
      await seed(foreignRoot, { "AGENTS.md": ENTRY });
      await seedAgent(foreign, cfg("external", foreignRoot), { companyId: otherCompanyId });
      const outcome = await settle(agentService(db).update(foreign, { adapterConfig: cfg("external", ownerRoot) }, { instructionConfigWrite: { keys: "all" } }));
      expect(outcome).toMatchObject({ ok: false, status: 409, code: INSTRUCTION_ROOT_IN_USE });
      // And the reverse: this company's agent cannot claim the foreign agent's managed area.
      const reverse = await settle(agentService(db).update(ownerId, {
        adapterConfig: cfg("external", resolveManagedAgentArea({ id: foreign, companyId: otherCompanyId })) }, { instructionConfigWrite: { keys: "all" } }));
      expect(reverse).toMatchObject({ ok: false, status: 409, code: INSTRUCTION_ROOT_IN_USE });
    });

    it("symbolic-link equivalents: a link to the root, a link to its parent, and a dangling link to a managed area are refused", async () => {
      const links = fresh("links");
      await fs.mkdir(links, { recursive: true });
      await fs.symlink(ownerRoot, path.join(links, "to-root"));
      await fs.symlink(path.dirname(ownerRoot), path.join(links, "to-parent"));
      const bare = randomUUID();
      await seedAgent(bare, { model: "m0" });
      await fs.symlink(resolveManagedAgentArea({ id: bare, companyId }), path.join(links, "dangling"));
      for (const target of [
        path.join(links, "to-root"),
        path.join(links, "to-parent", path.basename(ownerRoot)),
        path.join(links, "dangling", "instructions"),
      ]) {
        const outcome = await settle(agentService(db).update(agentId, { adapterConfig: cfg("external", target) }, { instructionConfigWrite: { keys: "all" } }));
        expect(outcome, target).toMatchObject({ ok: false, status: 409, code: INSTRUCTION_ROOT_IN_USE });
      }
    });

    it("case and Unicode variants are refused on every host (folding is unconditional)", async () => {
      const unicodeRoot = path.join(fresh("u"), "café");
      const unicodeOwner = randomUUID();
      await seedAgent(unicodeOwner, cfg("external", unicodeRoot));
      for (const target of [
        ownerRoot.toUpperCase(),
        path.join(path.dirname(ownerRoot), path.basename(ownerRoot).toUpperCase()),
        path.join(path.dirname(unicodeRoot), "café"),
        path.join(path.dirname(unicodeRoot), "CAFÉ", "x"),
      ]) {
        const outcome = await settle(agentService(db).update(agentId, { adapterConfig: cfg("external", target) }, { instructionConfigWrite: { keys: "all" } }));
        expect(outcome, target).toMatchObject({ ok: false, status: 409, code: INSTRUCTION_ROOT_IN_USE });
      }
    });

    it("missing path components: a missing root under another agent's missing root is refused", async () => {
      const missingOwnerRoot = path.join(fresh("missing"), "a", "b");
      const missingOwner = randomUUID();
      await seedAgent(missingOwner, cfg("external", missingOwnerRoot));
      expect(await exists(missingOwnerRoot)).toBe(false);
      const outcome = await settle(agentService(db).update(agentId, { adapterConfig: cfg("external", path.join(missingOwnerRoot, "c", "d")) },
        { instructionConfigWrite: { keys: "all" } }));
      expect(outcome).toMatchObject({ ok: false, status: 409, code: INSTRUCTION_ROOT_IN_USE });
    });

    it.skipIf(!caseInsensitiveDir)("case-insensitive volume: an existing folder named in another case is refused", async () => {
      const base = path.join(caseInsensitiveDir!, `w1-${randomUUID()}`);
      const ciRoot = path.join(base, "Owner-Root");
      await seed(ciRoot, { "AGENTS.md": ENTRY });
      const ciOwner = randomUUID();
      await seedAgent(ciOwner, cfg("external", ciRoot));
      const variant = path.join(base, "owner-ROOT");
      expect(await exists(variant)).toBe(true);
      const outcome = await settle(agentService(db).update(agentId, { adapterConfig: cfg("external", variant) }, { instructionConfigWrite: { keys: "all" } }));
      expect(outcome).toMatchObject({ ok: false, status: 409, code: INSTRUCTION_ROOT_IN_USE });
    });

    it("fails closed: a root whose path cannot be resolved (permission error, link loop) is refused", async () => {
      const locked = fresh("locked");
      await fs.mkdir(path.join(locked, "inner"), { recursive: true });
      await fs.chmod(locked, 0o000);
      const loop = fresh("loop");
      await fs.mkdir(loop, { recursive: true });
      await fs.symlink(path.join(loop, "b"), path.join(loop, "a"));
      await fs.symlink(path.join(loop, "a"), path.join(loop, "b"));
      try {
        const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
        const targets = [path.join(loop, "a", "x"), ...(isRoot ? [] : [path.join(locked, "inner", "x")])];
        for (const target of targets) {
          const outcome = await settle(agentService(db).update(agentId, { adapterConfig: cfg("external", target) }, { instructionConfigWrite: { keys: "all" } }));
          expect(outcome, target).toMatchObject({ ok: false, status: 409, code: INSTRUCTION_ROOT_UNVERIFIABLE });
        }
      } finally {
        await fs.chmod(locked, 0o755);
      }
    });
  });

  describe("every writer refuses an overlapping root and changes nothing", () => {
    it("generic PATCH route: 409 before secret normalization; config unchanged, no secret", async () => {
      const before = await configOf();
      const res = await request(app()).patch(`/api/agents/${agentId}`).send({ adapterConfig: { ...cfg("external", ownerRoot), apiKey: RAW_API_KEY } });
      expect(res.status, JSON.stringify(res.body)).toBe(409);
      expect(JSON.stringify(res.body)).toContain(INSTRUCTION_ROOT_IN_USE);
      expect(await configOf()).toEqual(before);
      expect(await secretCount()).toBe(0);
    });

    it("instructions-path PATCH route: 409 and nothing changes", async () => {
      const before = await configOf();
      const res = await request(app()).patch(`/api/agents/${agentId}/instructions-path`)
        .send({ path: path.join(ownerRoot, "AGENTS.md"), adapterConfigKey: "instructionsFilePath" });
      expect(res.status, JSON.stringify(res.body)).toBe(409);
      expect(JSON.stringify(res.body)).toContain(INSTRUCTION_ROOT_IN_USE);
      expect(await configOf()).toEqual(before);
    });

    it("bundle PATCH (updateBundle): 409 before any folder is created", async () => {
      const target = path.join(ownerRoot, "nested-new");
      const agent = (await loadAgent())!;
      const outcome = await settle(agentInstructionsService(db).updateBundle(agent, { mode: "external", rootPath: target }, await optionsFor(agent)));
      expect(outcome).toMatchObject({ ok: false, status: 409, code: INSTRUCTION_ROOT_IN_USE });
      expect(await exists(target)).toBe(false);
      expect(await configOf()).toMatchObject(cfg("managed", managedRoot));
      const res = await request(app()).patch(`/api/agents/${agentId}/instructions-bundle`).send({ mode: "external", rootPath: target });
      expect(res.status, JSON.stringify(res.body)).toBe(409);
      expect(await exists(target)).toBe(false);
    });

    it("service create: refused by the pre-check before normalization; no agent, no secret", async () => {
      const id = randomUUID();
      const outcome = await settle(agentService(db).create(companyId, { id, name: "Created", adapterType: "hermes_gateway",
        adapterConfig: { ...cfg("external", ownerRoot), apiKey: RAW_API_KEY } }));
      expect(outcome).toMatchObject({ ok: false, status: 409, code: INSTRUCTION_ROOT_IN_USE });
      expect(await loadAgent(id)).toBeUndefined();
      expect(await secretCount()).toBe(0);
    });

    for (const [label, url] of [["create", "agents"], ["hire", "agent-hires"]] as const) {
      it(`${label} route: the pre-check refuses with 409 before any secret row or agent exists`, async () => {
        const agentsBefore = await agentCount();
        const res = await request(app()).post(`/api/companies/${companyId}/${url}`).send({
          name: "Routed", role: "general", adapterType: "hermes_gateway", adapterConfig: { ...cfg("external", ownerRoot), apiKey: RAW_API_KEY } });
        expect(res.status, JSON.stringify(res.body)).toBe(409);
        expect(JSON.stringify(res.body)).toContain(INSTRUCTION_ROOT_IN_USE);
        expect(await secretCount()).toBe(0);
        expect(await agentCount()).toBe(agentsBefore);
      });
    }

    it("hire approval activation: an approved overlapping root refuses; still pending, no secret", async () => {
      const pending = randomUUID();
      await seedAgent(pending, { model: "m0" }, { status: "pending_approval", adapterType: "hermes_gateway" });
      const outcome = await settle(agentService(db).activatePendingApproval(pending, {
        name: "Approved", adapterType: "hermes_gateway", adapterConfig: { ...cfg("external", path.join(ownerRoot, "sub")), apiKey: RAW_API_KEY } }));
      expect(outcome).toMatchObject({ ok: false, status: 409, code: INSTRUCTION_ROOT_IN_USE });
      expect((await loadAgent(pending))!.status).toBe("pending_approval");
      expect(await configOf(pending)).toEqual({ model: "m0" });
      expect(await secretCount()).toBe(0);
    });

    it("first managed-root bind (materializeManagedBundle): a legacy overlap refuses before the folder is written", async () => {
      // A legacy state that the rule now prevents: another agent's external
      // root inside this agent's managed root, assigned before the rule.
      const fresh1 = randomUUID();
      await seedAgent(fresh1, { model: "m0" });
      const target = resolveManagedInstructionsRoot({ id: fresh1, companyId, name: "x", adapterConfig: {} });
      await seedAgent(randomUUID(), cfg("external", path.join(target, "legacy")));
      const agent = (await loadAgent(fresh1))!;
      const outcome = await settle(agentInstructionsService(db).materializeManagedBundle(agent, { "AGENTS.md": ENTRY }, { entryFile: "AGENTS.md" }));
      expect(outcome).toMatchObject({ ok: false, status: 409, code: INSTRUCTION_ROOT_IN_USE });
      expect(await exists(target)).toBe(false);
    });

    it("first managed-root bind (unversioned save without a root): a legacy overlap refuses before the root is bound", async () => {
      const fresh2 = randomUUID();
      await seedAgent(fresh2, { model: "m0" });
      const target = resolveManagedInstructionsRoot({ id: fresh2, companyId, name: "x", adapterConfig: {} });
      await seedAgent(randomUUID(), cfg("external", target));
      const agent = (await loadAgent(fresh2))!;
      const outcome = await settle(agentInstructionsService(db).writeFile(agent, "notes/a.md", "SENTINEL-NOTE\n"));
      expect(outcome).toMatchObject({ ok: false, status: 409, code: INSTRUCTION_ROOT_IN_USE });
      expect(await exists(path.join(target, "notes"))).toBe(false);
    });

    // Codex P2 on 3ac09f46. The canonical entry commit route first-binds the managed root in
    // agent-instruction-revisions.ts. A legacy overlap (another agent's root, stored before this
    // rule, equal to or containing this agent's managed root) must refuse before adoption, any
    // file write and the identical-content replay bind, and change nothing.
    const legacyOverlaps = [
      { relation: "equal to A's managed root", legacyRoot: (id: string) => managedRootOf(id), entry: "AGENTS.md" },
      { relation: "containing A's managed root (A's managed area)", legacyRoot: (id: string) => resolveManagedAgentArea({ id, companyId }), entry: "instructions/AGENTS.md" },
    ];
    it.each(legacyOverlaps.flatMap((overlap) => [
      { ...overlap, replay: false, kind: "new content" },
      { ...overlap, replay: true, kind: "identical-content replay" },
    ]))("canonical entry commit route (first bind): a legacy root $relation refuses a $kind with 409 and changes nothing", async ({ legacyRoot, entry, replay }) => {
      const a = randomUUID();
      await seedAgent(a, { model: "m0" });
      const bId = randomUUID();
      const bRoot = legacyRoot(a);
      await seedAgent(bId, cfg("external", bRoot));
      const bBytes = `SENTINEL-B-${bId.slice(0, 8)}\n`;
      await seed(bRoot, { [entry]: bBytes, "notes/b.md": "SENTINEL-B-NOTE\n" });
      const before = {
        tree: await treeOf(bRoot), a: await loadAgent(a), b: await loadAgent(bId), audit: await filesUpdatedAudit(a),
        revisions: await db.select().from(agentConfigRevisions).where(eq(agentConfigRevisions.agentId, a)),
      };
      expect(await exists(adoptionMarkerOf(a))).toBe(false);
      const res = await putEntry(app(), a, { content: replay ? bBytes : "SENTINEL-A-NEW\n", baseHash: sha256(bBytes) });
      expect(res.status, JSON.stringify(res.body)).toBe(409);
      expect(JSON.stringify(res.body)).toContain(INSTRUCTION_ROOT_IN_USE);
      expect(await fs.readFile(path.join(bRoot, entry), "utf8")).toBe(bBytes);
      expect(await treeOf(bRoot)).toEqual(before.tree);
      expect(await loadAgent(a)).toEqual(before.a);
      expect(await loadAgent(bId)).toEqual(before.b);
      expect(await exists(adoptionMarkerOf(a))).toBe(false);
      expect(await filesUpdatedAudit(a)).toEqual(before.audit);
      expect(before.audit).toEqual([]);
      expect(await db.select().from(agentConfigRevisions).where(eq(agentConfigRevisions.agentId, a))).toEqual(before.revisions);
    });
  });

  // IF-1 (WS-2 integration run 2): a read of an agent that was never adopted
  // runs first adoption, which creates the managed root and writes the legacy
  // heads and the marker. When another agent's root overlaps that managed root
  // or the marker folder (a legacy state that the W1 rule now prevents), the
  // read must refuse under the assignment lock and write nothing.
  describe("read-triggered first adoption (IF-1)", () => {
    const LEGACY = "SENTINEL-A-LEGACY-HEAD\n";
    async function seedLegacyHead(id: string, entryFile: string, content: string) {
      const revisionId = randomUUID();
      const bytes = Buffer.from(content);
      await db.insert(agentInstructionRevisions).values({ id: revisionId, companyId, agentId: id, entryFile,
        contentBase64: bytes.toString("base64"), contentHash: sha256(content), byteLength: bytes.length, source: "api" });
      await db.insert(agentInstructionHeads).values({ companyId, agentId: id, entryFile, revisionId });
    }
    const areaOf = (id: string) => resolveManagedAgentArea({ id, companyId });
    const target = (id: string) => ({ companyId, agentId: id });
    /** Every read path that runs first adoption, as the routes and the runtime call it. */
    const readers: Array<{ name: string; read: (id: string) => Promise<unknown> }> = [
      { name: "GET instructions-bundle route", read: async (id) => {
        const res = await request(app()).get(`/api/agents/${id}/instructions-bundle`);
        if (res.status !== 200) throw Object.assign(new Error(JSON.stringify(res.body)), { status: res.status, details: res.body?.details ?? res.body });
        return res.body;
      } },
      { name: "GET instructions-bundle/file route (entry)", read: async (id) => {
        const res = await request(app()).get(`/api/agents/${id}/instructions-bundle/file`).query({ path: "AGENTS.md" });
        if (res.status !== 200) throw Object.assign(new Error(JSON.stringify(res.body)), { status: res.status, details: res.body?.details ?? res.body });
        return res.body;
      } },
      { name: "runtime read (readCommittedForRuntime)", read: (id) => agentInstructionRevisionService(db).readCommittedForRuntime(target(id)) },
      { name: "materializeCurrent", read: (id) => agentInstructionRevisionService(db).materializeCurrent(target(id)) },
      { name: "agent file store read", read: (id) => agentFileStore(db).read(companyId, id, "notes/b.md", actorAdmin() as any) },
    ];
    const codeOf = (outcome: Outcome) => outcome.ok ? null : (outcome.code ?? (outcome.details as { code?: string }).code ?? null);
    /** The other agent's (B's) legacy root relative to A: it overlaps A's managed root or A's marker folder. */
    const overlaps = [
      { relation: "equal to A's managed root", bRoot: (a: string) => managedRootOf(a) },
      { relation: "containing A's managed root (A's managed area)", bRoot: (a: string) => areaOf(a) },
      { relation: "inside A's managed root", bRoot: (a: string) => path.join(managedRootOf(a), "legacy") },
      { relation: "equal to A's marker folder", bRoot: (a: string) => path.join(areaOf(a), "file-sync") },
    ];

    it.each(overlaps.flatMap((overlap) => readers.map((reader) => ({ ...overlap, reader }))))(
      "conflicting ownership: $reader.name on an unadopted agent whose root is $relation refuses with 409 and writes nothing",
      async ({ bRoot, reader }) => {
        const a = randomUUID();
        await seedAgent(a, { model: "m0" });
        await seedLegacyHead(a, "AGENTS.md", LEGACY);
        const bId = randomUUID();
        const root = bRoot(a);
        await seedAgent(bId, cfg("external", root));
        const bBytes = `SENTINEL-B-${bId.slice(0, 8)}\n`;
        await seed(root, { "AGENTS.md": bBytes, "notes/b.md": "SENTINEL-B-NOTE\n" });
        const before = { area: await treeOf(areaOf(a)), a: await loadAgent(a), b: await loadAgent(bId), audit: await filesUpdatedAudit(a) };
        expect(await exists(adoptionMarkerOf(a))).toBe(false);
        const outcome = await settle(reader.read(a));
        expect(outcome, JSON.stringify(outcome)).toMatchObject({ ok: false, status: 409 });
        expect(codeOf(outcome)).toBe(INSTRUCTION_ROOT_IN_USE);
        // Nothing was created or written in A's managed area or in B's root.
        expect(await exists(adoptionMarkerOf(a))).toBe(false);
        expect(await fs.readFile(path.join(root, "AGENTS.md"), "utf8")).toBe(bBytes);
        expect(await treeOf(areaOf(a))).toEqual(before.area);
        expect(await loadAgent(a)).toEqual(before.a);
        expect(await loadAgent(bId)).toEqual(before.b);
        expect(await filesUpdatedAudit(a)).toEqual(before.audit);
        expect(await assignmentLockIsFree()).toBe(true);
      },
    );

    it("conflicting ownership: the marker-folder overlap refuses before A's managed root folder is created", async () => {
      const a = randomUUID();
      await seedAgent(a, { model: "m0" });
      const bRoot = path.join(areaOf(a), "file-sync");
      await seedAgent(randomUUID(), cfg("external", bRoot));
      await seed(bRoot, { "AGENTS.md": "SENTINEL-B\n" });
      const outcome = await settle(agentInstructionRevisionService(db).readCommittedForRuntime(target(a)));
      expect(outcome).toMatchObject({ ok: false, status: 409, code: INSTRUCTION_ROOT_IN_USE });
      expect(await exists(managedRootOf(a))).toBe(false);
      expect(await fs.readdir(bRoot)).toEqual(["AGENTS.md"]);
    });

    it.each(readers)("legitimate adoption: $name adopts an unbound agent with a legacy head and no overlap", async ({ name, read }) => {
      const a = randomUUID();
      await seedAgent(a, { model: "m0" });
      await seedLegacyHead(a, "AGENTS.md", LEGACY);
      // An unrelated agent with its own separate root.
      await seedAgent(randomUUID(), cfg("external", fresh("unrelated")));
      const outcome = await settle(read(a));
      if (name === "agent file store read") expect(outcome).toMatchObject({ ok: true, value: null });
      else expect(outcome, JSON.stringify(outcome)).toMatchObject({ ok: true });
      if (name === "GET instructions-bundle/file route (entry)") expect((outcome as { value: { content: string } }).value.content).toBe(LEGACY);
      if (name === "runtime read (readCommittedForRuntime)") {
        expect((outcome as { value: { revision: { contentHash: string } } }).value.revision.contentHash).toBe(sha256(LEGACY));
      }
      expect(await fs.readFile(path.join(managedRootOf(a), "AGENTS.md"), "utf8")).toBe(LEGACY);
      expect(JSON.parse(await fs.readFile(adoptionMarkerOf(a), "utf8"))).toEqual({ schema: AGENT_FILES_CONTRACT });
      expect(await assignmentLockIsFree()).toBe(true);
    });

    it("legitimate adoption: an agent with no legacy head gets its root folder and marker on first read", async () => {
      const a = randomUUID();
      await seedAgent(a, { model: "m0" });
      expect(await settle(agentInstructionRevisionService(db).readCommittedForRuntime(target(a)))).toMatchObject({ ok: true, value: null });
      expect(await exists(managedRootOf(a))).toBe(true);
      expect(JSON.parse(await fs.readFile(adoptionMarkerOf(a), "utf8"))).toEqual({ schema: AGENT_FILES_CONTRACT });
    });

    it("valid marker: a read takes no assignment lock, returns the bytes and writes nothing", async () => {
      await seed(path.dirname(adoptionMarkerOf(agentId)), { "adopted.json": JSON.stringify({ schema: AGENT_FILES_CONTRACT }) });
      const before = { area: await treeOf(areaOf(agentId)), row: await loadAgent(agentId) };
      const holder = await holdAssignmentLock();
      let outcome: Outcome;
      let waiters = -1;
      try {
        outcome = await settle((async () => {
          const res = await request(app()).get(`/api/agents/${agentId}/instructions-bundle/file`).query({ path: "AGENTS.md" });
          if (res.status !== 200) throw Object.assign(new Error(JSON.stringify(res.body)), { status: res.status });
          return res.body;
        })());
        waiters = await advisoryWaiters();
      } finally {
        holder.release();
        await holder.done;
      }
      expect(outcome!, JSON.stringify(outcome!)).toMatchObject({ ok: true, value: { content: ENTRY } });
      expect(waiters).toBe(0);
      expect(await treeOf(areaOf(agentId))).toEqual(before.area);
      expect(await loadAgent(agentId)).toEqual(before.row);
    });

    it("valid marker: an already adopted agent stays readable when a legacy root overlaps it (no write, no new refusal)", async () => {
      await seed(path.dirname(adoptionMarkerOf(agentId)), { "adopted.json": JSON.stringify({ schema: AGENT_FILES_CONTRACT }) });
      await seedAgent(randomUUID(), cfg("external", path.join(managedRoot, "legacy")));
      const before = await treeOf(areaOf(agentId));
      const res = await request(app()).get(`/api/agents/${agentId}/instructions-bundle/file`).query({ path: "AGENTS.md" });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.content).toBe(ENTRY);
      expect(await treeOf(areaOf(agentId))).toEqual(before);
    });

    it("concurrency boundary: the ownership check runs after the assignment lock, so a root committed while the read waits is seen and refused", async () => {
      const a = randomUUID();
      await seedAgent(a, { model: "m0" });
      await seedLegacyHead(a, "AGENTS.md", LEGACY);
      const bRoot = managedRootOf(a);
      const bBytes = "SENTINEL-B-LATE\n";
      await seed(bRoot, { "AGENTS.md": bBytes });
      // A writer that never checks (a legacy or out-of-band writer) commits B's overlapping
      // root while holding the assignment lock; the read starts before that commit.
      const bId = randomUUID();
      const holder = await holdAssignmentLock(async (tx) => {
        await tx.insert(agents).values({ id: bId, companyId, name: `T-${bId.slice(0, 4)}`, adapterConfig: cfg("external", bRoot) });
      });
      let read: Promise<Outcome> | null = null;
      let queued = false;
      try {
        read = settle(agentInstructionRevisionService(db).readCommittedForRuntime(target(a)));
        queued = await waitFor(async () => (await advisoryWaiters()) === 1, 5_000);
      } finally {
        holder.release();
        await holder.done;
      }
      const outcome = await read!;
      expect(queued).toBe(true);
      expect(outcome, JSON.stringify(outcome)).toMatchObject({ ok: false, status: 409, code: INSTRUCTION_ROOT_IN_USE });
      expect(await fs.readFile(path.join(bRoot, "AGENTS.md"), "utf8")).toBe(bBytes);
      expect(await exists(adoptionMarkerOf(a))).toBe(false);
      expect(await assignmentLockIsFree()).toBe(true);
    });
  });

  describe("preserved success paths", () => {
    it("an unchanged root succeeds (an unrelated field changes, the root stays)", async () => {
      const before = await configOf(ownerId);
      const updated = await agentService(db).update(ownerId, { adapterConfig: { ...before, model: "m1" } }, { instructionConfigWrite: { keys: "all" } });
      expect(updated?.adapterConfig).toMatchObject({ ...cfg("external", ownerRoot), model: "m1" });
    });

    it("an unchanged root succeeds even when a legacy overlap already exists", async () => {
      await seedAgent(randomUUID(), cfg("external", path.join(ownerRoot, "legacy-inside")));
      const updated = await agentService(db).update(ownerId, { adapterConfig: { ...(await configOf(ownerId)), model: "m2" } }, { instructionConfigWrite: { keys: "all" } });
      expect(updated?.adapterConfig).toMatchObject({ instructionsRootPath: ownerRoot, model: "m2" });
    });

    it("generic PATCH activates an independent root and stores the secret reference", async () => {
      const ext = fresh("ok-patch");
      await seed(ext, { "AGENTS.md": ENTRY });
      const apiKey = await storedApiKeyRef();
      const res = await request(app()).patch(`/api/agents/${agentId}`).send({ adapterConfig: { ...cfg("external", ext), apiKey } });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(await configOf()).toMatchObject({ ...cfg("external", ext), apiKey: { type: "secret_ref", secretId: apiKey.secretId } });
      expect(await secretCount()).toBe(1);
    });

    it("a sibling whose name shares a prefix with another root succeeds", async () => {
      const sibling = `${ownerRoot}-2`;
      await seed(sibling, { "AGENTS.md": ENTRY });
      const updated = await agentService(db).update(agentId, { adapterConfig: cfg("external", sibling) }, { instructionConfigWrite: { keys: "all" } });
      expect(updated?.adapterConfig).toMatchObject(cfg("external", sibling));
    });

    it("create (service and routes) with independent roots succeeds", async () => {
      const ext = fresh("ok-create");
      const created = await agentService(db).create(companyId, { name: "Created", adapterType: "hermes_gateway", adapterConfig: cfg("external", ext) });
      expect(created.adapterConfig).toMatchObject(cfg("external", ext));
      const apiKey = await storedApiKeyRef();
      for (const url of ["agents", "agent-hires"]) {
        const res = await request(app()).post(`/api/companies/${companyId}/${url}`).send({
          name: `Routed-${url}`, role: "general", adapterType: "hermes_gateway", adapterConfig: { ...cfg("external", fresh(url)), apiKey } });
        expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
      }
      expect(await secretCount()).toBe(1);
    });

    it("hire approval activates as before, including its approved independent root", async () => {
      const pending = randomUUID();
      await seedAgent(pending, { model: "m0" }, { status: "pending_approval", adapterType: "hermes_gateway" });
      const ext = fresh("ok-approve");
      await seed(ext, { "AGENTS.md": ENTRY });
      const result = await agentService(db).activatePendingApproval(pending, { name: "Approved", adapterType: "hermes_gateway", adapterConfig: { ...cfg("external", ext), apiKey: await storedApiKeyRef() } });
      expect(result).toMatchObject({ activated: true });
      expect((await loadAgent(pending))!.status).toBe("idle");
      expect(await configOf(pending)).toMatchObject(cfg("external", ext));
    });

    it("bundle PATCH copies into an independent folder and back to managed", async () => {
      const ext = fresh("ok-bundle");
      let agent = (await loadAgent())!;
      await agentInstructionsService(db).updateBundle(agent, { mode: "external", rootPath: ext }, await optionsFor(agent));
      expect(await configOf()).toMatchObject(cfg("external", ext));
      agent = (await loadAgent())!;
      await agentInstructionsService(db).updateBundle(agent, { mode: "managed" }, await optionsFor(agent));
      expect(await configOf()).toMatchObject({ instructionsBundleMode: "managed", instructionsRootPath: managedRoot });
    });

    it("first managed-root binds succeed for agents without a root", async () => {
      const a = randomUUID();
      await seedAgent(a, { model: "m0" });
      const materialized = await agentInstructionsService(db).materializeManagedBundle((await loadAgent(a))!, { "AGENTS.md": ENTRY }, { entryFile: "AGENTS.md" });
      expect(materialized.adapterConfig).toMatchObject({ instructionsBundleMode: "managed" });
      const b = randomUUID();
      await seedAgent(b, { model: "m0" });
      const saved = await agentInstructionsService(db).writeFile((await loadAgent(b))!, "notes/a.md", "SENTINEL-NOTE\n");
      expect(saved.adapterConfig).toMatchObject({ instructionsBundleMode: "managed" });
    });

    it("canonical entry commit route: a first bind of an independent managed root succeeds and is audited", async () => {
      const a = randomUUID();
      await seedAgent(a, { model: "m0" });
      const root = managedRootOf(a);
      expect(await exists(root)).toBe(false);
      const res = await putEntry(app(), a, { content: "SENTINEL-A-FIRST\n", baseRevisionId: null });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(await configOf(a)).toMatchObject({ model: "m0", instructionsBundleMode: "managed", instructionsRootPath: root,
        instructionsEntryFile: "AGENTS.md", instructionsFilePath: `${root}/AGENTS.md` });
      expect(await fs.readFile(path.join(root, "AGENTS.md"), "utf8")).toBe("SENTINEL-A-FIRST\n");
      expect(await exists(adoptionMarkerOf(a))).toBe(true);
      const audit = await filesUpdatedAudit(a);
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ actorType: "user", actorId: userId, agentId: null, details: { path: "AGENTS.md", contentHash: sha256("SENTINEL-A-FIRST\n") } });
      // An identical replay of the bound root is still a no-op success.
      const replay = await putEntry(app(), a, { content: "SENTINEL-A-FIRST\n", baseHash: sha256("SENTINEL-A-FIRST\n") });
      expect(replay.status, JSON.stringify(replay.body)).toBe(200);
      expect(await filesUpdatedAudit(a)).toHaveLength(1);
    });
  });

  describe("concurrency", () => {
    it("two agents claim one new root at the same time: exactly one succeeds, the other gets 409", async () => {
      const claimant = randomUUID();
      await seedAgent(claimant, { model: "m0" });
      const shared = fresh("race");
      let secondWaited = false;
      let second: Promise<Outcome> | null = null;
      const first = await settle(db.transaction(async (tx) => {
        const result = await agentService(tx as unknown as Db).update(agentId, { adapterConfig: cfg("external", shared) }, { instructionConfigWrite: { keys: "all" } });
        // The first claim holds the assignment lock, uncommitted. The second starts now.
        second = settle(agentService(db).update(claimant, { adapterConfig: cfg("external", shared) }, { instructionConfigWrite: { keys: "all" } }));
        secondWaited = await waitFor(async () => (await advisoryWaiters()) > 0, 2_000);
        return result;
      }));
      const secondOutcome = await second!;
      expect(first.ok).toBe(true);
      expect(secondWaited).toBe(true);
      expect(secondOutcome).toMatchObject({ ok: false, status: 409, code: INSTRUCTION_ROOT_IN_USE });
      expect((await configOf()).instructionsRootPath).toBe(shared);
      expect((await configOf(claimant)).instructionsRootPath).toBeUndefined();
    });

    it("parallel claims of one root by many agents and writers: exactly one wins, no deadlock", async () => {
      const ids = Array.from({ length: 5 }, () => randomUUID());
      for (const id of ids) await seedAgent(id, { model: "m0" });
      const shared = fresh("race-many");
      const outcomes = await Promise.all([
        ...ids.map((id) => settle(agentService(db).update(id, { adapterConfig: cfg("external", shared) }, { instructionConfigWrite: { keys: "all" } }))),
        settle(agentService(db).create(companyId, { name: "Racer", adapterType: "hermes_gateway", adapterConfig: cfg("external", shared) })),
        (async () => { const agent = (await loadAgent())!; return settle(agentInstructionsService(db).updateBundle(agent, { mode: "external", rootPath: shared }, await optionsFor(agent))); })(),
      ]);
      expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1);
      for (const outcome of outcomes.filter((entry) => !entry.ok)) expect(outcome).toMatchObject({ status: 409, code: INSTRUCTION_ROOT_IN_USE });
    });

    it("lock order: concurrent writers of different roots and agents finish without a deadlock", async () => {
      const ids = Array.from({ length: 4 }, () => randomUUID());
      for (const id of ids) await seedAgent(id, { model: "m0" });
      for (let round = 0; round < 3; round += 1) {
        const outcomes = await Promise.all([
          ...ids.map((id) => settle(agentService(db).update(id, { adapterConfig: cfg("external", fresh(`lo-${round}`)) }, { instructionConfigWrite: { keys: "all" } }))),
          settle(agentService(db).create(companyId, { name: `LO-${round}`, adapterType: "hermes_gateway", adapterConfig: cfg("external", fresh("lo-create")) })),
          (async () => { const agent = (await loadAgent())!; return settle(agentInstructionsService(db).updateBundle(agent, { mode: round % 2 ? "managed" : "external", rootPath: fresh("lo-bundle") }, await optionsFor(agent))); })(),
          (async () => { const id = randomUUID(); await seedAgent(id, { model: "m0" }); return settle(agentInstructionsService(db).writeFile((await loadAgent(id))!, "n.md", "SENTINEL\n")); })(),
        ]);
        for (const outcome of outcomes) expect(outcome, JSON.stringify(outcome)).toMatchObject({ ok: true });
      }
    });

    it("A13: an activation during a concurrent instruction change is decided on the locked row", async () => {
      // The pending agent's root is R, which (legacy) overlaps the owner, and
      // the approved payload names R. A concurrent writer moves the agent to
      // S. With the row lock, the activation waits, reads S and checks R
      // (409). Without it, it reads R, sees no root change and activates R.
      const pending = randomUUID();
      const rootR = path.join(ownerRoot, "a13-r");
      const rootS = fresh("a13-s");
      await seed(rootS, { "AGENTS.md": ENTRY });
      await seedAgent(pending, { ...cfg("external", rootR), model: "m0" }, { status: "pending_approval", adapterType: "hermes_gateway" });
      let waited = false;
      const hold = db.transaction(async (tx) => {
        const [row] = await tx.select().from(agents).where(eq(agents.id, pending)).for("update");
        await tx.update(agents).set({ adapterConfig: { ...(row!.adapterConfig as Config), ...cfg("external", rootS) } }).where(eq(agents.id, pending));
        for (let i = 0; i < 200; i += 1) {
          const rows = await db.execute(sql`select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`);
          if (Number((rows as unknown as Array<{ n: number }>)[0]?.n ?? 0) > 0) { waited = true; break; }
          await sleep(25);
        }
      });
      await sleep(50);
      const activation = settle(agentService(db).activatePendingApproval(pending, { name: "Approved", adapterType: "hermes_gateway", adapterConfig: { ...cfg("external", rootR), model: "m0" } }));
      await hold;
      const outcome = await activation;
      expect(waited).toBe(true);
      expect(outcome).toMatchObject({ ok: false, status: 409, code: INSTRUCTION_ROOT_IN_USE });
      expect((await loadAgent(pending))!.status).toBe("pending_approval");
      expect((await configOf(pending)).instructionsRootPath).toBe(rootS);
    });

    it("the assignment lock is transaction scoped: it is free again after a refused write", async () => {
      await settle(agentService(db).update(agentId, { adapterConfig: cfg("external", ownerRoot) }, { instructionConfigWrite: { keys: "all" } }));
      const free = await db.transaction(async (tx) => {
        const rows = await tx.execute(sql`select pg_try_advisory_xact_lock(hashtextextended(${INSTRUCTION_ROOT_ASSIGNMENT_LOCK}, 0)) as ok`);
        return Boolean((rows as unknown as Array<{ ok: boolean }>)[0]?.ok);
      });
      expect(free).toBe(true);
    });
  });

  describe("PG-3 characterization: create pre-check versus locked check", () => {
    it("a root claimed between the two checks is refused under the lock, and no secret is stored (PG-3 closed)", async () => {
      const window = fresh("pg3");
      const claimant = randomUUID();
      await seedAgent(claimant, { model: "m0" });
      const createId = randomUUID();
      const apiKey = await storedApiKeyRef();
      let create: Promise<Outcome> | null = null;
      let createWaited = false;
      await db.transaction(async (tx) => {
        // An uncommitted claim that holds the assignment lock: the create's
        // unlocked pre-check cannot see it, its locked check waits for it.
        await agentService(tx as unknown as Db).update(claimant, { adapterConfig: cfg("external", window) }, { instructionConfigWrite: { keys: "all" } });
        create = settle(agentService(db).create(companyId, { id: createId, name: "PG3", adapterType: "hermes_gateway",
          adapterConfig: { ...cfg("external", window), apiKey } }));
        createWaited = await waitFor(async () => (await advisoryWaiters()) > 0, 5_000);
      });
      const outcome = await create!;
      expect(createWaited).toBe(true);
      expect(outcome).toMatchObject({ ok: false, status: 409, code: INSTRUCTION_ROOT_IN_USE });
      expect(await loadAgent(createId)).toBeUndefined();
      // Before PG-3 the global normalization had already stored a new secret
      // here, an orphan. Normalization now only checks an existing reference,
      // so the refused create leaves the secret rows as they were.
      expect(await secretCount()).toBe(1);
      // A raw value is refused before any write, also outside the window.
      const raw = await settle(agentService(db).create(companyId, { name: "PG3-raw", adapterType: "hermes_gateway",
        adapterConfig: { ...cfg("external", fresh("pg3-raw")), apiKey: RAW_API_KEY } }));
      expect(raw).toMatchObject({ ok: false, status: 422, code: "schema_secret_field_requires_secret_ref" });
      expect(await secretCount()).toBe(1);
    });
  });

  describe("lock order: create with a reporting parent versus the parent's root change", () => {
    // Codex P2 on PR #10. The create's insert takes a KEY SHARE lock on the
    // parent row (reports_to). The parent's root change takes its own row
    // FOR UPDATE, then the assignment lock. The create must take the parent
    // row lock before the assignment lock, or the two wait on each other.
    const GATE = "w1-test-insert-gate";
    const lockOf = (key: string) => sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
    /** Holds an exclusive transaction-scoped advisory lock on key until release() is called. */
    async function holdAdvisory(key: string) {
      let release!: () => void;
      const released = new Promise<void>((resolve) => { release = resolve; });
      let held!: () => void;
      const isHeld = new Promise<void>((resolve) => { held = resolve; });
      const done = db.transaction(async (tx) => { await tx.execute(lockOf(key)); held(); await released; });
      await isHeld;
      return { release, done };
    }
    const assignmentLockFree = () => db.transaction(async (tx) => {
      const rows = await tx.execute(sql`select pg_try_advisory_xact_lock(hashtextextended(${INSTRUCTION_ROOT_ASSIGNMENT_LOCK}, 0)) as ok`);
      return Boolean((rows as unknown as Array<{ ok: boolean }>)[0]?.ok);
    });
    let parentId: string;
    let parentRoot: string;
    beforeEach(async () => {
      parentId = randomUUID();
      parentRoot = fresh("parent");
      await seedAgent(parentId, { ...cfg("external", parentRoot), model: "m0" }, { adapterType: "hermes_gateway" });
      // Pauses an insert or update of a gate-named agent: after its locked check, before the reports_to key lock.
      await db.execute(sql.raw(`create or replace function w1_test_insert_gate() returns trigger language plpgsql as $$
        begin
          if NEW.name like 'w1-gate-%' then perform pg_advisory_xact_lock_shared(hashtextextended('${GATE}', 0)); end if;
          return NEW;
        end $$`));
      await db.execute(sql.raw("drop trigger if exists w1_test_insert_gate on agents"));
      await db.execute(sql.raw("create trigger w1_test_insert_gate before insert or update on agents for each row execute function w1_test_insert_gate()"));
    });
    afterEach(async () => {
      await db.execute(sql.raw("drop trigger if exists w1_test_insert_gate on agents"));
      await db.execute(sql.raw("drop function if exists w1_test_insert_gate()"));
    });

    it.each([
      { conflict: false, label: "independent roots: both succeed" },
      { conflict: true, label: "the parent asks for the child's new root: the parent gets 409 and changes nothing" },
    ])("create holds the assignment lock first, then the parent changes its root ($label)", async ({ conflict }) => {
      const childRoot = fresh("child");
      const parentNext = conflict ? childRoot : fresh("parent-next");
      const childName = `w1-gate-${randomUUID().slice(0, 8)}`;
      const gate = await holdAdvisory(GATE);
      let create: Promise<Outcome> | null = null;
      let parentChange: Promise<Outcome> | null = null;
      let createAtInsert = false, parentQueuedOnLock = false, rowWaitersWhileParentQueued = -1;
      try {
        create = settle(agentService(db).create(companyId, { name: childName, adapterType: "hermes_gateway", reportsTo: parentId,
          adapterConfig: cfg("external", childRoot) }));
        // The create has passed its locked check and waits at the insert gate.
        createAtInsert = await waitFor(async () => (await advisoryWaiters()) === 1, 5_000);
        parentChange = settle(agentService(db).update(parentId, { adapterConfig: cfg("external", parentNext) }, { instructionConfigWrite: { keys: "all" } }));
        // The parent's NO KEY UPDATE row lock does not conflict with the create's KEY SHARE on
        // it: the parent queues on the assignment lock, and no session waits on a row lock.
        parentQueuedOnLock = await waitFor(async () => (await advisoryWaiters()) === 2, 5_000);
        rowWaitersWhileParentQueued = await rowLockWaiters();
      } finally {
        gate.release();
        await gate.done;
      }
      const [createOutcome, parentOutcome] = [await create!, await parentChange!];
      expect(createAtInsert).toBe(true);
      expect(parentQueuedOnLock).toBe(true);
      expect(rowWaitersWhileParentQueued).toBe(0);
      expect(createOutcome, JSON.stringify(createOutcome)).toMatchObject({ ok: true });
      const child = (createOutcome as { value: { id: string } }).value;
      expect((await loadAgent(child.id))!.reportsTo).toBe(parentId);
      expect((await configOf(child.id)).instructionsRootPath).toBe(childRoot);
      if (conflict) {
        expect(parentOutcome).toMatchObject({ ok: false, status: 409, code: INSTRUCTION_ROOT_IN_USE });
        expect((await configOf(parentId)).instructionsRootPath).toBe(parentRoot);
      } else {
        expect(parentOutcome, JSON.stringify(parentOutcome)).toMatchObject({ ok: true });
        expect((await configOf(parentId)).instructionsRootPath).toBe(parentNext);
      }
      expect(await assignmentLockFree()).toBe(true);
    });

    it.each([
      { conflict: false, label: "independent roots: both succeed" },
      { conflict: true, label: "the child asks for the parent's new root: the create gets 409 and inserts nothing" },
    ])("the parent holds its row first and waits for the assignment lock, then a child is created ($label)", async ({ conflict }) => {
      const parentNext = fresh("parent-next");
      const childRoot = conflict ? parentNext : fresh("child");
      const childId = randomUUID();
      const agentsBefore = await agentCount();
      const assignment = await holdAdvisory(INSTRUCTION_ROOT_ASSIGNMENT_LOCK);
      let create: Promise<Outcome> | null = null;
      let parentChange: Promise<Outcome> | null = null;
      let parentAtLock = false, createQueuedOnLock = false, rowWaitersWhileCreateQueued = -1;
      try {
        parentChange = settle(agentService(db).update(parentId, { adapterConfig: cfg("external", parentNext) }, { instructionConfigWrite: { keys: "all" } }));
        // The parent holds its row (FOR NO KEY UPDATE) and waits for the assignment lock.
        parentAtLock = await waitFor(async () => (await advisoryWaiters()) === 1, 5_000);
        create = settle(agentService(db).create(companyId, { id: childId, name: `W1-child-${childId.slice(0, 8)}`, adapterType: "hermes_gateway",
          reportsTo: parentId, adapterConfig: cfg("external", childRoot) }));
        // The create's KEY SHARE on the parent row does not conflict with the parent's NO KEY
        // UPDATE lock: the create queues on the assignment lock, and no session waits on a row lock.
        createQueuedOnLock = await waitFor(async () => (await advisoryWaiters()) === 2, 5_000);
        rowWaitersWhileCreateQueued = await rowLockWaiters();
      } finally {
        assignment.release();
        await assignment.done;
      }
      const [parentOutcome, createOutcome] = [await parentChange!, await create!];
      expect(parentAtLock).toBe(true);
      expect(createQueuedOnLock).toBe(true);
      expect(rowWaitersWhileCreateQueued).toBe(0);
      expect(parentOutcome, JSON.stringify(parentOutcome)).toMatchObject({ ok: true });
      expect((await configOf(parentId)).instructionsRootPath).toBe(parentNext);
      if (conflict) {
        expect(createOutcome).toMatchObject({ ok: false, status: 409, code: INSTRUCTION_ROOT_IN_USE });
        expect(await loadAgent(childId)).toBeUndefined();
        expect(await agentCount()).toBe(agentsBefore);
      } else {
        expect(createOutcome, JSON.stringify(createOutcome)).toMatchObject({ ok: true });
        expect((await loadAgent(childId))!.reportsTo).toBe(parentId);
        expect((await configOf(childId)).instructionsRootPath).toBe(childRoot);
      }
      expect(await assignmentLockFree()).toBe(true);
    });

    /**
     * Runs subject (the write under test) against a root change of the parent, in one of two
     * orders, with deterministic barriers. "subject-first": the subject passes its locked check and
     * waits at the gate (before its reports_to key lock); then the parent starts. "parent-first":
     * the test holds the assignment lock; the parent locks its row and waits for it; then the
     * subject starts. In both orders the second writer must queue on the assignment lock and no
     * session may wait on a row lock: writers hold agent rows FOR NO KEY UPDATE, which the
     * reports_to KEY SHARE lock does not conflict with. Every wait is bounded.
     */
    async function interleave(order: "subject-first" | "parent-first", subject: () => Promise<unknown>, parentNext: string) {
      const barrier = await holdAdvisory(order === "subject-first" ? GATE : INSTRUCTION_ROOT_ASSIGNMENT_LOCK);
      const changeParent = () => settle(agentService(db).update(parentId, { adapterConfig: cfg("external", parentNext) }, { instructionConfigWrite: { keys: "all" } }));
      let subjectRun: Promise<Outcome> | null = null;
      let parentRun: Promise<Outcome> | null = null;
      let firstAtBarrier = false, secondQueuedOnLock = false, rowWaitersWhileSecondQueued = -1;
      try {
        if (order === "subject-first") subjectRun = settle(subject());
        else parentRun = changeParent();
        firstAtBarrier = await waitFor(async () => (await advisoryWaiters()) === 1, 5_000);
        if (order === "subject-first") parentRun = changeParent();
        else subjectRun = settle(subject());
        secondQueuedOnLock = await waitFor(async () => (await advisoryWaiters()) === 2, 5_000);
        rowWaitersWhileSecondQueued = await rowLockWaiters();
      } finally {
        barrier.release();
        await barrier.done;
      }
      const result = { subject: await subjectRun!, parent: await parentRun!, firstAtBarrier, secondQueuedOnLock, rowWaitersWhileSecondQueued };
      expect(result.firstAtBarrier).toBe(true);
      expect(result.secondQueuedOnLock).toBe(true);
      expect(result.rowWaitersWhileSecondQueued).toBe(0);
      expect(await assignmentLockFree()).toBe(true);
      return result;
    }
    const orders = [
      { order: "subject-first" as const, conflict: false },
      { order: "subject-first" as const, conflict: true },
      { order: "parent-first" as const, conflict: false },
      { order: "parent-first" as const, conflict: true },
    ];

    it.each(orders)("root-changing PATCH that also sets reportsTo, versus the parent's root change ($order, conflict $conflict)", async ({ order, conflict }) => {
      const childId = randomUUID();
      await seedAgent(childId, { model: "m0" }, { name: `w1-gate-${childId.slice(0, 8)}`, adapterType: "hermes_gateway" });
      const before = await configOf(childId);
      // The conflicting write is always the one that runs second.
      const shared = fresh("shared");
      const childRoot = conflict && order === "parent-first" ? shared : fresh("child");
      const parentNext = conflict && order === "subject-first" ? childRoot : (conflict ? shared : fresh("parent-next"));
      const { subject, parent } = await interleave(order, () => agentService(db).update(childId,
        { reportsTo: parentId, adapterConfig: cfg("external", childRoot) }, { instructionConfigWrite: { keys: "all" } }), parentNext);
      const childRefused = conflict && order === "parent-first";
      const parentRefused = conflict && order === "subject-first";
      if (childRefused) {
        expect(subject).toMatchObject({ ok: false, status: 409, code: INSTRUCTION_ROOT_IN_USE });
        expect(await configOf(childId)).toEqual(before);
        expect((await loadAgent(childId))!.reportsTo).toBeNull();
      } else {
        expect(subject, JSON.stringify(subject)).toMatchObject({ ok: true });
        expect((await loadAgent(childId))!.reportsTo).toBe(parentId);
        expect((await configOf(childId)).instructionsRootPath).toBe(childRoot);
      }
      if (parentRefused) {
        expect(parent).toMatchObject({ ok: false, status: 409, code: INSTRUCTION_ROOT_IN_USE });
        expect((await configOf(parentId)).instructionsRootPath).toBe(parentRoot);
      } else {
        expect(parent, JSON.stringify(parent)).toMatchObject({ ok: true });
        expect((await configOf(parentId)).instructionsRootPath).toBe(parentNext);
      }
    });

    // PG-4: an approval refuses a linked payload that changes the pending agent's instruction root
    // (409, nothing changed), so this W1 lock order is reached only by the activation service itself.
    it.each(orders)("hire activation whose payload sets reportsTo and a root, versus the parent's root change ($order, conflict $conflict)", async ({ order, conflict }) => {
      const pendingId = randomUUID();
      await seedAgent(pendingId, { model: "m0" }, { name: `w1-gate-${pendingId.slice(0, 8)}`, status: "pending_approval", adapterType: "hermes_gateway" });
      const shared = fresh("shared");
      const childRoot = conflict && order === "parent-first" ? shared : fresh("approved");
      const parentNext = conflict && order === "subject-first" ? childRoot : (conflict ? shared : fresh("parent-next"));
      const payload = { agentId: pendingId, adapterType: "hermes_gateway", reportsTo: parentId, adapterConfig: { ...cfg("external", childRoot), model: "m0" } };
      const { subject, parent } = await interleave(order, () => agentService(db).activatePendingApproval(pendingId, payload), parentNext);
      const approvalRefused = conflict && order === "parent-first";
      const parentRefused = conflict && order === "subject-first";
      if (approvalRefused) {
        expect(subject).toMatchObject({ ok: false, status: 409, code: INSTRUCTION_ROOT_IN_USE });
        expect((await loadAgent(pendingId))!.status).toBe("pending_approval");
        expect((await loadAgent(pendingId))!.reportsTo).toBeNull();
      } else {
        expect(subject, JSON.stringify(subject)).toMatchObject({ ok: true, value: { activated: true } });
        expect((await loadAgent(pendingId))!.status).toBe("idle");
        expect((await loadAgent(pendingId))!.reportsTo).toBe(parentId);
        expect((await configOf(pendingId)).instructionsRootPath).toBe(childRoot);
      }
      if (parentRefused) {
        expect(parent).toMatchObject({ ok: false, status: 409, code: INSTRUCTION_ROOT_IN_USE });
        expect((await configOf(parentId)).instructionsRootPath).toBe(parentRoot);
      } else {
        expect(parent, JSON.stringify(parent)).toMatchObject({ ok: true });
        expect((await configOf(parentId)).instructionsRootPath).toBe(parentNext);
      }
    });

    // Revision-actor cycle (PR #10 follow-up). An agent actor A saves into B's bundle, which
    // first-binds B's managed root: the outer transaction locks B, takes the assignment lock,
    // then the revision insert takes a KEY SHARE lock on A through created_by_agent_id. A
    // concurrent root change of A locks A's row and waits for the assignment lock.
    /** Persist as the routes do for an agent actor: attributed to that agent. */
    const persistAs = (actorAgentId: string): InstructionConfigPersist => async (tx, current, adapterConfig) => {
      const txDb = tx as unknown as Db;
      const normalized = await secretService(txDb).normalizeAdapterConfigForPersistence(current.companyId, adapterConfig,
        { strictMode: false, adapterType: current.adapterType ?? "process" });
      await agentService(txDb).update(current.id, { adapterConfig: normalized },
        { recordRevision: { createdByAgentId: actorAgentId, createdByUserId: null, source: "instructions_bundle_file_put" }, instructionConfigWrite: { keys: "all" } });
    };
    /** Agent actorId saves notes/a.md into targetId's bundle (first managed-root bind). */
    const actorSave = async (actorId: string, targetId: string) =>
      agentInstructionsService(db).writeFile((await loadAgent(targetId))!, "notes/a.md", `SENTINEL-${actorId.slice(0, 8)}\n`, { persistConfig: persistAs(actorId) });
    const revisionsOf = async (target: string) => db.select().from(agentConfigRevisions).where(eq(agentConfigRevisions.agentId, target));
    /** Like settle, but keeps the database error text and SQLSTATE that query wrappers put in cause. */
    const settleDeep = (promise: Promise<unknown>): Promise<Outcome> => promise.then(
      (value) => ({ ok: true as const, value }),
      (error: any) => {
        const chain: any[] = [];
        for (let current = error; current && chain.length < 5; current = current.cause) chain.push(current);
        const sqlState = chain.map((entry) => entry?.code).find((code) => typeof code === "string" && /^[0-9A-Z]{5}$/.test(code));
        return { ok: false as const, status: error?.status, code: error?.details?.code ?? sqlState ?? error?.code,
          message: chain.map((entry) => String(entry?.message ?? "")).join(" | "), details: error?.details ?? {} };
      });
    const isDeadlock = (outcome: Outcome) => {
      if (outcome.ok) return false;
      return /deadlock detected/i.test(outcome.message) || outcome.code === "40P01";
    };
    /**
     * "assignment-first": the first writer takes the assignment lock and waits at the gate (after its
     * locked check, before its agent row update and revision insert); the second then starts.
     * "row-first": the test holds the assignment lock; the first writer locks its row and queues for
     * it; the second locks its own row and queues behind. Released, the first runs first.
     * Either way the second writer must queue on the assignment lock and no session may wait on a
     * row lock. Every wait is bounded; outcomes are read after both transactions settle.
     */
    async function race(order: "assignment-first" | "row-first", first: () => Promise<unknown>, second: () => Promise<unknown>) {
      const barrier = await holdAdvisory(order === "assignment-first" ? GATE : INSTRUCTION_ROOT_ASSIGNMENT_LOCK);
      let firstRun: Promise<Outcome> | null = null;
      let secondRun: Promise<Outcome> | null = null;
      let firstQueued = false, secondQueued = false, rowWaitersWhileQueued = -1;
      try {
        firstRun = settleDeep(first());
        firstQueued = await waitFor(async () => (await advisoryWaiters()) === 1, 5_000);
        secondRun = settleDeep(second());
        secondQueued = await waitFor(async () => (await advisoryWaiters()) === 2, 5_000);
        rowWaitersWhileQueued = await rowLockWaiters();
      } finally {
        barrier.release();
        await barrier.done;
      }
      const outcomes = { first: await firstRun!, second: await secondRun! };
      expect(firstQueued).toBe(true);
      expect(secondQueued).toBe(true);
      expect(rowWaitersWhileQueued).toBe(0);
      expect(isDeadlock(outcomes.first) || isDeadlock(outcomes.second), JSON.stringify(outcomes)).toBe(false);
      expect(await assignmentLockFree()).toBe(true);
      return outcomes;
    }
    async function seedPair() {
      const actorId = randomUUID(), targetId = randomUUID();
      await seedAgent(actorId, { model: "m0" }, { adapterType: "hermes_gateway" });
      await seedAgent(targetId, { model: "m0" }, { name: `w1-gate-${targetId.slice(0, 8)}`, adapterType: "hermes_gateway" });
      return { actorId, targetId };
    }
    const managedOf = (id: string) => resolveManagedInstructionsRoot({ id, companyId, name: "x", adapterConfig: {} });

    it.each(["assignment-first", "row-first"] as const)(
      "agent A first-binds B's bundle while the board changes A's root ($0): both commit, revision attributed to A",
      async (order) => {
        const { actorId, targetId } = await seedPair();
        const actorNext = fresh("actor-next");
        const { first, second } = await race(order, () => actorSave(actorId, targetId),
          () => agentService(db).update(actorId, { adapterConfig: cfg("external", actorNext) }, { instructionConfigWrite: { keys: "all" } }));
        expect(first, JSON.stringify(first)).toMatchObject({ ok: true });
        expect(second, JSON.stringify(second)).toMatchObject({ ok: true });
        expect((await configOf(targetId)).instructionsRootPath).toBe(managedOf(targetId));
        expect(await fs.readFile(path.join(managedOf(targetId), "notes/a.md"), "utf8")).toBe(`SENTINEL-${actorId.slice(0, 8)}\n`);
        const revisions = await revisionsOf(targetId);
        expect(revisions.length).toBeGreaterThan(0);
        for (const revision of revisions) {
          expect(revision.createdByAgentId).toBe(actorId);
          expect(revision.createdByUserId).toBeNull();
        }
        expect((await configOf(actorId)).instructionsRootPath).toBe(actorNext);
      },
    );

    it.each(["assignment-first", "row-first"] as const)(
      "reciprocal actors: A saves into B while B saves into A ($0): both commit with their own attribution",
      async (order) => {
        const { actorId: a, targetId: b } = await seedPair();
        const { first, second } = await race(order, () => actorSave(a, b), () => actorSave(b, a));
        expect(first, JSON.stringify(first)).toMatchObject({ ok: true });
        expect(second, JSON.stringify(second)).toMatchObject({ ok: true });
        expect((await configOf(b)).instructionsRootPath).toBe(managedOf(b));
        expect((await configOf(a)).instructionsRootPath).toBe(managedOf(a));
        expect((await revisionsOf(b)).every((revision) => revision.createdByAgentId === a)).toBe(true);
        expect((await revisionsOf(a)).every((revision) => revision.createdByAgentId === b)).toBe(true);
        expect((await revisionsOf(a)).length).toBeGreaterThan(0);
      },
    );

    it("reporting parent and revision actor together: A saves into B while the board moves C under A with a new root and A changes its root", async () => {
      const { actorId, targetId } = await seedPair();
      const childId = randomUUID();
      await seedAgent(childId, { model: "m0" }, { adapterType: "hermes_gateway" });
      const childRoot = fresh("child"), actorNext = fresh("actor-next");
      const gate = await holdAdvisory(GATE);
      let save: Promise<Outcome> | null = null, move: Promise<Outcome> | null = null, change: Promise<Outcome> | null = null;
      let queued = false, rowWaiters = -1;
      try {
        save = settleDeep(actorSave(actorId, targetId));
        await waitFor(async () => (await advisoryWaiters()) === 1, 5_000);
        move = settleDeep(agentService(db).update(childId, { reportsTo: actorId, adapterConfig: cfg("external", childRoot) }, { instructionConfigWrite: { keys: "all" } }));
        change = settleDeep(agentService(db).update(actorId, { adapterConfig: cfg("external", actorNext) }, { instructionConfigWrite: { keys: "all" } }));
        queued = await waitFor(async () => (await advisoryWaiters()) === 3, 5_000);
        rowWaiters = await rowLockWaiters();
      } finally {
        gate.release();
        await gate.done;
      }
      const outcomes = [await save!, await move!, await change!];
      expect(queued).toBe(true);
      expect(rowWaiters).toBe(0);
      for (const outcome of outcomes) expect(outcome, JSON.stringify(outcome)).toMatchObject({ ok: true });
      expect((await loadAgent(childId))!.reportsTo).toBe(actorId);
      expect((await configOf(childId)).instructionsRootPath).toBe(childRoot);
      expect((await configOf(actorId)).instructionsRootPath).toBe(actorNext);
      expect((await revisionsOf(targetId)).every((revision) => revision.createdByAgentId === actorId)).toBe(true);
    });

    it.each(["assignment-first", "row-first"] as const)(
      "the board moves A's bundle into B's managed area while A first-binds B ($0): the bundle switch is refused with nothing written",
      async (order) => {
        const { actorId, targetId } = await seedPair();
        const before = await configOf(actorId);
        const revisionsBefore = (await revisionsOf(actorId)).length;
        const intoB = path.join(managedOf(targetId), "stolen");
        const actor = (await loadAgent(actorId))!;
        const options = await optionsFor(actor);
        const { first, second } = await race(order, () => actorSave(actorId, targetId),
          () => agentInstructionsService(db).updateBundle(actor, { mode: "external", rootPath: intoB }, options));
        expect(first, JSON.stringify(first)).toMatchObject({ ok: true });
        expect(second).toMatchObject({ ok: false, status: 409, code: INSTRUCTION_ROOT_IN_USE });
        expect(await configOf(actorId)).toEqual(before);
        expect((await revisionsOf(actorId)).length).toBe(revisionsBefore);
        expect(await exists(intoB)).toBe(false);
        expect(await fs.readdir(instructionCopyIntentsDirectory()).catch(() => [] as string[])).toEqual([]);
        expect((await revisionsOf(targetId)).every((revision) => revision.createdByAgentId === actorId)).toBe(true);
      },
    );

    it.each(["assignment-first", "row-first"] as const)(
      "the board moves A's bundle to an independent root while A first-binds B ($0): both commit, files copied, no copy intent left",
      async (order) => {
        const { actorId, targetId } = await seedPair();
        const actorRoot = managedOf(actorId);
        await seed(actorRoot, { "AGENTS.md": ENTRY });
        await db.update(agents).set({ adapterConfig: { ...cfg("managed", actorRoot), model: "m0" } }).where(eq(agents.id, actorId));
        const independent = fresh("independent");
        const actor = (await loadAgent(actorId))!;
        const options = await optionsFor(actor);
        const { first, second } = await race(order, () => actorSave(actorId, targetId),
          () => agentInstructionsService(db).updateBundle(actor, { mode: "external", rootPath: independent }, options));
        expect(first, JSON.stringify(first)).toMatchObject({ ok: true });
        expect(second, JSON.stringify(second)).toMatchObject({ ok: true });
        expect((await configOf(actorId)).instructionsRootPath).toBe(independent);
        expect(await fs.readFile(path.join(independent, "AGENTS.md"), "utf8")).toBe(ENTRY);
        expect(await fs.readdir(instructionCopyIntentsDirectory()).catch(() => [] as string[])).toEqual([]);
        expect((await revisionsOf(targetId)).every((revision) => revision.createdByAgentId === actorId)).toBe(true);
      },
    );

    it.each(["assignment-first", "row-first"] as const)(
      "the board saves into A's unconfigured managed bundle (store repair binds A's root) while A first-binds B ($0): both commit",
      async (order) => {
        const { actorId, targetId } = await seedPair();
        await seed(managedOf(actorId), { "AGENTS.md": ENTRY });
        const repairAsBoard: AgentFileConfigRepair = async (tx, agent, adapterConfig) => {
          await agentService(tx as unknown as Db).update(agent.id, { adapterConfig },
            { recordRevision: { createdByAgentId: null, createdByUserId: userId, source: "instructions_bundle_file_put" }, instructionConfigWrite: { keys: "all" } });
        };
        const { first, second } = await race(order, () => actorSave(actorId, targetId),
          () => agentFileStore(db).write({ companyId, agentId: actorId, path: "notes/b.md", bytes: Buffer.from("SENTINEL-STORE\n"), baseHash: null },
            { type: "board", userId, source: "session" }, { repairConfig: repairAsBoard }));
        expect(first, JSON.stringify(first)).toMatchObject({ ok: true });
        expect(second, JSON.stringify(second)).toMatchObject({ ok: true });
        expect((await configOf(actorId)).instructionsRootPath).toBe(managedOf(actorId));
        expect(await fs.readFile(path.join(managedOf(actorId), "notes/b.md"), "utf8")).toBe("SENTINEL-STORE\n");
        expect((await revisionsOf(targetId)).every((revision) => revision.createdByAgentId === actorId)).toBe(true);
        expect((await revisionsOf(actorId)).every((revision) => revision.createdByUserId === userId && revision.createdByAgentId === null)).toBe(true);
      },
    );

    // First managed-root bind (materializeManagedBundle, as the default-bundle route runs it:
    // materialize, then persist the returned config). The materialize transaction locks A's row
    // and takes the assignment lock, while A's save into B holds the assignment lock and then
    // needs KEY SHARE on A for the revision actor. A FOR UPDATE owner lock would deadlock.
    it.each(["assignment-first", "row-first"] as const)(
      "the board materializes A's default bundle while A first-binds B ($0): both commit, A owns its managed root",
      async (order) => {
        const { actorId, targetId } = await seedPair();
        const actor = (await loadAgent(actorId))!;
        const materializeAndPersist = async () => {
          const materialized = await agentInstructionsService(db).materializeManagedBundle(actor, { "AGENTS.md": ENTRY },
            { entryFile: "AGENTS.md", replaceExisting: false });
          return agentService(db).update(actorId, { adapterConfig: materialized.adapterConfig },
            { allowPendingApprovalConfigUpdate: true, instructionConfigWrite: { keys: "all" } });
        };
        const { first, second } = await race(order, () => actorSave(actorId, targetId), materializeAndPersist);
        expect(first, JSON.stringify(first)).toMatchObject({ ok: true });
        expect(second, JSON.stringify(second)).toMatchObject({ ok: true });
        // WS-2 PR-W2: materialize activates a versioned generation inside A's own managed area; reload A to resolve it.
        const activated = (await loadAgent(actorId))!;
        expect(activated.instructionBundleId).toBeTruthy();
        const actorManaged = resolveManagedInstructionsRoot(activated);
        expect(actorManaged).toBe(path.join(path.dirname(managedOf(actorId)), "instruction-versions", activated.instructionBundleId!));
        expect((await configOf(actorId)).instructionsRootPath).toBe(actorManaged);
        expect((await configOf(actorId)).instructionsBundleMode).toBe("managed");
        expect(await fs.readFile(path.join(actorManaged, "AGENTS.md"), "utf8")).toBe(ENTRY);
        expect((await configOf(targetId)).instructionsRootPath).toBe(managedOf(targetId));
        expect(await fs.readFile(path.join(managedOf(targetId), "notes/a.md"), "utf8")).toBe(`SENTINEL-${actorId.slice(0, 8)}\n`);
        const revisions = await revisionsOf(targetId);
        expect(revisions.length).toBeGreaterThan(0);
        for (const revision of revisions) {
          expect(revision.createdByAgentId).toBe(actorId);
          expect(revision.createdByUserId).toBeNull();
        }
        expect(await fs.readdir(instructionCopyIntentsDirectory()).catch(() => [] as string[])).toEqual([]);
      },
    );

    // Hire approval activation (A13) of pending agent P, through approvalService.approve, while the
    // board moves C under P with a new root. C's write pre-locks P FOR KEY SHARE before the
    // assignment lock. With A13 at FOR NO KEY UPDATE neither waits on a row: the second writer
    // queues on the assignment lock. A13 at FOR UPDATE conflicts with that KEY SHARE lock.
    it.each(["assignment-first", "row-first"] as const)(
      "hire activation activates pending P while the board moves C under P with a new root ($0): both commit, no row wait",
      async (order) => {
        const pendingId = randomUUID(), childId = randomUUID();
        await seedAgent(pendingId, { model: "m0" }, { status: "pending_approval", adapterType: "hermes_gateway" });
        await seedAgent(childId, { model: "m0" }, { name: `w1-gate-${childId.slice(0, 8)}`, adapterType: "hermes_gateway" });
        const approvedRoot = fresh("approved"), childRoot = fresh("child");
        // PG-4: reached only by the activation service (an approval refuses a linked root change).
        const approve = () => agentService(db).activatePendingApproval(pendingId,
          { agentId: pendingId, adapterType: "hermes_gateway", adapterConfig: { ...cfg("external", approvedRoot), model: "m0" } });
        const moveChild = () => agentService(db).update(childId, { reportsTo: pendingId, adapterConfig: cfg("external", childRoot) },
          { instructionConfigWrite: { keys: "all" } });
        // assignment-first: C holds the assignment lock (paused at its gated update), then P activates.
        // row-first: P holds its row and queues on the assignment lock, then C starts.
        const { first, second } = order === "assignment-first" ? await race(order, moveChild, approve) : await race(order, approve, moveChild);
        const [activation, move] = order === "assignment-first" ? [second, first] : [first, second];
        expect(activation, JSON.stringify(activation)).toMatchObject({ ok: true, value: { activated: true } });
        expect(move, JSON.stringify(move)).toMatchObject({ ok: true });
        const activated = (await loadAgent(pendingId))!;
        expect(activated.status).toBe("idle");
        expect(activated.reportsTo).toBeNull();
        expect((activated.adapterConfig as Config).instructionsRootPath).toBe(approvedRoot);
        expect((await loadAgent(childId))!.reportsTo).toBe(pendingId);
        expect((await configOf(childId)).instructionsRootPath).toBe(childRoot);
        expect(await fs.readdir(instructionCopyIntentsDirectory()).catch(() => [] as string[])).toEqual([]);
      },
    );

    // Instructions-path PATCH route (Codex P2 on b204944d). The route locks A's row in its own
    // transaction (lockAgentForInstructionsChange), then updateAgent takes the assignment lock
    // for the new root. A FOR UPDATE route lock would deadlock with A's first bind of B.
    it.each(["assignment-first", "row-first"] as const)(
      "the board moves A's instructions path through the route while A first-binds B ($0): both commit, attribution kept",
      async (order) => {
        const { actorId, targetId } = await seedPair();
        const nextRoot = fresh("path-next");
        // The real routes and error handler; a test-only hook before the handler keeps the
        // server error so its SQLSTATE can be checked (the 500 body hides it).
        const routeErrors: unknown[] = [];
        const server = express();
        server.use(express.json());
        server.use((req, _res, next) => { (req as any).actor = actorAdmin(); next(); });
        server.use("/api", agentRoutes(db as any));
        server.use((err: unknown, _req: express.Request, _res: express.Response, next: express.NextFunction) => { routeErrors.push(err); next(err); });
        server.use(errorHandler);
        const pathPatch = async () => {
          const res = await request(server).patch(`/api/agents/${actorId}/instructions-path`)
            .send({ path: path.join(nextRoot, "AGENTS.md"), adapterConfigKey: "instructionsFilePath" });
          if (res.status !== 200) throw routeErrors[0] ?? Object.assign(new Error(JSON.stringify(res.body)), { status: res.status });
          return res.body;
        };
        const actorRevisionsBefore = (await revisionsOf(actorId)).length;
        const { first, second } = await race(order, () => actorSave(actorId, targetId), pathPatch);
        expect(first, JSON.stringify(first)).toMatchObject({ ok: true });
        expect(second, JSON.stringify(second)).toMatchObject({ ok: true });
        expect(routeErrors).toEqual([]);
        expect((await configOf(actorId)).instructionsFilePath).toBe(path.join(nextRoot, "AGENTS.md"));
        expect((await configOf(actorId)).instructionsRootPath).toBe(nextRoot);
        const actorRevisions = await revisionsOf(actorId);
        expect(actorRevisions.length).toBe(actorRevisionsBefore + 1);
        for (const revision of actorRevisions) {
          expect(revision.createdByUserId).toBe(userId);
          expect(revision.createdByAgentId).toBeNull();
        }
        expect((await configOf(targetId)).instructionsRootPath).toBe(managedOf(targetId));
        expect(await fs.readFile(path.join(managedOf(targetId), "notes/a.md"), "utf8")).toBe(`SENTINEL-${actorId.slice(0, 8)}\n`);
        const targetRevisions = await revisionsOf(targetId);
        expect(targetRevisions.length).toBeGreaterThan(0);
        for (const revision of targetRevisions) {
          expect(revision.createdByAgentId).toBe(actorId);
          expect(revision.createdByUserId).toBeNull();
        }
        expect(await fs.readdir(instructionCopyIntentsDirectory()).catch(() => [] as string[])).toEqual([]);
      },
    );

    // Canonical entry commit route (Codex P2 on 3ac09f46). The commit locks A's row in
    // agent-instruction-revisions.ts (lockTarget), then the first-bind guard takes the assignment
    // lock. A's concurrent first bind of B holds the assignment lock and then needs KEY SHARE on A
    // (created_by_agent_id). A FOR UPDATE commit lock would deadlock with it.
    it.each(["assignment-first", "row-first"] as const)(
      "the board commits A's entry through the route (A's first bind) while A first-binds B ($0): both commit, attribution kept",
      async (order) => {
        const { actorId, targetId } = await seedPair();
        // The real routes and error handler; a test-only hook before the handler keeps the
        // server error so its SQLSTATE can be checked (the 500 body hides it).
        const routeErrors: unknown[] = [];
        const server = express();
        server.use(express.json());
        server.use((req, _res, next) => { (req as any).actor = actorAdmin(); next(); });
        server.use("/api", agentRoutes(db as any));
        server.use((err: unknown, _req: express.Request, _res: express.Response, next: express.NextFunction) => { routeErrors.push(err); next(err); });
        server.use(errorHandler);
        const commit = async () => {
          const res = await putEntry(server, actorId, { content: "SENTINEL-COMMIT\n", baseRevisionId: null });
          if (res.status !== 200) throw routeErrors[0] ?? Object.assign(new Error(JSON.stringify(res.body)), { status: res.status });
          return res.body;
        };
        const { first, second } = await race(order, () => actorSave(actorId, targetId), commit);
        expect(first, JSON.stringify(first)).toMatchObject({ ok: true });
        expect(second, JSON.stringify(second)).toMatchObject({ ok: true });
        expect(routeErrors).toEqual([]);
        // A: bound to its managed root by the commit, bytes written, audited to the board user.
        expect(await configOf(actorId)).toMatchObject({ instructionsBundleMode: "managed", instructionsRootPath: managedOf(actorId),
          instructionsFilePath: `${managedOf(actorId)}/AGENTS.md` });
        expect(await fs.readFile(path.join(managedOf(actorId), "AGENTS.md"), "utf8")).toBe("SENTINEL-COMMIT\n");
        const audit = await filesUpdatedAudit(actorId);
        expect(audit).toHaveLength(1);
        expect(audit[0]).toMatchObject({ actorType: "user", actorId: userId, agentId: null });
        expect(await revisionsOf(actorId)).toEqual([]);
        // B: first-bound by A's save, attributed to A.
        expect((await configOf(targetId)).instructionsRootPath).toBe(managedOf(targetId));
        expect(await fs.readFile(path.join(managedOf(targetId), "notes/a.md"), "utf8")).toBe(`SENTINEL-${actorId.slice(0, 8)}\n`);
        const targetRevisions = await revisionsOf(targetId);
        expect(targetRevisions.length).toBeGreaterThan(0);
        for (const revision of targetRevisions) {
          expect(revision.createdByAgentId).toBe(actorId);
          expect(revision.createdByUserId).toBeNull();
        }
        // No row lock on either agent is left behind.
        const rowLocks = await db.execute(sql`select count(*)::int as n from pg_locks l join pg_class c on c.oid = l.relation
          where c.relname = 'agents' and l.locktype = 'tuple'`);
        expect(Number((rowLocks as unknown as Array<{ n: number }>)[0]?.n ?? 0)).toBe(0);
        const locked = await db.transaction(async (tx) => tx.execute(sql`select id from agents where id in (${actorId}, ${targetId}) for update nowait`));
        expect((locked as unknown as unknown[]).length).toBe(2);
      },
    );

    it("negative control: a session that holds A FOR UPDATE and then waits for the assignment lock deadlocks with A's save into B", async () => {
      // The pre-correction lock: FOR UPDATE conflicts with the revision insert's KEY SHARE on A.
      // PostgreSQL detects the cycle and aborts one side; this proves the harness sees the defect.
      const { actorId, targetId } = await seedPair();
      const gate = await holdAdvisory(GATE);
      let save: Promise<Outcome> | null = null, holder: Promise<Outcome> | null = null;
      try {
        save = settleDeep(actorSave(actorId, targetId));
        expect(await waitFor(async () => (await advisoryWaiters()) === 1, 5_000)).toBe(true);
        holder = settleDeep(db.transaction(async (tx) => {
          await tx.select({ id: agents.id }).from(agents).where(eq(agents.id, actorId)).for("update");
          await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${INSTRUCTION_ROOT_ASSIGNMENT_LOCK}, 0))`);
        }));
        expect(await waitFor(async () => (await advisoryWaiters()) === 2, 5_000)).toBe(true);
      } finally {
        gate.release();
        await gate.done;
      }
      const outcomes = [await save!, await holder!];
      expect(outcomes.filter(isDeadlock), JSON.stringify(outcomes)).toHaveLength(1);
      expect(await assignmentLockFree()).toBe(true);
    });

    // IF-1 fix: read-triggered first adoption now takes the assignment lock, so the read paths lock
    // the agent row FOR NO KEY UPDATE. A's first-adoption read must not deadlock with A's save into B,
    // which holds the assignment lock and then needs KEY SHARE on A (created_by_agent_id).
    const adoptionReaders = [
      { name: "runtime read", read: (id: string) => agentInstructionRevisionService(db).readCommittedForRuntime({ companyId, agentId: id }) },
      { name: "GET instructions-bundle route", read: async (id: string) => {
        const res = await request(app()).get(`/api/agents/${id}/instructions-bundle`);
        if (res.status !== 200) throw Object.assign(new Error(JSON.stringify(res.body)), { status: res.status });
        return res.body;
      } },
    ];
    it.each((["assignment-first", "row-first"] as const).flatMap((order) => adoptionReaders.map((reader) => ({ order, ...reader }))))(
      "A's first-adoption read ($name) while A first-binds B ($order): both commit, no deadlock, attribution kept",
      async ({ order, read }) => {
        const { actorId, targetId } = await seedPair();
        const { first, second } = await race(order, () => actorSave(actorId, targetId), () => read(actorId));
        expect(first, JSON.stringify(first)).toMatchObject({ ok: true });
        expect(second, JSON.stringify(second)).toMatchObject({ ok: true });
        expect(JSON.parse(await fs.readFile(path.join(resolveManagedAgentArea({ id: actorId, companyId }), "file-sync", "adopted.json"), "utf8")))
          .toEqual({ schema: AGENT_FILES_CONTRACT });
        expect((await configOf(targetId)).instructionsRootPath).toBe(managedOf(targetId));
        const revisions = await revisionsOf(targetId);
        expect(revisions.length).toBeGreaterThan(0);
        for (const revision of revisions) expect(revision.createdByAgentId).toBe(actorId);
      },
    );
  });

  describe("hire approval: the decision and the activation or creation commit together", () => {
    const BUDGET = 700;
    const approvalRow = async (id: string) => (await db.select().from(approvals).where(eq(approvals.id, id)))[0]!;
    const budgetRows = async (agent: string) => db.select().from(budgetPolicies)
      .where(eq(budgetPolicies.scopeId, agent));
    async function insertApproval(status: "pending" | "revision_requested", payload: Record<string, unknown>) {
      const [row] = await db.insert(approvals).values({ companyId, type: "hire_agent", status, payload }).returning();
      return row!;
    }
    const overlappingConfig = () => ({ ...cfg("external", ownerRoot), model: "m0" });
    const independentConfig = (label: string) => ({ ...cfg("external", fresh(label)), model: "m0" });

    it.each(["pending", "revision_requested"] as const)(
      // PG-4: a linked payload that changes the pending agent's root is now refused as stale (409)
      // inside the decision transaction; the rollback guarantees are unchanged.
      "existing pending agent: a root-changing payload's 409 rolls the decision back (%s stays), nothing fires; a corrected payload then approves once",
      async (status) => {
        const pendingId = randomUUID();
        await seedAgent(pendingId, { model: "m0" }, { status: "pending_approval", adapterType: "hermes_gateway" });
        const before = await configOf(pendingId);
        const approval = await insertApproval(status, { agentId: pendingId, adapterType: "hermes_gateway", budgetMonthlyCents: BUDGET,
          adapterConfig: { ...overlappingConfig(), apiKey: RAW_API_KEY } });
        const secretsBefore = await secretCount();
        const refused = await settle(approvalService(db).approve(approval.id, userId, "first try", { decider: PG4_LOCAL_BOARD, expectedUpdatedAt: await reviewedVersion(db, approval.id) }));
        expect(refused).toMatchObject({ ok: false, status: 409, code: "hire_approval_instruction_config_stale" });
        const afterRefusal = await approvalRow(approval.id);
        expect(afterRefusal.status).toBe(status);
        expect(afterRefusal.decidedByUserId).toBeNull();
        expect(afterRefusal.decidedAt).toBeNull();
        expect((await loadAgent(pendingId))!.status).toBe("pending_approval");
        expect(await configOf(pendingId)).toEqual(before);
        expect(await secretCount()).toBe(secretsBefore);
        expect(await budgetRows(pendingId)).toHaveLength(0);
        expect(hireHook.notifyHireApproved).not.toHaveBeenCalled();

        // The approval is still correctable: request a revision (pending only), resubmit a corrected payload, approve.
        if (status === "pending") await approvalService(db).requestRevision(approval.id, userId, "pick another folder");
        // PG-4: the corrected payload keeps the agent's current (empty) instruction configuration.
        const corrected = { model: "m1" };
        await approvalService(db).resubmit(approval.id, { agentId: pendingId, adapterType: "hermes_gateway", budgetMonthlyCents: BUDGET, adapterConfig: corrected });
        const approved = await approvalService(db).approve(approval.id, userId, "second try", { decider: PG4_LOCAL_BOARD, expectedUpdatedAt: await reviewedVersion(db, approval.id) });
        expect(approved.applied).toBe(true);
        expect((await approvalRow(approval.id)).status).toBe("approved");
        expect((await loadAgent(pendingId))!.status).toBe("idle");
        expect((await configOf(pendingId)).instructionsRootPath).toBeUndefined();
        expect((await configOf(pendingId)).model).toBe("m1");
        expect(await budgetRows(pendingId)).toHaveLength(1);
        expect(hireHook.notifyHireApproved).toHaveBeenCalledTimes(1);
        expect(hireHook.notifyHireApproved).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ agentId: pendingId, sourceId: approval.id }));

        // A repeated approve is a no-op: no second activation, budget write or hook.
        const updatedAt = (await loadAgent(pendingId))!.updatedAt;
        const again = await approvalService(db).approve(approval.id, userId, "again", { decider: PG4_LOCAL_BOARD, expectedUpdatedAt: await reviewedVersion(db, approval.id) });
        expect(again.applied).toBe(false);
        expect((await loadAgent(pendingId))!.updatedAt).toEqual(updatedAt);
        expect(await budgetRows(pendingId)).toHaveLength(1);
        expect(hireHook.notifyHireApproved).toHaveBeenCalledTimes(1);
      },
    );

    it("hire without an existing agent: a root 409 rolls the decision back and creates nothing; a corrected payload then creates once", async () => {
      const name = `W1-hire-${randomUUID().slice(0, 8)}`;
      const agentsBefore = await agentCount();
      const secretsBefore = await secretCount();
      const approval = await insertApproval("pending", { name, adapterType: "hermes_gateway", budgetMonthlyCents: BUDGET,
        adapterConfig: { ...overlappingConfig(), apiKey: RAW_API_KEY } });
      const refused = await settle(approvalService(db).approve(approval.id, userId, null, { decider: PG4_LOCAL_BOARD, expectedUpdatedAt: await reviewedVersion(db, approval.id) }));
      expect(refused).toMatchObject({ ok: false, status: 409, code: INSTRUCTION_ROOT_IN_USE });
      expect((await approvalRow(approval.id)).status).toBe("pending");
      expect(await agentCount()).toBe(agentsBefore);
      // The create runs inside the approval transaction, so its secret normalization rolls back too.
      expect(await secretCount()).toBe(secretsBefore);
      expect(hireHook.notifyHireApproved).not.toHaveBeenCalled();

      await approvalService(db).requestRevision(approval.id, userId, "pick another folder");
      const corrected = independentConfig("hire-corrected");
      await approvalService(db).resubmit(approval.id, { name, adapterType: "hermes_gateway", budgetMonthlyCents: BUDGET, adapterConfig: corrected });
      const approved = await approvalService(db).approve(approval.id, userId, null, { decider: PG4_LOCAL_BOARD, expectedUpdatedAt: await reviewedVersion(db, approval.id) });
      expect(approved.applied).toBe(true);
      expect(await agentCount()).toBe(agentsBefore + 1);
      const [created] = await db.select().from(agents).where(and(eq(agents.companyId, companyId), eq(agents.name, name)));
      expect((created!.adapterConfig as Config).instructionsRootPath).toBe(corrected.instructionsRootPath);
      expect(await budgetRows(created!.id)).toHaveLength(1);
      expect(hireHook.notifyHireApproved).toHaveBeenCalledTimes(1);
      expect(hireHook.notifyHireApproved).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ agentId: created!.id }));

      const again = await approvalService(db).approve(approval.id, userId, null, { decider: PG4_LOCAL_BOARD, expectedUpdatedAt: await reviewedVersion(db, approval.id) });
      expect(again.applied).toBe(false);
      expect(await agentCount()).toBe(agentsBefore + 1);
      expect(hireHook.notifyHireApproved).toHaveBeenCalledTimes(1);
    });

    it.each([
      { branch: "existing pending agent", withAgent: true },
      { branch: "hire without an agent", withAgent: false },
    ])("concurrent approvals of one decision ($branch): exactly one applies, one activation or creation, one hook", async ({ withAgent }) => {
      const pendingId = randomUUID();
      const name = `W1-concurrent-${randomUUID().slice(0, 8)}`;
      if (withAgent) await seedAgent(pendingId, { model: "m0" }, { status: "pending_approval", adapterType: "hermes_gateway" });
      const agentsBefore = await agentCount();
      const root = independentConfig("concurrent");
      // PG-4: the linked payload keeps the pending agent's current (empty) instruction configuration.
      const approval = await insertApproval("pending", withAgent
        ? { agentId: pendingId, adapterType: "hermes_gateway", budgetMonthlyCents: BUDGET, adapterConfig: { model: "m0" } }
        : { name, adapterType: "hermes_gateway", budgetMonthlyCents: BUDGET, adapterConfig: root });
      // Hold the approval row so both decisions queue on it, then release them together.
      let release!: () => void;
      const released = new Promise<void>((resolve) => { release = resolve; });
      let held!: () => void;
      const isHeld = new Promise<void>((resolve) => { held = resolve; });
      const holder = db.transaction(async (tx) => {
        await tx.select().from(approvals).where(eq(approvals.id, approval.id)).for("update");
        held();
        await released;
      });
      await isHeld;
      let both: Promise<Outcome[]> | null = null;
      let queued = false;
      const expectedUpdatedAt = await reviewedVersion(db, approval.id);
      try {
        both = Promise.all([settle(approvalService(db).approve(approval.id, userId, null, { decider: PG4_LOCAL_BOARD, expectedUpdatedAt })), settle(approvalService(db).approve(approval.id, userId, null, { decider: PG4_LOCAL_BOARD, expectedUpdatedAt }))]);
        queued = await waitFor(async () => (await rowLockWaiters()) >= 2, 5_000);
      } finally {
        release();
        await holder;
      }
      const outcomes = await both!;
      expect(queued).toBe(true);
      for (const outcome of outcomes) expect(outcome, JSON.stringify(outcome)).toMatchObject({ ok: true });
      const applied = outcomes.map((outcome) => (outcome as { value: { applied: boolean } }).value.applied).sort();
      expect(applied).toEqual([false, true]);
      expect((await approvalRow(approval.id)).status).toBe("approved");
      expect(await agentCount()).toBe(withAgent ? agentsBefore : agentsBefore + 1);
      const agentId = withAgent ? pendingId
        : (await db.select().from(agents).where(and(eq(agents.companyId, companyId), eq(agents.name, name))))[0]!.id;
      expect((await loadAgent(agentId))!.status).toBe("idle");
      expect(await budgetRows(agentId)).toHaveLength(1);
      expect(hireHook.notifyHireApproved).toHaveBeenCalledTimes(1);
    });

    it("non-hire approvals are unchanged: approve resolves them without any agent effect", async () => {
      const agentsBefore = await agentCount();
      const [row] = await db.insert(approvals).values({ companyId, type: "approve_ceo_strategy", status: "pending", payload: { plan: "SENTINEL" } }).returning();
      const result = await approvalService(db).approve(row!.id, userId, "ok", { decider: PG4_LOCAL_BOARD, expectedUpdatedAt: await reviewedVersion(db, row!.id) });
      expect(result.applied).toBe(true);
      expect((await approvalRow(row!.id)).status).toBe("approved");
      expect(await agentCount()).toBe(agentsBefore);
      expect(hireHook.notifyHireApproved).not.toHaveBeenCalled();
    });
  });

  describe("409 detail level", () => {
    it("non-admins get the sanitized 409; server-verified instance admins get the other agent's identifiers", async () => {
      const service = agentInstructionsService(db);
      const agent = (await loadAgent())!;
      const plain = await settle(db.transaction((tx) => service.assertExclusiveRoot(tx, agent, ownerRoot, { isInstanceAdmin: false })));
      const admin = await settle(db.transaction((tx) => service.assertExclusiveRoot(tx, agent, ownerRoot, { isInstanceAdmin: true })));
      expect(plain).toMatchObject({ ok: false, status: 409, details: { code: INSTRUCTION_ROOT_IN_USE } });
      expect(Object.keys(plain.ok ? {} : plain.details)).toEqual(["code"]);
      expect(JSON.stringify(plain)).not.toContain(ownerId);
      expect(JSON.stringify(plain)).not.toContain(ownerRoot);
      expect(admin).toMatchObject({ ok: false, status: 409, details: { code: INSTRUCTION_ROOT_IN_USE, conflictingAgentId: ownerId, against: "root", relation: "equal" } });
      const res = await request(app()).patch(`/api/agents/${agentId}`).send({ adapterConfig: cfg("external", ownerRoot) });
      expect(res.body?.details?.conflictingAgentId).toBe(ownerId);
    });

    it("a non-admin operator's hire with an external root stops at the existing 403, before the check, and learns nothing", async () => {
      await db.insert(principalPermissionGrants).values({ companyId, principalType: "user", principalId: userId, permissionKey: "agents:create", scope: null });
      const res = await request(app(actorOperator)).post(`/api/companies/${companyId}/agent-hires`).send({
        name: "Operator hire", role: "general", adapterType: "hermes_gateway", adapterConfig: { ...cfg("external", ownerRoot), apiKey: RAW_API_KEY } });
      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(JSON.stringify(res.body)).not.toContain(ownerId);
      expect(JSON.stringify(res.body)).not.toContain(INSTRUCTION_ROOT_IN_USE);
      expect(await secretCount()).toBe(0);
    });
  });

  describe("comparison key on disk", () => {
    it("canonicalizes symbolic links on the existing part and keeps missing parts, folded", async () => {
      const real = fresh("real");
      await fs.mkdir(real, { recursive: true });
      const link = `${real}-link`;
      await fs.symlink(real, link);
      expect(await instructionRootComparisonKey(path.join(link, "Missing", "Café"))).toEqual(
        await instructionRootComparisonKey(path.join(real, "missing", "café")));
    });
  });
});
