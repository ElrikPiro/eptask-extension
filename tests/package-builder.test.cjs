const assert = require("node:assert/strict");
const { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { pathToFileURL } = require("node:url");

const repositoryRoot = path.resolve(__dirname, "..");
let buildPackages;
const builderReady = import(pathToFileURL(path.join(repositoryRoot, "scripts", "package-extension.mjs")).href)
  .then((module) => { buildPackages = module.buildPackages; });

async function temporaryDirectory() {
  return mkdtemp(path.join(os.tmpdir(), "extension-package-"));
}

function readStoredZipEntries(archive) {
  let endOffset = -1;
  for (let offset = archive.length - 22; offset >= Math.max(0, archive.length - 0xffff - 22); offset -= 1) {
    if (archive.readUInt32LE(offset) === 0x06054b50) {
      endOffset = offset;
      break;
    }
  }
  assert.notEqual(endOffset, -1, "ZIP must end with an end-of-central-directory record");
  const count = archive.readUInt16LE(endOffset + 10);
  let cursor = archive.readUInt32LE(endOffset + 16);
  const entries = new Map();
  for (let index = 0; index < count; index += 1) {
    assert.equal(archive.readUInt32LE(cursor), 0x02014b50, "central directory entry signature");
    const method = archive.readUInt16LE(cursor + 10);
    const size = archive.readUInt32LE(cursor + 24);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32);
    const localOffset = archive.readUInt32LE(cursor + 42);
    const name = archive.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    assert.equal(method, 0, "deterministic archive uses the store method");
    assert.equal(archive.readUInt32LE(localOffset), 0x04034b50, "local file header signature");
    const localNameLength = archive.readUInt16LE(localOffset + 26);
    const localExtraLength = archive.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    entries.set(name, archive.subarray(dataStart, dataStart + size));
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  assert.equal(cursor, archive.readUInt32LE(endOffset + 16) + archive.readUInt32LE(endOffset + 12));
  return entries;
}

test("builds self-contained browser folders and ZIP/XPI archives from the same runtime files", async (t) => {
  await builderReady;
  const outputDirectory = await temporaryDirectory();
  t.after(() => rm(outputDirectory, { recursive: true, force: true }));

  const { report } = await buildPackages({ outputDirectory, environment: {} });
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.sourceManifestChecks.chromiumAndFirefoxCommonFieldsMatch, true);
  assert.equal(report.firefoxSigning.readyForMozillaSigning, false);
  assert.deepEqual(report.firefoxSigning.blockers, [
    "Firefox Gecko add-on ID has not been supplied.",
    "Firefox data collection consent categories have not been classified and declared.",
  ]);

  const chromiumDir = path.join(outputDirectory, "chromium-unpacked");
  const firefoxDir = path.join(outputDirectory, "firefox-unpacked");
  const chromiumManifest = JSON.parse(await readFile(path.join(chromiumDir, "manifest.json"), "utf8"));
  const firefoxManifest = JSON.parse(await readFile(path.join(firefoxDir, "manifest.json"), "utf8"));
  assert.deepEqual(chromiumManifest.background, { service_worker: "background.js" });
  assert.deepEqual(firefoxManifest.background, { scripts: ["background.js"] });
  assert.equal(firefoxManifest.browser_specific_settings, undefined);
  assert.deepEqual(chromiumManifest.permissions, ["storage", "alarms", "notifications", "tabs"]);

  const expectedPaths = [...report.runtimeFiles, "manifest.json"].sort();
  const chromiumArchive = readStoredZipEntries(await readFile(path.join(outputDirectory, "chromium.zip")));
  const firefoxArchive = readStoredZipEntries(await readFile(path.join(outputDirectory, "firefox-unsigned.xpi")));
  assert.deepEqual([...chromiumArchive.keys()].sort(), expectedPaths);
  assert.deepEqual([...firefoxArchive.keys()].sort(), expectedPaths);
  assert.deepEqual([...await readdir(outputDirectory)].sort(), [
    "SHA256SUMS",
    "chromium-unpacked",
    "chromium.zip",
    "firefox-unpacked",
    "firefox-unsigned.xpi",
    "package-report.json",
  ]);
  await assert.rejects(stat(path.join(chromiumDir, "tests")));
  await assert.rejects(stat(path.join(firefoxDir, "README.md")));
});

test("archive bytes are reproducible and checksums cover each package and the report", async (t) => {
  await builderReady;
  const outputDirectory = await temporaryDirectory();
  t.after(() => rm(outputDirectory, { recursive: true, force: true }));

  const { report } = await buildPackages({ outputDirectory, environment: {} });
  const firstChrome = await readFile(path.join(outputDirectory, "chromium.zip"));
  const firstFirefox = await readFile(path.join(outputDirectory, "firefox-unsigned.xpi"));
  await buildPackages({ outputDirectory, environment: {} });
  assert.deepEqual(await readFile(path.join(outputDirectory, "chromium.zip")), firstChrome);
  assert.deepEqual(await readFile(path.join(outputDirectory, "firefox-unsigned.xpi")), firstFirefox);

  const sums = (await readFile(path.join(outputDirectory, "SHA256SUMS"), "utf8")).trim().split("\n");
  const expectedNames = [
    "chromium.zip",
    "firefox-unsigned.xpi",
    "package-report.json",
    ...report.runtimeFiles.map((name) => "chromium-unpacked/" + name),
    "chromium-unpacked/manifest.json",
    ...report.runtimeFiles.map((name) => "firefox-unpacked/" + name),
    "firefox-unpacked/manifest.json",
  ].sort();
  assert.deepEqual(sums.map((line) => line.slice(66)), expectedNames);
  assert.ok(sums.every((line) => /^[0-9a-f]{64}  /.test(line)));
});

test("Firefox release metadata is explicit and appears only in the Firefox package", async (t) => {
  await builderReady;
  const outputDirectory = await temporaryDirectory();
  t.after(() => rm(outputDirectory, { recursive: true, force: true }));
  const environment = {
    FIREFOX_ADDON_ID: "extension-test@example.invalid",
    FIREFOX_DATA_COLLECTION_PERMISSIONS_JSON: JSON.stringify({ required: ["none"], optional: [] }),
  };

  const { report } = await buildPackages({ outputDirectory, environment });
  const chromiumManifest = JSON.parse(await readFile(path.join(outputDirectory, "chromium-unpacked", "manifest.json"), "utf8"));
  const firefoxManifest = JSON.parse(await readFile(path.join(outputDirectory, "firefox-unpacked", "manifest.json"), "utf8"));
  assert.equal(chromiumManifest.browser_specific_settings, undefined);
  assert.equal(firefoxManifest.browser_specific_settings.gecko.id, environment.FIREFOX_ADDON_ID);
  assert.deepEqual(firefoxManifest.browser_specific_settings.gecko.data_collection_permissions, { required: ["none"], optional: [] });
  assert.equal(report.firefoxSigning.readyForMozillaSigning, true);
  assert.equal(report.firefoxSigning.signed, false);
});

test("a committed Firefox identity and consent declaration satisfy the same signing preflight", async (t) => {
  await builderReady;
  const repositoryFixture = await temporaryDirectory();
  const sourceRoot = path.join(repositoryRoot, "extension");
  const fixtureSource = path.join(repositoryFixture, "extension");
  t.after(() => rm(repositoryFixture, { recursive: true, force: true }));
  await mkdir(fixtureSource, { recursive: true });

  for (const manifestName of ["manifest.chromium.json", "manifest.firefox.json", "manifest.json"]) {
    const sourceManifest = JSON.parse(await readFile(path.join(sourceRoot, manifestName), "utf8"));
    if (manifestName !== "manifest.chromium.json") {
      sourceManifest.browser_specific_settings = {
        gecko: {
          id: "committed-test@example.invalid",
          data_collection_permissions: { required: ["websiteContent"], optional: [] },
        },
      };
    }
    await writeFile(path.join(fixtureSource, manifestName), JSON.stringify(sourceManifest, null, 2) + "\n");
  }
  for (const fileName of ["background.js", "index.html", "options.html", "popup.html"]) {
    await cp(path.join(sourceRoot, fileName), path.join(fixtureSource, fileName));
  }
  for (const directoryName of ["css", "icons", "js"]) {
    await cp(path.join(sourceRoot, directoryName), path.join(fixtureSource, directoryName), { recursive: true });
  }

  const { report } = await buildPackages({ repositoryRoot: repositoryFixture, environment: {} });
  assert.equal(report.firefoxSigning.geckoAddonIdConfigured, true);
  assert.equal(report.firefoxSigning.dataCollectionPermissionsConfigured, true);
  assert.equal(report.firefoxSigning.readyForMozillaSigning, true);
});

test("rejects invalid Gecko IDs and Firefox consent categories before building", async (t) => {
  await builderReady;
  const outputDirectory = await temporaryDirectory();
  t.after(() => rm(outputDirectory, { recursive: true, force: true }));
  await assert.rejects(
    buildPackages({ outputDirectory, environment: { FIREFOX_ADDON_ID: "bad id" } }),
    /FIREFOX_ADDON_ID/,
  );
  await assert.rejects(
    buildPackages({
      outputDirectory,
      environment: {
        FIREFOX_DATA_COLLECTION_PERMISSIONS_JSON: JSON.stringify({ required: ["technicalAndInteraction"], optional: [] }),
      },
    }),
    /technicalAndInteraction as optional/,
  );
  await assert.rejects(
    buildPackages({
      outputDirectory,
      environment: {
        FIREFOX_DATA_COLLECTION_PERMISSIONS_JSON: JSON.stringify({ required: ["none", "websiteContent"], optional: [] }),
      },
    }),
    /cannot combine none/,
  );
});

test("does not let a custom build remove or overwrite source files", async () => {
  await builderReady;
  await assert.rejects(
    buildPackages({ outputDirectory: path.join(repositoryRoot, "extension", "temporary-output"), environment: {} }),
    /outside the extension source tree/,
  );
});
