import express from "express";
import request from "supertest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockAgentService = vi.hoisted(() => ({
  create: vi.fn(),
  getById: vi.fn(),
  update: vi.fn(),
  resolveByReference: vi.fn(),
}));

const mockBuiltInAgentService = vi.hoisted(() => ({
  ensureCompanyDefaultAgentGrants: vi.fn(),
}));

const mockAgentInstructionsService = vi.hoisted(() => ({
  getBundle: vi.fn(),
  readFile: vi.fn(),
  updateBundle: vi.fn(),
  assertNoCopyIntentForRoot: vi.fn(),
  writeFile: vi.fn(),
  deleteFile: vi.fn(),
  exportFiles: vi.fn(),
  ensureManagedBundle: vi.fn(),
  materializeManagedBundle: vi.fn(),
}));

const mockInstructionWorkingCopies = vi.hoisted(() => ({ list: vi.fn(), resolve: vi.fn(), acknowledgeExplicitSave: vi.fn() }));
vi.mock("../services/agent-instruction-working-copies.js", () => ({ agentInstructionWorkingCopyService: () => mockInstructionWorkingCopies }));

const mockDownloadAgentFile = vi.hoisted(() => vi.fn());
// Records managed writes. It calls the real store unless a test installs an implementation.
const mockAgentFileWrite = vi.hoisted(() => vi.fn());
vi.mock("../services/agent-file-store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/agent-file-store.js")>();
  return { ...actual, agentFileStore: (...args: Parameters<typeof actual.agentFileStore>) => {
    const store = actual.agentFileStore(...args);
    const write: typeof store.write = (...input) => mockAgentFileWrite.getMockImplementation()
      ? mockAgentFileWrite(...input)
      : store.write(...input);
    return { ...store, download: mockDownloadAgentFile, write };
  } };
});

const mockInstructionRevisions = vi.hoisted(() => ({ readCurrent: vi.fn(), commit: vi.fn(), restore: vi.fn(), history: vi.fn(), readRevision: vi.fn(), diff: vi.fn(), materializeCurrent: vi.fn() }));
vi.mock("../services/agent-instruction-revisions.js", () => ({ agentInstructionRevisionService: () => mockInstructionRevisions }));

const mockAuthorizeInstructionRead = vi.hoisted(() => vi.fn());
vi.mock("../services/agent-instruction-authorization.js", () => ({ authorizeInstructionRead: mockAuthorizeInstructionRead }));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  decide: vi.fn(),
  hasPermission: vi.fn(),
}));

const mockSecretService = vi.hoisted(() => ({
  resolveAdapterConfigForRuntime: vi.fn(),
  normalizeAdapterConfigForPersistence: vi.fn(async (_companyId: string, config: Record<string, unknown>) => config),
}));
// Records the connection each secret service is built on, so a test can prove
// which database handle (global or transaction) a code path normalizes with.
const mockSecretServiceFactory = vi.hoisted(() => vi.fn((_db?: unknown) => mockSecretService));
const mockEnvironmentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());
const mockSyncInstructionsBundleConfigFromFilePath = vi.hoisted(() => vi.fn());
const mockFindServerAdapter = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  agentService: () => mockAgentService,
  agentInstructionsService: () => mockAgentInstructionsService,
  accessService: () => mockAccessService,
  approvalService: () => ({}),
  builtInAgentService: () => mockBuiltInAgentService,
  companySkillService: () => ({ listRuntimeSkillEntries: vi.fn() }),
  budgetService: () => ({}),
  environmentService: () => mockEnvironmentService,
  heartbeatService: () => ({}),
  issueApprovalService: () => ({}),
  issueService: () => ({}),
  logActivity: mockLogActivity,
  secretService: mockSecretServiceFactory,
  syncInstructionsBundleConfigFromFilePath: mockSyncInstructionsBundleConfigFromFilePath,
  workspaceOperationService: () => ({}),
}));

vi.mock("../services/secrets.js", () => ({
  secretService: mockSecretServiceFactory,
}));

vi.mock("../services/environments.js", () => ({
  environmentService: () => mockEnvironmentService,
}));

vi.mock("../adapters/index.js", () => ({
  findServerAdapter: mockFindServerAdapter,
  findActiveServerAdapter: mockFindServerAdapter,
  listAdapterModels: vi.fn(),
}));

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    agentService: () => mockAgentService,
    agentInstructionsService: () => mockAgentInstructionsService,
    accessService: () => mockAccessService,
    approvalService: () => ({}),
    builtInAgentService: () => mockBuiltInAgentService,
    companySkillService: () => ({ listRuntimeSkillEntries: vi.fn() }),
    budgetService: () => ({}),
    heartbeatService: () => ({}),
    issueApprovalService: () => ({}),
    issueService: () => ({}),
    logActivity: mockLogActivity,
    secretService: mockSecretServiceFactory,
    syncInstructionsBundleConfigFromFilePath: mockSyncInstructionsBundleConfigFromFilePath,
    workspaceOperationService: () => ({}),
  }));

  vi.doMock("../services/secrets.js", () => ({
    secretService: mockSecretServiceFactory,
  }));

  vi.doMock("../services/environments.js", () => ({
    environmentService: () => mockEnvironmentService,
  }));

  vi.doMock("../adapters/index.js", () => ({
    findServerAdapter: mockFindServerAdapter,
    findActiveServerAdapter: mockFindServerAdapter,
    listAdapterModels: vi.fn(),
  }));
}

function boardActor() {
  return {
    type: "board",
    userId: "local-board",
    companyIds: ["company-1"],
    source: "local_implicit",
    isInstanceAdmin: false,
  };
}

async function createApp(actor: Record<string, unknown> = boardActor(), db: Record<string, unknown> = {}) {
  const [{ agentRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/agents.js")>("../routes/agents.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", agentRoutes(db as any));
  app.use(errorHandler);
  return app;
}

async function requestApp(
  app: express.Express,
  buildRequest: (baseUrl: string) => request.Test,
) {
  const { createServer } = await vi.importActual<typeof import("node:http")>("node:http");
  const server = createServer(app);
  try {
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected HTTP server to listen on a TCP port");
    }
    return await buildRequest(`http://127.0.0.1:${address.port}`);
  } finally {
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    }
  }
}

function makeAgent() {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    companyId: "company-1",
    name: "Agent",
    role: "engineer",
    title: "Engineer",
    status: "active",
    reportsTo: null,
    capabilities: null,
    adapterType: "codex_local",
    adapterConfig: {},
    runtimeConfig: {},
    defaultEnvironmentId: null,
    permissions: null,
    updatedAt: new Date(),
  };
}

function makeReflectionCoachAgent(overrides: Record<string, unknown> = {}) {
  return {
    ...makeAgent(),
    id: "22222222-2222-4222-8222-222222222222",
    name: "Reflection Coach",
    metadata: {
      paperclipBuiltInAgent: {
        key: "reflection-coach",
        featureKeys: ["reflection-coach"],
      },
    },
    ...overrides,
  };
}

describe("agent instructions bundle routes", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../routes/agents.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.clearAllMocks();
    mockAuthorizeInstructionRead.mockImplementation(async (_db, actor) => actor);
    mockInstructionRevisions.readCurrent.mockResolvedValue(null);
    mockInstructionRevisions.commit.mockResolvedValue({ revision: { id: "33333333-3333-4333-8333-333333333333", entryFile: "AGENTS.md", byteLength: 18 }, content: "# Updated Agent\n", changed: true, materialization: "current" });
    mockBuiltInAgentService.ensureCompanyDefaultAgentGrants.mockResolvedValue(0);
    mockSyncInstructionsBundleConfigFromFilePath.mockImplementation((_agent, config) => config);
    mockFindServerAdapter.mockImplementation((_type: string) => ({ type: _type }));
    mockAccessService.decide.mockResolvedValue({
      allowed: true,
      reason: "allow_explicit_grant",
      explanation: "Allowed by test grant",
    });
    mockAgentService.getById.mockResolvedValue(makeAgent());
    mockAgentService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...makeAgent(),
      adapterConfig: patch.adapterConfig ?? {},
    }));
    mockAgentInstructionsService.getBundle.mockResolvedValue({
      agentId: "11111111-1111-4111-8111-111111111111",
      companyId: "company-1",
      mode: "managed",
      rootPath: "/tmp/agent-1",
      managedRootPath: "/tmp/agent-1",
      entryFile: "AGENTS.md",
      resolvedEntryPath: "/tmp/agent-1/AGENTS.md",
      editable: true,
      warnings: [],
      legacyPromptTemplateActive: false,
      legacyBootstrapPromptTemplateActive: false,
      files: [{
        path: "AGENTS.md",
        size: 12,
        language: "markdown",
        markdown: true,
        isEntryFile: true,
        editable: true,
        deprecated: false,
        virtual: false,
      }],
    });
    mockAgentInstructionsService.readFile.mockResolvedValue({
      path: "AGENTS.md",
      size: 12,
      language: "markdown",
      markdown: true,
      isEntryFile: true,
      editable: true,
      deprecated: false,
      virtual: false,
      content: "# Agent\n",
    });
    mockAgentInstructionsService.writeFile.mockResolvedValue({
      bundle: null,
      file: {
        path: "AGENTS.md",
        size: 18,
        language: "markdown",
        markdown: true,
        isEntryFile: true,
        editable: true,
        deprecated: false,
        virtual: false,
        content: "# Updated Agent\n",
      },
      adapterConfig: {
        instructionsBundleMode: "managed",
        instructionsRootPath: "/tmp/agent-1",
        instructionsEntryFile: "AGENTS.md",
        instructionsFilePath: "/tmp/agent-1/AGENTS.md",
      },
    });
  });

  it("returns bundle metadata", async () => {
    const res = await requestApp(
      await createApp(),
      (baseUrl) => request(baseUrl)
        .get("/api/agents/11111111-1111-4111-8111-111111111111/instructions-bundle?companyId=company-1"),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      mode: "managed",
      rootPath: "/tmp/agent-1",
      managedRootPath: "/tmp/agent-1",
      entryFile: "AGENTS.md",
    });
    expect(mockAgentInstructionsService.getBundle).toHaveBeenCalled();
    expect(mockAuthorizeInstructionRead).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ type: "board" }),
      expect.objectContaining({ companyId: "company-1", id: "11111111-1111-4111-8111-111111111111" }));
  });

  it("requires instance-admin access for every external instruction entry point", async () => {
    mockAgentService.getById.mockResolvedValue({
      ...makeAgent(),
      adapterConfig: {
        instructionsBundleMode: "external",
        instructionsRootPath: "/srv/paperclip/external-agent",
        instructionsEntryFile: "AGENTS.md",
      },
    });
    const app = await createApp({
      type: "board",
      userId: "company-admin",
      companyIds: ["company-1"],
      memberships: [{ companyId: "company-1", status: "active", membershipRole: "admin" }],
      source: "session",
      isInstanceAdmin: false,
    });
    const requests = [
      () => request(app).get("/api/agents/11111111-1111-4111-8111-111111111111/instructions-bundle"),
      () => request(app)
        .patch("/api/agents/11111111-1111-4111-8111-111111111111/instructions-bundle")
        .send({ entryFile: "AGENTS.md" }),
      () => request(app)
        .get("/api/agents/11111111-1111-4111-8111-111111111111/instructions-bundle/file")
        .query({ path: "AGENTS.md" }),
      () => request(app)
        .put("/api/agents/11111111-1111-4111-8111-111111111111/instructions-bundle/file")
        .send({ path: "AGENTS.md", content: "# changed" }),
      () => request(app)
        .delete("/api/agents/11111111-1111-4111-8111-111111111111/instructions-bundle/file")
        .query({ path: "AGENTS.md" }),
    ];

    for (const perform of requests) {
      const res = await perform();
      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(res.body.error).toContain("Instance admin");
    }
    expect(mockAgentInstructionsService.getBundle).not.toHaveBeenCalled();
    expect(mockAgentInstructionsService.readFile).not.toHaveBeenCalled();
    expect(mockAgentInstructionsService.updateBundle).not.toHaveBeenCalled();
    expect(mockAgentInstructionsService.writeFile).not.toHaveBeenCalled();
    expect(mockAgentInstructionsService.deleteFile).not.toHaveBeenCalled();
    expect(mockAuthorizeInstructionRead).not.toHaveBeenCalled();
  });

  it("treats a host root mislabeled as managed as external", async () => {
    mockAgentService.getById.mockResolvedValue({
      ...makeAgent(),
      adapterConfig: {
        instructionsBundleMode: "managed",
        instructionsRootPath: "/private/host/instructions",
        instructionsEntryFile: "AGENTS.md",
      },
    });
    const app = await createApp({
      type: "board",
      userId: "company-admin",
      companyIds: ["company-1"],
      memberships: [{ companyId: "company-1", status: "active", membershipRole: "admin" }],
      source: "session",
      isInstanceAdmin: false,
    });

    const res = await request(app)
      .get("/api/agents/11111111-1111-4111-8111-111111111111/instructions-bundle");

    expect(res.status).toBe(403);
    expect(mockAgentInstructionsService.getBundle).not.toHaveBeenCalled();
  });

  it("allows an instance admin to read an external instruction bundle", async () => {
    mockAgentService.getById.mockResolvedValue({
      ...makeAgent(),
      adapterConfig: {
        instructionsBundleMode: "external",
        instructionsRootPath: "/srv/paperclip/external-agent",
        instructionsEntryFile: "AGENTS.md",
      },
    });

    const res = await requestApp(
      await createApp({
        type: "board",
        userId: "instance-admin",
        companyIds: ["company-1"],
        memberships: [{ companyId: "company-1", status: "active", membershipRole: "admin" }],
        source: "session",
        isInstanceAdmin: true,
      }),
      (baseUrl) => request(baseUrl)
        .get("/api/agents/11111111-1111-4111-8111-111111111111/instructions-bundle"),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockAgentInstructionsService.getBundle).toHaveBeenCalled();
    expect(mockAuthorizeInstructionRead).not.toHaveBeenCalled();
  });

  it("rejects a company admin that requests a new external instruction root", async () => {
    mockSyncInstructionsBundleConfigFromFilePath.mockImplementation((_agent, config) => ({
      ...config,
      instructionsBundleMode: "external",
      instructionsRootPath: "/srv/paperclip/external-agent",
      instructionsEntryFile: "AGENTS.md",
    }));
    const app = await createApp({
      type: "board",
      userId: "company-admin",
      companyIds: ["company-1"],
      memberships: [{ companyId: "company-1", status: "active", membershipRole: "admin" }],
      source: "session",
      isInstanceAdmin: false,
    });

    const compatibilityRes = await request(app)
      .patch("/api/agents/11111111-1111-4111-8111-111111111111/instructions-path")
      .send({ path: "/srv/paperclip/external-agent/AGENTS.md" });
    expect(compatibilityRes.status, JSON.stringify(compatibilityRes.body)).toBe(403);

    const bundleRes = await request(app)
      .patch("/api/agents/11111111-1111-4111-8111-111111111111/instructions-bundle")
      .send({ mode: "external", rootPath: "/srv/paperclip/external-agent" });
    expect(bundleRes.status, JSON.stringify(bundleRes.body)).toBe(403);
    expect(mockAgentService.update).not.toHaveBeenCalled();
    expect(mockAgentInstructionsService.updateBundle).not.toHaveBeenCalled();
  });

  it("rejects external instruction roots through the generic agent patch", async () => {
    mockSyncInstructionsBundleConfigFromFilePath.mockImplementation((_agent, config) => config);
    const app = await createApp({
      type: "board",
      userId: "company-admin",
      companyIds: ["company-1"],
      memberships: [{ companyId: "company-1", status: "active", membershipRole: "admin" }],
      source: "session",
      isInstanceAdmin: false,
    });

    const res = await request(app)
      .patch("/api/agents/11111111-1111-4111-8111-111111111111")
      .send({
        adapterConfig: {
          instructionsBundleMode: "external",
          instructionsRootPath: "/srv/paperclip/external-agent",
          instructionsEntryFile: "AGENTS.md",
        },
      });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toContain("Instance admin");
    expect(mockAgentService.update).not.toHaveBeenCalled();
  });

  it("rejects external instruction roots during both hire and direct creation", async () => {
    const actor = {
      type: "board",
      userId: "company-admin",
      companyIds: ["company-1"],
      memberships: [{ companyId: "company-1", status: "active", membershipRole: "admin" }],
      source: "session",
      isInstanceAdmin: false,
    };
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(async () => [{
            id: "company-1",
            requireBoardApprovalForNewAgents: false,
          }]),
        })),
      })),
    };
    const app = await createApp(actor, db);
    const body = {
      name: "External agent",
      adapterType: "codex_local",
      adapterConfig: {
        instructionsBundleMode: "external",
        instructionsRootPath: "/srv/paperclip/external-agent",
        instructionsEntryFile: "AGENTS.md",
      },
    };

    const hireRes = await request(app)
      .post("/api/companies/company-1/agent-hires")
      .send(body);
    expect(hireRes.status, JSON.stringify(hireRes.body)).toBe(403);
    expect(hireRes.body.error).toContain("Instance admin");

    const createRes = await request(app)
      .post("/api/companies/company-1/agents")
      .send(body);
    expect(createRes.status, JSON.stringify(createRes.body)).toBe(403);
    expect(createRes.body.error).toContain("Instance admin");
    expect(mockAgentService.create).not.toHaveBeenCalled();
  });

  it.each(["", "/file?path=AGENTS.md", "/file?path=private-support.md"])(
    "denies peer instruction reads before any data dispatch: %s", async (suffix) => {
    mockAgentService.getById.mockImplementation(async (id: string) => {
      if (id === "agent-reader") {
        return {
          ...makeAgent(),
          id: "agent-reader",
          name: "Reader",
          permissions: { canCreateAgents: false },
        };
      }
      return makeAgent();
    });
    // General agent visibility is allowed. It must not authorize instruction
    // metadata, canonical entry bytes, or supporting files from a peer.
    const { forbidden } = await vi.importActual<typeof import("../errors.js")>("../errors.js");
    mockAuthorizeInstructionRead.mockRejectedValue(forbidden("Missing permission to read peer instructions"));

    const res = await requestApp(
      await createApp({
        type: "agent",
        agentId: "agent-reader",
        companyId: "company-1",
        source: "agent_key",
      }),
      (baseUrl) => request(baseUrl)
        .get(`/api/agents/11111111-1111-4111-8111-111111111111/instructions-bundle${suffix}`),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toContain("Missing permission");
    expect(mockAuthorizeInstructionRead).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      type: "agent", agentId: "agent-reader",
    }), { companyId: "company-1", id: "11111111-1111-4111-8111-111111111111" });
    expect(mockAgentInstructionsService.getBundle).not.toHaveBeenCalled();
    expect(mockAgentInstructionsService.readFile).not.toHaveBeenCalled();
    expect(mockInstructionRevisions.readCurrent).not.toHaveBeenCalled();
    expect(mockInstructionRevisions.materializeCurrent).not.toHaveBeenCalled();
  });

  it("allows agents to read their own instructions bundles", async () => {
    const res = await requestApp(
      await createApp({
        type: "agent",
        agentId: "11111111-1111-4111-8111-111111111111",
        companyId: "company-1",
        source: "agent_key",
      }),
      (baseUrl) => request(baseUrl)
        .get("/api/agents/11111111-1111-4111-8111-111111111111/instructions-bundle"),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockAgentInstructionsService.getBundle).toHaveBeenCalled();
    expect(mockAuthorizeInstructionRead).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      type: "agent", agentId: "11111111-1111-4111-8111-111111111111",
    }), { companyId: "company-1", id: "11111111-1111-4111-8111-111111111111" });
  });

  it.each(["AGENTS.md", "private-support.md"])("allows an authorized peer to read instruction file %s", async (filePath) => {
    mockAccessService.decide.mockResolvedValue({
      allowed: true,
      reason: "allow_explicit_grant",
      explanation: "Allowed by explicit grant agents:suggest-changes.",
      grant: {
        principalType: "agent",
        principalId: "coach-agent",
        permissionKey: "agents:suggest-changes",
        scope: null,
      },
    });
    mockAgentService.getById.mockImplementation(async (id: string) => {
      if (id === "coach-agent") {
        return makeReflectionCoachAgent({ id: "coach-agent" });
      }
      return makeAgent();
    });

    const res = await requestApp(
      await createApp({
        type: "agent",
        agentId: "coach-agent",
        companyId: "company-1",
        source: "agent_key",
      }),
      (baseUrl) => request(baseUrl)
        .get("/api/agents/11111111-1111-4111-8111-111111111111/instructions-bundle/file")
        .query({ path: filePath }),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockAuthorizeInstructionRead).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      type: "agent", agentId: "coach-agent",
    }), { companyId: "company-1", id: "11111111-1111-4111-8111-111111111111" });
    expect(mockAgentInstructionsService.readFile).toHaveBeenCalledWith(
      expect.objectContaining({ id: "11111111-1111-4111-8111-111111111111" }),
      filePath,
    );
  });

  it("commits entry bytes through the canonical service with the authenticated actor", async () => {
    const res = await requestApp(await createApp(), (baseUrl) => request(baseUrl)
      .put("/api/agents/11111111-1111-4111-8111-111111111111/instructions-bundle/file?companyId=company-1")
      .send({ path: "AGENTS.md", content: "# Updated Agent\n", baseRevisionId: null }));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockInstructionRevisions.commit).toHaveBeenCalledWith(expect.objectContaining({
      agentId: "11111111-1111-4111-8111-111111111111", entryFile: "AGENTS.md", content: "# Updated Agent\n", baseRevisionId: null, source: "board",
    }), expect.objectContaining({ type: "board" }));
    expect(mockAgentInstructionsService.writeFile).not.toHaveBeenCalled();
    expect(res.body.receipt.revision.id).toBe("33333333-3333-4333-8333-333333333333");
  });

  it("returns committed entry content independently of its disk copy", async () => {
    mockInstructionRevisions.readCurrent.mockResolvedValue({ revision: { id: "33333333-3333-4333-8333-333333333333", entryFile: "AGENTS.md", byteLength: 9 }, content: "committed" });
    const res = await requestApp(await createApp(), (baseUrl) => request(baseUrl)
      .get("/api/agents/11111111-1111-4111-8111-111111111111/instructions-bundle/file?path=AGENTS.md"));
    expect(res.status).toBe(200);
    expect(res.body.content).toBe("committed");
    expect(res.body.revision.id).toBe("33333333-3333-4333-8333-333333333333");
    expect(mockAgentInstructionsService.readFile).not.toHaveBeenCalled();
  });

  it.each([Buffer.from([0, 255, 128, 17]), Buffer.alloc(0)])("streams an authorized binary download without text conversion (%j)", async bytes => {
    mockAgentService.getById.mockResolvedValue({ ...makeAgent(), adapterConfig: { instructionsBundleMode: "managed" } });
    mockDownloadAgentFile.mockResolvedValue({ size: bytes.length, stream: Readable.from(bytes.length ? [bytes] : []) });
    const res = await requestApp(await createApp(), url => request(url)
      .get("/api/agents/11111111-1111-4111-8111-111111111111/instructions-bundle/file")
      .query({ path: "notes/data.bin", download: "true" }));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual(bytes);
    expect(res.headers["content-length"]).toBe(String(bytes.length));
    expect(res.headers["content-disposition"]).toContain('filename="data.bin"');
    expect(mockDownloadAgentFile).toHaveBeenCalledWith("company-1", "11111111-1111-4111-8111-111111111111", "notes/data.bin", expect.objectContaining({ type: "board" }));
    expect(mockAgentInstructionsService.readFile).not.toHaveBeenCalled();
  });

  it("lists and resolves preserved edits with server scope, actor, and explicit revision", async () => {
    const app = await createApp();
    const runId = "55555555-5555-4555-8555-555555555555";
    const baseRevisionId = "44444444-4444-4444-8444-444444444444";
    const prefix = "/api/agents/11111111-1111-4111-8111-111111111111/instructions-bundle/candidates";
    mockInstructionWorkingCopies.list.mockResolvedValue([{ runId, entryFile: "AGENTS.md", state: "conflict", content: "preserved" }]);
    mockInstructionWorkingCopies.resolve.mockResolvedValue({ revision: { id: baseRevisionId, entryFile: "AGENTS.md", byteLength: 8 }, content: "resolved", changed: true, materialization: "current" });
    const listed = await requestApp(app, (url) => request(url).get(prefix));
    expect(listed.status).toBe(200);
    expect(listed.body).toEqual([{ runId, entryFile: "AGENTS.md", state: "conflict", content: "preserved" }]);
    expect(mockInstructionWorkingCopies.list).toHaveBeenCalledWith("company-1", "11111111-1111-4111-8111-111111111111", expect.objectContaining({ type: "board", userId: "local-board" }));
    const resolved = await requestApp(app, (url) => request(url).post(`${prefix}/${runId}/resolve`).send({ baseRevisionId, content: "resolved" }));
    expect(resolved.status).toBe(200);
    expect(resolved.body).toMatchObject({ content: "resolved", receipt: { changed: true } });
    expect(mockInstructionWorkingCopies.resolve).toHaveBeenCalledWith({ companyId: "company-1", agentId: "11111111-1111-4111-8111-111111111111", runId, baseRevisionId, content: "resolved" }, expect.objectContaining({ type: "board", userId: "local-board" }));
    for (const body of [{ content: "missing base" }, { baseRevisionId, content: "forged", responsibleUserId: "other" }, { baseRevisionId, content: "forged", entryFile: "other.md" }]) {
      expect((await requestApp(app, (url) => request(url).post(`${prefix}/${runId}/resolve`).send(body))).status).toBe(400);
    }
    expect(mockInstructionWorkingCopies.resolve).toHaveBeenCalledOnce();
  });

  it("exposes scoped history, diff and restore with the server actor", async () => {
    const app = await createApp();
    const revisionId = "33333333-3333-4333-8333-333333333333";
    const baseRevisionId = "44444444-4444-4444-8444-444444444444";
    const prefix = "/api/agents/11111111-1111-4111-8111-111111111111/instructions-bundle";
    mockInstructionRevisions.history.mockResolvedValue({ revisions: [], nextCursor: null });
    mockInstructionRevisions.diff.mockResolvedValue({ removed: "old", added: "new" });
    mockInstructionRevisions.restore.mockResolvedValue({ revision: { id: revisionId, entryFile: "AGENTS.md", byteLength: 3 }, content: "old", changed: true, materialization: "current" });
    expect((await requestApp(app, (url) => request(url).get(`${prefix}/history?path=AGENTS.md`))).status).toBe(200);
    expect((await requestApp(app, (url) => request(url).get(`${prefix}/diff?path=AGENTS.md&from=${revisionId}&to=${baseRevisionId}`))).status).toBe(200);
    const restored = await requestApp(app, (url) => request(url).post(`${prefix}/restore`).send({ path: "AGENTS.md", revisionId, baseRevisionId }));
    expect(restored.status).toBe(200);
    expect(restored.body.receipt.changed).toBe(true);
    expect(mockInstructionRevisions.restore).toHaveBeenCalledWith({ companyId: "company-1", agentId: "11111111-1111-4111-8111-111111111111", entryFile: "AGENTS.md", revisionId, baseRevisionId }, expect.objectContaining({ type: "board", userId: "local-board" }));
  });

  it("requires a base revision and rejects client-supplied responsible identity", async () => {
    const app = await createApp();
    for (const body of [ { path: "AGENTS.md", content: "stale" }, { path: "AGENTS.md", content: "forged", baseRevisionId: null, responsibleUserId: "forged" } ]) {
      const res = await requestApp(app, (baseUrl) => request(baseUrl)
        .put("/api/agents/11111111-1111-4111-8111-111111111111/instructions-bundle/file").send(body));
      expect([400, 422]).toContain(res.status);
    }
    expect(mockInstructionRevisions.commit).not.toHaveBeenCalled();
  });

  it("preserves managed instructions config when switching adapters", async () => {
    mockAgentService.getById.mockResolvedValue({
      ...makeAgent(),
      adapterType: "codex_local",
      adapterConfig: {
        instructionsBundleMode: "managed",
        instructionsRootPath: "/tmp/agent-1",
        instructionsEntryFile: "AGENTS.md",
        instructionsFilePath: "/tmp/agent-1/AGENTS.md",
        model: "gpt-5.4",
      },
    });

    const res = await requestApp(await createApp(), (baseUrl) => request(baseUrl)
      .patch("/api/agents/11111111-1111-4111-8111-111111111111?companyId=company-1")
      .send({
        adapterType: "claude_local",
        adapterConfig: {
          model: "claude-sonnet-4",
        },
      }));

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockAgentService.update).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({
        adapterType: "claude_local",
        adapterConfig: expect.objectContaining({
          model: "claude-sonnet-4",
          instructionsBundleMode: "managed",
          instructionsRootPath: "/tmp/agent-1",
          instructionsEntryFile: "AGENTS.md",
          instructionsFilePath: "/tmp/agent-1/AGENTS.md",
        }),
      }),
      expect.any(Object),
    );
  });

  it("preserves paperclip skill-sync selections when switching adapters", async () => {
    // Desired skills live inside the per-adapter config under
    // `paperclipSkillSync`, yet they are adapter-agnostic company-level
    // selections. Switching adapter type must not silently wipe them — the
    // server carries them over from the existing config the same way it
    // preserves env/cwd and the instructions bundle.
    mockAgentService.getById.mockResolvedValue({
      ...makeAgent(),
      adapterType: "claude_local",
      adapterConfig: {
        model: "claude-sonnet-4",
        paperclipSkillSync: { desiredSkills: ["research", "code-review"] },
      },
    });

    const res = await requestApp(await createApp(), (baseUrl) => request(baseUrl)
      .patch("/api/agents/11111111-1111-4111-8111-111111111111?companyId=company-1")
      .send({
        adapterType: "codex_local",
        replaceAdapterConfig: true,
        adapterConfig: {
          model: "gpt-5.4",
        },
      }));

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockAgentService.update).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({
        adapterType: "codex_local",
        adapterConfig: expect.objectContaining({
          model: "gpt-5.4",
          paperclipSkillSync: { desiredSkills: ["research", "code-review"] },
        }),
      }),
      expect.any(Object),
    );
  });

  it("merges same-adapter config patches so instructions metadata is not dropped", async () => {
    mockAgentService.getById.mockResolvedValue({
      ...makeAgent(),
      adapterType: "codex_local",
      adapterConfig: {
        instructionsBundleMode: "managed",
        instructionsRootPath: "/tmp/agent-1",
        instructionsEntryFile: "AGENTS.md",
        instructionsFilePath: "/tmp/agent-1/AGENTS.md",
        model: "gpt-5.4",
      },
    });

    const res = await requestApp(await createApp(), (baseUrl) => request(baseUrl)
      .patch("/api/agents/11111111-1111-4111-8111-111111111111?companyId=company-1")
      .send({
        adapterConfig: {
          command: "codex --profile engineer",
        },
      }));

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockAgentService.update).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({
        adapterConfig: expect.objectContaining({
          command: "codex --profile engineer",
          model: "gpt-5.4",
          instructionsBundleMode: "managed",
          instructionsRootPath: "/tmp/agent-1",
          instructionsEntryFile: "AGENTS.md",
          instructionsFilePath: "/tmp/agent-1/AGENTS.md",
        }),
      }),
      expect.any(Object),
    );
  });

  it("replaces adapter config when replaceAdapterConfig is true", async () => {
    mockAgentService.getById.mockResolvedValue({
      ...makeAgent(),
      adapterType: "codex_local",
      adapterConfig: {
        instructionsBundleMode: "managed",
        instructionsRootPath: "/tmp/agent-1",
        instructionsEntryFile: "AGENTS.md",
        instructionsFilePath: "/tmp/agent-1/AGENTS.md",
        model: "gpt-5.4",
      },
    });

    const res = await requestApp(await createApp(), (baseUrl) => request(baseUrl)
      .patch("/api/agents/11111111-1111-4111-8111-111111111111?companyId=company-1")
      .send({
        replaceAdapterConfig: true,
        adapterConfig: {
          command: "codex --profile engineer",
        },
      }));

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.adapterConfig).toMatchObject({
      command: "codex --profile engineer",
    });
    expect(res.body.adapterConfig.instructionsBundleMode).toBeUndefined();
    expect(res.body.adapterConfig.instructionsRootPath).toBeUndefined();
    expect(res.body.adapterConfig.instructionsEntryFile).toBeUndefined();
    expect(res.body.adapterConfig.instructionsFilePath).toBeUndefined();
  });

  describe("instruction file writes across bundle mode transitions", () => {
    const agentId = "11111111-1111-4111-8111-111111111111";
    const filePath = `/api/agents/${agentId}/instructions-bundle/file`;
    const baseHash = "a".repeat(64);
    const externalAgent = () => ({ ...makeAgent(), adapterConfig: {
      instructionsBundleMode: "external", instructionsRootPath: "/srv/paperclip/external-agent", instructionsEntryFile: "AGENTS.md",
    } });
    const managedAgent = () => ({ ...makeAgent(), adapterConfig: { instructionsBundleMode: "managed", instructionsEntryFile: "AGENTS.md" } });
    const externalTarget = { mode: "external", rootPath: "/srv/paperclip/external-agent" };
    const externalModeRejection = () => Object.assign(new Error("External instructions must be migrated to managed storage first"), { status: 422 });

    beforeEach(() => {
      mockAgentFileWrite.mockReset();
      mockAgentInstructionsService.deleteFile.mockResolvedValue({ bundle: { files: [] }, adapterConfig: externalAgent().adapterConfig });
    });

    it("routes a non-entry save with baseHash through the managed path after the bundle became external", async () => {
      mockAgentService.getById.mockResolvedValue(externalAgent());
      const { HttpError } = await vi.importActual<typeof import("../errors.js")>("../errors.js");
      mockAgentFileWrite.mockRejectedValue(new HttpError(422, externalModeRejection().message));
      const res = await requestApp(await createApp(), url => request(url).put(filePath)
        .send({ path: "notes/plan.md", content: "draft\n", baseHash }));
      expect(res.status, JSON.stringify(res.body)).toBe(422);
      expect(res.body.error).toContain("External instructions must be migrated");
      expect(mockAgentFileWrite).toHaveBeenCalledOnce();
      expect(mockAgentFileWrite).toHaveBeenCalledWith(expect.objectContaining({ agentId, path: "notes/plan.md", baseHash }), expect.objectContaining({ type: "board" }),
        expect.objectContaining({ allowRecoveredManaged: true, repairConfig: expect.any(Function) }));
      expect(mockAgentInstructionsService.writeFile).not.toHaveBeenCalled();
      expect(mockAgentService.update).not.toHaveBeenCalled();
      expect(mockLogActivity).not.toHaveBeenCalled();
    });

    it("treats an explicit null baseHash as base-bearing and an omitted one as not", async () => {
      mockAgentService.getById.mockResolvedValue(externalAgent());
      const { HttpError } = await vi.importActual<typeof import("../errors.js")>("../errors.js");
      mockAgentFileWrite.mockRejectedValue(new HttpError(422, externalModeRejection().message));
      const withNull = await requestApp(await createApp(), url => request(url).put(filePath)
        .send({ path: "notes/new.md", content: "new\n", baseHash: null }));
      expect(withNull.status, JSON.stringify(withNull.body)).toBe(422);
      expect(mockAgentFileWrite).toHaveBeenCalledWith(expect.objectContaining({ path: "notes/new.md", baseHash: null }), expect.anything(), expect.anything());
      expect(mockAgentInstructionsService.writeFile).not.toHaveBeenCalled();

      mockAgentFileWrite.mockClear();
      const omitted = await requestApp(await createApp(), url => request(url).put(filePath)
        .send({ path: "notes/new.md", content: "new\n" }));
      expect(omitted.status, JSON.stringify(omitted.body)).toBe(200);
      expect(mockAgentFileWrite).not.toHaveBeenCalled();
      expect(mockAgentInstructionsService.writeFile).toHaveBeenCalledWith(expect.objectContaining({ id: agentId }), "notes/new.md", "new\n",
        { clearLegacyPromptTemplate: false, expectedMode: "external", expectedTarget: externalTarget, persistConfig: expect.any(Function) });
    });

    it("keeps external saves without baseHash on the external path, guarded by the expected mode", async () => {
      mockAgentService.getById.mockResolvedValue(externalAgent());
      const res = await requestApp(await createApp(), url => request(url).put(filePath)
        .send({ path: "notes/plan.md", content: "external\n" }));
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(mockAgentInstructionsService.writeFile).toHaveBeenCalledOnce();
      expect(mockAgentInstructionsService.writeFile.mock.calls[0]![3]).toEqual({ clearLegacyPromptTemplate: false, expectedMode: "external", expectedTarget: externalTarget, persistConfig: expect.any(Function) });
      expect(mockAgentFileWrite).not.toHaveBeenCalled();
      expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "agent.instructions_file_updated" }));
    });

    it("returns the conflict and records nothing when the bundle became managed under the lock", async () => {
      mockAgentService.getById.mockResolvedValue(externalAgent());
      const { conflict } = await vi.importActual<typeof import("../errors.js")>("../errors.js");
      mockAgentInstructionsService.writeFile.mockRejectedValueOnce(conflict("The instructions bundle mode changed; reload and retry"));
      mockAgentInstructionsService.deleteFile.mockRejectedValueOnce(conflict("The instructions bundle mode changed; reload and retry"));
      const put = await requestApp(await createApp(), url => request(url).put(filePath).send({ path: "notes/plan.md", content: "x\n" }));
      expect(put.status, JSON.stringify(put.body)).toBe(409);
      const del = await requestApp(await createApp(), url => request(url).delete(filePath).query({ path: "notes/plan.md" }));
      expect(del.status, JSON.stringify(del.body)).toBe(409);
      expect(mockAgentService.update).not.toHaveBeenCalled();
      expect(mockLogActivity).not.toHaveBeenCalled();
    });

    it("passes the external expected mode to external deletes", async () => {
      mockAgentService.getById.mockResolvedValue(externalAgent());
      const res = await requestApp(await createApp(), url => request(url).delete(filePath).query({ path: "notes/plan.md" }));
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(mockAgentInstructionsService.deleteFile).toHaveBeenCalledWith(expect.objectContaining({ id: agentId }), "notes/plan.md", { expectedMode: "external", expectedTarget: externalTarget });
      expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "agent.instructions_file_deleted" }));
    });

    it("leaves the legacy pseudo-file on its existing path without an expected mode", async () => {
      mockAgentService.getById.mockResolvedValue(managedAgent());
      const res = await requestApp(await createApp(), url => request(url).put(filePath)
        .send({ path: "promptTemplate.legacy.md", content: "legacy\n", baseHash }));
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(mockAgentFileWrite).not.toHaveBeenCalled();
      expect(mockAgentInstructionsService.writeFile).toHaveBeenCalledWith(expect.objectContaining({ id: agentId }), "promptTemplate.legacy.md", "legacy\n",
        { clearLegacyPromptTemplate: false, expectedMode: undefined, expectedTarget: undefined, persistConfig: expect.any(Function) });
    });

    it("still requires baseHash for managed non-entry saves", async () => {
      mockAgentService.getById.mockResolvedValue(managedAgent());
      const res = await requestApp(await createApp(), url => request(url).put(filePath).send({ path: "notes/plan.md", content: "x\n" }));
      expect(res.status, JSON.stringify(res.body)).toBe(422);
      expect(mockAgentFileWrite).not.toHaveBeenCalled();
      expect(mockAgentInstructionsService.writeFile).not.toHaveBeenCalled();
    });

    it("keeps entry-file saves on the canonical commit even with baseHash", async () => {
      mockAgentService.getById.mockResolvedValue(externalAgent());
      const { HttpError } = await vi.importActual<typeof import("../errors.js")>("../errors.js");
      mockInstructionRevisions.commit.mockRejectedValueOnce(new HttpError(422, "External host instructions do not support revision write-back."));
      const res = await requestApp(await createApp(), url => request(url).put(filePath).send({ path: "AGENTS.md", content: "x\n", baseHash }));
      expect(res.status, JSON.stringify(res.body)).toBe(422);
      expect(mockInstructionRevisions.commit).toHaveBeenCalledOnce();
      expect(mockAgentFileWrite).not.toHaveBeenCalled();
      expect(mockAgentInstructionsService.writeFile).not.toHaveBeenCalled();
    });

    it("still requires instance admin before any external write path, including base-bearing saves", async () => {
      mockAgentService.getById.mockResolvedValue(externalAgent());
      const app = await createApp({ type: "board", userId: "company-admin", companyIds: ["company-1"],
        memberships: [{ companyId: "company-1", status: "active", membershipRole: "admin" }], source: "session", isInstanceAdmin: false });
      for (const perform of [
        () => request(app).put(filePath).send({ path: "notes/plan.md", content: "x\n", baseHash }),
        () => request(app).put(filePath).send({ path: "notes/plan.md", content: "x\n", baseHash: null }),
        () => request(app).put(filePath).send({ path: "notes/plan.md", content: "x\n" }),
        () => request(app).delete(filePath).query({ path: "notes/plan.md" }),
      ]) {
        const res = await perform();
        expect(res.status, JSON.stringify(res.body)).toBe(403);
      }
      expect(mockAgentFileWrite).not.toHaveBeenCalled();
      expect(mockAgentInstructionsService.writeFile).not.toHaveBeenCalled();
      expect(mockAgentInstructionsService.deleteFile).not.toHaveBeenCalled();
    });

    describe("recovered-managed bundles (managed files on disk at the canonical managed root)", () => {
      const previousHome = process.env.PAPERCLIP_HOME;
      let home: string;
      let managedRoot: string;
      const staleRoot = "/srv/paperclip/moved-instance/instructions";
      const b3Agent = () => ({ ...makeAgent(), adapterConfig: { instructionsBundleMode: "managed", instructionsRootPath: staleRoot, instructionsEntryFile: "AGENTS.md" } });
      const b2Agent = () => ({ ...makeAgent(), adapterConfig: { instructionsRootPath: staleRoot, instructionsEntryFile: "AGENTS.md" } });
      const a2Agent = () => ({ ...makeAgent(), adapterConfig: {} });
      const nonAdmin = () => ({ type: "board", userId: "company-admin", companyIds: ["company-1"],
        memberships: [{ companyId: "company-1", status: "active", membershipRole: "admin" }], source: "session", isInstanceAdmin: false });

      beforeEach(async () => {
        home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "recovered-routes-")));
        process.env.PAPERCLIP_HOME = home;
        const { resolveManagedInstructionsRoot } = await vi.importActual<typeof import("../services/agent-instructions.js")>("../services/agent-instructions.js");
        managedRoot = resolveManagedInstructionsRoot(makeAgent());
        await fs.mkdir(path.join(managedRoot, "notes"), { recursive: true });
        await fs.writeFile(path.join(managedRoot, "AGENTS.md"), "SENTINEL-ROUTE-ENTRY\n");
        await fs.writeFile(path.join(managedRoot, "notes/plan.md"), "SENTINEL-ROUTE-NOTE\n");
        mockAgentFileWrite.mockResolvedValue({ contentHash: "b".repeat(64), changed: true });
        mockAgentInstructionsService.readFile.mockResolvedValue({ path: "notes/plan.md", content: "x\n" });
        mockAgentInstructionsService.getBundle.mockResolvedValue({ files: [] });
      });
      afterEach(async () => {
        if (previousHome === undefined) delete process.env.PAPERCLIP_HOME; else process.env.PAPERCLIP_HOME = previousHome;
        await fs.rm(home, { recursive: true, force: true });
      });

      it("routes B2/B3 base-bearing saves to the store with recovery allowed and a repair callback", async () => {
        for (const agent of [b3Agent(), b2Agent()]) {
          mockAgentFileWrite.mockClear();
          mockAgentService.getById.mockResolvedValue(agent);
          const res = await requestApp(await createApp(), url => request(url).put(filePath).send({ path: "notes/plan.md", content: "x\n", baseHash }));
          expect(res.status, JSON.stringify(res.body)).toBe(200);
          expect(mockAgentFileWrite).toHaveBeenCalledWith(expect.objectContaining({ path: "notes/plan.md", baseHash }), expect.anything(),
            expect.objectContaining({ allowRecoveredManaged: true, repairConfig: expect.any(Function) }));
        }
        expect(mockAgentInstructionsService.writeFile).not.toHaveBeenCalled();
      });

      it("routes an A2 base-bearing save to the store without the stale-root allowance", async () => {
        mockAgentService.getById.mockResolvedValue(a2Agent());
        const res = await requestApp(await createApp(nonAdmin()), url => request(url).put(filePath).send({ path: "notes/plan.md", content: "x\n", baseHash }));
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        expect(mockAgentFileWrite).toHaveBeenCalledWith(expect.anything(), expect.anything(),
          expect.objectContaining({ allowRecoveredManaged: false, repairConfig: expect.any(Function) }));
      });

      it("keeps the instance-admin gate for B2/B3 saves and deletes", async () => {
        for (const agent of [b3Agent(), b2Agent()]) {
          mockAgentService.getById.mockResolvedValue(agent);
          const app = await createApp(nonAdmin());
          for (const perform of [
            () => request(app).put(filePath).send({ path: "notes/plan.md", content: "x\n", baseHash }),
            () => request(app).put(filePath).send({ path: "notes/plan.md", content: "x\n" }),
            () => request(app).delete(filePath).query({ path: "notes/plan.md", baseHash }),
            () => request(app).delete(filePath).query({ path: "notes/plan.md" }),
          ]) {
            expect((await perform()).status).toBe(403);
          }
        }
        expect(mockAgentFileWrite).not.toHaveBeenCalled();
        expect(mockAgentInstructionsService.writeFile).not.toHaveBeenCalled();
        expect(mockAgentInstructionsService.deleteFile).not.toHaveBeenCalled();
      });

      it("routes A2/B2/B3 deletes with a base to the store, and without one to the guarded unversioned path", async () => {
        for (const [agent, allowRecoveredManaged] of [[a2Agent(), false], [b2Agent(), true], [b3Agent(), true]] as const) {
          mockAgentFileWrite.mockClear();
          mockAgentInstructionsService.deleteFile.mockClear();
          mockAgentService.getById.mockResolvedValue(agent);
          const withBase = await requestApp(await createApp(), url => request(url).delete(filePath).query({ path: "notes/plan.md", baseHash }));
          expect(withBase.status, JSON.stringify(withBase.body)).toBe(200);
          expect(mockAgentFileWrite).toHaveBeenCalledWith(expect.objectContaining({ path: "notes/plan.md", bytes: null, baseHash }), expect.anything(),
            { allowRecoveredManaged });
          expect(mockAgentInstructionsService.deleteFile).not.toHaveBeenCalled();

          mockAgentFileWrite.mockClear();
          const withoutBase = await requestApp(await createApp(), url => request(url).delete(filePath).query({ path: "notes/plan.md" }));
          expect(withoutBase.status, JSON.stringify(withoutBase.body)).toBe(200);
          expect(mockAgentFileWrite).not.toHaveBeenCalled();
          expect(mockAgentInstructionsService.deleteFile).toHaveBeenCalledWith(expect.objectContaining({ id: agentId }), "notes/plan.md",
            { expectedMode: "external", expectedTarget: { mode: "managed", rootPath: managedRoot } });
        }
      });

      it("keeps explicit-external and other-root deletes with a base on the external path", async () => {
        await fs.rm(managedRoot, { recursive: true, force: true });
        const otherRoot = { ...makeAgent(), adapterConfig: { instructionsRootPath: "/srv/paperclip/other-root", instructionsEntryFile: "AGENTS.md" } };
        // C2 (another root, no persisted mode) keeps its null effective mode in the target.
        for (const [agent, mode, rootPath] of [[externalAgent(), "external", "/srv/paperclip/external-agent"], [otherRoot, null, "/srv/paperclip/other-root"]] as const) {
          mockAgentInstructionsService.deleteFile.mockClear();
          mockAgentService.getById.mockResolvedValue(agent);
          const res = await requestApp(await createApp(), url => request(url).delete(filePath).query({ path: "notes/plan.md", baseHash }));
          expect(res.status, JSON.stringify(res.body)).toBe(200);
          expect(mockAgentInstructionsService.deleteFile).toHaveBeenCalledWith(expect.objectContaining({ id: agentId }), "notes/plan.md",
            { expectedMode: "external", expectedTarget: { mode, rootPath } });
        }
        expect(mockAgentFileWrite).not.toHaveBeenCalled();
      });

      it("keeps explicit-external deletes with a base on the external path even when managed files exist", async () => {
        mockAgentService.getById.mockResolvedValue(externalAgent());
        const res = await requestApp(await createApp(), url => request(url).delete(filePath).query({ path: "notes/plan.md", baseHash }));
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        expect(mockAgentFileWrite).not.toHaveBeenCalled();
        expect(mockAgentInstructionsService.deleteFile).toHaveBeenCalledOnce();
      });

      it("passes the recovered managed target to a no-base save so a concurrent switch is refused", async () => {
        mockAgentService.getById.mockResolvedValue(b3Agent());
        mockAgentInstructionsService.writeFile.mockResolvedValue({ file: { path: "notes/plan.md", size: 2 }, adapterConfig: b3Agent().adapterConfig });
        const res = await requestApp(await createApp(), url => request(url).put(filePath).send({ path: "notes/plan.md", content: "x\n" }));
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        expect(mockAgentInstructionsService.writeFile.mock.calls[0]![3]).toEqual({ clearLegacyPromptTemplate: false, expectedMode: "external",
          expectedTarget: { mode: "managed", rootPath: managedRoot }, persistConfig: expect.any(Function) });
      });

      it("repairs configuration through secret normalization and the agent-service update with a config revision", async () => {
        mockAgentService.getById.mockResolvedValue(b3Agent());
        await requestApp(await createApp(), url => request(url).put(filePath).send({ path: "notes/plan.md", content: "x\n", baseHash }));
        const repair = mockAgentFileWrite.mock.calls[0]![2].repairConfig as (tx: unknown, agent: unknown, config: Record<string, unknown>) => Promise<void>;
        mockAgentService.update.mockClear();
        mockSecretService.normalizeAdapterConfigForPersistence.mockClear();
        mockSecretServiceFactory.mockClear();
        const repaired = { instructionsBundleMode: "managed", instructionsRootPath: managedRoot };
        const tx = { storeTransaction: true };
        await repair(tx, { ...b3Agent(), adapterType: "codex_local" }, repaired);
        // R1: normalization runs on a secret service built on the store's own
        // transaction object, not on the router's global connection.
        expect(mockSecretServiceFactory).toHaveBeenCalledTimes(1);
        expect(mockSecretServiceFactory.mock.calls[0]![0]).toBe(tx);
        expect(mockSecretService.normalizeAdapterConfigForPersistence).toHaveBeenCalledTimes(1);
        expect(mockSecretService.normalizeAdapterConfigForPersistence).toHaveBeenCalledWith("company-1", repaired,
          { strictMode: false, adapterType: "codex_local" });
        expect(mockAgentService.update).toHaveBeenCalledWith(agentId, { adapterConfig: repaired },
          { recordRevision: expect.objectContaining({ source: "instructions_bundle_file_put", createdByUserId: "local-board" }), instructionConfigWrite: { keys: "all" } });
        expect(mockLogActivity).not.toHaveBeenCalled();
      });
    });
  });

  describe("locked instructions bundle PATCH, path PATCH and legacy clear", () => {
    const agentId = "11111111-1111-4111-8111-111111111111";
    const bundlePath = `/api/agents/${agentId}/instructions-bundle`;
    const managedConfig = { instructionsBundleMode: "managed", instructionsEntryFile: "AGENTS.md" };
    const sessionBoard = (isInstanceAdmin: boolean) => ({ type: "board", userId: "company-admin", companyIds: ["company-1"],
      memberships: [{ companyId: "company-1", status: "active", membershipRole: "admin" }], source: "session", isInstanceAdmin });
    /** A db whose transaction hands out a tx that locks and returns `locked`. */
    const lockingDb = (locked: () => Record<string, unknown> | undefined) => {
      const forUpdate = vi.fn(async () => (locked() ? [locked()] : []));
      const tx = { select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(() => ({ for: forUpdate })) })) })) };
      return { db: { transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(tx)) }, tx, forUpdate };
    };

    beforeEach(() => {
      mockAgentService.getById.mockResolvedValue({ ...makeAgent(), adapterConfig: managedConfig });
      mockAgentInstructionsService.updateBundle.mockResolvedValue({
        bundle: { mode: "managed", rootPath: null, entryFile: "AGENTS.md", files: [] }, adapterConfig: managedConfig });
    });

    it("W1: passes the authorized target, config-only mode, a persist callback and the actor to the locked service", async () => {
      const res = await requestApp(await createApp(), url => request(url).patch(bundlePath).send({ clearLegacyPromptTemplate: true }));
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(mockAgentInstructionsService.updateBundle).toHaveBeenCalledOnce();
      const [agent, body, options] = mockAgentInstructionsService.updateBundle.mock.calls[0]!;
      expect(agent).toMatchObject({ id: agentId });
      expect(body).toEqual({ clearLegacyPromptTemplate: true });
      expect(options).toEqual({ expectedTarget: expect.objectContaining({ mode: "managed" }), expectedConfigMode: "managed",
        persist: expect.any(Function), isInstanceAdmin: true, actor: { actorType: "user", actorId: "local-board", runId: null } });
      expect(mockAgentService.update).not.toHaveBeenCalled();
      expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "agent.instructions_bundle_updated" }));
    });

    it("W1: the persist callback normalizes and updates on the locked transaction with the bundle PATCH source", async () => {
      await requestApp(await createApp(), url => request(url).patch(bundlePath).send({ clearLegacyPromptTemplate: true }));
      const persist = mockAgentInstructionsService.updateBundle.mock.calls[0]![2].persist as (tx: unknown, agent: unknown, config: Record<string, unknown>) => Promise<void>;
      mockSecretServiceFactory.mockClear();
      const tx = { bundleTransaction: true };
      await persist(tx, { ...makeAgent(), adapterConfig: managedConfig }, { ...managedConfig, instructionsRootPath: "/x" });
      expect(mockSecretServiceFactory).toHaveBeenCalledTimes(1);
      expect(mockSecretServiceFactory.mock.calls[0]![0]).toBe(tx);
      expect(mockAgentService.update).toHaveBeenCalledWith(agentId, { adapterConfig: { ...managedConfig, instructionsRootPath: "/x" } },
        { recordRevision: expect.objectContaining({ source: "instructions_bundle_patch", createdByUserId: "local-board" }), instructionConfigWrite: { keys: "all" } });
    });

    it("never takes the instance-admin flag from the request body, query or headers", async () => {
      const app = await createApp(sessionBoard(false));
      const res = await requestApp(app, url => request(url).patch(`${bundlePath}?isInstanceAdmin=true&admin=1`)
        .set("x-paperclip-instance-admin", "true").set("x-instance-admin", "true")
        .send({ clearLegacyPromptTemplate: true, isInstanceAdmin: true, admin: true }));
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(mockAgentInstructionsService.updateBundle.mock.calls[0]![2].isInstanceAdmin).toBe(false);
      expect(mockAgentInstructionsService.updateBundle.mock.calls[0]![1]).toEqual({ clearLegacyPromptTemplate: true });
      mockAgentInstructionsService.updateBundle.mockClear();
      await requestApp(await createApp(sessionBoard(true)), url => request(url).patch(bundlePath).send({ clearLegacyPromptTemplate: true }));
      expect(mockAgentInstructionsService.updateBundle.mock.calls[0]![2].isInstanceAdmin).toBe(true);
    });

    it("returns the service's copy 409 unchanged and records no activity", async () => {
      const { conflict } = await vi.importActual<typeof import("../errors.js")>("../errors.js");
      mockAgentInstructionsService.updateBundle.mockRejectedValueOnce(conflict(
        "A previous instructions copy for this agent did not finish. An instance administrator must resolve it.", { code: "INSTRUCTION_BUNDLE_COPY_INCOMPLETE" }));
      const res = await requestApp(await createApp(sessionBoard(false)), url => request(url).patch(bundlePath).send({ clearLegacyPromptTemplate: true }));
      expect(res.status, JSON.stringify(res.body)).toBe(409);
      expect(JSON.stringify(res.body)).toContain("INSTRUCTION_BUNDLE_COPY_INCOMPLETE");
      expect(mockAgentService.update).not.toHaveBeenCalled();
      expect(mockLogActivity).not.toHaveBeenCalled();
    });

    it("W4: the instructions-path PATCH locks the row, normalizes on the transaction and refuses a changed bundle", async () => {
      const existing = { ...makeAgent(), adapterConfig: managedConfig };
      mockAgentService.getById.mockResolvedValue(existing);
      let locked: Record<string, unknown> | undefined = existing;
      const { db, tx, forUpdate } = lockingDb(() => locked);
      const pathUrl = `/api/agents/${agentId}/instructions-path`;
      const ok = await requestApp(await createApp(boardActor(), db), url => request(url).patch(pathUrl).send({ path: "/srv/paperclip/prompts/AGENTS.md" }));
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
      expect(forUpdate).toHaveBeenCalledOnce();
      // The new root is checked for copy records on the locked transaction.
      expect(mockAgentInstructionsService.assertNoCopyIntentForRoot).toHaveBeenCalledWith(tx, expect.objectContaining({ id: agentId }), "/srv/paperclip/prompts", true);
      expect(mockSecretServiceFactory.mock.calls.some((call) => call[0] === tx)).toBe(true);
      expect(mockAgentService.update).toHaveBeenCalledWith(agentId, expect.anything(),
        { recordRevision: expect.objectContaining({ source: "instructions_path_patch" }), instructionConfigWrite: { keys: "all" } });
      mockAgentService.update.mockClear();
      mockLogActivity.mockClear();
      locked = { ...existing, adapterConfig: { instructionsBundleMode: "external", instructionsRootPath: "/srv/paperclip/elsewhere", instructionsEntryFile: "AGENTS.md" } };
      const refused = await requestApp(await createApp(boardActor(), db), url => request(url).patch(pathUrl).send({ path: "/srv/paperclip/prompts/AGENTS.md" }));
      expect(refused.status, JSON.stringify(refused.body)).toBe(409);
      expect(refused.body.error).toBe("The instructions bundle mode changed; reload and retry");
      expect(mockAgentService.update).not.toHaveBeenCalled();
      expect(mockLogActivity).not.toHaveBeenCalled();
    });

    it("W4: a copy 409 from the root check is returned unchanged and nothing is persisted or recorded", async () => {
      const existing = { ...makeAgent(), adapterConfig: managedConfig };
      mockAgentService.getById.mockResolvedValue(existing);
      const { conflict } = await vi.importActual<typeof import("../errors.js")>("../errors.js");
      mockAgentInstructionsService.assertNoCopyIntentForRoot.mockRejectedValueOnce(conflict(
        "A previous instructions copy for this agent did not finish. An instance administrator must resolve it.", { code: "INSTRUCTION_BUNDLE_COPY_INCOMPLETE" }));
      const { db } = lockingDb(() => existing);
      const res = await requestApp(await createApp(boardActor(), db), url => request(url).patch(`/api/agents/${agentId}/instructions-path`)
        .send({ path: "/srv/paperclip/prompts/AGENTS.md" }));
      expect(res.status, JSON.stringify(res.body)).toBe(409);
      expect(JSON.stringify(res.body)).toContain("INSTRUCTION_BUNDLE_COPY_INCOMPLETE");
      expect(mockSecretService.normalizeAdapterConfigForPersistence).not.toHaveBeenCalled();
      expect(mockAgentService.update).not.toHaveBeenCalled();
      expect(mockLogActivity).not.toHaveBeenCalled();
    });

    it("W3: the legacy prompt clear after an entry commit is a read-modify-write of the locked row", async () => {
      mockAgentService.getById.mockResolvedValue({ ...makeAgent(), adapterConfig: { ...managedConfig, promptTemplate: "old" } });
      const lockedConfig = { instructionsBundleMode: "external", instructionsRootPath: "/srv/paperclip/switched", instructionsEntryFile: "AGENTS.md",
        promptTemplate: "old", bootstrapPromptTemplate: "boot" };
      const { db, forUpdate } = lockingDb(() => ({ ...makeAgent(), adapterConfig: lockedConfig }));
      const res = await requestApp(await createApp(boardActor(), db), url => request(url).put(`${bundlePath}/file`)
        .send({ path: "AGENTS.md", content: "x\n", baseRevisionId: null, clearLegacyPromptTemplate: true }));
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(forUpdate).toHaveBeenCalledOnce();
      // The switch committed meanwhile survives: only the legacy keys are removed from the locked row.
      expect(mockAgentService.update).toHaveBeenCalledWith(agentId, { adapterConfig: {
        instructionsBundleMode: "external", instructionsRootPath: "/srv/paperclip/switched", instructionsEntryFile: "AGENTS.md" } });
    });
  });
});
