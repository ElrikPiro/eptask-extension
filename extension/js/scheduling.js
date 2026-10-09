// Mirrors the versioned heuristic-v1 calculations advertised by the server.
export function dailyEffort(value) {
  const text = String(value).trim();
  let effort;
  if (/^\d+(?:\.\d+)?$/.test(text)) effort = Number(text);
  else {
    let milliseconds;
    const clock = /^(\d+):(\d+)$/.exec(text);
    const duration = /^(\d+(?:\.\d+)?)([smhdwp])$/.exec(text);
    if (clock) milliseconds = (Number(clock[1]) * 60 + Number(clock[2])) * 60000;
    else if (duration) milliseconds = Number(duration[1]) * { s: 1000, m: 60000, h: 3600000, d: 86400000, w: 604800000, p: 1500000 }[duration[2]];
    else throw new Error("Indica una dedicación diaria válida, como 30m, 2p o 01:00.");
    effort = Math.ceil(Math.trunc(milliseconds) / 60000) / 25;
  }
  if (!Number.isFinite(effort) || effort <= 0) throw new Error("La dedicación diaria debe ser mayor que cero.");
  return effort;
}

export function schedulingPreview(task, configuration, mode, effortValue, now = Date.now()) {
  if (configuration?.algorithm !== "heuristic-v1") throw new Error("Este servidor aún no proporciona los datos de previsualización. Actualiza el backend y los datos de la tarea.");
  const p = Number(configuration.dailyDedication);
  const r = Number(task.totalCost?.value);
  const start = Date.parse(task.start);
  const due = Date.parse(task.due);
  if (!Number.isFinite(p) || p <= 0) throw new Error("La dedicación diaria configurada en el servidor debe ser mayor que cero.");
  if (!Number.isFinite(r) || r <= 0 || !Number.isFinite(start) || !Number.isFinite(due)) throw new Error("Completa un coste mayor que cero y fechas válidas en la tarea.");
  if (mode === "auto") {
    const days = Math.ceil(Math.max(0, (due - now) / 86400000));
    return { count: 1, severity: Math.max((days * p - r) / (p * r), 1), due: task.due, cost: r, description: task.description, days };
  }
  const effort = dailyEffort(effortValue);
  const severity = p / effort;
  const count = severity >= 1 ? 1 : Math.ceil(1 / severity);
  const cost = count === 1 ? r : Math.ceil(Math.trunc((r / count) * 1500000) / 60000) / 25;
  // Split parts use a fixed 1p/day, as the server currently does.
  const resultingSeverity = count === 1 ? severity : p;
  const days = Math.ceil((r / count) * (p * resultingSeverity + 1) / p);
  const deadline = new Date(start + days * 86400000);
  if (!Number.isFinite(deadline.getTime()) || !Number.isSafeInteger(count)) throw new Error("La dedicación produce una planificación fuera del rango admitido.");
  return { count, severity: resultingSeverity, due: deadline.toISOString(), cost, description: task.description, days };
}
