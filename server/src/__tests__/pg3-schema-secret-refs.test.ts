// PG-3: a schema-secret adapter field (Hermes gateway `apiKey`) is persisted
// only as a reference to an existing secret of the same company. Real routes
// and services on embedded PostgreSQL, synthetic actors and sentinel values
// only. A rejected request writes nothing.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { agents, approvals, companies, companySecrets, createDb, invites, joinRequests } from "@paperclipai/db";
import { agentRoutes } from "../routes/agents.js";
import { approvalRoutes } from "../routes/approvals.js";
import { accessRoutes, prepareAgentDefaultsPayloadForJoinPersistence } from "../routes/access.js";
import { errorHandler } from "../middleware/index.js";
import { agentService } from "../services/agents.js";
import { secretService } from "../services/secrets.js";
import { companyPortabilityService } from "../services/company-portability.js";
import { setAdapterDisabled } from "../services/adapter-plugin-store.js";
import { findServerAdapter, registerServerAdapter, unregisterServerAdapter } from "../adapters/index.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const hireHook = vi.hoisted(() => ({ notifyHireApproved: vi.fn() }));
vi.mock("../services/hire-hook.js", () => hireHook);

const RAW_API_KEY = "SENTINEL-SYNTHETIC-HERMES-API-KEY-PG3";
const REQUIRES_REF = "schema_secret_field_requires_secret_ref";
const SCHEMA_UNAVAILABLE = "adapter_config_schema_unavailable";
const HERMES = "hermes_gateway";

describe("PG-3: schema-secret fields require an existing same-company secret reference", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let home: string;
  let companyId: string;
  let otherCompanyId: string;
  const userId = "pg3-board-user";

  const localBoard = () => ({ type: "board", userId, companyIds: [companyId], source: "local_implicit", isInstanceAdmin: true });
  const app = () => {
    const server = express();
    server.use(express.json());
    server.use((req, _res, next) => { (req as any).actor = localBoard(); next(); });
    server.use("/api", agentRoutes(db as any));
    server.use("/api", approvalRoutes(db as any));
    server.use(errorHandler);
    return server;
  };
  const hermesConfig = (apiKey: unknown, extra: Record<string, unknown> = {}) =>
    ({ apiBaseUrl: "http://127.0.0.1:65530", apiKey, ...extra });
  const ref = (secretId: string) => ({ type: "secret_ref", secretId, version: "latest" });
  async function makeSecret(company: string, name = `PG3_${randomUUID().slice(0, 8)}`) {
    return secretService(db).create(company, { name, provider: "local_encrypted", value: "SENTINEL-SYNTHETIC-STORED" }, { userId, agentId: null });
  }

  /** Every row a rejected request must not add or change. */
  async function effects() {
    const companyIds = [companyId, otherCompanyId];
    const rows = async (table: any, column: any) =>
      (await db.select().from(table)).filter((row: any) => companyIds.includes(row[column]))
        .map((row: any) => JSON.stringify(row)).sort();
    return {
      companies: (await db.select({ id: companies.id }).from(companies)).map((r) => r.id).sort(),
      agents: await rows(agents, "companyId"),
      secrets: await rows(companySecrets, "companyId"),
      approvals: await rows(approvals, "companyId"),
      joinRequests: await rows(joinRequests, "companyId"),
      invites: await rows(invites, "companyId"),
    };
  }
  async function expectRejectedWithoutWrites(run: () => Promise<{ status: number; body: any }>, status: number, code: string) {
    const before = await effects();
    const res = await run();
    expect(res.status, JSON.stringify(res.body)).toBe(status);
    expect(res.body?.code ?? res.body?.details?.code).toBe(code);
    expect(await effects()).toEqual(before);
    expect(JSON.stringify(await effects())).not.toContain(RAW_API_KEY);
    expect(hireHook.notifyHireApproved).not.toHaveBeenCalled();
  }
  /** Runs a service call and shapes its rejection like a response. */
  const serviceCall = (fn: () => Promise<unknown>) => async () =>
    fn().then(
      () => ({ status: 200, body: {} }),
      (err: any) => ({ status: err?.status ?? 500, body: { code: err?.details?.code, message: String(err?.message) } }),
    );

  const post = (url: string, body: Record<string, unknown>) => request(app()).post(url).send(body).then((res) => res);
  const createAgent = (adapterConfig: Record<string, unknown>, adapterType = HERMES) =>
    post(`/api/companies/${companyId}/agents`, { name: `PG3-${randomUUID().slice(0, 6)}`, role: "general", adapterType, adapterConfig });
  const hire = (adapterConfig: Record<string, unknown>) =>
    post(`/api/companies/${companyId}/agent-hires`, { name: `PG3H-${randomUUID().slice(0, 6)}`, role: "general", adapterType: HERMES, adapterConfig });
  const approvalRequest = (adapterConfig: Record<string, unknown>) =>
    post(`/api/companies/${companyId}/approvals`, {
      type: "hire_agent",
      payload: { name: `PG3A-${randomUUID().slice(0, 6)}`, role: "general", adapterType: HERMES, adapterConfig },
    });
  const adapterTest = (adapterConfig: Record<string, unknown>) =>
    post(`/api/companies/${companyId}/adapters/${HERMES}/test-environment`, { adapterConfig });
  const join = (adapterConfig: Record<string, unknown>) => serviceCall(() => prepareAgentDefaultsPayloadForJoinPersistence({
    db: db as any, companyId, adapterType: HERMES, normalized: adapterConfig, actor: { userId: null, agentId: null },
  }));
  const serviceCreate = (adapterConfig: Record<string, unknown>) => serviceCall(() => agentService(db as any).create(companyId, {
    name: `PG3S-${randomUUID().slice(0, 6)}`, role: "general", adapterType: HERMES, adapterConfig,
  } as any));
  const importBundle = (adapterConfigs: Array<Record<string, unknown>>, target: "existing" | "new") => serviceCall(() => {
    const files: Record<string, string> = { "COMPANY.md": "---\nname: PG3 Import\n---\n" };
    const adapterOverrides: Record<string, { adapterType: string; adapterConfig: Record<string, unknown> }> = {};
    adapterConfigs.forEach((adapterConfig, index) => {
      files[`agents/hermes-${index}/AGENTS.md`] = `---\nname: Hermes ${index}\n---\n`;
      adapterOverrides[`hermes-${index}`] = { adapterType: HERMES, adapterConfig };
    });
    return companyPortabilityService(db as any).importBundle({
      source: { type: "inline", rootPath: "pg3", files },
      include: { company: target === "new", agents: true, projects: false, issues: false },
      target: target === "existing" ? { mode: "existing_company", companyId } : { mode: "new_company", newCompanyName: "PG3 New" },
      agents: "all",
      collisionStrategy: "rename",
      adapterOverrides,
    } as any, userId);
  });

  beforeAll(async () => {
    home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pg3-secret-refs-")));
    process.env.PAPERCLIP_HOME = home;
    database = await startEmbeddedPostgresTestDatabase("pg3-secret-refs-db-");
    db = createDb(database.connectionString);
  }, 90_000);
  afterAll(async () => { await database?.cleanup(); await fs.rm(home, { recursive: true, force: true }); });
  beforeEach(async () => {
    hireHook.notifyHireApproved.mockReset();
    companyId = randomUUID();
    otherCompanyId = randomUUID();
    await db.insert(companies).values([
      { id: companyId, name: "PG3", issuePrefix: randomUUID().slice(0, 8) },
      { id: otherCompanyId, name: "PG3-other", issuePrefix: randomUUID().slice(0, 8) },
    ]);
  });
  afterEach(() => {
    setAdapterDisabled(HERMES, false);
    unregisterServerAdapter(HERMES);
  });

  const rawEntries: Array<[string, unknown]> = [
    ["a raw string", RAW_API_KEY],
    ["a plain binding", { type: "plain", value: RAW_API_KEY }],
  ];

  describe("raw values are refused on every listed path, with no writes", () => {
    for (const [label, apiKey] of rawEntries) {
      it(`agent create route: ${label}`, async () => {
        await expectRejectedWithoutWrites(() => createAgent(hermesConfig(apiKey)), 422, REQUIRES_REF);
      });
      it(`hire route: ${label}`, async () => {
        await expectRejectedWithoutWrites(() => hire(hermesConfig(apiKey)), 422, REQUIRES_REF);
      });
      it(`hire approval request: ${label}`, async () => {
        await expectRejectedWithoutWrites(() => approvalRequest(hermesConfig(apiKey)), 422, REQUIRES_REF);
      });
      it(`adapter test: ${label}`, async () => {
        await expectRejectedWithoutWrites(() => adapterTest(hermesConfig(apiKey)), 422, REQUIRES_REF);
      });
      it(`Hermes join defaults: ${label}`, async () => {
        await expectRejectedWithoutWrites(join({ url: "http://127.0.0.1:65530", ...hermesConfig(apiKey) }), 422, REQUIRES_REF);
      });
      it(`agent service create (service caller): ${label}`, async () => {
        await expectRejectedWithoutWrites(serviceCreate(hermesConfig(apiKey)), 422, REQUIRES_REF);
      });
      it(`import into an existing company: ${label}`, async () => {
        await expectRejectedWithoutWrites(importBundle([hermesConfig(apiKey)], "existing"), 422, REQUIRES_REF);
      });
    }
    it("import into a new company refuses any secret value before the company is created", async () => {
      const secret = await makeSecret(companyId);
      await expectRejectedWithoutWrites(importBundle([hermesConfig(RAW_API_KEY)], "new"), 422, REQUIRES_REF);
      await expectRejectedWithoutWrites(importBundle([hermesConfig(ref(secret.id))], "new"), 422, REQUIRES_REF);
    });
    it("import: a valid first agent and an invalid second agent write nothing (no partial import)", async () => {
      const secret = await makeSecret(companyId);
      await expectRejectedWithoutWrites(
        importBundle([hermesConfig(ref(secret.id)), hermesConfig(RAW_API_KEY)], "existing"), 422, REQUIRES_REF);
    });
  });

  describe("invalid and cross-company references are refused with no writes", () => {
    it("another company's secret", async () => {
      const foreign = await makeSecret(otherCompanyId);
      for (const run of [createAgent, hire, approvalRequest, adapterTest]) {
        const before = await effects();
        const res = await run(hermesConfig(ref(foreign.id)));
        expect(res.status, JSON.stringify(res.body)).toBe(422);
        expect(res.body.error).toMatch(/same company/);
        expect(await effects()).toEqual(before);
      }
      for (const run of [join({ url: "http://127.0.0.1:65530", ...hermesConfig(ref(foreign.id)) }), serviceCreate(hermesConfig(ref(foreign.id))),
        importBundle([hermesConfig(ref(foreign.id))], "existing")]) {
        const before = await effects();
        expect((await run()).status).toBe(422);
        expect(await effects()).toEqual(before);
      }
    });
    it("a missing secret id, a deleted secret, and a user-secret reference", async () => {
      const deleted = await makeSecret(companyId);
      await secretService(db).remove(deleted.id);
      const cases: Array<[unknown, number]> = [
        [ref(randomUUID()), 404],
        [ref(deleted.id), 404],
        [{ type: "user_secret_ref", key: "SOME_KEY" }, 422],
        [{ nested: true }, 422],
      ];
      for (const [apiKey, status] of cases) {
        for (const run of [createAgent, hire, approvalRequest, adapterTest]) {
          const before = await effects();
          const res = await run(hermesConfig(apiKey));
          expect(res.status, `${JSON.stringify(apiKey)} ${JSON.stringify(res.body)}`).toBe(status);
          expect(await effects()).toEqual(before);
        }
        for (const run of [serviceCreate(hermesConfig(apiKey)), importBundle([hermesConfig(apiKey)], "existing")]) {
          const before = await effects();
          expect((await run()).status, JSON.stringify(apiKey)).toBe(status);
          expect(await effects()).toEqual(before);
        }
      }
    });
  });

  describe("existing same-company references are accepted and create no secret", () => {
    it("create, hire, approval request, join and service create store the reference as given", async () => {
      const secret = await makeSecret(companyId);
      const secretCount = async () => (await db.select().from(companySecrets).where(eq(companySecrets.companyId, companyId))).length;
      const count = await secretCount();
      const created = await createAgent(hermesConfig(ref(secret.id)));
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      const hired = await hire(hermesConfig(ref(secret.id)));
      expect(hired.status, JSON.stringify(hired.body)).toBe(201);
      const requested = await approvalRequest(hermesConfig(ref(secret.id)));
      expect(requested.status, JSON.stringify(requested.body)).toBe(201);
      const joined = await prepareAgentDefaultsPayloadForJoinPersistence({
        db: db as any, companyId, adapterType: HERMES, normalized: { url: "http://127.0.0.1:65530", ...hermesConfig(ref(secret.id)) },
      });
      expect(joined?.apiKey).toMatchObject({ type: "secret_ref", secretId: secret.id });
      const serviceCreated = await agentService(db as any).create(companyId, {
        name: "PG3-service-ok", role: "general", adapterType: HERMES, adapterConfig: hermesConfig(ref(secret.id)),
      } as any);
      for (const agentId of [created.body.id, hired.body.agent.id, serviceCreated.id]) {
        const [row] = await db.select().from(agents).where(eq(agents.id, agentId));
        expect((row!.adapterConfig as any).apiKey).toMatchObject({ type: "secret_ref", secretId: secret.id });
      }
      expect(await secretCount()).toBe(count);
    });
    it("import into an existing company stores the reference as given and creates no secret", async () => {
      const secret = await makeSecret(companyId);
      const before = (await db.select().from(companySecrets)).length;
      const result = await importBundle([hermesConfig(ref(secret.id))], "existing")();
      expect(result.status, JSON.stringify(result.body)).toBe(200);
      const rows = await db.select().from(agents).where(eq(agents.companyId, companyId));
      expect(rows).toHaveLength(1);
      expect((rows[0]!.adapterConfig as any).apiKey).toMatchObject({ type: "secret_ref", secretId: secret.id });
      expect((await db.select().from(companySecrets)).length).toBe(before);
    });
    it("an empty value clears the field and creates no secret", async () => {
      const before = (await db.select().from(companySecrets)).length;
      const created = await createAgent(hermesConfig(""));
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      expect((await db.select().from(companySecrets)).length).toBe(before);
    });
  });

  describe("adapter state", () => {
    it("a disabled (hidden but callable) Hermes adapter still refuses raw values", async () => {
      setAdapterDisabled(HERMES, true);
      // The create route already refuses a disabled adapter type for a new
      // agent; the service caller and the join path still reach the adapter.
      const before = await effects();
      const routed = await createAgent(hermesConfig(RAW_API_KEY));
      expect(routed.status, JSON.stringify(routed.body)).toBe(422);
      expect(routed.body.error).toMatch(/not available on this instance/);
      expect(await effects()).toEqual(before);
      await expectRejectedWithoutWrites(() => adapterTest(hermesConfig(RAW_API_KEY)), 422, REQUIRES_REF);
      await expectRejectedWithoutWrites(serviceCreate(hermesConfig(RAW_API_KEY)), 422, REQUIRES_REF);
      await expectRejectedWithoutWrites(join({ url: "http://127.0.0.1:65530", ...hermesConfig(RAW_API_KEY) }), 422, REQUIRES_REF);
    });
    it("an adapter whose config schema cannot be read fails closed, with no writes", async () => {
      const builtin = findServerAdapter(HERMES)!;
      registerServerAdapter({
        ...builtin,
        getConfigSchema: async () => { throw new Error("synthetic: schema unavailable"); },
      });
      const secret = await makeSecret(companyId);
      for (const apiKey of [RAW_API_KEY, ref(secret.id)]) {
        await expectRejectedWithoutWrites(() => createAgent(hermesConfig(apiKey)), 503, SCHEMA_UNAVAILABLE);
        await expectRejectedWithoutWrites(() => hire(hermesConfig(apiKey)), 503, SCHEMA_UNAVAILABLE);
        await expectRejectedWithoutWrites(() => adapterTest(hermesConfig(apiKey)), 503, SCHEMA_UNAVAILABLE);
        await expectRejectedWithoutWrites(serviceCreate(hermesConfig(apiKey)), 503, SCHEMA_UNAVAILABLE);
        await expectRejectedWithoutWrites(join({ url: "http://127.0.0.1:65530", ...hermesConfig(apiKey) }), 503, SCHEMA_UNAVAILABLE);
        await expectRejectedWithoutWrites(importBundle([hermesConfig(apiKey)], "existing"), 503, SCHEMA_UNAVAILABLE);
      }
    });
    it("a schema-only secret field (not in the fallback list) is refused when raw", async () => {
      const builtin = findServerAdapter(HERMES)!;
      const schema = await builtin.getConfigSchema!();
      registerServerAdapter({
        ...builtin,
        getConfigSchema: async () => ({
          ...schema,
          fields: [...schema.fields, { key: "extraToken", label: "Extra token", type: "text", meta: { secret: true } }],
        }),
      });
      const secret = await makeSecret(companyId);
      // The first field is a valid reference, the second is raw: the request
      // is refused as a whole, with no writes.
      await expectRejectedWithoutWrites(
        () => createAgent(hermesConfig(ref(secret.id), { extraToken: RAW_API_KEY })), 422, REQUIRES_REF);
      await expectRejectedWithoutWrites(
        serviceCreate(hermesConfig(ref(secret.id), { extraToken: RAW_API_KEY })), 422, REQUIRES_REF);
    });
  });

  describe("Hermes invite join fails closed (PG-3 compatibility limitation)", () => {
    // The joiner is outside the company and also chooses apiBaseUrl, so it
    // must never name a company secret (its value would be sent to that URL).
    // Join normalization keeps requiring a string key, and PG-3 refuses a raw
    // key, so no Hermes join can be accepted. Nothing is written either way.
    const joinApp = () => {
      const server = express();
      server.use(express.json());
      server.use((req, _res, next) => { (req as any).actor = { type: "none", source: "none" }; next(); });
      server.use("/api", accessRoutes(db as any, {
        deploymentMode: "authenticated", deploymentExposure: "private", bindHost: "127.0.0.1", allowedHostnames: [],
      }));
      server.use(errorHandler);
      return server;
    };
    async function agentInvite() {
      const token = `pg3-invite-${randomUUID()}`;
      await db.insert(invites).values({
        companyId, inviteType: "company_join", tokenHash: createHash("sha256").update(token).digest("hex"),
        allowedJoinTypes: "agent", defaultsPayload: null, expiresAt: new Date(Date.now() + 86_400_000),
      });
      return token;
    }
    const accept = (token: string, apiKey: unknown) => request(joinApp()).post(`/api/invites/${token}/accept`).send({
      requestType: "agent", agentName: "PG3 Hermes", adapterType: HERMES, capabilities: "synthetic",
      agentDefaultsPayload: { apiBaseUrl: "http://127.0.0.1:65530", apiKey, paperclipApiUrl: "http://127.0.0.1:3100" },
    }).then((res) => res);

    for (const [label, apiKey] of rawEntries) {
      it(`a raw key (${label}) is refused, the invite stays open and nothing is written`, async () => {
        const token = await agentInvite();
        const before = await effects();
        const res = await accept(token, apiKey);
        expect(res.status, JSON.stringify(res.body)).toBe(apiKey === RAW_API_KEY ? 422 : 400);
        if (res.status === 422) expect(res.body?.details?.code ?? res.body?.code).toBe(REQUIRES_REF);
        expect(await effects()).toEqual(before);
        expect(JSON.stringify(await effects())).not.toContain(RAW_API_KEY);
      });
    }
    it("a same-company secret reference is refused before persistence; the secret is not exposed to the joiner's URL", async () => {
      const token = await agentInvite();
      const secret = await makeSecret(companyId);
      const before = await effects();
      const res = await accept(token, ref(secret.id));
      expect(res.status, JSON.stringify(res.body)).toBe(400);
      expect(String(res.body?.error)).toContain("agentDefaultsPayload.apiKey is required");
      expect(await effects()).toEqual(before);
    });
  });

  describe("updates of an existing agent are reference-only too", () => {
    const patchAgent = (agentId: string, body: Record<string, unknown>) =>
      request(app()).patch(`/api/agents/${agentId}`).send(body).then((res) => res);
    const setInstructionsPath = (agentId: string, body: Record<string, unknown>) =>
      request(app()).patch(`/api/agents/${agentId}/instructions-path`).send(body).then((res) => res);
    async function hermesAgent(apiKey: unknown) {
      const [row] = await db.insert(agents).values({
        companyId, name: `PG3U-${randomUUID().slice(0, 6)}`, role: "general", adapterType: HERMES,
        adapterConfig: hermesConfig(apiKey) as Record<string, unknown>,
      }).returning();
      return row!;
    }

    for (const [label, apiKey] of rawEntries) {
      it(`configuration PATCH (merge and replace): ${label}`, async () => {
        const secret = await makeSecret(companyId);
        const agent = await hermesAgent(ref(secret.id));
        await expectRejectedWithoutWrites(() => patchAgent(agent.id, { adapterConfig: { apiKey } }), 422, REQUIRES_REF);
        await expectRejectedWithoutWrites(
          () => patchAgent(agent.id, { adapterConfig: hermesConfig(apiKey), replaceAdapterConfig: true }), 422, REQUIRES_REF);
      });
      it(`agent service update (service caller): ${label}`, async () => {
        const secret = await makeSecret(companyId);
        const agent = await hermesAgent(ref(secret.id));
        await expectRejectedWithoutWrites(serviceCall(() => agentService(db as any).update(
          agent.id, { adapterConfig: hermesConfig(apiKey) }, { secretNormalization: {} } as any)), 422, REQUIRES_REF);
      });
    }
    it("configuration PATCH: a valid reference in one field and a raw value in another write nothing", async () => {
      const builtin = findServerAdapter(HERMES)!;
      const schema = await builtin.getConfigSchema!();
      registerServerAdapter({
        ...builtin,
        getConfigSchema: async () => ({
          ...schema,
          fields: [...schema.fields, { key: "extraToken", label: "Extra token", type: "text", meta: { secret: true } }],
        }),
      });
      const secret = await makeSecret(companyId);
      const agent = await hermesAgent(ref(secret.id));
      await expectRejectedWithoutWrites(
        () => patchAgent(agent.id, { adapterConfig: { apiKey: ref(secret.id), extraToken: RAW_API_KEY } }), 422, REQUIRES_REF);
    });
    it("configuration PATCH: cross-company, missing and deleted references write nothing", async () => {
      const own = await makeSecret(companyId);
      const agent = await hermesAgent(ref(own.id));
      const foreign = await makeSecret(otherCompanyId);
      const deleted = await makeSecret(companyId);
      await secretService(db).remove(deleted.id);
      for (const [apiKey, status] of [[ref(foreign.id), 422], [ref(randomUUID()), 404], [ref(deleted.id), 404]] as const) {
        const before = await effects();
        const res = await patchAgent(agent.id, { adapterConfig: { apiKey } });
        expect(res.status, JSON.stringify(res.body)).toBe(status);
        expect(await effects()).toEqual(before);
      }
    });
    it("configuration PATCH: an existing same-company reference is stored as given and creates no secret", async () => {
      const first = await makeSecret(companyId);
      const second = await makeSecret(companyId);
      const agent = await hermesAgent(ref(first.id));
      const count = (await db.select().from(companySecrets)).length;
      const res = await patchAgent(agent.id, { adapterConfig: { apiKey: ref(second.id) } });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const [row] = await db.select().from(agents).where(eq(agents.id, agent.id));
      expect((row!.adapterConfig as any).apiKey).toMatchObject({ type: "secret_ref", secretId: second.id });
      expect((await db.select().from(companySecrets)).length).toBe(count);
    });
    it("instructions-path change: accepted with a stored reference, refused for a legacy raw value with no writes", async () => {
      const secret = await makeSecret(companyId);
      const instructionsFile = async () => {
        const dir = path.join(home, "pg3-instructions", randomUUID());
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(path.join(dir, "AGENTS.md"), "# synthetic\n");
        return path.join(dir, "AGENTS.md");
      };
      const good = await hermesAgent(ref(secret.id));
      const ok = await setInstructionsPath(good.id, { path: await instructionsFile(), adapterConfigKey: "instructionsFilePath" });
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
      // A row stored before PG-3 can still hold a raw value. The change now
      // refuses it instead of converting it, and changes nothing.
      const legacy = await hermesAgent(RAW_API_KEY);
      const before = await effects();
      const res = await setInstructionsPath(legacy.id, { path: await instructionsFile(), adapterConfigKey: "instructionsFilePath" });
      expect(res.status, JSON.stringify(res.body)).toBe(422);
      expect(res.body?.details?.code ?? res.body?.code).toBe(REQUIRES_REF);
      expect(await effects()).toEqual(before);
    });
    it("configuration PATCH on a legacy raw row is refused until the value is replaced by a reference", async () => {
      const legacy = await hermesAgent(RAW_API_KEY);
      const before = await effects();
      const refused = await patchAgent(legacy.id, { adapterConfig: { apiBaseUrl: "http://127.0.0.1:65531" } });
      expect(refused.status, JSON.stringify(refused.body)).toBe(422);
      expect(refused.body?.details?.code ?? refused.body?.code).toBe(REQUIRES_REF);
      expect(await effects()).toEqual(before);
      const secret = await makeSecret(companyId);
      const fixed = await patchAgent(legacy.id, { adapterConfig: { apiKey: ref(secret.id) } });
      expect(fixed.status, JSON.stringify(fixed.body)).toBe(200);
      const [row] = await db.select().from(agents).where(eq(agents.id, legacy.id));
      expect(JSON.stringify(row!.adapterConfig)).not.toContain(RAW_API_KEY);
    });
  });

  describe("unchanged behavior", () => {
    it("ordinary environment strings are still stored as plain bindings", async () => {
      const created = await createAgent({ env: { ORDINARY_SETTING: "plain-value", OTHER: { type: "plain", value: "x" } } }, "process");
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      const [row] = await db.select().from(agents).where(eq(agents.id, created.body.id));
      expect((row!.adapterConfig as any).env).toEqual({
        ORDINARY_SETTING: { type: "plain", value: "plain-value" },
        OTHER: { type: "plain", value: "x" },
      });
    });
  });
});
