// WS-2 PR-W2: versioned instruction generations (spec rev 3, D1-D8). Real
// services on embedded PostgreSQL, mkdtemp roots and synthetic content only.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  activityLog, agentInstructionWorkingCopies, agents, authUsers, companies, companyMemberships, createDb,
  heartbeatRuns, principalPermissionGrants,
} from "@paperclipai/db";
import { AGENT_FILES_CONTRACT, agentFileStore, fileHash, snapshotAgentFiles } from "../services/agent-file-store.js";
import { agentInstructionWorkingCopyService } from "../services/agent-instruction-working-copies.js";
import {
  agentInstructionsBundleMode, agentInstructionsService, deriveBundleState, resolveAgentFileSyncDirectory,
  resolveInstructionVersionRoot, resolveLegacyManagedInstructionsRoot, resolveManagedInstructionsRoot,
  INSTRUCTION_BUNDLE_REPLACE_UNSUPPORTED, resolveInstructionWriteTarget,
} from "../services/agent-instructions.js";
import {
  ACTIVATION_BLOCKING_COPY_STATES, INSTRUCTION_GENERATION_ACTIVATED_ACTION, instructionActivationService,
  instructionActivationTestHooks, instructionGenerationStatus, instructionStagingReceiptsDirectory,
} from "../services/instruction-generation-activation.js";
import { agentService } from "../services/agents.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const ENTRY = "SENTINEL-W2-ENTRY\n";
const PERSONAL = "SENTINEL-W2-PERSONAL\n";
const BINARY = Buffer.from([0, 1, 2, 255, 254, 0, 7]);
type Failure = { status?: number; code?: string; details: Record<string, unknown> };
const settle = <T>(promise: Promise<T>): Promise<{ ok: true; value: T } | ({ ok: false } & Failure)> => promise.then(
  (value) => ({ ok: true as const, value }),
  (error: any) => ({ ok: false as const, status: error?.status, code: error?.details?.code, details: error?.details ?? {} }));

describe("versioned instruction generations (WS-2 PR-W2)", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let home: string;
  let companyId: string, agentId: string, userId: string;
  const board = () => ({ type: "board" as const, userId, source: "session" as const });
  const loadAgent = async (id = agentId) => (await db.select().from(agents).where(eq(agents.id, id)))[0]!;
  const read = (root: string, rel: string) => fs.readFile(path.join(root, rel), "utf8").catch(() => null);
  const cfg = (root: string, entry = "AGENTS.md") => ({
    instructionsBundleMode: "managed", instructionsRootPath: root, instructionsEntryFile: entry, instructionsFilePath: path.join(root, entry) });
  const legacyRoot = () => resolveLegacyManagedInstructionsRoot({ id: agentId, companyId });
  const receipts = async () => (await fs.readdir(instructionStagingReceiptsDirectory()).catch(() => [] as string[])).sort();
  const versions = async () => (await fs.readdir(path.join(path.dirname(legacyRoot()), "instruction-versions")).catch(() => [] as string[])).sort();

  /** A legacy managed agent with an entry, a personal note and a binary file. */
  async function seedLegacyHome() {
    const root = legacyRoot();
    await db.update(agents).set({ adapterConfig: cfg(root) }).where(eq(agents.id, agentId));
    await fs.mkdir(path.join(root, "notes"), { recursive: true });
    await fs.writeFile(path.join(root, "AGENTS.md"), ENTRY);
    await fs.writeFile(path.join(root, "notes/personal.md"), PERSONAL);
    await fs.writeFile(path.join(root, "data.bin"), BINARY);
    return root;
  }
  const materialize = (files: Record<string, string>, options?: { replaceExisting?: boolean }) =>
    settle(loadAgent().then((agent) => agentInstructionsService(db).materializeManagedBundle(agent, files, { ...options })));
  /** The generic engine with a declared-paths overlay, like a stock reset. */
  const activateOverlay = (overlay: Record<string, string>, extra?: Parameters<ReturnType<typeof instructionActivationService>["activate"]>[0] extends infer S ? Partial<S> : never) =>
    settle(instructionActivationService(db).activate({
      companyId, agentId, kind: "builtin_reset", isInstanceAdmin: true,
      activity: { actorType: "user", actorId: userId },
      identity: async () => ({}),
      plan: async (_tx, current) => ({ overlay: new Map(Object.entries(overlay).map(([k, v]) => [k, Buffer.from(v)])),
        entryFile: deriveBundleState(current).entryFile }),
      ...(extra ?? {}),
    } as Parameters<ReturnType<typeof instructionActivationService>["activate"]>[0]));
  async function insertRun() {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, invocationSource: "on_demand", responsibleUserId: userId });
    return runId;
  }

  beforeAll(async () => {
    home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "w2-generations-")));
    process.env.PAPERCLIP_HOME = home;
    database = await startEmbeddedPostgresTestDatabase("w2-generations-db-");
    db = createDb(database.connectionString);
  }, 90_000);
  afterAll(async () => {
    await database?.cleanup();
    await fs.rm(home, { recursive: true, force: true });
  });
  afterEach(() => {
    for (const key of Object.keys(instructionActivationTestHooks)) delete (instructionActivationTestHooks as Record<string, unknown>)[key];
  });
  beforeEach(async () => {
    // Host free space varies; capacity is exercised explicitly below.
    instructionActivationTestHooks.statfs = async () => ({ bsize: 4096, blocks: 1 << 24, bavail: 1 << 23, files: 1 << 20, ffree: 1 << 20 });
    companyId = randomUUID(); agentId = randomUUID(); userId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "W2", issuePrefix: randomUUID().slice(0, 8) });
    await db.insert(authUsers).values({ id: userId, name: "Editor", email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companyMemberships).values([
      { companyId, principalType: "user", principalId: userId, membershipRole: "operator" },
      { companyId, principalType: "agent", principalId: agentId, membershipRole: "member" },
    ]);
    await db.insert(agents).values({ id: agentId, companyId, name: `W2-${agentId.slice(0, 4)}`, adapterType: "claude_local", adapterConfig: {} });
    await db.insert(principalPermissionGrants).values({ companyId, principalType: "user", principalId: userId, permissionKey: "agents:configure", scope: { agentIds: [agentId] } });
  });

  it("runs only on mkdtemp roots", () => {
    expect(legacyRoot().startsWith(home)).toBe(true);
  });

  describe("activation carries the whole agent home forward (Option B)", () => {
    it("materialize creates a generation with personal and binary files, retains the old one and a receipt", async () => {
      const root = await seedLegacyHome();
      const result = await materialize({ "AGENTS.md": ENTRY, "docs/declared.md": "DECLARED\n" });
      expect(result.ok).toBe(true);
      const agent = await loadAgent();
      expect(agent.instructionBundleId).toMatch(/^[0-9a-f-]{36}$/);
      const y = resolveManagedInstructionsRoot(agent);
      expect(y).toBe(resolveInstructionVersionRoot(agent, agent.instructionBundleId!));
      expect((agent.adapterConfig as Record<string, unknown>).instructionsRootPath).toBe(y);
      expect(await read(y, "notes/personal.md")).toBe(PERSONAL);
      expect(await fs.readFile(path.join(y, "data.bin"))).toEqual(BINARY);
      expect(await read(y, "docs/declared.md")).toBe("DECLARED\n");
      // D4: the old generation is retained untouched.
      expect(await read(root, "notes/personal.md")).toBe(PERSONAL);
      expect(await read(root, "docs/declared.md")).toBeNull();
      expect(await receipts()).toContain(`${agent.instructionBundleId}.json`);
      const receipt = JSON.parse(await fs.readFile(path.join(instructionStagingReceiptsDirectory(), `${agent.instructionBundleId}.json`), "utf8"));
      expect(receipt).toMatchObject({ operationId: agent.instructionBundleId, agentId, kind: "materialize", sourceGeneration: null });
      expect((await fs.stat(y)).mode & 0o777).toBe(0o700);
      const rows = await db.select().from(activityLog).where(and(eq(activityLog.entityId, agentId), eq(activityLog.action, INSTRUCTION_GENERATION_ACTIVATED_ACTION)));
      expect(rows).toHaveLength(1);
      expect(rows[0]!.details).toMatchObject({ stagingId: agent.instructionBundleId, sourceGeneration: null });
      expect(instructionGenerationStatus(agent, agent.instructionBundleId!)).toBe("active");
    });

    it("a reset overlay replaces only declared paths; an unchanged entry still moves to a new generation", async () => {
      await seedLegacyHome();
      expect((await materialize({ "AGENTS.md": ENTRY })).ok).toBe(true);
      const first = await loadAgent();
      const before = resolveManagedInstructionsRoot(first);
      await fs.writeFile(path.join(before, "notes/personal.md"), "EDITED-PERSONAL\n");
      const result = await activateOverlay({ "AGENTS.md": ENTRY, "skills/tool.md": "STOCK\n" });
      expect(result.ok).toBe(true);
      const second = await loadAgent();
      expect(second.instructionBundleId).not.toBe(first.instructionBundleId);
      const y = resolveManagedInstructionsRoot(second);
      expect(await read(y, "AGENTS.md")).toBe(ENTRY);
      expect(await read(y, "notes/personal.md")).toBe("EDITED-PERSONAL\n");
      expect(await read(y, "skills/tool.md")).toBe("STOCK\n");
      // The superseded generation reports an unknown prior outcome, never "failed".
      expect(instructionGenerationStatus(second, first.instructionBundleId!)).toBe("not_currently_active_outcome_unknown");
      expect(await versions()).toEqual([first.instructionBundleId, second.instructionBundleId].sort());
    });

    it("resolver: an older generation configured as the root is recovered to the current one", async () => {
      await seedLegacyHome();
      await materialize({ "AGENTS.md": ENTRY });
      const agent = await loadAgent();
      const stale = { ...agent, adapterConfig: cfg(legacyRoot()) };
      expect(agentInstructionsBundleMode(stale)).toBe("managed");
      expect((await resolveInstructionWriteTarget(stale)).rootPath).toBe(resolveManagedInstructionsRoot(agent));
      const fileOnly = { ...agent, adapterConfig: { instructionsFilePath: path.join(legacyRoot(), "AGENTS.md") } };
      expect(agentInstructionsBundleMode(fileOnly)).toBe("managed");
      expect(agentInstructionsBundleMode({ ...agent, adapterConfig: cfg(path.join(home, "elsewhere")) })).toBe("external");
      // The sync folder (marker, manifest cache, run copies) is shared by every generation.
      expect(resolveAgentFileSyncDirectory(agent)).toBe(path.join(path.dirname(legacyRoot()), "file-sync"));
    });
  });

  describe("interruption, revalidation and capacity (D1-R, D4, D7)", () => {
    it("a source change during staging refuses with SOURCE_CHANGED; the old generation stays active and Y is retained", async () => {
      const root = await seedLegacyHome();
      instructionActivationTestHooks.duringStaging = async () => { await fs.writeFile(path.join(root, "notes/late.md"), "LATE\n"); };
      const result = await activateOverlay({ "AGENTS.md": ENTRY });
      expect(result).toMatchObject({ ok: false, status: 409, code: "INSTRUCTION_ACTIVATION_SOURCE_CHANGED" });
      const agent = await loadAgent();
      expect(agent.instructionBundleId).toBeNull();
      expect(await read(root, "notes/late.md")).toBe("LATE\n");
      const staged = await versions();
      expect(staged).toHaveLength(1);
      expect(await receipts()).toContain(`${staged[0]}.json`);
      expect(instructionGenerationStatus(agent, staged[0]!)).toBe("not_currently_active_outcome_unknown");
    });

    it("a change to the staged folder before activation refuses with STAGING_CHANGED", async () => {
      await seedLegacyHome();
      instructionActivationTestHooks.afterStaging = async ({ stagingRoot }) => { await fs.writeFile(path.join(stagingRoot, "injected.md"), "X\n"); };
      const result = await activateOverlay({ "AGENTS.md": ENTRY });
      expect(result).toMatchObject({ ok: false, status: 409, code: "INSTRUCTION_ACTIVATION_STAGING_CHANGED" });
      expect((await loadAgent()).instructionBundleId).toBeNull();
    });

    it("a supported write between staging and activation refuses with SOURCE_CHANGED (stamps), not activating stale bytes", async () => {
      await seedLegacyHome();
      instructionActivationTestHooks.afterStaging = async () => {
        const write = await agentFileStore(db).write({ companyId, agentId, path: "notes/personal.md", bytes: Buffer.from("NEWER\n"), baseHash: fileHash(Buffer.from(PERSONAL)) }, board());
        expect(write.changed).toBe(true);
      };
      const result = await activateOverlay({ "AGENTS.md": ENTRY });
      expect(result).toMatchObject({ ok: false, status: 409, code: "INSTRUCTION_ACTIVATION_SOURCE_CHANGED" });
      expect(await read(legacyRoot(), "notes/personal.md")).toBe("NEWER\n");
    });

    it("an entry change between capture and activation refuses with GENERATION_CHANGED (identity tuple)", async () => {
      await seedLegacyHome();
      instructionActivationTestHooks.afterStaging = async () => {
        await db.update(agents).set({ adapterConfig: cfg(legacyRoot(), "notes/personal.md") }).where(eq(agents.id, agentId));
      };
      const result = await activateOverlay({ "AGENTS.md": ENTRY });
      expect(result).toMatchObject({ ok: false, status: 409, code: "INSTRUCTION_GENERATION_CHANGED" });
      expect((await loadAgent()).instructionBundleId).toBeNull();
    });

    it("an interrupted staging (thrown mid-way) keeps the old generation and retains Y and its receipt", async () => {
      await seedLegacyHome();
      instructionActivationTestHooks.duringStaging = async () => { throw Object.assign(new Error("ENOSPC: simulated"), { code: "ENOSPC" }); };
      const result = await activateOverlay({ "AGENTS.md": ENTRY });
      expect(result.ok).toBe(false);
      expect((await loadAgent()).instructionBundleId).toBeNull();
      expect(await versions()).toHaveLength(1);
      expect(await receipts()).toContain(`${(await versions())[0]}.json`);
    });

    it("D7: insufficient free space refuses before any receipt or folder", async () => {
      await seedLegacyHome();
      const receiptsBefore = await receipts();
      // 5 GiB volume with 1 GiB free: the 1 GiB minimum reserve leaves no room.
      instructionActivationTestHooks.statfs = async () => ({ bsize: 4096, blocks: (5 * 1024 ** 3) / 4096, bavail: (1024 ** 3) / 4096, files: 1000, ffree: 1000 });
      const result = await activateOverlay({ "AGENTS.md": ENTRY });
      expect(result).toMatchObject({ ok: false, status: 409, code: "INSTRUCTION_ACTIVATION_INSUFFICIENT_SPACE" });
      expect(await versions()).toEqual([]);
      expect(await receipts()).toEqual(receiptsBefore);
      // 10% of a 100 GiB volume is the larger reserve.
      instructionActivationTestHooks.statfs = async () => ({ bsize: 4096, blocks: (100 * 1024 ** 3) / 4096, bavail: (9 * 1024 ** 3) / 4096, files: 1000, ffree: 1000 });
      expect(await activateOverlay({ "AGENTS.md": ENTRY })).toMatchObject({ ok: false, code: "INSTRUCTION_ACTIVATION_INSUFFICIENT_SPACE" });
      instructionActivationTestHooks.statfs = async () => ({ bsize: 4096, blocks: (100 * 1024 ** 3) / 4096, bavail: (11 * 1024 ** 3) / 4096, files: 1000, ffree: 1000 });
      expect((await activateOverlay({ "AGENTS.md": ENTRY })).ok).toBe(true);
    });

    it("unsupported content (a symlink) fails closed before staging", async () => {
      const root = await seedLegacyHome();
      await fs.symlink("/etc/hostname", path.join(root, "link"));
      const result = await activateOverlay({ "AGENTS.md": ENTRY });
      expect(result).toMatchObject({ ok: false, status: 422 });
      expect(await versions()).toEqual([]);
    });

    it("a declared path that is a folder in the home refuses without activating", async () => {
      await seedLegacyHome();
      const result = await activateOverlay({ "AGENTS.md": ENTRY, notes: "FILE\n" });
      expect(result).toMatchObject({ ok: false, status: 409, code: "INSTRUCTION_ACTIVATION_PATH_CONFLICT" });
    });
  });

  describe("quiescence (D2) and the copy generation fence (D3)", () => {
    it.each(ACTIVATION_BLOCKING_COPY_STATES)("an agent-directory copy in %s blocks activation; run ids only for admins", async (state) => {
      await seedLegacyHome();
      const runId = await insertRun();
      await db.insert(agentInstructionWorkingCopies).values({ runId, companyId, agentId, responsibleUserId: userId, entryFile: "AGENTS.md",
        baseHash: "x", localRoot: "/nonexistent", executionRoot: "/nonexistent", location: "local", state, receipt: { schema: AGENT_FILES_CONTRACT } });
      expect(await activateOverlay({ "AGENTS.md": ENTRY })).toMatchObject({ ok: false, status: 409, code: "INSTRUCTION_ACTIVATION_BUSY", details: { runIds: [runId] } });
      const nonAdmin = await activateOverlay({ "AGENTS.md": ENTRY }, { isInstanceAdmin: false });
      expect(nonAdmin).toMatchObject({ ok: false, code: "INSTRUCTION_ACTIVATION_BUSY" });
      expect((nonAdmin as Failure).details.runIds).toBeUndefined();
      expect((await loadAgent()).instructionBundleId).toBeNull();
    });

    it("a copy registered during staging is seen by the locked check", async () => {
      await seedLegacyHome();
      const runId = await insertRun();
      instructionActivationTestHooks.afterStaging = async () => {
        await db.insert(agentInstructionWorkingCopies).values({ runId, companyId, agentId, responsibleUserId: userId, entryFile: "AGENTS.md",
          baseHash: "preparing", localRoot: "/nonexistent", executionRoot: "/nonexistent", location: "local", state: "preparing", receipt: { schema: AGENT_FILES_CONTRACT } });
      };
      expect(await activateOverlay({ "AGENTS.md": ENTRY })).toMatchObject({ ok: false, code: "INSTRUCTION_ACTIVATION_BUSY" });
    });

    it("legacy entry-only rows do not block activation", async () => {
      await seedLegacyHome();
      const runId = await insertRun();
      await db.insert(agentInstructionWorkingCopies).values({ runId, companyId, agentId, responsibleUserId: userId, entryFile: "AGENTS.md",
        baseHash: "x", localRoot: "/nonexistent", executionRoot: "/nonexistent", location: "local", state: "prepared" });
      expect((await activateOverlay({ "AGENTS.md": ENTRY })).ok).toBe(true);
    });

    it("a stale-generation write-back is refused before adoption or any write, with a terminal code", async () => {
      const root = await seedLegacyHome();
      const baseline = await snapshotAgentFiles(root);
      const source = await fs.mkdtemp(path.join(home, "src-"));
      await fs.cp(root, source, { recursive: true });
      await fs.writeFile(path.join(source, "notes/personal.md"), "RUN-EDIT\n");
      expect((await activateOverlay({ "AGENTS.md": ENTRY })).ok).toBe(true);
      const markerBefore = await fs.readdir(resolveAgentFileSyncDirectory({ id: agentId, companyId })).catch(() => []);
      const result = await settle(agentFileStore(db).apply({ companyId, agentId, sourceDir: source, baseline, expectedGeneration: null },
        { type: "agent", companyId, agentId, runId: await insertRun(), onBehalfOfUserId: userId }));
      expect(result).toMatchObject({ ok: false, status: 409, code: "AGENT_FILES_GENERATION_CHANGED" });
      const y = resolveManagedInstructionsRoot(await loadAgent());
      expect(await read(y, "notes/personal.md")).toBe(PERSONAL);
      expect(await read(root, "notes/personal.md")).toBe(PERSONAL);
      expect(await fs.readdir(resolveAgentFileSyncDirectory({ id: agentId, companyId })).catch(() => [])).toEqual(markerBefore);
    });

    it("a directory copy records its generation from the locked row; write-back lands in that generation", async () => {
      await seedLegacyHome();
      expect((await materialize({ "AGENTS.md": ENTRY })).ok).toBe(true);
      const agent = await loadAgent();
      const copies = agentInstructionWorkingCopyService(db);
      const runId = await insertRun();
      const copy = (await copies.prepare({ companyId, agentId, runId, cwd: home }))!;
      expect(copy.instructionBundleId).toBe(agent.instructionBundleId);
      expect(copy.localRoot.startsWith(resolveAgentFileSyncDirectory(agent))).toBe(true);
      expect(await read(copy.localRoot, "notes/personal.md")).toBe(PERSONAL);
      // While prepared, no activation may happen.
      expect(await activateOverlay({ "AGENTS.md": ENTRY })).toMatchObject({ ok: false, code: "INSTRUCTION_ACTIVATION_BUSY" });
      await fs.writeFile(path.join(copy.localRoot, "notes/personal.md"), "RUN-EDIT\n");
      const collected = await copies.collectStopped({ companyId, runId });
      expect(collected?.state).toBe("saved");
      expect(await read(resolveManagedInstructionsRoot(agent), "notes/personal.md")).toBe("RUN-EDIT\n");
      expect(await read(legacyRoot(), "notes/personal.md")).toBe(PERSONAL);
    });

    it("a directory copy whose generation was superseded is rejected terminally at collection", async () => {
      await seedLegacyHome();
      const copies = agentInstructionWorkingCopyService(db);
      const runId = await insertRun();
      const copy = (await copies.prepare({ companyId, agentId, runId, cwd: home }))!;
      expect(copy.instructionBundleId).toBeNull();
      await fs.writeFile(path.join(copy.localRoot, "notes/personal.md"), "RUN-EDIT\n");
      // Simulate an activation that bypassed quiescence (defense in depth).
      await db.update(agents).set({ instructionBundleId: randomUUID() }).where(eq(agents.id, agentId));
      const collected = await copies.collectStopped({ companyId, runId });
      expect(collected).toMatchObject({ state: "unavailable", errorCode: "AGENT_FILES_GENERATION_CHANGED" });
      expect(await read(legacyRoot(), "notes/personal.md")).toBe(PERSONAL);
    });

    it("legacy entry copies: an unchanged entry with a new generation is preserved as a conflict, not committed", async () => {
      await seedLegacyHome();
      const copies = agentInstructionWorkingCopyService(db);
      const runId = await insertRun();
      const workspace = await fs.mkdtemp(path.join(home, "ws-"));
      const copy = (await copies.prepare({ companyId, agentId, runId, cwd: workspace, legacy: true }))!;
      expect(copy.instructionBundleId).toBeNull();
      // Unchanged entry, changed sibling: the activation adds no entry revision.
      expect((await activateOverlay({ "AGENTS.md": ENTRY, "notes/personal.md": "STOCK-NOTE\n" })).ok).toBe(true);
      await fs.chmod(path.join(copy.localRoot, "AGENTS.md"), 0o600);
      await fs.writeFile(path.join(copy.localRoot, "AGENTS.md"), "RUN-ENTRY-EDIT\n");
      const collected = await copies.collectStopped({ companyId, runId });
      expect(collected).toMatchObject({ state: "conflict", errorCode: "AGENT_FILES_GENERATION_CHANGED" });
      expect(Buffer.from(collected!.candidateBase64!, "base64").toString("utf8")).toBe("RUN-ENTRY-EDIT\n");
      expect(await read(resolveManagedInstructionsRoot(await loadAgent()), "AGENTS.md")).toBe(ENTRY);
    });
  });

  describe("exclusivity (D6) and import-with-replace (D5(c))", () => {
    it("the final locked exclusivity check refuses a staged root claimed by another agent meanwhile", async () => {
      await seedLegacyHome();
      const other = randomUUID();
      await db.insert(agents).values({ id: other, companyId, name: "Other", adapterConfig: {} });
      instructionActivationTestHooks.afterStaging = async ({ stagingRoot }) => {
        await db.update(agents).set({ adapterConfig: cfg(stagingRoot) }).where(eq(agents.id, other));
      };
      expect(await activateOverlay({ "AGENTS.md": ENTRY })).toMatchObject({ ok: false, status: 409, code: "INSTRUCTION_ROOT_IN_USE" });
      expect((await loadAgent()).instructionBundleId).toBeNull();
    });

    it("replaceExisting keeps the legacy in-place behavior for an unversioned agent", async () => {
      const root = await seedLegacyHome();
      const result = await materialize({ "AGENTS.md": ENTRY, "fresh.md": "FRESH\n" }, { replaceExisting: true });
      expect(result.ok).toBe(true);
      expect((await loadAgent()).instructionBundleId).toBeNull();
      expect(await read(root, "fresh.md")).toBe("FRESH\n");
      expect(await read(root, "notes/personal.md")).toBeNull();
    });

    it("replaceExisting on a versioned agent is refused with 409 and changes nothing", async () => {
      await seedLegacyHome();
      await materialize({ "AGENTS.md": ENTRY });
      const before = await loadAgent();
      const result = await materialize({ "AGENTS.md": ENTRY, "fresh.md": "FRESH\n" }, { replaceExisting: true });
      expect(result).toMatchObject({ ok: false, status: 409, code: INSTRUCTION_BUNDLE_REPLACE_UNSUPPORTED });
      const after = await loadAgent();
      expect(after.instructionBundleId).toBe(before.instructionBundleId);
      expect(await read(resolveManagedInstructionsRoot(after), "notes/personal.md")).toBe(PERSONAL);
      expect(await read(resolveManagedInstructionsRoot(after), "fresh.md")).toBeNull();
    });

    it("adoption runs first as its own transaction and is reported even when activation is refused", async () => {
      await seedLegacyHome();
      const marker = path.join(resolveAgentFileSyncDirectory({ id: agentId, companyId }), "adopted.json");
      expect(await fs.stat(marker).catch(() => null)).toBeNull();
      instructionActivationTestHooks.duringStaging = async () => { throw Object.assign(new Error("simulated"), { code: "EIO" }); };
      const runId = await insertRun();
      await db.insert(agentInstructionWorkingCopies).values({ runId, companyId, agentId, responsibleUserId: userId, entryFile: "AGENTS.md",
        baseHash: "x", localRoot: "/nonexistent", executionRoot: "/nonexistent", location: "local", state: "prepared", receipt: { schema: AGENT_FILES_CONTRACT } });
      const refused = await activateOverlay({ "AGENTS.md": ENTRY });
      expect(refused).toMatchObject({ ok: false, code: "INSTRUCTION_ACTIVATION_BUSY", details: { adoption: "adopted" } });
      expect(await fs.stat(marker).catch(() => null)).not.toBeNull();
    });
  });

  describe("updateBundle switch into an empty managed folder", () => {
    it("activates a generation from the external bundle and keeps the external source untouched", async () => {
      const ext = path.join(home, "ext", agentId);
      await fs.mkdir(ext, { recursive: true });
      await fs.writeFile(path.join(ext, "AGENTS.md"), ENTRY);
      await fs.writeFile(path.join(ext, "guide.md"), "GUIDE\n");
      await db.update(agents).set({ adapterConfig: { ...cfg(ext), instructionsBundleMode: "external" } }).where(eq(agents.id, agentId));
      const stale = await loadAgent();
      const persisted: Record<string, unknown>[] = [];
      const result = await agentInstructionsService(db).updateBundle(stale, { mode: "managed" }, {
        expectedTarget: await resolveInstructionWriteTarget(stale), expectedConfigMode: agentInstructionsBundleMode(stale),
        isInstanceAdmin: true, actor: { actorType: "user", actorId: userId, runId: null },
        persist: async (tx, current, adapterConfig) => {
          persisted.push(adapterConfig);
          await agentService(tx as never).update(current.id, { adapterConfig }, { instructionConfigWrite: { keys: "all" } });
        },
      });
      const agent = await loadAgent();
      expect(agent.instructionBundleId).toBeTruthy();
      expect(persisted).toHaveLength(1);
      expect(result.bundle.rootPath).toBe(resolveManagedInstructionsRoot(agent));
      expect(await read(resolveManagedInstructionsRoot(agent), "guide.md")).toBe("GUIDE\n");
      expect(await read(ext, "guide.md")).toBe("GUIDE\n");
      expect(await read(legacyRoot(), "guide.md")).toBeNull();
    });
  });
});
