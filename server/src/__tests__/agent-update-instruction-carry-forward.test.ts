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
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  activityLog, agentConfigRevisions, agentInstructionRevisions, agents, authUsers, companies, companyMemberships,
  companySecrets, createDb, plugins, principalPermissionGrants, type Db,
} from "@paperclipai/db";
import { deriveBundleState, resolveManagedInstructionsRoot } from "../services/agent-instructions.js";
import { instructionActivationTestHooks } from "../services/instruction-generation-activation.js";
import { agentService } from "../services/agents.js";
import { secretService } from "../services/secrets.js";
import { companySkillService } from "../services/company-skills.js";
import { builtInAgentService } from "../services/built-in-agents.js";
import { agentRoutes } from "../routes/agents.js";
import { buildHostServices } from "../services/plugin-host-services.js";
import { errorHandler } from "../middleware/index.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

// F-1 fault injection: run a hook just before a named writer's update, after
// its own read. Every other caller passes straight through to the real service.
const updateHooks = vi.hoisted(() => ({ before: new Map<string, () => Promise<void>>() }));
vi.mock("../services/agents.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/agents.js")>();
  return {
    ...actual,
    agentService: (...args: Parameters<typeof actual.agentService>) => {
      const svc = actual.agentService(...args);
      return {
        ...svc,
        update: async (...updateArgs: Parameters<typeof svc.update>) => {
          const source = (updateArgs[2] as { recordRevision?: { source?: string } } | undefined)?.recordRevision?.source;
          const key = source ? [...updateHooks.before.keys()].find((suffix) => source.endsWith(suffix)) : undefined;
          const hook = key ? updateHooks.before.get(key) : undefined;
          if (key && hook) { updateHooks.before.delete(key); await hook(); }
          return svc.update(...updateArgs);
        },
      };
    },
  };
});

const KEYS = ["instructionsBundleMode", "instructionsRootPath", "instructionsEntryFile", "instructionsFilePath", "agentsMdPath"] as const;
type Config = Record<string, unknown>;
const ENTRY = "SENTINEL-CARRY-FORWARD-ENTRY\n";
const CONFIG_CHANGED = "AGENT_CONFIG_CHANGED";
const RAW_API_KEY = "SENTINEL-SYNTHETIC-RAW-API-KEY-CARRY";

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
      // The install activates a versioned generation (WS-2 PR-W2): reload the row to resolve it.
      const installed = await loadAgent(state.agent!.id);
      expect(installed.instructionBundleId).toBeTruthy();
      const managed = resolveManagedInstructionsRoot(installed);
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

  describe("F-1: stale reset writers (W-10, W-13, W-14)", () => {
    const STOCK = { "notes/one.md": "STOCK-ONE\n", "notes/two.md": "STOCK-TWO\n", "notes/three.md": "STOCK-THREE\n" };
    const PLUGIN_ENTRY = "PLUGIN-STOCK-ENTRY\n";
    afterEach(() => {
      vi.restoreAllMocks(); updateHooks.before.clear();
      delete instructionActivationTestHooks.duringStaging; delete instructionActivationTestHooks.afterStaging;
    });
    const generationOf = async (id: string) => (await loadAgent(id)).instructionBundleId ?? null;

    /** Every file under a root with its content, or null when the root does not exist. */
    async function filesUnder(root: string): Promise<Record<string, string> | null> {
      const out: Record<string, string> = {};
      const walk = async (dir: string): Promise<boolean> => {
        let entries;
        try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return false; }
        for (const entry of entries) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) await walk(full);
          else out[path.relative(root, full)] = await fs.readFile(full, "utf8");
        }
        return true;
      };
      return (await walk(root)) ? Object.fromEntries(Object.entries(out).sort()) : null;
    }
    async function effects(id: string, roots: Record<string, string>) {
      const files: Record<string, unknown> = {};
      for (const [name, root] of Object.entries(roots)) files[name] = await filesUnder(root);
      return {
        keys: keysOf(await configOf(id)),
        configRevisions: (await revisions(id)).length,
        instructionRevisions: (await db.select({ id: agentInstructionRevisions.id }).from(agentInstructionRevisions)
          .where(eq(agentInstructionRevisions.agentId, id))).length,
        activity: await activityCount(),
        files,
      };
    }
    /** Commit a switch now (no lock may be held by the caller). */
    const commitSwitch = (id: string, keys: Config) => db.transaction(async (tx) => {
      const [row] = await tx.select().from(agents).where(eq(agents.id, id)).for("update");
      await tx.update(agents).set({ adapterConfig: withKeys(row!.adapterConfig as Config, keys) }).where(eq(agents.id, id));
    });
    /**
     * WS-2 PR-W2: a reset stages a new generation outside the row lock and
     * activates it in one locked transaction, so there is no per-file write
     * loop to interrupt. Commit a switch at a staging point instead: while the
     * staged folder is being written, or after staging and before activation.
     */
    function switchDuringActivation(phase: "duringStaging" | "afterStaging", id: () => string, keys: () => Config) {
      const state: { staged?: string; committed: boolean } = { committed: false };
      instructionActivationTestHooks[phase] = async ({ stagingRoot }: { stagingRoot: string }) => {
        delete instructionActivationTestHooks[phase];
        state.staged = stagingRoot;
        await commitSwitch(id(), keys());
        state.committed = true;
      };
      return state;
    }

    async function seedPluginAgent() {
      const pluginId = randomUUID();
      const manifest: any = {
        id: `paperclip.carry-forward-${pluginId.slice(0, 8)}`, apiVersion: 1, version: "0.1.0", displayName: "Carry", description: "Test plugin",
        author: "Paperclip", categories: ["automation"], capabilities: ["agents.managed"], entrypoints: { worker: "./dist/worker.js" },
        agents: [{ agentKey: "carry", displayName: "Carry Managed", role: "engineer", title: "t", capabilities: "c",
          adapterType: "process", adapterConfig: { command: "carry" }, runtimeConfig: { heartbeat: { enabled: false } },
          permissions: { canCreateAgents: false }, budgetMonthlyCents: 0,
          instructions: { entryFile: "AGENTS.md", content: PLUGIN_ENTRY, files: STOCK } }],
      };
      await db.insert(plugins).values({ id: pluginId, pluginKey: manifest.id, packageName: "@paperclipai/carry", version: "0.1.0",
        apiVersion: 1, categories: manifest.categories, manifestJson: manifest, status: "ready", installOrder: 1 });
      const services = buildHostServices(db, pluginId, manifest.id, { forPlugin: () => ({ emit: async () => {}, subscribe: () => {} }) } as any,
        undefined, { manifest });
      const created = await services.agents.managedReconcile({ companyId, agentKey: "carry" });
      const id = created.agentId!;
      // Reconcile activates a versioned generation (WS-2 PR-W2): reload the row to resolve the active root.
      const managed = resolveManagedInstructionsRoot(await loadAgent(id));
      const ext = path.join(home, "ext-b", id);
      await fs.mkdir(ext, { recursive: true });
      await fs.writeFile(path.join(ext, "MAIN.md"), "B-ENTRY\n");
      // Drift the stock files so a reset has something to write.
      for (const file of Object.keys(STOCK)) await fs.writeFile(path.join(managed, file), "USER-EDIT\n");
      await fs.writeFile(path.join(managed, "AGENTS.md"), "USER-ENTRY-EDIT\n");
      const reset = () => services.agents.managedReset({ companyId, agentKey: "carry" });
      return { id, managed, ext, reset, stateExt: () => cfg("external", ext, "MAIN.md") };
    }
    const outcome = (value: Promise<unknown>) => value.then((r: any) => ({ ok: true, status: r?.status ?? null }),
      (e: any) => ({ ok: false, status: e?.status ?? null, code: e?.details?.code ?? null, message: String(e?.message ?? e) }));

    it("W-13 mid-staging: a switch committed while the generation is staged refuses activation; nothing reaches root A or B", async () => {
      const agent = await seedPluginAgent();
      const generation = await generationOf(agent.id);
      const before = await effects(agent.id, { A: agent.managed, B: agent.ext });
      const hook = switchDuringActivation("duringStaging", () => agent.id, agent.stateExt);
      const result = await outcome(agent.reset());
      const after = await effects(agent.id, { A: agent.managed, B: agent.ext });
      char("F-1 W-13 mid-staging", { result, committed: hook.committed, before: norm(before), after: norm(after) });
      expect(hook.committed).toBe(true);
      // The locked recheck reruns the reset's identity on the switched row; an external bundle is refused there.
      expect(result).toMatchObject({ ok: false, status: 422, code: "INSTRUCTION_MANAGED_BUNDLE_REQUIRED" });
      expect(after.keys).toEqual(agent.stateExt());
      expect(after.files.B).toEqual(before.files.B);
      expect(after.configRevisions).toBe(before.configRevisions);
      expect(after.instructionRevisions).toBe(before.instructionRevisions);
      expect(after.activity).toBe(before.activity);
      // No partial activation: the active generation and root A are unchanged; the staged folder is retained, not active.
      expect(await generationOf(agent.id)).toBe(generation);
      expect(after.files.A).toEqual(before.files.A);
      expect(hook.staged).toBeTruthy();
      expect(hook.staged).not.toBe(agent.managed);
    }, 30_000);

    it("W-13 after staging, same-root entry-only switch: activation refuses and no stock file lands in the active root", async () => {
      const agent = await seedPluginAgent();
      await fs.writeFile(path.join(agent.managed, "OTHER.md"), "OTHER-ENTRY\n");
      const entrySwitch = () => cfg("managed", agent.managed, "OTHER.md");
      const generation = await generationOf(agent.id);
      const before = await effects(agent.id, { A: agent.managed });
      const hook = switchDuringActivation("afterStaging", () => agent.id, entrySwitch);
      const result = await outcome(agent.reset());
      const after = await effects(agent.id, { A: agent.managed });
      char("F-1 W-13 after staging entry-only", { result, committed: hook.committed, before: norm(before), after: norm(after) });
      expect(hook.committed).toBe(true);
      expect(result).toMatchObject({ ok: false, status: 409, code: "INSTRUCTION_GENERATION_CHANGED" });
      expect(after.keys).toEqual(entrySwitch());
      expect(after.configRevisions).toBe(before.configRevisions);
      expect(after.instructionRevisions).toBe(before.instructionRevisions);
      expect(after.activity).toBe(before.activity);
      // The former residual (stock files landing in the active root) is closed for supported writers.
      expect(await generationOf(agent.id)).toBe(generation);
      expect(after.files.A).toEqual(before.files.A);
      expect((after.files.A as Record<string, string>)["notes/one.md"]).toBe("USER-EDIT\n");
    }, 30_000);

    it("W-13 after the loop: a switch committed before the final update gives 409 AGENT_CONFIG_CHANGED and keeps root B", async () => {
      const agent = await seedPluginAgent();
      const generation = await generationOf(agent.id);
      const before = await effects(agent.id, { A: agent.managed, B: agent.ext });
      updateHooks.before.set(":managed-agent-instructions", () => commitSwitch(agent.id, agent.stateExt()));
      const result = await outcome(agent.reset());
      const after = await effects(agent.id, { A: agent.managed, B: agent.ext });
      char("F-1 W-13 after loop", { result, before: norm(before), after: norm(after) });
      expect(result).toMatchObject({ ok: false, status: 409, code: CONFIG_CHANGED });
      expect(after.keys).toEqual(agent.stateExt());
      expect(after.files.B).toEqual(before.files.B);
      expect(after.configRevisions).toBe(before.configRevisions);
      // The switch landed after the atomic activation: a new generation is recorded, the earlier one is retained untouched.
      expect(await generationOf(agent.id)).not.toBe(generation);
      expect(after.files.A).toEqual(before.files.A);
    }, 30_000);

    for (const variant of ["root switch", "agentsMdPath added (missing to present)"] as const) {
      it(`W-14: a ${variant} committed after W-13's update gives 409 AGENT_CONFIG_CHANGED with no file change`, async () => {
        const agent = await seedPluginAgent();
        let filesAtHook: unknown = null;
        let target: Config = {};
        updateHooks.before.set(":managed-agent-reset", async () => {
          filesAtHook = await effects(agent.id, { A: agent.managed, B: agent.ext });
          const current = keysOf(await configOf(agent.id));
          target = variant === "root switch" ? agent.stateExt() : { ...current, agentsMdPath: path.join(agent.managed, "LEGACY.md") };
          await commitSwitch(agent.id, target);
        });
        const result = await outcome(agent.reset());
        const after = await effects(agent.id, { A: agent.managed, B: agent.ext });
        char(`F-1 W-14 ${variant}`, { result, atHook: norm(filesAtHook), after: norm(after) });
        expect(result).toMatchObject({ ok: false, status: 409, code: CONFIG_CHANGED });
        expect(after.keys).toEqual(target);
        expect(after.files).toEqual((filesAtHook as any).files);
        expect(after.configRevisions).toBe((filesAtHook as any).configRevisions);
        expect(after.activity).toBe((filesAtHook as any).activity);
      }, 30_000);
    }

    it("W-13 and W-14 without a concurrent switch: the reset succeeds and writes every stock file into root A", async () => {
      const agent = await seedPluginAgent();
      const generation = await generationOf(agent.id);
      const before = await effects(agent.id, { A: agent.managed });
      const result = await outcome(agent.reset());
      // The reset activates a new generation (WS-2 PR-W2); reload the row to resolve its root.
      const activated = await loadAgent(agent.id);
      expect(activated.instructionBundleId).toBeTruthy();
      expect(activated.instructionBundleId).not.toBe(generation);
      const rootY = resolveManagedInstructionsRoot(activated);
      const after = await effects(agent.id, { A: agent.managed, Y: rootY, B: agent.ext });
      char("F-1 plugin reset success", { result, after: norm(after) });
      expect(result).toMatchObject({ ok: true, status: "reset" });
      expect(after.keys).toMatchObject({ instructionsBundleMode: "managed", instructionsRootPath: rootY, instructionsEntryFile: "AGENTS.md" });
      for (const [file, content] of Object.entries(STOCK)) expect((after.files.Y as Record<string, string>)[file]).toBe(content);
      expect((after.files.Y as Record<string, string>)["AGENTS.md"]).toBe(PLUGIN_ENTRY);
      // The previous generation is retained unchanged.
      expect(after.files.A).toEqual(before.files.A);
    }, 30_000);

    const operator = { type: "board", userId: "local-board", source: "local_implicit" } as const;
    async function seedBuiltIn() {
      await agentService(db).create(companyId, { name: "CEO", role: "ceo", status: "idle", adapterType: "codex_local",
        adapterConfig: { model: "gpt-5.4" }, runtimeConfig: {}, permissions: {} });
      const builtIns = builtInAgentService(db);
      const state = await builtIns.ensure(companyId, "reflection-coach");
      const id = state.agent!.id;
      const managed = resolveManagedInstructionsRoot(await loadAgent(id));
      const ext = path.join(home, "ext-b", id);
      await fs.mkdir(ext, { recursive: true });
      await fs.writeFile(path.join(ext, "MAIN.md"), "B-ENTRY\n");
      await fs.writeFile(path.join(managed, "AGENTS.md"), "USER-EDIT\n");
      return { id, managed, ext, reset: () => builtIns.reset(companyId, "reflection-coach", { resources: ["instructions"] }, operator as any) };
    }

    it("W-10 after the stock writes: a switch committed before the final update gives 409 AGENT_CONFIG_CHANGED and keeps root B", async () => {
      const agent = await seedBuiltIn();
      const target = cfg("external", agent.ext, "MAIN.md");
      const before = await effects(agent.id, { A: agent.managed, B: agent.ext });
      updateHooks.before.set("built-in-bundle:reset:instructions", () => commitSwitch(agent.id, target));
      const result = await outcome(agent.reset());
      const after = await effects(agent.id, { A: agent.managed, B: agent.ext });
      char("F-1 W-10 after loop", { result, before: JSON.parse(JSON.stringify(norm(before)).split(agent.id).join("<BUILTIN>")),
        after: JSON.parse(JSON.stringify(norm(after)).split(agent.id).join("<BUILTIN>")) });
      expect(result).toMatchObject({ ok: false, status: 409, code: CONFIG_CHANGED });
      expect(after.keys).toEqual(target);
      expect(after.files.B).toEqual(before.files.B);
      expect(after.configRevisions).toBe(before.configRevisions);
    }, 30_000);

    it("W-10 without a concurrent switch: the reset succeeds and restores the stock entry", async () => {
      const agent = await seedBuiltIn();
      const generation = await generationOf(agent.id);
      const result = await outcome(agent.reset());
      // The reset activates a new generation (WS-2 PR-W2); reload the row to resolve its root.
      const activated = await loadAgent(agent.id);
      expect(activated.instructionBundleId).toBeTruthy();
      expect(activated.instructionBundleId).not.toBe(generation);
      const rootY = resolveManagedInstructionsRoot(activated);
      const after = await effects(agent.id, { A: rootY, previous: agent.managed });
      char("F-1 W-10 reset success", { result: { ok: result.ok }, keys: JSON.parse(JSON.stringify(norm(after.keys)).split(agent.id).join("<BUILTIN>")),
        entryRestored: (after.files.A as Record<string, string>)["AGENTS.md"] !== "USER-EDIT\n" });
      expect(result.ok).toBe(true);
      expect(after.keys).toMatchObject({ instructionsBundleMode: "managed", instructionsRootPath: rootY });
      expect((after.files.A as Record<string, string>)["AGENTS.md"]).not.toBe("USER-EDIT\n");
      expect((after.files.previous as Record<string, string>)["AGENTS.md"]).toBe("USER-EDIT\n");
    }, 30_000);
  });

  describe("F-2: secrets are normalized inside the update transaction", () => {
    const secretCount = async () => (await db.select({ id: companySecrets.id }).from(companySecrets).where(eq(companySecrets.companyId, companyId))).length;
    /** Everything a rejected PATCH must leave unchanged, including secret rows. */
    const full = async () => ({ config: await configOf(), revisions: (await revisions()).length, activity: await activityCount(), secrets: await secretCount() });
    /** A config with secret ids replaced, for comparing persisted shapes across runs. */
    const shape = (config: Config) => JSON.parse(JSON.stringify(norm(config)).replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<ID>"));
    const patch = (body: Record<string, unknown>, actor: () => Record<string, unknown> = actorAdmin) =>
      request(app(actor)).patch(`/api/agents/${agentId}`).send(body);
    const viewer = async () => {
      const other = randomUUID();
      await db.insert(authUsers).values({ id: other, name: "Viewer", email: `${other}@example.test`, createdAt: new Date(), updatedAt: new Date() });
      await db.insert(companyMemberships).values([{ companyId, principalType: "user", principalId: other, membershipRole: "viewer" }]);
      return () => ({ type: "board", userId: other, companyIds: [companyId], source: "session", isInstanceAdmin: false });
    };
    const withStrict = async <T>(fn: () => Promise<T>) => {
      const previous = process.env.PAPERCLIP_SECRETS_STRICT_MODE;
      process.env.PAPERCLIP_SECRETS_STRICT_MODE = "true";
      try { return await fn(); } finally {
        if (previous === undefined) delete process.env.PAPERCLIP_SECRETS_STRICT_MODE; else process.env.PAPERCLIP_SECRETS_STRICT_MODE = previous;
      }
    };
    /**
     * PG-3: a schema-secret field takes only an existing same-company secret
     * reference, so these tests store the key first and pass its reference.
     * The secret count then starts at 1; "no new secret row" stays asserted.
     */
    let apiKeyRef: Record<string, unknown>;
    const REQUIRES_REF = "schema_secret_field_requires_secret_ref";
    beforeEach(async () => {
      await db.update(agents).set({ adapterType: "hermes_gateway", adapterConfig: { ...stateA(), model: "m0" } }).where(eq(agents.id, agentId));
      await fs.mkdir(rootC, { recursive: true });
      const stored = await secretService(db).create(companyId, {
        name: `carry-forward-api-key-${randomUUID()}`, provider: "local_encrypted", value: RAW_API_KEY,
      });
      apiKeyRef = { type: "secret_ref", secretId: stored.id, version: "latest" };
    });

    describe("F-2 rejections leave no secret row and change nothing", () => {
      for (const mode of ["merge", "replace"] as const) {
        it(`${mode} mode with a secret reference and a concurrent switch: 409 ${CONFIG_CHANGED}`, async () => {
          const body = mode === "merge"
            ? { adapterConfig: { instructionsFilePath: path.join(rootC, "AGENTS.md"), apiKey: apiKeyRef } }
            : { adapterConfig: { ...stateC(), model: "m3", apiKey: apiKeyRef }, replaceAdapterConfig: true };
          const hold = holdSwitch(stateB());
          await sleep(50);
          const res = patch(body).then((r) => r);
          await hold.done;
          const before = await full();
          const settled = await res;
          const after = await full();
          char(`F-2 ${mode} 409 secret ref`, { status: settled.status, waited: hold.waited(), secretsBefore: before.secrets, secretsAfter: after.secrets });
          expect(hold.waited()).toBe(true);
          expect(settled.status, JSON.stringify(settled.body)).toBe(409);
          expect(JSON.stringify(settled.body)).toContain(CONFIG_CHANGED);
          expect(after).toEqual(before);
          expect(after.secrets).toBe(1);
          expect(keysOf(after.config)).toEqual(stateB());
        });
      }
      it("merge and replace mode with a raw secret: 422 schema_secret_field_requires_secret_ref, no secret row (PG-3)", async () => {
        for (const body of [
          { adapterConfig: { instructionsFilePath: path.join(rootC, "AGENTS.md"), apiKey: RAW_API_KEY } },
          { adapterConfig: { ...stateC(), model: "m3", apiKey: RAW_API_KEY }, replaceAdapterConfig: true },
        ]) {
          const before = await full();
          const res = await patch(body);
          const after = await full();
          expect(res.status, JSON.stringify(res.body)).toBe(422);
          expect(res.body?.details?.code ?? res.body?.code).toBe(REQUIRES_REF);
          expect(after).toEqual(before);
          expect(after.secrets).toBe(1);
          expect(JSON.stringify(res.body)).not.toContain(RAW_API_KEY);
        }
      });
      it("an unauthorized viewer PATCH with a raw secret: 403 and no secret row", async () => {
        const actor = await viewer();
        const before = await full();
        const res = await patch({ adapterConfig: { apiKey: RAW_API_KEY } }, actor);
        const after = await full();
        char("F-2 viewer 403 raw secret", { status: res.status, secretsBefore: before.secrets, secretsAfter: after.secrets });
        expect(res.status).toBe(403);
        expect(after).toEqual(before);
      });
      it("an authorized strict-mode PATCH with a raw sensitive env value: 422 and no secret row", async () => {
        const before = await full();
        const res = await withStrict(() => patch({ adapterConfig: { apiKey: apiKeyRef, env: { OPENAI_API_KEY: { type: "plain", value: "SENTINEL-PLAIN-TOKEN" } } } }));
        const after = await full();
        char("F-2 strict 422", { status: res.status, error: res.body?.error, secretsAfter: after.secrets });
        expect(res.status).toBe(422);
        expect(String(res.body?.error)).toContain("Strict secret mode requires secret references for sensitive key: OPENAI_API_KEY");
        expect(after).toEqual(before);
      });
      it("a constraint failure with a raw secret keeps its validation error", async () => {
        await db.update(agents).set({ adapterType: "opencode_local", adapterConfig: { ...stateA(), model: "openai/gpt-5" } }).where(eq(agents.id, agentId));
        const before = await full();
        const res = await patch({ adapterConfig: { model: "not-a-provider-model", env: { API_TOKEN: { type: "plain", value: "SENTINEL-PLAIN-TOKEN" } } } });
        const after = await full();
        char("F-2 constraint 422", { status: res.status, error: res.body?.error, secretsAfter: after.secrets });
        expect(res.status).toBe(422);
        expect(String(res.body?.error)).toContain("Invalid opencode_local adapterConfig");
        expect(after).toEqual(before);
      });
      it("an updateAgent rejection after normalization (direct service D-R4) leaves no secret row", async () => {
        const stale = await configOf();
        const hold = holdSwitch(stateB());
        await sleep(50);
        const write = agentService(db).update(agentId, { adapterConfig: { ...stale, apiKey: apiKeyRef } },
          { instructionConfigWrite: { keys: "all", expected: stale } }).then(() => null, (e) => e?.details?.code ?? String(e));
        await hold.done;
        const before = await full();
        const code = await write;
        const after = await full();
        char("F-2 service 409 secret ref", { code, secretsAfter: after.secrets });
        expect(code).toBe(CONFIG_CHANGED);
        expect(after).toEqual(before);
        expect(after.secrets).toBe(1);
      });
      it("rollback of an outer transaction undoes an update made inside it", async () => {
        const before = await full();
        const result = await db.transaction(async (tx) => {
          await agentService(tx as unknown as Db).update(agentId, { adapterConfig: { ...(await configOf()), apiKey: apiKeyRef } });
          throw new Error("SENTINEL-OUTER-ROLLBACK");
        }).then(() => "committed", (e) => String(e?.message));
        const after = await full();
        expect(result).toBe("SENTINEL-OUTER-ROLLBACK");
        expect(after).toEqual(before);
      });
    });

    describe("F-2 success", () => {
      it("an existing secret reference creates no secret row and is stored as the base canonical reference", async () => {
        const res = await patch({ adapterConfig: { apiKey: apiKeyRef } });
        const final = await configOf();
        char("F-2 success secret ref", { status: res.status, secrets: await secretCount(), config: shape(final) });
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        expect(await secretCount()).toBe(1);
        // The canonical reference shape stored at the base (8a99046a).
        expect(final.apiKey).toEqual({ type: "secret_ref", secretId: apiKeyRef.secretId, version: "latest",
          projectionClass: "unclassified", projectionAllowlistKey: null });
        expect(JSON.stringify(final)).not.toContain(RAW_API_KEY);
        expect(JSON.stringify(res.body)).not.toContain(RAW_API_KEY);
      });
      it("an existing secret reference is kept and creates no row", async () => {
        await patch({ adapterConfig: { apiKey: apiKeyRef } });
        const ref = (await configOf()).apiKey;
        const res = await patch({ adapterConfig: { apiKey: ref, model: "m4" } });
        const final = await configOf();
        char("F-2 success existing ref", { status: res.status, secrets: await secretCount(), same: JSON.stringify(final.apiKey) === JSON.stringify(ref), config: shape(final) });
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        expect(await secretCount()).toBe(1);
        expect(final.apiKey).toEqual(ref);
      });
      it("a repeated raw-secret PATCH is refused each time and creates no secret (PG-3)", async () => {
        const before = await full();
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const res = await patch({ adapterConfig: { apiKey: RAW_API_KEY } });
          expect(res.status, JSON.stringify(res.body)).toBe(422);
        }
        const final = await configOf();
        char("F-2 repeated raw refused", { secrets: await secretCount(), config: shape(final) });
        expect(await full()).toEqual(before);
        expect(JSON.stringify(final)).not.toContain(RAW_API_KEY);
      });
      it("a redacted env value keeps the stored value", async () => {
        await db.update(agents).set({ adapterConfig: { ...stateA(), model: "m0", env: { OPENAI_API_KEY: { type: "plain", value: "SENTINEL-STORED-ENV" } } } }).where(eq(agents.id, agentId));
        const res = await patch({ adapterConfig: { env: { OPENAI_API_KEY: { type: "plain", value: "***REDACTED***" } }, model: "m5" } });
        const final = await configOf();
        char("F-2 success redacted env", { status: res.status, secrets: await secretCount(), env: final.env, model: final.model });
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        expect(final.env).toEqual({ OPENAI_API_KEY: { type: "plain", value: "SENTINEL-STORED-ENV" } });
      });
      it("strict mode accepts a secret reference and refuses a raw secret field", async () => {
        const refused = await withStrict(() => patch({ adapterConfig: { apiKey: RAW_API_KEY, env: { PLAIN_SETTING: { type: "plain", value: "ok" } } } }));
        expect(refused.status, JSON.stringify(refused.body)).toBe(422);
        expect(await secretCount()).toBe(1);
        const res = await withStrict(() => patch({ adapterConfig: { apiKey: apiKeyRef, env: { PLAIN_SETTING: { type: "plain", value: "ok" } } } }));
        const final = await configOf();
        char("F-2 success strict", { status: res.status, secrets: await secretCount(), config: shape(final) });
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        expect(await secretCount()).toBe(1);
        expect(JSON.stringify(final)).not.toContain(RAW_API_KEY);
      });
      it("a transaction-bound caller commits its secret reference with its update", async () => {
        await db.transaction(async (tx) => {
          await agentService(tx as unknown as Db).update(agentId, { adapterConfig: { ...(await configOf()), apiKey: apiKeyRef } });
        });
        const final = await configOf();
        char("F-2 success nested", { secrets: await secretCount(), config: shape(final) });
        expect(await secretCount()).toBe(1);
        expect(final.apiKey).toMatchObject({ type: "secret_ref", secretId: apiKeyRef.secretId });
      });
    });
  });
});
