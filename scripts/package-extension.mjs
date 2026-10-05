import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPOSITORY_ROOT = path.resolve(SCRIPT_DIRECTORY, "..");
const DEFAULT_SOURCE_DIRECTORY = path.join(DEFAULT_REPOSITORY_ROOT, "extension");
const DEFAULT_OUTPUT_DIRECTORY = path.join(DEFAULT_SOURCE_DIRECTORY, "dist");
const TOP_LEVEL_RUNTIME_FILES = new Set(["background.js", "index.html", "options.html", "popup.html"]);
const RUNTIME_DIRECTORIES = new Set(["css", "icons", "js"]);
const RUNTIME_EXTENSIONS = new Set([".css", ".html", ".js", ".png"]);
const REQUIRED_PERMISSIONS = ["alarms", "notifications", "storage", "tabs"];
const OPTIONAL_HOST_PERMISSIONS = ["https://*/*"];
const EXTENSION_CSP = "script-src 'self'; object-src 'self'; connect-src https:;";
const GECKO_DATA_TYPES = new Set([
  "personallyIdentifyingInfo",
  "healthInfo",
  "financialAndPaymentInfo",
  "personalCommunications",
  "locationInfo",
  "browsingActivity",
  "websiteContent",
  "websiteActivity",
  "searchTerms",
  "bookmarksInfo",
  "technicalAndInteraction",
]);
const GECKO_PERSONAL_DATA_TYPES = new Set([...GECKO_DATA_TYPES].filter((name) => name !== "technicalAndInteraction"));
const ALLOWED_MANIFEST_KEYS = new Set([
  "manifest_version",
  "name",
  "version",
  "description",
  "action",
  "options_ui",
  "permissions",
  "optional_host_permissions",
  "content_security_policy",
  "icons",
  "background",
  "browser_specific_settings",
]);
const ALLOWED_GECKO_KEYS = new Set(["id", "data_collection_permissions"]);
function fail(message) {
  throw new Error(message);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sorted(values) {
  return [...values].sort();
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalJson(value[key])]));
}

function deepEqual(left, right) {
  return JSON.stringify(canonicalJson(left)) === JSON.stringify(canonicalJson(right));
}

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch {
    fail(label + " is not valid JSON.");
  }
}

function validateFirefoxAddonId(value) {
  if (value === undefined || value === "") return null;
  if (typeof value !== "string" || value.length > 255 || /[\u0000-\u0020\u007f]/.test(value)) {
    fail("FIREFOX_ADDON_ID must be a non-empty Gecko ID without whitespace or control characters.");
  }
  return value;
}

function parseDataCollectionPermissions(raw) {
  if (raw === undefined || raw === "") return null;
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    fail("FIREFOX_DATA_COLLECTION_PERMISSIONS_JSON must contain valid JSON.");
  }
  validateDataCollectionPermissions(value, "FIREFOX_DATA_COLLECTION_PERMISSIONS_JSON");
  return value;
}

function validateDataCollectionPermissions(value, label) {
  if (!isObject(value) || !deepEqual(sorted(Object.keys(value)), ["optional", "required"])) {
    fail(label + " must have exactly required and optional arrays.");
  }
  for (const key of ["required", "optional"]) {
    if (!Array.isArray(value[key]) || value[key].some((item) => typeof item !== "string")) {
      fail(label + " " + key + " must be an array of strings.");
    }
    if (new Set(value[key]).size !== value[key].length) {
      fail(label + " " + key + " cannot contain duplicate values.");
    }
    for (const item of value[key]) {
      if (item !== "none" && !GECKO_DATA_TYPES.has(item)) {
        fail(label + " includes an unsupported Firefox data collection category.");
      }
    }
  }
  if (value.required.includes("none")) {
    if (value.required.length !== 1 || value.optional.length !== 0) {
      fail(label + " cannot combine none with another data collection category.");
    }
    return;
  }
  if (value.required.includes("technicalAndInteraction")) {
    fail(label + " must list technicalAndInteraction as optional.");
  }
  if ([...value.required, ...value.optional].some((item) => !GECKO_PERSONAL_DATA_TYPES.has(item) && item !== "technicalAndInteraction")) {
    fail(label + " includes an unsupported Firefox data collection category.");
  }
  if (value.required.length + value.optional.length === 0) {
    fail(label + " must explicitly declare none or at least one data collection category.");
  }
}

function getDataCollectionPermissions(manifest) {
  const gecko = manifest?.browser_specific_settings?.gecko;
  return isObject(gecko) ? gecko.data_collection_permissions : undefined;
}

function validateGeckoSettings(manifest, label) {
  const settings = manifest.browser_specific_settings;
  if (settings === undefined) return;
  if (!isObject(settings) || !deepEqual(Object.keys(settings), ["gecko"]) || !isObject(settings.gecko)) {
    fail(label + " may only define browser_specific_settings.gecko.");
  }
  if (Object.keys(settings.gecko).some((key) => !ALLOWED_GECKO_KEYS.has(key))) {
    fail(label + " contains an unsupported Firefox-specific manifest field.");
  }
  if (settings.gecko.id !== undefined) validateFirefoxAddonId(settings.gecko.id);
  if (settings.gecko.data_collection_permissions !== undefined) {
    validateDataCollectionPermissions(settings.gecko.data_collection_permissions, label + " data_collection_permissions");
  }
}

function validateManifest(manifest, browser, label) {
  if (!isObject(manifest)) fail(label + " must be a JSON object.");
  if (Object.keys(manifest).some((key) => !ALLOWED_MANIFEST_KEYS.has(key))) {
    fail(label + " contains an unsupported manifest field.");
  }
  if (manifest.manifest_version !== 3 || typeof manifest.name !== "string" || !manifest.name.trim()) {
    fail(label + " must define a named Manifest V3 extension.");
  }
  if (typeof manifest.version !== "string" || !/^\d+(?:\.\d+){0,3}$/.test(manifest.version)) {
    fail(label + " must define a browser-compatible numeric version.");
  }
  if (!Array.isArray(manifest.permissions) || !deepEqual(sorted(manifest.permissions), REQUIRED_PERMISSIONS)) {
    fail(label + " permissions differ from the reviewed minimum permission set.");
  }
  if (!Array.isArray(manifest.optional_host_permissions) || !deepEqual(manifest.optional_host_permissions, OPTIONAL_HOST_PERMISSIONS)) {
    fail(label + " optional host permissions differ from the HTTPS-only scope.");
  }
  if (!deepEqual(manifest.content_security_policy, { extension_pages: EXTENSION_CSP })) {
    fail(label + " extension page CSP differs from the required local-code/TLS policy.");
  }
  if (browser === "chromium") {
    if (manifest.browser_specific_settings !== undefined) fail(label + " must not contain Firefox-only settings.");
    if (!deepEqual(manifest.background, { service_worker: "background.js" })) {
      fail(label + " must use the Chromium background service worker.");
    }
  } else {
    if (!deepEqual(manifest.background, { scripts: ["background.js"] })) {
      fail(label + " must use Firefox background scripts.");
    }
    validateGeckoSettings(manifest, label);
  }
  if (manifest.action?.default_popup !== "popup.html" || manifest.options_ui?.page !== "options.html") {
    fail(label + " must refer to packaged popup and options pages.");
  }
  if (!isObject(manifest.icons) || !deepEqual(sorted(Object.keys(manifest.icons)), ["128", "16", "48"])) {
    fail(label + " must define the three packaged extension icons.");
  }
  for (const [size, iconPath] of Object.entries(manifest.icons)) {
    if (iconPath !== "icons/icon-" + size + ".png") fail(label + " contains an unexpected icon path.");
  }
}

function manifestCommonFields(manifest) {
  const copy = { ...manifest };
  delete copy.background;
  delete copy.browser_specific_settings;
  return copy;
}

async function loadManifests(sourceDirectory) {
  const [chromiumText, firefoxText, activeText] = await Promise.all([
    readFile(path.join(sourceDirectory, "manifest.chromium.json"), "utf8"),
    readFile(path.join(sourceDirectory, "manifest.firefox.json"), "utf8"),
    readFile(path.join(sourceDirectory, "manifest.json"), "utf8"),
  ]);
  const chromium = parseJson(chromiumText, "manifest.chromium.json");
  const firefox = parseJson(firefoxText, "manifest.firefox.json");
  const active = parseJson(activeText, "manifest.json");
  validateManifest(chromium, "chromium", "manifest.chromium.json");
  validateManifest(firefox, "firefox", "manifest.firefox.json");
  if (!deepEqual(manifestCommonFields(chromium), manifestCommonFields(firefox))) {
    fail("The Chromium and Firefox source manifests differ outside their browser-specific backgrounds.");
  }
  if (!deepEqual(active, chromium) && !deepEqual(active, firefox)) {
    fail("The active manifest must match one of the two complete source manifests.");
  }
  return { chromium, firefox, active };
}

function isSafeRuntimeExtension(filePath) {
  return RUNTIME_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

async function collectRuntimeFiles(sourceDirectory) {
  const files = new Map();
async function addFile(absolutePath, relativePath) {
    const details = await stat(absolutePath);
    if (!details.isFile()) fail("Packaged runtime paths must be regular files.");
    const extension = path.posix.extname(relativePath).toLowerCase();
    if (!isSafeRuntimeExtension(relativePath)) fail("A runtime directory contains an unexpected file type.");
    const bytes = await readFile(absolutePath);
    const decoded = bytes.toString("utf8");
    if (extension === ".png") {
      if (bytes.length < 8 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
        fail("A packaged PNG asset has an invalid signature.");
      }
    } else if (/\u0000/.test(decoded)) {
      fail("A runtime text file contains a binary NUL byte.");
    }
    if (extension !== ".png" && (/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/.test(decoded) ||
        /\bAKIA[0-9A-Z]{16}\b/.test(decoded) ||
        /\b(?:gh[pousr]_[A-Za-z0-9_]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/.test(decoded) ||
        /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/i.test(decoded) ||
        /https?:\/\/[^/\s:@]+:[^/\s@]+@/i.test(decoded))) {
      fail("A runtime file contains a value matching a private-key, credential, or token pattern.");
    }
    files.set(relativePath, bytes);
  }

  for (const entry of await readdir(sourceDirectory, { withFileTypes: true })) {
    if (TOP_LEVEL_RUNTIME_FILES.has(entry.name)) {
      if (!entry.isFile()) fail("Runtime entry " + entry.name + " must be a regular file.");
      await addFile(path.join(sourceDirectory, entry.name), entry.name);
      continue;
    }
    if (!RUNTIME_DIRECTORIES.has(entry.name)) continue;
    if (!entry.isDirectory()) fail("Runtime directory " + entry.name + " must not be a symlink.");
    const directoryPath = path.join(sourceDirectory, entry.name);
    async function walk(currentPath, relativeDirectory) {
      for (const child of await readdir(currentPath, { withFileTypes: true })) {
        const childRelative = path.posix.join(relativeDirectory, child.name);
        const childAbsolute = path.join(currentPath, child.name);
        if (child.isDirectory()) {
          await walk(childAbsolute, childRelative);
        } else if (child.isFile()) {
          await addFile(childAbsolute, childRelative);
        } else {
          fail("Runtime paths cannot contain symlinks or special files.");
        }
      }
    }
    await walk(directoryPath, entry.name);
  }

  for (const requiredPath of TOP_LEVEL_RUNTIME_FILES) {
    if (!files.has(requiredPath)) fail("Missing required extension runtime file: " + requiredPath);
  }
  for (const icon of ["icons/icon-16.png", "icons/icon-48.png", "icons/icon-128.png"]) {
    if (!files.has(icon)) fail("Missing required extension icon: " + icon);
  }
  return new Map([...files.entries()].sort(([left], [right]) => compareText(left, right)));
}

function normalizeLocalReference(reference, fromFile) {
  const withoutSuffix = reference.split(/[?#]/, 1)[0];
  if (!withoutSuffix || withoutSuffix.startsWith("/") || withoutSuffix.startsWith("\\") ||
      /^[a-z][a-z0-9+.-]*:/i.test(withoutSuffix) || withoutSuffix.startsWith("//")) {
    fail("Packaged HTML/CSS/module assets must use local relative paths.");
  }
  let decoded;
  try {
    decoded = decodeURIComponent(withoutSuffix);
  } catch {
    fail("A packaged asset path contains invalid URL encoding.");
  }
  const normalized = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), decoded));
  if (normalized === ".." || normalized.startsWith("../")) fail("A packaged asset path escapes the extension folder.");
  return normalized;
}

function validateHtmlAndModules(files) {
  const hasFile = (value, fromFile) => {
    const pathName = normalizeLocalReference(value, fromFile);
    if (!files.has(pathName)) fail("A packaged page or module refers to a missing local asset: " + pathName);
  };
  for (const [filePath, bytes] of files) {
    const text = bytes.toString("utf8");
    if (filePath.endsWith(".html")) {
      for (const match of text.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
        const attrs = match[1];
        const src = attrs.match(/\bsrc\s*=\s*(["'])(.*?)\1/i);
        if (!src || match[2].trim()) fail("Extension pages must load local scripts from external files only.");
        const type = attrs.match(/\btype\s*=\s*(["'])(.*?)\1/i);
        if (type && !["module", "text/javascript"].includes(type[2].toLowerCase())) fail("An extension page uses an unsupported script type.");
        hasFile(src[2], filePath);
      }
      if (/\son[a-z]+\s*=/i.test(text)) fail("Inline event handlers are not allowed in extension pages.");
      for (const tagMatch of text.matchAll(/<(script|link|img|source|video|audio|iframe|object|embed)\b([^>]*)>/gi)) {
        const tag = tagMatch[1].toLowerCase();
        const attrs = tagMatch[2];
        const src = attrs.match(/\bsrc\s*=\s*(["'])(.*?)\1/i);
        const href = attrs.match(/\bhref\s*=\s*(["'])(.*?)\1/i);
        if (src) hasFile(src[2], filePath);
        if (href && (tag !== "link" || /\brel\s*=\s*(["'])?stylesheet\b/i.test(attrs))) {
          hasFile(href[2], filePath);
        }
      }
    }
    if (filePath.endsWith(".css")) {
      if (/@import\b/i.test(text)) fail("Packaged stylesheets cannot import external or additional stylesheets.");
      for (const match of text.matchAll(/url\(\s*(["']?)(.*?)\1\s*\)/gi)) {
        const reference = match[2].trim();
        if (reference && !reference.startsWith("#")) hasFile(reference, filePath);
      }
    }
    if (filePath.endsWith(".js")) {
      if (/\bimport\s*\(/.test(text) || /\bimportScripts\s*\(/.test(text)) {
        fail("Dynamic script loading is not allowed in packaged extension code.");
      }
      if (/\beval\s*\(|\bnew\s+Function\s*\(/.test(text)) {
        fail("Eval-based code loading is not allowed in packaged extension code.");
      }
      const importPattern = /\b(?:import|export)\s+(?:[^;"']*?\s+from\s+)?(["'])([^"']+)\1/g;
      for (const match of text.matchAll(importPattern)) hasFile(match[2], filePath);
    }
  }
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function createDeterministicZip(files) {
  const entries = [...files.entries()].sort(([left], [right]) => compareText(left, right));
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  const timestamp = 0;
  const date = 0x0021;
  for (const [filePath, contentsValue] of entries) {
    const name = Buffer.from(filePath, "utf8");
    const contents = Buffer.isBuffer(contentsValue) ? contentsValue : Buffer.from(contentsValue);
    if (name.length > 0xffff || contents.length > 0xffffffff || offset > 0xffffffff) {
      fail("A package exceeds the supported ZIP32 size limits.");
    }
    const checksum = crc32(contents);
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(timestamp, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(contents.length, 18);
    local.writeUInt32LE(contents.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    name.copy(local, 30);
    localParts.push(local, contents);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(timestamp, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(contents.length, 20);
    central.writeUInt32LE(contents.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0x81a40000, 38);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centralParts.push(central);
    offset += local.length + contents.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const entryCount = entries.length;
  if (entryCount > 0xffff || centralDirectory.length > 0xffffffff || offset > 0xffffffff) {
    fail("A package exceeds the supported ZIP32 archive limits.");
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entryCount, 8);
  end.writeUInt16LE(entryCount, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function validateOutputDirectory(outputDirectory, sourceDirectory) {
  const defaultOutput = path.join(sourceDirectory, "dist");
  if (outputDirectory === defaultOutput) return;
  const relativeToSource = path.relative(sourceDirectory, outputDirectory);
  const relativeToOutput = path.relative(outputDirectory, sourceDirectory);
  if (relativeToSource === "" || (!relativeToSource.startsWith(".." + path.sep) && relativeToSource !== "..") ||
      relativeToOutput === "" || (!relativeToOutput.startsWith(".." + path.sep) && relativeToOutput !== "..")) {
    fail("A custom output directory must be outside the extension source tree.");
  }
}

async function writeFiles(directory, files) {
  await mkdir(directory, { recursive: true });
  for (const [filePath, contents] of files) {
    const destination = path.join(directory, ...filePath.split("/"));
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, contents, { mode: 0o644 });
  }
}

function withFirefoxMetadata(sourceManifest, addonId, dataCollectionPermissions) {
  const manifest = structuredClone(sourceManifest);
  const sourceGecko = manifest.browser_specific_settings?.gecko;
  const sourceId = sourceGecko?.id;
  if (sourceId && addonId && sourceId !== addonId) {
    fail("FIREFOX_ADDON_ID does not match the ID already present in the Firefox source manifest.");
  }
  const gecko = { ...(sourceGecko ?? {}) };
  if (addonId) gecko.id = addonId;
  if (dataCollectionPermissions) gecko.data_collection_permissions = dataCollectionPermissions;
  if (Object.keys(gecko).length > 0) {
    manifest.browser_specific_settings = { ...(manifest.browser_specific_settings ?? {}), gecko };
  }
  return manifest;
}

function parseCli(argumentsList) {
  let outputDirectory = DEFAULT_OUTPUT_DIRECTORY;
  for (let index = 0; index < argumentsList.length; index += 1) {
    if (argumentsList[index] === "--output-dir" && argumentsList[index + 1]) {
      outputDirectory = path.resolve(argumentsList[index + 1]);
      index += 1;
    } else {
      fail("Usage: node scripts/package-extension.mjs [--output-dir PATH]");
    }
  }
  return outputDirectory;
}

export async function buildPackages(options = {}) {
  const repositoryRoot = path.resolve(options.repositoryRoot ?? DEFAULT_REPOSITORY_ROOT);
  const sourceDirectory = path.join(repositoryRoot, "extension");
  const outputDirectory = path.resolve(options.outputDirectory ?? path.join(sourceDirectory, "dist"));
  const environment = options.environment ?? process.env;
  validateOutputDirectory(outputDirectory, sourceDirectory);

  const addonId = validateFirefoxAddonId(environment.FIREFOX_ADDON_ID);
  const dataCollectionPermissions = parseDataCollectionPermissions(environment.FIREFOX_DATA_COLLECTION_PERMISSIONS_JSON);
  const manifests = await loadManifests(sourceDirectory);
  const runtimeFiles = await collectRuntimeFiles(sourceDirectory);
  validateHtmlAndModules(runtimeFiles);

  const chromiumManifest = Buffer.from(JSON.stringify(manifests.chromium, null, 2) + "\n");
  const firefoxManifestObject = withFirefoxMetadata(manifests.firefox, addonId, dataCollectionPermissions);
  validateManifest(firefoxManifestObject, "firefox", "built Firefox manifest");
  const firefoxManifest = Buffer.from(JSON.stringify(firefoxManifestObject, null, 2) + "\n");
  const chromiumFiles = new Map(runtimeFiles);
  const firefoxFiles = new Map(runtimeFiles);
  chromiumFiles.set("manifest.json", chromiumManifest);
  firefoxFiles.set("manifest.json", firefoxManifest);

  const chromeArchive = createDeterministicZip(chromiumFiles);
  const firefoxArchive = createDeterministicZip(firefoxFiles);
  await mkdir(outputDirectory, { recursive: true });
  await Promise.all([
    rm(path.join(outputDirectory, "chromium-unpacked"), { recursive: true, force: true }),
    rm(path.join(outputDirectory, "firefox-unpacked"), { recursive: true, force: true }),
    rm(path.join(outputDirectory, "chromium.zip"), { force: true }),
    rm(path.join(outputDirectory, "firefox-unsigned.xpi"), { force: true }),
    rm(path.join(outputDirectory, "package-report.json"), { force: true }),
    rm(path.join(outputDirectory, "SHA256SUMS"), { force: true }),
  ]);
  await Promise.all([
    writeFiles(path.join(outputDirectory, "chromium-unpacked"), chromiumFiles),
    writeFiles(path.join(outputDirectory, "firefox-unpacked"), firefoxFiles),
    writeFile(path.join(outputDirectory, "chromium.zip"), chromeArchive, { mode: 0o644 }),
    writeFile(path.join(outputDirectory, "firefox-unsigned.xpi"), firefoxArchive, { mode: 0o644 }),
  ]);

  const missingFirefoxConfiguration = [];
  const effectiveAddonId = firefoxManifestObject.browser_specific_settings?.gecko?.id;
  if (!effectiveAddonId) missingFirefoxConfiguration.push("Firefox Gecko add-on ID has not been supplied.");
  if (!dataCollectionPermissions && !getDataCollectionPermissions(firefoxManifestObject)) {
    missingFirefoxConfiguration.push("Firefox data collection consent categories have not been classified and declared.");
  }
  const report = {
    schemaVersion: 1,
    extensionVersion: manifests.firefox.version,
    sourceManifestChecks: {
      activeMatchesFirefoxOrChromium: true,
      chromiumAndFirefoxCommonFieldsMatch: true,
      chromiumBackground: "service_worker",
      firefoxBackground: "scripts",
      permissions: REQUIRED_PERMISSIONS,
      optionalHostPermissions: OPTIONAL_HOST_PERMISSIONS,
      extensionPagesCsp: EXTENSION_CSP,
    },
    runtimeFiles: [...runtimeFiles.keys()],
    artifacts: [
      { name: "chromium.zip", sha256: sha256(chromeArchive), sizeBytes: chromeArchive.length },
      { name: "firefox-unsigned.xpi", sha256: sha256(firefoxArchive), sizeBytes: firefoxArchive.length },
    ],
    firefoxSigning: {
      signed: false,
      geckoAddonIdConfigured: Boolean(effectiveAddonId),
      dataCollectionPermissionsConfigured: Boolean(getDataCollectionPermissions(firefoxManifestObject)),
      readyForMozillaSigning: missingFirefoxConfiguration.length === 0,
      blockers: missingFirefoxConfiguration,
      channel: "unlisted",
    },
    chromiumDistribution: {
      package: "chromium.zip",
      persistentInstallationChannel: "not selected or verified",
      note: "The ZIP is a store/submission package, not a universal persistent installer.",
    },
  };
  const reportBytes = Buffer.from(JSON.stringify(report, null, 2) + "\n");
  await writeFile(path.join(outputDirectory, "package-report.json"), reportBytes, { mode: 0o644 });
  const sums = [
    ["chromium.zip", chromeArchive],
    ["firefox-unsigned.xpi", firefoxArchive],
    ["package-report.json", reportBytes],
    ...[...chromiumFiles].map(([name, bytes]) => ["chromium-unpacked/" + name, bytes]),
    ...[...firefoxFiles].map(([name, bytes]) => ["firefox-unpacked/" + name, bytes]),
  ].sort(([left], [right]) => compareText(left, right))
    .map(([name, bytes]) => sha256(bytes) + "  " + name);
  await writeFile(path.join(outputDirectory, "SHA256SUMS"), sums.join("\n") + "\n", { mode: 0o644 });
  return { outputDirectory, report };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const outputDirectory = parseCli(process.argv.slice(2));
    const result = await buildPackages({ outputDirectory });
    console.log("Extension packages written to " + result.outputDirectory);
    console.log("Firefox signing ready: " + result.report.firefoxSigning.readyForMozillaSigning);
    if (result.report.firefoxSigning.blockers.length > 0) {
      for (const blocker of result.report.firefoxSigning.blockers) console.log("Signing blocker: " + blocker);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Extension packaging failed.");
    process.exitCode = 1;
  }
}
