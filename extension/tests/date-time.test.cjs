const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const source = fs.readFileSync(path.join(__dirname, "../js/date-time.js"), "utf8");
const modulePromise = import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);

test("selected IANA zones convert to UTC independently of the browser zone", async () => {
  const { dateTimeToIso } = await modulePromise;
  assert.equal(dateTimeToIso("2026-12-10T15:45[America/New_York]"), "2026-12-10T20:45:00.000Z");
  assert.equal(dateTimeToIso("2026-07-10T15:45[America/New_York]"), "2026-07-10T19:45:00.000Z");
  assert.equal(dateTimeToIso("2026-12-10T15:45:12.123[Asia/Kolkata]"), "2026-12-10T10:15:12.123Z");
  assert.equal(dateTimeToIso("2026-12-10T15:45[Asia/Kathmandu]"), "2026-12-10T10:00:00.000Z");
  assert.equal(dateTimeToIso("2026-12-10T00:00[UTC]"), "2026-12-10T00:00:00.000Z");
});

test("nonexistent spring times and impossible dates are rejected", async () => {
  const { dateTimeToIso } = await modulePromise;
  assert.throws(() => dateTimeToIso("2026-03-29T02:30[Europe/Madrid]"), /no existe/);
  assert.throws(() => dateTimeToIso("2026-03-08T02:30[America/New_York]"), /no existe/);
  assert.throws(() => dateTimeToIso("2026-02-30T12:30[UTC]"), /válida/);
  assert.throws(() => dateTimeToIso("2026-12-10T[UTC]"), /válida/);
});

test("repeated autumn hours resolve consistently to their first occurrence", async () => {
  const { dateTimeToIso } = await modulePromise;
  assert.equal(dateTimeToIso("2026-10-25T02:30[Europe/Madrid]"), "2026-10-25T00:30:00.000Z");
  assert.equal(dateTimeToIso("2026-11-01T01:30[America/New_York]"), "2026-11-01T05:30:00.000Z");
});

test("zoned and incomplete drafts keep the wall time and selected zone", async () => {
  const { dateTimeParts, zonedControlValue } = await modulePromise;
  assert.deepEqual(dateTimeParts("2026-12-10T15:45[Asia/Tokyo]"), { local: "2026-12-10T15:45:00.000", timeZone: "Asia/Tokyo" });
  assert.deepEqual(dateTimeParts("T15:45[Asia/Tokyo]"), { local: "T15:45", timeZone: "Asia/Tokyo" });
  assert.equal(zonedControlValue("2026-12-10T15:45", "Asia/Tokyo"), "2026-12-10T15:45:00.000[Asia/Tokyo]");
});
