const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { isDeepStrictEqual } = require("node:util");
const { extensionRoot } = require("./helpers.cjs");

function read(relativePath) {
  return fs.readFileSync(path.join(extensionRoot, relativePath), "utf8");
}

function manifestResources(manifest) {
  const resources = new Set();
  const add = (value) => { if (typeof value === "string") resources.add(value); };
  add(manifest.action?.default_popup);
  add(manifest.options_ui?.page);
  add(manifest.background?.service_worker);
  for (const item of manifest.background?.scripts ?? []) add(item);
  for (const value of Object.values(manifest.icons ?? {})) add(value);
  for (const value of Object.values(manifest.action?.default_icon ?? {})) add(value);
  return resources;
}

function localPageDependencies(relativePath) {
  const content = read(relativePath);
  const dependencies = [];
  for (const match of content.matchAll(/\b(?:src|href)\s*=\s*["']([^"']+)["']/gi)) {
    const value = match[1];
    if (/^(?:https?:)?\/\//i.test(value) || value.startsWith("data:")) {
      throw new Error(`${relativePath} has a remote/data dependency: ${value}`);
    }
    if (!value.startsWith("#") && !value.startsWith("mailto:")) dependencies.push(path.posix.normalize(path.posix.join(path.posix.dirname(relativePath), value)));
  }
  return { content, dependencies };
}

function moduleImports(relativePath) {
  const content = read(relativePath);
  const imports = [];
  for (const match of content.matchAll(/\bfrom\s*["']([^"']+)["']|\bimport\s*["']([^"']+)["']/g)) {
    const value = match[1] || match[2];
    if (/^(?:https?:)?\/\//i.test(value)) throw new Error(`${relativePath} imports remote code: ${value}`);
    if (value.startsWith(".")) imports.push(path.posix.normalize(path.posix.join(path.posix.dirname(relativePath), value)));
  }
  return imports;
}

function assertResourceExists(relativePath) {
  assert.ok(fs.existsSync(path.join(extensionRoot, relativePath)), `manifest/UI resource is missing: ${relativePath}`);
  assert.ok(!relativePath.split("/").includes(".."), `resource escaped extension root: ${relativePath}`);
}

test("both source manifests and the active manifest point to local, present resources", () => {
  const chromium = JSON.parse(read("manifest.chromium.json"));
  const firefox = JSON.parse(read("manifest.firefox.json"));
  const active = JSON.parse(read("manifest.json"));

  for (const manifest of [chromium, firefox, active]) {
    assert.equal(manifest.manifest_version, 3);
    assert.deepEqual(new Set(manifest.permissions), new Set(["storage", "alarms", "notifications"]));
    assert.ok(manifest.host_permissions.includes("http://*/*"));
    assert.equal(manifest.action.default_popup, "popup.html");
    assert.equal(manifest.options_ui.page, "options.html");
    assert.equal(manifest.options_ui.open_in_tab, true);
    assert.equal(manifest.content_scripts, undefined);
    assert.equal(manifest.web_accessible_resources, undefined);
    for (const resource of manifestResources(manifest)) assertResourceExists(resource);
  }
  assert.deepEqual(chromium.background, { service_worker: "background.js" });
  assert.deepEqual(firefox.background, { scripts: ["background.js"] });
  assert.ok(
    isDeepStrictEqual(active, chromium) || isDeepStrictEqual(active, firefox),
    "manifest.json must preserve one of the checked-in browser variants",
  );
});

test("all manifests use a local-only CSP without rewriting HTTP backend requests", () => {
  for (const name of ["manifest.json", "manifest.chromium.json", "manifest.firefox.json"]) {
    const manifest = JSON.parse(read(name));
    const policy = manifest.content_security_policy?.extension_pages;

    assert.equal(typeof policy, "string", `${name} must explicitly declare extension_pages CSP`);
    assert.match(policy, /^script-src 'self'; object-src 'self';$/);
    assert.doesNotMatch(policy, /(?:^|;)\s*connect-src\b/i);
    assert.doesNotMatch(policy, /(?:^|;)\s*upgrade-insecure-requests\b/i);
    assert.doesNotMatch(policy, /'unsafe-eval'|https?:\/\//i);
  }
});

test("HTML and module dependency graph stays local and has no inline handlers or scripts", () => {
  const htmlFiles = ["popup.html", "options.html", "index.html"];
  const moduleFiles = new Set();
  for (const htmlPath of htmlFiles) {
    const { content, dependencies } = localPageDependencies(htmlPath);
    for (const dependency of dependencies) assertResourceExists(dependency);
    assert.doesNotMatch(content, /<script(?![^>]*\bsrc\s*=)[^>]*>/i, `${htmlPath} should load scripts from files`);
    assert.doesNotMatch(content, /\son[a-z]+\s*=/i, `${htmlPath} should not use inline event handlers`);
    for (const match of content.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)) {
      moduleFiles.add(path.posix.normalize(path.posix.join(path.posix.dirname(htmlPath), match[1])));
    }
  }

  const visited = new Set();
  const visit = (relativePath) => {
    if (visited.has(relativePath)) return;
    visited.add(relativePath);
    assertResourceExists(relativePath);
    for (const dependency of moduleImports(relativePath)) visit(dependency);
  };
  for (const modulePath of moduleFiles) visit(modulePath);
});

test("only the background owns HTTP; UI reads local notification history and renders backend text safely", () => {
  const jsFiles = fs.readdirSync(path.join(extensionRoot, "js"))
    .filter((file) => file.endsWith(".js"))
    .map((file) => path.join("js", file));
  const uiSource = jsFiles.map(read).join("\n");
  const background = read("background.js");

  assert.match(background, /fetch\(/);
  assert.doesNotMatch(uiSource, /\bfetch\s*\(|XMLHttpRequest|X-Atm-Target/);
  assert.doesNotMatch(uiSource, /GET_NOTIFICATIONS|\/notifications(?:\?|['"`])/);
  assert.match(uiSource, /notificationHistory\.v1/);
  assert.match(read("js/render.js"), /textContent/);
  assert.doesNotMatch(uiSource, /\.innerHTML\s*=|insertAdjacentHTML\s*\(/);
});

test("popup reads the first agenda task and exposes only identity-checked urgent-task actions", () => {
  const popup = read("js/popup.js");
  const html = read("popup.html");
  assert.match(popup, /GET_AGENDA/);
  assert.match(popup, /active_urgent_tasks\[0\]/);
  assert.doesNotMatch(popup, /GET_INFO|SELECT_TASK|task_1|\/info/);
  assert.match(popup, /"POPUP_DONE"/);
  assert.match(popup, /"POPUP_SNOOZE"/);
  assert.match(popup, /expectedTask/);
  assert.match(html, /id="complete-task"[^>]*disabled>Completar/);
  assert.match(html, /id="snooze-task"[^>]*disabled>Posponer 5 minutos/);
});

test("manager markup and handlers cover the current TaskManagerApi operation families", () => {
  const html = read("index.html");
  const app = read("js/app.js");
  const operations = [
    "GET_LIST", "NEXT", "PREVIOUS", "SELECT_TASK", "GET_INFO",
    "GET_HEURISTICS", "SELECT_HEURISTIC", "GET_ALGORITHMS", "SELECT_ALGORITHM",
    "GET_FILTERS", "TOGGLE_FILTER", "DONE", "SET", "NEW", "SCHEDULE", "WORK",
    "SNOOZE", "SEARCH", "GET_STATS", "GET_AGENDA", "GET_EVENTS", "PROJECT", "RAISE",
  ];
  for (const operation of operations) assert.ok(app.includes(`"${operation}"`), `manager does not call ${operation}`);
  for (const formId of ["set-form", "new-form", "work-form", "schedule-form", "snooze-form", "search-form", "project-form", "raise-form"]) {
    assert.match(html, new RegExp(`id="${formId}"`));
  }
  for (const view of ["tasks", "agenda", "stats", "events", "selectedTask"]) assert.ok(html.includes(`data-view="${view}"`));
  for (const action of ["refresh-list", "previous", "next", "get-info", "done", "refresh-agenda", "refresh-stats", "refresh-events"]) {
    assert.ok(html.includes(`data-action="${action}"`), `manager markup lacks ${action}`);
  }
});

test("options masks token and the manager clears only its own local notification history", () => {
  assert.match(read("options.html"), /id="token"[^>]*type="password"/);
  assert.match(read("js/options.js"), /settingsMessages\.connect/);
  assert.match(read("js/app.js"), /clearHistory\(\)/);
  assert.match(read("js/messages.js"), /history\.clear/);
  assert.match(read("js/storage-view.js"), /storage\.onChanged/);
});

test("manager retains list UID and page when selecting from paginated or agenda results", () => {
  const app = read("js/app.js");
  const render = read("js/render.js");
  assert.match(app, /async function findTaskRow\(taskId/);
  assert.match(app, /entry\.id === taskId/);
  assert.match(app, /request\("NEXT"\)/);
  assert.match(app, /request\("SELECT_TASK",\s*\{\s*index,\s*expectedTaskId:\s*task\.id,\s*page\s*\}\)/);
  assert.match(app, /data\.task\.id !== task\.id/);
  assert.match(render, /task\.id && task\.id !== "unknown"/);
});

test("native extension contains no bundled framework, build output, or package dependency", () => {
  const files = [];
  const walk = (directory) => {
    for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, item.name);
      if (item.isDirectory()) walk(fullPath);
      else files.push(path.relative(extensionRoot, fullPath).split(path.sep).join("/"));
    }
  };
  walk(extensionRoot);
  assert.equal(files.some((file) => file.startsWith("node_modules/")), false);
  assert.equal(files.some((file) => /\.(?:ts|tsx|jsx)$/.test(file)), false);
  assert.equal(files.some((file) => /(?:^|\/)(?:vite|webpack|rollup)\.(?:config|)[^.]*\./i.test(file)), false);
});
