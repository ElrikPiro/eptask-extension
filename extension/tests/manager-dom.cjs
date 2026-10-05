const fs = require("node:fs");
const path = require("node:path");

const extensionRoot = path.resolve(__dirname, "..");
const voidTags = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);

class FakeText {
  constructor(text) {
    this.textContent = String(text);
    this.parentNode = null;
  }
}

class FakeElement {
  constructor(tagName = "div", ownerDocument = null) {
    this.tagName = String(tagName).toUpperCase();
    this.ownerDocument = ownerDocument;
    this.parentNode = null;
    this.children = [];
    this.attributes = new Map();
    this.listeners = new Map();
    this.dataset = new Proxy({}, {
      get: (_target, property) => this.attributes.get(`data-${String(property).replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`),
      set: (_target, property, value) => {
        this.setAttribute(`data-${String(property).replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`, value);
        return true;
      },
    });
    this.classList = {
      add: (...names) => this._changeClasses((classes) => names.forEach((name) => classes.add(name))),
      remove: (...names) => this._changeClasses((classes) => names.forEach((name) => classes.delete(name))),
      contains: (name) => this.className.split(/\s+/).includes(name),
      toggle: (name, force) => {
        const classes = new Set(this.className.split(/\s+/).filter(Boolean));
        const shouldAdd = force === undefined ? !classes.has(name) : Boolean(force);
        if (shouldAdd) classes.add(name);
        else classes.delete(name);
        this.className = [...classes].join(" ");
        return shouldAdd;
      },
    };
    this.hidden = false;
    this.disabled = false;
    this.checked = false;
    this.selected = false;
    this.multiple = false;
    this.value = "";
    this.type = "";
    this.name = "";
    this.id = "";
    this.className = "";
    this._text = "";
    this._html = "";
  }

  _changeClasses(change) {
    const classes = new Set(this.className.split(/\s+/).filter(Boolean));
    change(classes);
    this.className = [...classes].join(" ");
  }

  set textContent(value) {
    this._text = value === null || value === undefined ? "" : String(value);
    this.children = [];
  }

  get textContent() {
    return this._text + this.children.map((child) => child.textContent || "").join("");
  }

  set innerHTML(value) {
    this._html = String(value ?? "");
    this.textContent = this._html;
  }

  get innerHTML() {
    return this._html || this.textContent;
  }

  setAttribute(name, value) {
    const normalized = String(name).toLowerCase();
    const text = String(value);
    this.attributes.set(normalized, text);
    if (normalized === "id") this.id = text;
    if (normalized === "class") this.className = text;
    if (normalized === "value") this.value = text;
    if (normalized === "type") this.type = text;
    if (normalized === "name") this.name = text;
    if (normalized === "hidden") this.hidden = true;
    if (normalized === "disabled") this.disabled = true;
    if (normalized === "checked") this.checked = true;
    if (normalized === "selected") this.selected = true;
  }

  getAttribute(name) {
    return this.attributes.get(String(name).toLowerCase()) ?? null;
  }

  hasAttribute(name) {
    return this.attributes.has(String(name).toLowerCase());
  }

  removeAttribute(name) {
    const normalized = String(name).toLowerCase();
    this.attributes.delete(normalized);
    if (normalized === "hidden") this.hidden = false;
    if (normalized === "disabled") this.disabled = false;
  }

  append(...nodes) {
    for (const child of nodes) this.appendChild(child);
  }

  prepend(...nodes) {
    for (const child of [...nodes].reverse()) {
      if (child.parentNode) child.parentNode.removeChild(child);
      child.parentNode = this;
      this.children.unshift(child);
    }
  }

  appendChild(child) {
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  replaceChildren(...nodes) {
    for (const child of this.children) child.parentNode = null;
    this.children = [];
    this._text = "";
    for (const child of nodes) this.appendChild(child);
  }

  removeChild(child) {
    const index = this.children.indexOf(child);
    if (index >= 0) this.children.splice(index, 1);
    child.parentNode = null;
    return child;
  }

  remove() {
    this.parentNode?.removeChild(this);
  }

  replaceWith(...nodes) {
    if (!this.parentNode) return;
    const parent = this.parentNode;
    const index = parent.children.indexOf(this);
    parent.removeChild(this);
    const prepared = nodes.map((child) => {
      if (child.parentNode) child.parentNode.removeChild(child);
      child.parentNode = parent;
      return child;
    });
    parent.children.splice(index, 0, ...prepared);
  }

  addEventListener(type, listener) {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  removeEventListener(type, listener) {
    const list = this.listeners.get(type) ?? [];
    this.listeners.set(type, list.filter((candidate) => candidate !== listener));
  }

  dispatchEvent(event) {
    const value = { bubbles: false, preventDefault() { this.defaultPrevented = true; }, ...event, target: event.target ?? this, currentTarget: this };
    for (const listener of this.listeners.get(value.type) ?? []) listener(value);
    if (value.bubbles && this.parentNode) this.parentNode.dispatchEvent(value);
    return !value.defaultPrevented;
  }

  click() {
    if (!this.disabled) this.dispatchEvent({ type: "click", bubbles: true });
  }

  submit() {
    this.dispatchEvent({ type: "submit", bubbles: true });
  }

  reportValidity() {
    return true;
  }

  focus() {
    if (this.ownerDocument) this.ownerDocument.activeElement = this;
    this.dispatchEvent({ type: "focus" });
  }

  blur() {
    if (this.ownerDocument?.activeElement === this) this.ownerDocument.activeElement = null;
    this.dispatchEvent({ type: "blur" });
  }

  matches(selector) {
    return matchesSelector(this, selector);
  }

  closest(selector) {
    let current = this;
    while (current) {
      if (current.matches?.(selector)) return current;
      current = current.parentNode;
    }
    return null;
  }

  querySelector(selector) {
    return queryWithin(this, selector, false)[0] ?? null;
  }

  querySelectorAll(selector) {
    return queryWithin(this, selector, false);
  }

  contains(node) {
    let current = node;
    while (current) {
      if (current === this) return true;
      current = current.parentNode;
    }
    return false;
  }

  get elements() {
    const controls = this.querySelectorAll("input,select,textarea,button");
    return {
      length: controls.length,
      namedItem: (name) => controls.find((control) => control.name === name) ?? null,
      [Symbol.iterator]: () => controls[Symbol.iterator](),
    };
  }

  get options() {
    return this.querySelectorAll("option");
  }

  get selectedOptions() {
    return this.options.filter((option) => option.selected);
  }

  get childElementCount() {
    return this.children.filter((child) => child instanceof FakeElement).length;
  }
}

class FakeDocument extends FakeElement {
  constructor() {
    super("document", null);
    this.ownerDocument = this;
    this.activeElement = null;
    this.documentElement = new FakeElement("html", this);
    this.body = new FakeElement("body", this);
    this.appendChild(this.documentElement);
    this.documentElement.appendChild(this.body);
  }

  createElement(tagName) {
    return new FakeElement(tagName, this);
  }

  createTextNode(text) {
    return new FakeText(text);
  }

  createDocumentFragment() {
    return new FakeElement("fragment", this);
  }

  getElementById(id) {
    return this.querySelector(`#${id}`);
  }

  hasFocus() {
    return true;
  }
}

function parseAttributes(raw, element) {
  const attributePattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  let match;
  while ((match = attributePattern.exec(raw))) {
    const name = match[1];
    if (name === "<" || name === "/") continue;
    const value = match[2] ?? match[3] ?? match[4] ?? "";
    element.setAttribute(name, value);
  }
}

function documentFromHtml(html) {
  const document = new FakeDocument();
  const stack = [document.body];
  const tokens = String(html).match(/<!--[\s\S]*?-->|<\/?[A-Za-z][^>]*>|[^<]+/g) ?? [];
  for (const token of tokens) {
    if (token.startsWith("<!--")) continue;
    const closing = token.match(/^<\/\s*([A-Za-z][\w-]*)/);
    if (closing) {
      const tag = closing[1].toUpperCase();
      while (stack.length > 1) {
        const popped = stack.pop();
        if (popped.tagName === tag) break;
      }
      continue;
    }
    const opening = token.match(/^<\s*([A-Za-z][\w-]*)\b([^>]*)>/);
    if (opening) {
      const element = document.createElement(opening[1]);
      parseAttributes(opening[2], element);
      stack.at(-1).appendChild(element);
      if (!voidTags.has(element.tagName.toLowerCase()) && !opening[2].trimEnd().endsWith("/")) stack.push(element);
      continue;
    }
    if (token) stack.at(-1).appendChild(new FakeText(token));
  }
  return document;
}

function splitSelector(selector) {
  const parts = [];
  let current = "";
  let depth = 0;
  for (const char of selector.trim()) {
    if (char === "[") depth += 1;
    if (char === "]") depth -= 1;
    if (/\s/.test(char) && depth === 0) {
      if (current) parts.push(current);
      current = "";
    } else current += char;
  }
  if (current) parts.push(current);
  return parts;
}

function matchesSimple(element, selector) {
  if (!(element instanceof FakeElement)) return false;
  // Attribute values can contain dots (for example name="changes.description").
  // Exclude attributes before looking for class selectors so dots in values are
  // not mistaken for CSS classes.
  const structuralSelector = selector.replace(/\[[^\]]*\]/g, "");
  const tag = structuralSelector.match(/^[A-Za-z][\w-]*/)?.[0];
  if (tag && element.tagName.toLowerCase() !== tag.toLowerCase()) return false;
  for (const id of structuralSelector.matchAll(/#([\w-]+)/g)) if (element.id !== id[1]) return false;
  for (const klass of structuralSelector.matchAll(/\.([\w-]+)/g)) if (!element.classList.contains(klass[1])) return false;
  for (const attribute of selector.matchAll(/\[([^\]=~^$*|]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\]]+)))?\]/g)) {
    const name = attribute[1].trim();
    const expected = attribute[2] ?? attribute[3] ?? attribute[4]?.trim();
    const propertyValue = name.startsWith("data-") ? element.dataset[name.slice(5).replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase())] : element[name];
    const actual = element.hasAttribute(name) ? element.getAttribute(name) : propertyValue;
    if (actual === null || actual === undefined || actual === false) return false;
    if (expected !== undefined && String(actual) !== expected) return false;
  }
  if (selector.endsWith(":checked") && !element.checked && !element.selected) return false;
  return true;
}

function matchesSelector(element, selector) {
  if (selector.includes(",")) return selector.split(",").some((part) => matchesSelector(element, part));
  const parts = splitSelector(selector);
  if (!parts.length || !matchesSimple(element, parts.at(-1))) return false;
  let ancestor = element.parentNode;
  for (let index = parts.length - 2; index >= 0; index -= 1) {
    while (ancestor && !matchesSimple(ancestor, parts[index])) ancestor = ancestor.parentNode;
    if (!ancestor) return false;
    ancestor = ancestor.parentNode;
  }
  return true;
}

function queryWithin(root, selector, includeRoot) {
  const matches = [];
  const selectors = String(selector).split(",").map((part) => part.trim()).filter(Boolean);
  const visit = (element) => {
    if (element instanceof FakeElement && selectors.some((part) => matchesSelector(element, part))) matches.push(element);
    for (const child of element.children ?? []) if (child instanceof FakeElement) visit(child);
  };
  if (includeRoot) visit(root);
  else for (const child of root.children ?? []) if (child instanceof FakeElement) visit(child);
  return matches;
}

class FakeFormData {
  constructor(form) {
    this.values = [];
    for (const control of form.elements) {
      if (!control.name || control.disabled) continue;
      if ((control.type === "checkbox" || control.type === "radio") && !control.checked) continue;
      if (control.tagName === "SELECT" && control.multiple) {
        for (const option of control.selectedOptions) this.values.push([control.name, option.value || option.textContent]);
      } else {
        this.values.push([control.name, control.value]);
      }
    }
  }

  get(name) {
    return this.values.find(([key]) => key === name)?.[1] ?? null;
  }

  getAll(name) {
    return this.values.filter(([key]) => key === name).map(([, value]) => value);
  }

  entries() {
    return this.values[Symbol.iterator]();
  }

  [Symbol.iterator]() {
    return this.entries();
  }
}

function loadExtensionDocument() {
  const html = fs.readFileSync(path.join(extensionRoot, "index.html"), "utf8");
  return documentFromHtml(html);
}

function flushMicrotasks() {
  return new Promise((resolve) => setImmediate(resolve));
}

module.exports = { FakeDocument, FakeElement, FakeFormData, documentFromHtml, flushMicrotasks, loadExtensionDocument };
