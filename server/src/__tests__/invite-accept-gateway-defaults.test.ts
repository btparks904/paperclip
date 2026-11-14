import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  companies,
  companySecretProviderConfigs,
  companySecretVersions,
  companySecrets,
  createDb,
  invites,
  joinRequests,
} from "@paperclipai/db";
import {
  buildJoinDefaultsPayloadForAccept,
  normalizeAgentDefaultsForJoin,
  prepareAgentDefaultsPayloadForJoinPersistence,
} from "../routes/access.js";
import { secretService } from "../services/secrets.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres invite accept gateway defaults tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describe("buildJoinDefaultsPayloadForAccept (openclaw_gateway)", () => {
  it("leaves non-gateway payloads unchanged", () => {
    const defaultsPayload = { command: "echo hello" };
    const result = buildJoinDefaultsPayloadForAccept({
      adapterType: "process",
      defaultsPayload,
      inboundOpenClawAuthHeader: "ignored-token",
    });

    expect(result).toEqual(defaultsPayload);
  });

  it("normalizes wrapped x-openclaw-token header", () => {
    const result = buildJoinDefaultsPayloadForAccept({
      adapterType: "openclaw_gateway",
      defaultsPayload: {
        url: "ws://127.0.0.1:18789",
        headers: {
          "x-openclaw-token": {
            value: "gateway-token-1234567890",
          },
        },
      },
    }) as Record<string, unknown>;

    expect(result).toMatchObject({
      url: "ws://127.0.0.1:18789",
      headers: {
        "x-openclaw-token": "gateway-token-1234567890",
      },
    });
  });

  it("accepts inbound x-openclaw-token for gateway joins", () => {
    const result = buildJoinDefaultsPayloadForAccept({
      adapterType: "openclaw_gateway",
      defaultsPayload: {
        url: "ws://127.0.0.1:18789",
      },
      inboundOpenClawTokenHeader: "gateway-token-1234567890",
    }) as Record<string, unknown>;

    expect(result).toMatchObject({
      headers: {
        "x-openclaw-token": "gateway-token-1234567890",
      },
    });
  });

  it("derives x-openclaw-token from authorization header", () => {
    const result = buildJoinDefaultsPayloadForAccept({
      adapterType: "openclaw_gateway",
      defaultsPayload: {
        url: "ws://127.0.0.1:18789",
        headers: {
          authorization: "Bearer gateway-token-1234567890",
        },
      },
    }) as Record<string, unknown>;

    expect(result).toMatchObject({
      headers: {
        authorization: "Bearer gateway-token-1234567890",
        "x-openclaw-token": "gateway-token-1234567890",
      },
    });
  });
});

describe("normalizeAgentDefaultsForJoin (openclaw_gateway)", () => {
  it("generates persistent device key when device auth is enabled", () => {
    const normalized = normalizeAgentDefaultsForJoin({
      adapterType: "openclaw_gateway",
      defaultsPayload: {
        url: "ws://127.0.0.1:18789",
        headers: {
          "x-openclaw-token": "gateway-token-1234567890",
        },
        disableDeviceAuth: false,
      },
      deploymentMode: "authenticated",
      deploymentExposure: "private",
      bindHost: "127.0.0.1",
      allowedHostnames: [],
    });

    expect(normalized.fatalErrors).toEqual([]);
    expect(normalized.normalized?.disableDeviceAuth).toBe(false);
    expect(typeof normalized.normalized?.devicePrivateKeyPem).toBe("string");
    expect((normalized.normalized?.devicePrivateKeyPem as string).length).toBeGreaterThan(64);
  });

  it("does not generate device key when disableDeviceAuth=true", () => {
    const normalized = normalizeAgentDefaultsForJoin({
      adapterType: "openclaw_gateway",
      defaultsPayload: {
        url: "ws://127.0.0.1:18789",
        headers: {
          "x-openclaw-token": "gateway-token-1234567890",
        },
        disableDeviceAuth: true,
      },
      deploymentMode: "authenticated",
      deploymentExposure: "private",
      bindHost: "127.0.0.1",
      allowedHostnames: [],
    });

    expect(normalized.fatalErrors).toEqual([]);
    expect(normalized.normalized?.disableDeviceAuth).toBe(true);
    expect(normalized.normalized?.devicePrivateKeyPem).toBeUndefined();
  });
});

describe("normalizeAgentDefaultsForJoin (hermes_gateway)", () => {
  it("rejects remote plain HTTP by default", () => {
    const normalized = normalizeAgentDefaultsForJoin({
      adapterType: "hermes_gateway",
      defaultsPayload: {
        apiBaseUrl: "http://192.168.1.25:8642",
        apiKey: "hermes-key-1234567890",
      },
      deploymentMode: "authenticated",
      deploymentExposure: "private",
      bindHost: "127.0.0.1",
      allowedHostnames: [],
    });

    expect(normalized.fatalErrors.join("\n")).toContain("remote plain HTTP");
    expect(normalized.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "hermes_gateway_plain_http_remote_denied",
        }),
      ]),
    );
  });

  it("allows remote plain HTTP only with the explicit unsafe flag", () => {
    const normalized = normalizeAgentDefaultsForJoin({
      adapterType: "hermes_gateway",
      defaultsPayload: {
        apiBaseUrl: "http://192.168.1.25:8642",
        apiKey: "hermes-key-1234567890",
        dangerouslyAllowInsecureRemoteHttp: true,
      },
      deploymentMode: "authenticated",
      deploymentExposure: "private",
      bindHost: "127.0.0.1",
      allowedHostnames: [],
    });

    expect(normalized.fatalErrors).toEqual([]);
    expect(normalized.normalized?.apiBaseUrl).toBe("http://192.168.1.25:8642/");
    expect(normalized.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "hermes_gateway_plain_http_remote_unsafe_allowed",
        }),
      ]),
    );
  });

  it("maps the default Hermes dashboard root to the API base path", () => {
    const normalized = normalizeAgentDefaultsForJoin({
      adapterType: "hermes_gateway",
      defaultsPayload: {
        apiBaseUrl: "http://127.0.0.1:9119",
        apiKey: "hermes-key-1234567890",
      },
      deploymentMode: "authenticated",
      deploymentExposure: "private",
      bindHost: "127.0.0.1",
      allowedHostnames: [],
    });

    expect(normalized.fatalErrors).toEqual([]);
    expect(normalized.normalized?.apiBaseUrl).toBe("http://127.0.0.1:9119/api");
    expect(normalized.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "hermes_gateway_dashboard_root_mapped",
          level: "info",
          hint: expect.stringContaining("/api/v1/runs"),
        }),
        expect.objectContaining({
          code: "hermes_gateway_api_base_url_configured",
          message: "Hermes gateway endpoint set to http://127.0.0.1:9119/api",
        }),
      ]),
    );
  });

  it("maps the default Hermes dashboard chat URL to the API base path", () => {
    const normalized = normalizeAgentDefaultsForJoin({
      adapterType: "hermes_gateway",
      defaultsPayload: {
        apiBaseUrl: "http://127.0.0.1:9119/chat",
        apiKey: "hermes-key-1234567890",
      },
      deploymentMode: "authenticated",
      deploymentExposure: "private",
      bindHost: "127.0.0.1",
      allowedHostnames: [],
    });

    expect(normalized.fatalErrors).toEqual([]);
    expect(normalized.normalized?.apiBaseUrl).toBe("http://127.0.0.1:9119/api");
    expect(normalized.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "hermes_gateway_dashboard_root_mapped",
          level: "info",
          hint: expect.stringContaining("/api/v1/runs"),
        }),
      ]),
    );
  });
});

describeEmbeddedPostgres("prepareAgentDefaultsPayloadForJoinPersistence (hermes_gateway)", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const secretsTmpDir = path.join(os.tmpdir(), `paperclip-hermes-join-defaults-${randomUUID()}`);

  beforeAll(async () => {
    mkdirSync(secretsTmpDir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(secretsTmpDir, "master.key");
    const started = await startEmbeddedPostgresTestDatabase("hermes-join-defaults");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(joinRequests);
    await db.delete(invites);
    await db.delete(companySecretVersions);
    await db.delete(companySecrets);
    await db.delete(companySecretProviderConfigs);
    await db.delete(companies);
  });

  afterAll(async () => {
    await stopDb?.();
    if (previousKeyFile === undefined) {
      delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    } else {
      process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = previousKeyFile;
    }
    rmSync(secretsTmpDir, { recursive: true, force: true });
  });

  it("refuses a literal apiKey and a secret reference in Hermes join defaults, creating no secret (PG-3)", async () => {
    const companyId = randomUUID();
    const inviteId = randomUUID();
    const joinRequestId = randomUUID();
    const literalApiKey = `hermes-key-${randomUUID()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(invites).values({
      id: inviteId,
      companyId,
      inviteType: "company_join",
      tokenHash: `invite-token-${randomUUID()}`,
      allowedJoinTypes: "agent",
      defaultsPayload: null,
      expiresAt: new Date("2027-03-10T00:00:00.000Z"),
    });

    const joinDefaultsFor = (apiKey: unknown) => normalizeAgentDefaultsForJoin({
      adapterType: "hermes_gateway",
      defaultsPayload: {
        apiBaseUrl: "https://hermes.example",
        apiKey,
        paperclipApiUrl: "https://paperclip.example",
      },
      deploymentMode: "authenticated",
      deploymentExposure: "private",
      bindHost: "127.0.0.1",
      allowedHostnames: [],
    });
    // PG-3: a literal value is refused, and no secret is created for it.
    const literalDefaults = joinDefaultsFor(literalApiKey);
    expect(literalDefaults.fatalErrors).toEqual([]);
    await expect(prepareAgentDefaultsPayloadForJoinPersistence({
      db,
      companyId,
      adapterType: "hermes_gateway",
      normalized: literalDefaults.normalized,
    })).rejects.toMatchObject({ status: 422, details: { code: "schema_secret_field_requires_secret_ref" } });
    expect(await db.select().from(companySecrets)).toHaveLength(0);

    // A joiner also supplies apiBaseUrl, so it must never name a company
    // secret: join normalization still requires a string key, which refuses
    // a reference before persistence. A Hermes agent therefore cannot join
    // with a key under PG-3; a board user creates it with a reference.
    const stored = await secretService(db).create(companyId, {
      name: `hermes-api-key-${randomUUID()}`,
      provider: "local_encrypted",
      value: literalApiKey,
    });
    const referenceDefaults = joinDefaultsFor({ type: "secret_ref", secretId: stored.id, version: "latest" });
    expect(referenceDefaults.fatalErrors).toContain("agentDefaultsPayload.apiKey is required");
    expect(await db.select().from(joinRequests).where(eq(joinRequests.id, joinRequestId))).toEqual([]);
    expect(await db.select().from(companySecrets)).toHaveLength(1);
  });
});
