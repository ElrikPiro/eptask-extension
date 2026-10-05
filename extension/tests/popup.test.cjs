const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { extensionRoot } = require("./helpers.cjs");

const popupPath = path.join(extensionRoot, "js/popup.js");
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
  }),
  refreshUrgentTask,
  performTaskAction,
};
`;

const readySettings = (overrides = {}) => ({
  schemaVersion: 1,
  serverUrl: "http://tasks.example.test/api",
  token: "test-token",
  monitorEnabled: true,
  ...overrides,
});

function task(id, description = `Task ${id}`, context = "work") {
  return {
    id,
    description,
    context,
    due: "2026-10-02",
    status: "pending",
    total_cost: 1.25,
  };
}

function success(data) {
  return { ok: true, data };
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

function bootPopup({ initialSettings = readySettings(), respond } = {}) {
  const selectors = [
    "#popup-status", "#urgent-task", "#open-options", "#open-manager",
    "#refresh-agenda", "#complete-task", "#snooze-task", "#popup-error-badge",
  ];
  const elements = new Map(selectors.map((selector) => [selector, new FakeElement() ]));
  for (const selector of ["#refresh-agenda", "#complete-task", "#snooze-task"]) {
    elements.get(selector).disabled = true;
  }

  const calls = [];
  let storageListener = null;
  const statePromise = Promise.resolve({ settings: initialSettings, history: [], monitorStatus: null });
  const document = {
    querySelector(selector) {
      const element = elements.get(selector);
      if (!element) throw new Error(`Unexpected selector ${selector}`);
      return element;
    },
    createElement(tagName) {
      return new FakeElement(tagName);
    },
  };
  const node = (tagName, text = "", className = "") => {
    const element = document.createElement(tagName);
    if (text !== null && text !== undefined) element.textContent = String(text);
    if (className) element.className = className;
    return element;
  };
  const sandbox = {
    document,
    Error,
    Promise,
    browserApi: {
      runtime: {
        openOptionsPage: async () => undefined,
        getURL: (relativePath) => `moz-extension://test/${relativePath}`,
      },
      tabs: { create: async () => ({ id: 1 }) },
    },
    gatewayCall(operation, args = {}) {
      calls.push({ operation, args });
      if (respond) return respond(operation, args, calls);
      if (operation === "GET_AGENDA") return Promise.resolve(success({ active_urgent_tasks: [task("task-1")] }));
      return Promise.resolve(success({ message: "ok" }));
    },
    assertSuccessfulReply(reply) {
      if (reply?.ok === true) return reply;
      const error = new Error(reply?.error?.message || "La operación no se pudo completar.");
      error.kind = typeof reply?.error?.kind === "string" ? reply.error.kind : "gateway-unavailable";
      error.status = Number.isInteger(reply?.status) ? reply.status : null;
      throw error;
    },
    isReady(settings) {
      return Boolean(
        settings && settings.monitorEnabled === true &&
        typeof settings.serverUrl === "string" && settings.serverUrl.trim() &&
        typeof settings.token === "string" && settings.token.trim(),
      );
    },
    readExtensionState: () => statePromise,
    subscribeStorageChanges(listener) {
      storageListener = listener;
      return () => {};
    },
  };
  sandbox.node = node;
  const context = vm.createContext(sandbox);
  vm.runInContext(popupSource, context, { filename: popupPath, timeout: 2_000 });

  return {
    calls,
    elements,
    state: () => context.__popupTest.getState(),
    changeSettings(settings) {
      storageListener({ "settings.v1": { newValue: settings } });
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

  await waitFor(() => env.calls.length === 1 && !env.state().agendaLoading, "initial agenda");
  assert.deepEqual(env.calls.map(({ operation }) => operation), ["GET_AGENDA"]);
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
            totalCost: { value: "5", unit: "pomodoro" },
            investedEffort: { value: "2", unit: "pomodoro" },
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
    total_cost: 3,
  });
  assert.doesNotMatch(env.elements.get("#urgent-task").textContent, /https:\/\//);
  assert.match(env.elements.get("#urgent-task").textContent, /3\.00p/);
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
  await waitFor(() => env.calls.length === 1 && !env.state().agendaLoading, "empty agenda");
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
  await waitFor(() => env.calls.length === 1 && !env.state().agendaLoading, "first agenda");

  env.elements.get("#complete-task").click();
  env.elements.get("#complete-task").click();
  env.elements.get("#snooze-task").click();
  assert.equal(env.elements.get("#complete-task").disabled, true);
  assert.equal(env.elements.get("#snooze-task").disabled, true);
  assert.equal(env.calls.filter((call) => call.operation === "POPUP_DONE").length, 1);
  assert.deepEqual(
    JSON.parse(JSON.stringify(env.calls.find((call) => call.operation === "POPUP_DONE").args)),
    { expectedTask: { id: "uid-1", description: "Prepare report", context: "office" } },
  );

  actionResponse.resolve(success({ message: "completed" }));
  await waitFor(() => env.calls.filter((call) => call.operation === "GET_AGENDA").length === 2, "agenda refresh after completion");
  await waitFor(() => !env.state().agendaLoading && !env.state().activeAction, "completed refresh");
  assert.match(env.elements.get("#popup-status").textContent, /Tarea completada\. Agenda actualizada\./);
  assert.match(env.elements.get("#urgent-task").textContent, /Call customer/);

  env.elements.get("#snooze-task").click();
  await waitFor(() => env.calls.some((call) => call.operation === "POPUP_SNOOZE"), "snooze action");
  await waitFor(() => env.calls.filter((call) => call.operation === "GET_AGENDA").length === 3, "agenda refresh after snooze");
  await waitFor(() => !env.state().agendaLoading && !env.state().activeAction, "snooze refresh");
  assert.deepEqual(
    JSON.parse(JSON.stringify(env.calls.find((call) => call.operation === "POPUP_SNOOZE").args)),
    { expectedTask: { id: "uid-2", description: "Call customer", context: "phone" } },
  );
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
  await waitFor(() => env.calls.length === 1 && !env.state().agendaLoading, "initial task");

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
  await waitFor(() => env.calls.length === 1 && !env.state().agendaLoading, "initial agenda");
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
  await waitFor(() => env.calls.length === 1 && !env.state().agendaLoading, "initial task");

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
  await waitFor(() => env.calls.length === 1, "old connection agenda request");
  env.changeSettings(readySettings({ serverUrl: "http://new-server.example.test/api" }));
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
  await waitFor(() => env.calls.length === 1, "pending initial agenda");
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
