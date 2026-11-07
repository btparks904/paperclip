// R-P1: configuration writers that rebuild adapterConfig from an earlier,
// unlocked read must not revert committed instruction settings. updateAgent
// locks the agent row and carries the five instruction keys forward from the
// locked row unless the caller opts in. Real services and routes on embedded
// PostgreSQL, mkdtemp roots and synthetic sentinel content only.
//
// Each scenario logs one "CHAR <json>" line with the observed outcome so the
// same file characterizes the base and the branch.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  activityLog, agentConfigRevisions, agents, authUsers, companies, companyMemberships, createDb,
  principalPermissionGrants, type Db,
} from "@paperclipai/db";
import { deriveBundleState, resolveManagedInstructionsRoot } from "../services/agent-instructions.js";
import { agentService } from "../services/agents.js";
import { companySkillService } from "../services/company-skills.js";
import { builtInAgentService } from "../services/built-in-agents.js";
import { agentRoutes } from "../routes/agents.js";
import { errorHandler } from "../middleware/index.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const KEYS = ["instructionsBundleMode", "instructionsRootPath", "instructionsEntryFile", "instructionsFilePath", "agentsMdPath"] as const;
type Config = Record<string, unknown>;
const ENTRY = "SENTINEL-CARRY-FORWARD-ENTRY\n";
const CONFIG_CHANGED = "AGENT_CONFIG_CHANGED";

/** The five instruction keys present in a config (absent keys omitted). */
const keysOf = (config: unknown): Config => Object.fromEntries(
  KEYS.filter((key) => (config as Config | null)?.[key] !== undefined).map((key) => [key, (config as Config)[key]]));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("updateAgent carries instruction settings forward from the locked row", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let home: string;
  let companyId: string, agentId: string, userId: string, rootA: string, rootB: string, rootC: string;

  const cfg = (mode: "managed" | "external", root: string, entry = "AGENTS.md", extra: Config = {}) => ({
    instructionsBundleMode: mode, instructionsRootPath: root, instructionsEntryFile: entry,
    instructionsFilePath: path.join(root, entry), ...extra });
  const stateA = () => cfg("managed", rootA);
  const stateB = () => cfg("external", rootB, "MAIN.md", { agentsMdPath: path.join(rootB, "AGENTS.md") });
  const stateC = () => cfg("external", rootC);
  const loadAgent = async (id = agentId) => (await db.select().from(agents).where(eq(agents.id, id)))[0]!;
  const configOf = async (id = agentId) => (await loadAgent(id)).adapterConfig as Config;
  const revisions = (id = agentId) => db.select().from(agentConfigRevisions)
    .where(eq(agentConfigRevisions.agentId, id)).orderBy(desc(agentConfigRevisions.createdAt));
  const activityCount = async () => (await db.select().from(activityLog).where(eq(activityLog.companyId, companyId))).length;
  const norm = (value: unknown) => JSON.parse(JSON.stringify(value ?? null)
    .split(home).join("<HOME>").split(agentId).join("<AGENT>").split(companyId).join("<COMPANY>"));
  const char = (id: string, data: Record<string, unknown>) => console.log(`CHAR ${JSON.stringify({ id, ...norm(data) })}`);

  /** Replace only the five keys of the stored config (a committed instruction switch by another writer). */
  const withKeys = (config: Config, keys: Config) => {
    const next = { ...config };
    for (const key of KEYS) delete next[key];
    return { ...next, ...keys };
  };

  /**
   * Hold the agent row lock in another transaction with an uncommitted
   * instruction switch to `keys`, and commit it only once a writer is waiting
   * on that lock. The writer's earlier read therefore cannot have seen the
   * switch, which reproduces the stale-read interleaving deterministically.
   */
  function holdSwitch(keys: Config, id = agentId) {
    let waited = false;
    const done = db.transaction(async (tx) => {
      const [row] = await tx.select().from(agents).where(eq(agents.id, id)).for("update");
      await tx.update(agents).set({ adapterConfig: withKeys(row!.adapterConfig as Config, keys) }).where(eq(agents.id, id));
      for (let i = 0; i < 200; i += 1) {
        const rows = await db.execute(sql`select count(*)::int as n from pg_stat_activity
          where datname = current_database() and wait_event_type = 'Lock'`);
        const n = Number((rows as unknown as Array<{ n: number }>)[0]?.n ?? (rows as any).rows?.[0]?.n ?? 0);
        if (n > 0) { waited = true; break; }
        await sleep(25);
      }
    });
    return { done, waited: () => waited };
  }

  const actorAdmin = () => ({ type: "board", userId, companyIds: [companyId], source: "local_implicit", isInstanceAdmin: true });
  const actorAgent = () => ({ type: "agent", agentId, companyId, source: "agent_key", runId: null });
  const app = (actor: () => Record<string, unknown> = actorAdmin) => {
    const server = express();
    server.use(express.json());
    server.use((req, _res, next) => { (req as any).actor = actor(); next(); });
    server.use("/api", agentRoutes(db as any));
    server.use(errorHandler);
    return server;
  };
  async function seedAgent(id: string, adapterConfig: Config) {
    await db.insert(agents).values({ id, companyId, name: `T-${id.slice(0, 4)}`, adapterConfig });
    if (id !== agentId) return;
    await db.insert(principalPermissionGrants).values([
      { companyId, principalType: "user", principalId: userId, permissionKey: "agents:configure", scope: { agentIds: [id] } },
      { companyId, principalType: "agent", principalId: id, permissionKey: "agents:configure", scope: { agentIds: [id] } },
    ]);
  }
  /** Everything a refused write must leave unchanged. */
  async function snapshot() {
    return { config: await configOf(), revisions: (await revisions()).length, activity: await activityCount() };
  }

  beforeAll(async () => {
    home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "carry-forward-")));
    process.env.PAPERCLIP_HOME = home;
    database = await startEmbeddedPostgresTestDatabase("carry-forward-db-");
    db = createDb(database.connectionString);
  }, 90_000);
  afterAll(async () => {
    await database?.cleanup();
    await fs.rm(home, { recursive: true, force: true });
  });
  beforeEach(async () => {
    companyId = randomUUID(); agentId = randomUUID(); userId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Carry", issuePrefix: randomUUID().slice(0, 8) });
    await db.insert(authUsers).values({ id: userId, name: "Editor", email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companyMemberships).values([{ companyId, principalType: "user", principalId: userId, membershipRole: "operator" }]);
    rootA = resolveManagedInstructionsRoot({ companyId, id: agentId, name: "T", adapterConfig: {} });
    rootB = path.join(home, "ext-b", agentId);
    rootC = path.join(home, "ext-c", agentId);
    await fs.mkdir(rootA, { recursive: true });
    await fs.writeFile(path.join(rootA, "AGENTS.md"), ENTRY);
    await seedAgent(agentId, { ...stateA(), model: "m0" });
  });

  describe("R-R1: RP1 port", () => {
    it("a stale whole-config update after a committed bundle switch keeps the switch and changes the model", async () => {
      const stale = await loadAgent();
      const switched = await request(app()).patch(`/api/agents/${agentId}/instructions-bundle`)
        .send({ mode: "external", rootPath: rootB });
      expect(switched.status, JSON.stringify(switched.body)).toBe(200);
      const afterSwitch = keysOf(await configOf());
      await agentService(db).update(agentId, { adapterConfig: { ...(stale.adapterConfig as Config), model: "m1" } },
        { recordRevision: { source: "patch" } });
      const final = await configOf();
      const [revision] = await revisions();
      char("R-R1", { afterSwitch, final: keysOf(final), model: final.model,
        revisionBefore: keysOf((revision?.beforeConfig as any)?.adapterConfig), revisionAfter: keysOf((revision?.afterConfig as any)?.adapterConfig) });
      expect(afterSwitch.instructionsRootPath).toBe(rootB);
      expect(keysOf(final)).toEqual(afterSwitch);
      expect(final.model).toBe("m1");
      expect(keysOf((revision!.beforeConfig as any).adapterConfig)).toEqual(afterSwitch);
      expect(keysOf((revision!.afterConfig as any).adapterConfig)).toEqual(afterSwitch);
    });
  });

  describe("R-R2: carry-forward writers keep a switch committed after their read", () => {
    // Each case builds the patch exactly as the named writer does, from a read
    // taken before the switch, with the writer's own options.
    type Writer = { id: string; patch: (stale: Config) => Partial<typeof agents.$inferInsert>; options?: Record<string, unknown> };
    const writers: Writer[] = [
      { id: "W-4 bootstrap prompt strip (routes/agents.ts 2732)", options: { allowPendingApprovalConfigUpdate: true },
        patch: (stale) => { const next = { ...stale }; delete next.promptTemplate; delete next.bootstrapPromptTemplate; return { adapterConfig: next }; } },
      { id: "W-6 skills sync (routes/agents.ts 4015)", options: { recordRevision: { source: "skill-sync" } },
        patch: (stale) => ({ adapterConfig: { ...stale, paperclipSkillSync: { desiredSkills: ["sentinel-skill"] } } }) },
      { id: "W-8 heartbeat runner-provider normalization (heartbeat.ts 26729)",
        options: { recordRevision: { source: "normalize_runner_provider", createdByAgentId: null, createdByUserId: null } },
        patch: (stale) => ({ adapterConfig: { ...stale, provider: "normalized" } }) },
      { id: "W-9 secret proposal apply (secret-proposals.ts 702)", options: { recordRevision: { source: "patch" } },
        patch: (stale) => ({ adapterConfig: { ...stale, env: { SENTINEL: { type: "plain", value: "x" } } } }) },
      { id: "W-11 built-in skill sync (built-in-agents.ts 1196)", options: { recordRevision: { source: "built-in-agent:skills" } },
        patch: (stale) => ({ adapterConfig: { ...stale, paperclipSkillSync: { desiredSkills: ["built-in"] } } }) },
      { id: "W-12 built-in provisioning, default input (built-in-agents.ts 1770)", options: { allowBuiltInAgentMetadata: true },
        patch: (stale) => ({ adapterType: "process", adapterConfig: stale }) },
      { id: "W-15 import update (company-portability.ts 5622)",
        patch: (stale) => ({ adapterType: "process", adapterConfig: { ...stale, model: "imported" } }) },
      { id: "W-17 join-request replay (access.ts 3992)",
        patch: (stale) => ({ adapterType: "process", adapterConfig: { ...stale, gateway: "sentinel" } }) },
      { id: "V-5 adapterType-only branch (services/agents.ts 760)", patch: () => ({ adapterType: "process" }) },
    ];
    for (const writer of writers) {
      it(writer.id, async () => {
        const stale = (await loadAgent()).adapterConfig as Config;
        const hold = holdSwitch(stateB());
        await sleep(50);
        const write = agentService(db).update(agentId, writer.patch(stale), writer.options as any);
        await hold.done;
        await write;
        const final = await configOf();
        char("R-R2", { writer: writer.id, waited: hold.waited(), final: keysOf(final) });
        expect(hold.waited()).toBe(true);
        expect(keysOf(final)).toEqual(stateB());
      });
    }
  });

  describe("R-R6: W-12 and W-15 replacement paths without instruction keys", () => {
    it("W-12 provisioning replacement with defaults keeps the previous pointer, also when the later install fails", async () => {
      await agentService(db).update(agentId, { adapterType: "process", adapterConfig: { model: "default" } },
        { allowBuiltInAgentMetadata: true });
      const final = await configOf();
      char("R-R6 W-12 default replacement, install not run", { final: keysOf(final), model: final.model });
      expect(keysOf(final)).toEqual(stateA());
      expect(final.model).toBe("default");
    });
    it("W-15 import update from a manifest without instruction keys keeps the previous pointer when materialization fails", async () => {
      await agentService(db).update(agentId, { adapterType: "process", adapterConfig: { model: "imported" } });
      const final = await configOf();
      char("R-R6 W-15 import update, W-16 not run", { final: keysOf(final), model: final.model });
      expect(keysOf(final)).toEqual(stateA());
    });
  });

  describe("R-R3: opt-in writers still change the keys", () => {
    it("W-1 bundle PATCH switches to an external root", async () => {
      const res = await request(app()).patch(`/api/agents/${agentId}/instructions-bundle`).send({ mode: "external", rootPath: rootB });
      const final = await configOf();
      char("R-R3 W-1 bundle PATCH", { status: res.status, final: keysOf(final) });
      expect(res.status).toBe(200);
      expect(keysOf(final)).toEqual(cfg("external", rootB));
    });
    it("W-2 instructions-path PATCH moves the entry", async () => {
      await fs.mkdir(rootC, { recursive: true });
      await fs.writeFile(path.join(rootC, "AGENTS.md"), "SENTINEL-C\n");
      const res = await request(app()).patch(`/api/agents/${agentId}/instructions-path`)
        .send({ path: path.join(rootC, "AGENTS.md"), adapterConfigKey: "instructionsFilePath" });
      const final = await configOf();
      char("R-R3 W-2 instructions-path PATCH", { status: res.status, final: keysOf(final) });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(keysOf(final)).toEqual(stateC());
    });
    it("W-1 file PUT on a recovered bundle and W-18 legacy prompt clear keep the keys and do not self-block", async () => {
      await db.update(agents).set({ adapterConfig: { ...stateA(), model: "m0", promptTemplate: "legacy", bootstrapPromptTemplate: "legacy" } })
        .where(eq(agents.id, agentId));
      const current = await request(app()).get(`/api/agents/${agentId}/instructions-bundle/file`).query({ path: "AGENTS.md" });
      expect(current.status, JSON.stringify(current.body)).toBe(200);
      const started = Date.now();
      const res = await request(app()).put(`/api/agents/${agentId}/instructions-bundle/file`)
        .send({ path: "AGENTS.md", content: "SENTINEL-W18\n", baseRevisionId: current.body.revision?.id ?? null, clearLegacyPromptTemplate: true });
      const final = await configOf();
      char("R-R3 W-18 legacy prompt clear", { status: res.status, ms: Date.now() - started < 10_000, final: keysOf(final),
        promptTemplate: final.promptTemplate ?? null, bootstrapPromptTemplate: final.bootstrapPromptTemplate ?? null });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(keysOf(final)).toEqual(stateA());
      expect(final.promptTemplate).toBeUndefined();
      expect(final.bootstrapPromptTemplate).toBeUndefined();
    }, 20_000);
    it("W-10 built-in bundle install materializes a managed bundle", async () => {
      await agentService(db).create(companyId, { name: "CEO", role: "ceo", status: "idle", adapterType: "codex_local",
        adapterConfig: { model: "gpt-5.4" }, runtimeConfig: {}, permissions: {} });
      const state = await builtInAgentService(db).ensure(companyId, "reflection-coach");
      const final = await configOf(state.agent!.id);
      const managed = resolveManagedInstructionsRoot({ companyId, id: state.agent!.id, name: "x", adapterConfig: {} });
      char("R-R3 W-10 built-in install", { final: JSON.parse(JSON.stringify(keysOf(final)).split(state.agent!.id).join("<BUILTIN>")) });
      expect(keysOf(final)).toMatchObject({ instructionsBundleMode: "managed", instructionsRootPath: managed, instructionsEntryFile: "AGENTS.md" });
    }, 30_000);
  });

  describe("R-R4: generic PATCH (W-5)", () => {
    const patchAgent = (body: Record<string, unknown>, actor: () => Record<string, unknown> = actorAdmin) => request(app(actor)).patch(`/api/agents/${agentId}`).send(body);

    it("merge mode without instruction keys carries a concurrent switch forward", async () => {
      const hold = holdSwitch(stateB());
      await sleep(50);
      const res = patchAgent({ adapterConfig: { model: "m1" } }).then((r) => r);
      await hold.done;
      const settled = await res;
      const final = await configOf();
      char("R-R4 merge without keys, concurrent switch", { status: settled.status, waited: hold.waited(), final: keysOf(final), model: final.model });
      expect(settled.status, JSON.stringify(settled.body)).toBe(200);
      expect(hold.waited()).toBe(true);
      expect(keysOf(final)).toEqual(stateB());
      expect(final.model).toBe("m1");
    });

    it("merge mode without instruction keys on a legacy file-path-only agent stores no derived keys; the derived state is unchanged", async () => {
      const legacy = { instructionsFilePath: path.join(rootA, "AGENTS.md"), model: "m0" };
      await db.update(agents).set({ adapterConfig: legacy }).where(eq(agents.id, agentId));
      const derivedBefore = deriveBundleState(await loadAgent());
      const res = await patchAgent({ adapterConfig: { model: "m1" } });
      const final = await configOf();
      const derivedAfter = deriveBundleState(await loadAgent());
      char("R-R4 merge without keys, legacy file path only", { status: res.status, final: keysOf(final),
        derivedSame: derivedBefore.mode === derivedAfter.mode && derivedBefore.rootPath === derivedAfter.rootPath && derivedBefore.entryFile === derivedAfter.entryFile,
        derived: { mode: derivedAfter.mode, rootPath: derivedAfter.rootPath, entryFile: derivedAfter.entryFile } });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(keysOf(final)).toEqual({ instructionsFilePath: legacy.instructionsFilePath });
      expect({ mode: derivedAfter.mode, rootPath: derivedAfter.rootPath, entryFile: derivedAfter.entryFile })
        .toEqual({ mode: derivedBefore.mode, rootPath: derivedBefore.rootPath, entryFile: derivedBefore.entryFile });
    });

    it("merge mode with instruction keys changes those keys", async () => {
      await fs.mkdir(rootC, { recursive: true });
      const res = await patchAgent({ adapterConfig: { instructionsFilePath: path.join(rootC, "AGENTS.md") } });
      const final = await configOf();
      char("R-R4 merge with instructionsFilePath", { status: res.status, final: keysOf(final) });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(keysOf(final)).toEqual(stateC());
    });

    it("merge mode with agentsMdPath only changes agentsMdPath", async () => {
      const res = await patchAgent({ adapterConfig: { agentsMdPath: path.join(rootA, "LEGACY.md") } });
      const final = await configOf();
      char("R-R4 merge with agentsMdPath", { status: res.status, final: keysOf(final) });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(keysOf(final)).toEqual({ ...stateA(), agentsMdPath: path.join(rootA, "LEGACY.md") });
    });

    it("replace mode with an authorized omission clears the keys", async () => {
      const res = await patchAgent({ adapterConfig: { model: "m2" }, replaceAdapterConfig: true });
      const final = await configOf();
      char("R-R4 replace with omission", { status: res.status, final: keysOf(final), model: final.model });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(keysOf(final)).toEqual({});
      expect(final.model).toBe("m2");
    });

    for (const mode of ["merge", "replace"] as const) {
      it(`${mode} mode: a switch committed after authorization gives 409 ${CONFIG_CHANGED} and writes nothing`, async () => {
        await fs.mkdir(rootC, { recursive: true });
        const body = mode === "merge"
          ? { adapterConfig: { instructionsFilePath: path.join(rootC, "AGENTS.md") } }
          : { adapterConfig: { ...stateC(), model: "m3" }, replaceAdapterConfig: true };
        await db.update(agents).set({ updatedAt: new Date() }).where(eq(agents.id, agentId));
        const hold = holdSwitch(stateB());
        await sleep(50);
        const res = patchAgent(body).then((r) => r);
        await hold.done;
        const before = await snapshot();
        const settled = await res;
        const after = await snapshot();
        char(`R-R4 ${mode} locked re-check`, { status: settled.status, code: settled.body?.details?.code ?? settled.body?.code ?? null,
          waited: hold.waited(), unchanged: JSON.stringify(after) === JSON.stringify(before), final: keysOf(after.config) });
        expect(hold.waited()).toBe(true);
        expect(settled.status, JSON.stringify(settled.body)).toBe(409);
        expect(JSON.stringify(settled.body)).toContain(CONFIG_CHANGED);
        expect(after).toEqual(before);
        expect(keysOf(after.config)).toEqual(stateB());
      });
    }

    it("an agent actor is still refused before any write", async () => {
      const before = await snapshot();
      const res = await patchAgent({ adapterConfig: { instructionsRootPath: rootB } }, actorAgent);
      const after = await snapshot();
      char("R-R4 agent actor", { status: res.status, unchanged: JSON.stringify(after) === JSON.stringify(before) });
      expect(res.status).toBe(403);
      expect(after).toEqual(before);
    });
  });

  describe("R-R7: configuration rollback (D-R3)", () => {
    it("case 1: a revision with root A no longer restores A after the pointer moved to B", async () => {
      const svc = agentService(db);
      await svc.update(agentId, { adapterConfig: { ...stateA(), model: "m1" } }, { recordRevision: { source: "test" } });
      const [revision] = await revisions();
      await db.update(agents).set({ adapterConfig: { ...stateB(), model: "m2" } }).where(eq(agents.id, agentId));
      await svc.rollbackConfigRevision(agentId, revision!.id, {});
      const final = await configOf();
      char("R-R7 case 1", { final: keysOf(final), model: final.model });
      expect(keysOf(final)).toEqual(stateB());
      expect(final.model).toBe("m1");
    });

    it("case 2: a revision with no instruction keys keeps the current keys", async () => {
      const otherId = randomUUID();
      await seedAgent(otherId, { model: "m0" });
      const svc = agentService(db);
      await svc.update(otherId, { adapterConfig: { model: "m1" } }, { recordRevision: { source: "test" } });
      const [revision] = await revisions(otherId);
      await db.update(agents).set({ adapterConfig: { ...stateB(), model: "m2" } }).where(eq(agents.id, otherId));
      await svc.rollbackConfigRevision(otherId, revision!.id, {});
      const final = await configOf(otherId);
      char("R-R7 case 2", { final: keysOf(final), model: final.model });
      expect(keysOf(final)).toEqual(stateB());
      expect(final.model).toBe("m1");
    });

    it("case 3: keys absent from the current config stay absent", async () => {
      const svc = agentService(db);
      await svc.update(agentId, { adapterConfig: { ...stateB(), model: "m1" } }, { recordRevision: { source: "test" } });
      const [revision] = await revisions();
      await db.update(agents).set({ adapterConfig: { model: "m2" } }).where(eq(agents.id, agentId));
      await svc.rollbackConfigRevision(agentId, revision!.id, {});
      const final = await configOf();
      char("R-R7 case 3", { final: keysOf(final), model: final.model });
      expect(keysOf(final)).toEqual({});
      expect(final.model).toBe("m1");
    });

    it("the rollback revision records the locked row's keys, not a switch made by another transaction", async () => {
      const svc = agentService(db);
      await svc.update(agentId, { adapterConfig: { ...stateA(), model: "m1" } }, { recordRevision: { source: "test" } });
      const [revision] = await revisions();
      await db.update(agents).set({ adapterConfig: { ...stateB(), model: "m2" } }).where(eq(agents.id, agentId));
      const hold = holdSwitch(stateC());
      await sleep(50);
      const rollback = svc.rollbackConfigRevision(agentId, revision!.id, {});
      await hold.done;
      await rollback;
      const [rollbackRevision] = await revisions();
      const final = await configOf();
      char("R-R7 attribution", { waited: hold.waited(), final: keysOf(final), source: rollbackRevision?.source,
        before: keysOf((rollbackRevision?.beforeConfig as any)?.adapterConfig), after: keysOf((rollbackRevision?.afterConfig as any)?.adapterConfig) });
      expect(hold.waited()).toBe(true);
      expect(rollbackRevision!.source).toBe("rollback");
      expect(keysOf(final)).toEqual(stateC());
      expect(keysOf((rollbackRevision!.beforeConfig as any).adapterConfig)).toEqual(stateC());
      expect(keysOf((rollbackRevision!.afterConfig as any).adapterConfig)).toEqual(stateC());
    });

    it("P-1b: an agent-authenticated rollback can no longer change instruction keys", async () => {
      const svc = agentService(db);
      await svc.update(agentId, { adapterConfig: { ...cfg("managed", rootA, "OLD.md"), model: "m1" } }, { recordRevision: { source: "test" } });
      const [revision] = await revisions();
      await db.update(agents).set({ adapterConfig: { ...stateA(), model: "m2" } }).where(eq(agents.id, agentId));
      const res = await request(app(actorAgent)).post(`/api/agents/${agentId}/config-revisions/${revision!.id}/rollback`);
      const final = await configOf();
      char("R-R7 P-1b agent rollback", { status: res.status, final: keysOf(final), model: final.model });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(keysOf(final)).toEqual(stateA());
      expect(final.model).toBe("m1");
    });
  });

  describe("D-3 and D-4: direct locked skill-reassignment writers (company-skills.ts 3925, 4196)", () => {
    const desired = async () => ((await configOf()).paperclipSkillSync as { desiredSkills?: unknown[] } | undefined)?.desiredSkills;
    it("D-3 fork reassignment waits for an in-flight switch and keeps it", async () => {
      const skills = companySkillService(db);
      const source = await skills.createLocalSkill(companyId, { name: "Carry Source", slug: "carry-source" }, { type: "user", userId: "board" });
      await db.update(agents).set({ adapterType: "codex_local", adapterConfig: { ...stateA(), paperclipSkillSync: { desiredSkills: [source.key] } } })
        .where(eq(agents.id, agentId));
      const hold = holdSwitch(stateB());
      await sleep(50);
      const fork = skills.forkSkill(companyId, source.id, { slug: "carry-source-fork", reassignAgentIds: [agentId] }, { type: "user", userId: "board" });
      await hold.done;
      const result = await fork;
      const final = await configOf();
      char("D-3 fork reassignment", { waited: hold.waited(), final: keysOf(final), desired: await desired(), reassigned: result.reassignments.length });
      expect(hold.waited()).toBe(true);
      expect(keysOf(final)).toEqual(stateB());
      expect(await desired()).toEqual([`company/${companyId}/carry-source-fork`]);
    }, 30_000);
    it("D-4 rename reassignment waits for an in-flight switch and keeps it", async () => {
      const skills = companySkillService(db);
      const source = await skills.createLocalSkill(companyId, { name: "Carry Rename", slug: "carry-rename" }, { type: "user", userId: "board" });
      await db.update(agents).set({ adapterType: "codex_local", adapterConfig: { ...stateA(), paperclipSkillSync: { desiredSkills: [source.key] } } })
        .where(eq(agents.id, agentId));
      const hold = holdSwitch(stateB());
      await sleep(50);
      const rename = skills.renameSkill(companyId, source.id, { name: "Carry Renamed", slug: "carry-renamed" });
      await hold.done;
      const result = await rename;
      const final = await configOf();
      char("D-4 rename reassignment", { waited: hold.waited(), final: keysOf(final), desired: await desired(), reassigned: result.reassignments.length });
      expect(hold.waited()).toBe(true);
      expect(keysOf(final)).toEqual(stateB());
      expect(await desired()).toEqual([`company/${companyId}/carry-renamed`]);
    }, 30_000);
  });

  describe("R-R5: concurrency and nesting", () => {
    it("updateAgent waits for an in-flight switch, then the switch and the update both stand", async () => {
      const stale = (await loadAgent()).adapterConfig as Config;
      const hold = holdSwitch(stateB());
      await sleep(50);
      const write = agentService(db).update(agentId, { adapterConfig: { ...stale, model: "m1" } });
      await hold.done;
      await write;
      const final = await configOf();
      expect(hold.waited()).toBe(true);
      expect(keysOf(final)).toEqual(stateB());
      expect(final.model).toBe("m1");
    });

    it("a bundle switch after a committed update keeps the update", async () => {
      await agentService(db).update(agentId, { adapterConfig: { ...stateA(), model: "m1" } });
      const res = await request(app()).patch(`/api/agents/${agentId}/instructions-bundle`).send({ mode: "external", rootPath: rootB });
      const final = await configOf();
      expect(res.status).toBe(200);
      expect(keysOf(final)).toEqual(cfg("external", rootB));
      expect(final.model).toBe("m1");
    });

    it("a caller already holding the row lock in its transaction does not self-block", async () => {
      const result = await Promise.race([
        db.transaction(async (tx) => {
          await tx.select().from(agents).where(eq(agents.id, agentId)).for("update");
          return agentService(tx as unknown as Db).update(agentId, { adapterConfig: { ...stateA(), model: "nested" } });
        }).then(() => "done"),
        sleep(10_000).then(() => "timeout"),
      ]);
      expect(result).toBe("done");
      expect((await configOf()).model).toBe("nested");
    }, 20_000);
  });
});
