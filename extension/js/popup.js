import { browserApi } from "./browser-api.js";
import { gatewayCall, assertSuccessfulReply } from "./messages.js";
import { isReady, readExtensionState, subscribeStorageChanges } from "./storage-view.js";
import { node } from "./render.js";

const status = document.querySelector("#popup-status");
const taskCard = document.querySelector("#urgent-task");
const openOptions = document.querySelector("#open-options");
const openManager = document.querySelector("#open-manager");
const refreshButton = document.querySelector("#refresh-agenda");
const completeButton = document.querySelector("#complete-task");
const snoozeButton = document.querySelector("#snooze-task");

let extensionState = null;
let stateLoaded = false;
let agendaLoading = true;
let currentTask = null;
let settingsRevision = 0;
let agendaRevision = 0;
let actionRevision = 0;
let activeAction = null;
let needsRefreshBeforeAction = false;

function settingsAreReady() {
  return stateLoaded && isReady(extensionState?.settings);
}

function updateControls() {
  const busy = agendaLoading || activeAction !== null;
  const canRefresh = settingsAreReady() && !busy;
  const canAct = canRefresh && currentTask !== null && !needsRefreshBeforeAction;
  refreshButton.disabled = !canRefresh;
  completeButton.disabled = !canAct;
  snoozeButton.disabled = !canAct;
}

function setStatus(message, kind = "") {
  status.textContent = message;
  status.className = `status-line ${kind}`.trim();
}

function renderTask(task) {
  taskCard.replaceChildren();
  if (!task) {
    taskCard.append(node("p", "No hay tareas urgentes activas.", "empty"));
    return;
  }

  const context = node("span", task.context || "Sin contexto", "task-context");
  const description = node("h2", task.description || "Tarea sin descripción");
  const details = node("dl", null, "urgent-details");
  for (const [label, value] of [
    ["Vence", task.due || "—"],
    ["Estado", task.status || "—"],
    ["Coste restante", `${Number(task.total_cost).toFixed(2)}p`],
  ]) {
    const row = node("div", null, "key-value-row");
    row.append(node("dt", label, "key"), node("dd", value, "value"));
    details.append(row);
  }
  taskCard.append(context, description, details);
}

function renderCardMessage(message, kind = "empty") {
  taskCard.replaceChildren(node("p", message, kind));
}

function isCurrentAgendaRequest(requestRevision, requestSettingsRevision) {
  return requestRevision === agendaRevision &&
    requestSettingsRevision === settingsRevision &&
    settingsAreReady();
}

async function refreshUrgentTask({ resultMessage = "" } = {}) {
  if (!settingsAreReady()) {
    agendaLoading = false;
    currentTask = null;
    updateControls();
    setStatus("Configura el servidor y conecta el monitor para consultar la agenda.", "offline-text");
    renderCardMessage("Conecta con el servidor desde Configuración para ver la tarea prioritaria.");
    return;
  }

  const requestRevision = ++agendaRevision;
  const requestSettingsRevision = settingsRevision;
  agendaLoading = true;
  currentTask = null;
  updateControls();
  renderCardMessage("Consultando agenda…");
  setStatus(resultMessage ? `${resultMessage} Actualizando agenda…` : "Consultando agenda…", "online-text");

  try {
    const reply = assertSuccessfulReply(await gatewayCall("GET_AGENDA"));
    if (!isCurrentAgendaRequest(requestRevision, requestSettingsRevision)) return;

    const agenda = reply.data;
    if (!agenda || !Array.isArray(agenda.active_urgent_tasks)) {
      throw new Error("La respuesta de agenda no tiene el formato esperado.");
    }
    currentTask = agenda.active_urgent_tasks[0] ?? null;
    needsRefreshBeforeAction = false;
    renderTask(currentTask);
    setStatus(resultMessage ? `${resultMessage} Agenda actualizada.` : "Agenda actualizada.", "online-text");
  } catch (error) {
    if (!isCurrentAgendaRequest(requestRevision, requestSettingsRevision)) return;
    const detail = error instanceof Error ? error.message : "No se pudo cargar la agenda.";
    currentTask = null;
    renderCardMessage(detail, "error-text");
    const refreshFailure = needsRefreshBeforeAction
      ? `No se pudo verificar la acción anterior. La agenda no se pudo actualizar: ${detail}`
      : detail;
    setStatus(
      resultMessage ? `${resultMessage} No se pudo actualizar la agenda: ${detail}` : refreshFailure,
      "error-text",
    );
  } finally {
    if (requestRevision === agendaRevision && requestSettingsRevision === settingsRevision) {
      agendaLoading = false;
      updateControls();
    }
  }
}

function expectedTask(task) {
  return {
    id: task.id,
    description: task.description,
    context: task.context,
  };
}

function isCurrentAction(actionId, actionSettingsRevision) {
  return activeAction === actionId &&
    actionSettingsRevision === settingsRevision &&
    settingsAreReady();
}

async function performTaskAction(operation) {
  if (
    !settingsAreReady() || !currentTask || agendaLoading || activeAction !== null ||
    needsRefreshBeforeAction
  ) return;

  const task = currentTask;
  const expectedTaskIdentity = expectedTask(task);
  const actionId = ++actionRevision;
  const actionSettingsRevision = settingsRevision;
  const label = operation === "POPUP_DONE" ? "Tarea completada." : "Tarea pospuesta 5 minutos.";
  activeAction = actionId;
  agendaRevision += 1;
  updateControls();
  setStatus(operation === "POPUP_DONE" ? "Completando tarea…" : "Posponiendo tarea 5 minutos…", "online-text");

  try {
    const reply = await gatewayCall(operation, { expectedTask: expectedTaskIdentity });
    assertSuccessfulReply(reply);
    if (!isCurrentAction(actionId, actionSettingsRevision)) return;
    await refreshUrgentTask({ resultMessage: label });
  } catch (error) {
    if (!isCurrentAction(actionId, actionSettingsRevision)) return;
    const detail = error instanceof Error ? error.message : "Error desconocido.";
    needsRefreshBeforeAction = true;
    setStatus(
      `No se pudo confirmar si la acción se aplicó. Actualiza la agenda antes de volver a intentarlo. ${detail}`,
      "error-text",
    );
  } finally {
    if (activeAction === actionId) {
      activeAction = null;
      updateControls();
    }
  }
}

function applySettings(settings) {
  settingsRevision += 1;
  agendaRevision += 1;
  actionRevision += 1;
  activeAction = null;
  agendaLoading = false;
  currentTask = null;
  needsRefreshBeforeAction = false;
  extensionState = { ...(extensionState ?? {}), settings };
  stateLoaded = true;
  updateControls();

  if (!isReady(settings)) {
    setStatus("El monitor está desconectado.", "offline-text");
    renderCardMessage("Conecta con el servidor desde Configuración para ver la tarea prioritaria.");
    return;
  }

  renderCardMessage("La conexión cambió. Actualiza la agenda para ver la tarea prioritaria.");
  setStatus("Conexión actualizada. Actualiza la agenda para ver la tarea prioritaria.", "online-text");
}

openOptions.addEventListener("click", () => {
  void browserApi.runtime.openOptionsPage();
});
openManager.addEventListener("click", () => {
  void browserApi.tabs.create({ url: browserApi.runtime.getURL("index.html") });
});
refreshButton.addEventListener("click", () => {
  if (refreshButton.disabled) return;
  void refreshUrgentTask();
});
completeButton.addEventListener("click", () => void performTaskAction("POPUP_DONE"));
snoozeButton.addEventListener("click", () => void performTaskAction("POPUP_SNOOZE"));

subscribeStorageChanges((changes) => {
  if (changes["settings.v1"]) applySettings(changes["settings.v1"].newValue);
});

const initialSettingsRevision = settingsRevision;
void readExtensionState().then((value) => {
  if (initialSettingsRevision !== settingsRevision) return;
  extensionState = value;
  stateLoaded = true;
  if (!isReady(value.settings)) {
    agendaLoading = false;
    currentTask = null;
    updateControls();
    setStatus("Configura el servidor y conecta el monitor.", "offline-text");
    renderCardMessage("Conecta con el servidor desde Configuración para ver la tarea prioritaria.");
    return;
  }
  void refreshUrgentTask();
}).catch((error) => {
  if (initialSettingsRevision !== settingsRevision) return;
  stateLoaded = true;
  agendaLoading = false;
  const detail = error instanceof Error ? error.message : "No se pudo leer el estado de la extensión.";
  updateControls();
  setStatus(detail, "error-text");
  renderCardMessage(detail, "error-text");
});
