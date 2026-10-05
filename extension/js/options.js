import { assertSuccessfulReply, settingsMessages } from "./messages.js";
import { DEFAULT_SETTINGS, readExtensionState, subscribeStorageChanges } from "./storage-view.js";

const form = document.querySelector("#settings-form");
const serverInput = document.querySelector("#server-url");
const tokenInput = document.querySelector("#token");
const timeoutInput = document.querySelector("#timeout-ms");
const message = document.querySelector("#options-message");
const badge = document.querySelector("#monitor-badge");
const description = document.querySelector("#monitor-description");
const saveButton = document.querySelector("#save-settings");
const connectButton = document.querySelector("#connect");
const disconnectButton = document.querySelector("#disconnect");
const clearButton = document.querySelector("#clear-settings");
const TIMEOUT_MIN = 1000;
const TIMEOUT_MAX = 120000;
let settings = { ...DEFAULT_SETTINGS };
let isDirty = false;

const SAFE_ERRORS = Object.freeze({
  "permission-denied": "No se concedió permiso para acceder al servidor.",
  "permission-required": "Se necesita permiso para acceder al servidor. Vuelve a conectar.",
  "endpoint-invalid": "La dirección del servidor no es válida. Usa una URL HTTPS sin usuario, contraseña, consulta ni fragmento.",
  tls: "No se pudo establecer una conexión TLS segura. Revisa la dirección y el certificado del servidor.",
  network: "No se pudo conectar con el servidor. Comprueba la dirección y la red.",
  timeout: "El servidor tardó demasiado en responder.",
  parse: "El servidor devolvió una respuesta que no se pudo leer.",
  "invalid-response": "El servidor devolvió una respuesta no válida.",
  "invalid-config": "La configuración no es válida. Comprueba la dirección y el token.",
  "invalid-request": "La solicitud no es válida. Revisa los datos configurados.",
  "gateway-unavailable": "No se pudo contactar con el servicio de conexión.",
  http: "El servidor respondió con un error.",
  uncertain: "No se pudo confirmar el resultado. Comprueba el estado antes de repetir la acción.",
  "unsupported-operation": "Esta función no está disponible en esta versión de la extensión.",
  "task-changed": "La tarea urgente cambió. Actualiza la agenda antes de actuar.",
  "task-missing": "La tarea ya no está disponible en la agenda.",
  "task-ambiguous": "La agenda contiene identidades repetidas; no se aplicó la acción.",
});

function showMessage(text, kind = "info") {
  message.hidden = !text;
  message.textContent = text;
  message.className = `alert ${kind}`;
}

function safeErrorMessage(error) {
  const kind = typeof error?.kind === "string" ? error.kind : "";
  const detail = SAFE_ERRORS[kind] || "No se pudo completar la operación. Revisa la configuración e inténtalo de nuevo.";
  if (kind === "http" && Number.isInteger(error?.status) && error.status >= 100 && error.status <= 599) {
    return `${detail} (HTTP ${error.status})`;
  }
  return detail;
}

function canonicalizeEndpointInput(value) {
  const raw = String(value ?? "").trim();
  if (!raw || !/^https:\/\//i.test(raw) || /[\s\\\u0000-\u001f\u007f?#]/.test(raw)) return null;

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (
    parsed.protocol !== "https:" || !parsed.hostname || parsed.username || parsed.password ||
    parsed.search || parsed.hash || raw.includes("?") || raw.includes("#")
  ) return null;

  const afterScheme = raw.slice("https://".length);
  const pathStart = afterScheme.indexOf("/");
  const authority = pathStart < 0 ? afterScheme : afterScheme.slice(0, pathStart);
  if (authority.includes("@")) return null;
  const rawPath = pathStart < 0 ? "/" : afterScheme.slice(pathStart);
  const rawSegments = rawPath.split("/").filter(Boolean);
  const segments = [];
  try {
    for (const rawSegment of rawSegments) {
      const segment = decodeURIComponent(rawSegment);
      if (!segment || segment === "." || segment === ".." || /[\\/\u0000-\u001f\u007f]/.test(segment)) return null;
      segments.push(encodeURIComponent(segment));
    }
  } catch {
    return null;
  }

  let path = segments.length ? `/${segments.join("/")}` : "";
  const suffix = "/api/v1";
  if (/\/api\/v1(?:\/api\/v1)+$/i.test(path)) return null;
  if (path.toLowerCase().endsWith(suffix)) {
    path = `${path.slice(0, -suffix.length)}${suffix}`;
  } else {
    path += suffix;
  }
  return `${parsed.origin}${path}`;
}

function paintConnection(value) {
  const enabled = value?.monitorEnabled === true && Boolean(value?.token) && Boolean(value?.serverUrl);
  badge.textContent = enabled ? "Conectado" : value?.serverUrl && value?.token ? "Sin validar" : "Desconectado";
  badge.className = `status-pill ${enabled ? "online" : "offline"}`;
  description.textContent = enabled
    ? "El servidor respondió correctamente a la comprobación de conexión."
    : "Valida la conexión para habilitar las funciones disponibles.";
  disconnectButton.disabled = !enabled;
  clearButton.disabled = !value?.serverUrl && !value?.token;
}

function updateForm(value, force = false) {
  settings = value && typeof value === "object" ? value : { ...DEFAULT_SETTINGS };
  paintConnection(settings);
  if (force || !isDirty) {
    serverInput.value = settings.serverUrl || "";
    tokenInput.value = settings.token || "";
    timeoutInput.value = String(settings.timeoutMs ?? DEFAULT_SETTINGS.timeoutMs ?? 30000);
    isDirty = false;
  }
}

function currentSettings(monitorEnabled = false) {
  const canonicalUrl = canonicalizeEndpointInput(serverInput.value);
  if (!canonicalUrl) {
    serverInput.setCustomValidity("Introduce una URL HTTPS válida sin credenciales, consulta ni fragmento.");
    serverInput.reportValidity();
    throw new Error("endpoint-invalid");
  }
  serverInput.setCustomValidity("");

  const timeoutMs = Number(timeoutInput.value);
  if (!Number.isInteger(timeoutMs) || timeoutMs < TIMEOUT_MIN || timeoutMs > TIMEOUT_MAX) {
    timeoutInput.setCustomValidity("El tiempo debe estar entre 1000 y 120000 milisegundos.");
    timeoutInput.reportValidity();
    throw new Error("timeout-invalid");
  }
  timeoutInput.setCustomValidity("");
  serverInput.value = canonicalUrl;

  return {
    schemaVersion: 1,
    serverUrl: canonicalUrl,
    token: tokenInput.value,
    monitorEnabled,
    timeoutMs,
  };
}

function setBusy(value) {
  for (const button of [saveButton, connectButton, disconnectButton, clearButton]) button.disabled = value;
}

async function perform(label, action) {
  setBusy(true);
  showMessage(`${label}…`);
  try {
    assertSuccessfulReply(await action());
    showMessage(`${label} completado.`, "info");
    const latest = await readExtensionState();
    updateForm(latest.settings, true);
  } catch (error) {
    const text = error?.message === "endpoint-invalid"
      ? SAFE_ERRORS["endpoint-invalid"]
      : error?.message === "timeout-invalid"
        ? "El tiempo de espera debe estar entre 1 y 120 segundos."
        : safeErrorMessage(error);
    showMessage(text, "error");
  } finally {
    setBusy(false);
    paintConnection(settings);
  }
}

serverInput.addEventListener("input", () => { isDirty = true; serverInput.setCustomValidity(""); });
tokenInput.addEventListener("input", () => { isDirty = true; });
timeoutInput.addEventListener("input", () => { isDirty = true; timeoutInput.setCustomValidity(""); });
form.addEventListener("submit", (event) => {
  event.preventDefault();
  if (!form.reportValidity()) return;
  void perform("Guardando configuración", () => settingsMessages.save(currentSettings(false)));
});
connectButton.addEventListener("click", () => {
  if (!form.reportValidity()) return;
  void perform("Probando conexión", () => settingsMessages.connect(currentSettings(true)));
});
disconnectButton.addEventListener("click", () => {
  void perform("Desconectando", () => settingsMessages.disconnect());
});
clearButton.addEventListener("click", () => {
  if (!globalThis.confirm("¿Borrar la URL y el token guardados?")) return;
  void perform("Borrando credenciales", () => settingsMessages.clear());
});

void readExtensionState().then((value) => {
  updateForm(value.settings, true);
  if (value.gatewayError) showMessage(safeErrorMessage(value.gatewayError), "error");
});
subscribeStorageChanges((changes) => {
  if (changes["settings.v1"]) updateForm(changes["settings.v1"].newValue);
  if (changes["gatewayError.v1"]?.newValue) {
    showMessage(safeErrorMessage(changes["gatewayError.v1"].newValue), "error");
  }
});
