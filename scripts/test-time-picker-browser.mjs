import assert from "node:assert/strict";
import http from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const { chromium, firefox } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const fixture = require("../extension/tests/manager-fixtures.cjs");
const extension = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../extension");
const screenshotDirectory = process.env.TIME_PICKER_SCREENSHOTS;
const browserType = process.env.TIME_PICKER_BROWSER === "firefox" ? firefox : chromium;
const tasks = [fixture.taskResource("task-a")];
const resources = { "root.read": { timeZone: "Europe/Madrid" }, "strategies.list": fixture.strategiesResource(), "tasks.list": fixture.taskCollection(tasks), "tasks.get": tasks[0] };
const server = http.createServer(async (request, response) => {
  try {
    const relative = new URL(request.url, "http://localhost").pathname.slice(1) || "index.html";
    const target = path.resolve(extension, relative);
    if (!target.startsWith(`${extension}/`)) throw new Error("Invalid path");
    response.setHeader("Content-Type", target.endsWith(".js") ? "text/javascript" : target.endsWith(".css") ? "text/css" : "text/html");
    response.setHeader("Content-Security-Policy", "script-src 'self'; object-src 'self'; connect-src https:;");
    response.end(await readFile(target));
  } catch { response.writeHead(404); response.end(); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
let browser;
try {
  browser = await browserType.launch({ headless: true, args: browserType === chromium ? ["--no-sandbox"] : [] });
  const page = await browser.newPage({ timezoneId: "Europe/Madrid", locale: "es-ES", viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  await page.addInitScript(({ resources }) => {
    const listeners = [];
    window.testWrites = [];
    window.emitChange = () => listeners.forEach(listener => listener({ protocolVersion: 1, event: "changes.invalidated", changes: { collections: ["tasks"], taskIds: ["task-a"], projectNames: [], eventNames: [], refreshAll: true } }, { id: "test-browser-extension", url: "moz-extension://fixture/background.js" }));
    window.browser = {
      runtime: {
        id: "test-browser-extension", getURL: file => `moz-extension://fixture/${file}`,
        onMessage: { addListener: listener => listeners.push(listener), removeListener() {} }, openOptionsPage: async () => {},
        sendMessage: async message => {
          let data = resources[message.operation];
          if (message.operation === "operations.submit") {
            window.testWrites.push(message.parameters);
            data = { id: message.parameters.id, status: "succeeded", type: message.parameters.type, target: message.target, result: { effectsState: "complete", affectedIds: ["task-a"] }, failure: null };
          }
          return { requestId: message.requestId, ok: true, status: 200, data: structuredClone(data || {}), error: null };
        },
      },
      storage: { onChanged: { addListener() {} }, local: { get: async () => ({ "settings.v1": { schemaVersion: 1, serverUrl: "https://tasks.example.test/team/api/v1", token: "fixture-token", monitorEnabled: true, timeoutMs: 30000 } }) } },
    };
  }, { resources });
  await page.goto(`http://127.0.0.1:${server.address().port}/index.html`);
  await page.locator('tr[data-task-id="task-a"]').click();
  const form = page.locator("#action-form-edit-task");
  const button = form.locator('[data-time-picker="changes.due"]');
  const time = form.locator('[name="changes.due.time"]');
  const zone = form.locator('[name="changes.due.zone"]');
  const originalTime = await time.inputValue();
  await button.click();
  await page.locator(".tp-ui-clock-face").waitFor({ state: "visible" });
  await page.locator(".tp-ui-timezone-dropdown").click();
  await page.locator('.tp-ui-timezone-option[data-value="Asia/Tokyo"]').click();
  await page.getByText("Cancelar", { exact: true }).click();
  assert.equal(await time.inputValue(), originalTime);
  assert.equal(await zone.inputValue(), "Europe/Madrid");
  await button.click();
  await page.locator(".tp-ui-timezone-dropdown").click();
  await page.locator('.tp-ui-timezone-option[data-value="America/New_York"]').click();
  async function clickClockNumber(selector, text) {
    const tip = await page.locator(selector).filter({ hasText: new RegExp(`^${text}$`) }).boundingBox();
    const face = page.locator(".tp-ui-clock-face");
    const box = await face.boundingBox();
    await face.click({ position: { x: tip.x + tip.width / 2 - box.x, y: tip.y + tip.height / 2 - box.y } });
  }
  await clickClockNumber(".tp-ui-value-tips-24h", "15");
  await page.waitForTimeout(700);
  await clickClockNumber(".tp-ui-value-tips", "30");
  await page.waitForTimeout(200);
  if (screenshotDirectory) { await mkdir(screenshotDirectory, { recursive: true }); await page.screenshot({ path: path.join(screenshotDirectory, `${browserType.name()}-time-picker-popup.png`) }); }
  await page.getByText("Aceptar", { exact: true }).click();
  assert.equal(await zone.inputValue(), "America/New_York");
  await page.evaluate(() => window.emitChange());
  await page.waitForTimeout(100);
  assert.equal(await zone.inputValue(), "America/New_York", "zone survives a remote update");
  await button.click();
  await page.evaluate(() => window.emitChange());
  await page.waitForTimeout(100);
  assert.equal(await page.locator(".tp-ui-modal").count(), 0, "rerender removes the old popup");
  await form.getByRole("button", { name: "Guardar cambios", exact: true }).click();
  await page.waitForFunction(() => window.testWrites.length === 1);
  const sent = await page.evaluate(() => window.testWrites[0].parameters);
  assert.equal(sent.changes.due, "2026-10-07T19:30:00.000Z", "15:30 in New York is sent as UTC");
  assert.deepEqual(Object.keys(sent.changes), ["due"]);
  assert.deepEqual(errors, [], "real UI has no script, resource, or CSP errors");
  console.log(`PASS: real ${browserType.name()} popup, timezone, cancellation, drafts, cleanup, CSP and UTC conversion.`);
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
