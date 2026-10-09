export function browserTimeZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

export function availableTimeZones() {
  return [...new Set([browserTimeZone(), "UTC", "Europe/Madrid", ...(Intl.supportedValuesOf?.("timeZone") || [])])];
}

function normalizeLocal(value) {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/.exec(value);
  return match ? `${match[1]}:${match[2] || "00"}.${(match[3] || "").padEnd(3, "0")}` : value;
}

export function localInZone(value, timeZone) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone, calendar: "gregory", numberingSystem: "latn", hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}T${values.hour}:${values.minute}:${values.second}.${String(date.getUTCMilliseconds()).padStart(3, "0")}`;
}

export function dateTimeParts(value) {
  const match = /^(.*)\[([^\]]+)\]$/.exec(String(value || ""));
  const timeZone = match?.[2] || browserTimeZone();
  const raw = match?.[1] ?? String(value || "");
  const local = /(?:Z|[+-]\d{2}:\d{2})$/.test(raw) ? localInZone(raw, timeZone) : normalizeLocal(raw);
  return { local, timeZone };
}

export function dateTimeControlValue(value) {
  return dateTimeParts(value).local;
}

export function zonedControlValue(local, timeZone) {
  if (!local) return "";
  const normalized = normalizeLocal(local);
  return timeZone === browserTimeZone() ? normalized : `${normalized}[${timeZone}]`;
}

export function dateTimeToIso(value) {
  const { local, timeZone } = dateTimeParts(value);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}$/.test(local)) throw new Error("Selecciona una fecha y hora válida.");
  const wall = Date.parse(`${local}Z`);
  if (!Number.isFinite(wall) || new Date(wall).toISOString() !== `${local}Z`) throw new Error("Selecciona una fecha y hora válida.");
  // Probe both sides of timezone transitions, then validate the wall time exactly.
  const offsets = new Set();
  for (let hours = -48; hours <= 48; hours += 6) {
    const sample = wall + hours * 3600000;
    offsets.add(Date.parse(`${localInZone(sample, timeZone)}Z`) - sample);
  }
  const matches = [...offsets].map(offset => wall - offset)
    .filter(epoch => localInZone(epoch, timeZone) === local).sort((a, b) => a - b);
  if (!matches.length) throw new Error(`Esa hora no existe en ${timeZone} por el cambio de horario. Selecciona una fecha y hora válida.`);
  // Repeated autumn hours resolve to their first occurrence, consistently in all browsers.
  return new Date(matches[0]).toISOString();
}
