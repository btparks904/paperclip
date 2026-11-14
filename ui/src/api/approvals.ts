import type { Approval, ApprovalComment, Issue } from "@paperclipai/shared";
import { api } from "./client";

/**
 * PG-4: the approval version a reviewer decided on: the `updatedAt` of the
 * approval as it was shown. The server refuses the decision if the approval
 * changed since, and requires it to approve a hire.
 */
export type ApprovalReviewVersion = { id: string; updatedAt: Date | string };

export const approvalsApi = {
  list: (companyId: string, status?: string) =>
    api.get<Approval[]>(
      `/companies/${companyId}/approvals${status ? `?status=${encodeURIComponent(status)}` : ""}`,
    ),
  create: (companyId: string, data: Record<string, unknown>) =>
    api.post<Approval>(`/companies/${companyId}/approvals`, data),
  get: (id: string) => api.get<Approval>(`/approvals/${id}`),
  approve: (reviewed: ApprovalReviewVersion, decisionNote?: string) =>
    api.post<Approval>(`/approvals/${reviewed.id}/approve`, {
      decisionNote,
      expectedUpdatedAt: new Date(reviewed.updatedAt).toISOString(),
    }),
  reject: (id: string, decisionNote?: string) =>
    api.post<Approval>(`/approvals/${id}/reject`, { decisionNote }),
  requestRevision: (id: string, decisionNote?: string) =>
    api.post<Approval>(`/approvals/${id}/request-revision`, { decisionNote }),
  resubmit: (id: string, payload?: Record<string, unknown>) =>
    api.post<Approval>(`/approvals/${id}/resubmit`, { payload }),
  listComments: (id: string) => api.get<ApprovalComment[]>(`/approvals/${id}/comments`),
  addComment: (id: string, body: string) =>
    api.post<ApprovalComment>(`/approvals/${id}/comments`, { body }),
  listIssues: (id: string) => api.get<Issue[]>(`/approvals/${id}/issues`),
};
