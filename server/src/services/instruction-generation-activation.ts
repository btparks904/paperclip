// WS-2 PR-W2: versioned instruction generations (copy and activation
// consistency specification rev 3, design direction approved 2026-11-13).
//
// The managed instructions root is the agent's whole persistent directory
// (AGENT_HOME). An operation that replaces instructions as a unit (stock reset,
// plugin reset, stock update, first materialization, switch to an empty managed
// folder) builds a new generation Y beside the current one and activates it in
// one database transaction:
//
//   A0  Adoption, when the agent has no adoption marker. Its own committed
//       transaction, a change to the old root Rs that stays even if the
//       activation later fails. Reported separately from the activation.
//   A   One agent-row-lock (L1) transaction that writes nothing and captures
//       the identity tuple I0. Then, unlocked: a quiescence pre-check, the W1
//       exclusivity pre-check on Y (D6), the capacity check (D7), a durable
//       staging receipt and `mkdir Y`.
//   B   Staging with no lock and no connection: walk Rs (S0), copy every
//       supported entry into Y with a per-file stamp check, write the declared
//       overlay, fsync, walk Rs again (S1 must equal S0) and walk Y (SY).
//   C   One L1 transaction with no filesystem writes: I0 re-derived, strict
//       quiescence (D2), Rs equal to S1 and Y equal to SY by stamps (D1-R),
//       the locked W1 exclusivity check on Y, then database effects only.
//
// Nothing is ever deleted: old generations, failed or abandoned stagings and
// their receipts are retained (D4). Nothing retries automatically.
//
// Guarantees cover supported writers only (Paperclip code paths that change a
// root under L1 through the resolved current root). Accepted residuals: R-1 an
// unsupported write made after the phase C source walk stays only in the old
// generation; R-2 an unsupported write to Y after its phase C walk is activated
// unreviewed; R-3 equal stamps do not prove equal content. Hashing here is
// evidence, not a write fence.
import fs from "node:fs/promises";
import { constants as fsConstants, type BigIntStats } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { activityLog, agents, agentInstructionWorkingCopies as copies, type Db } from "@paperclipai/db";
import { HttpError, conflict, notFound, unprocessable } from "../errors.js";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";
import { logger } from "../middleware/logger.js";
import { AGENT_FILES_CONTRACT, adoptAgentFiles, agentFilePath, inspectAgentFile } from "./agent-file-store.js";
import { assertInstructionPathSafe, instructionPathKey } from "./agent-instruction-files.js";
import { pickInstructionConfig } from "./agent-instruction-keys.js";
import {
  agentInstructionsBundleMode,
  applyManagedBundleConfig,
  deriveBundleState,
  resolveAgentFileSyncDirectory,
  resolveInstructionVersionRoot,
  resolveInstructionVersionsDirectory,
  resolveManagedInstructionsRoot,
} from "./agent-instructions.js";
import { assertExclusiveInstructionRoot } from "./instruction-root-exclusivity.js";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type ActivationAgent = typeof agents.$inferSelect;

export const INSTRUCTION_GENERATION_CHANGED = "INSTRUCTION_GENERATION_CHANGED";
export const INSTRUCTION_ACTIVATION_SOURCE_CHANGED = "INSTRUCTION_ACTIVATION_SOURCE_CHANGED";
export const INSTRUCTION_ACTIVATION_STAGING_CHANGED = "INSTRUCTION_ACTIVATION_STAGING_CHANGED";
export const INSTRUCTION_ACTIVATION_BUSY = "INSTRUCTION_ACTIVATION_BUSY";
export const INSTRUCTION_ACTIVATION_INSUFFICIENT_SPACE = "INSTRUCTION_ACTIVATION_INSUFFICIENT_SPACE";
export const INSTRUCTION_ACTIVATION_PATH_CONFLICT = "INSTRUCTION_ACTIVATION_PATH_CONFLICT";
export const INSTRUCTION_GENERATION_ACTIVATED_ACTION = "agent.instructions_generation_activated";

/** D2: agent-directory copy states that block an activation. */
export const ACTIVATION_BLOCKING_COPY_STATES = [
  "preparing", "prepared", "warm_saved", "unchanged_turn", "pending_collection", "pending_commit",
] as const;

/** D7: the reserve is the larger of 1 GiB and 10% of the volume. */
export const ACTIVATION_MIN_RESERVE_BYTES = 1024 * 1024 * 1024;
export const ACTIVATION_RESERVE_FRACTION = 0.1;

// Directory sync is best-available: these mean the platform cannot do it.
const UNSUPPORTED_DIRECTORY_SYNC = new Set(["EINVAL", "ENOTSUP", "EISDIR", "EOPNOTSUPP"]);

export type ActivationKind = "builtin_reset" | "plugin_reset" | "stock_update" | "materialize" | "switch_managed";
export type AdoptionOutcome = "adopted" | "already_adopted" | "not_applicable";
export type ActivityActor = { actorType: string; actorId: string; agentId?: string | null; runId?: string | null; responsibleUserId?: string | null };

/** What a capture plans for Y, on top of the carried-forward source tree. */
/** Overlay bytes read during staging; a different hash refuses the activation. */
export type OverlaySource = { size: number; hash: string; read: () => Promise<Buffer> };

export type ActivationPlan = {
  /** Declared paths written into Y; each replaces a carried file of the same path. */
  overlay: Map<string, Buffer | OverlaySource>;
  /** Carried files left out of Y (D8 removed stock paths). */
  omit?: Set<string>;
  /** The entry file the activated configuration names. */
  entryFile: string;
};

/** Read-only facts about the staged trees, for checks in phase C. */
export type StagedFacts = {
  /** SHA-256 of every regular file of Rs, read with a stable stamp during staging. */
  sourceHashes: ReadonlyMap<string, string>;
  /** SHA-256 of every overlay file written into Y. */
  overlayHashes: ReadonlyMap<string, string>;
};

export type ActivationSpec<P> = {
  companyId: string;
  agentId: string;
  kind: ActivationKind;
  /** Server-verified instance admin; selects 409 detail only. */
  isInstanceAdmin: boolean;
  activity: ActivityActor;
  /**
   * Authorization and the operation's own invariants, on the locked row. Runs
   * in A0, A and C and may throw a refusal. The returned value becomes part of
   * the identity tuple and must be equal in A and C.
   */
  identity: (tx: Tx, agent: ActivationAgent) => Promise<unknown>;
  /** Phase A only, after identity: the plan, or { skip } for no activation. */
  plan: (tx: Tx, agent: ActivationAgent) => Promise<(ActivationPlan & { result?: P }) | { skip: P }>;
  /** Phase C, before the exclusivity check: extra checks on the revalidated trees. */
  verify?: (tx: Tx, agent: ActivationAgent, staged: StagedFacts) => Promise<void>;
  /** Phase C database effects other than the configuration (activity rows, bindings). */
  effects?: (tx: Tx, agent: ActivationAgent, staged: StagedFacts, generation: { id: string; root: string }) => Promise<void>;
  /** Persists the new configuration on the locked transaction; the default writes adapter_config directly. */
  persist?: (tx: Tx, agent: ActivationAgent, adapterConfig: Record<string, unknown>) => Promise<void>;
  /** Removes promptTemplate and bootstrapPromptTemplate from the activated configuration. */
  clearLegacyPromptTemplate?: boolean;
};

export type ActivationResult<P> =
  | { outcome: "skipped"; adoption: AdoptionOutcome; result: P }
  | { outcome: "activated"; adoption: AdoptionOutcome; generationId: string; rootPath: string; sourceGeneration: string | null;
      adapterConfig: Record<string, unknown>; agent: ActivationAgent; result?: P };

/** Test-only seams. Production code never sets them. */
export const instructionActivationTestHooks: {
  statfs?: (target: string) => Promise<{ bsize: number; blocks: number; bavail: number; files: number; ffree: number }>;
  /** After the copy and overlay, before S1 (a source change here is detected). */
  duringStaging?: (context: { sourceRoot: string; stagingRoot: string }) => Promise<void>;
  /** After staging, before phase C. */
  afterStaging?: (context: { sourceRoot: string; stagingRoot: string; generationId: string }) => Promise<void>;
} = {};

/** Paperclip-owned, outside every root. */
export function instructionStagingReceiptsDirectory(): string {
  return path.resolve(resolvePaperclipInstanceRoot(), "instruction-version-staging");
}

/**
 * Section 5.2: the database alone proves only whether a generation is active
 * now. A generation that is not current may have failed, been refused or
 * abandoned, or been activated and later superseded; that is unknown.
 */
export function instructionGenerationStatus(agent: { instructionBundleId?: string | null }, generationId: string):
  "active" | "not_currently_active_outcome_unknown" {
  return agent.instructionBundleId === generationId ? "active" : "not_currently_active_outcome_unknown";
}

// ---------------------------------------------------------------------------
// Stamp walks
// ---------------------------------------------------------------------------

type WalkEntry = { kind: "dir" | "file"; stamp: string; size: number; mode: number };
type TreeWalk = { exists: boolean; entries: Map<string, WalkEntry>; bytes: number };

const stampOf = (stat: BigIntStats) => [stat.dev, stat.ino, stat.size, stat.mode, stat.mtimeNs, stat.ctimeNs].map(String).join(":");

function sourceChanged(detail?: string) {
  return conflict("The agent's instructions folder changed while the new generation was being staged. Nothing was activated; retry.", {
    code: INSTRUCTION_ACTIVATION_SOURCE_CHANGED, ...(detail ? { reason: detail } : {}),
  });
}

/** The canonical root (ancestors without links) or null when it does not exist. */
async function canonicalRoot(root: string): Promise<string | null> {
  const checked = path.dirname(await assertInstructionPathSafe(root, ".path-check"));
  const stat = await fs.lstat(checked).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!stat) return null;
  if (!stat.isDirectory()) throw unprocessable("The agent directory must be a folder");
  return checked;
}

/**
 * Every entry under root with its kernel stamp. Only regular files with one
 * link and folders are supported (the store's rule); anything else, or a
 * reserved name, fails closed. No size or count limit applies: existing
 * over-quota homes are carried forward as they are.
 */
async function walkTree(root: string): Promise<TreeWalk> {
  const canonical = await canonicalRoot(root);
  if (!canonical) return { exists: false, entries: new Map(), bytes: 0 };
  const entries = new Map<string, WalkEntry>();
  let bytes = 0;
  async function walk(directory: string) {
    const names = (await fs.readdir(path.join(canonical!, directory))).sort();
    for (const name of names) {
      const relative = agentFilePath(directory ? `${directory}/${name}` : name);
      const stat = await fs.lstat(path.join(canonical!, relative), { bigint: true });
      if (stat.isDirectory()) {
        entries.set(relative, { kind: "dir", stamp: stampOf(stat), size: 0, mode: Number(stat.mode & 0o7777n) });
        await walk(relative);
      } else if (stat.isFile() && stat.nlink === 1n) {
        entries.set(relative, { kind: "file", stamp: stampOf(stat), size: Number(stat.size), mode: Number(stat.mode & 0o7777n) });
        bytes += Number(stat.size);
      } else {
        throw unprocessable("Agent directories support regular files and directories, without links or special files");
      }
    }
  }
  await walk("");
  return { exists: true, entries, bytes };
}

function sameWalk(left: TreeWalk, right: TreeWalk): boolean {
  if (left.exists !== right.exists || left.entries.size !== right.entries.size) return false;
  for (const [name, entry] of left.entries) {
    const other = right.entries.get(name);
    if (!other || other.kind !== entry.kind || other.stamp !== entry.stamp) return false;
  }
  return true;
}

async function syncDirectory(directory: string) {
  const handle = await fs.open(directory, "r");
  try {
    await handle.sync().catch((error: NodeJS.ErrnoException) => {
      if (!UNSUPPORTED_DIRECTORY_SYNC.has(error.code ?? "")) throw error;
    });
  } finally {
    await handle.close();
  }
}

/** Streams one source file with a stable stamp; optionally copies it into target. Returns its SHA-256. */
async function readStable(sourceRoot: string, relative: string, expected: WalkEntry, target?: string): Promise<string> {
  const handle = await fs.open(path.join(sourceRoot, relative), fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0)).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT" || error.code === "ELOOP") throw sourceChanged();
    throw error;
  });
  try {
    if (stampOf(await handle.stat({ bigint: true })) !== expected.stamp) throw sourceChanged();
    const out = target ? await fs.open(target, "wx", 0o600) : null;
    try {
      const hash = createHash("sha256");
      let read = 0;
      for await (const chunk of handle.createReadStream({ autoClose: false, start: 0 })) {
        read += chunk.length;
        if (read > expected.size) throw sourceChanged();
        hash.update(chunk);
        if (out) await out.write(chunk);
      }
      if (read !== expected.size) throw sourceChanged();
      const after = await handle.stat({ bigint: true });
      if (stampOf(after) !== expected.stamp) throw sourceChanged();
      if (out) {
        await out.chmod(expected.mode & 0o777);
        await out.utimes(new Date(Number(after.atimeMs)), new Date(Number(after.mtimeMs)));
        await out.sync();
      }
      return hash.digest("hex");
    } finally {
      await out?.close();
    }
  } finally {
    await handle.close();
  }
}

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

export function instructionActivationService(db: Db) {
  async function lockAgent(tx: Tx, companyId: string, agentId: string): Promise<ActivationAgent> {
    // FOR NO KEY UPDATE, like every instruction writer that can take the
    // instruction-root assignment lock (see instruction-root-exclusivity.ts).
    const [agent] = await tx.select().from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.companyId, companyId))).for("no key update");
    if (!agent) throw notFound("Agent not found");
    return agent;
  }

  async function markerPresent(agent: ActivationAgent): Promise<boolean> {
    return fs.lstat(path.join(resolveAgentFileSyncDirectory(agent), "adopted.json")).then(() => true, (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    });
  }

  /** Section 3.1 step 2: the generic part of the identity tuple. */
  async function baseIdentity(agent: ActivationAgent) {
    const root = resolveManagedInstructionsRoot(agent);
    const state = deriveBundleState(agent);
    const entry = await inspectAgentFile(root, state.entryFile).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
      throw error;
    });
    return {
      generation: agent.instructionBundleId ?? null,
      root,
      mode: agentInstructionsBundleMode(agent),
      keys: pickInstructionConfig(state.config),
      entryFile: state.entryFile,
      entryHash: entry?.hash ?? null,
      marker: await markerPresent(agent),
    };
  }

  async function blockingCopies(conn: Tx | Db, agent: ActivationAgent): Promise<string[]> {
    const rows = await conn.select({ runId: copies.runId }).from(copies).where(and(
      eq(copies.companyId, agent.companyId), eq(copies.agentId, agent.id),
      inArray(copies.state, [...ACTIVATION_BLOCKING_COPY_STATES]),
      sql`${copies.receipt}->>'schema' = ${AGENT_FILES_CONTRACT}`,
    )).limit(50);
    return rows.map(row => row.runId);
  }

  function busy(runIds: string[], isInstanceAdmin: boolean) {
    return conflict("A run is using this agent's directory. Activate new instructions after it stops.", {
      code: INSTRUCTION_ACTIVATION_BUSY, ...(isInstanceAdmin ? { runIds } : {}),
    });
  }

  async function assertExclusive(conn: Tx | Db, agent: ActivationAgent, rootPath: string, isInstanceAdmin: boolean, lock: boolean) {
    await assertExclusiveInstructionRoot(conn as unknown as Db, agent, rootPath, {
      isInstanceAdmin, lock, deriveRoot: (other) => deriveBundleState(other).rootPath,
    });
  }

  /** D7: free bytes and inodes for the source, the overlay and the reserve. */
  async function assertCapacity(target: string, bytes: number, entries: number) {
    let existing = target;
    for (;;) {
      const stat = await fs.lstat(existing).catch(() => null);
      if (stat) break;
      const parent = path.dirname(existing);
      if (parent === existing) break;
      existing = parent;
    }
    const stats = await (instructionActivationTestHooks.statfs ?? ((p: string) => fs.statfs(p)))(existing);
    const total = stats.blocks * stats.bsize;
    const free = stats.bavail * stats.bsize;
    const reserve = Math.max(ACTIVATION_MIN_RESERVE_BYTES, Math.ceil(total * ACTIVATION_RESERVE_FRACTION));
    const inodesReported = stats.files > 0;
    if (free < bytes + reserve || (inodesReported && stats.ffree < entries)) {
      throw conflict("Not enough free disk space to stage a new instructions generation. Nothing was changed.", {
        code: INSTRUCTION_ACTIVATION_INSUFFICIENT_SPACE,
      });
    }
  }

  /** Section 5.1: durable before Y exists. */
  async function writeStagingReceipt(receipt: Record<string, unknown> & { operationId: string }) {
    const directory = instructionStagingReceiptsDirectory();
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await fs.chmod(directory, 0o700);
    const file = path.join(directory, `${receipt.operationId}.json`);
    const handle = await fs.open(file, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify(receipt), "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await syncDirectory(directory);
  }

  /** Refuses overlay paths that collide with carried entries (folders, files above them, folded spellings). */
  function assertOverlayFits(source: TreeWalk, plan: ActivationPlan) {
    const carriedKeys = new Map<string, Set<string>>();
    for (const name of source.entries.keys()) {
      if (plan.omit?.has(name)) continue;
      const key = instructionPathKey(name);
      carriedKeys.set(key, (carriedKeys.get(key) ?? new Set()).add(name));
    }
    const overlaySpellings = new Map<string, string>();
    const collision = () => unprocessable("Instructions bundle has file or folder names that differ only by letter case or Unicode form", {
      code: "INSTRUCTION_BUNDLE_NAME_COLLISION",
    });
    for (const name of [...plan.overlay.keys()].sort()) {
      const parts = name.split("/");
      for (let index = 1; index <= parts.length; index += 1) {
        const prefix = parts.slice(0, index).join("/");
        const key = instructionPathKey(prefix);
        const previous = overlaySpellings.get(key);
        if (previous !== undefined && previous !== prefix) throw collision();
        overlaySpellings.set(key, prefix);
        const carried = source.entries.get(prefix);
        // On a volume that folds names, another spelling is the same entry.
        if (!carried && carriedKeys.has(key)) throw collision();
        const isFile = index === parts.length;
        if (carried && !plan.omit?.has(prefix) && (isFile ? carried.kind !== "file" : carried.kind !== "dir")) {
          throw conflict("A declared instructions path conflicts with a file or folder in the agent directory. Nothing was activated.", {
            code: INSTRUCTION_ACTIVATION_PATH_CONFLICT, path: prefix,
          });
        }
      }
    }
  }

  /** Phase B: Y is the only folder written. */
  async function stage(sourceRoot: string, stagingRoot: string, source: TreeWalk, plan: ActivationPlan): Promise<StagedFacts> {
    const sourceHashes = new Map<string, string>();
    const overlayHashes = new Map<string, string>();
    const canonicalSource = source.exists ? await canonicalRoot(sourceRoot) : null;
    const folders: string[] = [];
    const folderModes = new Map<string, number>();
    for (const [name, entry] of source.entries) {
      if (entry.kind === "dir") {
        await fs.mkdir(path.join(stagingRoot, name), { mode: 0o700 });
        await fs.chmod(path.join(stagingRoot, name), 0o700);
        folderModes.set(name, entry.mode & 0o777);
        folders.push(name);
        continue;
      }
      const replaced = plan.overlay.has(name) || plan.omit?.has(name);
      sourceHashes.set(name, await readStable(canonicalSource!, name, entry, replaced ? undefined : path.join(stagingRoot, name)));
    }
    for (const [name, value] of [...plan.overlay].sort(([a], [b]) => a.localeCompare(b))) {
      const bytes = Buffer.isBuffer(value) ? value : await value.read();
      if (!Buffer.isBuffer(value) && createHash("sha256").update(bytes).digest("hex") !== value.hash) throw sourceChanged("overlay source");
      const parts = name.split("/");
      for (let index = 1; index < parts.length; index += 1) {
        const folder = parts.slice(0, index).join("/");
        const absolute = path.join(stagingRoot, folder);
        const stat = await fs.lstat(absolute).catch(() => null);
        if (stat?.isDirectory()) continue;
        if (stat) throw conflict("A declared instructions path conflicts with the staged folder", { code: INSTRUCTION_ACTIVATION_PATH_CONFLICT, path: folder });
        await fs.mkdir(absolute);
        await fs.chmod(absolute, 0o700);
        folders.push(folder);
      }
      const handle = await fs.open(path.join(stagingRoot, name), "wx", 0o600);
      try {
        await handle.writeFile(bytes);
        await handle.chmod(0o600);
        await handle.sync();
      } finally {
        await handle.close();
      }
      overlayHashes.set(name, createHash("sha256").update(bytes).digest("hex"));
    }
    // Carried folder modes last, so a read-only folder still received its files.
    for (const [folder, mode] of [...folderModes].reverse()) await fs.chmod(path.join(stagingRoot, folder), mode);
    for (const folder of [...new Set(folders)].sort().reverse()) await syncDirectory(path.join(stagingRoot, folder));
    await syncDirectory(stagingRoot);
    await syncDirectory(path.dirname(stagingRoot));
    return { sourceHashes, overlayHashes };
  }

  async function activate<P>(spec: ActivationSpec<P>): Promise<ActivationResult<P>> {
    // A0: adoption, its own committed transaction.
    const adoption = await db.transaction(async (tx): Promise<AdoptionOutcome> => {
      const agent = await lockAgent(tx, spec.companyId, spec.agentId);
      await spec.identity(tx, agent);
      if (agentInstructionsBundleMode(agent) === "external") return "not_applicable";
      if (await markerPresent(agent)) return "already_adopted";
      await adoptAgentFiles(tx, agent);
      return "adopted";
    });
    const withAdoption = (error: unknown) => {
      if (error instanceof HttpError) error.details = { ...(error.details as Record<string, unknown> | undefined), adoption };
      return error;
    };
    try {
      return await activateAdopted(spec, adoption);
    } catch (error) {
      throw withAdoption(error);
    }
  }

  async function activateAdopted<P>(spec: ActivationSpec<P>, adoption: AdoptionOutcome): Promise<ActivationResult<P>> {
    // A: locked capture, nothing written.
    const captured = await db.transaction(async (tx) => {
      const agent = await lockAgent(tx, spec.companyId, spec.agentId);
      const identity = JSON.stringify({ base: await baseIdentity(agent), operation: await spec.identity(tx, agent) });
      const planned = await spec.plan(tx, agent);
      if ("skip" in planned) return { skip: planned.skip } as const;
      const blocking = await blockingCopies(tx, agent);
      if (blocking.length > 0) throw busy(blocking, spec.isInstanceAdmin);
      return { agent, identity, plan: planned };
    });
    if ("skip" in captured) return { outcome: "skipped", adoption, result: captured.skip as P };
    const { agent, identity, plan } = captured;
    const sourceGeneration = agent.instructionBundleId ?? null;
    const sourceRoot = resolveManagedInstructionsRoot(agent);
    const generationId = randomUUID();
    const stagingRoot = resolveInstructionVersionRoot(agent, generationId);

    // A, unlocked: W1 pre-check (D6), S0 and capacity (D7).
    await assertExclusive(db, agent, stagingRoot, spec.isInstanceAdmin, false);
    const s0 = await walkTree(sourceRoot);
    assertOverlayFits(s0, plan);
    const overlayBytes = [...plan.overlay.values()].reduce((total, value) => total + (Buffer.isBuffer(value) ? value.length : value.size), 0);
    await assertCapacity(resolveInstructionVersionsDirectory(agent), s0.bytes + overlayBytes, s0.entries.size + plan.overlay.size + 1);

    // Durable receipt, then Y (0700, non-recursive, fresh id).
    await writeStagingReceipt({
      version: 1, operationId: generationId, companyId: agent.companyId, agentId: agent.id, kind: spec.kind,
      sourceGeneration, destinationPathKey: instructionPathKey(stagingRoot), startedAt: new Date().toISOString(),
      server: { hostname: os.hostname(), pid: process.pid },
    });
    const versions = resolveInstructionVersionsDirectory(agent);
    await fs.mkdir(versions, { recursive: true, mode: 0o700 });
    await fs.mkdir(stagingRoot, { mode: 0o700 });
    await fs.chmod(stagingRoot, 0o700);
    await syncDirectory(versions);

    // Set as the last step inside the transaction callback. After that point an
    // error can come from COMMIT itself, so the activation outcome is unknown.
    let commitPending = false;
    try {
      // B: staging.
      const staged = await stage(sourceRoot, stagingRoot, s0, plan);
      await instructionActivationTestHooks.duringStaging?.({ sourceRoot, stagingRoot });
      const s1 = await walkTree(sourceRoot);
      if (!sameWalk(s0, s1)) throw sourceChanged();
      const sy = await walkTree(stagingRoot);
      await instructionActivationTestHooks.afterStaging?.({ sourceRoot, stagingRoot, generationId });

      // C: one transaction, database effects only.
      return await db.transaction(async (tx) => {
        const locked = await lockAgent(tx, spec.companyId, spec.agentId);
        const current = JSON.stringify({ base: await baseIdentity(locked), operation: await spec.identity(tx, locked) });
        if (current !== identity) {
          throw conflict("The agent's instructions changed while the new generation was being staged. Nothing was activated; retry.", {
            code: INSTRUCTION_GENERATION_CHANGED,
          });
        }
        const blocking = await blockingCopies(tx, locked);
        if (blocking.length > 0) throw busy(blocking, spec.isInstanceAdmin);
        if (!sameWalk(s1, await walkTree(sourceRoot))) throw sourceChanged();
        if (!sameWalk(sy, await walkTree(stagingRoot))) {
          throw conflict("The staged instructions generation changed before activation. Nothing was activated.", {
            code: INSTRUCTION_ACTIVATION_STAGING_CHANGED,
          });
        }
        await spec.verify?.(tx, locked, staged);
        await assertExclusive(tx, locked, stagingRoot, spec.isInstanceAdmin, true);
        await spec.effects?.(tx, locked, staged, { id: generationId, root: stagingRoot });
        const adapterConfig = applyManagedBundleConfig(deriveBundleState(locked).config, stagingRoot, plan.entryFile,
          { clearLegacyPromptTemplate: spec.clearLegacyPromptTemplate });
        if (spec.persist) await spec.persist(tx, locked, adapterConfig);
        else await tx.update(agents).set({ adapterConfig, updatedAt: new Date() }).where(eq(agents.id, locked.id));
        const [updated] = await tx.update(agents).set({ instructionBundleId: generationId, updatedAt: new Date() })
          .where(and(eq(agents.id, locked.id), eq(agents.companyId, locked.companyId))).returning();
        await tx.insert(activityLog).values({
          companyId: locked.companyId, actorType: spec.activity.actorType, actorId: spec.activity.actorId,
          agentId: spec.activity.agentId ?? null, runId: spec.activity.runId ?? null, responsibleUserId: spec.activity.responsibleUserId ?? null,
          action: INSTRUCTION_GENERATION_ACTIVATED_ACTION, entityType: "agent", entityId: locked.id,
          details: { stagingId: generationId, operation: spec.kind, sourceGeneration, generation: generationId, entryFile: plan.entryFile },
        });
        commitPending = true;
        return { outcome: "activated" as const, adoption, generationId, rootPath: stagingRoot, sourceGeneration,
          adapterConfig: updated!.adapterConfig as Record<string, unknown>, agent: updated!, result: plan.result };
      });
    } catch (error) {
      // D4: Y and its receipt are retained. Nothing is retried.
      if (commitPending) {
        // The commit did not confirm. The generation may or may not be active.
        logger.warn({ err: error, agentId: agent.id, stagingId: generationId, activationOutcome: "unknown" },
          "instructions generation activation outcome is unknown: the error came after the activation transaction finished its work, so the commit may or may not have taken effect; the staged folder and its receipt are retained");
      } else {
        // The error came before the activation transaction finished its work, so this activation was not committed.
        logger.warn({ err: error, agentId: agent.id, stagingId: generationId, activationOutcome: "not_activated" },
          "instructions generation was not activated; the staged folder and its receipt are retained");
      }
      throw error;
    }
  }

  return { activate };
}
