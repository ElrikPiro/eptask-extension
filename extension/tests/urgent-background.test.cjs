const assert = require("node:assert/strict");
const test = require("node:test");
const { bootBackground, response } = require("./helpers.cjs");

const SETTINGS_KEY = "settings.v1";
const ERROR_KEY = "gatewayError.v1";
const URGENCY_KEY = "urgentIndicator.v1";
const LEGACY_ALARM = "eptask-notification-monitor";
const URGENCY_ALARM = "eptask-urgent-indicator";
const BASE = "https://tasks.example.test:9443/prefix/api/v1";
const HOST_PERMISSION = "https://tasks.example.test/*";
const REQUEST_ID = "00000000-0000-4000-8000-000000000031";
const settings = {
  schemaVersion: 1,
  serverUrl: BASE,
  token: "test-bearer-token",
  monitorEnabled: true,
  timeoutMs: 30_000,
};

function json(value, status = 200) {
  return response(value, status, status >= 400 ? "application/problem+json" : "application/hal+json");
}

function agenda(tasks) {
  return {
    _links: { self: { href: `${BASE}/agenda` } },
    _embedded: { activeUrgentTasks: tasks },
  };
}

function rpc(operation, target = null, parameters = {}) {
  return { protocolVersion: 1, requestId: REQUEST_ID, operation, target, parameters };
}

function sender(env, page = "index.html") {
  return { id: env.extensionId, url: env.namespace.runtime.getURL(page) };
}

function waitFor(predicate, description, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const check = () => {
      if (predicate()) return resolve();
      if (Date.now() >= deadline) return reject(new Error(`Timed out waiting for ${description}`));
      setImmediate(check);
    };
    check();
  });
}

function boot(fetch) {
  return bootBackground({
    initialStorage: { [SETTINGS_KEY]: settings },
    initialPermissions: [HOST_PERMISSION],
    fetch,
  });
}

test("the urgency alarm makes a query-free authenticated HTTPS read without notification side effects", async () => {
  const tasks = [{ id: "task/東京", description: "Prepare release", context: "work" }];
  const env = boot(async () => json(agenda(tasks)));
  env.fireAlarm(URGENCY_ALARM);
  await waitFor(() => env.requests.length === 1, "the agenda request");
  await waitFor(() => env.badgeState.text === "●", "the urgency badge");

  const request = env.requests[0];
  assert.equal(request.url, `${BASE}/agenda`);
  assert.equal(request.init.method, "GET");
  assert.equal(request.init.headers.Authorization, "Bearer test-bearer-token");
  assert.equal(request.init.redirect, "error");
  assert.equal(request.init.cache, "no-store");
  assert.equal(request.init.credentials, "omit");
  assert.equal(env.localData[URGENCY_KEY].active, true);
  assert.equal(env.notificationCalls.length, 0);
});

test("the retired notification alarm never fetches or clears notifications", async () => {
  const env = boot(async () => json(agenda([])));
  env.fireAlarm(LEGACY_ALARM);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(env.requests.length, 0);
  assert.equal(env.notificationCalls.length, 0);
});

test("agenda failures show a safe error badge and store no bearer token or endpoint details", async () => {
  const token = settings.token;
  const env = boot(async () => json({
    code: "service-unavailable",
    title: "Unavailable",
    detail: `Bearer ${token} could not reach https://private.example/path`,
    effectsState: "none",
  }, 503));
  const reply = await env.send(rpc("agenda.read"), sender(env, "popup.html"));

  assert.equal(reply.ok, false);
  assert.equal(reply.status, 503);
  assert.equal(reply.error.kind, "http");
  assert.equal(env.badgeState.text, "!");
  assert.doesNotMatch(JSON.stringify(env.localData[ERROR_KEY]), new RegExp(token));
  assert.doesNotMatch(JSON.stringify(env.localData[ERROR_KEY]), /private\.example|https:\/\//);
  assert.equal(env.notificationCalls.length, 0);
});

test("a worker restart preserves the last gateway error badge and its popup diagnostic", async () => {
  const savedError = {
    kind: "network",
    title: "No se pudo conectar",
    message: "No se pudo contactar con el servidor.",
    requestId: REQUEST_ID,
    updatedAt: "2026-10-05T08:00:00.000Z",
  };
  const env = bootBackground({
    initialStorage: {
      [SETTINGS_KEY]: settings,
      [ERROR_KEY]: savedError,
      [URGENCY_KEY]: { active: false, endpoint: BASE, updatedAt: "2026-10-05T08:00:00.000Z" },
    },
    initialPermissions: [HOST_PERMISSION],
    fetch: async () => json(agenda([])),
  });
  await waitFor(() => env.badgeState.text === "!", "the restored error badge");

  assert.deepEqual(env.localData[ERROR_KEY], savedError);
  assert.equal(env.badgeState.title, "ElrikPiro: No se pudo conectar. No se pudo contactar con el servidor.");
  assert.equal(env.requests.length, 0);
});

test("a legacy command message is rejected without contacting the task server", async () => {
  const env = boot(async () => json(agenda([])));
  const reply = await env.send({ type: "gateway.call", requestId: REQUEST_ID, operation: "GET_LIST", args: {} }, sender(env));

  assert.equal(reply.ok, false);
  assert.equal(reply.error.kind, "invalid-request");
  assert.equal(env.requests.length, 0);
});

test("settings control messages from popup are rejected before any network request", async () => {
  const env = boot(async () => json(agenda([])));
  const reply = await env.send(rpc("settings.disconnect"), sender(env, "popup.html"));

  assert.equal(reply.ok, false);
  assert.equal(reply.error.kind, "unauthorized-sender");
  assert.equal(env.requests.length, 0);
});
