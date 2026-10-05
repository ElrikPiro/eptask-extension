const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { extensionRoot } = require("./helpers.cjs");

const requestUuid = "00000000-0000-4000-8000-000000000101";

class FakeElement {
  constructor() {
    this.value = "";
    this.textContent = "";
    this.className = "";
    this.hidden = false;
    this.disabled = false;
    this.listeners = new Map();
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  click() {
    if (this.disabled) return;
    for (const listener of this.listeners.get("click") || []) listener({ target: this, preventDefault() {} });
  }

  submit() {
    for (const listener of this.listeners.get("submit") || []) listener({ target: this, preventDefault() {} });
  }

  reportValidity() { return true; }
  setCustomValidity(message) { this.validationMessage = message; }
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

function bootOptions({ requestPermission = () => Promise.resolve(true), settings = {} } = {}) {
  const elements = new Map([
    "#settings-form", "#server-url", "#token", "#timeout-ms", "#options-message",
    "#monitor-badge", "#monitor-description", "#save-settings", "#connect",
    "#disconnect", "#clear-settings",
  ].map((selector) => [selector, new FakeElement()]));
  const calls = [];
  const timeline = [];
  const uuidValues = [requestUuid];
  let uuidIndex = 0;
  const storageListener = { current: null };
  const browserApi = {
    runtime: {
      sendMessage(message) {
        timeline.push("runtime.sendMessage");
        calls.push(JSON.parse(JSON.stringify(message)));
        return Promise.resolve({
          requestId: message.requestId,
          ok: true,
          status: null,
          data: { message: "Conexión validada" },
          error: null,
        });
      },
    },
    permissions: {
      request(details) {
        timeline.push("permissions.request");
        return requestPermission(details);
      },
    },
  };
  const messages = fs.readFileSync(path.join(extensionRoot, "js/messages.js"), "utf8")
    .replace(/^import .*;\s*$/gm, "")
    .replace(/^export /gm, "");
  const options = fs.readFileSync(path.join(extensionRoot, "js/options.js"), "utf8")
    .replace(/^import .*;\s*$/gm, "")
    .replace(/^export /gm, "");
  const prelude = `
    const DEFAULT_SETTINGS = {schemaVersion:1,serverUrl:"",token:"",monitorEnabled:false,timeoutMs:30000};
    function readExtensionState() { return Promise.resolve({settings:{...DEFAULT_SETTINGS,...initialSettings},gatewayError:null}); }
    function subscribeStorageChanges(listener) { storageListener.current = listener; return () => {}; }
  `;
  const source = `${messages}\n${prelude}\n${options}\n` + `
    globalThis.__optionsTest = { currentSettings, canonicalizeEndpointInput, settings: () => settings };
  `;
  const context = vm.createContext({
    browserApi,
    document: { querySelector: (selector) => {
      const element = elements.get(selector);
      if (!element) throw new Error(`Unexpected selector ${selector}`);
      return element;
    } },
    initialSettings: settings,
    storageListener,
    URL,
    Promise,
    Uint8Array,
    Date,
    Math,
    crypto: { randomUUID: () => uuidValues[uuidIndex++] },
    confirm: () => true,
  });
  vm.runInContext(source, context, { filename: "options.js", timeout: 2_000 });
  return {
    calls,
    timeline,
    elements,
    uuidCount: () => uuidIndex,
    state: () => context.__optionsTest.settings(),
    currentSettings: () => context.__optionsTest.currentSettings(true),
    async flush() {
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

test("the connect click requests only the HTTPS host before any RPC and canonicalizes the API prefix", async () => {
  const permission = deferred();
  const requested = [];
  const env = bootOptions({ requestPermission: (details) => {
    requested.push(JSON.parse(JSON.stringify(details)));
    return permission.promise;
  } });
  await env.flush();
  env.elements.get("#server-url").value = "https://api.example.test:9443/gestor/%C3%B1/";
  env.elements.get("#token").value = "private-token";
  env.elements.get("#timeout-ms").value = "45000";

  assert.equal(JSON.parse(JSON.stringify(env.currentSettings())).serverUrl, "https://api.example.test:9443/gestor/%C3%B1/api/v1");
  assert.equal(env.elements.get("#connect").listeners.get("click")?.length, 1);

  env.elements.get("#connect").click();
  assert.deepEqual(requested, [{ origins: ["https://api.example.test/*"] }], env.elements.get("#options-message").textContent);
  assert.deepEqual(env.timeline, ["permissions.request"]);
  assert.equal(env.calls.length, 0, "no RPC or fetch starts while the browser permission prompt is pending");

  permission.resolve(true);
  await env.flush();
  assert.deepEqual(env.timeline, ["permissions.request", "runtime.sendMessage"]);
  assert.equal(env.calls.length, 1);
  assert.equal(env.calls[0].operation, "settings.connect");
  assert.equal(env.calls[0].parameters.serverUrl, "https://api.example.test:9443/gestor/%C3%B1/api/v1");
  assert.equal(env.calls[0].parameters.timeoutMs, 45_000);
  assert.equal(env.calls[0].parameters.token, "private-token");
});

test("the form rejects encoded separators, dot segments, credentials, and non-HTTPS URLs before permission", async (t) => {
  const invalidUrls = [
    "http://api.example.test/prefix",
    "https://user:pass@api.example.test/prefix",
    "https://api.example.test/prefix/%2fadmin",
    "https://api.example.test/prefix/%2e%2e/admin",
    "https://api.example.test/prefix/../admin",
    "https://api.example.test/prefix?next=https://evil.test",
    "https://api.example.test/prefix/api/v1/api/v1",
  ];
  for (const serverUrl of invalidUrls) {
    await t.test(serverUrl, async () => {
      const env = bootOptions();
      await env.flush();
      env.elements.get("#server-url").value = serverUrl;
      env.elements.get("#token").value = "private-token";
      env.elements.get("#connect").click();
      await env.flush();
      assert.equal(env.timeline.length, 0);
      assert.equal(env.calls.length, 0);
      assert.match(env.elements.get("#options-message").textContent, /HTTPS/);
    });
  }
});

test("connect denial disarms background monitoring without exposing the token", async () => {
  const token = "secret-that-must-not-appear";
  const env = bootOptions({ requestPermission: () => Promise.resolve(false) });
  await env.flush();
  env.elements.get("#server-url").value = "https://api.example.test";
  env.elements.get("#token").value = token;
  env.elements.get("#connect").click();
  await env.flush();

  assert.deepEqual(env.timeline, ["permissions.request", "runtime.sendMessage"]);
  assert.equal(env.calls.length, 1);
  assert.equal(env.calls[0].operation, "settings.disconnect");
  assert.match(env.elements.get("#options-message").textContent, /No se concedió permiso/);
  assert.doesNotMatch(env.elements.get("#options-message").textContent, new RegExp(token));
});

test("the timeout control enforces the documented range and never sends an invalid value", async (t) => {
  for (const timeoutMs of ["999", "120001", "1.5"]) {
    await t.test(timeoutMs, async () => {
      const env = bootOptions();
      await env.flush();
      env.elements.get("#server-url").value = "https://api.example.test";
      env.elements.get("#token").value = "secret";
      env.elements.get("#timeout-ms").value = timeoutMs;
      env.elements.get("#connect").click();
      await env.flush();
      assert.equal(env.timeline.length, 0);
      assert.equal(env.calls.length, 0);
      assert.match(env.elements.get("#options-message").textContent, /1 y 120 segundos/);
    });
  }
});
