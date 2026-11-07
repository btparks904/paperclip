import { createHash } from "node:crypto";
import { expect, test, type APIRequestContext, type APIResponse, type Page } from "@playwright/test";

// Byte-exact raw instruction editor in a real browser: real textarea value
// semantics, real Web Crypto and the real instruction PUT contract.

const sha = (text: string) => createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
// BOM, leading newline, trailing spaces and tabs, NFD text, final newline.
const ORIGINAL = "﻿\n# Raw editor e2e original  \n\tindented\tline\ncafé\n";
const PROPOSED = "﻿\n# Raw editor e2e proposed  \n\tindented\tline\ncafé \u{1F680}\n\n";

async function json(response: APIResponse) {
  expect(response.ok(), `${response.status()}: ${await response.text()}`).toBe(true);
  return response.json();
}

async function setup(request: APIRequestContext, content: string) {
  const company = await json(await request.post("/api/companies", { data: { name: `Raw editor QA ${Date.now()}` } }));
  const agent = await json(await request.post(`/api/companies/${company.id}/agents`, {
    data: { name: `Raw editor agent ${Date.now()}`, role: "engineer", adapterType: "codex_local", adapterConfig: {} },
  }));
  const bundle = await json(await request.get(`/api/agents/${agent.id}/instructions-bundle?companyId=${company.id}`));
  const entry: string = bundle.entryFile;
  const current = await request.get(`/api/agents/${agent.id}/instructions-bundle/file?path=${encodeURIComponent(entry)}&companyId=${company.id}`);
  const baseHash = current.ok() ? (await current.json()).contentHash ?? null : null;
  const saved = await json(await request.put(`/api/agents/${agent.id}/instructions-bundle/file?companyId=${company.id}`, {
    data: { path: entry, content, baseHash },
  }));
  expect(saved.contentHash).toBe(sha(content));
  return { company, agent, entry };
}

async function readFile(request: APIRequestContext, ctx: Awaited<ReturnType<typeof setup>>) {
  return json(await request.get(`/api/agents/${ctx.agent.id}/instructions-bundle/file?path=${encodeURIComponent(ctx.entry)}&companyId=${ctx.company.id}`));
}

async function openRaw(page: Page, ctx: Awaited<ReturnType<typeof setup>>) {
  await page.goto(`/${ctx.company.issuePrefix}/agents/${ctx.agent.urlKey ?? ctx.agent.id}/instructions`, { waitUntil: "domcontentloaded" });
  await page.getByRole("group", { name: "Instruction file view" }).getByRole("button", { name: /^raw$/i }).click();
  await expect(page.getByTestId("instructions-raw-source")).toBeVisible();
}

function countPuts(page: Page) {
  const puts: string[] = [];
  page.on("request", (req) => {
    if (req.method() === "PUT" && req.url().includes("/instructions-bundle/file")) puts.push(req.postData() ?? "");
  });
  return puts;
}

test("a real textarea normalizes CR and CRLF, which is why raw editing refuses CR files", async ({ page }) => {
  await page.goto("/api/health");
  const value = await page.evaluate(() => {
    const area = document.createElement("textarea");
    document.body.appendChild(area);
    area.value = "a\r\nb\rc\nd";
    return area.value;
  });
  expect(value).toBe("a\nb\nc\nd");
});

test("Web Crypto is available on the loopback origin and absent in an insecure context", async ({ page, browser }) => {
  await page.goto("/api/health");
  expect(await page.evaluate(() => window.isSecureContext && typeof crypto.subtle?.digest === "function")).toBe(true);
  const insecure = await browser.newPage();
  try {
    await insecure.route("http://insecure.raw-editor.test/**", (route) => route.fulfill({ contentType: "text/html", body: "<!doctype html><title>insecure</title>" }));
    await insecure.goto("http://insecure.raw-editor.test/");
    expect(await insecure.evaluate(() => ({ secure: window.isSecureContext, subtle: typeof (crypto as Crypto).subtle }))).toEqual({ secure: false, subtle: "undefined" });
  } finally { await insecure.close(); }
});

test("ordinary raw edit preserves LF, BOM, leading newline and trailing whitespace byte for byte", async ({ page, request }) => {
  test.setTimeout(120_000);
  const ctx = await setup(request, ORIGINAL);
  const puts = countPuts(page);
  await openRaw(page, ctx);
  await page.getByRole("button", { name: "Edit raw" }).click();
  const editor = page.getByTestId("instructions-raw-editor");
  await expect(editor).toBeVisible();
  expect(await editor.evaluate((el: HTMLTextAreaElement) => el.value)).toBe(ORIGINAL);
  await expect(editor).toHaveAttribute("spellcheck", "false");
  await expect(editor).toHaveAttribute("autocorrect", "off");
  await editor.fill(PROPOSED);
  expect(await editor.evaluate((el: HTMLTextAreaElement) => el.value)).toBe(PROPOSED);
  await expect(page.getByTestId("instructions-raw-draft-hash")).toHaveText(sha(PROPOSED));
  await page.getByRole("button", { name: "Save raw edit" }).dblclick();
  await expect(page.getByTestId("instructions-raw-saved")).toContainText(sha(PROPOSED));
  expect(puts).toHaveLength(1);
  expect(JSON.parse(puts[0]!)).toEqual({ path: ctx.entry, content: PROPOSED, baseHash: sha(ORIGINAL) });
  const stored = await readFile(request, ctx);
  expect(stored.content).toBe(PROPOSED);
  expect(stored.contentHash).toBe(sha(PROPOSED));
});

test("pasted CRLF and inserted text reach the draft without CR and the hash tracks the exact draft", async ({ page, request }) => {
  test.setTimeout(120_000);
  const ctx = await setup(request, ORIGINAL);
  await openRaw(page, ctx);
  await page.getByRole("button", { name: "Edit raw" }).click();
  const editor = page.getByTestId("instructions-raw-editor");
  await editor.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(el.value.length, el.value.length));
  await editor.focus();
  await page.keyboard.insertText("pasted\r\nline\rend é");
  const value = await editor.evaluate((el: HTMLTextAreaElement) => el.value);
  expect(value.includes("\r")).toBe(false);
  expect(value.endsWith("pasted\nline\nend é")).toBe(true);
  await expect(page.getByTestId("instructions-raw-draft-hash")).toHaveText(sha(value));
  await page.getByRole("button", { name: "Discard raw edit" }).click();
  expect((await readFile(request, ctx)).content).toBe(ORIGINAL);
});

test("a stored CRLF file is refused for raw editing and never normalized", async ({ page, request }) => {
  test.setTimeout(120_000);
  const crlf = "# Raw editor e2e crlf\r\nline\r\n";
  const ctx = await setup(request, crlf);
  const puts = countPuts(page);
  await openRaw(page, ctx);
  await expect(page.getByTestId("instructions-raw-ineligible")).toContainText("carriage return");
  await expect(page.getByRole("button", { name: "Edit raw" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Verified installation" })).toBeDisabled();
  expect(puts).toHaveLength(0);
  expect((await readFile(request, ctx)).contentHash).toBe(sha(crlf));
});

test("without crypto.subtle raw editing is refused", async ({ page, request }) => {
  test.setTimeout(120_000);
  const ctx = await setup(request, ORIGINAL);
  await page.addInitScript(() => {
    Object.defineProperty(globalThis.crypto, "subtle", { configurable: true, get: () => undefined });
  });
  await openRaw(page, ctx);
  await expect(page.getByTestId("instructions-raw-ineligible")).toContainText("SHA-256 is unavailable");
  await expect(page.getByRole("button", { name: "Edit raw" })).toBeDisabled();
});

test("verified installation gates Save on an operator-entered hash and mode changes cannot bypass it", async ({ page, request }) => {
  test.setTimeout(120_000);
  const ctx = await setup(request, ORIGINAL);
  const puts = countPuts(page);
  await openRaw(page, ctx);
  await page.getByRole("button", { name: "Verified installation" }).click();
  const editor = page.getByTestId("instructions-raw-editor");
  const expected = page.getByRole("textbox", { name: "Expected SHA-256" });
  const save = page.getByRole("button", { name: "Save verified installation" });
  await expect(expected).toHaveValue("");
  await editor.fill(PROPOSED);
  await expect(save).toBeDisabled();
  await expect(page.getByTestId("instructions-raw-draft-hash")).toHaveCount(0);
  await expected.fill(sha(ORIGINAL));
  await expect(page.getByTestId("instructions-raw-expected-status")).toHaveText("Does not match the content to install.");
  await expect(save).toBeDisabled();
  await expected.fill(sha(PROPOSED));
  await expect(save).toBeEnabled();
  // An edit after matching clears the binding.
  await editor.fill(`${PROPOSED}x`);
  await expect(expected).toHaveValue("");
  await expect(save).toBeDisabled();
  // The view switch is locked; leaving needs a deliberate discard.
  await expect(page.getByRole("group", { name: "Instruction file view" }).getByRole("button", { name: /^edit$/i })).toBeDisabled();
  await page.getByRole("button", { name: "Discard raw edit" }).click();
  await page.getByRole("button", { name: "Edit raw" }).click();
  await expect(page.getByRole("textbox", { name: "Expected SHA-256" })).toHaveCount(0);
  await page.getByRole("button", { name: "Discard raw edit" }).click();
  await page.getByRole("button", { name: "Verified installation" }).click();
  await expect(expected).toHaveValue("");
  await editor.fill(PROPOSED);
  await expected.fill(sha(PROPOSED));
  await expect(save).toBeEnabled();
  await save.dblclick();
  await expect(page.getByTestId("instructions-raw-saved")).toContainText("Verified installation saved");
  expect(puts).toHaveLength(1);
  const stored = await readFile(request, ctx);
  expect(stored.content).toBe(PROPOSED);
  expect(stored.contentHash).toBe(sha(PROPOSED));
});

test("a stale base is rejected with 409 and the draft is kept without retry", async ({ page, request }) => {
  test.setTimeout(120_000);
  const ctx = await setup(request, ORIGINAL);
  const puts = countPuts(page);
  await openRaw(page, ctx);
  await page.getByRole("button", { name: "Edit raw" }).click();
  await page.getByTestId("instructions-raw-editor").fill(PROPOSED);
  // Another writer changes the file after raw editing started.
  const other = "# Raw editor e2e other writer\n";
  await json(await request.put(`/api/agents/${ctx.agent.id}/instructions-bundle/file?companyId=${ctx.company.id}`, {
    data: { path: ctx.entry, content: other, baseHash: sha(ORIGINAL) },
  }));
  await page.getByRole("button", { name: "Save raw edit" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "nothing was written" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Save raw edit" })).toBeDisabled();
  expect(await page.getByTestId("instructions-raw-editor").evaluate((el: HTMLTextAreaElement) => el.value)).toBe(PROPOSED);
  expect(puts).toHaveLength(1);
  expect((await readFile(request, ctx)).content).toBe(other);
});
