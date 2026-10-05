const namespace = globalThis.browser ?? globalThis.chrome;
const isPromiseNamespace = namespace === globalThis.browser;

if (!namespace) {
  throw new Error("Extension browser API is unavailable");
}

function invoke(owner, methodName, args = []) {
  const method = owner?.[methodName];
  if (typeof method !== "function") {
    return Promise.reject(new Error(`Browser API method is unavailable: ${methodName}`));
  }

  if (isPromiseNamespace) {
    try {
      return Promise.resolve(method.apply(owner, args));
    } catch (error) {
      return Promise.reject(error);
    }
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      callback(value);
    };
    const callback = (value) => {
      const lastError = namespace.runtime?.lastError;
      if (lastError) {
        finish(reject, new Error(lastError.message || "Browser API request failed"));
      } else {
        finish(resolve, value);
      }
    };

    try {
      const returned = method.apply(owner, [...args, callback]);
      if (returned && typeof returned.then === "function") {
        returned.then((value) => finish(resolve, value), (error) => finish(reject, error));
      } else if (returned !== undefined) {
        finish(resolve, returned);
      }
    } catch (error) {
      finish(reject, error);
    }
  });
}

export const browserApi = Object.freeze({
  runtime: Object.freeze({
    id: namespace.runtime.id,
    onMessage: namespace.runtime.onMessage,
    sendMessage: (message) => invoke(namespace.runtime, "sendMessage", [message]),
    openOptionsPage: () => invoke(namespace.runtime, "openOptionsPage"),
    getURL: (path) => namespace.runtime.getURL(path),
  }),
  tabs: Object.freeze({
    create: (properties) => invoke(namespace.tabs, "create", [properties]),
  }),
  permissions: Object.freeze({
    request: (details) => invoke(namespace.permissions, "request", [details]),
    contains: (details) => invoke(namespace.permissions, "contains", [details]),
    remove: (details) => invoke(namespace.permissions, "remove", [details]),
  }),
  storage: Object.freeze({
    local: Object.freeze({
      get: (keys) => invoke(namespace.storage?.local, "get", [keys]),
    }),
    onChanged: namespace.storage?.onChanged,
  }),
});
