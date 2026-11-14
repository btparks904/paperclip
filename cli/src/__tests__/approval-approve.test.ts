import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerApprovalCommands } from "../commands/client/approval.js";

const APPROVAL_ID = "44444444-4444-4444-8444-444444444444";

function createProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerApprovalCommands(program);
  return program;
}

async function run(args: string[]): Promise<void> {
  await createProgram().parseAsync([
    ...args,
    "--api-base", "http://localhost:3100",
    "--api-key", "board-token",
  ], { from: "user" });
}

// PG-4: an open hire is approved with the approval version the operator
// reviewed (`approval get` shows its updatedAt).
describe("approval approve", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    delete process.env.PAPERCLIP_API_KEY;
    delete process.env.PAPERCLIP_API_URL;
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("sends the reviewed version given with --expected-updated-at", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ id: APPROVAL_ID }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await run(["approval", "approve", APPROVAL_ID, "--expected-updated-at", "2026-11-13T23:59:58.123Z", "--decision-note", "reviewed"]);
    await run(["approval", "approve", APPROVAL_ID]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]![0]).toBe(`http://localhost:3100/api/approvals/${APPROVAL_ID}/approve`);
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body as string)).toEqual({
      decisionNote: "reviewed",
      expectedUpdatedAt: "2026-11-13T23:59:58.123Z",
    });
    // Without the flag no version is invented: the server decides whether one is required.
    expect(JSON.parse(fetchMock.mock.calls[1]![1].body as string)).toEqual({});
  });
});
