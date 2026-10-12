import assert from "node:assert/strict";
import test from "node:test";

import type { PreviewReopenJob } from "@atoms/contracts";
import Fastify from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";

import { ApiError } from "./errors.js";
import type { PreviewReopenQueue } from "./preview-reopen-queue.js";
import type {
  PreviewReopenRepository,
  PreviewReopenTarget,
} from "./preview-reopen-repository.js";
import { registerPreviewReopenRoutes } from "./preview-reopen-routes.js";

const PROJECT_ID = "00000000-0000-4000-8000-0000000000a1";
const WORKSPACE_ID = "00000000-0000-4000-8000-0000000000a2";
const RUN_ID = "00000000-0000-4000-8000-0000000000a3";
const NOW = new Date("2026-08-02T12:00:00.000Z");

class MemoryRepository implements PreviewReopenRepository {
  target: PreviewReopenTarget = { kind: "ok", workspaceId: WORKSPACE_ID, runId: RUN_ID };
  lookups: { userId: string; projectId: string; now: Date }[] = [];
  async findReopenTarget(input: {
    userId: string;
    projectId: string;
    now: Date;
  }): Promise<PreviewReopenTarget> {
    this.lookups.push(input);
    return this.target;
  }
  async close(): Promise<void> {}
}

class MemoryQueue implements PreviewReopenQueue {
  jobs: PreviewReopenJob[] = [];
  async enqueue(job: PreviewReopenJob): Promise<void> {
    this.jobs.push(job);
  }
  async close(): Promise<void> {}
}

async function createFixture(options: { authenticated?: boolean } = {}) {
  const repository = new MemoryRepository();
  const queue = new MemoryQueue();
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  if (options.authenticated !== false) {
    app.addHook("onRequest", async (request) => {
      request.principal = {
        userId: "user-test",
        subject: "user-test",
        issuer: "urn:atoms:test",
        audience: ["atoms-control-api"],
        issuedAt: Math.floor(NOW.getTime() / 1_000),
        notBefore: Math.floor(NOW.getTime() / 1_000),
        expiresAt: Math.floor(NOW.getTime() / 1_000) + 3600,
      };
    });
  }
  registerPreviewReopenRoutes(app, { repository, queue, now: () => NOW });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ApiError) {
      return reply.code(error.statusCode).send({
        error: { code: error.code, message: error.message, details: error.details },
      });
    }
    return reply.code(500).send({ error: { code: "INTERNAL" } });
  });
  await app.ready();
  return { app, repository, queue };
}

const reopen = { method: "POST", url: `/v1/projects/${PROJECT_ID}/preview/reopen` } as const;

test("a project member's request is accepted and queued for the run that received the last generation", async () => {
  const { app, repository, queue } = await createFixture();
  try {
    const response = await app.inject(reopen);

    assert.equal(response.statusCode, 202);
    assert.deepEqual(response.json(), { status: "REQUESTED", runId: RUN_ID });
    assert.deepEqual(queue.jobs, [
      { projectId: PROJECT_ID, workspaceId: WORKSPACE_ID, runId: RUN_ID },
    ]);
    assert.equal(repository.lookups[0]?.userId, "user-test");
    assert.deepEqual(repository.lookups[0]?.now, NOW);
  } finally {
    await app.close();
  }
});

test("a project the user cannot see is a 404 and nothing is queued", async () => {
  const { app, repository, queue } = await createFixture();
  repository.target = { kind: "project_not_found" };
  try {
    const response = await app.inject(reopen);

    assert.equal(response.statusCode, 404);
    assert.equal(response.json().error.code, "PROJECT_NOT_FOUND");
    assert.deepEqual(queue.jobs, []);
  } finally {
    await app.close();
  }
});

test("a project that never finished a run has nothing to reopen", async () => {
  const { app, repository, queue } = await createFixture();
  repository.target = { kind: "no_finished_run" };
  try {
    const response = await app.inject(reopen);

    assert.equal(response.statusCode, 409);
    assert.equal(response.json().error.code, "PREVIEW_NOTHING_TO_REOPEN");
    assert.deepEqual(queue.jobs, []);
  } finally {
    await app.close();
  }
});

test("a preview that is still live is not rebuilt, and the answer says when it ends", async () => {
  const { app, repository, queue } = await createFixture();
  const expiresAt = new Date("2026-08-02T12:20:00.000Z");
  repository.target = { kind: "preview_active", expiresAt };
  try {
    const response = await app.inject(reopen);

    assert.equal(response.statusCode, 409);
    assert.equal(response.json().error.code, "PREVIEW_ALREADY_ACTIVE");
    assert.equal(response.json().error.details.expiresAt, expiresAt.toISOString());
    assert.deepEqual(queue.jobs, []);
  } finally {
    await app.close();
  }
});

test("an unauthenticated request is refused before anything is looked up", async () => {
  const { app, repository, queue } = await createFixture({ authenticated: false });
  try {
    const response = await app.inject(reopen);

    assert.equal(response.statusCode, 401);
    assert.deepEqual(repository.lookups, []);
    assert.deepEqual(queue.jobs, []);
  } finally {
    await app.close();
  }
});

test("a project id that is not a UUID is rejected", async () => {
  const { app, queue } = await createFixture();
  try {
    const response = await app.inject({ method: "POST", url: "/v1/projects/nope/preview/reopen" });

    assert.notEqual(response.statusCode, 202);
    assert.deepEqual(queue.jobs, []);
  } finally {
    await app.close();
  }
});
