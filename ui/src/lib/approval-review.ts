import { ApiError } from "../api/client";

/** PG-4: the server code for an approve that names no reviewed approval version. */
export const APPROVAL_REVIEW_VERSION_REQUIRED = "approval_review_version_required";

/**
 * PG-4: approving a pending agent that has an open hire approval needs the
 * version of that approval a reviewer saw. The agent page shows the agent, not
 * the approval, so when the server asks for a review this returns the approval
 * page to open instead. Nothing was decided. Returns null for any other error.
 */
export function approvalReviewPath(error: unknown): string | null {
  if (!(error instanceof ApiError) || error.status !== 428) return null;
  const body = error.body as { details?: { code?: unknown; approvalId?: unknown } } | null;
  const details = body?.details;
  if (details?.code !== APPROVAL_REVIEW_VERSION_REQUIRED || typeof details.approvalId !== "string") return null;
  return `/approvals/${encodeURIComponent(details.approvalId)}`;
}
