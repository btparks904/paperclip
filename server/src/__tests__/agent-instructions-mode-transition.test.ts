import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { activityLog, agents, authUsers, companies, companyMemberships, createDb, principalPermissionGrants } from "@paperclipai/db";
import { agentFileStore, fileHash, snapshotAgentFiles } from "../services/agent-file-store.js";
import { agentInstructionRevisionService } from "../services/agent-instruction-revisions.js";
import { agentInstructionsService, resolveManagedInstructionsRoot } from "../services/agent-instructions.js";
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
});
