import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { parseDirectorySnapshot, type DirectorySnapshot, type SnapshotEntry } from "@paperclipai/adapter-utils/workspace-restore-merge";
import { activityLog, agents, agentInstructionWorkingCopies, authUsers, companies, companyMemberships, createDb, heartbeatRuns, principalPermissionGrants } from "@paperclipai/db";
import { AGENT_FILES_ENTRY_CONFLICT, agentFileStore, agentFileTokenFromHash, fileHash, isStaleEntryWriteBack, snapshotAgentFiles } from "../services/agent-file-store.js";
import { agentInstructionRevisionService } from "../services/agent-instruction-revisions.js";
import { agentInstructionWorkingCopyService } from "../services/agent-instruction-working-copies.js";
import { resolveManagedInstructionsRoot } from "../services/agent-instructions.js";
import { logger } from "../middleware/logger.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

// Synthetic sentinels stand in for private instruction text. None of them may
// appear in an error, row, receipt, activity entry or log line.
const ORIGINAL = "SENTINEL-ORIGINAL-ENTRY-7d1c\n";
const NEWER = "SENTINEL-NEWER-MANAGED-ENTRY-41af\n";
const STALE = "SENTINEL-STALE-RUN-ENTRY-9b02\n";
const UNRELATED = "SENTINEL-UNRELATED-RUN-FILE-c3e8\n";
const SENTINELS = [ORIGINAL, NEWER, STALE, UNRELATED].map(value => value.trim());

function snapshot(entries: Record<string, SnapshotEntry>): DirectorySnapshot {
  return { exclude: [], entries: new Map(Object.entries(entries)) };
}
const file = (hash: string, mode = 0o100644): SnapshotEntry => ({ kind: "file", mode, hash });
const h = (seed: string) => seed.repeat(64).slice(0, 64);

describe("stale instruction entry predicate", () => {
  const entry = "AGENTS.md";
  const check = (baseline?: SnapshotEntry, incoming?: SnapshotEntry, current?: SnapshotEntry) =>
    isStaleEntryWriteBack(entry, snapshot(baseline ? { [entry]: baseline } : {}),
      snapshot(incoming ? { [entry]: incoming } : {}), snapshot(current ? { [entry]: current } : {}));

  it("rejects only when the copy and canonical storage both changed the entry differently", () => {
    expect(check(file(h("a")), file(h("b")), file(h("c")))).toBe(true);
    expect(check(file(h("a")), file(h("a")), file(h("c")))).toBe(false); // copy did not change the entry
    expect(check(file(h("a")), file(h("b")), file(h("a")))).toBe(false); // canonical is still the baseline
    expect(check(file(h("a")), file(h("b")), file(h("b")))).toBe(false); // convergent content
  });

  it("compares content by SHA-256 and treats any entry change apply would write as a write", () => {
    // A mode-only copy change still copies the whole file, so it must not
    // replace newer canonical content.
    expect(check(file(h("a"), 0o100644), file(h("a"), 0o100755), file(h("c")))).toBe(true);
    expect(check(file(h("a"), 0o100644), file(h("a"), 0o100755), file(h("a"), 0o100644))).toBe(false);
    expect(check(file(h("a"), 0o100644), file(h("a"), 0o100755), file(h("a"), 0o100600))).toBe(false);
    // Mode differences never make convergent or unchanged canonical content stale.
    expect(check(file(h("a")), file(h("b"), 0o100755), file(h("b"), 0o100644))).toBe(false);
    expect(check(file(h("a")), file(h("b")), file(h("a"), 0o100755))).toBe(false);
  });

  it("handles absent and unexpected entry states explicitly", () => {
    // Absent baseline: creating the entry is safe only while canonical has none.
    expect(check(undefined, file(h("b")), undefined)).toBe(false);
    expect(check(undefined, file(h("b")), file(h("c")))).toBe(true);
    expect(check(undefined, file(h("b")), file(h("b")))).toBe(false);
    // Absent current entry after a present baseline is a canonical change.
    expect(check(file(h("a")), file(h("b")), undefined)).toBe(true);
    // A deleted incoming entry differs from both; apply rejects it separately.
    expect(check(file(h("a")), undefined, file(h("c")))).toBe(true);
    expect(check(file(h("a")), undefined, file(h("a")))).toBe(false);
    // A non-file entry never matches file content.
    expect(check(file(h("a")), file(h("b")), { kind: "dir" })).toBe(true);
    expect(check({ kind: "dir" }, { kind: "dir" }, file(h("c")))).toBe(false);
  });
});

describe("stale instruction entry write-back", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let copies: ReturnType<typeof agentInstructionWorkingCopyService>;
  let revisions: ReturnType<typeof agentInstructionRevisionService>;
  const previousHome = process.env.PAPERCLIP_HOME;
  let home: string;
  let companyId: string, agentId: string, userId: string, root: string;
  const entryFile = "AGENTS.md";
  const target = () => ({ companyId, agentId });
  const board = () => ({ type: "board" as const, userId, source: "session" as const });
  const entryPath = () => path.join(root, entryFile);
  const readEntry = () => fs.readFile(entryPath(), "utf8");
  async function run(options: { warm?: boolean } = {}) {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, invocationSource: "on_demand", responsibleUserId: userId });
    return (await copies.prepare({ ...target(), runId, cwd: home, ...options }))!;
  }
  /** The managed PUT for the entry: a content-addressed CAS commit under the agent row lock. */
  async function managedSave(content: string) {
    const bytes = await fs.readFile(entryPath()).catch(() => null);
    return revisions.commit({ ...target(), entryFile, content, source: "board",
      baseRevisionId: bytes === null ? null : agentFileTokenFromHash(fileHash(bytes)) }, board());
  }
  async function tree() {
    const result: Record<string, string> = {};
    for (const [name, entry] of (await snapshotAgentFiles(root, false)).entries) result[name] = entry.kind === "file" ? entry.hash : entry.kind;
    return result;
  }
  const activityCount = async () => (await db.select().from(activityLog).where(eq(activityLog.entityId, agentId))).length;
  function expectNoSentinel(value: unknown) {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    for (const sentinel of SENTINELS) expect(text).not.toContain(sentinel);
  }
  function serializeLogCalls(spy: ReturnType<typeof vi.spyOn>) {
    return JSON.stringify(spy.mock.calls.map(args => args.map(arg => arg instanceof Error
      ? { name: arg.name, message: arg.message, details: (arg as { details?: unknown }).details }
      : arg && typeof arg === "object" && "err" in arg
        ? { ...arg, err: arg.err instanceof Error ? { message: arg.err.message, details: (arg.err as { details?: unknown }).details } : arg.err }
        : arg)));
  }
  async function expectRejected(runId: string) {
    const row = (await copies.get(companyId, runId))!;
    expect(row).toMatchObject({ state: "unavailable", errorCode: AGENT_FILES_ENTRY_CONFLICT });
    expect(row.processStoppedAt).not.toBeNull();
    expectNoSentinel(row.errorMessage);
    expectNoSentinel(row.receipt);
    return row;
  }

  beforeAll(async () => {
    home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "stale-entry-")));
    process.env.PAPERCLIP_HOME = home;
    database = await startEmbeddedPostgresTestDatabase("stale-entry-db-");
    db = createDb(database.connectionString);
    revisions = agentInstructionRevisionService(db);
  }, 90_000);
  afterAll(async () => {
    if (previousHome === undefined) delete process.env.PAPERCLIP_HOME; else process.env.PAPERCLIP_HOME = previousHome;
    await database?.cleanup();
    if (home) await fs.rm(home, { recursive: true, force: true });
  });
  beforeEach(async () => {
    copies = agentInstructionWorkingCopyService(db);
    companyId = randomUUID(); agentId = randomUUID(); userId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Stale entry tests", issuePrefix: randomUUID().slice(0, 8) });
    await db.insert(authUsers).values({ id: userId, name: "Editor", email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    root = resolveManagedInstructionsRoot({ ...target(), id: agentId, name: "Target", adapterConfig: {} });
    await db.insert(agents).values({ id: agentId, companyId, name: "Target", adapterConfig: { instructionsBundleMode: "managed", instructionsRootPath: root, instructionsEntryFile: entryFile } });
    await db.insert(companyMemberships).values([
      { companyId, principalType: "user", principalId: userId, membershipRole: "operator" },
      { companyId, principalType: "agent", principalId: agentId, membershipRole: "member" },
    ]);
    await db.insert(principalPermissionGrants).values({ companyId, principalType: "user", principalId: userId, permissionKey: "agents:configure", scope: { agentIds: [agentId] } });
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(entryPath(), ORIGINAL);
    await fs.writeFile(path.join(root, "keep.txt"), "canonical keep\n");
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it("A/B: rejects a stale entry and the whole write-back, including unrelated changes", async () => {
    const copy = await run();
    await fs.writeFile(path.join(copy.localRoot, entryFile), STALE);
    await fs.writeFile(path.join(copy.localRoot, "unrelated.txt"), UNRELATED);
    await fs.rm(path.join(copy.localRoot, "keep.txt"));
    await managedSave(NEWER);
    const before = await tree();
    const activity = await activityCount();
    await copies.collectStopped({ companyId, runId: copy.runId });
    await expectRejected(copy.runId);
    expect(await readEntry()).toBe(NEWER);
    expect(await tree()).toEqual(before);
    await expect(fs.stat(path.join(root, "unrelated.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(path.join(root, "keep.txt"), "utf8")).toBe("canonical keep\n");
    // No candidate is retained: the temporary copy is gone and no save was audited.
    await expect(fs.stat(path.dirname(copy.localRoot))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await activityCount()).toBe(activity);
    expect((await copies.get(companyId, copy.runId))?.candidateBase64).toBeNull();
  });

  it("rejects at the shared apply boundary before touching files, with bounded details", async () => {
    const copy = await run();
    await fs.writeFile(path.join(copy.localRoot, entryFile), STALE);
    await fs.writeFile(path.join(copy.localRoot, "unrelated.txt"), UNRELATED);
    await managedSave(NEWER);
    const before = await tree();
    const baseline = parseDirectorySnapshot(copy.receipt?.baseline)!;
    const actor = { type: "agent" as const, companyId, agentId, runId: copy.runId, onBehalfOfUserId: userId };
    const error = await agentFileStore(db).apply({ ...target(), sourceDir: copy.localRoot, baseline }, actor).then(() => null, (caught: unknown) => caught);
    expect(error).toMatchObject({ status: 409, details: { code: AGENT_FILES_ENTRY_CONFLICT, path: entryFile } });
    expect(Object.keys((error as { details: object }).details).sort()).toEqual(["code", "path"]);
    expectNoSentinel((error as Error).message);
    expectNoSentinel((error as { details: unknown }).details);
    expect(await tree()).toEqual(before);
    // L: an interrupted rejection (no durable outcome yet) is re-evaluated, never applied.
    await copies.collectStopped({ companyId, runId: copy.runId });
    await expectRejected(copy.runId);
    await copies.collectStopped({ companyId, runId: copy.runId });
    await expectRejected(copy.runId);
    expect(await readEntry()).toBe(NEWER);
    expect(await tree()).toEqual(before);
  });

  it("C/D: keeps normal nonconflicting write-backs, including entry-untouched copies after a managed save", async () => {
    const editing = await run();
    await fs.writeFile(path.join(editing.localRoot, entryFile), STALE);
    await fs.writeFile(path.join(editing.localRoot, "notes.txt"), "notes\n");
    expect((await copies.collectStopped({ companyId, runId: editing.runId }))?.state).toBe("saved");
    expect(await readEntry()).toBe(STALE);
    expect(await fs.readFile(path.join(root, "notes.txt"), "utf8")).toBe("notes\n");

    const untouched = await run();
    await fs.writeFile(path.join(untouched.localRoot, "unrelated.txt"), UNRELATED);
    await managedSave(NEWER);
    expect((await copies.collectStopped({ companyId, runId: untouched.runId }))?.state).toBe("saved");
    expect(await readEntry()).toBe(NEWER);
    expect(await fs.readFile(path.join(root, "unrelated.txt"), "utf8")).toBe(UNRELATED);
  });

  it("E: accepts convergent entry content", async () => {
    const copy = await run();
    await fs.writeFile(path.join(copy.localRoot, entryFile), NEWER);
    await fs.writeFile(path.join(copy.localRoot, "unrelated.txt"), UNRELATED);
    await managedSave(NEWER);
    expect((await copies.collectStopped({ companyId, runId: copy.runId }))?.state).toBe("saved");
    expect(await readEntry()).toBe(NEWER);
    expect(await fs.readFile(path.join(root, "unrelated.txt"), "utf8")).toBe(UNRELATED);
  });

  it("F: handles deleted, absent-baseline and absent-current entries", async () => {
    // Deleted incoming entry keeps the existing whole-write rejection.
    const deleting = await run();
    await fs.rm(path.join(deleting.localRoot, entryFile));
    await fs.writeFile(path.join(deleting.localRoot, "unrelated.txt"), UNRELATED);
    expect((await copies.collectStopped({ companyId, runId: deleting.runId }))?.state).toBe("unavailable");
    expect(await readEntry()).toBe(ORIGINAL);
    await expect(fs.stat(path.join(root, "unrelated.txt"))).rejects.toMatchObject({ code: "ENOENT" });

    // Absent baseline: the copy may create the entry while canonical has none.
    await fs.rm(entryPath());
    const creating = await run();
    await fs.writeFile(path.join(creating.localRoot, entryFile), STALE);
    expect((await copies.collectStopped({ companyId, runId: creating.runId }))?.state).toBe("saved");
    expect(await readEntry()).toBe(STALE);

    // Absent baseline, but a managed save created the entry meanwhile.
    await fs.rm(entryPath());
    const racing = await run();
    await fs.writeFile(path.join(racing.localRoot, entryFile), STALE);
    await managedSave(NEWER);
    await copies.collectStopped({ companyId, runId: racing.runId });
    await expectRejected(racing.runId);
    expect(await readEntry()).toBe(NEWER);

    // Canonical entry absent after a present baseline is a canonical change.
    const orphan = await run();
    await fs.writeFile(path.join(orphan.localRoot, entryFile), STALE);
    await fs.rm(entryPath());
    await copies.collectStopped({ companyId, runId: orphan.runId });
    await expectRejected(orphan.runId);
    await expect(fs.stat(entryPath())).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a mode-only entry change that would replace newer canonical content", async () => {
    const copy = await run();
    await fs.chmod(path.join(copy.localRoot, entryFile), 0o755);
    await fs.writeFile(path.join(copy.localRoot, "unrelated.txt"), UNRELATED);
    await managedSave(NEWER);
    await copies.collectStopped({ companyId, runId: copy.runId });
    await expectRejected(copy.runId);
    expect(await readEntry()).toBe(NEWER);
    await expect(fs.stat(path.join(root, "unrelated.txt"))).rejects.toMatchObject({ code: "ENOENT" });

    const warm = await run({ warm: true });
    await fs.chmod(path.join(warm.localRoot, entryFile), 0o755);
    await managedSave(ORIGINAL);
    expect((await copies.checkpointWarm({ companyId, runId: warm.runId }))?.errorCode).toBe(AGENT_FILES_ENTRY_CONFLICT);
    expect(await readEntry()).toBe(ORIGINAL);
    await copies.collectStopped({ companyId, runId: warm.runId });
    await expectRejected(warm.runId);

    // With canonical content unchanged, a mode-only change still saves.
    const unchanged = await run();
    await fs.chmod(path.join(unchanged.localRoot, entryFile), 0o755);
    expect((await copies.collectStopped({ companyId, runId: unchanged.runId }))?.state).toBe("saved");
    expect(await readEntry()).toBe(ORIGINAL);
  });

  it("keeps a warm rejection terminal across unconfirmed-stop recovery", async () => {
    const copy = await run({ warm: true });
    await fs.writeFile(path.join(copy.localRoot, entryFile), STALE);
    await fs.writeFile(path.join(copy.localRoot, "unrelated.txt"), UNRELATED);
    await managedSave(NEWER);
    expect((await copies.checkpointWarm({ companyId, runId: copy.runId }))?.state).toBe("prepared");
    // A terminal run without process-stop proof moves the copy to pending
    // collection and replaces its error code.
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, copy.runId));
    copies = agentInstructionWorkingCopyService(db);
    await copies.recoverStopped();
    expect((await copies.get(companyId, copy.runId))).toMatchObject({ state: "pending_collection", errorCode: "INSTRUCTION_STOP_UNCONFIRMED" });
    // A rollback-like save restores the baseline. The rejected copy must still
    // never be re-evaluated or applied.
    await managedSave(ORIGINAL);
    await copies.collectStopped({ companyId, runId: copy.runId });
    await expectRejected(copy.runId);
    expect(await readEntry()).toBe(ORIGINAL);
    await expect(fs.stat(path.join(root, "unrelated.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(path.dirname(copy.localRoot))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("G: rejects the same way for a cancelled run", async () => {
    const copy = await run();
    await fs.writeFile(path.join(copy.localRoot, entryFile), STALE);
    await managedSave(NEWER);
    await db.update(heartbeatRuns).set({ status: "cancelled" }).where(eq(heartbeatRuns.id, copy.runId));
    await copies.collectStopped({ companyId, runId: copy.runId });
    await expectRejected(copy.runId);
    expect(await readEntry()).toBe(NEWER);
  });

  it("H: the recovery sweeper rejects a stopped stale copy and discards it", async () => {
    const copy = await run();
    await fs.writeFile(path.join(copy.localRoot, entryFile), STALE);
    await fs.writeFile(path.join(copy.localRoot, "unrelated.txt"), UNRELATED);
    await managedSave(NEWER);
    await db.update(heartbeatRuns).set({ status: "failed" }).where(eq(heartbeatRuns.id, copy.runId));
    await db.update(agentInstructionWorkingCopies).set({ processStoppedAt: new Date() }).where(eq(agentInstructionWorkingCopies.runId, copy.runId));
    copies = agentInstructionWorkingCopyService(db);
    await copies.recoverStopped();
    await expectRejected(copy.runId);
    expect(await readEntry()).toBe(NEWER);
    await expect(fs.stat(path.join(root, "unrelated.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(path.dirname(copy.localRoot))).rejects.toMatchObject({ code: "ENOENT" });
    await copies.recoverStopped();
    await expectRejected(copy.runId);
  });

  it("I: rejects a stale entry at the first warm checkpoint and never reapplies it", async () => {
    const copy = await run({ warm: true });
    await fs.writeFile(path.join(copy.localRoot, entryFile), STALE);
    await fs.writeFile(path.join(copy.localRoot, "unrelated.txt"), UNRELATED);
    await managedSave(NEWER);
    const failed = (await copies.checkpointWarm({ companyId, runId: copy.runId }))!;
    expect(failed).toMatchObject({ errorCode: AGENT_FILES_ENTRY_CONFLICT, processStoppedAt: null });
    expect(failed.receipt?.checkpointState).not.toBe("saved");
    expect(await copies.canReuseWarm(companyId, agentId, copy.runId)).toBe(false);
    expect(await readEntry()).toBe(NEWER);
    await expect(fs.stat(path.join(root, "unrelated.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    // K: a rollback-like managed update restores the baseline content. The
    // rejected copy must still never be reapplied by later checkpoints or stop.
    await managedSave(ORIGINAL);
    expect((await copies.checkpointWarm({ companyId, runId: copy.runId }))?.errorCode).toBe(AGENT_FILES_ENTRY_CONFLICT);
    await copies.collectStopped({ companyId, runId: copy.runId });
    await expectRejected(copy.runId);
    expect(await readEntry()).toBe(ORIGINAL);
    await expect(fs.stat(path.join(root, "unrelated.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(path.dirname(copy.localRoot))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("I: checkpoint advancement does not erase a later stale entry", async () => {
    const copy = await run({ warm: true });
    await fs.writeFile(path.join(copy.localRoot, "memory.txt"), "turn 1\n");
    expect((await copies.checkpointWarm({ companyId, runId: copy.runId }))?.state).toBe("warm_saved");
    // A managed save between turns is not visible in the live copy. The next
    // baseline is the copy's own checkpoint, not canonical storage.
    await managedSave(NEWER);
    await fs.writeFile(path.join(copy.localRoot, "memory.txt"), "turn 2\n");
    const second = (await copies.checkpointWarm({ companyId, runId: copy.runId }))!;
    expect(second).toMatchObject({ state: "warm_saved", errorCode: null });
    expect(await readEntry()).toBe(NEWER);
    await fs.writeFile(path.join(copy.localRoot, entryFile), STALE);
    await fs.writeFile(path.join(copy.localRoot, "memory.txt"), "turn 3\n");
    expect((await copies.checkpointWarm({ companyId, runId: copy.runId }))?.errorCode).toBe(AGENT_FILES_ENTRY_CONFLICT);
    expect(await readEntry()).toBe(NEWER);
    expect(await fs.readFile(path.join(root, "memory.txt"), "utf8")).toBe("turn 2\n");
    await copies.collectStopped({ companyId, runId: copy.runId });
    await expectRejected(copy.runId);
    expect(await fs.readFile(path.join(root, "memory.txt"), "utf8")).toBe("turn 2\n");
  });

  it("I: a warm entry edit saved before a managed save still conflicts with a later copy edit", async () => {
    const copy = await run({ warm: true });
    await fs.writeFile(path.join(copy.localRoot, entryFile), "first run edit\n");
    expect((await copies.checkpointWarm({ companyId, runId: copy.runId }))?.state).toBe("warm_saved");
    await managedSave(NEWER);
    await fs.writeFile(path.join(copy.localRoot, entryFile), STALE);
    expect((await copies.checkpointWarm({ companyId, runId: copy.runId }))?.errorCode).toBe(AGENT_FILES_ENTRY_CONFLICT);
    await copies.collectStopped({ companyId, runId: copy.runId });
    await expectRejected(copy.runId);
    expect(await readEntry()).toBe(NEWER);
  });

  async function waitForLockWaiters(count: number) {
    for (let attempt = 0; attempt < 400; attempt++) {
      const rows = await db.execute(sql`select count(*)::int as n from pg_stat_activity where wait_event_type = 'Lock' and datname = current_database()`);
      if (Number((rows as unknown as Array<{ n: number }>)[0]?.n ?? 0) >= count) return;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error("Lock waiters did not appear");
  }
  async function race(first: "put" | "apply") {
    const copy = await run();
    await fs.writeFile(path.join(copy.localRoot, entryFile), STALE);
    await fs.writeFile(path.join(copy.localRoot, "unrelated.txt"), UNRELATED);
    let release!: () => void; let held!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const holding = new Promise<void>(resolve => { held = resolve; });
    const holder = db.transaction(async tx => {
      await tx.select().from(agents).where(eq(agents.id, agentId)).for("update");
      held();
      await gate;
    });
    await holding;
    const baseRevisionId = agentFileTokenFromHash(fileHash(Buffer.from(ORIGINAL)));
    const put = () => revisions.commit({ ...target(), entryFile, content: NEWER, source: "board", baseRevisionId }, board()).then(() => "ok", (error: { status?: number }) => error.status);
    const apply = () => copies.collectStopped({ companyId, runId: copy.runId }).then(row => row?.state);
    const results: Record<string, Promise<unknown>> = {};
    results[first] = first === "put" ? put() : apply();
    await waitForLockWaiters(1);
    const second = first === "put" ? "apply" : "put";
    results[second] = second === "put" ? put() : apply();
    await waitForLockWaiters(2);
    release();
    await holder;
    return { copy, put: await results.put, apply: await results.apply };
  }

  it("J: a managed save that wins the lock makes the concurrent write-back reject", async () => {
    const { copy, put, apply } = await race("put");
    expect(put).toBe("ok");
    expect(apply).toBe("unavailable");
    await expectRejected(copy.runId);
    expect(await readEntry()).toBe(NEWER);
    await expect(fs.stat(path.join(root, "unrelated.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("J: a write-back that wins the lock makes the concurrent stale managed save conflict", async () => {
    const { put, apply } = await race("apply");
    expect(apply).toBe("saved");
    expect(put).toBe(409);
    expect(await readEntry()).toBe(STALE);
    expect(await fs.readFile(path.join(root, "unrelated.txt"), "utf8")).toBe(UNRELATED);
  });

  it("K: a cold copy applies when managed saves restored the baseline content", async () => {
    const copy = await run();
    await fs.writeFile(path.join(copy.localRoot, entryFile), STALE);
    await managedSave(NEWER);
    await managedSave(ORIGINAL);
    expect((await copies.collectStopped({ companyId, runId: copy.runId }))?.state).toBe("saved");
    expect(await readEntry()).toBe(STALE);
  });

  it("M: rejection observability carries no instruction content", async () => {
    const warn = vi.spyOn(logger, "warn");
    const cold = await run();
    await fs.writeFile(path.join(cold.localRoot, entryFile), STALE);
    await fs.writeFile(path.join(cold.localRoot, "unrelated.txt"), UNRELATED);
    const warm = await run({ warm: true });
    await fs.writeFile(path.join(warm.localRoot, entryFile), STALE);
    await managedSave(NEWER);
    await copies.collectStopped({ companyId, runId: cold.runId });
    await copies.checkpointWarm({ companyId, runId: warm.runId });
    await copies.collectStopped({ companyId, runId: warm.runId });
    for (const runId of [cold.runId, warm.runId]) {
      const row = await expectRejected(runId);
      expect(row.errorMessage).toMatch(/^The instruction entry changed after this run's copy was prepared\./);
    }
    expect(warn).toHaveBeenCalled();
    const logged = serializeLogCalls(warn);
    expect(logged).toContain(AGENT_FILES_ENTRY_CONFLICT);
    expectNoSentinel(logged);
    const rows = await db.select().from(activityLog).where(eq(activityLog.entityId, agentId));
    expectNoSentinel(rows.map(row => row.details));
  });
});
