'use strict';

/**
 * Live network tests against Discord. Skipped unless PALANTIR_NETWORK_TESTS=1.
 * Run them with: `bun run test:network`
 */

const { describe, test, expect } = require('bun:test');
const nodeZlib = require('node:zlib');

const ENABLED = process.env.PALANTIR_NETWORK_TESTS === '1';
const skip = ENABLED ? test : test.skip;

describe('Discord network', () => {
  skip(
    'REST: GET /gateway goes through the full REST pipeline',
    async () => {
      const { Client } = require('../src/index.js');
      const client = new Client({ ws: { properties: {} } });
      const data = await client.rest.request('get', '/gateway', { auth: false, versioned: true, route: '/gateway' });
      expect(data.url).toMatch(/^wss:\/\//);
    },
    { timeout: 30000 },
  );

  skip(
    'Gateway: HELLO is received over zlib-stream compression',
    async () => {
      const WebSocket = require('../src/WebSocket.js');
      const ws = WebSocket.create('wss://gateway.discord.gg', { v: 10, compress: 'zlib-stream' });
      const inflate = nodeZlib.createInflate({ chunkSize: 65535 });
      const chunks = [];
      inflate.on('data', chunk => chunks.push(chunk));
      const packet = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('gateway timeout')), 20000);
        ws.onmessage = ({ data }) => {
          const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
          const length = buffer.length;
          const flush =
            length >= 4 && buffer[length - 4] === 0 && buffer[length - 3] === 0 && buffer[length - 2] === 0xff && buffer[length - 1] === 0xff;
          inflate.write(buffer);
          if (!flush) return;
          inflate.flush(nodeZlib.constants.Z_SYNC_FLUSH, () => {
            clearTimeout(timer);
            resolve(WebSocket.unpack(Buffer.concat(chunks)));
          });
        };
        ws.onerror = event => {
          clearTimeout(timer);
          reject(event instanceof Error ? event : new Error('ws error'));
        };
      });
      expect(packet.op).toBe(10);
      expect(packet.d.heartbeat_interval).toBeGreaterThan(0);
      ws.close(1000);
    },
    { timeout: 30000 },
  );
});
