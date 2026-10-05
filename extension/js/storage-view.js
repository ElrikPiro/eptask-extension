import { browserApi } from "./browser-api.js";

export const SETTINGS_KEY = "settings.v1";
export const HISTORY_KEY = "notificationHistory.v1";
export const MONITOR_STATUS_KEY = "monitorStatus.v1";
export const GATEWAY_ERROR_KEY = "gatewayError.v1";

export const DEFAULT_SETTINGS = Object.freeze({
  schemaVersion: 1,
  serverUrl: "",
  token: "",
  monitorEnabled: false,
  timeoutMs: 30000,
});

export async function readExtensionState() {
  const values = await browserApi.storage.local.get([
    SETTINGS_KEY,
    HISTORY_KEY,
    MONITOR_STATUS_KEY,
    GATEWAY_ERROR_KEY,
  ]);
  return {
    settings: values?.[SETTINGS_KEY] ?? { ...DEFAULT_SETTINGS },
    history: Array.isArray(values?.[HISTORY_KEY]) ? values[HISTORY_KEY] : [],
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
