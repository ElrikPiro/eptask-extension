/* Classic script shared by Chromium service worker and Firefox event background.
 * All network access and critical dependencies live here; listeners register synchronously.
 */
(() => {
  'use strict';
  const native = typeof browser !== 'undefined' ? browser : chrome;
  const promises = typeof browser !== 'undefined';
  const SETTINGS = 'settings.v1';
  const HISTORY = 'notificationHistory.v1';
  const STATUS = 'monitorStatus.v1';
  const URGENCY_STATE = 'urgentIndicator.v1';
  const ALARM = 'eptask-notification-monitor';
  const URGENCY_ALARM = 'eptask-urgent-indicator';
  const defaults = () => ({schemaVersion: 1, serverUrl: '', token: '', monitorEnabled: false});
  let queue = Promise.resolve();
  let writes = Promise.resolve();
  let badgeWrites = Promise.resolve();
  let revision = 0;
  let badgeRevision = 0;
  let monitorBusy = false;
  let urgencyBusy = false;
  let reconciliation = null;
  let urgencyReconciliation = null;
  let idCounter = 0;

  function api(object, method, ...args) {
    if (promises) return Promise.resolve().then(() => object[method](...args));
    // Older Chromium alarms.create has no callback. Its optional promise is safe to await.
    if (object === native.alarms && method === 'create') return Promise.resolve(object[method](...args));
    return new Promise((resolve, reject) => {
      object[method](...args, result => {
        const err = native.runtime.lastError;
        if (err) reject(new Error('Browser API failure'));
        else resolve(result);
      });
    });
  }
  function enqueue(job) {
    const result = queue.then(job);
    queue = result.catch(() => {});
    return result;
  }
  function write(job) {
    const result = writes.then(job);
    writes = result.catch(() => {});
    return result;
  }
  function failure(kind, message, status = null) { return {ok: false, status, error: {kind, message}}; }
  function invalid(message = 'Solicitud o argumentos no válidos') { throw failure('invalid-request', message); }
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  function keys(value, allowed) {
    if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) invalid();
  }
  function text(value, required = true) {
    if (typeof value !== 'string' || value.length > 20000 || (required && !value.trim())) invalid();
    return value;
  }
  function index(value) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 1000000) invalid();
    return value;
  }
  function page(value) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 1000) invalid('Página no válida');
    return value;
  }
  function target(value) {
    keys(value, ['index', 'expectedTaskId', 'page']);
    index(value.index);
    if (value.page !== undefined) page(value.page);
    text(value.expectedTaskId);
    if (value.expectedTaskId === 'unknown') invalid('Elige una tarea con un identificador de listado válido');
    return value;
  }
  function expectedTask(value) {
    keys(value, ['id', 'description', 'context']);
    text(value.id);
    if (value.id === 'unknown') invalid('La tarea urgente no tiene una identidad de listado válida');
    text(value.description);
    text(value.context, false);
    return {id: value.id, description: value.description, context: value.context};
  }
  function normalizeSettings(value, requireCredentials = false) {
    keys(value, ['schemaVersion', 'serverUrl', 'token', 'monitorEnabled']);
    if (typeof value.serverUrl !== 'string' || typeof value.token !== 'string' || typeof value.monitorEnabled !== 'boolean') invalid();
    let serverUrl = value.serverUrl.trim();
    const token = value.token.trim();
    if (token.length > 8192 || /[\r\n\x00-\x1f\x7f]/.test(token)) throw failure('invalid-config', 'Token no válido');
    if (serverUrl) {
      let url;
      try { url = new URL(serverUrl); } catch { throw failure('invalid-config', 'Usa una URL HTTP absoluta'); }
      if (url.protocol !== 'http:' || !url.hostname || url.username || url.password || url.search || url.hash) {
        throw failure('invalid-config', 'URL HTTP no válida: sin credenciales, consulta ni fragmento');
      }
      serverUrl = url.origin + url.pathname.replace(/\/+$/, '');
    }
    if (requireCredentials && (!serverUrl || !token)) throw failure('invalid-config', 'Configura servidor y token');
    return {schemaVersion: 1, serverUrl, token, monitorEnabled: value.monitorEnabled};
  }
  async function readSettings() {
    await writes;
    const values = await api(native.storage.local, 'get', SETTINGS);
    try { return normalizeSettings(values[SETTINGS] || defaults()); }
    catch { return defaults(); }
  }
  function publicSettings(value) {
    return {schemaVersion: 1, serverUrl: value.serverUrl, monitorEnabled: value.monitorEnabled, hasToken: Boolean(value.token)};
  }
  async function activeSettings() {
    const settings = await readSettings();
    if (!settings.monitorEnabled || !settings.serverUrl || !settings.token) throw failure('invalid-config', 'Conecta la extensión desde Opciones');
    return settings;
  }
  function redact(value, token) {
    if (typeof value === 'string') return token ? value.split(token).join('[redactado]') : value;
    if (Array.isArray(value)) return value.map(item => redact(item, token));
    if (object(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redact(item, token)]));
    return value;
  }
  async function http(settings, path, args = [], notifications = false) {
    const url = new URL(settings.serverUrl + '/' + path);
    if (notifications) url.searchParams.set('mask_as_read', 'true');
    else {
      const joined = args.map(value => value.trim()).filter(Boolean).join(' ');
      if (joined) url.searchParams.set('args', joined);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      // Never follow redirects with credentials, including same-host backend redirects.
      const response = await fetch(url.href, {method: 'GET', headers: {Authorization: 'Bearer ' + settings.token}, signal: controller.signal, redirect: 'error', cache: 'no-store', credentials: 'omit'});
      if (!response.ok) throw failure('http', 'Respuesta HTTP no satisfactoria', response.status);
      const contentType = response.headers.get('content-type') || '';
      const raw = await response.text();
      let data = raw;
      if (/json/i.test(contentType) || /^[\s]*[\[{]/.test(raw)) {
        try { data = JSON.parse(raw); }
        catch { throw failure('invalid-response', 'JSON de respuesta no válido', response.status); }
      }
      return {ok: true, status: response.status, contentType, data};
    } catch (error) {
      if (error && error.ok === false) throw error;
      if (controller.signal.aborted) throw failure('timeout', 'La petición excedió diez segundos');
      throw failure('network', 'No se pudo contactar con el servidor; comprueba red y permisos de host');
    } finally { clearTimeout(timer); }
  }
  function agenda(response) {
    if (!object(response.data) || !Array.isArray(response.data.active_urgent_tasks) || response.data.active_urgent_tasks.some(task => !object(task) || typeof task.id !== 'string' || typeof task.context !== 'string' || typeof task.description !== 'string')) {
      throw failure('invalid-response', 'La agenda recibida no tiene una estructura válida', response.status);
    }
    return response;
  }
  const simple = {GET_LIST: 'list', NEXT: 'next', PREVIOUS: 'previous', GET_INFO: 'info', GET_HEURISTICS: 'heuristic', GET_ALGORITHMS: 'algorithm', GET_FILTERS: 'filter', DONE: 'done', GET_STATS: 'stats', GET_AGENDA: 'agenda', GET_EVENTS: 'events'};
  function command(operation, args) {
    const spec = {GET_INFO: ['target'], DONE: ['target'], SET: ['param','value','target'], NEW: ['description','context','totalCost'], WORK: ['amount','target'], SNOOZE: ['amount','target'], SCHEDULE: ['expectedWorkPerDay','target'], SEARCH: ['terms'], PROJECT: ['args','target'], RAISE: ['eventName'], SELECT_TASK: ['index','expectedTaskId','page'], SELECT_HEURISTIC: ['index'], SELECT_ALGORITHM: ['index'], TOGGLE_FILTER: ['index'], POPUP_DONE: ['expectedTask'], POPUP_SNOOZE: ['expectedTask']};
    if (!Object.hasOwn(simple, operation) && !Object.hasOwn(spec, operation)) invalid('Operación no permitida');
    keys(args, spec[operation] || []);
    if (operation === 'POPUP_DONE' || operation === 'POPUP_SNOOZE') {
      return {path: operation === 'POPUP_DONE' ? 'done' : 'snooze', values: operation === 'POPUP_DONE' ? [] : ['5m'], popupAction: true, expectedTask: expectedTask(args.expectedTask)};
    }
    if (['DONE','SET','WORK','SNOOZE','SCHEDULE'].includes(operation)) target(args.target);
    else if (args.target !== undefined) target(args.target);
    if (Object.hasOwn(simple, operation)) return {path: simple[operation], values: []};
    const indexed = {SELECT_TASK:'task', SELECT_HEURISTIC:'heuristic', SELECT_ALGORITHM:'algorithm', TOGGLE_FILTER:'filter'};
    if (indexed[operation]) {
      if (operation === 'SELECT_TASK') {
        if (args.page !== undefined) page(args.page);
        if (args.expectedTaskId !== undefined) target({index:args.index,expectedTaskId:args.expectedTaskId,page:args.page});
      }
      return {path: indexed[operation] + '_' + index(args.index), values: []};
    }
    switch (operation) {
      case 'SET': return {path:'set', values:[text(args.param), text(args.value)]};
      case 'NEW': {
        const description = text(args.description);
        if (args.context !== undefined) text(args.context, false);
        if (args.totalCost !== undefined) text(args.totalCost, false);
        return {path:'new', values:[args.context && args.totalCost ? `${description};${args.context};${args.totalCost}` : description]};
      }
      case 'WORK': return {path:'work', values:[text(args.amount)]};
      case 'SNOOZE': return {path:'snooze', values: args.amount === undefined ? [] : [text(args.amount, false)]};
      case 'SCHEDULE': return {path:'schedule', values: args.expectedWorkPerDay === undefined ? [] : [text(args.expectedWorkPerDay, false)]};
      case 'SEARCH': case 'PROJECT': {
        const values = operation === 'SEARCH' ? args.terms : args.args;
        if (!Array.isArray(values) || values.length > 100) invalid();
        values.forEach(value => text(value, false));
        return {path:operation.toLowerCase(), values};
      }
      case 'RAISE': return {path:'raise', values:[text(args.eventName)]};
    }
  }
  function popupListPage(response, expectedPage, previous = null) {
    const data = response.data;
    if (!object(data) || !Array.isArray(data.tasks) || !Number.isSafeInteger(data.current_page) ||
        !Number.isSafeInteger(data.total_pages) || !Number.isSafeInteger(data.total_tasks) ||
        !Array.isArray(data.active_filters)) {
      throw failure('invalid-response', 'No se pudo validar la lista y sus filtros para actuar sobre la tarea urgente', response.status);
    }
    if (data.current_page !== expectedPage || data.total_pages < 1 || data.total_pages > 1000 ||
        data.total_tasks < 0 || expectedPage > data.total_pages) {
      throw failure('task-changed', 'La paginación del gestor ha cambiado; actualiza la lista y vuelve a intentarlo', response.status);
    }
    if (data.active_filters.some(filter => !object(filter) || typeof filter.name !== 'string' ||
        typeof filter.description !== 'string' || !Number.isSafeInteger(filter.index) || filter.index < 1)) {
      throw failure('invalid-response', 'No se pudieron identificar los filtros activos del gestor', response.status);
    }
    const filterSignature = JSON.stringify(data.active_filters);
    if (previous && (data.total_pages !== previous.totalPages || data.total_tasks !== previous.totalTasks ||
        filterSignature !== previous.filterSignature)) {
      throw failure('task-changed', 'La lista o sus filtros han cambiado; actualiza y vuelve a intentarlo', response.status);
    }
    if (data.tasks.some(row => !object(row) || typeof row.id !== 'string' || !row.id || row.id === 'unknown' ||
        typeof row.description !== 'string' || typeof row.context !== 'string')) {
      throw failure('invalid-response', 'La lista no contiene identidades de tarea válidas; no se ha realizado ningún cambio', response.status);
    }
    return {
      tasks: data.tasks,
      totalPages: data.total_pages,
      totalTasks: data.total_tasks,
      activeFilters: data.active_filters,
      filterSignature,
    };
  }
  function sameTask(left, right) {
    return left.id === right.id && left.description === right.description && left.context === right.context;
  }
  async function setUrgencyBadge(urgent, version) {
    const action = native.action || native.browserAction;
    const updateVersion = ++badgeRevision;
    const current = () => revision === version && badgeRevision === updateVersion;
    const update = badgeWrites.catch(() => {}).then(async () => {
      if (!current()) return;
      if (action && typeof action.setBadgeText === 'function' && typeof action.setBadgeBackgroundColor === 'function') {
        if (urgent) {
          let redDot = false;
          if (typeof action.setBadgeTextColor === 'function') {
            try {
              await api(action, 'setBadgeTextColor', {color: '#c62828'});
              if (!current()) return;
              await api(action, 'setBadgeBackgroundColor', {color: [0, 0, 0, 0]});
              if (!current()) return;
              redDot = true;
            } catch { /* Older or incompatible APIs use the red badge fallback below. */ }
          }
          if (!redDot) {
            if (!current()) return;
            await api(action, 'setBadgeBackgroundColor', {color: '#c62828'});
            if (!current()) return;
            if (typeof action.setBadgeTextColor === 'function') {
              try { await api(action, 'setBadgeTextColor', {color: '#ffffff'}); } catch { /* Browser default remains readable on red. */ }
              if (!current()) return;
            }
          }
        }
        await api(action, 'setBadgeText', {text: urgent ? '●' : ''});
      }
      if (!current()) return;
      await api(native.storage.local, 'set', {[URGENCY_STATE]: {active: urgent, updatedAt: new Date().toISOString()}});
    }).catch(() => {});
    badgeWrites = update;
    await update;
  }
  async function restoreUrgencyBadge() {
    const version = revision;
    const updateVersion = badgeRevision;
    const stored = await api(native.storage.local, 'get', URGENCY_STATE);
    if (revision !== version || badgeRevision !== updateVersion) return;
    const settings = await readSettings();
    if (revision !== version || badgeRevision !== updateVersion) return;
    await setUrgencyBadge(settings.monitorEnabled && stored[URGENCY_STATE]?.active === true, version);
  }
  async function refreshUrgency(settings, version) {
    if (revision !== version) return;
    const current = await activeSettings();
    if (revision !== version || current.serverUrl !== settings.serverUrl || current.token !== settings.token) return;
    const result = agenda(await http(current, 'agenda'));
    if (revision !== version) return;
    await setUrgencyBadge(result.data.active_urgent_tasks.length > 0, version);
  }
  async function call(operation, args, spec) {
    const settings = await activeSettings();
    const version = revision;
    let verifiedRow = null;
    async function unchanged() {
      const current = await activeSettings();
      if (revision !== version || current.serverUrl !== settings.serverUrl || current.token !== settings.token) throw failure('invalid-config', 'La configuración ha cambiado');
    }
    function validateSelected(response) {
      const task = object(response.data) && response.data.task;
      // Backend list IDs use getTaskUID(); current detail serializer uses missing getId(),
      // returning "unknown". Validate the actual page UID and selection fields together.
      const matches = object(task) && (task.id === verifiedRow.id ||
        (task.id === 'unknown' && task.description === verifiedRow.description && task.context === verifiedRow.context));
      if (!matches) throw failure('invalid-response', 'La tarea ha cambiado; actualiza el listado antes de actuar', response.status);
    }
    function localIdentity(response) {
      if (verifiedRow && object(response.data) && object(response.data.task) && response.data.task.id === 'unknown') {
        response = {...response,data:{...response.data,task:{...response.data.task,id:verifiedRow.id}},verifiedTaskId:verifiedRow.id};
      }
      return {...response,data:redact(response.data,settings.token)};
    }
    if (spec.popupAction) {
      const shownTask = spec.expectedTask;
      const agendaResult = agenda(await http(settings, 'agenda'));
      await unchanged();
      const urgentTasks = agendaResult.data.active_urgent_tasks;
      await setUrgencyBadge(urgentTasks.length > 0, version);
      if (!urgentTasks[0]) throw failure('task-missing', 'Ya no hay una tarea urgente activa; actualiza el popup');
      if (!sameTask(urgentTasks[0], shownTask)) throw failure('task-changed', 'La tarea urgente ha cambiado desde que abriste el popup; actualízalo');
      if (urgentTasks.filter(task => task.id === shownTask.id).length !== 1) {
        throw failure('task-ambiguous', 'La agenda contiene varias tareas con la misma identidad; no se ha realizado ningún cambio');
      }

      let listedResponse = await http(settings, 'list');
      await unchanged();
      let listing = popupListPage(listedResponse, 1);
      const listingReference = listing;
      const candidates = [];
      for (let currentPage = 1; currentPage <= listing.totalPages; currentPage++) {
        for (let rowIndex = 0; rowIndex < listing.tasks.length; rowIndex++) {
          const row = listing.tasks[rowIndex];
          if (row.id === shownTask.id) candidates.push({row, page: currentPage, index: rowIndex + 1});
        }
        if (currentPage < listing.totalPages) {
          await unchanged();
          listedResponse = await http(settings, 'next');
          await unchanged();
          listing = popupListPage(listedResponse, currentPage + 1, listingReference);
        }
      }
      if (candidates.length > 1) throw failure('task-ambiguous', 'La tarea aparece varias veces en la lista; no se ha realizado ningún cambio');
      if (candidates.length === 0) {
        const filtered = listingReference.activeFilters.length > 0;
        throw failure('task-missing', filtered
          ? 'La tarea urgente no aparece con los filtros actuales; desactívalos o ajusta la lista y vuelve a intentarlo'
          : 'La tarea urgente no aparece en la lista actual; actualiza la lista y vuelve a intentarlo');
      }
      const candidate = candidates[0];
      if (!sameTask(candidate.row, shownTask)) throw failure('task-changed', 'La identidad de la tarea ha cambiado en el listado; no se ha realizado ningún cambio');

      // Rebuild the target page inside this FIFO group so selection uses a freshly
      // verified UID even when the full scan ended on a later page.
      await unchanged();
      let targetPageResponse = await http(settings, 'list');
      await unchanged();
      let targetListing = popupListPage(targetPageResponse, 1, listingReference);
      for (let currentPage = 2; currentPage <= candidate.page; currentPage++) {
        await unchanged();
        targetPageResponse = await http(settings, 'next');
        await unchanged();
        targetListing = popupListPage(targetPageResponse, currentPage, listingReference);
      }
      const verifiedRow = targetListing.tasks[candidate.index - 1];
      if (!verifiedRow || !sameTask(verifiedRow, shownTask)) {
        throw failure('task-changed', 'La tarea ha cambiado de página o identidad; actualiza y vuelve a intentarlo');
      }
      await unchanged();
      const selected = await http(settings, 'task_' + candidate.index);
      await unchanged();
      const selectedTask = object(selected.data) && selected.data.task;
      const selectedDetailsMatch = object(selectedTask) && selectedTask.description === verifiedRow.description &&
        selectedTask.context === verifiedRow.context;
      const selectedMatches = selectedDetailsMatch && (selectedTask.id === verifiedRow.id || selectedTask.id === 'unknown');
      if (!selectedMatches) throw failure('task-changed', 'El backend seleccionó otra tarea; no se ha realizado ningún cambio', selected.status);
      await unchanged();
      const mutation = await http(settings, spec.path, spec.values);
      if (revision === version) {
        try { await refreshUrgency(settings, version); } catch { /* A completed mutation must not be reported as retryable. */ }
      }
      return localIdentity(mutation);
    }
    const goal = args.target || (operation === 'SELECT_TASK' ? {index:args.index,expectedTaskId:args.expectedTaskId,page:args.page} : null);
    if (goal) {
      let listed = await http(settings, 'list');
      const desiredPage = goal.page === undefined ? 1 : goal.page;
      if (desiredPage > 1) {
        if (!object(listed.data) || !Array.isArray(listed.data.tasks) ||
            !Number.isSafeInteger(listed.data.total_pages) || desiredPage > listed.data.total_pages || listed.data.current_page !== 1) {
          throw failure('invalid-response', 'La página solicitada ya no existe; actualiza el listado', listed.status);
        }
        // /list resets pagination in the existing backend. Restore the requested page
        // inside this same FIFO group before validating its UID and selecting a row.
        for (let currentPage = 2; currentPage <= desiredPage; currentPage++) {
          await unchanged();
          listed = await http(settings, 'next');
          if (!object(listed.data) || !Array.isArray(listed.data.tasks) || listed.data.current_page !== currentPage ||
              !Number.isSafeInteger(listed.data.total_pages) || listed.data.total_pages < desiredPage) {
            throw failure('invalid-response', 'La paginación ha cambiado; actualiza el listado', listed.status);
          }
        }
      }
      const row = object(listed.data) && Array.isArray(listed.data.tasks) && listed.data.tasks[goal.index - 1];
      if (!object(row) || typeof row.id !== 'string' || !row.id || row.id === 'unknown' ||
          typeof row.description !== 'string' || typeof row.context !== 'string' ||
          (goal.expectedTaskId !== undefined && row.id !== goal.expectedTaskId)) {
        throw failure('invalid-response', 'El listado ha cambiado; actualízalo antes de actuar', listed.status);
      }
      verifiedRow = row;
      await unchanged();
      const selected = await http(settings, 'task_' + goal.index);
      validateSelected(selected);
      await unchanged();
      if (operation === 'SELECT_TASK') return localIdentity(selected);
    }
    const response = await http(settings, spec.path, spec.values);
    if (operation === 'GET_AGENDA') {
      agenda(response);
      if (revision === version) await setUrgencyBadge(response.data.active_urgent_tasks.length > 0, version);
    }
    if (verifiedRow && operation === 'GET_INFO') validateSelected(response);
    if (['DONE','SET','NEW','WORK','SNOOZE','SCHEDULE'].includes(operation) && revision === version) {
      try { await refreshUrgency(settings, version); } catch { /* Keep the mutation result authoritative. */ }
    }
    return localIdentity(response);
  }
  function trusted(sender, optionsOnly = false) {
    if (!sender || sender.id !== native.runtime.id || typeof sender.url !== 'string') return false;
    const root = native.runtime.getURL('');
    if (!sender.url.startsWith(root)) return false;
    const page = sender.url.slice(root.length).split(/[?#]/)[0];
    return optionsOnly ? page === 'options.html' : ['popup.html','options.html','index.html'].includes(page);
  }
  function trustedPopup(sender) {
    if (!trusted(sender)) return false;
    const root = native.runtime.getURL('');
    return sender.url.slice(root.length).split(/[?#]/)[0] === 'popup.html';
  }
  async function configure(type, candidate, version) {
    const saved = await write(async () => {
      const stored = await api(native.storage.local, 'get', SETTINGS);
      let old;
      try { old = normalizeSettings(stored[SETTINGS] || defaults()); } catch { old = defaults(); }
      let next;
      if (type === 'settings.clear') next = defaults();
      else if (type === 'settings.disconnect') next = {...old, monitorEnabled:false};
      else {
        next = {...candidate, monitorEnabled:false};
        if (type === 'settings.save' && old.monitorEnabled === true && candidate.monitorEnabled && old.serverUrl === candidate.serverUrl && old.token === candidate.token) next.monitorEnabled = true;
      }
      await api(native.storage.local, 'set', {[SETTINGS]:next});
      return next;
    });
    if (type !== 'settings.connect') {
      if (revision === version && (type === 'settings.disconnect' || type === 'settings.clear' || !saved.monitorEnabled)) {
        await setUrgencyBadge(false, version);
      }
      return {ok:true,status:null,data:publicSettings(saved)};
    }
    return enqueue(async () => {
      if (revision !== version) throw failure('invalid-config', 'La configuración ha cambiado');
      const connectedAgenda = agenda(await http(saved, 'agenda'));
      return write(async () => {
        if (revision !== version) throw failure('invalid-config', 'La configuración ha cambiado durante la conexión');
        const next = {...saved,monitorEnabled:true};
        await api(native.storage.local, 'set', {[SETTINGS]:next});
        if (revision !== version) throw failure('invalid-config', 'La configuración ha cambiado durante la conexión');
        await setUrgencyBadge(connectedAgenda.data.active_urgent_tasks.length > 0, version);
        return {ok:true,status:200,data:publicSettings(next)};
      });
    });
  }
  function handle(message, sender) {
    if (!trusted(sender)) invalid('Remitente no autorizado');
    keys(message, ['type','requestId','operation','args','settings']);
    text(message.requestId);
    if (message.requestId.length > 200) invalid();
    if (message.type === 'gateway.call') {
      if (message.settings !== undefined) invalid();
      const args = message.args === undefined ? {} : message.args;
      if (['POPUP_DONE','POPUP_SNOOZE'].includes(message.operation) && !trustedPopup(sender)) invalid('Esta acción solo se admite desde el popup');
      const spec = command(message.operation, args);
      return enqueue(() => call(message.operation, args, spec));
    }
    if (message.operation !== undefined) invalid();
    if (['settings.save','settings.connect','settings.disconnect','settings.clear'].includes(message.type)) {
      if (!trusted(sender, true)) invalid('La configuración solo se modifica desde Opciones');
      keys(message.args || {}, []);
      const hasCandidate = ['settings.save','settings.connect'].includes(message.type);
      if (!hasCandidate && message.settings !== undefined) invalid();
      const version = ++revision;
      let candidate = null;
      try {
        if (hasCandidate) candidate = normalizeSettings(message.settings, message.type === 'settings.connect');
      } catch (error) {
        // An invalid configuration entered in Options also disables the existing connection.
        return configure('settings.disconnect', null, version).then(() => { throw error; });
      }
      return configure(message.type, candidate, version);
    }
    if (message.type === 'history.clear') {
      if (message.settings !== undefined) invalid();
      keys(message.args || {}, []);
      return write(async () => { await api(native.storage.local, 'set', {[HISTORY]:[]}); return {ok:true,status:null,data:[]}; });
    }
    invalid('Tipo de mensaje no permitido');
  }
  function resultError(error) {
    return error && error.ok === false ? error : failure('invalid-response','No se pudo completar la operación local');
  }
  const localId = () => Date.now().toString(36) + '-' + (++idCounter).toString(36) + '-' + Math.random().toString(36).slice(2);
  async function notify(title, message) {
    await api(native.notifications, 'create', 'eptask-' + localId(), {type:'basic',iconUrl:native.runtime.getURL('icons/icon-128.png'),title,message});
  }
  async function monitor() {
    const settings = await activeSettings();
    const version = revision;
    const response = await http(settings, 'notifications', [], true);
    const entries = response.data;
    if (!Array.isArray(entries) || entries.some(entry => !object(entry) || typeof entry.message !== 'string' || typeof entry.timestamp !== 'string')) {
      throw failure('invalid-response', 'Lote de notificaciones no válido', response.status);
    }
    if (entries.length) {
      await write(async () => {
        const values = await api(native.storage.local,'get',HISTORY);
        const previous = Array.isArray(values[HISTORY]) ? values[HISTORY] : [];
        const receivedAt = new Date().toISOString();
        const additions = entries.map(entry => ({localId:localId(),message:entry.message,timestamp:entry.timestamp,receivedAt}));
        await api(native.storage.local,'set',{[HISTORY]:previous.concat(additions).slice(-500)});
      });
      if (revision === version && (await readSettings()).monitorEnabled) await notify(`${entries.length} notificaciones de ElrikPiro`,entries.map(entry => entry.message).join('\n').slice(0,500));
    } else {
      const current = await activeSettings();
      if (revision !== version) return;
      const tasks = agenda(await http(current,'agenda')).data.active_urgent_tasks;
      if (revision === version) await setUrgencyBadge(tasks.length > 0, version);
      if (revision === version && (await readSettings()).monitorEnabled && tasks[0] && tasks[0].context === 'alert') await notify('Tarea urgente · ElrikPiro',tasks[0].description.slice(0,500));
    }
    await write(() => api(native.storage.local,'set',{[STATUS]:{updatedAt:new Date().toISOString(),ok:true,status:response.status}}));
  }
  function reconcile() {
    if (reconciliation) return reconciliation;
    reconciliation = api(native.alarms,'get',ALARM).then(alarm => {
      if (!alarm || alarm.periodInMinutes !== 5) return api(native.alarms,'create',ALARM,{delayInMinutes:5,periodInMinutes:5});
    }).catch(() => write(() => api(native.storage.local,'set',{[STATUS]:{updatedAt:new Date().toISOString(),...failure('invalid-response','No se pudo reconciliar la alarma del monitor')}}))).catch(() => {}).finally(() => {reconciliation = null;});
    return reconciliation;
  }
  function reconcileUrgencyAlarm() {
    if (urgencyReconciliation) return urgencyReconciliation;
    urgencyReconciliation = api(native.alarms,'get',URGENCY_ALARM).then(alarm => {
      if (!alarm || alarm.periodInMinutes !== 5) return api(native.alarms,'create',URGENCY_ALARM,{delayInMinutes:5,periodInMinutes:5});
    }).catch(() => {}).finally(() => { urgencyReconciliation = null; });
    return urgencyReconciliation;
  }

  native.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const requestId = message && typeof message.requestId === 'string' && message.requestId.length <= 200 ? message.requestId : null;
    Promise.resolve().then(() => handle(message,sender)).then(reply => sendResponse({...reply,requestId}),error => sendResponse({...resultError(error),requestId}));
    return true;
  });
  native.alarms.onAlarm.addListener(alarm => {
    if (alarm && alarm.name === URGENCY_ALARM) {
      if (urgencyBusy) return;
      urgencyBusy = true;
      enqueue(async () => {
        const settings = await readSettings();
        const version = revision;
        if (!settings.monitorEnabled || !settings.serverUrl || !settings.token) {
          await setUrgencyBadge(false, version);
          return;
        }
        await refreshUrgency(settings, version);
      }).catch(() => {}).finally(() => { urgencyBusy = false; });
      return;
    }
    if (!alarm || alarm.name !== ALARM || monitorBusy) return;
    monitorBusy = true;
    enqueue(async () => {
      const settings = await readSettings();
      if (!settings.monitorEnabled || !settings.serverUrl || !settings.token) return;
      await monitor();
    }).catch(error => write(() => api(native.storage.local,'set',{[STATUS]:{updatedAt:new Date().toISOString(),...resultError(error)}}))).catch(() => {}).finally(() => {monitorBusy = false;});
  });
  native.runtime.onInstalled.addListener(() => { reconcile(); reconcileUrgencyAlarm(); restoreUrgencyBadge(); });
  native.runtime.onStartup.addListener(() => { reconcile(); reconcileUrgencyAlarm(); restoreUrgencyBadge(); });
  reconcile();
  reconcileUrgencyAlarm();
  restoreUrgencyBadge();
})();
