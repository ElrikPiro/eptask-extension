const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { extensionRoot } = require("./helpers.cjs");

const popupPath = path.join(extensionRoot, "js/popup.js");
const renderPath = path.join(extensionRoot, "js/render.js");
const popupSource = fs.readFileSync(popupPath, "utf8")
  .replace(/^import .*;\s*$/gm, "") + `
globalThis.__popupTest = {
  getState: () => ({
    stateLoaded,
    settings: extensionState?.settings,
    task: currentTask,
    agendaLoading,
    activeAction,
    needsRefreshBeforeAction,
    managerOpening,
    managerOpenState,
    managerOpenMessage,
    notificationReception: extensionState?.notificationReception,
    notificationError: extensionState?.notificationError,
  }),
  refreshUrgentTask,
  performTaskAction,
  performManagerOpen,
};
`;
const renderSource = fs.readFileSync(renderPath, "utf8")
  .replace(/^export\s+/gm, "") + `\n globalThis.__popupRenderer = { node, renderNotificationHistory };`;

const readySettings = (overrides = {}) => ({
  schemaVersion: 1,
  serverUrl: "https://tasks.example.test/api/v1",
  token: "test-token",
  monitorEnabled: true,
  timeoutMs: 30_000,
  ...overrides,
});

function task(id, description = `Task ${id}`, context = "work") {
  return {
    id,
    description,
    context,
    due: "2026-10-05",
    status: "active",
    totalCost: { value: "2", unit: "pomodoro" },
    investedEffort: { value: "1", unit: "pomodoro" },
  };
}

function success(data, status = 200) {
  return { requestId: "fixture-request", ok: true, status, data, error: null };
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

class FakeElement {
  constructor(tagName = "div") {
    this.tagName = String(tagName).toUpperCase();
    this.children = [];
    this.listeners = new Map();
    this.attributes = new Map();
    this.dataset = new Proxy({}, {
      get: (_target, property) => this.attributes.get(`data-${String(property).replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`),
      set: (_target, property, value) => {
        this.attributes.set(`data-${String(property).replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`, String(value));
        return true;
      },
    });
    this.classList = {
      toggle: (name, force) => {
        const classes = new Set(this.className.split(/\\s+/).filter(Boolean));
        const shouldAdd = force === undefined ? !classes.has(name) : Boolean(force);
        if (shouldAdd) classes.add(name);
        else classes.delete(name);
        this.className = [...classes].join(" ");
        return shouldAdd;
      },
    };
    this.hidden = false;
    this.title = "";
    this.className = "";
    this.disabled = false;
    this._textContent = "";
  }

  set textContent(value) {
    this._textContent = value === null || value === undefined ? "" : String(value);
    this.children = [];
  }

  get textContent() {
    return this._textContent + this.children.map((child) => child.textContent).join("");
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  removeAttribute(name) {
    this.attributes.delete(name);
    if (name === "title") this.title = "";
  }

  append(...children) {
    this._textContent = "";
    this.children.push(...children);
  }

  replaceChildren(...children) {
    this._textContent = "";
    this.children = [...children];
  }

  click() {
    if (this.disabled) return;
    for (const listener of this.listeners.get("click") ?? []) {
      listener({ target: this, preventDefault() {} });
    }
  }
}

function bootPopup({ initialSettings = readySettings(), initialState, initialStatePromise, respond, managerOpen, serverTimeZone = "Europe/Madrid" } = {}) {
  const selectors = [
    "#popup-status", "#urgent-task", "#open-options", "#open-manager",
    "#refresh-agenda", "#complete-task", "#snooze-task", "#popup-error-badge",
    "#popup-notification-list", "#popup-notification-monitor-status", "#popup-notification-continuity", "#popup-clear-history", "#manager-open-status",
  ];
  const elements = new Map(selectors.map((selector) => [selector, new FakeElement() ]));
  for (const selector of ["#refresh-agenda", "#complete-task", "#snooze-task"]) {
    elements.get(selector).disabled = true;
  }

  const calls = [];
  let storageListener = null;
  let changeListener = null;
  let localState = initialState || { settings: initialSettings, history: [], notificationReception: null, notificationError: "", monitorStatus: null, gatewayError: null };
  let initialReadPending = Boolean(initialStatePromise);
  const clearCalls = [];
  const windowListeners = new Map();
  const documentListeners = new Map();
  const document = {
    querySelector(selector) {
      const element = elements.get(selector);
      if (!element) throw new Error(`Unexpected selector ${selector}`);
      return element;
    },
    createElement(tagName) {
      return new FakeElement(tagName);
    },
    addEventListener(type, listener) { documentListeners.set(type, listener); },
  };
  const node = (tagName, text = "", className = "") => {
    const element = document.createElement(tagName);
    if (text !== null && text !== undefined) element.textContent = String(text);
    if (className) element.className = className;
    return element;
  };
  const sandbox = {
    document,
    window: { addEventListener(type, listener) { windowListeners.set(type, listener); } },
    Error,
    Promise,
    browserApi: {
      runtime: {
        id: "popup-test-extension",
        openOptionsPage: async () => undefined,
        getURL: (relativePath) => `moz-extension://test/${relativePath}`,
      },
      tabs: { create: async () => ({ id: 1 }) },
    },
    gatewayCall(operation, args = {}) {
      calls.push({ operation, args });
      if (respond) return respond(operation, args, calls);
      if (operation === "GET_AGENDA") return Promise.resolve(success({ active_urgent_tasks: [task("task-1")] }));
      return Promise.resolve(success({ id: "operation-id", status: "succeeded", result: { effectsState: "complete", affectedIds: [] }, failure: null }, 201));
    },
    readGateway(operation, target = null, parameters = {}) {
      calls.push({ operation, target, parameters });
      if (operation === "root.read") return Promise.resolve(success({ timeZone: serverTimeZone }));
      if (respond) {
        const response = respond(operation, { target, parameters }, calls);
        if (response !== undefined) return response;
      }
      return Promise.resolve(success({}));
    },
    openManagerPage() {
      calls.push({ operation: "manager.open", target: null, parameters: {} });
      return managerOpen ? managerOpen(calls) : Promise.resolve(success({ opened: true, reused: true }));
    },
    subscribeChanges(listener) {
      changeListener = listener;
      return () => { changeListener = null; };
    },
    assertSuccessfulReply(reply) {
      if (reply?.ok === true) return reply;
      const error = new Error(reply?.error?.message || "La operación no se pudo completar.");
      error.kind = typeof reply?.error?.kind === "string" ? reply.error.kind : "gateway-unavailable";
      error.status = Number.isInteger(reply?.status) ? reply.status : null;
      error.operationId = reply?.error?.operationId;
      error.effectsState = reply?.error?.effectsState;
      error.requestId = reply?.requestId;
      throw error;
    },
    isReady(settings) {
      return Boolean(
        settings && settings.monitorEnabled === true &&
        typeof settings.serverUrl === "string" && settings.serverUrl.trim() &&
        typeof settings.token === "string" && settings.token.trim(),
      );
    },
    readExtensionState() {
      if (initialReadPending) {
        initialReadPending = false;
        return initialStatePromise;
      }
      return Promise.resolve(localState);
    },
    async clearNotificationBuffer() {
      clearCalls.push({ operation: "notifications.clear-local" });
      const reception = localState.notificationReception;
      const bufferGeneration = (reception?.bufferGeneration || 0) + 1;
      localState = {
        ...localState,
        history: [],
        notificationReception: reception ? {
          ...reception,
          buffer: [],
          bufferGeneration,
          ...(reception.continuity ? { continuity: { ...reception.continuity, localTruncated: false } } : {}),
        } : null,
      };
      return success({ cleared: true, bufferGeneration });
    },
    subscribeStorageChanges(listener) {
      storageListener = listener;
      return () => {};
    },
  };
  const context = vm.createContext(sandbox);
  vm.runInContext(renderSource, context, { filename: renderPath, timeout: 2_000 });
  vm.runInContext(popupSource, context, { filename: popupPath, timeout: 2_000 });

  return {
    calls,
    clearCalls,
    elements,
    state: () => context.__popupTest.getState(),
    focus: () => windowListeners.get("focus")?.(),
    visible: () => documentListeners.get("visibilitychange")?.(),
    changeSettings(settings) {
      storageListener({ "settings.v1": { newValue: settings } });
    },
    storageChanged(changes) {
      if (changes["notificationReception.v1"]) {
        localState = { ...localState, notificationReception: changes["notificationReception.v1"].newValue };
      }
      if (changes["notificationHistory.v1"]) {
        localState = { ...localState, history: changes["notificationHistory.v1"].newValue };
      }
      storageListener(changes);
    },
    invalidate(changes = { taskIds: [], projectNames: [], eventNames: [], collections: ["tasks", "agenda"] }) {
      changeListener?.(changes);
    },
    async flush() {
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(`Timed out waiting for ${message}`);
}

test("popup loads the first urgent agenda task and enables its accessible actions", async () => {
  const first = task("task-a", "Pay invoice", "home");
  const env = bootPopup({
    respond: (operation) => operation === "GET_AGENDA"
      ? Promise.resolve(success({ active_urgent_tasks: [first, task("task-b")] }))
      : Promise.resolve(success({})),
  });

  await waitFor(() => env.calls.some((call) => call.operation === "GET_AGENDA") && !env.state().agendaLoading, "initial agenda");
  assert.deepEqual(env.calls.map(({ operation }) => operation), ["root.read", "GET_AGENDA"]);
  assert.match(env.elements.get("#urgent-task").textContent, /Pay invoice/);
  assert.equal(env.elements.get("#complete-task").disabled, false);
  assert.equal(env.elements.get("#snooze-task").disabled, false);
  assert.equal(env.elements.get("#refresh-agenda").disabled, false);
});

test("popup maps a HAL agenda resource into the displayed task without exposing transport fields", async () => {
  const env = bootPopup({
    respond: (operation) => operation === "GET_AGENDA"
      ? Promise.resolve(success({
        _embedded: {
          activeUrgentTasks: [{
            id: "task/ä",
            description: "Prepare the release",
            context: "work",
            due: "2026-10-05",
            status: "active",
            totalCost: { value: "2", unit: "pomodoro" },
            investedEffort: { value: "1", unit: "pomodoro" },
            _links: { self: { href: "https://api.example.test/api/v1/tasks/task%2F%C3%A4" } },
          }],
        },
      }))
      : Promise.resolve(success({})),
  });

  await waitFor(() => env.state().stateLoaded && !env.state().agendaLoading, "HAL agenda conversion");
  assert.deepEqual(JSON.parse(JSON.stringify(env.state().task)), {
    id: "task/ä",
    description: "Prepare the release",
    context: "work",
    due: "2026-10-05",
    status: "active",
    total_cost: "2",
  });
  assert.doesNotMatch(env.elements.get("#urgent-task").textContent, /https:\/\//);
  assert.match(env.elements.get("#urgent-task").textContent, /2p/);
});

test("popup preserves negative backend remaining effort without subtracting invested work", async () => {
  const env = bootPopup({
    respond: (operation) => operation === "GET_AGENDA"
      ? Promise.resolve(success({
        _embedded: {
          activeUrgentTasks: [{
            id: "negative-cost",
            description: "Review balance",
            context: "work",
            totalCost: { value: "-0.5", unit: "pomodoro" },
            investedEffort: { value: "9", unit: "pomodoro" },
          }],
        },
      }))
      : undefined,
  });

  await waitFor(() => env.calls.some((call) => call.operation === "GET_AGENDA") && !env.state().agendaLoading, "negative effort display");
  assert.deepEqual(JSON.parse(JSON.stringify(env.state().task)), {
    id: "negative-cost",
    description: "Review balance",
    context: "work",
    total_cost: "-0.5",
  });
  assert.match(env.elements.get("#urgent-task").textContent, /-0\.5p/);
});

test("an invalid server timezone prevents a guessed agenda query", async () => {
  const env = bootPopup({ serverTimeZone: "Invalid/Zone" });
  await waitFor(() => env.state().stateLoaded && !env.state().agendaLoading, "timezone failure");

  assert.equal(env.calls.filter((call) => call.operation === "GET_AGENDA").length, 0);
  assert.match(env.elements.get("#urgent-task").textContent, /zona horaria|respuesta no válida/i);
  assert.equal(env.elements.get("#complete-task").disabled, true);
  assert.equal(env.elements.get("#snooze-task").disabled, true);
});

test("actions stay disabled without a connection or when the agenda has no urgent task", async () => {
  const env = bootPopup({
    initialSettings: { ...readySettings(), monitorEnabled: false },
    respond: (operation) => operation === "GET_AGENDA"
      ? Promise.resolve(success({ active_urgent_tasks: [] }))
      : Promise.resolve(success({})),
  });
  await waitFor(() => env.state().stateLoaded, "initial disconnected state");
  assert.equal(env.calls.length, 0);
  assert.equal(env.elements.get("#refresh-agenda").disabled, true);
  assert.equal(env.elements.get("#complete-task").disabled, true);
  assert.equal(env.elements.get("#snooze-task").disabled, true);

  env.changeSettings(readySettings());
  assert.equal(env.calls.length, 0, "a settings change must not request the agenda");
  assert.equal(env.elements.get("#refresh-agenda").disabled, false);
  assert.match(env.elements.get("#popup-status").textContent, /Actualiza la agenda/);
  env.elements.get("#refresh-agenda").click();
  await waitFor(() => env.calls.filter((call) => call.operation === "GET_AGENDA").length === 1 && !env.state().agendaLoading, "empty agenda");
  assert.match(env.elements.get("#urgent-task").textContent, /No hay tareas urgentes activas/);
  assert.equal(env.elements.get("#refresh-agenda").disabled, false);
  assert.equal(env.elements.get("#complete-task").disabled, true);
  assert.equal(env.elements.get("#snooze-task").disabled, true);
});

test("complete and snooze send the displayed identity once and refresh the agenda after success", async () => {
  const first = task("uid-1", "Prepare report", "office");
  const second = task("uid-2", "Call customer", "phone");
  const actionResponse = deferred();
  const env = bootPopup({
    respond: (operation, _args, calls) => {
      if (operation === "GET_AGENDA") {
        const refreshCount = calls.filter((call) => call.operation === "GET_AGENDA").length;
        return Promise.resolve(success({ active_urgent_tasks: [refreshCount === 1 ? first : second] }));
      }
      if (operation === "POPUP_DONE") return actionResponse.promise;
      return Promise.resolve(success({}));
    },
  });
  await waitFor(() => env.calls.filter((call) => call.operation === "GET_AGENDA").length === 1 && !env.state().agendaLoading, "first agenda");

  env.elements.get("#complete-task").click();
  env.elements.get("#complete-task").click();
  env.elements.get("#snooze-task").click();
  assert.equal(env.elements.get("#complete-task").disabled, true);
  assert.equal(env.elements.get("#snooze-task").disabled, true);
  assert.equal(env.calls.filter((call) => call.operation === "POPUP_DONE").length, 1);
  const completeArgs = env.calls.find((call) => call.operation === "POPUP_DONE").args;
  assert.deepEqual(JSON.parse(JSON.stringify(completeArgs.expectedTask)), { id: "uid-1" });
  assert.match(completeArgs.day, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(completeArgs.heuristic, "Remaining Effort(1)");

  actionResponse.resolve(success({ message: "completed" }));
  await waitFor(() => env.calls.filter((call) => call.operation === "GET_AGENDA").length === 2, "agenda refresh after completion");
  await waitFor(() => !env.state().agendaLoading && !env.state().activeAction, "completed refresh");
  assert.match(env.elements.get("#popup-status").textContent, /Tarea completada\. Agenda actualizada\./);
  assert.match(env.elements.get("#urgent-task").textContent, /Call customer/);

  env.elements.get("#snooze-task").click();
  await waitFor(() => env.calls.some((call) => call.operation === "POPUP_SNOOZE"), "snooze action");
  await waitFor(() => env.calls.filter((call) => call.operation === "GET_AGENDA").length === 3, "agenda refresh after snooze");
  await waitFor(() => !env.state().agendaLoading && !env.state().activeAction, "snooze refresh");
  const snoozeArgs = env.calls.find((call) => call.operation === "POPUP_SNOOZE").args;
  assert.deepEqual(JSON.parse(JSON.stringify(snoozeArgs.expectedTask)), { id: "uid-2" });
  assert.match(snoozeArgs.day, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(snoozeArgs.heuristic, "Remaining Effort(1)");
  assert.equal(env.calls.filter((call) => call.operation === "POPUP_SNOOZE").length, 1);
  assert.match(env.elements.get("#popup-status").textContent, /Tarea pospuesta 5 minutos\. Agenda actualizada\./);
});

test("an action error stays uncertain and requires a successful manual agenda refresh before retry", async () => {
  const first = task("uid-error", "Check the build", "work");
  const env = bootPopup({
    respond: (operation) => {
      if (operation === "GET_AGENDA") return Promise.resolve(success({ active_urgent_tasks: [first] }));
      return Promise.resolve({ ok: false, status: null, error: { kind: "uncertain", message: "Respuesta perdida" } });
    },
  });
  await waitFor(() => env.calls.filter((call) => call.operation === "GET_AGENDA").length === 1 && !env.state().agendaLoading, "initial task");

  env.elements.get("#complete-task").click();
  await waitFor(() => !env.state().activeAction, "failed action handling");
  assert.equal(env.state().needsRefreshBeforeAction, true);
  assert.equal(env.elements.get("#complete-task").disabled, true);
  assert.equal(env.elements.get("#snooze-task").disabled, true);
  assert.match(env.elements.get("#popup-status").textContent, /No se pudo completar la acción/);
  assert.equal(env.calls.filter((call) => call.operation === "POPUP_DONE").length, 1);
  assert.equal(env.calls.filter((call) => call.operation === "GET_AGENDA").length, 1);

  env.elements.get("#refresh-agenda").click();
  await waitFor(() => env.calls.filter((call) => call.operation === "GET_AGENDA").length === 2, "manual refresh");
  await waitFor(() => !env.state().agendaLoading, "manual refresh completion");
  assert.equal(env.state().needsRefreshBeforeAction, false);
  assert.equal(env.elements.get("#complete-task").disabled, false);
  assert.equal(env.calls.filter((call) => call.operation === "POPUP_DONE").length, 1);
});

test("a successful mutation remains confirmed when the following agenda refresh fails", async () => {
  const visibleTask = task("uid-success", "Submit the report", "office");
  const env = bootPopup({
    respond: (operation, _args, calls) => {
      if (operation === "GET_AGENDA") {
        const getCount = calls.filter((call) => call.operation === "GET_AGENDA").length;
        return getCount === 1
          ? Promise.resolve(success({ active_urgent_tasks: [visibleTask] }))
          : Promise.resolve({ ok: false, status: null, error: { kind: "network", message: "Servidor no disponible" } });
      }
      return Promise.resolve(success({ message: "done" }));
    },
  });
  await waitFor(() => env.calls.filter((call) => call.operation === "GET_AGENDA").length === 1 && !env.state().agendaLoading, "initial agenda");
  env.elements.get("#complete-task").click();
  await waitFor(() => env.calls.filter((call) => call.operation === "GET_AGENDA").length === 2, "failed post-action agenda refresh");
  await waitFor(() => !env.state().agendaLoading && !env.state().activeAction, "post-action refresh failure handling");

  assert.match(env.elements.get("#popup-status").textContent, /Tarea completada\. No se pudo actualizar la agenda: No se pudo conectar con el servidor\./);
  assert.equal(env.calls.filter((call) => call.operation === "POPUP_DONE").length, 1);
  assert.equal(env.elements.get("#complete-task").disabled, true);
  assert.equal(env.elements.get("#snooze-task").disabled, true);
  assert.equal(env.elements.get("#refresh-agenda").disabled, false);
});

test("a failed mutation stays unverified when the manual refresh also fails", async () => {
  const env = bootPopup({
    respond: (operation, _args, calls) => {
      if (operation === "GET_AGENDA") {
        const getCount = calls.filter((call) => call.operation === "GET_AGENDA").length;
        return getCount === 1
          ? Promise.resolve(success({ active_urgent_tasks: [task("uid-uncertain", "Verify payment")] }))
          : Promise.resolve({ ok: false, status: null, error: { kind: "network", message: "Servidor no disponible" } });
      }
      return Promise.resolve({ ok: false, status: null, error: { kind: "uncertain", message: "Respuesta perdida" } });
    },
  });
  await waitFor(() => env.calls.filter((call) => call.operation === "GET_AGENDA").length === 1 && !env.state().agendaLoading, "initial task");

  env.elements.get("#complete-task").click();
  await waitFor(() => !env.state().activeAction, "uncertain action result");
  env.elements.get("#refresh-agenda").click();
  await waitFor(() => env.calls.filter((call) => call.operation === "GET_AGENDA").length === 2, "verification refresh");
  await waitFor(() => !env.state().agendaLoading, "failed verification refresh");

  assert.match(env.elements.get("#popup-status").textContent, /No se pudo verificar la acción anterior/);
  assert.equal(env.elements.get("#complete-task").disabled, true);
  assert.equal(env.elements.get("#snooze-task").disabled, true);
  assert.equal(env.calls.filter((call) => call.operation === "POPUP_DONE").length, 1);
});

test("a late agenda reply from an old connection cannot restore stale task data", async () => {
  const oldReply = deferred();
  const newReply = deferred();
  const env = bootPopup({
    respond: (operation, _args, calls) => {
      if (operation !== "GET_AGENDA") return Promise.resolve(success({}));
      const count = calls.filter((call) => call.operation === "GET_AGENDA").length;
      return count === 1 ? oldReply.promise : newReply.promise;
    },
  });
  await waitFor(() => env.calls.filter((call) => call.operation === "GET_AGENDA").length === 1, "old connection agenda request");
  env.changeSettings(readySettings({ serverUrl: "https://new-server.example.test/api/v1" }));
  assert.equal(env.calls.filter((call) => call.operation === "GET_AGENDA").length, 1, "storage changes do not fetch");
  assert.equal(env.elements.get("#refresh-agenda").disabled, false);
  assert.equal(env.elements.get("#complete-task").disabled, true);
  env.elements.get("#refresh-agenda").click();
  await waitFor(() => env.calls.filter((call) => call.operation === "GET_AGENDA").length === 2, "new connection agenda request");

  newReply.resolve(success({ active_urgent_tasks: [task("new-uid", "Current connection task")] }));
  await waitFor(() => env.elements.get("#urgent-task").textContent.includes("Current connection task"), "new task render");
  oldReply.resolve(success({ active_urgent_tasks: [task("old-uid", "Stale connection task")] }));
  await env.flush();

  assert.match(env.elements.get("#urgent-task").textContent, /Current connection task/);
  assert.doesNotMatch(env.elements.get("#urgent-task").textContent, /Stale connection task/);
  assert.equal(env.state().task.id, "new-uid");
});

test("disconnect invalidates pending agenda and mutation replies", async () => {
  const agendaReply = deferred();
  const actionReply = deferred();
  const env = bootPopup({
    respond: (operation, _args, calls) => {
      if (operation === "GET_AGENDA") {
        const getCount = calls.filter((call) => call.operation === "GET_AGENDA").length;
        return getCount === 1
          ? agendaReply.promise
          : Promise.resolve(success({ active_urgent_tasks: [task("uid-live", "Live task")] }));
      }
      return actionReply.promise;
    },
  });
  await waitFor(() => env.calls.filter((call) => call.operation === "GET_AGENDA").length === 1, "pending initial agenda");
  env.changeSettings({ ...readySettings(), monitorEnabled: false });
  agendaReply.resolve(success({ active_urgent_tasks: [task("uid-stale", "Stale task")] }));
  await env.flush();
  assert.match(env.elements.get("#popup-status").textContent, /desactivada|desconectado/i);
  assert.doesNotMatch(env.elements.get("#urgent-task").textContent, /Stale task/);
  assert.equal(env.elements.get("#complete-task").disabled, true);

  env.changeSettings(readySettings());
  assert.equal(env.calls.filter((call) => call.operation === "GET_AGENDA").length, 1, "reconnection does not fetch until refresh is clicked");
  assert.equal(env.elements.get("#refresh-agenda").disabled, false);
  assert.equal(env.elements.get("#complete-task").disabled, true);
  env.elements.get("#refresh-agenda").click();
  await waitFor(() => env.calls.filter((call) => call.operation === "GET_AGENDA").length === 2, "reconnected agenda");
  await waitFor(() => !env.state().agendaLoading, "reconnected task load");
  assert.match(env.elements.get("#urgent-task").textContent, /Live task/);
  env.elements.get("#complete-task").click();
  await waitFor(() => env.calls.some((call) => call.operation === "POPUP_DONE"), "pending completion");
  env.changeSettings({ ...readySettings(), monitorEnabled: false });
  actionReply.resolve(success({ message: "done" }));
  await env.flush();

  assert.match(env.elements.get("#popup-status").textContent, /desactivada|desconectado/i);
  assert.doesNotMatch(env.elements.get("#urgent-task").textContent, /Live task|completada/i);
  assert.equal(env.elements.get("#complete-task").disabled, true);
  assert.equal(env.calls.filter((call) => call.operation === "GET_AGENDA").length, 2);
});

test("transport errors show a safe accessible badge without inventing an HTTP status", async () => {
  const token = "private-token-value";
  const env = bootPopup({
    respond: () => Promise.resolve({
      ok: false,
      status: null,
      error: { kind: "tls", message: `TLS failure ${token}` },
    }),
  });

  await waitFor(() => env.state().stateLoaded && !env.state().agendaLoading, "TLS failure state");
  const badge = env.elements.get("#popup-error-badge");
  assert.equal(badge.hidden, false);
  assert.equal(badge.textContent, "!");
  assert.match(badge.title, /conexión TLS segura/i);
  assert.equal(badge.attributes.get("aria-label"), badge.title);
  assert.doesNotMatch(`${badge.title} ${env.elements.get("#popup-status").textContent}`, new RegExp(token));
  assert.doesNotMatch(badge.title, /HTTP/);
});

test("the popup shows a real HTTP status and clears its badge after a successful refresh", async () => {
  let failing = true;
  const env = bootPopup({
    respond: (operation) => {
      if (operation !== "GET_AGENDA") return Promise.resolve(success({}));
      return Promise.resolve(failing
        ? { ok: false, status: 503, error: { kind: "http", status: 503, message: "private backend detail" } }
        : success({ active_urgent_tasks: [] }));
    },
  });

  await waitFor(() => env.state().stateLoaded && !env.state().agendaLoading, "HTTP failure state");
  const badge = env.elements.get("#popup-error-badge");
  assert.match(badge.title, /HTTP 503/);
  assert.doesNotMatch(badge.title, /private backend detail/);

  failing = false;
  env.elements.get("#refresh-agenda").click();
  await waitFor(() => !env.state().agendaLoading && badge.hidden, "successful refresh to clear badge");
  assert.equal(badge.title, "");
  assert.equal(badge.attributes.has("aria-label"), false);
});

test("opening the manager reports a safe accessible status without changing popup task or history", async () => {
  const opening = deferred();
  let attempts = 0;
  const token = "private-manager-error-token";
  const env = bootPopup({
    initialState: {
      settings: readySettings(),
      history: [],
      notificationReception: null,
      notificationError: "",
      gatewayError: null,
    },
    managerOpen: () => {
      attempts += 1;
      return attempts === 1
        ? Promise.reject(Object.assign(new Error(token), {kind: "network"}))
        : Promise.resolve(success({opened: true, reused: true}));
    },
  });
  await waitFor(() => env.state().stateLoaded && !env.state().agendaLoading, "popup ready before manager open");

  const managerButton = env.elements.get("#open-manager");
  const managerStatus = env.elements.get("#manager-open-status");
  const popupStatus = env.elements.get("#popup-status").textContent;
  const taskText = env.elements.get("#urgent-task").textContent;
  const historyText = env.elements.get("#popup-notification-list").textContent;

  managerButton.click();
  await waitFor(() => env.state().managerOpenState === "error", "safe manager-open error");
  assert.equal(managerButton.disabled, false, "the button is available for a retry after failure");
  assert.equal(managerButton.textContent, "Reintentar");
  assert.equal(managerStatus.dataset.state, "error");
  assert.equal(managerStatus.textContent, "No se pudo abrir el gestor. Inténtalo de nuevo.");
  assert.doesNotMatch(managerStatus.textContent, new RegExp(token));
  assert.equal(env.elements.get("#popup-status").textContent, popupStatus);
  assert.equal(env.elements.get("#urgent-task").textContent, taskText);
  assert.equal(env.elements.get("#popup-notification-list").textContent, historyText);

  managerButton.click();
  await waitFor(() => env.state().managerOpenState === "opened", "manager-open retry succeeds");
  assert.equal(attempts, 2);
  assert.equal(managerStatus.dataset.state, "opened");
  assert.equal(managerStatus.textContent, "Se activó el gestor que ya estaba abierto.");
  assert.equal(managerButton.disabled, false);
  assert.deepEqual(env.calls.filter((call) => call.operation === "manager.open"), [
    {operation: "manager.open", target: null, parameters: {}},
    {operation: "manager.open", target: null, parameters: {}},
  ]);
});

test("opening the manager disables only its button while the shared open request is pending", async () => {
  const opening = deferred();
  let calls = 0;
  const env = bootPopup({
    managerOpen: () => {
      calls += 1;
      return opening.promise;
    },
  });
  await waitFor(() => env.state().stateLoaded && !env.state().agendaLoading, "popup ready before manager open");

  const managerButton = env.elements.get("#open-manager");
  managerButton.click();
  assert.equal(managerButton.disabled, true);
  assert.equal(env.elements.get("#refresh-agenda").disabled, false);
  assert.equal(env.elements.get("#complete-task").disabled, false);
  assert.equal(env.elements.get("#snooze-task").disabled, false);
  assert.equal(env.elements.get("#manager-open-status").dataset.state, "opening");
  assert.equal(env.elements.get("#manager-open-status").textContent, "Abriendo el gestor…");
  managerButton.click();
  assert.equal(calls, 1, "a pending request cannot be started twice from the popup");

  opening.resolve(success({opened: true, reused: false}));
  await waitFor(() => env.state().managerOpenState === "opened", "new manager tab opened");
  assert.equal(managerButton.disabled, false);
  assert.equal(env.elements.get("#manager-open-status").textContent, "Se abrió el gestor en una pestaña nueva.");
});

test("notification history is rendered and cleared locally while disconnected", async () => {
  const historyId = "4d217360-5d69-47c9-bcc3-5a4d76cf1b32";
  const endpointKey = "https://tasks.example.test/team/api/v1";
  const entry = {
    endpointKey,
    id: `${historyId}:5`,
    historyId,
    sequence: 5,
    timestamp: "2026-10-05T09:00:00+02:00",
    text: "<img src=x onerror=alert(1)> aviso recibido",
  };
  const reception = {
    schemaVersion: 1,
    endpointKey,
    historyId,
    lastReceivedSequence: 5,
    buffer: [entry],
    bufferGeneration: 3,
    continuity: {
      discardedThrough: 4,
      missedRanges: [{ fromSequence: 3, throughSequence: 4 }],
      gapsTruncated: false,
      localTruncated: true,
    },
  };
  const env = bootPopup({
    initialSettings: readySettings({ monitorEnabled: false }),
    initialState: {
      settings: readySettings({ monitorEnabled: false }),
      history: [],
      notificationReception: reception,
      notificationError: "",
      gatewayError: null,
    },
  });
  await waitFor(() => env.state().stateLoaded, "local notification history");

  const list = env.elements.get("#popup-notification-list");
  assert.equal(env.calls.length, 0, "rendering the saved history never contacts the server");
  assert.equal(env.elements.get("#popup-clear-history").disabled, false);
  assert.equal(list.children.length, 1);
  assert.equal(list.children[0].dataset.notificationId, `${historyId}:5`);
  assert.equal(list.children[0].dataset.historyId, historyId);
  assert.equal(list.children[0].dataset.sequence, "5");
  assert.match(list.textContent, /<img src=x onerror=alert\(1\)> aviso recibido/);
  assert.equal(list.children[0].children[0].children.length, 0, "notification text is assigned as text, not parsed markup");
  assert.match(env.elements.get("#popup-notification-continuity").textContent, /número 4/);
  assert.match(env.elements.get("#popup-notification-continuity").textContent, /número 3 al 4/);
  assert.match(env.elements.get("#popup-notification-continuity").textContent, /límite/);

  env.elements.get("#popup-clear-history").click();
  await waitFor(() => env.clearCalls.length === 1 && list.children.length === 1 && list.children[0].className.includes("empty"), "local notification clear");
  assert.deepEqual(env.clearCalls, [{ operation: "notifications.clear-local" }]);
  assert.equal(env.calls.length, 0, "clearing the local copy never contacts the server");
  assert.equal(env.state().notificationReception.buffer.length, 0);
  assert.equal(env.state().notificationReception.historyId, historyId);
  assert.equal(env.state().notificationReception.lastReceivedSequence, 5);
  assert.equal(env.state().notificationReception.bufferGeneration, 4);
  assert.equal(env.state().notificationReception.continuity.localTruncated, false);
  assert.equal(env.elements.get("#popup-clear-history").disabled, true);
});

test("a local notification update during initial storage hydration is not overwritten by the older snapshot", async () => {
  const initialRead = deferred();
  const historyId = "a5d5c365-cf9d-4b45-8612-a97448358dc1";
  const endpointKey = "https://tasks.example.test/api/v1";
  const currentReception = {
    schemaVersion: 1,
    endpointKey,
    historyId,
    lastReceivedSequence: 1,
    buffer: [{ endpointKey, id: `${historyId}:1`, historyId, sequence: 1, timestamp: "2026-10-05T10:00:00Z", text: "current local notice" }],
    bufferGeneration: 0,
    continuity: { discardedThrough: 0, missedRanges: [], gapsTruncated: false, localTruncated: false },
  };
  const env = bootPopup({
    initialState: { settings: readySettings(), history: [], notificationReception: null, notificationError: "", gatewayError: null },
    initialStatePromise: initialRead.promise,
    respond: (operation) => operation === "GET_AGENDA"
      ? Promise.resolve(success({ active_urgent_tasks: [] }))
      : undefined,
  });

  env.storageChanged({ "notificationReception.v1": { newValue: currentReception } });
  await env.flush();
  assert.equal(env.state().notificationReception.historyId, historyId);
  assert.equal(env.elements.get("#popup-notification-list").textContent.includes("current local notice"), true);

  initialRead.resolve({ settings: readySettings(), history: [], notificationReception: null, notificationError: "", gatewayError: null });
  await env.flush();

  assert.equal(env.state().stateLoaded, true);
  assert.equal(env.state().settings.monitorEnabled, true);
  assert.equal(env.state().notificationReception.historyId, historyId);
  assert.equal(env.elements.get("#popup-notification-list").textContent.includes("current local notice"), true);
  assert.ok(env.calls.some((call) => call.operation === "root.read"), "the hydrated connection can still start its agenda read");
});


test("popup focus and visibility do not reload its remote agenda", async () => {
  const env = bootPopup({
    respond: operation => operation === "GET_AGENDA"
      ? Promise.resolve(success({ active_urgent_tasks: [task("task-1")] }))
      : Promise.resolve(success({})),
  });
  await env.flush();
  const reads = env.calls.length;
  env.focus();
  env.visible();
  await env.flush();
  assert.equal(env.calls.length, reads);
  env.elements.get("#refresh-agenda").click();
  await env.flush();
  assert.ok(env.calls.length > reads);
});
