import { browserApi } from "./browser-api.js";

export const SETTINGS_KEY = "settings.v1";
export const HISTORY_KEY = "notificationHistory.v1";
export const NOTIFICATION_RECEPTION_KEY = "notificationReception.v1";
export const MONITOR_STATUS_KEY = "monitorStatus.v1";
export const GATEWAY_ERROR_KEY = "gatewayError.v1";

export const DEFAULT_SETTINGS = Object.freeze({
  schemaVersion: 1,
  serverUrl: "",
  token: "",
  monitorEnabled: false,
  timeoutMs: 30000,
});

function nonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function validEndpointKey(value) {
  if (value === "") return true;
  if (typeof value !== "string" || value.length > 4096) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && Boolean(url.hostname) && !url.username && !url.password && !url.search && !url.hash && `${url.origin}${url.pathname.replace(/\/+$/, "")}` === value;
  } catch {
    return false;
  }
}

function validContinuity(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = ["discardedThrough", "missedRanges", "gapsTruncated", "localTruncated"];
  if (Object.keys(value).some(key => !keys.includes(key)) || keys.some(key => !Object.hasOwn(value, key))) return false;
  return nonNegativeInteger(value.discardedThrough) &&
    Array.isArray(value.missedRanges) && value.missedRanges.length <= 16 &&
    value.missedRanges.every(range => range && typeof range === "object" && !Array.isArray(range) &&
      Object.keys(range).every(key => key === "fromSequence" || key === "throughSequence") &&
      nonNegativeInteger(range.fromSequence) && nonNegativeInteger(range.throughSequence) &&
      range.fromSequence > 0 && range.throughSequence >= range.fromSequence) &&
    typeof value.gapsTruncated === "boolean" && typeof value.localTruncated === "boolean";
}

function validNotificationEntry(entry) {
  return Boolean(entry && typeof entry === "object" && !Array.isArray(entry) &&
    Object.keys(entry).every(key => ["endpointKey", "id", "historyId", "sequence", "timestamp", "text"].includes(key)) &&
    validEndpointKey(entry.endpointKey) && entry.endpointKey !== "" &&
    typeof entry.id === "string" && entry.id.length > 0 && entry.id.length <= 8192 &&
    typeof entry.historyId === "string" && entry.historyId.length > 0 && entry.historyId.length <= 4096 &&
    nonNegativeInteger(entry.sequence) && entry.sequence > 0 && entry.id === `${entry.historyId}:${entry.sequence}` &&
    typeof entry.timestamp === "string" && entry.timestamp.length <= 100 &&
    typeof entry.text === "string" && entry.text.length <= 20000);
}

export function validateNotificationReception(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some(key => !["schemaVersion", "endpointKey", "historyId", "lastReceivedSequence", "buffer", "bufferGeneration", "continuity"].includes(key)) ||
      value.schemaVersion !== 1 || !validEndpointKey(value.endpointKey) ||
      !(value.historyId === null || (typeof value.historyId === "string" && value.historyId.length > 0 && value.historyId.length <= 4096)) ||
      !nonNegativeInteger(value.lastReceivedSequence) || !Array.isArray(value.buffer) || value.buffer.length > 1024 ||
      !value.buffer.every(validNotificationEntry) || !nonNegativeInteger(value.bufferGeneration)) {
    return { value: null, error: "La copia local de notificaciones tiene un formato no válido." };
  }
  const identities = new Set();
  for (const entry of value.buffer) {
    const identity = `${entry.endpointKey}\u0000${entry.historyId}\u0000${entry.sequence}`;
    if (identities.has(identity)) return { value: null, error: "La copia local contiene identidades repetidas y no se ha mostrado." };
    identities.add(identity);
  }
  const copy = {
    schemaVersion: 1,
    endpointKey: value.endpointKey,
    historyId: value.historyId,
    lastReceivedSequence: value.lastReceivedSequence,
    buffer: value.buffer.map(entry => ({...entry})),
    bufferGeneration: value.bufferGeneration,
  };
  if (value.continuity !== undefined) {
    if (validContinuity(value.continuity)) {
      copy.continuity = {
        discardedThrough: value.continuity.discardedThrough,
        missedRanges: value.continuity.missedRanges.map(range => ({...range})),
        gapsTruncated: value.continuity.gapsTruncated,
        localTruncated: value.continuity.localTruncated,
      };
    } else {
      return { value: copy, error: "Algunos datos sobre la continuidad de las notificaciones no se pudieron leer." };
    }
  }
  return { value: copy, error: "" };
}

export async function readExtensionState() {
  const values = await browserApi.storage.local.get([
    SETTINGS_KEY,
    HISTORY_KEY,
    NOTIFICATION_RECEPTION_KEY,
    MONITOR_STATUS_KEY,
    GATEWAY_ERROR_KEY,
  ]);
  const hasReception = Object.hasOwn(values || {}, NOTIFICATION_RECEPTION_KEY) && values[NOTIFICATION_RECEPTION_KEY] !== undefined;
  const reception = hasReception ? validateNotificationReception(values[NOTIFICATION_RECEPTION_KEY]) : { value: null, error: "" };
  return {
    settings: values?.[SETTINGS_KEY] ?? { ...DEFAULT_SETTINGS },
    history: Array.isArray(values?.[HISTORY_KEY]) ? values[HISTORY_KEY].filter(entry => entry && typeof entry === "object" && typeof entry.message === "string") : [],
    notificationReception: reception.value,
    notificationError: reception.error,
    monitorStatus: values?.[MONITOR_STATUS_KEY] ?? null,
    gatewayError: values?.[GATEWAY_ERROR_KEY] ?? null,
  };
}

export function subscribeStorageChanges(listener) {
  const onChanged = browserApi.storage.onChanged;
  if (!onChanged?.addListener) return () => {};
  const handler = (changes, areaName) => {
    if (areaName === "local") listener(changes);
  };
  onChanged.addListener(handler);
  return () => onChanged.removeListener?.(handler);
}

export function isReady(settings) {
  return Boolean(
    settings &&
    settings.monitorEnabled === true &&
    typeof settings.serverUrl === "string" && settings.serverUrl.trim() &&
    typeof settings.token === "string" && settings.token.trim(),
  );
}
