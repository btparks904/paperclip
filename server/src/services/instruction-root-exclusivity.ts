// WS-2 PR-W1: exclusive instruction roots.
//
// Each agent owns its instructions root. No agent may activate a root that is
// equal to, inside, or an ancestor of another agent's root, or that is equal
// to, inside, or an ancestor of another agent's managed area
// (<instance>/companies/<companyId>/agents/<agentId>/). The rule applies
// across all companies. It is a fork-specific behavior change.
//
// Concurrency: every check that can activate a root runs on the caller's
// transaction under one fixed, transaction-scoped advisory lock
// (INSTRUCTION_ROOT_ASSIGNMENT_LOCK). The lock is released at commit or
// rollback, so two transactions cannot both pass the check for equivalent
// roots.
//
// Lock order:
//   1. The caller locks its agent row FOR NO KEY UPDATE (L1). Writers of one
//      agent still serialize: NO KEY UPDATE conflicts with itself, with FOR
//      UPDATE and with every UPDATE or DELETE of the row.
//   2. A write that sets reports_to locks the parent row FOR KEY SHARE.
//   3. This assignment lock.
// After this lock, the transaction takes no explicit agent row lock. Its
// inserts and updates still take implicit foreign-key KEY SHARE locks on the
// agent rows they reference (for example created_by_agent_id on a revision,
// or reports_to). KEY SHARE does not conflict with NO KEY UPDATE, so these
// never wait on another instruction writer that holds L1 and waits for this
// lock. They can still wait on a FOR UPDATE or DELETE holder, which is a
// writer that never takes this lock.
//
// Path equivalence: each path becomes one comparison key.
//   1. Resolve symbolic links with realpath.native on the nearest existing
//      ancestor. A dangling link is followed to its target. Missing parts are
//      kept as written.
//   2. Strip a leading /System/Volumes/Data (the macOS data-volume firmlink,
//      which realpath does not collapse).
//   3. Fold the whole path with instructionPathKey (NFC, then lowercase).
//   4. Compare whole segments, never raw string prefixes.
// Folding is applied on every host. On a case-sensitive volume it can only
// refuse more, never less. A path that cannot be resolved (for example a
// permission error or a symbolic-link loop) refuses: the check fails closed.
// Network and virtual filesystems with other equivalence rules are not
// supported for instruction roots.
import fs from "node:fs/promises";
import { realpath as realpathCallback } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { ne, sql } from "drizzle-orm";
import { agents, type Db } from "@paperclipai/db";
import { instructionPathKey } from "./agent-instruction-files.js";
import { conflict } from "../errors.js";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";
import { logger } from "../middleware/logger.js";

export const INSTRUCTION_ROOT_ASSIGNMENT_LOCK = "paperclip:instruction-root-assignment";
export const INSTRUCTION_ROOT_IN_USE = "INSTRUCTION_ROOT_IN_USE";
export const INSTRUCTION_ROOT_UNVERIFIABLE = "INSTRUCTION_ROOT_UNVERIFIABLE";
const MACOS_DATA_VOLUME_PREFIX = "/System/Volumes/Data";
const MAX_SYMLINK_HOPS = 40;
// The operating system's realpath: on APFS it returns the on-disk spelling.
const realpathNative = promisify(realpathCallback.native);

/** The agent fields the check reads. */
export type ExclusivityAgent = { id: string; companyId: string; name: string; adapterConfig: unknown; instructionBundleId?: string | null };

/** The caller's transaction (or, for the unlocked pre-check, any connection). */
export type ExclusivityConnection = Db;

/** Derives an agent's configured root (deriveBundleState(agent).rootPath). */
export type DeriveInstructionRoot = (agent: ExclusivityAgent) => string | null;

export type RootRelation = "equal" | "inside" | "contains";

class UnverifiablePathError extends Error {}

function missing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/** Resolves every existing link in target, including a dangling one; missing parts are kept as written. */
async function canonicalize(target: string, hops: number): Promise<string> {
  if (hops > MAX_SYMLINK_HOPS) throw new UnverifiablePathError("too many symbolic links");
  try {
    return await realpathNative(target);
  } catch (error) {
    if (!missing(error)) throw new UnverifiablePathError((error as NodeJS.ErrnoException).code ?? "realpath failed");
  }
  const stat = await fs.lstat(target).catch((error: unknown) => {
    if (missing(error)) return null;
    throw new UnverifiablePathError((error as NodeJS.ErrnoException).code ?? "lstat failed");
  });
  if (stat?.isSymbolicLink()) {
    const link = await fs.readlink(target).catch((error: unknown) => {
      throw new UnverifiablePathError((error as NodeJS.ErrnoException).code ?? "readlink failed");
    });
    return canonicalize(path.resolve(path.dirname(target), link), hops + 1);
  }
  const parent = path.dirname(target);
  if (parent === target) return target;
  return path.join(await canonicalize(parent, hops), path.basename(target));
}

/** Steps 2 and 3 of the comparison key, on an absolute path. Exported for unit tests. */
export function foldInstructionRootPath(canonicalPath: string): string[] {
  let value = path.resolve(canonicalPath);
  const prefixKey = instructionPathKey(MACOS_DATA_VOLUME_PREFIX);
  const folded = instructionPathKey(value);
  if (folded === prefixKey || folded.startsWith(`${prefixKey}/`)) {
    value = value.slice(MACOS_DATA_VOLUME_PREFIX.length) || "/";
  }
  return instructionPathKey(value).split("/").filter((segment) => segment.length > 0);
}

/** The comparison key of rootPath: canonical, firmlink-stripped, folded segments. */
export async function instructionRootComparisonKey(rootPath: string): Promise<string[]> {
  return foldInstructionRootPath(await canonicalize(path.resolve(rootPath), 0));
}

/** How candidate relates to other, by whole segments; null when they do not overlap. */
export function compareInstructionRootKeys(candidate: string[], other: string[]): RootRelation | null {
  const shared = Math.min(candidate.length, other.length);
  for (let index = 0; index < shared; index += 1) {
    if (candidate[index] !== other[index]) return null;
  }
  if (candidate.length === other.length) return "equal";
  return candidate.length > other.length ? "inside" : "contains";
}

/** <instance>/companies/<companyId>/agents/<agentId>: the agent's whole managed area. */
export function resolveManagedAgentArea(agent: { id: string; companyId: string }): string {
  return path.resolve(resolvePaperclipInstanceRoot(), "companies", agent.companyId, "agents", agent.id);
}

/** Takes the instance-wide assignment lock on tx; held until tx ends. */
export async function lockInstructionRootAssignment(tx: ExclusivityConnection): Promise<void> {
  if (typeof (tx as { execute?: unknown } | null)?.execute !== "function") {
    throw new Error("Instruction root assignment requires a database transaction");
  }
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${INSTRUCTION_ROOT_ASSIGNMENT_LOCK}, 0))`);
}

function unverifiable(isInstanceAdmin: boolean, detail: Record<string, unknown>) {
  return conflict("Paperclip could not verify that this instructions folder is not used by another agent; nothing was changed.", {
    code: INSTRUCTION_ROOT_UNVERIFIABLE,
    ...(isInstanceAdmin ? detail : {}),
  });
}

/**
 * Refuses (409 INSTRUCTION_ROOT_IN_USE) when rootPath is equal to, inside, or
 * an ancestor of another agent's configured root or managed area, in any
 * company. With lock (the default), it first takes the assignment lock on
 * conn, which must be the caller's transaction, after the caller's agent row
 * lock. With lock: false it only checks (the unlocked route pre-check); that
 * result is advisory and the locked check must follow. Only server-verified
 * instance admins get the other agent's identifiers.
 */
export async function assertExclusiveInstructionRoot(
  conn: ExclusivityConnection,
  agent: ExclusivityAgent,
  rootPath: string,
  options: { isInstanceAdmin: boolean; lock?: boolean; deriveRoot: DeriveInstructionRoot },
): Promise<void> {
  if (options.lock !== false) await lockInstructionRootAssignment(conn);
  let candidate: string[];
  try {
    candidate = await instructionRootComparisonKey(rootPath);
  } catch (error) {
    if (!(error instanceof UnverifiablePathError)) throw error;
    throw unverifiable(options.isInstanceAdmin, { rootPath, reason: error.message });
  }
  const everyAgent = conn.select({
    id: agents.id,
    companyId: agents.companyId,
    name: agents.name,
    adapterConfig: agents.adapterConfig,
    instructionBundleId: agents.instructionBundleId,
  }).from(agents);
  // A create without a caller-chosen id has no row to exclude yet.
  const others = (await (agent.id ? everyAgent.where(ne(agents.id, agent.id)) : everyAgent))
    .filter((other) => other.id !== agent.id);
  for (const other of others) {
    const targets: Array<{ against: "root" | "managed_area"; target: string }> = [
      { against: "managed_area", target: resolveManagedAgentArea(other) },
    ];
    const otherRoot = options.deriveRoot(other);
    if (otherRoot) targets.push({ against: "root", target: path.resolve(otherRoot) });
    for (const { against, target } of targets) {
      let key: string[];
      try {
        key = await instructionRootComparisonKey(target);
      } catch (error) {
        if (!(error instanceof UnverifiablePathError)) throw error;
        throw unverifiable(options.isInstanceAdmin, { conflictingAgentId: other.id, against, reason: error.message });
      }
      const relation = compareInstructionRootKeys(candidate, key);
      if (!relation) continue;
      logger.warn({ agentId: agent.id, conflictingAgentId: other.id, against, relation },
        "instructions root refused: it overlaps another agent's instructions");
      throw conflict("This instructions folder is used by another agent, or overlaps one. Choose a separate folder.", {
        code: INSTRUCTION_ROOT_IN_USE,
        ...(options.isInstanceAdmin
          ? { conflictingAgentId: other.id, conflictingCompanyId: other.companyId, against, relation }
          : {}),
      });
    }
  }
}
