const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { bootBackground, response, extensionRoot } = require("./helpers.cjs");

const SETTINGS_KEY = "settings.v1";
const ERROR_KEY = "gatewayError.v1";
const BASE = "https://tasks.example.test:9443/prefix/api/v1";
const HOST_PERMISSION = "https://tasks.example.test/*";
const REQUEST_A = "00000000-0000-4000-8000-000000000011";
const REQUEST_B = "00000000-0000-4000-8000-000000000012";
const OPERATION_A = "00000000-0000-4000-8000-000000000021";

function activeSettings(overrides = {}) {
  return {
    schemaVersion: 1,
    serverUrl: BASE,
    token: "test-bearer-token",
    monitorEnabled: true,
    timeoutMs: 30000,
    ...overrides,
  };
}

function rpc(operation, target = null, parameters = {}, requestId = REQUEST_A) {
  return { protocolVersion: 1, requestId, operation, target, parameters };
}

function rootResource(extra = {}) {
  return { _links: { self: { href: BASE } }, ...extra };
}

function operationReceipt(id, type, target, status = "succeeded") {
  return {
    id,
    status,
    type,
    target,
    parameters: {},
    result: status === "succeeded" ? {
      type,
      target,
      affectedIds: [],
      effectsState: "none",
      value: null,
      _links: { affected: [] },
    } : null,
    failure: status === "succeeded" ? null : { code: "conflict" },
    _links: { self: { href: `${BASE}/operations/${id}` } },
  };
}

function boot(fetch, overrides = {}) {
  return bootBackground({
    initialStorage: { [SETTINGS_KEY]: activeSettings(overrides.settings) },
    initialPermissions: overrides.initialPermissions ?? [HOST_PERMISSION],
    ...overrides.background,
    fetch,
  });
}

function sender(env, page = "index.html", id = env.extensionId) {
  return { id, url: env.namespace.runtime.getURL(page) };
}

async function idle() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

test("background registers its listener synchronously and Firefox ID differs from the moz-extension origin", () => {
  const source = fs.readFileSync(path.join(extensionRoot, "background.js"), "utf8");
  const env = boot(async () => response(rootResource()));
  const extensionUrl = new URL(env.namespace.runtime.getURL("index.html"));

  assert.equal(env.events.runtime.listeners.length, 1);
  assert.equal(env.events.alarm.listeners.length, 1);
  assert.equal(env.events.installed.listeners.length, 1);
  assert.equal(env.events.startup.listeners.length, 1);
  assert.notEqual(env.extensionId, extensionUrl.host);
  assert.equal(extensionUrl.protocol, "moz-extension:");
  assert.match(source, /onMessage\.addListener/);
});

test("sender ID, exact extension page URL, and page allowlist are checked before storage or network access", async (t) => {
  const cases = [
    { name: "foreign runtime ID", sender: (env) => sender(env, "index.html", "foreign-extension") },
    { name: "origin UUID used as runtime ID", sender: (env) => sender(env, "index.html", new URL(env.namespace.runtime.getURL("index.html")).host) },
    { name: "wrong extension origin", sender: (env) => ({ id: env.extensionId, url: "moz-extension://another-id/index.html" }) },
    { name: "query appended to a valid page URL", sender: (env) => ({ id: env.extensionId, url: `${env.namespace.runtime.getURL("index.html")}?operation=tasks.patch` }) },
    { name: "unlisted extension page", sender: (env) => sender(env, "storage-view.html") },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const env = boot(async () => response(rootResource()));
      const reply = await env.send(rpc("root.read"), scenario.sender(env));
      assert.equal(reply.ok, false);
      assert.equal(reply.error.kind, "unauthorized-sender");
      assert.equal(reply.requestId, REQUEST_A);
      assert.equal(env.requests.length, 0);
      assert.equal(env.permissionCalls.length, 0);
    });
  }
});

test("RPC envelope rejects wrong versions, unknown keys, non-UUID IDs, and legacy messages without fetching", async (t) => {
  const cases = [
    { name: "wrong version", message: { ...rpc("root.read"), protocolVersion: 2 } },
    { name: "extra top-level secret field", message: { ...rpc("root.read"), token: "must-not-pass" } },
    { name: "malformed request ID", message: { ...rpc("root.read"), requestId: "not-a-uuid" } },
    { name: "retired message shape", message: { type: "gateway.call", requestId: REQUEST_A, operation: "GET_LIST", args: {} } },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const env = boot(async () => response(rootResource()));
      const reply = await env.send(scenario.message, sender(env));
      assert.equal(reply.ok, false);
      assert.equal(reply.error.kind, "invalid-request");
      assert.equal(env.requests.length, 0);
    });
  }
});

test("settings operations require a null target before changing configuration", async () => {
  const env = boot(async () => response(rootResource()));
  const before = structuredClone(env.localData[SETTINGS_KEY]);
  const reply = await env.send(rpc("settings.disconnect", { kind: "task", id: "task-1" }, {}), sender(env, "options.html"));

  assert.equal(reply.ok, false);
  assert.equal(reply.error.kind, "invalid-request");
  assert.deepEqual(env.localData[SETTINGS_KEY], before);
  assert.equal(env.storageWrites.length, 0);
  assert.equal(env.requests.length, 0);
});

test("revoked host permission is checked before fetch and disarms the stored monitor", async () => {
  const env = boot(async () => response(rootResource()));
  env.allowedPermissions.delete(HOST_PERMISSION);
  const reply = await env.send(rpc("root.read"), sender(env));

  assert.equal(reply.ok, false);
  assert.equal(reply.error.kind, "permission-required");
  assert.equal(reply.status, null);
  assert.equal(env.requests.length, 0);
  assert.deepEqual(env.permissionCalls.map(({ method, details }) => ({ method, details })), [
    { method: "contains", details: { origins: [HOST_PERMISSION] } },
  ]);
  assert.equal(env.localData[SETTINGS_KEY].monitorEnabled, false);
});

test("typed task-list parameters become a bounded query while authentication stays in the background", async () => {
  const env = boot(async () => response(rootResource({ _embedded: { tasks: [] } })));
  const reply = await env.send(rpc("tasks.list", null, {
    page: 2,
    pageSize: 20,
    filters: ["open", "urgent"],
    heuristic: "priority",
    algorithm: "due-date",
    search: ["invoice & report"],
  }), sender(env));

  assert.equal(reply.ok, true);
  const request = env.requests[0];
  const url = new URL(request.url);
  assert.equal(url.origin, "https://tasks.example.test:9443");
  assert.equal(url.pathname, "/prefix/api/v1/tasks");
  assert.equal(url.searchParams.get("page"), "2");
  assert.equal(url.searchParams.get("pageSize"), "20");
  assert.deepEqual(url.searchParams.getAll("filters"), ["open", "urgent"]);
  assert.equal(url.searchParams.get("search"), "invoice & report");
  assert.equal(url.searchParams.get("algorithm"), "due-date");
  assert.equal(url.searchParams.get("heuristic"), "priority");
  assert.equal(request.init.method, "GET");
  assert.equal(request.init.body, undefined);
  assert.equal(request.init.redirect, "error");
  assert.equal(request.init.cache, "no-store");
  assert.equal(request.init.credentials, "omit");
  assert.equal(request.init.headers.Authorization, "Bearer test-bearer-token");
});

test("resource IDs are encoded as one UTF-8 path segment and dot-segment identities fail before fetch", async (t) => {
  const resourceId = "project/週 & plan";
  const expectedPath = `/prefix/api/v1/projects/${encodeURIComponent(resourceId)}`;
  const env = boot(async () => response({ _links: { self: { href: `https://tasks.example.test:9443${expectedPath}` } }, name: resourceId }));
  const valid = await env.send(rpc("projects.get", { kind: "project", id: resourceId }), sender(env));

  assert.equal(valid.ok, true);
  assert.equal(new URL(env.requests[0].url).pathname, expectedPath);
  assert.equal(env.requests[0].init.headers.Authorization, "Bearer test-bearer-token");

  for (const id of [".", ".."]) {
    await t.test(`ID ${id}`, async () => {
      const invalidEnv = boot(async () => response(rootResource()));
      const reply = await invalidEnv.send(rpc("tasks.get", { kind: "task", id }), sender(invalidEnv));
      assert.equal(reply.ok, false);
      assert.equal(reply.error.kind, "unsupported-resource-id");
      assert.equal(reply.status, null);
      assert.equal(invalidEnv.requests.length, 0);
    });
  }
});

test("hostile HAL links never become authenticated follow-up requests", async (t) => {
  const hostileLinks = [
    "https://attacker.example:9443/prefix/api/v1/tasks/x",
    "https://tasks.example.test:9444/prefix/api/v1/tasks/x",
    "https://tasks.example.test:9443/other/api/v1/tasks/x",
    "https://tasks.example.test:9443/prefix/api/v1/../evil",
  ];
  for (const href of hostileLinks) {
    await t.test(href, async () => {
      const env = boot(async () => response({ _links: { self: { href } }, id: "task-x" }));
      const reply = await env.send(rpc("root.read"), sender(env));
      assert.equal(reply.ok, false);
      assert.ok(["invalid-response", "unsupported-resource-id"].includes(reply.error.kind));
      assert.equal(env.requests.length, 1);
      assert.equal(env.requests[0].init.headers.Authorization, "Bearer test-bearer-token");
      assert.equal(env.requests.some((request) => new URL(request.url).host !== "tasks.example.test:9443"), false);
    });
  }
});

test("PATCH uses merge-patch JSON and rejects unknown fields before writing", async (t) => {
  const id = "task/東京";
  const env = boot(async (url, init) => {
    assert.equal(init.method, "PATCH");
    assert.equal(init.headers["Content-Type"], "application/merge-patch+json");
    assert.equal(new URL(url).pathname, `/prefix/api/v1/tasks/${encodeURIComponent(id)}`);
    assert.deepEqual(JSON.parse(init.body), { description: "Updated & safe" });
    return response({ id, description: "Updated & safe", _links: { self: { href: url } } });
  });
  const reply = await env.send(rpc("tasks.patch", { kind: "task", id }, { description: "Updated & safe" }), sender(env));
  assert.equal(reply.ok, true);
  assert.equal(reply.status, 200);
  assert.equal(env.requests.length, 1);

  const invalidEnv = boot(async () => response(rootResource()));
  const invalid = await invalidEnv.send(rpc("tasks.patch", { kind: "task", id }, { description: "No", arbitraryCommand: "delete" }), sender(invalidEnv));
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error.kind, "invalid-request");
  assert.equal(invalidEnv.requests.length, 0);
});

test("typed operation submit posts one exact body with a separate client operation ID", async () => {
  const target = { kind: "task", id: "uid-42" };
  const parameters = { duration: "0.5p" };
  const message = rpc("operations.submit", target, { id: OPERATION_A, type: "record-work", parameters });
  const env = boot(async (url, init) => {
    assert.equal(url, `${BASE}/operations`);
    assert.equal(init.method, "POST");
    assert.equal(init.headers["Content-Type"], "application/json");
    assert.deepEqual(JSON.parse(init.body), { id: OPERATION_A, type: "record-work", target, parameters });
    return response(operationReceipt(OPERATION_A, "record-work", target), 201);
  });
  const reply = await env.send(message, sender(env));

  assert.equal(reply.ok, true);
  assert.equal(reply.status, 201);
  assert.notEqual(message.requestId, JSON.parse(env.requests[0].init.body).id);
  assert.equal(env.requests.length, 1);
  assert.equal(env.requests[0].init.headers.Authorization, "Bearer test-bearer-token");
});

test("successful resource data preserves an ID that happens to contain the configured token", async () => {
  const token = "token-part-of-task-id";
  const id = "task-token-part-of-task-id-東京";
  const href = `${BASE}/tasks/${encodeURIComponent(id)}`;
  const env = boot(async (url, init) => init.method === "POST"
    ? response(operationReceipt(OPERATION_A, "complete-task", { kind: "task", id }), 201)
    : response({
      id,
      description: "Keep the resource identity exact",
      _links: {
        self: { href },
        actions: { edit: { href } },
      },
    }), { settings: { token } });
  const reply = await env.send(rpc("tasks.get", { kind: "task", id }), sender(env));

  assert.equal(reply.ok, true);
  assert.equal(reply.data.id, id);
  assert.equal(reply.data._links.self.href, href);
  assert.equal(reply.data._links.actions.edit.href, href);
  assert.equal(env.requests[0].url, href);

  const action = await env.send(rpc("operations.submit", { kind: "task", id }, {
    id: OPERATION_A,
    type: "complete-task",
    parameters: {},
  }, REQUEST_B), sender(env));
  assert.equal(action.ok, true);
  assert.deepEqual(JSON.parse(env.requests[1].init.body).target, { kind: "task", id });
  assert.equal(env.requests.length, 2);
});

test("uncertain write replies retain correlation and a receipt GET does not replay the POST", async () => {
  const env = boot(async (url, init) => {
    if (init.method === "POST") return response("{", 201);
    return response(operationReceipt(OPERATION_A, "complete-task", { kind: "task", id: "uid-42" }, "pending"));
  });
  const submitted = await env.send(rpc("operations.submit", { kind: "task", id: "uid-42" }, {
    id: OPERATION_A, type: "complete-task", parameters: {},
  }), sender(env));

  assert.equal(submitted.ok, false);
  assert.equal(submitted.error.kind, "uncertain");
  assert.equal(submitted.error.effectsState, "unknown");
  assert.equal(submitted.error.operationId, OPERATION_A);
  assert.equal(submitted.status, 201);
  assert.equal(env.requests.length, 1);
  const receipt = await env.send(rpc("operations.get", { kind: "operation", id: OPERATION_A }), sender(env));
  assert.equal(receipt.ok, true);
  assert.equal(env.requests.length, 2);
  assert.deepEqual(env.requests.map(({ init }) => init.method), ["POST", "GET"]);
});

test("an incomplete 2xx receipt and a 5xx problem without a reliable effects state stay uncertain", async (t) => {
  const cases = [
    {
      name: "2xx is not a succeeded receipt",
      fetch: async () => response(operationReceipt(OPERATION_A, "complete-task", { kind: "task", id: "uid-43" }, "failed"), 200),
      status: 200,
    },
    {
      name: "5xx does not say whether effects occurred",
      fetch: async () => response({ code: "service-unavailable", title: "Unavailable", detail: "Try later" }, 503, "application/problem+json"),
      status: 503,
    },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const env = boot(scenario.fetch);
      const reply = await env.send(rpc("operations.submit", { kind: "task", id: "uid-43" }, {
        id: OPERATION_A,
        type: "complete-task",
        parameters: {},
      }), sender(env));

      assert.equal(reply.ok, false);
      assert.equal(reply.error.kind, "uncertain");
      assert.equal(reply.error.effectsState, "unknown");
      assert.equal(reply.error.operationId, OPERATION_A);
      assert.equal(reply.status, scenario.status);
      assert.equal(env.requests.length, 1);
      assert.equal(env.requests[0].init.method, "POST");
    });
  }
});

test("typed 401 and 409 Problem Details stay determinate when effectsState is omitted", async (t) => {
  const cases = [
    { name: "unauthorized read", method: "GET", status: 401, expectedKind: "http", operation: "tasks.get", target: { kind: "task", id: "uid-44" } },
    { name: "conflicting write", method: "POST", status: 409, expectedKind: "conflict", operation: "operations.submit", target: { kind: "task", id: "uid-45" } },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const requestId = scenario.status === 401 ? REQUEST_A : REQUEST_B;
      const problem = {
        type: "about:blank",
        title: "Request rejected",
        status: scenario.status,
        detail: "The operation could not be applied.",
        instance: "/api/v1/resource",
        code: scenario.status === 401 ? "unauthorized" : "operation-conflict",
        requestId,
      };
      const env = boot(async () => response(problem, scenario.status, "application/problem+json"));
      const parameters = scenario.method === "POST" ? { id: OPERATION_A, type: "complete-task", parameters: {} } : {};
      const reply = await env.send(rpc(scenario.operation, scenario.target, parameters, requestId), sender(env));

      assert.equal(reply.ok, false);
      assert.equal(reply.status, scenario.status);
      assert.equal(reply.error.kind, scenario.expectedKind);
      assert.equal(reply.error.effectsState, undefined);
      if (scenario.method === "POST") assert.equal(reply.error.operationId, OPERATION_A);
    });
  }
});

test("HTTP problem details preserve the actual status and sanitize a leaked credential", async () => {
  const token = "credential-value-for-test";
  const env = boot(async () => response({
    type: "about:blank",
    title: "Error",
    status: 503,
    detail: `Bearer ${token} failed at https://internal.example/private/path`,
    code: "service-unavailable",
    effectsState: "none",
  }, 503), { settings: { token } });
  const reply = await env.send(rpc("root.read"), sender(env));

  assert.equal(reply.ok, false);
  assert.equal(reply.status, 503);
  assert.equal(reply.error.kind, "http");
  assert.equal(reply.error.effectsState, "none");
  assert.doesNotMatch(JSON.stringify(reply), new RegExp(token));
  assert.doesNotMatch(JSON.stringify(env.localData[ERROR_KEY]), new RegExp(token));
  assert.doesNotMatch(JSON.stringify(env.localData[ERROR_KEY]), /internal\.example|private\/path/);
  assert.equal(env.badgeState.text, "!");
});

test("the retired notification alarm remains inert; notification reads are safe GETs without cursors or ACK flags", async () => {
  const env = boot(async () => response(rootResource({ _embedded: { notifications: [] } })));
  env.fireAlarm("eptask-notification-monitor");
  await idle();
  assert.equal(env.requests.length, 0);

  const reply = await env.send(rpc("notifications.read"), sender(env));
  assert.equal(reply.ok, true);
  assert.equal(new URL(env.requests[0].url).pathname, "/prefix/api/v1/notifications");
  assert.equal(new URL(env.requests[0].url).search, "");
  assert.equal(env.requests[0].init.method, "GET");
  assert.equal(env.requests[0].init.body, undefined);
});

test("the timeout covers response body consumption and returns no invented HTTP status", async () => {
  const env = boot(async (_url, init) => ({
    ok: true,
    status: 200,
    text: () => new Promise((_resolve, reject) => {
      if (init.signal.aborted) reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      else init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
    }),
  }), { settings: { timeoutMs: 1000 } });
  const reply = await env.send(rpc("root.read"), sender(env));

  assert.equal(reply.ok, false);
  assert.equal(reply.error.kind, "timeout");
  assert.equal(reply.status, null);
  assert.equal(env.requests.length, 1);
  assert.equal(env.requests[0].init.signal.aborted, true);
});

test("a late read after disconnect and reconfiguration cannot restore stale UI state or erase a newer error", async () => {
  const newBase = "https://replacement.example.test:9443/next/api/v1";
  const newHostPermission = "https://replacement.example.test/*";
  let releaseOldRead;
  const env = boot(async (url) => {
    if (url === `${BASE}/tasks`) {
      return new Promise((resolve) => { releaseOldRead = () => resolve(response({ tasks: [] })); });
    }
    if (url === "https://replacement.example.test:9443/next/api/v1") {
      return response({ _links: { self: { href: newBase } } });
    }
    if (url === `${newBase}/tasks`) {
      return response({ code: "service-unavailable", title: "Unavailable", detail: "Try later" }, 503, "application/problem+json");
    }
    throw new Error("unexpected test URL");
  }, {
    initialPermissions: [HOST_PERMISSION, newHostPermission],
  });
  const oldRead = env.send(rpc("tasks.list", null, {}), sender(env));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(env.requests.length, 1);

  const disconnected = await env.send(rpc("settings.disconnect", null, {}), sender(env, "options.html", env.extensionId));
  assert.equal(disconnected.ok, true);
  const connected = await env.send(rpc("settings.connect", null, {
    serverUrl: newBase,
    token: "replacement-token",
    monitorEnabled: true,
    timeoutMs: 30000,
  }, REQUEST_B), sender(env, "options.html", env.extensionId));
  assert.equal(connected.ok, true);

  const newFailure = await env.send(rpc("tasks.list", null, {}, OPERATION_A), sender(env));
  assert.equal(newFailure.ok, false);
  assert.equal(newFailure.status, 503);
  assert.equal(env.localData[ERROR_KEY].requestId, OPERATION_A);
  assert.equal(env.badgeState.text, "!");

  releaseOldRead();
  const lateReply = await oldRead;
  assert.equal(lateReply.ok, true);
  assert.equal(env.localData[ERROR_KEY].requestId, OPERATION_A);
  assert.equal(env.badgeState.text, "!");
  assert.equal(env.localData[SETTINGS_KEY].serverUrl, newBase);
});
