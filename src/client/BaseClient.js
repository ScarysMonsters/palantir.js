'use strict';

const EventEmitter = require('node:events');
const process = require('node:process');
const RESTManager = require('../rest/RESTManager');
const Options = require('../util/Options');
const Util = require('../util/Util');

/**
 * The base class for all clients.
 * @extends {EventEmitter}
 */
class BaseClient extends EventEmitter {
  constructor(options = {}) {
    super({ captureRejections: true });

    /**
     * With `captureRejections`, a rejected promise returned by an asynchronous event listener is
     * re-emitted as an `error` event. Without a listener, Node (and Bun) throws and kills the
     * whole process — a single failed API call in a `ready`/`messageCreate` handler would take
     * the client offline. Keep a permanent fallback listener so those errors are surfaced through
     * `debug` (or stderr) instead of crashing.
     * @private
     */
    this.on('error', error => {
      const info = `[ClientError] ${error?.stack ?? error}`;
      if (this.listenerCount('debug') > 0) this.emit('debug', info);
      else console.error(info);
    });

    if (options.intents) {
      process.emitWarning('Intents is not available.', 'DeprecationWarning');
    }

    /**
     * The options the client was instantiated with
     * @type {ClientOptions}
     */
    this.options = Util.mergeDefault(Options.createDefault(), options);

    /**
     * The REST manager of the client
     * @type {RESTManager}
     * @private
     */
    this.rest = new RESTManager(this);
  }

  /**
   * API shortcut
   * @type {Object}
   * @readonly
   * @private
   */
  get api() {
    return this.rest.api;
  }

  /**
   * Destroys all assets used by the base client.
   * @returns {void}
   */
  destroy() {
    if (this.rest.sweepInterval) clearInterval(this.rest.sweepInterval);
  }

  /**
   * Increments max listeners by one, if they are not zero.
   * @private
   */
  incrementMaxListeners() {
    const maxListeners = this.getMaxListeners();
    if (maxListeners !== 0) {
      this.setMaxListeners(maxListeners + 1);
    }
  }

  /**
   * Decrements max listeners by one, if they are not zero.
   * @private
   */
  decrementMaxListeners() {
    const maxListeners = this.getMaxListeners();
    if (maxListeners !== 0) {
      this.setMaxListeners(maxListeners - 1);
    }
  }

  toJSON(...props) {
    return Util.flatten(this, { domain: false }, ...props);
  }
}

module.exports = BaseClient;

/**
 * Emitted for general debugging information.
 * @event BaseClient#debug
 * @param {string} info The debug information
 */
