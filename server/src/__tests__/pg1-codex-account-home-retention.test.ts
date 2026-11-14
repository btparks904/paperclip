// PG-1: a failed legacy Codex device-login promotion keeps the account-home
// directory it created. Real routes, the real promotion helper and the real
// secrets service on embedded PostgreSQL; the login session store and the
// sandbox runtime are in-memory fakes. Synthetic account ids and token values
// only; no real credential is used.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { companies, companySecrets, createDb } from "@paperclipai/db";
import { AdapterAuthSessionConflictError } from "../services/device-login-service.js";
import type {
  AdapterAuthSessionRow,
  AdapterAuthSessionStore,
  LoginSessionLease,
  LoginSessionRuntime,
} from "../services/device-login-service.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const ACCOUNT_ID = "acct-pg1-synthetic";
const ENVIRONMENT_ID = "11111111-1111-4111-8111-111111111111";
const OWNER = "pg1-owner";
const PROMPT_OUTPUT =
  "Open https://auth.openai.com/codex/device in your browser.\nEnter the one-time code below:\nABCD-EFGHI\n";
// A synthetic subscription credential: the shape the promotion accepts, with
// sentinel token strings.
const CREDENTIAL_BYTES = JSON.stringify({
  tokens: {
    id_token: "SENTINEL-PG1-ID-TOKEN",
    access_token: "SENTINEL-PG1-ACCESS-TOKEN",
    refresh_token: "SENTINEL-PG1-REFRESH-TOKEN",
    account_id: ACCOUNT_ID,
  },
  last_refresh: "2026-11-14T00:00:00.000Z",
});

const harness = vi.hoisted(() => ({
  store: null as unknown as AdapterAuthSessionStore,
  runtime: null as unknown as LoginSessionRuntime,
  gate: Promise.resolve<void>(undefined),
  releaseGate: (() => {}) as () => void,
  // Runs inside the secrets service's `create`, for the generated
  // CODEX_HOME_<handle> secret only, before it fails.
  onAccountHomeSecretCreate: null as null | (() => Promise<void>),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  decide: vi.fn(),
  hasPermission: vi.fn(),
  getMembership: vi.fn(async () => null),
  listPrincipalGrants: vi.fn(async () => []),
}));
const mockEnvironmentService = vi.hoisted(() => ({
  getById: vi.fn(),
  releaseLease: vi.fn(),
  listBoundCompanyIds: vi.fn(async () => [] as string[]),
}));

vi.mock("../services/index.js", () => ({
  agentService: () => ({ getById: vi.fn(), getChainOfCommand: vi.fn(async () => []) }),
  agentInstructionsService: () => ({}),
  accessService: () => mockAccessService,
  approvalService: () => ({}),
  builtInAgentService: () => ({ ensureCompanyDefaultAgentGrants: vi.fn() }),
  companySkillService: () => ({
    listRuntimeSkillEntries: vi.fn(async () => []),
    resolveRequestedSkillKeys: vi.fn(async () => []),
  }),
  budgetService: () => ({}),
  heartbeatService: () => ({ wakeup: vi.fn(), cancelActiveForAgent: vi.fn() }),
  ISSUE_LIST_DEFAULT_LIMIT: 50,
  issueApprovalService: () => ({}),
  issueRecoveryActionService: () => ({}),
  issueService: () => ({}),
  logActivity: vi.fn(),
  syncInstructionsBundleConfigFromFilePath: vi.fn((_agent, config) => config),
  workspaceOperationService: () => ({}),
}));
vi.mock("../services/environments.js", () => ({ environmentService: () => mockEnvironmentService }));
vi.mock("../services/environment-runtime.js", () => ({
  environmentRuntimeService: () => ({
    acquireRunLease: vi.fn(),
    realizeWorkspace: vi.fn(),
    getDriver: vi.fn(() => ({ releaseRunLease: vi.fn(async () => undefined) })),
  }),
}));
vi.mock("../services/plugin-environment-driver.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/plugin-environment-driver.js")>()),
  resolvePluginSandboxProviderDriverByKey: vi.fn(async ({ driverKey }: { driverKey: string }) =>
    driverKey === "daytona" ? { plugin: { id: "plugin-daytona" }, driver: { supportsLoginPty: true } } : null),
}));
vi.mock("../services/environment-execution-target.js", () => ({ resolveEnvironmentExecutionTarget: vi.fn() }));
vi.mock("../services/instance-settings.js", () => ({
  instanceSettingsService: () => ({ getGeneral: vi.fn(async () => ({ censorUsernameInLogs: false })) }),
}));
// The real secrets service. Only `create` for the generated account-home
// secret is made to fail (after an optional hook), to drive the promotion's
// "failed to record the account home secret" path; every other call,
// including the hook's own concurrent write, is the real service.
vi.mock("../services/secrets.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/secrets.js")>();
  return {
    ...actual,
    secretService: (db: Parameters<typeof actual.secretService>[0]) => {
      const svc = actual.secretService(db);
      return {
        ...svc,
        create: async (...args: Parameters<typeof svc.create>) => {
          if (typeof args[1]?.name === "string" && args[1].name.startsWith("CODEX_HOME_")) {
            if (harness.onAccountHomeSecretCreate) await harness.onAccountHomeSecretCreate();
            throw new Error("synthetic failure: the account home secret write failed");
          }
          return svc.create(...args);
        },
      };
    },
  };
});
vi.mock("../services/device-login-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/device-login-service.js")>()),
  createDbAdapterAuthSessionStore: () => harness.store,
  createProductionLoginSessionRuntime: () => harness.runtime,
}));

function createMemoryStore(): AdapterAuthSessionStore {
  const rows = new Map<string, AdapterAuthSessionRow>();
  const active = new Set<string>();
  const key = (c: string, u: string, a: string) => `${c}|${u}|${a}`;
  const isActive = (s: AdapterAuthSessionRow["status"]) => s === "starting" || s === "waiting_for_user" || s === "promoting";
  const apply = (row: AdapterAuthSessionRow, input: Record<string, any>) => {
    row.status = input.status;
    for (const field of ["failureReason", "finishedAt", "promotionExpiresAt", "resultClaim"] as const) {
      if (input[field] !== undefined) (row as any)[field] = input[field];
    }
    if (!isActive(input.status)) active.delete(key(row.companyId, row.startedByUserId, row.adapterType));
  };
  return {
    async insert(input) {
      const k = key(input.companyId, input.startedByUserId, input.adapterType);
      if (active.has(k)) throw new AdapterAuthSessionConflictError();
      active.add(k);
      rows.set(input.id, {
        id: input.id, publicSessionId: input.publicSessionId, companyId: input.companyId, environmentId: input.environmentId,
        adapterType: input.adapterType, startedByUserId: input.startedByUserId, providerLeaseId: null, status: "starting",
        expiresAt: input.expiresAt, promotionExpiresAt: null, finishedAt: null, failureReason: null, resultClaim: null,
      });
    },
    async recordLeaseAcquired(input) {
      const row = rows.get(input.sessionId);
      if (row) row.providerLeaseId = input.providerLeaseId;
    },
    async setStatus(input) {
      const row = rows.get(input.sessionId);
      if (row) apply(row, input);
    },
    async compareAndSetStatus(input) {
      const row = rows.get(input.sessionId);
      if (!row || !input.expectedStatuses.includes(row.status)) return false;
      apply(row, input);
      return true;
    },
    async get(sessionId) {
      const row = rows.get(sessionId);
      return row ? { ...row } : null;
    },
    async getByPublicId(publicSessionId, companyId) {
      for (const row of rows.values()) {
        if (row.publicSessionId === publicSessionId && row.companyId === companyId) return { ...row };
      }
      return null;
    },
    async getActiveByOwner(companyId, startedByUserId, adapterType) {
      for (const row of rows.values()) {
        if (row.companyId === companyId && row.startedByUserId === startedByUserId && row.adapterType === adapterType && isActive(row.status)) {
          return { ...row };
        }
      }
      return null;
    },
    async withCompanyAdapterPromotionLock(_c, _u, _a, fn) {
      return fn();
    },
  };
}

function createFakeRuntime(): LoginSessionRuntime {
  return {
    async acquireLoginLease(input) {
      const lease: LoginSessionLease = {
        providerLeaseId: `provider-lease-${input.sessionId}`,
        authPath: `/tmp/paperclip-adapter-login/${input.sessionId}/auth.json`,
        driver: {
          async start(_command, onData) {
            onData(PROMPT_OUTPUT);
            await harness.gate;
            return { exitCode: 0 };
          },
          async readFile() {
            return Buffer.from(CREDENTIAL_BYTES, "utf8");
          },
          async dispose() {},
        },
        async deleteSandbox() {
          return { outcome: "deleted" };
        },
        async release() {},
      };
      return lease;
    },
  };
}

describe("PG-1: a failed Codex device-login promotion keeps the account home it created", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let home: string;
  let companyId: string;
  const previousHome = process.env.PAPERCLIP_HOME;

  async function createApp() {
    const [{ agentRoutes }, { errorHandler }] = await Promise.all([
      import("../routes/agents.js"),
      import("../middleware/index.js"),
    ]);
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = { type: "board", userId: OWNER, companyIds: [companyId], source: "local_implicit", isInstanceAdmin: false };
      next();
    });
    app.use("/api", agentRoutes(db as any));
    app.use(errorHandler);
    return app;
  }
  const loginPath = () => `/api/companies/${companyId}/adapters/codex_local/login-sessions`;
  const accountHomeDir = () => path.join(home, "instances", "default", "companies", companyId, "codex-auth-cache", ACCOUNT_ID);

  /** Starts a login, lets the fake sandbox finish, and waits for the failed terminal state. */
  async function runFailedLogin() {
    const app = await createApp();
    const start = await request(app).post(loginPath()).send({ environmentId: ENVIRONMENT_ID });
    expect(start.status, JSON.stringify(start.body)).toBe(201);
    harness.releaseGate();
    await vi.waitFor(async () => {
      const status = await request(app).get(`${loginPath()}/${start.body.sessionId}`);
      expect(status.body.status).toBe("failed");
      expect(status.body.failure?.reason).toBe("promotion_failed");
    }, { timeout: 15_000 });
  }

  async function expectPrivateCredentialHome(dir: string) {
    const dirStat = await fs.lstat(dir);
    expect(dirStat.isDirectory()).toBe(true);
    expect(dirStat.isSymbolicLink()).toBe(false);
    expect(dirStat.mode & 0o777).toBe(0o700);
    const fileStat = await fs.lstat(path.join(dir, "auth.json"));
    expect(fileStat.isFile()).toBe(true);
    expect(fileStat.mode & 0o777).toBe(0o600);
    expect(dirStat.uid).toBe(process.getuid?.());
    // The kept file is the synthetic credential this login staged.
    const kept = JSON.parse(await fs.readFile(path.join(dir, "auth.json"), "utf8"));
    expect(kept.tokens.account_id).toBe(ACCOUNT_ID);
  }

  beforeAll(async () => {
    home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pg1-account-home-")));
    process.env.PAPERCLIP_HOME = home;
    database = await startEmbeddedPostgresTestDatabase("pg1-account-home-db-");
    db = createDb(database.connectionString);
  }, 90_000);
  afterAll(async () => {
    await database?.cleanup();
    await fs.rm(home, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = previousHome;
  });
  beforeEach(async () => {
    vi.clearAllMocks();
    companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "PG1", issuePrefix: randomUUID().slice(0, 8) });
    harness.store = createMemoryStore();
    harness.runtime = createFakeRuntime();
    harness.onAccountHomeSecretCreate = null;
    harness.gate = new Promise<void>((resolve) => {
      harness.releaseGate = resolve;
    });
    mockAccessService.decide.mockResolvedValue({ allowed: true, reason: "allow_explicit_grant", explanation: "test grant" });
    mockEnvironmentService.getById.mockImplementation(async (id: string) => ({
      id, companyId, name: "Sandbox", driver: "sandbox", status: "active", config: { provider: "daytona" }, envVars: {},
    }));
  });
  afterEach(() => {
    harness.releaseGate();
  });

  it("race: a secret naming the new home, uncommitted in another transaction, keeps the home after the promotion fails", async () => {
    // The race the old cleanup lost: another transaction writes a
    // `local_encrypted` secret whose value is this account home (the same
    // `createManagedLocalSecret` an agent configuration save uses when it
    // normalizes a raw value). It takes and releases the account-home secret
    // lock, then holds its transaction open. The promotion's own secret
    // write then fails. The old code scanned for claimants in that gap, could
    // not see the uncommitted row, and deleted the directory.
    const { secretService } = await vi.importActual<typeof import("../services/secrets.js")>("../services/secrets.js");
    let releaseTx!: () => void;
    const txReleased = new Promise<void>((resolve) => { releaseTx = resolve; });
    let txDone!: Promise<unknown>;
    harness.onAccountHomeSecretCreate = async () => {
      // The promotion has created the account home by now.
      await expect(fs.lstat(accountHomeDir())).resolves.toBeDefined();
      let created!: () => void;
      const written = new Promise<void>((resolve) => { created = resolve; });
      txDone = db.transaction(async (tx) => {
        await secretService(tx as any).create(
          companyId,
          { name: "HAND_NAMED_CODEX_HOME", provider: "local_encrypted", value: accountHomeDir() },
          { userId: OWNER, agentId: null },
        );
        created();
        await txReleased;
      });
      await written;
      // Uncommitted: not visible outside the transaction.
      const visible = await db.select({ id: companySecrets.id }).from(companySecrets).where(eq(companySecrets.companyId, companyId));
      expect(visible).toHaveLength(0);
    };

    await runFailedLogin();

    // The promotion stays failed, and the directory it created is still
    // there while the other transaction is still open.
    await expectPrivateCredentialHome(accountHomeDir());

    releaseTx();
    await txDone;
    // The committed secret names a directory that exists.
    const [committed] = await db.select().from(companySecrets).where(eq(companySecrets.companyId, companyId));
    expect(committed?.name).toBe("HAND_NAMED_CODEX_HOME");
    const resolved = await secretService(db).resolveSecretValueForDeviceLoginCheck(companyId, committed!.id, { configPath: "secrets.HAND_NAMED_CODEX_HOME" });
    expect(resolved).toBe(accountHomeDir());
    await expectPrivateCredentialHome(resolved);
  }, 60_000);

  it("keeps the new home, private, when no secret names it, and no generated secret is written", async () => {
    await runFailedLogin();
    await expectPrivateCredentialHome(accountHomeDir());
    const rows = await db.select({ id: companySecrets.id }).from(companySecrets).where(eq(companySecrets.companyId, companyId));
    expect(rows).toHaveLength(0);
  }, 60_000);
});
