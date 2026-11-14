import { afterEach, expect, it, vi } from "vitest";
import { approvalsApi } from "./approvals";

afterEach(() => vi.unstubAllGlobals());

// PG-4: the approve request carries the approval version the reviewer saw, so
// the server can refuse a payload that changed after review.
it("sends the reviewed approval version with an approval decision", async () => {
  const fetchMock = vi.fn().mockImplementation(async () => Response.json({ id: "approval-1" }));
  vi.stubGlobal("fetch", fetchMock);

  await approvalsApi.approve({ id: "approval-1", updatedAt: "2026-11-13T23:59:58.123Z" }, "looks right");
  await approvalsApi.approve({ id: "approval-2", updatedAt: new Date("2026-11-14T00:00:01.456Z") });

  expect(fetchMock).toHaveBeenCalledTimes(2);
  const [firstUrl, firstInit] = fetchMock.mock.calls[0]!;
  expect(firstUrl).toBe("/api/approvals/approval-1/approve");
  expect(firstInit.method).toBe("POST");
  expect(JSON.parse(firstInit.body as string)).toEqual({
    decisionNote: "looks right",
    expectedUpdatedAt: "2026-11-13T23:59:58.123Z",
  });
  const [secondUrl, secondInit] = fetchMock.mock.calls[1]!;
  expect(secondUrl).toBe("/api/approvals/approval-2/approve");
  expect(JSON.parse(secondInit.body as string)).toEqual({ expectedUpdatedAt: "2026-11-14T00:00:01.456Z" });
});

// PG-4: the agent page sends no approval version; when the server asks for a
// reviewed version it opens the approval's review page instead of failing.
it("turns the server's review-required refusal into the approval review page", async () => {
  const { ApiError } = await import("./client");
  const { approvalReviewPath } = await import("../lib/approval-review");
  const refusal = new ApiError("review it", 428, {
    error: "review it",
    details: { code: "approval_review_version_required", approvalId: "approval-9" },
  });
  expect(approvalReviewPath(refusal)).toBe("/approvals/approval-9");
  expect(approvalReviewPath(new ApiError("other", 428, { details: { code: "something_else", approvalId: "a" } }))).toBeNull();
  expect(approvalReviewPath(new ApiError("stale", 409, { details: { code: "approval_review_version_required", approvalId: "a" } }))).toBeNull();
  expect(approvalReviewPath(new Error("network"))).toBeNull();
});
