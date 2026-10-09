const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const source = fs.readFileSync(path.join(__dirname, "../js/scheduling.js"), "utf8");
const modulePromise = import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
const configuration = { algorithm: "heuristic-v1", dailyDedication: 2 };
const task = { description: "Report", start: "2026-10-05T09:00:00Z", due: "2026-11-04T09:00:00Z", totalCost: { value: "10" } };

test("automatic scheduling changes only severity and uses total cost, including overdue tasks", async () => {
  const { schedulingPreview } = await modulePromise;
  const preview = schedulingPreview(task, configuration, "auto", "", Date.parse(task.start));
  assert.equal(preview.severity, 2.5);
  assert.equal(preview.due, task.due);
  assert.equal(preview.count, 1);
  assert.equal(schedulingPreview(task, configuration, "auto", "", Date.parse(task.due) + 1).severity, 1);
});

test("daily effort previews the existing backend formulas for normal and split tasks", async () => {
  const { schedulingPreview } = await modulePromise;
  const normal = schedulingPreview(task, configuration, "daily", "1p");
  assert.equal(normal.count, 1);
  assert.equal(normal.severity, 2);
  assert.equal(normal.due, "2026-10-30T09:00:00.000Z");
  const split = schedulingPreview(task, configuration, "daily", "4p");
  assert.equal(split.count, 2);
  assert.equal(split.severity, 2);
  assert.equal(split.cost, 5);
  assert.equal(split.due, "2026-10-18T09:00:00.000Z");
  const fractional = schedulingPreview({ ...task, totalCost: { value: "3.04" } }, configuration, "daily", "6p");
  assert.equal(fractional.cost, 1.04);
  assert.equal(fractional.days, 3);
});

test("duration parsing follows minute rounding while bare numbers represent pomodoros", async () => {
  const { dailyEffort } = await modulePromise;
  assert.equal(dailyEffort("30m"), 1.2);
  assert.equal(dailyEffort("01:00"), 2.4);
  assert.equal(dailyEffort("1s"), 0.04);
  assert.equal(dailyEffort("1.5"), 1.5);
  for (const value of ["", "auto", "invalid", "0p", "-1p", "Infinity"]) assert.throws(() => dailyEffort(value));
});

test("preview never invents configuration or accepts invalid task fields", async () => {
  const { schedulingPreview } = await modulePromise;
  assert.throws(() => schedulingPreview(task, null, "auto", ""), /Actualiza el backend/);
  assert.throws(() => schedulingPreview(task, { ...configuration, dailyDedication: 0 }, "auto", ""), /mayor que cero/);
  assert.throws(() => schedulingPreview({ ...task, start: "invalid" }, configuration, "daily", "1p"), /fechas válidas/);
});
