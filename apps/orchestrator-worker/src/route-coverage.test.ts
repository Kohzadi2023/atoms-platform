import assert from "node:assert/strict";
import test from "node:test";

import {
  describeMissingRoutes,
  findMissingRoutes,
  normalizeRoutePath,
  routeServedByFile,
} from "./route-coverage.js";

test("dynamic segment names are ignored, their shape is not", () => {
  assert.equal(normalizeRoutePath("/staff/accounts/[id]"), normalizeRoutePath("/staff/accounts/[accountId]"));
  assert.equal(normalizeRoutePath("/api/accounts/:id"), "/api/accounts/[]");
  assert.equal(normalizeRoutePath("/api/auth/[...nextauth]"), "/api/auth/[...]");
  assert.equal(normalizeRoutePath("/docs/[[...slug]]"), "/docs/[[...]]");
  assert.equal(normalizeRoutePath("/login/?next=/x"), "/login");
  assert.equal(normalizeRoutePath("/"), "/");
  assert.notEqual(normalizeRoutePath("/a/[id]"), normalizeRoutePath("/a/[...id]"));
});

test("files map to the routes they serve, ignoring route groups and parallel slots", () => {
  assert.equal(routeServedByFile("app/page.tsx"), "/");
  assert.equal(routeServedByFile("src/app/login/page.tsx"), "/login");
  assert.equal(routeServedByFile("app/(portal)/staff/page.tsx"), "/staff");
  assert.equal(routeServedByFile("app/api/auth/[...nextauth]/route.ts"), "/api/auth/[...]");
  assert.equal(routeServedByFile("app/@modal/login/page.tsx"), "/login");
  assert.equal(routeServedByFile("pages/index.tsx"), "/");
  assert.equal(routeServedByFile("pages/staff/index.tsx"), "/staff");
  assert.equal(routeServedByFile("pages/api/accounts/[id].ts"), "/api/accounts/[]");
  assert.equal(routeServedByFile("pages/_app.tsx"), undefined);
  assert.equal(routeServedByFile("app/layout.tsx"), undefined);
  assert.equal(routeServedByFile("components/LoginForm.tsx"), undefined);
});

test("the planned routes without a serving file are reported once each", () => {
  const files = [
    "app/layout.tsx",
    "app/page.tsx",
    "app/login/page.tsx",
    "app/(portal)/staff/page.tsx",
    "app/staff/accounts/[accountId]/page.tsx",
    "app/api/support-requests/route.ts",
  ];
  const missing = findMissingRoutes(
    [
      { method: "GET", path: "/login" },
      { method: "GET", path: "/staff" },
      { method: "GET", path: "/staff/accounts/[id]" },
      { method: "GET", path: "/api/auth/[...nextauth]" },
      { method: "POST", path: "/api/auth/[...nextauth]" },
      { method: "GET", path: "/api/support-requests" },
      { method: "POST", path: "/api/support-requests" },
      { method: "GET", path: "/api/accounts/[id]" },
    ],
    files,
  );

  assert.deepEqual(missing.map((route) => route.path), [
    "/api/auth/[...nextauth]",
    "/api/accounts/[id]",
  ]);
  assert.equal(describeMissingRoutes(missing), "GET /api/auth/[...nextauth]\nGET /api/accounts/[id]");
});

test("a project without app/ or pages/ is never judged", () => {
  assert.deepEqual(
    findMissingRoutes([{ method: "GET", path: "/anything" }], ["src/index.ts", "package.json"]),
    [],
  );
});
