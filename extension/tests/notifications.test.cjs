const assert = require("node:assert/strict");
const test = require("node:test");
const { bootBackground, response } = require("./helpers.cjs");
const {
  API_ROOT,
  HISTORY_A,
  HISTORY_B,
  OBSERVED_AT,
  notificationEntry,
  notificationsSnapshot,
  receptionState,
  sequenceRange,
} = require("./notification-fixtures.cjs");

const SETTINGS_KEY = "settings.v1";
const RECEPTION_KEY = "notificationReception.v1";
const ERROR_KEY = "gatewayError.v1";
const MONITOR_ALARM = "eptask-urgent-indicator";
const HOST_PERMISSION = "https://tasks.example.test/*";
const REQUEST_A = "00000000-0000-4000-8000-000000000141";
const REQUEST_B = "00000000-0000-4000-8000-000000000142";
const CLEAR_REQUEST = "00000000-0000-4000-8000-000000000143";
const SETTINGS = {
  schemaVersion: 1,
  serverUrl: API_ROOT,
  token: "test-bearer-token",
  monitorEnabled: true,
  timeoutMs: 30_000,
};

function hal(value, status = 200) {
  return response(value, status, status >= 400 ? "application/problem+json" : "application/hal+json");
}

function rpc(operation, requestId = REQUEST_A) {
  return { protocolVersion: 1, requestId, operation, target: null, parameters: {} };
}

function sender(env, page = "index.html") {
  return { id: env.extensionId, url: env.namespace.runtime.getURL(page) };
}

function boot(fetch, { settings = SETTINGS, reception, permissions = [HOST_PERMISSION], extraStorage = {} } = {}) {
  return bootBackground({
    initialStorage: {
      [SETTINGS_KEY]: settings,
      ...(reception ? { [RECEPTION_KEY]: reception } : {}),
      ...extraStorage,
    },
    initialPermissions: permissions,
    fetch,
  });
}

function waitFor(predicate, description, timeoutMs = 1_500) {
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

async function flush() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

function fireCycle(env) {
  env.fireAlarm(MONITOR_ALARM);
}

async function startCycle(env) {
  await waitFor(() => env.alarmCreates.some((alarm) => alarm.name === MONITOR_ALARM), "the periodic monitor alarm");
  fireCycle(env);
}

function notificationRequests(env) {
  return env.requests.filter((request) => new URL(request.url).pathname.endsWith("/notifications"));
}

test("monitor schedules one five-minute cycle and persists distinct identities before native notices", async () => {
  const sameText = "El mismo aviso test-bearer-token";
  const snapshot = notificationsSnapshot([
    notificationEntry(HISTORY_A, 2, sameText),
    notificationEntry(HISTORY_A, 1, sameText),
  ]);
  const env = boot(async (url) => {
    assert.equal(url, `${API_ROOT}/notifications`);
    return hal(snapshot);
  });

  await waitFor(() => env.alarmCreates.some((alarm) => alarm.name === MONITOR_ALARM), "the notification monitor alarm");
  const monitorAlarm = env.alarmCreates.find((alarm) => alarm.name === MONITOR_ALARM);
  assert.equal(monitorAlarm.info.periodInMinutes, 5);

  await startCycle(env);
  await waitFor(() => env.notificationCalls.length > 0, "native notifications after the saved buffer");

  const received = env.localData[RECEPTION_KEY];
  assert.equal(received.historyId, HISTORY_A);
  assert.equal(received.lastReceivedSequence, 2);
  assert.deepEqual(received.buffer.map(({ id, sequence, text }) => ({ id, sequence, text })), [
    { id: `${HISTORY_A}:1`, sequence: 1, text: "El mismo aviso [redactado]" },
    { id: `${HISTORY_A}:2`, sequence: 2, text: "El mismo aviso [redactado]" },
  ]);
  assert.equal(new Set(received.buffer.map((entry) => entry.id)).size, 2, "equal text does not collapse distinct server identities");

  const savedAt = env.timeline.findIndex((event) => event.type === "storage.set" && event.items?.[RECEPTION_KEY]?.lastReceivedSequence === 2);
  const notifiedAt = env.timeline.findIndex((event) => event.type === "notification.create");
  assert.ok(savedAt >= 0 && savedAt < notifiedAt, "the buffer and cursor are committed before native notification emission");
  assert.equal(env.notificationCalls.length, 1, "new server notices in one cycle are grouped into one native alert");
  assert.doesNotMatch(JSON.stringify(received), /test-bearer-token/);
  assert.doesNotMatch(JSON.stringify(env.notificationCalls), /test-bearer-token/);
  const invalidation = env.runtimeMessages.find(message => message.event === "changes.invalidated");
  assert.ok(invalidation, "new notifications request a refresh of connected views");
  assert.equal(invalidation.changes.refreshAll, true);
  assert.ok(invalidation.changes.collections.includes("events"));
  assert.equal(notificationRequests(env).length, 1);
  assert.equal(env.requests.some((request) => new URL(request.url).pathname.endsWith("/agenda")), false, "new notices skip the urgency branch in the same cycle");
});

test("overlapping alarm deliveries are dropped and a later cycle runs after the active one completes", async () => {
  let releaseFirstSnapshot;
  let historyReads = 0;
  const pending = new Promise((resolve) => { releaseFirstSnapshot = resolve; });
  const snapshot = notificationsSnapshot([notificationEntry(HISTORY_A, 1, "One notice")]);
  const env = boot(async (url) => {
    const path = new URL(url).pathname;
    if (path.endsWith("/notifications")) {
      historyReads += 1;
      return historyReads === 1 ? pending : hal(snapshot);
    }
    if (path.replace(/\/$/, "") === "/prefix/api/v1") return hal({ timeZone: "UTC", _links: { self: { href: API_ROOT }, agenda: { href: `${API_ROOT}/agenda` } } });
    if (path.endsWith("/agenda")) return hal({ _links: { self: { href: `${API_ROOT}/agenda` } }, _embedded: { activeUrgentTasks: [] } });
    throw new Error(`Unexpected monitor request ${url}`);
  });

  await waitFor(() => env.alarmCreates.some((alarm) => alarm.name === MONITOR_ALARM), "periodic alarm setup");
  fireCycle(env);
  fireCycle(env);
  await waitFor(() => notificationRequests(env).length === 1, "the single in-flight notifications GET");
  await flush();
  assert.equal(notificationRequests(env).length, 1, "a concurrent alarm is dropped, not queued for catch-up");

  releaseFirstSnapshot(hal(snapshot));
  await waitFor(() => env.localData[RECEPTION_KEY]?.lastReceivedSequence === 1, "the first cycle to finish");
  await waitFor(() => env.notificationCalls.length === 1, "the first cycle's grouped native notice");

  fireCycle(env);
  await waitFor(() => historyReads === 2, "a later, independent monitor cycle");
  await waitFor(() => env.requests.some((request) => new URL(request.url).pathname.endsWith("/agenda")), "the no-new-notices agenda branch");
  assert.equal(env.notificationCalls.length, 1, "a saved identity is not notified again");
});

test("worker restarts do not replay received IDs, while separate profiles track the same server independently", async () => {
  const snapshot = notificationsSnapshot([notificationEntry(HISTORY_A, 1, "Repeated notice")]);
  const fetchSnapshot = async (url) => {
    const path = new URL(url).pathname;
    if (path.endsWith("/notifications")) return hal(snapshot);
    if (path.replace(/\/$/, "") === "/prefix/api/v1") return hal({ version: "1", timeZone: "UTC", _links: { self: { href: API_ROOT }, agenda: { href: `${API_ROOT}/agenda` } } });
    if (path.endsWith("/agenda")) return hal({ _links: { self: { href: `${API_ROOT}/agenda` } }, _embedded: { activeUrgentTasks: [] } });
    throw new Error(`Unexpected monitor request ${url}`);
  };

  const profileA = boot(fetchSnapshot);
  await startCycle(profileA);
  await waitFor(() => profileA.notificationCalls.length === 1, "first profile notification");
  const persistedProfileA = structuredClone(profileA.localData);

  const restartedA = boot(fetchSnapshot, { extraStorage: persistedProfileA });
  await startCycle(restartedA);
  await waitFor(() => restartedA.requests.some((request) => new URL(request.url).pathname.endsWith("/agenda")), "valid no-new-notices agenda follow-up");
  await flush();
  assert.equal(restartedA.notificationCalls.length, 0, "the persisted cursor prevents replay after a worker restart");
  assert.deepEqual(restartedA.localData[RECEPTION_KEY].buffer.map((entry) => entry.id), [`${HISTORY_A}:1`]);

  const profileB = boot(fetchSnapshot);
  await startCycle(profileB);
  await waitFor(() => profileB.notificationCalls.length === 1, "second profile notification");
  assert.equal(profileB.localData[RECEPTION_KEY].lastReceivedSequence, 1);
  assert.equal(profileA.localData[RECEPTION_KEY].lastReceivedSequence, 1);
  assert.notStrictEqual(profileA.localData[RECEPTION_KEY], profileB.localData[RECEPTION_KEY]);
  assert.notStrictEqual(profileA.localData[RECEPTION_KEY].buffer, profileB.localData[RECEPTION_KEY].buffer);
});

test("1025 receipts retain the newest 1024 once and mark only local truncation", async () => {
  const firstSnapshot = notificationsSnapshot(sequenceRange(HISTORY_A, 1, 1024));
  const secondSnapshot = notificationsSnapshot(sequenceRange(HISTORY_A, 2, 1025), { discardedThrough: 1, nextSequence: 1026 });
  const snapshots = [firstSnapshot, secondSnapshot];
  const env = boot(async (url) => {
    assert.equal(url, `${API_ROOT}/notifications`);
    return hal(snapshots.shift());
  });

  await startCycle(env);
  await waitFor(() => env.localData[RECEPTION_KEY]?.lastReceivedSequence === 1024, "1024 saved receipts", 5_000);
  await waitFor(() => env.notificationCalls.length === 1, "the grouped native notice for the first batch", 10_000);
  assert.equal(env.localData[RECEPTION_KEY].buffer.length, 1024);

  await startCycle(env);
  await waitFor(() => env.localData[RECEPTION_KEY]?.lastReceivedSequence === 1025, "the 1025th saved receipt", 5_000);

  const reception = env.localData[RECEPTION_KEY];
  assert.equal(reception.buffer.length, 1024);
  assert.equal(reception.buffer[0].sequence, 2);
  assert.equal(reception.buffer.at(-1).sequence, 1025);
  assert.equal(reception.buffer.some((entry) => entry.sequence === 1), false);
  assert.equal(reception.continuity.localTruncated, true);
  assert.deepEqual(reception.continuity.missedRanges, []);
  assert.equal(env.notificationCalls.length, 2, "each batch produces one grouped native notification while retaining every identity");
});

test("server truncation produces an exact gap without inventing missing entries", async () => {
  const oldEntries = sequenceRange(HISTORY_A, 1, 3).map((entry) => ({ ...entry, endpointKey: API_ROOT }));
  const reception = receptionState({ historyId: HISTORY_A, lastReceivedSequence: 3, buffer: oldEntries });
  const snapshot = notificationsSnapshot(sequenceRange(HISTORY_A, 6, 7), { discardedThrough: 5, nextSequence: 8 });
  const env = boot(async () => hal(snapshot), { reception });

  await startCycle(env);
  await waitFor(() => env.localData[RECEPTION_KEY]?.lastReceivedSequence === 7, "gap state to be saved");

  const saved = env.localData[RECEPTION_KEY];
  assert.deepEqual(saved.continuity.missedRanges, [{ fromSequence: 4, throughSequence: 5 }]);
  assert.equal(saved.continuity.discardedThrough, 5);
  assert.deepEqual(saved.buffer.map((entry) => entry.sequence), [1, 2, 3, 6, 7]);
  assert.equal(saved.buffer.some((entry) => entry.sequence === 4 || entry.sequence === 5), false);
  assert.equal(saved.continuity.gapsTruncated, false);
});

test("clearing during a history request invalidates its generation but preserves the cursor", async () => {
  let releaseSnapshot;
  const pending = new Promise((resolve) => { releaseSnapshot = resolve; });
  const existing = notificationEntry(HISTORY_A, 1, "Already seen");
  const reception = receptionState({
    historyId: HISTORY_A,
    lastReceivedSequence: 5,
    buffer: [existing],
    bufferGeneration: 7,
    continuity: {
      discardedThrough: 5,
      missedRanges: [{ fromSequence: 4, throughSequence: 5 }],
      gapsTruncated: false,
      localTruncated: true,
    },
  });
  const env = boot(async (url) => {
    assert.equal(url, `${API_ROOT}/notifications`);
    return pending;
  }, { reception });

  await startCycle(env);
  await waitFor(() => notificationRequests(env).length === 1, "the in-flight history GET");
  const clearReply = await env.send(rpc("notifications.clear-local", CLEAR_REQUEST), sender(env));
  assert.equal(clearReply.ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(clearReply.data)), { cleared: true, bufferGeneration: 8 });
  assert.deepEqual(env.localData[RECEPTION_KEY].buffer, []);
  assert.equal(env.localData[RECEPTION_KEY].endpointKey, API_ROOT);
  assert.equal(env.localData[RECEPTION_KEY].historyId, HISTORY_A);
  assert.equal(env.localData[RECEPTION_KEY].lastReceivedSequence, 5);
  assert.equal(env.localData[RECEPTION_KEY].bufferGeneration, 8);
  assert.deepEqual(env.localData[RECEPTION_KEY].continuity, {
    discardedThrough: 5,
    missedRanges: [{ fromSequence: 4, throughSequence: 5 }],
    gapsTruncated: false,
    localTruncated: false,
  });
  assert.equal(env.notificationCalls.length, 0);

  releaseSnapshot(hal(notificationsSnapshot([
    notificationEntry(HISTORY_A, 6, "Arrived during clear"),
  ], { discardedThrough: 5, nextSequence: 7 })));
  await flush();

  assert.deepEqual(env.localData[RECEPTION_KEY].buffer, [], "the stale response cannot repopulate a cleared buffer");
  assert.equal(env.localData[RECEPTION_KEY].lastReceivedSequence, 5, "the clear preserves read progress");
  assert.equal(env.localData[RECEPTION_KEY].bufferGeneration, 8);
  assert.equal(env.notificationCalls.length, 0);
  assert.equal(env.timeline.some((event) => event.type === "notification.clear"), false, "local clear does not remove native or server notifications");
});

test("clear refuses to replace malformed local reception state", async () => {
  const malformed = {
    schemaVersion: 1,
    endpointKey: API_ROOT,
    historyId: HISTORY_A,
    lastReceivedSequence: 4,
    buffer: [{ endpointKey: API_ROOT, id: "incorrect", historyId: HISTORY_A, sequence: 4, timestamp: OBSERVED_AT, text: "keep this bytestring" }],
    bufferGeneration: 6,
    continuity: { discardedThrough: 3, missedRanges: [], gapsTruncated: false, localTruncated: false },
  };
  const env = boot(async () => { throw new Error("clear should not use the server"); }, { extraStorage: { [RECEPTION_KEY]: malformed } });
  const before = JSON.stringify(env.localData[RECEPTION_KEY]);

  const reply = await env.send(rpc("notifications.clear-local", CLEAR_REQUEST), sender(env));
  assert.equal(reply.ok, false);
  assert.equal(env.localData[RECEPTION_KEY] && JSON.stringify(env.localData[RECEPTION_KEY]), before, "invalid data stays intact for recovery");
  assert.equal(env.timeline.some((event) => event.type === "storage.set" && event.items?.[RECEPTION_KEY]), false);
  assert.equal(notificationRequests(env).length, 0, "local clear does not dispatch network requests");
});

test("only a valid no-new snapshot enables an explicit agenda check, and context matching is exact", async (t) => {
  for (const { context, expected } of [
    { context: "alert", expected: 1 },
    { context: "Alert", expected: 0 },
    { context: "work", expected: 0 },
  ]) {
    await t.test(`context ${context}`, async () => {
      const prior = notificationEntry(HISTORY_A, 1, "Already received");
      const reception = receptionState({ historyId: HISTORY_A, lastReceivedSequence: 1, buffer: [prior] });
      const snapshot = notificationsSnapshot([notificationEntry(HISTORY_A, 1, "Already received")], { nextSequence: 2 });
      const timeZone = "Europe/Madrid";
      const root = { version: "1", timeZone, _links: { self: { href: API_ROOT }, notifications: { href: `${API_ROOT}/notifications` }, agenda: { href: `${API_ROOT}/agenda` } } };
      const agenda = {
        _links: { self: { href: `${API_ROOT}/agenda` } },
        _embedded: { activeUrgentTasks: [{ id: "urgent-a", description: `Urgent task ${SETTINGS.token}`, context }] },
      };
      const env = boot(async (url) => {
        const path = new URL(url).pathname;
        if (path.endsWith("/notifications")) return hal(snapshot);
        if (path.replace(/\/$/, "") === "/prefix/api/v1") return hal(root);
        if (path.endsWith("/agenda")) return hal(agenda);
        throw new Error(`Unexpected monitor request ${url}`);
      }, { reception });

      await startCycle(env);
      await waitFor(() => env.requests.some((request) => new URL(request.url).pathname.endsWith("/agenda")), "agenda read after valid no-new snapshot");
      await flush();

      assert.deepEqual(env.requests.map((request) => new URL(request.url).pathname), [
        "/prefix/api/v1/notifications",
        "/prefix/api/v1",
        "/prefix/api/v1/agenda",
      ]);
      const agendaUrl = new URL(env.requests[2].url);
      assert.match(agendaUrl.searchParams.get("day"), /^\d{4}-\d{2}-\d{2}$/);
      assert.equal(agendaUrl.searchParams.get("heuristic"), "Remaining Effort(1)");
      assert.equal(env.notificationCalls.length, expected);
      if (expected) assert.doesNotMatch(env.notificationCalls[0].options.message, new RegExp(SETTINGS.token), "native alert text is redacted before it leaves the extension");
    });
  }
});

test("invalid or failed history snapshots never fall back to agenda alerts", async (t) => {
  const validOne = notificationsSnapshot([notificationEntry(HISTORY_A, 1, "Notice")]);
  const gap = notificationsSnapshot([
    notificationEntry(HISTORY_A, 1, "Notice one"),
    notificationEntry(HISTORY_A, 3, "Notice three"),
  ], { nextSequence: 4 });
  const mismatchedId = notificationsSnapshot([notificationEntry(HISTORY_A, 1, "Notice")]);
  mismatchedId._embedded.notifications[0].id = `${HISTORY_B}:1`;
  const oversized = notificationsSnapshot(sequenceRange(HISTORY_A, 1, 1025), { nextSequence: 1026 });

  for (const scenario of [
    { name: "HTTP 503", fetch: async () => hal({ code: "service-unavailable", title: "Unavailable" }, 503) },
    { name: "truncated payload", fetch: async () => response("{", 200, "application/hal+json") },
    { name: "sequence gap", fetch: async () => hal(gap) },
    { name: "identity mismatch", fetch: async () => hal(mismatchedId) },
    { name: "snapshot above server bound", fetch: async () => hal(oversized) },
    { name: "malformed retention count", fetch: async () => hal({ ...validOne, total: 2 }) },
  ]) {
    await t.test(scenario.name, async () => {
      const env = boot(scenario.fetch);
      await startCycle(env);
      await waitFor(() => Boolean(env.localData[ERROR_KEY]), "stored safe gateway error");
      await flush();

      assert.equal(notificationRequests(env).length, 1);
      assert.equal(env.requests.some((request) => new URL(request.url).pathname.endsWith("/agenda")), false);
      assert.equal(env.notificationCalls.length, 0);
      assert.doesNotMatch(JSON.stringify(env.localData[ERROR_KEY]), /test-bearer-token|tasks\.example\.test|https:\/\//);
      assert.doesNotMatch(JSON.stringify(env.localData[RECEPTION_KEY] ?? null), /test-bearer-token/);
    });
  }
});

test("a new endpoint or history identity preserves old entries without claiming its gaps", async (t) => {
  const newBase = "https://new.example.test/team/api/v1";
  const newHostPermission = "https://new.example.test/*";
  for (const scenario of [
    { name: "server endpoint", settings: { ...SETTINGS, serverUrl: newBase }, endpointKey: newBase, historyId: HISTORY_A },
    { name: "server history", settings: SETTINGS, endpointKey: API_ROOT, historyId: HISTORY_B },
  ]) {
    await t.test(scenario.name, async () => {
      const previous = notificationEntry(HISTORY_A, 1, "Old server entry");
      const reception = receptionState({ historyId: HISTORY_A, lastReceivedSequence: 1, buffer: [previous] });
      const snapshot = notificationsSnapshot(sequenceRange(scenario.historyId, 5, 5), { historyId: scenario.historyId, discardedThrough: 4, nextSequence: 6 });
      const currentBase = scenario.settings.serverUrl;
      snapshot._links = { self: { href: `${currentBase}/notifications` }, root: { href: currentBase } };
      const env = boot(async (url) => {
        assert.equal(url, `${currentBase}/notifications`);
        return hal(snapshot);
      }, { settings: scenario.settings, reception, permissions: [HOST_PERMISSION, newHostPermission] });

      await startCycle(env);
      await waitFor(() => env.localData[RECEPTION_KEY]?.historyId === scenario.historyId && env.localData[RECEPTION_KEY]?.lastReceivedSequence === 5, "new history identity to be saved");

      const saved = env.localData[RECEPTION_KEY];
      assert.equal(saved.buffer.length, 2);
      assert.equal(saved.buffer[0].id, `${HISTORY_A}:1`);
      assert.equal(saved.buffer[0].endpointKey, API_ROOT);
      assert.equal(saved.buffer[1].id, `${scenario.historyId}:5`);
      assert.equal(saved.buffer[1].endpointKey, scenario.endpointKey);
      assert.deepEqual(saved.continuity.missedRanges, [], "a new identity does not attribute earlier discarded items to this profile");
      assert.equal(saved.continuity.discardedThrough, 4);
    });
  }
});
