const API_ROOT = "https://tasks.example.test:9443/prefix/api/v1";
const HISTORY_A = "00000000-0000-4000-8000-000000000111";
const HISTORY_B = "00000000-0000-4000-8000-000000000112";
const OBSERVED_AT = "2026-10-05T10:00:00+02:00";

function notificationEntry(historyId, sequence, text, overrides = {}) {
  return {
    id: `${historyId}:${sequence}`,
    historyId,
    sequence,
    timestamp: OBSERVED_AT,
    text,
    ...overrides,
  };
}

function notificationsSnapshot(entries = [], overrides = {}) {
  const historyId = overrides.historyId || HISTORY_A;
  const notifications = entries.map((entry, index) => typeof entry === "string"
    ? notificationEntry(historyId, index + 1, entry)
    : { ...entry });
  const sequences = notifications.map((entry) => entry.sequence);
  const nextSequence = overrides.nextSequence ?? (sequences.length ? Math.max(...sequences) + 1 : 1);
  return {
    schemaVersion: 1,
    historyId,
    nextSequence,
    discardedThrough: overrides.discardedThrough ?? 0,
    retainedFromSequence: sequences.length ? Math.min(...sequences) : null,
    retainedThroughSequence: sequences.length ? Math.max(...sequences) : null,
    total: notifications.length,
    observedAt: OBSERVED_AT,
    _links: {
      self: { href: `${API_ROOT}/notifications` },
      root: { href: API_ROOT },
    },
    _embedded: { notifications },
    ...overrides,
  };
}

function sequenceRange(historyId, first, last, textFor = (sequence) => `Notice ${sequence}`) {
  const entries = [];
  for (let sequence = first; sequence <= last; sequence += 1) {
    entries.push(notificationEntry(historyId, sequence, textFor(sequence)));
  }
  return entries;
}

function receptionEntry(entry, endpointKey = API_ROOT) {
  return { endpointKey, ...entry };
}

function receptionState({ endpointKey = API_ROOT, historyId = null, lastReceivedSequence = 0, buffer = [], bufferGeneration = 0, continuity } = {}) {
  return {
    schemaVersion: 1,
    endpointKey,
    historyId,
    lastReceivedSequence,
    buffer: buffer.map((entry) => receptionEntry(entry, endpointKey)),
    bufferGeneration,
    ...(continuity ? { continuity } : {}),
  };
}

module.exports = { API_ROOT, HISTORY_A, HISTORY_B, OBSERVED_AT, notificationEntry, notificationsSnapshot, sequenceRange, receptionEntry, receptionState };
