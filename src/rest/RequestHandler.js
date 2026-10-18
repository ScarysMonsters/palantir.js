'use strict';

const { setTimeout } = require('node:timers');
const { setTimeout: sleep } = require('node:timers/promises');
const { AsyncQueue } = require('../util/AsyncQueue');
const DiscordAPIError = require('./DiscordAPIError');
const HTTPError = require('./HTTPError');
const RateLimitError = require('./RateLimitError');
const {
  Events: { DEBUG, RATE_LIMIT, INVALID_REQUEST_WARNING, API_RESPONSE, API_REQUEST },
} = require('../util/Constants');

const captchaMessage = [
  'incorrect-captcha',
  'response-already-used',
  'captcha-required',
  'invalid-input-response',
  'invalid-response',
  'You need to update your app',
  'response-already-used-error',
  'rqkey-mismatch',
  'sitekey-secret-mismatch',
];

/**
 * Bounded exponential backoff with jitter, in milliseconds. Scaling: 500ms,
 * 1s, 2s, 4s ... capped at 20s. Used by the 429-without-timing and 5xx retry
 * paths so neither can hammer the API in a tight loop.
 * @param {number} attempt Number of retries already consumed (1 = first retry)
 * @returns {number} Delay to sleep before the next attempt
 */
function backoffFor(attempt) {
  return Math.min(2 ** Math.max(attempt - 1, 0) * 500, 20_000) + Math.floor(Math.random() * 250);
}

function parseResponse(res) {
  if (res.headers.get('content-type')?.startsWith('application/json')) return res.json();
  return res.arrayBuffer();
}

function getAPIOffset(serverDate) {
  return new Date(serverDate).getTime() - Date.now();
}

function calculateReset(reset, resetAfter, serverDate) {
  // Use direct reset time when available, server date becomes irrelevant in this case
  if (resetAfter) {
    return Date.now() + Number(resetAfter) * 1_000;
  }
  return new Date(Number(reset) * 1_000).getTime() - getAPIOffset(serverDate);
}

/* Invalid request limiting is done on a per-IP basis, not a per-token basis.
 * The best we can do is track invalid counts process-wide (on the theory that
 * users could have multiple bots run from one process) rather than per-bot.
 * Therefore, store these at file scope here rather than in the client's
 * RESTManager object.
 */
let invalidCount = 0;
let invalidCountResetTime = null;

class RequestHandler {
  constructor(manager) {
    this.manager = manager;
    this.queue = new AsyncQueue();
    this.reset = -1;
    this.remaining = -1;
    this.limit = -1;
    this.bucket = null;
  }

  async push(request) {
    await this.queue.wait();
    try {
      return await this.execute(request);
    } finally {
      this.queue.shift();
    }
  }

  get globalLimited() {
    return this.manager.globalRemaining <= 0 && Date.now() < this.manager.globalReset;
  }

  get localLimited() {
    return this.remaining <= 0 && Date.now() < this.reset;
  }

  get limited() {
    return this.globalLimited || this.localLimited;
  }

  get _inactive() {
    return this.queue.remaining === 0 && !this.limited;
  }

  globalDelayFor(ms) {
    return new Promise(resolve => {
      setTimeout(() => {
        this.manager.globalDelay = null;
        resolve();
      }, ms).unref();
    });
  }

  /*
   * Determines whether the request should be queued or whether a RateLimitError should be thrown
   */
  async onRateLimit(request, limit, timeout, isGlobal) {
    const { options } = this.manager.client;
    if (!options.rejectOnRateLimit) return;

    const rateLimitData = {
      timeout,
      limit,
      method: request.method,
      path: request.path,
      route: request.route,
      global: isGlobal,
    };
    const shouldThrow =
      typeof options.rejectOnRateLimit === 'function'
        ? await options.rejectOnRateLimit(rateLimitData)
        : options.rejectOnRateLimit.some(route => rateLimitData.route.startsWith(route.toLowerCase()));
    if (shouldThrow) {
      throw new RateLimitError(rateLimitData);
    }
  }

  async execute(request, captchaKey, captchaToken, captchaSessionId) {
    /*
     * After calculations have been done, pre-emptively stop further requests
     * Potentially loop until this task can run if e.g. the global rate limit is hit twice
     */
    while (this.limited) {
      const isGlobal = this.globalLimited;
      let limit, timeout, delayPromise;

      if (isGlobal) {
        // Set the variables based on the global rate limit
        limit = this.manager.globalLimit;
        timeout = this.manager.globalReset + this.manager.client.options.restTimeOffset - Date.now();
      } else {
        // Set the variables based on the route-specific rate limit
        limit = this.limit;
        timeout = this.reset + this.manager.client.options.restTimeOffset - Date.now();
      }

      if (this.manager.client.listenerCount(RATE_LIMIT)) {
        /**
         * Emitted when the client hits a rate limit while making a request
         * @event BaseClient#rateLimit
         * @param {RateLimitData} rateLimitData Object containing the rate limit info
         */
        this.manager.client.emit(RATE_LIMIT, {
          timeout,
          limit,
          method: request.method,
          path: request.path,
          route: request.route,
          global: isGlobal,
        });
      }

      if (isGlobal) {
        // If this is the first task to reach the global timeout, set the global delay
        if (!this.manager.globalDelay) {
          // The global delay function should clear the global delay state when it is resolved
          this.manager.globalDelay = this.globalDelayFor(timeout);
        }
        delayPromise = this.manager.globalDelay;
      } else {
        delayPromise = sleep(timeout);
      }

      // Determine whether a RateLimitError should be thrown
      await this.onRateLimit(request, limit, timeout, isGlobal); // eslint-disable-line no-await-in-loop

      // Wait for the timeout to expire in order to avoid an actual 429
      await delayPromise; // eslint-disable-line no-await-in-loop
    }

    // As the request goes out, update the global usage information
    if (!this.manager.globalReset || this.manager.globalReset < Date.now()) {
      this.manager.globalReset = Date.now() + 1_000;
      this.manager.globalRemaining = this.manager.globalLimit;
    }
    this.manager.globalRemaining--;

    /**
     * Represents a request that will or has been made to the Discord API
     * @typedef {Object} APIRequest
     * @property {HTTPMethod} method The HTTP method used in this request
     * @property {string} path The full path used to make the request
     * @property {string} route The API route identifying the rate limit for this request
     * @property {Object} options Additional options for this request
     * @property {number} retries The number of times this request has been attempted
     */

    if (this.manager.client.listenerCount(API_REQUEST)) {
      /**
       * Emitted before every API request.
       * This event can emit several times for the same request, e.g. when hitting a rate limit.
       * <info>This is an informational event that is emitted quite frequently,
       * it is highly recommended to check `request.path` to filter the data.</info>
       * @event BaseClient#apiRequest
       * @param {APIRequest} request The request that is about to be sent
       */
      this.manager.client.emit(API_REQUEST, {
        method: request.method,
        path: request.path,
        route: request.route,
        options: request.options,
        retries: request.retries,
      });
    }

    // Perform the request
    let res;
    try {
      res = await request.make(captchaKey, captchaToken, captchaSessionId);
    } catch (error) {
      // Retry the specified number of times for request abortions
      if (request.retries === this.manager.client.options.retryLimit) {
        throw new HTTPError(error.message, error.constructor.name, error.status, request);
      }

      request.retries++;
      return this.execute(request);
    }

    if (this.manager.client.listenerCount(API_RESPONSE)) {
      /**
       * Emitted after every API request has received a response.
       * This event does not necessarily correlate to completion of the request, e.g. when hitting a rate limit.
       * <info>This is an informational event that is emitted quite frequently,
       * it is highly recommended to check `request.path` to filter the data.</info>
       * @event BaseClient#apiResponse
       * @param {APIRequest} request The request that triggered this response
       * @param {Response} response The response received from the Discord API
       */
      this.manager.client.emit(
        API_RESPONSE,
        {
          method: request.method,
          path: request.path,
          route: request.route,
          options: request.options,
          retries: request.retries,
        },
        res.clone(),
      );
    }

    let sublimitTimeout;
    if (res.headers) {
      const serverDate = res.headers.get('date');
      const limit = res.headers.get('x-ratelimit-limit');
      const remaining = res.headers.get('x-ratelimit-remaining');
      const reset = res.headers.get('x-ratelimit-reset');
      const resetAfter = res.headers.get('x-ratelimit-reset-after');
      this.limit = limit ? Number(limit) : Infinity;
      this.remaining = remaining ? Number(remaining) : 1;

      /*
       * Learn the bucket hash of this route: future requests (including sibling
       * routes that answer with the same hash) are then routed to one shared
       * handler instead of consuming the bucket through independent queues.
       */
      const bucket = res.headers.get('x-ratelimit-bucket');
      if (bucket) {
        this.manager.hashes.set(request.route, bucket);
        if (this.bucket !== bucket) {
          this.bucket = bucket;
          const bucketKey = `bucket:${bucket}`;
          if (!this.manager.handlers.has(bucketKey)) this.manager.handlers.set(bucketKey, this);
        }
      }

      this.reset = reset || resetAfter ? calculateReset(reset, resetAfter, serverDate) : Date.now();

      // https://github.com/discord/discord-api-docs/issues/182
      if (!resetAfter && request.route.includes('reactions')) {
        this.reset = new Date(serverDate).getTime() - getAPIOffset(serverDate) + 250;
      }

      // Handle retryAfter, which means we have actually hit a rate limit
      let retryAfter = res.headers.get('retry-after');
      retryAfter = retryAfter ? Number(retryAfter) * 1_000 : -1;
      if (retryAfter > 0) {
        // If the global rate limit header is set, that means we hit the global rate limit
        if (res.headers.get('x-ratelimit-global')) {
          this.manager.globalRemaining = 0;
          this.manager.globalReset = Date.now() + retryAfter;
        } else if (!this.localLimited) {
          /*
           * This is a sublimit (e.g. 2 channel name changes/10 minutes) since the headers don't indicate a
           * route-wide rate limit. Don't update remaining or reset to avoid rate limiting the whole
           * endpoint, just set a reset time on the request itself to avoid retrying too soon.
           */
          sublimitTimeout = retryAfter;
        }
      }
    }

    // Count the invalid requests
    if (res.status === 401 || res.status === 403 || res.status === 429) {
      if (!invalidCountResetTime || invalidCountResetTime < Date.now()) {
        invalidCountResetTime = Date.now() + 1_000 * 60 * 10;
        invalidCount = 0;
      }
      invalidCount++;

      const emitInvalid =
        this.manager.client.listenerCount(INVALID_REQUEST_WARNING) &&
        this.manager.client.options.invalidRequestWarningInterval > 0 &&
        invalidCount % this.manager.client.options.invalidRequestWarningInterval === 0;
      if (emitInvalid) {
        /**
         * @typedef {Object} InvalidRequestWarningData
         * @property {number} count Number of invalid requests that have been made in the window
         * @property {number} remainingTime Time in milliseconds remaining before the count resets
         */

        /**
         * Emitted periodically when the process sends invalid requests to let users avoid the
         * 10k invalid requests in 10 minutes threshold that causes a ban
         * @event BaseClient#invalidRequestWarning
         * @param {InvalidRequestWarningData} invalidRequestWarningData Object containing the invalid request info
         */
        this.manager.client.emit(INVALID_REQUEST_WARNING, {
          count: invalidCount,
          remainingTime: invalidCountResetTime - Date.now(),
        });
      }
    }

    // Handle 2xx and 3xx responses
    if (res.ok) {
      const parsed = await parseResponse(res);

      /*
       * The API answers 202 with a code starting with 11 to tell the request was queued
       * server-side instead of completed: retry after retry_after seconds (or 5s)
       * rather than treat the envelope as a final response.
       */
      if (res.status === 202 && parsed?.code != null && String(parsed.code).startsWith('11')) {
        if (request.retries >= this.manager.client.options.retryLimit) {
          throw new DiscordAPIError(parsed, res.status, request);
        }

        const retryAfter = Number(parsed.retry_after ?? 0);
        const waitMs = retryAfter > 0 ? retryAfter * 1_000 : 5_000;
        request.retries++;
        this.manager.client.emit(
          DEBUG,
          `[Request Handler] ${res.status} code ${parsed.code}: retrying in ${waitMs}ms (${request.method} ${request.path})`,
        );
        await sleep(waitMs);
        return this.execute(request, captchaKey, captchaToken, captchaSessionId);
      }

      // Nothing wrong with the request, proceed with the next one
      return parsed;
    }

    // Handle 4xx responses
    if (res.status >= 400 && res.status < 500) {
      // Handle ratelimited requests
      if (res.status === 429) {
        const rateLimitRetryLimit = this.manager.client.options.rateLimitRetryLimit ?? 5;
        // A durable 429 otherwise loops forever: bound the consecutive retries
        if (request.retries >= rateLimitRetryLimit) {
          throw new HTTPError(
            `Rate limited more than ${rateLimitRetryLimit} consecutive times on ${request.route}`,
            'RateLimitError',
            429,
            request,
          );
        }
        const isGlobal = this.globalLimited;
        let limit, timeout;
        if (isGlobal) {
          // Set the variables based on the global rate limit
          limit = this.manager.globalLimit;
          timeout = this.manager.globalReset + this.manager.client.options.restTimeOffset - Date.now();
        } else {
          // Set the variables based on the route-specific rate limit
          limit = this.limit;
          timeout = this.reset + this.manager.client.options.restTimeOffset - Date.now();
        }

        this.manager.client.emit(
          DEBUG,
          `[Request Handler] Hit a 429 while executing a request.
    Global  : ${isGlobal}
    Method  : ${request.method}
    Path    : ${request.path}
    Route   : ${request.route}
    Limit   : ${limit}
    Timeout : ${timeout}ms
    Sublimit: ${sublimitTimeout ? `${sublimitTimeout}ms` : 'None'}`,
        );

        await this.onRateLimit(request, limit, timeout, isGlobal);

        request.retries++;
        // If caused by a sublimit, wait it out here so other requests on the route can be handled
        if (sublimitTimeout) {
          await sleep(sublimitTimeout);
        } else if (!isGlobal && !this.localLimited) {
          /*
           * No authoritative timing on this 429 (user tokens are often only sent
           * a Retry-After and not the full ratelimit header set, and neither may
           * be present): bounded exponential backoff so we do not hammer the route.
           */
          const backoff = backoffFor(request.retries);
          this.manager.client.emit(
            DEBUG,
            `[Request Handler] No Retry-After on 429, backing off for ${backoff}ms (${request.method} ${request.path})`,
          );
          await sleep(backoff);
        }
        return this.execute(request);
      }

      // Handle possible malformed requests
      let data;
      try {
        data = await parseResponse(res);
        // Captcha
        if (
          data?.captcha_service &&
          typeof this.manager.client.options.captchaSolver == 'function' &&
          request.retries < this.manager.client.options.captchaRetryLimit &&
          Array.isArray(data.captcha_key) &&
          data.captcha_key.some(s => typeof s === 'string' && captchaMessage.some(m => s.includes(m)))
        ) {
          // Retry the request after a captcha is solved
          this.manager.client.emit(
            DEBUG,
            `[Request Handler] Hit a captcha while executing a request (${Array.isArray(data.captcha_key) ? data.captcha_key.join(', ') : 'unknown'})
    Method  : ${request.method}
    Path    : ${request.path}
    Route   : ${request.route}
    Sitekey : ${data.captcha_sitekey}
    rqToken : ${data.captcha_rqtoken ? 'present' : 'absent'}`,
          );
          const captcha = await this.manager.client.options.captchaSolver(data, request.fullUserAgent);
          this.manager.client.emit(
            DEBUG,
            `[Request Handler] Captcha details:
    Method  : ${request.method}
    Path    : ${request.path}
    Route   : ${request.route}
    Key     : ${captcha ? `[SOLVED] (length ${captcha.length})` : '[Captcha not solved]'}
    rqToken : ${data.captcha_rqtoken ? 'present' : 'absent'}`,
          );
          request.retries++;
          return this.execute(request, captcha, data.captcha_rqtoken, data.captcha_session_id);
        }
        // Two factor handling
        if (data?.code && data.code == 60003 && request.options.auth !== false && request.retries < 1) {
          // https://gist.github.com/Dziurwa14/de2498e5ee28d2089f095aa037957cbb
          // 60003: Two factor is required for this operation
          /**
           * {
           *     message: "Two factor is required for this operation";
           *     code: 60003;
           *     mfa: {
           *         ticket: string;
           *         methods: {
           *             type: "password" | "totp" | "sms" | "backup" | "webauthn";
           *             backup_codes_allowed?: boolean;
           *         }[];
           *     };
           * };
           */
          if (
            data.mfa.methods.find(o => o.type === 'totp') &&
            typeof this.manager.client.options.TOTPKey === 'string'
          ) {
            // Get mfa code
            const otp = this.manager.client.authenticator.generate(this.manager.client.options.TOTPKey);
            this.manager.client.emit(
              DEBUG,
              `[Request Handler] ${data.message}
    Method  : ${request.method}
    Path    : ${request.path}
    Route   : ${request.route}
    mfaCode : [TOTP_CODE] (not logged)`,
            );
            // Get ticket
            const mfaData = data.mfa;
            const mfaPost = await this.manager.client.api.mfa.finish.post({
              data: {
                ticket: mfaData.ticket,
                data: otp,
                mfa_type: 'totp',
              },
            });
            request.options.mfaToken = mfaPost.token;
            request.retries++;
            return this.execute(request);
          }
        }
      } catch (err) {
        throw new HTTPError(err.message, err.constructor.name, err.status, request);
      }

      throw new DiscordAPIError(data, res.status, request);
    }

    // Handle 5xx responses
    if (res.status >= 500 && res.status < 600) {
      // Retry the specified number of times for possible serverside issues (502/504/507/522/523/524 demand a backoff)
      if (request.retries >= this.manager.client.options.retryLimit) {
        throw new HTTPError(res.statusText, res.constructor.name, res.status, request);
      }

      /*
       * The API surfaces the number of failures in a row on X-Failed-Requests;
       * when it exceeds the retry limit there is no point waiting or retrying.
       */
      const failedRequests = Number(res.headers.get('x-failed-requests') ?? '0');
      if (failedRequests >= this.manager.client.options.retryLimit) {
        throw new HTTPError(
          `${res.status} after ${failedRequests} server failures (X-Failed-Requests)`,
          res.constructor.name,
          res.status,
          request,
        );
      }

      request.retries++;
      const backoff = backoffFor(request.retries);
      this.manager.client.emit(
        DEBUG,
        `[Request Handler] Hit a ${res.status}, retrying in ${backoff}ms (${request.method} ${request.path})`,
      );
      await sleep(backoff);
      return this.execute(request);
    }

    // Fallback in the rare case a status code outside the range 200..=599 is returned
    return null;
  }
}

module.exports = RequestHandler;
module.exports.backoffFor = backoffFor;

/**
 * @external HTTPMethod
 * @see {@link https://developer.mozilla.org/docs/Web/HTTP/Methods}
 */

/**
 * @external Response
 * @see {@link https://developer.mozilla.org/docs/Web/API/Response}
 */
