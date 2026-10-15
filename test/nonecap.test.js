'use strict';

const { describe, test, expect } = require('bun:test');
const NoneCap = require('../src/util/NoneCap.js');

const jsonResponse = (status, payload) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: () => null },
  json: async () => payload,
});

const withFetch = async (impl, fn) => {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
};

describe('NoneCap', () => {
  test('constructor validates the api key and exposes solver helpers', () => {
    expect(() => new NoneCap()).toThrow();
    expect(() => new NoneCap('')).toThrow();
    const solver = new NoneCap('nc_live_test');
    expect(solver.baseUrl).toBe('https://api.nonecap.com');
    expect(typeof solver.solver()).toBe('function');
    expect(typeof NoneCap.solver('nc_live_test')).toBe('function');
  });

  test('solve posts the challenge and returns the token', async () => {
    const calls = [];
    await withFetch(
      async (url, init) => {
        calls.push({ url, init });
        return jsonResponse(200, { id: 'solve_1', status: 'solved', token: 'P1_token', resp_key: 'E0_key' });
      },
      async () => {
        const solver = new NoneCap('nc_live_test', { waitSeconds: 1 });
        const token = await solver.solve(
          { captcha_sitekey: 'f5ab1c2d-7e8f-4a9b-b1c2-d3e4f5a6b7c8', captcha_rqtoken: 'rt' },
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/152.0.0.0',
        );
        expect(token).toBe('P1_token');
        expect(solver.lastSolve.id).toBe('solve_1');
        expect(solver.lastSolve.resp_key).toBe('E0_key');
      },
    );
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe('https://api.nonecap.com/v1/solves?wait=1');
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.headers.authorization).toBe('Bearer nc_live_test');
    expect(JSON.parse(calls[0].init.body)).toEqual({
      type: 'hcaptcha',
      sitekey: 'f5ab1c2d-7e8f-4a9b-b1c2-d3e4f5a6b7c8',
      url: 'https://discord.com',
      user_agent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/152.0.0.0',
    });
  });

  test('solve uses the enterprise flow when rqdata is present', async () => {
    let body;
    await withFetch(
      async (url, init) => {
        body = JSON.parse(init.body);
        return jsonResponse(200, { id: 'solve_2', status: 'solved', token: 'P1_ent' });
      },
      async () => {
        const solver = new NoneCap('nc_live_test', { waitSeconds: 1, userAgent: 'UA/1.0' });
        await solver.solve({ captcha_sitekey: 'key', captcha_rqdata: 'rqdata-blob' });
      },
    );
    expect(body.type).toBe('hcaptcha_enterprise');
    expect(body.rqdata).toBe('rqdata-blob');
    expect(body.user_agent).toBe('UA/1.0');
  });

  test('solve polls until the solve is terminal', async () => {
    let calls = 0;
    await withFetch(
      async () => {
        calls += 1;
        if (calls === 1) return jsonResponse(202, { id: 'solve_3', status: 'pending' });
        return jsonResponse(200, { id: 'solve_3', status: 'solved', token: 'P1_slow' });
      },
      async () => {
        const solver = new NoneCap('nc_live_test', { waitSeconds: 1, pollIntervalMs: 250 });
        const token = await solver.solve({ captcha_sitekey: 'key' });
        expect(token).toBe('P1_slow');
      },
    );
    expect(calls).toBe(2);
  });

  test('solve throws on a failed solve', async () => {
    await withFetch(
      async () =>
        jsonResponse(200, {
          id: 'solve_4',
          status: 'failed',
          token: null,
          error: { code: 'token_not_granted', reason: null, retryable: true },
        }),
      async () => {
        const solver = new NoneCap('nc_live_test', { waitSeconds: 1 });
        await expect(solver.solve({ captcha_sitekey: 'key' })).rejects.toThrow('token_not_granted');
        expect(solver.lastSolve).toBe(null);
      },
    );
  });

  test('solve surfaces API error envelopes', async () => {
    await withFetch(
      async () =>
        jsonResponse(402, {
          error: { code: 'insufficient_credits', message: 'no credits', param: null, request_id: 'req-1' },
        }),
      async () => {
        const solver = new NoneCap('nc_live_test', { waitSeconds: 1 });
        try {
          await solver.solve({ captcha_sitekey: 'key' });
          throw new Error('should have thrown');
        } catch (error) {
          expect(error.message).toBe('no credits');
          expect(error.status).toBe(402);
          expect(error.code).toBe('insufficient_credits');
          expect(error.requestId).toBe('req-1');
        }
      },
    );
  });

  test('balance fetches the account', async () => {
    let url;
    await withFetch(
      async requestUrl => {
        url = requestUrl;
        return jsonResponse(200, { object: 'account', credits_balance: 42 });
      },
      async () => {
        const account = await new NoneCap('nc_live_test').balance();
        expect(account.credits_balance).toBe(42);
      },
    );
    expect(url).toBe('https://api.nonecap.com/v1/me');
  });

  test('report validates the outcome and targets the last solve', async () => {
    let call;
    const solver = new NoneCap('nc_live_test', { waitSeconds: 1 });
    expect(() => solver.report('wat')).toThrow();
    expect(() => solver.report('accepted')).toThrow();
    solver.lastSolve = { id: 'solve_5' };
    await withFetch(
      async (url, init) => {
        call = { url, init };
        return jsonResponse(200, { object: 'feedback', solve_id: 'solve_5', outcome: 'rejected' });
      },
      async () => {
        await solver.report('rejected', { reason: 'invalid-response' });
      },
    );
    expect(call.url).toBe('https://api.nonecap.com/v1/solves/solve_5/feedback');
    expect(JSON.parse(call.init.body)).toEqual({ outcome: 'rejected', reason: 'invalid-response', context: null });
  });

  test('solve rejects invalid captcha objects', async () => {
    const solver = new NoneCap('nc_live_test');
    await expect(solver.solve()).rejects.toThrow();
    await expect(solver.solve({})).rejects.toThrow();
    await expect(solver.solve({ captcha_sitekey: 42 })).rejects.toThrow();
  });
});
