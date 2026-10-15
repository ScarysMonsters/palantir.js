'use strict';

/**
 * Bun-native WebSocket adapter exposing the subset of the `ws` API used by this library.
 * Zero dependency: JSON only (no erlpack/zlib-sync native addons required).
 */

const { Buffer } = require('node:buffer');

const NativeWebSocket = globalThis.WebSocket;

const STATE = {
  CONNECTING: 0,
  OPEN: 1,
  CLOSING: 2,
  CLOSED: 3,
};

function normalizeData(data) {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  return data;
}

/**
 * Minimal EventEmitter-style + browser-style WebSocket wrapper.
 */
class WebSocket {
  static CONNECTING = STATE.CONNECTING;
  static OPEN = STATE.OPEN;
  static CLOSING = STATE.CLOSING;
  static CLOSED = STATE.CLOSED;

  constructor(url, protocolsOrOptions, maybeOptions) {
    let protocols = protocolsOrOptions;
    let options = maybeOptions ?? {};
    if (protocolsOrOptions && typeof protocolsOrOptions === 'object' && !Array.isArray(protocolsOrOptions)) {
      options = protocolsOrOptions;
      protocols = options.protocols;
    }

    this.url = url;
    this.readyState = WebSocket.CONNECTING;
    this.listeners = new Map();

    /** @type {?Function} */
    this.onopen = null;
    /** @type {?Function} */
    this.onmessage = null;
    /** @type {?Function} */
    this.onerror = null;
    /** @type {?Function} */
    this.onclose = null;

    const nativeOptions = {};
    if (options.headers) nativeOptions.headers = options.headers;
    const proxy = options.proxy ?? options.agent?.proxy ?? options.agent?.uri;
    if (typeof proxy === 'string') nativeOptions.proxy = proxy;

    this._ws =
      protocols !== undefined ? new NativeWebSocket(url, protocols, nativeOptions) : new NativeWebSocket(url, nativeOptions);
    try {
      this._ws.binaryType = 'arraybuffer';
    } catch {}
    this._handshakeTimeout = null;

    if (options.handshakeTimeout > 0) {
      this._handshakeTimeout = setTimeout(() => {
        if (this.readyState === WebSocket.CONNECTING) {
          this._emit('error', new Error('Opening handshake has timed out'));
          this.terminate();
        }
      }, options.handshakeTimeout);
      this._handshakeTimeout.unref?.();
    }

    this._ws.addEventListener('open', event => {
      this._clearHandshakeTimeout();
      this.readyState = WebSocket.OPEN;
      this._emit('open', event);
      if (typeof this.onopen === 'function') this.onopen(event);
    });

    this._ws.addEventListener('message', event => {
      const dispatch = raw => {
        const data = normalizeData(raw);
        const normalized = { ...event, data, target: this, type: 'message' };
        Object.defineProperty(normalized, 'data', { value: data, enumerable: true });
        this._emit('message', data, normalized);
        if (typeof this.onmessage === 'function') this.onmessage(normalized);
      };
      if (typeof Blob !== 'undefined' && event.data instanceof Blob) {
        event.data.arrayBuffer().then(dispatch, error => this._emit('error', error, event));
      } else {
        dispatch(event.data);
      }
    });

    this._ws.addEventListener('error', event => {
      const error = event instanceof Error ? event : Object.assign(new Error('WebSocket error'), { event });
      this._emit('error', error, event);
      if (typeof this.onerror === 'function') this.onerror(error);
    });

    this._ws.addEventListener('close', event => {
      this._clearHandshakeTimeout();
      this.readyState = WebSocket.CLOSED;
      const closeEvent = {
        type: 'close',
        code: event.code,
        reason: event.reason,
        wasClean: event.wasClean,
        target: this,
      };
      this._emit('close', closeEvent.code, closeEvent.reason, closeEvent);
      if (typeof this.onclose === 'function') this.onclose(closeEvent);
    });
  }

  get bufferedAmount() {
    return this._ws.bufferedAmount ?? 0;
  }

  get protocol() {
    return this._ws.protocol ?? '';
  }

  _clearHandshakeTimeout() {
    if (this._handshakeTimeout) {
      clearTimeout(this._handshakeTimeout);
      this._handshakeTimeout = null;
    }
  }

  _emit(eventName, ...args) {
    const handlers = this.listeners.get(eventName);
    if (!handlers) return;
    for (const handler of [...handlers]) {
      try {
        handler(...args);
      } catch (error) {
        if (eventName !== 'error') this._emit('error', error);
      }
    }
  }

  /**
   * EventEmitter-style listener registration.
   * @param {string} eventName The event name
   * @param {Function} listener The listener
   * @returns {this}
   */
  on(eventName, listener) {
    if (!this.listeners.has(eventName)) this.listeners.set(eventName, new Set());
    this.listeners.get(eventName).add(listener);
    return this;
  }

  /**
   * @param {string} eventName The event name
   * @param {Function} listener The listener
   * @returns {this}
   */
  addListener(eventName, listener) {
    return this.on(eventName, listener);
  }

  /**
   * @param {string} eventName The event name
   * @param {Function} listener The listener
   * @returns {this}
   */
  once(eventName, listener) {
    const wrapper = (...args) => {
      this.off(eventName, wrapper);
      listener(...args);
    };
    return this.on(eventName, wrapper);
  }

  /**
   * @param {string} eventName The event name
   * @param {Function} listener The listener
   * @returns {this}
   */
  off(eventName, listener) {
    this.listeners.get(eventName)?.delete(listener);
    return this;
  }

  /**
   * @param {string} eventName The event name
   * @param {Function} listener The listener
   * @returns {this}
   */
  removeListener(eventName, listener) {
    return this.off(eventName, listener);
  }

  /**
   * @param {string} [eventName] The event name, defaults to all events
   * @returns {this}
   */
  removeAllListeners(eventName) {
    if (eventName === undefined) this.listeners.clear();
    else this.listeners.delete(eventName);
    return this;
  }

  /**
   * Sends data over the socket.
   * @param {string|Buffer|ArrayBuffer|Uint8Array} data The data to send
   * @param {Object} [options] Ignored ws options (kept for API compatibility)
   * @param {Function} [callback] Callback invoked once the data has been flushed
   * @returns {void}
   */
  send(data, options, callback) {
    if (typeof options === 'function') {
      callback = options;
      options = undefined;
    }
    if (typeof data === 'string' || data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
      try {
        this._ws.send(data);
        if (typeof callback === 'function') callback(null);
      } catch (error) {
        if (typeof callback === 'function') callback(error);
        else this._emit('error', error);
      }
      return;
    }
    // Anything else (objects) is serialized as JSON, mirroring ws's behavior for JSON gateway packets.
    try {
      this._ws.send(JSON.stringify(data));
      if (typeof callback === 'function') callback(null);
    } catch (error) {
      if (typeof callback === 'function') callback(error);
      else this._emit('error', error);
    }
  }

  /**
   * Closes the connection.
   * @param {number} [code] Close code
   * @param {string} [reason] Close reason
   * @returns {void}
   */
  close(code, reason) {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSING;
    try {
      this._ws.close(code, reason);
    } catch {
      this._ws.close();
    }
  }

  /**
   * Forcefully terminates the connection.
   * @returns {void}
   */
  terminate() {
    this._clearHandshakeTimeout();
    this.readyState = WebSocket.CLOSED;
    try {
      this._ws.terminate();
    } catch {
      try {
        this._ws.close();
      } catch {}
    }
  }

  /**
   * Sends a ping frame.
   * @param {*} [data] Ping payload
   * @returns {void}
   */
  ping(data) {
    this._ws.ping?.(data);
  }

  /**
   * Sends a pong frame.
   * @param {*} [data] Pong payload
   * @returns {void}
   */
  pong(data) {
    this._ws.pong?.(data);
  }
}

exports.WebSocket = WebSocket;

const ab = new TextDecoder();

exports.encoding = 'json';

exports.pack = JSON.stringify;

exports.unpack = (data, type) => {
  if (typeof data !== 'string') {
    if (!(data instanceof Uint8Array)) data = new Uint8Array(data);
    data = ab.decode(data);
  }
  return JSON.parse(data);
};

exports.create = (gateway, query = {}, ...args) => {
  const [g, q] = gateway.split('?');
  query.encoding = exports.encoding;
  query = new URLSearchParams(query);
  if (q) new URLSearchParams(q).forEach((v, k) => query.set(k, v));
  const ws = new exports.WebSocket(`${g}?${query}`, ...args);
  return ws;
};

for (const state of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) exports[state] = exports.WebSocket[state];
