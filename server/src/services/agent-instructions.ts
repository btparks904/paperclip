import { inspectAgentFile, fileHash, agentFilePath, assertDirectorySize, MAX_AGENT_FILE_BYTES } from "./agent-file-store.js";
import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { activityLog, agentInstructionHeads, agents, type Db } from "@paperclipai/db";
import { instructionPath, instructionPathKey, matchesInstructionEntry, assertInstructionPathSafe, instructionBytes, readInstructionBytes, MAX_INSTRUCTION_BYTES } from "./agent-instruction-files.js";
import { conflict, notFound, unprocessable } from "../errors.js";
import { resolveHomeAwarePath, resolvePaperclipInstanceRoot } from "../home-paths.js";
import { logger } from "../middleware/logger.js";
import { assertExclusiveInstructionRoot } from "./instruction-root-exclusivity.js";

const ENTRY_FILE_DEFAULT = "AGENTS.md";
const MODE_KEY = "instructionsBundleMode";
const ROOT_KEY = "instructionsRootPath";
const ENTRY_KEY = "instructionsEntryFile";
const FILE_KEY = "instructionsFilePath";
const PROMPT_KEY = "promptTemplate";
/** @deprecated Use the managed instructions bundle system instead. */
const BOOTSTRAP_PROMPT_KEY = "bootstrapPromptTemplate";
const LEGACY_PROMPT_TEMPLATE_PATH = "promptTemplate.legacy.md";
const IGNORED_INSTRUCTIONS_FILE_NAMES = new Set([".DS_Store", "Thumbs.db", "Desktop.ini"]);
const IGNORED_INSTRUCTIONS_DIRECTORY_NAMES = new Set([
  ".git",
  ".nox",
  ".pytest_cache",
  ".ruff_cache",
  ".tox",
  ".venv",
  "__pycache__",
  "node_modules",
  "venv",
]);

type BundleMode = "managed" | "external";
/** The bundle mode a write path was selected for; see assertExpectedBundleMode. */
export type InstructionBundleWriteMode = BundleMode;

type AgentLike = {
  id: string;
  companyId: string;
  name: string;
  adapterConfig: unknown;
};

type AgentInstructionsFileSummary = {
  path: string;
  contentHash?: string;
  binary?: boolean;
  size: number;
  language: string;
  markdown: boolean;
  isEntryFile: boolean;
  editable: boolean;
  deprecated: boolean;
  virtual: boolean;
};

type AgentInstructionsFileDetail = AgentInstructionsFileSummary & {
  content: string;
  editable: boolean;
};

type AgentInstructionsBundle = {
  agentId: string;
  companyId: string;
  persistence?: "agent_files";
  mode: BundleMode | null;
  rootPath: string | null;
  managedRootPath: string;
  entryFile: string;
  resolvedEntryPath: string | null;
  editable: boolean;
  warnings: string[];
  legacyPromptTemplateActive: boolean;
  legacyBootstrapPromptTemplateActive: boolean;
  files: AgentInstructionsFileSummary[];
};

type BundleState = {
  config: Record<string, unknown>;
  mode: BundleMode | null;
  rootPath: string | null;
  entryFile: string;
  resolvedEntryPath: string | null;
  warnings: string[];
  legacyPromptTemplateActive: boolean;
  legacyBootstrapPromptTemplateActive: boolean;
};

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isBundleMode(value: unknown): value is BundleMode {
  return value === "managed" || value === "external";
}

function inferLanguage(relativePath: string): string {
  const lower = relativePath.toLowerCase();
  if (lower.endsWith(".md")) return "markdown";
  if (lower.endsWith(".json")) return "json";
  if (lower.endsWith(".yaml") || lower.endsWith(".yml")) return "yaml";
  if (lower.endsWith(".ts") || lower.endsWith(".tsx")) return "typescript";
  if (lower.endsWith(".js") || lower.endsWith(".jsx") || lower.endsWith(".mjs") || lower.endsWith(".cjs")) {
    return "javascript";
  }
  if (lower.endsWith(".sh")) return "bash";
  if (lower.endsWith(".py")) return "python";
  if (lower.endsWith(".toml")) return "toml";
  if (lower.endsWith(".txt")) return "text";
  return "text";
}

function isMarkdown(relativePath: string) {
  return relativePath.toLowerCase().endsWith(".md");
}

function normalizeRelativeFilePath(candidatePath: string): string {
  return instructionPath(candidatePath);
}

function resolvePathWithinRoot(rootPath: string, relativePath: string): string {
  const normalizedRelativePath = normalizeRelativeFilePath(relativePath);
  const absoluteRoot = path.resolve(rootPath);
  const absolutePath = path.resolve(absoluteRoot, normalizedRelativePath);
  const relativeToRoot = path.relative(absoluteRoot, absolutePath);
  if (relativeToRoot === ".." || relativeToRoot.startsWith(`..${path.sep}`)) {
    throw unprocessable("Instructions file path must stay within the bundle root");
  }
  return absolutePath;
}

export function resolveManagedInstructionsRoot(agent: AgentLike): string {
  return path.resolve(
    resolvePaperclipInstanceRoot(),
    "companies",
    agent.companyId,
    "agents",
    agent.id,
    "instructions",
  );
}

function resolveLegacyInstructionsPath(candidatePath: string, config: Record<string, unknown>): string {
  if (path.isAbsolute(candidatePath)) return candidatePath;
  const cwd = asString(config.cwd);
  if (!cwd || !path.isAbsolute(cwd)) {
    throw unprocessable(
      "Legacy relative instructionsFilePath requires adapterConfig.cwd to be set to an absolute path",
    );
  }
  return path.resolve(cwd, candidatePath);
}

async function statIfExists(targetPath: string) {
  return fs.lstat(targetPath).catch(() => null);
}

function shouldIgnoreInstructionsEntry(entry: { name: string; isDirectory(): boolean; isFile(): boolean }) {
  if (entry.name === "." || entry.name === "..") return true;
  if (entry.isDirectory()) {
    return IGNORED_INSTRUCTIONS_DIRECTORY_NAMES.has(entry.name);
  }
  if (!entry.isFile()) return false;
  return (
    IGNORED_INSTRUCTIONS_FILE_NAMES.has(entry.name)
    || entry.name.startsWith("._")
    || entry.name.endsWith(".pyc")
    || entry.name.endsWith(".pyo")
  );
}

async function listFilesRecursive(
  rootPath: string,
  options?: { rejectSymlinks?: boolean; legacyExcludes?: boolean },
): Promise<string[]> {
  const output: string[] = [];

  async function walk(currentPath: string, relativeDir: string) {
    const entries = await fs.readdir(currentPath, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (options?.legacyExcludes && shouldIgnoreInstructionsEntry(entry)) continue;
      const absolutePath = path.join(currentPath, entry.name);
      const relativePath = normalizeRelativeFilePath(
        relativeDir ? path.posix.join(relativeDir, entry.name) : entry.name,
      );
      if (entry.isSymbolicLink()) {
        if (options?.rejectSymlinks) {
          throw unprocessable(`Instructions bundle may not contain symlinks: ${relativePath}`);
        }
        continue;
      }
      if (entry.isDirectory()) {
        await walk(absolutePath, relativePath);
        continue;
      }
      if (!entry.isFile()) continue;
      output.push(relativePath);
    }
  }

  await walk(rootPath, "");
  return output.sort((left, right) => left.localeCompare(right));
}

async function readFileSummary(rootPath: string, relativePath: string, entryFile: string): Promise<AgentInstructionsFileSummary> {
  const absolutePath = resolvePathWithinRoot(rootPath, relativePath);
  const stat = await fs.stat(absolutePath);
  // External bundles may contain large assets; listing must not read them.
  const file = stat.size > MAX_AGENT_FILE_BYTES ? null : await inspectAgentFile(rootPath, relativePath);
  return summarizeFile(relativePath, entryFile, file?.size ?? stat.size, file?.bytes ?? null, file?.hash);
}

function summarizeFile(relativePath: string, entryFile: string, size: number, bytes: Buffer | null, hash?: string): AgentInstructionsFileSummary {
  let binary = bytes === null;
  try { if (bytes?.includes(0)) binary = true; new TextDecoder("utf-8", { fatal: true }).decode(bytes ?? undefined); } catch { binary = true; }
  return {
    path: relativePath,
    size,
    language: inferLanguage(relativePath),
    markdown: isMarkdown(relativePath),
    isEntryFile: relativePath === entryFile,
    editable: !binary, binary, contentHash: hash,
    deprecated: false,
    virtual: false,
  };
}

async function readLegacyInstructions(agent: AgentLike, config: Record<string, unknown>): Promise<string> {
  const instructionsFilePath = asString(config[FILE_KEY]);
  if (instructionsFilePath) {
    try {
      const resolvedPath = resolveLegacyInstructionsPath(instructionsFilePath, config);
      return await fs.readFile(resolvedPath, "utf8");
    } catch {
      // Fall back to promptTemplate below.
    }
  }
  return asString(config[PROMPT_KEY]) ?? "";
}

export function deriveBundleState(agent: AgentLike): BundleState {
  const config = asRecord(agent.adapterConfig);
  const warnings: string[] = [];
  const storedModeRaw = config[MODE_KEY];
  const storedRootRaw = asString(config[ROOT_KEY]);
  const legacyInstructionsPath = asString(config[FILE_KEY]);

  let mode: BundleMode | null = isBundleMode(storedModeRaw) ? storedModeRaw : null;
  let rootPath = storedRootRaw ? resolveHomeAwarePath(storedRootRaw) : null;
  let entryFile = ENTRY_FILE_DEFAULT;

  const storedEntryRaw = asString(config[ENTRY_KEY]);
  if (storedEntryRaw) {
    try {
      // Historical config accepted normalized relative paths. Keep that read
      // compatibility; new API writes still use strict instructionPath validation.
      entryFile = normalizeRelativeFilePath(path.posix.normalize(storedEntryRaw.replaceAll("\\", "/")).replace(/^\/+/, ""));
    } catch (error) {
      warnings.push(error instanceof Error ? error.message : String(error));
    }
  }

  if (!rootPath && legacyInstructionsPath) {
    try {
      const resolvedLegacyPath = resolveLegacyInstructionsPath(legacyInstructionsPath, config);
      const managedRoot = resolveManagedInstructionsRoot(agent);
      const managedRelative = path.relative(managedRoot, resolvedLegacyPath);
      const inManagedRoot = managedRelative !== ".." && !managedRelative.startsWith(`..${path.sep}`) && !path.isAbsolute(managedRelative);
      rootPath = inManagedRoot ? managedRoot : path.dirname(resolvedLegacyPath);
      entryFile = inManagedRoot ? instructionPath(managedRelative.split(path.sep).join("/")) : path.basename(resolvedLegacyPath);
      mode = inManagedRoot ? "managed" : "external";
      if (!path.isAbsolute(legacyInstructionsPath)) {
        warnings.push("Using legacy relative instructionsFilePath; migrate this agent to a managed or absolute external bundle.");
      }
    } catch (err) {
      warnings.push(err instanceof Error ? err.message : String(err));
    }
  }

  const resolvedEntryPath = rootPath ? path.resolve(rootPath, entryFile) : null;

  return {
    config,
    mode,
    rootPath,
    entryFile,
    resolvedEntryPath,
    warnings,
    legacyPromptTemplateActive: Boolean(asString(config[PROMPT_KEY])),
    legacyBootstrapPromptTemplateActive: Boolean(asString(config[BOOTSTRAP_PROMPT_KEY])),
  };
}

/** Classify the configured bundle without touching the filesystem. */
export function agentInstructionsBundleMode(agent: AgentLike): BundleMode | null {
  const state = deriveBundleState(agent);
  if (state.mode === "external") return "external";
  if (
    state.rootPath
    && path.resolve(state.rootPath) !== resolveManagedInstructionsRoot(agent)
  ) {
    return "external";
  }
  return state.mode;
}

async function recoverManagedBundleState(agent: AgentLike, state: BundleState): Promise<BundleState> {
  const managedRootPath = resolveManagedInstructionsRoot(agent);
  const stat = await statIfExists(managedRootPath);
  if (!stat?.isDirectory()) return state;

  const files = await listFilesRecursive(managedRootPath);
  if (files.length === 0) return state;

  const recoveredEntryFile = asString(state.config[ENTRY_KEY]) ? state.entryFile : files.includes(state.entryFile)
    ? state.entryFile
    : files.includes(ENTRY_FILE_DEFAULT)
      ? ENTRY_FILE_DEFAULT
      : files[0]!;

  if (!state.rootPath) {
    return {
      ...state,
      mode: "managed",
      rootPath: managedRootPath,
      entryFile: recoveredEntryFile,
      resolvedEntryPath: path.resolve(managedRootPath, recoveredEntryFile),
    };
  }

  if (state.mode === "external") return state;

  const resolvedConfiguredRoot = path.resolve(state.rootPath);
  const configuredRootMatchesManaged = resolvedConfiguredRoot === managedRootPath;
  const hasEntryMismatch = recoveredEntryFile !== state.entryFile;

  if (configuredRootMatchesManaged && !hasEntryMismatch) {
    return state;
  }

  const warnings = [...state.warnings];
  if (!configuredRootMatchesManaged) {
    warnings.push(
      `Recovered managed instructions from disk at ${managedRootPath}; ignoring stale configured root ${state.rootPath}.`,
    );
  }
  if (hasEntryMismatch) {
    warnings.push(
      `Recovered managed instructions entry file from disk as ${recoveredEntryFile}; previous entry ${state.entryFile} was missing.`,
    );
  }

  return {
    ...state,
    mode: "managed",
    rootPath: managedRootPath,
    entryFile: recoveredEntryFile,
    resolvedEntryPath: path.resolve(managedRootPath, recoveredEntryFile),
    warnings,
  };
}

function toBundle(agent: AgentLike, state: BundleState, files: AgentInstructionsFileSummary[]): AgentInstructionsBundle {
  const nextFiles = [...files];
  if (state.legacyPromptTemplateActive && !nextFiles.some((file) => file.path === LEGACY_PROMPT_TEMPLATE_PATH)) {
    const legacyPromptTemplate = asString(state.config[PROMPT_KEY]) ?? "";
    nextFiles.push({
      path: LEGACY_PROMPT_TEMPLATE_PATH,
      size: legacyPromptTemplate.length,
      language: "markdown",
      markdown: true,
      isEntryFile: false,
      editable: true,
      deprecated: true,
      virtual: true,
    });
  }
  nextFiles.sort((left, right) => left.path.localeCompare(right.path));
  return {
    agentId: agent.id,
    companyId: agent.companyId,
    ...(state.mode === "managed" ? { persistence: "agent_files" as const } : {}),
    mode: state.mode,
    rootPath: state.rootPath,
    managedRootPath: resolveManagedInstructionsRoot(agent),
    entryFile: state.entryFile,
    resolvedEntryPath: state.resolvedEntryPath,
    editable: Boolean(state.rootPath),
    warnings: state.warnings,
    legacyPromptTemplateActive: state.legacyPromptTemplateActive,
    legacyBootstrapPromptTemplateActive: state.legacyBootstrapPromptTemplateActive,
    files: nextFiles,
  };
}

function applyBundleConfig(
  config: Record<string, unknown>,
  input: {
    mode: BundleMode;
    rootPath: string;
    entryFile: string;
    clearLegacyPromptTemplate?: boolean;
  },
): Record<string, unknown> {
  const next: Record<string, unknown> = {
    ...config,
    [MODE_KEY]: input.mode,
    [ROOT_KEY]: input.rootPath,
    [ENTRY_KEY]: input.entryFile,
    [FILE_KEY]: path.resolve(input.rootPath, input.entryFile),
  };
  if (input.clearLegacyPromptTemplate) {
    delete next[PROMPT_KEY];
    delete next[BOOTSTRAP_PROMPT_KEY];
  }
  return next;
}

function buildPersistedBundleConfig(
  derived: BundleState,
  current: BundleState,
  options?: { clearLegacyPromptTemplate?: boolean },
): Record<string, unknown> {
  const currentRootPath = current.rootPath ? path.resolve(current.rootPath) : null;
  const derivedRootPath = derived.rootPath ? path.resolve(derived.rootPath) : null;
  const configMatchesRecoveredState =
    derived.mode === current.mode
    && derivedRootPath !== null
    && currentRootPath !== null
    && derivedRootPath === currentRootPath
    && derived.entryFile === current.entryFile;

  if (configMatchesRecoveredState && !options?.clearLegacyPromptTemplate) {
    return current.config;
  }

  if (!current.rootPath || !current.mode) {
    return current.config;
  }

  return applyBundleConfig(current.config, {
    mode: current.mode,
    rootPath: current.rootPath,
    entryFile: current.entryFile,
    clearLegacyPromptTemplate: options?.clearLegacyPromptTemplate,
  });
}

/**
 * The destination an unversioned write or delete resolves to: the effective
 * (recovered) mode and the canonical root path. Two targets are equal only when
 * both match, so a different external root or a recovered-managed bundle that
 * became external never compares equal. This compares path strings; it does
 * not pin filesystem identity (per-operation path safety checks still apply).
 */
export type InstructionWriteTarget = { mode: BundleMode | null; rootPath: string | null };

export async function resolveInstructionWriteTarget(agent: AgentLike): Promise<InstructionWriteTarget> {
  const state = await recoverManagedBundleState(agent, deriveBundleState(agent));
  return { mode: state.mode, rootPath: state.rootPath ? path.resolve(state.rootPath) : null };
}

/**
 * Classify a bundle that the existing recovery rules already treat as managed
 * at the canonical managed root, without widening them. An explicitly external
 * persisted mode is never recovered. Returns the persisted configuration that
 * the unversioned write path would have stored for it, or null when the stored
 * configuration already matches.
 */
export type RecoveredManagedBundle = { rootPath: string; entryFile: string; repairedConfig: Record<string, unknown> | null };

export async function resolveRecoveredManagedBundle(agent: AgentLike): Promise<RecoveredManagedBundle | null> {
  const derived = deriveBundleState(agent);
  if (derived.mode === "external") return null;
  const recovered = await recoverManagedBundleState(agent, derived);
  const managedRoot = resolveManagedInstructionsRoot(agent);
  if (recovered.mode !== "managed" || !recovered.rootPath || path.resolve(recovered.rootPath) !== managedRoot) return null;
  const repaired = buildPersistedBundleConfig(derived, recovered);
  return { rootPath: managedRoot, entryFile: recovered.entryFile, repairedConfig: repaired === derived.config ? null : repaired };
}

// ---------------------------------------------------------------------------
// Bundle copy-and-switch (PATCH /instructions-bundle). The copy runs inside the
// agent row lock with the configuration persist, and a Paperclip-owned copy
// intent makes every failed copy refuse later adoption instead of activating
// partial or stale output. Paperclip never deletes destination content.
// ---------------------------------------------------------------------------

type InstructionTx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export type UpdateBundleInput = {
  mode?: BundleMode;
  rootPath?: string | null;
  entryFile?: string;
  clearLegacyPromptTemplate?: boolean;
};

/** Persists an instruction configuration on the caller's locked transaction. */
export type InstructionConfigPersist = (
  tx: InstructionTx,
  current: AgentLike & { adapterType?: string | null },
  adapterConfig: Record<string, unknown>,
) => Promise<void>;

export type UpdateBundleOptions = {
  /** The write target the route authorized against (its unlocked read). */
  expectedTarget: InstructionWriteTarget;
  /** The config-only mode classification the route's admin gate used. */
  expectedConfigMode: BundleMode | null;
  persist: InstructionConfigPersist;
  /** Server-side instance-admin determination; controls 409 detail only. */
  isInstanceAdmin: boolean;
  actor: { actorType: string; actorId: string; runId?: string | null };
};

export const INSTRUCTION_BUNDLE_COPY_COMPLETED_ACTION = "agent.instructions_bundle_copy_completed";
export const INSTRUCTION_BUNDLE_COPY_INCOMPLETE = "INSTRUCTION_BUNDLE_COPY_INCOMPLETE";
export const INSTRUCTION_BUNDLE_NAME_COLLISION = "INSTRUCTION_BUNDLE_NAME_COLLISION";
const MODE_CHANGED_MESSAGE = "The instructions bundle mode changed; reload and retry";
const COPY_INTENT_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DECIMAL = /^(0|[1-9][0-9]*)$/;
const MAX_COPY_INTENT_BYTES = 64 * 1024;
// Directory sync is best-available: these mean the platform cannot do it.
const UNSUPPORTED_DIRECTORY_SYNC = new Set(["EINVAL", "ENOTSUP", "EISDIR", "EOPNOTSUPP"]);

/** Paperclip-owned, outside every instruction root. */
export function instructionCopyIntentsDirectory(): string {
  return path.resolve(resolvePaperclipInstanceRoot(), "instruction-copy-intents");
}

type DestinationIdentity = { ino: string; dev: string; birthtimeNs: string; canonicalPath: string; pathKey: string };

type CopyIntent = {
  version: 1;
  operationId: string;
  companyId: string;
  agentId: string;
  destination: DestinationIdentity;
  sourceRoot: string | null;
  plannedCount: number;
  plannedBytes: number;
  startedAt: string;
};

type IntentEntry = { file: string; intent: CopyIntent | null };

/** Identity of the directory the copy writes into (after mkdir -p). */
async function pathOnlyIdentity(resolved: string): Promise<DestinationIdentity> {
  let ancestor = resolved;
  const rest: string[] = [];
  for (;;) {
    try {
      const real = await fs.realpath(ancestor);
      const canonicalPath = path.join(real, ...rest);
      return { ino: "", dev: "", birthtimeNs: "", canonicalPath, pathKey: instructionPathKey(canonicalPath) };
    } catch (error) {
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw error;
      rest.unshift(path.basename(ancestor));
      ancestor = parent;
    }
  }
}

async function captureDestinationIdentity(rootPath: string): Promise<DestinationIdentity> {
  const canonicalPath = await fs.realpath(rootPath);
  const stat = await fs.lstat(canonicalPath, { bigint: true });
  if (!stat.isDirectory()) throw unprocessable("Instructions root must be a directory");
  return {
    ino: stat.ino.toString(),
    dev: stat.dev.toString(),
    birthtimeNs: (stat.birthtimeNs ?? 0n).toString(),
    canonicalPath,
    pathKey: instructionPathKey(canonicalPath),
  };
}

function parseCopyIntent(raw: string): CopyIntent | null {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return null; }
  const intent = value as Partial<CopyIntent> | null;
  const destination = intent?.destination as Partial<DestinationIdentity> | undefined;
  if (
    !intent || typeof intent !== "object" || intent.version !== 1
    || typeof intent.operationId !== "string" || !UUID.test(intent.operationId)
    || typeof intent.companyId !== "string" || intent.companyId.length === 0
    || typeof intent.agentId !== "string" || intent.agentId.length === 0
    || !destination || typeof destination !== "object"
    || typeof destination.ino !== "string" || !DECIMAL.test(destination.ino)
    || typeof destination.dev !== "string" || !DECIMAL.test(destination.dev)
    || typeof destination.birthtimeNs !== "string" || !DECIMAL.test(destination.birthtimeNs)
    || typeof destination.pathKey !== "string" || destination.pathKey.length === 0
    || typeof destination.canonicalPath !== "string"
    || typeof intent.startedAt !== "string"
  ) return null;
  return intent as CopyIntent;
}

/** Every record in the intent directory; unreadable or invalid ones carry null. */
async function readCopyIntents(): Promise<IntentEntry[]> {
  const directory = instructionCopyIntentsDirectory();
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!entries) return [];
  const output: IntentEntry[] = [];
  for (const entry of entries) {
    const file = path.join(directory, entry.name);
    if (!entry.isFile() || !COPY_INTENT_NAME.test(entry.name)) {
      output.push({ file, intent: null });
      continue;
    }
    const raw = await readCappedRegularFile(file, MAX_COPY_INTENT_BYTES).catch(() => null);
    const intent = raw && raw.length <= MAX_COPY_INTENT_BYTES ? parseCopyIntent(raw.toString("utf8")) : null;
    output.push({ file, intent: intent && `${intent.operationId}.json` === entry.name ? intent : null });
  }
  return output;
}

/** M-1: an intent concerns this destination when the inode or folded path is equal. */
function intentMatchesDestination(intent: CopyIntent, identity: DestinationIdentity): boolean {
  return intent.destination.ino === identity.ino || intent.destination.pathKey === identity.pathKey;
}

/** Reads at most limit + 1 bytes of a regular file without following a final symlink. */
async function readCappedRegularFile(absolutePath: string, limit: number): Promise<Buffer> {
  const handle = await fs.open(absolutePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw unprocessable("Instructions bundle may only copy regular files");
    const buffer = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    return buffer.subarray(0, length);
  } finally {
    await handle.close();
  }
}

/** Strict instruction bytes: 1 MiB per file, valid UTF-8, never decoded lossily. */
async function readInstructionCopyBytes(absolutePath: string): Promise<Buffer> {
  return instructionBytes(await readCappedRegularFile(absolutePath, MAX_INSTRUCTION_BYTES));
}

type PlannedCopyFile = { path: string; source: string | null; bytes: Buffer | null; size: number; hash: string };
type CopyPlan = { files: PlannedCopyFile[]; folders: string[]; bytes: number; sourceRoot: string | null };

/**
 * Bounded walk of a copy source (Q-1): every visited, non-excluded entry is
 * counted (files, folders, symlinks, special entries); symlinks are never
 * followed; bytes are the sizes of the regular files that would be copied. The
 * walk stops as soon as the store's entry or byte limit is exceeded.
 */
async function walkCopySource(sourceRoot: string): Promise<{ files: Array<{ path: string; size: number }> }> {
  const files: Array<{ path: string; size: number }> = [];
  let count = 0;
  let bytes = 0;
  async function walk(currentPath: string, relativeDir: string) {
    const entries = await fs.readdir(currentPath, { withFileTypes: true });
    for (const entry of entries) {
      if (shouldIgnoreInstructionsEntry(entry)) continue;
      count += 1;
      assertDirectorySize(bytes, count);
      const relativePath = normalizeRelativeFilePath(relativeDir ? path.posix.join(relativeDir, entry.name) : entry.name);
      if (entry.isSymbolicLink()) continue;
      const absolutePath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        await walk(absolutePath, relativePath);
        continue;
      }
      if (!entry.isFile()) continue;
      const stat = await fs.lstat(absolutePath);
      if (!stat.isFile()) continue;
      bytes += stat.size;
      assertDirectorySize(bytes, count);
      files.push({ path: relativePath, size: stat.size });
    }
  }
  await walk(sourceRoot, "");
  files.sort((left, right) => left.path.localeCompare(right.path));
  return { files };
}

/**
 * RD-1: refuse a plan whose paths (files or the folders that hold them) are
 * equivalent under instructionPathKey. On a volume that folds case or Unicode
 * form two such names are one file, so the copy could never be exact.
 */
function assertNoFoldedNameCollisions(paths: string[]) {
  const seen = new Map<string, string>();
  for (const filePath of paths) {
    const parts = filePath.split("/");
    for (let index = 1; index <= parts.length; index += 1) {
      const candidate = parts.slice(0, index).join("/");
      const key = instructionPathKey(candidate);
      const previous = seen.get(key);
      if (previous !== undefined && previous !== candidate) {
        throw unprocessable("Instructions bundle has file or folder names that differ only by letter case or Unicode form", {
          code: INSTRUCTION_BUNDLE_NAME_COLLISION,
        });
      }
      seen.set(key, candidate);
    }
  }
}

function plannedFolders(paths: string[]): string[] {
  const folders = new Set<string>();
  for (const filePath of paths) {
    const parts = filePath.split("/");
    for (let index = 1; index < parts.length; index += 1) folders.add(parts.slice(0, index).join("/"));
  }
  return [...folders].sort();
}

/** Create one directory level; an existing entry must be a real directory. */
async function ensureCopyDirectory(absolutePath: string) {
  try {
    await fs.mkdir(absolutePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const stat = await fs.lstat(absolutePath);
    if (!stat.isDirectory()) throw conflict("The instructions destination changed during the copy; nothing was activated");
  }
}

/** Create a file exclusively; returns false when the name already exists. */
async function writeFileExclusive(absolutePath: string, bytes: Buffer, options?: { existingIsPresent?: boolean }): Promise<boolean> {
  let handle: Awaited<ReturnType<typeof fs.open>>;
  try {
    handle = await fs.open(absolutePath, "wx");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST" && options?.existingIsPresent) return false;
    throw error;
  }
  try {
    await handle.writeFile(bytes);
  } finally {
    await handle.close();
  }
  return true;
}

/** Every non-directory entry under root, without exclusions or link following. */
async function listDestinationEntries(rootPath: string): Promise<string[]> {
  const output: string[] = [];
  async function walk(currentPath: string, relativeDir: string) {
    for (const entry of await fs.readdir(currentPath, { withFileTypes: true })) {
      const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(path.join(currentPath, entry.name), relativePath);
      else output.push(relativePath);
    }
  }
  await walk(rootPath, "");
  return output.sort();
}

function pathKeyHash(pathKey: string): string {
  return fileHash(Buffer.from(pathKey, "utf8"));
}

export function syncInstructionsBundleConfigFromFilePath(
  agent: AgentLike,
  adapterConfig: Record<string, unknown>,
): Record<string, unknown> {
  const instructionsFilePath = asString(adapterConfig[FILE_KEY]);
  const next = { ...adapterConfig };
  if (!instructionsFilePath) {
    delete next[MODE_KEY];
    delete next[ROOT_KEY];
    delete next[ENTRY_KEY];
    return next;
  }
  const resolvedPath = resolveLegacyInstructionsPath(instructionsFilePath, adapterConfig);
  const managedRoot = resolveManagedInstructionsRoot(agent);
  const relative = path.relative(managedRoot, resolvedPath);
  const managed = relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  const rootPath = managed ? managedRoot : path.dirname(resolvedPath);
  const entryFile = managed ? instructionPath(relative.split(path.sep).join("/")) : path.basename(resolvedPath);
  const mode: BundleMode = managed ? "managed" : "external";
  return applyBundleConfig(next, { mode, rootPath, entryFile });
}

export function agentInstructionsService(db?: Db) {
  async function assertUnversionedEntry(agent: AgentLike, entryFile: string, connection: Db | Parameters<Parameters<Db["transaction"]>[0]>[0] | undefined = db) {
    if (!connection) throw unprocessable("Bundle initialization requires the database-backed instructions service");
    // Match historical entries by folded key: on a case-insensitive volume a
    // case or Unicode variant of a historical entry names that entry.
    const heads = await connection.select({ entryFile: agentInstructionHeads.entryFile }).from(agentInstructionHeads)
      .where(and(eq(agentInstructionHeads.companyId, agent.companyId), eq(agentInstructionHeads.agentId, agent.id)));
    const key = instructionPathKey(entryFile);
    if (heads.some(head => instructionPathKey(head.entryFile) === key)) throw unprocessable("This entry has revision history. Use the instruction content API with its baseRevisionId to update it.", { code: "INSTRUCTION_REVISION_REQUIRED" });
  }
  async function getBundle(agent: AgentLike): Promise<AgentInstructionsBundle> {
    const state = await recoverManagedBundleState(agent, deriveBundleState(agent));
    if (!state.rootPath) return toBundle(agent, state, []);
    await assertInstructionPathSafe(state.rootPath, state.entryFile);
    const stat = await statIfExists(state.rootPath);
    if (!stat?.isDirectory()) {
      return toBundle(agent, {
        ...state,
        warnings: [...state.warnings, `Instructions root does not exist: ${state.rootPath}`],
      }, []);
    }
    const files = await listFilesRecursive(state.rootPath, { legacyExcludes: state.mode === "external" });
    const summaries: AgentInstructionsFileSummary[] = [];
    // Bound open descriptors and text buffers even for a large personal folder.
    for (let index = 0; index < files.length; index += 8) {
      summaries.push(...await Promise.all(files.slice(index, index + 8).map(relativePath => readFileSummary(state.rootPath!, relativePath, state.entryFile))));
    }
    return toBundle(agent, state, summaries);
  }

  async function readFile(agent: AgentLike, relativePath: string): Promise<AgentInstructionsFileDetail> {
    const state = await recoverManagedBundleState(agent, deriveBundleState(agent));
    if (relativePath === LEGACY_PROMPT_TEMPLATE_PATH) {
      const content = asString(state.config[PROMPT_KEY]);
      if (content === null) throw notFound("Instructions file not found");
      return {
        path: LEGACY_PROMPT_TEMPLATE_PATH,
        size: content.length,
        language: "markdown",
        markdown: true,
        isEntryFile: false,
        editable: true,
        deprecated: true,
        virtual: true,
        content,
      };
    }
    if (!state.rootPath) throw notFound("Agent instructions bundle is not configured");
    await assertInstructionPathSafe(state.rootPath, relativePath);
    const file = await inspectAgentFile(state.rootPath, relativePath);
    if (file === null) throw notFound("Instructions file not found");
    const summary = summarizeFile(relativePath, state.entryFile, file.size, file.bytes, file.hash);
    return { ...summary, content: summary.binary ? "" : file.bytes!.toString("utf8") };
  }

  async function ensureWritableBundle(
    agent: AgentLike,
    options?: { clearLegacyPromptTemplate?: boolean },
    tx?: InstructionTx,
  ): Promise<{ adapterConfig: Record<string, unknown>; state: BundleState }> {
    const derived = deriveBundleState(agent);
    const current = await recoverManagedBundleState(agent, derived);
    // WS-2 PR-W1: a save that binds a root the configuration does not name yet
    // (none, or a recovered managed root) is a root activation. It refuses a
    // root that overlaps another agent before the first folder is created.
    const bindRoot = current.rootPath && current.mode ? current.rootPath : resolveManagedInstructionsRoot(agent);
    if (!derived.rootPath || path.resolve(derived.rootPath) !== path.resolve(bindRoot)) {
      if (tx) await assertExclusiveRoot(tx, agent, bindRoot, { isInstanceAdmin: false });
      else if (db) throw unprocessable("Binding an instructions root requires the agent's locked transaction");
    }
    if (current.rootPath && current.mode) {
      const adapterConfig = buildPersistedBundleConfig(derived, current, options);
      return {
        adapterConfig,
        state: deriveBundleState({ ...agent, adapterConfig }),
      };
    }

    const managedRoot = resolveManagedInstructionsRoot(agent);
    const entryFile = current.entryFile || ENTRY_FILE_DEFAULT;
    const nextConfig = applyBundleConfig(current.config, {
      mode: "managed",
      rootPath: managedRoot,
      entryFile,
      clearLegacyPromptTemplate: options?.clearLegacyPromptTemplate,
    });
    await fs.mkdir(managedRoot, { recursive: true });

    const entryPath = await assertInstructionPathSafe(managedRoot, entryFile);
    const entryStat = await statIfExists(entryPath);
    if (!entryStat?.isFile()) {
      const legacyInstructions = await readLegacyInstructions(agent, current.config);
      if (legacyInstructions.trim().length > 0) {
        await assertUnversionedEntry(agent, entryFile);
        await fs.mkdir(path.dirname(entryPath), { recursive: true });
        await fs.writeFile(entryPath, legacyInstructions, "utf8");
      }
    }

    return {
      adapterConfig: nextConfig,
      state: deriveBundleState({ ...agent, adapterConfig: nextConfig }),
    };
  }

  // The 409 for a destination with an unfinished copy record. Detailed recovery
  // data goes only to server-verified instance admins (Q-2); the completion
  // hint is computed only for them, and never decides anything.
  async function copyIncompleteError(
    tx: InstructionTx,
    options: Pick<UpdateBundleOptions, "isInstanceAdmin">,
    blocking: IntentEntry,
    rootPath: string,
  ) {
    logger.warn({ intentFile: blocking.file, operationId: blocking.intent?.operationId ?? null, destinationRoot: rootPath },
      "instructions bundle switch refused: an unfinished copy record matches the destination");
    if (!options.isInstanceAdmin) {
      return conflict("A previous instructions copy for this agent did not finish. An instance administrator must resolve it.", {
        code: INSTRUCTION_BUNDLE_COPY_INCOMPLETE,
      });
    }
    if (!blocking.intent) {
      return conflict("An instructions copy record could not be read. Inspect it, and delete it if no copy depends on it, then retry.", {
        code: INSTRUCTION_BUNDLE_COPY_INCOMPLETE,
        destinationRoot: rootPath,
        intentFile: blocking.file,
        completionHint: "not_completed",
      });
    }
    const completionHint = await copyCompletionHint(tx, blocking.intent);
    return conflict(completionHint === "completed"
      ? "Paperclip's record shows this copy finished, but its copy record was not cleared. Inspect the folder; if you keep it, delete the copy record file and retry."
      : "A previous instructions copy into this folder did not finish. Inspect the folder, then empty it, move it or choose another folder, and remove the copy record if you keep the folder.", {
      code: INSTRUCTION_BUNDLE_COPY_INCOMPLETE,
      destinationRoot: blocking.intent.destination.canonicalPath,
      operationId: blocking.intent.operationId,
      startedAt: blocking.intent.startedAt,
      intentFile: blocking.file,
      completionHint,
    });
  }

  // M-2 (addendum 2): a hint for the admin 409 only. Exactly one committed row,
  // visible on tx, with every pinned field equal; anything else is not_completed.
  async function copyCompletionHint(tx: InstructionTx, intent: CopyIntent): Promise<"completed" | "not_completed"> {
    if (!UUID.test(intent.companyId) || !UUID.test(intent.agentId)) return "not_completed";
    const rows = await tx.select().from(activityLog).where(and(
      eq(activityLog.companyId, intent.companyId),
      eq(activityLog.action, INSTRUCTION_BUNDLE_COPY_COMPLETED_ACTION),
      sql`${activityLog.details} ->> 'operationId' = ${intent.operationId}`,
    ));
    if (rows.length !== 1) return "not_completed";
    const row = rows[0]!;
    const destination = asRecord(asRecord(row.details).destination);
    const matches = row.agentId === intent.agentId
      && row.entityType === "agent"
      && row.entityId === intent.agentId
      && destination.ino === intent.destination.ino
      && destination.birthtimeNs === intent.destination.birthtimeNs
      && destination.pathKeyHash === pathKeyHash(intent.destination.pathKey);
    return matches ? "completed" : "not_completed";
  }

  // Addendum 2, 3.2: the decision depends only on the intent records and the
  // destination's state. Steps 3 (scan) and 8 (peer re-scan) share it.
  async function classifyCopyIntents(
    tx: InstructionTx,
    current: AgentLike,
    options: Pick<UpdateBundleOptions, "isInstanceAdmin">,
    identity: DestinationIdentity,
    rootPath: string,
    destinationEmpty: boolean,
    ownOperationId: string | null,
  ) {
    const intents = await readCopyIntents().catch(() => null);
    if (!intents) {
      throw await copyIncompleteError(tx, options, { file: instructionCopyIntentsDirectory(), intent: null }, rootPath);
    }
    for (const entry of intents) {
      if (ownOperationId && path.basename(entry.file) === `${ownOperationId}.json`) continue;
      if (!entry.intent) throw await copyIncompleteError(tx, options, entry, rootPath);
      if (!intentMatchesDestination(entry.intent, identity)) continue;
      const sameAgent = entry.intent.agentId === current.id && entry.intent.companyId === current.companyId;
      // A stale record of this agent on an empty destination has no files that
      // depend on it, and the row lock rules out an operation of this agent in
      // progress. Before our own intent exists (step 3) it is removed; any
      // other matching record refuses. The record must name this very folder
      // (same device and inode): a match by folded path alone may be another
      // folder that still holds the partial copy, so it refuses.
      const sameFolder = entry.intent.destination.ino === identity.ino && entry.intent.destination.dev === identity.dev;
      if (destinationEmpty && sameAgent && sameFolder && !ownOperationId) {
        await fs.unlink(entry.file).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        });
        continue;
      }
      throw await copyIncompleteError(tx, options, entry, rootPath);
    }
  }

  async function sourceEntryBytes(state: BundleState, plan: CopyPlan | null, nextEntryFile: string, agent: AgentLike): Promise<Buffer> {
    // Same content rule as before: the requested entry from the source, else
    // the source entry, else empty; a source without files uses the legacy body.
    if (plan) {
      const sourceEntry = plan.files.find(file => file.path === nextEntryFile) ?? plan.files.find(file => file.path === state.entryFile);
      if (sourceEntry) return sourceEntry.bytes ?? await readInstructionCopyBytes(sourceEntry.source!);
      return Buffer.alloc(0);
    }
    if (state.rootPath && (await statIfExists(state.rootPath))?.isDirectory()) {
      const { files } = await walkCopySource(state.rootPath);
      if (files.length > 0) {
        const chosen = files.find(file => file.path === nextEntryFile) ?? files.find(file => file.path === state.entryFile);
        return chosen ? readInstructionCopyBytes(resolvePathWithinRoot(state.rootPath, chosen.path)) : Buffer.alloc(0);
      }
    }
    const legacyBody = await readLegacyInstructions(agent, state.config);
    return instructionBytes(legacyBody || "_No AGENTS instructions were resolved from current agent config._");
  }

  // Pass 1 (E1, D1, D3, D4, RD-1): the whole copy is planned and validated
  // before the intent and before the first destination byte.
  async function planBundleCopy(state: BundleState, agent: AgentLike, nextEntryFile: string): Promise<CopyPlan> {
    const files: PlannedCopyFile[] = [];
    let sourceRoot: string | null = null;
    if (state.rootPath && (await statIfExists(state.rootPath))?.isDirectory()) {
      sourceRoot = state.rootPath;
      const walked = await walkCopySource(state.rootPath);
      for (const file of walked.files) {
        const source = resolvePathWithinRoot(state.rootPath, file.path);
        const bytes = await readInstructionCopyBytes(source);
        files.push({ path: file.path, source, bytes: null, size: bytes.length, hash: fileHash(bytes) });
      }
    }
    if (files.length === 0) {
      sourceRoot = null;
      const legacyBody = await readLegacyInstructions(agent, state.config);
      const bytes = instructionBytes(legacyBody || "_No AGENTS instructions were resolved from current agent config._");
      files.push({ path: state.entryFile, source: null, bytes, size: bytes.length, hash: fileHash(bytes) });
    }
    if (!files.some(file => file.path === nextEntryFile)) {
      const partial: CopyPlan = { files, folders: [], bytes: 0, sourceRoot };
      const bytes = await sourceEntryBytes(state, partial, nextEntryFile, agent);
      files.push({ path: nextEntryFile, source: null, bytes, size: bytes.length, hash: fileHash(bytes) });
    }
    const paths = files.map(file => file.path);
    assertNoFoldedNameCollisions(paths);
    const folders = plannedFolders(paths);
    const bytes = files.reduce((total, file) => total + file.size, 0);
    assertDirectorySize(bytes, files.length + folders.length);
    return { files, folders, bytes, sourceRoot };
  }

  async function createCopyIntent(intent: CopyIntent): Promise<string> {
    const directory = instructionCopyIntentsDirectory();
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const file = path.join(directory, `${intent.operationId}.json`);
    const handle = await fs.open(file, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify(intent), "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    const directoryHandle = await fs.open(directory, "r");
    try {
      await directoryHandle.sync().catch((error: NodeJS.ErrnoException) => {
        if (!UNSUPPORTED_DIRECTORY_SYNC.has(error.code ?? "")) throw error;
      });
    } finally {
      await directoryHandle.close();
    }
    return file;
  }

  // Pass 2: directories one level at a time, every file exclusive, every
  // source byte re-checked against pass 1. Nothing is overwritten or deleted.
  async function copyPlannedFiles(rootPath: string, plan: CopyPlan) {
    for (const folder of plan.folders) await ensureCopyDirectory(resolvePathWithinRoot(rootPath, folder));
    for (const file of plan.files) {
      const bytes = file.bytes ?? await readInstructionCopyBytes(file.source!);
      if (fileHash(bytes) !== file.hash) {
        throw conflict("Instructions changed while they were being copied; nothing was activated");
      }
      await writeFileExclusive(resolvePathWithinRoot(rootPath, file.path), bytes);
    }
  }

  async function verifyCopiedFiles(rootPath: string, plan: CopyPlan) {
    const expected = plan.files.map(file => file.path).sort();
    const actual = await listDestinationEntries(rootPath);
    let exact = actual.length === expected.length && actual.every((entry, index) => entry === expected[index]);
    for (const file of exact ? plan.files : []) {
      const stat = await fs.lstat(resolvePathWithinRoot(rootPath, file.path));
      if (!stat.isFile() || stat.size !== file.size) exact = false;
    }
    if (!exact) throw conflict("The instructions destination changed during the copy; nothing was activated");
  }

  // Switch or reconfigure the bundle under the agent row lock (consolidated
  // 5.3, addenda 2 and 3). There is no unlocked form: export, copy, the
  // configuration persist and the completion record share one transaction.
  /** Writes our durable record, then re-scans; any other matching record aborts before a write. */
  async function beginCopyIntent(
    tx: InstructionTx,
    current: AgentLike,
    options: UpdateBundleOptions,
    identity: DestinationIdentity,
    rootPath: string,
    operationId: string,
    sourceRoot: string | null,
    plannedCount: number,
    plannedBytes: number,
  ): Promise<string> {
    const file = await createCopyIntent({
      version: 1,
      operationId,
      companyId: current.companyId,
      agentId: current.id,
      destination: identity,
      sourceRoot,
      plannedCount,
      plannedBytes,
      startedAt: new Date().toISOString(),
    });
    try {
      await classifyCopyIntents(tx, current, options, identity, rootPath, true, operationId);
    } catch (error) {
      await fs.unlink(file).catch(() => undefined);
      throw error;
    }
    return file;
  }

  /** Completion evidence on tx (addendum 2): an admin hint only, never an authorization. */
  async function recordCopyCompletion(
    tx: InstructionTx,
    current: AgentLike,
    options: UpdateBundleOptions,
    operationId: string,
    identity: DestinationIdentity,
    plannedCount: number,
    plannedBytes: number,
  ) {
    await tx.insert(activityLog).values({
      companyId: current.companyId,
      actorType: options.actor.actorType,
      actorId: options.actor.actorId,
      runId: options.actor.runId ?? null,
      action: INSTRUCTION_BUNDLE_COPY_COMPLETED_ACTION,
      entityType: "agent",
      entityId: current.id,
      agentId: current.id,
      details: {
        operationId,
        destination: { ino: identity.ino, birthtimeNs: identity.birthtimeNs, pathKeyHash: pathKeyHash(identity.pathKey) },
        plannedCount,
        plannedBytes,
      },
    });
  }

  /**
   * Refuses (409) when any copy record matches rootPath, for configuration
   * writers other than the bundle PATCH that switch the instruction root
   * (the instructions-path PATCH). Uses the same classifier as updateBundle,
   * treating the destination as populated, so nothing is removed and every
   * matching record refuses; recovery stays with the operator.
   */
  async function assertNoCopyIntentForRoot(tx: InstructionTx, agent: AgentLike, rootPath: string, isInstanceAdmin: boolean) {
    const resolved = path.resolve(rootPath);
    const stat = await fs.stat(resolved, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
      throw error;
    });
    // A folder that is missing (or not a folder) still matches a record by
    // its folded path, taken from the nearest existing ancestor's real path.
    const identity: DestinationIdentity = stat?.isDirectory()
      ? await captureDestinationIdentity(resolved)
      : await pathOnlyIdentity(resolved);
    await classifyCopyIntents(tx, agent, { isInstanceAdmin }, identity, resolved, false, null);
  }

  /**
   * WS-2 PR-W1 exclusive roots (instruction-root-exclusivity.ts). With lock
   * (the default), conn is the caller's transaction, after its agent row lock.
   */
  async function assertExclusiveRoot(
    conn: InstructionTx | Db,
    agent: AgentLike,
    rootPath: string,
    options: { isInstanceAdmin: boolean; lock?: boolean },
  ) {
    await assertExclusiveInstructionRoot(conn as unknown as Db, agent, rootPath, {
      ...options,
      deriveRoot: (other) => deriveBundleState(other).rootPath,
    });
  }

  /** The unlocked create and hire pre-check of the root a new configuration names, if any. */
  async function precheckExclusiveRoot(conn: Db, agent: AgentLike, options: { isInstanceAdmin: boolean }) {
    const rootPath = deriveBundleState(agent).rootPath;
    if (!rootPath) return;
    await assertExclusiveRoot(conn, agent, rootPath, { isInstanceAdmin: options.isInstanceAdmin, lock: false });
  }

  async function updateBundle(
    agent: AgentLike,
    input: UpdateBundleInput,
    options: UpdateBundleOptions,
  ): Promise<{ bundle: AgentInstructionsBundle; adapterConfig: Record<string, unknown> }> {
    if (!db) throw unprocessable("Bundle updates require the database-backed instructions service");
    if (!options?.persist) throw unprocessable("Bundle updates must persist their configuration under the agent lock");
    let ownIntentFile: string | null = null;
    const result = await db.transaction(async (tx) => {
      // Step 1: lock, then recheck what the route authorized (3.2).
      const [current] = await tx.select().from(agents)
        .where(and(eq(agents.id, agent.id), eq(agents.companyId, agent.companyId))).for("no key update");
      if (!current) throw notFound("Agent not found");
      await assertExpectedTarget(current, options.expectedTarget);
      if (agentInstructionsBundleMode(current) !== options.expectedConfigMode) throw conflict(MODE_CHANGED_MESSAGE);

      // Step 2: plan the destination.
      const state = await recoverManagedBundleState(current, deriveBundleState(current));
      const nextMode = input.mode ?? state.mode ?? "managed";
      const nextEntryFile = input.entryFile ? normalizeRelativeFilePath(input.entryFile) : state.entryFile;
      let nextRootPath: string;
      if (nextMode === "managed") {
        nextRootPath = resolveManagedInstructionsRoot(current);
      } else {
        const rootPath = asString(input.rootPath) ?? state.rootPath;
        if (!rootPath) throw unprocessable("External instructions bundles require an absolute rootPath");
        const resolvedRoot = resolveHomeAwarePath(rootPath);
        if (!path.isAbsolute(resolvedRoot)) throw unprocessable("External instructions bundles require an absolute rootPath");
        nextRootPath = resolvedRoot;
      }
      await assertInstructionPathSafe(nextRootPath, nextEntryFile);
      // WS-2 PR-W1: a switch to another root takes the assignment lock and
      // refuses a root that overlaps another agent, before the first folder.
      const configuredRoot = deriveBundleState(current).rootPath;
      if (!configuredRoot || path.resolve(configuredRoot) !== path.resolve(nextRootPath)) {
        await assertExclusiveRoot(tx, current, nextRootPath, { isInstanceAdmin: options.isInstanceAdmin === true });
      }
      await fs.mkdir(nextRootPath, { recursive: true });
      const identity = await captureDestinationIdentity(nextRootPath);
      const existingFiles = await listFilesRecursive(nextRootPath);
      // Exact compare by design (addendum 3 section 3): every other spelling
      // goes through the folded history check.
      if (nextMode === "managed" && !existingFiles.includes(nextEntryFile)) {
        await assertUnversionedEntry(current, nextEntryFile, tx);
      }
      const destinationEmpty = existingFiles.length === 0;

      // Step 3: any matching copy record refuses (or, for this agent on an
      // empty destination, is cleared).
      await classifyCopyIntents(tx, current, options, identity, nextRootPath, destinationEmpty, null);

      const nextConfig = applyBundleConfig(state.config, {
        mode: nextMode,
        rootPath: nextRootPath,
        entryFile: nextEntryFile,
        clearLegacyPromptTemplate: input.clearLegacyPromptTemplate,
      });

      if (!destinationEmpty) {
        // Step 4: adopt the populated destination; only a missing entry is
        // written, exclusively, so an existing file is never replaced (C-2).
        const entryBytes = existingFiles.includes(nextEntryFile) ? null : await sourceEntryBytes(state, null, nextEntryFile, current);
        await options.persist(tx, current, nextConfig);
        if (entryBytes) {
          // The entry write is guarded like a copy: a record is durable before
          // the file is created, so a write that fails after creating it (for
          // example ENOSPC) leaves a record that refuses the next PATCH instead
          // of a truncated entry that would be adopted.
          const operationId = randomUUID();
          ownIntentFile = await beginCopyIntent(tx, current, options, identity, nextRootPath, operationId, null, 1, entryBytes.length);
          const entryPath = await assertInstructionPathSafe(nextRootPath, nextEntryFile);
          await fs.mkdir(path.dirname(entryPath), { recursive: true });
          await writeFileExclusive(entryPath, entryBytes, { existingIsPresent: true });
          await recordCopyCompletion(tx, current, options, operationId, identity, 1, entryBytes.length);
        }
      } else {
        // Step 5: pass 1; step 6: persist before anything is written.
        const plan = await planBundleCopy(state, current, nextEntryFile);
        await options.persist(tx, current, nextConfig);
        // Steps 7 and 8: our intent, durable before the first destination
        // write, then the peer re-scan.
        const operationId = randomUUID();
        ownIntentFile = await beginCopyIntent(tx, current, options, identity, nextRootPath, operationId, plan.sourceRoot, plan.files.length, plan.bytes);
        // Steps 9 to 11: copy, verify, completion evidence on tx.
        await copyPlannedFiles(nextRootPath, plan);
        await verifyCopiedFiles(nextRootPath, plan);
        await recordCopyCompletion(tx, current, options, operationId, identity, plan.files.length, plan.bytes);
      }
      const bundle = await getBundle({ ...current, adapterConfig: nextConfig });
      return { bundle, adapterConfig: nextConfig };
    });
    // Step 13: after commit, remove only our own record. A failure leaves it in
    // place, which refuses later switches to this folder until an operator
    // deletes it (addendum 2, 3.3).
    if (ownIntentFile) {
      const file = ownIntentFile;
      await fs.unlink(file).catch((error: unknown) => {
        logger.warn({ err: error, intentFile: file }, "instructions bundle copy committed but its copy record was not removed");
      });
    }
    return result;
  }

  async function writeFileUnversioned(
    agent: AgentLike,
    relativePath: string,
    content: string,
    options?: { clearLegacyPromptTemplate?: boolean },
    tx?: InstructionTx,
  ): Promise<{
    bundle: AgentInstructionsBundle;
    file: AgentInstructionsFileDetail;
    adapterConfig: Record<string, unknown>;
  }> {
    const current = deriveBundleState(agent);
    if (relativePath === LEGACY_PROMPT_TEMPLATE_PATH) {
      const adapterConfig: Record<string, unknown> = {
        ...current.config,
        [PROMPT_KEY]: content,
      };
      const nextAgent = { ...agent, adapterConfig };
      const [bundle, file] = await Promise.all([
        getBundle(nextAgent),
        readFile(nextAgent, LEGACY_PROMPT_TEMPLATE_PATH),
      ]);
      return { bundle, file, adapterConfig };
    }

    const configured = await recoverManagedBundleState(agent, current);
    if (await matchesInstructionEntry(configured.rootPath, normalizeRelativeFilePath(relativePath), [configured.entryFile])) {
      throw unprocessable("Entry edits require the canonical instruction commit service and baseRevisionId", { code: "INSTRUCTION_REVISION_REQUIRED" });
    }
    if (configured.mode !== "external") agentFilePath(relativePath);
    const prepared = await ensureWritableBundle(agent, options, tx);
    instructionBytes(content);
    await assertInstructionPathSafe(prepared.state.rootPath!, relativePath);
    const absolutePath = resolvePathWithinRoot(prepared.state.rootPath!, relativePath);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, content, "utf8");
    const nextAgent = { ...agent, adapterConfig: prepared.adapterConfig };
    const [bundle, file] = await Promise.all([
      getBundle(nextAgent),
      readFile(nextAgent, relativePath),
    ]);
    return { bundle, file, adapterConfig: prepared.adapterConfig };
  }

  async function deleteFileUnversioned(agent: AgentLike, relativePath: string): Promise<{
    bundle: AgentInstructionsBundle;
    adapterConfig: Record<string, unknown>;
  }> {
    const derived = deriveBundleState(agent);
    const state = await recoverManagedBundleState(agent, derived);
    if (relativePath === LEGACY_PROMPT_TEMPLATE_PATH) {
      throw unprocessable("Cannot delete the legacy promptTemplate pseudo-file");
    }
    if (!state.rootPath) throw notFound("Agent instructions bundle is not configured");
    const normalizedPath = normalizeRelativeFilePath(relativePath);
    if (await matchesInstructionEntry(state.rootPath, normalizedPath, [state.entryFile])) {
      throw unprocessable("Cannot delete the bundle entry file");
    }
    const absolutePath = await assertInstructionPathSafe(state.rootPath, normalizedPath);
    await fs.rm(absolutePath, { force: true });
    const adapterConfig = buildPersistedBundleConfig(derived, state);
    const bundle = await getBundle({ ...agent, adapterConfig });
    return { bundle, adapterConfig };
  }

  // The bundle mode a caller chose its write path for. "external" means the
  // unversioned path for any bundle that is not managed, matching the route's
  // branch predicate. A mismatch under the lock means the mode changed after
  // the caller read the agent, so nothing may be written or deleted.
  function assertExpectedBundleMode(current: AgentLike, expectedMode: InstructionBundleWriteMode | undefined) {
    if (!expectedMode) return;
    const currentlyManaged = agentInstructionsBundleMode(current) === "managed";
    if (currentlyManaged !== (expectedMode === "managed")) {
      throw conflict("The instructions bundle mode changed; reload and retry");
    }
  }

  // The exact destination a caller routed for. A different mode or root under
  // the lock means another change won the race, so nothing may be written.
  async function assertExpectedTarget(current: AgentLike, expectedTarget: InstructionWriteTarget | undefined) {
    if (!expectedTarget) return;
    const target = await resolveInstructionWriteTarget(current);
    if (target.mode !== expectedTarget.mode || target.rootPath !== expectedTarget.rootPath) {
      throw conflict("The instructions bundle mode changed; reload and retry");
    }
  }

  // Reload configuration under the commit lock: a previously supporting file
  // may have become the configured entry since the route loaded its agent.
  async function withCurrentAgent<T>(
    agent: AgentLike,
    relativePath: string,
    operation: (current: AgentLike, tx?: InstructionTx) => Promise<T>,
    expected?: { mode?: InstructionBundleWriteMode; target?: InstructionWriteTarget },
  ) {
    if (!db) {
      assertExpectedBundleMode(agent, expected?.mode);
      await assertExpectedTarget(agent, expected?.target);
      return operation(agent);
    }
    return db.transaction(async (tx) => {
      const [current] = await tx.select().from(agents)
        .where(and(eq(agents.id, agent.id), eq(agents.companyId, agent.companyId))).for("no key update");
      if (!current) throw notFound("Agent not found");
      assertExpectedBundleMode(current, expected?.mode);
      await assertExpectedTarget(current, expected?.target);
      if (relativePath !== LEGACY_PROMPT_TEMPLATE_PATH) {
        // Historical entries also remain projections if the configured entry changes.
        await assertUnversionedEntry(current, normalizeRelativeFilePath(relativePath), tx);
      }
      return operation(current, tx);
    });
  }
  async function writeFile(
    agent: AgentLike,
    relativePath: string,
    content: string,
    options?: {
      clearLegacyPromptTemplate?: boolean;
      expectedMode?: InstructionBundleWriteMode;
      expectedTarget?: InstructionWriteTarget;
      // Persist the resulting configuration inside the same locked transaction,
      // so a bundle PATCH queued behind this write is not reverted by a
      // configuration built from the pre-PATCH row.
      persistConfig?: InstructionConfigPersist;
    },
  ) {
    const writeOptions = options ? { clearLegacyPromptTemplate: options.clearLegacyPromptTemplate } : undefined;
    return withCurrentAgent(agent, relativePath, async (current, tx) => {
      const result = await writeFileUnversioned(current, relativePath, content, writeOptions, tx);
      if (options?.persistConfig) {
        if (!tx) throw unprocessable("Configuration persistence requires the database-backed instructions service");
        await options.persistConfig(tx, current, result.adapterConfig);
      }
      return result;
    }, { mode: options?.expectedMode, target: options?.expectedTarget });
  }
  async function deleteFile(
    agent: AgentLike,
    relativePath: string,
    options?: { expectedMode?: InstructionBundleWriteMode; expectedTarget?: InstructionWriteTarget },
  ) {
    return withCurrentAgent(agent, relativePath, (current) => deleteFileUnversioned(current, relativePath),
      { mode: options?.expectedMode, target: options?.expectedTarget });
  }

  async function exportFiles(agent: AgentLike, options?: { rejectSymlinks?: boolean }): Promise<{
    files: Record<string, string>;
    entryFile: string;
    warnings: string[];
  }> {
    const state = await recoverManagedBundleState(agent, deriveBundleState(agent));
    if (state.rootPath) {
      const stat = await statIfExists(state.rootPath);
      if (stat?.isDirectory()) {
        const relativePaths = await listFilesRecursive(state.rootPath, { ...options, legacyExcludes: true });
        const files = Object.fromEntries(await Promise.all(relativePaths.map(async (relativePath) => {
          const absolutePath = resolvePathWithinRoot(state.rootPath!, relativePath);
          const content = await fs.readFile(absolutePath, "utf8");
          return [relativePath, content] as const;
        })));
        if (Object.keys(files).length > 0) {
          return { files, entryFile: state.entryFile, warnings: state.warnings };
        }
      }
    }

    const legacyBody = await readLegacyInstructions(agent, state.config);
    return {
      files: { [state.entryFile]: legacyBody || "_No AGENTS instructions were resolved from current agent config._" },
      entryFile: state.entryFile,
      warnings: state.warnings,
    };
  }

  async function materializeManagedBundleUnversioned(
    agent: AgentLike,
    files: Record<string, string>,
    options?: {
      clearLegacyPromptTemplate?: boolean;
      replaceExisting?: boolean;
      entryFile?: string;
    },
  ): Promise<{ bundle: AgentInstructionsBundle; adapterConfig: Record<string, unknown> }> {
    const rootPath = resolveManagedInstructionsRoot(agent);
    const entryFile = options?.entryFile ? normalizeRelativeFilePath(options.entryFile) : ENTRY_FILE_DEFAULT;

    for (const [relativePath, content] of Object.entries(files)) {
      instructionBytes(content);
      await assertInstructionPathSafe(rootPath, agentFilePath(relativePath));
    }
    const previous = await readInstructionBytes(rootPath, entryFile);
    if (previous && !previous.equals(instructionBytes(files[entryFile] ?? ""))) {
      throw unprocessable("Existing entry content must be saved through the canonical revision API before replacing a bundle", { code: "INSTRUCTION_REVISION_REQUIRED" });
    }
    if (options?.replaceExisting) {
      await fs.rm(rootPath, { recursive: true, force: true });
    }
    await fs.mkdir(rootPath, { recursive: true });

    const normalizedEntries = Object.entries(files).map(([relativePath, content]) => [
      normalizeRelativeFilePath(relativePath),
      content,
    ] as const);
    for (const [relativePath, content] of normalizedEntries) {
      const absolutePath = resolvePathWithinRoot(rootPath, relativePath);
      await fs.mkdir(path.dirname(absolutePath), { recursive: true });
      await fs.writeFile(absolutePath, content, "utf8");
    }
    if (!normalizedEntries.some(([relativePath]) => relativePath === entryFile)) {
      await fs.writeFile(resolvePathWithinRoot(rootPath, entryFile), "", "utf8");
    }

    const adapterConfig = applyBundleConfig(asRecord(agent.adapterConfig), {
      mode: "managed",
      rootPath,
      entryFile,
      clearLegacyPromptTemplate: options?.clearLegacyPromptTemplate,
    });
    const bundle = await getBundle({ ...agent, adapterConfig });
    return { bundle, adapterConfig };
  }

  async function materializeManagedBundle(
    ...args: Parameters<typeof materializeManagedBundleUnversioned>
  ) {
    if (!db) throw unprocessable("Bundle initialization requires the database-backed instructions service");
    return db.transaction(async (tx) => {
      const agent = args[0];
      const [owner] = await tx.select({ id: agents.id }).from(agents).where(and(eq(agents.id, agent.id), eq(agents.companyId, agent.companyId))).for("no key update");
      if (!owner) throw notFound("Agent not found");
      // WS-2 PR-W1: the first bind of the managed root is a root activation.
      const managedRoot = resolveManagedInstructionsRoot(agent);
      const configuredRoot = deriveBundleState(agent).rootPath;
      if (!configuredRoot || path.resolve(configuredRoot) !== managedRoot) {
        await assertExclusiveRoot(tx, agent, managedRoot, { isInstanceAdmin: false });
      }
      await assertUnversionedEntry(agent, args[2]?.entryFile ? normalizeRelativeFilePath(args[2].entryFile) : ENTRY_FILE_DEFAULT, tx);
      if (args[2]?.replaceExisting) {
        const [existingHead] = await tx.select({ id: agentInstructionHeads.revisionId }).from(agentInstructionHeads)
          .where(and(eq(agentInstructionHeads.companyId, agent.companyId), eq(agentInstructionHeads.agentId, agent.id))).limit(1);
        if (existingHead) throw unprocessable("Replacing this bundle would remove a versioned entry. Use canonical content commits.", { code: "INSTRUCTION_REVISION_REQUIRED" });
      }
      return materializeManagedBundleUnversioned(...args);
    });
  }

  return {
    getBundle,
    readFile,
    updateBundle,
    assertNoCopyIntentForRoot,
    assertExclusiveRoot,
    precheckExclusiveRoot,
    writeFile,
    deleteFile,
    exportFiles,
    ensureManagedBundle: ensureWritableBundle,
    materializeManagedBundle,
  };
}
