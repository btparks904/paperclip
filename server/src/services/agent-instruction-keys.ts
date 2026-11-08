/**
 * The adapterConfig keys that select an agent's instructions: the bundle mode,
 * root and entry file, plus the legacy file pointers. Every registered adapter
 * uses `instructionsFilePath` as its instructions path key, so this set is
 * complete for the adapter registry at this baseline. An adapter that declares
 * another path key must be added here.
 */
export const AGENT_INSTRUCTION_CONFIG_KEYS = [
  "instructionsBundleMode",
  "instructionsRootPath",
  "instructionsEntryFile",
  "instructionsFilePath",
  "agentsMdPath",
] as const;

export type AgentInstructionConfigKey = (typeof AGENT_INSTRUCTION_CONFIG_KEYS)[number];

export const AGENT_INSTRUCTION_CONFIG_KEY_SET: ReadonlySet<string> = new Set(AGENT_INSTRUCTION_CONFIG_KEYS);

/** The instruction keys present in a config, absent keys omitted. */
export function pickInstructionConfig(config: Record<string, unknown>): Partial<Record<AgentInstructionConfigKey, unknown>> {
  const picked: Partial<Record<AgentInstructionConfigKey, unknown>> = {};
  for (const key of AGENT_INSTRUCTION_CONFIG_KEYS) {
    if (config[key] !== undefined) picked[key] = config[key];
  }
  return picked;
}

/** True when both configs hold the same value, or both lack, each instruction key. */
export function instructionConfigEqual(left: Record<string, unknown>, right: Record<string, unknown>) {
  return AGENT_INSTRUCTION_CONFIG_KEYS.every((key) =>
    JSON.stringify(left[key] ?? null) === JSON.stringify(right[key] ?? null));
}

/**
 * Returns `next` with every instruction key that the write does not set on
 * purpose taken from `locked`: the locked row's value when it has one, else
 * the key removed.
 */
export function carryForwardInstructionConfig(
  next: Record<string, unknown>,
  locked: Record<string, unknown>,
  writes: "all" | readonly AgentInstructionConfigKey[],
): Record<string, unknown> {
  if (writes === "all") return next;
  const carried = { ...next };
  for (const key of AGENT_INSTRUCTION_CONFIG_KEYS) {
    if (writes.includes(key)) continue;
    if (locked[key] !== undefined) carried[key] = locked[key];
    else delete carried[key];
  }
  return carried;
}
