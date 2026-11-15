import { MODULE_ID } from '../config.mjs';
import { registerAPI } from './runtime.mjs';

const RAW_CHANNEL = `module.${MODULE_ID}`;

const _rawHandlers = new Map();

/**
 * Register a handler for raw `module.showstopper` socket messages.
 * Messages must carry `ns` (namespace) matching the registered key.
 * Re-registration overwrites the previous handler.
 */
export function registerRawHandler(ns, fn) {
  if (typeof fn !== 'function') return;
  _rawHandlers.set(ns, fn);
}

/**
 * Compat alias for the former socketlib registration: named handler,
 * first registration wins.
 */
export function registerSocketHandler(name, fn) {
  if (typeof fn !== 'function') {
    console.error(`${MODULE_ID} | registerSocketHandler: handler for '${name}' is not a function`);
    return;
  }
  if (_rawHandlers.has(name)) return;
  _rawHandlers.set(name, fn);
}

/**
 * Removes a named handler registered via `registerSocketHandler` (no-op if
 * not found). Used to roll back registrations during teardown
 * (`effectRegistry.unregister`); the underlying socket listener stays attached —
 * deleting the Map entry is sufficient.
 */
export function unregisterSocketHandler(name) {
  _rawHandlers.delete(name);
}

/**
 * Send a raw socket message under a namespace to all OTHER clients.
 * The `ns` field is injected into the payload automatically. The native
 * socket does not echo back to the sender — local execution is up to the
 * caller (see emitAll).
 */
export function emitRaw(ns, payload) {
  // Place ns/toGM AFTER the spread so payload keys cannot override routing
  game.socket.emit(RAW_CHANNEL, { ...payload, ns });
}

/**
 * Broadcast under a namespace: all OTHER clients plus this one (the local
 * handler runs under the same error guard as remote ones). Equivalent of
 * socketlib's executeForEveryone — fire-and-forget, resolves right after
 * dispatch, handler promises are not awaited.
 */
export function emitAll(ns, payload) {
  const data = { ...payload, ns };
  game.socket.emit(RAW_CHANNEL, data);
  _runRawHandler(ns, data);
}

/**
 * Execute a handler on connected GM clients (and locally if the sender is
 * the GM). Equivalent of socketlib's executeAsGM — fire-and-forget. No-ops
 * with a warning when no GM is connected.
 */
export function emitGM(ns, payload) {
  const gmOnline = game.users?.some((u) => u.isGM && u.active) ?? game.user.isGM;
  if (!gmOnline) {
    console.warn(`${MODULE_ID} | emitGM('${ns}'): no GM is connected, action skipped`);
    return;
  }
  const data = { ...payload, ns, toGM: true };
  game.socket.emit(RAW_CHANNEL, data);
  if (game.user.isGM) _runRawHandler(ns, data);
}

function _runRawHandler(ns, data) {
  const handler = _rawHandlers.get(ns);
  if (typeof handler !== 'function') return;
  try {
    handler(data);
  } catch (e) {
    console.error(`${MODULE_ID} | Raw socket handler '${ns}' failed:`, e);
  }
}

function _onRawSocketMessage(data) {
  if (!data || typeof data !== 'object') return;
  if (data.toGM && !game.user.isGM) return;
  if (typeof data.ns !== 'string') return;
  _runRawHandler(data.ns, data);
}

Hooks.once('ready', () => {
  game.socket.on(RAW_CHANNEL, _onRawSocketMessage);
});

/**
 * Compatibility facade repeating the subset of the socketlib API the module
 * uses (register / executeForEveryone / executeAsGM), but running entirely
 * over the native `module.showstopper` channel — the socketlib module is
 * NOT used. Always available, never null.
 */
const _socketShim = Object.freeze({
  register(name, fn) {
    registerSocketHandler(name, fn);
  },
  executeForEveryone(ns, payload) {
    emitAll(ns, payload ?? {});
  },
  executeForOthers(ns, payload) {
    emitRaw(ns, payload ?? {});
  },
  executeAsGM(ns, payload) {
    emitGM(ns, payload ?? {});
  }
});

/**
 * Returns the module's socket facade backed by the native game.socket
 * channel. Kept as a stable entry point for the many existing callers.
 */
export function getSocket() {
  return _socketShim;
}

registerAPI('socketSdk', {
  getSocket,
  registerSocketHandler,
  unregisterSocketHandler,
  registerRawHandler,
  emitRaw,
  emitAll,
  emitGM
});
