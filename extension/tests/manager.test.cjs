const assert = require("node:assert/strict");
const test = require("node:test");
const { bootManager } = require("./manager-harness.cjs");
const {
  API_ROOT,
  agendaResource,
  eventsResource,
  projectCollection,
  projectResource,
  statisticsResource,
  strategiesResource,
  taskCollection,
  taskResource,
} = require("./manager-fixtures.cjs");

const defaultView = {
  page: 1,
  pageSize: 5,
  filters: ["All active task filter"],
  algorithm: "GTD Algorithm",
  heuristic: "Remaining Effort(1)",
  search: [],
};

function serverFixture({ missingTaskIds = [], missingTaskAfter = {}, ambiguousTaskIds = [], detailUpdates = {}, rootTimeZone = "Europe/Madrid", taskListHandler = null, taskGetHandler = null, projectContent = null, projectDescription = "Roadmap" } = {}) {
  const tasks = [
    taskResource("task-a"),
    taskResource("task-b", { description: "Second task" }),
    taskResource("task-c", { description: "Third task" }),
    taskResource("task-completed", { status: "completed" }),
    taskResource("agenda-only/東京", { description: "Outside the current page" }),
  ];
  const taskById = new Map(tasks.map((resource) => [resource.id, resource]));
  const calls = [];
  const taskGetCounts = new Map();
  async function readGateway(operation, target, parameters = {}) {
    calls.push({ operation, target: target ? structuredClone(target) : null, parameters: structuredClone(parameters) });
    if (operation === "root.read") {
      return { version: "1", timeZone: rootTimeZone, _links: Object.fromEntries(["tasks", "agenda", "statistics", "events", "strategies", "projects", "operations", "notifications"].map((name) => [name, { href: `${API_ROOT}/${name}` }])) };
    }
    if (operation === "strategies.list") return strategiesResource();
    if (operation === "tasks.list") {
      if (taskListHandler) {
        const custom = await taskListHandler(parameters, calls.filter((call) => call.operation === "tasks.list").length);
        if (custom) return custom;
      }
      const page = parameters.page ?? 1;
      const pageSize = parameters.pageSize ?? 5;
      const selectedTasks = parameters.filters?.includes("All Tasks") ? tasks : tasks.filter((resource) => resource.status !== "completed");
      const selected = selectedTasks.slice((page - 1) * pageSize, page * pageSize);
      return taskCollection(selected, { ...defaultView, ...parameters, total: selectedTasks.length });
    }
    if (operation === "tasks.get") {
      const id = target?.id;
      const count = (taskGetCounts.get(id) || 0) + 1;
      taskGetCounts.set(id, count);
      if (taskGetHandler) {
        const custom = await taskGetHandler(id, count, taskById.get(id));
        if (custom !== undefined) return custom;
      }
      if (id && ambiguousTaskIds.includes(id)) {
        const error = new Error("The task identifier is ambiguous");
        error.kind = "ambiguous-resource";
        error.status = 409;
        throw error;
      }
      if (!id || missingTaskIds.includes(id) || (missingTaskAfter[id] && count >= missingTaskAfter[id]) || !taskById.has(id)) {
        const error = new Error("The task was not found");
        error.kind = "http";
        error.status = 404;
        throw error;
      }
      const resource = structuredClone(taskById.get(id));
      const update = detailUpdates[id];
      if (update && count >= update.after) Object.assign(resource, update.values);
      return resource;
    }
    if (operation === "agenda.read") return agendaResource([taskById.get("agenda-only/東京")]);
    if (operation === "statistics.read") return statisticsResource(tasks);
    if (operation === "events.list") return eventsResource();
    if (operation === "projects.list") {
      const status = parameters.status ?? "open";
      const projectProperties = typeof projectContent === "string" ? { content: projectContent } : { description: projectDescription };
      const projects = status === "open"
        ? [projectResource("Project A", "open", projectProperties)]
        : [projectResource("Project B", "closed", { content: "Archived" })];
      return projectCollection(projects, status);
    }
    if (operation === "projects.get") {
      const projectProperties = typeof projectContent === "string" ? { content: projectContent } : { description: projectDescription };
      return projectResource(target.id, target.id === "Project B" ? "closed" : "open", projectProperties);
    }
    if (operation === "operations.get") return { id: target.id, status: "succeeded" };
    throw new Error(`Unexpected manager read ${operation}`);
  }
  return { calls, readGateway, tasks, taskById, taskGetCounts };
}

async function bootFixture(options = {}) {
  const fixture = serverFixture(options);
  const manager = bootManager({
    readGateway: fixture.readGateway,
    submitOperation: async (type, target, parameters) => ({
      id: "00000000-0000-4000-8000-000000000101",
      status: "succeeded",
      type,
      target,
      result: { type, target, effectsState: "complete", affectedIds: target?.id ? [target.id] : [] },
      failure: null,
    }),
  });
  await manager.flush();
  return { ...manager, fixture };
}

function lastTaskList(calls) {
  return calls.filter((call) => call.operation === "tasks.list").at(-1);
}

function dispatchValue(control, value, type = "change") {
  control.value = value;
  control.dispatchEvent({ type, bubbles: true });
}

function chooseValues(select, selectedValues) {
  const values = new Set(selectedValues);
  for (const option of select.options) option.selected = values.has(option.value || option.textContent);
  select.dispatchEvent({ type: "change", bubbles: true });
}

function taskRow(document, id) {
  return document.querySelector(`tr[data-task-id="${id}"]`);
}

function navByText(document, expression) {
  return document.querySelectorAll("[data-view]").find((button) => expression.test(button.textContent));
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

test("the manager renders saved notices offline and clear-local preserves the received cursor", async () => {
  const historyId = "14cc5d25-e2ec-4e17-b8a4-c084d27440ed";
  const endpointKey = "https://tasks.example.test/team/api/v1";
  const manager = bootManager({
    initialSettings: {
      schemaVersion: 1,
      serverUrl: endpointKey,
      token: "",
      monitorEnabled: false,
      timeoutMs: 30_000,
    },
    initialState: {
      settings: {
        schemaVersion: 1,
        serverUrl: endpointKey,
        token: "",
        monitorEnabled: false,
        timeoutMs: 30_000,
      },
      history: [],
      notificationReception: {
        schemaVersion: 1,
        endpointKey,
        historyId,
        lastReceivedSequence: 5,
        buffer: [{
          endpointKey,
          id: `${historyId}:5`,
          historyId,
          sequence: 5,
          timestamp: "2026-10-05T09:00:00+02:00",
          text: "<img src=x onerror=alert(1)> Aviso guardado",
        }],
        bufferGeneration: 3,
        continuity: {
          discardedThrough: 4,
          missedRanges: [{ fromSequence: 3, throughSequence: 4 }],
          gapsTruncated: false,
          localTruncated: true,
        },
      },
      notificationError: "",
      monitorStatus: null,
      gatewayError: null,
    },
  });
  await manager.flush();

  const list = manager.document.querySelector("#notification-list");
  assert.equal(manager.reads.length, 0, "the offline history surface does not call the gateway");
  assert.equal(manager.document.querySelector("#clear-history").disabled, false);
  assert.equal(list.children.length, 1);
  assert.equal(list.children[0].dataset.notificationId, `${historyId}:5`);
  assert.equal(list.children[0].dataset.historyId, historyId);
  assert.equal(list.children[0].dataset.sequence, "5");
  assert.match(list.textContent, /<img src=x onerror=alert\(1\)> Aviso guardado/);
  assert.match(manager.document.querySelector("#notification-continuity").textContent, /número 3 al 4/);

  manager.document.querySelector("#clear-history").click();
  await manager.flush();
  assert.deepEqual(manager.clearCalls, [{ operation: "notifications.clear-local" }]);
  assert.equal(manager.reads.length, 0, "clearing local notices does not contact the server");
  assert.equal(manager.writes.length, 0);
  assert.equal(list.children.length, 1);
  assert.match(list.children[0].className, /empty/);
  assert.equal(manager.document.querySelector("#clear-history").disabled, true);
  assert.match(manager.document.querySelector("#notification-monitor-status").textContent, /desactivada/);
});

test("each manager document sends a complete independent task view", async () => {
  const sharedCalls = [];
  const firstServer = serverFixture();
  const secondServer = serverFixture();
  const first = bootManager({ readGateway: async (...args) => { sharedCalls.push(["first", args[0], args[2]]); return firstServer.readGateway(...args); } });
  const second = bootManager({ readGateway: async (...args) => { sharedCalls.push(["second", args[0], args[2]]); return secondServer.readGateway(...args); } });
  await Promise.all([first.flush(), second.flush()]);

  assert.deepEqual(lastTaskList(firstServer.calls).parameters, defaultView);
  assert.deepEqual(lastTaskList(secondServer.calls).parameters, defaultView);

  const filters = first.document.querySelector("#task-filters");
  chooseValues(filters, ["All active task filter", "All Tasks"]);
  await first.flush();
  dispatchValue(first.document.querySelector("#task-algorithm"), "EDF Algorithm");
  await first.flush();
  dispatchValue(first.document.querySelector("#task-heuristic"), "Time Remaining");
  await first.flush();
  dispatchValue(first.document.querySelector("#task-search"), "urgent release", "input");
  first.document.querySelector("#task-search-form").submit();
  await first.flush();
  dispatchValue(first.document.querySelector("#task-page"), "3");
  dispatchValue(first.document.querySelector("#task-page-size"), "10");
  first.document.querySelector(".paging-controls button").click();
  await first.flush();

  assert.deepEqual(lastTaskList(firstServer.calls).parameters, {
    page: 3,
    pageSize: 10,
    filters: ["All active task filter", "All Tasks"],
    algorithm: "EDF Algorithm",
    heuristic: "Time Remaining",
    search: ["urgent", "release"],
  });
  assert.deepEqual(lastTaskList(secondServer.calls).parameters, defaultView);
  assert.ok(sharedCalls.some(([instance, operation]) => instance === "first" && operation === "tasks.list"));
  assert.ok(sharedCalls.some(([instance, operation]) => instance === "second" && operation === "tasks.list"));
});

test("agenda task details are resolved directly by opaque ID, including tasks outside the current page", async () => {
  const manager = await bootFixture();
  navByText(manager.document, /agenda/i).click();
  await manager.flush();

  const listReadsBeforeSelection = manager.fixture.calls.filter((call) => call.operation === "tasks.list").length;
  const row = taskRow(manager.document, "agenda-only/東京");
  assert.ok(row, "the agenda renders the task's opaque identifier on its row");
  row.click();
  await manager.flush();

  const detail = manager.fixture.calls.filter((call) => call.operation === "tasks.get");
  assert.equal(detail.length, 1);
  assert.deepEqual(detail[0].target, { kind: "task", id: "agenda-only/東京" });
  assert.equal(manager.fixture.calls.filter((call) => call.operation === "tasks.list").length, listReadsBeforeSelection, "selection does not search or walk pages");
  assert.equal(manager.document.querySelector("#task-detail").dataset.selectedTaskId, "agenda-only/東京");
});

test("missing and ambiguous task IDs never fall back to a row index", async (t) => {
  for (const [label, options] of [
    ["missing", { missingTaskIds: ["agenda-only/東京"] }],
    ["ambiguous", { ambiguousTaskIds: ["agenda-only/東京"] }],
  ]) {
    await t.test(label, async () => {
      const manager = await bootFixture(options);
      navByText(manager.document, /agenda/i).click();
      await manager.flush();
      const listReadsBeforeSelection = manager.fixture.calls.filter((call) => call.operation === "tasks.list").length;
      taskRow(manager.document, "agenda-only/東京").click();
      await manager.flush();

      const lookups = manager.fixture.calls.filter((call) => call.operation === "tasks.get");
      assert.deepEqual(lookups.map((call) => call.target.id), ["agenda-only/東京"]);
      assert.equal(manager.fixture.calls.filter((call) => call.operation === "tasks.list").length, listReadsBeforeSelection);
      assert.ok(manager.document.querySelector("#app-message").textContent);
    });
  }
});

test("task detail, agenda, statistics, events, and projects use their resource reads", async () => {
  const manager = await bootFixture();
  for (const [view, label] of [["agenda", /agenda/i], ["statistics", /estad[ií]stic/i], ["events", /event/i], ["projects", /proyecto|project/i]]) {
    const control = navByText(manager.document, label);
    assert.ok(control, `missing ${view} navigation control`);
    control.click();
    await manager.flush();
  }

  for (const operation of ["strategies.list", "tasks.list", "agenda.read", "statistics.read", "events.list", "projects.list"]) {
    assert.ok(manager.fixture.calls.some((call) => call.operation === operation), `expected ${operation}`);
  }
  assert.equal(manager.fixture.calls.filter((call) => call.operation.startsWith("GET_")).length, 0);
  assert.ok(manager.document.querySelector("#main-view").textContent.includes("Project A"));
});

test("statistics has an independent complete query view", async () => {
  const manager = await bootFixture();
  const tasksQuery = lastTaskList(manager.fixture.calls).parameters;
  navByText(manager.document, /estad[ií]stic/i).click();
  await manager.flush();
  chooseValues(manager.document.querySelector("#stats-filters"), ["All Tasks"]);
  await manager.flush();
  dispatchValue(manager.document.querySelector("#stats-algorithm"), "EDF Algorithm");
  await manager.flush();
  dispatchValue(manager.document.querySelector("#stats-heuristic"), "Time Remaining");
  await manager.flush();
  dispatchValue(manager.document.querySelector("#stats-search"), "release overdue", "input");
  manager.document.querySelector("#stats-search-form").submit();
  await manager.flush();

  const statsReads = manager.fixture.calls.filter((call) => call.operation === "statistics.read");
  assert.deepEqual(statsReads.at(-1).parameters, {
    page: 1,
    pageSize: 5,
    filters: ["All Tasks"],
    algorithm: "EDF Algorithm",
    heuristic: "Time Remaining",
    search: ["release", "overdue"],
  });
  assert.deepEqual(lastTaskList(manager.fixture.calls).parameters, tasksQuery, "statistics edits do not change the task-list view");
});

test("a task draft remains tied to its original ID across selection, refresh, focus, and invalidation", async () => {
  const manager = await bootFixture({
    detailUpdates: { "task-a": { after: 2, values: { description: "Task A updated elsewhere" } } },
  });
  taskRow(manager.document, "task-a").click();
  await manager.flush();

  const editFormA = manager.document.querySelector("#action-form-edit-task");
  assert.equal(editFormA.dataset.taskId, "task-a");
  const descriptionA = editFormA.elements.namedItem("changes.description");
  descriptionA.value = "Draft belongs to A";
  descriptionA.dispatchEvent({ type: "input", bubbles: true });

  manager.document.querySelector('[data-action="reload"]').click();
  await manager.flush();
  assert.equal(manager.document.querySelector("#action-form-edit-task").elements.namedItem("changes.description").value, "Draft belongs to A");

  manager.focus();
  manager.invalidate({ taskIds: ["task-a"], projectNames: [], eventNames: [], collections: ["tasks", "agenda", "statistics", "events"] });
  await manager.flush();
  assert.match(manager.document.querySelector("#stale-notice").textContent, /datos nuevos/i);
  assert.equal(manager.document.querySelector("#action-form-edit-task").elements.namedItem("changes.description").value, "Draft belongs to A");

  const tasksTab = navByText(manager.document, /^tareas$/i);
  tasksTab.click();
  await manager.flush();
  taskRow(manager.document, "task-b").click();
  await manager.flush();
  assert.equal(manager.document.querySelector("#action-form-edit-task").dataset.taskId, "task-b");
  assert.match(manager.document.querySelector("#draft-notice").textContent, /Task task-a/i);

  const openDraft = manager.document.querySelector('#draft-notice [data-action="open-draft"]');
  assert.ok(openDraft);
  openDraft.click();
  await manager.flush();
  const reopenedA = manager.document.querySelector("#action-form-edit-task");
  assert.equal(reopenedA.dataset.taskId, "task-a");
  assert.equal(reopenedA.elements.namedItem("changes.description").value, "Draft belongs to A");
  reopenedA.submit();
  await manager.flush();

  assert.equal(manager.writes.length, 1);
  assert.equal(manager.writes[0].type, "edit-task");
  assert.deepEqual(manager.writes[0].target, { kind: "task", id: "task-a" });
  assert.deepEqual(manager.writes[0].parameters, { changes: { description: "Draft belongs to A" } });
  assert.equal(manager.writes.some((write) => write.type === "tasks.patch"), false);
});

test("completed tasks omit completion and the edit form excludes identity, status, and derived effort", async () => {
  const manager = await bootFixture();
  chooseValues(manager.document.querySelector("#task-filters"), ["All Tasks"]);
  await manager.flush();
  taskRow(manager.document, "task-completed").click();
  await manager.flush();

  assert.ok(manager.document.querySelector("#action-form-edit-task"));
  assert.equal(manager.document.querySelector('[data-operation-name="complete-task"]'), null);
  assert.equal(manager.document.querySelector('#main-view [name="changes.id"]'), null);
  assert.equal(manager.document.querySelector('#main-view [name="changes.status"]'), null);
  assert.equal(manager.document.querySelector('#main-view [name="changes.investedEffort"]'), null);
  assert.equal(manager.writes.length, 0);
});

test("creating a task uses the collection target and preserves multiline description text exactly", async () => {
  const manager = await bootFixture();
  const form = manager.document.querySelector("#action-form-create-task");
  assert.ok(form, "create-task is rendered from the collection capability");
  const description = form.elements.namedItem("description");
  assert.ok(description);
  description.value = "  Primera línea\n\tSegunda línea  ";
  form.submit();
  await manager.flush();

  assert.equal(manager.writes.length, 1);
  assert.equal(manager.writes[0].type, "create-task");
  assert.deepEqual(manager.writes[0].target, { kind: "tasks" });
  assert.deepEqual(manager.writes[0].parameters, { description: "  Primera línea\n\tSegunda línea  " });
});

test("project content editing sends exact Markdown whitespace in one capability operation", async () => {
  const manager = await bootFixture({ projectContent: "# Project A\nbody\n" });
  navByText(manager.document, /proyecto|project/i).click();
  await manager.flush();
  manager.document.querySelector('[data-project-name="Project A"]').click();
  await manager.flush();

  const form = manager.document.querySelector("#action-form-edit-project-content");
  assert.ok(form, "the Markdown project capability is rendered from its own descriptor");
  form.elements.namedItem("action").value = "replace";
  form.elements.namedItem("line").value = "2";
  form.elements.namedItem("content").value = "  línea\n\tsegunda  ";
  form.submit();
  await manager.flush();

  assert.equal(manager.writes.length, 1);
  assert.equal(manager.writes[0].type, "edit-project-content");
  assert.deepEqual(manager.writes[0].target, { kind: "project", id: "Project A" });
  assert.deepEqual(manager.writes[0].parameters, { action: "replace", line: 2, content: "  línea\n\tsegunda  " });
});

test("project collection and detail capabilities keep their targets distinct and labels unique", async () => {
  const manager = await bootFixture();
  navByText(manager.document, /proyecto|project/i).click();
  await manager.flush();
  dispatchValue(manager.document.querySelector("#project-status"), "closed");
  await manager.flush();
  manager.document.querySelector('[data-project-name="Project B"]').click();
  await manager.flush();

  const openForms = manager.document.querySelectorAll('form[data-action-name="open-project"]');
  assert.equal(openForms.length, 2, "the collection and selected-project open capabilities are both shown");
  const ids = manager.document.querySelectorAll("[id]").map((element) => element.id).filter(Boolean);
  assert.equal(new Set(ids).size, ids.length, "form and input identifiers are unique within the document");
  for (const label of manager.document.querySelectorAll("label[for]")) {
    assert.ok(ids.includes(label.htmlFor), `label ${label.textContent} has a matching control`);
  }

  const collectionOpen = openForms.find((form) => form.elements.namedItem("target.id"));
  assert.ok(collectionOpen);
  collectionOpen.elements.namedItem("target.id").value = "New Project";
  collectionOpen.submit();
  await manager.flush();
  const detailOpen = manager.document.querySelectorAll('form[data-action-name="open-project"]').find((form) => !form.elements.namedItem("target.id"));
  assert.ok(detailOpen);
  detailOpen.submit();
  await manager.flush();

  assert.deepEqual(manager.writes.map((write) => [write.type, write.target]), [
    ["open-project", { kind: "project", id: "New Project" }],
    ["open-project", { kind: "project", id: "Project B" }],
  ]);
});

test("event action uses the published event identity without deriving a row position", async () => {
  const manager = await bootFixture();
  navByText(manager.document, /event/i).click();
  await manager.flush();
  const action = manager.document.querySelector('[data-operation-name="raise-event"]');
  assert.ok(action);
  action.click();
  await manager.flush();

  assert.equal(manager.writes.length, 1);
  assert.equal(manager.writes[0].type, "raise-event");
  assert.deepEqual(manager.writes[0].target, { kind: "event", id: "release-ready" });
});

test("record-work, schedule, and snooze submit the exact published task capability target and parameters", async (t) => {
  const scenarios = [
    { operation: "schedule-task", field: "effortPerDay", value: "1.5p", parameters: { effortPerDay: "1.5p" } },
    { operation: "record-work", field: "duration", value: "30m", parameters: { duration: "30m" } },
  ];
  for (const scenario of scenarios) {
    await t.test(scenario.operation, async () => {
      const manager = await bootFixture();
      taskRow(manager.document, "task-a").click();
      await manager.flush();
      const form = manager.document.querySelector(`#action-form-${scenario.operation}`);
      assert.ok(form);
      form.elements.namedItem(scenario.field).value = scenario.value;
      form.submit();
      await manager.flush();

      assert.equal(manager.writes.length, 1);
      assert.equal(manager.writes[0].type, scenario.operation);
      assert.deepEqual(manager.writes[0].target, { kind: "task", id: "task-a" });
      assert.deepEqual(manager.writes[0].parameters, scenario.parameters);
    });
  }

  await t.test("snooze retains its edited default while switching task detail", async () => {
    const manager = await bootFixture();
    taskRow(manager.document, "task-a").click();
    await manager.flush();
    const snooze = manager.document.querySelector("#action-form-snooze-task");
    assert.equal(snooze.elements.namedItem("duration").value, "5m");
    snooze.elements.namedItem("duration").value = "1h";
    snooze.elements.namedItem("duration").dispatchEvent({ type: "input", bubbles: true });

    navByText(manager.document, /^tareas$/i).click();
    await manager.flush();
    taskRow(manager.document, "task-b").click();
    await manager.flush();
    assert.match(manager.document.querySelector("#draft-notice").textContent, /Task task-a/i);
    manager.document.querySelector('#draft-notice [data-action="open-draft"]').click();
    await manager.flush();
    const restored = manager.document.querySelector("#action-form-snooze-task");
    assert.equal(restored.dataset.taskId, "task-a");
    assert.equal(restored.elements.namedItem("duration").value, "1h");
    restored.submit();
    await manager.flush();

    assert.equal(manager.writes.length, 1);
    assert.equal(manager.writes[0].type, "snooze-task");
    assert.deepEqual(manager.writes[0].target, { kind: "task", id: "task-a" });
    assert.deepEqual(manager.writes[0].parameters, { duration: "1h" });
  });
});

test("open, close, and hold project actions use their advertised project IDs", async () => {
  const manager = await bootFixture();
  navByText(manager.document, /proyecto|project/i).click();
  await manager.flush();
  const createForm = manager.document.querySelector("#action-form-open-project");
  createForm.elements.namedItem("target.id").value = "New Project";
  createForm.submit();
  await manager.flush();

  manager.document.querySelector('[data-project-name="Project A"]').click();
  await manager.flush();
  manager.document.querySelector('[data-operation-name="close-project"]').click();
  await manager.flush();
  manager.document.querySelector('[data-operation-name="hold-project"]').click();
  await manager.flush();

  assert.deepEqual(manager.writes.map((write) => [write.type, write.target]), [
    ["open-project", { kind: "project", id: "New Project" }],
    ["close-project", { kind: "project", id: "Project A" }],
    ["hold-project", { kind: "project", id: "Project A" }],
  ]);
});

test("empty Markdown replacement content is sent explicitly instead of omitted", async () => {
  const manager = await bootFixture({ projectContent: "# Project A\nbody\n" });
  navByText(manager.document, /proyecto|project/i).click();
  await manager.flush();
  manager.document.querySelector('[data-project-name="Project A"]').click();
  await manager.flush();
  const form = manager.document.querySelector("#action-form-edit-project-content");
  form.elements.namedItem("action").value = "replace";
  form.elements.namedItem("line").value = "2";
  form.elements.namedItem("content").value = "";
  form.submit();
  await manager.flush();

  assert.equal(manager.writes.length, 1);
  assert.deepEqual(manager.writes[0].parameters, { action: "replace", line: 2, content: "" });
});

test("a required JSON project description may be explicitly cleared to an empty string", async () => {
  const manager = await bootFixture({ projectDescription: "Existing summary" });
  navByText(manager.document, /proyecto|project/i).click();
  await manager.flush();
  manager.document.querySelector('[data-project-name="Project A"]').click();
  await manager.flush();
  const form = manager.document.querySelector("#action-form-edit-project-content");
  form.elements.namedItem("description").value = "";
  form.submit();
  await manager.flush();

  assert.equal(manager.writes.length, 1);
  assert.deepEqual(manager.writes[0].parameters, { description: "" });
});

test("apply-fresh preserves a local due date and does not resend an untouched remote description", async () => {
  const manager = await bootFixture({
    detailUpdates: { "task-a": { after: 2, values: { description: "Remote description" } } },
  });
  taskRow(manager.document, "task-a").click();
  await manager.flush();
  const form = manager.document.querySelector("#action-form-edit-task");
  const due = form.elements.namedItem("changes.due");
  due.value = "2026-10-09T15:00:00+02:00";
  due.dispatchEvent({ type: "input", bubbles: true });

  manager.focus();
  await manager.flush();
  const fresh = manager.document.querySelector('#stale-notice [data-action="apply-fresh"]');
  assert.ok(fresh, "remote changes are offered while the local draft remains pending");
  fresh.click();
  await manager.flush();

  const updatedForm = manager.document.querySelector("#action-form-edit-task");
  assert.equal(updatedForm.elements.namedItem("changes.description").value, "Remote description");
  assert.equal(updatedForm.elements.namedItem("changes.due").value, "2026-10-09T15:00:00+02:00");
  updatedForm.submit();
  await manager.flush();

  assert.equal(manager.writes.length, 1);
  assert.deepEqual(manager.writes[0].parameters, { changes: { due: "2026-10-09T15:00:00+02:00" } });
});

test("a detail refresh that receives 404 reports the failure instead of a successful refresh", async () => {
  const manager = await bootFixture({ missingTaskAfter: { "task-a": 2 } });
  taskRow(manager.document, "task-a").click();
  await manager.flush();
  manager.invalidate({ taskIds: ["task-a"], projectNames: [], eventNames: [], collections: ["tasks"] });
  await manager.flush();

  assert.match(manager.document.querySelector("#main-view").textContent, /not found|no se encontr/i);
  assert.match(manager.document.querySelector("#app-message").textContent, /not found|no se encontr/i);
  assert.doesNotMatch(manager.document.querySelector("#app-message").textContent, /actualizados|completado/i);
});

test("a late failed detail read cannot add an error after a newer detail read succeeded", async () => {
  const oldRead = deferred();
  const manager = await bootFixture({
    taskGetHandler: async (id, count, resource) => {
      if (id !== "task-a") return undefined;
      if (count === 2) return oldRead.promise;
      if (count === 3) return { ...structuredClone(resource), description: "Newest details" };
      return undefined;
    },
  });
  taskRow(manager.document, "task-a").click();
  await manager.flush();
  manager.focus();
  await manager.flush();
  manager.invalidate({ taskIds: ["task-a"], projectNames: [], eventNames: [], collections: ["tasks"] });
  await manager.flush();
  assert.match(manager.document.querySelector("#task-detail").textContent, /Newest details/);

  const notFound = new Error("The task was not found in this profile");
  notFound.status = 404;
  oldRead.reject(notFound);
  await manager.flush();

  assert.match(manager.document.querySelector("#task-detail").textContent, /Newest details/);
  assert.doesNotMatch(manager.document.querySelector("#main-view").textContent, /not found|no se encontr/i);
});

test("an invalid or missing server timezone prevents an agenda query with a guessed local day", async () => {
  const manager = await bootFixture({ rootTimeZone: "Invalid/Timezone" });
  navByText(manager.document, /agenda/i).click();
  await manager.flush();

  assert.equal(manager.fixture.calls.filter((call) => call.operation === "agenda.read").length, 0);
  assert.match(manager.document.querySelector("#app-message").textContent, /zona horaria|time.?zone/i);
});

test("a slower old task query cannot overwrite the latest query result", async () => {
  const oldQuery = deferred();
  const newQuery = deferred();
  let requestNumber = 0;
  const manager = await bootFixture({
    taskListHandler: async (parameters) => {
      requestNumber += 1;
      if (requestNumber === 2) return oldQuery.promise;
      if (requestNumber === 3) return newQuery.promise;
      return null;
    },
  });

  manager.focus();
  await manager.flush();
  assert.equal(requestNumber, 2);
  dispatchValue(manager.document.querySelector("#task-algorithm"), "EDF Algorithm");
  await manager.flush();
  assert.equal(requestNumber, 3);

  newQuery.resolve(taskCollection([taskResource("new-query")], { ...defaultView, algorithm: "EDF Algorithm" }));
  await manager.flush();
  assert.match(manager.document.querySelector("#main-view").textContent, /EDF Algorithm/);
  oldQuery.resolve(taskCollection([taskResource("old-query")], { ...defaultView, algorithm: "GTD Algorithm", heuristic: "Remaining Effort(1)" }));
  await manager.flush();

  assert.match(manager.document.querySelector("#main-view").textContent, /EDF Algorithm/);
  assert.ok(taskRow(manager.document, "new-query"), "the current query resource remains visible");
  assert.equal(taskRow(manager.document, "old-query"), null, "a slower stale response cannot replace the current query resource");
});

test("a delayed initial storage snapshot cannot replace a newer connection or its draft", async () => {
  const initialRead = deferred();
  const oldSettings = {
    schemaVersion: 1,
    serverUrl: "https://old.example.test/team/api/v1",
    token: "old-token",
    monitorEnabled: true,
    timeoutMs: 30_000,
  };
  const newSettings = {
    schemaVersion: 1,
    serverUrl: "https://new.example.test/team/api/v1",
    token: "new-token",
    monitorEnabled: true,
    timeoutMs: 30_000,
  };
  const manager = bootManager({ initialSettings: oldSettings, initialStatePromise: initialRead.promise, readGateway: serverFixture().readGateway });

  manager.storageChanged({ "settings.v1": { oldValue: oldSettings, newValue: newSettings } });
  await manager.flush();
  assert.ok(manager.reads.some((read) => read.operation === "root.read"), "the new connection starts loading while initial hydration is pending");
  assert.ok(taskRow(manager.document, "task-a"), "the new connection's task collection is visible");

  taskRow(manager.document, "task-a").click();
  await manager.flush();
  const form = manager.document.querySelector("#action-form-edit-task");
  const description = form.elements.namedItem("changes.description");
  description.value = "Draft on the new connection";
  description.dispatchEvent({ type: "input", bubbles: true });
  const readsBeforeOldSnapshot = manager.reads.length;

  initialRead.resolve({ settings: oldSettings, history: [], monitorStatus: null, gatewayError: null });
  await manager.flush();

  assert.equal(manager.reads.length, readsBeforeOldSnapshot, "the stale snapshot does not trigger a second load against the old connection");
  const preservedForm = manager.document.querySelector("#action-form-edit-task");
  assert.equal(preservedForm.dataset.taskId, "task-a");
  assert.equal(preservedForm.elements.namedItem("changes.description").value, "Draft on the new connection");
  preservedForm.submit();
  await manager.flush();

  assert.equal(manager.writes.length, 1, "the draft remains actionable under the current connection scope");
  assert.deepEqual(manager.writes[0].target, { kind: "task", id: "task-a" });
  assert.deepEqual(manager.writes[0].parameters, { changes: { description: "Draft on the new connection" } });
});
