const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { FakeFormData, flushMicrotasks, loadExtensionDocument } = require("./manager-dom.cjs");
const { extensionRoot } = require("./helpers.cjs");

const managerPath = path.join(extensionRoot, "js/app.js");

function eventSlot() {
  const listeners = new Set();
  return {
    addListener(listener) { listeners.add(listener); },
    removeListener(listener) { listeners.delete(listener); },
    fire(...args) { for (const listener of [...listeners]) listener(...args); },
    get listeners() { return [...listeners]; },
  };
}

function namedBindings(specification) {
  return specification.split(",").map((part) => part.trim()).filter(Boolean).map((binding) => {
    const alias = binding.match(/^([\w$]+)\s+as\s+([\w$]+)$/);
    return alias ? `${alias[1]}: ${alias[2]}` : binding;
  }).join(", ");
}

function compileModule(source, moduleId, modules) {
  const exported = [];
  let transformed = source.replace(/^\s*import\s*\{([\s\S]*?)\}\s*from\s*["']([^"']+)["'];\s*$/gm, (_statement, bindings, dependency) => {
    const normalized = namedBindings(bindings.replace(/\s+/g, " ").trim());
    return `const { ${normalized} } = globalThis.__testModules[${JSON.stringify(dependency)}];`;
  });
  transformed = transformed.replace(/^\s*import\s+([\w$]+)\s+from\s*["']([^"']+)["'];\s*$/gm, (_statement, binding, dependency) => {
    return `const ${binding} = globalThis.__testModules[${JSON.stringify(dependency)}].default;`;
  });
  for (const match of transformed.matchAll(/^export\s+(?:async\s+)?(?:function|class|const|let|var)\s+([\w$]+)/gm)) exported.push(match[1]);
  transformed = transformed.replace(/^export\s+/gm, "");
  const returnValue = exported.length ? `return { ${exported.join(", ")} };` : "return {};";
  return `(function(){\n${transformed}\n${returnValue}\n})()`;
}

function bootManager({ readGateway, submitOperation, initialSettings, initialState = null, initialStatePromise = null, ready = true, focusTarget = null } = {}) {
  const document = loadExtensionDocument();
  document.visibilityState = "visible";
  const reads = [];
  const writes = [];
  const clearCalls = [];
  const readListeners = new Set();
  const changeListeners = new Set();
  const storageListeners = new Set();
  const browserEvents = { focus: eventSlot(), blur: eventSlot(), visibilitychange: eventSlot() };
  const currentSettings = initialSettings ?? {
    schemaVersion: 1,
    serverUrl: "https://tasks.example.test/team/api/v1",
    token: "test-token",
    monitorEnabled: true,
    timeoutMs: 30_000,
  };
  let localState = initialState || { settings: currentSettings, history: [], notificationReception: null, notificationError: "", monitorStatus: null, gatewayError: null };
  const statePromise = initialStatePromise || Promise.resolve(localState);
  let initialReadPending = Boolean(initialStatePromise);
  const browserApi = {
    runtime: {
      id: "test-extension-id",
      getURL: (relative) => `moz-extension://fixture/${relative}`,
      openOptionsPage: async () => undefined,
      onMessage: eventSlot(),
    },
    tabs: { create: async (properties) => ({ id: 1, ...properties }) },
  };

  const gateway = {
    async readGateway(operation, target = null, parameters = {}) {
      const call = { operation, target, parameters: structuredClone(parameters) };
      reads.push(call);
      const data = readGateway ? await readGateway(operation, target, parameters, reads.length) : {};
      return { requestId: `read-${reads.length}`, ok: true, status: 200, data, error: null };
    },
    async submitOperation(type, target, parameters = {}) {
      const call = { type, target: structuredClone(target), parameters: structuredClone(parameters) };
      writes.push(call);
      const data = submitOperation
        ? await submitOperation(type, target, parameters, writes.length)
        : { id: `operation-${writes.length}`, status: "succeeded", type, target, result: { effectsState: "complete", affectedIds: target?.id ? [target.id] : [] }, failure: null };
      return { requestId: `write-${writes.length}`, ok: true, status: 201, data, error: null };
    },
    subscribeChanges(listener) {
      changeListeners.add(listener);
      return () => changeListeners.delete(listener);
    },
  };

  const storage = {
    isReady(settings) { return ready && Boolean(settings?.serverUrl && settings?.token && settings?.monitorEnabled); },
    async readExtensionState() {
      if (initialReadPending) {
        initialReadPending = false;
        return statePromise;
      }
      return localState;
    },
    subscribeStorageChanges(listener) {
      storageListeners.add(listener);
      return () => storageListeners.delete(listener);
    },
  };
  const testModules = {
    "./browser-api.js": { browserApi },
    "./messages.js": {
      ...gateway,
      gatewayCall: async (operation, args) => gateway.readGateway(operation, args?.target, args),
      assertSuccessfulReply: (reply) => {
        if (reply?.ok === true) return reply;
        const error = new Error(reply?.error?.message || "Gateway request failed");
        error.kind = reply?.error?.kind || "gateway-unavailable";
        error.status = reply?.status ?? null;
        throw error;
      },
      clearNotificationBuffer: async () => {
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
        return { requestId: "clear", ok: true, status: null, data: { cleared: true, bufferGeneration }, error: null };
      },
    },
    "./storage-view.js": storage,
  };
  const sandbox = {
    document,
    window: {
      addEventListener(type, listener) { browserEvents[type]?.addListener(listener); },
      removeEventListener(type, listener) { browserEvents[type]?.removeListener(listener); },
      focus() { browserEvents.focus.fire(); },
      blur() { browserEvents.blur.fire(); },
    },
    browserApi,
    URL,
    URLSearchParams,
    FormData: FakeFormData,
    requestAnimationFrame: (callback) => setTimeout(callback, 0),
    cancelAnimationFrame: clearTimeout,
    Date,
    Math,
    JSON,
    Object,
    Array,
    Set,
    Map,
    Number,
    String,
    Boolean,
    Promise,
    Error,
    TypeError,
    console: { log() {}, warn() {}, error() {} },
    setTimeout,
    clearTimeout,
    setInterval: () => 1,
    clearInterval() {},
    structuredClone,
    __testModules: testModules,
  };
  sandbox.globalThis = sandbox;
  const context = vm.createContext(sandbox);

  const renderPath = path.join(extensionRoot, "js/render.js");
  if (fs.existsSync(renderPath)) {
    const renderSource = fs.readFileSync(renderPath, "utf8");
    testModules["./render.js"] = vm.runInContext(compileModule(renderSource, "./render.js", testModules), context, { filename: renderPath, timeout: 2_000 });
  }

  const source = fs.readFileSync(managerPath, "utf8");
  vm.runInContext(compileModule(source, "./app.js", testModules), context, { filename: managerPath, timeout: 2_000 });

  if (focusTarget) browserEvents.focus.fire({ target: focusTarget });

  return {
    document,
    reads,
    writes,
    clearCalls,
    context,
    get stateLoaded() { return reads.length > 0; },
    async flush(rounds = 8) {
      for (let index = 0; index < rounds; index += 1) await flushMicrotasks();
    },
    invalidate(changes = { taskIds: [], projectNames: [], eventNames: [], collections: ["tasks"] }) {
      for (const listener of [...changeListeners]) listener(changes);
    },
    focus() {
      browserEvents.focus.fire();
    },
    storageChanged(changes = {}) {
      if (changes["notificationReception.v1"]) {
        localState = { ...localState, notificationReception: changes["notificationReception.v1"].newValue };
      }
      if (changes["notificationHistory.v1"]) {
        localState = { ...localState, history: changes["notificationHistory.v1"].newValue };
      }
      for (const listener of [...storageListeners]) listener(changes);
    },
    readListeners,
  };
}

module.exports = { bootManager };
