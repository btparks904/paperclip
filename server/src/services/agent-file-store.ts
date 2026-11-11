import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { cachedAgentFileManifest, checkpointSnapshot, type AgentFileManifest } from "./agent-file-checkpoints.js";
import { constants } from "node:fs";
import { Readable } from "node:stream";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { agents, activityLog, agentInstructionHeads, agentInstructionRevisions, type Db } from "@paperclipai/db";
import { captureDirectorySnapshot, mergeDirectoryWithBaseline, type DirectorySnapshot, type SnapshotEntry } from "@paperclipai/adapter-utils/workspace-restore-merge";
import { HttpError, conflict, notFound, unprocessable } from "../errors.js";
import { authorizeInstructionCommit, authorizeInstructionRead } from "./agent-instruction-authorization.js";
import { assertInstructionPathSafe, instructionPath, instructionPathKey, matchesInstructionEntry, instructionBytes, materializeInstructionBytes, readInstructionBytes, MAX_INSTRUCTION_BYTES } from "./agent-instruction-files.js";
import { agentInstructionsBundleMode, deriveBundleState, resolveManagedInstructionsRoot, resolveRecoveredManagedBundle, type RecoveredManagedBundle } from "./agent-instructions.js";
import type { AuthorizationActor } from "./authorization.js";

export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Agent = typeof agents.$inferSelect;
/** Persists a repaired instruction bundle configuration inside the store's
 * locked transaction. Supplied by the caller so the store does not import the
 * agent service (which would form a module cycle). */
export type AgentFileConfigRepair = (tx: Tx, agent: Agent, adapterConfig: Record<string, unknown>) => Promise<void>;
export type AgentFileWriteOptions = {
  /** The caller passed the stale-root (instance-admin) gate, so a bundle that
   * the existing recovery rules treat as managed at the canonical managed root
   * may be written even though its stored root differs. Explicitly external
   * bundles are always refused. */
  allowRecoveredManaged?: boolean;
  repairConfig?: AgentFileConfigRepair;
};
export const AGENT_FILES_CONTRACT = "paperclip.agent-files.v1";
export const MAX_AGENT_FILE_BYTES = 256 * 1024 * 1024;
export const MAX_AGENT_DIRECTORY_BYTES = 2 * 1024 * 1024 * 1024;
export const MAX_AGENT_DIRECTORY_ENTRIES = 100_000;
export const fileHash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

export class AgentFileLimitError extends HttpError {
  constructor(message: string) {
    super(422, message, { code: "AGENT_FILES_LIMIT_EXCEEDED" });
  }
}
function assertFileSize(size: number, relative: string) {
  if (size > MAX_AGENT_FILE_BYTES) throw new AgentFileLimitError(`Agent file "${relative}" exceeds the 256 MiB per-file limit`);
}
export function assertDirectorySize(size: number, count: number) {
  if (size > MAX_AGENT_DIRECTORY_BYTES) throw new AgentFileLimitError("Agent directory exceeds the 2 GiB total storage limit");
  if (count > MAX_AGENT_DIRECTORY_ENTRIES) throw new AgentFileLimitError("Agent directory exceeds the 100,000-entry limit (files and folders)");
}
export const AGENT_FILES_ENTRY_CONFLICT = "AGENT_FILES_ENTRY_CONFLICT";

/** Content identity of one snapshot entry. Files compare by SHA-256 only, never
 * by mode, size, timestamps, inode or path; an absent entry is null. */
function entryIdentity(entry: SnapshotEntry | undefined): string | null {
  if (!entry) return null;
  if (entry.kind === "file") return `file:${entry.hash}`;
  return entry.kind === "symlink" ? `symlink:${entry.target}` : "dir";
}

/** A write-back is stale for the configured entry when apply would write the
 * copy's entry, canonical content also changed after the copy's durable
 * baseline, and the copy's content differs from canonical content. Applying it
 * would replace newer entry content. "Would write" mirrors apply's changed-path
 * rule, so a mode-only change that copies the whole file is covered. */
export function isStaleEntryWriteBack(entryPath: string, baseline: DirectorySnapshot,
  incoming: DirectorySnapshot, current: DirectorySnapshot): boolean {
  const baselineEntry = baseline.entries.get(entryPath), incomingEntry = incoming.entries.get(entryPath);
  const writes = JSON.stringify(baselineEntry) !== JSON.stringify(incomingEntry);
  const before = entryIdentity(baselineEntry);
  const next = entryIdentity(incomingEntry);
  const present = entryIdentity(current.entries.get(entryPath));
  return writes && present !== before && next !== present;
}

export function isAgentFileEntryConflict(error: unknown): boolean {
  return error instanceof HttpError && error.status === 409 &&
    (error.details as { code?: unknown } | undefined)?.code === AGENT_FILES_ENTRY_CONFLICT;
}

export function agentStorageWarning(detail: string) {
  return `Agent storage is full. ${detail}. Runs can continue; remove or shrink files in AGENT_HOME to free space. Changes exceeding the storage limits will not be saved.`;
}
function storageWarning(size: number, count: number, fullFile?: string) {
  if (size >= MAX_AGENT_DIRECTORY_BYTES) return agentStorageWarning("The agent folder has reached its 2 GiB limit");
  if (count >= MAX_AGENT_DIRECTORY_ENTRIES) return agentStorageWarning("The agent folder has reached its 100,000-entry limit");
  if (fullFile) return agentStorageWarning(`Agent file "${fullFile}" has reached its 256 MiB limit`);
  return null;
}

export function agentFilePath(value: string): string {
  const relative = instructionPath(value);
  if (relative.split("/").includes(".paperclip-runtime") || relative === "promptTemplate.legacy.md") {
    throw unprocessable(`${relative} is reserved and cannot be used for agent files`);
  }
  return relative;
}

/** Compatibility ETag for clients whose old schema requires a UUID. This is a
 * content token, not a revision ID: no snapshot or history row is created. */
export function agentFileToken(bytes: Uint8Array): string {
  return agentFileTokenFromHash(fileHash(bytes));
}
export function agentFileTokenFromHash(h: string): string {
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

type AdoptionPlan = { root: string; markerRoot: string; marker: string; pending: Array<{ entryFile: string; bytes: Buffer }> | null };

/** Call under the agent row lock. Reads what first adoption would write
 * without writing it (beyond creating the managed directory), so a caller can
 * validate an operation before any file bytes change. */
async function planAgentFileAdoption(tx: Tx, agent: Agent, options?: { recoveredManaged?: boolean }): Promise<AdoptionPlan> {
  // A recovered-managed bundle is classified "external" by the synchronous
  // check only because its stored root is stale; the caller has already
  // re-evaluated it under this lock as managed at the canonical managed root.
  if (agentInstructionsBundleMode(agent) === "external" && !options?.recoveredManaged) {
    throw unprocessable("External instructions must be migrated to managed storage first");
  }
  const root = resolveManagedInstructionsRoot(agent);
  const markerRoot = path.join(path.dirname(root), "file-sync");
  const marker = "adopted.json";
  await assertInstructionPathSafe(root, deriveBundleState(agent).entryFile);
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const filename = await assertInstructionPathSafe(markerRoot, marker);
  const adopted = await fs.readFile(filename, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (adopted !== null) {
    if (JSON.parse(adopted).schema !== AGENT_FILES_CONTRACT) throw new Error("Unsupported agent file contract");
    return { root, markerRoot, marker, pending: null };
  }
  const legacy = await tx.select({ entryFile: agentInstructionHeads.entryFile, contentBase64: agentInstructionRevisions.contentBase64 })
    .from(agentInstructionHeads).innerJoin(agentInstructionRevisions, eq(agentInstructionHeads.revisionId, agentInstructionRevisions.id))
    .where(and(eq(agentInstructionHeads.companyId, agent.companyId), eq(agentInstructionHeads.agentId, agent.id)));
  return { root, markerRoot, marker, pending: legacy.map(entry => ({ entryFile: entry.entryFile, bytes: Buffer.from(entry.contentBase64, "base64") })) };
}

async function completeAgentFileAdoption(plan: AdoptionPlan) {
  if (!plan.pending) return;
  for (const entry of plan.pending) await materializeInstructionBytes(plan.root, entry.entryFile, entry.bytes);
  await materializeInstructionBytes(plan.markerRoot, plan.marker, Buffer.from(JSON.stringify({ schema: AGENT_FILES_CONTRACT })));
  plan.pending = null;
}

/** Call under the agent row lock. Import deployed revision heads once, then the
 * directory is authoritative. The adoption marker lives OUTSIDE agent files. */
export async function adoptAgentFiles(tx: Tx, agent: Agent, options?: { recoveredManaged?: boolean }): Promise<string> {
  const plan = await planAgentFileAdoption(tx, agent, options);
  await completeAgentFileAdoption(plan);
  return plan.root;
}

async function openAgentFile(root: string, relative: string) {
  const filename = await assertInstructionPathSafe(root, relative);
  const handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!handle) return null;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1) throw unprocessable("Agent files must be regular files without links");
    assertFileSize(stat.size, relative);
    return { handle, size: stat.size };
  } catch (error) { await handle.close(); throw error; }
}

/** Hash large files incrementally. Only editor-sized content is retained in RAM. */
export async function inspectAgentFile(root: string, relative: string, bufferLimit = MAX_INSTRUCTION_BYTES) {
  const opened = await openAgentFile(root, relative);
  if (!opened) return null;
  const hash = createHash("sha256");
  let chunks: Buffer[] | null = opened.size <= bufferLimit ? [] : null;
  let size = 0;
  try {
    for await (const chunk of opened.handle.createReadStream()) {
      size += chunk.length;
      assertFileSize(size, relative);
      hash.update(chunk);
      if (size > bufferLimit) chunks = null;
      chunks?.push(chunk);
    }
    return { size, hash: hash.digest("hex"), bytes: chunks ? Buffer.concat(chunks) : null };
  } finally { await opened.handle.close(); }
}

export async function readAgentFile(root: string, relative: string): Promise<Buffer | null> {
  return (await inspectAgentFile(root, relative, MAX_AGENT_FILE_BYTES))?.bytes ?? null;
}

/** Validate before staging and again after provider stop; never follow links or
 * silently skip an unsupported file. Bounds apply to bytes, including binaries. */
async function scanAgentFiles(root: string, enforceLimits = true) {
  await assertInstructionPathSafe(root, ".path-check");
  let size = 0, count = 0;
  const entries = new Set<string>();
  let fullFile: string | undefined;
  async function walk(dir: string) {
    for (const item of await fs.readdir(path.join(root, dir), { withFileTypes: true })) {
      const relative = agentFilePath(dir ? `${dir}/${item.name}` : item.name);
      const stat = await fs.lstat(path.join(root, relative));
      count++;
      if (enforceLimits) assertDirectorySize(size, count);
      entries.add(relative);
      if (stat.isDirectory()) await walk(relative);
      else if (stat.isFile() && stat.nlink === 1) {
        size += stat.size;
        if (stat.size >= MAX_AGENT_FILE_BYTES) fullFile ??= relative;
        if (enforceLimits) {
          assertFileSize(stat.size, relative);
          assertDirectorySize(size, count);
        }
      } else throw unprocessable("Agent directories support regular files and directories, without links or special files");
    }
  }
  await walk("");
  return { size, entries, storageWarning: storageWarning(size, count, fullFile) };
}

export async function inspectAgentDirectory(root: string, enforceLimits = true) {
  const usage = await scanAgentFiles(root, enforceLimits);
  return { snapshot: await captureDirectorySnapshot(root), storageWarning: usage.storageWarning };
}
export async function snapshotAgentFiles(root: string, enforceLimits = true): Promise<DirectorySnapshot> {
  return (await inspectAgentDirectory(root, enforceLimits)).snapshot;
}

type ApplyTree = Map<string, { value: SnapshotEntry; root: string }>;

/** The tree a write-back would leave: the current tree, minus the run's
 * removed paths, plus its changed paths from the source, with parent folders. */
function applyFinalTree(baseline: DirectorySnapshot, incoming: DirectorySnapshot, current: DirectorySnapshot,
  root: string, sourceDir: string): ApplyTree {
  const changed = [...new Set([...baseline.entries, ...incoming.entries].map(([name]) => name))]
    .filter(name => JSON.stringify(baseline.entries.get(name)) !== JSON.stringify(incoming.entries.get(name)));
  const finalEntries: ApplyTree = new Map([...current.entries].map(([name, value]) => [name, { value, root }]));
  for (const name of changed) if (!incoming.entries.has(name)) finalEntries.delete(name);
  for (const [name, value] of incoming.entries) {
    if (JSON.stringify(baseline.entries.get(name)) === JSON.stringify(value)) continue;
    if (value.kind !== "dir") for (const child of finalEntries.keys()) if (child.startsWith(`${name}/`)) finalEntries.delete(child);
    finalEntries.set(name, { value, root: sourceDir });
    for (let parent = path.posix.dirname(name); parent !== "."; parent = path.posix.dirname(parent)) {
      if (finalEntries.get(parent)?.value.kind !== "dir") finalEntries.set(parent, { value: { kind: "dir" }, root: sourceDir });
    }
  }
  // An unchanged file created by another run can keep a removed folder
  // alive. Count those surviving parent directories in quota preflight.
  for (const name of finalEntries.keys()) {
    for (let parent = path.posix.dirname(name); parent !== "."; parent = path.posix.dirname(parent)) {
      if (!finalEntries.has(parent)) finalEntries.set(parent, { value: { kind: "dir" }, root });
    }
  }
  return finalEntries;
}

/** Enforce the per-file and directory limits on a write-back's resulting tree.
 * sizeOf can supply a size for a file not yet on disk (a pending legacy head). */
async function applyTreeUsage(finalEntries: ApplyTree,
  sizeOf?: (name: string, item: { value: SnapshotEntry; root: string }) => number | undefined) {
  let total = 0;
  let fullFile: string | undefined;
  for (const [name, item] of finalEntries) if (item.value.kind === "file") {
    const size = sizeOf?.(name, item) ?? (await fs.stat(path.join(item.root, name))).size;
    assertFileSize(size, name);
    if (size >= MAX_AGENT_FILE_BYTES) fullFile ??= name;
    total += size;
  }
  assertDirectorySize(total, finalEntries.size);
  return { total, fullFile };
}

export function agentFileStore(db: Db) {
  async function locked<T>(companyId: string, agentId: string, actor: AuthorizationActor, write: boolean,
    fn: (tx: Tx, agent: Agent, root: string, bound: AuthorizationActor, recovered: RecoveredManagedBundle | null, adoption: AdoptionPlan) => Promise<T>,
    options?: { recoverManaged?: boolean; allowRecoveredManaged?: boolean; deferAdoption?: boolean }) {
    return db.transaction(async tx => {
      // FOR NO KEY UPDATE, like every instruction writer that can take the
      // instruction-root assignment lock: writers of this agent still
      // serialize, and a foreign-key KEY SHARE lock on this row (for example a
      // revision attributed to this agent) never waits on it.
      const [agent] = await tx.select().from(agents).where(and(eq(agents.companyId, companyId), eq(agents.id, agentId))).for("no key update");
      if (!agent) throw notFound("Agent not found");
      const bound = write ? await authorizeInstructionCommit(tx, actor, agent) : await authorizeInstructionRead(tx, actor, agent);
      // Re-evaluate recovery on the locked row, never on the caller's earlier read.
      const recovered = options?.recoverManaged || options?.allowRecoveredManaged ? await resolveRecoveredManagedBundle(agent) : null;
      const adoption = await planAgentFileAdoption(tx, agent, { recoveredManaged: options?.allowRecoveredManaged === true && recovered !== null });
      if (recovered && adoption.root !== recovered.rootPath) throw conflict("The instructions bundle mode changed; reload and retry");
      // A deferring caller completes adoption itself once its operation is valid.
      if (!options?.deferAdoption) await completeAgentFileAdoption(adoption);
      return fn(tx, agent, adoption.root, bound, recovered, adoption);
    });
  }
  async function audit(tx: Tx, agent: Agent, actor: AuthorizationActor, details: Record<string, unknown>) {
    await tx.insert(activityLog).values({ companyId: agent.companyId, actorType: actor.type === "board" ? "user" : "agent",
      actorId: (actor.type === "board" ? actor.userId : actor.agentId)!, agentId: actor.type === "agent" ? actor.agentId : null,
      runId: actor.runId, responsibleUserId: actor.type === "board" ? actor.userId : actor.onBehalfOfUserId,
      action: "agent.files_updated", entityType: "agent", entityId: agent.id, details });
  }
  return {
    locked,
    download: async (companyId: string, agentId: string, relative: string, actor: AuthorizationActor) => {
      const opened: { file: Awaited<ReturnType<typeof openAgentFile>> } = { file: null };
      try {
        const file = await locked(companyId, agentId, actor, false, async (_tx, _agent, root) => {
          opened.file = await openAgentFile(root, instructionPath(relative));
          return opened.file;
        });
        // Transfer outside the database lock. The open descriptor pins the file
        // across concurrent atomic replacements; end bounds concurrent growth.
        if (!file) return null;
        if (file.size === 0) { await file.handle.close(); return { size: 0, stream: Readable.from([]) }; }
        return { size: file.size, stream: file.handle.createReadStream({ end: file.size - 1 }) };
      } catch (error) { await opened.file?.handle.close(); throw error; }
    },
    read: (companyId: string, agentId: string, relative: string, actor: AuthorizationActor) =>
      locked(companyId, agentId, actor, false, (_tx, _agent, root) => readAgentFile(root, instructionPath(relative))),
    write: (input: { companyId: string; agentId: string; path: string; bytes: Buffer | null; baseHash: string | null }, actor: AuthorizationActor,
      options?: AgentFileWriteOptions) =>
      locked(input.companyId, input.agentId, actor, true, async (tx, agent, root, bound, recovered, adoption) => {
        // Bundles the store did not serve before (unconfigured or stale-root
        // recovered-managed) use the recovered entry and may need their stored
        // configuration repaired. Normal managed bundles keep their behavior.
        const recoveredOnly = recovered !== null && agentInstructionsBundleMode(agent) !== "managed" ? recovered : null;
        // The entry is protected under both the configured name and the name the
        // recovery rules select from disk, as resolved on this locked row: either
        // can be the entry the bundle reports, and neither may change here.
        const entryFiles = new Set([deriveBundleState(agent).entryFile]);
        if (recovered) entryFiles.add(recovered.entryFile);
        const relative = agentFilePath(input.path);
        // On a case-insensitive volume "agents.md" opens, replaces and unlinks
        // "AGENTS.md", so the entry is matched by folded key and file identity.
        const isEntry = await matchesInstructionEntry(root, relative, entryFiles);
        // Entry content changes only through the canonical instruction revision
        // service. Refuse before any check that could adopt or write files.
        if (input.bytes !== null && isEntry) {
          throw unprocessable("Entry edits require the canonical instruction commit service and baseRevisionId", { code: "INSTRUCTION_REVISION_REQUIRED" });
        }
        if (input.bytes) assertFileSize(input.bytes.length, relative);
        // First adoption is validated against, not written, until this operation
        // passes its checks: a rejected save or delete changes no file bytes.
        const pending = adoption.pending ?? [];
        const pendingBytes = pending.find(entry => entry.entryFile === relative)?.bytes;
        const previous = pendingBytes ? { size: pendingBytes.length, hash: fileHash(pendingBytes) } : await inspectAgentFile(root, relative);
        const currentHash = previous?.hash ?? null;
        const incomingHash = input.bytes === null ? null : fileHash(input.bytes);
        if (currentHash === incomingHash) {
          await completeAgentFileAdoption(adoption);
          return { contentHash: currentHash, changed: false };
        }
        if (currentHash !== input.baseHash) throw conflict("This file changed since it was read. Reload before saving.", { code: "AGENT_FILE_CONFLICT", path: relative, currentHash });
        if (input.bytes === null && isEntry) throw unprocessable("The configured instruction entry cannot be deleted");
        if (input.bytes !== null) {
          // A quota check needs metadata only. Do not hash unrelated large
          // files while holding the editor's row lock for a one-file save.
          const snapshot = await scanAgentFiles(root);
          const ancestry = (name: string) => name.split("/").map((_part, i, parts) => parts.slice(0, i + 1).join("/"));
          const diskSize = async (name: string) => {
            const stat = await fs.lstat(path.join(root, name)).catch(() => null);
            return stat?.isFile() ? stat.size : 0;
          };
          // Size after adoption and this write: the target replaces whatever is on
          // disk now, and every other pending head replaces its disk copy.
          let total = snapshot.size + input.bytes.length - (pendingBytes ? await diskSize(relative) : (previous?.size ?? 0));
          const added = new Set<string>();
          for (const entry of pending) {
            if (entry.entryFile !== relative) total += entry.bytes.length - await diskSize(entry.entryFile);
            for (const name of ancestry(entry.entryFile)) if (!snapshot.entries.has(name)) added.add(name);
          }
          for (const name of ancestry(relative)) if (!snapshot.entries.has(name)) added.add(name);
          assertDirectorySize(total, snapshot.entries.size + added.size);
        }
        // Persist the configuration the unversioned save path would have stored
        // (only on a changing save, never on a delete). It runs before adoption
        // and the file write, inside this transaction, so a rejected repair
        // changes no file bytes and a later failure rolls its database rows back.
        if (input.bytes !== null && recoveredOnly?.repairedConfig && options?.repairConfig) {
          await options.repairConfig(tx, agent, recoveredOnly.repairedConfig);
        }
        // The file bytes below are not transactional: if the audit fails, the
        // database rows roll back but the written file remains, as for any
        // managed save.
        await completeAgentFileAdoption(adoption);
        if (input.bytes === null) await fs.unlink(await assertInstructionPathSafe(root, relative));
        else await materializeInstructionBytes(root, relative, input.bytes);
        await audit(tx, agent, bound, { path: relative, contentHash: incomingHash });
        return { contentHash: incomingHash, changed: true };
      // Always resolve recovery under the lock so an unconfigured bundle's
      // recovered entry stays protected even without the stale-root allowance.
      }, { recoverManaged: true,
        allowRecoveredManaged: options?.allowRecoveredManaged === true, deferAdoption: true }),
    apply: (input: { companyId: string; agentId: string; sourceDir: string; baseline: DirectorySnapshot; checkpoint?: AgentFileManifest }, actor: AuthorizationActor) =>
      locked(input.companyId, input.agentId, actor, true, async (tx, agent, root, bound, _recovered, adoption) => {
        const incoming = input.checkpoint ? checkpointSnapshot(input.checkpoint) : await snapshotAgentFiles(input.sourceDir);
        const entryPath = deriveBundleState(agent).entryFile;
        // A changed path that names the entry under another spelling (letter case
        // or Unicode form), or that replaces or removes a folder above the entry
        // under another spelling, would land on the entry on a case-insensitive
        // volume, past the stale-entry check below. Reject the whole write-back.
        // The check reads only the baseline and incoming snapshots, so it runs
        // before first adoption: a rejection leaves the adoption marker and the
        // legacy head projections untouched. The checks after adoption keep
        // their existing order.
        const entryKey = instructionPathKey(entryPath);
        for (const name of new Set([...input.baseline.entries, ...incoming.entries].map(([entryName]) => entryName))) {
          if (name === entryPath || JSON.stringify(input.baseline.entries.get(name)) === JSON.stringify(incoming.entries.get(name))) continue;
          const key = instructionPathKey(name);
          const replacesEntryFolder = entryKey.startsWith(`${key}/`) && !entryPath.startsWith(`${name}/`)
            && incoming.entries.get(name)?.kind !== "dir";
          if (key === entryKey || replacesEntryFolder) {
            throw conflict("A changed path names the instruction entry under another spelling. The write-back was rejected and no files were saved.",
              { code: AGENT_FILES_ENTRY_CONFLICT, path: entryPath });
          }
        }
        const assertIncomingEntry = async () => {
          if (incoming.entries.get(entryPath)?.kind !== "file") throw unprocessable("The configured instruction entry cannot be deleted");
          if (!input.checkpoint || JSON.stringify(incoming.entries.get(entryPath)) !== JSON.stringify(input.baseline.entries.get(entryPath))) {
            const entry = await readInstructionBytes(input.sourceDir, entryPath);
            if (entry === null) throw unprocessable("The configured instruction entry cannot be deleted");
            instructionBytes(entry);
          }
        };
        // Previously saved/imported bytes must remain readable, including when
        // over quota. Enforce limits on the incoming and resulting tree so a
        // run can delete files to recover instead of being locked out forever.
        const captureCurrent = async () => input.checkpoint ? checkpointSnapshot(await cachedAgentFileManifest(root)) : await snapshotAgentFiles(root, false);
        const assertNotStale = (current: DirectorySnapshot) => {
          if (isStaleEntryWriteBack(entryPath, input.baseline, incoming, current)) {
            throw conflict("The instruction entry changed after this working copy was prepared. The write-back was rejected and no files were saved.",
              { code: AGENT_FILES_ENTRY_CONFLICT, path: entryPath });
          }
        };
        // First adoption writes the legacy revision heads and the marker. Run
        // the checks below against the tree as adoption would leave it, without
        // writing it, so a rejected first write-back changes no file. The heads
        // replace their disk paths (with any missing parent folders) and count
        // with their own sizes. Only content identity (entryIdentity, hash only)
        // and sizes are read here, never mode; the merge below uses a fresh
        // snapshot taken after adoption. Once these pass, adoption completes
        // and the same checks run again on disk, unchanged.
        if (adoption.pending) {
          await assertIncomingEntry();
          const onDisk = await captureCurrent();
          const pendingBytes = new Map(adoption.pending.map(head => [head.entryFile, head.bytes]));
          const adoptedEntries = new Map<string, SnapshotEntry>(onDisk.entries);
          for (const [name, bytes] of pendingBytes) {
            adoptedEntries.set(name, { kind: "file", mode: 0, hash: fileHash(bytes) });
            for (let parent = path.posix.dirname(name); parent !== "."; parent = path.posix.dirname(parent)) {
              if (!adoptedEntries.has(parent)) adoptedEntries.set(parent, { kind: "dir" });
            }
          }
          const adopted: DirectorySnapshot = { ...onDisk, entries: adoptedEntries };
          assertNotStale(adopted);
          await applyTreeUsage(applyFinalTree(input.baseline, incoming, adopted, root, input.sourceDir),
            (name, item) => item.root === root ? pendingBytes.get(name)?.length : undefined);
        }
        await completeAgentFileAdoption(adoption);
        await assertIncomingEntry();
        const current = await captureCurrent();
        // Managed instruction saves take this same agent row lock, so canonical
        // content cannot change between this check and the merge below. A stale
        // entry rejects the whole write-back before any file is touched: no
        // partial apply, no preserved candidate. Report only the entry path.
        assertNotStale(current);
        // Rebase only the run's changed paths onto the current tree. This makes
        // same-file edits/deletions last-sync-wins while untouched files retain
        // changes from other runs. Ancestors may need recreating after a writer
        // replaced a directory with a file.
        const entries = new Map(input.baseline.entries);
        const changed = [...new Set([...input.baseline.entries, ...incoming.entries].map(([name]) => name))]
          .filter(name => JSON.stringify(input.baseline.entries.get(name)) !== JSON.stringify(incoming.entries.get(name)));
        for (const name of changed) {
          const present = current.entries.get(name);
          if (present) entries.set(name, present); else entries.delete(name);
          if (incoming.entries.has(name)) {
            for (let parent = path.posix.dirname(name); parent !== "."; parent = path.posix.dirname(parent)) {
              if (current.entries.get(parent)?.kind === "dir") continue;
              const before = current.entries.get(parent);
              if (before) entries.set(parent, before); else entries.delete(parent);
            }
          }
        }
        const applyBaseline = { ...input.baseline, entries };
        const finalEntries = applyFinalTree(input.baseline, incoming, current, root, input.sourceDir);
        const { total, fullFile } = await applyTreeUsage(finalEntries);
        await mergeDirectoryWithBaseline({ ...input, baseline: applyBaseline, targetDir: root,
          ...(input.checkpoint ? { snapshots: { source: incoming, current } } : {}) });
        await audit(tx, agent, bound, { sourceRunId: actor.runId, contract: AGENT_FILES_CONTRACT });
        return { storageWarning: storageWarning(total, finalEntries.size, fullFile) };
      }, { deferAdoption: true }),
  };
}
