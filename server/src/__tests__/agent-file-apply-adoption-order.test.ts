import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { DirectorySnapshot } from "@paperclipai/adapter-utils/workspace-restore-merge";
import {
  activityLog, agentConfigRevisions, agentInstructionHeads, agentInstructionRevisions, agents, authUsers, companies,
  companyMemberships, createDb, principalPermissionGrants,
} from "@paperclipai/db";
import {
  AGENT_FILES_ENTRY_CONFLICT, MAX_AGENT_DIRECTORY_BYTES, MAX_AGENT_DIRECTORY_ENTRIES, MAX_AGENT_FILE_BYTES,
  agentFileStore, fileHash, snapshotAgentFiles,
} from "../services/agent-file-store.js";
import { checkpointBaseline, type AgentFileManifest } from "../services/agent-file-checkpoints.js";
import { resolveManagedInstructionsRoot } from "../services/agent-instructions.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

// Synthetic sentinels only. A first write-back (no file-sync/adopted.json yet)
// must validate against the tree first adoption would produce, and a rejected
// one must leave the marker, the legacy head projections and every file alone.
const DISK = "SENTINEL-ADOPT-DISK-ENTRY-1\n";
const HEAD = "SENTINEL-ADOPT-HEAD-ENTRY-2\n";
const LEGACY = "SENTINEL-ADOPT-LEGACY-3\n";
const NOTE_TEXT = "SENTINEL-ADOPT-NOTE-4\n";
const EDIT = "SENTINEL-ADOPT-EDIT-5\n";
const ALIAS = "SENTINEL-ADOPT-ALIAS-6\n";
const ENTRY = "AGENTS.md";
const NOTE = "notes/plan.md";
const LEGACY_FILE = "legacy/deep/OLD.md"; // a pending head whose parent folders do not exist yet

type Outcome = { ok: true } | { ok: false; status: number | undefined; code: string | undefined; message: string };

describe("agent file write-back defers first adoption until validation passes", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let home: string, companyId: string, agentId: string, userId: string, managedRoot: string;
  const board = () => ({ type: "board" as const, userId, source: "session" as const });
  const marker = () => path.join(path.dirname(managedRoot), "file-sync", "adopted.json");
  const hasMarker = () => fs.access(marker()).then(() => true, () => false);

  async function tree(root: string): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    async function walk(dir: string, rel: string) {
      for (const item of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
        const relative = rel ? `${rel}/${item.name}` : item.name;
        // The canonical-manifest cache is rebuilt by every checkpoint apply,
        // before any check, exactly as before this change. It is not agent content.
        // Its folder may be created by that cache; the marker is checked on its own.
        if (relative === "file-sync/canonical-manifest.json" || (relative === "file-sync" && item.isDirectory())) {
          if (item.isDirectory()) await walk(path.join(dir, item.name), relative);
          continue;
        }
        if (item.isDirectory()) { out[`${relative}/`] = "dir"; await walk(path.join(dir, item.name), relative); }
        else out[relative] = fileHash(await fs.readFile(path.join(dir, item.name)));
      }
    }
    await walk(root, "");
    return out;
  }
  const state = async () => ({
    agentFolder: await tree(path.dirname(managedRoot)),
    config: (await db.select().from(agents).where(eq(agents.id, agentId)))[0]!.adapterConfig,
    activity: (await db.select().from(activityLog).where(eq(activityLog.entityId, agentId))).map(row => row.action),
    configRevisions: (await db.select().from(agentConfigRevisions).where(eq(agentConfigRevisions.agentId, agentId))).length,
    heads: (await db.select().from(agentInstructionHeads).where(eq(agentInstructionHeads.agentId, agentId)))
      .map(row => `${row.entryFile}:${row.revisionId}`).sort(),
    revisions: (await db.select().from(agentInstructionRevisions).where(eq(agentInstructionRevisions.agentId, agentId))).length,
  });
  async function seedHead(name: string, content: string | Buffer) {
    const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
    const id = randomUUID();
    await db.insert(agentInstructionRevisions).values({ id, companyId, agentId, entryFile: name, contentBase64: bytes.toString("base64"),
      contentHash: fileHash(bytes), byteLength: bytes.length, source: "board" } as never);
    await db.insert(agentInstructionHeads).values({ companyId, agentId, entryFile: name, revisionId: id } as never);
  }
  async function sourceWith(files: Record<string, string | Buffer>) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "adopt-src-"));
    for (const [name, content] of Object.entries(files)) {
      await fs.mkdir(path.dirname(path.join(dir, name)), { recursive: true });
      await fs.writeFile(path.join(dir, name), content);
    }
    return dir;
  }
  const outcome = (promise: Promise<unknown>): Promise<Outcome> => promise.then(() => ({ ok: true as const }),
    (error: { status?: number; details?: { code?: string }; code?: string; message: string }) =>
      ({ ok: false as const, status: error.status, code: error.details?.code ?? error.code, message: error.message }));
  const apply = (sourceDir: string, baseline: DirectorySnapshot, checkpoint?: AgentFileManifest) =>
    outcome(agentFileStore(db).apply({ companyId, agentId, sourceDir, baseline, ...(checkpoint ? { checkpoint } : {}) }, board()));
  // Adoption through an ordinary read, as a prepared run would have done.
  const adoptNow = () => agentFileStore(db).read(companyId, agentId, NOTE, board());

  /** A sparse checkpoint: the manifest lists the whole tree, the source holds only changed files. */
  async function checkpointFrom(baseline: DirectorySnapshot, changes: Record<string, string | Buffer | null>) {
    const manifest = checkpointBaseline(baseline);
    const byName = new Map(manifest.entries);
    const files: Record<string, string | Buffer> = {};
    for (const [name, content] of Object.entries(changes)) {
      if (content === null) { byName.delete(name); continue; }
      files[name] = content;
      byName.set(name, { kind: "file", mode: 0o100644, hash: fileHash(Buffer.from(content)) } as never);
      for (let parent = path.posix.dirname(name); parent !== "."; parent = path.posix.dirname(parent)) {
        if (!byName.has(parent)) byName.set(parent, { kind: "dir" } as never);
      }
    }
    const sourceDir = await sourceWith(files);
    for (const name of Object.keys(files)) await fs.chmod(path.join(sourceDir, name), 0o644);
    return { sourceDir, checkpoint: { version: 1, entries: [...byName] } as AgentFileManifest };
  }

  beforeAll(async () => {
    home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "adopt-home-")));
    process.env.PAPERCLIP_HOME = home;
    database = await startEmbeddedPostgresTestDatabase("adopt-order-db-");
    db = createDb(database.connectionString);
  }, 120_000);
  afterAll(async () => {
    await database?.cleanup();
    await fs.rm(home, { recursive: true, force: true });
  });
  beforeEach(async () => {
    companyId = randomUUID(); agentId = randomUUID(); userId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Adopt", issuePrefix: randomUUID().slice(0, 8) });
    await db.insert(authUsers).values({ id: userId, name: "Board", email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    managedRoot = resolveManagedInstructionsRoot({ companyId, id: agentId, name: "T", adapterConfig: {} });
    await db.insert(agents).values({ id: agentId, companyId, name: "T",
      adapterConfig: { instructionsBundleMode: "managed", instructionsRootPath: managedRoot, instructionsEntryFile: ENTRY } });
    await db.insert(companyMemberships).values([
      { companyId, principalType: "user", principalId: userId, membershipRole: "operator" },
      { companyId, principalType: "agent", principalId: agentId, membershipRole: "member" },
    ]);
    await db.insert(principalPermissionGrants).values({ companyId, principalType: "user", principalId: userId,
      permissionKey: "agents:configure", scope: { agentIds: [agentId] } });
    await fs.mkdir(path.join(managedRoot, "notes"), { recursive: true });
    await fs.writeFile(path.join(managedRoot, ENTRY), DISK);
    await fs.writeFile(path.join(managedRoot, NOTE), NOTE_TEXT);
  });

  /** Rejected with no side effect, then a legitimate write-back from a fresh baseline succeeds. */
  async function expectRejectedWithoutEffect(run: () => Promise<Outcome>, expected: { status: number; code?: string }) {
    expect(await hasMarker()).toBe(false);
    const before = await state();
    const result = await run();
    expect(result).toMatchObject({ ok: false, status: expected.status, ...(expected.code ? { code: expected.code } : {}) });
    expect(await hasMarker()).toBe(false);
    expect(await state()).toEqual(before);
    expect(await fs.readFile(path.join(managedRoot, ENTRY), "utf8")).toBe(DISK);
    await expect(fs.access(path.join(managedRoot, LEGACY_FILE))).rejects.toThrow();
    return result;
  }
  async function expectLaterWriteBackSucceeds() {
    const baseline = await snapshotAgentFiles(managedRoot);
    const entry = await fs.readFile(path.join(managedRoot, ENTRY));
    const later = await apply(await sourceWith({ [ENTRY]: entry, [NOTE]: EDIT }), baseline);
    expect(later).toEqual({ ok: true });
    expect(await fs.readFile(path.join(managedRoot, NOTE), "utf8")).toBe(EDIT);
  }
  const seedLegacyHeads = async () => { await seedHead(ENTRY, HEAD); await seedHead(LEGACY_FILE, LEGACY); };

  describe("rejected first write-backs leave no adoption effect (R-A1 to R-A3, R-A8)", () => {
    for (const checkpointed of [false, true]) {
      const label = checkpointed ? "checkpoint" : "directory";
      const run = async (baseline: DirectorySnapshot, files: Record<string, string | Buffer | null>) => {
        if (checkpointed) {
          const { sourceDir, checkpoint } = await checkpointFrom(baseline, files);
          return apply(sourceDir, baseline, checkpoint);
        }
        const present: Record<string, string | Buffer> = { [ENTRY]: DISK, [NOTE]: NOTE_TEXT };
        for (const [name, content] of Object.entries(files)) { if (content === null) delete present[name]; else present[name] = content; }
        return apply(await sourceWith(present), baseline);
      };

      it(`R-A1 (${label}): a stale entry against a pending head is refused before adoption`, async () => {
        await seedLegacyHeads();
        const baseline = await snapshotAgentFiles(managedRoot);
        const result = await expectRejectedWithoutEffect(() => run(baseline, { [ENTRY]: EDIT }),
          { status: 409, code: AGENT_FILES_ENTRY_CONFLICT });
        expect(result).toMatchObject({ message: "The instruction entry changed after this working copy was prepared. The write-back was rejected and no files were saved." });
        await expectLaterWriteBackSucceeds();
      });

      it(`R-A2 (${label}): a deleted entry is refused before adoption`, async () => {
        await seedLegacyHeads();
        const baseline = await snapshotAgentFiles(managedRoot);
        const result = await expectRejectedWithoutEffect(() => run(baseline, { [ENTRY]: null }), { status: 422 });
        expect(result).toMatchObject({ message: "The configured instruction entry cannot be deleted" });
        await expectLaterWriteBackSucceeds();
      });

      it(`R-A3 (${label}): an invalid entry is refused before adoption`, async () => {
        await seedLegacyHeads();
        const baseline = await snapshotAgentFiles(managedRoot);
        const result = await expectRejectedWithoutEffect(() => run(baseline, { [ENTRY]: Buffer.from([0xc3, 0x28]) }),
          { status: 422, code: "INSTRUCTION_CONTENT_INVALID" });
        expect(result).toMatchObject({ message: "Instructions must be valid UTF-8" });
        await expectLaterWriteBackSucceeds();
      });
    }

    it("keeps R2's alias refusal ahead of adoption", async () => {
      await seedLegacyHeads();
      const baseline = await snapshotAgentFiles(managedRoot);
      const result = await expectRejectedWithoutEffect(async () => apply(await sourceWith({ [ENTRY]: DISK, [NOTE]: NOTE_TEXT, "agents.md": ALIAS }), baseline),
        { status: 409, code: AGENT_FILES_ENTRY_CONFLICT });
      expect(result).toMatchObject({ message: "A changed path names the instruction entry under another spelling. The write-back was rejected and no files were saved." });
    });
  });

  describe("accepted write-backs and responses are unchanged (R-A4, R-A5, R-A6)", () => {
    type Case = { name: string; files: Record<string, string | Buffer | null> };
    const cases: Case[] = [
      { name: "stale entry", files: { [ENTRY]: EDIT } },
      { name: "deleted entry", files: { [ENTRY]: null } },
      { name: "invalid entry", files: { [ENTRY]: Buffer.from([0xff]) } },
      { name: "note edit (accepted)", files: { [NOTE]: EDIT } },
      { name: "entry rewritten to the pending head bytes (accepted)", files: { [ENTRY]: HEAD } },
      { name: "new file under a pending head's folder (accepted)", files: { "legacy/deep/NEW.md": EDIT } },
    ];
    /** Run one write-back on this agent; return its outcome and the resulting state. */
    async function runCase(item: Case, adoptFirst: boolean, checkpointed: boolean) {
      await seedLegacyHeads();
      const baseline = await snapshotAgentFiles(managedRoot); // taken before adoption either way
      if (adoptFirst) { await adoptNow(); expect(await hasMarker()).toBe(true); }
      let result: Outcome;
      if (checkpointed) {
        const { sourceDir, checkpoint } = await checkpointFrom(baseline, item.files);
        result = await apply(sourceDir, baseline, checkpoint);
      } else {
        const present: Record<string, string | Buffer> = { [ENTRY]: DISK, [NOTE]: NOTE_TEXT };
        for (const [name, content] of Object.entries(item.files)) { if (content === null) delete present[name]; else present[name] = content; }
        result = await apply(await sourceWith(present), baseline);
      }
      const after = await state();
      // Compare content and database effects, not the agent and company ids.
      const folder = Object.fromEntries(Object.entries(await tree(managedRoot)).sort());
      return { result, folder, marker: await hasMarker(), activity: after.activity, configRevisions: after.configRevisions,
        revisions: after.revisions, headCount: after.heads.length };
    }
    for (const checkpointed of [false, true]) {
      for (const item of cases) {
        it(`R-A4/R-A5 (${checkpointed ? "checkpoint" : "directory"}): ${item.name} gives the same response first-time as after adoption`, async () => {
          const adopted = await runCase(item, true, checkpointed);
          // A fresh agent for the first-adoption run.
          companyId = randomUUID(); agentId = randomUUID();
          await db.insert(companies).values({ id: companyId, name: "Adopt", issuePrefix: randomUUID().slice(0, 8) });
          managedRoot = resolveManagedInstructionsRoot({ companyId, id: agentId, name: "T", adapterConfig: {} });
          await db.insert(agents).values({ id: agentId, companyId, name: "T",
            adapterConfig: { instructionsBundleMode: "managed", instructionsRootPath: managedRoot, instructionsEntryFile: ENTRY } });
          await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, membershipRole: "operator" });
          await db.insert(principalPermissionGrants).values({ companyId, principalType: "user", principalId: userId,
            permissionKey: "agents:configure", scope: { agentIds: [agentId] } });
          await fs.mkdir(path.join(managedRoot, "notes"), { recursive: true });
          await fs.writeFile(path.join(managedRoot, ENTRY), DISK);
          await fs.writeFile(path.join(managedRoot, NOTE), NOTE_TEXT);
          const first = await runCase(item, false, checkpointed);
          expect(first.result).toEqual(adopted.result);
          expect(first.activity).toEqual(adopted.activity);
          expect([first.configRevisions, first.revisions, first.headCount]).toEqual([adopted.configRevisions, adopted.revisions, adopted.headCount]);
          if (first.result.ok) {
            // Accepted: adoption happened, then the merge, exactly as before.
            expect(first.marker).toBe(true);
            expect(first.folder).toEqual(adopted.folder);
            expect(first.activity).toEqual(["agent.files_updated"]);
          } else {
            expect(first.marker).toBe(false);
            expect(first.activity).toEqual([]);
          }
        });
      }
    }

    it("R-A6: the decision does not depend on the disk copy's mode (mode is not compared)", async () => {
      await seedHead(ENTRY, DISK); // the pending head equals the disk bytes
      await fs.chmod(path.join(managedRoot, ENTRY), 0o644);
      const baseline = await snapshotAgentFiles(managedRoot);
      const result = await apply(await sourceWith({ [ENTRY]: EDIT, [NOTE]: NOTE_TEXT }), baseline);
      // After adoption the entry is rewritten 0o600 & ~umask, a different mode with
      // the same bytes. Content identity is unchanged, so the edit is not stale.
      expect(result).toEqual({ ok: true });
      expect(await fs.readFile(path.join(managedRoot, ENTRY), "utf8")).toBe(EDIT);
    });

    it("R-A6: a pending head that differs from the disk bytes is the entry the stale check sees", async () => {
      await seedHead(ENTRY, HEAD);
      const baseline = await snapshotAgentFiles(managedRoot);
      // The run rewrote the entry to exactly the pending head: next equals present.
      expect(await apply(await sourceWith({ [ENTRY]: HEAD, [NOTE]: EDIT }), baseline)).toEqual({ ok: true });
      expect(await fs.readFile(path.join(managedRoot, NOTE), "utf8")).toBe(EDIT);
    });

    it("R-A6: a disk-only entry (no pending head for it) is compared as on disk", async () => {
      await seedHead(LEGACY_FILE, LEGACY);
      const baseline = await snapshotAgentFiles(managedRoot);
      expect(await apply(await sourceWith({ [ENTRY]: EDIT, [NOTE]: NOTE_TEXT }), baseline)).toEqual({ ok: true });
      expect(await fs.readFile(path.join(managedRoot, ENTRY), "utf8")).toBe(EDIT);
      expect(await fs.readFile(path.join(managedRoot, LEGACY_FILE), "utf8")).toBe(LEGACY);
    });
  });

  describe("quota preflight counts pending heads (R-A7)", () => {
    /** Fill the managed root so the post-adoption tree sits exactly `slack` entries under the limit. */
    async function fillEntries(count: number) {
      const per = 1000;
      for (let i = 0; i * per < count; i++) {
        const dir = path.join(managedRoot, "bulk", String(i));
        await fs.mkdir(dir, { recursive: true });
        const n = Math.min(per, count - i * per);
        await Promise.all(Array.from({ length: n }, (_v, j) => fs.writeFile(path.join(dir, `${j}`), "")));
      }
    }
    async function entryCount() {
      return (await snapshotAgentFiles(managedRoot, false)).entries.size;
    }

    for (const overBy of [0, 1]) {
      it(`R-A7: pending head files and their new parent folders count toward the entry limit (${overBy ? "one over: refused" : "exactly at: accepted"})`, async () => {
        await seedLegacyHeads(); // adds legacy/, legacy/deep/, legacy/deep/OLD.md: 3 new entries
        const base = await entryCount(); // AGENTS.md, notes/, notes/plan.md
        const bulkDirs = (fill: number) => Math.ceil(fill / 1000) + 1; // bulk/ plus bulk/<i>/
        const target = MAX_AGENT_DIRECTORY_ENTRIES - base - 3 + overBy;
        let fill = target - bulkDirs(target);
        while (fill + bulkDirs(fill) < target) fill++;
        while (fill + bulkDirs(fill) > target) fill--;
        await fillEntries(fill);
        expect(await entryCount() + 3).toBe(MAX_AGENT_DIRECTORY_ENTRIES + overBy);
        const baseline = await snapshotAgentFiles(managedRoot, false);
        const { sourceDir, checkpoint } = await checkpointFrom(baseline, { [NOTE]: EDIT });
        if (overBy) {
          const result = await expectRejectedWithoutEffect(() => apply(sourceDir, baseline, checkpoint), { status: 422 });
          expect(result).toMatchObject({ message: "Agent directory exceeds the 100,000-entry limit (files and folders)" });
        } else {
          expect(await apply(sourceDir, baseline, checkpoint)).toEqual({ ok: true });
          expect(await hasMarker()).toBe(true);
          expect(await fs.readFile(path.join(managedRoot, LEGACY_FILE), "utf8")).toBe(LEGACY);
        }
      }, 240_000);
    }

    for (const overBy of [0, 1]) {
      it(`R-A7: a pending head's bytes replace its disk copy's size in the total (${overBy ? "one byte over: refused" : "exactly at: accepted"})`, async () => {
        // Sparse files bring the disk total near the 2 GiB limit without using disk space.
        // After adoption the entry holds the pending head (headLength bytes) instead of DISK.
        const headLength = 1024;
        const note = Buffer.byteLength(NOTE_TEXT);
        let rest = MAX_AGENT_DIRECTORY_BYTES + overBy - note - headLength;
        await fs.mkdir(path.join(managedRoot, "big"), { recursive: true });
        for (let i = 0; rest > 0; i++) {
          const size = Math.min(rest, MAX_AGENT_FILE_BYTES - 1);
          const handle = await fs.open(path.join(managedRoot, "big", `${i}.bin`), "w");
          await handle.truncate(size); await handle.close();
          rest -= size;
        }
        // On disk, DISK is shorter than the head: only the replaced size can push it over.
        expect(Buffer.byteLength(DISK)).toBeLessThan(headLength);
        await seedHead(ENTRY, Buffer.alloc(headLength, 0x61));
        const baseline = await snapshotAgentFiles(managedRoot, false);
        const { sourceDir, checkpoint } = await checkpointFrom(baseline, { [NOTE]: NOTE_TEXT.replace("4", "5") });
        if (overBy) {
          const result = await expectRejectedWithoutEffect(() => apply(sourceDir, baseline, checkpoint), { status: 422 });
          expect(result).toMatchObject({ message: "Agent directory exceeds the 2 GiB total storage limit" });
        } else {
          expect(await apply(sourceDir, baseline, checkpoint)).toEqual({ ok: true });
          expect((await fs.stat(path.join(managedRoot, ENTRY))).size).toBe(headLength);
        }
      }, 240_000);
    }
  });
});
