import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  activityLog, agentConfigRevisions, agentInstructionHeads, agentInstructionRevisions, agents, authUsers, companies, companyMemberships,
  companySecretBindings, companySecretVersions, companySecrets, createDb, instanceUserRoles, principalPermissionGrants, type Db,
} from "@paperclipai/db";
import { agentFileStore, fileHash, snapshotAgentFiles, type AgentFileConfigRepair, type AgentFileWriteOptions } from "../services/agent-file-store.js";
import { agentInstructionRevisionService } from "../services/agent-instruction-revisions.js";
import { agentInstructionsService, resolveInstructionWriteTarget, resolveManagedInstructionsRoot } from "../services/agent-instructions.js";
import { agentService } from "../services/agents.js";
import { secretService } from "../services/secrets.js";
import type { AuthorizationActor } from "../services/authorization.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

// Synthetic sentinels stand in for private instruction text.
const ENTRY = "SENTINEL-MODE-ENTRY-1f07\n";
const MANAGED_NOTE = "SENTINEL-MODE-MANAGED-NOTE-6a2d\n";
const EXTERNAL_NOTE = "SENTINEL-MODE-EXTERNAL-NOTE-b93e\n";
const INCOMING = "SENTINEL-MODE-INCOMING-0c51\n";
const OTHER = "SENTINEL-MODE-OTHER-77e4\n";
const NOTE = "notes/plan.md";
const hashOf = (content: string) => fileHash(Buffer.from(content, "utf8"));

describe("instruction writes across bundle mode transitions", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const previousHome = process.env.PAPERCLIP_HOME;
  let home: string;
  let companyId: string, agentId: string, userId: string, managedRoot: string, externalRoot: string;
  const entryFile = "AGENTS.md";
  const board = () => ({ type: "board" as const, userId, source: "session" as const });
  const managedConfig = () => ({ instructionsBundleMode: "managed", instructionsRootPath: managedRoot, instructionsEntryFile: entryFile });
  const externalConfig = () => ({ instructionsBundleMode: "external", instructionsRootPath: externalRoot, instructionsEntryFile: entryFile });
  const setConfig = (adapterConfig: Record<string, unknown>) => db.update(agents).set({ adapterConfig }).where(eq(agents.id, agentId));
  const loadAgent = async () => (await db.select().from(agents).where(eq(agents.id, agentId)))[0]!;
  async function tree(root: string) {
    const result: Record<string, string> = {};
    for (const [name, entry] of (await snapshotAgentFiles(root, false)).entries) result[name] = entry.kind === "file" ? entry.hash : entry.kind;
    return result;
  }
  const bothTrees = async () => ({ managed: await tree(managedRoot), external: await tree(externalRoot) });
  const activity = () => db.select().from(activityLog).where(eq(activityLog.entityId, agentId));
  /** The route's managed path: agentFiles.write under the agent row lock. */
  const managedWrite = (content: string | null, baseHash: string | null, filePath = NOTE) => agentFileStore(db).write({
    companyId, agentId, path: filePath, bytes: content === null ? null : Buffer.from(content, "utf8"), baseHash,
  }, board());

  beforeAll(async () => {
    home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "mode-transition-")));
    process.env.PAPERCLIP_HOME = home;
    database = await startEmbeddedPostgresTestDatabase("mode-transition-db-");
    db = createDb(database.connectionString);
  }, 90_000);
  afterAll(async () => {
    if (previousHome === undefined) delete process.env.PAPERCLIP_HOME; else process.env.PAPERCLIP_HOME = previousHome;
    await database?.cleanup();
    if (home) await fs.rm(home, { recursive: true, force: true });
  });
  beforeEach(async () => {
    companyId = randomUUID(); agentId = randomUUID(); userId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Mode transition tests", issuePrefix: randomUUID().slice(0, 8) });
    await db.insert(authUsers).values({ id: userId, name: "Editor", email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    managedRoot = resolveManagedInstructionsRoot({ companyId, id: agentId, name: "Target", adapterConfig: {} });
    externalRoot = path.join(home, "external", agentId);
    await db.insert(agents).values({ id: agentId, companyId, name: "Target", adapterConfig: managedConfig() });
    await db.insert(companyMemberships).values([
      { companyId, principalType: "user", principalId: userId, membershipRole: "operator" },
      { companyId, principalType: "agent", principalId: agentId, membershipRole: "member" },
    ]);
    await db.insert(principalPermissionGrants).values({ companyId, principalType: "user", principalId: userId, permissionKey: "agents:configure", scope: { agentIds: [agentId] } });
    for (const [root, note] of [[managedRoot, MANAGED_NOTE], [externalRoot, EXTERNAL_NOTE]] as const) {
      await fs.mkdir(path.join(root, "notes"), { recursive: true });
      await fs.writeFile(path.join(root, entryFile), ENTRY);
      await fs.writeFile(path.join(root, NOTE), note);
    }
  });

  it("5: rejects a base-bearing managed save after the bundle became external, touching neither root", async () => {
    const baseHash = hashOf(MANAGED_NOTE); // read while managed
    await setConfig(externalConfig());
    const before = await bothTrees();
    for (const [content, base] of [[INCOMING, baseHash], [INCOMING, null], [null, baseHash]] as const) {
      await expect(managedWrite(content, base)).rejects.toMatchObject({ status: 422, message: "External instructions must be migrated to managed storage first" });
    }
    expect(await bothTrees()).toEqual(before);
    expect(await fs.readFile(path.join(externalRoot, NOTE), "utf8")).toBe(EXTERNAL_NOTE);
    expect(await fs.readFile(path.join(managedRoot, NOTE), "utf8")).toBe(MANAGED_NOTE);
    expect(await activity()).toHaveLength(0);
  });

  it("6: refuses an external-path write or delete when the bundle is managed under the lock", async () => {
    const staleExternal = { ...(await loadAgent()), adapterConfig: externalConfig() }; // the route's unlocked read
    const instructions = agentInstructionsService(db);
    const before = await bothTrees();
    await expect(instructions.writeFile(staleExternal, NOTE, INCOMING, { expectedMode: "external" }))
      .rejects.toMatchObject({ status: 409, message: "The instructions bundle mode changed; reload and retry" });
    await expect(instructions.writeFile(staleExternal, "notes/new.md", INCOMING, { expectedMode: "external" }))
      .rejects.toMatchObject({ status: 409 });
    await expect(instructions.deleteFile(staleExternal, NOTE, { expectedMode: "external" }))
      .rejects.toMatchObject({ status: 409 });
    expect(await bothTrees()).toEqual(before);
    expect(await activity()).toHaveLength(0);
    expect((await loadAgent()).adapterConfig).toEqual(managedConfig());
  });

  it("6b: an expected managed mode is refused when the bundle is external under the lock", async () => {
    await setConfig(externalConfig());
    const staleManaged = { ...(await loadAgent()), adapterConfig: managedConfig() };
    const before = await bothTrees();
    await expect(agentInstructionsService(db).writeFile(staleManaged, NOTE, INCOMING, { expectedMode: "managed" }))
      .rejects.toMatchObject({ status: 409 });
    expect(await bothTrees()).toEqual(before);
  });

  it("7: rejects a stale managed base with AGENT_FILE_CONFLICT and leaves the file unchanged", async () => {
    const before = await bothTrees();
    await expect(managedWrite(INCOMING, hashOf(OTHER))).rejects.toMatchObject({
      status: 409, details: { code: "AGENT_FILE_CONFLICT", path: NOTE, currentHash: hashOf(MANAGED_NOTE) },
    });
    await expect(managedWrite(INCOMING, null)).rejects.toMatchObject({ status: 409, details: { code: "AGENT_FILE_CONFLICT" } });
    expect(await bothTrees()).toEqual(before);
    expect(await activity()).toHaveLength(0);
  });

  it("8: lets exactly one of two same-base writes succeed, and treats identical content as a no-op", async () => {
    const baseHash = hashOf(MANAGED_NOTE);
    const results = await Promise.allSettled([managedWrite(INCOMING, baseHash), managedWrite(OTHER, baseHash)]);
    const fulfilled = results.filter(result => result.status === "fulfilled");
    const rejected = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toMatchObject({ status: 409, details: { code: "AGENT_FILE_CONFLICT" } });
    const stored = await fs.readFile(path.join(managedRoot, NOTE), "utf8");
    const winner = results[0]!.status === "fulfilled" ? INCOMING : OTHER;
    expect(stored).toBe(winner);
    expect(await activity()).toHaveLength(1);

    // Resubmitting the stored bytes, even against the old base, changes nothing and records nothing.
    await expect(managedWrite(winner, baseHash)).resolves.toEqual({ contentHash: hashOf(winner), changed: false });
    expect(await fs.readFile(path.join(managedRoot, NOTE), "utf8")).toBe(winner);
    expect(await activity()).toHaveLength(1);
  });

  it("9/10: writes only to the root for the current mode, with consistent hashes", async () => {
    const externalBefore = await tree(externalRoot);
    const managed = await managedWrite(INCOMING, hashOf(MANAGED_NOTE));
    expect(managed).toEqual({ contentHash: hashOf(INCOMING), changed: true });
    const storedBytes = await fs.readFile(path.join(managedRoot, NOTE));
    expect(fileHash(storedBytes)).toBe(managed.contentHash);
    expect(await tree(externalRoot)).toEqual(externalBefore);
    const rows = await activity();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: "agent.files_updated", details: { path: NOTE, contentHash: managed.contentHash } });
    expect(JSON.stringify(rows[0]!.details)).not.toContain(INCOMING.trim());

    // External: the unversioned path, with the external expected mode, writes only the external root.
    await setConfig(externalConfig());
    const managedBefore = await tree(managedRoot);
    const result = await agentInstructionsService(db).writeFile(await loadAgent(), NOTE, OTHER, { expectedMode: "external" });
    expect(result.file).toMatchObject({ path: NOTE, content: OTHER });
    expect(await fs.readFile(path.join(externalRoot, NOTE), "utf8")).toBe(OTHER);
    expect(await tree(managedRoot)).toEqual(managedBefore);
    // The external audit row (agent.instructions_file_updated) is written by the route, not the service.
    expect(await activity()).toHaveLength(1);

    await agentInstructionsService(db).deleteFile(await loadAgent(), NOTE, { expectedMode: "external" });
    await expect(fs.stat(path.join(externalRoot, NOTE))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await tree(managedRoot)).toEqual(managedBefore);
  });

  it("10: an external write without an expected mode keeps its existing behavior", async () => {
    await setConfig(externalConfig());
    const managedBefore = await tree(managedRoot);
    await agentInstructionsService(db).writeFile(await loadAgent(), NOTE, OTHER);
    expect(await fs.readFile(path.join(externalRoot, NOTE), "utf8")).toBe(OTHER);
    expect(await tree(managedRoot)).toEqual(managedBefore);
  });

  it("11: still rejects an entry commit after the bundle became external", async () => {
    await setConfig(externalConfig());
    const before = await bothTrees();
    await expect(agentInstructionRevisionService(db).commit({ companyId, agentId, entryFile, content: INCOMING, source: "board",
      baseRevisionId: null }, board())).rejects.toMatchObject({ status: 422, details: { code: "INSTRUCTION_MANAGED_BUNDLE_REQUIRED" } });
    expect(await bothTrees()).toEqual(before);
    expect(await activity()).toHaveLength(0);
  });

  describe("recovered-managed bundles", () => {
    const STALE_NOTE = "SENTINEL-MODE-STALE-NOTE-4d18\n";
    const HEAD_ENTRY = "SENTINEL-MODE-HEAD-ENTRY-9a0c\n";
    let staleRoot: string;
    const b3Config = () => ({ instructionsBundleMode: "managed", instructionsRootPath: staleRoot, instructionsEntryFile: entryFile });
    const b2Config = () => ({ instructionsRootPath: staleRoot, instructionsEntryFile: entryFile });
    const repairedConfig = () => ({ instructionsBundleMode: "managed", instructionsRootPath: managedRoot, instructionsEntryFile: entryFile,
      instructionsFilePath: path.join(managedRoot, entryFile) });
    /**
     * Mirrors the route's repair callback: secret normalization on the store
     * transaction, then the full agent-service update on the same transaction.
     */
    const makeRepair = (strictMode = false): AgentFileConfigRepair => async (tx, agent, adapterConfig) => {
      const txDb = tx as unknown as Db;
      const normalized = await secretService(txDb).normalizeAdapterConfigForPersistence(agent.companyId, adapterConfig,
        { strictMode, adapterType: agent.adapterType });
      await agentService(txDb).update(agent.id, { adapterConfig: normalized },
        { recordRevision: { createdByAgentId: null, createdByUserId: userId, source: "instructions_bundle_file_put" }, instructionConfigWrite: { keys: "all" } });
    };
    const repairConfig = makeRepair();
    const recoveredOptions = (): AgentFileWriteOptions => ({ allowRecoveredManaged: true, repairConfig });
    const recoveredWrite = (content: string | null, baseHash: string | null, options: AgentFileWriteOptions = recoveredOptions(),
      actor: AuthorizationActor = board(), filePath = NOTE) => agentFileStore(db).write({
      companyId, agentId, path: filePath, bytes: content === null ? null : Buffer.from(content, "utf8"), baseHash,
    }, actor, options);
    const revisions = () => db.select().from(agentConfigRevisions).where(eq(agentConfigRevisions.agentId, agentId));
    const bindings = () => db.select().from(companySecretBindings).where(eq(companySecretBindings.companyId, companyId));
    const allTrees = async () => ({ ...(await bothTrees()), stale: await tree(staleRoot) });
    const markerPath = () => path.join(path.dirname(managedRoot), "file-sync", "adopted.json");
    const markerPresent = () => fs.stat(markerPath()).then(() => true, () => false);
    const unchangedSnapshot = async () => ({ trees: await allTrees(), config: (await loadAgent()).adapterConfig,
      activity: (await activity()).length, revisions: (await revisions()).length, marker: await markerPresent() });
    const seedEntryHead = async () => {
      const revisionId = randomUUID();
      await db.insert(agentInstructionRevisions).values({ id: revisionId, companyId, agentId, entryFile,
        contentBase64: Buffer.from(HEAD_ENTRY).toString("base64"), contentHash: hashOf(HEAD_ENTRY), byteLength: HEAD_ENTRY.length, source: "board" });
      await db.insert(agentInstructionHeads).values({ companyId, agentId, entryFile, revisionId });
    };

    beforeEach(async () => {
      staleRoot = path.join(home, "moved-instance", agentId, "instructions");
      await fs.mkdir(path.join(staleRoot, "notes"), { recursive: true });
      await fs.writeFile(path.join(staleRoot, entryFile), ENTRY);
      await fs.writeFile(path.join(staleRoot, NOTE), STALE_NOTE);
    });

    for (const [label, config] of [["B3", () => b3Config()], ["B2", () => b2Config()]] as const) {
      it(`1/2 ${label}: a CAS save writes only the managed root and repairs the configuration through the agent service`, async () => {
        await setConfig(config());
        const target = await resolveInstructionWriteTarget(await loadAgent());
        expect(target).toEqual({ mode: "managed", rootPath: managedRoot });
        const staleBefore = await tree(staleRoot);
        const externalBefore = await tree(externalRoot);
        const bindingsBefore = await bindings();

        const result = await recoveredWrite(INCOMING, hashOf(MANAGED_NOTE));
        expect(result).toEqual({ contentHash: hashOf(INCOMING), changed: true });
        expect(await fs.readFile(path.join(managedRoot, NOTE), "utf8")).toBe(INCOMING);
        expect(await tree(staleRoot)).toEqual(staleBefore);
        expect(await tree(externalRoot)).toEqual(externalBefore);
        expect((await loadAgent()).adapterConfig).toEqual(repairedConfig());

        const revisionRows = await revisions();
        expect(revisionRows).toHaveLength(1);
        expect(revisionRows[0]).toMatchObject({ source: "instructions_bundle_file_put", createdByUserId: userId, changedKeys: ["adapterConfig"],
          beforeConfig: { adapterConfig: config() }, afterConfig: { adapterConfig: repairedConfig() } });
        const rows = await activity();
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ action: "agent.files_updated", details: { path: NOTE, contentHash: hashOf(INCOMING) } });
        expect(JSON.stringify(rows[0]!.details)).not.toContain(INCOMING.trim());
        expect(await bindings()).toEqual(bindingsBefore);

        // 7 and 12: the bundle is now normal managed; a later changing save records no further config revision.
        expect(await resolveInstructionWriteTarget(await loadAgent())).toEqual(target);
        await recoveredWrite(OTHER, hashOf(INCOMING));
        expect(await revisions()).toHaveLength(1);
        expect(await activity()).toHaveLength(2);
      });
    }

    it("3: a stale base on a recovered bundle is rejected with no write, repair or audit", async () => {
      for (const config of [b3Config(), b2Config()]) {
        await setConfig(config);
        const before = await unchangedSnapshot();
        await expect(recoveredWrite(INCOMING, hashOf(OTHER))).rejects.toMatchObject({
          status: 409, details: { code: "AGENT_FILE_CONFLICT", path: NOTE, currentHash: hashOf(MANAGED_NOTE) },
        });
        await expect(recoveredWrite(null, hashOf(OTHER))).rejects.toMatchObject({ status: 409, details: { code: "AGENT_FILE_CONFLICT" } });
        expect(await unchangedSnapshot()).toEqual(before);
      }
    });

    it("4/14: a recovered bundle switched to explicit external before the lock is rejected without touching any root", async () => {
      await setConfig(b3Config());
      const baseHash = hashOf(MANAGED_NOTE); // read while recovered-managed
      await setConfig(externalConfig());
      const before = await unchangedSnapshot();
      for (const [content, base] of [[INCOMING, baseHash], [null, baseHash]] as const) {
        await expect(recoveredWrite(content, base)).rejects.toMatchObject({ status: 422, message: "External instructions must be migrated to managed storage first" });
      }
      // An explicit external mode with the managed root still counts as external.
      await setConfig({ ...externalConfig(), instructionsRootPath: managedRoot });
      await expect(recoveredWrite(INCOMING, baseHash)).rejects.toMatchObject({ status: 422 });
      await setConfig(externalConfig());
      expect(await unchangedSnapshot()).toEqual(before);
    });

    it("5: without the route's instance-admin allowance the store keeps refusing stale-root bundles", async () => {
      await setConfig(b3Config());
      const before = await unchangedSnapshot();
      await expect(recoveredWrite(INCOMING, hashOf(MANAGED_NOTE), { repairConfig })).rejects.toMatchObject({ status: 422 });
      await expect(recoveredWrite(INCOMING, hashOf(MANAGED_NOTE), {})).rejects.toMatchObject({ status: 422 });
      expect(await unchangedSnapshot()).toEqual(before);
    });

    it("6: concurrent same-base recovered saves let exactly one win and repair once", async () => {
      await setConfig(b2Config());
      const baseHash = hashOf(MANAGED_NOTE);
      const results = await Promise.allSettled([recoveredWrite(INCOMING, baseHash), recoveredWrite(OTHER, baseHash)]);
      expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
      const rejected = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
      expect(rejected).toHaveLength(1);
      expect(rejected[0]!.reason).toMatchObject({ status: 409, details: { code: "AGENT_FILE_CONFLICT" } });
      expect(await revisions()).toHaveLength(1);
      expect(await activity()).toHaveLength(1);
      expect((await loadAgent()).adapterConfig).toEqual(repairedConfig());
    });

    it("7: an entry commit succeeds after the recovered bundle was repaired", async () => {
      await setConfig(b3Config());
      await expect(agentInstructionRevisionService(db).commit({ companyId, agentId, entryFile, content: INCOMING, source: "board",
        baseRevisionId: null }, board())).rejects.toMatchObject({ status: 422 });
      await recoveredWrite(INCOMING, hashOf(MANAGED_NOTE));
      const revisionsSvc = agentInstructionRevisionService(db);
      const current = (await revisionsSvc.readCurrent({ companyId, agentId }, board()))!;
      expect(current.content).toBe(ENTRY);
      const receipt = await revisionsSvc.commit({ companyId, agentId, entryFile, content: OTHER, source: "board",
        baseRevisionId: current.revision.id }, board());
      expect(receipt.revision.contentHash).toBe(hashOf(OTHER));
      expect(await fs.readFile(path.join(managedRoot, entryFile), "utf8")).toBe(OTHER);
      expect(await fs.readFile(path.join(staleRoot, entryFile), "utf8")).toBe(ENTRY);
    });

    it("8: A2, B2 and B3 recovered deletes use the base, refuse the entry, and do not repair configuration", async () => {
      for (const config of [{}, b2Config(), b3Config()]) {
        await setConfig(config);
        await fs.writeFile(path.join(managedRoot, NOTE), MANAGED_NOTE);
        const staleBefore = await tree(staleRoot);
        const before = { config: (await loadAgent()).adapterConfig, revisions: (await revisions()).length, activity: (await activity()).length };
        const options = { allowRecoveredManaged: Object.keys(config).length > 0 };
        await expect(recoveredWrite(null, hashOf(OTHER), options)).rejects.toMatchObject({ status: 409, details: { code: "AGENT_FILE_CONFLICT" } });
        await expect(recoveredWrite(null, hashOf(ENTRY), options, board(), entryFile))
          .rejects.toMatchObject({ status: 422, message: "The configured instruction entry cannot be deleted" });
        await expect(recoveredWrite(null, hashOf(MANAGED_NOTE), options)).resolves.toEqual({ contentHash: null, changed: true });
        await expect(fs.stat(path.join(managedRoot, NOTE))).rejects.toMatchObject({ code: "ENOENT" });
        expect(await tree(staleRoot)).toEqual(staleBefore);
        expect((await loadAgent()).adapterConfig).toEqual(before.config);
        expect(await revisions()).toHaveLength(before.revisions);
        expect(await activity()).toHaveLength(before.activity + 1);
      }
    });

    it("8b: an unconfigured bundle's recovered entry cannot be deleted, with or without store options", async () => {
      await setConfig({});
      await fs.rm(managedRoot, { recursive: true, force: true });
      await fs.mkdir(managedRoot, { recursive: true });
      await fs.writeFile(path.join(managedRoot, "CUSTOM.md"), ENTRY);
      await fs.writeFile(path.join(managedRoot, "other.md"), OTHER);
      const before = await unchangedSnapshot();
      for (const options of [{}, { allowRecoveredManaged: false }, { repairConfig }]) {
        await expect(recoveredWrite(null, hashOf(ENTRY), options, board(), "CUSTOM.md"))
          .rejects.toMatchObject({ status: 422, message: "The configured instruction entry cannot be deleted" });
      }
      expect(await unchangedSnapshot()).toEqual(before);
      await expect(recoveredWrite(null, hashOf(OTHER), {}, board(), "other.md")).resolves.toEqual({ contentHash: null, changed: true });
      expect(await fs.readFile(path.join(managedRoot, "CUSTOM.md"), "utf8")).toBe(ENTRY);
    });

    it("A2: a changing save repairs the unconfigured configuration; an identical save does not", async () => {
      await setConfig({});
      await expect(recoveredWrite(MANAGED_NOTE, hashOf(MANAGED_NOTE), { repairConfig })).resolves.toEqual({ contentHash: hashOf(MANAGED_NOTE), changed: false });
      expect((await loadAgent()).adapterConfig).toEqual({});
      expect(await revisions()).toHaveLength(0);
      await recoveredWrite(INCOMING, hashOf(MANAGED_NOTE), { repairConfig });
      expect((await loadAgent()).adapterConfig).toEqual(repairedConfig());
      expect(await revisions()).toHaveLength(1);
    });

    it("unconfigured empty bundle: a save creates the managed file and leaves configuration unrepaired", async () => {
      await setConfig({});
      await fs.rm(managedRoot, { recursive: true, force: true });
      await recoveredWrite(INCOMING, null, { repairConfig });
      expect(await fs.readFile(path.join(managedRoot, NOTE), "utf8")).toBe(INCOMING);
      expect((await loadAgent()).adapterConfig).toEqual({});
      expect(await revisions()).toHaveLength(0);
    });

    it("9/15: a no-base save or delete is refused when the destination root changed under the lock", async () => {
      const instructions = agentInstructionsService(db);
      await setConfig(b3Config());
      const routed = await loadAgent();
      const recoveredTarget = await resolveInstructionWriteTarget(routed);
      await setConfig(externalConfig());
      const before = await unchangedSnapshot();
      await expect(instructions.writeFile(routed, NOTE, INCOMING, { expectedMode: "external", expectedTarget: recoveredTarget }))
        .rejects.toMatchObject({ status: 409, message: "The instructions bundle mode changed; reload and retry" });
      await expect(instructions.deleteFile(routed, NOTE, { expectedMode: "external", expectedTarget: recoveredTarget }))
        .rejects.toMatchObject({ status: 409 });

      // Two different external roots: the mode name matches, the destination does not.
      const routedExternal = await loadAgent();
      const externalTarget = await resolveInstructionWriteTarget(routedExternal);
      const otherExternal = path.join(home, "external-other", agentId);
      await fs.mkdir(path.join(otherExternal, "notes"), { recursive: true });
      await fs.writeFile(path.join(otherExternal, NOTE), EXTERNAL_NOTE);
      await setConfig({ ...externalConfig(), instructionsRootPath: otherExternal });
      const otherBefore = await tree(otherExternal);
      await expect(instructions.writeFile(routedExternal, NOTE, INCOMING, { expectedMode: "external", expectedTarget: externalTarget }))
        .rejects.toMatchObject({ status: 409 });
      await expect(instructions.deleteFile(routedExternal, NOTE, { expectedMode: "external", expectedTarget: externalTarget }))
        .rejects.toMatchObject({ status: 409 });
      expect(await tree(otherExternal)).toEqual(otherBefore);
      await setConfig(externalConfig());
      expect(await unchangedSnapshot()).toEqual(before);
    });

    it("13/17: matching targets and callers without an expected target keep their behavior", async () => {
      const instructions = agentInstructionsService(db);
      await setConfig(externalConfig());
      const target = await resolveInstructionWriteTarget(await loadAgent());
      const managedBefore = await tree(managedRoot);
      await instructions.writeFile(await loadAgent(), NOTE, OTHER, { expectedMode: "external", expectedTarget: target });
      expect(await fs.readFile(path.join(externalRoot, NOTE), "utf8")).toBe(OTHER);
      await instructions.deleteFile(await loadAgent(), NOTE, { expectedMode: "external", expectedTarget: target });
      await expect(fs.stat(path.join(externalRoot, NOTE))).rejects.toMatchObject({ code: "ENOENT" });
      expect(await tree(managedRoot)).toEqual(managedBefore);

      // A recovered bundle without baseHash keeps the unversioned path, which writes the managed root.
      await setConfig(b3Config());
      const result = await instructions.writeFile(await loadAgent(), NOTE, INCOMING);
      expect(await fs.readFile(path.join(managedRoot, NOTE), "utf8")).toBe(INCOMING);
      expect(result.adapterConfig).toMatchObject({ instructionsRootPath: managedRoot });
      expect(await fs.readFile(path.join(staleRoot, NOTE), "utf8")).toBe(STALE_NOTE);
    });

    it("16: the legacy pseudo-file stays in adapter configuration and touches no root", async () => {
      await setConfig(b3Config());
      const before = await allTrees();
      const result = await agentInstructionsService(db).writeFile(await loadAgent(), "promptTemplate.legacy.md", INCOMING);
      expect(result.adapterConfig).toMatchObject({ promptTemplate: INCOMING });
      expect(await allTrees()).toEqual(before);
    });

    it("10: first adoption of a recovered bundle materializes only revision heads into the managed root", async () => {
      await setConfig(b3Config());
      await seedEntryHead();
      const staleBefore = await tree(staleRoot);
      await recoveredWrite(INCOMING, hashOf(MANAGED_NOTE));
      expect(await fs.readFile(path.join(managedRoot, entryFile), "utf8")).toBe(HEAD_ENTRY);
      expect(await fs.readFile(path.join(managedRoot, NOTE), "utf8")).toBe(INCOMING);
      expect(await tree(staleRoot)).toEqual(staleBefore);
      // The marker is written once; a later out-of-band entry edit is not overwritten again.
      await fs.writeFile(path.join(managedRoot, entryFile), ENTRY);
      await recoveredWrite(OTHER, hashOf(INCOMING));
      expect(await fs.readFile(path.join(managedRoot, entryFile), "utf8")).toBe(ENTRY);
    });

    it("10b/14: a rejected first-adoption save or delete writes no adopted head and no marker", async () => {
      for (const [config, allowRecoveredManaged] of [[b3Config(), true], [b2Config(), true], [{}, false], [managedConfig(), false]] as const) {
        await fs.rm(path.dirname(markerPath()), { recursive: true, force: true });
        await fs.writeFile(path.join(managedRoot, entryFile), ENTRY);
        await db.delete(agentInstructionHeads).where(eq(agentInstructionHeads.agentId, agentId));
        await seedEntryHead();
        await setConfig(config);
        const before = await unchangedSnapshot();
        expect(before.marker).toBe(false);
        const options = { allowRecoveredManaged, repairConfig };
        await expect(recoveredWrite(INCOMING, hashOf(OTHER), options)).rejects.toMatchObject({ status: 409, details: { code: "AGENT_FILE_CONFLICT" } });
        await expect(recoveredWrite(null, hashOf(OTHER), options)).rejects.toMatchObject({ status: 409 });
        // The base is checked against the head that adoption would materialize.
        await expect(recoveredWrite(null, hashOf(ENTRY), options, board(), entryFile)).rejects.toMatchObject({ status: 409 });
        await expect(recoveredWrite(null, hashOf(HEAD_ENTRY), options, board(), entryFile)).rejects.toMatchObject({ status: 422 });
        expect(await unchangedSnapshot()).toEqual(before);
        expect(await fs.readFile(path.join(managedRoot, entryFile), "utf8")).toBe(ENTRY);
      }
    });

    describe("F1: entry saves through the file store", () => {
      const CUSTOM = "CUSTOM.md";
      const heads = () => db.select().from(agentInstructionHeads).where(eq(agentInstructionHeads.agentId, agentId));
      const instructionRevisionRows = () => db.select().from(agentInstructionRevisions).where(eq(agentInstructionRevisions.agentId, agentId));
      /** Managed root holds a non-default entry and an ordinary file, but no AGENTS.md. */
      async function customEntryRoot() {
        await fs.rm(managedRoot, { recursive: true, force: true });
        await fs.rm(path.dirname(markerPath()), { recursive: true, force: true });
        await fs.mkdir(managedRoot, { recursive: true });
        await fs.writeFile(path.join(managedRoot, CUSTOM), ENTRY);
        await fs.writeFile(path.join(managedRoot, "other.md"), OTHER);
      }
      const cases: Array<[string, () => Record<string, unknown>, AgentFileWriteOptions]> = [
        ["A2 (unconfigured)", () => ({}), { repairConfig }],
        ["A2 with an explicit false allowance", () => ({}), { allowRecoveredManaged: false, repairConfig }],
        ["B2 without an entry key", () => ({ instructionsRootPath: staleRoot }), { allowRecoveredManaged: true, repairConfig }],
        ["B3 without an entry key", () => ({ instructionsBundleMode: "managed", instructionsRootPath: staleRoot }), { allowRecoveredManaged: true, repairConfig }],
        ["B3 with CUSTOM.md configured", () => ({ ...b3Config(), instructionsEntryFile: CUSTOM }), { allowRecoveredManaged: true, repairConfig }],
        ["normal managed without an entry key", () => ({ instructionsBundleMode: "managed", instructionsRootPath: managedRoot }), {}],
        ["normal managed with CUSTOM.md configured", () => ({ ...managedConfig(), instructionsEntryFile: CUSTOM }), {}],
      ];
      for (const [label, config, options] of cases) {
        it(`${label}: a save to the recovered entry is refused for every base, with no bytes, adoption, revision or audit`, async () => {
          await customEntryRoot();
          await setConfig(config());
          // The bundle reports CUSTOM.md as its entry; the unversioned path refuses it.
          expect((await agentInstructionsService(db).getBundle(await loadAgent())).entryFile).toBe(CUSTOM);
          // A pending first-adoption head for the entry: a refusal must not adopt it.
          const revisionId = randomUUID();
          await db.insert(agentInstructionRevisions).values({ id: revisionId, companyId, agentId, entryFile: CUSTOM,
            contentBase64: Buffer.from(HEAD_ENTRY).toString("base64"), contentHash: hashOf(HEAD_ENTRY), byteLength: HEAD_ENTRY.length, source: "board" });
          await db.insert(agentInstructionHeads).values({ companyId, agentId, entryFile: CUSTOM, revisionId });
          const before = { ...(await unchangedSnapshot()), heads: await heads(), instructionRevisions: (await instructionRevisionRows()).length };
          expect(before.marker).toBe(false);
          // Matching disk base, matching planned base, stale base, new-file base, and identical content.
          for (const [content, base] of [[INCOMING, hashOf(ENTRY)], [INCOMING, hashOf(HEAD_ENTRY)], [INCOMING, hashOf(OTHER)], [INCOMING, null], [HEAD_ENTRY, hashOf(HEAD_ENTRY)]] as const) {
            await expect(recoveredWrite(content, base, options, board(), CUSTOM)).rejects.toMatchObject({
              status: 422, details: { code: "INSTRUCTION_REVISION_REQUIRED" },
            });
          }
          expect({ ...(await unchangedSnapshot()), heads: await heads(), instructionRevisions: (await instructionRevisionRows()).length }).toEqual(before);
          expect(await fs.readFile(path.join(managedRoot, CUSTOM), "utf8")).toBe(ENTRY);
          expect((await activity()).filter(row => row.action === "agent.files_updated")).toHaveLength(0);

          // An ordinary file in the same bundle stays writable.
          await expect(recoveredWrite(INCOMING, hashOf(OTHER), options, board(), "other.md")).resolves.toEqual({ contentHash: hashOf(INCOMING), changed: true });
          expect(await fs.readFile(path.join(managedRoot, "other.md"), "utf8")).toBe(INCOMING);
          expect(await fs.readFile(path.join(managedRoot, CUSTOM), "utf8")).not.toBe(INCOMING);
        });
      }

      it("a configured entry missing on disk stays the protected entry; other files keep their recovered status", async () => {
        await customEntryRoot();
        // The configured AGENTS.md is absent, so the configured name stays the entry and CUSTOM.md is an ordinary file.
        await setConfig(b3Config());
        expect((await agentInstructionsService(db).getBundle(await loadAgent())).entryFile).toBe(entryFile);
        const before = await unchangedSnapshot();
        await expect(recoveredWrite(INCOMING, null, recoveredOptions(), board(), entryFile)).rejects.toMatchObject({
          status: 422, details: { code: "INSTRUCTION_REVISION_REQUIRED" },
        });
        expect(await unchangedSnapshot()).toEqual(before);
        await expect(recoveredWrite(INCOMING, hashOf(ENTRY), recoveredOptions(), board(), CUSTOM)).resolves.toMatchObject({ changed: true });
      });

      it("the canonical entry commit still updates a non-default entry after a refused store save", async () => {
        await customEntryRoot();
        await setConfig({ ...managedConfig(), instructionsEntryFile: CUSTOM });
        await expect(recoveredWrite(INCOMING, hashOf(ENTRY), {}, board(), CUSTOM)).rejects.toMatchObject({ status: 422 });
        const revisionsSvc = agentInstructionRevisionService(db);
        const current = await revisionsSvc.readCurrent({ companyId, agentId }, board());
        const receipt = await revisionsSvc.commit({ companyId, agentId, entryFile: CUSTOM, content: INCOMING, source: "board",
          baseRevisionId: current?.revision.id ?? null }, board());
        expect(receipt.revision).toMatchObject({ entryFile: CUSTOM, contentHash: hashOf(INCOMING) });
        expect(await fs.readFile(path.join(managedRoot, CUSTOM), "utf8")).toBe(INCOMING);
        expect((await revisionsSvc.readCurrent({ companyId, agentId }, board()))?.content).toBe(INCOMING);
      });
    });

    describe("F2: configuration repair runs before adoption and the file write", () => {
      const setStatus = (status: string) => db.update(agents).set({ status }).where(eq(agents.id, agentId));
      /** Records the managed note and marker as the repair saw them, and how often it ran. */
      function observedRepair() {
        const seen: Array<{ note: string; entry: string; marker: boolean }> = [];
        const callback: AgentFileConfigRepair = async (tx, agent, adapterConfig) => {
          seen.push({ note: await fs.readFile(path.join(managedRoot, NOTE), "utf8"), entry: await fs.readFile(path.join(managedRoot, entryFile), "utf8"),
            marker: await markerPresent() });
          await repairConfig(tx, agent, adapterConfig);
        };
        return { seen, callback };
      }
      const firstAdoptionState = async () => {
        await fs.rm(path.dirname(markerPath()), { recursive: true, force: true });
        await db.delete(agentInstructionHeads).where(eq(agentInstructionHeads.agentId, agentId));
        await seedEntryHead();
      };

      for (const [label, config, allowRecoveredManaged] of [["A2", () => ({}), false], ["B2", () => b2Config(), true], ["B3", () => b3Config(), true]] as const) {
        it(`${label}: a pending-approval rejection inside the repair leaves every root, the marker, config, revisions and audit unchanged`, async () => {
          await firstAdoptionState();
          await setConfig(config());
          await setStatus("pending_approval");
          const before = await unchangedSnapshot();
          expect(before.marker).toBe(false);
          const { seen, callback } = observedRepair();
          await expect(recoveredWrite(INCOMING, hashOf(MANAGED_NOTE), { allowRecoveredManaged, repairConfig: callback }))
            .rejects.toMatchObject({ status: 409, details: { code: "pending_approval_agent_config_frozen" } });
          // The repair ran before any file change.
          expect(seen).toEqual([{ note: MANAGED_NOTE, entry: ENTRY, marker: false }]);
          expect(await unchangedSnapshot()).toEqual(before);
          expect(await fs.readFile(path.join(managedRoot, NOTE), "utf8")).toBe(MANAGED_NOTE);
          expect(await fs.readFile(path.join(managedRoot, entryFile), "utf8")).toBe(ENTRY);
          expect(await fs.readFile(path.join(staleRoot, NOTE), "utf8")).toBe(STALE_NOTE);
        });
      }

      it("a successful repair still runs before the write and the save then writes, adopts, revises and audits once", async () => {
        await firstAdoptionState();
        await setConfig(b3Config());
        const secrets = () => db.select().from(companySecrets).where(eq(companySecrets.companyId, companyId));
        const secretsBefore = await secrets();
        const { seen, callback } = observedRepair();
        await expect(recoveredWrite(INCOMING, hashOf(MANAGED_NOTE), { allowRecoveredManaged: true, repairConfig: callback }))
          .resolves.toEqual({ contentHash: hashOf(INCOMING), changed: true });
        // Normalizing an already-persisted configuration creates no secret outside the transaction.
        expect(await secrets()).toEqual(secretsBefore);
        expect(seen).toEqual([{ note: MANAGED_NOTE, entry: ENTRY, marker: false }]);
        expect(await fs.readFile(path.join(managedRoot, NOTE), "utf8")).toBe(INCOMING);
        expect(await fs.readFile(path.join(managedRoot, entryFile), "utf8")).toBe(HEAD_ENTRY);
        expect(await markerPresent()).toBe(true);
        expect((await loadAgent()).adapterConfig).toEqual(repairedConfig());
        expect(await revisions()).toHaveLength(1);
        expect(await activity()).toHaveLength(1);
      });

      it("a stale base, an identical save and a delete never call the repair", async () => {
        await setConfig(b3Config());
        await setStatus("pending_approval");
        const { seen, callback } = observedRepair();
        const options = { allowRecoveredManaged: true, repairConfig: callback };
        const before = await unchangedSnapshot();
        await expect(recoveredWrite(INCOMING, hashOf(OTHER), options)).rejects.toMatchObject({ status: 409, details: { code: "AGENT_FILE_CONFLICT" } });
        expect(await unchangedSnapshot()).toEqual(before);
        await expect(recoveredWrite(MANAGED_NOTE, hashOf(MANAGED_NOTE), options)).resolves.toEqual({ contentHash: hashOf(MANAGED_NOTE), changed: false });
        await expect(recoveredWrite(null, hashOf(MANAGED_NOTE), options)).resolves.toEqual({ contentHash: null, changed: true });
        expect(seen).toHaveLength(0);
        expect((await loadAgent()).adapterConfig).toEqual(b3Config());
        expect(await revisions()).toHaveLength(0);
      });

      describe("Claude OAuth binding", () => {
        const binding = { type: "user_secret_ref", key: "CLAUDE_CODE_OAUTH_TOKEN" };
        const setClaude = () => db.update(agents).set({ adapterType: "claude_local" }).where(eq(agents.id, agentId));

        it("a pre-existing invalid binding configuration rejects inside the repair with no file change", async () => {
          await firstAdoptionState();
          await setClaude();
          await setConfig({ ...b3Config(), env: { CLAUDE_CODE_OAUTH_TOKEN: binding, ANTHROPIC_API_KEY: { type: "plain", value: "SENTINEL-SYNTHETIC-KEY" } } });
          const before = await unchangedSnapshot();
          const { seen, callback } = observedRepair();
          await expect(recoveredWrite(INCOMING, hashOf(MANAGED_NOTE), { allowRecoveredManaged: true, repairConfig: callback }))
            .rejects.toMatchObject({ status: 409, details: { code: "claude_oauth_credential_conflict" } });
          expect(seen).toEqual([{ note: MANAGED_NOTE, entry: ENTRY, marker: false }]);
          expect(await unchangedSnapshot()).toEqual(before);
        });

        it("an existing valid binding is kept unchanged by a successful repair", async () => {
          await setClaude();
          await setConfig({ ...b3Config(), env: { CLAUDE_CODE_OAUTH_TOKEN: binding } });
          const secretCount = (await db.select().from(companySecrets).where(eq(companySecrets.companyId, companyId))).length;
          await expect(recoveredWrite(INCOMING, hashOf(MANAGED_NOTE))).resolves.toMatchObject({ changed: true });
          const stored = (await loadAgent()).adapterConfig as Record<string, unknown>;
          expect(stored).toMatchObject({ instructionsRootPath: managedRoot, env: { CLAUDE_CODE_OAUTH_TOKEN: binding } });
          expect(Object.keys(stored.env as Record<string, unknown>)).toEqual(["CLAUDE_CODE_OAUTH_TOKEN"]);
          // R1e: the short binding is stored in its canonical form (the defaults the
          // normalizer already filled in before R1), and the repair creates no company secret.
          expect((stored.env as Record<string, unknown>).CLAUDE_CODE_OAUTH_TOKEN)
            .toEqual({ ...binding, version: "latest", required: true, allowMissingOverride: false });
          expect(await db.select().from(companySecrets).where(eq(companySecrets.companyId, companyId))).toHaveLength(secretCount);
          expect(await fs.readFile(path.join(managedRoot, NOTE), "utf8")).toBe(INCOMING);
          expect(await revisions()).toHaveLength(1);
        });
      });
    });

    describe("R1: repair secret normalization commits with the store transaction", () => {
      // A synthetic stand-in for a raw adapter schema-secret value. It is never printed;
      // assertions only check that stored records do not contain it.
      const RAW_API_KEY = "SENTINEL-SYNTHETIC-RAW-API-KEY-5e21";
      const setStatus = (status: string) => db.update(agents).set({ status }).where(eq(agents.id, agentId));
      const setHermes = () => db.update(agents).set({ adapterType: "hermes_gateway" }).where(eq(agents.id, agentId));
      // PG-3: a schema-secret field takes only an existing same-company secret
      // reference, so the R1 tests store the key first and configure its
      // reference. A stored raw value (a pre-PG-3 row) is refused (R1f).
      let apiKeyRef: { type: "secret_ref"; secretId: string; version: "latest" };
      beforeEach(async () => {
        const stored = await secretService(db).create(companyId, {
          name: `r1-api-key-${randomUUID()}`, provider: "local_encrypted", value: RAW_API_KEY,
        });
        apiKeyRef = { type: "secret_ref", secretId: stored.id, version: "latest" };
      });
      const refSecretConfig = () => ({ ...b3Config(), apiKey: apiKeyRef });
      const rawSecretConfig = () => ({ ...b3Config(), apiKey: RAW_API_KEY });
      const secretRows = () => db.select().from(companySecrets).where(eq(companySecrets.companyId, companyId));
      const versionRows = async () => {
        const ids = new Set((await secretRows()).map((row) => row.id));
        return (await db.select().from(companySecretVersions)).filter((row) => ids.has(row.secretId));
      };
      const allVersionCount = async () => (await db.select().from(companySecretVersions)).length;
      const secretState = async () => ({ secrets: (await secretRows()).length, versions: (await versionRows()).length, allVersions: await allVersionCount() });
      const noRawValue = (value: unknown) => expect(JSON.stringify(value).includes(RAW_API_KEY)).toBe(false);
      function countingRepair(repair: AgentFileConfigRepair = repairConfig) {
        let calls = 0;
        const callback: AgentFileConfigRepair = async (tx, agent, adapterConfig) => { calls += 1; await repair(tx, agent, adapterConfig); };
        return { callback, calls: () => calls };
      }

      it("R1a: a pending-approval rejection after normalizing a schema secret leaves no secret and no change, every attempt", async () => {
        await fs.rm(path.dirname(markerPath()), { recursive: true, force: true });
        await setHermes();
        await setConfig(refSecretConfig());
        await setStatus("pending_approval");
        const before = await unchangedSnapshot();
        const secretsBefore = await secretState();
        const { callback, calls } = countingRepair();
        for (let attempt = 1; attempt <= 3; attempt += 1) {
          await expect(recoveredWrite(INCOMING, hashOf(MANAGED_NOTE), { allowRecoveredManaged: true, repairConfig: callback }))
            .rejects.toMatchObject({ status: 409, details: { code: "pending_approval_agent_config_frozen" } });
          expect(calls()).toBe(attempt);
          expect(await secretState()).toEqual(secretsBefore);
        }
        expect(await unchangedSnapshot()).toEqual(before);
        expect((await loadAgent()).adapterConfig).toEqual(refSecretConfig());
        expect(await fs.readFile(path.join(managedRoot, NOTE), "utf8")).toBe(MANAGED_NOTE);
      });

      it("R1b: a file-write failure after a normalizing repair rolls back with the configuration and leaves the secrets unchanged", async () => {
        await setHermes();
        await setConfig(refSecretConfig());
        const secretsBefore = await secretState();
        const revisionsBefore = (await revisions()).length;
        const activityBefore = (await activity()).length;
        const { callback, calls } = countingRepair();
        const notesDir = path.join(managedRoot, "notes");
        // The suite runs as a non-root user, so a read-only directory makes the temporary file create fail.
        await fs.chmod(notesDir, 0o555);
        try {
          await expect(recoveredWrite(INCOMING, hashOf(MANAGED_NOTE), { allowRecoveredManaged: true, repairConfig: callback }))
            .rejects.toMatchObject({ code: "EACCES" });
        } finally {
          await fs.chmod(notesDir, 0o755);
        }
        // The repair ran (normalization executed) before the write failed.
        expect(calls()).toBe(1);
        expect(await secretState()).toEqual(secretsBefore);
        expect((await loadAgent()).adapterConfig).toEqual(refSecretConfig());
        expect(await revisions()).toHaveLength(revisionsBefore);
        expect(await activity()).toHaveLength(activityBefore);
        expect(await fs.readFile(path.join(managedRoot, NOTE), "utf8")).toBe(MANAGED_NOTE);
        expect(await fs.readFile(path.join(staleRoot, NOTE), "utf8")).toBe(STALE_NOTE);
      });

      it("R1c: a successful save creates no secret and commits the existing reference with its binding", async () => {
        await setHermes();
        await setConfig(refSecretConfig());
        const secretsBefore = await secretState();
        const staleBefore = await tree(staleRoot);
        // A stale base is still refused before any repair or secret.
        await expect(recoveredWrite(INCOMING, hashOf(OTHER))).rejects.toMatchObject({ status: 409, details: { code: "AGENT_FILE_CONFLICT" } });
        expect(await secretState()).toEqual(secretsBefore);

        await expect(recoveredWrite(INCOMING, hashOf(MANAGED_NOTE))).resolves.toEqual({ contentHash: hashOf(INCOMING), changed: true });
        const created = await secretRows();
        expect(created).toHaveLength(secretsBefore.secrets);
        const secret = created.find((row) => row.id === apiKeyRef.secretId)!;
        expect(secret).toMatchObject({ companyId, status: "active" });
        expect(await versionRows()).toHaveLength(secretsBefore.versions);
        const stored = (await loadAgent()).adapterConfig as Record<string, unknown>;
        const { apiKey, ...rest } = stored;
        expect(apiKey).toEqual({ type: "secret_ref", secretId: secret.id, version: "latest", projectionClass: "unclassified", projectionAllowlistKey: null });
        expect(rest).toEqual(repairedConfig());
        noRawValue(stored);
        noRawValue(secret);
        const revisionRows = await revisions();
        expect(revisionRows).toHaveLength(1);
        expect(revisionRows[0]).toMatchObject({ source: "instructions_bundle_file_put", createdByUserId: userId });
        noRawValue(revisionRows[0]!.afterConfig);
        // The agent service syncs the binding row in the same transaction; the
        // reference was already in the configuration, so it is not a new
        // binding to audit (PG-3: no secret is created). The store audits the file update.
        const rows = await activity();
        expect(rows.map((row) => row.action).sort()).toEqual(["agent.files_updated"]);
        expect(rows.find((row) => row.action === "agent.files_updated")).toMatchObject({ details: { path: NOTE, contentHash: hashOf(INCOMING) } });
        noRawValue(rows);
        expect((await bindings()).filter((row) => row.secretId === secret.id)).toHaveLength(1);
        expect(await fs.readFile(path.join(managedRoot, NOTE), "utf8")).toBe(INCOMING);
        expect(await tree(staleRoot)).toEqual(staleBefore);
      });

      it("R1f: a stored raw schema-secret value (pre-PG-3 row) is refused inside the repair with no secret, file or configuration change", async () => {
        await setHermes();
        await setConfig(rawSecretConfig());
        const before = await unchangedSnapshot();
        const secretsBefore = await secretState();
        const { callback, calls } = countingRepair();
        await expect(recoveredWrite(INCOMING, hashOf(MANAGED_NOTE), { allowRecoveredManaged: true, repairConfig: callback }))
          .rejects.toMatchObject({ status: 422, details: { code: "schema_secret_field_requires_secret_ref" } });
        expect(calls()).toBe(1);
        expect(await secretState()).toEqual(secretsBefore);
        expect(await unchangedSnapshot()).toEqual(before);
        expect((await loadAgent()).adapterConfig).toEqual(rawSecretConfig());
        expect(await fs.readFile(path.join(managedRoot, NOTE), "utf8")).toBe(MANAGED_NOTE);
      });

      it("R1e: a canonical Claude OAuth user_secret_ref is unchanged after a successful normalizing repair", async () => {
        const canonical = { type: "user_secret_ref", key: "CLAUDE_CODE_OAUTH_TOKEN", version: "latest", required: true, allowMissingOverride: false };
        await db.update(agents).set({ adapterType: "claude_local" }).where(eq(agents.id, agentId));
        await setConfig({ ...b3Config(), env: { CLAUDE_CODE_OAUTH_TOKEN: canonical } });
        const secretsBefore = await secretState();
        const bindingsBefore = await bindings();
        await expect(recoveredWrite(INCOMING, hashOf(MANAGED_NOTE))).resolves.toMatchObject({ changed: true });
        const stored = (await loadAgent()).adapterConfig as Record<string, unknown>;
        expect((stored.env as Record<string, unknown>).CLAUDE_CODE_OAUTH_TOKEN).toStrictEqual(canonical);
        expect(stored).toEqual({ ...repairedConfig(), env: { CLAUDE_CODE_OAUTH_TOKEN: canonical } });
        expect(await secretState()).toEqual(secretsBefore);
        expect(await bindings()).toEqual(bindingsBefore);
      });

      it("R1d: strict mode rejects a sensitive plain env value before any secret or file change; non-strict keeps it", async () => {
        const sensitiveEnv = { SERVICE_API_KEY: { type: "plain", value: "SENTINEL-SYNTHETIC-PLAIN-KEY" } };
        await setConfig({ ...b3Config(), env: sensitiveEnv });
        const before = await unchangedSnapshot();
        const secretsBefore = await secretState();
        await expect(recoveredWrite(INCOMING, hashOf(MANAGED_NOTE), { allowRecoveredManaged: true, repairConfig: makeRepair(true) }))
          .rejects.toMatchObject({ status: 422 });
        expect(await secretState()).toEqual(secretsBefore);
        expect(await unchangedSnapshot()).toEqual(before);
        expect(await fs.readFile(path.join(managedRoot, NOTE), "utf8")).toBe(MANAGED_NOTE);

        await expect(recoveredWrite(INCOMING, hashOf(MANAGED_NOTE), { allowRecoveredManaged: true, repairConfig: makeRepair(false) }))
          .resolves.toMatchObject({ changed: true });
        expect(await secretState()).toEqual(secretsBefore);
        expect((await loadAgent()).adapterConfig).toEqual({ ...repairedConfig(), env: sensitiveEnv });
      });
    });

    describe("G1 authorization for recovered-managed writes", () => {
      async function actorUser(options: { grant: boolean; instanceAdminRow?: boolean; id?: string }) {
        const id = options.id ?? randomUUID();
        await db.insert(authUsers).values({ id, name: "Actor", email: `${id}@example.test`, createdAt: new Date(), updatedAt: new Date() }).onConflictDoNothing();
        await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: id, membershipRole: "operator" });
        if (options.grant) {
          await db.insert(principalPermissionGrants).values({ companyId, principalType: "user", principalId: id, permissionKey: "agents:configure", scope: { agentIds: [agentId] } });
        }
        if (options.instanceAdminRow) await db.insert(instanceUserRoles).values({ userId: id, role: "instance_admin" }).onConflictDoNothing();
        return id;
      }
      const cases: Array<[string, () => Promise<AuthorizationActor>, boolean]> = [
        ["local implicit instance admin, no grant", async () => ({ type: "board", userId: randomUUID(), source: "local_implicit", isInstanceAdmin: true }), true],
        ["session instance admin, no grant", async () => ({ type: "board", userId: await actorUser({ grant: false, instanceAdminRow: true }), source: "session", isInstanceAdmin: true }), true],
        ["cloud tenant instance admin, no grant", async () => ({ type: "board", userId: await actorUser({ grant: false }), source: "cloud_tenant", isInstanceAdmin: true }), false],
        ["cloud tenant instance admin, with grant", async () => ({ type: "board", userId: await actorUser({ grant: true }), source: "cloud_tenant", isInstanceAdmin: true }), true],
        ["cloud control instance admin, no grant", async () => ({ type: "board", userId: await actorUser({ grant: false, id: `paperclip-cloud-${randomUUID()}` }), source: "cloud_control", isInstanceAdmin: true }), false],
        ["cloud control instance admin, with grant", async () => ({ type: "board", userId: await actorUser({ grant: true, id: `paperclip-cloud-${randomUUID()}` }), source: "cloud_control", isInstanceAdmin: true }), true],
        ["non-instance-admin session user, no grant", async () => ({ type: "board", userId: await actorUser({ grant: false }), source: "session", isInstanceAdmin: false }), false],
        ["agent actor without run context", async () => ({ type: "agent", agentId, companyId, source: "agent_key" }), false],
      ];
      for (const [label, makeActor, allowed] of cases) {
        for (const [bundle, config, options] of [
          ["B3", () => b3Config(), { allowRecoveredManaged: true, repairConfig }],
          ["A2", () => ({}), { repairConfig }],
        ] as const) {
          it(`${bundle}: ${label} is ${allowed ? "allowed" : "refused with 403"}`, async () => {
            await setConfig(config());
            const actor = await makeActor();
            const before = await unchangedSnapshot();
            if (allowed) {
              await expect(recoveredWrite(INCOMING, hashOf(MANAGED_NOTE), options, actor)).resolves.toMatchObject({ changed: true });
              await expect(recoveredWrite(null, hashOf(INCOMING), { allowRecoveredManaged: options.allowRecoveredManaged }, actor)).resolves.toMatchObject({ changed: true });
            } else {
              await expect(recoveredWrite(INCOMING, hashOf(MANAGED_NOTE), options, actor)).rejects.toMatchObject({ status: 403 });
              await expect(recoveredWrite(null, hashOf(MANAGED_NOTE), { allowRecoveredManaged: options.allowRecoveredManaged }, actor)).rejects.toMatchObject({ status: 403 });
              expect(await unchangedSnapshot()).toEqual(before);
            }
          });
        }
      }
    });
  });
});
