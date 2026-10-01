import { browserApi } from "./browser-api.js";

function createRequestId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export async function sendRequest(type, payload = {}) {
  const requestId = createRequestId();
  const reply = await browserApi.runtime.sendMessage({ type, requestId, ...payload });
  if (!reply || typeof reply !== "object") {
    throw new Error("El background no devolvió una respuesta válida.");
  }
  if (reply.requestId && reply.requestId !== requestId) {
    throw new Error("La respuesta recibida no corresponde a esta solicitud.");
  }
  return reply;
}

export function gatewayCall(operation, args = {}) {
  return sendRequest("gateway.call", { operation, args });
}

export const settingsMessages = Object.freeze({
  save: (settings) => sendRequest("settings.save", { settings }),
  connect: (settings) => sendRequest("settings.connect", { settings }),
  disconnect: () => sendRequest("settings.disconnect"),
  clear: () => sendRequest("settings.clear"),
});

export const clearHistory = () => sendRequest("history.clear");

export function assertSuccessfulReply(reply) {
  if (reply?.ok === true) return reply;
  const detail = reply?.error?.message || "La operación no se pudo completar.";
  const status = Number.isFinite(reply?.status) ? ` (HTTP ${reply.status})` : "";
  throw new Error(`${detail}${status}`);
}
