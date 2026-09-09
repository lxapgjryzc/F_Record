/**
 * The smallest DOM preact will run against, plus enough of a query API to
 * write readable assertions about what the panel rendered.
 *
 * Why not jsdom: this repository has no test dependencies at all, and the
 * panel runs in Chromium 61 on Photoshop 2020 -- a browser jsdom does not
 * model either. What preact 10 actually touches is small and documented by
 * its own source: createElement/createElementNS/createTextNode, the four
 * tree-mutation calls, setAttribute/removeAttribute, add/removeEventListener,
 * `style`, and a handful of properties it prefers over attributes. All of that
 * is below, and nothing else is pretended.
 *
 * Effects are the other half. preact schedules them through
 * `options.requestAnimationFrame` when one is set, so `flush()` drives them
 * directly instead of racing a real frame.
 */

import { options } from "preact";
import { render as preactRender } from "preact";

/* ---------------------------------------------------------------- the tree */

const DOM_EVENTS = ["blur", "change", "click", "dblclick", "focus", "input", "keydown", "mousedown", "submit"];

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

class FakeNode {
    constructor(nodeType) {
        this.nodeType = nodeType;
        this.childNodes = [];
        this.parentNode = null;
    }

    get firstChild() {
        return this.childNodes[0] || null;
    }

    get nextSibling() {
        if (!this.parentNode) {
            return null;
        }
        const siblings = this.parentNode.childNodes;
        return siblings[siblings.indexOf(this) + 1] || null;
    }

    appendChild(child) {
        return this.insertBefore(child, null);
    }

    insertBefore(child, reference) {
        if (child.parentNode) {
            child.parentNode.removeChild(child);
        }
        const at = reference ? this.childNodes.indexOf(reference) : -1;
        if (at === -1) {
            this.childNodes.push(child);
        } else {
            this.childNodes.splice(at, 0, child);
        }
        child.parentNode = this;
        return child;
    }

    removeChild(child) {
        const at = this.childNodes.indexOf(child);
        if (at !== -1) {
            this.childNodes.splice(at, 1);
            child.parentNode = null;
        }
        return child;
    }

    remove() {
        if (this.parentNode) {
            this.parentNode.removeChild(this);
        }
    }
}

class FakeText extends FakeNode {
    constructor(data) {
        super(TEXT_NODE);
        this.data = String(data);
    }
}

/** `el.style.foo = "1px"` and `setProperty`, both of which preact uses. */
class FakeStyle {
    constructor() {
        this.cssText = "";
    }

    setProperty(name, value) {
        this[name] = value;
    }
}

/** `classList`, backed by the same string `className` is. */
class FakeClassList {
    constructor(element) {
        this.element = element;
    }

    get names() {
        return String(this.element.className || "").split(/\s+/).filter(Boolean);
    }

    add(name) {
        const names = this.names;
        if (names.indexOf(name) === -1) {
            names.push(name);
            this.element.className = names.join(" ");
        }
    }

    remove(name) {
        this.element.className = this.names.filter((each) => each !== name).join(" ");
    }

    contains(name) {
        return this.names.indexOf(name) !== -1;
    }
}

class FakeElement extends FakeNode {
    constructor(localName, namespaceURI) {
        super(ELEMENT_NODE);
        this.localName = localName;
        this.nodeName = String(localName).toUpperCase();
        this.namespaceURI = namespaceURI || null;
        this.attributes = Object.create(null);
        this.style = new FakeStyle();
        this.eventListeners = Object.create(null);
        this.classList = new FakeClassList(this);

        // preact writes a prop as a property when the name is already on the
        // element and falls back to setAttribute when it is not, so this list
        // is what decides which side of that line each one lands on. These are
        // the ones the panel reads back -- `input.checked`, `select.value` --
        // and everything else stays an attribute, where a test can see it.
        this.className = "";
        this.id = "";
        this.value = "";
        this.checked = false;
        this.disabled = false;

        // preact decides an event's registered name by whether the lowercase
        // `onclick` form is already on the element: present, and it listens
        // for "click"; absent, and it listens for "Click" instead. These are
        // the events the panel binds.
        for (const name of DOM_EVENTS) {
            this["on" + name] = undefined;
        }
    }

    setAttribute(name, value) {
        if (name === "class") {
            this.className = String(value);
            return;
        }
        this.attributes[name] = String(value);
    }

    removeAttribute(name) {
        if (name === "class") {
            this.className = "";
            return;
        }
        delete this.attributes[name];
    }

    getAttribute(name) {
        if (name === "class") {
            return this.className || null;
        }
        return name in this.attributes ? this.attributes[name] : null;
    }

    addEventListener(type, handler) {
        (this.eventListeners[type] || (this.eventListeners[type] = [])).push(handler);
    }

    removeEventListener(type, handler) {
        const list = this.eventListeners[type];
        if (!list) {
            return;
        }
        const at = list.indexOf(handler);
        if (at !== -1) {
            list.splice(at, 1);
        }
    }

    /** preact clears a node this way before replacing its children. */
    set innerHTML(value) {
        this.childNodes.slice().forEach((child) => this.removeChild(child));
        this.rawHtml = String(value);
    }

    get innerHTML() {
        return this.rawHtml || "";
    }
}

/* ------------------------------------------------------------- installing */

/**
 * Puts a document, a window and a preact effect queue on the globals, and
 * hands back the container to render into.
 *
 * Everything is undone by `cleanup`, so one test file can mount many panels
 * without them seeing each other.
 */
export function installDom() {
    const documentElement = new FakeElement("html");
    const body = new FakeElement("body");
    documentElement.appendChild(body);

    const byId = Object.create(null);
    const document = {
        documentElement,
        body,
        createElement: (type) => new FakeElement(type, null),
        createElementNS: (namespace, type) => new FakeElement(type, namespace),
        createTextNode: (data) => new FakeText(data),
        getElementById: (id) => byId[id] || null,
        register: (id, element) => {
            byId[id] = element;
        }
    };

    const windowListeners = Object.create(null);
    const window = {
        document,
        addEventListener(type, handler) {
            (windowListeners[type] || (windowListeners[type] = [])).push(handler);
        },
        removeEventListener(type, handler) {
            const list = windowListeners[type];
            const at = list ? list.indexOf(handler) : -1;
            if (at !== -1) {
                list.splice(at, 1);
            }
        }
    };

    // preact defers effects through this when it is set, so the test decides
    // when they run rather than waiting on a frame that never comes.
    const effects = [];
    const savedRaf = options.requestAnimationFrame;
    options.requestAnimationFrame = (callback) => {
        effects.push(callback);
    };

    // And it batches re-renders onto a microtask. Rendering as soon as state
    // changes is what preact's own test-utils do, and it means a test can
    // click a switch and look at it on the next line.
    const savedDebounce = options.debounceRendering;
    options.debounceRendering = (process) => process();

    const saved = { document: globalThis.document, window: globalThis.window };
    globalThis.document = document;
    globalThis.window = window;

    return {
        document,
        window,
        body,
        /** Fires whatever the window is listening for, as the panel would. */
        fireWindow(type, init) {
            for (const handler of (windowListeners[type] || []).slice()) {
                handler(Object.assign({ type }, init));
            }
        },
        windowListenerCount: (type) => (windowListeners[type] || []).length,
        /** Runs every deferred effect, then lets the promises they made settle. */
        async flush(times = 6) {
            for (let round = 0; round < times; round++) {
                while (effects.length > 0) {
                    effects.shift()();
                }
                await Promise.resolve();
                await new Promise((resolve) => setTimeout(resolve, 0));
            }
            while (effects.length > 0) {
                effects.shift()();
            }
        },
        cleanup() {
            options.requestAnimationFrame = savedRaf;
            options.debounceRendering = savedDebounce;
            for (const key of ["document", "window"]) {
                if (saved[key] === undefined) {
                    delete globalThis[key];
                } else {
                    globalThis[key] = saved[key];
                }
            }
        }
    };
}

/** Renders `vnode` into a fresh container and returns it. */
export function mount(dom, vnode) {
    const container = dom.document.createElement("div");
    dom.body.appendChild(container);
    preactRender(vnode, container);
    return container;
}

export function unmount(dom, container) {
    preactRender(null, container);
}

/* ----------------------------------------------------------------- finding */

/** Every element under `root`, including it. */
export function all(root) {
    const found = [];
    const walk = (node) => {
        if (node.nodeType === ELEMENT_NODE) {
            found.push(node);
        }
        for (const child of node.childNodes) {
            walk(child);
        }
    };
    walk(root);
    return found;
}

/** The visible text of a node and everything under it. */
export function textOf(node) {
    if (node.nodeType === TEXT_NODE) {
        return node.data;
    }
    return node.childNodes.map(textOf).join("");
}

function matchesOne(element, selector) {
    let rest = selector;
    const tag = /^[a-zA-Z][a-zA-Z0-9-]*/.exec(rest);
    if (tag) {
        if (element.localName !== tag[0]) {
            return false;
        }
        rest = rest.slice(tag[0].length);
    }
    for (;;) {
        if (rest.length === 0) {
            return true;
        }
        const cls = /^\.([A-Za-z0-9_-]+)/.exec(rest);
        if (cls) {
            if (!element.classList.contains(cls[1])) {
                return false;
            }
            rest = rest.slice(cls[0].length);
            continue;
        }
        const attr = /^\[([A-Za-z0-9_:-]+)(?:="([^"]*)")?\]/.exec(rest);
        if (attr) {
            const value = element.getAttribute(attr[1]);
            if (value === null || (attr[2] !== undefined && value !== attr[2])) {
                return false;
            }
            rest = rest.slice(attr[0].length);
            continue;
        }
        throw new Error("unsupported selector: " + selector);
    }
}

/**
 * Splits a descendant chain on the spaces between its steps, and not on the
 * ones inside `[aria-label="Aspect ratio"]`.
 */
function steps(selector) {
    const found = [];
    let current = "";
    let inBrackets = false;
    for (const character of selector.trim()) {
        if (character === "[") {
            inBrackets = true;
        } else if (character === "]") {
            inBrackets = false;
        }
        if (/\s/.test(character) && !inBrackets) {
            if (current.length > 0) {
                found.push(current);
                current = "";
            }
            continue;
        }
        current += character;
    }
    if (current.length > 0) {
        found.push(current);
    }
    return found;
}

/**
 * A deliberately small selector engine: tag, `.class`, `[attr]`,
 * `[attr="value"]`, and descendant chains of those.
 */
export function queryAll(root, selector) {
    const parts = steps(selector);
    let current = all(root);
    for (let i = 0; i < parts.length; i++) {
        const matched = current.filter((element) => matchesOne(element, parts[i]));
        if (i === parts.length - 1) {
            return matched;
        }
        current = matched.reduce((acc, element) => acc.concat(all(element).filter((e) => e !== element)), []);
    }
    return current;
}

export function query(root, selector) {
    const found = queryAll(root, selector);
    return found.length > 0 ? found[0] : null;
}

/** The one element whose own text is exactly `text`, or null. */
export function byText(root, text) {
    return all(root).filter((element) => textOf(element).trim() === text).pop() || null;
}

/* ----------------------------------------------------------------- events */

/**
 * Dispatches `type` at `element` and lets it bubble, the way a browser does.
 *
 * preact attaches its handlers to the element itself, so bubbling only
 * matters where the panel puts a handler on a parent -- but it does, and a
 * click that did not bubble would silently do nothing.
 */
export function fire(element, type, init) {
    const event = Object.assign(
        {
            type,
            target: element,
            defaultPrevented: false,
            preventDefault() {
                event.defaultPrevented = true;
            },
            stopPropagation() {
                event.propagationStopped = true;
            }
        },
        init
    );
    for (let node = element; node; node = node.parentNode) {
        event.currentTarget = node;
        for (const handler of (node.eventListeners && node.eventListeners[type]
            ? node.eventListeners[type]
            : []
        ).slice()) {
            handler.call(node, event);
        }
        if (event.propagationStopped) {
            break;
        }
    }
    return event;
}

/** Clicks an element, failing loudly rather than silently doing nothing. */
export function click(element, init) {
    if (!element) {
        throw new Error("nothing to click");
    }
    if (element.disabled) {
        throw new Error("that " + element.localName + " is disabled");
    }
    return fire(element, "click", init);
}

/** Types into an input and tells the panel about it. */
export function typeInto(element, value) {
    element.value = value;
    return fire(element, "input", {});
}

/** Changes a select or a checkbox and tells the panel about it. */
export function choose(element, value) {
    if (typeof value === "boolean") {
        element.checked = value;
    } else {
        element.value = value;
    }
    return fire(element, "change", {});
}
