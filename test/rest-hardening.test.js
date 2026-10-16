'use strict';

const { describe, test, expect } = require('bun:test');

const RequestHandler = require('../src/rest/RequestHandler.js');

/**
 * Builds a RequestHandler backed by a stub client — no network, no real Client.
 * `responseFactory` controls what request.make() answers with.
 */
function makeHandler(responseFactory, optionOverrides = {}) {
  const handler = Object.create(RequestHandler.prototype);
  handler.queue = { wait: async () => {}, shift: () => {} };
  handler.limit = -1;
  handler.remaining = -1;
  handler.reset = -1;
  handler.manager = {
    globalLimit: 50,
    globalRemaining: 1,
    globalReset: -1,
    globalDelay: null,
    client: {
      listenerCount: () => 0,
      emit: () => {},
      options: {
        restTimeOffset: 0,
        rateLimitRetryLimit: 3,
        rejectOnRateLimit: false,
        captchaRetryLimit: 3,
        invalidRequestWarningInterval: 0,
        ...optionOverrides,
      },
    },
  };
  return handler;
}

function makeRequest(factory, { method = 'get', path = '/', route = '/' } = {}) {
  const request = { method, path, route, retries: 0, options: {}, make: factory };
  return request;
}

describe('P1: rate limit citizenship', () => {
  test('a durable 429 is retried rateLimitRetryLimit times then throws', async () => {
    const response = {
      ok: false,
      status: 429,
      statusText: 'Too Many Requests',
      headers: new Headers(),
      arrayBuffer: async () => new ArrayBuffer(0),
      text: async () => '',
      json: async () => ({}),
    };
    const handler = makeHandler(async () => response, { rateLimitRetryLimit: 2 });
    const request = makeRequest(async () => response);

    const error = await handler.execute(request).catch(e => e);
    expect(error.name).toBe('RateLimitError');
    expect(error.code).toBe(429);
    expect(error.path).toBe('/');
    // Initial attempt + 2 retries before giving up
    expect(request.retries).toBe(2);
  });

  test('client default rateLimitRetryLimit exists and defaults to 5', () => {
    const Options = require('../src/util/Options.js');
    expect(Options.createDefault().rateLimitRetryLimit).toBe(5);
  });

  test('backoffFor is bounded, monotonic and jittered', () => {
    const backoffFor = RequestHandler.backoffFor;
    const first = backoffFor(1);
    expect(first).toBeGreaterThanOrEqual(500);
    expect(first).toBeLessThan(750);
    const second = backoffFor(2);
    expect(second).toBeGreaterThanOrEqual(1000);
    expect(second).toBeLessThan(1250);
    // Bounded regardless of attempt count
    for (let attempt = 1; attempt <= 12; attempt++) {
      expect(backoffFor(attempt)).toBeLessThanOrEqual(20_250);
    }
  });

  test('a 5xx honours retryLimit and the X-Failed-Requests early-bail', async () => {
    // Mimic the shape the handler receives: it reads res.constructor.name for the error name
    const response = {
      constructor: { name: 'Response' },
      ok: false,
      status: 502,
      statusText: 'Bad Gateway',
      headers: new Headers(),
    };
    const handler = makeHandler(async () => response, { retryLimit: 2 });
    const request = makeRequest(async () => response);
    const error = await handler.execute(request).catch(e => e);
    // Upstream (djs v13) quirk HTTPError keeps: name copies res.constructor.name
    expect(error.name).toBe('Response');
    expect(error.constructor.name).toBe('HTTPError');
    expect(error.code).toBe(502);
    expect(request.retries).toBe(2);

    const bailed = makeHandler(async () => response, { retryLimit: 5 });
    response.headers.set('x-failed-requests', '7');
    const request2 = makeRequest(async () => response);
    const error2 = await bailed.execute(request2).catch(e => e);
    expect(error2.message).toContain('X-Failed-Requests');
    expect(error2.code).toBe(502);
    expect(request2.retries).toBe(0);
  });
});
