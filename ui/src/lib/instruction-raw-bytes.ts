/**
 * Byte-exact helpers for the raw instruction editor.
 *
 * The raw editor hashes exactly the UTF-8 bytes the server will store, so
 * these helpers never normalize text: no Unicode normalization, no BOM
 * stripping, no trimming and no line-ending rewrites. Errors carry a fixed
 * message and a code only, never any part of the text.
 */

/** Server limit on the stored UTF-8 bytes (instructionBytes). */
export const INSTRUCTION_MAX_UTF8_BYTES = 1024 * 1024;
/** Server schema limit on the JSON string length, in UTF-16 code units. */
export const INSTRUCTION_MAX_UTF16_CODE_UNITS = 1024 * 1024;

const SHA256_HEX = /^[a-f0-9]{64}$/;
const SHA256_HEX_ANY_CASE = /^[0-9a-fA-F]{64}$/;

export type InstructionRawBytesErrorCode = "crypto_unavailable" | "ill_formed" | "digest_failed";

const ERROR_MESSAGES: Record<InstructionRawBytesErrorCode, string> = {
  crypto_unavailable: "Browser SHA-256 is unavailable in this context.",
  ill_formed: "The text is not well-formed Unicode and cannot be encoded exactly.",
  digest_failed: "The browser could not compute the SHA-256 hash.",
};

export class InstructionRawBytesError extends Error {
  readonly code: InstructionRawBytesErrorCode;
  constructor(code: InstructionRawBytesErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "InstructionRawBytesError";
    this.code = code;
  }
}

export type InstructionRawTextProblem =
  | "ill_formed"
  | "carriage_return"
  | "too_many_utf8_bytes"
  | "too_many_code_units";

export interface InstructionRawTextInspection {
  /** UTF-8 byte length, or null when the text is ill-formed. */
  utf8ByteLength: number | null;
  codeUnitLength: number;
  problems: InstructionRawTextProblem[];
}

/** True when every surrogate code unit is part of a valid pair. */
export function isWellFormedUtf16(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = index + 1 < text.length ? text.charCodeAt(index + 1) : -1;
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

export function containsCarriageReturn(text: string): boolean {
  return text.includes("\r");
}

/** Exact UTF-8 encoding. Refuses ill-formed text instead of substituting U+FFFD. */
export function encodeInstructionUtf8(text: string): Uint8Array<ArrayBuffer> {
  if (!isWellFormedUtf16(text)) throw new InstructionRawBytesError("ill_formed");
  return new TextEncoder().encode(text);
}

/** Synchronous eligibility facts. Never throws and never mutates the input. */
export function inspectInstructionRawText(text: string): InstructionRawTextInspection {
  const problems: InstructionRawTextProblem[] = [];
  let utf8ByteLength: number | null = null;
  if (isWellFormedUtf16(text)) {
    utf8ByteLength = new TextEncoder().encode(text).length;
    if (utf8ByteLength > INSTRUCTION_MAX_UTF8_BYTES) problems.push("too_many_utf8_bytes");
  } else {
    problems.push("ill_formed");
  }
  if (containsCarriageReturn(text)) problems.push("carriage_return");
  if (text.length > INSTRUCTION_MAX_UTF16_CODE_UNITS) problems.push("too_many_code_units");
  return { utf8ByteLength, codeUnitLength: text.length, problems };
}

/** The browser SubtleCrypto, or null outside a secure context. */
export function browserSubtleCrypto(): SubtleCrypto | null {
  const cryptoObject = (globalThis as { crypto?: Crypto }).crypto;
  const subtle = cryptoObject?.subtle;
  return subtle && typeof subtle.digest === "function" ? subtle : null;
}

/**
 * Lowercase hex SHA-256 of the exact UTF-8 bytes of `text`. Rejects when Web
 * Crypto is unavailable (no fallback implementation) or the text is ill-formed.
 */
export async function sha256HexOfInstructionText(
  text: string,
  subtle: SubtleCrypto | null = browserSubtleCrypto(),
): Promise<string> {
  if (!subtle || typeof subtle.digest !== "function") throw new InstructionRawBytesError("crypto_unavailable");
  const bytes = encodeInstructionUtf8(text);
  let digest: ArrayBuffer;
  try {
    digest = await subtle.digest("SHA-256", bytes);
  } catch {
    throw new InstructionRawBytesError("digest_failed");
  }
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  if (!SHA256_HEX.test(hex)) throw new InstructionRawBytesError("digest_failed");
  return hex;
}

/** True for a server-shaped lowercase hex SHA-256. */
export function isSha256Hex(value: unknown): value is string {
  return typeof value === "string" && SHA256_HEX.test(value);
}

/**
 * Parses an operator-entered expected hash: exactly 64 hex digits, either
 * case, nothing else (no trimming). Returns lowercase hex, or null.
 */
export function parseExpectedSha256(input: string): string | null {
  return SHA256_HEX_ANY_CASE.test(input) ? input.toLowerCase() : null;
}
