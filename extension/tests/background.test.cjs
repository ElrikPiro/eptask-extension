const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { bootBackground, response, extensionRoot } = require("./helpers.cjs");

const SETTINGS_KEY = "settings.v1";
const HISTORY_KEY = "notificationHistory.v1";
const STATUS_KEY = "monitorStatus.v1";
const ALARM = "eptask-notification-monitor";

function activeSettings(overrides = {}) {
  return {
    schemaVersion: 1,
    serverUrl: "http://tasks.example.test/prefix/api",
    token: "test-bearer-token",
    monitorEnabled: true,
    ...overrides,
  };
}

function agenda(tasks = []) {
  return { active_urgent_tasks: tasks, planned_tasks_by_date: {} };
}

function task(id, context = "work", description = `Task ${id}`) {
  return { id, context, description };
}

function json(value, status = 200) {
  return response(value, status, "application/json");
}

function plain(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

async function waitFor(predicate, description, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(`Timed out waiting for ${description}`);
}

async function fireAndWaitForStatus(env, name = ALARM) {
  env.fireAlarm(name);
  await waitFor(() => Boolean(env.localData[STATUS_KEY]), `monitor status after ${name}`);
}

test("background registers message, alarm, install, and startup listeners before async work", () => {
  const source = fs.readFileSync(path.join(extensionRoot, "background.js"), "utf8");
  const env = bootBackground({ fetch: async () => json(agenda()) });

  assert.equal(env.events.runtime.listeners.length, 1);
  assert.equal(env.events.alarm.listeners.length, 1);
  assert.equal(env.events.installed.listeners.length, 1);
  assert.equal(env.events.startup.listeners.length, 1);
  assert.match(source, /onMessage\.addListener/);
});

for (const mode of ["browser", "chrome"]) {
  test(`${mode} adapter sends allowlisted requests to the configured prefixed URL with Bearer auth`, async () => {
    const env = bootBackground({
      mode,
      initialStorage: { [SETTINGS_KEY]: activeSettings() },
      fetch: async () => json(agenda()),
    });
    const reply = plain(await env.send({ type: "gateway.call", requestId: "agenda-1", operation: "GET_AGENDA", args: {} }));

    assert.equal(reply.requestId, "agenda-1");
    assert.equal(reply.ok, true);
    assert.equal(env.requests.length, 1);
    assert.equal(env.requests[0].url, "http://tasks.example.test/prefix/api/agenda");
    assert.equal(env.requests[0].init.method, "GET");
    assert.equal(env.requests[0].init.headers.Authorization, "Bearer test-bearer-token");
    assert.equal(env.requests[0].init.body, undefined);
    assert.equal(env.requests[0].init.headers["X-Atm-Target"], undefined);
  });
}

test("dependent task action reselection and ID check stay in FIFO order; arguments use URLSearchParams", async () => {
  const env = bootBackground({
    initialStorage: { [SETTINGS_KEY]: activeSettings() },
    fetch: async (url) => {
      if (String(url).endsWith("/list")) return json({ tasks: [
        ...Array.from({ length: 6 }, (_, index) => ({ id: `other-${index + 1}`, description: `Other ${index + 1}`, context: "work" })),
        { id: "task-seven", description: "Pay invoice", context: "work" },
      ] });
      if (String(url).endsWith("/task_7")) return json({ task: { id: "unknown", description: "Pay invoice", context: "work" } });
      return json({ changed: true });
    },
  });
  const reply = plain(await env.send({
    type: "gateway.call",
    requestId: "set-1",
    operation: "SET",
    args: { param: "due", value: "tomorrow & details?", target: { index: 7, expectedTaskId: "task-seven" } },
  }));

  assert.equal(reply.ok, true);
  assert.deepEqual(env.requests.map((request) => new URL(request.url).pathname), [
    "/prefix/api/list",
    "/prefix/api/task_7",
    "/prefix/api/set",
  ]);
  assert.equal(new URL(env.requests[2].url).searchParams.get("args"), "due tomorrow & details?");
  assert.equal(env.requests.every((request) => request.init.method === "GET" && request.init.body === undefined), true);
});

test("action refuses to run when the selected task ID differs", async () => {
  const env = bootBackground({
    initialStorage: { [SETTINGS_KEY]: activeSettings() },
    fetch: async () => json({ tasks: [{ id: "different-task", description: "Other", context: "work" }] }),
  });
  const reply = plain(await env.send({
    type: "gateway.call",
    requestId: "work-stale",
    operation: "WORK",
    args: { amount: "20m", target: { index: 4, expectedTaskId: "expected-task" } },
  }));

  assert.equal(reply.ok, false);
  assert.equal(reply.error.kind, "invalid-response");
  assert.equal(env.requests.length, 1);
  assert.match(new URL(env.requests[0].url).pathname, /\/list$/);
});

test("GET_INFO and SELECT_TASK normalize a raw unknown detail ID using the verified UID row", async () => {
  const row = { id: "stable-uid-1", description: "Write report", context: "work" };
  const env = bootBackground({
    initialStorage: { [SETTINGS_KEY]: activeSettings() },
    fetch: async (url) => {
      if (String(url).endsWith("/list")) return json({ tasks: [row] });
      if (String(url).endsWith("/task_1")) return json({ task: { id: "unknown", description: row.description, context: row.context } });
      if (String(url).endsWith("/info")) return json({ task: { id: "unknown", description: row.description, context: row.context }, extended: { metadata: "local" } });
      return json({});
    },
  });
  const selected = plain(await env.send({
    type: "gateway.call", requestId: "select-1", operation: "SELECT_TASK", args: { index: 1, expectedTaskId: row.id },
  }));
  const info = plain(await env.send({
    type: "gateway.call", requestId: "info-1", operation: "GET_INFO", args: { target: { index: 1, expectedTaskId: row.id } },
  }));

  assert.equal(selected.ok, true);
  assert.equal(selected.data.task.id, row.id);
  assert.equal(selected.verifiedTaskId, row.id);
  assert.equal(info.ok, true);
  assert.equal(info.data.task.id, row.id);
  assert.equal(info.data.extended.metadata, "local");
  assert.deepEqual(env.requests.map((request) => new URL(request.url).pathname), [
    "/prefix/api/list", "/prefix/api/task_1",
    "/prefix/api/list", "/prefix/api/task_1", "/prefix/api/info",
  ]);
});

test("page-two selection restores pagination inside one FIFO group before UID validation", async () => {
  const row = { id: "page-two-uid", description: "Second page task", context: "project" };
  const env = bootBackground({
    initialStorage: { [SETTINGS_KEY]: activeSettings() },
    fetch: async (url) => {
      const pathName = new URL(url).pathname;
      if (pathName.endsWith("/list")) return json({ tasks: [{ id: "page-one-uid", description: "First page", context: "work" }], current_page: 1, total_pages: 2 });
      if (pathName.endsWith("/next")) return json({ tasks: [row], current_page: 2, total_pages: 2 });
      if (pathName.endsWith("/task_1")) return json({ task: { id: "unknown", description: row.description, context: row.context } });
      return json({ worked: true });
    },
  });
  const reply = plain(await env.send({
    type: "gateway.call", requestId: "page-two", operation: "WORK",
    args: { amount: "20m", target: { index: 1, page: 2, expectedTaskId: row.id } },
  }));

  assert.equal(reply.ok, true);
  assert.deepEqual(env.requests.map((request) => new URL(request.url).pathname), [
    "/prefix/api/list", "/prefix/api/next", "/prefix/api/task_1", "/prefix/api/work",
  ]);
});

test("out-of-range task page is rejected before paging or selection", async () => {
  const env = bootBackground({
    initialStorage: { [SETTINGS_KEY]: activeSettings() },
    fetch: async () => json({ tasks: [{ id: "uid", description: "Only task", context: "work" }], current_page: 1, total_pages: 1 }),
  });
  const reply = plain(await env.send({
    type: "gateway.call", requestId: "past-last-page", operation: "DONE",
    args: { target: { index: 1, page: 2, expectedTaskId: "uid" } },
  }));

  assert.equal(reply.ok, false);
  assert.equal(reply.error.kind, "invalid-response");
  assert.deepEqual(env.requests.map((request) => new URL(request.url).pathname), ["/prefix/api/list"]);
});

test("configuration change during page navigation prevents task selection and mutation", async () => {
  let releaseNext;
  const env = bootBackground({
    initialStorage: { [SETTINGS_KEY]: activeSettings() },
    fetch: async (url) => {
      const pathName = new URL(url).pathname;
      if (pathName.endsWith("/list")) return json({ tasks: [{ id: "page-one-uid", description: "First page", context: "work" }], current_page: 1, total_pages: 2 });
      if (pathName.endsWith("/next")) return new Promise((resolve) => { releaseNext = () => resolve(json({ tasks: [{ id: "page-two-uid", description: "Second page", context: "work" }], current_page: 2, total_pages: 2 })); });
      return json({ task: { id: "page-two-uid", description: "Second page", context: "work" } });
    },
  });
  const action = env.send({
    type: "gateway.call", requestId: "page-race", operation: "WORK",
    args: { amount: "20m", target: { index: 1, page: 2, expectedTaskId: "page-two-uid" } },
  });
  await waitFor(() => env.requests.length === 2, "next-page request");
  const disconnected = plain(await env.send({ type: "settings.disconnect", requestId: "disconnect-page-race", args: {} }));
  assert.equal(disconnected.ok, true);
  releaseNext();
  const reply = plain(await action);

  assert.equal(reply.ok, false);
  assert.equal(reply.error.kind, "invalid-config");
  assert.deepEqual(env.requests.map((request) => new URL(request.url).pathname), ["/prefix/api/list", "/prefix/api/next"]);
});

test("selection rejects a short or incompatible backend page before calling /task_N", async (t) => {
  const scenarios = [
    { name: "short page", list: { tasks: [] } },
    { name: "different selected description", list: { tasks: [{ id: "stable-uid-1", description: "Other", context: "work" }] }, detail: { task: { id: "unknown", description: "Expected", context: "work" } } },
    { name: "different selected context", list: { tasks: [{ id: "stable-uid-1", description: "Expected", context: "work" }] }, detail: { task: { id: "unknown", description: "Expected", context: "alert" } } },
    { name: "unexpected non-unknown ID", list: { tasks: [{ id: "stable-uid-1", description: "Expected", context: "work" }] }, detail: { task: { id: "other-uid", description: "Expected", context: "work" } } },
  ];
  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const env = bootBackground({
        initialStorage: { [SETTINGS_KEY]: activeSettings() },
        fetch: async (url) => String(url).endsWith("/list") ? json(scenario.list) : json(scenario.detail || {}),
      });
      const reply = plain(await env.send({
        type: "gateway.call", requestId: scenario.name, operation: "SELECT_TASK", args: { index: 1, expectedTaskId: "stable-uid-1" },
      }));

      assert.equal(reply.ok, false);
      assert.equal(reply.error.kind, "invalid-response");
      assert.equal(env.requests.some((request) => /\/task_1(?:\?|$)/.test(request.url)), scenario.name !== "short page");
    });
  }
});

test("concurrent gateway calls are dispatched FIFO, one HTTP request at a time", async () => {
  let releaseFirst;
  const env = bootBackground({
    initialStorage: { [SETTINGS_KEY]: activeSettings() },
    fetch: async (_url, _init) => {
      if (!releaseFirst) return new Promise((resolve) => { releaseFirst = () => resolve(json(agenda())); });
      return json(agenda());
    },
  });
  const first = env.send({ type: "gateway.call", requestId: "fifo-1", operation: "GET_AGENDA", args: {} });
  await waitFor(() => env.requests.length === 1, "first FIFO request");
  const second = env.send({ type: "gateway.call", requestId: "fifo-2", operation: "GET_AGENDA", args: {} });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(env.requests.length, 1, "second request must wait for the first response");

  releaseFirst();
  const replies = await Promise.all([first, second]);
  assert.deepEqual(replies.map((reply) => plain(reply).requestId), ["fifo-1", "fifo-2"]);
  assert.equal(env.requests.length, 2);
});

test("invalid senders, arbitrary operations, and credentials in gateway messages never reach fetch", async () => {
  const env = bootBackground({ initialStorage: { [SETTINGS_KEY]: activeSettings() } });
  const external = await env.send(
    { type: "gateway.call", requestId: "external", operation: "GET_AGENDA", args: {} },
    { id: "attacker", url: "https://example.test/" },
  );
  const privateQueue = plain(await env.send({ type: "gateway.call", requestId: "queue", operation: "GET_NOTIFICATIONS", args: {} }));
  const credentialInjection = plain(await env.send({ type: "gateway.call", requestId: "url", operation: "GET_AGENDA", args: {}, settings: activeSettings({ token: "stolen" }) }));

  assert.equal(plain(external).ok, false);
  assert.equal(privateQueue.ok, false);
  assert.equal(credentialInjection.ok, false);
  assert.equal(env.requests.length, 0);
});

test("valid empty notification batch alone opens the first-task exact-alert branch", async () => {
  const cases = [
    { label: "literal alert", tasks: [task("1", "alert"), task("2", "work")], notices: 1 },
    { label: "trimmed alert", tasks: [task("1", " alert"), task("2", "alert")], notices: 0 },
    { label: "later alert", tasks: [task("1", "work"), task("2", "alert")], notices: 0 },
    { label: "empty agenda", tasks: [], notices: 0 },
  ];
  for (const scenario of cases) {
    const env = bootBackground({
      initialStorage: { [SETTINGS_KEY]: activeSettings() },
      fetch: async (url) => String(url).includes("/notifications") ? json([]) : json(agenda(scenario.tasks)),
    });
    await fireAndWaitForStatus(env);

    assert.equal(env.requests.length, 2, scenario.label);
    assert.equal(env.notificationCalls.length, scenario.notices, scenario.label);
    assert.equal(env.requests.some((request) => /\/(?:task_1|info)(?:\?|$)/.test(request.url)), false, scenario.label);
    assert.equal(env.requests.filter((request) => request.url.includes("/notifications?")).length, 1, scenario.label);
  }
});

test("a nonempty batch is persisted before one grouped notification and history stays capped at 500", async () => {
  const oldRows = Array.from({ length: 500 }, (_, index) => ({
    localId: `old-${index}`,
    message: `old message ${index}`,
    timestamp: `old time ${index}`,
    receivedAt: "2026-01-01T00:00:00.000Z",
  }));
  const batch = [
    { message: "first backend message", timestamp: "backend-time-1" },
    { message: "second backend message", timestamp: "backend-time-2" },
  ];
  const env = bootBackground({
    initialStorage: { [SETTINGS_KEY]: activeSettings(), [HISTORY_KEY]: oldRows },
    fetch: async () => json(batch),
  });
  await fireAndWaitForStatus(env);

  const rows = env.localData[HISTORY_KEY];
  assert.equal(rows.length, 500);
  assert.equal(rows[0].localId, "old-2");
  assert.deepEqual(rows.slice(-2).map(({ message, timestamp }) => ({ message, timestamp })), batch);
  assert.ok(rows.at(-1).localId);
  assert.ok(rows.at(-1).receivedAt);
  assert.equal(env.notificationCalls.length, 1);
  assert.match(env.notificationCalls[0].options.title, /2/);
  const persistedAt = env.timeline.findIndex((item) => item.type === "storage.set" && item.items[HISTORY_KEY]);
  const notifiedAt = env.timeline.findIndex((item) => item.type === "notification.create");
  assert.ok(persistedAt >= 0 && notifiedAt > persistedAt, "notification must follow persisted history");
  assert.equal(env.requests.length, 1, "a nonempty batch skips agenda");
  assert.match(env.requests[0].url, /\/notifications\?mask_as_read=true$/);
});

test("HTTP and malformed notification failures terminate before agenda and do not notify", async (t) => {
  const scenarios = [
    { name: "unauthorized response", first: async () => response("Unauthorized", 401, "text/plain") },
    { name: "server failure", first: async () => response("diagnostic test-bearer-token", 503, "text/plain") },
    { name: "invalid JSON", first: async () => response("{oops", 200, "application/json") },
    { name: "invalid notification shape", first: async () => json({ message: "not an array" }) },
  ];
  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const env = bootBackground({
        initialStorage: { [SETTINGS_KEY]: activeSettings() },
        fetch: scenario.first,
      });
      await fireAndWaitForStatus(env);

      assert.equal(env.requests.length, 1);
      assert.equal(env.notificationCalls.length, 0);
      assert.equal(env.requests.some((request) => request.url.endsWith("/agenda")), false);
      assert.equal(env.localData[STATUS_KEY].ok, false);
      assert.ok(env.localData[STATUS_KEY].error);
      if (scenario.name === "server failure") {
        assert.equal(env.localData[STATUS_KEY].status, 503);
        assert.equal(JSON.stringify(env.localData[STATUS_KEY]).includes("test-bearer-token"), false);
      }
    });
  }
});

test("notification timeout aborts the request and never falls through to agenda", async () => {
  const scheduled = new Map();
  let nextTimer = 1;
  const timers = {
    setTimeout(callback, delay) {
      const id = nextTimer++;
      scheduled.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) { scheduled.delete(id); },
  };
  const env = bootBackground({
    timers,
    initialStorage: { [SETTINGS_KEY]: activeSettings() },
    fetch: async (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    }),
  });
  env.fireAlarm(ALARM);
  await waitFor(() => env.requests.length === 1, "notification request start");
  const timer = [...scheduled.values()].find(({ delay }) => delay === 10_000);
  assert.ok(timer, "HTTP gateway must schedule a ten-second timeout");
  timer.callback();
  await waitFor(() => Boolean(env.localData[STATUS_KEY]), "timeout status");

  assert.equal(env.requests.length, 1);
  assert.equal(env.notificationCalls.length, 0);
  assert.equal(env.localData[STATUS_KEY].error.kind, "timeout");
});

test("alarm ignores foreign names and stays inert when disconnected", async () => {
  const env = bootBackground({ initialStorage: { [SETTINGS_KEY]: activeSettings({ monitorEnabled: false }) } });
  env.fireAlarm("some-other-extension-alarm");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(env.requests.length, 0);
  assert.equal(env.notificationCalls.length, 0);

  env.fireAlarm(ALARM);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(env.requests.length, 0);
});

test("a second alarm received during a monitor cycle is ignored without overlapping fetches", async () => {
  let releaseNotifications;
  const env = bootBackground({
    initialStorage: { [SETTINGS_KEY]: activeSettings() },
    fetch: async (url) => {
      if (String(url).includes("/notifications")) {
        return new Promise((resolve) => { releaseNotifications = () => resolve(json([])); });
      }
      return json(agenda());
    },
  });
  env.fireAlarm(ALARM);
  await waitFor(() => env.requests.length === 1, "first monitor notification fetch");
  env.fireAlarm(ALARM);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(env.requests.length, 1);
  releaseNotifications();
  await waitFor(() => Boolean(env.localData[STATUS_KEY]), "first monitor completion");
  assert.equal(env.requests.filter((request) => request.url.includes("/notifications?")).length, 1);
  assert.equal(env.requests.filter((request) => request.url.endsWith("/agenda")).length, 1);
});

test("alarm reconciliation creates one five-minute alarm and preserves a valid existing one", async () => {
  const env = bootBackground({ fetch: async () => json(agenda()) });
  await waitFor(() => env.alarmCreates.length === 1, "initial monitor alarm");
  assert.equal(env.alarmCreates[0].name, ALARM);
  assert.equal(env.alarmCreates[0].info.periodInMinutes, 5);
  assert.equal(env.alarmCreates[0].info.delayInMinutes, 5);

  const scheduledTime = env.alarmData.get(ALARM).scheduledTime;
  env.events.installed.fire({ reason: "update" });
  env.events.startup.fire();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(env.alarmCreates.length, 1);
  assert.equal(env.alarmData.get(ALARM).scheduledTime, scheduledTime);
  assert.equal(env.requests.length, 0, "reconciling an alarm does not start an immediate monitor request");
});

test("a stale task connection cannot overwrite settings saved while its probe is in flight", async () => {
  let releaseProbe;
  const env = bootBackground({
    fetch: async () => new Promise((resolve) => { releaseProbe = () => resolve(json(agenda())); }),
  });
  const connect = env.send({
    type: "settings.connect",
    requestId: "connect-old",
    settings: activeSettings({ serverUrl: "http://old.example.test/base", token: "old-token", monitorEnabled: true }),
  });
  await waitFor(() => env.requests.length === 1, "old settings probe");
  const saved = plain(await env.send({
    type: "settings.save",
    requestId: "save-new",
    settings: activeSettings({ serverUrl: "http://new.example.test/base", token: "new-token", monitorEnabled: true }),
    args: {},
  }));
  assert.equal(saved.ok, true);
  releaseProbe();
  const result = plain(await connect);

  assert.equal(result.ok, false);
  assert.equal(env.localData[SETTINGS_KEY].serverUrl, "http://new.example.test/base");
  assert.equal(env.localData[SETTINGS_KEY].token, "new-token");
  assert.equal(env.localData[SETTINGS_KEY].monitorEnabled, false);
  assert.equal(env.requests.length, 1);
});

test("disconnect prevents already queued operations from starting new fetches", async () => {
  let releaseFirst;
  const env = bootBackground({
    initialStorage: { [SETTINGS_KEY]: activeSettings() },
    fetch: async () => new Promise((resolve) => { releaseFirst = () => resolve(json(agenda())); }),
  });
  const first = env.send({ type: "gateway.call", requestId: "first", operation: "GET_AGENDA", args: {} });
  await waitFor(() => env.requests.length === 1, "first request");
  const queued = env.send({ type: "gateway.call", requestId: "queued", operation: "GET_AGENDA", args: {} });
  const disconnected = plain(await env.send({ type: "settings.disconnect", requestId: "disconnect", args: {} }));
  assert.equal(disconnected.ok, true);
  releaseFirst();
  const [firstReply, queuedReply] = await Promise.all([first, queued]);

  assert.equal(plain(firstReply).ok, true, "an already-started request may complete");
  assert.equal(plain(queuedReply).ok, false);
  assert.equal(env.requests.length, 1, "disconnected work in the queue does not start a new request");
  assert.equal(env.localData[SETTINGS_KEY].monitorEnabled, false);
});

test("invalid configuration disables an active monitor and the error never exposes the token", async () => {
  const env = bootBackground({ initialStorage: { [SETTINGS_KEY]: activeSettings() } });
  const result = plain(await env.send({
    type: "settings.save",
    requestId: "bad-url",
    settings: activeSettings({ serverUrl: "/api", monitorEnabled: true }),
    args: {},
  }));

  assert.equal(result.ok, false);
  assert.equal(env.localData[SETTINGS_KEY].monitorEnabled, false);
  assert.equal(JSON.stringify(result).includes("test-bearer-token"), false);
  const gateway = plain(await env.send({ type: "gateway.call", requestId: "after-invalid", operation: "GET_AGENDA", args: {} }));
  assert.equal(gateway.ok, false);
  assert.equal(env.requests.length, 0);
});
