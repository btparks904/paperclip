const SILENCED_SUCCESS_METHODS = new Set(["GET", "HEAD"]);

const SILENCED_SUCCESS_API_PATHS = [
  /^\/api\/health(?:\/|$)/,
  /^\/api\/companies\/[^/]+\/activity(?:\/|$)/,
  /^\/api\/companies\/[^/]+\/dashboard(?:\/|$)/,
  /^\/api\/companies\/[^/]+\/heartbeat-runs(?:\/|$)/,
  /^\/api\/companies\/[^/]+\/issues(?:\/|$)/,
  /^\/api\/companies\/[^/]+\/live-runs(?:\/|$)/,
  /^\/api\/companies\/[^/]+\/sidebar-badges(?:\/|$)/,
  /^\/api\/heartbeat-runs\/[^/]+\/log(?:\/|$)/,
];

const SILENCED_SUCCESS_STATIC_PREFIXES = [
  "/@fs/",
  "/@id/",
  "/@react-refresh",
  "/@vite/",
  "/_plugins/",
  "/assets/",
  "/node_modules/",
  "/src/",
];

const SILENCED_SUCCESS_STATIC_PATHS = new Set([
  "/",
  "/index.html",
  "/favicon.ico",
  "/site.webmanifest",
  "/sw.js",
]);

function normalizePath(url: string): string {
  const trimmed = url.trim();
  if (trimmed.length === 0) return "/";
  const pathname = trimmed.split("?")[0]?.trim() ?? "/";
  return pathname.length > 0 ? pathname : "/";
}

const SECRET_SENSITIVE_HTTP_PATHS = [
  /^\/api\/chat-endpoints\/[^/]+\/setup(?:-secret)?(?:\/|$)/,
];
const SECRET_SENSITIVE_HTTP_METHODS = new Set(["POST", "PUT", "PATCH"]);

/** Provider payloads are private even when a method/signature is rejected. */
export function isPrivateWebhookHttpRequest(
  method: string | undefined,
  url: string | undefined,
): boolean {
  if (!method || !url) return false;
  let pathname = normalizePath(url);
  if (/^https?:\/\//i.test(pathname)) {
    // Do not let URL dot-segment normalization erase an explicitly supplied
    // ingress namespace on a malformed absolute-form callback.
    const rawPath = pathname.replace(/^https?:\/\/[^/]*/i, "");
    if (/^\/api\/(?:chat-webhooks|routine-triggers\/public)(?:\/|$)/i.test(rawPath)) return true;
    try {
      pathname = new URL(url).pathname;
    } catch {
      return false;
    }
  }
  // This namespace is reserved for provider ingress, including malformed or
  // unknown callback paths. Rejecting a route must not make its payload public.
  return /^\/api\/(?:chat-webhooks|routine-triggers\/public)(?:\/|$)/i.test(pathname);
}

/**
 * Managed agent instruction writes carry the complete private instruction file
 * in the request body. Classify them by exact method and route so a rejected
 * request (authentication, origin, validation, conflict or server failure)
 * never copies that body into HTTP logs or error diagnostics. Read routes,
 * restore, delete and bundle settings carry no instruction content and keep
 * their ordinary diagnostics.
 */
const PRIVATE_INSTRUCTION_CONTENT_HTTP_ROUTES: ReadonlyArray<{
  method: string;
  pattern: RegExp;
}> = [
  {
    method: "PUT",
    pattern: /^\/api\/agents\/[^/]+\/instructions-bundle\/file\/?$/i,
  },
  {
    method: "POST",
    pattern:
      /^\/api\/agents\/[^/]+\/instructions-bundle\/candidates\/[^/]+\/resolve\/?$/i,
  },
];

function requestPathname(url: string): string {
  const pathname = normalizePath(url);
  // Absolute-form request targets reach Express unchanged. Classify their path
  // component instead of letting a scheme and host prefix skip the match.
  return /^https?:\/\//i.test(pathname)
    ? pathname.replace(/^https?:\/\/[^/]*/i, "") || "/"
    : pathname;
}

export function isPrivateInstructionContentHttpRequest(
  method: string | undefined,
  url: string | undefined,
): boolean {
  if (!method || !url) return false;
  const upperMethod = method.toUpperCase();
  const pathname = requestPathname(url);
  return PRIVATE_INSTRUCTION_CONTENT_HTTP_ROUTES.some(
    (route) => route.method === upperMethod && route.pattern.test(pathname),
  );
}

/**
 * These routes accept or create one-time connector credentials. A provider or
 * validation error can echo credential material in its message even after the
 * structured request body has been redacted, so HTTP failure logs use generic
 * error metadata for the whole route. Webhook failures also use generic error
 * metadata: raw provider text/files/credentials cannot be named-field redacted.
 */
export function isSecretSensitiveHttpRequest(
  method: string | undefined,
  url: string | undefined,
): boolean {
  if (isPrivateWebhookHttpRequest(method, url)) return true;
  if (!method || !url) return false;
  if (!SECRET_SENSITIVE_HTTP_METHODS.has(method.toUpperCase())) return false;
  const pathname = normalizePath(url);
  return SECRET_SENSITIVE_HTTP_PATHS.some((pattern) => pattern.test(pathname));
}

export function shouldSilenceHttpSuccessLog(
  method: string | undefined,
  url: string | undefined,
  statusCode: number,
): boolean {
  if (statusCode >= 400) return false;
  if (statusCode === 304) return true;
  if (!method || !url) return false;
  if (!SILENCED_SUCCESS_METHODS.has(method.toUpperCase())) return false;

  const pathname = normalizePath(url);
  if (SILENCED_SUCCESS_STATIC_PATHS.has(pathname)) return true;
  if (
    SILENCED_SUCCESS_STATIC_PREFIXES.some((prefix) =>
      pathname.startsWith(prefix),
    )
  )
    return true;
  return SILENCED_SUCCESS_API_PATHS.some((pattern) => pattern.test(pathname));
}
