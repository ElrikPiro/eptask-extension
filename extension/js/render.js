const TASK_COLUMNS = [
  ["Descripción", (task) => task?.description],
  ["Contexto", (task) => task?.context],
  ["Inicio", (task) => task?.start],
  ["Vencimiento", (task) => task?.due],
  ["Coste restante", (task) => formatAmount(task?.totalCost)],
  ["Esfuerzo invertido", (task) => formatAmount(task?.investedEffort)],
  ["Severidad", (task) => finiteText(task?.severity, 2)],
  ["Estado", (task) => task?.status],
  ["Valor heurístico", (task) => finiteText(task?.heuristicValue, 3)],
];

export function node(tagName, text = "", className = "") {
  const element = document.createElement(tagName);
  if (text !== null && text !== undefined) element.textContent = String(text);
  if (className) element.className = className;
  return element;
}

export function panel(title, className = "") {
  const section = node("section", null, `panel${className ? ` ${className}` : ""}`);
  section.append(node("h2", title));
  return section;
}

export function emptyState(message) {
  return node("p", message, "empty");
}

export function taskTable(title, tasks, onSelect = null, { selectedId = null } = {}) {
  const section = panel(title, "full");
  if (!Array.isArray(tasks) || tasks.length === 0) {
    section.append(emptyState("No hay tareas para mostrar."));
    return section;
  }

  const wrap = node("div", null, "table-wrap");
  const table = node("table");
  const thead = node("thead");
  const headingRow = node("tr");
  for (const [label] of TASK_COLUMNS) headingRow.append(node("th", label));
  thead.append(headingRow);

  const tbody = node("tbody");
  tasks.forEach((task) => {
    const taskId = typeof task?.id === "string" ? task.id : "";
    const row = node("tr", null, onSelect && taskId ? "clickable" : "");
    if (taskId) row.dataset.taskId = taskId;
    if (taskId && taskId === selectedId) row.classList.add("selected-row");
    for (const [, getValue] of TASK_COLUMNS) {
      const value = getValue(task);
      row.append(node("td", value === "" || value === null || value === undefined ? "—" : value));
    }
    if (onSelect && taskId) {
      row.tabIndex = 0;
      row.setAttribute("role", "button");
      row.setAttribute("aria-label", `Abrir ${task?.description || "tarea"}`);
      row.addEventListener("click", () => onSelect(task));
      row.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect(task);
        }
      });
    }
    tbody.append(row);
  });

  table.append(thead, tbody);
  wrap.append(table);
  section.append(wrap);
  return section;
}

export function keyValuePanel(title, entries) {
  const section = panel(title);
  const grid = node("dl", null, "key-value-grid");
  for (const [label, value] of entries) {
    const row = node("div", null, "key-value-row");
    row.append(node("dt", label, "key"), node("dd", value ?? "—", "value"));
    grid.append(row);
  }
  section.append(grid);
  return section;
}

export function taskInfoPanel(task, title = "Información de tarea") {
  const section = panel(title, "full");
  if (!task || typeof task !== "object") {
    section.append(emptyState("Abre una tarea para ver sus detalles."));
    return section;
  }
  section.dataset.selectedTaskId = typeof task.id === "string" ? task.id : "";
  const details = node("dl", null, "key-value-grid task-info-grid");
  for (const [label, value] of [
    ["Descripción", task.description],
    ["Identificador", task.id],
    ["Contexto", task.context],
    ["Inicio", task.start],
    ["Vencimiento", task.due],
    ["Severidad", finiteText(task.severity, 2)],
    ["Estado", task.status],
    ["Coste restante", formatAmount(task.totalCost)],
    ["Esfuerzo invertido", formatAmount(task.investedEffort)],
    ["Calma", typeof task.calm === "boolean" ? (task.calm ? "Sí" : "No") : null],
    ["Proyecto", task.project],
    ["Evento que espera", task.waited],
    ["Evento que activa", task.raised],
  ]) {
    const row = node("div", null, "key-value-row");
    row.append(node("dt", label, "key"), node("dd", value ?? "—", "value"));
    details.append(row);
  }
  section.append(details);
  if (Array.isArray(task.heuristics) && task.heuristics.length) {
    const heuristicsPanel = panel("Cálculos disponibles");
    const list = node("ul", null, "heuristic-list");
    for (const item of task.heuristics) {
      const line = node("li");
      line.append(node("strong", item.name), document.createTextNode(`: ${finiteText(item.value, 3)} · ${item.comment || ""}`));
      list.append(line);
    }
    heuristicsPanel.append(list);
    section.append(heuristicsPanel);
  }
  if (task.metadata && typeof task.metadata === "object") {
    const metadataPanel = panel("Datos de la tarea");
    const list = node("ul", null, "metadata-list");
    for (const [name, value] of Object.entries(task.metadata)) {
      if (name === "id" || name === "description" || value === null || value === undefined) continue;
      list.append(node("li", `${humanField(name)}: ${displayValue(value)}`));
    }
    metadataPanel.append(list);
    section.append(metadataPanel);
  }
  return section;
}

export function formatAmount(amount) {
  if (amount === null || amount === undefined) return "";
  if (typeof amount === "string" || typeof amount === "number") return `${amount} p`;
  const value = amount?.value;
  if (value === null || value === undefined || value === "") return "";
  return `${value} ${amount?.unit === "pomodoro" ? "pomodoros" : (amount?.unit || "")}`.trim();
}

export function formatDuration(milliseconds) {
  const totalSeconds = Math.max(0, Math.floor(Number(milliseconds) / 1000));
  const units = [["d", 86400], ["h", 3600], ["m", 60], ["s", 1]];
  let remaining = totalSeconds;
  const values = [];
  for (const [suffix, size] of units) {
    const count = Math.floor(remaining / size);
    remaining %= size;
    if (count > 0 || values.length > 0) values.push(`${count}${suffix}`);
  }
  return values.join(" ") || "0s";
}

export function formatTimestamp(timestamp) {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? String(timestamp ?? "") : date.toLocaleString();
}

export function humanField(name) {
  const labels = {
    description: "Descripción",
    context: "Contexto",
    start: "Inicio",
    due: "Vencimiento",
    severity: "Severidad",
    totalCost: "Coste restante",
    investedEffort: "Esfuerzo invertido",
    status: "Estado",
    calm: "Calma",
    project: "Proyecto",
    waited: "Evento que espera",
    raised: "Evento que activa",
  };
  return labels[name] || name;
}

function finiteText(value, _digits) {
  if (typeof value !== "number" || !Number.isFinite(value)) return value ?? "";
  return String(value);
}

function displayValue(value) {
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}
