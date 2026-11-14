/**
 * The agent debug setting that captures raw provider traces
 * (`runtimeConfig.debug.providerTrace === "raw"`). Turning it on or off is an
 * instance-admin action; a value that stays the same needs no extra authority.
 * This is the one predicate the agent routes and the hire approval guard share.
 */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function isRawProviderTraceEnabled(runtimeConfig: unknown): boolean {
  return asRecord(asRecord(runtimeConfig)?.debug)?.providerTrace === "raw";
}

/** True when going from `previous` to `next` turns raw provider tracing on or off. */
export function providerTraceSettingChanges(next: unknown, previous?: unknown): boolean {
  return isRawProviderTraceEnabled(previous) !== isRawProviderTraceEnabled(next);
}
