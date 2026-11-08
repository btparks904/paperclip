// WS-2 PR-A: the instruction-root guard and the destination lock. Real
// services on embedded PostgreSQL, mkdtemp roots and synthetic sentinel
// content only. An "unfinished copy record" is written the way a copy that
// crashed after its first file leaves it.
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
import { agentInstructionRevisionService } from "../services/agent-instruction-revisions.js";
import {
  agentInstructionsBundleMode, agentInstructionsService, instructionCopyIntentsDirectory, resolveInstructionWriteTarget,
  resolveManagedInstructionsRoot, type InstructionConfigPersist, type UpdateBundleOptions,
} from "../services/agent-instructions.js";
import { instructionPathKey } from "../services/agent-instruction-files.js";
import {
  assertInstructionDestinationKey, deriveInstructionDestinationKey, lockInstructionDestination,
} from "../services/instruction-root-guard.js";
import { agentService } from "../services/agents.js";
import { secretService } from "../services/secrets.js";
import { agentRoutes } from "../routes/agents.js";
import { errorHandler } from "../middleware/index.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const ENTRY = "SENTINEL-WS2-ENTRY\n";
const NOTE = "notes/plan.md";
const PARTIAL = "SENTINEL-WS2-PARTIAL\n";
const RAW_API_KEY = "SENTINEL-SYNTHETIC-RAW-API-KEY-WS2";
const COPY_INCOMPLETE = "INSTRUCTION_BUNDLE_COPY_INCOMPLETE";
const errno = (code: string) => Object.assign(new Error(`${code}: simulated`), { code });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
type Config = Record<string, unknown>;
type Outcome = { ok: true; value: unknown } | { ok: false; status?: number; code?: string; message: string; details: Record<string, unknown> };
const settle = (promise: Promise<unknown>): Promise<Outcome> => promise.then(
  (value) => ({ ok: true as const, value }),
  (error: any) => ({ ok: false as const, status: error?.status, code: error?.details?.code ?? error?.code, message: String(error?.message), details: error?.details ?? {} }));

// Optional: a case-insensitive volume with stable inode numbers (for example
// `ciopfs -o use_ino,allow_other`). Unset on Linux CI.
const caseInsensitiveDir = process.env.PAPERCLIP_TEST_CASE_INSENSITIVE_DIR;

describe("WS-2 instruction-root guard", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let granted: string[] = [];
  let home: string, companyId: string, agentId: string, userId: string, managedRoot: string;
  const board = (isInstanceAdmin = true) => ({ type: "board" as const, userId, source: "session" as const, isInstanceAdmin });
  const cfg = (mode: "managed" | "external", root: string, entry = "AGENTS.md") => ({
    instructionsBundleMode: mode, instructionsRootPath: root, instructionsEntryFile: entry, instructionsFilePath: path.join(root, entry) });
  const loadAgent = async (id = agentId) => (await db.select().from(agents).where(eq(agents.id, id)))[0];
  const configOf = async (id = agentId) => (await loadAgent(id))!.adapterConfig as Config;
  const secretCount = async () => (await db.select({ id: companySecrets.id }).from(companySecrets).where(eq(companySecrets.companyId, companyId))).length;
  const ls = async (root: string) => {
    const out: string[] = [];
    async function walk(dir: string) {
      for (const entry of await fs.readdir(path.join(root, dir), { withFileTypes: true }).catch(() => [])) {
        const rel = dir ? `${dir}/${entry.name}` : entry.name;
        if (entry.isDirectory()) await walk(rel); else out.push(rel);
      }
    }
    await walk("");
    return out.sort();
  };
  const exists = (target: string) => fs.lstat(target).then(() => true, () => false);
  const intents = async () => (await fs.readdir(instructionCopyIntentsDirectory()).catch(() => [] as string[])).sort();
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
  /** What a copy that crashed after its first file leaves: part of the bundle and its record. */
  async function lingeringRecord(owner: string, root: string, partial: Record<string, string> = { [NOTE]: PARTIAL }) {
    await seed(root, partial);
    const canonicalPath = await fs.realpath(root);
    const stat = await fs.lstat(canonicalPath, { bigint: true });
    const operationId = randomUUID();
    await fs.mkdir(instructionCopyIntentsDirectory(), { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(instructionCopyIntentsDirectory(), `${operationId}.json`), JSON.stringify({
      version: 1, operationId, companyId, agentId: owner,
      destination: { ino: stat.ino.toString(), dev: stat.dev.toString(), birthtimeNs: (stat.birthtimeNs ?? 0n).toString(), canonicalPath, pathKey: instructionPathKey(canonicalPath) },
      sourceRoot: null, plannedCount: 2, plannedBytes: 40, startedAt: new Date().toISOString(),
    }));
    return operationId;
  }
  const actorAdmin = () => ({ type: "board", userId, companyIds: [companyId], source: "local_implicit", isInstanceAdmin: true });
  const app = (actor: () => Record<string, unknown> = actorAdmin) => {
    const server = express();
    server.use(express.json());
    server.use((req, _res, next) => { (req as any).actor = actor(); next(); });
    server.use("/api", agentRoutes(db as any));
    server.use(errorHandler);
    return server;
  };
  /** Sessions currently waiting on an advisory lock. */
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
  /** Can another session take the destination lock right now? */
  async function lockIsFree(key: string) {
    return db.transaction(async (tx) => {
      const rows = await tx.execute(sql`select pg_try_advisory_xact_lock(hashtextextended(${key}, 0)) as ok`);
      return Boolean((rows as unknown as Array<{ ok: boolean }>)[0]?.ok);
    });
  }

  beforeAll(async () => {
    home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "ws2-root-guard-")));
    process.env.PAPERCLIP_HOME = home;
    database = await startEmbeddedPostgresTestDatabase("ws2-root-guard-db-");
    db = createDb(database.connectionString);
  }, 90_000);
  afterAll(async () => { await database?.cleanup(); await fs.rm(home, { recursive: true, force: true }); });
  afterEach(() => { vi.restoreAllMocks(); });
  beforeEach(async () => {
    await fs.rm(instructionCopyIntentsDirectory(), { recursive: true, force: true });
    granted = []; companyId = randomUUID(); agentId = randomUUID(); userId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "WS2", issuePrefix: randomUUID().slice(0, 8) });
    await db.insert(authUsers).values({ id: userId, name: "Editor", email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companyMemberships).values([{ companyId, principalType: "user", principalId: userId, membershipRole: "operator" }]);
    managedRoot = resolveManagedInstructionsRoot({ companyId, id: agentId, name: "T", adapterConfig: {} });
    await seedAgent(agentId, { ...cfg("managed", managedRoot), model: "m0" }, { adapterType: "hermes_gateway" });
    await seed(managedRoot, { "AGENTS.md": ENTRY, [NOTE]: "SENTINEL-NOTE\n" });
  });

  describe("R-W1: every guarded writer refuses an unfinished-copy root and changes nothing", () => {
    it("A3 generic PATCH: 409 before secret normalization; no root, no secret, record kept", async () => {
      const ext = path.join(home, "ext-a3", agentId);
      await lingeringRecord(agentId, ext);
      const before = await configOf();
      const res = await request(app()).patch(`/api/agents/${agentId}`).send({ adapterConfig: { ...cfg("external", ext), apiKey: RAW_API_KEY } });
      expect(res.status, JSON.stringify(res.body)).toBe(409);
      expect(JSON.stringify(res.body)).toContain(COPY_INCOMPLETE);
      expect(await configOf()).toEqual(before);
      expect(await secretCount()).toBe(0);
      expect(await ls(ext)).toEqual([NOTE]);
      expect(await intents()).toHaveLength(1);
    });

    it("A3 updateAgent (any caller): a root change into an unfinished copy refuses", async () => {
      const ext = path.join(home, "ext-a3s", agentId);
      await lingeringRecord(randomUUID(), ext);
      const before = await configOf();
      const outcome = await settle(agentService(db).update(agentId, { adapterConfig: { ...before, ...cfg("external", ext), apiKey: RAW_API_KEY } },
        { instructionConfigWrite: { keys: "all" } }));
      expect(outcome).toMatchObject({ ok: false, status: 409, code: COPY_INCOMPLETE });
      expect(await configOf()).toEqual(before);
      expect(await secretCount()).toBe(0);
    });

    it("A2 instructions-path PATCH: 409 and nothing changes", async () => {
      const ext = path.join(home, "ext-a2", agentId);
      await lingeringRecord(randomUUID(), ext);
      const before = await configOf();
      const res = await request(app()).patch(`/api/agents/${agentId}/instructions-path`).send({ path: path.join(ext, "AGENTS.md"), adapterConfigKey: "instructionsFilePath" });
      expect(res.status, JSON.stringify(res.body)).toBe(409);
      expect(await configOf()).toEqual(before);
    });

    it("A4 create with an explicit root: refused by the pre-check before normalization; no agent, no secret", async () => {
      const ext = path.join(home, "ext-a4", agentId);
      await lingeringRecord(randomUUID(), ext);
      const id = randomUUID();
      const outcome = await settle(agentService(db).create(companyId, { id, name: "Created", adapterType: "hermes_gateway",
        adapterConfig: { ...cfg("external", ext), apiKey: RAW_API_KEY } }));
      expect(outcome).toMatchObject({ ok: false, status: 409, code: COPY_INCOMPLETE });
      expect(await loadAgent(id)).toBeUndefined();
      expect(await secretCount()).toBe(0);
    });

    it("A5 new-agent default bundle: refuses before any stock file is written", async () => {
      const fresh = randomUUID();
      await seedAgent(fresh, {});
      const root = resolveManagedInstructionsRoot({ companyId, id: fresh, name: "F", adapterConfig: {} });
      await lingeringRecord(fresh, root, { "stray/partial.md": PARTIAL });
      const outcome = await settle(agentInstructionsService(db).materializeManagedBundle((await loadAgent(fresh))!, { "AGENTS.md": "SENTINEL-STOCK\n" },
        { entryFile: "AGENTS.md", replaceExisting: false }));
      expect(outcome).toMatchObject({ ok: false, status: 409, code: COPY_INCOMPLETE });
      expect(await ls(root)).toEqual(["stray/partial.md"]);
      expect(await configOf(fresh)).toEqual({});
    });

    it("A6 replacing materialization (reset, import): refuses before the folder is removed", async () => {
      const fresh = randomUUID();
      await seedAgent(fresh, {});
      const root = resolveManagedInstructionsRoot({ companyId, id: fresh, name: "F", adapterConfig: {} });
      await lingeringRecord(fresh, root, { "stray/partial.md": PARTIAL });
      const outcome = await settle(agentInstructionsService(db).materializeManagedBundle((await loadAgent(fresh))!, { "AGENTS.md": "SENTINEL-STOCK\n" },
        { entryFile: "AGENTS.md", replaceExisting: true }));
      expect(outcome).toMatchObject({ ok: false, status: 409, code: COPY_INCOMPLETE });
      expect(await ls(root)).toEqual(["stray/partial.md"]);
    });

    it("A7 legacy revision commit and read: refuse to adopt or bind a managed root with an unfinished copy", async () => {
      const legacy = randomUUID();
      await seedAgent(legacy, {});
      const root = resolveManagedInstructionsRoot({ companyId, id: legacy, name: "L", adapterConfig: {} });
      await lingeringRecord(legacy, root, { "AGENTS.md": PARTIAL });
      const revisions = agentInstructionRevisionService(db);
      const commit = await settle(revisions.commit({ companyId, agentId: legacy, entryFile: "AGENTS.md", content: "SENTINEL-COMMIT\n", baseRevisionId: null, source: "board" }, board()));
      const read = await settle(revisions.readCurrent({ companyId, agentId: legacy }, board()));
      expect(commit).toMatchObject({ ok: false, status: 409, code: COPY_INCOMPLETE });
      expect(read).toMatchObject({ ok: false, status: 409, code: COPY_INCOMPLETE });
      expect(await configOf(legacy)).toEqual({});
      expect(await fs.readFile(path.join(root, "AGENTS.md"), "utf8")).toBe(PARTIAL);
    });

    it("A8 unversioned save for an agent without a root: refuses before the managed root is bound or written", async () => {
      const legacy = randomUUID();
      await seedAgent(legacy, { promptTemplate: "SENTINEL-LEGACY-PROMPT\n" });
      const root = resolveManagedInstructionsRoot({ companyId, id: legacy, name: "L", adapterConfig: {} });
      await lingeringRecord(legacy, root, { "stray/partial.md": PARTIAL });
      const outcome = await settle(agentInstructionsService(db).writeFile((await loadAgent(legacy))!, "notes/new.md", "SENTINEL-NEW\n"));
      expect(outcome).toMatchObject({ ok: false, status: 409, code: COPY_INCOMPLETE });
      expect(await ls(root)).toEqual(["stray/partial.md"]);
    });

    it("A13 hire approval: an approved root with an unfinished copy refuses; still pending, no secret", async () => {
      const pending = randomUUID();
      await seedAgent(pending, { model: "m0" }, { status: "pending_approval", adapterType: "hermes_gateway" });
      const ext = path.join(home, "ext-a13", pending);
      await lingeringRecord(randomUUID(), ext);
      const outcome = await settle(agentService(db).activatePendingApproval(pending, {
        name: "Approved", adapterType: "hermes_gateway", adapterConfig: { ...cfg("external", ext), apiKey: RAW_API_KEY } }));
      expect(outcome).toMatchObject({ ok: false, status: 409, code: COPY_INCOMPLETE });
      expect((await loadAgent(pending))!.status).toBe("pending_approval");
      expect(await configOf(pending)).toEqual({ model: "m0" });
      expect(await secretCount()).toBe(0);
    });
  });

  describe("D-1: create and hire routes check the root before their own secret normalization", () => {
    const body = (root: string) => ({ name: "Routed", role: "general", adapterType: "hermes_gateway", adapterConfig: { ...cfg("external", root), apiKey: RAW_API_KEY } });
    for (const [label, url] of [["create", "agents"], ["hire", "agent-hires"]] as const) {
      it(`${label}: an unfinished-copy root is refused with 409 before any secret row exists`, async () => {
        const ext = path.join(home, `ext-d1-${label}`, agentId);
        await lingeringRecord(randomUUID(), ext);
        const agentsBefore = (await db.select({ id: agents.id }).from(agents).where(eq(agents.companyId, companyId))).length;
        const res = await request(app()).post(`/api/companies/${companyId}/${url}`).send(body(ext));
        expect(res.status, JSON.stringify(res.body)).toBe(409);
        expect(JSON.stringify(res.body)).toContain(COPY_INCOMPLETE);
        expect(await secretCount()).toBe(0);
        expect((await db.select({ id: agents.id }).from(agents).where(eq(agents.companyId, companyId))).length).toBe(agentsBefore);
      });
      it(`${label}: a clean explicit root still succeeds and stores its secret`, async () => {
        const ext = path.join(home, `ext-d1-ok-${label}`, agentId);
        await seed(ext, { "AGENTS.md": ENTRY });
        const res = await request(app()).post(`/api/companies/${companyId}/${url}`).send(body(ext));
        expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
        expect(await secretCount()).toBe(1);
      });
    }
  });

  describe("A13: the approval activation locks the agent row", () => {
    it("an activation that runs during a concurrent instruction change is decided on the locked row", async () => {
      // The pending agent's root is R, which holds an unfinished copy record,
      // and the approved payload names R. A concurrent writer moves the agent
      // to S. With the row lock, the activation waits, reads S and checks R
      // (409). Without it, it reads R, sees no root change and activates R.
      const pending = randomUUID();
      const rootR = path.join(home, "a13-r", pending);
      const rootS = path.join(home, "a13-s", pending);
      await seed(rootS, { "AGENTS.md": ENTRY });
      await seedAgent(pending, { ...cfg("external", rootR), model: "m0" }, { status: "pending_approval", adapterType: "hermes_gateway" });
      await lingeringRecord(randomUUID(), rootR);
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
      expect(outcome).toMatchObject({ ok: false, status: 409, code: COPY_INCOMPLETE });
      expect((await loadAgent(pending))!.status).toBe("pending_approval");
      expect((await configOf(pending)).instructionsRootPath).toBe(rootS);
    });
  });

  describe("R-W2: clean roots keep their successful behavior", () => {
    it("A3 generic PATCH activates a clean root and stores the secret as before", async () => {
      const ext = path.join(home, "ext-ok-a3", agentId);
      await seed(ext, { "AGENTS.md": ENTRY });
      const res = await request(app()).patch(`/api/agents/${agentId}`).send({ adapterConfig: { ...cfg("external", ext), apiKey: RAW_API_KEY } });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(await configOf()).toMatchObject({ ...cfg("external", ext), apiKey: { type: "secret_ref" } });
      expect(await secretCount()).toBe(1);
    });

    it("A4 create with a clean explicit root succeeds", async () => {
      const ext = path.join(home, "ext-ok-a4", agentId);
      await seed(ext, { "AGENTS.md": ENTRY });
      const id = randomUUID();
      const created = await agentService(db).create(companyId, { id, name: "Created", adapterType: "hermes_gateway", adapterConfig: { ...cfg("external", ext), apiKey: RAW_API_KEY } });
      expect(created.adapterConfig).toMatchObject(cfg("external", ext));
      expect(await secretCount()).toBe(1);
    });

    it("A5 default bundle, A7 legacy commit and A8 unversioned save on clean managed roots succeed", async () => {
      const a5 = randomUUID(), a7 = randomUUID(), a8 = randomUUID();
      for (const id of [a5, a7]) await seedAgent(id, {});
      await seedAgent(a8, { promptTemplate: "SENTINEL-LEGACY-PROMPT\n" });
      const materialized = await agentInstructionsService(db).materializeManagedBundle((await loadAgent(a5))!, { "AGENTS.md": "SENTINEL-STOCK\n" },
        { entryFile: "AGENTS.md", replaceExisting: false });
      expect(materialized.adapterConfig).toMatchObject({ instructionsBundleMode: "managed" });
      const receipt = await agentInstructionRevisionService(db).commit({ companyId, agentId: a7, entryFile: "AGENTS.md", content: "SENTINEL-COMMIT\n", baseRevisionId: null, source: "board" }, board());
      expect(receipt.revision.entryFile).toBe("AGENTS.md");
      expect(await configOf(a7)).toMatchObject({ instructionsBundleMode: "managed" });
      const saved = await agentInstructionsService(db).writeFile((await loadAgent(a8))!, "notes/new.md", "SENTINEL-NEW\n");
      expect(saved.adapterConfig).toMatchObject({ instructionsBundleMode: "managed" });
    });

    it("A13 hire approval activates as before, including its approved root", async () => {
      const pending = randomUUID();
      await seedAgent(pending, { model: "m0" }, { status: "pending_approval", adapterType: "hermes_gateway" });
      const ext = path.join(home, "ext-ok-a13", pending);
      await seed(ext, { "AGENTS.md": ENTRY });
      const result = await agentService(db).activatePendingApproval(pending, { name: "Approved", adapterType: "hermes_gateway", adapterConfig: { ...cfg("external", ext), apiKey: RAW_API_KEY } });
      expect(result).toMatchObject({ activated: true });
      expect((await loadAgent(pending))!.status).toBe("idle");
      expect(await configOf(pending)).toMatchObject(cfg("external", ext));
    });

    it("A1 bundle PATCH copy into a new folder still succeeds and clears its record", async () => {
      const ext = path.join(home, "ext-ok-a1", agentId);
      const agent = (await loadAgent())!;
      await agentInstructionsService(db).updateBundle(agent, { mode: "external", rootPath: ext }, await optionsFor(agent));
      expect(await ls(ext)).toEqual(["AGENTS.md", NOTE]);
      expect(await configOf()).toMatchObject(cfg("external", ext));
      expect(await intents()).toEqual([]);
    });
  });

  describe("R-W3: N-4, another agent cannot activate a folder mid-copy", () => {
    const other = () => granted[1]!;
    beforeEach(async () => {
      await seedAgent(randomUUID(), cfg("managed", path.join(home, "other-managed")));
    });
    /** Runs A's copy into shared; at A's first destination write, B's instructions-path PATCH for activate is started. */
    async function copyWhileOtherActivates(shared: string, activatePath: string, failSecondWrite: boolean) {
      let started: Promise<request.Response> | null = null;
      let pendingDuringCopy = false;
      let count = 0;
      const realOpen = fs.open.bind(fs);
      vi.spyOn(fs, "open").mockImplementation((async (file: any, flags?: any, mode?: any) => {
        if (flags === "wx" && String(file).startsWith(`${shared}${path.sep}`)) {
          count += 1;
          if (count === 1) {
            let done = false;
            started = Promise.resolve(request(app()).patch(`/api/agents/${other()}/instructions-path`)
              .send({ path: path.join(activatePath, "AGENTS.md"), adapterConfigKey: "instructionsFilePath" })).then((res) => { done = true; return res; });
            pendingDuringCopy = await waitFor(async () => (await advisoryWaiters()) > 0) && !done;
          }
          if (count === 2 && failSecondWrite) throw errno("EIO");
        }
        return realOpen(file, flags, mode);
      }) as typeof fs.open);
      const agent = (await loadAgent())!;
      const copy = await settle(agentInstructionsService(db).updateBundle(agent, { mode: "external", rootPath: shared }, await optionsFor(agent)));
      vi.restoreAllMocks();
      const activation = await started!;
      return { copy, activation, pendingDuringCopy };
    }

    it("a failed copy: B waited on the destination lock, then got 409; B never points at the partial folder", async () => {
      const shared = path.join(home, "shared-n4");
      const { copy, activation, pendingDuringCopy } = await copyWhileOtherActivates(shared, shared, true);
      expect(copy.ok).toBe(false);
      expect(pendingDuringCopy).toBe(true);
      expect(activation.status, JSON.stringify(activation.body)).toBe(409);
      expect(JSON.stringify(activation.body)).toContain(COPY_INCOMPLETE);
      expect((await configOf(other())).instructionsRootPath).not.toBe(shared);
    });

    it("a finished copy: B waited and activated only after A committed (a shared root, closed by PR-B)", async () => {
      const shared = path.join(home, "shared-n4-ok");
      const { copy, activation, pendingDuringCopy } = await copyWhileOtherActivates(shared, shared, false);
      expect(copy.ok).toBe(true);
      expect(pendingDuringCopy).toBe(true);
      expect(activation.status, JSON.stringify(activation.body)).toBe(200);
      expect(await ls(shared)).toEqual(["AGENTS.md", NOTE]);
    });

    it("aliases: a symbolic link to the folder and an NFD spelling of a missing name wait on the same lock", async () => {
      const shared = path.join(home, "shared-n4-link");
      await fs.mkdir(path.join(home, "links"), { recursive: true });
      const link = path.join(home, "links", "to-shared");
      await fs.mkdir(shared, { recursive: true });
      await fs.symlink(shared, link);
      const viaLink = await copyWhileOtherActivates(shared, link, true);
      expect(viaLink.pendingDuringCopy).toBe(true);
      expect(viaLink.activation.status, JSON.stringify(viaLink.activation.body)).toBe(409);

      const nfc = path.join(home, "café-n4");
      const nfd = path.join(home, "café-n4");
      const viaNfd = await copyWhileOtherActivates(nfc, nfd, true);
      expect(viaNfd.pendingDuringCopy).toBe(true);
      expect(viaNfd.activation.status, JSON.stringify(viaNfd.activation.body)).toBe(409);
    });

    it.skipIf(!caseInsensitiveDir)("case-insensitive volume: a case variant waits on the same lock and refuses", async () => {
      const base = await fs.mkdtemp(path.join(caseInsensitiveDir!, "n4-"));
      const shared = path.join(base, "Shared");
      const viaCase = await copyWhileOtherActivates(shared, path.join(base, "SHARED"), true);
      expect(viaCase.pendingDuringCopy).toBe(true);
      expect(viaCase.activation.status, JSON.stringify(viaCase.activation.body)).toBe(409);
    });
  });

  describe("R-W4: lock order", () => {
    it("concurrent writers of one destination finish without a deadlock or a self-block", async () => {
      const others = [randomUUID(), randomUUID(), randomUUID()];
      for (const id of others) await seedAgent(id, { model: "m0" }, { adapterType: "hermes_gateway" });
      const errors: string[] = [];
      for (let round = 0; round < 15; round += 1) {
        const shared = path.join(home, "stress", String(round));
        const agent = (await loadAgent())!;
        const results = await Promise.all([
          settle(agentInstructionsService(db).updateBundle(agent, { mode: "external", rootPath: shared }, await optionsFor(agent))),
          settle(request(app()).patch(`/api/agents/${others[0]}/instructions-path`).send({ path: path.join(shared, "AGENTS.md"), adapterConfigKey: "instructionsFilePath" })
            .then((res) => { if (res.status >= 500) throw new Error(`instructions-path ${res.status} ${JSON.stringify(res.body)}`); return res; })),
          settle(request(app()).patch(`/api/agents/${others[1]}`).send({ adapterConfig: { ...cfg("external", shared), apiKey: RAW_API_KEY } })
            .then((res) => { if (res.status >= 500) throw new Error(`patch ${res.status} ${JSON.stringify(res.body)}`); return res; })),
          settle(agentService(db).create(companyId, { name: `S-${round}`, adapterType: "hermes_gateway", adapterConfig: cfg("external", shared) })),
          settle(agentInstructionRevisionService(db).commit({ companyId, agentId: others[2]!, entryFile: "AGENTS.md", content: `SENTINEL-${round}\n`, baseRevisionId: null, source: "board" }, board())
            .then(() => agentService(db).update(others[2]!, { adapterConfig: cfg("external", shared) }, { instructionConfigWrite: { keys: "all" } }))),
        ]);
        for (const result of results) {
          if (result.ok) continue;
          if (/deadlock|40P01|lock order/i.test(result.message) || (result.status ?? 500) >= 500) errors.push(result.message);
        }
        // Reset agent A to managed for the next round.
        await db.update(agents).set({ adapterConfig: { ...cfg("managed", managedRoot), model: "m0" } }).where(eq(agents.id, agentId));
        await db.update(agents).set({ adapterConfig: {} }).where(eq(agents.id, others[2]!));
      }
      expect(errors).toEqual([]);
    }, 120_000);

    it("a second, different destination lock in one transaction is refused", async () => {
      const first = path.join(home, "order-1"), second = path.join(home, "order-2");
      const outcome = await settle(db.transaction(async (tx) => {
        await lockInstructionDestination(tx, first, { agentId, createParent: true });
        await lockInstructionDestination(tx, first, { agentId, createParent: true });
        await lockInstructionDestination(tx, second, { agentId, createParent: true });
      }));
      expect(outcome).toMatchObject({ ok: false });
      expect((outcome as { message: string }).message).toContain("lock order");
    });

    it("an agent row lock of another agent after a destination lock is refused", async () => {
      const other = randomUUID();
      await seedAgent(other, { model: "m0" });
      const outcome = await settle(db.transaction(async (tx) => {
        await lockInstructionDestination(tx, path.join(home, "order-row"), { agentId, createParent: true });
        await agentService(tx as unknown as Db).update(other, { name: "Renamed" });
      }));
      expect(outcome).toMatchObject({ ok: false });
      expect((outcome as { message: string }).message).toContain("lock order");
      expect((await loadAgent(other))!.name).not.toBe("Renamed");
    });
  });

  describe("R-W4b: nested transactions and savepoint rollback", () => {
    it("a savepoint that took the lock and rolled back releases it; a released savepoint keeps it", async () => {
      const root = path.join(home, "savepoint");
      const { key } = await deriveInstructionDestinationKey(root);
      const observed: Record<string, boolean> = {};
      await db.transaction(async (tx) => {
        await settle(tx.transaction(async (savepoint) => {
          await lockInstructionDestination(savepoint, root, { agentId, createParent: true });
          observed.heldInsideSavepoint = !(await lockIsFree(key));
          throw new Error("roll back the savepoint");
        }));
        observed.freeAfterRollback = await lockIsFree(key);
        // The rolled-back savepoint also cleared the held-lock marker: another key is allowed now.
        await lockInstructionDestination(tx, path.join(home, "savepoint-other"), { agentId, createParent: true });
        await tx.transaction(async (savepoint) => {
          await lockInstructionDestination(savepoint, path.join(home, "savepoint-other"), { agentId, createParent: true });
        });
        observed.heldAfterRelease = !(await lockIsFree((await deriveInstructionDestinationKey(path.join(home, "savepoint-other"))).key));
      });
      observed.freeAfterCommit = await lockIsFree((await deriveInstructionDestinationKey(path.join(home, "savepoint-other"))).key);
      expect(observed).toEqual({ heldInsideSavepoint: true, freeAfterRollback: true, heldAfterRelease: true, freeAfterCommit: true });
    });

    it("updateAgent nested in updateBundle's transaction re-enters the same lock (persist inside the copy)", async () => {
      const ext = path.join(home, "nested", agentId);
      const agent = (await loadAgent())!;
      let heldDuringPersist = false;
      const result = await settle(agentInstructionsService(db).updateBundle(agent, { mode: "external", rootPath: ext }, await optionsFor(agent, {
        persist: async (tx, current, adapterConfig) => {
          heldDuringPersist = !(await lockIsFree((await deriveInstructionDestinationKey(ext)).key));
          await persistOn()(tx, current, adapterConfig);
        },
      })));
      expect(result.ok).toBe(true);
      expect(heldDuringPersist).toBe(true);
      expect(await lockIsFree((await deriveInstructionDestinationKey(ext)).key)).toBe(true);
    });
  });

  describe("R-W5: the 409 detail level", () => {
    it("non-admins get the sanitized 409; instance admins get recovery detail", async () => {
      const ext = path.join(home, "ext-w5", agentId);
      const operationId = await lingeringRecord(randomUUID(), ext);
      const service = agentInstructionsService(db);
      const agent = (await loadAgent())!;
      const plain = await settle(db.transaction((tx) => service.assertInstructionRootAvailable(tx, agent, ext, { isInstanceAdmin: false })));
      const admin = await settle(db.transaction((tx) => service.assertInstructionRootAvailable(tx, agent, ext, { isInstanceAdmin: true })));
      expect(plain).toMatchObject({ ok: false, status: 409, details: { code: COPY_INCOMPLETE } });
      expect(JSON.stringify(plain)).not.toContain(ext);
      expect(JSON.stringify(plain)).not.toContain(operationId);
      expect(admin).toMatchObject({ ok: false, status: 409, details: { code: COPY_INCOMPLETE, operationId } });
      const res = await request(app()).patch(`/api/agents/${agentId}`).send({ adapterConfig: cfg("external", ext) });
      expect(res.body?.details?.operationId).toBe(operationId);
    });
  });

  describe("R-K: destination-lock identity", () => {
    const keyOf = async (target: string) => (await deriveInstructionDestinationKey(target)).key;
    it("a symlinked root, a symlinked parent and a dangling link share the target's key", async () => {
      const base = await fs.mkdtemp(path.join(home, "rk-"));
      const real = path.join(base, "real", "root");
      await fs.mkdir(real, { recursive: true });
      await fs.symlink(real, path.join(base, "root-link"));
      await fs.symlink(path.join(base, "real"), path.join(base, "parent-link"));
      await fs.symlink(path.join(base, "real", "missing"), path.join(base, "dangling"));
      expect(await keyOf(path.join(base, "root-link"))).toBe(await keyOf(real));
      expect(await keyOf(path.join(base, "parent-link", "root"))).toBe(await keyOf(real));
      expect(await keyOf(path.join(base, "dangling"))).toBe(await keyOf(path.join(base, "real", "missing")));
    });

    it("case and Unicode spellings of the missing part fold to one key", async () => {
      const base = await fs.mkdtemp(path.join(home, "rk-"));
      expect(await keyOf(path.join(base, "Café", "Root"))).toBe(await keyOf(path.join(base, "café", "ROOT")));
    });

    it("missing then created: the key a copy writer locks is the key after the folder exists", async () => {
      const base = await fs.mkdtemp(path.join(home, "rk-"));
      const root = path.join(base, "deep", "root");
      const locked = await db.transaction((tx) => lockInstructionDestination(tx, root, { agentId, createParent: true }));
      await fs.mkdir(root);
      expect(await keyOf(root)).toBe(locked.key);
      await seed(root, { "AGENTS.md": ENTRY });
      expect(await keyOf(root)).toBe(locked.key);
    });

    it("a renamed parent keeps the key under its new name", async () => {
      const base = await fs.mkdtemp(path.join(home, "rk-"));
      await fs.mkdir(path.join(base, "before", "root"), { recursive: true });
      const original = await keyOf(path.join(base, "before", "root"));
      await fs.rename(path.join(base, "before"), path.join(base, "after"));
      expect(await keyOf(path.join(base, "after", "root"))).toBe(original);
    });

    it("an identity change after the lock (swapped link, created parent) refuses with 409", async () => {
      const base = await fs.mkdtemp(path.join(home, "rk-"));
      await fs.mkdir(path.join(base, "a"), { recursive: true });
      await fs.mkdir(path.join(base, "b"), { recursive: true });
      await fs.symlink(path.join(base, "a"), path.join(base, "link"));
      const swapped = await settle(db.transaction(async (tx) => {
        const locked = await lockInstructionDestination(tx, path.join(base, "link", "root"), { agentId, createParent: false });
        await fs.rm(path.join(base, "link"));
        await fs.symlink(path.join(base, "b"), path.join(base, "link"));
        await assertInstructionDestinationKey(path.join(base, "link", "root"), locked);
      }));
      expect(swapped).toMatchObject({ ok: false, status: 409 });
      const created = await settle(db.transaction(async (tx) => {
        const locked = await lockInstructionDestination(tx, path.join(base, "x", "y", "root"), { agentId, createParent: false });
        await fs.mkdir(path.join(base, "x", "y"), { recursive: true });
        await assertInstructionDestinationKey(path.join(base, "x", "y", "root"), locked);
      }));
      expect(created).toMatchObject({ ok: false, status: 409 });
    });

    it("a lock taken while the folder changes identity is refused before anything is written (re-derive under the lock)", async () => {
      const base = await fs.mkdtemp(path.join(home, "rk-"));
      await fs.mkdir(path.join(base, "a"), { recursive: true });
      await fs.mkdir(path.join(base, "b"), { recursive: true });
      await fs.symlink(path.join(base, "a"), path.join(base, "link"));
      const realStat = fs.stat.bind(fs);
      let swapped = false;
      vi.spyOn(fs, "stat").mockImplementation((async (target: any, options?: any) => {
        const result = await realStat(target, options);
        if (!swapped && String(target) === path.join(base, "a")) {
          swapped = true;
          await fs.rm(path.join(base, "link"));
          await fs.symlink(path.join(base, "b"), path.join(base, "link"));
        }
        return result;
      }) as typeof fs.stat);
      const outcome = await settle(db.transaction((tx) => lockInstructionDestination(tx, path.join(base, "link", "root"), { agentId, createParent: false })));
      expect(swapped).toBe(true);
      expect(outcome).toMatchObject({ ok: false, status: 409 });
    });

    it.skipIf(!caseInsensitiveDir)("case-insensitive volume: case variants of an existing parent share the key", async () => {
      const base = await fs.mkdtemp(path.join(caseInsensitiveDir!, "rk-"));
      await fs.mkdir(path.join(base, "Parent"), { recursive: true });
      expect(await keyOf(path.join(base, "PARENT", "root"))).toBe(await keyOf(path.join(base, "parent", "Root")));
    });
  });

  describe("AD-3 characterization: create pre-check versus locked re-check", () => {
    it("a record that appears between the two checks is refused under the lock, after its secret was stored (PG-3)", async () => {
      const ext = path.join(home, "ext-ad3", agentId);
      await fs.mkdir(ext, { recursive: true });
      const realReaddir = fs.readdir.bind(fs);
      let reads = 0;
      vi.spyOn(fs, "readdir").mockImplementation((async (target: any, options?: any) => {
        const result = await realReaddir(target, options);
        if (String(target) === instructionCopyIntentsDirectory() && ++reads === 1) await lingeringRecord(randomUUID(), ext);
        return result;
      }) as typeof fs.readdir);
      // The intents directory must exist for the first read to be observed.
      await fs.mkdir(instructionCopyIntentsDirectory(), { recursive: true, mode: 0o700 });
      const id = randomUUID();
      const outcome = await settle(agentService(db).create(companyId, { id, name: "Interleaved", adapterType: "hermes_gateway",
        adapterConfig: { ...cfg("external", ext), apiKey: RAW_API_KEY } }));
      vi.restoreAllMocks();
      console.log(`CHAR ${JSON.stringify({ id: "AD-3 interleave", outcome: outcome.ok ? "ok" : `${outcome.status}:${outcome.code}`, agentCreated: Boolean(await loadAgent(id)), orphanSecrets: await secretCount() })}`);
      expect(outcome).toMatchObject({ ok: false, status: 409, code: COPY_INCOMPLETE });
      expect(await loadAgent(id)).toBeUndefined();
      expect(await secretCount()).toBe(1);
    });
  });
});
