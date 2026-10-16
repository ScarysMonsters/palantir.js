'use strict';

const { describe, test, expect } = require('bun:test');

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
});
