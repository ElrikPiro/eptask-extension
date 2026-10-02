const assert = require("node:assert/strict");
const test = require("node:test");
const { bootBackground, response } = require("./helpers.cjs");

const SETTINGS_KEY = "settings.v1";
const URGENCY_STATE_KEY = "urgentIndicator.v1";
const URGENCY_ALARM = "eptask-urgent-indicator";
const settings = {
  schemaVersion: 1,
  serverUrl: "http://tasks.example.test/api",
  token: "test-token",
  monitorEnabled: true,
};

function json(value, status = 200) {
  return response(value, status, "application/json");
}

function task(id, description = `Task ${id}`, context = "work") {
  return { id, description, context };
}

function agenda(tasks) {
  return { active_urgent_tasks: tasks, planned_urgent_tasks: [], planned_tasks_by_date: {}, other_tasks: [] };
}

function taskList(rows, currentPage, totalPages, totalTasks, activeFilters = []) {
  return {
    tasks: rows,
    current_page: currentPage,
    total_pages: totalPages,
    total_tasks: totalTasks,
    active_filters: activeFilters,
  };
}

function popupSender(env) {
  return { id: env.extensionId, url: env.namespace.runtime.getURL("popup.html") };
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

function pagedBackend({urgentTask, pages, activeFilters = [], afterMutationAgenda = null}) {
  let currentPage = 1;
  let latestAgenda = [urgentTask];
  const mutations = [];
  const fetch = async (url) => {
    const parsed = new URL(url);
    const path = parsed.pathname;
    if (path.endsWith("/agenda")) return json(agenda(latestAgenda));
    if (path.endsWith("/list")) {
      currentPage = 1;
      return json(taskList(pages[0] || [], currentPage, pages.length, pages.flat().length, activeFilters));
    }
    if (path.endsWith("/next")) {
      currentPage += 1;
      return json(taskList(pages[currentPage - 1] || [], currentPage, pages.length, pages.flat().length, activeFilters));
    }
    const selection = path.match(/\/task_(\d+)$/);
    if (selection) {
      const selected = pages[currentPage - 1]?.[Number(selection[1]) - 1];
      return selected ? json({ task: { id: "unknown", description: selected.description, context: selected.context } }) : json({});
    }
    if (path.endsWith("/done") || path.endsWith("/snooze")) {
      mutations.push({ path, args: parsed.searchParams.get("args") });
      if (afterMutationAgenda) latestAgenda = afterMutationAgenda;
      return json({ changed: true });
    }
    return json({});
  };
  return { fetch, mutations };
}

for (const mode of ["browser", "chrome"]) {
  test(`${mode} GET_AGENDA turns the red dot badge on and off`, async () => {
    let current = [task("urgent", "Pay invoice", "home")];
    const env = bootBackground({
      mode,
      initialStorage: { [SETTINGS_KEY]: settings },
      fetch: async () => json(agenda(current)),
    });

    const on = await env.send({ type: "gateway.call", requestId: "badge-on", operation: "GET_AGENDA", args: {} });
    assert.equal(on.ok, true);
    assert.equal(env.badgeState.text, "●");
    assert.equal(env.badgeState.textColor, "#c62828");
    assert.deepEqual(env.badgeState.backgroundColor, [0, 0, 0, 0]);

    current = [];
    const off = await env.send({ type: "gateway.call", requestId: "badge-off", operation: "GET_AGENDA", args: {} });
    assert.equal(off.ok, true);
    assert.equal(env.badgeState.text, "");
    assert.equal(env.localData[URGENCY_STATE_KEY].active, false);
  });
}

test("older Chromium without badge text color falls back to a red pill with a white dot", async () => {
  const env = bootBackground({
    mode: "chrome",
    supportsBadgeTextColor: false,
    initialStorage: { [SETTINGS_KEY]: settings },
    fetch: async () => json(agenda([task("urgent")])),
  });
  const reply = await env.send({ type: "gateway.call", requestId: "badge-fallback", operation: "GET_AGENDA", args: {} });

  assert.equal(reply.ok, true);
  assert.equal(env.badgeState.text, "●");
  assert.equal(env.badgeState.backgroundColor, "#c62828");
  assert.equal(env.actionCalls.some(({ method }) => method === "setBadgeTextColor"), false);
});

test("a failed badge text color API falls back to the red badge", async () => {
  const env = bootBackground({
    failBadgeTextColor: true,
    initialStorage: { [SETTINGS_KEY]: settings },
    fetch: async () => json(agenda([task("urgent")])),
  });
  const reply = await env.send({ type: "gateway.call", requestId: "badge-api-failure", operation: "GET_AGENDA", args: {} });

  assert.equal(reply.ok, true);
  assert.equal(env.badgeState.text, "●");
  assert.equal(env.badgeState.backgroundColor, "#c62828");
  assert.equal(env.badgeState.textColor, null);
  assert.equal(env.actionCalls.filter(({ method }) => method === "setBadgeTextColor").length, 2);
});

test("the separate five-minute urgency alarm updates the badge while the popup is closed", async () => {
  const env = bootBackground({
    initialStorage: { [SETTINGS_KEY]: settings },
    fetch: async () => json(agenda([task("urgent", "Prepare release")])),
  });

  env.fireAlarm(URGENCY_ALARM);
  await waitFor(() => env.badgeState.text === "●", "urgent badge from the alarm");
  assert.equal(env.requests.length, 1);
  assert.match(env.requests[0].url, /\/agenda$/);
  assert.equal(env.notificationCalls.length, 0);
});

test("the last known badge is restored from storage without an HTTP request", async () => {
  const env = bootBackground({
    initialStorage: {
      [SETTINGS_KEY]: settings,
      [URGENCY_STATE_KEY]: { active: true, updatedAt: "2026-10-01T00:00:00.000Z" },
    },
  });

  await waitFor(() => env.badgeState.text === "●", "restored urgency badge");
  assert.equal(env.requests.length, 0);
});

test("connecting initializes the badge from the connection agenda", async () => {
  const env = bootBackground({ fetch: async () => json(agenda([task("urgent", "Prepare release")])) });
  const reply = await env.send({
    type: "settings.connect",
    requestId: "connect-urgent",
    settings: settings,
  });

  assert.equal(reply.ok, true);
  assert.equal(env.badgeState.text, "●");
  assert.equal(env.localData[SETTINGS_KEY].monitorEnabled, true);
  assert.equal(env.requests.length, 1);
  assert.match(env.requests[0].url, /\/agenda$/);
});

test("disconnect clears the badge and a stale agenda response cannot restore it", async () => {
  let releaseAgenda;
  const env = bootBackground({
    initialStorage: { [SETTINGS_KEY]: settings },
    fetch: async () => new Promise((resolve) => { releaseAgenda = () => resolve(json(agenda([task("urgent")]))); }),
  });
  const pending = env.send({ type: "gateway.call", requestId: "late-agenda", operation: "GET_AGENDA", args: {} });
  await waitFor(() => env.requests.length === 1, "pending agenda request");
  const disconnected = await env.send({ type: "settings.disconnect", requestId: "disconnect", args: {} });
  assert.equal(disconnected.ok, true);
  assert.equal(env.badgeState.text, "");
  releaseAgenda();
  const result = await pending;

  assert.equal(result.ok, true);
  assert.equal(env.badgeState.text, "");
  assert.equal(env.localData[URGENCY_STATE_KEY].active, false);
});

test("settings.clear clears the badge and leaves both periodic alarms inert", async () => {
  const env = bootBackground({
    initialStorage: { [SETTINGS_KEY]: settings },
    fetch: async () => json(agenda([task("urgent")])),
  });
  await env.send({ type: "gateway.call", requestId: "set-badge", operation: "GET_AGENDA", args: {} });
  assert.equal(env.badgeState.text, "●");

  const cleared = await env.send({ type: "settings.clear", requestId: "clear", args: {} });
  assert.equal(cleared.ok, true);
  assert.equal(env.badgeState.text, "");
  assert.equal(env.localData[SETTINGS_KEY].monitorEnabled, false);
  const requestCount = env.requests.length;
  env.fireAlarm(URGENCY_ALARM);
  env.fireAlarm("eptask-notification-monitor");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(env.requests.length, requestCount);
});

for (const [operation, expectedMutation] of [["POPUP_DONE", "/api/done"], ["POPUP_SNOOZE", "/api/snooze"]]) {
  test(`${operation} targets the exact urgent task across pages and mutates once`, async () => {
    const rows = Array.from({ length: 12 }, (_, index) => task(`uid-${index + 1}`, `Task ${index + 1}`, index === 6 ? "home" : "work"));
    const urgentTask = rows[6];
    const backend = pagedBackend({ urgentTask, pages: [rows.slice(0, 5), rows.slice(5, 10), rows.slice(10)] });
    const env = bootBackground({ initialStorage: { [SETTINGS_KEY]: settings }, fetch: backend.fetch });
    const reply = await env.send({
      type: "gateway.call",
      requestId: `urgent-${operation}`,
      operation,
      args: { expectedTask: urgentTask },
    }, popupSender(env));

    assert.equal(reply.ok, true);
    assert.equal(backend.mutations.length, 1);
    assert.equal(backend.mutations[0].path, expectedMutation);
    assert.equal(backend.mutations[0].args, operation === "POPUP_SNOOZE" ? "5m" : null);
    assert.deepEqual(env.requests.map(({ url }) => new URL(url).pathname), [
      "/api/agenda",
      "/api/list", "/api/next", "/api/next",
      "/api/list", "/api/next", "/api/task_2", expectedMutation, "/api/agenda",
    ]);
    assert.equal(env.requests.some(({ url }) => /\/task_1(?:\?|$)/.test(url)), false);
    assert.equal(env.requests.filter(({ url }) => new URL(url).pathname === expectedMutation).length, 1);
  });
}

test("urgent popup actions reject stale, missing, and ambiguous agenda identities before listing", async (t) => {
  const expected = task("stable-uid", "Pay invoice", "home");
  const cases = [
    { name: "changed description", tasks: [task(expected.id, "New description", expected.context)], kind: "task-changed" },
    { name: "missing urgent", tasks: [], kind: "task-missing" },
    { name: "duplicate agenda UID", tasks: [expected, expected], kind: "task-ambiguous" },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const env = bootBackground({
        initialStorage: { [SETTINGS_KEY]: settings },
        fetch: async () => json(agenda(scenario.tasks)),
      });
      const reply = await env.send({
        type: "gateway.call", requestId: scenario.name, operation: "POPUP_DONE", args: { expectedTask: expected },
      }, popupSender(env));
      assert.equal(reply.ok, false);
      assert.equal(reply.error.kind, scenario.kind);
      assert.equal(env.requests.length, 1);
      assert.equal(env.requests[0].url.endsWith("/agenda"), true);
      assert.equal(env.requests.some(({ url }) => new URL(url).pathname.endsWith("/done")), false);
    });
  }
});

test("popup actions fail closed when filters hide the urgent task or the list duplicates its UID", async (t) => {
  const urgentTask = task("stable-uid", "Pay invoice", "home");
  const other = task("other-uid", "Other", "work");
  const cases = [
    {
      name: "filtered list hides target",
      pages: [[other]],
      filters: [{ name: "active", description: "Only active tasks", index: 1 }],
      kind: "task-missing",
      message: /filtros actuales/,
    },
    {
      name: "duplicate UID in list is ambiguous",
      pages: [[urgentTask], [urgentTask]],
      filters: [],
      kind: "task-ambiguous",
      message: /varias veces/,
    },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const backend = pagedBackend({ urgentTask, pages: scenario.pages, activeFilters: scenario.filters });
      const env = bootBackground({ initialStorage: { [SETTINGS_KEY]: settings }, fetch: backend.fetch });
      const reply = await env.send({
        type: "gateway.call", requestId: scenario.name, operation: "POPUP_SNOOZE", args: { expectedTask: urgentTask },
      }, popupSender(env));
      assert.equal(reply.ok, false);
      assert.equal(reply.error.kind, scenario.kind);
      assert.match(reply.error.message, scenario.message);
      assert.equal(backend.mutations.length, 0);
      assert.equal(env.requests.some(({ url }) => /\/task_\d+(?:\?|$)/.test(url)), false);
    });
  }
});

test("popup operation sender and expected task shape are validated before network access", async (t) => {
  const expected = task("uid", "Task uid", "work");
  const cases = [
    { name: "options page sender", senderPage: "options.html", args: { expectedTask: expected } },
    { name: "unknown task UID", senderPage: "popup.html", args: { expectedTask: { ...expected, id: "unknown" } } },
    { name: "unexpected task field", senderPage: "popup.html", args: { expectedTask: { ...expected, page: 2 } } },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const env = bootBackground({ initialStorage: { [SETTINGS_KEY]: settings }, fetch: async () => json(agenda([expected])) });
      const sender = { id: env.extensionId, url: env.namespace.runtime.getURL(scenario.senderPage) };
      const reply = await env.send({
        type: "gateway.call", requestId: scenario.name, operation: "POPUP_DONE", args: scenario.args,
      }, sender);
      assert.equal(reply.ok, false);
      assert.equal(reply.error.kind, "invalid-request");
      assert.equal(env.requests.length, 0);
    });
  }
});

test("disconnect while backend selection is pending prevents the popup mutation", async () => {
  const urgentTask = task("stable-uid", "Pay invoice", "home");
  let releaseSelection;
  const env = bootBackground({
    initialStorage: { [SETTINGS_KEY]: settings },
    fetch: async (url) => {
      const path = new URL(url).pathname;
      if (path.endsWith("/agenda")) return json(agenda([urgentTask]));
      if (path.endsWith("/list")) return json(taskList([urgentTask], 1, 1, 1));
      if (path.endsWith("/task_1")) return new Promise((resolve) => {
        releaseSelection = () => resolve(json({ task: { id: "unknown", description: urgentTask.description, context: urgentTask.context } }));
      });
      return json({ changed: true });
    },
  });
  const action = env.send({
    type: "gateway.call", requestId: "popup-disconnect-race", operation: "POPUP_DONE", args: { expectedTask: urgentTask },
  }, popupSender(env));
  await waitFor(() => env.requests.some(({ url }) => new URL(url).pathname.endsWith("/task_1")), "task selection start");
  await env.send({ type: "settings.disconnect", requestId: "disconnect-selection", args: {} });
  releaseSelection();
  const reply = await action;

  assert.equal(reply.ok, false);
  assert.equal(reply.error.kind, "invalid-config");
  assert.equal(env.requests.some(({ url }) => new URL(url).pathname.endsWith("/done")), false);
  assert.equal(env.badgeState.text, "");
});

test("a popup action rejects a detail whose description or context changed without mutating", async (t) => {
  const urgentTask = task("stable-uid", "Pay invoice", "home");
  const cases = [
    { name: "unknown UID with changed description", detail: { id: "unknown", description: "Different task", context: urgentTask.context } },
    { name: "known UID with changed description", detail: { id: urgentTask.id, description: "Different task", context: urgentTask.context } },
    { name: "known UID with changed context", detail: { id: urgentTask.id, description: urgentTask.description, context: "different-context" } },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const env = bootBackground({
        initialStorage: { [SETTINGS_KEY]: settings },
        fetch: async (url) => {
          const path = new URL(url).pathname;
          if (path.endsWith("/agenda")) return json(agenda([urgentTask]));
          if (path.endsWith("/list")) return json(taskList([urgentTask], 1, 1, 1));
          if (path.endsWith("/task_1")) return json({ task: scenario.detail });
          return json({ changed: true });
        },
      });
      const reply = await env.send({
        type: "gateway.call", requestId: scenario.name, operation: "POPUP_DONE", args: { expectedTask: urgentTask },
      }, popupSender(env));

      assert.equal(reply.ok, false);
      assert.equal(reply.error.kind, "task-changed");
      assert.equal(env.requests.some(({ url }) => new URL(url).pathname.endsWith("/done")), false);
    });
  }
});

test("popup selection and mutation remain one FIFO group when another request arrives", async () => {
  const urgentTask = task("page-two", "Pay invoice", "home");
  const first = task("page-one", "Other task", "work");
  let page = 1;
  let releaseSelection;
  const env = bootBackground({
    initialStorage: { [SETTINGS_KEY]: settings },
    fetch: async (url) => {
      const path = new URL(url).pathname;
      if (path.endsWith("/agenda")) return json(agenda([urgentTask]));
      if (path.endsWith("/list")) {
        page = 1;
        return json(taskList([first], 1, 2, 2));
      }
      if (path.endsWith("/next")) {
        page += 1;
        return json(taskList([urgentTask], page, 2, 2));
      }
      if (path.endsWith("/task_1")) return new Promise((resolve) => {
        releaseSelection = () => resolve(json({ task: { id: "unknown", description: urgentTask.description, context: urgentTask.context } }));
      });
      return json({ changed: true });
    },
  });
  const action = env.send({
    type: "gateway.call", requestId: "fifo-popup-action", operation: "POPUP_DONE", args: { expectedTask: urgentTask },
  }, popupSender(env));
  await waitFor(() => env.requests.some(({ url }) => new URL(url).pathname.endsWith("/task_1")), "popup task selection");
  const queuedAgenda = env.send({
    type: "gateway.call", requestId: "fifo-agenda", operation: "GET_AGENDA", args: {},
  }, popupSender(env));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(env.requests.some(({ url }) => new URL(url).pathname.endsWith("/done")), false);
  assert.equal(env.requests.length, 6, "the queued agenda must not enter the selection/mutation group");
  releaseSelection();
  const [actionReply, agendaReply] = await Promise.all([action, queuedAgenda]);

  assert.equal(actionReply.ok, true);
  assert.equal(agendaReply.ok, true);
  assert.deepEqual(env.requests.map(({ url }) => new URL(url).pathname), [
    "/api/agenda", "/api/list", "/api/next", "/api/list", "/api/next", "/api/task_1",
    "/api/done", "/api/agenda", "/api/agenda",
  ]);
});
