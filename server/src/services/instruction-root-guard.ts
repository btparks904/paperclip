// WS-2: the instruction-destination lock (L2).
//
// Lock order for every transaction that writes or activates an instruction
// root: L1 agent row lock(s), then at most one destination lock (this file),
// then the account-home secret file lock (inside secret normalization). No
// transaction takes an agent row lock after its destination lock, and no
// transaction takes two different destination locks.
//
// The lock identity is the filesystem identity (device and inode) of the
// destination's nearest existing real ancestor folder, plus the folded rest of
// the path. Symbolic links (including dangling ones) are followed first, so a
// link and its target share one key; case and Unicode spellings of the part of
// the path that does not exist yet fold to one key; and an ancestor reached
// under another name (a case variant on a case-insensitive volume, a firmlink,
// a bind mount) has the same device and inode. The identity requires a volume
// whose inode numbers are stable: network and FUSE volumes that report
// unstable inodes are not supported for instruction roots.
import fs from "node:fs/promises";
import path from "node:path";
import { sql } from "drizzle-orm";
import { instructionPathKey } from "./agent-instruction-files.js";
import { conflict, unprocessable } from "../errors.js";

/** Anything that can run a statement on the caller's transaction. */
export type InstructionLockTx = { execute: (query: ReturnType<typeof sql>) => Promise<unknown> };

export const INSTRUCTION_DESTINATION_LOCK_PREFIX = "paperclip:instruction-destination:v1:";
const HELD_SETTING = "paperclip.instruction_destination_lock";
const MAX_SYMLINK_HOPS = 40;

export type InstructionDestinationKey = {
  /** The advisory-lock identity. */
  key: string;
  /** The destination with every existing symbolic link resolved. */
  canonicalPath: string;
};

function missing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/** Resolves every existing link in target, including a dangling final one; missing parts are kept as written. */
async function canonicalize(target: string, hops = 0): Promise<string> {
  if (hops > MAX_SYMLINK_HOPS) throw unprocessable("Instructions root path has too many symbolic links");
  try {
    return await fs.realpath(target);
  } catch (error) {
    if (!missing(error)) throw error;
  }
  const stat = await fs.lstat(target).catch((error: unknown) => {
    if (missing(error)) return null;
    throw error;
  });
  if (stat?.isSymbolicLink()) {
    const link = await fs.readlink(target);
    return canonicalize(path.resolve(path.dirname(target), link), hops + 1);
  }
  const parent = path.dirname(target);
  if (parent === target) return target;
  return path.join(await canonicalize(parent, hops), path.basename(target));
}

/** The destination-lock identity of rootPath (see the file header). */
export async function deriveInstructionDestinationKey(rootPath: string): Promise<InstructionDestinationKey> {
  const canonicalPath = await canonicalize(path.resolve(rootPath));
  let anchor = path.dirname(canonicalPath);
  if (anchor === canonicalPath) throw unprocessable("Instructions root cannot be a filesystem root");
  const rest = [path.basename(canonicalPath)];
  for (;;) {
    const stat = await fs.stat(anchor, { bigint: true }).catch((error: unknown) => {
      if (missing(error)) return null;
      throw error;
    });
    if (stat) {
      if (!stat.isDirectory()) throw unprocessable("Instructions root must be inside a directory");
      return {
        key: `${INSTRUCTION_DESTINATION_LOCK_PREFIX}${stat.dev}:${stat.ino}:${instructionPathKey(rest.join("/"))}`,
        canonicalPath,
      };
    }
    const up = path.dirname(anchor);
    if (up === anchor) throw unprocessable("Instructions root has no existing ancestor folder");
    rest.unshift(path.basename(anchor));
    anchor = up;
  }
}

function rowsOf(result: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(result)) return result as Array<Record<string, unknown>>;
  const rows = (result as { rows?: unknown } | null)?.rows;
  return Array.isArray(rows) ? rows as Array<Record<string, unknown>> : [];
}

/** The destination lock this transaction holds, as "<agentId>|<key>", or null. */
async function heldDestinationLock(tx: InstructionLockTx): Promise<{ agentId: string; key: string } | null> {
  const [row] = rowsOf(await tx.execute(sql`select current_setting(${HELD_SETTING}, true) as held`));
  const held = typeof row?.held === "string" ? row.held : "";
  if (!held) return null;
  const separator = held.indexOf("|");
  return { agentId: held.slice(0, separator), key: held.slice(separator + 1) };
}

// A programming error, not a request error: it fails the transaction closed.
function lockOrderViolation(detail: string) {
  return new Error(`Instruction root lock order violated: ${detail}`);
}

/**
 * Call before taking an agent row lock in a transaction that may already hold
 * a destination lock: a row lock of another agent after L2 is refused.
 */
export async function assertAgentRowLockAllowed(tx: InstructionLockTx, agentId: string): Promise<void> {
  const held = await heldDestinationLock(tx);
  if (held && held.agentId !== agentId) throw lockOrderViolation("an agent row after the destination lock");
}

/**
 * Takes the destination lock for rootPath on tx (transaction scoped, released
 * at commit or rollback, and on rollback of the savepoint that took it), then
 * derives the identity again and refuses if it changed. With createParent, the
 * parent folder of rootPath is created first (only empty folders), so the key
 * is the one every later writer of this destination derives.
 */
export async function lockInstructionDestination(
  tx: InstructionLockTx,
  rootPath: string,
  options: { agentId: string; createParent: boolean },
): Promise<InstructionDestinationKey> {
  const resolved = path.resolve(rootPath);
  if (options.createParent) await fs.mkdir(path.dirname(resolved), { recursive: true });
  const first = await deriveInstructionDestinationKey(resolved);
  const held = await heldDestinationLock(tx);
  if (held && held.key !== first.key) throw lockOrderViolation("a second destination lock");
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${first.key}, 0)), set_config(${HELD_SETTING}, ${`${held?.agentId ?? options.agentId}|${first.key}`}, true)`);
  await assertInstructionDestinationKey(resolved, first);
  return first;
}

/** Refuses (409) when rootPath no longer derives the identity that was locked. */
export async function assertInstructionDestinationKey(rootPath: string, locked: InstructionDestinationKey): Promise<void> {
  const again = await deriveInstructionDestinationKey(rootPath);
  if (again.key !== locked.key) {
    throw conflict("The instructions folder changed while it was being checked; nothing was changed. Reload and retry.");
  }
}
