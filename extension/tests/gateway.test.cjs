const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { bootBackground, extensionRoot, response } = require("./helpers.cjs");

const BASE = "https://tasks.example.test/team/api/v1";
const HOST_PERMISSION = "https://tasks.example.test/*";
const settings = {
  schemaVersion: 1,
  serverUrl: BASE,
  token: "test-bearer-token",
  monitorEnabled: true,
  timeoutMs: 30_000,
};

const firstUuid = "00000000-0000-4000-8000-000000000001";
const secondUuid = "00000000-0000-4000-8000-000000000002";
const laterUuid = "00000000-0000-4000-8000-000000000003";
const operationUuid = "00000000-0000-4000-8000-000000000004";

function rpc(operation, target = null, parameters = {}, requestId = firstUuid) {
  return { protocolVersion: 1, requestId, operation, target, parameters };
}

function sender(env, page = "index.html") {
  return { id: env.extensionId, url: env.namespace.runtime.getURL(page) };
}

function json(body, status = 200) {
  return response(body, status, "application/json");
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function loadMessages({ sendMessage, requestPermission } = {}) {
  const calls = [];
  const timeline = [];
  const uuidValues = [firstUuid, secondUuid, laterUuid];
  let uuidIndex = 0;
  const browserApi = {
    runtime: {
      id: "test-extension", getURL: file => `moz-extension://test/${file}`,
      sendMessage(message) {
        timeline.push("runtime.sendMessage");
        calls.push(JSON.parse(JSON.stringify(message)));
        if (sendMessage) return sendMessage(message, calls.length);
        return Promise.resolve({
          requestId: message.requestId,
          ok: true,
          status: null,
          data: { accepted: true },
          error: null,
        });
      },
    },
    permissions: {
      request(details) {
        timeline.push("permissions.request");
        if (requestPermission) return requestPermission(details);
        return Promise.resolve(true);
      },
    },
  };
  const source = fs.readFileSync(path.join(extensionRoot, "js/messages.js"), "utf8")
    .replace(/^import .*;\s*$/gm, "")
    .replace(/^export /gm, "") + `\n globalThis.__gatewayTest = {
      sendRequest, readGateway, submitOperation, gatewayCall, settingsMessages,
      assertSuccessfulReply, GatewayRequestError, readInvalidation,
    };`;
  const context = vm.createContext({
    browserApi,
    URL,
    Promise,
    Uint8Array,
    Date,
    Math,
    crypto: { randomUUID: () => uuidValues[uuidIndex++] },
  });
  vm.runInContext(source, context, { filename: "js/messages.js", timeout: 2_000 });
  return {
    ...context.__gatewayTest,
    calls,
    timeline,
    uuidCount: () => uuidIndex,
    vmObject(value) {
      const serialized = JSON.stringify(value);
      return vm.runInContext(`JSON.parse(${JSON.stringify(serialized)})`, context);
    },
  };
}

test("RPC v1 uses the exact envelope and independent UUIDs are allocated before sending a write", async () => {
  const env = loadMessages();
  const target = { kind: "task", id: "task/ü" };
  const parameters = { duration: "0.5p" };
  const pending = env.submitOperation("record-work", target, parameters);

  assert.equal(env.uuidCount(), 2, "request and operation IDs exist before dispatch");
  assert.equal(env.calls.length, 0, "dispatch is deferred until after the synchronous caller returns");
  const reply = await pending;

  assert.equal(reply.requestId, env.calls[0].requestId);
  assert.equal(env.calls.length, 1);
  const envelope = env.calls[0];
  assert.deepEqual(Object.keys(envelope).sort(), ["operation", "parameters", "protocolVersion", "requestId", "target"]);
  assert.equal(envelope.protocolVersion, 1);
  assert.match(envelope.requestId, /^[0-9a-f-]{36}$/i);
  assert.notEqual(envelope.requestId, envelope.parameters.id);
  assert.match(envelope.parameters.id, /^[0-9a-f-]{36}$/i);
  assert.deepEqual(new Set([envelope.requestId, envelope.parameters.id]), new Set([firstUuid, secondUuid]));
  assert.equal(envelope.operation, "operations.submit");
  assert.deepEqual(envelope.target, target);
  assert.deepEqual(envelope.parameters, {
    id: envelope.parameters.id,
    type: "record-work",
    parameters,
  });
  assert.doesNotMatch(JSON.stringify(envelope), /serverUrl|token|https?:\/\//i);
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(envelope)));
});

test("a lost write response retains its operation ID and receipt lookup never resends the write", async () => {
  const env = loadMessages({
    sendMessage: (message, callNumber) => {
      if (callNumber === 1) return Promise.reject(new Error("connection closed"));
      return Promise.resolve({
        requestId: message.requestId,
        ok: true,
        status: 200,
        data: { id: message.target?.id || message.parameters?.id, status: "succeeded", result: {}, failure: null },
        error: null,
      });
    },
  });
  let failure;
  try {
    await env.submitOperation("complete-task", { kind: "task", id: "task-a" }, {});
  } catch (error) {
    failure = error;
  }

  assert.equal(failure?.kind, "uncertain");
  assert.equal(failure?.status, null);
  assert.equal(failure?.effectsState, "unknown");
  assert.equal(failure?.requestId, env.calls[0].requestId);
  const operationId = env.calls[0].parameters.id;
  assert.equal(failure?.operationId, operationId);
  assert.equal(env.calls.length, 1);

  await env.readGateway("operations.get", { kind: "operation", id: operationId }, {});
  assert.equal(env.calls.length, 2);
  assert.equal(env.calls[0].operation, "operations.submit");
  assert.equal(env.calls[1].operation, "operations.get");
  assert.equal(env.calls[1].target.id, operationId);
  assert.equal(env.calls.filter((call) => call.operation === "operations.submit").length, 1);
});

test("a mismatched write reply is uncertain and keeps its original operation ID without retry", async () => {
  const env = loadMessages({
    sendMessage: (message) => Promise.resolve({
      requestId: laterUuid,
      ok: true,
      status: 201,
      data: { id: message.parameters.id, status: "succeeded", result: {}, failure: null },
      error: null,
    }),
  });

  await assert.rejects(
    env.submitOperation("complete-task", { kind: "task", id: "task-1" }, {}),
    (error) => error.kind === "uncertain" &&
      error.effectsState === "unknown" &&
      error.operationId === env.calls[0].parameters.id &&
      error.requestId === env.calls[0].requestId,
  );
  assert.equal(env.calls.length, 1);
  assert.equal(env.calls[0].operation, "operations.submit");
});

test("connect requests only the selected HTTPS host before sending settings", async () => {
  const permission = deferred();
  const env = loadMessages({ requestPermission: (details) => {
    assert.deepEqual(JSON.parse(JSON.stringify(details)), { origins: ["https://api.example.test/*"] });
    return permission.promise;
  } });
  const pending = env.settingsMessages.connect({
    schemaVersion: 1,
    serverUrl: "https://api.example.test:9443/team/",
    token: "secret-token",
    monitorEnabled: true,
    timeoutMs: 45_000,
  });

  assert.deepEqual(env.timeline, ["permissions.request"]);
  assert.equal(env.calls.length, 0, "settings RPC waits for the optional-host prompt");
  assert.equal(env.uuidCount(), 0, "no request ID is needed before permission is granted");
  permission.resolve(true);
  await pending;

  assert.deepEqual(env.timeline, ["permissions.request", "runtime.sendMessage"]);
  assert.equal(env.calls[0].operation, "settings.connect");
  assert.equal(env.calls[0].parameters.serverUrl, "https://api.example.test:9443/team/api/v1");
  assert.equal(env.calls[0].parameters.timeoutMs, 45_000);
  assert.equal(env.calls[0].parameters.token, "secret-token");
});

test("denied host permission disarms the monitor and reports a statusless error", async () => {
  const permission = deferred();
  const env = loadMessages({ requestPermission: () => permission.promise });
  const pending = env.settingsMessages.connect({
    serverUrl: "https://api.example.test/api/v1",
    token: "secret-token",
    monitorEnabled: true,
  });
  permission.resolve(false);

  await assert.rejects(pending, (error) => error.kind === "permission-denied" && error.status === null);
  assert.equal(env.calls.length, 1);
  assert.equal(env.calls[0].operation, "settings.disconnect");
  assert.deepEqual(env.timeline, ["permissions.request", "runtime.sendMessage"]);
});

test("settings reject insecure or malformed endpoints before requesting permission", async (t) => {
  const candidates = [
    { name: "plain HTTP", serverUrl: "http://api.example.test", kind: "endpoint-invalid" },
    { name: "credentials", serverUrl: "https://user:pass@api.example.test", kind: "endpoint-invalid" },
    { name: "query", serverUrl: "https://api.example.test/api/v1?next=http://evil.test", kind: "endpoint-invalid" },
    { name: "fragment", serverUrl: "https://api.example.test/api/v1#section", kind: "endpoint-invalid" },
    { name: "encoded slash", serverUrl: "https://api.example.test/prefix/%2Fadmin", kind: "endpoint-invalid" },
    { name: "encoded dot segment", serverUrl: "https://api.example.test/prefix/%2e%2e/admin", kind: "endpoint-invalid" },
    { name: "duplicate API suffix", serverUrl: "https://api.example.test/prefix/api/v1/api/v1", kind: "endpoint-invalid" },
    { name: "invalid timeout", serverUrl: "https://api.example.test", timeoutMs: 999, kind: "invalid-request" },
  ];
  for (const candidate of candidates) {
    await t.test(candidate.name, async () => {
      const env = loadMessages();
      await assert.rejects(
        env.settingsMessages.connect({ serverUrl: candidate.serverUrl, token: "token", timeoutMs: candidate.timeoutMs }),
        (error) => error.kind === candidate.kind,
      );
      assert.deepEqual(env.timeline, []);
      assert.equal(env.calls.length, 0);
    });
  }
});

test("a typed operation problem preserves real HTTP status and effects state", async () => {
  const env = loadMessages({
    sendMessage: (message) => Promise.resolve({
      requestId: message.requestId,
      ok: false,
      status: 409,
      data: null,
      error: {
        kind: "conflict",
        title: "Conflicto",
        message: "El estado cambió.",
        operationId: message.parameters.id,
        effectsState: "partial",
      },
    }),
  });
  let failure;
  try {
    await env.submitOperation("complete-task", { kind: "task", id: "uid-1" }, {});
  } catch (error) {
    failure = error;
  }

  assert.equal(failure?.kind, "conflict");
  assert.equal(failure?.status, 409);
  assert.equal(failure?.effectsState, "partial");
  assert.equal(failure?.requestId, env.calls[0].requestId);
  assert.equal(failure?.operationId, env.calls[0].parameters.id);
  assert.notEqual(failure?.requestId, failure?.operationId);
});

test("retired manager commands fail locally instead of becoming command-style GET requests", async () => {
  const env = loadMessages();
  await assert.rejects(env.gatewayCall("GET_LIST"), (error) => error.kind === "unsupported-operation");
  await assert.rejects(env.gatewayCall("SET", { param: "due", value: "tomorrow" }), (error) => error.kind === "unsupported-operation");
  assert.equal(env.calls.length, 0);
});

test("a confirmed task operation publishes identity-based invalidations, including statistics for snooze", async () => {
  const target = { kind: "task", id: "task-a" };
  const env = bootBackground({
    initialStorage: { "settings.v1": {
      schemaVersion: 1,
      serverUrl: "https://tasks.example.test/team/api/v1",
      token: "test-token",
      monitorEnabled: true,
      timeoutMs: 30_000,
    } },
    initialPermissions: ["https://tasks.example.test/*"],
    fetch: async (_url, init) => {
      const intent = JSON.parse(init.body);
      const receipt = {
        id: intent.id,
        status: "succeeded",
        type: intent.type,
        target: intent.target,
        parameters: intent.parameters,
        result: {
          type: intent.type,
          target: intent.target,
          affectedIds: [target.id],
          effectsState: "complete",
          value: null,
          _links: { affected: [] },
        },
        failure: null,
      };
      return json(receipt, 201);
    },
  });
  const result = await env.send(rpc("operations.submit", target, {
    id: operationUuid,
    type: "snooze-task",
    parameters: { duration: "5m" },
  }), sender(env, "index.html"));

  assert.equal(result.ok, true);
  assert.deepEqual(env.runtimeMessages, [{
    protocolVersion: 1,
    event: "changes.invalidated",
    changes: {
      taskIds: ["task-a"],
      projectNames: [],
      eventNames: [],
      collections: ["tasks", "agenda", "statistics", "events"],
    },
  }]);
});

test("a confirmed patch that removes an event invalidates the event collection even without a remaining event name", async () => {
  const target = { kind: "task", id: "task-a" };
  const env = bootBackground({
    initialStorage: { "settings.v1": settings },
    initialPermissions: [HOST_PERMISSION],
    fetch: async () => json({
      id: target.id,
      description: "Task A",
      context: "work",
      status: "active",
      raised: null,
      waited: null,
      actions: [],
      _links: { self: { href: `${BASE}/tasks/task-a` } },
    }),
  });
  const result = await env.send(rpc("tasks.patch", target, { raised: null }), sender(env, "index.html"));

  assert.equal(result.ok, true);
  assert.deepEqual(env.runtimeMessages, [{
    protocolVersion: 1,
    event: "changes.invalidated",
    changes: {
      taskIds: ["task-a"],
      projectNames: [],
      eventNames: [],
      collections: ["tasks", "statistics", "agenda", "events"],
    },
  }]);
});

test("a popup action whose agenda read finishes after its local identity changed is not submitted", async () => {
  let isCurrent = true;
  const env = loadMessages({
    sendMessage: (message) => {
      isCurrent = false;
      return Promise.resolve({
        requestId: message.requestId,
        ok: true,
        status: 200,
        data: { _embedded: { activeUrgentTasks: [{ id: "task-a" }] } },
        error: null,
      });
    },
  });

  await assert.rejects(
    env.gatewayCall("POPUP_DONE", env.vmObject({
      expectedTask: { id: "task-a" },
      day: "2026-10-05",
      heuristic: "Remaining Effort(1)",
    }), { isCurrent: () => isCurrent }),
    (error) => error.kind === "invalid-request" && error.effectsState === "none",
  );
  assert.equal(env.calls.length, 1);
  assert.equal(env.calls[0].operation, "agenda.read");
});

test("a popup action is checked again immediately before submit dispatch", async () => {
  let checks = 0;
  const env = loadMessages({
    sendMessage: (message) => Promise.resolve({
      requestId: message.requestId,
      ok: true,
      status: 200,
      data: { _embedded: { activeUrgentTasks: [{ id: "task-a" }] } },
      error: null,
    }),
  });

  await assert.rejects(
    env.gatewayCall("POPUP_SNOOZE", env.vmObject({
      expectedTask: { id: "task-a" },
      day: "2026-10-05",
      heuristic: "Remaining Effort(1)",
    }), { isCurrent: () => ++checks === 1 }),
    (error) => error.kind === "invalid-request" && error.effectsState === "none",
  );
  assert.equal(checks, 2);
  assert.equal(env.calls.length, 1);
  assert.equal(env.calls[0].operation, "agenda.read");
});

test("popup legacy actions preflight the current urgent identity and submit one typed operation", async (t) => {
  const expectedTask = { id: "task/ü" };
  const scenarios = [
    { operation: "POPUP_DONE", type: "complete-task", parameters: {} },
    { operation: "POPUP_SNOOZE", type: "snooze-task", parameters: { duration: "5m" } },
  ];
  for (const scenario of scenarios) {
    await t.test(scenario.operation, async () => {
      const env = loadMessages({
        sendMessage: (message, callNumber) => Promise.resolve(callNumber === 1 ? {
          requestId: message.requestId,
          ok: true,
          status: 200,
          data: { _embedded: { activeUrgentTasks: [expectedTask] } },
          error: null,
        } : {
          requestId: message.requestId,
          ok: true,
          status: 201,
          data: { id: message.parameters.id, status: "succeeded", result: {}, failure: null },
          error: null,
        }),
      });
      const reply = await env.gatewayCall(scenario.operation, env.vmObject({
        expectedTask,
        day: "2026-10-05",
        heuristic: "Remaining Effort(1)",
      }), { isCurrent: () => true });

      assert.equal(reply.ok, true);
      assert.equal(env.calls.length, 2);
      assert.deepEqual(env.calls.map((call) => call.operation), ["agenda.read", "operations.submit"]);
      assert.deepEqual(env.calls[1].target, { kind: "task", id: expectedTask.id });
      assert.notEqual(env.calls[1].requestId, env.calls[1].parameters.id);
      assert.equal(env.calls[1].parameters.type, scenario.type);
      assert.deepEqual(env.calls[1].parameters.parameters, scenario.parameters);
      assert.ok(env.timeline.indexOf("runtime.sendMessage") >= 0);
      assert.equal(env.timeline.filter((entry) => entry === "runtime.sendMessage").length, 2);
    });
  }
});

test("popup action stops before submit when the urgent task identity is stale", async () => {
  const expectedTask = { id: "task-1" };
  const env = loadMessages({
    sendMessage: (message) => Promise.resolve({
      requestId: message.requestId,
      ok: true,
      status: 200,
      data: { _embedded: { activeUrgentTasks: [{ id: "task-2" }] } },
      error: null,
    }),
  });

  await assert.rejects(env.gatewayCall("POPUP_DONE", env.vmObject({
    expectedTask,
    day: "2026-10-05",
    heuristic: "Remaining Effort(1)",
  }), { isCurrent: () => true }), (error) => error.kind === "task-changed");
  assert.deepEqual(env.calls.map((call) => call.operation), ["agenda.read"]);
});

test("reply correlation rejects a mismatched request ID without trusting the response status", async () => {
  const env = loadMessages({
    sendMessage: () => Promise.resolve({ requestId: secondUuid, ok: false, status: 599, data: null, error: { kind: "http" } }),
  });

  await assert.rejects(env.readGateway("root.read"), (error) => error.kind === "request-mismatch" && error.status === null);
});


test("background monitor invalidations admit broad refreshes and still validate sender and fields", () => {
  const env = loadMessages();
  const message = env.vmObject({ protocolVersion: 1, event: "changes.invalidated", changes: {
    taskIds: [], projectNames: [], eventNames: [], collections: ["tasks", "agenda"], refreshAll: true,
  } });
  const sender = { id: "test-extension", url: "moz-extension://test/background.js" };
  assert.equal(env.readInvalidation(message, sender).refreshAll, true);
  assert.equal(env.readInvalidation(message, { ...sender, id: "another-extension" }), null);
  message.changes.refreshAll = "yes";
  assert.equal(env.readInvalidation(message, sender), null);
  message.changes.refreshAll = true;
  message.changes.unexpected = true;
  assert.equal(env.readInvalidation(message, sender), null);
});
