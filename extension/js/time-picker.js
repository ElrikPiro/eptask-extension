import { TimepickerUI, PluginRegistry } from "./vendor/timepicker-ui/index.js";
import { TimezonePlugin } from "./vendor/timepicker-ui/timezone.js";
import { availableTimeZones } from "./date-time.js";

PluginRegistry.register(TimezonePlugin);
const pickers = new Set();

export function disposeTimePickers() {
  for (const picker of pickers) picker.destroy({ keepInputValue: true });
  pickers.clear();
}

export function bindTimePickers(root) {
  for (const button of root.querySelectorAll("button[data-time-picker]")) {
    let picker = null;
    button.addEventListener("click", () => {
      if (button.disabled) return;
      const form = button.closest("form");
      const name = button.dataset.timePicker;
      const time = form.elements.namedItem(`${name}.time`);
      const zone = form.elements.namedItem(`${name}.zone`);
      const pickerInput = button.parentNode.querySelector(".time-picker-input");
      if (picker) { picker.destroy({ keepInputValue: true }); pickers.delete(picker); }
      pickerInput.value = time.value.slice(0, 5) || "00:00";
      let pendingZone = zone.value;
      picker = new TimepickerUI(pickerInput, {
        clock: { type: "24h" },
        ui: { theme: "basic", animation: false },
        timezone: { enabled: true, default: zone.value, whitelist: [...new Set([zone.value, ...availableTimeZones()])], label: "Zona horaria" },
        labels: {
          ok: "Aceptar", cancel: "Cancelar", time: "Seleccionar hora", mobileTime: "Seleccionar hora",
          hourLabel: "Hora", minuteLabel: "Minutos", clockLabel: "Reloj", timezoneSelectorLabel: "Zona horaria",
          switchToKeyboardLabel: "Escribir hora", switchToClockLabel: "Mostrar reloj", format24Label: "24 horas",
        },
        behavior: { focusInputAfterClose: false },
        callbacks: {
          onTimezoneChange: ({ timezone }) => { pendingZone = timezone; },
          onConfirm: ({ hour, minutes }) => {
            time.value = `${String(hour).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:00.000`;
            zone.value = pendingZone;
            form.querySelector(`#${zone.id}-label`).textContent = `Zona horaria: ${pendingZone}`;
            time.dispatchEvent(new Event("input", { bubbles: true }));
            button.focus();
          },
          onCancel: () => button.focus(),
        },
      });
      pickers.add(picker);
      picker.create();
      const currentPicker = picker;
      picker.open();
      requestAnimationFrame(() => {
        if (!pickers.has(currentPicker)) return;
        // Upstream offsets describe today; show IANA IDs for future dates too.
        for (const option of document.querySelectorAll(".tp-ui-timezone-option")) option.textContent = option.dataset.value;
        const selected = document.querySelector(".tp-ui-timezone-selected");
        if (selected) selected.textContent = pendingZone;
      });
    });
  }
}
