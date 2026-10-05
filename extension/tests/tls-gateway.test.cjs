const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

function runOpenSsl(args, cwd) {
  const result = spawnSync("openssl", args, { cwd, encoding: "utf8" });
  if (result.error?.code === "ENOENT") return false;
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  return true;
}

function createCertificates(directory) {
  const created = runOpenSsl([
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256", "-days", "2",
    "-keyout", "ca.key", "-out", "ca.pem", "-subj", "/CN=Local-Test-CA",
    "-addext", "basicConstraints=critical,CA:TRUE",
    "-addext", "keyUsage=critical,keyCertSign,cRLSign",
  ], directory);
  if (!created) return false;
  fs.writeFileSync(path.join(directory, "server.ext"), [
    "subjectAltName=DNS:localhost",
    "extendedKeyUsage=serverAuth",
    "keyUsage=digitalSignature,keyEncipherment",
    "",
  ].join("\n"), { mode: 0o600 });
  assert.equal(runOpenSsl([
    "req", "-newkey", "rsa:2048", "-nodes", "-sha256",
    "-keyout", "server.key", "-out", "server.csr", "-subj", "/CN=localhost",
  ], directory), true);
  assert.equal(runOpenSsl([
    "x509", "-req", "-in", "server.csr", "-CA", "ca.pem", "-CAkey", "ca.key",
    "-CAcreateserial", "-out", "server.pem", "-days", "2", "-sha256", "-extfile", "server.ext",
  ], directory), true);
  for (const name of ["ca.key", "server.key", "server.csr", "server.ext", "ca.pem", "server.pem"]) {
    fs.chmodSync(path.join(directory, name), name.endsWith(".key") ? 0o600 : 0o600);
  }
  return true;
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve(server.address().port);
    });
  });
}

function close(server) {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve) => server.close(() => resolve()));
}

function runBackground({ baseUrl, hostPermission, caPath }) {
  const script = String.raw`
    const { bootBackground } = require("./tests/helpers.cjs");
    const baseUrl = process.env.TEST_BASE_URL;
    const hostPermission = process.env.TEST_HOST_PERMISSION;
    const env = bootBackground({
      initialStorage: { "settings.v1": {
        schemaVersion: 1,
        serverUrl: baseUrl,
        token: "local-test-secret",
        monitorEnabled: true,
        timeoutMs: 3000,
      } },
      initialPermissions: [hostPermission],
      fetch: (url, init) => globalThis.fetch(url, init),
    });
    const message = {
      protocolVersion: 1,
      requestId: "00000000-0000-4000-8000-000000000041",
      operation: "root.read",
      target: null,
      parameters: {},
    };
    env.send(message, { id: env.extensionId, url: env.namespace.runtime.getURL("index.html") })
      .then(reply => process.stdout.write(JSON.stringify(reply)))
      .catch(() => process.exitCode = 1);
  `;
  const env = {
    ...process.env,
    TEST_BASE_URL: baseUrl,
    TEST_HOST_PERMISSION: hostPermission,
  };
  delete env.NODE_EXTRA_CA_CERTS;
  if (caPath) env.NODE_EXTRA_CA_CERTS = caPath;
  const child = spawn(process.execPath, ["-e", script], { cwd: path.resolve(__dirname, ".."), env });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("The temporary TLS request did not finish in time."));
    }, 8000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`Client exited ${code}: ${stderr}`));
      try { resolve(JSON.parse(stdout)); }
      catch { reject(new Error(`Client returned invalid JSON: ${stderr}\n${stdout}`)); }
    });
  });
}

test("the background uses native TLS validation and refuses HTTP redirects without forwarding credentials", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "extension-gateway-tls-"));
  fs.chmodSync(directory, 0o700);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  if (!createCertificates(directory)) return t.skip("OpenSSL is unavailable; the local certificate handshake was not run.");

  const secureRequests = [];
  const plainRequests = [];
  let plainPort = 0;
  const secureServer = https.createServer({
    key: fs.readFileSync(path.join(directory, "server.key")),
    cert: fs.readFileSync(path.join(directory, "server.pem")),
  }, (request, response) => {
    secureRequests.push({ url: request.url, authorization: request.headers.authorization });
    if (request.url === "/prefix/redirect/api/v1") {
      response.writeHead(302, { Location: `http://127.0.0.1:${plainPort}/collect` });
      response.end();
      return;
    }
    const base = `https://localhost:${secureServer.address().port}${request.url}`;
    response.writeHead(200, { "Content-Type": "application/hal+json" });
    response.end(JSON.stringify({ _links: { self: { href: base } } }));
  });
  const plainServer = http.createServer((request, response) => {
    plainRequests.push({ url: request.url, authorization: request.headers.authorization });
    response.writeHead(200);
    response.end("unexpected request");
  });
  let securePort;
  try {
    plainPort = await listen(plainServer);
    securePort = await listen(secureServer);
  } catch (error) {
    await Promise.all([close(secureServer), close(plainServer)]);
    if (error && error.code === "EPERM") return t.skip("The environment does not permit a loopback listener.");
    throw error;
  }
  t.after(async () => {
    await Promise.all([close(secureServer), close(plainServer)]);
  });

  const trusted = await runBackground({
    baseUrl: `https://localhost:${securePort}/prefix/api/v1`,
    hostPermission: "https://localhost/*",
    caPath: path.join(directory, "ca.pem"),
  });
  assert.equal(trusted.ok, true);
  assert.equal(trusted.status, 200);
  assert.equal(secureRequests.length, 1);
  assert.equal(secureRequests[0].authorization, "Bearer local-test-secret");

  const requestCount = secureRequests.length;
  const untrusted = await runBackground({
    baseUrl: `https://localhost:${securePort}/prefix/api/v1`,
    hostPermission: "https://localhost/*",
  });
  assert.equal(untrusted.ok, false);
  assert.equal(untrusted.status, null);
  assert.ok(["network", "tls"].includes(untrusted.error.kind));
  assert.equal(secureRequests.length, requestCount, "an untrusted certificate fails before HTTP headers are sent");
  assert.doesNotMatch(JSON.stringify(untrusted), /local-test-secret/);

  const wrongName = await runBackground({
    baseUrl: `https://127.0.0.1:${securePort}/prefix/api/v1`,
    hostPermission: "https://127.0.0.1/*",
    caPath: path.join(directory, "ca.pem"),
  });
  assert.equal(wrongName.ok, false);
  assert.equal(wrongName.status, null);
  assert.ok(["network", "tls"].includes(wrongName.error.kind));
  assert.equal(secureRequests.length, requestCount, "a certificate name mismatch fails before HTTP headers are sent");
  assert.doesNotMatch(JSON.stringify(wrongName), /local-test-secret/);

  const redirected = await runBackground({
    baseUrl: `https://localhost:${securePort}/prefix/redirect/api/v1`,
    hostPermission: "https://localhost/*",
    caPath: path.join(directory, "ca.pem"),
  });
  assert.equal(redirected.ok, false);
  assert.equal(redirected.status, null);
  assert.equal(plainRequests.length, 0, "an HTTPS-to-HTTP redirect is rejected without sending credentials to HTTP");
  assert.equal(secureRequests.filter((entry) => entry.url === "/prefix/redirect/api/v1").length, 1);
});
