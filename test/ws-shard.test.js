'use strict';

const { test, expect } = require('bun:test');
const WebSocketShard = require('../src/client/websocket/WebSocketShard.js');
const { Status } = require('../src/util/Constants.js');

test('WebSocketShard#connect does not throw a TDZ ReferenceError on gatewayProxy', async () => {
  const fake = {
    connection: null,
    status: Status.DISCONNECTED,
    inflate: null,
    resumeURL: undefined,
    manager: {
      gateway: 'ws://127.0.0.1:1',
      client: { options: { ws: { version: 10, compress: false, agent: null } } },
    },
    debug: () => {},
    once: () => {},
    removeListener: () => {},
    setHelloTimeout: () => {},
    setWsCloseTimeout: () => {},
    identify: () => {},
    destroy: () => {},
    onOpen: () => {},
    onMessage: () => {},
    onError: () => {},
    onClose: () => {},
  };

  const settled = await Promise.race([
    WebSocketShard.prototype.connect.call(fake).then(
      () => 'resolved',
      error => error,
    ),
    Bun.sleep(150).then(() => 'still-connecting'),
  ]);

  expect(settled).toBe('still-connecting');
});
