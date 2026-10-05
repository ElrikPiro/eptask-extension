const assert = require("node:assert/strict");
const test = require("node:test");
const { bootBackground } = require("./helpers.cjs");

const RECENCY_KEY = "managerRecency.v1";
const REQUEST_ID = "00000000-0000-4000-8000-000000000091";

function openRequest(overrides = {}) {
  return {
    protocolVersion: 1,
    requestId: REQUEST_ID,
    operation: "manager.open",
    target: null,
    parameters: {},
    ...overrides,
  };
}

function managerSender(env, page = "popup.html", id = env.extensionId) {
  return { id, url: env.namespace.runtime.getURL(page) };
}

function candidate(env, id, windowId, overrides = {}) {
  return {
    id,
    windowId,
    active: false,
    url: env.namespace.runtime.getURL("index.html"),
    title: "ElrikPiro",
    ...overrides,
  };
}

function recency(entries, nextOrdinal = 1) {
  return {
    schemaVersion: 1,
    nextOrdinal,
    candidates: entries,
  };
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

async function idle() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

async function bootManager(options = {}) {
  const env = bootBackground(options);
  await idle();
  return env;
}

test("manager.open creates one exact extension manager tab when no candidate exists", async () => {
  const settings = {
    schemaVersion: 1,
    serverUrl: "https://tasks.example.test/api/v1",
    token: "manager-open-secret",
    monitorEnabled: false,
    timeoutMs: 30000,
  };
  const env = await bootManager({ initialStorage: { "settings.v1": settings } });
  const reply = await env.send(openRequest(), managerSender(env));

  assert.equal(reply.ok, true);
  assert.deepEqual(plain(reply.data), { opened: true, reused: false });
  const creates = env.tabCalls.filter((call) => call.method === "create");
  assert.equal(creates.length, 1);
  assert.deepEqual(creates[0].properties, {
    url: env.namespace.runtime.getURL("index.html"),
    active: true,
  });
  assert.equal(env.tabsState.length, 1);
  assert.equal(env.tabsState[0].url, env.namespace.runtime.getURL("index.html"));
  assert.equal(env.tabsState[0].active, true);
  assert.equal(env.requests.length, 0, "opening the local manager never contacts the task server");
  assert.deepEqual(env.localData["settings.v1"], settings);
});

test("simultaneous open requests share one discovery and do not create duplicate tabs", async () => {
  const env = await bootManager();
  const [first, second] = await Promise.all([
    env.send(openRequest(), managerSender(env)),
    env.send(openRequest({ requestId: "00000000-0000-4000-8000-000000000092" }), managerSender(env)),
  ]);

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.deepEqual(plain(first.data), { opened: true, reused: false });
  assert.deepEqual(plain(second.data), { opened: true, reused: false });
  assert.equal(env.tabCalls.filter((call) => call.method === "create").length, 1);
});

test("manager.open reuses the most recently activated candidate and restores its minimized window", async () => {
  const envBase = bootBackground({
    initialWindows: [
      { id: 1, focused: false, state: "normal" },
      { id: 2, focused: true, state: "minimized" },
    ],
    initialTabs: [],
  });
  envBase.tabsState.push(
    candidate(envBase, 10, 1, { active: true }),
    candidate(envBase, 20, 2),
  );
  envBase.localData[RECENCY_KEY] = recency([
    { tabId: 10, windowId: 1, ordinal: 2 },
    { tabId: 20, windowId: 2, ordinal: 9 },
  ], 10);
  await idle();

  const reply = await envBase.send(openRequest(), managerSender(envBase));
  assert.equal(reply.ok, true);
  assert.deepEqual(plain(reply.data), { opened: true, reused: true });
  assert.equal(envBase.tabCalls.filter((call) => call.method === "create").length, 0);
  assert.ok(envBase.tabCalls.some((call) => call.method === "update" && call.tabId === 20 && call.properties.active === true));
  assert.equal(envBase.tabsState.find((tab) => tab.id === 20).active, true);
  assert.equal(envBase.windowsState.find((window) => window.id === 2).state, "normal");
  assert.equal(envBase.windowsState.find((window) => window.id === 2).focused, true);
  assert.ok(envBase.windowCalls.some((call) => call.method === "update" && call.windowId === 2 && call.properties.state === "normal" && call.properties.focused === true));
});

test("opening a candidate in a maximized window focuses it without changing its presentation state", async () => {
  const env = await bootManager({
    initialWindows: [{ id: 1, focused: false, state: "maximized" }],
    initialTabs: [{ id: 14, windowId: 1, active: true, url: "moz-extension://a1b2c3d4-e5f6-4789-8abc-1234567890ab/index.html" }],
    initialStorage: { [RECENCY_KEY]: recency([{ tabId: 14, windowId: 1, ordinal: 1 }], 2) },
  });

  const reply = await env.send(openRequest(), managerSender(env));
  assert.equal(reply.ok, true);
  assert.equal(env.windowsState.find((window) => window.id === 1).state, "maximized");
  assert.equal(env.windowsState.find((window) => window.id === 1).focused, true);
  assert.equal(env.windowCalls.some((call) => call.method === "update" && Object.hasOwn(call.properties, "state")), false);
});

test("failure to focus a still-valid manager window does not create a duplicate tab", async () => {
  const env = await bootManager({
    initialTabs: [{ id: 14, windowId: 1, active: true, url: "moz-extension://a1b2c3d4-e5f6-4789-8abc-1234567890ab/index.html" }],
    initialStorage: { [RECENCY_KEY]: recency([{ tabId: 14, windowId: 1, ordinal: 1 }], 2) },
  });
  env.namespace.windows.update = () => Promise.reject(new Error("focus unavailable"));

  const reply = await env.send(openRequest(), managerSender(env));
  assert.equal(reply.ok, false);
  assert.equal(reply.error.kind, "gateway-unavailable");
  assert.equal(env.tabCalls.filter((call) => call.method === "create").length, 0);
  assert.ok(env.tabsState.some((tab) => tab.id === 14));
});

test("a manager tab still loading at its exact extension URL is reused rather than duplicated", async () => {
  const env = await bootManager();
  const ownUrl = env.namespace.runtime.getURL("index.html");
  let creates = 0;
  env.namespace.tabs.create = (properties) => {
    creates += 1;
    const tab = { id: 71, windowId: 1, active: true, url: "about:blank", pendingUrl: properties.url };
    env.tabsState.push(tab);
    env.tabCalls.push({ method: "create", properties: plain(properties), result: plain(tab) });
    return Promise.resolve(plain(tab));
  };

  const first = await env.send(openRequest(), managerSender(env));
  const second = await env.send(openRequest({ requestId: "00000000-0000-4000-8000-000000000093" }), managerSender(env));
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(creates, 1);
  assert.equal(second.data.reused, true);
  assert.equal(env.tabsState.filter((tab) => tab.pendingUrl === ownUrl).length, 1);
});

test("startup reconciliation preserves known ordinals without assigning recency to newly discovered tabs", async () => {
  const extensionOrigin = "moz-extension://a1b2c3d4-e5f6-4789-8abc-1234567890ab";
  const original = {
    schemaVersion: 1,
    nextOrdinal: 18,
    candidates: [
      { tabId: 11, windowId: 3, ordinal: 17 },
      { tabId: 15, windowId: 3, ordinal: 8 },
      { tabId: 99, windowId: 9, ordinal: 3 },
    ],
  };
  const first = await bootManager({
    extensionOrigin,
    initialStorage: { [RECENCY_KEY]: original },
    initialWindows: [
      { id: 3, focused: true, state: "normal" },
      { id: 4, focused: false, state: "normal" },
    ],
    initialTabs: [
      { id: 11, windowId: 3, active: true, url: `${extensionOrigin}/index.html` },
      { id: 12, windowId: 4, active: false, url: `${extensionOrigin}/index.html` },
      { id: 15, windowId: 3, active: false, url: `${extensionOrigin}/index.html` },
    ],
  });
  const reconciled = first.localData[RECENCY_KEY];
  assert.equal(reconciled.nextOrdinal, 18);
  assert.deepEqual(reconciled.candidates, [
    { tabId: 11, windowId: 3, ordinal: 17 },
    { tabId: 12, windowId: 4, ordinal: null },
    { tabId: 15, windowId: 3, ordinal: 8 },
  ]);

  const restarted = await bootManager({
    extensionOrigin,
    initialStorage: structuredClone(first.localData),
    initialWindows: first.windowsState,
    initialTabs: first.tabsState,
  });
  assert.deepEqual(restarted.localData[RECENCY_KEY], reconciled);
  assert.equal(restarted.tabCalls.filter((call) => call.method === "create").length, 0);
  const reply = await restarted.send(openRequest(), managerSender(restarted));
  assert.equal(reply.ok, true);
  assert.ok(restarted.tabCalls.some((call) => call.method === "update" && call.tabId === 11));
  assert.equal(restarted.tabCalls.some((call) => call.method === "update" && call.tabId === 15), false);
});

test("actual tab activation advances the persisted ordinal used for the next open", async () => {
  const env = await bootManager({
    initialWindows: [
      { id: 1, focused: false, state: "normal" },
      { id: 2, focused: true, state: "normal" },
    ],
    initialTabs: [
      { id: 4, windowId: 1, active: true, url: "moz-extension://a1b2c3d4-e5f6-4789-8abc-1234567890ab/index.html" },
      { id: 8, windowId: 2, active: false, url: "moz-extension://a1b2c3d4-e5f6-4789-8abc-1234567890ab/index.html" },
    ],
  });
  env.events.tabActivated.fire({ tabId: 8, windowId: 2 });
  await idle();

  const state = env.localData[RECENCY_KEY];
  const usedTab = state.candidates.find((item) => item.tabId === 8);
  assert.ok(usedTab && Number.isSafeInteger(usedTab.ordinal) && usedTab.ordinal > 0);
  assert.equal(state.nextOrdinal, usedTab.ordinal + 1);
  const reply = await env.send(openRequest(), managerSender(env));
  assert.equal(reply.ok, true);
  assert.ok(env.tabCalls.some((call) => call.method === "update" && call.tabId === 8));
});

test("asynchronous tab activation checks cannot reverse the order in which the user activated tabs", async () => {
  const env = await bootManager({
    initialTabs: [
      { id: 4, windowId: 1, active: true, url: "moz-extension://a1b2c3d4-e5f6-4789-8abc-1234567890ab/index.html" },
      { id: 8, windowId: 1, active: false, url: "moz-extension://a1b2c3d4-e5f6-4789-8abc-1234567890ab/index.html" },
    ],
  });
  const delayed = deferred();
  const originalGet = env.namespace.tabs.get;
  let delayFirst = true;
  env.namespace.tabs.get = (tabId) => {
    if (tabId === 4 && delayFirst) {
      delayFirst = false;
      return delayed.promise;
    }
    return originalGet(tabId);
  };

  env.events.tabActivated.fire({ tabId: 4, windowId: 1 });
  await idle();
  env.events.tabActivated.fire({ tabId: 8, windowId: 1 });
  await idle();
  delayed.resolve(env.tabsState.find((tab) => tab.id === 4));
  await idle();

  const state = env.localData[RECENCY_KEY];
  assert.ok(state.candidates.find((item) => item.tabId === 8).ordinal > state.candidates.find((item) => item.tabId === 4).ordinal);
});

test("window focus events keep arrival order when the earlier active-tab query is slow", async () => {
  const env = await bootManager({
    initialWindows: [
      { id: 1, focused: true, state: "normal" },
      { id: 2, focused: false, state: "normal" },
    ],
    initialTabs: [
      { id: 11, windowId: 1, active: true, url: "moz-extension://a1b2c3d4-e5f6-4789-8abc-1234567890ab/index.html" },
      { id: 22, windowId: 2, active: true, url: "moz-extension://a1b2c3d4-e5f6-4789-8abc-1234567890ab/index.html" },
    ],
  });
  const delayed = deferred();
  const originalQuery = env.namespace.tabs.query;
  let delayFirst = true;
  env.namespace.tabs.query = (queryInfo) => {
    if (queryInfo.windowId === 1 && delayFirst) {
      delayFirst = false;
      return delayed.promise;
    }
    return originalQuery(queryInfo);
  };

  env.events.windowFocusChanged.fire(1);
  await idle();
  env.events.windowFocusChanged.fire(2);
  await idle();
  delayed.resolve([env.tabsState.find((tab) => tab.id === 11)]);
  await idle();

  const state = env.localData[RECENCY_KEY];
  assert.ok(state.candidates.find((item) => item.tabId === 22).ordinal > state.candidates.find((item) => item.tabId === 11).ordinal);
});

test("without saved recency the focused window wins, with tab ID as a stable tie-break", async () => {
  const env = await bootManager({
    initialWindows: [
      { id: 1, focused: false, state: "normal" },
      { id: 2, focused: true, state: "normal" },
    ],
    initialTabs: [
      { id: 3, windowId: 2, active: false, url: "moz-extension://a1b2c3d4-e5f6-4789-8abc-1234567890ab/index.html" },
      { id: 8, windowId: 1, active: true, url: "moz-extension://a1b2c3d4-e5f6-4789-8abc-1234567890ab/index.html" },
      { id: 12, windowId: 2, active: true, url: "moz-extension://a1b2c3d4-e5f6-4789-8abc-1234567890ab/index.html" },
    ],
  });
  const reply = await env.send(openRequest(), managerSender(env));

  assert.equal(reply.ok, true);
  assert.equal(reply.data.reused, true);
  assert.ok(env.tabCalls.some((call) => call.method === "update" && call.tabId === 12));
  assert.equal(env.tabCalls.some((call) => call.method === "update" && call.tabId === 8), false);

  const fallback = await bootManager({
    initialWindows: [{ id: 1, focused: false, state: "normal" }],
    initialTabs: [
      { id: 3, windowId: 1, active: false, url: "moz-extension://a1b2c3d4-e5f6-4789-8abc-1234567890ab/index.html" },
      { id: 8, windowId: 1, active: false, url: "moz-extension://a1b2c3d4-e5f6-4789-8abc-1234567890ab/index.html" },
    ],
  });
  fallback.namespace.windows.getLastFocused = (_getInfo, callback) => {
    if (callback) callback(null);
    return undefined;
  };
  const fallbackReply = await fallback.send(openRequest(), managerSender(fallback));
  assert.equal(fallbackReply.ok, true);
  assert.ok(fallback.tabCalls.some((call) => call.method === "update" && call.tabId === 3));
  assert.equal(fallback.tabCalls.some((call) => call.method === "update" && call.tabId === 8), false);
});

test("external pages, URL lookalikes, and manager URLs with query or fragment are never candidates", async () => {
  const env = await bootManager();
  const own = env.namespace.runtime.getURL("index.html");
  env.tabsState.push(
    { id: 1, windowId: 1, active: true, url: "https://example.test/index.html" },
    { id: 2, windowId: 1, active: false, url: `${own}?view=tasks` },
    { id: 3, windowId: 1, active: false, url: `${own}#section` },
    { id: 4, windowId: 1, active: false, url: own.replace("/index.html", "/index.html.evil") },
  );
  const reply = await env.send(openRequest(), managerSender(env));

  assert.equal(reply.ok, true);
  assert.deepEqual(plain(reply.data), { opened: true, reused: false });
  assert.equal(env.tabCalls.filter((call) => call.method === "create").length, 1);
  const createdId = env.tabCalls.find((call) => call.method === "create").result.id;
  assert.equal(env.tabCalls.some((call) => call.method === "update" && call.tabId !== createdId), false);
  assert.equal(env.tabsState.find((tab) => tab.id === createdId).url, own);
});

test("a candidate that closes or navigates after discovery is revalidated before activation", async (t) => {
  for (const scenario of ["close", "navigate"]) {
    await t.test(scenario, async () => {
      const env = await bootManager({
        initialTabs: [{ id: 7, windowId: 1, active: true, url: "moz-extension://a1b2c3d4-e5f6-4789-8abc-1234567890ab/index.html" }],
      });
      const query = env.namespace.tabs.query;
      env.namespace.tabs.query = async (...args) => {
        const discovered = await query(...args);
        if (scenario === "close") env.removeTab(7);
        else env.navigateTab(7, "https://outside.example.test/");
        return discovered;
      };

      const reply = await env.send(openRequest(), managerSender(env));
      assert.equal(reply.ok, true);
      assert.deepEqual(plain(reply.data), { opened: true, reused: false });
      assert.equal(env.tabCalls.some((call) => call.method === "update" && call.tabId === 7), false);
      assert.equal(env.tabCalls.filter((call) => call.method === "create").length, 1);
    });
  }
});

test("manager.open validates the sender and exact empty request before touching browser tabs", async (t) => {
  const scenarios = [
    { name: "foreign extension", sender: (env) => managerSender(env, "popup.html", "other-extension") },
    { name: "web page", sender: () => ({ id: "web-page", url: "https://example.test/" }) },
    { name: "query-appended extension page", sender: (env) => ({ id: env.extensionId, url: `${env.namespace.runtime.getURL("popup.html")}?manager.open` }) },
  ];
  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const env = await bootManager();
      const tabCallCount = env.tabCalls.length;
      const windowCallCount = env.windowCalls.length;
      const reply = await env.send(openRequest(), scenario.sender(env));
      assert.equal(reply.ok, false);
      assert.equal(reply.error.kind, "unauthorized-sender");
      assert.equal(env.tabCalls.length, tabCallCount);
      assert.equal(env.windowCalls.length, windowCallCount);
      assert.equal(env.requests.length, 0);
    });
  }

  const env = await bootManager();
  const tabCallCount = env.tabCalls.length;
  for (const malformedRequest of [
    openRequest({ target: { kind: "task", id: "task-1" } }),
    openRequest({ parameters: { url: "https://external.example.test/" } }),
  ]) {
    const malformed = await env.send(malformedRequest, managerSender(env));
    assert.equal(malformed.ok, false);
    assert.equal(malformed.error.kind, "invalid-request");
    assert.equal(env.tabCalls.length, tabCallCount);
  }
  assert.equal(env.localData["settings.v1"], undefined);
  assert.equal(env.requests.length, 0);
});

test("open RPC works with both Promise and callback browser API namespaces", async (t) => {
  for (const mode of ["browser", "chrome"]) {
    await t.test(mode, async () => {
      const env = await bootManager({ mode });
      const reply = await env.send(openRequest(), managerSender(env));
      assert.equal(reply.ok, true);
      assert.deepEqual(plain(reply.data), { opened: true, reused: false });
      assert.equal(env.tabCalls.filter((call) => call.method === "create").length, 1);
    });
  }
});
