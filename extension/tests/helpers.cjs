const fs = require("node:fs");
const path = require("node:path");

const extensionRoot = path.resolve(__dirname, "..");

function clone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function createEvent() {
  const listeners = [];
  return {
    addListener(listener) {
      listeners.push(listener);
    },
    removeListener(listener) {
      const index = listeners.indexOf(listener);
      if (index >= 0) listeners.splice(index, 1);
    },
    get listeners() {
      return [...listeners];
    },
    fire(...args) {
      return listeners.map((listener) => listener(...args));
    },
  };
}

function response(body, status = 200, contentType = "application/json") {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "HTTP response",
    headers: { get: (name) => name.toLowerCase() === "content-type" ? contentType : null },
    text: async () => text,
  };
}

function createApi({ mode = "browser", initialStorage = {}, extensionId = "elrikpiro-extension@test", extensionOrigin, initialPermissions = [], permissionRequestResult = true, permissionContains, supportsBadgeTextColor = true, failBadgeTextColor = false, initialTabs = [], initialWindows = [{ id: 1, focused: true, state: "normal" }] } = {}) {
  const changes = createEvent();
  const localData = clone(initialStorage) || {};
  const allowedPermissions = new Set(initialPermissions);
  const permissionCalls = [];
  const storageWrites = [];
  const timeline = [];
  const alarmData = new Map();
  const alarmCreates = [];
  const notificationCalls = [];
  const runtimeMessages = [];
  const badgeState = { text: "", textColor: null, backgroundColor: null, title: "ElrikPiro" };
  const actionCalls = [];
  const tabCalls = [];
  const windowCalls = [];
  const extensionBase = extensionOrigin || (mode === "browser"
    ? "moz-extension://a1b2c3d4-e5f6-4789-8abc-1234567890ab"
    : `chrome-extension://${extensionId}`);
  const runtime = {
    id: extensionId,
    lastError: null,
    onMessage: createEvent(),
    onInstalled: createEvent(),
    onStartup: createEvent(),
    getURL: (relativePath) => `${extensionBase}/${relativePath}`,
    openOptionsPage: callbackMethod(async () => undefined, mode),
    sendMessage: callbackMethod(async (message) => {
      runtimeMessages.push(clone(message));
      return undefined;
    }, mode),
  };

  const local = {
    get(keys, callback) {
      const result = {};
      if (keys == null) {
        Object.assign(result, clone(localData));
      } else if (typeof keys === "string") {
        if (Object.hasOwn(localData, keys)) result[keys] = clone(localData[keys]);
      } else if (Array.isArray(keys)) {
        for (const key of keys) if (Object.hasOwn(localData, key)) result[key] = clone(localData[key]);
      } else if (typeof keys === "object") {
        for (const [key, defaultValue] of Object.entries(keys)) {
          result[key] = Object.hasOwn(localData, key) ? clone(localData[key]) : clone(defaultValue);
        }
      }
      return callbackMethod(async () => result, mode)(callback);
    },
    set(items, callback) {
      const delta = {};
      for (const [key, value] of Object.entries(items)) {
        delta[key] = { oldValue: clone(localData[key]), newValue: clone(value) };
        localData[key] = clone(value);
      }
      storageWrites.push(clone(items));
      timeline.push({ type: "storage.set", items: clone(items) });
      if (Object.keys(delta).length) changes.fire(delta, "local");
      return callbackMethod(async () => undefined, mode)(callback);
    },
    remove(keys, callback) {
      const names = Array.isArray(keys) ? keys : [keys];
      const delta = {};
      for (const key of names) {
        if (Object.hasOwn(localData, key)) {
          delta[key] = { oldValue: clone(localData[key]) };
          delete localData[key];
        }
      }
      if (Object.keys(delta).length) changes.fire(delta, "local");
      return callbackMethod(async () => undefined, mode)(callback);
    },
    clear(callback) {
      const delta = {};
      for (const [key, value] of Object.entries(localData)) delta[key] = { oldValue: clone(value) };
      for (const key of Object.keys(localData)) delete localData[key];
      if (Object.keys(delta).length) changes.fire(delta, "local");
      return callbackMethod(async () => undefined, mode)(callback);
    },
  };

  const alarms = {
    onAlarm: createEvent(),
    get(name, callback) {
      return callbackMethod(async () => clone(alarmData.get(name) || null), mode)(callback);
    },
    create(name, info) {
      alarmCreates.push({ name, info: clone(info) });
      if (info && Number.isFinite(info.periodInMinutes)) {
        alarmData.set(name, { name, scheduledTime: Date.now() + info.periodInMinutes * 60_000, periodInMinutes: info.periodInMinutes });
      }
      return mode === "browser" ? Promise.resolve() : undefined;
    },
  };

  const notifications = {
    create(id, options, callback) {
      notificationCalls.push({ id, options: clone(options) });
      timeline.push({ type: "notification.create", id, options: clone(options) });
      if (typeof callback === "function") callback(id);
      return mode === "browser" ? Promise.resolve(id) : undefined;
    },
    clear(id, callback) {
      if (callback) callback(true);
      return mode === "browser" ? Promise.resolve(true) : undefined;
    },
  };

  const action = {
    setBadgeText(details, callback) {
      badgeState.text = details.text;
      actionCalls.push({ method: "setBadgeText", details: clone(details) });
      timeline.push({ type: "action.setBadgeText", details: clone(details) });
      if (callback) callback();
      return mode === "browser" ? Promise.resolve() : undefined;
    },
    setBadgeBackgroundColor(details, callback) {
      badgeState.backgroundColor = clone(details.color);
      actionCalls.push({ method: "setBadgeBackgroundColor", details: clone(details) });
      timeline.push({ type: "action.setBadgeBackgroundColor", details: clone(details) });
      if (callback) callback();
      return mode === "browser" ? Promise.resolve() : undefined;
    },
    setTitle(details, callback) {
      badgeState.title = details.title;
      actionCalls.push({ method: "setTitle", details: clone(details) });
      timeline.push({ type: "action.setTitle", details: clone(details) });
      if (callback) callback();
      return mode === "browser" ? Promise.resolve() : undefined;
    },
  };
  if (supportsBadgeTextColor) {
    action.setBadgeTextColor = function (details, callback) {
      actionCalls.push({ method: "setBadgeTextColor", details: clone(details) });
      timeline.push({ type: "action.setBadgeTextColor", details: clone(details) });
      if (failBadgeTextColor) {
        if (callback) {
          runtime.lastError = { message: "Badge text color is unavailable" };
          callback();
          runtime.lastError = null;
          return undefined;
        }
        return Promise.reject(new Error("Badge text color is unavailable"));
      }
      badgeState.textColor = clone(details.color);
      if (callback) callback();
      return mode === "browser" ? Promise.resolve() : undefined;
    };
  }

  const tabsState = clone(initialTabs) || [];
  const windowsState = clone(initialWindows) || [];
  const tabEvents = {
    onActivated: createEvent(),
    onUpdated: createEvent(),
    onRemoved: createEvent(),
    onCreated: createEvent(),
  };
  const windowEvents = { onFocusChanged: createEvent(), onRemoved: createEvent() };
  const focusedWindow = () => windowsState.find((window) => window.focused) || windowsState[0];
  const nextTabId = () => Math.max(0, ...tabsState.map((tab) => Number.isInteger(tab.id) ? tab.id : 0)) + 1;
  const tabs = {
    ...tabEvents,
    query: callbackMethod(async (queryInfo = {}) => {
      tabCalls.push({ method: "query", queryInfo: clone(queryInfo) });
      timeline.push({ type: "tabs.query", queryInfo: clone(queryInfo) });
      return tabsState.filter((tab) => {
        if (queryInfo.windowId !== undefined && tab.windowId !== queryInfo.windowId) return false;
        if (queryInfo.active !== undefined && tab.active !== queryInfo.active) return false;
        if (queryInfo.url !== undefined) {
          const patterns = Array.isArray(queryInfo.url) ? queryInfo.url : [queryInfo.url];
          if (!patterns.some((pattern) => {
            const escaped = String(pattern).split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*");
            return new RegExp(`^${escaped}$`).test(tab.url || "");
          })) return false;
        }
        return true;
      }).map(clone);
    }, mode),
    get: callbackMethod(async (tabId) => {
      tabCalls.push({ method: "get", tabId });
      timeline.push({ type: "tabs.get", tabId });
      return clone(tabsState.find((tab) => tab.id === tabId) || null);
    }, mode),
    update: callbackMethod(async (tabId, properties = {}) => {
      tabCalls.push({ method: "update", tabId, properties: clone(properties) });
      timeline.push({ type: "tabs.update", tabId, properties: clone(properties) });
      const tab = tabsState.find((item) => item.id === tabId);
      if (!tab) return null;
      if (properties.active === true) {
        for (const item of tabsState) if (item.windowId === tab.windowId) item.active = item.id === tab.id;
      }
      Object.assign(tab, clone(properties));
      tabEvents.onUpdated.fire(tabId, clone(properties), clone(tab));
      if (properties.active === true) tabEvents.onActivated.fire({ tabId, windowId: tab.windowId });
      return clone(tab);
    }, mode),
    create: callbackMethod(async (properties = {}) => {
      const window = windowsState.find((item) => item.id === properties.windowId) || focusedWindow();
      const windowId = properties.windowId ?? window?.id ?? 1;
      const tab = { id: nextTabId(), windowId, active: properties.active !== false, ...clone(properties) };
      if (tab.active) for (const item of tabsState) if (item.windowId === windowId) item.active = false;
      tabsState.push(tab);
      tabCalls.push({ method: "create", properties: clone(properties), result: clone(tab) });
      timeline.push({ type: "tabs.create", properties: clone(properties), result: clone(tab) });
      tabEvents.onCreated.fire(clone(tab));
      if (tab.active) tabEvents.onActivated.fire({ tabId: tab.id, windowId });
      return clone(tab);
    }, mode),
  };
  const windows = {
    ...windowEvents,
    get: callbackMethod(async (windowId, getInfo = {}) => {
      windowCalls.push({ method: "get", windowId, getInfo: clone(getInfo) });
      timeline.push({ type: "windows.get", windowId, getInfo: clone(getInfo) });
      const window = windowsState.find((item) => item.id === windowId);
      if (!window) return null;
      const result = clone(window);
      if (getInfo.populate) result.tabs = tabsState.filter((tab) => tab.windowId === windowId).map(clone);
      return result;
    }, mode),
    getAll: callbackMethod(async (getInfo = {}) => {
      windowCalls.push({ method: "getAll", getInfo: clone(getInfo) });
      timeline.push({ type: "windows.getAll", getInfo: clone(getInfo) });
      return windowsState.map((window) => {
        const result = clone(window);
        if (getInfo.populate) result.tabs = tabsState.filter((tab) => tab.windowId === window.id).map(clone);
        return result;
      });
    }, mode),
    getLastFocused: callbackMethod(async (getInfo = {}) => {
      windowCalls.push({ method: "getLastFocused", getInfo: clone(getInfo) });
      timeline.push({ type: "windows.getLastFocused", getInfo: clone(getInfo) });
      const window = focusedWindow();
      if (!window) return null;
      const result = clone(window);
      if (getInfo.populate) result.tabs = tabsState.filter((tab) => tab.windowId === window.id).map(clone);
      return result;
    }, mode),
    update: callbackMethod(async (windowId, properties = {}) => {
      windowCalls.push({ method: "update", windowId, properties: clone(properties) });
      timeline.push({ type: "windows.update", windowId, properties: clone(properties) });
      const window = windowsState.find((item) => item.id === windowId);
      if (!window) return null;
      if (properties.focused === true) {
        for (const item of windowsState) item.focused = item.id === windowId;
      }
      Object.assign(window, clone(properties));
      windowEvents.onFocusChanged.fire(window.focused ? windowId : -1);
      return clone(window);
    }, mode),
  };

  const permissions = {
    request(details, callback) {
      const normalized = clone(details);
      permissionCalls.push({ method: "request", details: normalized });
      timeline.push({ type: "permissions.request", details: normalized });
      return callbackMethod(async () => {
        const granted = typeof permissionRequestResult === "function"
          ? await permissionRequestResult(normalized)
          : permissionRequestResult;
        if (granted === true) for (const origin of normalized.origins || []) allowedPermissions.add(origin);
        return granted === true;
      }, mode)(callback);
    },
    contains(details, callback) {
      const normalized = clone(details);
      permissionCalls.push({ method: "contains", details: normalized });
      timeline.push({ type: "permissions.contains", details: normalized });
      return callbackMethod(async () => {
        if (permissionContains) return permissionContains(normalized, allowedPermissions);
        return (normalized.origins || []).every((origin) => allowedPermissions.has(origin) || allowedPermissions.has("https://*/*"));
      }, mode)(callback);
    },
    remove(details, callback) {
      const normalized = clone(details);
      permissionCalls.push({ method: "remove", details: normalized });
      timeline.push({ type: "permissions.remove", details: normalized });
      return callbackMethod(async () => {
        let removed = false;
        for (const origin of normalized.origins || []) removed = allowedPermissions.delete(origin) || removed;
        return removed;
      }, mode)(callback);
    },
  };

  return {
    namespace: { runtime, storage: { local, onChanged: changes }, alarms, notifications, tabs, windows, action, permissions },
    localData,
    storageWrites,
    timeline,
    alarmData,
    alarmCreates,
    notificationCalls,
    badgeState,
    actionCalls,
    permissionCalls,
    tabCalls,
    windowCalls,
    runtimeMessages,
    allowedPermissions,
    tabsState,
    windowsState,
    events: { changes, runtime: runtime.onMessage, installed: runtime.onInstalled, startup: runtime.onStartup, alarm: alarms.onAlarm, tabActivated: tabEvents.onActivated, tabUpdated: tabEvents.onUpdated, tabRemoved: tabEvents.onRemoved, tabCreated: tabEvents.onCreated, windowFocusChanged: windowEvents.onFocusChanged, windowRemoved: windowEvents.onRemoved },
    removeTab(tabId) {
      const index = tabsState.findIndex((tab) => tab.id === tabId);
      if (index < 0) return false;
      const [removed] = tabsState.splice(index, 1);
      tabEvents.onRemoved.fire(tabId, { windowId: removed.windowId, isWindowClosing: false });
      return true;
    },
    navigateTab(tabId, url) {
      const tab = tabsState.find((item) => item.id === tabId);
      if (!tab) return false;
      const changeInfo = { url };
      tab.url = url;
      tabEvents.onUpdated.fire(tabId, changeInfo, clone(tab));
      return true;
    },
    extensionId,
    extensionOrigin: extensionBase,
  };
}

function callbackMethod(implementation, mode) {
  return function (...args) {
    const callback = typeof args.at(-1) === "function" ? args.pop() : undefined;
    const promise = Promise.resolve().then(() => implementation(...args));
    if (mode === "browser") return promise;
    if (callback) promise.then((value) => callback(value), () => callback(undefined));
    return undefined;
  };
}

function bootBackground({ mode = "browser", initialStorage, fetch, timers = globalThis, console: consoleOverride, extensionId, extensionOrigin, initialPermissions = [], permissionRequestResult = true, permissionContains, supportsBadgeTextColor = true, failBadgeTextColor = false, initialTabs = [], initialWindows } = {}) {
  const api = createApi({ mode, initialStorage, extensionId, extensionOrigin, initialPermissions, permissionRequestResult, permissionContains, supportsBadgeTextColor, failBadgeTextColor, initialTabs, ...(initialWindows ? { initialWindows } : {}) });
  const requests = [];
  const fetcher = fetch || (async () => response({}));
  const recordedFetch = async (url, init) => {
    requests.push({ url: String(url), init });
    api.timeline.push({ type: "fetch", url: String(url), init });
    return fetcher(url, init);
  };
  const logs = [];
  const sandbox = {
    URL,
    URLSearchParams,
    AbortController,
    Date,
    Math,
    JSON,
    Promise,
    setTimeout: timers.setTimeout.bind(timers),
    clearTimeout: timers.clearTimeout.bind(timers),
    fetch: recordedFetch,
    console: consoleOverride || {
      log: (...args) => logs.push({ level: "log", args }),
      warn: (...args) => logs.push({ level: "warn", args }),
      error: (...args) => logs.push({ level: "error", args }),
    },
    crypto: { randomUUID: (() => { let next = 0; return () => `test-id-${++next}`; })() },
  };
  sandbox[mode === "browser" ? "browser" : "chrome"] = api.namespace;
  const context = vmContext(sandbox);
  context.self = context;
  const sourcePath = path.join(extensionRoot, "background.js");
  const source = fs.readFileSync(sourcePath, "utf8");
  require("node:vm").runInContext(source, context, { filename: sourcePath, timeout: 2_000 });

  async function send(message, sender = { id: api.extensionId, url: api.namespace.runtime.getURL("options.html") }) {
    const listeners = api.events.runtime.listeners;
    if (!listeners.length) throw new Error("background did not register runtime.onMessage");
    let responded = false;
    let resolveResponse;
    const responsePromise = new Promise((resolve) => { resolveResponse = resolve; });
    const sendResponse = (value) => {
      if (!responded) {
        responded = true;
        resolveResponse(value);
      }
    };
    const result = listeners[0](message, sender, sendResponse);
    if (result && typeof result.then === "function") {
      const value = await result;
      if (value !== undefined && !responded) return value;
    }
    if (responded) return responsePromise;
    if (result === true) {
      let timeoutHandle;
      const timeout = new Promise((_, reject) => { timeoutHandle = globalThis.setTimeout(() => reject(new Error("message listener did not respond")), 1_500); });
      return Promise.race([
        responsePromise,
        timeout,
      ]).finally(() => globalThis.clearTimeout(timeoutHandle));
    }
    return undefined;
  }

  function fireAlarm(name) {
    return api.events.alarm.fire({ name, scheduledTime: Date.now() });
  }

  return { ...api, requests, logs, send, fireAlarm, context };
}

function vmContext(sandbox) {
  return require("node:vm").createContext(sandbox);
}

module.exports = { extensionRoot, createEvent, response, createApi, bootBackground };
