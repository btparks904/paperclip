// Instructions bundle copy-and-switch (PATCH /agents/:id/instructions-bundle):
// locking, fail-closed copy, copy intents and completion evidence. Real services
// on embedded PostgreSQL, mkdtemp roots and synthetic sentinel content only.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  activityLog, agentConfigRevisions, agentInstructionHeads, agentInstructionRevisions, agents, authUsers, companies,
  companyMemberships, companySecrets, createDb, principalPermissionGrants, type Db,
} from "@paperclipai/db";
import { agentFileStore, fileHash } from "../services/agent-file-store.js";
import { agentInstructionRevisionService } from "../services/agent-instruction-revisions.js";
import {
  agentInstructionsBundleMode, agentInstructionsService, INSTRUCTION_BUNDLE_COPY_COMPLETED_ACTION,
  instructionCopyIntentsDirectory, resolveInstructionWriteTarget, resolveManagedInstructionsRoot,
  type InstructionConfigPersist, type UpdateBundleInput, type UpdateBundleOptions,
} from "../services/agent-instructions.js";
import { instructionPathKey } from "../services/agent-instruction-files.js";
import { agentService } from "../services/agents.js";
import { secretService } from "../services/secrets.js";
import { buildHostServices } from "../services/plugin-host-services.js";
import { activityRoutes } from "../routes/activity.js";
import { errorHandler } from "../middleware/index.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const ENTRY = "SENTINEL-SWITCH-ENTRY-OLD\n";
const ENTRY_NEW = "SENTINEL-SWITCH-ENTRY-NEW\n";
const NOTE = "notes/plan.md";
const NOTE_OLD = "SENTINEL-SWITCH-NOTE-OLD\n";
const NOTE_NEW = "SENTINEL-SWITCH-NOTE-NEW\n";
const RAW_API_KEY = "SENTINEL-SYNTHETIC-RAW-API-KEY-SWITCH";
const COPY_INCOMPLETE = "INSTRUCTION_BUNDLE_COPY_INCOMPLETE";
const MODE_CHANGED = "The instructions bundle mode changed; reload and retry";
const hashOf = (content: string | Buffer) => fileHash(Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8"));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const errno = (code: string) => Object.assign(new Error(`${code}: simulated`), { code });
type Settled = { ok: true; value: Awaited<ReturnType<ReturnType<typeof agentInstructionsService>["updateBundle"]>> }
  | { ok: false; status?: number; code?: string; message: string; details: Record<string, unknown> };

describe("instructions bundle copy-and-switch", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let home: string;
  let companyId: string, agentId: string, userId: string, managedRoot: string, ext: string;
  const board = () => ({ type: "board" as const, userId, source: "session" as const });
  const cfg = (mode: "managed" | "external", root: string, entry = "AGENTS.md") => ({
    instructionsBundleMode: mode, instructionsRootPath: root, instructionsEntryFile: entry, instructionsFilePath: path.join(root, entry) });
  const loadAgent = async (id = agentId) => (await db.select().from(agents).where(eq(agents.id, id)))[0]!;
  const configOf = async (id = agentId) => (await loadAgent(id)).adapterConfig as Record<string, unknown>;
  const read = (root: string, rel = NOTE) => fs.readFile(path.join(root, rel), "utf8").catch(() => null);
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
  const intents = async () => (await fs.readdir(instructionCopyIntentsDirectory()).catch(() => [] as string[])).sort();
  const readIntent = async (name: string) => JSON.parse(await fs.readFile(path.join(instructionCopyIntentsDirectory(), name), "utf8"));
  const completionRows = () => db.select().from(activityLog).where(and(eq(activityLog.companyId, companyId), eq(activityLog.action, INSTRUCTION_BUNDLE_COPY_COMPLETED_ACTION)));

  const persistOn = (source = "instructions_bundle_patch"): InstructionConfigPersist => async (tx, current, adapterConfig) => {
    const txDb = tx as unknown as Db;
    const normalized = await secretService(txDb).normalizeAdapterConfigForPersistence(current.companyId, adapterConfig,
      { strictMode: false, adapterType: current.adapterType ?? "process" });
    await agentService(txDb).update(current.id, { adapterConfig: normalized },
      { recordRevision: { createdByAgentId: null, createdByUserId: userId, source } });
  };
  async function optionsFor(stale: Awaited<ReturnType<typeof loadAgent>>, overrides: Partial<UpdateBundleOptions> = {}): Promise<UpdateBundleOptions> {
    return {
      expectedTarget: await resolveInstructionWriteTarget(stale),
      expectedConfigMode: agentInstructionsBundleMode(stale),
      persist: persistOn(),
      isInstanceAdmin: true,
      actor: { actorType: "user", actorId: userId, runId: null },
      ...overrides,
    };
  }
  async function patch(body: UpdateBundleInput, overrides: Partial<UpdateBundleOptions> = {},
    stale?: Awaited<ReturnType<typeof loadAgent>>, id = agentId): Promise<Settled> {
    const agent = stale ?? await loadAgent(id);
    return agentInstructionsService(db).updateBundle(agent, body, await optionsFor(agent, overrides)).then(
      (value) => ({ ok: true as const, value }),
      (error: any) => ({ ok: false as const, status: error?.status, code: error?.details?.code ?? error?.code, message: String(error?.message), details: error?.details ?? {} }));
  }
  async function seedAgent(id: string, adapterConfig: Record<string, unknown>) {
    await db.insert(agents).values({ id, companyId, name: `T-${id.slice(0, 4)}`, adapterConfig });
    if (id !== agentId) return;
    await db.insert(principalPermissionGrants).values({ companyId, principalType: "user", principalId: userId, permissionKey: "agents:configure", scope: { agentIds: [id] } });
  }
  async function seedSource(root: string, files: Record<string, string | Buffer> = { "AGENTS.md": ENTRY, [NOTE]: NOTE_OLD }) {
    for (const [rel, content] of Object.entries(files)) {
      await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
      await fs.writeFile(path.join(root, rel), content);
    }
  }
  /** G-INV: the old config is active and source bytes are untouched. */
  async function expectUnswitched(before: Record<string, unknown>, sourceRoot: string, sourceFiles: Record<string, string>) {
    expect(await configOf()).toEqual(before);
    for (const [rel, content] of Object.entries(sourceFiles)) expect(await read(sourceRoot, rel)).toBe(content);
  }
  /** Spy on fs.open; the hook may act before the real open of each path and flag. */
  function spyOpen(hook: (file: string, flags: unknown) => Promise<void> | void) {
    const real = fs.open.bind(fs);
    return vi.spyOn(fs, "open").mockImplementation((async (file: Parameters<typeof fs.open>[0], flags?: Parameters<typeof fs.open>[1], mode?: Parameters<typeof fs.open>[2]) => {
      await hook(String(file), flags);
      return real(file, flags, mode);
    }) as typeof fs.open);
  }
  const isDestWrite = (file: string, flags: unknown, root = ext) => flags === "wx" && file.startsWith(`${root}${path.sep}`);

  beforeAll(async () => {
    home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "bundle-switch-")));
    process.env.PAPERCLIP_HOME = home;
    database = await startEmbeddedPostgresTestDatabase("bundle-switch-db-");
    db = createDb(database.connectionString);
  }, 90_000);
  afterAll(async () => {
    await database?.cleanup();
    await fs.rm(home, { recursive: true, force: true });
  });
  afterEach(() => { vi.restoreAllMocks(); });
  beforeEach(async () => {
    await fs.rm(instructionCopyIntentsDirectory(), { recursive: true, force: true });
    companyId = randomUUID(); agentId = randomUUID(); userId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Switch", issuePrefix: randomUUID().slice(0, 8) });
    await db.insert(authUsers).values({ id: userId, name: "Editor", email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companyMemberships).values([{ companyId, principalType: "user", principalId: userId, membershipRole: "operator" }]);
    managedRoot = resolveManagedInstructionsRoot({ companyId, id: agentId, name: "T", adapterConfig: {} });
    ext = path.join(home, "ext", agentId);
    await seedAgent(agentId, cfg("managed", managedRoot));
    await seedSource(managedRoot);
  });

  it("G8: runs only on mkdtemp roots with synthetic content", () => {
    expect(home.startsWith(fsRealTmp())).toBe(true);
    expect(managedRoot.startsWith(home)).toBe(true);
    expect(ext.startsWith(home)).toBe(true);
  });

  describe("locking and authorization (P2 to P6, config-only mode)", () => {
    /** Run `during` while the PATCH holds the agent row lock, inside persist. */
    async function patchWithWriter(body: UpdateBundleInput, during: () => Promise<unknown>, stale?: Awaited<ReturnType<typeof loadAgent>>) {
      let writer: Promise<unknown> | null = null;
      let blockedWhileLocked: boolean | null = null;
      const result = await patch(body, {
        persist: async (tx, current, adapterConfig) => {
          let done = false;
          writer = during().then((value) => { done = true; return { ok: value }; }, (error) => { done = true; return { error }; });
          await sleep(300);
          blockedWhileLocked = !done;
          await persistOn()(tx, current, adapterConfig);
        },
      }, stale);
      return { result, writer: (await (writer as unknown as Promise<unknown>)) as { ok?: unknown; error?: any }, blockedWhileLocked };
    }

    it("P2: a store save of a note waits for the switch and is then refused, not lost", async () => {
      const run = await patchWithWriter({ mode: "external", rootPath: ext }, () =>
        agentFileStore(db).write({ companyId, agentId, path: NOTE, bytes: Buffer.from(NOTE_NEW), baseHash: hashOf(NOTE_OLD) }, board()));
      expect(run.result.ok).toBe(true);
      expect(run.blockedWhileLocked).toBe(true);
      expect(run.writer.error?.status).toBe(422);
      expect(await read(ext)).toBe(NOTE_OLD);
      expect(await read(managedRoot)).toBe(NOTE_OLD);
    });

    it("P2e: a canonical entry commit waits for the switch and is then refused", async () => {
      const revisions = agentInstructionRevisionService(db);
      const current = await revisions.readCurrent({ companyId, agentId }, board());
      const run = await patchWithWriter({ mode: "external", rootPath: ext }, () =>
        revisions.commit({ companyId, agentId, entryFile: "AGENTS.md", content: ENTRY_NEW, baseRevisionId: current?.revision.id ?? null, source: "board" }, board()));
      expect(run.writer.error?.status).toBe(422);
      expect(await read(ext, "AGENTS.md")).toBe(ENTRY);
      expect(await read(managedRoot, "AGENTS.md")).toBe(ENTRY);
    });

    it("P3: an unversioned PUT persists on the locked row and cannot revert a queued switch", async () => {
      await seedSource(ext);
      await db.update(agents).set({ adapterConfig: cfg("external", ext) }).where(eq(agents.id, agentId));
      const stale = await loadAgent();
      const target = await resolveInstructionWriteTarget(stale);
      const run = await patchWithWriter({ mode: "managed" }, () => agentInstructionsService(db).writeFile(stale, NOTE, NOTE_NEW, {
        expectedMode: "external", expectedTarget: target, persistConfig: persistOn("instructions_bundle_file_put") }), stale);
      expect(run.result.ok).toBe(true);
      expect(run.blockedWhileLocked).toBe(true);
      expect(run.writer.error).toMatchObject({ status: 409, message: MODE_CHANGED });
      expect((await configOf()).instructionsBundleMode).toBe("managed");
      expect(await read(ext)).toBe(NOTE_OLD);
      const revisions = await db.select().from(agentConfigRevisions).where(eq(agentConfigRevisions.agentId, agentId));
      expect(revisions.map((row) => row.source)).toEqual(["instructions_bundle_patch"]);
    });

    it("P4: the legacy clear is a locked read-modify-write and keeps a committed switch", async () => {
      await db.update(agents).set({ adapterConfig: { ...cfg("managed", managedRoot), promptTemplate: "legacy" } }).where(eq(agents.id, agentId));
      expect((await patch({ mode: "external", rootPath: ext })).ok).toBe(true);
      // The route's W3 shape: lock, reread, clear, update on the same transaction.
      await db.transaction(async (tx) => {
        const [row] = await tx.select().from(agents).where(and(eq(agents.id, agentId), eq(agents.companyId, companyId))).for("update");
        const adapterConfig = { ...(row!.adapterConfig as Record<string, unknown>) };
        delete adapterConfig.promptTemplate;
        await agentService(tx as unknown as Db).update(agentId, { adapterConfig });
      });
      const final = await configOf();
      expect(final.instructionsBundleMode).toBe("external");
      expect("promptTemplate" in final).toBe(false);
    });

    it("P5: a PATCH authorized on a stale managed read is refused after an admin switched to external", async () => {
      const staleForEditor = await loadAgent();
      expect((await patch({ mode: "external", rootPath: ext })).ok).toBe(true);
      const result = await patch({ clearLegacyPromptTemplate: true }, { isInstanceAdmin: false }, staleForEditor);
      expect(result).toMatchObject({ ok: false, status: 409, message: MODE_CHANGED });
      expect((await configOf()).instructionsBundleMode).toBe("external");
    });

    it("P5b: a PATCH authorized on one external root is refused after an admin moved the agent to another", async () => {
      const extA = path.join(home, "extA", agentId);
      await seedSource(extA);
      await db.update(agents).set({ adapterConfig: cfg("external", extA) }).where(eq(agents.id, agentId));
      const staleForEditor = await loadAgent();
      const extB = path.join(home, "extB-moved", agentId);
      await seedSource(extB);
      expect((await patch({ mode: "external", rootPath: extB })).ok).toBe(true);
      const before = await configOf();
      // Same config-only mode (external) before and after; only the target moved.
      expect(agentInstructionsBundleMode(staleForEditor)).toBe(agentInstructionsBundleMode(await loadAgent()));
      const result = await patch({ entryFile: "notes/plan.md" }, { isInstanceAdmin: false }, staleForEditor);
      expect(result).toMatchObject({ ok: false, status: 409, message: MODE_CHANGED });
      expect(await configOf()).toEqual(before);
    });

    it("P3b: a PATCH queued behind an unversioned PUT is not reverted by that PUT's configuration", async () => {
      await seedSource(ext);
      await db.update(agents).set({ adapterConfig: cfg("external", ext) }).where(eq(agents.id, agentId));
      const stale = await loadAgent();
      const target = await resolveInstructionWriteTarget(stale);
      let queued: Promise<Settled> | null = null;
      const put = await agentInstructionsService(db).writeFile(stale, NOTE, NOTE_NEW, { expectedMode: "external", expectedTarget: target,
        persistConfig: async (tx, current, adapterConfig) => {
          queued = patch({ mode: "managed" }, {}, stale);
          await sleep(500);
          await persistOn("instructions_bundle_file_put")(tx, current, adapterConfig);
        } });
      expect(put).toBeTruthy();
      expect((await queued!).ok).toBe(true);
      expect((await configOf()).instructionsBundleMode).toBe("managed");
      expect(await read(ext)).toBe(NOTE_NEW);
    });

    it("refuses a config-only mode change under the lock even when the recovered target is equal", async () => {
      const routeRead = await loadAgent();
      // Same managed files on disk; the stored mode key is removed, so the
      // config-only classification changes while the recovered target does not.
      // Only the entry key is stored, so recovery yields the managed target
      // while the config-only classification is null.
      await db.update(agents).set({ adapterConfig: { instructionsEntryFile: "AGENTS.md" } }).where(eq(agents.id, agentId));
      const locked = await loadAgent();
      expect(await resolveInstructionWriteTarget(locked)).toEqual(await resolveInstructionWriteTarget(routeRead));
      expect(agentInstructionsBundleMode(locked)).not.toBe(agentInstructionsBundleMode(routeRead));
      const before = await configOf();
      const result = await patch({ mode: "external", rootPath: ext }, {}, routeRead);
      expect(result).toMatchObject({ ok: false, status: 409, message: MODE_CHANGED });
      expect(await configOf()).toEqual(before);
      expect(await ls(ext)).toEqual([]);
    });

    it("P6: a writer queued behind the switch sees the new row and records nothing", async () => {
      const extB = path.join(home, "extB", agentId);
      const run = await patchWithWriter({ mode: "external", rootPath: extB }, () =>
        agentFileStore(db).write({ companyId, agentId, path: "notes/new.md", bytes: Buffer.from(NOTE_NEW), baseHash: null }, board()));
      expect(run.blockedWhileLocked).toBe(true);
      expect(run.writer.error?.status).toBe(422);
      const activity = await db.select().from(activityLog).where(eq(activityLog.entityId, agentId));
      expect(activity.filter((row) => row.action === "agent.files_updated")).toHaveLength(0);
      expect(await read(extB, "notes/new.md")).toBeNull();
    });
  });

  describe("validate and persist before any write (H1, binary, limits, RD-1)", () => {
    it("H1a: a rejected persist writes nothing; after edits a retry activates the new content", async () => {
      await db.update(agents).set({ status: "pending_approval" }).where(eq(agents.id, agentId));
      const before = await configOf();
      const first = await patch({ mode: "external", rootPath: ext });
      expect(first).toMatchObject({ ok: false, status: 409, code: "pending_approval_agent_config_frozen" });
      expect(await ls(ext)).toEqual([]);
      expect(await intents()).toEqual([]);
      await expectUnswitched(before, managedRoot, { "AGENTS.md": ENTRY, [NOTE]: NOTE_OLD });
      await db.update(agents).set({ status: "idle" }).where(eq(agents.id, agentId));
      await agentFileStore(db).write({ companyId, agentId, path: NOTE, bytes: Buffer.from(NOTE_NEW), baseHash: hashOf(NOTE_OLD) }, board());
      const revisions = agentInstructionRevisionService(db);
      const current = await revisions.readCurrent({ companyId, agentId }, board());
      await revisions.commit({ companyId, agentId, entryFile: "AGENTS.md", content: ENTRY_NEW, baseRevisionId: current?.revision.id ?? null, source: "board" }, board());
      expect((await patch({ mode: "external", rootPath: ext })).ok).toBe(true);
      expect(await read(ext, "AGENTS.md")).toBe(ENTRY_NEW);
      expect(await read(ext)).toBe(NOTE_NEW);
    });

    it("H1b: a file over 1 MiB is refused before any write; a retry after the fix copies everything", async () => {
      await seedSource(managedRoot, { "aa-first.md": "first\n", "notes/zz-big.md": "x".repeat(2 * 1024 * 1024), "notes/zzz-after.md": "after\n" });
      const before = await configOf();
      const first = await patch({ mode: "external", rootPath: ext });
      expect(first).toMatchObject({ ok: false, status: 422, code: "INSTRUCTION_CONTENT_INVALID" });
      expect(await ls(ext)).toEqual([]);
      expect(await intents()).toEqual([]);
      expect(await configOf()).toEqual(before);
      await fs.rm(path.join(managedRoot, "notes/zz-big.md"));
      expect((await patch({ mode: "external", rootPath: ext })).ok).toBe(true);
      expect(await ls(ext)).toEqual(["AGENTS.md", "aa-first.md", NOTE, "notes/zzz-after.md"]);
    });

    it("H1c: a binary or invalid UTF-8 source file is refused before any write, never decoded lossily", async () => {
      for (const bytes of [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0a, 0xff, 0xfe]), Buffer.from([0x61, 0xc3, 0x28, 0x62])]) {
        await fs.writeFile(path.join(managedRoot, "asset.bin"), bytes);
        const result = await patch({ mode: "external", rootPath: ext });
        expect(result).toMatchObject({ ok: false, status: 422, code: "INSTRUCTION_CONTENT_INVALID" });
        expect(await ls(ext)).toEqual([]);
        expect(await intents()).toEqual([]);
        expect(await fs.readFile(path.join(managedRoot, "asset.bin"))).toEqual(bytes);
      }
    });

    it("H1d (test 6): a populated operator folder without an intent is adopted; files untouched, missing entry written", async () => {
      await seedSource(ext, { "README.txt": "SENTINEL-OPERATOR\n" });
      const result = await patch({ mode: "external", rootPath: ext });
      expect(result.ok).toBe(true);
      expect(await ls(ext)).toEqual(["AGENTS.md", "README.txt"]);
      expect(await read(ext, "README.txt")).toBe("SENTINEL-OPERATOR\n");
      expect(await read(ext, "AGENTS.md")).toBe(ENTRY);
      expect(await completionRows()).toHaveLength(0);
      expect(await intents()).toEqual([]);
    });

    it("H1e (test 7): a destination holding only folders counts as empty and gets a full copy", async () => {
      await fs.mkdir(path.join(ext, "empty/dir"), { recursive: true });
      expect((await patch({ mode: "external", rootPath: ext })).ok).toBe(true);
      expect(await ls(ext)).toEqual(["AGENTS.md", NOTE]);
      expect(await completionRows()).toHaveLength(1);
    });

    it("test 16: one nested real file makes the destination non-empty; with a copy record it is refused, not adopted", async () => {
      await seedSource(ext, { "deep/nested/real.md": "SENTINEL-NESTED\n" });
      const otherAgent = randomUUID();
      await seedAgent(otherAgent, cfg("managed", resolveManagedInstructionsRoot({ companyId, id: otherAgent, name: "T", adapterConfig: {} })));
      // A lingering record for this folder (another agent's failed copy).
      const identity = await fs.lstat(await fs.realpath(ext), { bigint: true });
      await fs.mkdir(instructionCopyIntentsDirectory(), { recursive: true });
      const operationId = randomUUID();
      await fs.writeFile(path.join(instructionCopyIntentsDirectory(), `${operationId}.json`), JSON.stringify({ version: 1, operationId, companyId,
        agentId: otherAgent, destination: { ino: identity.ino.toString(), dev: identity.dev.toString(), birthtimeNs: "0", canonicalPath: await fs.realpath(ext),
          pathKey: instructionPathKey(await fs.realpath(ext)) }, sourceRoot: null, plannedCount: 1, plannedBytes: 1, startedAt: new Date().toISOString() }));
      const before = await configOf();
      const result = await patch({ mode: "external", rootPath: ext });
      expect(result).toMatchObject({ ok: false, status: 409, code: COPY_INCOMPLETE });
      expect(await ls(ext)).toEqual(["deep/nested/real.md"]);
      expect(await configOf()).toEqual(before);
      expect(await intents()).toEqual([`${operationId}.json`]);
    });

    it("D3/D4 (test 14): the copy source is bounded by the store limits; the walk stops at the limit", async () => {
      // 100,000 entries pass; 100,001 are refused with the store's own error.
      const symlinks = path.join(managedRoot, "links");
      await fs.mkdir(symlinks);
      // Existing entries: AGENTS.md, notes, notes/plan.md, links = 4.
      const needed = 100_000 - 4;
      for (let index = 0; index < needed; index += 1000) {
        await Promise.all(Array.from({ length: Math.min(1000, needed - index) }, (_unused, offset) =>
          fs.symlink("target-does-not-exist", path.join(symlinks, `l${index + offset}`))));
      }
      expect((await patch({ mode: "external", rootPath: ext })).ok).toBe(true);
      expect(await ls(ext)).toEqual(["AGENTS.md", NOTE]);
      await db.update(agents).set({ adapterConfig: cfg("managed", managedRoot) }).where(eq(agents.id, agentId));
      await fs.symlink("target-does-not-exist", path.join(symlinks, "one-more"));
      const ext2 = path.join(home, "ext-limit", agentId);
      const refused = await patch({ mode: "external", rootPath: ext2 });
      expect(refused).toMatchObject({ ok: false, status: 422, code: "AGENT_FILES_LIMIT_EXCEEDED", message: "Agent directory exceeds the 100,000-entry limit (files and folders)" });
      expect(await ls(ext2)).toEqual([]);
      expect(await intents()).toEqual([]);
      await fs.rm(symlinks, { recursive: true, force: true });
      // Bytes: one file reported just over 2 GiB stops the walk with the store's byte error.
      const realLstat = fs.lstat.bind(fs);
      vi.spyOn(fs, "lstat").mockImplementation((async (file: Parameters<typeof fs.lstat>[0], options?: any) => {
        const stat = await realLstat(file, options);
        if (String(file) === path.join(managedRoot, NOTE)) return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { size: 2 * 1024 * 1024 * 1024 + 1 - ENTRY.length });
        return stat;
      }) as typeof fs.lstat);
      const bytes = await patch({ mode: "external", rootPath: ext2 });
      expect(bytes).toMatchObject({ ok: false, status: 422, code: "AGENT_FILES_LIMIT_EXCEEDED", message: "Agent directory exceeds the 2 GiB total storage limit" });
      expect(await ls(ext2)).toEqual([]);
    }, 120_000);

    describe("RD-1: names equivalent under instructionPathKey", () => {
      const cases: Array<[string, Record<string, string>]> = [
        ["case-only file names", { "notes/Plan.md": "a\n", "notes/plan.md": "b\n" }],
        ["Unicode-equivalent file names (NFC and NFD)", { "notes/café.md": "a\n", "notes/café.md": "b\n" }],
        ["case-only folder names", { "Docs/a.md": "a\n", "docs/b.md": "b\n" }],
        ["a file and a folder that fold together", { "guide": "a\n", "GUIDE/b.md": "b\n" }],
      ];
      for (const [label, files] of cases) {
        it(`N1: refuses ${label} before any intent, write or config change`, async () => {
          await fs.rm(managedRoot, { recursive: true, force: true });
          await seedSource(managedRoot, { "AGENTS.md": ENTRY, ...files });
          const before = await configOf();
          const result = await patch({ mode: "external", rootPath: ext });
          expect(result).toMatchObject({ ok: false, status: 422, code: "INSTRUCTION_BUNDLE_NAME_COLLISION" });
          expect(await intents()).toEqual([]);
          expect(await ls(ext)).toEqual([]);
          expect(await configOf()).toEqual(before);
          expect(await completionRows()).toHaveLength(0);
        });
      }
      it("N1: distinct non-entry names still copy", async () => {
        await seedSource(managedRoot, { "notes/plan-a.md": "a\n", "notes/plan-b.md": "b\n", "Docs/guide.md": "g\n" });
        expect((await patch({ mode: "external", rootPath: ext })).ok).toBe(true);
        expect(await ls(ext)).toEqual(["AGENTS.md", "Docs/guide.md", "notes/plan-a.md", "notes/plan-b.md", NOTE]);
      });
      it("N1: a requested entry that folds onto a copied file is part of the plan and refused", async () => {
        const result = await patch({ mode: "external", rootPath: ext, entryFile: "agents.md" });
        expect(result).toMatchObject({ ok: false, status: 422, code: "INSTRUCTION_BUNDLE_NAME_COLLISION" });
        expect(await ls(ext)).toEqual([]);
      });
    });
  });

  describe("entry checks (EC1, EC2) and exclusive missing-entry creation (W1)", () => {
    const seedHistory = async () => {
      const revisionId = randomUUID();
      await db.insert(agentInstructionRevisions).values({ id: revisionId, companyId, agentId, entryFile: "AGENTS.md",
        contentBase64: Buffer.from(ENTRY).toString("base64"), contentHash: hashOf(ENTRY), byteLength: ENTRY.length, source: "board" });
      await db.insert(agentInstructionHeads).values({ companyId, agentId, entryFile: "AGENTS.md", revisionId });
    };
    for (const variant of ["agents.md", "Agents.md", "AGENTS.md".normalize("NFD")]) {
      it(`EC1: a case variant of a versioned entry (${JSON.stringify(variant)}) is refused on a case-sensitive volume`, async () => {
        await seedHistory();
        const before = await configOf();
        const result = await patch({ mode: "managed", entryFile: variant === "AGENTS.md".normalize("NFD") ? "Agents.MD" : variant });
        expect(result).toMatchObject({ ok: false, status: 422, code: "INSTRUCTION_REVISION_REQUIRED" });
        expect(await ls(managedRoot)).toEqual(["AGENTS.md", NOTE]);
        expect(await configOf()).toEqual(before);
      });
    }
    it("EC1: the exact versioned entry still adopts without the history check", async () => {
      await seedHistory();
      expect((await patch({ mode: "managed", entryFile: "AGENTS.md" })).ok).toBe(true);
    });
    it("EC2: an unversioned case variant creates its own file and changes no existing file", async () => {
      const result = await patch({ mode: "managed", entryFile: "agents.md" });
      expect(result.ok).toBe(true);
      expect(await ls(managedRoot)).toEqual(["AGENTS.md", "agents.md", NOTE]);
      expect(await read(managedRoot, "AGENTS.md")).toBe(ENTRY);
      expect(await read(managedRoot, "agents.md")).toBe(ENTRY);
      expect((await configOf()).instructionsEntryFile).toBe("agents.md");
    });
    it("W1: an entry created by an outside writer before the entry write is kept byte for byte", async () => {
      await seedSource(ext, { "README.txt": "SENTINEL-OPERATOR\n" });
      const outside = "SENTINEL-OUTSIDE-ENTRY\n";
      const entryPath = path.join(ext, "AGENTS.md");
      let raced = 0;
      spyOpen(async (file, flags) => {
        if (file === entryPath && flags === "wx") { raced += 1; await fs.writeFile(entryPath, outside); }
      });
      const result = await patch({ mode: "external", rootPath: ext });
      expect(raced).toBe(1);
      expect(result.ok).toBe(true);
      expect(await read(ext, "AGENTS.md")).toBe(outside);
    });
  });

  describe("failure safety and copy intents (E4, G1 to G7, tests 1 to 10)", () => {
    const failNthDestWrite = (n: number, code = "EIO", root = ext) => {
      let count = 0;
      return spyOpen((file, flags) => { if (isDestWrite(file, flags, root) && ++count === n) throw errno(code); });
    };

    it("E4a (test 1, G1): EIO mid-copy leaves the old config and a record; retry 409; after the operator empties the folder, a full copy", async () => {
      const before = await configOf();
      failNthDestWrite(2);
      const first = await patch({ mode: "external", rootPath: ext });
      vi.restoreAllMocks();
      expect(first).toMatchObject({ ok: false, code: "EIO" });
      await expectUnswitched(before, managedRoot, { "AGENTS.md": ENTRY, [NOTE]: NOTE_OLD });
      expect((await ls(ext)).length).toBeGreaterThan(0);
      const [intentName] = await intents();
      const intent = await readIntent(intentName!);
      // G1: the record names this destination and this operation.
      const canonical = await fs.realpath(ext);
      const stat = await fs.lstat(canonical, { bigint: true });
      expect(intent).toMatchObject({ version: 1, companyId, agentId, destination: { ino: stat.ino.toString(), canonicalPath: canonical, pathKey: instructionPathKey(canonical) } });
      expect(intentName).toBe(`${intent.operationId}.json`);
      const retry = await patch({ mode: "external", rootPath: ext });
      expect(retry).toMatchObject({ ok: false, status: 409, code: COPY_INCOMPLETE, details: { completionHint: "not_completed", operationId: intent.operationId } });
      await expectUnswitched(before, managedRoot, { "AGENTS.md": ENTRY, [NOTE]: NOTE_OLD });
      // Operator recovery (a): empty the folder; this agent's stale record is then removed.
      for (const entry of await fs.readdir(ext)) await fs.rm(path.join(ext, entry), { recursive: true });
      failNthDestWrite(1);
      const again = await patch({ mode: "external", rootPath: ext });
      vi.restoreAllMocks();
      expect(again).toMatchObject({ ok: false, code: "EIO" });
      const [secondName] = await intents();
      expect(secondName).not.toBe(intentName);
      expect((await readIntent(secondName!)).operationId).not.toBe(intent.operationId);
      for (const entry of await fs.readdir(ext)) await fs.rm(path.join(ext, entry), { recursive: true });
      expect((await patch({ mode: "external", rootPath: ext })).ok).toBe(true);
      expect(await ls(ext)).toEqual(["AGENTS.md", NOTE]);
      expect(await read(ext)).toBe(NOTE_OLD);
      expect(await intents()).toEqual([]);
    });

    it("E4b (test 2): a commit failure after a full copy rolls back config and completion; a retry after a source edit is refused, never stale", async () => {
      const before = await configOf();
      let copied = false;
      spyOpen((file, flags) => { if (isDestWrite(file, flags)) copied = true; });
      const realLstat = fs.lstat.bind(fs);
      // getBundle runs after the completion insert, inside the transaction.
      vi.spyOn(fs, "lstat").mockImplementation((async (file: Parameters<typeof fs.lstat>[0], options?: any) => {
        if (copied && String(file) === ext && !(options && options.bigint)) {
          const listing = await ls(ext);
          if (listing.length === 2) throw errno("EIO");
        }
        return realLstat(file, options);
      }) as typeof fs.lstat);
      const first = await patch({ mode: "external", rootPath: ext });
      vi.restoreAllMocks();
      expect(first).toMatchObject({ ok: false, code: "EIO" });
      expect(await configOf()).toEqual(before);
      expect(await completionRows()).toHaveLength(0);
      expect(await ls(ext)).toEqual(["AGENTS.md", NOTE]);
      expect(await intents()).toHaveLength(1);
      await agentFileStore(db).write({ companyId, agentId, path: NOTE, bytes: Buffer.from(NOTE_NEW), baseHash: hashOf(NOTE_OLD) }, board());
      const retry = await patch({ mode: "external", rootPath: ext });
      expect(retry).toMatchObject({ ok: false, status: 409, code: COPY_INCOMPLETE, details: { completionHint: "not_completed" } });
      expect((await configOf()).instructionsBundleMode).toBe("managed");
      expect(await read(ext)).toBe(NOTE_OLD);
    });

    it("test 3: a crash after the intent and before any copy leaves an empty folder; this agent's retry clears it and copies", async () => {
      const crash = spyOpen((file, flags) => { if (isDestWrite(file, flags)) throw errno("ESIMCRASH"); });
      expect((await patch({ mode: "external", rootPath: ext })).ok).toBe(false);
      crash.mockRestore();
      expect(await ls(ext)).toEqual([]);
      expect(await intents()).toHaveLength(1);
      expect((await patch({ mode: "external", rootPath: ext })).ok).toBe(true);
      expect(await intents()).toEqual([]);
      expect(await ls(ext)).toEqual(["AGENTS.md", NOTE]);
    });

    it("test 4: success records exactly one completion row and removes the record; switching back adopts", async () => {
      expect((await patch({ mode: "external", rootPath: ext })).ok).toBe(true);
      const rows = await completionRows();
      expect(rows).toHaveLength(1);
      const canonical = await fs.realpath(ext);
      const stat = await fs.lstat(canonical, { bigint: true });
      expect(rows[0]).toMatchObject({ companyId, agentId, entityType: "agent", entityId: agentId, actorType: "user", actorId: userId });
      expect(rows[0]!.details).toMatchObject({ destination: { ino: stat.ino.toString(), pathKeyHash: fileHash(Buffer.from(instructionPathKey(canonical))) }, plannedCount: 2 });
      expect(JSON.stringify(rows[0]!.details).includes(canonical)).toBe(false);
      expect(await intents()).toEqual([]);
      expect((await patch({ mode: "managed" })).ok).toBe(true);
      expect((await patch({ mode: "external", rootPath: ext })).ok).toBe(true);
      expect(await completionRows()).toHaveLength(1);
    });

    /** A committed copy whose record could not be removed after commit. */
    async function lingeringCompletedCopy() {
      const realUnlink = fs.unlink.bind(fs);
      vi.spyOn(fs, "unlink").mockImplementation((async (file: Parameters<typeof fs.unlink>[0]) => {
        if (String(file).startsWith(instructionCopyIntentsDirectory())) throw errno("EACCES");
        return realUnlink(file);
      }) as typeof fs.unlink);
      const result = await patch({ mode: "external", rootPath: ext });
      vi.restoreAllMocks();
      expect(result.ok).toBe(true);
      const [name] = await intents();
      return { name: name!, intent: await readIntent(name!) };
    }

    it("test 5: a record left after commit refuses the active folder with a completed hint; after the operator deletes it, the PATCH adopts", async () => {
      const { name, intent } = await lingeringCompletedCopy();
      expect((await configOf()).instructionsRootPath).toBe(ext);
      const same = await patch({ mode: "external", rootPath: ext, entryFile: "AGENTS.md" });
      expect(same).toMatchObject({ ok: false, status: 409, code: COPY_INCOMPLETE, details: { completionHint: "completed", operationId: intent.operationId } });
      expect(await ls(ext)).toEqual(["AGENTS.md", NOTE]);
      expect(await intents()).toEqual([name]);
      await fs.rm(path.join(instructionCopyIntentsDirectory(), name));
      expect((await patch({ mode: "external", rootPath: ext, entryFile: "AGENTS.md" })).ok).toBe(true);
    });

    it("tests 8 and 9: an outside writer during the copy aborts it (EEXIST or verification); the retry is refused; outside files untouched", async () => {
      for (const [label, outsider] of [["colliding", NOTE], ["non-colliding", "intruder.md"]] as const) {
        const root = path.join(home, `ext-${label}`, agentId);
        await db.update(agents).set({ adapterConfig: cfg("managed", managedRoot) }).where(eq(agents.id, agentId));
        let count = 0;
        spyOpen(async (file, flags) => {
          if (isDestWrite(file, flags, root) && ++count === 1) {
            await fs.mkdir(path.join(root, "notes"), { recursive: true });
            await fs.writeFile(path.join(root, outsider), "SENTINEL-OUTSIDE\n");
          }
        });
        const first = await patch({ mode: "external", rootPath: root });
        vi.restoreAllMocks();
        expect(first.ok).toBe(false);
        if (label === "colliding") expect(first).toMatchObject({ code: "EEXIST" });
        else expect(first).toMatchObject({ status: 409, message: "The instructions destination changed during the copy; nothing was activated" });
        expect((await configOf()).instructionsBundleMode).toBe("managed");
        expect(await read(root, outsider)).toBe("SENTINEL-OUTSIDE\n");
        const retry = await patch({ mode: "external", rootPath: root });
        expect(retry).toMatchObject({ ok: false, status: 409, code: COPY_INCOMPLETE });
        expect(await read(root, outsider)).toBe("SENTINEL-OUTSIDE\n");
      }
    });

    it("test 10: another agent's record on the same empty folder refuses before any write and is never removed", async () => {
      const other = randomUUID();
      const otherManaged = resolveManagedInstructionsRoot({ companyId, id: other, name: "T", adapterConfig: {} });
      await seedAgent(other, cfg("managed", otherManaged));
      await seedSource(otherManaged);
      let count = 0;
      spyOpen((file, flags) => { if (isDestWrite(file, flags) && ++count === 1) throw errno("EIO"); });
      expect((await patch({ mode: "external", rootPath: ext }, {}, undefined, other)).ok).toBe(false);
      vi.restoreAllMocks();
      const records = await intents();
      expect(records).toHaveLength(1);
      expect(await ls(ext)).toEqual([]);
      const result = await patch({ mode: "external", rootPath: ext });
      expect(result).toMatchObject({ ok: false, status: 409, code: COPY_INCOMPLETE });
      expect(await intents()).toEqual(records);
      expect(await ls(ext)).toEqual([]);
    });

    it("test 11: a folded spelling of a recorded path matches (fail closed)", async () => {
      failNthDestWrite(1);
      expect((await patch({ mode: "external", rootPath: ext })).ok).toBe(false);
      vi.restoreAllMocks();
      const upper = path.join(home, "EXT", agentId);
      const result = await patch({ mode: "external", rootPath: upper });
      expect(instructionPathKey(await fs.realpath(upper))).toBe(instructionPathKey(await fs.realpath(ext)));
      expect(result).toMatchObject({ ok: false, status: 409, code: COPY_INCOMPLETE });
      expect(await ls(upper)).toEqual([]);
      // A folded-path match on another empty folder never removes this agent's
      // record: the recorded folder may still hold the partial copy.
      expect(await intents()).toHaveLength(1);
    });

    it("G3: another operation's completion never authorizes this folder", async () => {
      failNthDestWrite(2);
      expect((await patch({ mode: "external", rootPath: ext })).ok).toBe(false);
      vi.restoreAllMocks();
      const other = path.join(home, "ext-other", agentId);
      expect((await patch({ mode: "external", rootPath: other })).ok).toBe(true);
      expect(await completionRows()).toHaveLength(1);
      const result = await patch({ mode: "external", rootPath: ext });
      expect(result).toMatchObject({ ok: false, status: 409, code: COPY_INCOMPLETE, details: { completionHint: "not_completed" } });
      expect((await configOf()).instructionsRootPath).toBe(other);
    });

    it("G4: an uncommitted matching completion blocks behind the lock and is invisible; rolled back not_completed; committed completed; never adoption", async () => {
      const { intent } = await lingeringCompletedCopy();
      await db.delete(activityLog).where(eq(activityLog.action, INSTRUCTION_BUNDLE_COPY_COMPLETED_ACTION));
      const real = { companyId, actorType: "user", actorId: userId, action: INSTRUCTION_BUNDLE_COPY_COMPLETED_ACTION, entityType: "agent", entityId: agentId,
        agentId, details: { operationId: intent.operationId, destination: { ino: intent.destination.ino, birthtimeNs: intent.destination.birthtimeNs,
          pathKeyHash: fileHash(Buffer.from(intent.destination.pathKey)) } } };
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const open = db.transaction(async (tx) => { await tx.insert(activityLog).values(real); await gate; throw new Error("rollback"); }).catch(() => "rolled back");
      await sleep(100);
      let settled = false;
      const pending = patch({ mode: "external", rootPath: ext }).then((result) => { settled = true; return result; });
      await sleep(300);
      expect(settled).toBe(false);
      release();
      expect(await open).toBe("rolled back");
      expect(await pending).toMatchObject({ ok: false, status: 409, details: { completionHint: "not_completed" } });
      await db.insert(activityLog).values(real);
      expect(await patch({ mode: "external", rootPath: ext })).toMatchObject({ ok: false, status: 409, details: { completionHint: "completed" } });
      expect(await ls(ext)).toEqual(["AGENTS.md", NOTE]);
    });

    it("G5 and G5b: a replaced folder at the same path, or a record with the same inode and another path, is refused", async () => {
      const { name } = await lingeringCompletedCopy();
      await fs.rename(ext, `${ext}-moved`);
      await seedSource(ext, { "AGENTS.md": "SENTINEL-REPLACED\n" });
      expect(await patch({ mode: "external", rootPath: ext })).toMatchObject({ ok: false, status: 409, code: COPY_INCOMPLETE });
      const recordPath = path.join(instructionCopyIntentsDirectory(), name);
      const record = await readIntent(name);
      const stat = await fs.lstat(await fs.realpath(ext), { bigint: true });
      await fs.writeFile(recordPath, JSON.stringify({ ...record, destination: { ...record.destination, ino: stat.ino.toString(), pathKey: "/elsewhere/entirely" } }));
      expect(await patch({ mode: "external", rootPath: ext })).toMatchObject({ ok: false, status: 409, code: COPY_INCOMPLETE });
      expect(await read(ext, "AGENTS.md")).toBe("SENTINEL-REPLACED\n");
    });

    it("an unreadable or invalid record in the intent directory refuses and is left in place", async () => {
      await fs.mkdir(instructionCopyIntentsDirectory(), { recursive: true });
      await fs.writeFile(path.join(instructionCopyIntentsDirectory(), "not-a-record.json"), "{");
      const result = await patch({ mode: "external", rootPath: ext });
      expect(result).toMatchObject({ ok: false, status: 409, code: COPY_INCOMPLETE });
      expect(await intents()).toEqual(["not-a-record.json"]);
      expect(await ls(ext)).toEqual([]);
    });

    describe("G6: two agents and one empty folder", () => {
      let other: string;
      beforeEach(async () => {
        other = randomUUID();
        const otherManaged = resolveManagedInstructionsRoot({ companyId, id: other, name: "T", adapterConfig: {} });
        await seedAgent(other, cfg("managed", otherManaged));
        await seedSource(otherManaged, { "AGENTS.md": "SENTINEL-OTHER-ENTRY\n", "notes/other.md": "SENTINEL-OTHER-NOTE\n" });
      });

      it("both create before either scans: both refuse, nothing is written, no record remains", async () => {
        let created = 0;
        let bothCreated!: () => void;
        const barrier = new Promise<void>((resolve) => { bothCreated = resolve; });
        const real = fs.open.bind(fs);
        vi.spyOn(fs, "open").mockImplementation((async (file: Parameters<typeof fs.open>[0], flags?: any, mode?: any) => {
          const handle = await real(file, flags, mode);
          if (flags === "wx" && String(file).startsWith(instructionCopyIntentsDirectory())) {
            created += 1;
            if (created === 2) bothCreated();
            await Promise.race([barrier, sleep(5000)]);
          }
          return handle;
        }) as typeof fs.open);
        const [a, b] = await Promise.all([patch({ mode: "external", rootPath: ext }), patch({ mode: "external", rootPath: ext }, {}, undefined, other)]);
        expect(created).toBe(2);
        expect(a).toMatchObject({ ok: false, status: 409, code: COPY_INCOMPLETE });
        expect(b).toMatchObject({ ok: false, status: 409, code: COPY_INCOMPLETE });
        expect(await ls(ext)).toEqual([]);
        expect(await intents()).toEqual([]);
      });

      it("one scans before the other creates: the later one refuses and writes nothing; the earlier one copies", async () => {
        let bAtPersist!: () => void; const bReady = new Promise<void>((resolve) => { bAtPersist = resolve; });
        let aScanned!: () => void; const aPast = new Promise<void>((resolve) => { aScanned = resolve; });
        let bFinished!: () => void; const bDone = new Promise<void>((resolve) => { bFinished = resolve; });
        let first = true;
        spyOpen(async (file, flags) => {
          if (isDestWrite(file, flags) && first) { first = false; aScanned(); await bDone; }
        });
        const b = patch({ mode: "external", rootPath: ext }, {
          persist: async (tx, current, adapterConfig) => { bAtPersist(); await aPast; await persistOn()(tx, current, adapterConfig); },
        }, undefined, other).then((result) => { bFinished(); return result; });
        await bReady;
        const a = await patch({ mode: "external", rootPath: ext });
        const bResult = await b;
        expect(bResult).toMatchObject({ ok: false, status: 409, code: COPY_INCOMPLETE });
        expect(a.ok).toBe(true);
        expect(await ls(ext)).toEqual(["AGENTS.md", NOTE]);
        expect(await read(ext, "AGENTS.md")).toBe(ENTRY);
        expect((await configOf(other)).instructionsBundleMode).toBe("managed");
        expect(await intents()).toEqual([]);
      });
    });

    it("G7: record create, record sync and directory sync come before the first destination write; unlink after commit", async () => {
      const events: string[] = [];
      const real = fs.open.bind(fs);
      vi.spyOn(fs, "open").mockImplementation((async (file: Parameters<typeof fs.open>[0], flags?: any, mode?: any) => {
        const name = String(file);
        const inIntents = name.startsWith(instructionCopyIntentsDirectory());
        if (isDestWrite(name, flags)) events.push("dest-write");
        const handle = await real(file, flags, mode);
        if (inIntents && (flags === "wx" || name === instructionCopyIntentsDirectory())) {
          const label = name === instructionCopyIntentsDirectory() ? "dir-sync" : "intent-sync";
          if (label === "intent-sync") events.push("intent-create");
          const sync = handle.sync.bind(handle);
          handle.sync = async () => { events.push(label); return sync(); };
        }
        return handle;
      }) as typeof fs.open);
      const realUnlink = fs.unlink.bind(fs);
      vi.spyOn(fs, "unlink").mockImplementation((async (file: Parameters<typeof fs.unlink>[0]) => {
        if (String(file).startsWith(instructionCopyIntentsDirectory())) {
          events.push((await completionRows()).length === 1 && ((await configOf()).instructionsRootPath === ext) ? "unlink-after-commit" : "unlink-before-commit");
        }
        return realUnlink(file);
      }) as typeof fs.unlink);
      expect((await patch({ mode: "external", rootPath: ext })).ok).toBe(true);
      expect(events.slice(0, 4)).toEqual(["intent-create", "intent-sync", "dir-sync", "dest-write"]);
      expect(events.at(-1)).toBe("unlink-after-commit");
      expect(events.filter((event) => event === "unlink-before-commit")).toEqual([]);
    });

    it("G7b: a directory sync failure that is not 'unsupported' aborts before any destination write", async () => {
      const real = fs.open.bind(fs);
      vi.spyOn(fs, "open").mockImplementation((async (file: Parameters<typeof fs.open>[0], flags?: any, mode?: any) => {
        const handle = await real(file, flags, mode);
        if (String(file) === instructionCopyIntentsDirectory()) handle.sync = async () => { throw errno("EIO"); };
        return handle;
      }) as typeof fs.open);
      const before = await configOf();
      expect(await patch({ mode: "external", rootPath: ext })).toMatchObject({ ok: false, code: "EIO" });
      vi.restoreAllMocks();
      expect(await ls(ext)).toEqual([]);
      expect(await configOf()).toEqual(before);
    });
  });

  describe("completion evidence never authorizes (G10a, G10b) and 409 disclosure", () => {
    async function lingeringFailedCopy() {
      let count = 0;
      spyOpen((file, flags) => { if (isDestWrite(file, flags) && ++count === 2) throw errno("EIO"); });
      expect((await patch({ mode: "external", rootPath: ext })).ok).toBe(false);
      vi.restoreAllMocks();
      const [name] = await intents();
      return { name: name!, intent: await readIntent(name!) };
    }
    const forgedDetails = (intent: any) => ({ operationId: intent.operationId,
      destination: { ino: intent.destination.ino, birthtimeNs: intent.destination.birthtimeNs, pathKeyHash: fileHash(Buffer.from(intent.destination.pathKey)) } });

    it("G10a: a row forged through POST /companies/:companyId/activity by a non-admin board user does not permit adoption", async () => {
      const { name, intent } = await lingeringFailedCopy();
      const listing = await ls(ext);
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => {
        (req as any).actor = { type: "board", userId, companyIds: [companyId], source: "session", isInstanceAdmin: false,
          memberships: [{ companyId, status: "active", membershipRole: "operator" }] };
        next();
      });
      app.use("/api", activityRoutes(db as any));
      app.use(errorHandler);
      const forged = await request(app).post(`/api/companies/${companyId}/activity`).send({ actorType: "system", actorId: "paperclip",
        action: INSTRUCTION_BUNDLE_COPY_COMPLETED_ACTION, entityType: "agent", entityId: agentId, agentId, details: forgedDetails(intent) });
      expect(forged.status, JSON.stringify(forged.body)).toBe(201);
      for (const isInstanceAdmin of [false, true]) {
        const result = await patch({ mode: "external", rootPath: ext }, { isInstanceAdmin });
        expect(result).toMatchObject({ ok: false, status: 409, code: COPY_INCOMPLETE });
        if (!isInstanceAdmin) {
          expect(result.ok === false && Object.keys(result.details)).toEqual(["code"]);
          expect(JSON.stringify(result).includes(intent.operationId)).toBe(false);
          expect(JSON.stringify(result).includes(ext)).toBe(false);
        }
      }
      expect(await ls(ext)).toEqual(listing);
      expect(await intents()).toEqual([name]);
      expect((await configOf()).instructionsBundleMode).toBe("managed");
    });

    it("G10a: a row forged through the plugin host activity.log does not permit adoption", async () => {
      const { name, intent } = await lingeringFailedCopy();
      const pluginId = randomUUID();
      const services = buildHostServices(db, pluginId, "paperclip.switch-race-test",
        { forPlugin: () => ({ emit: async () => {}, subscribe: () => {}, clear: () => {} }) } as any);
      await services.activity.log({ companyId, message: INSTRUCTION_BUNDLE_COPY_COMPLETED_ACTION, entityType: "agent", entityId: agentId,
        metadata: forgedDetails(intent) } as any);
      services.dispose();
      expect((await completionRows()).length).toBeGreaterThan(0);
      expect(await patch({ mode: "external", rootPath: ext })).toMatchObject({ ok: false, status: 409, code: COPY_INCOMPLETE });
      expect(await intents()).toEqual([name]);
      expect((await configOf()).instructionsBundleMode).toBe("managed");
    });

    it("G10b (and G2): the hint is completed only for exactly one fully matching row; the folder is refused in every case", async () => {
      const { intent } = await lingeringFailedCopy();
      const otherAgent = randomUUID();
      await seedAgent(otherAgent, cfg("managed", resolveManagedInstructionsRoot({ companyId, id: otherAgent, name: "T", adapterConfig: {} })));
      const otherCompany = randomUUID();
      await db.insert(companies).values({ id: otherCompany, name: "Other", issuePrefix: randomUUID().slice(0, 8) });
      const good = () => ({ companyId, actorType: "user", actorId: userId, action: INSTRUCTION_BUNDLE_COPY_COMPLETED_ACTION, entityType: "agent",
        entityId: agentId, agentId, details: forgedDetails(intent) as Record<string, any> });
      const variants: Array<[string, Array<ReturnType<typeof good>>, "completed" | "not_completed"]> = [
        ["zero rows", [], "not_completed"],
        ["two identical rows", [good(), good()], "not_completed"],
        ["company", [{ ...good(), companyId: otherCompany }], "not_completed"],
        ["agent", [{ ...good(), agentId: otherAgent }], "not_completed"],
        ["entity id", [{ ...good(), entityId: otherAgent }], "not_completed"],
        ["operationId", [{ ...good(), details: { ...good().details, operationId: randomUUID() } }], "not_completed"],
        ["inode", [{ ...good(), details: { ...good().details, destination: { ...good().details.destination, ino: "1" } } }], "not_completed"],
        ["birthtime", [{ ...good(), details: { ...good().details, destination: { ...good().details.destination, birthtimeNs: "12345" } } }], "not_completed"],
        ["path hash", [{ ...good(), details: { ...good().details, destination: { ...good().details.destination, pathKeyHash: fileHash(Buffer.from("other")) } } }], "not_completed"],
        ["one correct row", [good()], "completed"],
      ];
      const listing = await ls(ext);
      for (const [label, rows, hint] of variants) {
        await db.delete(activityLog).where(eq(activityLog.action, INSTRUCTION_BUNDLE_COPY_COMPLETED_ACTION));
        if (rows.length) await db.insert(activityLog).values(rows);
        const result = await patch({ mode: "external", rootPath: ext });
        expect(result, label).toMatchObject({ ok: false, status: 409, code: COPY_INCOMPLETE, details: { completionHint: hint } });
        expect(await ls(ext), label).toEqual(listing);
      }
      expect((await configOf()).instructionsBundleMode).toBe("managed");
    });

    it("discloses recovery detail only to instance admins", async () => {
      const { name, intent } = await lingeringFailedCopy();
      const admin = await patch({ mode: "external", rootPath: ext }, { isInstanceAdmin: true });
      expect(admin).toMatchObject({ ok: false, status: 409, details: { code: COPY_INCOMPLETE, destinationRoot: await fs.realpath(ext),
        operationId: intent.operationId, startedAt: intent.startedAt, intentFile: path.join(instructionCopyIntentsDirectory(), name), completionHint: "not_completed" } });
      const other = await patch({ mode: "external", rootPath: ext }, { isInstanceAdmin: false });
      expect(other).toMatchObject({ ok: false, status: 409, code: COPY_INCOMPLETE,
        message: "A previous instructions copy for this agent did not finish. An instance administrator must resolve it." });
      expect(other.ok === false && other.details).toEqual({ code: COPY_INCOMPLETE });
    });
  });

  describe("transaction rollback and secret parity (test 17)", () => {
    const secretRows = () => db.select().from(companySecrets).where(eq(companySecrets.companyId, companyId));
    beforeEach(async () => {
      await db.update(agents).set({ adapterType: "hermes_gateway", adapterConfig: { ...cfg("managed", managedRoot), apiKey: RAW_API_KEY } }).where(eq(agents.id, agentId));
    });
    it("creates no secret on a failure at persist, copy or commit, and exactly one on success", async () => {
      const failures: Array<[string, () => void]> = [
        ["persist (pending approval)", () => undefined],
        ["copy (EIO)", () => { spyOpen((file, flags) => { if (isDestWrite(file, flags)) throw errno("EIO"); }); }],
      ];
      await db.update(agents).set({ status: "pending_approval" }).where(eq(agents.id, agentId));
      failures[0]![1]();
      expect((await patch({ mode: "external", rootPath: ext })).ok).toBe(false);
      expect(await secretRows()).toHaveLength(0);
      await db.update(agents).set({ status: "idle" }).where(eq(agents.id, agentId));
      failures[1]![1]();
      expect((await patch({ mode: "external", rootPath: ext })).ok).toBe(false);
      vi.restoreAllMocks();
      expect(await secretRows()).toHaveLength(0);
      expect(JSON.stringify(await configOf()).includes(RAW_API_KEY)).toBe(true);
      const commitRoot = path.join(home, "ext-commit", agentId);
      let copied = false;
      spyOpen((file, flags) => { if (isDestWrite(file, flags, commitRoot)) copied = true; });
      const realLstat = fs.lstat.bind(fs);
      vi.spyOn(fs, "lstat").mockImplementation((async (file: Parameters<typeof fs.lstat>[0], options?: any) => {
        if (copied && String(file) === commitRoot && !(options && options.bigint) && (await ls(commitRoot)).length === 2) throw errno("EIO");
        return realLstat(file, options);
      }) as typeof fs.lstat);
      expect((await patch({ mode: "external", rootPath: commitRoot })).ok).toBe(false);
      vi.restoreAllMocks();
      expect(await secretRows()).toHaveLength(0);
      const okRoot = path.join(home, "ext-ok", agentId);
      expect((await patch({ mode: "external", rootPath: okRoot })).ok).toBe(true);
      expect(await secretRows()).toHaveLength(1);
      expect(JSON.stringify(await configOf()).includes(RAW_API_KEY)).toBe(false);
    });
  });
});

function fsRealTmp() {
  return os.tmpdir();
}
