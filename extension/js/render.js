const TASK_COLUMNS = [
  ["Descripción", "description"],
  ["Contexto", "context"],
  ["Inicio", "start"],
  ["Vencimiento", "due"],
  ["Coste restante (p)", "total_cost"],
  ["Invertido (p)", "effort_invested"],
  ["Severidad", "severity"],
  ["Estado", "status"],
  ["Heurística", "heuristic_value"],
];

export function node(tagName, text = "", className = "") {
  const element = document.createElement(tagName);
  if (text !== null && text !== undefined) element.textContent = String(text);
  if (className) element.className = className;
  return element;
}

export function panel(title) {
  const section = node("section", null, "panel");
  section.append(node("h2", title));
  return section;
}

export function emptyState(message) {
  return node("p", message, "empty");
}

export function taskTable(title, tasks, onSelect = null, indexOffset = 0) {
  const section = panel(title);
  if (!Array.isArray(tasks) || tasks.length === 0) {
    section.append(emptyState("No hay tareas para mostrar."));
    return section;
  }

  const wrap = node("div", null, "table-wrap");
  const table = node("table");
  const thead = node("thead");
  const headingRow = node("tr");
  headingRow.append(node("th", "#"));
  for (const [label] of TASK_COLUMNS) headingRow.append(node("th", label));
  thead.append(headingRow);

  const tbody = node("tbody");
  tasks.forEach((task, index) => {
    const row = node("tr", null, onSelect ? "clickable" : "");
    row.append(node("td", String(index + 1 + indexOffset)));
    for (const [, key] of TASK_COLUMNS) {
      let value = task?.[key];
      if (typeof value === "number") {
        value = value.toFixed(2);
      }
      row.append(node("td", value === "" || value === null || value === undefined ? "—" : value));
    }
    if (onSelect) {
      row.tabIndex = 0;
      row.setAttribute("role", "button");
      row.setAttribute("aria-label", `Seleccionar ${task?.description || "tarea"}`);
      row.addEventListener("click", () => onSelect(task, index + 1 + indexOffset));
      row.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect(task, index + 1 + indexOffset);
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

export function taskInfoPanel(info, title = "Información de tarea") {
  const section = panel(title);
  if (!info?.task) {
    section.append(emptyState("No hay ninguna tarea seleccionada."));
    return section;
  }
  const task = info.task;
  const details = node("dl", null, "key-value-grid task-info-grid");
  for (const [label, value] of [
    ["Descripción", task.description],
    ...(task.id && task.id !== "unknown" ? [["ID", task.id]] : []),
    ["Contexto", task.context],
    ["Inicio", task.start],
    ["Vencimiento", task.due],
    ["Severidad", Number(task.severity).toFixed(2)],
    ["Estado", task.status || "—"],
    ["Coste total", `${Number(task.total_cost).toFixed(2)}p`],
    ["Esfuerzo invertido", `${Number(task.effort_invested).toFixed(2)}p`],
  ]) {
    const row = node("div", null, "key-value-row");
    row.append(node("dt", label, "key"), node("dd", value ?? "—", "value"));
    details.append(row);
  }
  section.append(details);
  if (info.extended) {
    const heuristicsPanel = panel("Heurísticas");
    const list = node("ul", null, "heuristic-list");
    for (const item of info.extended.heuristics ?? []) {
      const line = node("li");
      const name = node("strong", item.name);
      line.append(name, document.createTextNode(`: ${Number(item.value).toFixed(3)} · ${item.comment || ""}`));
      list.append(line);
    }
    heuristicsPanel.append(list);
    section.append(heuristicsPanel);
    const metadataPanel = panel("Metadatos");
    metadataPanel.append(node("pre", info.extended.metadata || ""));
    section.append(metadataPanel);
  }
  return section;
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
  const date = new Date(Number(timestamp) * 1000);
  return Number.isNaN(date.getTime()) ? String(timestamp ?? "") : date.toLocaleString();
}
