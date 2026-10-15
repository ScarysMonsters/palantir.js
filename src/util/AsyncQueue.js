'use strict';

/**
 * A queue that ensures asynchronous tasks are executed sequentially.
 * Zero dependency replacement for `@sapphire/async-queue`.
 */
class AsyncQueue {
  constructor() {
    this.promises = [];
    this.remaining = 0;
  }

  /**
   * The last promise in the queue.
   * @type {Promise<void>}
   * @readonly
   */
  get last() {
    return this.promises.length > 0 ? this.promises[this.promises.length - 1].promise : Promise.resolve();
  }

  /**
   * Returns a promise that resolves when it is safe for the next task to run.
   * @returns {Promise<void>}
   */
  async wait() {
    this.remaining++;
    const previous = this.promises[this.promises.length - 1];
    let resolve;
    const promise = new Promise(r => (resolve = r));
    this.promises.push({ promise, resolve });
    if (previous) await previous.promise;
  }

  /**
   * Signals that a task has completed, allowing the next waiting task to run.
   * @returns {void}
   */
  shift() {
    if (this.remaining === 0) return;
    const entry = this.promises.shift();
    this.remaining--;
    entry?.resolve();
  }
}

module.exports = { AsyncQueue };
