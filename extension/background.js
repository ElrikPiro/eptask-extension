/* Classic script shared by Chromium service workers and Firefox event backgrounds.
 * All HTTP access and credential handling stay in this extension-owned gateway.
 */
(() => {
  'use strict';
  const native = typeof browser !== 'undefined' ? browser : chrome;
  const promiseApi = typeof browser !== 'undefined';
  const SETTINGS_KEY = 'settings.v1';
  const ERROR_KEY = 'gatewayError.v1';
  const URGENCY_KEY = 'urgentIndicator.v1';
  const RECEPTION_KEY = 'notificationReception.v1';
  const LEGACY_HISTORY_KEY = 'notificationHistory.v1';
  const MANAGER_RECENCY_KEY = 'managerRecency.v1';
  const LEGACY_MONITOR_ALARM = 'eptask-notification-monitor';
  const URGENCY_ALARM = 'eptask-urgent-indicator';
  const PROTOCOL_VERSION = 1;
  const DEFAULT_TIMEOUT = 30000;
  const RECEPTION_LIMIT = 1024;
  const GAP_RANGE_LIMIT = 16;
  const MONITOR_HEURISTIC = 'Remaining Effort(1)';
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const PATCH_FIELDS = new Set(['description', 'context', 'start', 'due', 'severity', 'totalCost', 'calm', 'raised', 'waited']);
  const OPERATION_TYPES = new Set([
    'create-task', 'edit-task', 'complete-task', 'schedule-task', 'record-work', 'snooze-task',
    'raise-event', 'open-project', 'close-project', 'hold-project', 'edit-project-content',
  ]);
  const knownQueries = new Set([
    'root.read', 'tasks.list', 'tasks.get', 'tasks.patch', 'agenda.read', 'statistics.read',
    'events.list', 'strategies.list', 'projects.list', 'projects.get', 'notifications.read',
    'operations.submit', 'operations.get', 'settings.save', 'settings.connect',
    'settings.disconnect', 'settings.clear', 'history.clear', 'notifications.clear-local', 'manager.open',
  ]);
  let monitorBusy = false;
  let alarmReconciliationCount = 0;
  let startupBusy = false;
  let queue = Promise.resolve();
  let receptionQueue = Promise.resolve();
  let managerStateQueue = Promise.resolve();
  let managerEventQueue = Promise.resolve();
  let managerOpenPromise = null;
  const pendingManagerUses = new Map();
  let currentUrgent = false;
  let badgeStateVersion = 0;
  let badgeMutationCount = 0;
  let badgeWriteQueue = Promise.resolve();
  let configurationRevision = 0;
  let nativeNotificationCounter = 0;

  function callApi(owner, method, ...args) {
    if (promiseApi) {
      try { return Promise.resolve(owner[method](...args)); }
      catch { return Promise.reject(new Error('browser-api-failure')); }
    }
    if (owner === native.alarms && method === 'create') {
      try { return Promise.resolve(owner[method](...args)); }
      catch { return Promise.reject(new Error('browser-api-failure')); }
    }
    return new Promise((resolve, reject) => {
      try {
        owner[method](...args, result => {
          if (native.runtime.lastError) reject(new Error('browser-api-failure'));
          else resolve(result);
        });
      } catch { reject(new Error('browser-api-failure')); }
    });
  }

  function enqueue(job) {
    const result = queue.then(job);
    queue = result.catch(() => {});
    return result;
  }

  function enqueueReception(job) {
    const result = receptionQueue.then(job);
    receptionQueue = result.catch(() => {});
    return result;
  }

  function defaultReceptionState() {
    return {
      schemaVersion: 1,
      endpointKey: '',
      historyId: null,
      lastReceivedSequence: 0,
      buffer: [],
      bufferGeneration: 0,
      continuity: emptyContinuity(),
    };
  }

  function emptyContinuity() {
    return {discardedThrough: 0, missedRanges: [], gapsTruncated: false, localTruncated: false};
  }

  function validOffsetTimestamp(value) {
    if (typeof value !== 'string') return false;
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-](\d{2}):(\d{2}))$/.exec(value);
    if (!match || !Number.isFinite(Date.parse(value))) return false;
    const [, year, month, day, hour, minute, second, , offsetHour, offsetMinute] = match;
    const calendar = new Date(0);
    calendar.setUTCFullYear(Number(year), Number(month) - 1, Number(day));
    calendar.setUTCHours(0, 0, 0, 0);
    if (calendar.getUTCFullYear() !== Number(year) || calendar.getUTCMonth() !== Number(month) - 1 || calendar.getUTCDate() !== Number(day) ||
        Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) return false;
    if (offsetHour !== undefined && (Number(offsetHour) > 23 || Number(offsetMinute) > 59)) return false;
    return true;
  }

  function validateEndpointKey(value) {
    if (typeof value !== 'string' || value.length > 8192) fail('invalid-response');
    if (value === '') return value;
    let url;
    try { url = new URL(value); } catch { fail('invalid-response'); }
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.search || url.hash || url.href.replace(/\/$/, '') !== value.replace(/\/$/, '')) fail('invalid-response');
    return value;
  }

  function normalizeContinuity(value) {
    if (value === null || value === undefined) return emptyContinuity();
    exactKeys(value, ['discardedThrough', 'missedRanges', 'gapsTruncated', 'localTruncated'], ['discardedThrough', 'missedRanges', 'gapsTruncated', 'localTruncated']);
    if (!Number.isSafeInteger(value.discardedThrough) || value.discardedThrough < 0 ||
        !Array.isArray(value.missedRanges) || value.missedRanges.length > GAP_RANGE_LIMIT ||
        typeof value.gapsTruncated !== 'boolean' || typeof value.localTruncated !== 'boolean') fail('invalid-response');
    const missedRanges = value.missedRanges.map(range => {
      exactKeys(range, ['fromSequence', 'throughSequence'], ['fromSequence', 'throughSequence']);
      if (!Number.isSafeInteger(range.fromSequence) || range.fromSequence < 1 ||
          !Number.isSafeInteger(range.throughSequence) || range.throughSequence < range.fromSequence) fail('invalid-response');
      return {fromSequence: range.fromSequence, throughSequence: range.throughSequence};
    });
    return {discardedThrough: value.discardedThrough, missedRanges, gapsTruncated: value.gapsTruncated, localTruncated: value.localTruncated};
  }

  function normalizeReceptionState(value) {
    if (value === undefined || value === null) return defaultReceptionState();
    exactKeys(value, ['schemaVersion', 'endpointKey', 'historyId', 'lastReceivedSequence', 'buffer', 'bufferGeneration', 'continuity'],
      ['schemaVersion', 'endpointKey', 'historyId', 'lastReceivedSequence', 'buffer', 'bufferGeneration']);
    if (value.schemaVersion !== 1 || !Number.isSafeInteger(value.lastReceivedSequence) || value.lastReceivedSequence < 0 ||
        !Number.isSafeInteger(value.bufferGeneration) || value.bufferGeneration < 0 || !Array.isArray(value.buffer) || value.buffer.length > RECEPTION_LIMIT ||
        (value.historyId !== null && !isUuid(value.historyId))) fail('invalid-response');
    const endpointKey = validateEndpointKey(value.endpointKey);
    const identities = new Set();
    const buffer = value.buffer.map(entry => {
      exactKeys(entry, ['endpointKey', 'id', 'historyId', 'sequence', 'timestamp', 'text'], ['endpointKey', 'id', 'historyId', 'sequence', 'timestamp', 'text']);
      const itemEndpoint = validateEndpointKey(entry.endpointKey);
      if (!itemEndpoint || !isUuid(entry.historyId) || !Number.isSafeInteger(entry.sequence) || entry.sequence < 1 ||
          entry.id !== `${entry.historyId}:${entry.sequence}` || !validOffsetTimestamp(entry.timestamp) ||
          typeof entry.text !== 'string' || entry.text.length > 1000) fail('invalid-response');
      const identity = `${itemEndpoint}\u0000${entry.historyId}\u0000${entry.id}`;
      if (identities.has(identity)) fail('invalid-response');
      identities.add(identity);
      return {endpointKey: itemEndpoint, id: entry.id, historyId: entry.historyId, sequence: entry.sequence, timestamp: entry.timestamp, text: entry.text};
    });
    return {
      schemaVersion: 1,
      endpointKey,
      historyId: value.historyId,
      lastReceivedSequence: value.lastReceivedSequence,
      buffer,
      bufferGeneration: value.bufferGeneration,
      continuity: normalizeContinuity(value.continuity),
    };
  }

  async function readReceptionState() {
    let values;
    try { values = await callApi(native.storage.local, 'get', RECEPTION_KEY); }
    catch { fail('gateway-unavailable'); }
    return normalizeReceptionState(values[RECEPTION_KEY]);
  }

  async function receptionGenerationMatches(expectedGeneration) {
    try { return (await readReceptionState()).bufferGeneration === expectedGeneration; }
    catch { return false; }
  }

  function validateNotificationSnapshot(data, settings) {
    exactKeys(data, ['schemaVersion', 'historyId', 'nextSequence', 'discardedThrough', 'retainedFromSequence', 'retainedThroughSequence', 'total', 'observedAt', '_links', '_embedded'],
      ['schemaVersion', 'historyId', 'nextSequence', 'discardedThrough', 'retainedFromSequence', 'retainedThroughSequence', 'total', 'observedAt', '_links', '_embedded']);
    if (data.schemaVersion !== 1 || !isUuid(data.historyId) || data.historyId !== data.historyId.toLowerCase() ||
        !Number.isSafeInteger(data.nextSequence) || data.nextSequence < 1 ||
        !Number.isSafeInteger(data.discardedThrough) || data.discardedThrough < 0 || data.discardedThrough >= data.nextSequence ||
        !Number.isSafeInteger(data.total) || data.total < 0 || data.total > RECEPTION_LIMIT || !validOffsetTimestamp(data.observedAt)) fail('invalid-response');
    exactKeys(data._links, ['self', 'root'], ['self', 'root']);
    for (const name of ['self', 'root']) {
      exactKeys(data._links[name], ['href', 'method'], ['href']);
      if (data._links[name].method !== undefined && data._links[name].method !== 'GET') fail('invalid-response');
      const link = validateDestination(settings, data._links[name].href, false);
      const expected = name === 'self' ? apiUrl(settings, 'notifications') : baseUrl(settings);
      if (link.href.replace(/\/$/, '') !== expected.replace(/\/$/, '')) fail('invalid-response');
    }
    exactKeys(data._embedded, ['notifications'], ['notifications']);
    if (!Array.isArray(data._embedded.notifications) || data._embedded.notifications.length !== data.total ||
        data.total !== data.nextSequence - 1 - data.discardedThrough) fail('invalid-response');
    const entries = data._embedded.notifications.map(entry => {
      exactKeys(entry, ['id', 'historyId', 'sequence', 'timestamp', 'text'], ['id', 'historyId', 'sequence', 'timestamp', 'text']);
      if (entry.historyId !== data.historyId || !Number.isSafeInteger(entry.sequence) ||
          entry.sequence <= data.discardedThrough || entry.sequence >= data.nextSequence ||
          entry.id !== `${data.historyId}:${entry.sequence}` || !validOffsetTimestamp(entry.timestamp) ||
          typeof entry.text !== 'string' || entry.text.length > 20000) fail('invalid-response');
      return {
        id: entry.id,
        historyId: entry.historyId,
        sequence: entry.sequence,
        timestamp: entry.timestamp,
        text: safeRemoteText(entry.text, settings.token),
      };
    });
    entries.sort((left, right) => left.sequence - right.sequence);
    if (entries.some((entry, index) => entry.sequence !== data.discardedThrough + index + 1)) fail('invalid-response');
    const first = entries.length ? entries[0].sequence : null;
    const last = entries.length ? entries[entries.length - 1].sequence : null;
    if (data.retainedFromSequence !== first || data.retainedThroughSequence !== last) fail('invalid-response');
    return {historyId: data.historyId, nextSequence: data.nextSequence, discardedThrough: data.discardedThrough, entries};
  }

  function addMissedRange(continuity, fromSequence, throughSequence) {
    if (fromSequence > throughSequence) return;
    const ranges = continuity.missedRanges;
    const last = ranges[ranges.length - 1];
    if (last && fromSequence === last.throughSequence + 1) last.throughSequence = throughSequence;
    else ranges.push({fromSequence, throughSequence});
    if (ranges.length > GAP_RANGE_LIMIT) {
      ranges.splice(0, ranges.length - GAP_RANGE_LIMIT);
      continuity.gapsTruncated = true;
    }
  }

  async function applyNotificationSnapshot(endpointKey, snapshot, expectedGeneration, revision) {
    return enqueueReception(async () => {
      if (revision !== configurationRevision) return {cancelled: true};
      const current = await readReceptionState();
      if (current.bufferGeneration !== expectedGeneration) return {cancelled: true};
      const sameScope = current.endpointKey === endpointKey && current.historyId === snapshot.historyId;
      let cursor = sameScope ? current.lastReceivedSequence : snapshot.discardedThrough;
      let continuity = sameScope && current.continuity
        ? current.continuity
        : {discardedThrough: snapshot.discardedThrough, missedRanges: [], gapsTruncated: false, localTruncated: false};
      if (sameScope) {
        if (snapshot.nextSequence - 1 < current.lastReceivedSequence || snapshot.discardedThrough < continuity.discardedThrough) fail('invalid-response');
        if (snapshot.discardedThrough > current.lastReceivedSequence) {
          addMissedRange(continuity, current.lastReceivedSequence + 1, snapshot.discardedThrough);
        }
        continuity.discardedThrough = snapshot.discardedThrough;
      }
      const known = new Set(current.buffer.map(item => `${item.endpointKey}\u0000${item.historyId}\u0000${item.id}`));
      const newEntries = [];
      const buffer = [...current.buffer];
      for (const entry of snapshot.entries) {
        if (entry.sequence <= cursor) continue;
        const item = {endpointKey, ...entry};
        const identity = `${item.endpointKey}\u0000${item.historyId}\u0000${item.id}`;
        if (known.has(identity)) continue;
        known.add(identity);
        buffer.push(item);
        newEntries.push(item);
      }
      let localTruncated = continuity.localTruncated;
      if (buffer.length > RECEPTION_LIMIT) {
        buffer.splice(0, buffer.length - RECEPTION_LIMIT);
        localTruncated = true;
      }
      continuity.localTruncated = localTruncated;
      const state = {
        schemaVersion: 1,
        endpointKey,
        historyId: snapshot.historyId,
        lastReceivedSequence: snapshot.nextSequence - 1,
        buffer,
        bufferGeneration: current.bufferGeneration,
        continuity,
      };
      if (revision !== configurationRevision) return {cancelled: true};
      try { await callApi(native.storage.local, 'set', {[RECEPTION_KEY]: state}); }
      catch { fail('gateway-unavailable'); }
      return {cancelled: false, state, newEntries};
    });
  }

  async function clearLocalReception() {
    return enqueueReception(async () => {
      const current = await readReceptionState();
      if (current.bufferGeneration >= Number.MAX_SAFE_INTEGER) fail('gateway-unavailable');
      const state = {
        ...current,
        buffer: [],
        bufferGeneration: current.bufferGeneration + 1,
        continuity: {...current.continuity, localTruncated: false},
      };
      try {
        await callApi(native.storage.local, 'set', {[RECEPTION_KEY]: state});
        await callApi(native.storage.local, 'remove', LEGACY_HISTORY_KEY);
      } catch { fail('gateway-unavailable'); }
      return state;
    });
  }

  function enqueueManagerState(job) {
    const result = managerStateQueue.then(job);
    managerStateQueue = result.catch(() => {});
    return result;
  }

  function enqueueManagerEvent(job) {
    const result = managerEventQueue.then(job);
    managerEventQueue = result.catch(() => {});
    return result;
  }

  function defaultManagerRecency() {
    return {schemaVersion: 1, nextOrdinal: 1, candidates: []};
  }

  function validTabId(value) { return Number.isSafeInteger(value) && value >= 0; }

  function normalizeManagerRecency(value) {
    if (value === undefined || value === null) return defaultManagerRecency();
    exactKeys(value, ['schemaVersion', 'nextOrdinal', 'candidates'], ['schemaVersion', 'nextOrdinal', 'candidates']);
    if (value.schemaVersion !== 1 || !Number.isSafeInteger(value.nextOrdinal) || value.nextOrdinal < 1 ||
        !Array.isArray(value.candidates) || value.candidates.length > 10000) fail('invalid-response');
    const tabIds = new Set();
    const ordinals = new Set();
    const candidates = value.candidates.map(candidate => {
      exactKeys(candidate, ['tabId', 'windowId', 'ordinal'], ['tabId', 'windowId', 'ordinal']);
      if (!validTabId(candidate.tabId) || !validTabId(candidate.windowId) || tabIds.has(candidate.tabId) ||
          !(candidate.ordinal === null || (Number.isSafeInteger(candidate.ordinal) && candidate.ordinal > 0 && candidate.ordinal < value.nextOrdinal)) ||
          (candidate.ordinal !== null && ordinals.has(candidate.ordinal))) fail('invalid-response');
      tabIds.add(candidate.tabId);
      if (candidate.ordinal !== null) ordinals.add(candidate.ordinal);
      return {tabId: candidate.tabId, windowId: candidate.windowId, ordinal: candidate.ordinal};
    });
    candidates.sort((left, right) => left.tabId - right.tabId);
    return {schemaVersion: 1, nextOrdinal: value.nextOrdinal, candidates};
  }

  async function readManagerRecency() {
    let values;
    try { values = await callApi(native.storage.local, 'get', MANAGER_RECENCY_KEY); }
    catch { fail('gateway-unavailable'); }
    return normalizeManagerRecency(values[MANAGER_RECENCY_KEY]);
  }

  async function saveManagerRecency(state) {
    try { await callApi(native.storage.local, 'set', {[MANAGER_RECENCY_KEY]: state}); }
    catch { fail('gateway-unavailable'); }
  }

  function managerPageUrl() {
    try {
      const url = native.runtime.getURL('index.html');
      if (typeof url !== 'string' || !url || /[?#]/.test(url)) fail('gateway-unavailable');
      return url;
    } catch (error) {
      if (error instanceof GatewayFault) throw error;
      fail('gateway-unavailable');
    }
  }

  function managerCandidateFromTab(tab, expectedWindowId = null, allowPending = false) {
    if (!isObject(tab) || !validTabId(tab.id) || !validTabId(tab.windowId) ||
        (expectedWindowId !== null && tab.windowId !== expectedWindowId)) return null;
    const ownUrl = managerPageUrl();
    if (tab.pendingUrl !== undefined && tab.pendingUrl !== null && tab.pendingUrl !== ownUrl) return null;
    const loaded = tab.url === ownUrl;
    const pending = allowPending && tab.pendingUrl === ownUrl;
    if (!loaded && !pending) return null;
    return {tabId: tab.id, windowId: tab.windowId, ordinal: null, active: tab.active === true, pending: !loaded};
  }

  async function revalidateManagerTab(tabId, expectedWindowId = null, allowPending = false) {
    if (!validTabId(tabId) || (expectedWindowId !== null && !validTabId(expectedWindowId)) || !native.tabs || typeof native.tabs.get !== 'function') return null;
    let tab;
    try { tab = await callApi(native.tabs, 'get', tabId); }
    catch { return null; }
    if (!tab || tab.id !== tabId) return null;
    return managerCandidateFromTab(tab, expectedWindowId, allowPending);
  }

  async function getPendingManagerTab(tabId) {
    if (!validTabId(tabId) || !native.tabs || typeof native.tabs.get !== 'function') return null;
    try { return await callApi(native.tabs, 'get', tabId); }
    catch { return null; }
  }

  async function discoverManagerCandidates() {
    if (!native.tabs || typeof native.tabs.query !== 'function') fail('gateway-unavailable');
    let tabs;
    try { tabs = await callApi(native.tabs, 'query', {}); }
    catch { fail('gateway-unavailable'); }
    if (!Array.isArray(tabs)) fail('gateway-unavailable');
    const candidates = [];
    for (const tab of tabs) {
      const candidate = managerCandidateFromTab(tab, null, true);
      if (!candidate) continue;
      const current = await revalidateManagerTab(candidate.tabId, candidate.windowId, true);
      if (current) candidates.push({...current});
    }
    candidates.sort((left, right) => left.windowId - right.windowId || left.tabId - right.tabId);
    return candidates;
  }

  async function mergeManagerCandidates(candidates) {
    return enqueueManagerState(async () => {
      const previous = await readManagerRecency();
      const byTabId = new Map(previous.candidates.map(candidate => [candidate.tabId, candidate]));
      const nextCandidates = candidates.map(candidate => ({
        tabId: candidate.tabId,
        windowId: candidate.windowId,
        ordinal: byTabId.get(candidate.tabId)?.ordinal ?? null,
      }));
      nextCandidates.sort((left, right) => left.tabId - right.tabId);
      const unchanged = previous.candidates.length === nextCandidates.length && previous.candidates.every((candidate, index) =>
        candidate.tabId === nextCandidates[index].tabId && candidate.windowId === nextCandidates[index].windowId && candidate.ordinal === nextCandidates[index].ordinal);
      if (unchanged) return previous;
      const state = {schemaVersion: 1, nextOrdinal: previous.nextOrdinal, candidates: nextCandidates};
      await saveManagerRecency(state);
      return state;
    });
  }

  async function ensureManagerCandidate(candidate) {
    return enqueueManagerState(async () => {
      const state = await readManagerRecency();
      const existing = state.candidates.find(item => item.tabId === candidate.tabId);
      if (existing && existing.windowId === candidate.windowId) return state;
      const candidates = state.candidates.filter(item => item.tabId !== candidate.tabId);
      candidates.push({tabId: candidate.tabId, windowId: candidate.windowId, ordinal: existing?.ordinal ?? null});
      candidates.sort((left, right) => left.tabId - right.tabId);
      const next = {...state, candidates};
      await saveManagerRecency(next);
      return next;
    });
  }

  async function removeManagerCandidate(tabId) {
    if (!validTabId(tabId)) return;
    return enqueueManagerState(async () => {
      const state = await readManagerRecency();
      const candidates = state.candidates.filter(candidate => candidate.tabId !== tabId);
      if (candidates.length === state.candidates.length) return state;
      const next = {...state, candidates};
      await saveManagerRecency(next);
      return next;
    });
  }

  async function recordManagerUse(candidate) {
    return enqueueManagerState(async () => {
      const state = await readManagerRecency();
      if (state.nextOrdinal >= Number.MAX_SAFE_INTEGER) fail('gateway-unavailable');
      const candidates = state.candidates.filter(item => item.tabId !== candidate.tabId);
      candidates.push({tabId: candidate.tabId, windowId: candidate.windowId, ordinal: state.nextOrdinal});
      candidates.sort((left, right) => left.tabId - right.tabId);
      const next = {schemaVersion: 1, nextOrdinal: state.nextOrdinal + 1, candidates};
      await saveManagerRecency(next);
      return next;
    });
  }

  function rememberPendingManagerUse(tabId, windowId, useWhenReady, focusWhenReady) {
    const previous = pendingManagerUses.get(tabId);
    pendingManagerUses.set(tabId, {
      windowId,
      useWhenReady: Boolean(useWhenReady || previous?.useWhenReady),
      focusWhenReady: Boolean(focusWhenReady || previous?.focusWhenReady),
    });
  }

  async function reconcileManagerCandidates() {
    try {
      const candidates = await discoverManagerCandidates();
      await mergeManagerCandidates(candidates);
    } catch { /* A missing tabs permission leaves manager reuse unavailable without affecting the gateway. */ }
  }

  async function focusedActiveCandidate(candidates) {
    if (!native.windows || typeof native.windows.getLastFocused !== 'function') return null;
    let focused;
    try { focused = await callApi(native.windows, 'getLastFocused', {populate: true}); }
    catch { return null; }
    if (!focused || focused.focused !== true || !validTabId(focused.id)) return null;
    const active = candidates.filter(candidate => candidate.windowId === focused.id && candidate.active).sort((left, right) => left.tabId - right.tabId);
    return active[0] || null;
  }

  async function rankManagerCandidates(candidates) {
    await managerEventQueue.catch(() => {});
    const recency = await enqueueManagerState(() => readManagerRecency()).catch(() => defaultManagerRecency());
    const ranked = candidates.map(candidate => ({...candidate, ordinal: recency.candidates.find(item => item.tabId === candidate.tabId && item.windowId === candidate.windowId)?.ordinal ?? null}));
    const used = ranked.some(candidate => Number.isSafeInteger(candidate.ordinal) && candidate.ordinal > 0);
    if (used) return ranked.sort((left, right) => {
      const leftUsed = Number.isSafeInteger(left.ordinal) && left.ordinal > 0;
      const rightUsed = Number.isSafeInteger(right.ordinal) && right.ordinal > 0;
      if (leftUsed !== rightUsed) return leftUsed ? -1 : 1;
      return (right.ordinal || 0) - (left.ordinal || 0) || left.windowId - right.windowId || left.tabId - right.tabId;
    });
    const focused = await focusedActiveCandidate(ranked);
    if (focused) return [focused, ...ranked.filter(candidate => candidate.tabId !== focused.tabId).sort((left, right) => left.windowId - right.windowId || left.tabId - right.tabId)];
    // When no usage or currently focused window can be reconstructed, choose the lower tabId.
    return [...ranked].sort((left, right) => left.tabId - right.tabId || left.windowId - right.windowId);
  }

  async function focusManagerCandidate(candidate) {
    if (!native.tabs || typeof native.tabs.update !== 'function' || !native.windows || typeof native.windows.update !== 'function' || typeof native.windows.get !== 'function') return false;
    const beforeActivate = await revalidateManagerTab(candidate.tabId, candidate.windowId);
    if (!beforeActivate) return null;
    try { await callApi(native.tabs, 'update', beforeActivate.tabId, {active: true}); }
    catch { return await revalidateManagerTab(beforeActivate.tabId, beforeActivate.windowId) ? false : null; }
    const beforeWindow = await revalidateManagerTab(beforeActivate.tabId, beforeActivate.windowId);
    if (!beforeWindow) return null;
    let window;
    try { window = await callApi(native.windows, 'get', beforeWindow.windowId); }
    catch { return await revalidateManagerTab(beforeWindow.tabId, beforeWindow.windowId) ? false : null; }
    if (!window || window.id !== beforeWindow.windowId) return null;
    const immediatelyBeforeFocus = await revalidateManagerTab(beforeWindow.tabId, beforeWindow.windowId);
    if (!immediatelyBeforeFocus) return null;
    const update = {focused: true};
    if (window.state === 'minimized') update.state = 'normal';
    try { await callApi(native.windows, 'update', immediatelyBeforeFocus.windowId, update); }
    catch { return await revalidateManagerTab(immediatelyBeforeFocus.tabId, immediatelyBeforeFocus.windowId) ? false : null; }
    const afterFocus = await revalidateManagerTab(beforeWindow.tabId, beforeWindow.windowId);
    if (!afterFocus) return null;
    await recordManagerUse(afterFocus).catch(() => {});
    return true;
  }

  async function tryManagerCandidates(candidates) {
    const ordered = await rankManagerCandidates(candidates);
    for (const candidate of ordered) {
      const current = await revalidateManagerTab(candidate.tabId, candidate.windowId, true);
      if (!current) {
        await removeManagerCandidate(candidate.tabId).catch(() => {});
        continue;
      }
      if (current.pending) {
        pendingManagerUses.set(current.tabId, {windowId: current.windowId, useWhenReady: false, focusWhenReady: true});
        await ensureManagerCandidate(current).catch(() => {});
        return {opened: true, reused: true};
      }
      const result = await focusManagerCandidate(current);
      if (result === true) return {opened: true, reused: true};
      if (result === false) fail('gateway-unavailable');
      await removeManagerCandidate(current.tabId).catch(() => {});
    }
    return null;
  }

  async function openManagerInternal() {
    if (!native.tabs || typeof native.tabs.create !== 'function') fail('gateway-unavailable');
    await managerEventQueue.catch(() => {});
    const candidates = await discoverManagerCandidates();
    await mergeManagerCandidates(candidates).catch(() => {});
    const reused = await tryManagerCandidates(candidates);
    if (reused) return reused;
    // Search immediately before creating to catch tabs opened while a stale candidate was being checked.
    const lastCandidates = await discoverManagerCandidates();
    await mergeManagerCandidates(lastCandidates).catch(() => {});
    const lastReuse = await tryManagerCandidates(lastCandidates);
    if (lastReuse) return lastReuse;
    let created;
    try { created = await callApi(native.tabs, 'create', {url: managerPageUrl(), active: true}); }
    catch { fail('gateway-unavailable'); }
    if (!created || !validTabId(created.id)) fail('gateway-unavailable');
    const opened = await revalidateManagerTab(created.id);
    if (opened) {
      const focused = await focusManagerCandidate(opened);
      if (focused === false) fail('gateway-unavailable');
      if (focused === null) fail('gateway-unavailable');
      return {opened: true, reused: false};
    }
    const pending = await revalidateManagerTab(created.id, null, true);
    if (pending && pending.pending && validTabId(pending.windowId)) {
      pendingManagerUses.set(created.id, {windowId: pending.windowId, useWhenReady: false, focusWhenReady: true});
      await ensureManagerCandidate(pending).catch(() => {});
      return {opened: true, reused: false};
    }
    fail('gateway-unavailable');
  }

  function openManagerShared() {
    if (!managerOpenPromise) {
      managerOpenPromise = openManagerInternal().finally(() => { managerOpenPromise = null; });
    }
    return managerOpenPromise;
  }

  async function handleTabActivated(activeInfo) {
    if (!isObject(activeInfo) || !validTabId(activeInfo.tabId) || !validTabId(activeInfo.windowId)) return;
    const candidate = await revalidateManagerTab(activeInfo.tabId, activeInfo.windowId, true);
    if (candidate) {
      if (candidate.pending) {
        rememberPendingManagerUse(candidate.tabId, candidate.windowId, true, false);
        await ensureManagerCandidate(candidate).catch(() => {});
      } else {
        pendingManagerUses.delete(candidate.tabId);
        await recordManagerUse(candidate).catch(() => {});
      }
      return;
    }
    const tab = await getPendingManagerTab(activeInfo.tabId);
    if (tab && tab.id === activeInfo.tabId && tab.windowId === activeInfo.windowId && tab.pendingUrl === managerPageUrl()) {
      rememberPendingManagerUse(activeInfo.tabId, activeInfo.windowId, true, false);
    } else pendingManagerUses.delete(activeInfo.tabId);
  }

  async function handleWindowFocused(windowId) {
    if (!validTabId(windowId)) return;
    let tabs;
    try { tabs = await callApi(native.tabs, 'query', {active: true, windowId}); }
    catch { return; }
    if (!Array.isArray(tabs)) return;
    for (const tab of tabs) {
      const candidate = managerCandidateFromTab(tab, windowId, true) && await revalidateManagerTab(tab.id, windowId, true);
      if (candidate) {
        if (candidate.pending) {
          rememberPendingManagerUse(candidate.tabId, windowId, true, false);
          await ensureManagerCandidate(candidate).catch(() => {});
        } else {
          pendingManagerUses.delete(candidate.tabId);
          await recordManagerUse(candidate).catch(() => {});
        }
        continue;
      }
      const pending = validTabId(tab?.id) ? await getPendingManagerTab(tab.id) : null;
      if (pending && pending.windowId === windowId && pending.pendingUrl === managerPageUrl()) rememberPendingManagerUse(pending.id, windowId, true, false);
    }
  }

  async function handleTabUpdated(tabId, changeInfo, tab) {
    if (!validTabId(tabId) || !isObject(changeInfo)) return;
    const pendingUse = pendingManagerUses.get(tabId);
    const candidate = await revalidateManagerTab(tabId, pendingUse?.windowId ?? null, true);
    if (candidate) {
      if (candidate.pending) {
        await ensureManagerCandidate(candidate).catch(() => {});
        return;
      }
      if (pendingUse?.focusWhenReady) {
        pendingManagerUses.delete(tabId);
        const focused = await focusManagerCandidate(candidate);
        if (focused === null) await removeManagerCandidate(tabId).catch(() => {});
      } else if (pendingUse?.useWhenReady) {
        pendingManagerUses.delete(tabId);
        await recordManagerUse(candidate).catch(() => {});
      } else await ensureManagerCandidate(candidate).catch(() => {});
      return;
    }
    const state = await enqueueManagerState(() => readManagerRecency()).catch(() => defaultManagerRecency());
    const managerPotential = pendingUse || state.candidates.some(candidate => candidate.tabId === tabId) ||
      tab?.url === managerPageUrl() || tab?.pendingUrl === managerPageUrl() || changeInfo.url === managerPageUrl();
    const pendingExternal = typeof tab?.pendingUrl === 'string' && tab.pendingUrl !== managerPageUrl();
    if (managerPotential && (pendingExternal || changeInfo.url || changeInfo.status === 'complete')) {
      pendingManagerUses.delete(tabId);
      await removeManagerCandidate(tabId).catch(() => {});
    }
  }

  async function handleTabRemoved(tabId) {
    pendingManagerUses.delete(tabId);
    await removeManagerCandidate(tabId).catch(() => {});
  }

  async function handleTabCreated(tab) {
    const candidate = managerCandidateFromTab(tab, null, true);
    if (candidate) {
      await ensureManagerCandidate(candidate).catch(() => {});
      if (candidate.pending && tab.active === true) rememberPendingManagerUse(candidate.tabId, candidate.windowId, true, false);
    }
  }

  async function handleTabAttached(tabId, attachInfo) {
    if (!validTabId(tabId) || !isObject(attachInfo) || !validTabId(attachInfo.newWindowId)) return;
    const candidate = await revalidateManagerTab(tabId, attachInfo.newWindowId, true);
    if (candidate) await ensureManagerCandidate(candidate).catch(() => {});
    else await removeManagerCandidate(tabId).catch(() => {});
  }

  class GatewayFault extends Error {
    constructor(kind, message, options = {}) {
      super(message || safeTitle(kind));
      this.kind = kind;
      this.status = Number.isInteger(options.status) && options.status >= 100 && options.status <= 599 ? options.status : null;
      this.requestId = options.requestId || null;
      this.operationId = options.operationId || null;
      this.effectsState = ['none', 'partial', 'unknown'].includes(options.effectsState) ? options.effectsState : null;
      this.title = safeTitle(kind);
    }
  }

  function safeTitle(kind) {
    const titles = {
      'invalid-request': 'Solicitud no válida',
      'unauthorized-sender': 'Remitente no autorizado',
      'endpoint-invalid': 'Dirección HTTPS no válida',
      'permission-denied': 'Permiso denegado',
      'permission-required': 'Permiso requerido',
      tls: 'Conexión TLS no disponible',
      network: 'No se pudo conectar',
      timeout: 'Tiempo de espera agotado',
      parse: 'Respuesta no legible',
      'invalid-response': 'Respuesta no válida',
      uncertain: 'Resultado incierto',
      'unsupported-resource-id': 'Identificador no compatible',
      'unsupported-operation': 'Operación retirada',
      conflict: 'Conflicto en la solicitud',
      http: 'Error del servidor',
      'gateway-unavailable': 'Gateway no disponible',
      'task-changed': 'La tarea urgente ha cambiado',
    };
    return titles[kind] || 'Solicitud no completada';
  }

  function safeMessage(kind) {
    const messages = {
      'invalid-request': 'La solicitud o sus parámetros no son válidos.',
      'unauthorized-sender': 'La solicitud procede de una página no autorizada.',
      'endpoint-invalid': 'Configura un endpoint HTTPS válido.',
      'permission-denied': 'No se concedió permiso para acceder al servidor.',
      'permission-required': 'Se necesita permiso para acceder al servidor.',
      tls: 'No se pudo establecer una conexión TLS segura.',
      network: 'No se pudo contactar con el servidor.',
      timeout: 'La solicitud excedió el tiempo de espera configurado.',
      parse: 'El servidor devolvió una respuesta que no se pudo leer.',
      'invalid-response': 'El servidor devolvió una respuesta no válida.',
      uncertain: 'No se pudo confirmar el resultado. Revisa el estado antes de volver a actuar.',
      'unsupported-resource-id': 'El identificador no se puede codificar como un único segmento de ruta de forma segura.',
      'unsupported-operation': 'Esta operación requiere una versión actualizada del gestor.',
      conflict: 'El servidor rechazó la solicitud por un conflicto.',
      http: 'El servidor respondió con un error HTTP.',
      'gateway-unavailable': 'No se pudo completar la solicitud del gateway.',
      'task-changed': 'La tarea urgente ha cambiado; actualiza la agenda antes de actuar.',
    };
    return messages[kind] || 'No se pudo completar la solicitud.';
  }

  function fail(kind, message, options = {}) {
    throw new GatewayFault(kind, message || safeMessage(kind), options);
  }

  const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  function exactKeys(value, allowed, required = []) {
    if (!isObject(value) || Object.keys(value).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(value, key))) {
      fail('invalid-request');
    }
  }
  function nonEmptyText(value, max = 20000) {
    if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) fail('invalid-request');
    return value;
  }
  function optionalText(value, max = 20000) {
    if (typeof value !== 'string' || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) fail('invalid-request');
    return value;
  }
  function domainText(value, max = 20000) {
    if (typeof value !== 'string' || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(value)) fail('invalid-request');
    return value;
  }
  function nonEmptyDomainText(value, max = 20000) {
    domainText(value, max);
    if (!value.trim()) fail('invalid-request');
    return value;
  }
  function isUuid(value) { return typeof value === 'string' && UUID.test(value); }
  function validateId(value) {
    nonEmptyText(value, 4096);
    if (value === '.' || value === '..') fail('unsupported-resource-id');
    return value;
  }
  function plainSerializable(value, depth = 0) {
    if (depth > 50) return false;
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
    if (typeof value === 'number') return Number.isFinite(value);
    if (Array.isArray(value)) return value.every(item => plainSerializable(item, depth + 1));
    if (!isObject(value)) return false;
    return Object.values(value).every(item => plainSerializable(item, depth + 1));
  }
  function safeRequestId(message) {
    return isObject(message) && isUuid(message.requestId) ? message.requestId : null;
  }

  function canonicalSettings(value, requireEnabled = false) {
    exactKeys(value, ['serverUrl', 'token', 'monitorEnabled', 'timeoutMs'], ['serverUrl', 'token', 'monitorEnabled']);
    if (typeof value.serverUrl !== 'string' || typeof value.token !== 'string' || typeof value.monitorEnabled !== 'boolean') fail('endpoint-invalid');
    const raw = value.serverUrl.trim();
    if (!raw || !/^https:\/\//i.test(raw) || /[\s\\\u0000-\u001f\u007f?#]/.test(raw)) fail('endpoint-invalid');
    let url;
    try { url = new URL(raw); } catch { fail('endpoint-invalid'); }
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.search || url.hash) fail('endpoint-invalid');
    const afterScheme = raw.slice(raw.indexOf('://') + 3);
    const pathStart = afterScheme.indexOf('/');
    const authority = pathStart < 0 ? afterScheme : afterScheme.slice(0, pathStart);
    if (authority.includes('@')) fail('endpoint-invalid');
    const rawPath = pathStart < 0 ? '/' : afterScheme.slice(pathStart);
    const segments = rawPath.split('/').filter(Boolean);
    try {
      for (const rawSegment of segments) {
        const decoded = decodeURIComponent(rawSegment);
        if (!decoded || decoded === '.' || decoded === '..' || /[\\/\u0000-\u001f\u007f]/.test(decoded)) fail('endpoint-invalid');
      }
    } catch (error) {
      if (error instanceof GatewayFault) throw error;
      fail('endpoint-invalid');
    }
    let path = url.pathname.replace(/\/+$/, '');
    if (/\/api\/v1(?:\/api\/v1)+$/i.test(path)) fail('endpoint-invalid');
    if (path.toLowerCase().endsWith('/api/v1')) path = path.slice(0, -'/api/v1'.length) + '/api/v1';
    else path += '/api/v1';
    const token = value.token;
    if (!token.trim() || token.length > 8192 || /[\r\n\u0000-\u001f\u007f]/.test(token)) fail('invalid-request');
    const timeoutMs = value.timeoutMs === undefined ? DEFAULT_TIMEOUT : value.timeoutMs;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000) fail('invalid-request');
    if (requireEnabled && value.monitorEnabled !== true) fail('invalid-request');
    return {serverUrl: url.origin + path, origin: url.origin, pathname: path, token, monitorEnabled: value.monitorEnabled, timeoutMs};
  }

  async function readStoredSettings(requireEnabled = true) {
    let values;
    try { values = await callApi(native.storage.local, 'get', SETTINGS_KEY); }
    catch { fail('gateway-unavailable'); }
    try {
      const result = canonicalSettings(normalizeStoredConfig(values[SETTINGS_KEY]), requireEnabled);
      if (!result.monitorEnabled) fail('endpoint-invalid');
      return result;
    } catch (error) {
      if (error instanceof GatewayFault) throw error;
      fail('endpoint-invalid');
    }
  }

  async function hasHostPermission(settings) {
    if (!native.permissions || typeof native.permissions.contains !== 'function') fail('permission-required');
    const origin = 'https://' + new URL(settings.serverUrl).hostname + '/*';
    let contains;
    try { contains = await callApi(native.permissions, 'contains', {origins: [origin]}); }
    catch { fail('permission-required'); }
    if (contains !== true) fail('permission-required');
  }

  function decodedSegments(pathname) {
    const raw = pathname.split('/').filter(Boolean);
    const result = [];
    for (const segment of raw) {
      let decoded;
      try { decoded = decodeURIComponent(segment); } catch { fail('invalid-response'); }
      if (decoded === '.' || decoded === '..' || decoded.includes('\\')) fail('unsupported-resource-id');
      result.push(decoded);
    }
    return result;
  }

  function hasDotSegment(rawPath) {
    const segments = rawPath.split('/');
    for (const segment of segments) {
      if (!segment) continue;
      try {
        const decoded = decodeURIComponent(segment);
        if (decoded === '.' || decoded === '..') return true;
      } catch { return true; }
    }
    return false;
  }

  function validateDestination(settings, href, allowQuery = false) {
    if (typeof href !== 'string' || !href || href.length > 8192 || /[\u0000-\u0020\u007f\\]/.test(href)) fail('invalid-response');
    const rawPath = href.replace(/^https:\/\/[^/?#]*/i, '').split(/[?#]/, 1)[0];
    if (hasDotSegment(rawPath)) fail('unsupported-resource-id');
    let url;
    try { url = new URL(href, settings.serverUrl + '/'); } catch { fail('invalid-response'); }
    if (url.protocol !== 'https:' || url.origin !== settings.origin || url.username || url.password || url.hash || (!allowQuery && url.search)) fail('invalid-response');
    const base = decodedSegments(settings.pathname);
    const destination = decodedSegments(url.pathname);
    if (destination.length < base.length || base.some((segment, index) => destination[index] !== segment)) fail('invalid-response');
    return url;
  }

  function checkHalLinks(value, settings, depth = 0) {
    if (depth > 50) fail('invalid-response');
    if (Array.isArray(value)) {
      value.forEach(item => checkHalLinks(item, settings, depth + 1));
      return;
    }
    if (!isObject(value)) return;
    for (const [key, item] of Object.entries(value)) {
      if (key === 'href') validateDestination(settings, item, true);
      else checkHalLinks(item, settings, depth + 1);
    }
  }

  function redact(value, token) {
    if (typeof value === 'string') {
      if (!token || token === '[redactado]') return value;
      return value.split(token).join('[redactado]');
    }
    if (Array.isArray(value)) return value.map(item => redact(item, token));
    if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [redact(key, token), redact(item, token)]));
    return value;
  }

  function safeRemoteText(value, token) {
    if (typeof value !== 'string') return '';
    let safe = redact(value, token).replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [redactado]');
    safe = safe.replace(/https?:\/\/[^\s<>"']+/gi, '[redactado]');
    safe = safe.replace(/(?:[A-Za-z]:\\[^\s<>"']+|\/(?:home|tmp|var|etc|Users|root)\/[^\s<>"']+)/g, '[redactado]');
    return safe.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 1000);
  }

  function classifyStatus(status, code) {
    if (['tls', 'permission-denied', 'permission-required', 'timeout', 'network', 'parse', 'invalid-response', 'unsupported-resource-id'].includes(code)) return code;
    if (status === 401) return 'http';
    if (status === 409) return 'conflict';
    return 'http';
  }

  function validProblem(problem, status) {
    return isObject(problem) &&
      typeof problem.type === 'string' && problem.type.length > 0 &&
      typeof problem.title === 'string' &&
      problem.status === status &&
      typeof problem.detail === 'string' &&
      typeof problem.instance === 'string' &&
      typeof problem.code === 'string' && /^[a-z0-9-]{1,80}$/.test(problem.code) &&
      isUuid(problem.requestId) &&
      (problem.effectsState === undefined || ['none', 'partial', 'unknown'].includes(problem.effectsState)) &&
      (problem.operationId === undefined || isUuid(problem.operationId));
  }

  function receiptMatchesTarget(actual, expected) {
    if (!isObject(actual) || !isObject(expected) || actual.kind !== expected.kind) return false;
    return expected.id === undefined ? actual.id === undefined : actual.id === expected.id;
  }

  function validOperationReceipt(receipt, options) {
    const affectedIds = receipt && receipt.result && receipt.result.affectedIds;
    const affectedIdsValid = Array.isArray(affectedIds) &&
      affectedIds.every(id => typeof id === 'string' && id.length > 0 && id.length <= 4096 && !/[\u0000-\u001f\u007f]/.test(id)) &&
      new Set(affectedIds).size === affectedIds.length;
    const targetAffected = options.expectedTarget.kind === 'task' || options.expectedTarget.kind === 'project'
      ? affectedIdsValid && affectedIds.includes(options.expectedTarget.id)
      : options.expectedOperationType === 'create-task'
        ? affectedIdsValid && affectedIds.length > 0
        : options.expectedOperationType === 'raise-event' && affectedIdsValid;
    return isObject(receipt) &&
      receipt.id === options.expectedOperationId &&
      receipt.status === 'succeeded' &&
      receipt.type === options.expectedOperationType &&
      receiptMatchesTarget(receipt.target, options.expectedTarget) &&
      isObject(receipt.result) &&
      receipt.result.type === options.expectedOperationType &&
      receiptMatchesTarget(receipt.result.target, options.expectedTarget) &&
      receipt.result.effectsState === 'complete' &&
      affectedIdsValid && targetAffected &&
      receipt.failure === null;
  }

  function collectTaskEventNames(value, eventNames) {
    if (Array.isArray(value)) {
      value.forEach(item => collectTaskEventNames(item, eventNames));
      return;
    }
    if (!isObject(value)) return;
    for (const key of ['raised', 'waited']) {
      const eventName = value[key];
      if (typeof eventName === 'string' && eventName.trim()) eventNames.add(eventName);
    }
  }

  function confirmedOperationChanges(receipt) {
    if (!isObject(receipt) || receipt.status !== 'succeeded' || receipt.failure !== null ||
        !isObject(receipt.result) || receipt.result.effectsState !== 'complete' ||
        !Array.isArray(receipt.result.affectedIds) ||
        receipt.result.affectedIds.some(id => typeof id !== 'string' || !id || id.length > 4096 || /[\u0000-\u001f\u007f]/.test(id))) return null;

    const taskIds = new Set();
    const projectNames = new Set();
    const eventNames = new Set();
    const collections = new Set();
    const affectedIds = receipt.result.affectedIds;

    switch (receipt.type) {
      case 'create-task':
      case 'edit-task':
      case 'complete-task':
      case 'schedule-task':
      case 'record-work':
      case 'snooze-task':
      case 'raise-event':
        affectedIds.forEach(id => taskIds.add(id));
        collections.add('tasks');
        collections.add('agenda');
        collections.add('statistics');
        collections.add('events');
        break;
      case 'open-project':
      case 'close-project':
      case 'hold-project':
      case 'edit-project-content':
        affectedIds.forEach(id => projectNames.add(id));
        collections.add('projects');
        break;
      default:
        return null;
    }

    if (receipt.type === 'raise-event') {
      if (typeof receipt.target?.id !== 'string' || !receipt.target.id.trim()) return null;
      eventNames.add(receipt.target.id);
      collections.add('events');
    }
    if (receipt.type === 'edit-task') {
      const changes = receipt.parameters?.changes;
      if (isObject(changes) && (Object.hasOwn(changes, 'raised') || Object.hasOwn(changes, 'waited'))) {
        collectTaskEventNames(changes, eventNames);
      }
    }
    if (receipt.type === 'complete-task' || receipt.type === 'schedule-task') {
      collectTaskEventNames(receipt.result.value, eventNames);
    }

    return {
      taskIds: [...taskIds],
      projectNames: [...projectNames],
      eventNames: [...eventNames],
      collections: [...collections],
    };
  }

  function confirmedPatchedTaskChanges(taskId, patch, task) {
    if (typeof taskId !== 'string' || !isObject(task) || task.id !== taskId) return null;
    const eventNames = new Set();
    if (isObject(patch) && (Object.hasOwn(patch, 'raised') || Object.hasOwn(patch, 'waited'))) {
      collectTaskEventNames(task, eventNames);
    }
    const collections = ['tasks', 'statistics', 'agenda', 'events'];
    return {taskIds: [taskId], projectNames: [], eventNames: [...eventNames], collections};
  }

  async function broadcastChanges(changes) {
    if (!changes || !native.runtime || typeof native.runtime.sendMessage !== 'function') return;
    const message = {protocolVersion: PROTOCOL_VERSION, event: 'changes.invalidated', changes};
    await callApi(native.runtime, 'sendMessage', message).catch(() => {});
  }

  async function fetchResource(settings, destination, options = {}) {
    if (options.configurationRevision !== undefined && options.configurationRevision !== configurationRevision) {
      fail('invalid-request', 'La configuración cambió antes de enviar la solicitud.', {
        operationId: options.operationId,
        effectsState: options.modifying ? 'none' : null,
      });
    }
    await hasHostPermission(settings);
    if (options.configurationRevision !== undefined && options.configurationRevision !== configurationRevision) {
      fail('invalid-request', 'La configuración cambió antes de enviar la solicitud.', {
        operationId: options.operationId,
        effectsState: options.modifying ? 'none' : null,
      });
    }
    const url = validateDestination(settings, destination, options.allowQuery === true);
    const headers = {Accept: 'application/hal+json, application/problem+json'};
    if (options.body !== undefined) headers['Content-Type'] = options.contentType || 'application/json';
    // Destination and permission checks complete before the credential is attached.
    headers.Authorization = 'Bearer ' + settings.token;
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, settings.timeoutMs);
    let response;
    let raw;
    try {
      response = await fetch(url.href, {
        method: options.method || 'GET',
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: controller.signal,
        redirect: 'error',
        cache: 'no-store',
        credentials: 'omit',
      });
      raw = await response.text();
    } catch (error) {
      const receivedStatus = response && Number.isInteger(response.status) ? response.status : null;
      if (timedOut || controller.signal.aborted) {
        fail(options.modifying ? 'uncertain' : 'timeout', undefined, {status: options.modifying ? receivedStatus : null, operationId: options.operationId, effectsState: options.modifying ? 'unknown' : null});
      }
      const name = error && typeof error === 'object' ? error.name : '';
      if (name === 'TypeError') fail(options.modifying ? 'uncertain' : 'network', undefined, {status: options.modifying ? receivedStatus : null, operationId: options.operationId, effectsState: options.modifying ? 'unknown' : null});
      fail(options.modifying ? 'uncertain' : 'network', undefined, {status: options.modifying ? receivedStatus : null, operationId: options.operationId, effectsState: options.modifying ? 'unknown' : null});
    } finally {
      clearTimeout(timer);
    }
    let parsed;
    try { parsed = raw ? JSON.parse(raw) : null; }
    catch {
      fail(options.modifying ? 'uncertain' : 'parse', undefined, {status: response.status, operationId: options.operationId, effectsState: options.modifying ? 'unknown' : null});
    }
    if (!response.ok) {
      const problem = isObject(parsed) ? parsed : {};
      const problemIsValid = validProblem(problem, response.status);
      if (options.modifying && !problemIsValid) {
        fail('uncertain', undefined, {status: response.status, operationId: options.operationId, effectsState: 'unknown'});
      }
      const code = typeof problem.code === 'string' && /^[a-z0-9-]{1,80}$/.test(problem.code) ? problem.code : 'http';
      const missing5xxEffectsState = options.modifying && response.status >= 500 && problem.effectsState === undefined;
      const uncertainEffects = options.modifying && ['partial', 'unknown'].includes(problem.effectsState);
      const kind = missing5xxEffectsState || uncertainEffects ? 'uncertain' : classifyStatus(response.status, code);
      const detail = safeRemoteText(problem.detail, settings.token) || safeRemoteText(problem.title, settings.token) || safeMessage(kind);
      fail(kind, detail, {
        status: response.status,
        operationId: isUuid(problem.operationId) ? problem.operationId : options.operationId,
        effectsState: options.modifying && kind === 'uncertain' ? (problem.effectsState || 'unknown') : problem.effectsState,
      });
    }
    if (!isObject(parsed) || !plainSerializable(parsed)) fail(options.modifying ? 'uncertain' : 'invalid-response', undefined, {status: response.status, operationId: options.operationId, effectsState: options.modifying ? 'unknown' : null});
    if (options.expectedOperationId && !validOperationReceipt(parsed, options)) {
      fail('uncertain', undefined, {status: response.status, operationId: options.expectedOperationId, effectsState: 'unknown'});
    }
    try { checkHalLinks(parsed, settings); }
    catch (error) {
      if (options.modifying) fail('uncertain', undefined, {status: response.status, operationId: options.operationId, effectsState: 'unknown'});
      throw error;
    }
    return {status: response.status, data: parsed};
  }

  function pathSegment(value) {
    validateId(value);
    return encodeURIComponent(value);
  }

  function baseUrl(settings) { return settings.origin + settings.pathname; }
  function apiUrl(settings, route, query = null) {
    let href = baseUrl(settings);
    if (route) href += '/' + route;
    if (query && query.size) href += '?' + query.toString();
    validateDestination(settings, href, query && query.size > 0);
    return href;
  }
  function appendQuery(query, key, value) {
    if (Array.isArray(value)) value.forEach(item => query.append(key, item));
    else if (value !== undefined) query.set(key, String(value));
  }

  function validateTaskView(params, allowPage = true) {
    const allowed = ['page', 'pageSize', 'filters', 'heuristic', 'algorithm', 'search'];
    exactKeys(params, allowed);
    const query = new URLSearchParams();
    if (allowPage && params.page !== undefined) {
      if (!Number.isSafeInteger(params.page) || params.page < 1 || params.page > 100000) fail('invalid-request');
      appendQuery(query, 'page', params.page);
    }
    if (params.pageSize !== undefined) {
      if (!Number.isSafeInteger(params.pageSize) || params.pageSize < 1 || params.pageSize > 1000) fail('invalid-request');
      appendQuery(query, 'pageSize', params.pageSize);
    }
    if (params.filters !== undefined) {
      if (!Array.isArray(params.filters) || params.filters.length > 100) fail('invalid-request');
      params.filters.forEach(item => nonEmptyText(item, 200));
      appendQuery(query, 'filters', params.filters);
    }
    for (const key of ['heuristic', 'algorithm']) if (params[key] !== undefined) appendQuery(query, key, nonEmptyText(params[key], 200));
    if (params.search !== undefined) {
      if (!Array.isArray(params.search) || params.search.length > 100) fail('invalid-request');
      params.search.forEach(item => optionalText(item, 2000));
      appendQuery(query, 'search', params.search);
    }
    return query;
  }

  function validatePatch(patch) {
    exactKeys(patch, Array.from(PATCH_FIELDS));
    for (const [key, value] of Object.entries(patch)) {
      if (value === null && !['raised', 'waited'].includes(key)) fail('invalid-request');
      if (key === 'description' && value !== null) nonEmptyDomainText(value, 20000);
      if (['context', 'start', 'due', 'raised', 'waited'].includes(key) && value !== null) optionalText(value, 20000);
      if (key === 'severity' && (typeof value !== 'number' || !Number.isFinite(value))) fail('invalid-request');
      if (key === 'calm' && typeof value !== 'boolean') fail('invalid-request');
      if (key === 'totalCost') validatePomodoro(value);
    }
    return patch;
  }

  function validatePomodoro(value) {
    exactKeys(value, ['value', 'unit'], ['value', 'unit']);
    if (value.unit !== 'pomodoro' || typeof value.value !== 'string' || value.value.length > 64 || !/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(value.value)) fail('invalid-request');
  }

  function validateOperationTarget(value, type) {
    if (!isObject(value)) fail('invalid-request');
    const targetIdRequired = ['task', 'event', 'project'].includes(value.kind);
    if (value.kind === 'tasks') {
      exactKeys(value, ['kind'], ['kind']);
    } else if (targetIdRequired) {
      exactKeys(value, ['kind', 'id'], ['kind', 'id']);
      validateId(value.id);
    } else fail('invalid-request');
    const expectedKind = type === 'create-task' ? 'tasks' :
      ['edit-task', 'complete-task', 'schedule-task', 'record-work', 'snooze-task'].includes(type) ? 'task' :
      type === 'raise-event' ? 'event' :
      ['open-project', 'close-project', 'hold-project', 'edit-project-content'].includes(type) ? 'project' : null;
    if (value.kind !== expectedKind) fail('invalid-request');
    return value;
  }

  function validateOperationParameters(type, params) {
    if (!isObject(params)) fail('invalid-request');
    const specs = {
      'create-task': ['description', 'context', 'totalCost'],
      'edit-task': ['changes', 'effortDelta'],
      'complete-task': [],
      'schedule-task': ['effortPerDay'],
      'record-work': ['duration'],
      'snooze-task': ['duration'],
      'raise-event': [],
      'open-project': ['description'],
      'close-project': [],
      'hold-project': [],
      'edit-project-content': ['action', 'line', 'position', 'content', 'description'],
    };
    if (!OPERATION_TYPES.has(type)) fail('invalid-request');
    exactKeys(params, specs[type]);
    switch (type) {
      case 'create-task':
        nonEmptyDomainText(params.description);
        if (params.context !== undefined) optionalText(params.context);
        if (params.totalCost !== undefined) validatePomodoro(params.totalCost);
        if ((params.context === undefined) !== (params.totalCost === undefined)) fail('invalid-request');
        break;
      case 'edit-task':
        if (params.changes !== undefined) validatePatch(params.changes);
        if (params.effortDelta !== undefined && typeof params.effortDelta !== 'string') validatePomodoro(params.effortDelta);
        if (params.effortDelta !== undefined && typeof params.effortDelta === 'string') optionalText(params.effortDelta);
        if (params.changes === undefined && params.effortDelta === undefined) fail('invalid-request');
        break;
      case 'schedule-task': if (params.effortPerDay !== undefined) optionalText(params.effortPerDay); break;
      case 'record-work':
        if (params.duration === undefined) fail('invalid-request');
        optionalText(params.duration);
        break;
      case 'snooze-task': if (params.duration !== undefined) optionalText(params.duration); break;
      case 'open-project': if (params.description !== undefined) domainText(params.description); break;
      case 'edit-project-content':
        if (Object.hasOwn(params, 'description')) {
          exactKeys(params, ['description'], ['description']);
          domainText(params.description);
          break;
        }
        if (!['replace', 'insert', 'delete'].includes(params.action) ||
            Object.hasOwn(params, 'line') === Object.hasOwn(params, 'position')) fail('invalid-request');
        const line = Object.hasOwn(params, 'line') ? params.line : params.position;
        if (!Number.isSafeInteger(line) || line < 1) fail('invalid-request');
        if (params.action === 'delete') {
          exactKeys(params, ['action', 'line', 'position'], ['action']);
        } else {
          exactKeys(params, ['action', 'line', 'position', 'content'], ['action', 'content']);
          domainText(params.content);
        }
        break;
      default: break;
    }
    return params;
  }

  function pageForSender(sender) {
    if (!sender || sender.id !== native.runtime.id || typeof sender.url !== 'string') return null;
    for (const page of ['options.html', 'popup.html', 'index.html']) {
      if (sender.url === native.runtime.getURL(page)) return page;
    }
    return null;
  }

  function requireTarget(target, kind) {
    if (!isObject(target)) fail('invalid-request');
    exactKeys(target, ['kind', 'id'], ['kind', 'id']);
    if (target.kind !== kind) fail('invalid-request');
    validateId(target.id);
    return target;
  }

  function validateRpc(message, sender) {
    const page = pageForSender(sender);
    if (!page) fail('unauthorized-sender');
    exactKeys(message, ['protocolVersion', 'requestId', 'operation', 'target', 'parameters'], ['protocolVersion', 'requestId', 'operation', 'target', 'parameters']);
    if (message.protocolVersion !== PROTOCOL_VERSION || !isUuid(message.requestId) || typeof message.operation !== 'string' || !knownQueries.has(message.operation)) fail('invalid-request');
    if (message.target !== null && !isObject(message.target)) fail('invalid-request');
    if (!isObject(message.parameters)) fail('invalid-request');
    const op = message.operation;
    if (op.startsWith('settings.') || op === 'history.clear') {
      if (page !== 'options.html') fail('unauthorized-sender');
    } else if (op === 'notifications.clear-local') {
      if (!['options.html', 'popup.html', 'index.html'].includes(page)) fail('unauthorized-sender');
    } else if (op === 'manager.open') {
      if (!['options.html', 'popup.html', 'index.html'].includes(page)) fail('unauthorized-sender');
    } else if (page === 'options.html') fail('unauthorized-sender');
    if (page === 'popup.html' && !['root.read', 'agenda.read', 'operations.submit', 'notifications.clear-local', 'manager.open'].includes(op)) fail('unauthorized-sender');
    return page;
  }

  function makeReply(requestId, ok, status, data, error = null) {
    const response = {requestId, ok, status, data: data === undefined ? null : data, error};
    if (!plainSerializable(response)) return {requestId, ok: false, status: null, data: null, error: {kind: 'invalid-response', title: safeTitle('invalid-response'), message: safeMessage('invalid-response')}};
    return response;
  }

  function errorReply(requestId, error) {
    const fault = error instanceof GatewayFault ? error : new GatewayFault('gateway-unavailable');
    const payload = {kind: fault.kind, title: fault.title, message: fault.message || safeMessage(fault.kind)};
    if (fault.operationId) payload.operationId = fault.operationId;
    if (fault.effectsState) payload.effectsState = fault.effectsState;
    return makeReply(requestId, false, fault.status, null, payload);
  }

  async function executeSettings(message, revision) {
    const op = message.operation;
    const params = message.parameters;
    if (message.target !== null) fail('invalid-request');
    if (op === 'settings.disconnect') {
      exactKeys(params, []);
      const current = await disarmStoredSettings();
      await clearUrgency();
      if (revision === configurationRevision) await clearStoredError(revision).catch(() => {});
      return {status: null, data: publicSettings(current)};
    }
    if (op === 'settings.clear') {
      exactKeys(params, []);
      const empty = defaultSettings();
      await callApi(native.storage.local, 'set', {[SETTINGS_KEY]: empty});
      await clearUrgency();
      if (revision === configurationRevision) await clearStoredError(revision).catch(() => {});
      return {status: null, data: publicSettings(empty)};
    }
    if (op === 'history.clear') {
      exactKeys(params, []);
      fail('unsupported-operation');
    }
    const candidate = canonicalSettings(params, op === 'settings.connect');
    if (op === 'settings.save') {
      if (candidate.monitorEnabled) fail('invalid-request');
      await disarmExisting();
      if (revision !== configurationRevision) fail('invalid-request');
      const saved = {...storedOnly(candidate), monitorEnabled: false};
      await callApi(native.storage.local, 'set', {[SETTINGS_KEY]: saved});
      await clearUrgency();
      if (revision === configurationRevision) await clearStoredError(revision).catch(() => {});
      return {status: null, data: publicSettings(saved)};
    }
    if (op !== 'settings.connect') fail('invalid-request');
    if (!candidate.monitorEnabled) fail('invalid-request');
    await disarmExisting();
    await hasHostPermission(candidate);
    const probed = await fetchResource(candidate, baseUrl(candidate), {configurationRevision: revision});
    if (!isObject(probed.data) || !isObject(probed.data._links) || !isObject(probed.data._links.self)) fail('invalid-response', undefined, {status: probed.status});
    const self = validateDestination(candidate, probed.data._links.self.href, false);
    if (self.href.replace(/\/$/, '') !== baseUrl(candidate)) fail('invalid-response', undefined, {status: probed.status});
    if (revision !== configurationRevision) fail('invalid-request');
    const saved = {...storedOnly(candidate), monitorEnabled: true};
    await callApi(native.storage.local, 'set', {[SETTINGS_KEY]: saved});
    if (revision === configurationRevision) await clearStoredError(revision).catch(() => {});
    await reconcileUrgencyAlarm(true).catch(() => {});
    if (revision === configurationRevision) {
      currentUrgent = false;
      await setBadge('').catch(() => {});
    }
    return {status: probed.status, data: publicSettings(saved)};
  }

  function storedOnly(settings) {
    return {schemaVersion: 1, serverUrl: settings.serverUrl, token: settings.token, monitorEnabled: settings.monitorEnabled, timeoutMs: settings.timeoutMs};
  }
  function defaultSettings() { return {schemaVersion: 1, serverUrl: '', token: '', monitorEnabled: false, timeoutMs: DEFAULT_TIMEOUT}; }
  function publicSettings(settings) { return {schemaVersion: 1, serverUrl: settings.serverUrl || '', monitorEnabled: settings.monitorEnabled === true, timeoutMs: settings.timeoutMs || DEFAULT_TIMEOUT, hasToken: Boolean(settings.token)}; }
  async function storedSettingsOrDefaults() {
    const values = await callApi(native.storage.local, 'get', SETTINGS_KEY);
    const raw = values[SETTINGS_KEY];
    try { return {...storedOnly(canonicalSettings(normalizeStoredConfig(raw))), monitorEnabled: raw.monitorEnabled === true}; }
    catch { return defaultSettings(); }
  }
  async function disarmStoredSettings() {
    const values = await callApi(native.storage.local, 'get', SETTINGS_KEY);
    const raw = values[SETTINGS_KEY];
    const current = isObject(raw) ? {...raw, monitorEnabled: false} : defaultSettings();
    await callApi(native.storage.local, 'set', {[SETTINGS_KEY]: current});
    return current;
  }
  function normalizeStoredConfig(raw) {
    if (!isObject(raw)) fail('endpoint-invalid');
    return {serverUrl: raw.serverUrl, token: raw.token, monitorEnabled: raw.monitorEnabled, timeoutMs: raw.timeoutMs};
  }
  async function disarmExisting() {
    const values = await callApi(native.storage.local, 'get', SETTINGS_KEY);
    const raw = values[SETTINGS_KEY];
    if (isObject(raw) && raw.monitorEnabled === true) {
      const safe = {...raw, monitorEnabled: false};
      await callApi(native.storage.local, 'set', {[SETTINGS_KEY]: safe});
    }
    await clearUrgency();
  }

  async function executeGateway(message, page, revision) {
    const op = message.operation;
    const params = message.parameters;
    try {
      if (op === 'manager.open') {
        if (message.target !== null) fail('invalid-request');
        exactKeys(params, []);
        const data = await openManagerShared();
        return {status: null, data};
      }
      if (op === 'notifications.clear-local') {
        if (message.target !== null) fail('invalid-request');
        exactKeys(params, []);
        const state = await clearLocalReception();
        return {status: null, data: {cleared: true, bufferGeneration: state.bufferGeneration}};
      }
      if (op === 'settings.save' || op === 'settings.connect' || op === 'settings.disconnect' || op === 'settings.clear' || op === 'history.clear') {
        const result = await executeSettings(message, revision);
        return {status: result.status, data: result.data};
      }
      if (op === 'root.read') exactKeys(params, []);
      const settings = await readStoredSettings(true);
      const route = routeFor(settings, op, message.target, params, message.requestId, page);
      const result = await fetchResource(settings, route.url, {...route.options, configurationRevision: revision});
      if (op === 'operations.submit') {
        if (revision === configurationRevision) await broadcastChanges(confirmedOperationChanges(result.data));
      } else if (op === 'tasks.patch') {
        const taskId = message.target && message.target.id;
        const changes = confirmedPatchedTaskChanges(taskId, params, result.data);
        if (!changes) fail('uncertain', undefined, {status: result.status, effectsState: 'unknown'});
        if (revision === configurationRevision) await broadcastChanges(changes);
      }
      if (revision === configurationRevision) {
        if (op === 'agenda.read') await updateUrgencyFromAgenda(result.data, settings, revision);
        if (revision === configurationRevision) await clearStoredError(revision).catch(() => {});
      }
      return {status: result.status, data: result.data};
    } catch (error) {
      if (error instanceof GatewayFault && error.configurationRevision === undefined) error.configurationRevision = revision;
      throw error;
    }
  }

  function routeFor(settings, op, target, params, requestId, page) {
    let query;
    if (op === 'root.read') {
      exactKeys(params, []);
      if (target !== null) fail('invalid-request');
      return {url: baseUrl(settings), options: {}};
    }
    if (op === 'tasks.list') {
      if (target !== null) fail('invalid-request');
      query = validateTaskView(params);
      return {url: apiUrl(settings, 'tasks', query), options: {allowQuery: query.size > 0}};
    }
    if (op === 'tasks.get') {
      exactKeys(params, []);
      const resource = requireTarget(target, 'task');
      return {url: apiUrl(settings, 'tasks/' + pathSegment(resource.id)), options: {}};
    }
    if (op === 'tasks.patch') {
      const resource = requireTarget(target, 'task');
      validatePatch(params);
      return {url: apiUrl(settings, 'tasks/' + pathSegment(resource.id)), options: {method: 'PATCH', body: params, contentType: 'application/merge-patch+json', modifying: true}};
    }
    if (op === 'agenda.read') {
      exactKeys(params, ['day', 'heuristic']);
      if (target !== null) fail('invalid-request');
      query = new URLSearchParams();
      if (params.day !== undefined) {
        if (typeof params.day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(params.day)) fail('invalid-request');
        query.set('day', params.day);
      }
      if (params.heuristic !== undefined) query.set('heuristic', nonEmptyText(params.heuristic, 200));
      return {url: apiUrl(settings, 'agenda', query), options: {allowQuery: query.size > 0}};
    }
    if (op === 'statistics.read') {
      if (target !== null) fail('invalid-request');
      query = validateTaskView(params);
      return {url: apiUrl(settings, 'statistics', query), options: {allowQuery: query.size > 0}};
    }
    if (op === 'events.list' || op === 'strategies.list' || op === 'notifications.read') {
      exactKeys(params, []);
      if (target !== null) fail('invalid-request');
      const path = op === 'events.list' ? 'events' : op === 'strategies.list' ? 'strategies' : 'notifications';
      return {url: apiUrl(settings, path), options: {}};
    }
    if (op === 'projects.list') {
      exactKeys(params, ['status']);
      if (target !== null) fail('invalid-request');
      query = new URLSearchParams();
      if (params.status !== undefined) query.set('status', nonEmptyText(params.status, 100));
      return {url: apiUrl(settings, 'projects', query), options: {allowQuery: query.size > 0}};
    }
    if (op === 'projects.get') {
      exactKeys(params, []);
      const resource = requireTarget(target, 'project');
      return {url: apiUrl(settings, 'projects/' + pathSegment(resource.id)), options: {}};
    }
    if (op === 'operations.get') {
      exactKeys(params, []);
      const resource = requireTarget(target, 'operation');
      if (!isUuid(resource.id)) fail('invalid-request');
      return {url: apiUrl(settings, 'operations/' + pathSegment(resource.id)), options: {}};
    }
    if (op === 'operations.submit') {
      exactKeys(params, ['id', 'type', 'parameters'], ['id', 'type', 'parameters']);
      if (!isUuid(params.id) || params.id === requestId || typeof params.type !== 'string') fail('invalid-request');
      const operationTarget = validateOperationTarget(target, params.type);
      const operationParameters = validateOperationParameters(params.type, params.parameters);
      if (page === 'popup.html' && !['complete-task', 'snooze-task'].includes(params.type)) fail('unauthorized-sender');
      return {
        url: apiUrl(settings, 'operations'),
        options: {
          method: 'POST', body: {id: params.id, type: params.type, target: operationTarget, parameters: operationParameters},
          contentType: 'application/json', modifying: true, operationId: params.id,
          expectedOperationId: params.id, expectedOperationType: params.type, expectedTarget: operationTarget,
        },
      };
    }
    fail('unsupported-operation');
  }

  async function processMessage(message, sender) {
    const page = validateRpc(message, sender);
    if (message.operation === 'manager.open') {
      return executeGateway(message, page, configurationRevision);
    }
    if (message.operation === 'notifications.clear-local') {
      return executeGateway(message, page, configurationRevision);
    }
    if (message.operation.startsWith('settings.') || message.operation === 'history.clear') {
      const revision = ++configurationRevision;
      return enqueue(() => executeGateway(message, page, revision));
    }
    return executeGateway(message, page, configurationRevision);
  }

  async function handleMessage(message, sender) {
    const requestId = safeRequestId(message);
    let operationId = null;
    try {
      if (isObject(message) && message.operation === 'operations.submit' && isObject(message.parameters) && isUuid(message.parameters.id)) operationId = message.parameters.id;
      const result = await processMessage(message, sender);
      return makeReply(requestId, true, result.status, result.data);
    } catch (error) {
      const fault = error instanceof GatewayFault ? error : new GatewayFault('gateway-unavailable');
      if (!fault.operationId && operationId && fault.kind === 'uncertain') fault.operationId = operationId;
      if (fault.kind === 'permission-required' && fault.configurationRevision === configurationRevision) await disarmExisting().catch(() => {});
      if (requestId && message?.operation !== 'manager.open' && fault.configurationRevision === configurationRevision && !['invalid-request', 'unauthorized-sender', 'unsupported-operation'].includes(fault.kind)) {
        await recordGatewayError(fault, requestId, fault.configurationRevision).catch(() => {});
      }
      throw fault;
    }
  }

  async function dispatchMessage(message, sender, sendResponse) {
    const requestId = safeRequestId(message);
    try {
      sendResponse(await handleMessage(message, sender));
    } catch (error) {
      sendResponse(errorReply(requestId, error));
    }
  }

  native.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // Invalidation broadcasts are notifications, never RPC requests or replies.
    if (isObject(message) && message.protocolVersion === PROTOCOL_VERSION && message.event === 'changes.invalidated') return false;
    void dispatchMessage(message, sender, sendResponse);
    return true;
  });

  if (native.tabs) {
    native.tabs.onActivated?.addListener(activeInfo => { void enqueueManagerEvent(() => handleTabActivated(activeInfo)).catch(() => {}); });
    native.tabs.onUpdated?.addListener((tabId, changeInfo, tab) => { void enqueueManagerEvent(() => handleTabUpdated(tabId, changeInfo, tab)).catch(() => {}); });
    native.tabs.onCreated?.addListener(tab => { void enqueueManagerEvent(() => handleTabCreated(tab)).catch(() => {}); });
    native.tabs.onRemoved?.addListener(tabId => { void enqueueManagerEvent(() => handleTabRemoved(tabId)).catch(() => {}); });
    native.tabs.onAttached?.addListener((tabId, attachInfo) => { void enqueueManagerEvent(() => handleTabAttached(tabId, attachInfo)).catch(() => {}); });
  }
  native.windows?.onFocusChanged?.addListener(windowId => { void enqueueManagerEvent(() => handleWindowFocused(windowId)).catch(() => {}); });

  async function recordGatewayError(error, requestId, revision = configurationRevision) {
    if (revision !== configurationRevision) return;
    const badgeVersion = beginBadgeMutation();
    try {
      const settings = await storedSettingsOrDefaults();
      if (revision !== configurationRevision || badgeVersion !== badgeStateVersion) return;
      const safe = safeRemoteText(error.message, settings.token) || safeMessage(error.kind);
      const errorState = {
        kind: error.kind,
        title: safeTitle(error.kind),
        message: safe,
        requestId,
        updatedAt: new Date().toISOString(),
      };
      if (error.operationId) errorState.operationId = error.operationId;
      if (revision !== configurationRevision || badgeVersion !== badgeStateVersion) return;
      await callApi(native.storage.local, 'set', {[ERROR_KEY]: errorState});
      if (revision !== configurationRevision || badgeVersion !== badgeStateVersion) return;
      await setBadge('!', 'ElrikPiro: ' + safeTitle(error.kind) + '. ' + safe, badgeVersion);
    } finally { endBadgeMutation(badgeVersion); }
  }

  async function clearStoredError(revision = configurationRevision) {
    if (revision !== configurationRevision) return;
    const badgeVersion = beginBadgeMutation();
    try {
      let values = {};
      try { values = await callApi(native.storage.local, 'get', ERROR_KEY); } catch { return; }
      if (revision !== configurationRevision || badgeVersion !== badgeStateVersion) return;
      if (values[ERROR_KEY] != null) await callApi(native.storage.local, 'set', {[ERROR_KEY]: null}).catch(() => {});
      if (revision !== configurationRevision || badgeVersion !== badgeStateVersion) return;
      await setBadge(currentUrgent ? '●' : '', null, badgeVersion).catch(() => {});
    } finally { endBadgeMutation(badgeVersion); }
  }

  function beginBadgeMutation() {
    badgeStateVersion += 1;
    badgeMutationCount += 1;
    return badgeStateVersion;
  }

  function endBadgeMutation(version) {
    badgeMutationCount = Math.max(0, badgeMutationCount - 1);
    if (version === badgeStateVersion) badgeStateVersion += 1;
  }

  function badgeSnapshotCurrent(version) {
    return version === badgeStateVersion && badgeMutationCount === 0;
  }

  function setBadge(text, title = null, badgeVersion = badgeStateVersion) {
    const result = badgeWriteQueue.then(() => {
      if (badgeVersion !== badgeStateVersion) return;
      return writeBadge(text, title, badgeVersion);
    });
    badgeWriteQueue = result.catch(() => {});
    return result;
  }

  async function writeBadge(text, title, badgeVersion) {
    const action = native.action || native.browserAction;
    if (!action) return;
    if (badgeVersion !== badgeStateVersion) return;
    if (typeof action.setBadgeText === 'function') await callApi(action, 'setBadgeText', {text}).catch(() => {});
    if (badgeVersion !== badgeStateVersion) return;
    if (text === '●' || text === '!') {
      if (typeof action.setBadgeTextColor === 'function') {
        try {
          if (text === '●') {
            await callApi(action, 'setBadgeTextColor', {color: '#c62828'});
            if (badgeVersion !== badgeStateVersion) return;
            await callApi(action, 'setBadgeBackgroundColor', {color: [0, 0, 0, 0]});
          } else {
            await callApi(action, 'setBadgeTextColor', {color: '#ffffff'});
            if (badgeVersion !== badgeStateVersion) return;
            await callApi(action, 'setBadgeBackgroundColor', {color: '#c62828'});
          }
        } catch {
          if (badgeVersion !== badgeStateVersion) return;
          await callApi(action, 'setBadgeBackgroundColor', {color: '#c62828'}).catch(() => {});
        }
      } else if (typeof action.setBadgeBackgroundColor === 'function') {
        await callApi(action, 'setBadgeBackgroundColor', {color: '#c62828'});
      }
    } else if (text === '!' && typeof action.setBadgeBackgroundColor === 'function') {
      await callApi(action, 'setBadgeBackgroundColor', {color: '#c62828'});
    }
    if (badgeVersion !== badgeStateVersion) return;
    if (typeof action.setTitle === 'function') await callApi(action, 'setTitle', {title: title || (text === '!' ? 'ElrikPiro: error de conexión.' : text === '●' ? 'ElrikPiro: hay tareas urgentes.' : 'ElrikPiro')});
  }

  async function updateUrgencyFromAgenda(data, settings, revision) {
    const tasks = data && data._embedded && data._embedded.activeUrgentTasks;
    if (!Array.isArray(tasks) || tasks.some(task => !isObject(task) || typeof task.id !== 'string' || typeof task.context !== 'string' || typeof task.description !== 'string')) {
      fail('invalid-response');
    }
    if (revision !== configurationRevision) return;
    const badgeVersion = beginBadgeMutation();
    try {
      const urgent = tasks.length > 0;
      await callApi(native.storage.local, 'set', {[URGENCY_KEY]: {active: urgent, endpoint: settings.serverUrl, updatedAt: new Date().toISOString()}}).catch(() => {});
      if (revision !== configurationRevision || badgeVersion !== badgeStateVersion) return;
      currentUrgent = urgent;
      await setBadge(currentUrgent ? '●' : '', null, badgeVersion).catch(() => {});
    } finally { endBadgeMutation(badgeVersion); }
  }

  async function clearUrgency() {
    const badgeVersion = beginBadgeMutation();
    alarmReconciliationCount += 1;
    try {
      currentUrgent = false;
      await callApi(native.alarms, 'clear', URGENCY_ALARM).catch(() => {});
      if (badgeVersion !== badgeStateVersion) return;
      await callApi(native.storage.local, 'set', {[URGENCY_KEY]: {active: false, updatedAt: new Date().toISOString()}}).catch(() => {});
      if (badgeVersion !== badgeStateVersion) return;
      await setBadge('', null, badgeVersion);
    } finally {
      endBadgeMutation(badgeVersion);
      alarmReconciliationCount -= 1;
    }
  }

  async function restoreUrgency() {
    const revision = configurationRevision;
    const badgeVersion = badgeStateVersion;
    if (badgeMutationCount !== 0) return;
    try {
      const stored = await callApi(native.storage.local, 'get', [URGENCY_KEY, ERROR_KEY, SETTINGS_KEY]);
      if (revision !== configurationRevision || !badgeSnapshotCurrent(badgeVersion)) return;
      const settings = await storedSettingsOrDefaults();
      if (revision !== configurationRevision || !badgeSnapshotCurrent(badgeVersion)) return;
      currentUrgent = settings.monitorEnabled === true && stored[URGENCY_KEY]?.endpoint === settings.serverUrl && stored[URGENCY_KEY]?.active === true;
      const errorState = stored[ERROR_KEY];
      if (isObject(errorState)) {
        const kind = typeof errorState.kind === 'string' && /^[a-z0-9-]{1,80}$/.test(errorState.kind) ? errorState.kind : 'gateway-unavailable';
        const rawSettings = stored[SETTINGS_KEY];
        const token = settings.token || (isObject(rawSettings) && typeof rawSettings.token === 'string' ? rawSettings.token : '');
        const message = safeRemoteText(errorState.message, token) || safeMessage(kind);
        if (revision !== configurationRevision || !badgeSnapshotCurrent(badgeVersion)) return;
        await setBadge('!', 'ElrikPiro: ' + safeTitle(kind) + '. ' + message, badgeVersion);
      } else {
        if (revision !== configurationRevision || !badgeSnapshotCurrent(badgeVersion)) return;
        await setBadge(currentUrgent ? '●' : '', null, badgeVersion);
      }
    } catch {
      if (revision === configurationRevision && badgeSnapshotCurrent(badgeVersion)) await setBadge('', null, badgeVersion);
    }
  }

  async function reconcileUrgencyAlarm(enabled) {
    alarmReconciliationCount += 1;
    try {
      if (!enabled) {
        await callApi(native.alarms, 'clear', URGENCY_ALARM).catch(() => {});
        return;
      }
      const existing = await callApi(native.alarms, 'get', URGENCY_ALARM).catch(() => null);
      if (!existing || existing.periodInMinutes !== 5) await callApi(native.alarms, 'create', URGENCY_ALARM, {delayInMinutes: 5, periodInMinutes: 5}).catch(() => {});
    } finally { alarmReconciliationCount -= 1; }
  }

  async function disarmLegacyConfiguration() {
    try {
      const values = await callApi(native.storage.local, 'get', SETTINGS_KEY);
      const raw = values[SETTINGS_KEY];
      if (isObject(raw) && raw.monitorEnabled === true) {
        try {
          canonicalSettings(normalizeStoredConfig(raw), true);
        } catch {
          await callApi(native.storage.local, 'set', {[SETTINGS_KEY]: {...raw, monitorEnabled: false}});
          await clearUrgency();
        }
      }
    } catch { /* Startup stays offline when extension storage cannot be read. */ }
  }

  function civilDayInZone(timeZone) {
    if (typeof timeZone !== 'string' || !timeZone.trim() || timeZone.length > 128 || /[\u0000-\u001f\u007f]/.test(timeZone)) fail('invalid-response');
    let parts;
    try {
      parts = new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).formatToParts(new Date());
    } catch { fail('invalid-response'); }
    const values = Object.fromEntries(parts.filter(part => ['year', 'month', 'day'].includes(part.type)).map(part => [part.type, part.value]));
    if (!/^\d{4}$/.test(values.year || '') || !/^\d{2}$/.test(values.month || '') || !/^\d{2}$/.test(values.day || '')) fail('invalid-response');
    return `${values.year}-${values.month}-${values.day}`;
  }

  async function fetchMonitorAgenda(settings, revision, expectedGeneration) {
    if (revision !== configurationRevision || !(await receptionGenerationMatches(expectedGeneration))) return null;
    const rootResponse = await fetchResource(settings, baseUrl(settings), {configurationRevision: revision});
    if (revision !== configurationRevision || !(await receptionGenerationMatches(expectedGeneration))) return null;
    const root = rootResponse.data;
    if (!isObject(root) || typeof root.timeZone !== 'string' || !isObject(root._links) || !isObject(root._links.agenda)) fail('invalid-response');
    exactKeys(root._links.agenda, ['href', 'method'], ['href']);
    if (root._links.agenda.method !== undefined && root._links.agenda.method !== 'GET') fail('invalid-response');
    const link = validateDestination(settings, root._links.agenda.href, false);
    if (link.href.replace(/\/$/, '') !== apiUrl(settings, 'agenda')) fail('invalid-response');
    const query = new URLSearchParams();
    query.set('day', civilDayInZone(root.timeZone));
    query.set('heuristic', MONITOR_HEURISTIC);
    if (revision !== configurationRevision || !(await receptionGenerationMatches(expectedGeneration))) return null;
    link.search = query.toString();
    const agendaResponse = await fetchResource(settings, link.href, {allowQuery: true, configurationRevision: revision});
    if (revision !== configurationRevision || !(await receptionGenerationMatches(expectedGeneration))) return null;
    return agendaResponse.data;
  }

  async function emitNativeNotification(title, message, revision, expectedGeneration = null) {
    if (!native.notifications || typeof native.notifications.create !== 'function' || revision !== configurationRevision) return;
    if (expectedGeneration !== null) {
      try {
        const latest = await readReceptionState();
        if (latest.bufferGeneration !== expectedGeneration || revision !== configurationRevision) return;
      } catch { return; }
    }
    const id = `eptask-${Date.now()}-${++nativeNotificationCounter}`;
    const details = {
      type: 'basic',
      iconUrl: native.runtime.getURL('icons/icon-48.png'),
      title: safeRemoteText(title, ''),
      message: safeRemoteText(message, ''),
    };
    try { await callApi(native.notifications, 'create', id, details); }
    catch { /* The local copy remains authoritative if the operating system rejects a notification. */ }
  }

  async function emitNewNotificationBatch(entries, revision, generation) {
    if (!entries.length) return;
    const count = entries.length;
    const title = count === 1 ? 'Nuevo aviso de ElrikPiro' : `${count} avisos nuevos de ElrikPiro`;
    const summary = entries[0].text || 'Se ha recibido un aviso nuevo.';
    await emitNativeNotification(title, summary, revision, generation);
  }

  async function emitUrgentAlert(task, revision, generation, token) {
    const description = safeRemoteText(task.description, token);
    await emitNativeNotification('Tarea urgente', description || 'Hay una tarea urgente que requiere atención.', revision, generation);
  }

  async function monitorUrgency() {
    if (monitorBusy || alarmReconciliationCount > 0 || startupBusy) return;
    monitorBusy = true;
    const revision = configurationRevision;
    try {
      const settings = await readStoredSettings(true);
      if (revision !== configurationRevision) return;
      const startingState = await readReceptionState();
      if (revision !== configurationRevision) return;
      const notificationsResponse = await fetchResource(settings, apiUrl(settings, 'notifications'), {configurationRevision: revision});
      if (revision !== configurationRevision) return;
      const snapshot = validateNotificationSnapshot(notificationsResponse.data, settings);
      const applied = await applyNotificationSnapshot(settings.serverUrl, snapshot, startingState.bufferGeneration, revision);
      if (applied.cancelled || revision !== configurationRevision) return;
      if (applied.newEntries.length) {
        await emitNewNotificationBatch(applied.newEntries, revision, applied.state.bufferGeneration);
        if (revision === configurationRevision) await clearStoredError(revision).catch(() => {});
        return;
      }
      const agenda = await fetchMonitorAgenda(settings, revision, applied.state.bufferGeneration);
      if (!agenda || revision !== configurationRevision) return;
      await updateUrgencyFromAgenda(agenda, settings, revision);
      if (revision !== configurationRevision) return;
      const urgentTasks = agenda?._embedded?.activeUrgentTasks;
      if (urgentTasks && urgentTasks[0] && urgentTasks[0].context === 'alert') {
        await emitUrgentAlert(urgentTasks[0], revision, applied.state.bufferGeneration, settings.token);
      }
      if (revision === configurationRevision) await clearStoredError(revision).catch(() => {});
    } catch (error) {
      const fault = error instanceof GatewayFault ? error : new GatewayFault('gateway-unavailable');
      if (revision === configurationRevision) {
        if (fault.kind === 'permission-required') await disarmExisting().catch(() => {});
        await recordGatewayError(fault, null, revision).catch(() => {});
      }
    } finally { monitorBusy = false; }
  }

  native.alarms.onAlarm.addListener(alarm => {
    // The old notification alarm is intentionally inert; it must never issue a destructive GET.
    if (alarm && alarm.name === URGENCY_ALARM && !startupBusy && alarmReconciliationCount === 0 && !monitorBusy) void monitorUrgency();
  });

  async function startup() {
    try {
      await reconcileManagerCandidates();
      await callApi(native.alarms, 'clear', LEGACY_MONITOR_ALARM).catch(() => {});
      await disarmLegacyConfiguration();
      await restoreUrgency();
      try {
        const settings = await storedSettingsOrDefaults();
        if (settings.monitorEnabled) await reconcileUrgencyAlarm(true);
        else await reconcileUrgencyAlarm(false);
      } catch { await reconcileUrgencyAlarm(false); }
    } finally { startupBusy = false; }
  }

  function scheduleStartup() {
    if (startupBusy) return;
    startupBusy = true;
    void enqueue(startup);
  }

  native.runtime.onInstalled.addListener(scheduleStartup);
  native.runtime.onStartup.addListener(scheduleStartup);
  scheduleStartup();
})();
