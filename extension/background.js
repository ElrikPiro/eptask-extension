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
  const LEGACY_MONITOR_ALARM = 'eptask-notification-monitor';
  const URGENCY_ALARM = 'eptask-urgent-indicator';
  const PROTOCOL_VERSION = 1;
  const DEFAULT_TIMEOUT = 30000;
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
    'settings.disconnect', 'settings.clear', 'history.clear',
  ]);
  let urgencyBusy = false;
  let queue = Promise.resolve();
  let currentUrgent = false;
  let configurationRevision = 0;

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
    return isObject(receipt) &&
      receipt.id === options.expectedOperationId &&
      receipt.status === 'succeeded' &&
      receipt.type === options.expectedOperationType &&
      receiptMatchesTarget(receipt.target, options.expectedTarget) &&
      isObject(receipt.result) &&
      receipt.result.type === options.expectedOperationType &&
      receiptMatchesTarget(receipt.result.target, options.expectedTarget) &&
      receipt.failure === null;
  }

  async function fetchResource(settings, destination, options = {}) {
    await hasHostPermission(settings);
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
      if (['description', 'context', 'start', 'due', 'raised', 'waited'].includes(key) && value !== null) optionalText(value, 20000);
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
        nonEmptyText(params.description);
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
      case 'open-project': if (params.description !== undefined) nonEmptyText(params.description); break;
      case 'edit-project-content':
        for (const key of ['action', 'content', 'description']) if (params[key] !== undefined) optionalText(params[key]);
        for (const key of ['line', 'position']) if (params[key] !== undefined && (!Number.isSafeInteger(params[key]) || params[key] < 0)) fail('invalid-request');
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
    } else if (page === 'options.html') fail('unauthorized-sender');
    if (page === 'popup.html' && !['agenda.read', 'operations.submit'].includes(op)) fail('unauthorized-sender');
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
    const probed = await fetchResource(candidate, baseUrl(candidate));
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
      if (op === 'settings.save' || op === 'settings.connect' || op === 'settings.disconnect' || op === 'settings.clear' || op === 'history.clear') {
        const result = await executeSettings(message, revision);
        return {status: result.status, data: result.data};
      }
      if (op === 'root.read') exactKeys(params, []);
      const settings = await readStoredSettings(true);
      const route = routeFor(settings, op, message.target, params, message.requestId, page);
      const result = await fetchResource(settings, route.url, route.options);
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
      if (requestId && fault.configurationRevision === configurationRevision && !['invalid-request', 'unauthorized-sender', 'unsupported-operation'].includes(fault.kind)) {
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
    void dispatchMessage(message, sender, sendResponse);
    return true;
  });

  async function recordGatewayError(error, requestId, revision = configurationRevision) {
    if (revision !== configurationRevision) return;
    const settings = await storedSettingsOrDefaults();
    if (revision !== configurationRevision) return;
    const safe = safeRemoteText(error.message, settings.token) || safeMessage(error.kind);
    const errorState = {
      kind: error.kind,
      title: safeTitle(error.kind),
      message: safe,
      requestId,
      updatedAt: new Date().toISOString(),
    };
    if (error.operationId) errorState.operationId = error.operationId;
    if (revision !== configurationRevision) return;
    await callApi(native.storage.local, 'set', {[ERROR_KEY]: errorState});
    if (revision !== configurationRevision) return;
    await setBadge('!', 'ElrikPiro: ' + safeTitle(error.kind) + '. ' + safe);
  }

  async function clearStoredError(revision = configurationRevision) {
    if (revision !== configurationRevision) return;
    let values = {};
    try { values = await callApi(native.storage.local, 'get', ERROR_KEY); } catch { return; }
    if (revision !== configurationRevision) return;
    if (values[ERROR_KEY] != null) await callApi(native.storage.local, 'set', {[ERROR_KEY]: null}).catch(() => {});
    if (revision !== configurationRevision) return;
    const action = native.action || native.browserAction;
    if (action && typeof action.setBadgeText === 'function') await callApi(action, 'setBadgeText', {text: currentUrgent ? '●' : ''}).catch(() => {});
    if (action && typeof action.setTitle === 'function') await callApi(action, 'setTitle', {title: currentUrgent ? 'ElrikPiro: hay tareas urgentes.' : 'ElrikPiro'}).catch(() => {});
  }

  async function setBadge(text, title = null) {
    const action = native.action || native.browserAction;
    if (!action) return;
    if (typeof action.setBadgeText === 'function') await callApi(action, 'setBadgeText', {text}).catch(() => {});
    if (text === '●' || text === '!') {
      if (typeof action.setBadgeTextColor === 'function') {
        try {
          if (text === '●') {
            await callApi(action, 'setBadgeTextColor', {color: '#c62828'});
            await callApi(action, 'setBadgeBackgroundColor', {color: [0, 0, 0, 0]});
          } else {
            await callApi(action, 'setBadgeTextColor', {color: '#ffffff'});
            await callApi(action, 'setBadgeBackgroundColor', {color: '#c62828'});
          }
        } catch {
          await callApi(action, 'setBadgeBackgroundColor', {color: '#c62828'}).catch(() => {});
        }
      } else if (typeof action.setBadgeBackgroundColor === 'function') {
        await callApi(action, 'setBadgeBackgroundColor', {color: '#c62828'});
      }
    } else if (text === '!' && typeof action.setBadgeBackgroundColor === 'function') {
      await callApi(action, 'setBadgeBackgroundColor', {color: '#c62828'});
    }
    if (typeof action.setTitle === 'function') await callApi(action, 'setTitle', {title: title || (text === '!' ? 'ElrikPiro: error de conexión.' : text === '●' ? 'ElrikPiro: hay tareas urgentes.' : 'ElrikPiro')});
  }

  async function updateUrgencyFromAgenda(data, settings, revision) {
    const tasks = data && data._embedded && data._embedded.activeUrgentTasks;
    if (!Array.isArray(tasks) || tasks.some(task => !isObject(task) || typeof task.id !== 'string' || typeof task.context !== 'string' || typeof task.description !== 'string')) {
      fail('invalid-response');
    }
    if (revision !== configurationRevision) return;
    const urgent = tasks.length > 0;
    await callApi(native.storage.local, 'set', {[URGENCY_KEY]: {active: urgent, endpoint: settings.serverUrl, updatedAt: new Date().toISOString()}}).catch(() => {});
    if (revision !== configurationRevision) return;
    currentUrgent = urgent;
    await setBadge(currentUrgent ? '●' : '').catch(() => {});
  }

  async function clearUrgency() {
    currentUrgent = false;
    await callApi(native.alarms, 'clear', URGENCY_ALARM).catch(() => {});
    await callApi(native.storage.local, 'set', {[URGENCY_KEY]: {active: false, updatedAt: new Date().toISOString()}}).catch(() => {});
    await setBadge('');
  }

  async function restoreUrgency() {
    const revision = configurationRevision;
    try {
      const stored = await callApi(native.storage.local, 'get', [URGENCY_KEY, ERROR_KEY, SETTINGS_KEY]);
      const settings = await storedSettingsOrDefaults();
      if (revision !== configurationRevision) return;
      currentUrgent = settings.monitorEnabled === true && stored[URGENCY_KEY]?.endpoint === settings.serverUrl && stored[URGENCY_KEY]?.active === true;
      const errorState = stored[ERROR_KEY];
      if (isObject(errorState)) {
        const kind = typeof errorState.kind === 'string' && /^[a-z0-9-]{1,80}$/.test(errorState.kind) ? errorState.kind : 'gateway-unavailable';
        const rawSettings = stored[SETTINGS_KEY];
        const token = settings.token || (isObject(rawSettings) && typeof rawSettings.token === 'string' ? rawSettings.token : '');
        const message = safeRemoteText(errorState.message, token) || safeMessage(kind);
        if (revision !== configurationRevision) return;
        await setBadge('!', 'ElrikPiro: ' + safeTitle(kind) + '. ' + message);
      } else {
        if (revision !== configurationRevision) return;
        await setBadge(currentUrgent ? '●' : '');
      }
    } catch {
      if (revision === configurationRevision) await setBadge('');
    }
  }

  async function reconcileUrgencyAlarm(enabled) {
    if (!enabled) {
      await callApi(native.alarms, 'clear', URGENCY_ALARM).catch(() => {});
      return;
    }
    const existing = await callApi(native.alarms, 'get', URGENCY_ALARM).catch(() => null);
    if (!existing || existing.periodInMinutes !== 5) await callApi(native.alarms, 'create', URGENCY_ALARM, {delayInMinutes: 5, periodInMinutes: 5}).catch(() => {});
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

  async function monitorUrgency() {
    if (urgencyBusy) return;
    urgencyBusy = true;
    const revision = configurationRevision;
    try {
      const settings = await readStoredSettings(true);
      const response = await fetchResource(settings, apiUrl(settings, 'agenda'), {});
      if (revision === configurationRevision) {
        await updateUrgencyFromAgenda(response.data, settings, revision);
        if (revision === configurationRevision) await clearStoredError(revision).catch(() => {});
      }
    } catch (error) {
      const fault = error instanceof GatewayFault ? error : new GatewayFault('gateway-unavailable');
      if (revision === configurationRevision) {
        if (fault.kind === 'permission-required') await disarmExisting().catch(() => {});
        await recordGatewayError(fault, null, revision).catch(() => {});
      }
    } finally { urgencyBusy = false; }
  }

  native.alarms.onAlarm.addListener(alarm => {
    // The old notification alarm is intentionally inert; it must never issue a destructive GET.
    if (alarm && alarm.name === URGENCY_ALARM) void enqueue(monitorUrgency);
  });

  async function startup() {
    await callApi(native.alarms, 'clear', LEGACY_MONITOR_ALARM).catch(() => {});
    await disarmLegacyConfiguration();
    await restoreUrgency();
    try {
      const settings = await storedSettingsOrDefaults();
      if (settings.monitorEnabled) await reconcileUrgencyAlarm(true);
      else await reconcileUrgencyAlarm(false);
    } catch { await reconcileUrgencyAlarm(false); }
  }

  native.runtime.onInstalled.addListener(() => { void enqueue(startup); });
  native.runtime.onStartup.addListener(() => { void enqueue(startup); });
  void enqueue(startup);
})();
