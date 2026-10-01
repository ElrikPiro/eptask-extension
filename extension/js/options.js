import { assertSuccessfulReply, settingsMessages } from "./messages.js";
import { DEFAULT_SETTINGS, readExtensionState, subscribeStorageChanges } from "./storage-view.js";

const form = document.querySelector("#settings-form");
const serverInput = document.querySelector("#server-url");
const tokenInput = document.querySelector("#token");
const message = document.querySelector("#options-message");
const badge = document.querySelector("#monitor-badge");
const description = document.querySelector("#monitor-description");
const saveButton = document.querySelector("#save-settings");
const connectButton = document.querySelector("#connect");
const disconnectButton = document.querySelector("#disconnect");
const clearButton = document.querySelector("#clear-settings");
let settings = { ...DEFAULT_SETTINGS };
let isDirty = false;

function showMessage(text, kind = "info") {
  message.hidden = !text;
  message.textContent = text;
  message.className = `alert ${kind}`;
}

function paintConnection(value) {
  const enabled = value?.monitorEnabled === true && Boolean(value?.token) && Boolean(value?.serverUrl);
  badge.textContent = enabled ? "Conectado" : "Desconectado";
  badge.className = `status-pill ${enabled ? "online" : "offline"}`;
  description.textContent = enabled
    ? "El monitor consulta las notificaciones y la agenda según su alarma periódica."
    : "El monitor permanece inactivo hasta validar la conexión.";
  disconnectButton.disabled = !enabled;
  clearButton.disabled = !value?.serverUrl && !value?.token;
}

function updateForm(value, force = false) {
  settings = value && typeof value === "object" ? value : { ...DEFAULT_SETTINGS };
  paintConnection(settings);
  if (force || !isDirty) {
    serverInput.value = settings.serverUrl || "";
    tokenInput.value = settings.token || "";
    isDirty = false;
  }
}

function currentSettings() {
  return {
    schemaVersion: 1,
    serverUrl: serverInput.value.trim(),
    token: tokenInput.value,
    monitorEnabled: false,
  };
}

function setBusy(value) {
  for (const button of [saveButton, connectButton, disconnectButton, clearButton]) button.disabled = value;
}

async function perform(label, action) {
  setBusy(true);
  showMessage(`${label}…`);
  try {
    const reply = assertSuccessfulReply(await action());
    showMessage(reply.data?.message || `${label} completado.`, "info");
    const latest = await readExtensionState();
    updateForm(latest.settings, true);
  } catch (error) {
    showMessage(error instanceof Error ? error.message : "No se pudo actualizar la configuración.", "error");
  } finally {
    setBusy(false);
    paintConnection(settings);
  }
}

serverInput.addEventListener("input", () => { isDirty = true; });
tokenInput.addEventListener("input", () => { isDirty = true; });
form.addEventListener("submit", (event) => {
  event.preventDefault();
  void perform("Guardando configuración", () => settingsMessages.save(currentSettings()));
});
connectButton.addEventListener("click", () => {
  if (!form.reportValidity()) return;
  void perform("Probando conexión", () => settingsMessages.connect(currentSettings()));
});
disconnectButton.addEventListener("click", () => {
  void perform("Desconectando", () => settingsMessages.disconnect());
});
clearButton.addEventListener("click", () => {
  if (!globalThis.confirm("¿Borrar la URL y el token guardados?")) return;
  void perform("Borrando credenciales", () => settingsMessages.clear());
});

void readExtensionState().then((value) => updateForm(value.settings, true));
subscribeStorageChanges((changes) => {
  if (changes["settings.v1"]) updateForm(changes["settings.v1"].newValue);
  if (changes["monitorStatus.v1"]?.newValue) {
    const state = changes["monitorStatus.v1"].newValue;
    if (state.ok === false && state.error) {
      const detail = typeof state.error === "object" ? state.error.message : state.error;
      showMessage(`Último ciclo: ${detail || "error"}`, "error");
    }
  }
});
