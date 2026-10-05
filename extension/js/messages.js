import { browserApi } from "./browser-api.js";

const PROTOCOL_VERSION = 1;
const EMPTY = Object.freeze({});
const CHANGE_EVENT = "changes.invalidated";
const CHANGE_COLLECTIONS = new Set(["tasks", "projects", "events", "statistics", "agenda"]);
const ERROR_TEXT = Object.freeze({
  "invalid-request": "La solicitud no es válida.",
  "unauthorized-sender": "La extensión rechazó este remitente.",
  "endpoint-invalid": "La dirección HTTPS configurada no es válida.",
  "permission-denied": "No se concedió permiso para acceder al servidor.",
  "permission-required": "Se necesita permiso para acceder al servidor. Vuelve a conectar.",
  tls: "No se pudo establecer una conexión TLS segura.",
  network: "No se pudo conectar con el servidor.",
  timeout: "El servidor tardó demasiado en responder.",
  parse: "El servidor devolvió una respuesta que no se pudo leer.",
  "invalid-response": "El servidor devolvió una respuesta no válida.",
  http: "El servidor respondió con un error.",
  uncertain: "No se pudo confirmar el resultado. Comprueba el estado antes de repetir la acción.",
  "unsupported-resource-id": "Este identificador no se puede transportar de forma segura.",
  "unsupported-operation": "Esta operación requiere una versión actualizada del gestor.",
  "gateway-unavailable": "No se pudo contactar con el gateway de la extensión.",
  "request-mismatch": "La respuesta no corresponde a esta solicitud.",
  "task-changed": "La tarea urgente ha cambiado; actualiza la agenda antes de actuar.",
});

export class GatewayRequestError extends Error {
  constructor({ kind = "gateway-unavailable", message, title, status = null, requestId = null, operationId = null, effectsState = null } = {}) {
    super(typeof message === "string" && message ? message : (ERROR_TEXT[kind] || ERROR_TEXT["gateway-unavailable"]));
    this.name = "GatewayRequestError";
    this.kind = kind;
    this.title = typeof title === "string" && title ? title : (ERROR_TEXT[kind] || "Error de conexión");
    this.status = Number.isInteger(status) && status >= 100 && status <= 599 ? status : null;
    this.requestId = isUuid(requestId) ? requestId : null;
    this.operationId = isUuid(operationId) ? operationId : null;
    this.effectsState = ["none", "partial", "unknown"].includes(effectsState) ? effectsState : null;
  }
}

function isUuid(value) {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function createUuid() {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.randomUUID === "function") return cryptoApi.randomUUID();
  if (typeof cryptoApi?.getRandomValues !== "function") {
    throw new GatewayRequestError({kind: "gateway-unavailable"});
  }
  const bytes = new Uint8Array(16);
  cryptoApi.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
  return hex.slice(0, 8) + "-" + hex.slice(8, 12) + "-4" + hex.slice(13, 16) + "-" + ((parseInt(hex[16], 16) & 3 | 8).toString(16)) + hex.slice(17, 20) + "-" + hex.slice(20);
}

function validateReply(reply, requestId, operationId = null) {
  const expectedKeys = ["requestId", "ok", "status", "data", "error"];
  if (!reply || typeof reply !== "object" || Array.isArray(reply) || Object.keys(reply).some(key => !expectedKeys.includes(key)) || expectedKeys.some(key => !Object.hasOwn(reply, key)) || reply.requestId !== requestId || typeof reply.ok !== "boolean" || !(reply.status === null || (Number.isInteger(reply.status) && reply.status >= 100 && reply.status <= 599))) {
    throw new GatewayRequestError({kind: "request-mismatch", requestId, operationId});
  }
  try {
    const serialized = JSON.stringify(reply.data);
    if (serialized === undefined) throw new Error("unserializable");
  } catch {
    throw new GatewayRequestError({kind: "request-mismatch", requestId, operationId});
  }
  if (reply.ok && reply.error !== null) throw new GatewayRequestError({kind: "request-mismatch", requestId, operationId});
  if (!reply.ok) {
    if (!reply.error || typeof reply.error !== "object" || Array.isArray(reply.error)) throw new GatewayRequestError({kind: "request-mismatch", requestId, operationId});
    const error = reply.error;
    const errorKeys = ["kind", "title", "message", "operationId", "effectsState"];
    if (Object.keys(reply.error).some(key => !errorKeys.includes(key)) || typeof reply.error.kind !== "string" || !/^[a-z0-9-]{1,80}$/.test(reply.error.kind) || typeof reply.error.title !== "string" || reply.error.title.length > 200 || typeof reply.error.message !== "string" || reply.error.message.length > 1000 || (reply.error.operationId !== undefined && !isUuid(reply.error.operationId)) || (reply.error.effectsState !== undefined && !["none", "partial", "unknown"].includes(reply.error.effectsState))) {
      throw new GatewayRequestError({kind: "request-mismatch", requestId, operationId});
    }
    throw new GatewayRequestError({
      kind: typeof error.kind === "string" ? error.kind : "gateway-unavailable",
      title: error.title,
      message: error.message,
      status: reply.status,
      requestId,
      operationId: error.operationId || operationId,
      effectsState: error.effectsState,
    });
  }
  return reply;
}

function assertCurrentBeforeSend(beforeSend, operationId = null) {
  if (typeof beforeSend !== "function") return;
  let current = false;
  try { current = beforeSend() === true; } catch { /* A stale local view must not dispatch a write. */ }
  if (!current) {
    throw new GatewayRequestError({
      kind: "invalid-request",
      message: "La configuración cambió antes de enviar la acción.",
      operationId,
      effectsState: "none",
    });
  }
}

export function sendRequest(operation, target = null, parameters = EMPTY, {operationId = null, modifying = false, beforeSend = null} = {}) {
  if (typeof operation !== "string" || !operation) {
    return Promise.reject(new GatewayRequestError({kind: "invalid-request"}));
  }
  let requestId = createUuid();
  if (operationId && requestId === operationId) requestId = createUuid();
  const envelope = {protocolVersion: PROTOCOL_VERSION, requestId, operation, target, parameters};
  return Promise.resolve().then(() => {
    assertCurrentBeforeSend(beforeSend, operationId);
    return browserApi.runtime.sendMessage(envelope);
  }).then(
    reply => {
      try {
        return validateReply(reply, requestId, operationId);
      } catch (error) {
        if (modifying && error instanceof GatewayRequestError && error.kind === "request-mismatch") {
          throw new GatewayRequestError({kind: "uncertain", requestId, operationId, effectsState: "unknown"});
        }
        throw error;
      }
    },
    error => {
      if (error instanceof GatewayRequestError) throw error;
      const kind = modifying ? "uncertain" : "gateway-unavailable";
      throw new GatewayRequestError({kind, requestId, operationId, effectsState: modifying ? "unknown" : null});
    },
  );
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, allowed, required = allowed) {
  return isPlainObject(value) &&
    Object.keys(value).every(key => allowed.includes(key)) &&
    required.every(key => Object.hasOwn(value, key));
}

function validChangeIds(values) {
  return Array.isArray(values) && values.length <= 10000 && values.every(value =>
    typeof value === "string" && value.length > 0 && value.length <= 4096 && !/[\u0000-\u001f\u007f]/.test(value),
  );
}

function readInvalidation(message, sender) {
  const backgroundUrls = [
    browserApi.runtime.getURL("background.js"),
    browserApi.runtime.getURL("_generated_background_page.html"),
  ];
  if (!sender || typeof browserApi.runtime.id !== "string" || sender.id !== browserApi.runtime.id ||
      !backgroundUrls.includes(sender.url)) return null;
  if (!exactKeys(message, ["protocolVersion", "event", "changes"]) ||
      message.protocolVersion !== PROTOCOL_VERSION || message.event !== CHANGE_EVENT ||
      !exactKeys(message.changes, ["taskIds", "projectNames", "eventNames", "collections"])) return null;
  const changes = message.changes;
  if (!validChangeIds(changes.taskIds) || !validChangeIds(changes.projectNames) ||
      !validChangeIds(changes.eventNames) || !Array.isArray(changes.collections) ||
      changes.collections.length > CHANGE_COLLECTIONS.size ||
      !changes.collections.every(value => CHANGE_COLLECTIONS.has(value)) ||
      new Set(changes.collections).size !== changes.collections.length) return null;
  return Object.freeze({
    taskIds: Object.freeze([...changes.taskIds]),
    projectNames: Object.freeze([...changes.projectNames]),
    eventNames: Object.freeze([...changes.eventNames]),
    collections: Object.freeze([...changes.collections]),
  });
}

export function subscribeChanges(listener) {
  const event = browserApi.runtime.onMessage;
  if (typeof listener !== "function" || !event?.addListener) return () => {};
  const handler = (message, sender) => {
    const changes = readInvalidation(message, sender);
    if (!changes) return;
    try { listener(changes); } catch { /* UI listeners cannot affect the gateway response. */ }
  };
  event.addListener(handler);
  return () => event.removeListener?.(handler);
}

function canonicalizeServerUrl(candidate) {
  if (!candidate || typeof candidate.serverUrl !== "string") throw new GatewayRequestError({kind: "endpoint-invalid"});
  const raw = candidate.serverUrl.trim();
  if (!raw || !/^https:\/\//i.test(raw) || /[\s\\\u0000-\u001f\u007f?#]/.test(raw)) throw new GatewayRequestError({kind: "endpoint-invalid"});
  const authorityAndPath = raw.slice(raw.indexOf("://") + 3);
  const rawPathStart = authorityAndPath.indexOf("/");
  const rawAuthority = rawPathStart < 0 ? authorityAndPath : authorityAndPath.slice(0, rawPathStart);
  if (rawAuthority.includes("@")) throw new GatewayRequestError({kind: "endpoint-invalid"});
  const rawPath = rawPathStart < 0 ? "/" : authorityAndPath.slice(rawPathStart);
  try {
    for (const segment of rawPath.split("/").filter(Boolean)) {
      const decoded = decodeURIComponent(segment);
      if (!decoded || decoded === "." || decoded === ".." || /[\\/\u0000-\u001f\u007f]/.test(decoded)) {
        throw new GatewayRequestError({kind: "endpoint-invalid"});
      }
    }
  } catch (error) {
    if (error instanceof GatewayRequestError) throw error;
    throw new GatewayRequestError({kind: "endpoint-invalid"});
  }
  let url;
  try { url = new URL(raw); } catch { throw new GatewayRequestError({kind: "endpoint-invalid"}); }
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password || url.search || url.hash) throw new GatewayRequestError({kind: "endpoint-invalid"});
  const suffix = "/api/v1";
  let path = url.pathname.replace(/\/+$/, "");
  if (/\/api\/v1(?:\/api\/v1)+$/i.test(path)) throw new GatewayRequestError({kind: "endpoint-invalid"});
  if (path.toLowerCase().endsWith(suffix)) path = path.slice(0, -suffix.length) + suffix;
  else path += suffix;
  const timeoutMs = candidate.timeoutMs === undefined ? 30000 : candidate.timeoutMs;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000) throw new GatewayRequestError({kind: "invalid-request"});
  if (typeof candidate.token !== "string" || !candidate.token.trim() || candidate.token.length > 8192 || /[\r\n\u0000-\u001f\u007f]/.test(candidate.token)) throw new GatewayRequestError({kind: "invalid-request"});
  return {
    serverUrl: url.origin + path,
    token: candidate.token,
    monitorEnabled: candidate.monitorEnabled === true,
    timeoutMs,
  };
}

function requestHostPermission(serverUrl) {
  let url;
  try { url = new URL(serverUrl); } catch { return Promise.reject(new GatewayRequestError({kind: "endpoint-invalid"})); }
  if (url.protocol !== "https:") return Promise.reject(new GatewayRequestError({kind: "endpoint-invalid"}));
  const origins = ["https://" + url.hostname + "/*"];
  if (!browserApi.permissions || typeof browserApi.permissions.request !== "function") return Promise.reject(new GatewayRequestError({kind: "permission-required"}));
  let permission;
  try {
    // Call the browser API in the click stack before yielding, preserving user activation.
    permission = browserApi.permissions.request({origins});
  } catch {
    return Promise.reject(new GatewayRequestError({kind: "permission-denied"}));
  }
  return Promise.resolve(permission).then(granted => {
    if (granted !== true) throw new GatewayRequestError({kind: "permission-denied"});
  }, () => { throw new GatewayRequestError({kind: "permission-denied"}); });
}

export function gatewayCall(operation, args = {}, {isCurrent = null} = {}) {
  if (operation === "GET_AGENDA") {
    if (!exactKeys(args, ["day", "heuristic"], ["day", "heuristic"]) ||
        typeof args.day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(args.day) ||
        typeof args.heuristic !== "string" || !args.heuristic.trim()) {
      return Promise.reject(new GatewayRequestError({kind: "invalid-request"}));
    }
    return sendRequest("agenda.read", null, {day: args.day, heuristic: args.heuristic}).then(reply => {
      const embedded = reply.data?._embedded;
      if (!embedded || !Array.isArray(embedded.activeUrgentTasks)) {
        throw new GatewayRequestError({kind: "invalid-response", requestId: reply.requestId});
      }
      return {
        ...reply,
        data: {
          active_urgent_tasks: embedded.activeUrgentTasks,
          planned_urgent_tasks: embedded.plannedUrgentTasks || [],
          planned_tasks_by_date: embedded.plannedTasksByDate || {},
          other_tasks: embedded.otherTasks || [],
        },
      };
    });
  }
  if (operation === "POPUP_DONE" || operation === "POPUP_SNOOZE") {
    const shown = args?.expectedTask;
    if (!isPlainObject(shown) || !exactKeys(shown, ["id"], ["id"]) ||
        typeof shown.id !== "string" || !shown.id ||
        !exactKeys(args, ["expectedTask", "day", "heuristic"], ["expectedTask", "day", "heuristic"]) ||
        typeof args.day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(args.day) ||
        typeof args.heuristic !== "string" || !args.heuristic.trim() || typeof isCurrent !== "function") {
      return Promise.reject(new GatewayRequestError({kind: "invalid-request"}));
    }
    return sendRequest("agenda.read", null, {day: args.day, heuristic: args.heuristic}).then(reply => {
      assertCurrentBeforeSend(isCurrent);
      const agenda = reply.data?._embedded?.activeUrgentTasks;
      const current = Array.isArray(agenda) ? agenda[0] : null;
      if (!current || current.id !== shown.id) {
        throw new GatewayRequestError({kind: "task-changed", requestId: reply.requestId});
      }
      const type = operation === "POPUP_DONE" ? "complete-task" : "snooze-task";
      const parameters = operation === "POPUP_DONE" ? {} : {duration: "5m"};
      return submitOperation(type, {kind: "task", id: shown.id}, parameters, {beforeSend: isCurrent});
    });
  }
  return Promise.reject(new GatewayRequestError({kind: "unsupported-operation"}));
}

export function readGateway(operation, target = null, parameters = EMPTY) {
  return sendRequest(operation, target, parameters);
}

export function submitOperation(type, target, parameters = EMPTY, {beforeSend = null} = {}) {
  const operationId = createUuid();
  const operationParameters = {id: operationId, type, parameters};
  return sendRequest("operations.submit", target, operationParameters, {operationId, modifying: true, beforeSend});
}

export const settingsMessages = Object.freeze({
  save: (settings) => {
    let normalized;
    try { normalized = canonicalizeServerUrl(settings); } catch (error) { return Promise.reject(error); }
    return sendRequest("settings.save", null, normalized);
  },
  connect: (settings) => {
    let normalized;
    try { normalized = canonicalizeServerUrl(settings); } catch (error) { return Promise.reject(error); }
    // The permission prompt must begin before the click's user activation expires.
    return requestHostPermission(normalized.serverUrl).then(
      () => sendRequest("settings.connect", null, normalized),
      async error => {
        if (error instanceof GatewayRequestError && ["permission-denied", "permission-required"].includes(error.kind)) {
          await sendRequest("settings.disconnect", null, {}).catch(() => {});
        }
        throw error;
      },
    );
  },
  disconnect: () => sendRequest("settings.disconnect", null, {}),
  clear: () => sendRequest("settings.clear", null, {}),
});

export const clearHistory = () => sendRequest("history.clear", null, {});

export function assertSuccessfulReply(reply) {
  if (reply?.ok === true) return reply;
  const error = reply?.error && typeof reply.error === "object" ? reply.error : {};
  throw new GatewayRequestError({
    kind: typeof error.kind === "string" ? error.kind : "gateway-unavailable",
    title: error.title,
    message: error.message,
    status: reply?.status,
    requestId: reply?.requestId,
    operationId: error.operationId,
    effectsState: error.effectsState,
  });
}
