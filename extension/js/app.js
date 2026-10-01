import { browserApi } from "./browser-api.js";
import { assertSuccessfulReply, clearHistory, gatewayCall } from "./messages.js";
import { isReady, readExtensionState, subscribeStorageChanges } from "./storage-view.js";
import {
  emptyState,
  formatDuration,
  formatTimestamp,
  keyValuePanel,
  node,
  panel,
  taskInfoPanel,
  taskTable,
} from "./render.js";

const state = {
  settings: null,
  monitorStatus: null,
  history: [],
  busy: false,
  view: "tasks",
  taskList: null,
  taskInfo: null,
  selectedTarget: null,
  agenda: null,
  stats: null,
  events: null,
  heuristics: [],
  algorithms: [],
  filters: [],
  strategyErrors: {},
};

const mainView = document.querySelector("#main-view");
const messageBox = document.querySelector("#app-message");
const badge = document.querySelector("#connection-badge");

function showMessage(message, kind = "info") {
  messageBox.hidden = !message;
  messageBox.textContent = message || "";
  messageBox.className = `alert ${kind}`;
}

function updateConnection() {
  const ready = isReady(state.settings);
  badge.textContent = ready ? "Conectado" : "Desconectado";
  badge.className = `status-pill ${ready ? "online" : "offline"}`;
  const canAct = ready && !state.busy;
  for (const button of document.querySelectorAll("[data-action]")) {
    const action = button.dataset.action;
    const needsTarget = ["get-info", "done"].includes(action);
    const atFirstPage = state.taskList?.interactive !== false && Number(state.taskList?.current_page) <= 1;
    const atLastPage = state.taskList?.interactive !== false && Number(state.taskList?.current_page) >= Number(state.taskList?.total_pages);
    button.disabled = !canAct || (needsTarget && !state.selectedTarget) || (action === "previous" && atFirstPage) || (action === "next" && atLastPage);
  }
  for (const button of document.querySelectorAll("#command-forms button, .command-panel form button")) {
    button.disabled = !canAct;
  }
  for (const button of document.querySelectorAll(".strategies-panel button")) {
    button.disabled = !canAct;
  }
  document.querySelector("#clear-history").disabled = state.busy;
  document.querySelectorAll("[data-view]").forEach((button) => {
    button.classList.toggle("secondary", button.dataset.view !== state.view);
  });
}

function setBusy(value) {
  state.busy = value;
  updateConnection();
}

function requireReady() {
  if (!isReady(state.settings)) {
    throw new Error("Configura el servidor y pulsa «Probar y conectar» antes de usar el gestor.");
  }
}

async function request(operation, args = {}) {
  requireReady();
  const reply = assertSuccessfulReply(await gatewayCall(operation, args));
  return reply.data;
}

async function perform(label, work) {
  if (state.busy) return;
  setBusy(true);
  showMessage(`${label}…`);
  try {
    await work();
    updateConnection();
  } catch (error) {
    showMessage(error instanceof Error ? error.message : "La operación falló.", "error");
  } finally {
    setBusy(false);
  }
}

function isTaskList(data) {
  return Boolean(data && typeof data === "object" && Array.isArray(data.tasks) && typeof data.algorithm_name === "string");
}

function isTaskInformation(data) {
  return Boolean(data && typeof data === "object" && data.task && typeof data.task === "object");
}

function isAgenda(data) {
  return Boolean(data && typeof data === "object" && Array.isArray(data.active_urgent_tasks));
}

function textResponse(data, fallback) {
  return typeof data === "string" && data.trim() ? data : fallback;
}

function updateList(data) {
  if (!isTaskList(data)) return false;
  state.taskList = data;
  renderMainView();
  return true;
}

function renderTaskInformation() {
  return taskInfoPanel(state.taskInfo, "Información de tarea");
}

function renderTasksView() {
  const fragment = document.createDocumentFragment();
  fragment.append(taskTable("Lista de tareas", state.taskList?.tasks ?? [], (task, index) => selectTask(task, index)));
  if (state.taskList) {
    fragment.append(keyValuePanel("Contexto de la lista", [
      ["Algoritmo", state.taskList.algorithm_name],
      ["Heurística", state.taskList.sort_heuristic],
      ["Tareas totales", state.taskList.total_tasks],
      ["Página", `${state.taskList.current_page}/${state.taskList.total_pages}`],
      ["Filtros activos", (state.taskList.active_filters ?? []).map((item) => `${item.index}. ${item.name}`).join(", ") || "Ninguno"],
    ]));
    const details = panel("Descripción del algoritmo");
    details.append(node("p", state.taskList.algorithm_desc || "Sin descripción.", "caption"));
    fragment.append(details);
  } else {
    const context = panel("Contexto de la lista");
    context.append(emptyState("Actualiza la lista para cargar las tareas."));
    fragment.append(context);
  }
  fragment.append(renderTaskInformation());
  mainView.replaceChildren(fragment);
}

function renderAgendaView() {
  const fragment = document.createDocumentFragment();
  if (!state.agenda) {
    const section = panel("Agenda");
    section.append(emptyState("Carga la agenda para ver tareas activas y planificadas."));
    fragment.append(section);
  } else {
    const heading = panel("Agenda");
    heading.append(node("p", `Fecha: ${state.agenda.date?.str_representation ?? "—"}`, "caption"));
    fragment.append(heading);
    const onAgendaSelect = (task) => selectAgendaTask(task);
    fragment.append(taskTable("Urgentes activas", state.agenda.active_urgent_tasks, onAgendaSelect));
    fragment.append(taskTable("Urgentes planificadas", state.agenda.planned_urgent_tasks ?? [], onAgendaSelect));
    fragment.append(taskTable("Otras tareas", state.agenda.other_tasks ?? [], onAgendaSelect));
    const planned = state.agenda.planned_tasks_by_date ?? {};
    for (const [date, tasks] of Object.entries(planned)) {
      fragment.append(taskTable(`Planificadas · ${date}`, tasks, onAgendaSelect));
    }
  }
  mainView.replaceChildren(fragment);
}

function renderStatsView() {
  const fragment = document.createDocumentFragment();
  if (!state.stats) {
    const section = panel("Estadísticas");
    section.append(emptyState("Carga las estadísticas para ver el resumen de trabajo."));
    fragment.append(section);
  } else {
    const stats = state.stats;
    fragment.append(keyValuePanel("Estadísticas", [
      ["Heurística", stats.HeuristicName],
      ["Heurística máxima", Number(stats.maxHeuristic).toFixed(3)],
      ["Mayor carga", stats.offender || "—"],
      ["Carga de trabajo", formatDuration(stats.workload?.int_representation)],
      ["Esfuerzo pendiente", formatDuration(stats.remainingEffort?.int_representation)],
      ["Máximo del responsable", formatDuration(stats.offenderMax?.int_representation)],
    ]));
    const byDay = panel("Trabajo por día");
    const list = node("ul");
    for (const [date, amount] of Object.entries(stats.workDone ?? {})) list.append(node("li", `${date}: ${Number(amount).toFixed(2)} pomodoros`));
    if (!list.childElementCount) list.append(node("li", "Sin registros."));
    byDay.append(list);
    fragment.append(byDay);
    const logPanel = panel("Registro de trabajo");
    const log = node("ul");
    for (const entry of stats.workDoneLog ?? []) {
      log.append(node("li", `${formatTimestamp(entry.timestamp)} · ${entry.task} (${Number(entry.work_units).toFixed(2)}p)`));
    }
    if (!log.childElementCount) log.append(node("li", "Sin entradas."));
    logPanel.append(log);
    fragment.append(logPanel);
  }
  mainView.replaceChildren(fragment);
}

function renderEventsView() {
  const fragment = document.createDocumentFragment();
  if (!state.events) {
    const section = panel("Eventos");
    section.append(emptyState("Carga los eventos para ver su estado."));
    fragment.append(section);
  } else {
    const events = state.events;
    fragment.append(keyValuePanel("Resumen de eventos", [
      ["Eventos totales", events.total_events],
      ["Tareas que los lanzan", events.total_raising_tasks],
      ["Tareas en espera", events.total_waiting_tasks],
      ["Eventos huérfanos", events.orphaned_events_count],
    ]));
    const section = panel("Detalle de eventos");
    if (!(events.event_statistics ?? []).length) {
      section.append(emptyState("No hay detalles de eventos."));
    } else {
      const table = node("table");
      const head = node("thead");
      const headingRow = node("tr");
      for (const value of ["Evento", "Lanzan", "Esperan", "Huérfano", "Tipo"]) headingRow.append(node("th", value));
      head.append(headingRow);
      const body = node("tbody");
      for (const event of events.event_statistics) {
        const row = node("tr", null, event.is_orphaned ? "orphaned" : "");
        for (const value of [event.event_name, event.tasks_raising, event.tasks_waiting, event.is_orphaned ? "Sí" : "No", event.orphan_type]) row.append(node("td", value));
        body.append(row);
      }
      table.append(head, body);
      const wrap = node("div", null, "table-wrap");
      wrap.append(table);
      section.append(wrap);
    }
    fragment.append(section);
  }
  mainView.replaceChildren(fragment);
}

function renderSelectedTaskView() {
  const fragment = document.createDocumentFragment();
  fragment.append(taskInfoPanel(state.taskInfo, "Tarea seleccionada"));
  const actions = panel("Acciones de tarea seleccionada");
  const row = node("div", null, "button-row");
  const refresh = node("button", "Actualizar información");
  refresh.type = "button";
  refresh.dataset.action = "get-info";
  refresh.disabled = state.busy || !isReady(state.settings) || !state.selectedTarget;
  refresh.addEventListener("click", () => void getSelectedInfo());
  const done = node("button", "Completar tarea", "danger-button");
  done.type = "button";
  done.dataset.action = "done";
  done.disabled = state.busy || !isReady(state.settings) || !state.selectedTarget;
  done.addEventListener("click", () => void markDone());
  row.append(refresh, done);
  actions.append(row);
  if (!state.selectedTarget && state.taskInfo) actions.append(node("p", "Selecciona la tarea en la lista para habilitar acciones que modifican la selección compartida.", "caption"));
  fragment.append(actions);
  mainView.replaceChildren(fragment);
}

function renderMainView() {
  updateConnection();
  if (!isReady(state.settings)) {
    const section = panel("Gestor de tareas");
    section.append(emptyState("Abre Configuración e introduce la URL y el token del backend."));
    mainView.replaceChildren(section);
    return;
  }
  if (state.view === "agenda") renderAgendaView();
  else if (state.view === "stats") renderStatsView();
  else if (state.view === "events") renderEventsView();
  else if (state.view === "selectedTask") renderSelectedTaskView();
  else renderTasksView();
}

function renderStrategies() {
  const renderEntries = (selector, entries, operation, label) => {
    const list = document.querySelector(selector);
    list.replaceChildren();
    if (!Array.isArray(entries) || entries.length === 0) {
      list.append(node("li", state.strategyErrors[selector] || "Sin opciones."));
      return;
    }
    entries.forEach((entry, index) => {
      const li = node("li");
      const button = node("button", `${label(entry, index)}`, "link-button");
      button.type = "button";
      button.disabled = state.busy || !isReady(state.settings);
      button.addEventListener("click", () => void perform(`Actualizando ${entry.name}`, async () => {
        const data = await request(operation, { index: index + 1 });
        if (isTaskList(data)) updateList(data);
        await refreshStrategies();
        showMessage(`${entry.name} actualizado.`);
      }));
      li.append(button);
      if (entry.description) li.append(node("p", entry.description, "caption"));
      list.append(li);
    });
  };

  renderEntries("#heuristics-list", state.heuristics, "SELECT_HEURISTIC", (entry, index) => `${index + 1}. ${entry.name}`);
  renderEntries("#algorithms-list", state.algorithms, "SELECT_ALGORITHM", (entry, index) => `${index + 1}. ${entry.name}`);
  renderEntries("#filters-list", state.filters, "TOGGLE_FILTER", (entry) => `${entry.enabled ? "Desactivar" : "Activar"} ${entry.name}`);
}

function renderHistory() {
  const list = document.querySelector("#notification-list");
  list.replaceChildren();
  if (!state.history.length) {
    list.append(node("li", "Sin notificaciones guardadas.", "empty"));
    return;
  }
  for (const entry of state.history) {
    const item = node("li");
    item.append(node("p", typeof entry?.message === "string" ? entry.message : ""));
    item.append(node("small", `${entry?.timestamp || ""}${entry?.receivedAt ? ` · recibido ${new Date(entry.receivedAt).toLocaleString()}` : ""}`));
    list.append(item);
  }
}

async function refreshStrategies() {
  const jobs = await Promise.allSettled([
    request("GET_HEURISTICS"),
    request("GET_ALGORITHMS"),
    request("GET_FILTERS"),
  ]);
  const unwrapArray = (value, key) => {
    if (Array.isArray(value)) return value;
    if (value && Array.isArray(value[key])) return value[key];
    return [];
  };
  const names = ["#heuristics-list", "#algorithms-list", "#filters-list"];
  const keys = ["heuristics", "algorithms", "filters"];
  state.strategyErrors = {};
  jobs.forEach((job, index) => {
    if (job.status === "fulfilled") {
      state[keys[index]] = unwrapArray(job.value, keys[index]);
    } else {
      state[keys[index]] = [];
      state.strategyErrors[names[index]] = `No se pudieron cargar: ${job.reason instanceof Error ? job.reason.message : "error"}`;
    }
  });
  renderStrategies();
}

async function refreshList(operation = "GET_LIST") {
  const data = await request(operation);
  if (!updateList(data)) throw new Error(textResponse(data, "La lista devolvió una respuesta no válida."));
  state.view = "tasks";
  renderMainView();
  await refreshStrategies();
}

async function refreshAgenda() {
  const data = await request("GET_AGENDA");
  if (!isAgenda(data)) throw new Error(textResponse(data, "La agenda devolvió una respuesta no válida."));
  state.agenda = data;
  state.view = "agenda";
  renderMainView();
}

async function refreshStats() {
  const data = await request("GET_STATS");
  if (!data || typeof data !== "object" || typeof data.maxHeuristic !== "number") throw new Error(textResponse(data, "Las estadísticas devolvieron una respuesta no válida."));
  state.stats = data;
  state.view = "stats";
  renderMainView();
}

async function refreshEvents() {
  const data = await request("GET_EVENTS");
  if (!data || typeof data !== "object" || !Array.isArray(data.event_statistics)) throw new Error(textResponse(data, "Los eventos devolvieron una respuesta no válida."));
  state.events = data;
  state.view = "events";
  renderMainView();
}

async function findTaskRow(taskId, details = null) {
  let list = await request("GET_LIST");
  if (!isTaskList(list)) throw new Error(textResponse(list, "No se pudo buscar la tarea en el listado."));
  const totalPages = Math.max(1, Math.min(1000, Number(list.total_pages) || 1));
  const matches = [];
  for (let page = 1; page <= totalPages; page += 1) {
    const indexes = taskId
      ? [list.tasks.findIndex((entry) => entry.id === taskId)].filter((index) => index >= 0)
      : list.tasks.map((entry, index) => ({ entry, index }))
        .filter(({ entry }) => entry.description === details?.description && entry.context === details?.context)
        .map(({ index }) => index);
    if (indexes.length) {
      state.taskList = list;
      for (const index of indexes) matches.push({ task: list.tasks[index], index: index + 1, page });
      if (taskId) return matches[0];
    }
    if (page < totalPages) {
      list = await request("NEXT");
      if (!isTaskList(list) || Number(list.current_page) !== page + 1) {
        throw new Error("La paginación cambió durante la búsqueda. Actualiza la lista e inténtalo de nuevo.");
      }
    }
  }
  state.taskList = list;
  return matches.length === 1 ? matches[0] : null;
}

async function selectTaskAt(task, index, page) {
  const data = await request("SELECT_TASK", { index, expectedTaskId: task.id, page });
  if (!isTaskInformation(data)) throw new Error(textResponse(data, "No se pudo seleccionar la tarea."));
  if (data.task.id !== task.id) throw new Error("El identificador de tarea cambió. Actualiza la lista y vuelve a seleccionarla.");
  state.taskInfo = data;
  state.selectedTarget = { index, expectedTaskId: task.id, page };
  state.view = "selectedTask";
  renderMainView();
  showMessage(`Seleccionada: ${data.task.description}`);
}

async function selectTask(task, index) {
  await perform("Seleccionando tarea", async () => {
    if (state.taskList?.interactive === false) {
      const position = await findTaskRow(task.id);
      if (!position) throw new Error("La tarea no está en el listado activo. Comprueba los filtros o la búsqueda.");
      await selectTaskAt(position.task, position.index, position.page);
      return;
    }
    const page = Number(state.taskList?.current_page) || 1;
    await selectTaskAt(task, index, page);
  });
}

function extractTaskHash(description) {
  const exact = String(description).match(/\[([a-zA-Z0-9]{5})\]\s*$/);
  if (exact?.[1]) return exact[1];
  const matches = Array.from(String(description).matchAll(/\[([^\]]+)\]/g));
  return matches.at(-1)?.[1]?.trim() || null;
}

async function selectAgendaTask(task) {
  await perform("Buscando tarea de agenda", async () => {
    const position = await findTaskRow(task?.id);
    if (position) {
      await selectTaskAt(position.task, position.index, position.page);
      return;
    }
    const hash = extractTaskHash(task?.description);
    if (!hash) throw new Error("La tarea de agenda no está en la lista activa y no tiene un identificador para buscarla.");
    const data = await request("SEARCH", { terms: [hash] });
    if (isTaskInformation(data)) {
      const position = await findTaskRow(null, { description: data.task.description, context: data.task.context });
      if (position) {
        await selectTaskAt(position.task, position.index, position.page);
      } else {
        state.taskInfo = data;
        state.selectedTarget = null;
        state.view = "selectedTask";
        renderMainView();
        showMessage("Tarea encontrada. Está fuera de la lista activa o coincide con varias tareas; sus acciones requieren selección desde la lista.");
      }
    } else if (isTaskList(data)) {
      state.taskList = data;
      state.taskInfo = null;
      state.selectedTarget = null;
      state.view = "tasks";
      renderMainView();
      showMessage(`La búsqueda encontró ${data.tasks.length} tareas. Selecciona una fila para continuar.`);
    } else {
      showMessage(textResponse(data, "La búsqueda no encontró esa tarea."), "info");
    }
  });
}

async function getSelectedInfo() {
  if (!state.selectedTarget) return;
  await perform("Cargando información", async () => {
    const data = await request("GET_INFO", { target: state.selectedTarget });
    if (!isTaskInformation(data)) throw new Error(textResponse(data, "No se pudo leer la tarea seleccionada."));
    state.taskInfo = data;
    renderMainView();
    showMessage("Información actualizada.");
  });
}

async function reloadListAfterAction() {
  const data = await request("GET_LIST");
  if (isTaskList(data)) state.taskList = data;
  renderMainView();
}

async function markDone() {
  if (!state.selectedTarget) return;
  await perform("Completando tarea", async () => {
    const data = await request("DONE", { target: state.selectedTarget });
    if (isTaskList(data)) state.taskList = data;
    state.selectedTarget = null;
    state.taskInfo = null;
    await reloadListAfterAction();
    state.view = "tasks";
    renderMainView();
    showMessage("Tarea completada.");
  });
}

function setSelectedTaskInfo(data) {
  if (!isTaskInformation(data)) return false;
  state.taskInfo = data;
  return true;
}

async function finishTaskMutation(label, operation, args) {
  await perform(label, async () => {
    const data = await request(operation, { ...args, target: state.selectedTarget });
    setSelectedTaskInfo(data);
    await reloadListAfterAction();
    showMessage(textResponse(typeof data === "string" ? data : null, label));
  });
}

function bindForm(id, handler) {
  const form = document.querySelector(`#${id}`);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!form.reportValidity() || state.busy) return;
    void handler(new FormData(form));
  });
}

function formValue(formData, name) {
  return String(formData.get(name) ?? "").trim();
}

function requireTarget() {
  if (!state.selectedTarget) throw new Error("Selecciona una tarea de la lista antes de usar este comando.");
  return state.selectedTarget;
}

bindForm("set-form", (data) => {
  try {
    requireTarget();
    return finishTaskMutation("Campo de tarea actualizado.", "SET", {
      param: formValue(data, "param"), value: formValue(data, "value"),
    });
  } catch (error) {
    showMessage(error.message, "error");
  }
});
bindForm("new-form", (data) => perform("Creando tarea", async () => {
  const args = { description: formValue(data, "description") };
  const context = formValue(data, "context");
  const totalCost = formValue(data, "totalCost");
  if (context) args.context = context;
  if (totalCost) args.totalCost = totalCost;
  const result = await request("NEW", args);
  if (isTaskInformation(result)) {
    state.taskInfo = result;
    state.selectedTarget = null;
  }
  await reloadListAfterAction();
  showMessage(textResponse(result, "Tarea creada."));
}));
bindForm("work-form", (data) => {
  try {
    requireTarget();
    return finishTaskMutation("Trabajo registrado.", "WORK", { amount: formValue(data, "amount") });
  } catch (error) {
    showMessage(error.message, "error");
  }
});
bindForm("schedule-form", (data) => {
  try {
    requireTarget();
    const expectedWorkPerDay = formValue(data, "amount");
    return finishTaskMutation("Tarea programada.", "SCHEDULE", expectedWorkPerDay ? { expectedWorkPerDay } : {});
  } catch (error) {
    showMessage(error.message, "error");
  }
});
bindForm("snooze-form", (data) => {
  try {
    requireTarget();
    const amount = formValue(data, "amount");
    return finishTaskMutation("Tarea pospuesta.", "SNOOZE", amount ? { amount } : {});
  } catch (error) {
    showMessage(error.message, "error");
  }
});
bindForm("search-form", (data) => perform("Buscando tareas", async () => {
  const terms = formValue(data, "terms").split(/\s+/).filter(Boolean);
  const result = await request("SEARCH", { terms });
  if (isTaskInformation(result)) {
    const position = await findTaskRow(null, { description: result.task.description, context: result.task.context });
    if (position) {
      await selectTaskAt(position.task, position.index, position.page);
    } else {
      state.taskInfo = result;
      state.selectedTarget = null;
      state.view = "selectedTask";
      renderMainView();
      showMessage("Tarea encontrada. Está fuera de la lista activa o coincide con varias tareas; sus acciones requieren selección desde la lista.");
    }
  } else if (isTaskList(result)) {
    state.taskList = result;
    state.taskInfo = null;
    state.selectedTarget = null;
    state.view = "tasks";
    renderMainView();
    showMessage(`Búsqueda completada: ${result.tasks.length} tareas.`);
  } else {
    showMessage(textResponse(result, "No se encontraron tareas."));
  }
}));
bindForm("project-form", (data) => perform("Ejecutando comando de proyecto", async () => {
  const args = formValue(data, "args").split(/\s+/).filter(Boolean);
  const commandArgs = state.selectedTarget ? { args, target: state.selectedTarget } : { args };
  const result = await request("PROJECT", commandArgs);
  showMessage(textResponse(result, "Comando de proyecto ejecutado."));
  const list = await request("GET_LIST");
  if (isTaskList(list)) state.taskList = list;
  renderMainView();
}));
bindForm("raise-form", (data) => perform("Lanzando evento", async () => {
  const result = await request("RAISE", { eventName: formValue(data, "eventName") });
  const list = await request("GET_LIST");
  if (isTaskList(list)) state.taskList = list;
  state.view = "tasks";
  renderMainView();
  showMessage(textResponse(result, "Evento lanzado."));
}));

document.querySelectorAll("[data-view]").forEach((button) => {
  button.addEventListener("click", () => {
    state.view = button.dataset.view;
    renderMainView();
  });
});

document.querySelector("[data-action='refresh-list']").addEventListener("click", () => {
  void perform("Actualizando lista", () => refreshList("GET_LIST").then(() => showMessage("Lista actualizada.")));
});
document.querySelector("[data-action='next']").addEventListener("click", () => {
  void perform("Abriendo la página siguiente", () => refreshList("NEXT").then(() => showMessage("Página siguiente.")));
});
document.querySelector("[data-action='previous']").addEventListener("click", () => {
  void perform("Abriendo la página anterior", () => refreshList("PREVIOUS").then(() => showMessage("Página anterior.")));
});
document.querySelector("[data-action='get-info']").addEventListener("click", () => void getSelectedInfo());
document.querySelector("[data-action='done']").addEventListener("click", () => void markDone());
document.querySelector("[data-action='refresh-agenda']").addEventListener("click", () => void perform("Cargando agenda", refreshAgenda));
document.querySelector("[data-action='refresh-stats']").addEventListener("click", () => void perform("Cargando estadísticas", refreshStats));
document.querySelector("[data-action='refresh-events']").addEventListener("click", () => void perform("Cargando eventos", refreshEvents));
document.querySelector("#open-options").addEventListener("click", () => void browserApi.runtime.openOptionsPage());
document.querySelector("#clear-history").addEventListener("click", () => {
  if (!globalThis.confirm("¿Vaciar el historial local de notificaciones?")) return;
  void perform("Vaciando historial", async () => {
    assertSuccessfulReply(await clearHistory());
    const extensionState = await readExtensionState();
    state.history = extensionState.history;
    renderHistory();
    showMessage("Historial local vaciado.");
  });
});

subscribeStorageChanges((changes) => {
  if (changes["settings.v1"]) {
    state.settings = changes["settings.v1"].newValue;
    updateConnection();
    if (!isReady(state.settings)) {
      state.taskList = null;
      state.selectedTarget = null;
      state.taskInfo = null;
      renderMainView();
    }
  }
  if (changes["notificationHistory.v1"]) {
    state.history = Array.isArray(changes["notificationHistory.v1"].newValue) ? changes["notificationHistory.v1"].newValue : [];
    renderHistory();
  }
  if (changes["monitorStatus.v1"]) state.monitorStatus = changes["monitorStatus.v1"].newValue;
});

async function initialize() {
  try {
    const saved = await readExtensionState();
    state.settings = saved.settings;
    state.history = saved.history;
    state.monitorStatus = saved.monitorStatus;
    renderHistory();
    renderStrategies();
    updateConnection();
    if (isReady(state.settings)) {
      await perform("Cargando gestor", async () => {
        await refreshList("GET_LIST");
        showMessage("Gestor conectado.");
      });
    } else {
      renderMainView();
      showMessage("Configura el servidor y conecta desde la página de opciones.");
    }
  } catch (error) {
    showMessage(error instanceof Error ? error.message : "No se pudo leer el estado de la extensión.", "error");
  }
}

void initialize();
