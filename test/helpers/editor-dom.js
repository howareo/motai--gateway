// Small event DOM for the editor contract tests; loads the production template.
// It intentionally does not emulate browser layout, focus traps or native validity.
export function editorDOM(html, templateId = 'gateway-channel-template') {
  const document = { activeElement: null, createElement: (tag) => new Element(tag) };
  class Element {
    constructor(tag, attributes = {}) {
      this.tagName = tag.toUpperCase(); this.attributes = attributes; this.children = []; this.parentNode = null;
      this.ownerDocument = document; this.listeners = new Map(); this.value = attributes.value || '';
      this.type = attributes.type || ''; this.name = attributes.name || ''; this.hidden = 'hidden' in attributes;
      this.disabled = false; this.checked = false; this.isConnected = true; this.textContent = ''; this.scrollTop = 0;
      this.dataset = Object.fromEntries(Object.entries(attributes).filter(([key]) => key.startsWith('data-'))
        .map(([key, value]) => [key.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()), value]));
    }
    append(...nodes) { for (const node of nodes) { node.parentNode = this; this.children.push(node); } }
    add(node) { this.append(node); }
    replaceChildren(...nodes) { for (const child of this.children) child.isConnected = false; this.children = []; this.append(...nodes); }
    setAttribute(name, value) { this.attributes[name] = value; }
    getAttribute(name) { return this.attributes[name]; }
    matches(selector) {
      if (selector === ':invalid') return Boolean(this.invalid);
      if (selector.startsWith('#')) return this.attributes.id === selector.slice(1);
      if (selector.startsWith('.')) return (this.className || this.attributes.class || '').split(/\s+/).includes(selector.slice(1));
      const attribute = selector.match(/^\[([^=\]]+)(?:="([^"]*)")?\]$/);
      if (attribute) return attribute[1] in this.attributes && (attribute[2] === undefined || this.attributes[attribute[1]] === attribute[2]);
      return this.tagName.toLowerCase() === selector;
    }
    querySelectorAll(selector) {
      return this.children.flatMap((child) => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]);
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    closest(selector) { return this.matches(selector) ? this : this.parentNode?.closest(selector); }
    contains(node) { return node === this || this.children.some((child) => child.contains(node)); }
    addEventListener(type, action) { this.listeners.set(type, [...(this.listeners.get(type) || []), action]); }
    async dispatch(type, properties = {}) {
      const event = { target: this, currentTarget: this, defaultPrevented: false,
        preventDefault() { this.defaultPrevented = true; }, ...properties };
      for (const action of this.listeners.get(type) || []) await action(event);
      return event;
    }
    focus() { document.activeElement = this; }
    getBoundingClientRect() { return { top: 0 }; }
    reportValidity() { this.validityReported = true; }
    showModal() { this.open = true; }
    close() { this.open = false; this.onclose?.(); }
    cloneNode() {
      const node = new Element(this.tagName, { ...this.attributes }); node.textContent = this.textContent;
      for (const child of this.children) node.append(child.cloneNode(true)); return node;
    }
  }
  const root = new Element('fragment'), stack = [root];
  const source = html.match(new RegExp(`<template id="${templateId}">([\\s\\S]*?)<\\/template>`))[1];
  for (const token of source.matchAll(/<\/?[\w-]+\b[^>]*>/g)) {
    const text = token[0], tag = text.match(/^<\/?([\w-]+)/)[1];
    if (text.startsWith('</')) { stack.pop(); continue; }
    const attributes = Object.fromEntries([...text.slice(tag.length + 1, -1).matchAll(/([\w-]+)(?:="([^"]*)")?/g)].map((item) => [item[1], item[2] || '']));
    const node = new Element(tag, attributes); stack.at(-1).append(node);
    if (!['input', 'br', 'hr', 'img'].includes(tag)) stack.push(node);
  }
  return { document, dialog: new Element('dialog'), template: { content: root }, trigger: new Element('button') };
}
