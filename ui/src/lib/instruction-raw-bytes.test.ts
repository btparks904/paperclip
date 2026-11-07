import { createHash, webcrypto } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  INSTRUCTION_MAX_UTF16_CODE_UNITS,
  INSTRUCTION_MAX_UTF8_BYTES,
  InstructionRawBytesError,
  browserSubtleCrypto,
  containsCarriageReturn,
  encodeInstructionUtf8,
  inspectInstructionRawText,
  isSha256Hex,
  isWellFormedUtf16,
  parseExpectedSha256,
  sha256HexOfInstructionText,
} from "./instruction-raw-bytes";

const subtle = webcrypto.subtle as unknown as SubtleCrypto;
const nodeSha = (text: string) => createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");

describe("instruction raw bytes helper", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("hashes known SHA-256 vectors as lowercase hex", async () => {
    await expect(sha256HexOfInstructionText("", subtle)).resolves.toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    await expect(sha256HexOfInstructionText("abc", subtle)).resolves.toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    await expect(sha256HexOfInstructionText("a\nb\n", subtle)).resolves.toBe(nodeSha("a\nb\n"));
  });

  it("accepts empty, ASCII and LF text", () => {
    for (const text of ["", "plain ascii", "line one\nline two\n", "\nleading newline"]) {
      const inspection = inspectInstructionRawText(text);
      expect(inspection.problems).toEqual([]);
      expect(inspection.utf8ByteLength).toBe(Buffer.byteLength(text, "utf8"));
    }
  });

  it("rejects CRLF, lone CR and mixed line endings without rewriting them", async () => {
    for (const text of ["a\r\nb", "a\rb", "a\nb\r\nc\rd"]) {
      expect(containsCarriageReturn(text)).toBe(true);
      expect(inspectInstructionRawText(text).problems).toContain("carriage_return");
      // Hashing is still byte exact: CR is never converted to LF.
      await expect(sha256HexOfInstructionText(text, subtle)).resolves.toBe(nodeSha(text));
      await expect(sha256HexOfInstructionText(text, subtle)).resolves.not.toBe(nodeSha(text.replace(/\r\n?/g, "\n")));
    }
  });

  it("keeps a BOM, NFC versus NFD, supplementary characters and whitespace distinct", async () => {
    const bom = "﻿# Title\n";
    const nfc = "café";
    const nfd = "café";
    const astral = "rocket \u{1F680} and \u{10348}";
    const spaced = "trailing spaces   \n\ttabbed\t\n";
    const withNewline = "text\n";
    expect(encodeInstructionUtf8(bom).slice(0, 3)).toEqual(new Uint8Array([0xef, 0xbb, 0xbf]));
    await expect(sha256HexOfInstructionText(bom, subtle)).resolves.toBe(nodeSha(bom));
    await expect(sha256HexOfInstructionText(bom, subtle)).resolves.not.toBe(nodeSha("# Title\n"));
    const nfcHash = await sha256HexOfInstructionText(nfc, subtle);
    const nfdHash = await sha256HexOfInstructionText(nfd, subtle);
    expect(nfcHash).toBe(nodeSha(nfc));
    expect(nfdHash).toBe(nodeSha(nfd));
    expect(nfcHash).not.toBe(nfdHash);
    expect(inspectInstructionRawText(astral)).toMatchObject({ problems: [], utf8ByteLength: Buffer.byteLength(astral, "utf8") });
    await expect(sha256HexOfInstructionText(astral, subtle)).resolves.toBe(nodeSha(astral));
    await expect(sha256HexOfInstructionText(spaced, subtle)).resolves.toBe(nodeSha(spaced));
    await expect(sha256HexOfInstructionText(withNewline, subtle)).resolves.not.toBe(nodeSha("text"));
  });

  it("rejects lone high and lone low surrogates instead of substituting U+FFFD", async () => {
    for (const text of ["a\uD800b", "a\uDC00b", "end\uD83D", "\uDE80start"]) {
      expect(isWellFormedUtf16(text)).toBe(false);
      expect(inspectInstructionRawText(text)).toMatchObject({ utf8ByteLength: null, problems: ["ill_formed"] });
      expect(() => encodeInstructionUtf8(text)).toThrow(InstructionRawBytesError);
      await expect(sha256HexOfInstructionText(text, subtle)).rejects.toMatchObject({ code: "ill_formed" });
    }
    expect(isWellFormedUtf16("🚀")).toBe(true);
  });

  it("enforces the 1 MiB UTF-8 byte limit at the boundary", () => {
    expect(INSTRUCTION_MAX_UTF8_BYTES).toBe(1024 * 1024);
    const atLimit = "é".repeat(INSTRUCTION_MAX_UTF8_BYTES / 2);
    expect(atLimit.length).toBe(INSTRUCTION_MAX_UTF8_BYTES / 2);
    expect(inspectInstructionRawText(atLimit)).toMatchObject({ problems: [], utf8ByteLength: INSTRUCTION_MAX_UTF8_BYTES });
    const overLimit = `${atLimit}a`;
    expect(inspectInstructionRawText(overLimit).problems).toEqual(["too_many_utf8_bytes"]);
  });

  it("enforces the server UTF-16 code-unit limit at the boundary", () => {
    expect(INSTRUCTION_MAX_UTF16_CODE_UNITS).toBe(1024 * 1024);
    const atLimit = "a".repeat(INSTRUCTION_MAX_UTF16_CODE_UNITS);
    expect(inspectInstructionRawText(atLimit).problems).toEqual([]);
    expect(inspectInstructionRawText(`${atLimit}a`).problems).toEqual(["too_many_utf8_bytes", "too_many_code_units"]);
    // Supplementary characters use two code units and four bytes each.
    const astral = "\u{1F600}".repeat(INSTRUCTION_MAX_UTF8_BYTES / 4);
    expect(inspectInstructionRawText(astral)).toMatchObject({ problems: [], codeUnitLength: INSTRUCTION_MAX_UTF8_BYTES / 2 });
  });

  it("fails closed without Web Crypto and has no fallback hash", async () => {
    await expect(sha256HexOfInstructionText("abc", null)).rejects.toMatchObject({ code: "crypto_unavailable" });
    vi.stubGlobal("crypto", undefined);
    expect(browserSubtleCrypto()).toBeNull();
    await expect(sha256HexOfInstructionText("abc")).rejects.toMatchObject({ code: "crypto_unavailable" });
    vi.stubGlobal("crypto", {});
    expect(browserSubtleCrypto()).toBeNull();
    await expect(sha256HexOfInstructionText("abc")).rejects.toBeInstanceOf(InstructionRawBytesError);
  });

  it("uses an injected SubtleCrypto and reports digest failures without content", async () => {
    const secret = "SENTINEL-CONTENT-7f3a";
    const failing = { digest: vi.fn(async () => { throw new Error(secret); }) } as unknown as SubtleCrypto;
    const error = await sha256HexOfInstructionText(secret, failing).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(InstructionRawBytesError);
    expect((error as Error).message).not.toContain(secret);
    expect(String((error as Error).stack)).not.toContain(secret);
    expect(JSON.stringify(error)).not.toContain(secret);
    const illFormed = await sha256HexOfInstructionText(`${secret}\uD800`, subtle).catch((caught: unknown) => caught);
    expect((illFormed as Error).message).not.toContain(secret);
    const spy = vi.fn(subtle.digest.bind(subtle));
    await sha256HexOfInstructionText("abc", { digest: spy } as unknown as SubtleCrypto);
    expect(spy).toHaveBeenCalledWith("SHA-256", expect.any(Uint8Array));
  });

  it("does not mutate its input or log", async () => {
    const consoleSpies = (["log", "info", "warn", "error", "debug"] as const).map((method) => vi.spyOn(console, method));
    const text = "﻿keep  \r\n exactlý \u{1F680}";
    const copy = `${text}`;
    inspectInstructionRawText(text);
    await sha256HexOfInstructionText(text, subtle);
    expect(text).toBe(copy);
    for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
  });

  it("validates server hashes strictly and parses operator hashes without trimming", () => {
    const hash = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
    expect(isSha256Hex(hash)).toBe(true);
    expect(isSha256Hex(hash.toUpperCase())).toBe(false);
    expect(isSha256Hex(undefined)).toBe(false);
    expect(parseExpectedSha256(hash.toUpperCase())).toBe(hash);
    expect(parseExpectedSha256(hash)).toBe(hash);
    expect(parseExpectedSha256(` ${hash}`)).toBeNull();
    expect(parseExpectedSha256(`${hash}\n`)).toBeNull();
    expect(parseExpectedSha256(hash.slice(1))).toBeNull();
    expect(parseExpectedSha256(`${hash.slice(1)}g`)).toBeNull();
    expect(parseExpectedSha256("")).toBeNull();
  });
});
