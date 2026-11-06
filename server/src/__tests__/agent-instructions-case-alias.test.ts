import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  activityLog, agentConfigRevisions, agentInstructionHeads, agentInstructionRevisions, agents, authUsers, companies,
  companyMemberships, createDb, principalPermissionGrants,
} from "@paperclipai/db";
import { AGENT_FILES_ENTRY_CONFLICT, agentFileStore, agentFileToken, fileHash, snapshotAgentFiles } from "../services/agent-file-store.js";
import { instructionPathKey } from "../services/agent-instruction-files.js";
import { agentInstructionRevisionService } from "../services/agent-instruction-revisions.js";
import { agentInstructionsService, resolveInstructionWriteTarget, resolveManagedInstructionsRoot } from "../services/agent-instructions.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

// Synthetic sentinels stand in for private instruction text.
const ENTRY = "SENTINEL-ALIAS-ENTRY-4c1e\n";
const NEWER = "SENTINEL-ALIAS-NEWER-9b02\n";
const ALIAS = "SENTINEL-ALIAS-WRITE-37fd\n";
const OTHER = "SENTINEL-ALIAS-OTHER-d518\n";
const HEAD_ENTRY = "SENTINEL-ALIAS-HEAD-a6e0\n";
const NOTE = "notes/plan.md";
const hashOf = (content: string) => fileHash(Buffer.from(content, "utf8"));
const REVISION_REQUIRED = { status: 422, details: { code: "INSTRUCTION_REVISION_REQUIRED" } };

// The suite always runs on the ordinary temporary directory, which is
// case-sensitive on Linux CI. Set PAPERCLIP_TEST_CASE_INSENSITIVE_DIR to a
// writable directory on a case-insensitive volume to run it there as well.
const roots: Array<[string, string]> = [["temporary directory", os.tmpdir()]];
if (process.env.PAPERCLIP_TEST_CASE_INSENSITIVE_DIR) roots.push(["case-insensitive volume", process.env.PAPERCLIP_TEST_CASE_INSENSITIVE_DIR]);

describe("instruction entry aliases (letter case, Unicode form, file identity)", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const previousHome = process.env.PAPERCLIP_HOME;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("case-alias-db-");
    db = createDb(database.connectionString);
  }, 90_000);
  afterAll(async () => {
    if (previousHome === undefined) delete process.env.PAPERCLIP_HOME; else process.env.PAPERCLIP_HOME = previousHome;
    await database?.cleanup();
  });

  it("folds case and Unicode composition conservatively", () => {
    expect(instructionPathKey("AGENTS.md")).toBe(instructionPathKey("agents.md"));
    expect(instructionPathKey("Prompts/Agents.MD")).toBe(instructionPathKey("prompts/agents.md"));
    expect(instructionPathKey("Café.md")).toBe(instructionPathKey("Café.md"));
    expect(instructionPathKey("CAFÉ.md")).toBe(instructionPathKey("café.md"));
    expect(instructionPathKey("K.md")).toBe(instructionPathKey("k.md")); // Kelvin sign
    expect(instructionPathKey("Σ.md")).toBe(instructionPathKey("ς.md")); // sigma and final sigma
    expect(instructionPathKey("notes/agents.md")).not.toBe(instructionPathKey("agents.md"));
  });

  describe.each(roots)("on the %s", (_label, base) => {
    let home: string, caseInsensitive: boolean;
    let companyId: string, agentId: string, userId: string, managedRoot: string, externalRoot: string;
    const entryFile = "AGENTS.md";
    const board = () => ({ type: "board" as const, userId, source: "session" as const });
    const managedConfig = (entry = entryFile) => ({ instructionsBundleMode: "managed", instructionsRootPath: managedRoot, instructionsEntryFile: entry });
    const externalConfig = () => ({ instructionsBundleMode: "external", instructionsRootPath: externalRoot, instructionsEntryFile: entryFile });
    const setConfig = (adapterConfig: Record<string, unknown>) => db.update(agents).set({ adapterConfig }).where(eq(agents.id, agentId));
    const loadAgent = async () => (await db.select().from(agents).where(eq(agents.id, agentId)))[0]!;
    const activity = () => db.select().from(activityLog).where(eq(activityLog.entityId, agentId));
    const write = (filePath: string, content: string | null, baseHash: string | null) => agentFileStore(db).write({
      companyId, agentId, path: filePath, bytes: content === null ? null : Buffer.from(content, "utf8"), baseHash,
    }, board());
    async function tree(root: string) {
      const result: Record<string, string> = {};
      const exists = await fs.stat(root).then(() => true, () => false);
      if (!exists) return result;
      for (const [name, entry] of (await snapshotAgentFiles(root, false)).entries) result[name] = entry.kind === "file" ? entry.hash : entry.kind;
      return result;
    }
    /** Everything a rejected mutation must leave alone: both roots (the agent
     * folder includes the adoption marker), config, audit and revision rows. */
    const state = async () => ({
      agentFolder: await tree(path.dirname(managedRoot)), external: await tree(externalRoot),
      config: (await loadAgent()).adapterConfig, activity: (await activity()).length,
      configRevisions: (await db.select().from(agentConfigRevisions).where(eq(agentConfigRevisions.agentId, agentId))).length,
      heads: await db.select().from(agentInstructionHeads).where(eq(agentInstructionHeads.agentId, agentId)),
      revisions: (await db.select().from(agentInstructionRevisions).where(eq(agentInstructionRevisions.agentId, agentId))).length,
    });
    const read = (root: string, name: string) => fs.readFile(path.join(root, name), "utf8");
    // Write-backs and no-op saves complete first adoption (the marker) before
    // their checks; adopt up front where a test compares against nothing changed.
    const adopt = () => agentFileStore(db).read(companyId, agentId, NOTE, board());
    /** A delete of a variant must never remove the entry. On a case-insensitive
     * volume the variant resolves to the entry and is refused; on a case-sensitive
     * one an absent variant is the existing no-op. */
    const expectVariantDeleteRefused = async (alias: string, baseHash: string) => {
      const result = write(alias, null, baseHash);
      if (caseInsensitive) await expect(result).rejects.toMatchObject({ status: 422, message: "The configured instruction entry cannot be deleted" });
      else await expect(result).resolves.toEqual({ contentHash: null, changed: false });
    };
    /** Content of every file under root, following no links and allowing hard links. */
    async function contents(root: string) {
      const result: Record<string, string> = {};
      async function walk(dir: string) {
        for (const item of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
          const full = path.join(dir, item.name);
          if (item.isDirectory()) await walk(full); else result[path.relative(root, full)] = hashOf(await fs.readFile(full, "utf8"));
        }
      }
      await walk(root);
      return result;
    }
    const seedHead = async (name: string) => {
      const revisionId = randomUUID();
      await db.insert(agentInstructionRevisions).values({ id: revisionId, companyId, agentId, entryFile: name,
        contentBase64: Buffer.from(HEAD_ENTRY).toString("base64"), contentHash: hashOf(HEAD_ENTRY), byteLength: HEAD_ENTRY.length, source: "board" });
      await db.insert(agentInstructionHeads).values({ companyId, agentId, entryFile: name, revisionId });
    };

    beforeAll(async () => {
      home = await fs.realpath(await fs.mkdtemp(path.join(base, "case-alias-")));
      await fs.writeFile(path.join(home, "Probe"), "");
      caseInsensitive = await fs.stat(path.join(home, "probe")).then(() => true, () => false);
    });
    afterAll(async () => { if (home) await fs.rm(home, { recursive: true, force: true }); });
    beforeEach(async () => {
      process.env.PAPERCLIP_HOME = home;
      companyId = randomUUID(); agentId = randomUUID(); userId = randomUUID();
      await db.insert(companies).values({ id: companyId, name: "Case alias tests", issuePrefix: randomUUID().slice(0, 8) });
      await db.insert(authUsers).values({ id: userId, name: "Editor", email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
      managedRoot = resolveManagedInstructionsRoot({ companyId, id: agentId, name: "Target", adapterConfig: {} });
      externalRoot = path.join(home, "external", agentId);
      await db.insert(agents).values({ id: agentId, companyId, name: "Target", adapterConfig: managedConfig() });
      await db.insert(companyMemberships).values([
        { companyId, principalType: "user", principalId: userId, membershipRole: "operator" },
        { companyId, principalType: "agent", principalId: agentId, membershipRole: "member" },
      ]);
      await db.insert(principalPermissionGrants).values({ companyId, principalType: "user", principalId: userId, permissionKey: "agents:configure", scope: { agentIds: [agentId] } });
      await fs.mkdir(path.join(managedRoot, "notes"), { recursive: true });
      await fs.writeFile(path.join(managedRoot, entryFile), ENTRY);
      await fs.writeFile(path.join(managedRoot, NOTE), OTHER);
    });

    it("refuses a managed save to a case variant of the entry for every base, changing nothing", async () => {
      const before = await state();
      for (const alias of ["agents.md", "Agents.md", "AGENTS.MD"]) {
        for (const baseHash of [hashOf(ENTRY), hashOf(OTHER), null]) {
          await expect(write(alias, ALIAS, baseHash)).rejects.toMatchObject(REVISION_REQUIRED);
        }
      }
      expect(await state()).toEqual(before);
      expect(await read(managedRoot, entryFile)).toBe(ENTRY);
    });

    it("refuses a managed delete of a case variant of the entry", async () => {
      // On a case-sensitive volume the variant is a separate file; it still names the entry elsewhere.
      if (!caseInsensitive) await fs.writeFile(path.join(managedRoot, "Agents.MD"), OTHER);
      const current = caseInsensitive ? ENTRY : OTHER;
      const before = await state();
      await expect(write("Agents.MD", null, hashOf(current))).rejects.toMatchObject({ status: 422, message: "The configured instruction entry cannot be deleted" });
      expect(await state()).toEqual(before);
      expect(await read(managedRoot, entryFile)).toBe(ENTRY);
    });

    it("protects a nested entry against case variants of its folder and name", async () => {
      await adopt(); // a no-op delete completes first adoption; compare after it
      await fs.mkdir(path.join(managedRoot, "prompts"), { recursive: true });
      await fs.writeFile(path.join(managedRoot, "prompts", entryFile), ENTRY);
      await setConfig(managedConfig("prompts/AGENTS.md"));
      const before = await state();
      for (const alias of ["PROMPTS/agents.md", "prompts/agents.md", "Prompts/AGENTS.md", "PROMPTS/AGENTS.md"]) {
        await expect(write(alias, ALIAS, hashOf(ENTRY))).rejects.toMatchObject(REVISION_REQUIRED);
        await expectVariantDeleteRefused(alias, hashOf(ENTRY));
      }
      expect(await state()).toEqual(before);
      expect(await read(managedRoot, "prompts/AGENTS.md")).toBe(ENTRY);
    });

    it("refuses a Unicode-equivalent spelling of the entry (NFC entry, NFD and upper-case paths)", async () => {
      const nfc = "Café.md";
      await fs.writeFile(path.join(managedRoot, nfc), ENTRY);
      await setConfig(managedConfig(nfc));
      const before = await state();
      for (const alias of ["Café.md", "CAFÉ.md", "café.MD"]) {
        await expect(write(alias, ALIAS, hashOf(ENTRY))).rejects.toMatchObject(REVISION_REQUIRED);
      }
      expect(await state()).toEqual(before);
      expect(await read(managedRoot, nfc)).toBe(ENTRY);
    });

    it("protects the recovered entry of an unconfigured bundle under a case variant", async () => {
      await adopt(); // a no-op delete completes first adoption; compare after it
      await fs.rm(managedRoot, { recursive: true, force: true });
      await fs.mkdir(managedRoot, { recursive: true });
      await fs.writeFile(path.join(managedRoot, "CUSTOM.md"), ENTRY);
      await fs.writeFile(path.join(managedRoot, "other.md"), OTHER);
      await setConfig({});
      expect((await agentInstructionsService(db).getBundle(await loadAgent())).entryFile).toBe("CUSTOM.md");
      const before = await state();
      await expect(write("custom.md", ALIAS, hashOf(ENTRY))).rejects.toMatchObject(REVISION_REQUIRED);
      await expectVariantDeleteRefused("Custom.MD", hashOf(ENTRY));
      expect(await state()).toEqual(before);
      // An ordinary file in the same bundle stays writable.
      await expect(write("other.md", ALIAS, hashOf(OTHER))).resolves.toMatchObject({ changed: true });
      expect(await read(managedRoot, "CUSTOM.md")).toBe(ENTRY);
    });

    it("refuses a save or delete through a hard-linked name for the managed entry", async () => {
      // Managed folders already refuse linked files; the entry must stay unchanged either way.
      await fs.link(path.join(managedRoot, entryFile), path.join(managedRoot, "linked.md"));
      const before = { files: await contents(managedRoot), activity: (await activity()).length };
      await expect(write("linked.md", ALIAS, hashOf(ENTRY))).rejects.toMatchObject({ status: 422 });
      await expect(write("linked.md", null, hashOf(ENTRY))).rejects.toMatchObject({ status: 422 });
      expect({ files: await contents(managedRoot), activity: (await activity()).length }).toEqual(before);
      expect(await read(managedRoot, entryFile)).toBe(ENTRY);
    });

    it("refuses an unversioned save or delete through another name for the external entry's file", async (context) => {
      // The case-insensitive test volume (a FUSE emulation) reports a separate
      // inode for each name, so file identity can only be checked on a real volume.
      if (caseInsensitive) context.skip();
      // The unversioned path writes in place, so a save through a hard link would change the entry itself.
      await fs.mkdir(externalRoot, { recursive: true });
      await fs.writeFile(path.join(externalRoot, entryFile), ENTRY);
      await fs.link(path.join(externalRoot, entryFile), path.join(externalRoot, "linked.md"));
      await setConfig(externalConfig());
      const agent = await loadAgent();
      const expected = { expectedMode: "external" as const, expectedTarget: await resolveInstructionWriteTarget(agent) };
      const before = { files: await contents(externalRoot), activity: (await activity()).length };
      await expect(agentInstructionsService(db).writeFile(agent, "linked.md", ALIAS, expected)).rejects.toMatchObject(REVISION_REQUIRED);
      await expect(agentInstructionsService(db).deleteFile(agent, "linked.md", expected)).rejects.toMatchObject({ status: 422, message: "Cannot delete the bundle entry file" });
      expect({ files: await contents(externalRoot), activity: (await activity()).length }).toEqual(before);
      expect(await read(externalRoot, entryFile)).toBe(ENTRY);
    });

    it("refuses an unversioned save or delete of a case variant of an external entry, in the external root only", async () => {
      await fs.mkdir(externalRoot, { recursive: true });
      await fs.writeFile(path.join(externalRoot, entryFile), ENTRY);
      if (!caseInsensitive) await fs.writeFile(path.join(externalRoot, "Agents.MD"), OTHER);
      await setConfig(externalConfig());
      const agent = await loadAgent();
      const expected = { expectedMode: "external" as const, expectedTarget: await resolveInstructionWriteTarget(agent) };
      const instructions = agentInstructionsService(db);
      const before = await state();
      for (const alias of ["agents.md", "Agents.MD"]) {
        await expect(instructions.writeFile(agent, alias, ALIAS, expected)).rejects.toMatchObject(REVISION_REQUIRED);
        await expect(instructions.deleteFile(agent, alias, expected)).rejects.toMatchObject({ status: 422, message: "Cannot delete the bundle entry file" });
      }
      expect(await state()).toEqual(before);
      expect(await read(externalRoot, entryFile)).toBe(ENTRY);
      expect(await read(managedRoot, entryFile)).toBe(ENTRY);
      // An ordinary external file is still saved, in the external root.
      await instructions.writeFile(agent, "notes/external.md", OTHER, expected);
      expect(await read(externalRoot, "notes/external.md")).toBe(OTHER);
      expect(await fs.stat(path.join(managedRoot, "notes/external.md")).then(() => true, () => false)).toBe(false);
    });

    it("refuses an unversioned save to a case variant of an entry with revision history", async () => {
      await fs.mkdir(externalRoot, { recursive: true });
      await fs.writeFile(path.join(externalRoot, entryFile), ENTRY);
      await setConfig(externalConfig());
      await seedHead("LEGACY.md");
      const agent = await loadAgent();
      const expected = { expectedMode: "external" as const, expectedTarget: await resolveInstructionWriteTarget(agent) };
      const before = await state();
      for (const alias of ["legacy.md", "Legacy.MD"]) {
        await expect(agentInstructionsService(db).writeFile(agent, alias, ALIAS, expected)).rejects.toMatchObject({
          ...REVISION_REQUIRED, message: "This entry has revision history. Use the instruction content API with its baseRevisionId to update it.",
        });
      }
      expect(await state()).toEqual(before);
    });

    describe("run write-back", () => {
      const apply = (sourceDir: string, baseline: Awaited<ReturnType<typeof snapshotAgentFiles>>) =>
        agentFileStore(db).apply({ companyId, agentId, sourceDir, baseline }, board());
      async function sourceWith(files: Record<string, string>) {
        // Always case-sensitive, like a remote runner's working copy.
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), "case-alias-source-"));
        for (const [name, content] of Object.entries(files)) {
          await fs.mkdir(path.dirname(path.join(dir, name)), { recursive: true });
          await fs.writeFile(path.join(dir, name), content);
        }
        return dir;
      }

      it("rejects a case variant that would replace a newer canonical entry past the stale-entry check", async () => {
        const baseline = await snapshotAgentFiles(managedRoot);
        await fs.writeFile(path.join(managedRoot, entryFile), NEWER);
        const source = await sourceWith({ [entryFile]: ENTRY, [NOTE]: OTHER, "agents.md": ALIAS });
        await adopt();
        const before = await state();
        await expect(apply(source, baseline)).rejects.toMatchObject({ status: 409, details: { code: AGENT_FILES_ENTRY_CONFLICT, path: entryFile } });
        expect(await state()).toEqual(before);
        expect(await read(managedRoot, entryFile)).toBe(NEWER);
      });

      it("rejects removing a folder above the entry under another spelling", async () => {
        await fs.mkdir(path.join(managedRoot, "prompts"), { recursive: true });
        await fs.writeFile(path.join(managedRoot, "prompts", entryFile), ENTRY);
        await setConfig(managedConfig("prompts/AGENTS.md"));
        const current = await snapshotAgentFiles(managedRoot);
        // The run started with a separately spelled folder and removed it.
        const baseline = { ...current, entries: new Map([...current.entries, ["PROMPTS", { kind: "dir" as const }],
          ["PROMPTS/x.md", { kind: "file" as const, mode: 0o644, hash: hashOf(OTHER) }]]) };
        const source = await sourceWith({ "prompts/AGENTS.md": ENTRY, [entryFile]: ENTRY, [NOTE]: OTHER });
        await adopt();
        const before = await state();
        await expect(apply(source, baseline)).rejects.toMatchObject({ status: 409, details: { code: AGENT_FILES_ENTRY_CONFLICT } });
        expect(await state()).toEqual(before);
      });

      it("still applies ordinary changes, including files in a differently spelled ordinary folder", async () => {
        const baseline = await snapshotAgentFiles(managedRoot);
        const source = await sourceWith({ [entryFile]: ENTRY, [NOTE]: ALIAS, "NOTES/extra.md": OTHER, "notes/agents-guide.md": OTHER });
        await expect(apply(source, baseline)).resolves.toBeDefined();
        expect(await read(managedRoot, NOTE)).toBe(ALIAS);
        expect(await read(managedRoot, "notes/agents-guide.md")).toBe(OTHER);
        expect(await read(managedRoot, entryFile)).toBe(ENTRY);
      });
    });

    it("keeps ordinary files and the canonical entry path working", async () => {
      // Ordinary saves and deletes, including a file named like the entry in another folder.
      await expect(write(NOTE, ALIAS, hashOf(OTHER))).resolves.toMatchObject({ changed: true });
      await expect(write("notes/agents.md", OTHER, null)).resolves.toMatchObject({ changed: true });
      await expect(write("notes/agents.md", null, hashOf(OTHER))).resolves.toMatchObject({ changed: true });
      // The exact entry name is still refused by the store, as before.
      await expect(write(entryFile, ALIAS, hashOf(ENTRY))).rejects.toMatchObject(REVISION_REQUIRED);
      // The entry still changes through the canonical revision service.
      const receipt = await agentInstructionRevisionService(db).commit({ companyId, agentId, entryFile, content: NEWER,
        baseRevisionId: agentFileToken(Buffer.from(ENTRY)), source: "board" }, board());
      expect(receipt.changed).toBe(true);
      expect(await read(managedRoot, entryFile)).toBe(NEWER);
      const audit = (await activity()).filter(row => row.action === "agent.files_updated").map(row => (row.details as { path: string }).path);
      expect(audit).toEqual(expect.arrayContaining([NOTE, "notes/agents.md", entryFile]));
    });
  });
});
