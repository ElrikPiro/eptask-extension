const mainView = document.querySelector("#main-view");
const pageHeadings = {
  tasks: ["Tareas", "Ordena lo que sigue, con el contexto que necesitas para avanzar."],
  agenda: ["Agenda", "Una vista del día para decidir qué atender y qué puede esperar."],
  stats: ["Estadísticas", "Una lectura clara del trabajo registrado y la carga pendiente."],
  events: ["Eventos", "Relaciones entre tareas, eventos y dependencias."],
  projects: ["Proyectos", "El estado y el contenido de tus proyectos."],
  detail: ["Detalle de tarea", "Información, cambios y acciones de la tarea seleccionada."],
};

const openDisclosures = new Map();
let focusRestoreId = "";
let focusRestoreNode = null;
let focusRestoreFramePending = false;
let pendingSearchFocus = false;
let pendingTaskNavigation = false;
let taskTableSequence = 0;
let chartResizeFrame = 0;
const dailyWorkCharts = new Set();

function rememberDisclosure(details, key, defaultOpen = false) {
  details.dataset.alphaKey = key;
  details.open = openDisclosures.has(key) ? openDisclosures.get(key) : defaultOpen;
  details.addEventListener("toggle", () => openDisclosures.set(key, details.open));
  return details;
}

function captureDisclosureState() {
  for (const details of mainView.querySelectorAll("details[data-alpha-key]")) {
    openDisclosures.set(details.dataset.alphaKey, details.open);
  }
}

function revealDisclosureAncestors(element) {
  let ancestor = element.parentElement;
  while (ancestor && mainView.contains(ancestor)) {
    if (ancestor.tagName === "DETAILS") {
      ancestor.open = true;
      const key = ancestor.dataset.alphaKey;
      if (key) openDisclosures.set(key, true);
    }
    ancestor = ancestor.parentElement;
  }
}

function currentQueryLabel(filterGrid) {
  const values = [];
  const filters = filterGrid.querySelector("select[multiple]");
  if (filters) {
    const selected = Array.from(filters.selectedOptions, (option) => option.textContent.trim()).filter(Boolean);
    if (selected.length) values.push(selected.length > 2 ? `${selected.slice(0, 2).join(", ")} +${selected.length - 2}` : selected.join(", "));
  }
  for (const select of filterGrid.querySelectorAll("select:not([multiple])")) {
    const selected = select.selectedOptions[0]?.textContent.trim();
    if (selected && select.value) values.push(selected);
  }
  return values.join(" · ") || "Sin filtros ni orden seleccionados";
}

function enhanceQueryControls() {
  for (const section of mainView.querySelectorAll(".query-controls")) {
    if (section.dataset.alphaQueryEnhanced === "true") continue;
    const grid = section.querySelector(".query-grid");
    if (!grid) continue;
    const search = grid.querySelector(".inline-search");
    const paging = grid.querySelector(".paging-controls");
    const fields = Array.from(grid.children).filter((child) => child.classList.contains("control-field"));
    const recognized = new Set([...fields, search, paging].filter(Boolean));
    const unknown = Array.from(grid.children).filter((child) => !recognized.has(child));
    if (!search && !fields.length) {
      section.classList.add("alpha-native-query-controls");
      const children = Array.from(grid.children);
      const grouped = [];
      for (let index = 0; index < children.length; index += 1) {
        const labelNode = children[index];
        const controlNode = children[index + 1];
        if (labelNode.tagName === "LABEL" && controlNode?.matches("input, select, textarea")) {
          const field = document.createElement("div");
          field.className = "alpha-native-query-field";
          field.append(labelNode, controlNode);
          grouped.push(field);
          index += 1;
        } else grouped.push(labelNode);
      }
      grid.replaceChildren(...grouped);
      section.dataset.alphaQueryEnhanced = "true";
      continue;
    }
    const label = search?.querySelector("label");
    const input = search?.querySelector('input[type="search"]');

    if (label) label.textContent = "Buscar en la lista";
    if (input && section.querySelector("#task-search")) input.placeholder = "Descripción, contexto, evento…";
    else if (input) input.placeholder = "Palabras separadas por espacios";

    const rebuilt = [];
    if (search) rebuilt.push(search);
    if (fields.length) {
      const details = rememberDisclosure(document.createElement("details"), `filters:${section.querySelector("#task-search") ? "tasks" : "stats"}`);
      details.className = "alpha-advanced-filters";
      const filterGrid = document.createElement("div");
      filterGrid.className = "alpha-filter-grid";
      for (const field of fields) filterGrid.append(field);
      const summary = document.createElement("summary");
      const refreshSummary = () => {
        const activeQuery = details.querySelector(".alpha-active-query");
        const labelText = currentQueryLabel(filterGrid);
        if (activeQuery) activeQuery.textContent = labelText;
        else {
          const state = document.createElement("span");
          state.className = "alpha-active-query";
          state.textContent = labelText;
          state.setAttribute("aria-live", "polite");
          summary.insertBefore(state, summary.querySelector(".alpha-disclosure-chevron"));
        }
      };
      const title = document.createElement("span");
      title.className = "alpha-disclosure-title";
      title.textContent = "Filtros y orden";
      const state = document.createElement("span");
      state.className = "alpha-active-query";
      state.setAttribute("aria-live", "polite");
      const chevron = document.createElement("span");
      chevron.className = "alpha-disclosure-chevron";
      chevron.setAttribute("aria-hidden", "true");
      chevron.textContent = "⌄";
      summary.append(title, state, chevron);
      for (const select of filterGrid.querySelectorAll("select")) select.addEventListener("change", refreshSummary);
      details.append(summary, filterGrid);
      refreshSummary();
      rebuilt.push(details);
    }
    if (paging) rebuilt.push(paging);
    rebuilt.push(...unknown);
    grid.replaceChildren(...rebuilt);
    section.dataset.alphaQueryEnhanced = "true";
  }
}

function enhanceCreateTask() {
  const form = mainView.querySelector('form[data-action-name="create-task"]');
  if (!form || form.closest(".alpha-create-disclosure")) return;
  const disclosure = rememberDisclosure(document.createElement("details"), "create-task");
  disclosure.className = "alpha-create-disclosure";
  const summary = document.createElement("summary");
  const mark = document.createElement("span");
  mark.className = "alpha-new-task-mark";
  mark.setAttribute("aria-hidden", "true");
  mark.textContent = "+";
  const label = document.createElement("span");
  label.textContent = "Nueva tarea";
  const prompt = document.createElement("span");
  prompt.className = "alpha-create-prompt";
  prompt.textContent = "Abre el formulario cuando quieras añadir una.";
  summary.append(mark, label, prompt);
  const taskListPanel = mainView.querySelector(".table-wrap")?.closest(".panel");
  const originalParent = form.parentElement;
  if (taskListPanel) taskListPanel.after(disclosure);
  else originalParent?.insertBefore(disclosure, form);
  disclosure.append(summary, form);
}

function actionLabel(formOrGroup) {
  if (formOrGroup.classList.contains("edit-task-form")) return "Editar tarea";
  if (formOrGroup.classList.contains("scheduling-actions")) return "Planificar trabajo";
  return formOrGroup.querySelector("h3")?.textContent.trim() || "Acción de tarea";
}

function actionDisclosureKey(formOrGroup) {
  const taskId = formOrGroup.dataset.taskId || formOrGroup.closest("[data-selected-task-id]")?.dataset.selectedTaskId || "tarea";
  if (formOrGroup.classList.contains("scheduling-actions")) return `action:${taskId}:schedule-task`;
  const form = formOrGroup.matches("form") ? formOrGroup : formOrGroup.querySelector("form");
  return `action:${taskId}:${form?.dataset.actionName || actionLabel(formOrGroup)}`;
}

function enhanceTaskActions() {
  for (const formsGrid of mainView.querySelectorAll(".action-forms .forms-grid")) {
    if (formsGrid.dataset.alphaActionsEnhanced === "true") continue;
    const entries = Array.from(formsGrid.children).filter((child) =>
      child.matches("form.capability-form") || child.classList.contains("scheduling-actions"),
    );
    if (!entries.length) continue;
    const rebuilt = [];
    for (const entry of Array.from(formsGrid.children)) {
      if (!entries.includes(entry)) {
        rebuilt.push(entry);
        continue;
      }
      const disclosure = rememberDisclosure(document.createElement("details"), actionDisclosureKey(entry));
      disclosure.className = "alpha-action-disclosure";
      const summary = document.createElement("summary");
      const label = document.createElement("span");
      label.className = "alpha-action-summary-label";
      label.textContent = actionLabel(entry);
      const hint = document.createElement("span");
      hint.className = "alpha-action-summary-hint";
      hint.textContent = "Abrir formulario";
      const chevron = document.createElement("span");
      chevron.className = "alpha-disclosure-chevron";
      chevron.setAttribute("aria-hidden", "true");
      chevron.textContent = "⌄";
      summary.append(label, hint, chevron);
      disclosure.append(summary, entry);
      rebuilt.push(disclosure);
    }
    formsGrid.replaceChildren(...rebuilt);
    formsGrid.dataset.alphaActionsEnhanced = "true";
  }
}

const TASK_PRIMARY_COLUMNS = ["Descripción", "Contexto", "Vencimiento", "Coste restante", "Severidad", "Estado"];
const TASK_EXTRA_COLUMNS = ["Inicio", "Esfuerzo invertido", "Valor heurístico"];

function browserTimeZone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "zona local"; }
  catch { return "zona local"; }
}

function displayTaskDate(rawValue) {
  if (typeof rawValue !== "string" || !rawValue.trim() || rawValue === "—") return rawValue;
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(rawValue.trim());
  const date = dateOnly
    ? new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]), 12)
    : new Date(rawValue);
  if (Number.isNaN(date.getTime())) return rawValue;
  const options = dateOnly
    ? { timeZone: browserTimeZone(), day: "numeric", month: "short", year: "numeric" }
    : { timeZone: browserTimeZone(), day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" };
  try { return new Intl.DateTimeFormat("es-ES", options).format(date); }
  catch { return rawValue; }
}

function translatedTaskStatus(rawValue) {
  const labels = { active: "Activa", completed: "Completada" };
  return labels[String(rawValue).trim().toLowerCase()] || rawValue;
}

function enhanceTaskTable(table) {
  if (table.dataset.alphaTaskTable === "true") return;
  const headerRow = table.querySelector("thead tr");
  if (!headerRow) return;
  const originalHeaders = Array.from(headerRow.children);
  const originalLabels = originalHeaders.map((header) => header.textContent.trim());
  const orderedLabels = [...TASK_PRIMARY_COLUMNS, ...TASK_EXTRA_COLUMNS];
  if (orderedLabels.some((label) => !originalLabels.includes(label))) return;

  const order = orderedLabels.map((label) => originalLabels.indexOf(label));
  headerRow.replaceChildren(...order.map((index) => originalHeaders[index]));
  for (const row of table.querySelectorAll("tbody tr")) {
    const originalCells = Array.from(row.children);
    if (originalCells.length !== originalHeaders.length) continue;
    row.replaceChildren(...order.map((index) => originalCells[index]));
  }
  table.classList.add("alpha-task-table");
  table.dataset.alphaTaskTable = "true";
  table.id = `alpha-task-table-${++taskTableSequence}`;

  const headers = Array.from(headerRow.children);
  for (const header of headers) {
    if (TASK_EXTRA_COLUMNS.includes(header.textContent.trim())) header.dataset.alphaExtra = "true";
  }
  for (const row of table.querySelectorAll("tbody tr")) {
    Array.from(row.children).forEach((cell, index) => {
      const label = headers[index]?.textContent.trim();
      if (!label) return;
      cell.dataset.label = label;
      if (TASK_EXTRA_COLUMNS.includes(label)) cell.dataset.alphaExtra = "true";
      if (label === "Inicio" || label === "Vencimiento") {
        const raw = cell.textContent.trim();
        if (raw && raw !== "—") {
          cell.title = raw;
          cell.textContent = displayTaskDate(raw);
          cell.setAttribute("aria-label", `${label}: ${cell.textContent}. Valor recibido: ${raw}`);
        }
      } else if (label === "Estado") {
        const raw = cell.textContent.trim();
        const translated = translatedTaskStatus(raw);
        if (translated !== raw) {
          cell.title = raw;
          cell.textContent = translated;
          cell.setAttribute("aria-label", `${label}: ${translated}. Valor recibido: ${raw}`);
        }
      }
    });
  }

  const panel = table.closest(".panel");
  if (!panel) return;
  const tools = document.createElement("div");
  tools.className = "alpha-table-tools";
  const caption = document.createElement("p");
  caption.className = "alpha-date-caption";
  caption.textContent = `Fechas en ${browserTimeZone()}. El valor recibido aparece al pasar el cursor.`;
  const button = document.createElement("button");
  button.className = "alpha-columns-toggle secondary";
  button.type = "button";
  button.textContent = "Más columnas";
  button.setAttribute("aria-controls", table.id);
  button.setAttribute("aria-pressed", "false");
  button.addEventListener("click", () => {
    const expanded = table.classList.toggle("show-extra-columns");
    button.setAttribute("aria-pressed", String(expanded));
    button.textContent = expanded ? "Ocultar columnas extra" : "Más columnas";
  });
  tools.append(caption, button);
  table.closest(".table-wrap")?.before(tools);
}

function enhanceTaskTables() {
  for (const table of mainView.querySelectorAll(".table-wrap table")) {
    if (table.querySelector("tbody tr[data-task-id]") || Array.from(table.querySelectorAll("thead th")).length === 9) {
      enhanceTaskTable(table);
    } else {
      const labels = Array.from(table.querySelectorAll("thead th"), (header) => header.textContent.trim());
      for (const row of table.querySelectorAll("tbody tr")) {
        Array.from(row.children).forEach((cell, index) => {
          if (labels[index]) cell.dataset.label = labels[index];
        });
      }
    }
  }
}

function validIsoDay(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [, year, month, day] = match.map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function parseDailyWorkList(list) {
  const items = Array.from(list.children, (item) => item.textContent.trim());
  if (!items.length || (items.length === 1 && items[0] === "Sin registros.")) return [];
  const parsed = [];
  for (const item of items) {
    const match = /^(\d{4}-\d{2}-\d{2}):\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)\s+pomodoros$/i.exec(item);
    if (!match || !validIsoDay(match[1])) return null;
    const amount = Number(match[2]);
    if (!Number.isFinite(amount)) return null;
    parsed.push({ day: match[1], amount });
  }
  return parsed.sort((left, right) => left.day.localeCompare(right.day));
}

function formatDailyAmount(value) {
  return String(value).replace(".", ",");
}

function formatDailyTick(value, range) {
  if (value === 0) return "0";
  if (Math.abs(value) < 1e-10) return value.toExponential(2).replace(".", ",");
  const divisions = range / 4 || 1;
  const precision = Math.min(12, Math.max(0, Math.ceil(-Math.log10(divisions)) + 1));
  return new Intl.NumberFormat("es-ES", { maximumFractionDigits: precision }).format(value);
}

function formatDailyAxisDate(day, includeYear = false) {
  const date = new Date(`${day}T12:00:00Z`);
  const options = { timeZone: "UTC", day: "numeric", month: "short" };
  if (includeYear) options.year = "2-digit";
  try { return new Intl.DateTimeFormat("es-ES", options).format(date).replace(".", ""); }
  catch { return day; }
}

function addUtcDays(day, amount) {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

function daysBetweenUtc(startDay, endDay) {
  return Math.round((Date.parse(`${endDay}T12:00:00Z`) - Date.parse(`${startDay}T12:00:00Z`)) / 86400000);
}

function localIsoDay() {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function startOfWeek(day) {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  return date.toISOString().slice(0, 10);
}

function startOfMonth(day) {
  return `${day.slice(0, 7)}-01`;
}

function advanceBucket(day, grouping) {
  if (grouping === "day") return addUtcDays(day, 1);
  if (grouping === "week") return addUtcDays(day, 7);
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() + 1, 1);
  return date.toISOString().slice(0, 10);
}

function bucketKey(day, grouping) {
  if (grouping === "week") return startOfWeek(day);
  if (grouping === "month") return startOfMonth(day);
  return day;
}

function decimalParts(value) {
  const [coefficient, exponentText] = String(value).toLowerCase().split("e");
  const exponent = Number(exponentText || 0);
  const negative = coefficient.startsWith("-");
  const unsigned = coefficient.replace(/^[+-]/, "");
  const [whole, fraction = ""] = unsigned.split(".");
  let units = BigInt(`${whole}${fraction}` || "0") * (negative ? -1n : 1n);
  let scale = fraction.length - exponent;
  if (scale < 0) {
    units *= 10n ** BigInt(-scale);
    scale = 0;
  }
  return { units, scale };
}

function sumDailyAmounts(records) {
  const parts = records.map(({ amount }) => decimalParts(amount));
  const scale = Math.max(0, ...parts.map((part) => part.scale));
  const units = parts.reduce((sum, part) => sum + part.units * (10n ** BigInt(scale - part.scale)), 0n);
  const negative = units < 0n;
  const absolute = (negative ? -units : units).toString().padStart(scale + 1, "0");
  const integer = scale ? absolute.slice(0, -scale) : absolute;
  const fraction = scale ? absolute.slice(-scale).replace(/0+$/, "") : "";
  const display = `${negative ? "-" : ""}${integer}${fraction ? `.${fraction}` : ""}`;
  return { amount: Number(display), display };
}

function makeDailyBuckets(days, chartStart, chartEnd, grouping) {
  const byBucket = new Map();
  for (const record of days) {
    const key = bucketKey(record.day, grouping);
    if (!byBucket.has(key)) byBucket.set(key, []);
    byBucket.get(key).push(record);
  }

  let bucketStart = bucketKey(chartStart, grouping);
  const finalBucket = bucketKey(chartEnd, grouping);
  const buckets = [];
  while (bucketStart <= finalBucket) {
    const records = byBucket.get(bucketStart) || [];
    let bucketEnd = bucketStart;
    if (grouping === "week") bucketEnd = addUtcDays(bucketStart, 6);
    else if (grouping === "month") bucketEnd = addUtcDays(advanceBucket(bucketStart, "month"), -1);
    const total = records.length ? sumDailyAmounts(records) : null;
    buckets.push({
      start: bucketStart,
      end: bucketEnd,
      records,
      amount: total?.amount ?? null,
      displayAmount: total?.display ?? "",
    });
    bucketStart = advanceBucket(bucketStart, grouping);
  }
  return buckets;
}

function dailyGroupingFor(range, chartStart, chartEnd) {
  if (range === "30") return "day";
  const calendarDays = daysBetweenUtc(chartStart, chartEnd) + 1;
  if (calendarDays <= 45) return "day";
  if (calendarDays <= 180) return "week";
  return "month";
}

function rangeLabel(range) {
  if (range === "30") return "Últimos 30 días";
  if (range === "90") return "Últimos 90 días";
  return "Historial completo";
}

function groupingLabel(grouping) {
  return grouping === "week" ? "semanas" : grouping === "month" ? "meses" : "días";
}

function formatBucketTitle(bucket, grouping) {
  if (grouping === "month") return new Intl.DateTimeFormat("es-ES", { timeZone: "UTC", month: "long", year: "numeric" }).format(new Date(`${bucket.start}T12:00:00Z`));
  if (grouping === "week") return `Semana del ${formatDailyAxisDate(bucket.start, true)} al ${formatDailyAxisDate(bucket.end, true)}`;
  return bucket.start;
}

function svgElement(name, attributes = {}, textContent = "") {
  const element = document.createElementNS("http://www.w3.org/2000/svg", name);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
  if (textContent) element.textContent = textContent;
  return element;
}

function buildDailyWorkSvg(figure, buckets, rangeStart, rangeEnd, grouping) {
  const left = 56;
  const right = 18;
  const top = 28;
  const plotHeight = 188;
  const bottom = 66;
  const maxWidth = 12000;
  const targetStep = 28;
  const viewportWidth = figure.querySelector(".alpha-work-chart-scroll")?.clientWidth || figure.clientWidth || 620;
  const width = buckets.length <= 45
    ? viewportWidth
    : Math.max(viewportWidth, Math.min(maxWidth, left + right + buckets.length * targetStep));
  const height = top + plotHeight + bottom;
  const plotWidth = width - left - right;
  let rawMin = 0;
  let rawMax = 0;
  for (const { amount } of buckets) {
    if (amount === null) continue;
    rawMin = Math.min(rawMin, amount);
    rawMax = Math.max(rawMax, amount);
  }
  const span = rawMax - rawMin;
  const pad = span ? span * 0.09 : 0.5;
  const domainMin = span ? (rawMin < 0 ? rawMin - pad : 0) : -0.5;
  const domainMax = span ? (rawMax > 0 ? rawMax + pad : 0) : 0.5;
  const domainSpan = domainMax - domainMin || 1;
  const yFor = (value) => top + ((domainMax - value) / domainSpan) * plotHeight;
  const zeroY = yFor(0);
  const svg = svgElement("svg", {
    class: "alpha-work-chart-svg",
    width,
    height,
    viewBox: `0 0 ${width} ${height}`,
    role: "img",
    "aria-labelledby": "alpha-daily-work-title alpha-daily-work-description",
    focusable: "false",
    "font-family": "system-ui, -apple-system, Segoe UI, Arial, sans-serif",
  });
  svg.append(
    svgElement("title", { id: "alpha-daily-work-title" }, "Pomodoros registrados por día"),
    svgElement("desc", { id: "alpha-daily-work-description" }, "Gráfica cronológica de los registros agrupados por periodo. Los periodos sin registro se dejan sin barra y no representan cero. La lista desplegable contiene todos los valores diarios exactos del historial."),
  );
  svg.append(svgElement("text", { class: "alpha-work-axis-title", x: left, y: 14, fill: "#626b61", "font-family": "system-ui, -apple-system, Segoe UI, Arial, sans-serif", "font-size": 11, "font-weight": 700 }, "pomodoros"));

  const tickCount = 4;
  for (let index = 0; index <= tickCount; index += 1) {
    const value = domainMin + (domainSpan * index) / tickCount;
    const y = yFor(value);
    svg.append(svgElement("line", {
      class: "alpha-work-grid-line",
      x1: left,
      x2: width - right,
      y1: y,
      y2: y,
      stroke: "#e9e4da",
      "stroke-width": 1,
    }));
    svg.append(svgElement("text", {
      class: "alpha-work-y-label",
      x: left - 10,
      y: y + 4,
      "text-anchor": "end",
      fill: "#555f55",
      "font-family": "system-ui, -apple-system, Segoe UI, Arial, sans-serif",
      "font-size": 11,
    }, formatDailyTick(value, domainSpan)));
  }
  svg.append(svgElement("line", {
    class: "alpha-work-grid-line is-zero",
    x1: left,
    x2: width - right,
    y1: zeroY,
    y2: zeroY,
    stroke: "#8e806c",
    "stroke-width": 1.6,
  }));

  if (!buckets.some(({ amount }) => amount !== null)) {
    svg.append(svgElement("text", {
      x: left + plotWidth / 2,
      y: top + plotHeight / 2,
      "text-anchor": "middle",
      fill: "#626b61",
      "font-family": "system-ui, -apple-system, Segoe UI, Arial, sans-serif",
      "font-size": 13,
    }, "Sin registros en este periodo"));
  }

  const years = new Set([rangeStart.slice(0, 4), rangeEnd.slice(0, 4)]);
  const step = plotWidth / Math.max(1, buckets.length);
  buckets.forEach((bucket, index) => {
    const centerX = left + step * (index + 0.5);
    const { amount, records } = bucket;
    if (amount === null) return;
    const valueY = yFor(amount);
    const topY = Math.min(zeroY, valueY);
    const barHeight = Math.abs(zeroY - valueY);
    const group = svgElement("g", { class: "alpha-work-bar-group" });
    const titleAmount = bucket.displayAmount;
    const amountUnit = Math.abs(amount) === 1 ? "pomodoro" : "pomodoros";
    const label = grouping === "day"
      ? `${bucket.start}: ${formatDailyAmount(titleAmount)} ${amountUnit}`
      : `${formatBucketTitle(bucket, grouping)}: ${formatDailyAmount(titleAmount)} ${amountUnit} en ${records.length} ${records.length === 1 ? "día" : "días"} con registro`;
    const title = svgElement("title", {}, label);
    group.append(title);
    if (amount === 0) {
      group.append(svgElement("circle", {
        class: "alpha-work-zero-marker",
        cx: centerX,
        cy: zeroY,
        r: 4,
        "aria-label": label,
        fill: "#d29a4f",
        stroke: "#fffefa",
        "stroke-width": 2,
      }));
    } else {
      const barWidth = Math.min(34, Math.max(2, step * 0.62));
      group.append(svgElement("rect", {
        class: amount < 0 ? "alpha-work-bar is-negative" : "alpha-work-bar",
        x: centerX - barWidth / 2,
        y: topY,
        width: barWidth,
        height: Math.max(2, barHeight),
        rx: Math.min(6, barWidth / 2),
        "aria-label": label,
        fill: amount < 0 ? "#cc785e" : "#39745a",
        stroke: amount < 0 ? "#a9553f" : "#245941",
        "stroke-width": 0.75,
      }));
    }
    svg.append(group);
  });

  const labelCount = Math.min(8, buckets.length, Math.max(2, Math.floor(plotWidth / 80)));
  const labelIndexes = new Set();
  if (buckets.length === 1) labelIndexes.add(0);
  else for (let index = 0; index < labelCount; index += 1) labelIndexes.add(Math.round(index * (buckets.length - 1) / (labelCount - 1)));
  for (const index of [...labelIndexes].sort((leftIndex, rightIndex) => leftIndex - rightIndex)) {
    const centerX = left + step * (index + 0.5);
    const bucket = buckets[index];
    const axisDate = grouping === "month" ? bucket.start : bucket.start;
    svg.append(svgElement("line", {
      class: "alpha-work-date-tick",
      x1: centerX,
      x2: centerX,
      y1: top + plotHeight,
      y2: top + plotHeight + 5,
      stroke: "#bdb4a7",
      "stroke-width": 1,
    }));
    svg.append(svgElement("text", {
      class: "alpha-work-x-label",
      x: centerX,
      y: top + plotHeight + 23,
      "text-anchor": "middle",
      fill: "#555f55",
      "font-family": "system-ui, -apple-system, Segoe UI, Arial, sans-serif",
      "font-size": 11,
    }, formatDailyAxisDate(axisDate, years.size > 1)));
  }
  return svg;
}

function selectedChartView(figure) {
  const days = figure._alphaDailyWork;
  const latestDay = days[days.length - 1].day;
  const range = figure.querySelector("#alpha-work-range")?.value || "30";
  const allHistory = range === "all";
  const rangeEnd = allHistory ? latestDay : localIsoDay();
  const rangeStart = allHistory ? days[0].day : addUtcDays(rangeEnd, -(Number(range) - 1));
  const visibleDays = days.filter(({ day }) => day >= rangeStart && day <= rangeEnd);
  const groupingControl = figure.querySelector("#alpha-work-grouping")?.value || "auto";
  const grouping = groupingControl === "auto" ? dailyGroupingFor(range, rangeStart, rangeEnd) : groupingControl;
  const buckets = makeDailyBuckets(visibleDays, rangeStart, rangeEnd, grouping);
  return { range, rangeStart, rangeEnd, visibleDays, grouping, buckets };
}

function renderDailyWorkChart(figure) {
  const scroll = figure.querySelector(".alpha-work-chart-scroll");
  const current = scroll?.querySelector("svg.alpha-work-chart-svg");
  if (!scroll) return;
  const view = selectedChartView(figure);
  const chart = buildDailyWorkSvg(figure, view.buckets, view.rangeStart, view.rangeEnd, view.grouping);
  if (current) current.replaceWith(chart);
  else scroll.append(chart);

  const rangeText = view.range === "all"
    ? `Historial completo: ${formatDailyAxisDate(view.rangeStart, true)} – ${formatDailyAxisDate(view.rangeEnd, true)}`
    : `${rangeLabel(view.range)}: ${formatDailyAxisDate(view.rangeStart, true)} – ${formatDailyAxisDate(view.rangeEnd, true)}`;
  const periodsWithData = view.buckets.filter(({ records }) => records.length).length;
  const rangeCaption = `${rangeText} · ${view.visibleDays.length} ${view.visibleDays.length === 1 ? "día con registro" : "días con registro"} · ${periodsWithData} ${groupingLabel(view.grouping)} con registro`;
  const caption = figure.querySelector(".alpha-work-chart-caption");
  if (caption) caption.textContent = rangeCaption;
  const note = figure.querySelector(".alpha-work-chart-note");
  if (note) note.textContent = `Cada barra suma los registros del periodo seleccionado. Los periodos sin registro quedan vacíos; no se interpretan como cero. Agrupación: ${groupingLabel(view.grouping)}.`;
  const dataNote = figure.querySelector(".alpha-work-chart-data-note");
  if (dataNote) dataNote.textContent = `Se muestran los ${figure._alphaDailyWork.length} valores diarios exactos de todo el historial, aunque el gráfico tenga otro periodo seleccionado.`;
}

function enhanceDailyWorkChart() {
  for (const chart of dailyWorkCharts) {
    if (!chart.isConnected) dailyWorkCharts.delete(chart);
  }
  for (const panel of mainView.querySelectorAll(".panel.full")) {
    if (panel.dataset.alphaWorkChart === "true") continue;
    const heading = panel.querySelector(":scope > h2");
    const sourceList = panel.querySelector(":scope > ul");
    if (heading?.textContent.trim() !== "Trabajo registrado por día" || !sourceList) continue;
    const days = parseDailyWorkList(sourceList);
    if (days === null) continue;
    panel.dataset.alphaWorkChart = "true";
    if (!days.length) {
      const empty = document.createElement("p");
      empty.className = "alpha-work-chart-empty";
      empty.textContent = "Todavía no hay registros diarios para representar.";
      sourceList.replaceWith(empty);
      continue;
    }

    const figure = document.createElement("figure");
    figure.className = "alpha-work-chart";
    figure.dataset.dayCount = String(days.length);
    figure._alphaDailyWork = days;

    const controls = document.createElement("div");
    controls.className = "alpha-work-chart-controls";
    const rangeField = document.createElement("div");
    rangeField.className = "alpha-work-chart-field";
    const rangeLabel = document.createElement("label");
    rangeLabel.htmlFor = "alpha-work-range";
    rangeLabel.textContent = "Periodo del gráfico";
    const rangeSelect = document.createElement("select");
    rangeSelect.id = "alpha-work-range";
    rangeSelect.setAttribute("aria-controls", "alpha-daily-work-scroll");
    for (const [value, labelText] of [["30", "Últimos 30 días"], ["90", "Últimos 90 días"], ["all", "Todo el historial"]]) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = labelText;
      rangeSelect.append(option);
    }
    rangeSelect.value = "30";
    rangeField.append(rangeLabel, rangeSelect);

    const groupingField = document.createElement("div");
    groupingField.className = "alpha-work-chart-field";
    const groupingLabelNode = document.createElement("label");
    groupingLabelNode.htmlFor = "alpha-work-grouping";
    groupingLabelNode.textContent = "Agrupar por";
    const groupingSelect = document.createElement("select");
    groupingSelect.id = "alpha-work-grouping";
    groupingSelect.setAttribute("aria-controls", "alpha-daily-work-scroll");
    for (const [value, labelText] of [["auto", "Automático"], ["day", "Día"], ["week", "Semana"], ["month", "Mes"]]) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = labelText;
      groupingSelect.append(option);
    }
    groupingSelect.value = "auto";
    groupingField.append(groupingLabelNode, groupingSelect);
    controls.append(rangeField, groupingField);

    const caption = document.createElement("figcaption");
    caption.className = "alpha-work-chart-caption";
    const note = document.createElement("p");
    note.className = "alpha-work-chart-note";
    const scroll = document.createElement("div");
    scroll.className = "alpha-work-chart-scroll";
    scroll.id = "alpha-daily-work-scroll";
    scroll.tabIndex = 0;
    scroll.setAttribute("role", "region");
    scroll.setAttribute("aria-label", "Gráfica de pomodoros por periodo. Desplázate horizontalmente si es necesario.");
    const legend = document.createElement("div");
    legend.className = "alpha-work-chart-legend";
    const positiveLegend = document.createElement("span");
    const positiveSwatch = document.createElement("i");
    positiveSwatch.className = "alpha-work-chart-swatch";
    positiveSwatch.setAttribute("aria-hidden", "true");
    positiveLegend.append(positiveSwatch, document.createTextNode("Registro positivo"));
    const negativeLegend = document.createElement("span");
    const negativeSwatch = document.createElement("i");
    negativeSwatch.className = "alpha-work-chart-swatch is-negative";
    negativeSwatch.setAttribute("aria-hidden", "true");
    negativeLegend.append(negativeSwatch, document.createTextNode("Ajuste negativo"));
    const zeroLegend = document.createElement("span");
    const zeroSwatch = document.createElement("i");
    zeroSwatch.className = "alpha-work-chart-swatch is-zero";
    zeroSwatch.setAttribute("aria-hidden", "true");
    zeroLegend.append(zeroSwatch, document.createTextNode("Cero o neto cero"));
    legend.append(positiveLegend, negativeLegend, zeroLegend);
    figure.append(caption, controls, note, legend, scroll);

    const dataDisclosure = document.createElement("details");
    dataDisclosure.className = "alpha-work-chart-data";
    const summary = document.createElement("summary");
    summary.textContent = `Ver valores diarios exactos (${days.length})`;
    const dataNote = document.createElement("p");
    dataNote.className = "alpha-work-chart-data-note";
    const dataList = document.createElement("ul");
    for (const { day, amount } of days) {
      const item = document.createElement("li");
      item.append(
        document.createElement("time"),
        document.createTextNode(` · ${formatDailyAmount(amount)} ${Math.abs(amount) === 1 ? "pomodoro" : "pomodoros"}`),
      );
      item.querySelector("time").dateTime = day;
      item.querySelector("time").textContent = day;
      dataList.append(item);
    }
    dataDisclosure.append(summary, dataNote, dataList);
    figure.append(dataDisclosure);
    sourceList.replaceWith(figure);
    dailyWorkCharts.add(figure);
    const onControlChange = () => renderDailyWorkChart(figure);
    rangeSelect.addEventListener("change", onControlChange);
    groupingSelect.addEventListener("change", onControlChange);
    renderDailyWorkChart(figure);
  }
}

function resizeDailyWorkCharts() {
  if (chartResizeFrame) return;
  chartResizeFrame = requestAnimationFrame(() => {
    chartResizeFrame = 0;
    for (const figure of dailyWorkCharts) {
      if (!figure.isConnected) {
        dailyWorkCharts.delete(figure);
        continue;
      }
      renderDailyWorkChart(figure);
    }
  });
}

function updateNotificationCount() {
  const list = document.querySelector("#notification-list");
  const count = document.querySelector("#alpha-notification-count");
  if (!list || !count) return;
  const total = Array.from(list.children).filter((item) => !item.classList.contains("empty") && !item.classList.contains("error-text")).length;
  count.textContent = String(total);
  count.setAttribute("aria-label", `${total} ${total === 1 ? "aviso guardado" : "avisos guardados"}`);
}

function updatePageHeading() {
  const active = document.querySelector('[data-view][aria-current="page"]');
  const view = pageHeadings[active?.dataset.view] ? active.dataset.view : "tasks";
  const [title, description] = pageHeadings[view];
  const heading = document.querySelector("#alpha-page-title");
  const intro = document.querySelector("#alpha-view-description");
  if (heading) heading.textContent = title;
  if (intro) intro.textContent = description;
  document.title = `${title} · ElrikPiro`;
}

function enhanceMainView() {
  enhanceQueryControls();
  enhanceCreateTask();
  enhanceTaskActions();
  enhanceTaskTables();
  enhanceDailyWorkChart();
  updateNotificationCount();
  updatePageHeading();
  applyFocusRestore();
  applyPendingSearchFocus();
}

function applyFocusRestore() {
  if (!focusRestoreId || focusRestoreFramePending) return;
  const focusTarget = Array.from(mainView.querySelectorAll("[id]")).find((element) => element.id === focusRestoreId);
  if (!focusTarget || focusTarget === focusRestoreNode || focusTarget.disabled) return;
  revealDisclosureAncestors(focusTarget);
  focusRestoreFramePending = true;
  requestAnimationFrame(() => {
    focusRestoreFramePending = false;
    const currentTarget = Array.from(mainView.querySelectorAll("[id]")).find((element) => element.id === focusRestoreId);
    if (!currentTarget || currentTarget === focusRestoreNode || currentTarget.disabled) return;
    revealDisclosureAncestors(currentTarget);
    currentTarget.focus({ preventScroll: true });
    if (document.activeElement === currentTarget) {
      focusRestoreId = "";
      focusRestoreNode = null;
    }
  });
}

function focusTaskSearch() {
  if (document.querySelector("#connection-badge")?.classList.contains("offline")) {
    pendingSearchFocus = false;
    pendingTaskNavigation = false;
    document.querySelector("#open-options")?.focus();
    return;
  }
  const existing = mainView.querySelector("#task-search, #stats-search");
  if (existing) {
    if (existing.disabled) {
      pendingSearchFocus = true;
      return;
    }
    pendingSearchFocus = false;
    pendingTaskNavigation = false;
    existing.focus();
    return;
  }
  const taskView = document.querySelector('[data-view="tasks"]');
  if (taskView && !taskView.disabled) {
    pendingSearchFocus = true;
    pendingTaskNavigation = false;
    taskView.click();
    applyPendingSearchFocus();
  } else if (taskView) {
    pendingSearchFocus = true;
    pendingTaskNavigation = true;
  } else {
    document.querySelector("#open-options")?.focus();
  }
}

function applyPendingSearchFocus() {
  if (!pendingSearchFocus) return;
  if (document.querySelector("#connection-badge")?.classList.contains("offline")) {
    pendingSearchFocus = false;
    pendingTaskNavigation = false;
    document.querySelector("#open-options")?.focus();
    return;
  }
  const search = mainView.querySelector("#task-search, #stats-search");
  if (!search) {
    const taskView = document.querySelector('[data-view="tasks"]');
    if (pendingTaskNavigation && taskView && !taskView.disabled) {
      pendingTaskNavigation = false;
      taskView.click();
    }
    return;
  }
  if (search.disabled) return;
  pendingSearchFocus = false;
  pendingTaskNavigation = false;
  requestAnimationFrame(() => search.focus());
}

document.querySelector("#alpha-search-trigger")?.addEventListener("click", focusTaskSearch);
mainView.addEventListener("change", (event) => {
  const target = event.target;
  if (target instanceof HTMLElement && target.id && target.matches("select, input[type='date']")) {
    if (target.closest(".alpha-work-chart")) return;
    captureDisclosureState();
    focusRestoreId = target.id;
    focusRestoreNode = target;
  }
}, true);
mainView.addEventListener("submit", (event) => {
  if (event.target.matches(".inline-search")) {
    const search = event.target.querySelector('input[type="search"]');
    captureDisclosureState();
    focusRestoreId = search?.id || "";
    focusRestoreNode = search || null;
  }
}, true);
document.addEventListener("click", (event) => {
  if (event.target.closest("[data-view]")) requestAnimationFrame(updatePageHeading);
});
document.addEventListener("keydown", (event) => {
  if (event.defaultPrevented || event.isComposing) return;
  if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "k") return;
  event.preventDefault();
  focusTaskSearch();
});
window.addEventListener("resize", resizeDailyWorkCharts, { passive: true });

const viewObserver = new MutationObserver((records) => {
  if (records.some((record) => record.type === "childList")) enhanceMainView();
  else {
    applyFocusRestore();
    applyPendingSearchFocus();
  }
});
viewObserver.observe(mainView, { childList: true, subtree: true, attributes: true, attributeFilter: ["disabled", "open"] });
const notificationObserver = new MutationObserver(updateNotificationCount);
notificationObserver.observe(document.querySelector("#notification-list"), { childList: true, subtree: true });
const navigationObserver = new MutationObserver(applyPendingSearchFocus);
navigationObserver.observe(document.querySelector(".alpha-navigation"), { attributes: true, subtree: true, attributeFilter: ["disabled"] });
enhanceMainView();
