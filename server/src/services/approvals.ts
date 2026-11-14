import { randomUUID } from "node:crypto";
import { agentAppearanceSchema } from "@paperclipai/shared";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, approvalComments, approvals } from "@paperclipai/db";
import { HttpError, conflict, forbidden, notFound, unprocessable } from "../errors.js";
import { redactCurrentUserText } from "../log-redaction.js";
import { agentService } from "./agents.js";
import { budgetService } from "./budgets.js";
import { notifyHireApproved } from "./hire-hook.js";
import {
  authorizeHireActivation,
  authorizeHireApprovalCreate,
  changesLinkedInstructions,
  recordHireInstructionAmendment,
  type HireApprovalActor,
} from "./hire-approval-authorization.js";
import { instanceSettingsService } from "./instance-settings.js";

export const APPROVAL_REVIEW_VERSION_REQUIRED = "approval_review_version_required";

/**
 * PG-4: the version written by a change to an open approval. It is strictly
 * later than the stored version at millisecond precision (the precision a
 * client reads it at), so a reviewed version never names a later payload,
 * even when two writes fall in the same millisecond.
 */
function nextApprovalVersion() {
  return sql`greatest(now(), date_trunc('milliseconds', ${approvals.updatedAt}) + interval '1 millisecond')`;
}

export function approvalService(db: Db) {
  const agentsSvc = agentService(db);
  const budgets = budgetService(db);
  const instanceSettings = instanceSettingsService(db);
  const canResolveStatuses = new Set(["pending", "revision_requested"]);
  const resolvableStatuses = Array.from(canResolveStatuses);
  type ApprovalRecord = typeof approvals.$inferSelect;
  type ResolutionResult = { approval: ApprovalRecord; applied: boolean };

  function redactApprovalComment<T extends { body: string }>(comment: T, censorUsernameInLogs: boolean): T {
    return {
      ...comment,
      body: redactCurrentUserText(comment.body, { enabled: censorUsernameInLogs }),
    };
  }

  async function reconcileApprovedBuiltInAgent(companyId: string, payload: Record<string, unknown>) {
    const sourceBuiltInAgentKey = typeof payload.sourceBuiltInAgentKey === "string" ? payload.sourceBuiltInAgentKey : null;
    if (!sourceBuiltInAgentKey) return;
    const { builtInAgentService } = await import("./built-in-agents.js");
    await builtInAgentService(db).ensure(companyId, sourceBuiltInAgentKey);
  }

  async function getExistingApproval(id: string, conn: Db = db) {
    const existing = await conn
      .select()
      .from(approvals)
      .where(eq(approvals.id, id))
      .then((rows) => rows[0] ?? null);
    if (!existing) throw notFound("Approval not found");
    return existing;
  }

  async function resolveApproval(
    id: string,
    targetStatus: "approved" | "rejected",
    decidedByUserId: string,
    decisionNote: string | null | undefined,
    conn: Db = db,
  ): Promise<ResolutionResult> {
    const existing = await getExistingApproval(id, conn);
    if (!canResolveStatuses.has(existing.status)) {
      if (existing.status === targetStatus) {
        return { approval: existing, applied: false };
      }
      throw unprocessable(
        `Only pending or revision requested approvals can be ${targetStatus === "approved" ? "approved" : "rejected"}`,
      );
    }

    const now = new Date();
    const updated = await conn
      .update(approvals)
      .set({
        status: targetStatus,
        decidedByUserId,
        decisionNote: decisionNote ?? null,
        decidedAt: now,
        updatedAt: now,
      })
      .where(and(eq(approvals.id, id), inArray(approvals.status, resolvableStatuses)))
      .returning()
      .then((rows) => rows[0] ?? null);

    if (updated) {
      return { approval: updated, applied: true };
    }

    const latest = await getExistingApproval(id, conn);
    if (latest.status === targetStatus) {
      return { approval: latest, applied: false };
    }

    throw unprocessable(
      `Only pending or revision requested approvals can be ${targetStatus === "approved" ? "approved" : "rejected"}`,
    );
  }

  return {
    list: (companyId: string, status?: string) => {
      const conditions = [eq(approvals.companyId, companyId)];
      if (status) conditions.push(eq(approvals.status, status));
      return db.select().from(approvals).where(and(...conditions));
    },

    getById: (id: string) =>
      db
        .select()
        .from(approvals)
        .where(eq(approvals.id, id))
        .then((rows) => rows[0] ?? null),

    findOpenHireApprovalForAgent: async (companyId: string, agentId: string) => {
      const rows = await db
        .select()
        .from(approvals)
        .where(
          and(
            eq(approvals.companyId, companyId),
            eq(approvals.type, "hire_agent"),
            inArray(approvals.status, resolvableStatuses),
            sql`${approvals.payload} ->> 'agentId' = ${agentId}`,
          ),
        );
      return rows[0] ?? null;
    },

    create: (companyId: string, data: Omit<typeof approvals.$inferInsert, "companyId">) =>
      db
        .insert(approvals)
        .values({ ...data, companyId })
        .returning()
        .then((rows) => rows[0]),

    // Cancel an open (pending/revision_requested) approval without a board
    // decision — e.g. when its paired agent is terminated during duplicate
    // cleanup. Idempotent: a no-op on already-resolved approvals.
    cancel: async (id: string, reason?: string | null) => {
      const now = new Date();
      const updated = await db
        .update(approvals)
        .set({
          status: "cancelled",
          decisionNote: reason ?? null,
          decidedAt: now,
          updatedAt: now,
        })
        .where(and(eq(approvals.id, id), inArray(approvals.status, resolvableStatuses)))
        .returning()
        .then((rows) => rows[0] ?? null);
      return updated;
    },

    approve: async (
      id: string,
      decidedByUserId: string,
      decisionNote?: string | null,
      options?: {
        /**
         * PG-4: the board actor deciding. Required for a `hire_agent`
         * approval; it is re-authorized inside the approval transaction.
         */
        decider?: HireApprovalActor;
        /**
         * The approval version the reviewer decided on. When set, the decision
         * is refused with 409 if the approval changed since. PG-4: required
         * for an open `hire_agent` approval (428 without it), so a payload
         * that changed after review cannot be approved as the reviewed one.
         * Every write that can change an open approval's payload advances
         * `updatedAt` by at least one millisecond (see `nextApprovalVersion`).
         */
        expectedUpdatedAt?: Date;
      },
    ) => {
      // WS-2 PR-W1: the decision and a hire's activation or creation commit or
      // roll back together. A refused activation (for example a 409 on the
      // instructions root) leaves the approval pending or revision requested,
      // so it can be corrected and approved again. The effects after the
      // decision (built-in reconciliation, budget policy, the hire hook) run
      // only after the commit, in the same order as before.
      const now = new Date();
      const { updated, applied, hireApprovedAgentId } = await db.transaction(async (tx) => {
        const txDb = tx as unknown as Db;
        // PG-4: lock the approval row first, so a resubmit, a revision request
        // or a second approval of the same row waits for this decision, and
        // this decision reads, authorizes and applies one payload version.
        const [locked] = await tx.select().from(approvals).where(eq(approvals.id, id)).for("update");
        if (!locked) throw notFound("Approval not found");
        if (options?.expectedUpdatedAt && canResolveStatuses.has(locked.status)
          && locked.updatedAt.getTime() !== options.expectedUpdatedAt.getTime()) {
          throw conflict("The approval changed after it was reviewed. Nothing was changed. Reload and review it again.", {
            code: "approval_changed_since_review",
          });
        }
        const isOpenHire = locked.type === "hire_agent" && canResolveStatuses.has(locked.status);
        if (isOpenHire && options?.decider?.type !== "board") {
          throw forbidden("A hire approval can only be decided by an authorized board user");
        }
        if (isOpenHire && !options?.expectedUpdatedAt) {
          throw new HttpError(428, "Approving a hire needs the approval version that was reviewed. Nothing was changed. Reload the approval, review it and approve again.", {
            code: APPROVAL_REVIEW_VERSION_REQUIRED,
            approvalId: locked.id,
          });
        }
        const resolution = await resolveApproval(id, "approved", decidedByUserId, decisionNote, txDb);
        let hiredAgentId: string | null = null;
        if (resolution.applied && resolution.approval.type === "hire_agent") {
          const updated = resolution.approval;
          const decider = options!.decider!;
          const payload = updated.payload as Record<string, unknown>;
          const payloadAgentId = typeof payload.agentId === "string" ? payload.agentId : null;
          const txAgents = agentService(txDb);
          if (payloadAgentId) {
            // Decision and activation commit together; the guard runs under
            // the activation's agent row lock, on the exact payload approved.
            const activation = await txAgents.activatePendingApproval(payloadAgentId, payload, {
              authorize: (activationDb, agent) => authorizeHireActivation(activationDb, decider, {
                companyId: updated.companyId,
                agent,
                payload,
                requestedByAgentId: updated.requestedByAgentId ?? null,
                approvalId: updated.id,
              }),
            });
            if (!activation?.activated) {
              throw conflict("The hire approval's agent is no longer pending approval. Nothing was changed.");
            }
            hiredAgentId = payloadAgentId;
          } else {
            const newAgentId = randomUUID();
            await authorizeHireApprovalCreate(txDb, decider, {
              companyId: updated.companyId,
              payload,
              requestedByAgentId: updated.requestedByAgentId ?? null,
              newAgentId,
            });
            const created = await txAgents.create(updated.companyId, {
              id: newAgentId,
              name: String(payload.name ?? "New Agent"),
              appearance: payload.appearance == null ? undefined : agentAppearanceSchema.parse(payload.appearance),
              role: String(payload.role ?? "general"),
              title: typeof payload.title === "string" ? payload.title : null,
              reportsTo: typeof payload.reportsTo === "string" ? payload.reportsTo : null,
              capabilities: typeof payload.capabilities === "string" ? payload.capabilities : null,
              adapterType: String(payload.adapterType ?? "process"),
              adapterConfig:
                typeof payload.adapterConfig === "object" && payload.adapterConfig !== null
                  ? (payload.adapterConfig as Record<string, unknown>)
                  : {},
              budgetMonthlyCents:
                typeof payload.budgetMonthlyCents === "number" ? payload.budgetMonthlyCents : 0,
              metadata:
                typeof payload.metadata === "object" && payload.metadata !== null
                  ? (payload.metadata as Record<string, unknown>)
                  : null,
              status: "idle",
              spentMonthlyCents: 0,
              permissions: undefined,
              lastHeartbeatAt: null,
            });
            hiredAgentId = created?.id ?? null;
          }
        }
        return { updated: resolution.approval, applied: resolution.applied, hireApprovedAgentId: hiredAgentId };
      });

      if (applied && updated.type === "hire_agent") {
        const payload = updated.payload as Record<string, unknown>;
        if (typeof payload.agentId === "string") {
          await reconcileApprovedBuiltInAgent(updated.companyId, payload);
        }
        if (hireApprovedAgentId) {
          const budgetMonthlyCents =
            typeof payload.budgetMonthlyCents === "number" ? payload.budgetMonthlyCents : 0;
          if (budgetMonthlyCents > 0) {
            await budgets.upsertPolicy(
              updated.companyId,
              {
                scopeType: "agent",
                scopeId: hireApprovedAgentId,
                amount: budgetMonthlyCents,
                windowKind: "calendar_month_utc",
              },
              decidedByUserId,
            );
          }
          void notifyHireApproved(db, {
            companyId: updated.companyId,
            agentId: hireApprovedAgentId,
            source: "approval",
            sourceId: id,
            approvedAt: now,
          }).catch(() => {});
        }
      }

      return { approval: updated, applied };
    },

    reject: async (id: string, decidedByUserId: string, decisionNote?: string | null) => {
      const { approval: updated, applied } = await resolveApproval(
        id,
        "rejected",
        decidedByUserId,
        decisionNote,
      );

      if (applied && updated.type === "hire_agent") {
        const payload = updated.payload as Record<string, unknown>;
        const payloadAgentId = typeof payload.agentId === "string" ? payload.agentId : null;
        if (payloadAgentId) {
          await agentsSvc.terminate(payloadAgentId);
        }
      }

      return { approval: updated, applied };
    },

    requestRevision: async (id: string, decidedByUserId: string, decisionNote?: string | null) => {
      const existing = await getExistingApproval(id);
      if (existing.status !== "pending") {
        throw unprocessable("Only pending approvals can request revision");
      }

      // PG-4: conditional on the status, so a revision request that loses a
      // race with a decision cannot reopen the decided approval.
      const now = new Date();
      const updated = await db
        .update(approvals)
        .set({
          status: "revision_requested",
          decidedByUserId,
          decisionNote: decisionNote ?? null,
          decidedAt: now,
          updatedAt: nextApprovalVersion(),
        })
        .where(and(eq(approvals.id, id), eq(approvals.status, "pending")))
        .returning()
        .then((rows) => rows[0] ?? null);
      if (!updated) throw unprocessable("Only pending approvals can request revision");
      return updated;
    },

    /**
     * PG-4: `expected` is the approval version the caller read and authorized.
     * The update applies only while the row is still revision requested at
     * that version, so a resubmit cannot replace a payload that changed since,
     * or reopen an approval that was decided in between. Without a payload the
     * expected version's payload is kept.
     */
    resubmit: async (
      id: string,
      payload?: Record<string, unknown>,
      expected?: { updatedAt: Date; payload: Record<string, unknown> },
      options?: {
        /**
         * PG-4: an authorized board user's explicit amendment of a linked
         * hire's instruction configuration. When the stored payload changes
         * the agent's instruction keys, the amendment is recorded in the same
         * transaction, bound to the exact payload.
         */
        instructionAmendment?: { actorUserId: string };
      },
    ) => {
      const existing = await getExistingApproval(id);
      if (existing.status !== "revision_requested") {
        throw unprocessable("Only revision requested approvals can be resubmitted");
      }
      const version = expected ?? { updatedAt: existing.updatedAt, payload: existing.payload as Record<string, unknown> };

      return db.transaction(async (tx) => {
        const txDb = tx as unknown as Db;
        const updated = await tx
          .update(approvals)
          .set({
            status: "pending",
            payload: payload ?? version.payload,
            decisionNote: null,
            decidedByUserId: null,
            decidedAt: null,
            updatedAt: nextApprovalVersion(),
          })
          .where(and(
            eq(approvals.id, id),
            eq(approvals.status, "revision_requested"),
            // Millisecond precision: the version was read into a JS Date.
            sql`date_trunc('milliseconds', ${approvals.updatedAt}) = ${version.updatedAt.toISOString()}::timestamptz`,
          ))
          .returning()
          .then((rows) => rows[0] ?? null);
        if (!updated) {
          throw conflict("The approval changed while it was being resubmitted. Nothing was changed. Reload and retry.");
        }
        const stored = updated.payload as Record<string, unknown>;
        const linkedAgentId = typeof stored.agentId === "string" ? stored.agentId : null;
        if (options?.instructionAmendment && updated.type === "hire_agent" && linkedAgentId) {
          const [agent] = await tx.select({ id: agents.id, companyId: agents.companyId, adapterConfig: agents.adapterConfig })
            .from(agents).where(eq(agents.id, linkedAgentId));
          if (agent && agent.companyId === updated.companyId && changesLinkedInstructions(stored, agent.adapterConfig)) {
            await recordHireInstructionAmendment(txDb, {
              companyId: updated.companyId,
              approvalId: updated.id,
              actorUserId: options.instructionAmendment.actorUserId,
              agentId: agent.id,
              payload: stored,
              agentAdapterConfig: agent.adapterConfig,
            });
          }
        }
        return updated;
      });
    },

    listComments: async (approvalId: string) => {
      const existing = await getExistingApproval(approvalId);
      const { censorUsernameInLogs } = await instanceSettings.getGeneral();
      return db
        .select()
        .from(approvalComments)
        .where(
          and(
            eq(approvalComments.approvalId, approvalId),
            eq(approvalComments.companyId, existing.companyId),
          ),
        )
        .orderBy(asc(approvalComments.createdAt))
        .then((comments) => comments.map((comment) => redactApprovalComment(comment, censorUsernameInLogs)));
    },

    addComment: async (
      approvalId: string,
      body: string,
      actor: { agentId?: string; userId?: string },
    ) => {
      const existing = await getExistingApproval(approvalId);
      const currentUserRedactionOptions = {
        enabled: (await instanceSettings.getGeneral()).censorUsernameInLogs,
      };
      const redactedBody = redactCurrentUserText(body, currentUserRedactionOptions);
      return db
        .insert(approvalComments)
        .values({
          companyId: existing.companyId,
          approvalId,
          authorAgentId: actor.agentId ?? null,
          authorUserId: actor.userId ?? null,
          body: redactedBody,
        })
        .returning()
        .then((rows) => redactApprovalComment(rows[0], currentUserRedactionOptions.enabled));
    },
  };
}
