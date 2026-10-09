const API_ROOT = "https://tasks.example.test/team/api/v1";

function operationAction(name, target, inputs = {}) {
  return {
    name,
    href: `${API_ROOT}/operations`,
    method: "POST",
    contentType: "application/json",
    target,
    inputs,
  };
}

function taskResource(id, overrides = {}) {
  const completed = overrides.status === "completed";
  const target = { kind: "task", id };
  const actions = [
    operationAction("edit-task", target, {
      changes: {
        type: "object",
        required: false,
        properties: {
          description: { type: "string", required: false },
          context: { type: "string", required: false, startsWithAny: ["work", "home", "alert"] },
          start: { type: "string", required: false, format: "date-time" },
          due: { type: "string", required: false, format: "date-time" },
          severity: { type: "number", required: false, finite: true },
          totalCost: { type: "object", required: false },
          calm: { type: "boolean", required: false },
          raised: { type: ["string", "null"], required: false },
          waited: { type: ["string", "null"], required: false },
        },
      },
      effortDelta: { type: "duration", required: false },
    }),
  ];
  if (!completed) actions.push(operationAction("complete-task", target));
  actions.push(
    { ...operationAction("schedule-task", target, { effortPerDay: { type: "duration", required: false } }), preview: { algorithm: "heuristic-v1", dailyDedication: 2 } },
    operationAction("record-work", target, { duration: { type: "duration", required: true } }),
    operationAction("snooze-task", target, { duration: { type: "duration", required: false, default: "5m" } }),
  );
  return {
    id,
    timeZone: "Europe/Madrid",
    description: `Task ${id}`,
    context: "work",
    start: "2026-10-05T09:00:00+02:00",
    due: "2026-10-07T17:00:00+02:00",
    severity: 1,
    totalCost: { value: "3", unit: "pomodoro" },
    investedEffort: { value: "1", unit: "pomodoro" },
    status: completed ? "completed" : "active",
    calm: false,
    project: null,
    waited: null,
    raised: null,
    observedAt: "2026-10-05T10:00:00+02:00",
    heuristics: [{ name: "Remaining Effort(1)", value: 2, comment: "" }],
    metadata: null,
    _links: {
      self: { href: `${API_ROOT}/tasks/${encodeURIComponent(id)}` },
      collection: { href: `${API_ROOT}/tasks` },
      root: { href: API_ROOT },
    },
    actions,
    ...overrides,
  };
}

function taskCollection(tasks, query = {}) {
  const page = query.page ?? 1;
  const pageSize = query.pageSize ?? 5;
  const total = query.total ?? tasks.length;
  return {
    total,
    page,
    pageSize,
    totalPages: Math.ceil(total / pageSize),
    algorithm: { name: query.algorithm ?? "GTD Algorithm", description: "Sorts by due date." },
    heuristic: query.heuristic ?? "Remaining Effort(1)",
    filters: (query.filters ?? ["All active task filter"]).map((name, index) => ({ name, index: index + 1, description: name })),
    search: query.search ?? [],
    observedAt: "2026-10-05T10:00:00+02:00",
    actions: [operationAction("create-task", { kind: "tasks" }, {
      description: { type: "string", required: true },
      context: { type: "string", required: false, startsWithAny: ["work", "home", "alert"] },
      totalCost: { type: "object", required: false },
    })],
    _links: {
      self: { href: `${API_ROOT}/tasks?page=${page}&pageSize=${pageSize}` },
      root: { href: API_ROOT },
    },
    _embedded: { tasks },
  };
}

function agendaResource(tasks = []) {
  return {
    day: "2026-10-05",
    timeZone: "Europe/Madrid",
    heuristic: "Remaining Effort(1)",
    observedAt: "2026-10-05T10:00:00+02:00",
    _links: { self: { href: `${API_ROOT}/agenda?day=2026-10-05` }, root: { href: API_ROOT } },
    _embedded: {
      activeUrgentTasks: tasks,
      plannedUrgentTasks: [],
      plannedTasksByDate: {},
      otherTasks: [],
    },
  };
}

function strategiesResource() {
  return {
    _links: { self: { href: `${API_ROOT}/strategies` } },
    _embedded: {
      filters: [
        { id: "All active task filter", name: "All active task filter", description: "Open tasks", kind: "filter", enabled: true },
        { id: "All Tasks", name: "All Tasks", description: "All tasks", kind: "filter", enabled: false },
      ],
      algorithms: [
        { id: "GTD Algorithm", name: "GTD Algorithm", description: "Task order", kind: "algorithm" },
        { id: "EDF Algorithm", name: "EDF Algorithm", description: "Due date order", kind: "algorithm" },
      ],
      heuristics: [
        { id: "Remaining Effort(1)", name: "Remaining Effort(1)", description: "Remaining work", kind: "heuristic" },
        { id: "Time Remaining", name: "Time Remaining", description: "Time until due", kind: "heuristic" },
      ],
    },
  };
}

function statisticsResource(tasks = []) {
  return {
    taskCount: tasks.length,
    timeZone: "Europe/Madrid",
    workload: { value: "7.5", unit: "pomodoro" },
    remainingEffort: { value: "4.5", unit: "pomodoro" },
    slack: { name: "Remaining Effort(1)", value: 2 },
    offender: "work",
    offenderWorkload: { value: "7.5", unit: "pomodoro" },
    workDone: { "2026-10-05": 1 },
    workDoneLog: [{ timestamp: "2026-10-05T10:00:00+02:00", workUnits: "1", unit: "pomodoro", task: "Fixture task" }],
    observedAt: "2026-10-05T10:00:00+02:00",
    _links: { self: { href: `${API_ROOT}/statistics` }, root: { href: API_ROOT } },
  };
}

function eventsResource() {
  return {
    totalEvents: 1,
    timeZone: "Europe/Madrid",
    totalRaisingTasks: 1,
    totalWaitingTasks: 0,
    orphanedEvents: 1,
    observedAt: "2026-10-05T10:00:00+02:00",
    _links: { self: { href: `${API_ROOT}/events` }, root: { href: API_ROOT } },
    _embedded: { events: [{ name: "release-ready", raisingTasks: 1, waitingTasks: 0, orphaned: true, orphanType: "waiting-task-missing", actions: [operationAction("raise-event", { kind: "event", id: "release-ready" })] }] },
  };
}

function projectResource(name, status = "open", properties = {}) {
  const actions = [];
  if (status === "open") {
    actions.push(operationAction("close-project", { kind: "project", id: name }));
    actions.push(operationAction("hold-project", { kind: "project", id: name }));
  } else {
    actions.push(operationAction("open-project", { kind: "project", id: name }));
  }
  if (Object.hasOwn(properties, "content")) {
    actions.push(operationAction("edit-project-content", { kind: "project", id: name }, {
      action: { type: "string", required: true, enum: ["replace", "insert", "delete"] },
      line: { type: "integer", required: true, minimum: 1 },
      content: { type: "string", required: false, requiredWhen: ["replace", "insert"] },
    }));
  } else if (Object.hasOwn(properties, "description")) {
    actions.push(operationAction("edit-project-content", { kind: "project", id: name }, {
      description: { type: "string", required: true },
    }));
  }
  return {
    name,
    status,
    ...properties,
    observedAt: "2026-10-05T10:00:00+02:00",
    timeZone: "Europe/Madrid",
    _links: { self: { href: `${API_ROOT}/projects/${encodeURIComponent(name)}` }, root: { href: API_ROOT } },
    actions,
  };
}

function projectCollection(projects, status = "open") {
  return {
    status,
    total: projects.length,
    observedAt: "2026-10-05T10:00:00+02:00",
    actions: [operationAction("open-project", { kind: "project" }, { "target.id": { type: "string", required: true } })],
    _links: { self: { href: `${API_ROOT}/projects?status=${status}` }, root: { href: API_ROOT } },
    _embedded: { projects },
  };
}

function operationReceipt({ id, type, target, affectedIds = [], value = null, effectsState = "complete" }) {
  return {
    id,
    status: "succeeded",
    type,
    target,
    parameters: {},
    result: {
      type,
      target,
      affectedIds,
      effectsState,
      value,
      _links: { affected: affectedIds.map((affectedId) => ({ href: `${API_ROOT}/tasks/${encodeURIComponent(affectedId)}` })) },
    },
    failure: null,
    timeZone: "Europe/Madrid",
    observedAt: "2026-10-05T10:00:00+02:00",
    _links: { self: { href: `${API_ROOT}/operations/${id}` }, root: { href: API_ROOT } },
    _embedded: { results: [] },
  };
}

module.exports = {
  API_ROOT,
  agendaResource,
  eventsResource,
  operationAction,
  operationReceipt,
  projectCollection,
  projectResource,
  statisticsResource,
  strategiesResource,
  taskCollection,
  taskResource,
};
