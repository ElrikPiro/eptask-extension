import { browserApi } from "./browser-api.js";
import { gatewayCall, assertSuccessfulReply } from "./messages.js";
import { isReady, readExtensionState, subscribeStorageChanges } from "./storage-view.js";
import { node } from "./render.js";

const status = document.querySelector("#popup-status");
const taskCard = document.querySelector("#urgent-task");
const openOptions = document.querySelector("#open-options");
const openManager = document.querySelector("#open-manager");
const refreshButton = document.querySelector("#refresh-agenda");
let extensionState = null;

function setStatus(message, kind = "") {
  status.textContent = message;
  status.className = `status-line ${kind}`.trim();
}

function renderTask(task) {
  taskCard.replaceChildren();
  if (!task) {
    const empty = node("p", "No hay tareas urgentes activas.", "empty");
    taskCard.append(empty);
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

async function refreshUrgentTask() {
  if (!extensionState) extensionState = await readExtensionState();
  if (!isReady(extensionState.settings)) {
    setStatus("Configura el servidor y conecta el monitor para consultar la agenda.", "offline-text");
    renderCardMessage("Conecta con el servidor desde Configuración para ver la tarea prioritaria.");
    return;
  }

  setStatus("Consultando agenda…");
  refreshButton.disabled = true;
  try {
    const reply = assertSuccessfulReply(await gatewayCall("GET_AGENDA"));
    const agenda = reply.data;
    if (!agenda || !Array.isArray(agenda.active_urgent_tasks)) {
      throw new Error("La respuesta de agenda no tiene el formato esperado.");
    }
    renderTask(agenda.active_urgent_tasks[0] ?? null);
    setStatus("Agenda actualizada.", "online-text");
  } catch (error) {
    const detail = error instanceof Error ? error.message : "No se pudo cargar la agenda.";
    renderCardMessage(detail, "error-text");
    setStatus(detail, "error-text");
  } finally {
    refreshButton.disabled = false;
  }
}

openOptions.addEventListener("click", () => {
  void browserApi.runtime.openOptionsPage();
});
openManager.addEventListener("click", () => {
  void browserApi.tabs.create({ url: browserApi.runtime.getURL("index.html") });
});
refreshButton.addEventListener("click", () => void refreshUrgentTask());

void readExtensionState().then((value) => {
  extensionState = value;
  if (!isReady(value.settings)) {
    setStatus("Configura el servidor y conecta el monitor.", "offline-text");
    renderCardMessage("Conecta con el servidor desde Configuración para ver la tarea prioritaria.");
    return;
  }
  void refreshUrgentTask();
}).catch((error) => {
  const detail = error instanceof Error ? error.message : "No se pudo leer el estado de la extensión.";
  setStatus(detail, "error-text");
  renderCardMessage(detail, "error-text");
});

subscribeStorageChanges((changes) => {
  if (changes["settings.v1"]) {
    const settings = changes["settings.v1"].newValue;
    extensionState = { ...(extensionState ?? {}), settings };
    if (!isReady(settings)) {
      setStatus("El monitor está desconectado.", "offline-text");
      renderCardMessage("Conecta con el servidor desde Configuración para ver la tarea prioritaria.");
    } else {
      setStatus("Conectado. Actualiza la agenda para ver la tarea prioritaria.", "online-text");
    }
  }
});
