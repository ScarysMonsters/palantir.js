'use strict';

const { describe, test, expect } = require('bun:test');

const DiscordAPIError = require('../src/rest/DiscordAPIError.js');
const HTTPError = require('../src/rest/HTTPError.js');
const sanitizeRequestData = require('../src/rest/Sanitize.js');
const WebSocketShard = require('../src/client/websocket/WebSocketShard.js');
const Options = require('../src/util/Options.js');

describe('P0: secret redaction', () => {
  test('WebSocketShard#redactPacket masks tokens but keeps the rest of the payload', () => {
    const identify = { op: 2, d: { token: 'userSecretToken abc', capabilities: 30717, properties: { os: 'Windows' } } };
    const parsed = JSON.parse(WebSocketShard.redactPacket(identify));
    expect(parsed.d.token).toBe('[REDACTED]');
    expect(parsed.d.capabilities).toBe(30717);
    expect(parsed.d.properties.os).toBe('Windows');

    const resume = { op: 6, d: { token: 'userSecretToken abc', session_id: 'abc123', seq: 42 } };
    const parsedResume = JSON.parse(WebSocketShard.redactPacket(resume));
    expect(parsedResume.d.token).toBe('[REDACTED]');
    expect(parsedResume.d.session_id).toBe('abc123');
    expect(parsedResume.d.seq).toBe(42);
  });

  test('Options default capabilities is the realistic 30717, never 0', () => {
    const options = Options.createDefault();
    expect(options.ws.capabilities).toBe(30717);
    expect(Number.isInteger(options.ws.capabilities)).toBe(true);
    expect(options.ws.capabilities).toBeGreaterThan(0);
  });

  test('auth/mfa payloads are dropped entirely from error requestData', () => {
    const sanitized = sanitizeRequestData({
      method: 'post',
      path: '/auth/login',
      options: {
        data: { email: 'user@example.com', password: 'hunter2', undealt: 'keep' },
        headers: { Authorization: 'userSecretToken abc' },
      },
    });
    expect(sanitized.json).toBeUndefined();
    expect(sanitized.headers.Authorization).toBe('[REDACTED]');

    const mfa = sanitizeRequestData({
      method: 'post',
      path: '/auth/mfa/totp',
      options: { data: { ticket: 't', code: '123456' } },
    });
    expect(mfa.json).toBeUndefined();
  });

  test('non-auth payloads keep data but redact sensitive keys', () => {
    const sanitized = sanitizeRequestData({
      method: 'post',
      path: '/channels/1/messages',
      options: { data: { token: 'userSecretToken abc', password: 'pw', content: 'hello' } },
    });
    expect(sanitized.json.token).toBe('[REDACTED]');
    expect(sanitized.json.password).toBe('[REDACTED]');
    expect(sanitized.json.content).toBe('hello');
  });

  test('DiscordAPIError#requestData carries no Authorization header nor secret body', () => {
    const error = new DiscordAPIError({ message: 'Invalid Form Body', code: 50035 }, 400, {
      method: 'post',
      path: '/auth/login',
      retries: 0,
      options: {
        data: { email: 'user@example.com', password: 'hunter2' },
        headers: { Authorization: 'userSecretToken abc', 'User-Agent': 'palantir' },
      },
    });
    expect(error.requestData.json).toBeUndefined();
    expect(error.requestData.headers.Authorization).toBe('[REDACTED]');
    expect(error.requestData.headers['User-Agent']).toBe('palantir');
  });

  test('HTTPError#requestData redacts MFA, captcha and cookie headers', () => {
    const error = new HTTPError('Forbidden', 'HTTPError', 403, {
      method: 'get',
      path: '/users/@me',
      formData: undefined,
      options: {
        data: null,
        files: [],
        headers: {
          Authorization: 'userSecretToken abc',
          'X-Discord-Mfa-Authorization': 'mfa1',
          'X-Captcha-Key': 'k',
          'X-Captcha-Session-Id': 's',
          'X-Captcha-Rqtoken': 'r',
          Cookie: 'cf_clearance=abc',
          'User-Agent': 'palantir',
        },
      },
    });
    const { headers, json } = error.requestData;
    expect(headers.Authorization).toBe('[REDACTED]');
    expect(headers['X-Discord-Mfa-Authorization']).toBe('[REDACTED]');
    expect(headers['X-Captcha-Key']).toBe('[REDACTED]');
    expect(headers['X-Captcha-Session-Id']).toBe('[REDACTED]');
    expect(headers['X-Captcha-Rqtoken']).toBe('[REDACTED]');
    expect(headers.Cookie).toBe('[REDACTED]');
    expect(headers['User-Agent']).toBe('palantir');
    expect(json).toBeNull();
  });
});
