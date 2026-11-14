import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { activityLog, agents, type Db } from "@paperclipai/db";
import { conflict, forbidden, unprocessable } from "../errors.js";
import { collectAgentAdapterWorkspaceCommandPaths } from "../routes/workspace-command-authz.js";
import { AGENT_INSTRUCTION_CONFIG_KEYS, pickInstructionConfig } from "./agent-instruction-keys.js";
import { agentInstructionsBundleMode } from "./agent-instructions.js";
import { providerTraceSettingChanges } from "./provider-trace-setting.js";
import {
  authorizationDeniedDetails,
  authorizationService,
  type AuthorizationActor,
} from "./authorization.js";

/**
 * PG-4: the shared guard for `hire_agent` approvals.
 *
 * One set of rules runs when a hire approval is requested (create or
 * resubmit) and again, inside the approval transaction, when it is decided
 * and the hire is activated or created:
 *
 * - The actor needs current `agents:create` in the approval's company, the
 *   same permission and agent company check as the hire route.
 * - A decision needs a board actor. Self-approval by an authorized user is
 *   allowed; no identity is special.
 * - A payload linked to an agent (`payload.agentId`) must name a pending agent
 *   of the same company. Its instruction keys must equal the agent's current
 *   committed instruction configuration, unless the exact payload is a board
 *   amendment (below). Anything else is refused as stale: never applied over
 *   the current root or generation, and never silently stripped.
 * - A board amendment is an explicit resubmit (`instructionAmendment: true`)
 *   by an authorized board user that changes a linked hire's instruction
 *   keys. The resubmit's transaction records it as an activity row by that
 *   user, bound to the exact stored payload and to the agent's instruction
 *   configuration at that moment. At decision the row must match both the
 *   approval's payload and the agent's current configuration, so a later
 *   payload change or a later root or generation change makes it stale. The
 *   decider's current authority is checked again as for any hire.
 * - An agent actor (at request) or an agent-requested approval (at decision)
 *   cannot introduce or change instruction keys or host-executed workspace
 *   commands. A linked payload that repeats the agent's current values is the
 *   server-generated snapshot and passes.
 * - An effective external instruction root, classified by the instructions
 *   service's own helper on the effective configuration (legacy fields and
 *   defaults included), needs instance-admin authorization.
 *
 * Authorization linearization:
 * - Request time (create, resubmit): the checks read committed state before
 *   the approval row is written. They are request-time checks only and give
 *   no protection at decision or commit time; the decision re-checks.
 * - Decision time: the approval row is locked FOR UPDATE first. For a linked
 *   hire the checks then run inside the activation, after the agent row is
 *   locked FOR NO KEY UPDATE and found pending; for a new agent they run
 *   before the create. Both are in the approval's transaction, so the decision
 *   and the activation or creation commit or roll back together.
 * - Membership, grants, the legacy agent permission and the instance-admin
 *   role are read by statements of that transaction at READ COMMITTED. A
 *   revocation committed before the checking statement is honored. A
 *   revocation that commits after it, before the approval commits, is not:
 *   those rows are read, not locked.
 * - The request-time `isInstanceAdmin` flag is cleared for the decision
 *   re-check, so the database role decides. Exceptions: local_implicit (always
 *   the instance admin) and cloud_tenant, whose attested flag has no database
 *   record by design and is trusted as of the request.
 */

export type HireApprovalActor = AuthorizationActor;

type JsonRecord = Record<string, unknown>;

const WORKSPACE_STRATEGY_COMMAND_KEYS = ["provisionCommand", "runtimeProvisionCommand", "teardownCommand"] as const;

export const HIRE_APPROVAL_STALE_INSTRUCTIONS =
  "The hire approval's instruction configuration differs from the agent's current configuration and is not a current board amendment. Nothing was changed. Resubmit the approval with the current configuration, or as an explicit instruction amendment.";

/** The activity action that records a board amendment of a linked hire's instruction configuration. */
export const HIRE_INSTRUCTION_AMENDMENT_ACTION = "approval.hire_instruction_amended";

/** Turning raw provider tracing on or off through a hire approval needs instance-admin access. */
export const HIRE_APPROVAL_PROVIDER_TRACE_ADMIN_REQUIRED = "hire_approval_provider_trace_admin_required";

/** JSON with object keys sorted, so a payload read back from jsonb hashes the same as the one written. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as JsonRecord;
    return `{${Object.keys(record).sort().filter((key) => record[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

function sha256(value: unknown) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function instructionFingerprint(adapterConfig: unknown) {
  return sha256(pickInstructionConfig(isRecord(adapterConfig) ? adapterConfig : {}));
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonEqual(left: unknown, right: unknown) {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

/** The instruction keys a payload configuration sets (present and defined). */
function presentInstructionPaths(config: JsonRecord): string[] {
  return AGENT_INSTRUCTION_CONFIG_KEYS.filter((key) => config[key] !== undefined).map((key) => `adapterConfig.${key}`);
}

/** The instruction keys whose payload value differs from the current committed value. */
function changedInstructionPaths(payloadConfig: JsonRecord, currentConfig: JsonRecord): string[] {
  return AGENT_INSTRUCTION_CONFIG_KEYS
    .filter((key) => !jsonEqual(payloadConfig[key], currentConfig[key]))
    .map((key) => `adapterConfig.${key}`);
}

/** The host-executed workspace command fields whose payload value differs from the current value. */
function changedWorkspaceCommandPaths(payloadConfig: JsonRecord, currentConfig: JsonRecord): string[] {
  const next = isRecord(payloadConfig.workspaceStrategy) ? payloadConfig.workspaceStrategy : {};
  const current = isRecord(currentConfig.workspaceStrategy) ? currentConfig.workspaceStrategy : {};
  return WORKSPACE_STRATEGY_COMMAND_KEYS
    .filter((key) => Object.prototype.hasOwnProperty.call(next, key) && !jsonEqual(next[key], current[key]))
    .map((key) => `adapterConfig.workspaceStrategy.${key}`);
}

/**
 * The actor for an in-transaction re-check. Instance-admin status is read from
 * the database (the request flag is cleared), except for local_implicit, which
 * is always the instance admin, and cloud_tenant, whose attested flag has no
 * database record.
 */
export function hireApprovalRecheckActor(actor: HireApprovalActor): HireApprovalActor {
  if (actor.type === "board" && actor.source !== "local_implicit" && actor.source !== "cloud_tenant") {
    return { ...actor, isInstanceAdmin: false };
  }
  return { ...actor };
}

async function assertCanCreateAgents(conn: Db, actor: HireApprovalActor, companyId: string) {
  const decision = await authorizationService(conn).decide({
    actor,
    action: "agents:create",
    resource: { type: "company", companyId },
  });
  if (!decision.allowed) {
    throw forbidden(decision.explanation, authorizationDeniedDetails(decision));
  }
  if (actor.type !== "agent") return;
  const actorAgent = actor.agentId
    ? await conn.select({ companyId: agents.companyId }).from(agents).where(eq(agents.id, actor.agentId)).then((rows) => rows[0] ?? null)
    : null;
  if (!actorAgent || actorAgent.companyId !== companyId) {
    throw forbidden("Agent key cannot access another company");
  }
}

/** Instance-admin authorization with the existing local_implicit equivalence. */
async function isInstanceAdmin(conn: Db, actor: HireApprovalActor): Promise<boolean> {
  if (actor.type !== "board" || actor.ignoreInstanceAdmin) return false;
  if (actor.source === "local_implicit") return true;
  if (actor.isInstanceAdmin === true) return true;
  if (actor.source === "cloud_tenant") return false;
  return authorizationService(conn).isInstanceAdmin(actor.userId ?? null);
}

type LinkedAgentRow = Pick<typeof agents.$inferSelect, "id" | "companyId" | "name" | "status" | "adapterConfig" | "runtimeConfig" | "instructionBundleId">;

/** Request time only: the decision paths receive the agent row locked by the activation. */
async function loadLinkedAgent(conn: Db, agentId: string): Promise<LinkedAgentRow | null> {
  return conn
    .select({
      id: agents.id,
      companyId: agents.companyId,
      name: agents.name,
      status: agents.status,
      adapterConfig: agents.adapterConfig,
      runtimeConfig: agents.runtimeConfig,
      instructionBundleId: agents.instructionBundleId,
    })
    .from(agents)
    .where(eq(agents.id, agentId))
    .then((rows) => rows[0] ?? null);
}

interface PayloadRuleInput {
  conn: Db;
  actor: HireApprovalActor;
  companyId: string;
  /** The approval payload's adapterConfig, when it is a plain object. */
  payloadConfig: JsonRecord | undefined;
  /**
   * The approval payload's runtimeConfig, when it is a plain object. A linked
   * activation replaces the agent's runtimeConfig with it.
   */
  payloadRuntimeConfig: JsonRecord | undefined;
  /** The linked agent, or null for a request that creates a new agent. */
  linked: LinkedAgentRow | null;
  /** The identity the new agent will have; only for an unlinked payload. */
  newAgentIdentity?: { id: string; name: string };
  /** True when agent-authorship restrictions apply (agent actor, or agent-requested approval). */
  agentAuthored: boolean;
  /**
   * Whether a linked payload may change the agent's instruction keys: at
   * request, an explicit board amendment; at decision, a matching amendment
   * record for the exact payload and the current configuration.
   */
  instructionChangeAllowed: boolean;
  phase: "request" | "decision";
}

async function applyPayloadRules(input: PayloadRuleInput) {
  const { linked, payloadConfig } = input;
  if (linked) {
    if (linked.companyId !== input.companyId) {
      if (input.phase === "decision") throw conflict("The hire approval's agent is not in the approval's company. Nothing was changed.");
      throw unprocessable("The hire approval's agent must be in this company");
    }
    if (linked.status !== "pending_approval") {
      if (input.phase === "decision") throw conflict("The hire approval's agent is no longer pending approval. Nothing was changed.");
      throw unprocessable("The hire approval's agent must be pending approval");
    }
  }

  // Raw provider tracing (`runtimeConfig.debug.providerTrace`): the agent
  // routes' rule, on the effective before and after. A linked payload is
  // checked against the linked agent's current runtimeConfig (at decision, the
  // row locked by the activation). An unlinked request is checked like the
  // hire route, against no previous value; an unlinked decision creates the
  // agent without the payload's runtimeConfig, so it changes nothing here.
  if (linked || input.phase === "request") {
    const previousRuntime = linked ? linked.runtimeConfig : undefined;
    const nextRuntime = input.payloadRuntimeConfig ?? previousRuntime;
    if (providerTraceSettingChanges(nextRuntime, previousRuntime)
      && !(await isInstanceAdmin(input.conn, input.actor))) {
      throw forbidden("Instance admin access required", { code: HIRE_APPROVAL_PROVIDER_TRACE_ADMIN_REQUIRED });
    }
  }

  const currentConfig = linked && isRecord(linked.adapterConfig) ? linked.adapterConfig : {};
  if (payloadConfig) {
    if (linked && !input.instructionChangeAllowed) {
      const changedInstructions = changedInstructionPaths(payloadConfig, currentConfig);
      if (changedInstructions.length > 0) {
        throw conflict(HIRE_APPROVAL_STALE_INSTRUCTIONS, {
          code: "hire_approval_instruction_config_stale",
          fields: changedInstructions,
        });
      }
    }
    if (input.agentAuthored) {
      const protectedPaths = linked
        ? changedWorkspaceCommandPaths(payloadConfig, currentConfig)
        : [...presentInstructionPaths(payloadConfig), ...collectAgentAdapterWorkspaceCommandPaths(payloadConfig)];
      if (protectedPaths.length > 0) {
        const message = `Agent-authored hire requests cannot set instructions or host-executed workspace commands (${protectedPaths.join(", ")})`;
        if (input.phase === "decision") {
          throw conflict(`${message}. Nothing was changed. A fresh authorized resubmission is required.`, {
            code: "hire_approval_agent_authored_protected_config",
            fields: protectedPaths,
          });
        }
        throw forbidden(message);
      }
    }
  }

  const effectiveConfig = payloadConfig ?? currentConfig;
  const subject = linked
    ? { id: linked.id, companyId: linked.companyId, name: linked.name, instructionBundleId: linked.instructionBundleId ?? null }
    : {
        id: input.newAgentIdentity?.id ?? randomUUID(),
        companyId: input.companyId,
        name: input.newAgentIdentity?.name ?? "New Agent",
        instructionBundleId: null,
      };
  if (agentInstructionsBundleMode({ ...subject, adapterConfig: effectiveConfig }) === "external"
    && !(await isInstanceAdmin(input.conn, input.actor))) {
    throw forbidden("Instance admin access required");
  }
}

function linkedAgentId(payload: JsonRecord): string | null {
  return typeof payload.agentId === "string" ? payload.agentId : null;
}

/**
 * Request time: approval create and resubmit of a `hire_agent` approval. Runs
 * before the payload's secrets are normalized and persisted.
 */
export async function authorizeHireApprovalRequest(
  db: Db,
  actor: HireApprovalActor,
  input: { companyId: string; payload: JsonRecord; requestedByAgentId?: string | null; instructionAmendment?: boolean },
) {
  await assertCanCreateAgents(db, actor, input.companyId);
  if (input.instructionAmendment && actor.type !== "board") {
    throw forbidden("Only a board user can amend a hire's instruction configuration");
  }
  if (input.requestedByAgentId) {
    if (actor.type === "agent" && input.requestedByAgentId !== actor.agentId) {
      throw forbidden("An agent can only request a hire approval as itself");
    }
    const requester = await db.select({ companyId: agents.companyId }).from(agents)
      .where(eq(agents.id, input.requestedByAgentId)).then((rows) => rows[0] ?? null);
    if (!requester || requester.companyId !== input.companyId) {
      throw unprocessable("The requesting agent must be in this company");
    }
  }
  const agentId = linkedAgentId(input.payload);
  const linked = agentId ? await loadLinkedAgent(db, agentId) : null;
  if (agentId && !linked) throw unprocessable("The hire approval's agent must be in this company");
  await applyPayloadRules({
    conn: db,
    actor,
    companyId: input.companyId,
    payloadConfig: isRecord(input.payload.adapterConfig) ? input.payload.adapterConfig : undefined,
    payloadRuntimeConfig: isRecord(input.payload.runtimeConfig) ? input.payload.runtimeConfig : undefined,
    linked,
    agentAuthored: actor.type === "agent",
    instructionChangeAllowed: Boolean(input.instructionAmendment) && actor.type === "board",
    phase: "request",
  });
}

/**
 * True when the stored payload changes the linked agent's instruction keys:
 * the resubmit then records the board amendment.
 */
export function changesLinkedInstructions(payload: JsonRecord, agentAdapterConfig: unknown) {
  const payloadConfig = isRecord(payload.adapterConfig) ? payload.adapterConfig : undefined;
  if (!payloadConfig) return false;
  return changedInstructionPaths(payloadConfig, isRecord(agentAdapterConfig) ? agentAdapterConfig : {}).length > 0;
}

/**
 * Records a board amendment inside the resubmit's transaction: the amending
 * user, the exact stored payload and the agent's instruction configuration
 * it amends. Written by the server only; never taken from the request.
 */
export async function recordHireInstructionAmendment(
  txDb: Db,
  input: { companyId: string; approvalId: string; actorUserId: string; agentId: string; payload: JsonRecord; agentAdapterConfig: unknown },
) {
  const payloadConfig = isRecord(input.payload.adapterConfig) ? input.payload.adapterConfig : {};
  const current = isRecord(input.agentAdapterConfig) ? input.agentAdapterConfig : {};
  await txDb.insert(activityLog).values({
    companyId: input.companyId,
    actorType: "user",
    actorId: input.actorUserId,
    action: HIRE_INSTRUCTION_AMENDMENT_ACTION,
    entityType: "approval",
    entityId: input.approvalId,
    details: {
      agentId: input.agentId,
      fields: changedInstructionPaths(payloadConfig, current),
      payloadSha256: sha256(input.payload),
      baseInstructionSha256: instructionFingerprint(current),
    },
  });
}

/** The latest amendment record matches the exact payload and the agent's current configuration. */
async function hasCurrentInstructionAmendment(
  txDb: Db,
  input: { companyId: string; approvalId: string; agent: LinkedAgentRow; payload: JsonRecord },
) {
  const [latest] = await txDb.select({ details: activityLog.details }).from(activityLog)
    .where(and(
      eq(activityLog.companyId, input.companyId),
      eq(activityLog.entityType, "approval"),
      eq(activityLog.entityId, input.approvalId),
      eq(activityLog.action, HIRE_INSTRUCTION_AMENDMENT_ACTION),
      eq(activityLog.actorType, "user"),
    ))
    .orderBy(desc(activityLog.createdAt))
    .limit(1);
  const details = isRecord(latest?.details) ? latest.details : null;
  return Boolean(details
    && details.agentId === input.agent.id
    && details.payloadSha256 === sha256(input.payload)
    && details.baseInstructionSha256 === instructionFingerprint(input.agent.adapterConfig));
}

/**
 * Decision time, inside the approval transaction: approval of a `hire_agent`
 * approval that creates a new agent (no `payload.agentId`).
 */
export async function authorizeHireApprovalCreate(
  txDb: Db,
  decider: HireApprovalActor,
  input: { companyId: string; payload: JsonRecord; requestedByAgentId: string | null; newAgentId: string },
) {
  const actor = await assertDecider(txDb, decider, input.companyId);
  await applyPayloadRules({
    conn: txDb,
    actor,
    companyId: input.companyId,
    payloadConfig: isRecord(input.payload.adapterConfig) ? input.payload.adapterConfig : undefined,
    payloadRuntimeConfig: isRecord(input.payload.runtimeConfig) ? input.payload.runtimeConfig : undefined,
    linked: null,
    newAgentIdentity: { id: input.newAgentId, name: String(input.payload.name ?? "New Agent") },
    agentAuthored: Boolean(input.requestedByAgentId),
    instructionChangeAllowed: false,
    phase: "decision",
  });
}

/**
 * Activation time, inside the activation transaction after the agent row is
 * locked and found pending: a linked approval's activation, or the direct
 * activation of a pending agent that has no open approval (`payload` null).
 */
export async function authorizeHireActivation(
  txDb: Db,
  decider: HireApprovalActor,
  input: {
    companyId: string;
    agent: LinkedAgentRow;
    payload: JsonRecord | null;
    requestedByAgentId: string | null;
    /** The approval being decided; null for the unlinked historical fallback. */
    approvalId: string | null;
  },
) {
  const actor = await assertDecider(txDb, decider, input.companyId);
  // A current board amendment attests the exact payload as board-authored.
  const amended = Boolean(input.payload && input.approvalId && input.agent.companyId === input.companyId
    && await hasCurrentInstructionAmendment(txDb, {
      companyId: input.companyId, approvalId: input.approvalId, agent: input.agent, payload: input.payload,
    }));
  await applyPayloadRules({
    conn: txDb,
    actor,
    companyId: input.companyId,
    payloadConfig: input.payload && isRecord(input.payload.adapterConfig) ? input.payload.adapterConfig : undefined,
    payloadRuntimeConfig: input.payload && isRecord(input.payload.runtimeConfig) ? input.payload.runtimeConfig : undefined,
    linked: input.agent,
    agentAuthored: Boolean(input.requestedByAgentId) && !amended,
    instructionChangeAllowed: amended,
    phase: "decision",
  });
}

async function assertDecider(txDb: Db, decider: HireApprovalActor, companyId: string) {
  if (decider.type !== "board") {
    throw forbidden("Board access required");
  }
  const actor = hireApprovalRecheckActor(decider);
  await assertCanCreateAgents(txDb, actor, companyId);
  return actor;
}
