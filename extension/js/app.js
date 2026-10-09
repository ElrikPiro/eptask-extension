import { browserTimeZone, dateTimeControlValue, dateTimeParts, dateTimeToIso, zonedControlValue } from "./date-time.js";
import { bindTimePickers, disposeTimePickers } from "./time-picker.js";
import { browserApi } from "./browser-api.js";
import { assertSuccessfulReply, clearNotificationBuffer, readGateway, submitOperation, subscribeChanges } from "./messages.js";
import { isReady, readExtensionState, subscribeStorageChanges } from "./storage-view.js";
import { emptyState, formatAmount, formatTimestamp, humanField, keyValuePanel, node, panel, renderNotificationHistory, taskInfoPanel, taskTable } from "./render.js";

const DEFAULT_FILTER = "All active task filter";
const DEFAULT_ALGORITHM = "GTD Algorithm";
const DEFAULT_HEURISTIC = "Remaining Effort(1)";
const VIEW_COLLECTIONS = Object.freeze({
  tasks: "tasks",
  agenda: "agenda",
  stats: "statistics",
  events: "events",
  projects: "projects",
});
const COLLECTION_READ_KEYS = Object.freeze({
  tasks: "tasks.list",
  agenda: "agenda",
  statistics: "statistics",
  events: "events",
  projects: "projects.list",
});
const ACTION_LABELS = {
  "create-task": "Crear tarea",
  "edit-task": "Guardar cambios",
  "complete-task": "Completar tarea",
  "schedule-task": "Planificar trabajo",
  "record-work": "Registrar trabajo",
  "snooze-task": "Posponer tarea",
  "raise-event": "Activar evento",
  "open-project": "Abrir proyecto",
  "close-project": "Cerrar proyecto",
  "hold-project": "Poner proyecto en espera",
  "edit-project-content": "Editar contenido",
};

function defaultTaskView() {
  return { filters: [DEFAULT_FILTER], page: 1, pageSize: 5, search: [], algorithm: DEFAULT_ALGORITHM, heuristic: DEFAULT_HEURISTIC };
}

function localDay() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function dayInTimeZone(timeZone) {
  if (typeof timeZone !== "string" || !timeZone.trim()) {
    throw new Error("El servidor no indicó una zona horaria válida. No se puede cargar la agenda.");
  }
  try {
    const parts = new Intl.DateTimeFormat("en", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}`;
  } catch {
    throw new Error("El servidor indicó una zona horaria no reconocida. No se puede cargar la agenda.");
  }
}

const state = {
  settings: null,
  settingsRevision: 0,
  settingsUpdateRevision: 0,
  endpointKey: "",
  readSequences: Object.create(null),
  monitorStatus: null,
  monitorUpdateRevision: 0,
  gatewayError: null,
  timeZone: null,
  agendaDayInitialized: false,
  notificationReception: null,
  legacyHistory: [],
  notificationError: "",
  notificationUpdateRevision: 0,
  localReadSequence: 0,
  historyClearPending: false,
  busy: false,
  view: "tasks",
  staleCollections: new Set(),
  collectionErrors: Object.create(null),
  staleTaskDetails: new Set(),
  staleProjectDetails: new Set(),
  invalidationVersions: Object.create(null),
  views: {
    tasks: defaultTaskView(),
    stats: defaultTaskView(),
    agenda: { day: localDay(), heuristic: DEFAULT_HEURISTIC },
    projects: { status: "open" },
  },
  taskList: null,
  taskDetails: Object.create(null),
  latestTaskDetails: Object.create(null),
  taskDetailErrors: Object.create(null),
  selectedTaskId: null,
  agenda: null,
  stats: null,
  events: null,
  strategies: { filters: [], algorithms: [], heuristics: [] },
  strategyError: "",
  projects: null,
  projectDetails: Object.create(null),
  latestProjectDetails: Object.create(null),
  projectDetailErrors: Object.create(null),
  selectedProjectName: null,
  drafts: Object.create(null),
  pendingFresh: Object.create(null),
  pendingRemoteRefresh: false,
  pendingChanges: { taskIds: [], projectNames: [], eventNames: [], collections: [] },
  pendingRefreshAll: false,
  confirmedOperationPendingRefresh: false,
  pendingConnectionReload: false,
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
  for (const control of mainView.querySelectorAll("button, input, select, textarea")) {
    control.disabled = !ready || state.busy;
  }
  for (const button of document.querySelectorAll("[data-action]")) {
    const action = button.dataset.action;
    if (action === "previous-page") button.disabled = !ready || state.busy || state.views.tasks.page <= 1;
    if (action === "next-page") {
      const last = Number(state.taskList?.totalPages || 0);
      button.disabled = !ready || state.busy || (last > 0 && state.views.tasks.page >= last);
    }
    if (["refresh", "search", "reload", "apply-fresh", "discard-draft-reload", "open-draft", "inline-operation"].includes(action)) {
      button.disabled = !ready || state.busy;
    }
  }
  updateHistoryControls();
  document.querySelectorAll("[data-view]").forEach((button) => {
    button.disabled = state.busy;
    button.classList.toggle("secondary", button.dataset.view !== state.view);
    button.setAttribute("aria-current", button.dataset.view === state.view ? "page" : "false");
  });
}

function setBusy(value) {
  state.busy = value;
  updateConnection();
}

function updateHistoryControls() {
  const button = document.querySelector("#clear-history");
  if (!button) return;
  const hasLocalEntries = Boolean(state.notificationReception?.buffer?.length || state.legacyHistory.length);
  button.disabled = state.historyClearPending || !hasLocalEntries;
}

function applyLocalNotificationState(saved) {
  state.notificationReception = saved.notificationReception;
  state.legacyHistory = saved.history;
  state.notificationError = saved.notificationError || "";
  state.gatewayError = saved.gatewayError;
  state.monitorStatus = saved.monitorStatus;
  renderHistory();
  updateHistoryControls();
}

async function refreshLocalNotifications() {
  const sequence = ++state.localReadSequence;
  try {
    const saved = await readExtensionState();
    if (sequence !== state.localReadSequence) return false;
    applyLocalNotificationState(saved);
    return true;
  } catch {
    if (sequence !== state.localReadSequence) return false;
    state.notificationError = "No se pudo leer la copia local de notificaciones.";
    renderHistory();
    updateHistoryControls();
    return false;
  }
}

async function clearLocalNotifications() {
  if (state.historyClearPending || (!state.notificationReception?.buffer?.length && !state.legacyHistory.length)) return;
  state.historyClearPending = true;
  updateHistoryControls();
  try {
    const reply = assertSuccessfulReply(await clearNotificationBuffer());
    if (reply.data?.cleared !== true || !Number.isSafeInteger(reply.data?.bufferGeneration)) {
      throw new Error("La copia local no confirmó el vaciado.");
    }
    if (state.notificationReception) {
      state.notificationReception = {
        ...state.notificationReception,
        buffer: [],
        bufferGeneration: reply.data.bufferGeneration,
        ...(state.notificationReception.continuity ? {continuity: {...state.notificationReception.continuity, localTruncated: false}} : {}),
      };
    }
    state.legacyHistory = [];
    state.notificationError = "";
    renderHistory();
    updateHistoryControls();
    await refreshLocalNotifications();
    showMessage("Se vaciaron los avisos guardados en este dispositivo.");
  } catch (error) {
    showMessage(error instanceof Error ? error.message : "No se pudo vaciar la copia local.", "error");
  } finally {
    state.historyClearPending = false;
    updateHistoryControls();
  }
}

function requireReady() {
  if (!isReady(state.settings)) throw new Error("Configura el servidor y conecta desde la página de opciones antes de usar el gestor.");
}

function endpointKey(settings) {
  if (typeof settings?.serverUrl !== "string") return "";
  try {
    const url = new URL(settings.serverUrl);
    url.pathname = url.pathname.replace(/\/+$/, "");
    return url.origin + url.pathname;
  } catch {
    return "";
  }
}

function configuredIdentityChanged(previous, next) {
  return endpointKey(previous) !== endpointKey(next) || previous?.token !== next?.token;
}

function draftScope(scope) {
  return { ...scope, endpointKey: state.endpointKey, settingsRevision: state.settingsRevision };
}

function isDraftScopeCurrent(scope) {
  return scope?.endpointKey === state.endpointKey && scope?.settingsRevision === state.settingsRevision;
}

async function readResource(operation, target = null, parameters = {}) {
  requireReady();
  const revision = state.settingsRevision;
  const endpoint = state.endpointKey;
  const reply = await readGateway(operation, target, parameters);
  if (revision !== state.settingsRevision || endpoint !== state.endpointKey) throw new Error("La conexión cambió mientras se actualizaban los datos. Vuelve a actualizar la vista.");
  return assertSuccessfulReply(reply).data;
}

function collectionForView(view) {
  return VIEW_COLLECTIONS[view] || null;
}

function bumpInvalidationVersion(key) {
  state.invalidationVersions[key] = (state.invalidationVersions[key] || 0) + 1;
}

function markChangesStale(change = {}) {
  if (change.refreshAll) markLoadedResourcesStale();
  const collections = new Set(change.collections || []);
  for (const collection of collections) {
    state.staleCollections.add(collection);
    const readKey = COLLECTION_READ_KEYS[collection];
    if (readKey) bumpInvalidationVersion(readKey);
  }
  const taskIds = new Set(change.taskIds || []);
  if (change.target?.kind === "task" && typeof change.target.id === "string") taskIds.add(change.target.id);
  for (const id of taskIds) {
    if (typeof id !== "string" || !id) continue;
    state.staleTaskDetails.add(id);
    bumpInvalidationVersion(`task:${id}`);
  }
  const projectNames = new Set(change.projectNames || []);
  if (change.target?.kind === "project" && typeof change.target.id === "string") projectNames.add(change.target.id);
  for (const name of projectNames) {
    if (typeof name !== "string" || !name) continue;
    state.staleProjectDetails.add(name);
    bumpInvalidationVersion(`project:${name}`);
  }
  if ((change.eventNames || []).some((name) => typeof name === "string" && name) || change.target?.kind === "event") {
    state.staleCollections.add("events");
    if (!collections.has("events")) bumpInvalidationVersion("events");
  }
}

function markLoadedResourcesStale() {
  for (const [collection, value] of Object.entries({
    tasks: state.taskList,
    agenda: state.agenda,
    statistics: state.stats,
    events: state.events,
    projects: state.projects,
  })) {
    if (value || collectionForView(state.view) === collection) {
      state.staleCollections.add(collection);
      const readKey = COLLECTION_READ_KEYS[collection];
      if (readKey) bumpInvalidationVersion(readKey);
    }
  }
  const taskIds = new Set([...Object.keys(state.taskDetails), ...Object.keys(state.latestTaskDetails)]);
  const projectNames = new Set([...Object.keys(state.projectDetails), ...Object.keys(state.latestProjectDetails)]);
  for (const draft of Object.values(state.drafts)) {
    if (!isDraftScopeCurrent(draft?.scope)) continue;
    if (draft.scope.kind === "task" && draft.scope.id) taskIds.add(draft.scope.id);
    if (draft.scope.kind === "project" && draft.scope.id) projectNames.add(draft.scope.id);
  }
  if (state.selectedTaskId) taskIds.add(state.selectedTaskId);
  if (state.selectedProjectName) projectNames.add(state.selectedProjectName);
  for (const id of taskIds) {
    state.staleTaskDetails.add(id);
    bumpInvalidationVersion(`task:${id}`);
  }
  for (const name of projectNames) {
    state.staleProjectDetails.add(name);
    bumpInvalidationVersion(`project:${name}`);
  }
}

function beginRead(key) {
  const sequence = (state.readSequences[key] || 0) + 1;
  state.readSequences[key] = sequence;
  return {
    sequence,
    settingsRevision: state.settingsRevision,
    endpointKey: state.endpointKey,
    invalidationVersion: state.invalidationVersions[key] || 0,
  };
}

function isLatestRead(key, request) {
  return state.readSequences[key] === request.sequence &&
    state.settingsRevision === request.settingsRevision &&
    state.endpointKey === request.endpointKey &&
    (state.invalidationVersions[key] || 0) === request.invalidationVersion;
}

async function readSequenced(key, request, operation, target, parameters, isViewCurrent = () => true) {
  try {
    const data = await readResource(operation, target, parameters);
    if (!isLatestRead(key, request) || !isViewCurrent()) throw supersededRead();
    return data;
  } catch (error) {
    if (error?.supersededRead) throw error;
    if (!isLatestRead(key, request) || !isViewCurrent()) throw supersededRead();
    throw error;
  }
}

function supersededRead() {
  const error = new Error("La respuesta pertenece a una consulta anterior y se ha descartado.");
  error.supersededRead = true;
  return error;
}

async function perform(label, work, { silent = false } = {}) {
  if (state.busy) return;
  setBusy(true);
  if (!silent) showMessage(`${label}…`);
  try {
    await work();
    updateConnection();
  } catch (error) {
    if (!error?.supersededRead && !silent) showMessage(error instanceof Error ? error.message : "No se pudo completar la solicitud.", "error");
  } finally {
    setBusy(false);
    if (state.pendingConnectionReload && isReady(state.settings)) {
      state.pendingConnectionReload = false;
      void reloadConnectedResources();
    } else if (state.pendingRemoteRefresh && isReady(state.settings)) {
      const pending = takePendingChanges();
      void perform("Actualizando datos", async () => {
        const complete = await refreshLoadedData(pending);
        renderMainView();
        if (state.confirmedOperationPendingRefresh) {
          if (complete) showMessage("La acción se confirmó y se cargaron los datos visibles más recientes.");
          else showMessage(`La acción se confirmó, pero los datos visibles siguen pendientes. ${visibleRefreshError()}`, "error");
          state.confirmedOperationPendingRefresh = false;
        } else if (!complete && changeTouchesCurrentResources(pending)) showMessage(visibleRefreshError(), "error");
      }, { silent: true });
    }
  }
}

async function reloadConnectedResources() {
  await perform("Conectando al servidor", async () => {
    const results = await Promise.allSettled([loadRoot(), loadStrategies(), loadTaskList()]);
    if (results[0].status === "rejected" && !results[0].reason?.supersededRead) {
      renderMainView();
      throw results[0].reason;
    }
    if (results[1].status === "rejected") state.strategyError = results[1].reason instanceof Error ? results[1].reason.message : "No se pudo cargar el catálogo.";
    if (results[2].status === "rejected") throw results[2].reason;
    renderMainView();
    showMessage("Conexión actualizada. Los borradores anteriores siguen guardados para su servidor original.");
  });
}

function taskViewParameters(view) {
  return {
    page: view.page,
    pageSize: view.pageSize,
    filters: [...view.filters],
    heuristic: view.heuristic,
    algorithm: view.algorithm,
    search: [...view.search],
  };
}

function isTaskCollection(data) {
  return Boolean(data && typeof data === "object" && Array.isArray(data._embedded?.tasks) && Number.isInteger(data.page) && Number.isInteger(data.pageSize));
}

function isTaskResource(data) {
  return Boolean(data && typeof data === "object" && typeof data.id === "string" && typeof data.description === "string" && Array.isArray(data.actions));
}

function isAgendaResource(data) {
  return Boolean(data && typeof data === "object" && typeof data.day === "string" && data._embedded && Array.isArray(data._embedded.activeUrgentTasks));
}

function resourceKey(kind, id) {
  return `${kind}:${id}`;
}

function draftKey(action, scope) {
  return JSON.stringify([scope.endpointKey ?? state.endpointKey, scope.settingsRevision ?? state.settingsRevision, scope.kind, scope.id ?? null, action.name]);
}

function actionScope(action, resource) {
  const target = action?.target && typeof action.target === "object" ? action.target : {};
  if (typeof target.id === "string") return { kind: target.kind || "resource", id: target.id };
  if (target.kind === "tasks") return { kind: "tasks", id: null };
  if (target.kind === "event") return { kind: "events", id: null };
  if (target.kind === "project") return { kind: "projects", id: null };
  return { kind: resource?.kind || "resource", id: null };
}

function hasDirtyDraft(kind, id) {
  return Object.values(state.drafts).some((draft) => draft?.dirty && isDraftScopeCurrent(draft.scope) && draft.scope?.kind === kind && draft.scope?.id === id);
}

function draftsForResource(kind, id) {
  return Object.entries(state.drafts).filter(([, draft]) => draft?.dirty && isDraftScopeCurrent(draft.scope) && draft.scope?.kind === kind && draft.scope?.id === id);
}

function anyDirtyDrafts() {
  return Object.values(state.drafts).some((draft) => draft?.dirty);
}

function cleanResource(value) {
  if (Array.isArray(value)) return value.map(cleanResource);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "observedAt").map(([key, item]) => [key, cleanResource(item)]));
}

function resourcesDiffer(left, right) {
  return JSON.stringify(cleanResource(left)) !== JSON.stringify(cleanResource(right));
}

async function loadTaskList({ render = false } = {}) {
  const query = taskViewParameters(state.views.tasks);
  const signature = JSON.stringify(query);
  const request = beginRead("tasks.list");
  const data = await readSequenced("tasks.list", request, "tasks.list", null, query,
    () => signature === JSON.stringify(taskViewParameters(state.views.tasks)));
  if (!isTaskCollection(data)) throw new Error("El servidor devolvió una lista de tareas no válida.");
  state.taskList = data;
  state.staleCollections.delete("tasks");
  delete state.collectionErrors.tasks;
  if (render) renderMainView();
  return data;
}

async function loadTaskDetail(taskId, { applyFresh = false } = {}) {
  if (typeof taskId !== "string" || !taskId) throw new Error("La tarea no tiene un identificador válido.");
  const readKey = `task:${taskId}`;
  const request = beginRead(readKey);
  const data = await readSequenced(readKey, request, "tasks.get", { kind: "task", id: taskId }, {});
  if (!isTaskResource(data) || data.id !== taskId) throw new Error("El detalle no corresponde a la tarea solicitada.");
  state.staleTaskDetails.delete(taskId);
  delete state.taskDetailErrors[taskId];
  const current = state.taskDetails[taskId];
  if (current && resourcesDiffer(current, data) && hasDirtyDraft("task", taskId) && !applyFresh) {
    state.latestTaskDetails[taskId] = data;
    state.pendingFresh[resourceKey("task", taskId)] = true;
  } else {
    state.taskDetails[taskId] = data;
    state.latestTaskDetails[taskId] = data;
    delete state.pendingFresh[resourceKey("task", taskId)];
  }
  return data;
}

async function loadAgenda() {
  if (!state.timeZone) await loadRoot();
  if (!state.timeZone) throw new Error("No se conoce la zona horaria del servidor. No se puede cargar la agenda.");
  const query = state.views.agenda;
  const parameters = { day: query.day, heuristic: query.heuristic };
  const signature = JSON.stringify(parameters);
  const request = beginRead("agenda");
  const data = await readSequenced("agenda", request, "agenda.read", null, parameters,
    () => signature === JSON.stringify({ day: state.views.agenda.day, heuristic: state.views.agenda.heuristic }));
  if (!isAgendaResource(data)) throw new Error("El servidor devolvió una agenda no válida.");
  state.agenda = data;
  state.staleCollections.delete("agenda");
  delete state.collectionErrors.agenda;
  return data;
}

async function loadStats() {
  const query = taskViewParameters(state.views.stats);
  const signature = JSON.stringify(query);
  const request = beginRead("statistics");
  const data = await readSequenced("statistics", request, "statistics.read", null, query,
    () => signature === JSON.stringify(taskViewParameters(state.views.stats)));
  if (!data || typeof data !== "object" || !data.workload || !data.slack || !data.remainingEffort) throw new Error("El servidor devolvió estadísticas no válidas.");
  state.stats = data;
  state.staleCollections.delete("statistics");
  delete state.collectionErrors.statistics;
  return data;
}

async function loadEvents() {
  const request = beginRead("events");
  const data = await readSequenced("events", request, "events.list", null, {});
  if (!data || typeof data !== "object" || !Array.isArray(data._embedded?.events)) throw new Error("El servidor devolvió eventos no válidos.");
  state.events = data;
  state.staleCollections.delete("events");
  delete state.collectionErrors.events;
  return data;
}

async function loadStrategies() {
  const request = beginRead("strategies");
  const data = await readSequenced("strategies", request, "strategies.list", null, {});
  const embedded = data?._embedded;
  if (!embedded || !Array.isArray(embedded.filters) || !Array.isArray(embedded.algorithms) || !Array.isArray(embedded.heuristics)) {
    throw new Error("El catálogo del gestor no tiene un formato válido.");
  }
  state.strategies = { filters: embedded.filters, algorithms: embedded.algorithms, heuristics: embedded.heuristics };
  state.strategyError = "";
  return data;
}

async function loadRoot() {
  const request = beginRead("root");
  const root = await readSequenced("root", request, "root.read", null, {});
  if (typeof root?.timeZone !== "string" || !root.timeZone.trim()) throw new Error("El servidor no indicó una zona horaria válida. No se puede cargar la agenda.");
  const initialDay = dayInTimeZone(root.timeZone);
  state.timeZone = root.timeZone;
  if (!state.agendaDayInitialized) {
    state.views.agenda.day = initialDay;
    state.agendaDayInitialized = true;
  }
  return root;
}

async function loadProjects() {
  const query = { status: state.views.projects.status };
  const signature = JSON.stringify(query);
  const request = beginRead("projects.list");
  const data = await readSequenced("projects.list", request, "projects.list", null, query,
    () => signature === JSON.stringify({ status: state.views.projects.status }));
  if (!data || typeof data !== "object" || !Array.isArray(data._embedded?.projects)) throw new Error("El servidor devolvió proyectos no válidos.");
  state.projects = data;
  state.staleCollections.delete("projects");
  delete state.collectionErrors.projects;
  return data;
}

async function loadProjectDetail(name, { applyFresh = false } = {}) {
  if (typeof name !== "string" || !name) throw new Error("El proyecto no tiene un nombre válido.");
  const readKey = `project:${name}`;
  const request = beginRead(readKey);
  const data = await readSequenced(readKey, request, "projects.get", { kind: "project", id: name }, {});
  if (!data || typeof data !== "object" || data.name !== name || !Array.isArray(data.actions)) throw new Error("El detalle no corresponde al proyecto solicitado.");
  state.staleProjectDetails.delete(name);
  delete state.projectDetailErrors[name];
  const current = state.projectDetails[name];
  if (current && resourcesDiffer(current, data) && hasDirtyDraft("project", name) && !applyFresh) {
    state.latestProjectDetails[name] = data;
    state.pendingFresh[resourceKey("project", name)] = true;
  } else {
    state.projectDetails[name] = data;
    state.latestProjectDetails[name] = data;
    delete state.pendingFresh[resourceKey("project", name)];
  }
  return data;
}

function renderMainView() {
  disposeTimePickers();
  updateConnection();
  if (!isReady(state.settings)) {
    const section = panel("Gestor de tareas");
    section.append(emptyState("Abre Configuración, guarda los datos del servidor y conecta."));
    mainView.replaceChildren(section);
    return;
  }

  const visibleCollection = collectionForView(state.view);
  if (visibleCollection && state.staleCollections.has(visibleCollection)) {
    const fragment = document.createDocumentFragment();
    const draftNotice = renderDraftNotice();
    if (draftNotice) fragment.append(draftNotice);
    if (state.view === "tasks") fragment.append(renderTaskViewControls("tasks", state.views.tasks, true));
    const section = panel("Datos pendientes de actualizar", "full");
    if (state.collectionErrors[visibleCollection]) section.append(node("p", state.collectionErrors[visibleCollection], "alert error"));
    section.append(emptyState("Esta vista cambió en el servidor y se volverá a cargar antes de mostrar sus acciones."));
    fragment.append(section);
    mainView.replaceChildren(fragment);
    updateConnection();
    return;
  }

  const fragment = document.createDocumentFragment();
  const draftNotice = renderDraftNotice();
  if (draftNotice) fragment.append(draftNotice);
  if (state.view === "agenda") fragment.append(renderAgendaView());
  else if (state.view === "stats") fragment.append(renderStatsView());
  else if (state.view === "events") fragment.append(renderEventsView());
  else if (state.view === "projects") fragment.append(renderProjectsView());
  else if (state.view === "detail") fragment.append(renderTaskDetailView());
  else fragment.append(renderTasksView());
  mainView.replaceChildren(fragment);
  bindTimePickers(mainView);
  updateConnection();
}

function renderDraftNotice() {
  const entries = Object.entries(state.drafts).filter(([, draft]) => draft?.dirty);
  if (!entries.length && !Object.keys(state.pendingFresh).length) return null;
  const section = panel("Cambios guardados en esta pantalla", "full draft-notice");
  section.id = "draft-notice";
  if (entries.length) {
    section.append(node("p", "Los formularios pendientes siguen ligados a su tarea o proyecto. Actualizar datos no los cambia."));
    const list = node("ul", null, "draft-list");
    for (const [key, draft] of entries) {
      const item = node("li", null, "draft-item");
      const identity = draft.identity || draft.scope?.id || "nuevo recurso";
      const typeName = draft.scope?.kind === "task" ? "Tarea" : draft.scope?.kind === "project" ? "Proyecto" : "Formulario";
      const stateText = state.pendingFresh[resourceKey(draft.scope?.kind, draft.scope?.id)] ? " · hay datos nuevos" : "";
      item.append(node("span", `${typeName}: ${identity} · ${actionLabel(draft.actionName)}${stateText}`));
      if (!isDraftScopeCurrent(draft.scope)) {
        item.append(node("small", `Guardado para ${connectionLabel(draft.scope)}; no se puede enviar con la conexión actual.`, "caption"));
        item.append(actionButton("Descartar borrador local", "discard-old-draft", { draftKey: key }));
        list.append(item);
        continue;
      }
      if (draft.scope?.kind === "task" && draft.scope.id) item.append(actionButton("Abrir tarea", "open-draft", { draftKey: key }));
      else if (draft.scope?.kind === "project" && draft.scope.id) item.append(actionButton("Abrir proyecto", "open-draft", { draftKey: key }));
      if (draft.scope?.id && state.pendingFresh[resourceKey(draft.scope.kind, draft.scope.id)]) {
        item.append(actionButton("Cargar datos actuales", "apply-fresh", { kind: draft.scope.kind, resourceId: draft.scope.id }));
      }
      item.append(actionButton(`Descartar borrador de ${identity} y cargar datos actuales`, "discard-draft-reload", { draftKey: key }));
      list.append(item);
    }
    section.append(list);
  }
  if (!entries.length) section.append(node("p", "Hay datos nuevos. Actualiza la vista cuando quieras cargar la versión actual."));
  return section;
}

function renderTasksView() {
  const fragment = document.createDocumentFragment();
  fragment.append(renderTaskViewControls("tasks", state.views.tasks, true));
  const tasks = state.taskList?._embedded?.tasks ?? [];
  fragment.append(taskTable("Tareas", tasks, (task) => void selectTask(task.id), { selectedId: state.selectedTaskId }));
  if (state.taskList) {
    fragment.append(keyValuePanel("Resultado de la consulta", [
      ["Total", state.taskList.total],
      ["Página", `${state.taskList.page}/${state.taskList.totalPages}`],
      ["Tamaño de página", state.taskList.pageSize],
      ["Algoritmo", state.taskList.algorithm?.name],
      ["Heurística", state.taskList.heuristic],
      ["Filtros", state.views.tasks.filters.join(", ") || "Ninguno"],
      ["Búsqueda", state.views.tasks.search.join(", ") || "Sin términos"],
    ]));
    if (state.taskList.algorithm?.description) fragment.append(keyValuePanel("Descripción del algoritmo", [["Información", state.taskList.algorithm.description]]));
  }
  const createAction = publishedAction(state.taskList, "create-task");
  if (createAction) fragment.append(renderActionForm(createAction, null, { kind: "tasks", id: null }, "create-task"));
  if (state.selectedTaskId) fragment.append(renderSelectedTaskPanel(state.selectedTaskId));
  return fragment;
}

function renderTaskViewControls(prefix, view, showPaging) {
  const section = panel(prefix === "tasks" ? "Consulta de tareas" : "Consulta de estadísticas", "full query-controls");
  const domPrefix = prefix === "tasks" ? "task" : prefix;
  const grid = node("div", null, "query-grid");
  const selectControl = (id, labelText, values, selected, multiple = false) => {
    const holder = node("div", null, "control-field");
    const label = node("label", labelText);
    label.htmlFor = id;
    const select = node("select", null, multiple ? "multi-select" : "");
    select.id = id;
    select.multiple = multiple;
    if (!multiple) {
      const option = node("option", "Selecciona una opción");
      option.value = "";
      select.append(option);
    }
    for (const item of values) {
      const option = node("option", item.name);
      option.value = item.name;
      option.selected = multiple ? selected.includes(item.name) : item.name === selected;
      select.append(option);
    }
    holder.append(label, select);
    grid.append(holder);
    return select;
  };

  const filterEntries = state.strategies.filters.some((entry) => entry.name === DEFAULT_FILTER)
    ? state.strategies.filters
    : [{ id: DEFAULT_FILTER, name: DEFAULT_FILTER, description: "Todas las tareas activas." }, ...state.strategies.filters];
  const filters = selectControl(`${domPrefix}-filters`, "Filtros", filterEntries, view.filters, true);
  const algorithm = selectControl(`${domPrefix}-algorithm`, "Orden", state.strategies.algorithms, view.algorithm);
  const heuristic = selectControl(`${domPrefix}-heuristic`, "Heurística", state.strategies.heuristics, view.heuristic);
  filters.addEventListener("change", () => {
    view.filters = Array.from(filters.selectedOptions, (option) => option.value);
    view.page = 1;
    void perform("Actualizando tareas", async () => { await (prefix === "tasks" ? loadTaskList() : loadStats()); renderMainView(); });
  });
  algorithm.addEventListener("change", () => {
    if (!algorithm.value) return;
    view.algorithm = algorithm.value;
    view.page = 1;
    void perform("Actualizando tareas", async () => { await (prefix === "tasks" ? loadTaskList() : loadStats()); renderMainView(); });
  });
  heuristic.addEventListener("change", () => {
    if (!heuristic.value) return;
    view.heuristic = heuristic.value;
    view.page = 1;
    void perform("Actualizando tareas", async () => { await (prefix === "tasks" ? loadTaskList() : loadStats()); renderMainView(); });
  });

  const searchForm = node("form", null, "inline-search");
  searchForm.id = `${domPrefix}-search-form`;
  const searchLabel = node("label", "Buscar");
  searchLabel.htmlFor = `${domPrefix}-search`;
  const search = node("input");
  search.id = `${domPrefix}-search`;
  search.type = "search";
  search.placeholder = "Palabras separadas por espacios";
  search.value = view.search.join(" ");
  const searchButton = node("button", "Buscar");
  searchButton.type = "submit";
  searchButton.dataset.action = "search";
  searchForm.append(searchLabel, search, searchButton);
  searchForm.addEventListener("submit", (event) => {
    event.preventDefault();
    view.search = search.value.trim().split(/\s+/).filter(Boolean);
    view.page = 1;
    void perform("Buscando tareas", async () => { await (prefix === "tasks" ? loadTaskList() : loadStats()); renderMainView(); });
  });
  grid.append(searchForm);

  if (showPaging) {
    const paging = node("div", null, "paging-controls");
    const pageLabel = node("label", "Página");
    pageLabel.htmlFor = "task-page";
    const page = node("input");
    page.id = "task-page";
    page.type = "number";
    page.min = "1";
    page.step = "1";
    page.value = String(view.page);
    const sizeLabel = node("label", "Filas por página");
    sizeLabel.htmlFor = "task-page-size";
    const size = node("input");
    size.id = "task-page-size";
    size.type = "number";
    size.min = "1";
    size.step = "1";
    size.value = String(view.pageSize);
    const go = node("button", "Ir");
    go.type = "button";
    go.addEventListener("click", () => {
      const pageValue = Number(page.value);
      const sizeValue = Number(size.value);
      if (!Number.isSafeInteger(pageValue) || pageValue < 1 || !Number.isSafeInteger(sizeValue) || sizeValue < 1) {
        showMessage("La página y el tamaño deben ser números enteros positivos.", "error");
        return;
      }
      view.page = pageValue;
      view.pageSize = sizeValue;
      void perform("Actualizando página", async () => { await loadTaskList(); renderMainView(); });
    });
    const previous = node("button", "Anterior", "secondary");
    previous.type = "button";
    previous.dataset.action = "previous-page";
    previous.disabled = view.page <= 1;
    const next = node("button", "Siguiente", "secondary");
    next.type = "button";
    next.dataset.action = "next-page";
    next.disabled = Number(state.taskList?.totalPages || 0) > 0 && view.page >= Number(state.taskList.totalPages);
    paging.append(pageLabel, page, sizeLabel, size, go, previous, next);
    grid.append(paging);
  }
  section.append(grid);
  if (state.strategyError) section.append(node("p", state.strategyError, "caption error-text"));
  return section;
}

function renderSelectedTaskPanel(taskId) {
  const task = state.taskDetails[taskId];
  const section = node("section", null, "full task-detail-area");
  const toolbar = node("div", null, "panel-header");
  const title = node("h2", "Detalle de la tarea");
  title.id = "task-detail-title";
  toolbar.append(title, actionButton("Actualizar datos", "reload"));
  section.append(toolbar);
  section.dataset.selectedTaskId = taskId;
  if (state.staleTaskDetails.has(taskId)) {
    if (state.taskDetailErrors[taskId]) section.append(node("p", state.taskDetailErrors[taskId], "alert error"));
    else section.append(emptyState("Los datos de esta tarea están pendientes de actualizar. Sus acciones volverán a aparecer al cargar la versión actual."));
    return section;
  }
  if (state.taskDetailErrors[taskId]) section.append(node("p", state.taskDetailErrors[taskId], "alert error"));
  if (!task) {
    section.append(emptyState("Cargando el detalle de la tarea…"));
    return section;
  }
  const detail = taskInfoPanel(task, "Información de tarea");
  detail.id = "task-detail";
  detail.dataset.selectedTaskId = taskId;
  detail.dataset.taskId = taskId;
  const stale = renderDraftNoticeForTarget("task", taskId);
  if (stale) section.append(stale);
  section.append(detail);
  const complete = publishedAction(task, "complete-task");
  if (complete && !Object.keys(complete.inputs).length) toolbar.append(renderImmediateAction(complete, { kind: "task", id: task.id }, task.description));
  section.append(renderTaskActions(task));
  return section;
}

function renderTaskDetailView() {
  const fragment = document.createDocumentFragment();
  if (state.selectedTaskId) fragment.append(renderSelectedTaskPanel(state.selectedTaskId));
  else {
    const section = panel("Detalle de la tarea");
    section.append(emptyState("Selecciona una tarea de la lista o de la agenda."));
    fragment.append(section);
  }
  return fragment;
}

function renderTaskActions(task) {
  const section = panel("Acciones disponibles para esta tarea", "full action-forms");
  section.dataset.selectedTaskId = task.id;
  const actions = Array.isArray(task.actions) ? task.actions : [];
  if (!actions.length) {
    section.append(emptyState("Esta tarea no publica acciones disponibles."));
    return section;
  }
  const forms = node("div", null, "forms-grid");
  for (const action of actions) {
    if (!isPublishedAction(action)) continue;
    if (action.name === "edit-task") forms.append(renderEditTaskForm(action, task));
    else if (action.name === "complete-task" && !Object.keys(action.inputs || {}).length) continue;
    else forms.append(renderActionForm(action, task, { kind: "task", id: task.id }, `task:${task.id}`));
  }
  if (!forms.childElementCount) forms.append(emptyState("No hay acciones disponibles."));
  section.append(forms);
  return section;
}

function renderAgendaView() {
  const fragment = document.createDocumentFragment();
  const controls = panel("Agenda", "full query-controls");
  const grid = node("div", null, "query-grid");
  const dateLabel = node("label", "Día");
  dateLabel.htmlFor = "agenda-day";
  const date = node("input");
  date.id = "agenda-day";
  date.type = "date";
  date.value = state.views.agenda.day;
  date.addEventListener("change", () => {
    if (!date.value) return;
    state.views.agenda.day = date.value;
    void perform("Actualizando agenda", async () => { await loadAgenda(); renderMainView(); });
  });
  const heuristicLabel = node("label", "Heurística");
  heuristicLabel.htmlFor = "agenda-heuristic";
  const heuristic = node("select");
  heuristic.id = "agenda-heuristic";
  appendCatalogOptions(heuristic, state.strategies.heuristics, state.views.agenda.heuristic);
  heuristic.addEventListener("change", () => {
    if (!heuristic.value) return;
    state.views.agenda.heuristic = heuristic.value;
    void perform("Actualizando agenda", async () => { await loadAgenda(); renderMainView(); });
  });
  const refresh = actionButton("Actualizar datos", "reload");
  grid.append(dateLabel, date, heuristicLabel, heuristic, refresh);
  controls.append(grid);
  fragment.append(controls);
  if (!state.agenda) {
    const empty = panel("Agenda", "full");
    empty.append(emptyState("Carga la agenda para ver las tareas del día."));
    fragment.append(empty);
  }
  else {
    fragment.append(keyValuePanel("Día y zona", [["Día", state.agenda.day], ["Zona horaria", state.agenda.timeZone], ["Heurística", state.agenda.heuristic]]));
    const embedded = state.agenda._embedded;
    const onSelect = (task) => void selectTask(task.id);
    fragment.append(taskTable("Urgentes activas", embedded.activeUrgentTasks, onSelect, { selectedId: state.selectedTaskId }));
    fragment.append(taskTable("Urgentes planificadas", embedded.plannedUrgentTasks || [], onSelect, { selectedId: state.selectedTaskId }));
    fragment.append(taskTable("Otras tareas", embedded.otherTasks || [], onSelect, { selectedId: state.selectedTaskId }));
    for (const [day, tasks] of Object.entries(embedded.plannedTasksByDate || {})) {
      fragment.append(taskTable(`Planificadas · ${day}`, tasks, onSelect, { selectedId: state.selectedTaskId }));
    }
  }
  if (state.selectedTaskId) fragment.append(renderSelectedTaskPanel(state.selectedTaskId));
  return fragment;
}

function renderStatsView() {
  const fragment = document.createDocumentFragment();
  fragment.append(renderTaskViewControls("stats", state.views.stats, false));
  if (!state.stats) {
    const empty = panel("Estadísticas", "full");
    empty.append(emptyState("Carga las estadísticas para ver el resumen de trabajo."));
    fragment.append(empty);
    return fragment;
  }
  const stats = state.stats;
  fragment.append(keyValuePanel("Carga de trabajo", [
    ["Tareas incluidas", stats.taskCount],
    ["Coste total", formatAmount(stats.workload)],
    ["Esfuerzo pendiente", formatAmount(stats.remainingEffort)],
    ["Margen", `${stats.slack?.name || "—"}: ${finite(stats.slack?.value, 3)}`],
    ["Mayor carga", stats.offender || "—"],
    ["Límite de carga", formatAmount(stats.offenderWorkload)],
    ["Zona horaria", stats.timeZone],
  ]));
  const byDay = panel("Trabajo registrado por día", "full");
  const list = node("ul");
  for (const [day, amount] of Object.entries(stats.workDone || {})) list.append(node("li", `${day}: ${amount} pomodoros`));
  if (!list.childElementCount) list.append(node("li", "Sin registros."));
  byDay.append(list);
  fragment.append(byDay);
  const workLog = panel("Detalle del trabajo", "full");
  const entries = stats.workDoneLog || [];
  if (!entries.length) workLog.append(emptyState("No hay entradas de trabajo."));
  else {
    const table = node("table");
    const head = node("thead");
    const headRow = node("tr");
    for (const value of ["Momento", "Tarea", "Esfuerzo"]) headRow.append(node("th", value));
    head.append(headRow);
    const body = node("tbody");
    for (const entry of entries) {
      const row = node("tr");
      row.append(node("td", formatTimestamp(entry.timestamp)), node("td", entry.task), node("td", `${entry.workUnits} ${entry.unit || "pomodoro"}`));
      body.append(row);
    }
    table.append(head, body);
    const wrap = node("div", null, "table-wrap");
    wrap.append(table);
    workLog.append(wrap);
  }
  fragment.append(workLog);
  return fragment;
}

function renderEventsView() {
  const fragment = document.createDocumentFragment();
  if (!state.events) {
    const empty = panel("Eventos", "full");
    empty.append(emptyState("Carga los eventos para ver su estado."));
    fragment.append(empty);
    return fragment;
  }
  const events = state.events;
  fragment.append(keyValuePanel("Resumen de eventos", [
    ["Eventos", events.totalEvents],
    ["Tareas que los activan", events.totalRaisingTasks],
    ["Tareas en espera", events.totalWaitingTasks],
    ["Eventos sin relación", events.orphanedEvents],
  ]));
  const section = panel("Eventos y tareas relacionadas", "full");
  const rows = events._embedded.events;
  if (!rows.length) section.append(emptyState("No hay eventos registrados."));
  else {
    const table = node("table");
    const head = node("thead");
    const heading = node("tr");
    for (const value of ["Evento", "Lo activan", "Lo esperan", "Sin relación", "Tipo", "Acción"]) heading.append(node("th", value));
    head.append(heading);
    const body = node("tbody");
    for (const event of rows) {
      const row = node("tr", null, event.orphaned ? "orphaned" : "");
      for (const value of [event.name, event.raisingTasks, event.waitingTasks, event.orphaned ? "Sí" : "No", event.orphanType]) row.append(node("td", value));
      const actionCell = node("td");
      const action = publishedAction(event, "raise-event");
      if (action) actionCell.append(renderImmediateAction(action, action.target, event.name));
      row.append(actionCell);
      body.append(row);
    }
    table.append(head, body);
    const wrap = node("div", null, "table-wrap");
    wrap.append(table);
    section.append(wrap);
  }
  fragment.append(section);
  const createEvent = publishedAction(events, "raise-event");
  if (createEvent && !createEvent.target?.id) fragment.append(renderActionForm(createEvent, null, { kind: "events", id: null }, "raise-event"));
  return fragment;
}

function renderProjectsView() {
  const fragment = document.createDocumentFragment();
  const controls = panel("Proyectos", "full query-controls");
  const row = node("div", null, "query-grid");
  const label = node("label", "Estado");
  label.htmlFor = "project-status";
  const select = node("select");
  select.id = "project-status";
  for (const [value, text] of [["open", "Abiertos"], ["closed", "Cerrados"], ["hold", "En espera"]]) {
    const option = node("option", text);
    option.value = value;
    option.selected = value === state.views.projects.status;
    select.append(option);
  }
  select.addEventListener("change", () => {
    state.views.projects.status = select.value;
    void perform("Actualizando proyectos", async () => { await loadProjects(); renderMainView(); });
  });
  row.append(label, select, actionButton("Actualizar datos", "reload"));
  controls.append(row);
  fragment.append(controls);
  if (!state.projects) {
    const empty = panel("Proyectos", "full");
    empty.append(emptyState("Carga los proyectos para verlos."));
    fragment.append(empty);
  }
  else {
    const projects = state.projects._embedded.projects;
    const section = panel("Proyectos disponibles", "full");
    if (!projects.length) section.append(emptyState("No hay proyectos con este estado."));
    else {
      const list = node("ul", null, "project-list");
      for (const project of projects) {
        const item = node("li");
        const open = node("button", project.name, "link-button");
        open.type = "button";
        open.dataset.projectName = project.name;
        open.addEventListener("click", () => void selectProject(project.name));
        item.append(open, node("span", ` · ${projectStatusLabel(project.status)}`));
        if (project.description) item.append(node("p", project.description, "caption"));
        list.append(item);
      }
      section.append(list);
    }
    fragment.append(section);
    const createAction = publishedAction(state.projects, "open-project");
    if (createAction) fragment.append(renderActionForm(createAction, null, { kind: "projects", id: null }, "open-project"));
  }
  if (state.selectedProjectName) fragment.append(renderProjectDetail(state.selectedProjectName));
  return fragment;
}

function renderProjectDetail(name) {
  const project = state.projectDetails[name];
  const section = panel("Detalle del proyecto", "full project-detail");
  section.dataset.projectName = name;
  if (state.staleProjectDetails.has(name)) {
    if (state.projectDetailErrors[name]) section.append(node("p", state.projectDetailErrors[name], "alert error"));
    else section.append(emptyState("Los datos de este proyecto están pendientes de actualizar. Sus acciones volverán a aparecer al cargar la versión actual."));
    return section;
  }
  if (state.projectDetailErrors[name]) section.append(node("p", state.projectDetailErrors[name], "alert error"));
  if (!project) {
    section.append(emptyState("Cargando el detalle del proyecto…"));
    return section;
  }
  const stale = renderDraftNoticeForTarget("project", name);
  if (stale) section.append(stale);
  const title = node("h3", project.name);
  title.dataset.projectName = project.name;
  section.append(title, keyValuePanel("Estado", [["Proyecto", project.name], ["Estado", projectStatusLabel(project.status)], ["Descripción", project.description || "—"]]));
  if (typeof project.content === "string") section.append(node("pre", project.content, "project-content"));
  const forms = node("div", null, "forms-grid");
  for (const action of project.actions || []) {
    if (!isPublishedAction(action)) continue;
    if (["close-project", "hold-project"].includes(action.name) && !Object.keys(action.inputs || {}).length) {
      forms.append(renderImmediateAction(action, { kind: "project", id: name }, project.name));
    } else forms.append(renderActionForm(action, project, { kind: "project", id: name }, `project:${name}`));
  }
  if (forms.childElementCount) section.append(forms);
  return section;
}

function renderActionForm(action, resource, scope, resourceType) {
  if (!isPublishedAction(action)) return node("div");
  const ownedScope = draftScope(scope);
  const key = draftKey(action, ownedScope);
  const initialValues = {};
  for (const [field, descriptor] of Object.entries(action.inputs || {})) {
    if (field === "changes" || field === "effortDelta") continue;
    const initial = defaultForField(field, descriptor, resource, action);
    initialValues[field] = descriptor.format === "date-time" ? dateTimeControlValue(initial) : initial === null || initial === undefined ? "" : String(initial);
  }
  const draft = ensureDraft(key, action, ownedScope, resource, initialValues);
  const form = node("form", null, "capability-form");
  const duplicateCollectionAction = action.name === "open-project" && scope.kind === "project" && scope.id;
  const controlScope = duplicateCollectionAction ? `project-${safeDomToken(scope.id)}` : "";
  form.id = `action-form-${action.name}${duplicateCollectionAction ? `--${controlScope}` : ""}`;
  form.dataset.draftKey = key;
  form.dataset.actionName = action.name;
  if (scope.kind === "task" && scope.id) form.dataset.taskId = scope.id;
  if (scope.kind === "project" && scope.id) form.dataset.projectName = scope.id;
  const heading = node("h3", actionLabel(action.name));
  form.append(heading);
  if (action.name === "edit-project-content") form.append(node("p", "Los campos disponibles dependen del formato guardado por el servidor.", "caption"));
  for (const [field, descriptor] of Object.entries(action.inputs || {})) {
    if (field === "changes" || field === "effortDelta") continue;
    const initial = defaultForField(field, descriptor, resource, action);
    const draftValue = draft.touched.includes(field) ? draft.values[field] : undefined;
    const control = makeControl(field, descriptor, initial, draftValue, controlScope);
    if (control) form.append(control);
  }
  rememberDraftBaseline(draft, form);
  const submit = node("button", actionLabel(action.name));
  submit.type = "submit";
  form.append(submit);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    void submitPublishedAction(action, resource, scope, key, form, resourceType);
  });
  return form;
}

function renderEditTaskForm(action, task) {
  if (!isPublishedAction(action)) return node("div");
  const scope = draftScope({ kind: "task", id: task.id });
  const key = draftKey(action, scope);
  const properties = action.inputs?.changes?.properties || {};
  const initialValues = Object.fromEntries(Object.keys(properties).map((field) => [`changes.${field}`, editFieldValue(field, task)]));
  initialValues.effortDelta = "";
  const draft = ensureDraft(key, action, scope, task, initialValues);
  const form = node("form", null, "capability-form edit-task-form");
  form.id = "action-form-edit-task";
  form.dataset.draftKey = key;
  form.dataset.actionName = action.name;
  form.dataset.taskId = task.id;
  form.append(node("h3", "Editar tarea"), node("p", "Los cambios de campos y el esfuerzo se guardan juntos en una sola operación.", "caption"));
  for (const [field, descriptor] of Object.entries(properties)) {
    const initial = editFieldValue(field, task);
    const name = `changes.${field}`;
    const draftValue = draft.touched.includes(name) ? draft.values[name] : undefined;
    const control = makeControl(name, descriptor, initial, draftValue);
    if (control) form.append(control);
  }
  const effortDescriptor = action.inputs?.effortDelta;
  if (effortDescriptor) {
    const initial = "";
    const draftValue = draft.touched.includes("effortDelta") ? draft.values.effortDelta : undefined;
    const control = makeControl("effortDelta", effortDescriptor, initial, draftValue);
    if (control) form.append(control);
  }
  rememberDraftBaseline(draft, form);
  const submit = node("button", "Guardar cambios");
  submit.type = "submit";
  form.append(submit);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    void submitEditTask(action, task, key, form);
  });
  return form;
}

function renderImmediateAction(action, target, identity) {
  if (!isPublishedAction(action)) return node("span");
  const button = node("button", actionLabel(action.name), action.name === "complete-task" ? "danger-button" : "secondary");
  button.type = "button";
  button.dataset.action = "inline-operation";
  button.dataset.operationName = action.name;
  button.dataset.operationTarget = JSON.stringify(target || action.target);
  button.dataset.identity = identity || "";
  button.dataset.settingsRevision = String(state.settingsRevision);
  button.dataset.endpointKey = state.endpointKey;
  return button;
}

function renderDraftNoticeForTarget(resourceType, id) {
  const pending = state.pendingFresh[resourceKey(resourceType, id)];
  if (!pending) return null;
  const section = node("div", null, "stale-notice");
  section.id = "stale-notice";
  section.append(node("p", `Hay datos nuevos para ${resourceType === "task" ? "esta tarea" : "este proyecto"}. Tu borrador sigue ligado a ${id}.`));
  section.append(actionButton("Cargar datos actuales", "apply-fresh", { kind: resourceType, resourceId: id }));
  return section;
}

function isPublishedAction(action) {
  return Boolean(action && typeof action.name === "string" && action.method === "POST" && action.contentType === "application/json" && action.href && action.target && typeof action.target.kind === "string" && action.inputs && typeof action.inputs === "object");
}

function publishedAction(resource, name) {
  return Array.isArray(resource?.actions) ? resource.actions.find((action) => action.name === name && isPublishedAction(action)) || null : null;
}

function ensureDraft(key, action, scope, resource, initialValues) {
  if (!state.drafts[key]) {
    const identity = resource?.description || resource?.name || scope.id || actionLabel(action.name);
    state.drafts[key] = {
      key,
      actionName: action.name,
      action,
      scope: { ...scope },
      identity,
      values: { ...initialValues },
      originalValues: { ...initialValues },
      touched: [],
      dirty: false,
    };
  } else {
    state.drafts[key].action = action;
    state.drafts[key].scope = { ...scope };
    state.drafts[key].identity = resource?.description || resource?.name || state.drafts[key].identity;
  }
  return state.drafts[key];
}

function rememberDraftBaseline(draft, form) {
  if (Object.keys(draft.originalValues || {}).length) return;
  draft.originalValues = formValues(form);
}

function makeControl(name, descriptor, initialValue, draftValue, controlScope = "") {
  if (!descriptor || typeof descriptor !== "object") return null;
  const holder = node("div", null, "control-field");
  const label = node("label", labelForField(name));
  const inputId = controlId(name, controlScope);
  label.htmlFor = inputId;
  const selectedValue = draftValue !== undefined ? draftValue : (initialValue !== undefined ? initialValue : descriptor.default);
  const typeList = Array.isArray(descriptor.type) ? descriptor.type : [descriptor.type];
  const isBoolean = typeList.includes("boolean");
  let control;
  if (isBoolean) {
    control = node("select");
    const blank = node("option", "Sin cambios");
    blank.value = "";
    control.append(blank);
    for (const value of ["true", "false"]) {
      const option = node("option", value === "true" ? "Sí" : "No");
      option.value = value;
      option.selected = String(selectedValue) === value;
      control.append(option);
    }
  } else if (Array.isArray(descriptor.enum)) {
    control = node("select");
    const blank = node("option", descriptor.required ? "Selecciona una opción" : "Sin cambios");
    blank.value = "";
    control.append(blank);
    for (const value of descriptor.enum) {
      const option = node("option", enumLabel(name, value));
      option.value = value;
      option.selected = String(selectedValue) === String(value);
      control.append(option);
    }
  } else if (name === "context" || name === "changes.context") {
    control = node("select");
    const prefixes = Array.isArray(descriptor.startsWithAny) ? descriptor.startsWithAny : state.strategies.filters.map(filter => /^Tasks with context starting with (.+)$/.exec(filter.description || "")?.[1]);
    const options = [...new Set(prefixes.filter(value => typeof value === "string" && value))];
    if (selectedValue && !options.includes(String(selectedValue))) options.push(String(selectedValue));
    const blank = node("option", "Selecciona un contexto");
    blank.value = "";
    control.append(blank);
    for (const value of options) {
      const option = node("option", value);
      option.value = value;
      option.selected = String(selectedValue) === value;
      control.append(option);
    }
    let customValue = "__custom_context__";
    while (options.includes(customValue)) customValue += "_";
    control.dataset.customValue = customValue;
    const customOption = node("option", "Escribir otro contexto…");
    customOption.value = customValue;
    control.append(customOption);
    control.value = selectedValue || "";
    const customGroup = node("div", null, "custom-context");
    customGroup.hidden = true;
    const customLabel = node("label", "Contexto personalizado");
    customLabel.htmlFor = `${inputId}-custom`;
    const custom = node("input");
    custom.type = "text";
    custom.id = customLabel.htmlFor;
    custom.name = `${name}.custom`;
    custom.dataset.ownerField = name;
    customGroup.append(customLabel, custom);
    control.addEventListener("change", () => {
      customGroup.hidden = control.value !== customValue;
    });
    holder.append(customGroup);
  } else if (name === "description" || name === "content" || name.endsWith(".description")) {
    control = node("textarea");
    control.rows = 3;
    control.value = selectedValue ?? "";
  } else {
    control = node("input");
    if (name === "changes.totalCost" || name === "totalCost") control.type = "text";
    else if (typeList.includes("integer") || typeList.includes("number")) control.type = "number";
    else control.type = descriptor.format === "date-time" ? "date" : "text";
    if (control.type === "number") {
      control.step = typeList.includes("integer") ? "1" : "any";
      if (Number.isFinite(descriptor.minimum)) control.min = String(descriptor.minimum);
      if (Number.isFinite(descriptor.maximum)) control.max = String(descriptor.maximum);
    }
    control.value = selectedValue ?? "";
    if (descriptor.format === "date-time") {
      const { local, timeZone } = dateTimeParts(selectedValue);
      const [day = "", clock = ""] = local.split("T");
      control.value = day;
      control.dataset.dateTimePart = "date";
      const timeLabel = node("label", `Hora de ${labelForField(name).toLowerCase()}`);
      timeLabel.htmlFor = `${inputId}-time`;
      const time = node("input");
      time.type = "time";
      time.step = "0.001";
      time.id = timeLabel.htmlFor;
      time.name = `${name}.time`;
      time.dataset.ownerField = name;
      time.value = clock;
      const timeGroup = node("div", null, "time-control");
      const zone = node("input");
      zone.type = "hidden";
      zone.id = `${inputId}-zone`;
      zone.name = `${name}.zone`;
      zone.dataset.ownerField = name;
      zone.value = timeZone;
      const zoneLabel = node("small", `Zona horaria: ${timeZone}`, "caption");
      zoneLabel.id = `${zone.id}-label`;
      const choose = node("button", "Elegir hora y zona", "secondary");
      choose.type = "button";
      choose.dataset.timePicker = name;
      const row = node("div", null, "time-picker-row");
      const pickerHost = node("div");
      pickerHost.hidden = true;
      const pickerInput = node("input", null, "time-picker-input");
      pickerInput.type = "text";
      pickerHost.append(pickerInput);
      row.append(time, choose, pickerHost);
      timeGroup.append(timeLabel, row, zone, zoneLabel);
      holder.append(timeGroup);
      control.addEventListener("change", () => {
        if (control.value && !time.value) time.value = "00:00";
      });
    }
    if (name === "changes.totalCost" || name === "totalCost") control.placeholder = "1.5";
    else if (name === "effortDelta") control.placeholder = "30m o 0.5";
  }
  control.id = inputId;
  control.name = name;
  control.dataset.fieldType = typeList.join("|");
  const stringType = typeList.includes("string");
  if (descriptor.required === true && (!stringType || Number(descriptor.minLength) > 0)) control.required = true;
  if (descriptor.minLength) control.minLength = descriptor.minLength;
  if (descriptor.maxLength) control.maxLength = descriptor.maxLength;
  if (name === "changes.totalCost" || name === "totalCost") control.inputMode = "decimal";
  holder.prepend(label, control);
  const help = inputHelp(name, descriptor);
  if (help) holder.append(node("small", help, "caption"));
  return holder;
}

function inputHelp(name, descriptor) {
  if (Array.isArray(descriptor.startsWithAny) && descriptor.startsWithAny.length) return `Prefijos admitidos: ${descriptor.startsWithAny.join(", ")}`;
  if (descriptor.format === "time-amount" || descriptor.type === "duration") return "Usa unidades como 30m, 1.5p o HH:MM.";
  if (descriptor.format === "date-time") return "Elige la hora y la zona en el popup. La zona inicial es la de este navegador.";
  if (name === "changes.totalCost" || name === "totalCost") return "Cantidad decimal en pomodoros; conserva los decimales escritos.";
  if (name === "changes.raised" || name === "changes.waited") return "Deja el campo vacío para quitar el evento.";
  if (name === "line") return "La numeración empieza en 1.";
  return "";
}

function defaultForField(name, descriptor, resource, action) {
  if (name === "target.id") return action?.target?.id || "";
  if (name === "totalCost" && resource?.totalCost) return resource.totalCost.value;
  if (name === "description" && action.name === "edit-project-content" && resource?.description !== undefined) return resource.description || "";
  if (name === "description" && action.name === "create-task") return "";
  if (name === "description" && action.name === "open-project") return "";
  if (name === "line") return "1";
  return descriptor.default ?? "";
}

function editFieldValue(field, task) {
  const value = task?.[field];
  if (field === "totalCost") return value && typeof value === "object" ? value.value ?? "" : "";
  if (value === null || value === undefined) return "";
  if (field === "start" || field === "due") return dateTimeControlValue(value);
  return String(value);
}

function labelForField(name) {
  const labels = {
    "target.id": "Nombre",
    description: "Descripción",
    context: "Contexto",
    start: "Inicio",
    due: "Vencimiento",
    severity: "Severidad",
    totalCost: "Coste restante en pomodoros",
    "changes.description": "Descripción",
    "changes.context": "Contexto",
    "changes.start": "Inicio",
    "changes.due": "Vencimiento",
    "changes.severity": "Severidad",
    "changes.totalCost": "Coste restante en pomodoros",
    "changes.calm": "Mantener tarea en calma",
    "changes.raised": "Evento que activa",
    "changes.waited": "Evento que espera",
    effortDelta: "Esfuerzo realizado",
    duration: "Duración",
    effortPerDay: "Trabajo esperado por día",
    action: "Cambio",
    line: "Línea",
    position: "Posición",
    content: "Texto",
  };
  return labels[name] || humanField(name);
}

function controlId(name, scope = "") {
  const base = `field-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
  return scope ? `${base}--${scope}` : base;
}

function safeDomToken(value) {
  const encoded = Array.from(String(value), (character) => character.codePointAt(0).toString(16)).join("-");
  return encoded || "empty";
}

function enumLabel(field, value) {
  if (field === "action") return ({ replace: "Reemplazar", insert: "Insertar", delete: "Eliminar" })[value] || value;
  return value;
}

function projectStatusLabel(status) {
  return ({ open: "Abierto", closed: "Cerrado", hold: "En espera" })[status] || status || "—";
}

function captureDraft(form, changedName) {
  const key = form.dataset.draftKey;
  const draft = state.drafts[key];
  if (!draft || typeof changedName !== "string" || !changedName) return;
  const values = formValues(form);
  draft.values = { ...draft.values, ...values };
  if (String(values[changedName] ?? "") === String(draft.originalValues?.[changedName] ?? "")) {
    draft.touched = draft.touched.filter((name) => name !== changedName);
  } else if (!draft.touched.includes(changedName)) draft.touched.push(changedName);
  draft.dirty = draft.touched.some((name) => String(draft.values[name] ?? "") !== String(draft.originalValues?.[name] ?? ""));
  updateDraftNoticeOnly();
}

function updateDraftNoticeOnly() {
  const existing = mainView.querySelector("#draft-notice");
  const updated = renderDraftNotice();
  if (existing && updated) existing.replaceWith(updated);
  else if (existing) existing.remove();
  else if (updated) mainView.prepend(updated);
}

function formValues(form) {
  const values = {};
  for (const control of form.querySelectorAll("input[name], select[name], textarea[name]")) {
    if (control.dataset.ownerField) continue;
    if (control.dataset.dateTimePart === "date") {
      const time = form.elements.namedItem(`${control.name}.time`)?.value || "";
      const zone = form.elements.namedItem(`${control.name}.zone`)?.value || browserTimeZone();
      values[control.name] = control.value || time ? zonedControlValue(`${control.value}T${time}`, zone) : "";
    } else if (control.dataset.customValue && control.value === control.dataset.customValue) {
      values[control.name] = form.elements.namedItem(`${control.name}.custom`)?.value || "";
    } else values[control.name] = control.value;
  }
  return values;
}

function typedValue(value, descriptor, fieldName) {
  const types = Array.isArray(descriptor.type) ? descriptor.type : [descriptor.type];
  const normalized = typeof value === "string" ? value.trim() : value;
  if (normalized === "") {
    if (types.includes("null")) return null;
    if (descriptor.required === true && types.includes("string")) return value;
    return undefined;
  }
  if (descriptor.format === "date-time") {
    try { return dateTimeToIso(normalized); }
    catch (error) { throw new Error(`${labelForField(fieldName)}: ${error.message}`); }
  }
  if (types.includes("boolean")) return normalized === "true";
  if (types.includes("integer")) {
    const parsed = Number(normalized);
    if (!Number.isSafeInteger(parsed)) throw new Error(`${labelForField(fieldName)} debe ser un entero.`);
    return parsed;
  }
  if (types.includes("number")) {
    const parsed = Number(normalized);
    if (!Number.isFinite(parsed)) throw new Error(`${labelForField(fieldName)} debe ser un número finito.`);
    return parsed;
  }
  if (types.includes("object")) {
    if (!/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(normalized)) throw new Error(`${labelForField(fieldName)} debe ser un decimal, por ejemplo 1.5.`);
    return { value: normalized, unit: descriptor.properties?.unit?.const || "pomodoro" };
  }
  return value;
}

function collectGenericParameters(action, form) {
  const values = formValues(form);
  const parameters = {};
  let targetId = action.target?.id;
  for (const [name, descriptor] of Object.entries(action.inputs || {})) {
    const raw = values[name] ?? "";
    if (name === "target.id") {
      targetId = raw.trim();
      continue;
    }
    const conditionallyRequired = Array.isArray(descriptor.requiredWhen) && descriptor.requiredWhen.includes(values.action);
    const value = typedValue(raw, conditionallyRequired ? { ...descriptor, required: true } : descriptor, name);
    if (value !== undefined) parameters[name] = value;
  }
  if (action.name === "create-task" && (parameters.context !== undefined) !== (parameters.totalCost !== undefined)) {
    throw new Error("Para especificar un contexto o un coste, completa ambos campos.");
  }
  if (action.name === "edit-project-content" && parameters.line !== undefined && parameters.line < 1) {
    throw new Error("La línea debe empezar en 1.");
  }
  if (action.name === "edit-project-content" && parameters.position !== undefined && parameters.position < 1) {
    throw new Error("La posición debe empezar en 1.");
  }
  const target = { ...action.target };
  if (target.kind === "tasks") {
    delete target.id;
  } else if (typeof target.id !== "string") {
    if (typeof targetId !== "string" || !targetId.trim()) throw new Error("Indica el nombre del recurso antes de continuar.");
    target.id = targetId.trim();
  }
  return { target, parameters };
}

function collectEditChanges(action, task, form) {
  const values = formValues(form);
  const draft = state.drafts[form.dataset.draftKey];
  const touched = new Set(draft?.touched || []);
  const changes = {};
  for (const [field, descriptor] of Object.entries(action.inputs?.changes?.properties || {})) {
    const name = `changes.${field}`;
    const raw = values[name] ?? "";
    const initial = String(draft?.originalValues?.[name] ?? editFieldValue(field, task));
    if (!touched.has(name) || raw === initial) continue;
    let value;
    if (field === "raised" || field === "waited") value = raw.trim() ? raw : null;
    else if (field === "totalCost") value = typedValue(raw, descriptor, name);
    else value = typedValue(raw, descriptor, name);
    if (value !== undefined) changes[field] = value;
  }
  const effortRaw = values.effortDelta ?? "";
  let effortDelta;
  if (effortRaw.trim()) {
    const normalizedEffort = effortRaw.trim();
    if (/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(normalizedEffort)) effortDelta = { value: normalizedEffort, unit: "pomodoro" };
    else effortDelta = normalizedEffort;
  }
  if (!Object.keys(changes).length && effortDelta === undefined) throw new Error("Cambia al menos un campo o indica el esfuerzo realizado.");
  return { changes, ...(effortDelta === undefined ? {} : { effortDelta }) };
}

async function submitPublishedAction(action, resource, scope, key, form, resourceType) {
  try {
    const draft = state.drafts[key];
    if (!draft || !isDraftScopeCurrent(draft.scope)) throw new Error("Este borrador pertenece a una conexión anterior y no se enviará al servidor actual.");
    const { target, parameters } = collectGenericParameters(action, form);
    const revision = state.settingsRevision;
    const endpoint = state.endpointKey;
    await perform(actionLabel(action.name), async () => {
      if (!isDraftScopeCurrent(draft.scope)) throw new Error("La conexión cambió antes de enviar el formulario.");
      const receipt = await submitOperation(action.name, target, parameters, {
        beforeSend: () => revision === state.settingsRevision && endpoint === state.endpointKey && isReady(state.settings) && isDraftScopeCurrent(draft.scope),
      });
      delete state.drafts[key];
      if (revision !== state.settingsRevision) {
        renderMainView();
        showMessage("La acción se confirmó en la conexión anterior. No se consultaron esos identificadores en la conexión actual.");
        return;
      }
      const refreshed = await afterSuccessfulOperation(action.name, target, receipt);
      renderMainView();
      if (refreshed === true) showMessage(`${actionLabel(action.name)} completado para ${target.id || "el recurso"}.`);
      else if (refreshed === null) {
        state.confirmedOperationPendingRefresh = true;
        showMessage("La acción se confirmó. Cargando los cambios más recientes antes de volver a habilitar las acciones.");
      } else showMessage(`${actionLabel(action.name)} se confirmó, pero no se pudieron actualizar los datos visibles. Actualiza la vista antes de continuar.`, "error");
    });
  } catch (error) {
    showMessage(error instanceof Error ? error.message : "No se pudo enviar el formulario.", "error");
  }
}

async function submitEditTask(action, task, key, form) {
  try {
    const draft = state.drafts[key];
    if (!draft || !isDraftScopeCurrent(draft.scope)) throw new Error("Este borrador pertenece a una conexión anterior y no se enviará al servidor actual.");
    const parameters = collectEditChanges(action, task, form);
    const target = action.target;
    if (!target || target.kind !== "task" || target.id !== task.id) throw new Error("El formulario ya no corresponde a la tarea mostrada.");
    const revision = state.settingsRevision;
    const endpoint = state.endpointKey;
    await perform("Guardando cambios de la tarea", async () => {
      if (!isDraftScopeCurrent(draft.scope)) throw new Error("La conexión cambió antes de enviar el formulario.");
      const receipt = await submitOperation("edit-task", { kind: "task", id: task.id }, parameters, {
        beforeSend: () => revision === state.settingsRevision && endpoint === state.endpointKey && isReady(state.settings) && isDraftScopeCurrent(draft.scope),
      });
      delete state.drafts[key];
      if (revision !== state.settingsRevision) {
        renderMainView();
        showMessage("Los cambios se confirmaron en la conexión anterior. No se consultó esta tarea en la conexión actual.");
        return;
      }
      const refreshed = await afterSuccessfulOperation("edit-task", { kind: "task", id: task.id }, receipt);
      renderMainView();
      if (refreshed === true) showMessage(`Cambios guardados para «${task.description}».`);
      else if (refreshed === null) {
        state.confirmedOperationPendingRefresh = true;
        showMessage("Los cambios se confirmaron. Cargando los cambios más recientes antes de volver a habilitar las acciones.");
      } else showMessage("Los cambios se confirmaron, pero no se pudo actualizar la tarea visible. Actualiza la vista antes de continuar.", "error");
    });
  } catch (error) {
    showMessage(error instanceof Error ? error.message : "No se pudieron guardar los cambios.", "error");
  }
}

async function afterSuccessfulOperation(operationName, target, receipt) {
  const pending = takePendingChanges();
  const result = receipt?.data?.result || {};
  const affected = Array.isArray(result.affectedIds) ? result.affectedIds.filter((id) => typeof id === "string") : [];
  const collections = operationName === "raise-event" ? ["tasks", "agenda", "events", "statistics"] :
    ["create-task", "edit-task", "complete-task", "schedule-task", "record-work", "snooze-task"].includes(operationName) ? ["tasks", "agenda", "statistics", "events"] : ["projects"];
  const changes = {
    collections: [...new Set([...collections, ...pending.collections])],
    taskIds: [...new Set([...pending.taskIds, ...(target?.kind === "task" ? [target.id] : []), ...(target?.kind === "tasks" || operationName === "raise-event" ? affected : [])])],
    projectNames: [...new Set([...pending.projectNames, ...(target?.kind === "project" ? [target.id] : []), ...(target?.kind === "project" ? affected : [])])],
    eventNames: [...new Set([...pending.eventNames, ...(target?.kind === "event" ? [target.id] : [])])],
    target,
    affected,
    refreshAll: pending.refreshAll,
  };

  if (operationName === "create-task") {
    const createdId = result.value?.id || affected[0];
    if (typeof createdId === "string" && createdId) {
      state.selectedTaskId = createdId;
      state.view = "detail";
      changes.taskIds = [...new Set([...changes.taskIds, createdId])];
    }
  }
  if (operationName === "complete-task" && target?.id === state.selectedTaskId) {
    state.selectedTaskId = null;
    state.view = "tasks";
  }
  markChangesStale(changes);
  if (changes.refreshAll) markLoadedResourcesStale();
  renderMainView();
  showMessage("La acción se confirmó. Actualizando los datos que estás viendo.");
  const refreshed = changes.refreshAll
    ? await refreshLoadedData(changes)
    : await refreshVisibleResources(changes);
  renderMainView();
  return refreshed ? true : state.pendingRemoteRefresh ? null : false;
}

function renderDraftForResource(key) {
  return state.drafts[key];
}

function renderTaskDetailStatus(taskId) {
  const stale = renderDraftNoticeForTarget("task", taskId);
  return stale;
}

function actionButton(label, action, data = {}) {
  const button = node("button", label, "secondary");
  button.type = "button";
  button.dataset.action = action;
  for (const [key, value] of Object.entries(data)) button.dataset[key] = String(value);
  return button;
}

async function handleActionButton(button) {
  const action = button.dataset.action;
  if (action === "refresh" || action === "reload") {
    await perform("Actualizando datos", async () => {
      await refreshLocalNotifications();
      const complete = await refreshLoadedData();
      renderMainView();
      showMessage(complete
        ? "Vista actualizada. Las demás se cargarán al abrirlas; se conservaron los borradores."
        : "No se pudieron actualizar todos los datos visibles. Se conservaron los borradores y la vista seguirá protegida hasta cargarla.", complete ? "info" : "error");
    });
  } else if (action === "previous-page") {
    if (state.views.tasks.page <= 1) return;
    await perform("Abriendo la página anterior", async () => { state.views.tasks.page -= 1; await loadTaskList(); renderMainView(); });
  } else if (action === "next-page") {
    const totalPages = Number(state.taskList?.totalPages || 0);
    if (totalPages && state.views.tasks.page >= totalPages) return;
    await perform("Abriendo la página siguiente", async () => { state.views.tasks.page += 1; await loadTaskList(); renderMainView(); });
  } else if (action === "open-draft") {
    const draft = state.drafts[button.dataset.draftKey];
    if (!draft) return;
    if (!isDraftScopeCurrent(draft.scope)) {
      showMessage("Este borrador pertenece a otra conexión. Cámbiala desde Configuración o descártalo localmente.", "error");
      return;
    }
    if (draft.scope.kind === "task" && draft.scope.id) await selectTask(draft.scope.id);
    if (draft.scope.kind === "project" && draft.scope.id) await selectProject(draft.scope.id);
  } else if (action === "apply-fresh") {
    const kind = button.dataset.kind;
    const id = button.dataset.resourceId;
    if (kind === "task" && state.latestTaskDetails[id]) state.taskDetails[id] = state.latestTaskDetails[id];
    if (kind === "project" && state.latestProjectDetails[id]) state.projectDetails[id] = state.latestProjectDetails[id];
    delete state.pendingFresh[resourceKey(kind, id)];
    renderMainView();
    showMessage("Se cargaron los datos actuales y se conservó el borrador.");
  } else if (action === "discard-draft-reload") {
    const draft = state.drafts[button.dataset.draftKey];
    if (!draft) return;
    if (!isDraftScopeCurrent(draft.scope)) {
      showMessage("Este borrador pertenece a otra conexión; usa «Descartar borrador local» para quitarlo sin consultar el servidor actual.", "error");
      return;
    }
    const key = button.dataset.draftKey;
    const identity = draft.identity || draft.scope.id;
    const resourceScope = { ...draft.scope };
    delete state.drafts[key];
    await perform("Cargando datos actuales", async () => {
      if (resourceScope.kind === "task" && resourceScope.id) await loadTaskDetail(resourceScope.id, { applyFresh: true });
      if (resourceScope.kind === "project" && resourceScope.id) await loadProjectDetail(resourceScope.id, { applyFresh: true });
      renderMainView();
      showMessage(`Se descartó el borrador de ${identity} y se cargó la versión actual.`);
    });
  } else if (action === "discard-old-draft") {
    const draft = state.drafts[button.dataset.draftKey];
    if (!draft || isDraftScopeCurrent(draft.scope)) return;
    delete state.drafts[button.dataset.draftKey];
    renderMainView();
    showMessage("Se descartó el borrador local de la conexión anterior.");
  } else if (action === "inline-operation") {
    let target;
    try { target = JSON.parse(button.dataset.operationTarget); } catch { return; }
    const operationName = button.dataset.operationName;
    const revision = Number(button.dataset.settingsRevision);
    const endpoint = button.dataset.endpointKey;
    if (revision !== state.settingsRevision || endpoint !== state.endpointKey) {
      showMessage("La conexión cambió. Actualiza los datos antes de usar esta acción.", "error");
      return;
    }
    await perform(actionLabel(operationName), async () => {
      const receipt = await submitOperation(operationName, target, {}, {
        beforeSend: () => revision === state.settingsRevision && endpoint === state.endpointKey && isReady(state.settings),
      });
      if (revision !== state.settingsRevision) {
        showMessage("La acción se confirmó en la conexión anterior; no se actualizaron datos de la conexión actual.");
        return;
      }
      const refreshed = await afterSuccessfulOperation(operationName, target, receipt);
      renderMainView();
      if (refreshed === true) showMessage(`${actionLabel(operationName)} completado.`);
      else if (refreshed === null) {
        state.confirmedOperationPendingRefresh = true;
        showMessage(`${actionLabel(operationName)} se confirmó. Cargando los cambios más recientes antes de volver a habilitar las acciones.`);
      } else showMessage(`${actionLabel(operationName)} se confirmó, pero no se pudieron actualizar los datos visibles. Actualiza la vista antes de continuar.`, "error");
    });
  }
}

async function selectTask(taskId, { announce = true } = {}) {
  if (typeof taskId !== "string" || !taskId) {
    showMessage("Esta tarea no contiene un identificador utilizable.", "error");
    return;
  }
  const previousId = state.selectedTaskId;
  state.selectedTaskId = taskId;
  state.view = "detail";
  state.taskDetailErrors[taskId] = "";
  renderMainView();
  await perform("Abriendo tarea", async () => {
    try {
      await loadTaskDetail(taskId);
      renderMainView();
      if (announce) showMessage(`Tarea abierta: ${state.taskDetails[taskId]?.description || taskId}.`);
      if (previousId && previousId !== taskId && draftsForResource("task", previousId).length) {
        showMessage(`El borrador de «${state.taskDetails[previousId]?.description || previousId}» sigue guardado para esa tarea.`);
      }
    } catch (error) {
      if (!error?.supersededRead) {
        state.taskDetailErrors[taskId] = error instanceof Error ? error.message : "No se pudo abrir la tarea.";
        renderMainView();
      }
      throw error;
    }
  }, { silent: !announce });
}

async function selectProject(name) {
  if (typeof name !== "string" || !name) {
    showMessage("El proyecto no tiene un nombre válido.", "error");
    return;
  }
  state.selectedProjectName = name;
  state.view = "projects";
  state.projectDetailErrors[name] = "";
  renderMainView();
  await perform("Abriendo proyecto", async () => {
    try {
      if (!state.projects || state.staleCollections.has("projects")) await loadProjects();
      await loadProjectDetail(name);
      renderMainView();
      showMessage(`Proyecto abierto: ${name}.`);
    } catch (error) {
      if (!error?.supersededRead) {
        state.projectDetailErrors[name] = error instanceof Error ? error.message : "No se pudo abrir el proyecto.";
        renderMainView();
      }
      throw error;
    }
  });
}

async function refreshLoadedData(change = null) {
  if (!isReady(state.settings)) return;
  if (!change) {
    markLoadedResourcesStale();
    renderMainView();
  }
  const complete = await refreshVisibleResources(change ? { ...change, forceVisible: Boolean(change.refreshAll) } : { forceVisible: true });
  renderMainView();
  return complete;
}

function visibleRefreshError() {
  if (state.view === "detail" && state.selectedTaskId && state.taskDetailErrors[state.selectedTaskId]) return state.taskDetailErrors[state.selectedTaskId];
  if (state.view === "projects" && state.selectedProjectName && state.projectDetailErrors[state.selectedProjectName]) return state.projectDetailErrors[state.selectedProjectName];
  const collection = collectionForView(state.view);
  if (collection && state.collectionErrors[collection]) return state.collectionErrors[collection];
  return "Hay datos nuevos que no se pudieron cargar. Actualiza la vista antes de continuar.";
}

function changeTouchesCurrentResources(change) {
  if (!change) return true;
  if (change.refreshAll || change.forceVisible) return true;
  const collection = collectionForView(state.view);
  if (collection && changeAffectsCollection(change, collection)) return true;
  if ((state.view === "detail" || state.view === "agenda") && state.selectedTaskId &&
    (change.collections?.includes("tasks") || (change.taskIds || []).includes(state.selectedTaskId) || change.target?.kind === "task" && change.target.id === state.selectedTaskId)) return true;
  if (state.view === "projects" && state.selectedProjectName &&
    ((change.projectNames || []).includes(state.selectedProjectName) || change.target?.kind === "project" && change.target.id === state.selectedProjectName)) return true;
  return false;
}

function changeAffectsCollection(change, collection) {
  if ((change.collections || []).includes(collection)) return true;
  if (collection === "events") return Boolean((change.eventNames || []).length || change.target?.kind === "event");
  if (collection === "tasks") return Boolean((change.taskIds || []).length || change.target?.kind === "task");
  if (collection === "projects") return Boolean((change.projectNames || []).length || change.target?.kind === "project");
  return false;
}

function markTaskDetailStale(id) {
  if (!id || state.staleTaskDetails.has(id)) return;
  state.staleTaskDetails.add(id);
  bumpInvalidationVersion(`task:${id}`);
}

function markProjectDetailStale(name) {
  if (!name || state.staleProjectDetails.has(name)) return;
  state.staleProjectDetails.add(name);
  bumpInvalidationVersion(`project:${name}`);
}

async function refreshVisibleResources(change = {}) {
  if (!isReady(state.settings)) return false;
  const collections = new Set(change.collections || []);
  const taskIds = new Set(change.taskIds || []);
  const projectNames = new Set(change.projectNames || []);
  const target = change.target;
  const visibleTaskDetail = state.view === "detail" || state.view === "agenda";
  const visibleProjectDetail = state.view === "projects";
  if (state.selectedTaskId && visibleTaskDetail && (collections.has("tasks") || taskIds.has(state.selectedTaskId) || (target?.kind === "task" && target.id === state.selectedTaskId))) {
    markTaskDetailStale(state.selectedTaskId);
  }
  if (state.selectedProjectName && visibleProjectDetail && (collections.has("projects") || projectNames.has(state.selectedProjectName) || (target?.kind === "project" && target.id === state.selectedProjectName))) {
    markProjectDetailStale(state.selectedProjectName);
  }

  const jobs = [];
  const currentViewCollection = collectionForView(state.view);
  const shouldReadCollection = (collection) => currentViewCollection === collection &&
    (change.forceVisible || changeAffectsCollection(change, collection));
  const addCollection = (collection, read) => {
    jobs.push(read().catch((error) => {
      if (!error?.supersededRead) state.collectionErrors[collection] = error instanceof Error ? error.message : "No se pudo actualizar esta vista.";
      throw error;
    }));
  };
  if (shouldReadCollection("tasks")) addCollection("tasks", loadTaskList);
  if (shouldReadCollection("agenda")) addCollection("agenda", loadAgenda);
  if (shouldReadCollection("statistics")) addCollection("statistics", loadStats);
  if (shouldReadCollection("events")) addCollection("events", loadEvents);
  if (shouldReadCollection("projects")) addCollection("projects", loadProjects);

  const selectedTaskVisible = state.selectedTaskId && visibleTaskDetail;
  const selectedTaskChanged = collections.has("tasks") || taskIds.has(state.selectedTaskId) || (target?.kind === "task" && target.id === state.selectedTaskId) ||
    (change.affected || []).includes(state.selectedTaskId);
  if (selectedTaskVisible && (selectedTaskChanged || (state.staleTaskDetails.has(state.selectedTaskId) && (change.forceVisible || change.refreshAll)))) {
    const id = state.selectedTaskId;
    jobs.push(loadTaskDetail(id).catch((error) => {
      if (!error?.supersededRead) state.taskDetailErrors[id] = error instanceof Error ? error.message : "No se pudo actualizar el detalle.";
      throw error;
    }));
  }

  const selectedProjectVisible = state.selectedProjectName && visibleProjectDetail;
  const selectedProjectChanged = collections.has("projects") || projectNames.has(state.selectedProjectName) || (target?.kind === "project" && target.id === state.selectedProjectName) ||
    (change.affected || []).includes(state.selectedProjectName);
  if (selectedProjectVisible && (selectedProjectChanged || (state.staleProjectDetails.has(state.selectedProjectName) && (change.forceVisible || change.refreshAll)))) {
    const name = state.selectedProjectName;
    jobs.push(loadProjectDetail(name).catch((error) => {
      if (!error?.supersededRead) state.projectDetailErrors[name] = error instanceof Error ? error.message : "No se pudo actualizar el proyecto.";
      throw error;
    }));
  }

  const results = await Promise.allSettled(jobs);
  const failures = results.filter((result) => result.status === "rejected" && !result.reason?.supersededRead);
  renderMainView();
  const collectionPending = currentViewCollection && state.staleCollections.has(currentViewCollection);
  const taskPending = selectedTaskVisible && state.staleTaskDetails.has(state.selectedTaskId);
  const projectPending = selectedProjectVisible && state.staleProjectDetails.has(state.selectedProjectName);
  return failures.length === 0 && !collectionPending && !taskPending && !projectPending;
}

function loadCurrentView() {
  if (state.view === "tasks") return loadTaskList();
  if (state.view === "agenda") return loadAgenda();
  if (state.view === "stats") return loadStats();
  if (state.view === "events") return loadEvents();
  if (state.view === "projects") return loadProjects();
  if (state.view === "detail" && state.selectedTaskId) return loadTaskDetail(state.selectedTaskId);
  return Promise.resolve(null);
}

function actionLabel(name) {
  return ACTION_LABELS[name] || name;
}

function connectionLabel(scope) {
  try {
    return new URL(scope?.endpointKey).host || "la configuración anterior";
  } catch {
    return "la configuración anterior";
  }
}

function appendCatalogOptions(select, entries, selected) {
  const placeholder = node("option", "Selecciona una heurística");
  placeholder.value = "";
  select.append(placeholder);
  for (const entry of entries || []) {
    const option = node("option", entry.name);
    option.value = entry.name;
    option.selected = entry.name === selected;
    select.append(option);
  }
}

function takePendingChanges() {
  const pending = {
    taskIds: [...state.pendingChanges.taskIds],
    projectNames: [...state.pendingChanges.projectNames],
    eventNames: [...state.pendingChanges.eventNames],
    collections: [...state.pendingChanges.collections],
    refreshAll: state.pendingRefreshAll,
  };
  state.pendingRemoteRefresh = false;
  state.pendingRefreshAll = false;
  state.pendingChanges = { taskIds: [], projectNames: [], eventNames: [], collections: [] };
  return pending;
}

function queuePendingChanges(change) {
  state.pendingRemoteRefresh = true;
  if (!change || Object.keys(change).length === 0) {
    state.pendingRefreshAll = true;
    markLoadedResourcesStale();
    return;
  }
  markChangesStale(change);
  for (const key of ["taskIds", "projectNames", "eventNames", "collections"]) {
    const values = new Set([...(state.pendingChanges[key] || []), ...(Array.isArray(change[key]) ? change[key] : [])]);
    state.pendingChanges[key] = [...values];
  }
}

function finite(value, digits = 2) {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : value ?? "—";
}

function renderHistory() {
  const list = document.querySelector("#notification-list");
  if (!list) return;
  renderNotificationHistory({
    list,
    status: document.querySelector("#notification-monitor-status"),
    continuity: document.querySelector("#notification-continuity"),
    reception: state.notificationReception,
    legacyHistory: state.legacyHistory,
    settings: state.settings,
    gatewayError: state.gatewayError,
    notificationError: state.notificationError,
    monitorStatus: state.monitorStatus,
  });
}

function bindStaticControls() {
  document.querySelectorAll("[data-view]").forEach((button) => {
    button.addEventListener("click", () => {
      const view = button.dataset.view;
      state.view = view;
      renderMainView();
      void perform("Cargando vista", async () => {
        if (view === "tasks" && (!state.taskList || state.staleCollections.has("tasks"))) await loadTaskList();
        else if (view === "agenda" && (!state.agenda || state.staleCollections.has("agenda"))) await loadAgenda();
        else if (view === "stats" && (!state.stats || state.staleCollections.has("statistics"))) await loadStats();
        else if (view === "events" && (!state.events || state.staleCollections.has("events"))) await loadEvents();
        else if (view === "projects" && (!state.projects || state.staleCollections.has("projects"))) await loadProjects();
        if (view === "projects" && state.selectedProjectName && state.staleProjectDetails.has(state.selectedProjectName)) {
          await loadProjectDetail(state.selectedProjectName);
        } else if (view === "detail" && state.selectedTaskId && (!state.taskDetails[state.selectedTaskId] || state.staleTaskDetails.has(state.selectedTaskId))) {
          await loadTaskDetail(state.selectedTaskId);
        }
        renderMainView();
      }, { silent: true });
    });
  });
  document.querySelector("#open-options").addEventListener("click", () => void browserApi.runtime.openOptionsPage());
  document.querySelector("[data-action='refresh']").addEventListener("click", (event) => void handleActionButton(event.currentTarget));
  document.querySelector("#clear-history").addEventListener("click", () => void clearLocalNotifications());
}

mainView.addEventListener("input", (event) => {
  const form = event.target.closest("form[data-draft-key]");
  if (form) captureDraft(form, event.target.dataset.ownerField || event.target.name);
});
mainView.addEventListener("change", (event) => {
  const form = event.target.closest("form[data-draft-key]");
  if (form) captureDraft(form, event.target.dataset.ownerField || event.target.name);
});
mainView.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-action]");
  if (button) void handleActionButton(button);
});

subscribeStorageChanges((changes) => {
  if (changes["settings.v1"]) {
    state.settingsUpdateRevision += 1;
    const previous = state.settings;
    const next = changes["settings.v1"].newValue;
    const connectionChanged = configuredIdentityChanged(previous, next);
    state.settings = next;
    if (connectionChanged) {
      state.settingsRevision += 1;
      state.endpointKey = endpointKey(next);
      state.readSequences = Object.create(null);
      state.invalidationVersions = Object.create(null);
      state.staleCollections.clear();
      state.collectionErrors = Object.create(null);
      state.staleTaskDetails.clear();
      state.staleProjectDetails.clear();
      state.timeZone = null;
      state.agendaDayInitialized = false;
      state.taskList = null;
      state.taskDetails = Object.create(null);
      state.latestTaskDetails = Object.create(null);
      state.taskDetailErrors = Object.create(null);
      state.selectedTaskId = null;
      state.agenda = null;
      state.stats = null;
      state.events = null;
      state.strategies = { filters: [], algorithms: [], heuristics: [] };
      state.projects = null;
      state.projectDetails = Object.create(null);
      state.latestProjectDetails = Object.create(null);
      state.projectDetailErrors = Object.create(null);
      state.selectedProjectName = null;
      state.pendingFresh = Object.create(null);
      state.pendingRemoteRefresh = false;
      state.pendingChanges = { taskIds: [], projectNames: [], eventNames: [], collections: [] };
      state.pendingRefreshAll = false;
      state.confirmedOperationPendingRefresh = false;
    }
    updateConnection();
    renderHistory();
    if (connectionChanged && isReady(state.settings)) {
      renderMainView();
      if (state.busy) state.pendingConnectionReload = true;
      else void reloadConnectedResources();
    } else if (connectionChanged) {
      state.pendingConnectionReload = false;
      renderMainView();
    }
  }
  if (changes["notificationReception.v1"] || changes["notificationHistory.v1"] || changes["monitorStatus.v1"] || changes["gatewayError.v1"]) {
    state.notificationUpdateRevision += 1;
    if (changes["monitorStatus.v1"]) state.monitorUpdateRevision += 1;
    if (changes["notificationReception.v1"]) {
      void refreshLocalNotifications();
    } else {
      if (changes["notificationHistory.v1"]) state.legacyHistory = Array.isArray(changes["notificationHistory.v1"].newValue) ? changes["notificationHistory.v1"].newValue.filter(entry => entry && typeof entry === "object" && typeof entry.message === "string") : [];
      if (changes["gatewayError.v1"]) state.gatewayError = changes["gatewayError.v1"].newValue;
      if (changes["monitorStatus.v1"]) state.monitorStatus = changes["monitorStatus.v1"].newValue;
      renderHistory();
      updateHistoryControls();
    }
  }
});

subscribeChanges((change) => {
  if (!change || !isReady(state.settings)) return;
  if (state.busy) {
    queuePendingChanges(change);
    return;
  }
  markChangesStale(change);
  renderMainView();
  void refreshVisibleResources(change).then((complete) => {
    renderMainView();
    if (!complete) showMessage(visibleRefreshError(), "error");
  }).catch(() => {});
});

window.addEventListener("focus", () => void refreshLocalNotifications());
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") void refreshLocalNotifications();
});

async function initialize() {
  bindStaticControls();
  const hydrationVersions = {
    settings: state.settingsUpdateRevision,
    notifications: state.notificationUpdateRevision,
    localRead: state.localReadSequence,
    monitor: state.monitorUpdateRevision,
  };
  try {
    const saved = await readExtensionState();
    const settingsChangedDuringHydration = state.settingsUpdateRevision !== hydrationVersions.settings;
    if (!settingsChangedDuringHydration) {
      state.settings = saved.settings;
      state.endpointKey = endpointKey(saved.settings);
      if (state.settingsRevision === 0) state.settingsRevision = 1;
    }
    if (state.notificationUpdateRevision === hydrationVersions.notifications && state.localReadSequence === hydrationVersions.localRead) applyLocalNotificationState(saved);
    if (state.monitorUpdateRevision === hydrationVersions.monitor) state.monitorStatus = saved.monitorStatus;
    renderHistory();
    updateHistoryControls();
    renderMainView();
    if (settingsChangedDuringHydration) return;
    if (isReady(state.settings)) {
      await perform("Cargando gestor", async () => {
        const results = await Promise.allSettled([loadRoot(), loadStrategies(), loadTaskList()]);
        if (results[0].status === "rejected" && !results[0].reason?.supersededRead) {
          renderMainView();
          throw results[0].reason;
        }
        const catalogFailure = results[1];
        if (catalogFailure.status === "rejected") state.strategyError = catalogFailure.reason instanceof Error ? catalogFailure.reason.message : "No se pudo cargar el catálogo.";
        const listFailure = results[2];
        if (listFailure.status === "rejected") throw listFailure.reason;
        renderMainView();
        showMessage("Gestor conectado.");
      });
    } else {
      showMessage("Configura el servidor y conecta desde la página de opciones.");
    }
  } catch (error) {
    if (state.settingsUpdateRevision === hydrationVersions.settings) {
      showMessage(error instanceof Error ? error.message : "No se pudo leer el estado de la extensión.", "error");
    }
  }
}

void initialize();
