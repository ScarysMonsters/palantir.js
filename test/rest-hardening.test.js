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

  test('the client self-throttles at the standard 50 req/s global budget by default', () => {
    const Options = require('../src/util/Options.js');
    expect(Options.createDefault().restGlobalRateLimit).toBe(50);
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

  test('a 400 captcha is solved, retried with rqtoken and session id, rqdata forwarded', async () => {
    const solverArgs = [];
    const makeCalls = [];
    const captchaData = {
      captcha_service: 'hcaptcha',
      captcha_key: ['invalid-input-response'],
      captcha_sitekey: 'site-key',
      captcha_rqtoken: 'rq-token',
      captcha_rqdata: 'rq-data',
      captcha_session_id: 'session-id',
    };
    const captchaResponse = {
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => captchaData,
    };
    const okResponse = {
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ message: 'OK' }),
    };
    const handler = makeHandler(
      async () => {},
      {
        captchaSolver: async data => {
          solverArgs.push(data);
          return 'solved-key';
        },
      },
    );
    const request = makeRequest((captchaKey, rqToken, sessionId) => {
      makeCalls.push([captchaKey, rqToken, sessionId]);
      return makeCalls.length === 1 ? captchaResponse : okResponse;
    });
    request.fullUserAgent = 'test-agent/1.0';

    const result = await handler.execute(request);
    expect(result).toEqual({ message: 'OK' });
    expect(request.retries).toBe(1);
    expect(solverArgs.length).toBe(1);
    // rqdata is passed through to the solver
    expect(solverArgs[0].captcha_rqdata).toBe('rq-data');
    // Retry carries the solved key, the rqtoken and the session id
    expect(makeCalls[1]).toEqual(['solved-key', 'rq-token', 'session-id']);
  });

  test('a 400 with captcha_service but no captcha_key array does not crash nor trigger the solver', async () => {
    const solverArgs = [];
    const response = {
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ captcha_service: 'hcaptcha', message: 'bad', code: 50035 }),
    };
    const handler = makeHandler(
      async () => response,
      {
        captchaSolver: async data => {
          solverArgs.push(data);
          return 'should-not-happen';
        },
        captchaRetryLimit: 3,
      },
    );
    const request = makeRequest(async () => response);
    const error = await handler.execute(request).catch(e => e);
    expect(solverArgs.length).toBe(0);
    expect(request.retries).toBe(0);
    expect(error.name).toBe('DiscordAPIError');
    expect(error.code).toBe(50035);
  });

  test('a 202 with a code starting with 11 retries on retry_after then fulfils', async () => {
    const queued = {
      ok: true,
      status: 202,
      statusText: 'Accepted',
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ code: 110020, retry_after: 0.2 }),
    };
    const done = {
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ done: 1 }),
    };
    let call = 0;
    const make = async () => (++call === 1 ? queued : done);
    const handler = makeHandler(make, { retryLimit: 3 });
    const request = makeRequest(make);
    const result = await handler.execute(request);
    expect(result).toEqual({ done: 1 });
    expect(request.retries).toBe(1);

    // Cap respected: retryLimit 0 rejects immediately
    let call2 = 0;
    const make2 = async () => (++call2 === 1 ? queued : ({ ok: true, status: 200, statusText: 'OK', headers: new Headers({ 'content-type': 'application/json' }), json: async () => ({}) }));
    const handler2 = makeHandler(make2, { retryLimit: 0 });
    const request2 = makeRequest(make2);
    const error = await handler2.execute(request2).catch(e => e);
    expect(error.name).toBe('DiscordAPIError');
    expect(error.code).toBe(110020);
    expect(request2.retries).toBe(0);
  });

  test('message POSTs get a snowflake nonce, user nonce preserved, other routes untouched', async () => {
    const APIRequest = require('../src/rest/APIRequest.js');
    const rest = {
      getAuth: () => 'test-token',
      client: {
        listenerCount: () => 0,
        emit: () => {},
        options: {
          http: { api: 'https://discord.com/api', version: 9, transport: 'fetch', headers: { 'User-Agent': 'test' } },
          ws: { properties: {} },
          restRequestTimeout: 1000,
          restTimeOffset: 0,
        },
      },
    };

    const post = (path, data) => {
      const request = new APIRequest(rest, 'post', path, { route: path, data });
      let captured;
      request.rest.fetch = async (url, init) => {
        captured = init;
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
      };
      return request.make().then(() => JSON.parse(captured.body));
    };

    const injected = await post('/channels/123/messages', { content: 'hey' });
    expect(typeof injected.nonce).toBe('string');
    expect(injected.nonce).toMatch(/^\d+$/);

    const preserved = await post('/channels/123/messages', { content: 'hey', nonce: 'user-nonce' });
    expect(preserved.nonce).toBe('user-nonce');

    const untouched = await post('/users/@me/notes', { note: 'note' });
    expect(untouched.nonce).toBeUndefined();
  });
});
