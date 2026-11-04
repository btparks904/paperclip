import { Writable } from "node:stream";
import express, { type NextFunction, type Request, type Response } from "express";
import pino from "pino";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  resolveAgentInstructionCandidateSchema,
  upsertAgentInstructionsFileSchema,
} from "@paperclipai/shared";
import {
  conflict,
  forbidden,
  HttpError,
  unauthorized,
  unprocessable,
} from "../errors.js";
import { boardMutationGuard } from "../middleware/board-mutation-guard.js";
import { errorHandler } from "../middleware/error-handler.js";
import { HTTP_LOG_REDACT_PATHS } from "../middleware/http-log-redaction.js";
import { createHttpLogger } from "../middleware/logger.js";
import { validate } from "../middleware/validate.js";

const captureExceptionMock = vi.hoisted(() => vi.fn());
vi.mock("../sentry.js", () => ({ captureException: captureExceptionMock }));
vi.mock("../telemetry.js", () => ({ getTelemetryClient: () => null }));

// Synthetic marker only. No real instruction text is used anywhere here.
const SENTINEL = "synthetic-private-instruction-sentinel-7f3a";
const AGENT_ID = "agent-fixture-1";
const RUN_ID = "11111111-2222-4333-8444-555555555555";
const VALID_HASH = "a".repeat(64);

type Failure =
  | "ok"
  | "missing-base-hash-422"
  | "stale-base-hash-409"
  | "forbidden-403"
  | "http-500"
  | "plain-500"
  | "candidate-422";

function failureFor(req: Request): Failure {
  const value = req.header("x-test-failure");
  return (value as Failure | undefined) ?? "ok";
}

function routeHandler(req: Request, res: Response) {
  switch (failureFor(req)) {
    case "missing-base-hash-422":
      throw unprocessable(
        `Read the file and supply baseHash (${SENTINEL})`,
        { code: "INSTRUCTION_BASE_REQUIRED", content: SENTINEL },
      );
    case "stale-base-hash-409":
      throw conflict(`Instruction file changed near ${SENTINEL}`, {
        code: "INSTRUCTION_BASE_STALE",
        currentContent: SENTINEL,
      });
    case "forbidden-403":
      throw forbidden(`Cannot manage instructions: ${SENTINEL}`);
    case "http-500":
      throw new HttpError(500, `write failed: ${SENTINEL}`, {
        code: "INSTRUCTION_WRITE_FAILED",
        content: SENTINEL,
      });
    case "plain-500":
      throw new Error(`filesystem failure while writing ${SENTINEL}`);
    case "candidate-422":
      throw unprocessable(`Invalid instruction candidate ${SENTINEL}`);
    default:
      res.status(200).json({ ok: true });
  }
}

function buildApp(stream: Writable) {
  const app = express();
  app.use(express.json());
  app.use(
    createHttpLogger(pino({ redact: [...HTTP_LOG_REDACT_PATHS] }, stream)),
  );
  // Auth runs before route validation in the real app. Model 401 and the
  // session-board Origin guard as pre-route middleware.
  app.use((req, _res, next) => {
    if (req.header("x-test-auth") === "missing") {
      next(unauthorized());
      return;
    }
    req.actor = (
      req.header("x-test-auth") === "session"
        ? { type: "board", source: "session" }
        : { type: "board", source: "local_implicit" }
    ) as Request["actor"];
    next();
  });
  const api = express.Router();
  api.use(boardMutationGuard());
  api.put(
    "/agents/:id/instructions-bundle/file",
    validate(upsertAgentInstructionsFileSchema),
    routeHandler,
  );
  api.post(
    "/agents/:id/instructions-bundle/candidates/:runId/resolve",
    validate(resolveAgentInstructionCandidateSchema),
    routeHandler,
  );
  // Unclassified control routes with the same validation and failures, to
  // prove response bodies and ordinary diagnostics are unchanged.
  api.put(
    "/control/:id/file",
    validate(upsertAgentInstructionsFileSchema),
    routeHandler,
  );
  app.use("/api", api);
  app.use(errorHandler as (
    err: unknown,
    req: Request,
    res: Response,
    next: NextFunction,
  ) => void);
  return app;
}

function captureStream() {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });
  return {
    stream,
    lines: () =>
      chunks
        .join("")
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as Record<string, any>),
    raw: () => chunks.join(""),
  };
}

const fileBody = (extra: Record<string, unknown> = {}) => ({
  path: "AGENTS.md",
  content: SENTINEL,
  baseHash: VALID_HASH,
  ...extra,
});

const FILE_URL = `/api/agents/${AGENT_ID}/instructions-bundle/file`;
const RESOLVE_URL = `/api/agents/${AGENT_ID}/instructions-bundle/candidates/${RUN_ID}/resolve`;

interface Case {
  name: string;
  method: "put" | "post";
  url: string;
  body: unknown;
  headers?: Record<string, string>;
  status: number;
  reportsCrash?: boolean;
  code?: string;
}

const CASES: Case[] = [
  {
    name: "missing baseHash 422",
    method: "put",
    url: FILE_URL,
    body: fileBody(),
    headers: { "x-test-failure": "missing-base-hash-422" },
    status: 422,
  },
  {
    name: "stale baseHash 409",
    method: "put",
    url: FILE_URL,
    body: fileBody(),
    headers: { "x-test-failure": "stale-base-hash-409" },
    status: 409,
  },
  {
    name: "unauthorized 403",
    method: "put",
    url: FILE_URL,
    body: fileBody(),
    headers: { "x-test-failure": "forbidden-403" },
    status: 403,
  },
  {
    name: "authentication 401",
    method: "put",
    url: FILE_URL,
    body: fileBody(),
    headers: { "x-test-auth": "missing" },
    status: 401,
  },
  {
    name: "Origin rejection 403",
    method: "put",
    url: FILE_URL,
    body: fileBody(),
    headers: { "x-test-auth": "session" },
    status: 403,
  },
  {
    name: "schema validation 400",
    method: "put",
    url: FILE_URL,
    body: { path: "", content: SENTINEL },
    status: 400,
  },
  {
    name: "invalid content 400",
    method: "put",
    url: FILE_URL,
    body: { path: "AGENTS.md", content: [SENTINEL, { text: SENTINEL }] },
    status: 400,
  },
  {
    name: "HttpError 500",
    method: "put",
    url: FILE_URL,
    body: fileBody(),
    headers: { "x-test-failure": "http-500" },
    status: 500,
    reportsCrash: true,
    code: "INSTRUCTION_WRITE_FAILED",
  },
  {
    name: "plain Error 500",
    method: "put",
    url: FILE_URL,
    body: fileBody(),
    headers: { "x-test-failure": "plain-500" },
    status: 500,
    reportsCrash: true,
  },
  {
    name: "nested content objects",
    method: "put",
    url: FILE_URL,
    body: fileBody({ meta: { nested: { content: SENTINEL, deeper: [SENTINEL] } } }),
    status: 400,
  },
  {
    name: "unexpected keys",
    method: "put",
    url: FILE_URL,
    body: fileBody({ [`key-${SENTINEL}`]: SENTINEL, notes: SENTINEL }),
    status: 400,
  },
  {
    name: "candidate resolution failure 422",
    method: "post",
    url: RESOLVE_URL,
    body: { baseRevisionId: null, content: SENTINEL },
    headers: { "x-test-failure": "candidate-422" },
    status: 422,
  },
  {
    name: "candidate resolution 500",
    method: "post",
    url: RESOLVE_URL,
    body: { baseRevisionId: null, content: SENTINEL },
    headers: { "x-test-failure": "plain-500" },
    status: 500,
    reportsCrash: true,
  },
  {
    name: "candidate resolution validation 400",
    method: "post",
    url: RESOLVE_URL,
    body: { content: SENTINEL, extra: SENTINEL },
    status: 400,
  },
];

async function send(app: express.Express, c: Case, url = c.url) {
  let req = request(app)[c.method](url);
  for (const [key, value] of Object.entries(c.headers ?? {})) {
    req = req.set(key, value);
  }
  return req.send(c.body as object);
}

describe("private instruction content HTTP logging", () => {
  beforeEach(() => {
    captureExceptionMock.mockReset();
  });

  it.each(CASES)(
    "omits the instruction body on $name",
    async (c) => {
      const capture = captureStream();
      const app = buildApp(capture.stream);
      const res = await send(app, c, `${c.url}?companyId=company-fixture`);
      expect(res.status).toBe(c.status);

      // Nothing logged anywhere carries the sentinel.
      expect(capture.raw()).not.toContain(SENTINEL);
      const [log] = capture.lines();
      expect(log).toBeDefined();
      expect(log.reqBody).toBe("[REDACTED]");
      // pino-http uses the error message only for 5xx or attached errors.
      // The success-style message keeps its existing mount-relative URL.
      const routeSuffix = c.url.replace(/^\/api/, "");
      expect(log.msg).toMatch(
        new RegExp(
          `^${c.method.toUpperCase()} (?:/api)?${routeSuffix} ${c.status}` +
            (c.reportsCrash ? " \u2014 request failed$" : "$"),
        ),
      );

      // Non-sensitive metadata is retained.
      expect(log.req.method).toBe(c.method.toUpperCase());
      expect(log.req.url).toBe(c.url);
      expect(log.res.statusCode).toBe(c.status);
      expect(log.responseTime).toEqual(expect.any(Number));
      if (log.reqParams) expect(log.reqParams.id).toBe(AGENT_ID);

      if (c.reportsCrash) {
        expect(log.err).toEqual(
          expect.objectContaining({
            message: "Instruction content request failed",
          }),
        );
        expect(log.errorContext).toEqual(
          c.code ? { name: "Error", code: c.code } : { name: "Error" },
        );
        expect(log.routePath).toBeDefined();
        expect(captureExceptionMock).toHaveBeenCalledTimes(1);
        const reported = captureExceptionMock.mock.calls[0]?.[0] as Error;
        expect(reported).toBeInstanceOf(Error);
        expect(reported.message).toBe("Instruction content request failed");
        expect(reported.name).toBe("Error");
        expect(String(reported.stack)).not.toContain(SENTINEL);
        expect(
          JSON.stringify(captureExceptionMock.mock.calls, (_k, v) =>
            v instanceof Error
              ? { message: v.message, name: v.name, stack: v.stack }
              : v,
          ),
        ).not.toContain(SENTINEL);
      } else {
        expect(captureExceptionMock).not.toHaveBeenCalled();
      }
    },
  );

  it.each(CASES.filter((c) => c.method === "put" && c.url === FILE_URL))(
    "leaves the client response unchanged on $name",
    async (c) => {
      const classified = await send(
        buildApp(captureStream().stream),
        c,
      );
      const control = await send(
        buildApp(captureStream().stream),
        c,
        `/api/control/${AGENT_ID}/file`,
      );
      expect(classified.status).toBe(control.status);
      expect(classified.body).toEqual(control.body);
    },
  );

  it("still logs ordinary diagnostics for unclassified routes", async () => {
    const capture = captureStream();
    const app = buildApp(capture.stream);
    await request(app)
      .put(`/api/control/${AGENT_ID}/file`)
      .set("x-test-failure", "http-500")
      .send(fileBody());
    const [log] = capture.lines();
    // `content` is intentionally not a globally redacted key.
    expect(log.reqBody).toEqual(expect.objectContaining({ content: SENTINEL }));
    expect(log.errorContext.message).toContain("write failed");
    expect(log.err.message).toContain("write failed");
    const reported = captureExceptionMock.mock.calls[0]?.[0] as Error;
    expect(reported.message).toContain("write failed");
  });

  it("does not log a body on success", async () => {
    const capture = captureStream();
    const app = buildApp(capture.stream);
    const res = await request(app).put(FILE_URL).send(fileBody());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(capture.raw()).not.toContain(SENTINEL);
    const [log] = capture.lines();
    expect(log.msg).toMatch(/^PUT (?:\/api)?\/agents\/[^ ]+\/file 200$/);
    expect(log.reqBody).toBeUndefined();
  });

  it("keeps the malformed JSON response constant and content-free", async () => {
    const capture = captureStream();
    const app = buildApp(capture.stream);
    const res = await request(app)
      .put(FILE_URL)
      .set("content-type", "application/json")
      .send(`{"content":"${SENTINEL}",`);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "Invalid JSON body" });
    expect(capture.raw()).not.toContain(SENTINEL);
  });
});
