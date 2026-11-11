// WS-2 PR-W1: exclusive instruction roots. Real services on embedded
// PostgreSQL, mkdtemp roots and synthetic sentinel content only.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  agents, authUsers, companies, companyMemberships, companySecrets, createDb, principalPermissionGrants, type Db,
} from "@paperclipai/db";
import {
  agentInstructionsBundleMode, agentInstructionsService, resolveInstructionWriteTarget, resolveManagedInstructionsRoot,
  type InstructionConfigPersist, type UpdateBundleOptions,
} from "../services/agent-instructions.js";
import {
  INSTRUCTION_ROOT_ASSIGNMENT_LOCK, INSTRUCTION_ROOT_IN_USE, INSTRUCTION_ROOT_UNVERIFIABLE,
  compareInstructionRootKeys, foldInstructionRootPath, instructionRootComparisonKey, resolveManagedAgentArea,
} from "../services/instruction-root-exclusivity.js";
import { agentService } from "../services/agents.js";
import { secretService } from "../services/secrets.js";
import { agentRoutes } from "../routes/agents.js";
import { errorHandler } from "../middleware/index.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

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
  const advisoryWaiters = async () => {
    const rows = await db.execute(sql`select count(*)::int as n from pg_locks where locktype = 'advisory' and not granted`);
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

    it("generic PATCH activates an independent root and stores the secret as before", async () => {
      const ext = fresh("ok-patch");
      await seed(ext, { "AGENTS.md": ENTRY });
      const res = await request(app()).patch(`/api/agents/${agentId}`).send({ adapterConfig: { ...cfg("external", ext), apiKey: RAW_API_KEY } });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(await configOf()).toMatchObject({ ...cfg("external", ext), apiKey: { type: "secret_ref" } });
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
      for (const url of ["agents", "agent-hires"]) {
        const res = await request(app()).post(`/api/companies/${companyId}/${url}`).send({
          name: `Routed-${url}`, role: "general", adapterType: "hermes_gateway", adapterConfig: { ...cfg("external", fresh(url)), apiKey: RAW_API_KEY } });
        expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
      }
      expect(await secretCount()).toBe(2);
    });

    it("hire approval activates as before, including its approved independent root", async () => {
      const pending = randomUUID();
      await seedAgent(pending, { model: "m0" }, { status: "pending_approval", adapterType: "hermes_gateway" });
      const ext = fresh("ok-approve");
      await seed(ext, { "AGENTS.md": ENTRY });
      const result = await agentService(db).activatePendingApproval(pending, { name: "Approved", adapterType: "hermes_gateway", adapterConfig: { ...cfg("external", ext), apiKey: RAW_API_KEY } });
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
    it("a root claimed between the two checks is refused under the lock, after the secret was stored (PG-3 window)", async () => {
      const window = fresh("pg3");
      const claimant = randomUUID();
      await seedAgent(claimant, { model: "m0" });
      const createId = randomUUID();
      let create: Promise<Outcome> | null = null;
      let createWaited = false;
      await db.transaction(async (tx) => {
        // An uncommitted claim that holds the assignment lock: the create's
        // unlocked pre-check cannot see it, its locked check waits for it.
        await agentService(tx as unknown as Db).update(claimant, { adapterConfig: cfg("external", window) }, { instructionConfigWrite: { keys: "all" } });
        create = settle(agentService(db).create(companyId, { id: createId, name: "PG3", adapterType: "hermes_gateway",
          adapterConfig: { ...cfg("external", window), apiKey: RAW_API_KEY } }));
        createWaited = await waitFor(async () => (await advisoryWaiters()) > 0, 5_000);
      });
      const outcome = await create!;
      expect(createWaited).toBe(true);
      expect(outcome).toMatchObject({ ok: false, status: 409, code: INSTRUCTION_ROOT_IN_USE });
      expect(await loadAgent(createId)).toBeUndefined();
      // The tracked PG-3 residual: the global normalization already stored the secret.
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
    const rowLockWaiters = async () => {
      const rows = await db.execute(sql`select count(*)::int as n from pg_stat_activity
        where datname = current_database() and wait_event_type = 'Lock' and wait_event in ('tuple', 'transactionid')`);
      return Number((rows as unknown as Array<{ n: number }>)[0]?.n ?? 0);
    };
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
      // Pauses the create at its insert: after its locked check, before the reports_to key lock.
      await db.execute(sql.raw(`create or replace function w1_test_insert_gate() returns trigger language plpgsql as $$
        begin
          if NEW.name like 'w1-gate-%' then perform pg_advisory_xact_lock_shared(hashtextextended('${GATE}', 0)); end if;
          return NEW;
        end $$`));
      await db.execute(sql.raw("drop trigger if exists w1_test_insert_gate on agents"));
      await db.execute(sql.raw("create trigger w1_test_insert_gate before insert on agents for each row execute function w1_test_insert_gate()"));
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
      let createAtInsert = false, parentWaitedOnRow = false, advisoryWhileParentWaits = -1;
      try {
        create = settle(agentService(db).create(companyId, { name: childName, adapterType: "hermes_gateway", reportsTo: parentId,
          adapterConfig: cfg("external", childRoot) }));
        // The create has passed its locked check and waits at the insert gate.
        createAtInsert = await waitFor(async () => (await advisoryWaiters()) === 1, 5_000);
        parentChange = settle(agentService(db).update(parentId, { adapterConfig: cfg("external", parentNext) }, { instructionConfigWrite: { keys: "all" } }));
        // The parent must wait on its row (the create's KEY SHARE), never on the assignment lock.
        parentWaitedOnRow = await waitFor(async () => (await rowLockWaiters()) >= 1, 5_000);
        advisoryWhileParentWaits = await advisoryWaiters();
      } finally {
        gate.release();
        await gate.done;
      }
      const [createOutcome, parentOutcome] = [await create!, await parentChange!];
      expect(createAtInsert).toBe(true);
      expect(parentWaitedOnRow).toBe(true);
      expect(advisoryWhileParentWaits).toBe(1);
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
      let parentAtLock = false, createWaitedOnRow = false, advisoryWhileCreateWaits = -1;
      try {
        parentChange = settle(agentService(db).update(parentId, { adapterConfig: cfg("external", parentNext) }, { instructionConfigWrite: { keys: "all" } }));
        // The parent holds its row FOR UPDATE and waits for the assignment lock.
        parentAtLock = await waitFor(async () => (await advisoryWaiters()) === 1, 5_000);
        create = settle(agentService(db).create(companyId, { id: childId, name: `W1-child-${childId.slice(0, 8)}`, adapterType: "hermes_gateway",
          reportsTo: parentId, adapterConfig: cfg("external", childRoot) }));
        // The create must wait on the parent row, before it asks for the assignment lock.
        createWaitedOnRow = await waitFor(async () => (await rowLockWaiters()) >= 1, 5_000);
        advisoryWhileCreateWaits = await advisoryWaiters();
      } finally {
        assignment.release();
        await assignment.done;
      }
      const [parentOutcome, createOutcome] = [await parentChange!, await create!];
      expect(parentAtLock).toBe(true);
      expect(createWaitedOnRow).toBe(true);
      expect(advisoryWhileCreateWaits).toBe(1);
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
