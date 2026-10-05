const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const extensionRoot = path.resolve(__dirname, "..");
const backendRoot = path.resolve(extensionRoot, "../../advanced-task-manager/backend");
const python = path.join(backendRoot, "..", ".venv", "bin", "python");
const token = "local-integration-bearer-value";
const resourceId = "task /+one";
const changedDescription = "Updated by the second HTTPS client";

function createCertificate(directory) {
  const keyPath = path.join(directory, "server.key");
  const certPath = path.join(directory, "server.pem");
  const result = spawnSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256", "-days", "2",
    "-keyout", keyPath, "-out", certPath, "-subj", "/CN=127.0.0.1",
    "-addext", "basicConstraints=critical,CA:TRUE",
    "-addext", "keyUsage=critical,keyCertSign,digitalSignature,keyEncipherment",
    "-addext", "extendedKeyUsage=serverAuth",
    "-addext", "subjectAltName=IP:127.0.0.1",
  ], { encoding: "utf8" });
  if (result.error?.code === "ENOENT") return null;
  assert.equal(result.status, 0, "OpenSSL must create a temporary loopback certificate");
  fs.chmodSync(keyPath, 0o600);
  fs.chmodSync(certPath, 0o600);
  return { keyPath, certPath };
}

const pythonServer = String.raw`
import asyncio
import json
import os
import signal
from pathlib import Path

from src.MutationCoordinator import MutationCoordinator
from src.NotificationHistoryStore import NotificationHistoryStore
from src.wrappers.HttpUserCommService import HttpUserCommService
from src.wrappers.Messaging import UserAgent
from tests.ApplicationReadIntegration_test import ApplicationReadIntegrationTest
from tests.HttpApiV1_integration_test import HttpApiV1IntegrationTest

async def serve():
    harness = HttpApiV1IntegrationTest()
    harness.root = Path(os.environ["E2E_DATA_ROOT"])
    harness.root.mkdir(parents=True, exist_ok=True)
    harness.coordinator = MutationCoordinator()
    harness.helper = ApplicationReadIntegrationTest()
    application, task_provider, _, broker = harness._json_stack()
    token = os.environ["E2E_TOKEN"]
    history = NotificationHistoryStore(broker, harness.coordinator, token)
    service = HttpUserCommService(
        "127.0.0.1", 0, token, 1, UserAgent("integration-client"),
        os.environ["E2E_CERT"], os.environ["E2E_KEY"], application,
        "/integration/api/v1", notification_history_store=history,
    )
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    loop.add_signal_handler(signal.SIGTERM, stop.set)
    try:
        await service.initialize()
        port = service.site._server.sockets[0].getsockname()[1]
        print(json.dumps({"ready": True, "port": port}), flush=True)
        await stop.wait()
    finally:
        await service.shutdown()
        task_provider.dispose()
        harness.coordinator.close(wait=True)

asyncio.run(serve())
`;

const nodeClients = String.raw`
const assert = require("node:assert/strict");
const { bootBackground } = require("./tests/helpers.cjs");
const base = process.env.E2E_BASE;
const token = process.env.E2E_TOKEN;
const resourceId = "task /+one";
const changedDescription = "Updated by the second HTTPS client";
const hostPermission = "https://127.0.0.1/*";
let nextUuid = 1;

function uuid() {
  const tail = String(nextUuid++).padStart(12, "0");
  return "00000000-0000-4000-8000-" + tail;
}
function rpc(operation, target = null, parameters = {}) {
  return {protocolVersion: 1, requestId: uuid(), operation, target, parameters};
}
function client() {
  return bootBackground({
    initialStorage: {"settings.v1": {
      schemaVersion: 1,
      serverUrl: base,
      token,
      monitorEnabled: true,
      timeoutMs: 5000,
    }},
    initialPermissions: [hostPermission],
    fetch: globalThis.fetch,
  });
}
function pageSender(env) {
  return {id: env.extensionId, url: env.namespace.runtime.getURL("index.html")};
}

(async () => {
  const first = client();
  const second = client();
  const firstSender = pageSender(first);
  const secondSender = pageSender(second);
  const [rootA, rootB] = await Promise.all([
    first.send(rpc("root.read"), firstSender),
    second.send(rpc("root.read"), secondSender),
  ]);
  assert.equal(rootA.ok, true, "the first gateway client reads the HTTPS root: " + JSON.stringify(rootA.error) + " status=" + rootA.status);
  assert.equal(rootB.ok, true, "the second gateway client reads the HTTPS root: " + JSON.stringify(rootB.error) + " status=" + rootB.status);
  assert.equal(rootA.data.version, "1", "the first root advertises API version 1");
  assert.equal(rootB.data.version, "1", "the second root advertises API version 1");

  const getTask = (env, sender) => env.send(rpc("tasks.get", {kind: "task", id: resourceId}), sender);
  const [taskA, taskB] = await Promise.all([
    getTask(first, firstSender),
    getTask(second, secondSender),
  ]);
  assert.equal(taskA.ok, true, "the first gateway client reads the stored task");
  assert.equal(taskB.ok, true, "the second gateway client reads the stored task");
  assert.equal(taskA.data.id, resourceId, "the first task read preserves its opaque ID");
  assert.equal(taskB.data.id, resourceId, "the second task read preserves its opaque ID");
  assert.equal(taskA.data.description, "Original task", "the temporary JSON fixture is served by the backend");

  const beforeRejectedIds = first.requests.length;
  for (const id of [".", ".."]) {
    const rejected = await first.send(rpc("tasks.get", {kind: "task", id}), firstSender);
    assert.equal(rejected.ok, false);
    assert.equal(rejected.error.kind, "unsupported-resource-id");
    assert.equal(rejected.status, null);
  }
  assert.equal(first.requests.length, beforeRejectedIds);

  const operationId = uuid();
  const receipt = await first.send(rpc("operations.submit", {kind: "task", id: resourceId}, {
    id: operationId,
    type: "edit-task",
    parameters: {changes: {description: changedDescription}},
  }), firstSender);
  assert.equal(receipt.ok, true, "the gateway validates the real POST operation receipt");
  assert.equal(receipt.status, 201, "the backend confirms the operation with HTTP 201");
  assert.equal(receipt.data.status, "succeeded", "the operation receipt is successful");
  assert.equal(receipt.data.id, operationId, "the operation identity is preserved");
  assert.equal(receipt.data.result.effectsState, "complete", "the receipt confirms complete effects");
  assert.deepEqual(receipt.data.result.affectedIds, [resourceId], "the receipt names the affected task");

  const confirmed = await getTask(second, secondSender);
  assert.equal(confirmed.ok, true, "the other gateway client can read the confirmed mutation");
  assert.equal(confirmed.data.id, resourceId, "the second read is still for the same task ID");
  assert.equal(confirmed.data.description, changedDescription, "both gateway clients share the persisted backend JSON");
  process.stdout.write(JSON.stringify({
    clients: 2,
    httpsRootReads: 2,
    concurrentResourceReads: 2,
    confirmedOperationStatus: receipt.status,
    persistedDescription: confirmed.data.description,
    rejectedDotIdsBeforeFetch: 2,
  }));
})().catch((error) => {
  process.stderr.write(error.name + ": " + String(error.message).replaceAll(token, "[redactado]") + "\n");
  process.exitCode = 1;
});
`;

function waitForReady(child) {
  return new Promise((resolve, reject) => {
    let output = "";
    let errorOutput = "";
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("The temporary HTTPS backend did not become ready."));
    }, 20000);
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      output += chunk;
      for (const line of output.split(/\r?\n/)) {
        try {
          const record = JSON.parse(line);
          if (record.ready === true && Number.isInteger(record.port)) {
            clearTimeout(timeout);
            resolve({port: record.port, output: () => output, errorOutput: () => errorOutput});
            return;
          }
        } catch { /* The service emits one fixed startup line before readiness. */ }
      }
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { errorOutput += chunk; });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      reject(new Error(`The temporary HTTPS backend exited before readiness (${code}).`));
    });
  });
}

function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  child.kill("SIGTERM");
  return new Promise((resolve) => child.once("close", resolve));
}

function runClients(base, certPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", nodeClients], {
      cwd: extensionRoot,
      env: {
        ...process.env,
        E2E_BASE: base,
        E2E_TOKEN: token,
        NODE_EXTRA_CA_CERTS: certPath,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Gateway clients did not finish their real HTTPS requests."));
    }, 20000);
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0) return reject(new Error(`Gateway client process failed (${code}): ${stderr}`));
      try { resolve(JSON.parse(stdout)); }
      catch { reject(new Error(`Gateway clients returned invalid summary: ${stderr}`)); }
    });
  });
}

test("two gateway instances use the real HTTPS backend and share JSON-backed mutations", async (t) => {
  if (!fs.existsSync(python)) {
    return t.skip("The real backend integration requires the adjacent checkout's prepared virtual environment.");
  }
  const dependencies = spawnSync(python, ["-c", "import aiohttp, dependency_injector, telegram"], {
    cwd: backendRoot,
    stdio: "ignore",
  });
  if (dependencies.status !== 0) {
    return t.skip("The real backend integration requires the adjacent checkout's test dependencies.");
  }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "real-backend-gateway-"));
  fs.chmodSync(directory, 0o700);
  let backend = null;
  t.after(async () => {
    if (backend !== null) await stopChild(backend);
    fs.rmSync(directory, {recursive: true, force: true});
  });
  const certificate = createCertificate(directory);
  if (certificate === null) return t.skip("OpenSSL is unavailable; the local certificate was not created.");

  backend = spawn(python, ["-c", pythonServer], {
    cwd: backendRoot,
    env: {
      ...process.env,
      PYTHONDONTWRITEBYTECODE: "1",
      E2E_DATA_ROOT: path.join(directory, "backend-data"),
      E2E_TOKEN: token,
      E2E_CERT: certificate.certPath,
      E2E_KEY: certificate.keyPath,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let ready;
  try {
    ready = await waitForReady(backend);
  } catch (error) {
    throw new Error(`${error.message}\n${backend.stderr.read()?.toString("utf8") ?? ""}`);
  }
  const base = `https://127.0.0.1:${ready.port}/integration/api/v1`;
  const summary = await runClients(base, certificate.certPath);

  assert.equal(summary.clients, 2);
  assert.equal(summary.confirmedOperationStatus, 201);
  assert.equal(summary.persistedDescription, changedDescription);
  assert.equal(summary.rejectedDotIdsBeforeFetch, 2);

  const persistedFile = path.join(directory, "backend-data", "json-data", "tasks.json");
  const persistedText = fs.readFileSync(persistedFile, "utf8");
  assert.doesNotMatch(persistedText, new RegExp(token), "the bearer token is not copied into task storage");
  const stored = JSON.parse(persistedText);
  const changedTask = stored.tasks.find((task) => task.id === resourceId);
  assert.equal(changedTask.description, changedDescription);
});

test("WHATWG URL parsing normalizes encoded dot path segments", () => {
  const base = "https://service.example.test/prefix/api/v1/";
  assert.equal(encodeURIComponent("."), ".");
  assert.equal(encodeURIComponent(".."), "..");
  assert.equal(new URL("tasks/%2E", base).pathname, "/prefix/api/v1/tasks/");
  assert.equal(new URL("tasks/%2E%2E", base).pathname, "/prefix/api/v1/");
});
