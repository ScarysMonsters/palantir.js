'use strict';

// Proxy configuration that is actually honored:
// - `http.agent` works with BOTH `http.transport: 'fetch'` (Bun only) and `'chrome'`.
// - `ws.agent` (gateway) accepts a URL string, `{ uri }` or `{ proxy }`.
// Under Node the `fetch` transport refuses to run with a proxy configured
// (PROXY_NOT_SUPPORTED) instead of silently leaking the real IP — use the
// Chrome transport there.

const Discord = require('../src/index');

const client = new Discord.Client({
  ws: {
    // Gateway proxy
    agent: 'http://user:pass@proxy.host:1080', // or { uri: '...' } / { proxy: '...' }
  },
  http: {
    // REST proxy (string URL: the only shape honored)
    agent: 'http://user:pass@proxy.host:1080',
    // Under Node, uncomment to route REST through the Chrome transport,
    // which tunnels everything itself and keeps the proxy working:
    // transport: 'chrome',
  },
});

client.on('ready', async () => {
  console.log('Ready!', client.user.tag);
});

// Never hard-code credentials — inject them from the environment.
client.login(process.env.DISCORD_TOKEN);
