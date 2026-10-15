'use strict';

const { setTimeout } = require('node:timers');

const DEFAULT_BASE_URL = 'https://api.nonecap.com';
const TERMINAL_STATUSES = new Set(['solved', 'failed', 'cancelled', 'expired']);
const FEEDBACK_OUTCOMES = new Set(['accepted', 'rejected', 'unknown', 'unused', 'error']);

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * @typedef {Object} NoneCapOptions
 * @property {string} [baseUrl=https://api.nonecap.com] API base URL
 * @property {string} [url=https://discord.com] Page URL the challenge is solved for
 * @property {boolean|string} [enterprise=auto] `true`, `false` or `auto` (enterprise when the captcha carries `rqdata`)
 * @property {?string} [userAgent] Overrides the user agent passed by the client
 * @property {?string} [proxy] Proxy used for the solve (`http://user:pass@host:port` or `host:port`)
 * @property {number} [waitSeconds=30] Server-side blocking wait (1-90) applied to each call
 * @property {number} [pollIntervalMs=2000] Delay between polls while a solve is in flight
 * @property {number} [maxPollMs=120000] Maximum total time to wait for a token
 */

/**
 * NoneCap (https://nonecap.com) hCaptcha solver, usable as the client `captchaSolver` hook.
 * Submits the challenge to the NoneCap API, polls until the solve is terminal and returns the
 * `P1_` token, ready to be sent back to Discord. The last terminal solve is kept on
 * {@link NoneCap#lastSolve} so `resp_key` and the solver `user_agent` stay available, and can be
 * reported to NoneCap with {@link NoneCap#report}.
 * @example
 * const { Client, NoneCap } = require("palantir.js");
 * const client = new Client({ captchaSolver: NoneCap.solver('nc_live_...') });
 */
class NoneCap {
  /**
   * @param {string} apiKey The NoneCap API key (`nc_live_...`)
   * @param {NoneCapOptions} [options] Solver options
   */
  constructor(apiKey, options = {}) {
    if (typeof apiKey !== 'string' || !apiKey) throw new Error('NONECAP_MISSING_API_KEY');

    /**
     * The API key used for requests
     * @type {string}
     */
    this.apiKey = apiKey;

    /**
     * The API base URL
     * @type {string}
     */
    this.baseUrl = String(options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');

    /**
     * The page URL the challenge is solved for
     * @type {string}
     */
    this.url = options.url ?? 'https://discord.com';

    /**
     * Enterprise mode: `true`, `false`, or `auto`
     * @type {boolean|string}
     */
    this.enterprise = options.enterprise ?? 'auto';

    /**
     * User agent override, defaults to the one passed by the client
     * @type {?string}
     */
    this.userAgent = options.userAgent ?? null;

    /**
     * Proxy used for the solve
     * @type {?string}
     */
    this.proxy = options.proxy ?? null;

    /**
     * Server-side blocking wait applied to each call
     * @type {number}
     */
    this.waitSeconds = Math.min(90, Math.max(1, Math.round(options.waitSeconds ?? 30)));

    /**
     * Delay between polls while a solve is in flight
     * @type {number}
     */
    this.pollIntervalMs = Math.max(250, options.pollIntervalMs ?? 2_000);

    /**
     * Maximum total time to wait for a token
     * @type {number}
     */
    this.maxPollMs = Math.max(5_000, options.maxPollMs ?? 120_000);

    /**
     * The last terminal solve
     * @type {?Object}
     */
    this.lastSolve = null;
  }

  /**
   * Creates a solver function bound to an API key, ready to pass as `captchaSolver`
   * @param {string} apiKey The NoneCap API key (`nc_live_...`)
   * @param {NoneCapOptions} [options] Solver options
   * @returns {CaptchaSolver}
   * @example
   * const client = new Client({ captchaSolver: NoneCap.solver('nc_live_...') });
   */
  static solver(apiKey, options) {
    return new NoneCap(apiKey, options).solver();
  }

  /**
   * Binds this instance into a `CaptchaSolver` function
   * @returns {CaptchaSolver}
   */
  solver() {
    return (captcha, userAgent) => this.solve(captcha, userAgent);
  }

  /**
   * Solves a Discord hCaptcha challenge and returns the `P1_` token
   * @param {Captcha} captcha The captcha object from a Discord error (needs `captcha_sitekey`)
   * @param {string} [userAgent] The user agent that will submit the token
   * @returns {Promise<string>}
   */
  async solve(captcha, userAgent) {
    if (!captcha || typeof captcha.captcha_sitekey !== 'string') throw new Error('NONECAP_INVALID_CAPTCHA');

    const enterprise = this.enterprise === true || (this.enterprise !== false && Boolean(captcha.captcha_rqdata));
    const body = {
      type: enterprise ? 'hcaptcha_enterprise' : 'hcaptcha',
      sitekey: captcha.captcha_sitekey,
      url: this.url,
    };
    const agent = this.userAgent ?? userAgent;
    if (agent) body.user_agent = agent;
    if (captcha.captcha_rqdata) body.rqdata = captcha.captcha_rqdata;
    if (this.proxy) body.proxy = this.proxy;

    let solve = await this._request(`/v1/solves?wait=${this.waitSeconds}`, { method: 'POST', body });
    const deadline = Date.now() + this.maxPollMs;

    while (solve && !TERMINAL_STATUSES.has(solve.status) && Date.now() < deadline) {
      await sleep(this.pollIntervalMs);
      solve = await this._request(`/v1/solves/${solve.id}?wait=${this.waitSeconds}`);
    }

    if (!solve || solve.status !== 'solved' || !solve.token) {
      const timedOut = Boolean(solve) && !TERMINAL_STATUSES.has(solve.status) && Date.now() >= deadline;
      const reason = timedOut ? 'timeout' : solve?.error?.code ?? solve?.status ?? 'unknown';
      const error = new Error(`NoneCap could not solve the captcha (${reason})`);
      error.reason = reason;
      error.solve = solve ?? null;
      throw error;
    }

    this.lastSolve = solve;
    return solve.token;
  }

  /**
   * Fetches the account and its current credit balance (`GET /v1/me`)
   * @returns {Promise<Object>}
   */
  balance() {
    return this._request('/v1/me');
  }

  /**
   * Reports the downstream verdict of a token (`POST /v1/solves/:id/feedback`)
   * @param {string} outcome One of `accepted`, `rejected`, `unknown`, `unused`, `error`
   * @param {Object} [options] Report options
   * @param {?string} [options.solveId] Solve id to report, defaults to the last solve
   * @param {?string} [options.reason] Freeform rejection reason, e.g. `invalid-response`
   * @param {?string} [options.context] Freeform context for support
   * @returns {Promise<Object>}
   */
  report(outcome, options = {}) {
    if (!FEEDBACK_OUTCOMES.has(outcome)) throw new Error('NONECAP_INVALID_OUTCOME');
    const solveId = options.solveId ?? this.lastSolve?.id;
    if (!solveId) throw new Error('NONECAP_MISSING_SOLVE_ID');
    return this._request(`/v1/solves/${encodeURIComponent(solveId)}/feedback`, {
      method: 'POST',
      body: { outcome, reason: options.reason ?? null, context: options.context ?? null },
    });
  }

  async _request(path, { method = 'GET', body } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), (this.waitSeconds + 15) * 1_000);

    let response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          accept: 'application/json',
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    const payload = await response.json().catch(() => null);

    if (!response.ok) {
      const error = new Error(payload?.error?.message ?? `NoneCap request failed with status ${response.status}`);
      error.status = response.status;
      error.code = payload?.error?.code ?? null;
      error.requestId = payload?.error?.request_id ?? response.headers?.get?.('x-request-id') ?? null;
      throw error;
    }

    return payload;
  }
}

module.exports = NoneCap;
