'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');

const resultsDir = path.join(__dirname, 'results');
const argv = process.argv.slice(2);
const getArg = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? undefined : argv[i + 1];
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const r2 = (x) => +x.toFixed(2);

const stats = (samples) => {
  if (!samples.length) return null;
  const s = [...samples].sort((a, b) => a - b);
  const sum = s.reduce((a, b) => a + b, 0);
  return { min: r2(s[0]), median: r2(s[Math.floor(s.length / 2)]), mean: r2(sum / s.length), max: r2(s[s.length - 1]), samples: s.map(r2) };
};

async function worker() {
  const dir = getArg('dir');
  const pkg = getArg('pkg');
  const guildId = getArg('guild');
  const outPath = getArg('out');
  const token = process.env.BENCH_TOKEN;

  const out = {
    pkg,
    version: null,
    ok: false,
    startedAt: new Date().toISOString(),
    notes: ['getLastProperties: true', 'Options.fetchClientProperties() pre-fetched', 'messages.fetch fallback to _fetchMany'],
    propertiesFetched: null,
    steps: {},
    samples: {},
    debugLog: [],
    errors: [],
  };
  let client;

  const samples = {};

  const finalize = (code) => {
    try {
      if (!out.samples || !Object.keys(out.samples).length) {
        out.samples = Object.fromEntries(Object.entries(samples).map(([k, v]) => [k, stats(v)]));
      }
      fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
    } catch {}
    try {
      client && client.destroy();
    } catch {}
    process.exit(code);
  };

  const killer = setTimeout(() => {
    out.errors.push('global timeout (150s)');
    finalize(1);
  }, 150000);

  try {
    if (!token) throw new Error('BENCH_TOKEN environment variable is required');
    const req = createRequire(path.join(dir, 'package.json'));
    const lib = req(pkg);
    out.version = req(`${pkg}/package.json`).version;

    if (lib.Options && typeof lib.Options.fetchClientProperties === 'function') {
      try {
        await lib.Options.fetchClientProperties();
        out.propertiesFetched = true;
      } catch {
        out.propertiesFetched = false;
      }
    }

    const { Client } = lib;
    client = new Client({ getLastProperties: true });

    client.on('debug', message => {
      if (out.debugLog.length < 400) {
        out.debugLog.push(
          String(message)
            .replace(/[\w-]{15,}\.[\w-]{5,8}\.[\w*-]{20,}/g, '<redacted-token>')
            .replace(/\s+/g, ' ')
            .trim(),
        );
      }
    });

    const timed = async (label, fn) => {
      const t0 = performance.now();
      const value = await fn();
      (samples[label] ??= []).push(performance.now() - t0);
      return value;
    };

    let readyEventAt = null;
    client.once('ready', () => {
      readyEventAt = performance.now();
    });

    const t0 = performance.now();
    await client.login(token);
    out.steps.loginResolvedMs = r2(performance.now() - t0);
    while (!client.readyAt && performance.now() - t0 < 30000) await sleep(50);
    out.steps.loginToReadyMs = r2((readyEventAt ?? performance.now()) - t0);
    out.steps.readyEventFired = readyEventAt !== null;

    await sleep(5000);
    out.steps.wsPingMs = client.ws.ping;

    const guild = await timed('guildFetch', () => client.guilds.fetch(guildId));
    const channels = await timed('channelsFetch', () => guild.channels.fetch());
    const channel = channels.find((c) => c && (c.type === 'GUILD_TEXT' || c.type === 0));
    if (!channel) throw new Error('no GUILD_TEXT channel found in the test guild');
    out.channelId = channel.id;

    const fetchMessages = channel.messages.fetch
      ? channel.messages.fetch.bind(channel.messages)
      : channel.messages._fetchMany.bind(channel.messages);
    try {
      await timed('messagesFetch', () => fetchMessages({ limit: 10 }));
    } catch (e) {
      out.errors.push(`messagesFetch: ${e.message}`);
    }

    for (let i = 0; i < 3; i++) {
      let msg;
      try {
        msg = await timed('send', () => channel.send(`palantir benchmark #${i + 1} (${Date.now()})`));
        await timed('edit', () => msg.edit(`palantir benchmark #${i + 1} (edited)`));
        await timed('react', () => msg.react('✅'));
        try {
          await timed('unreact', () => msg.reactions.cache.first().users.remove(client.user.id));
        } catch (e) {
          out.errors.push(`unreact: ${e.message}`);
        }
        await timed('delete', () => msg.delete());
      } catch (e) {
        out.errors.push(`iteration ${i + 1}: ${e.message}`);
        try {
          if (msg) await msg.delete();
        } catch {}
      }
      await sleep(2000);
    }

    out.steps.wsPingAfterMs = client.ws.ping;
    out.samples = Object.fromEntries(Object.entries(samples).map(([k, v]) => [k, stats(v)]));
    out.ok = true;
  } catch (e) {
    out.errors.push(String((e && e.stack) || e));
  } finally {
    clearTimeout(killer);
    finalize(out.ok ? 0 : 1);
  }
}

function driver() {
  const guild = getArg('guild');
  const outPath = getArg('out') || path.join(resultsDir, 'network.json');
  const only = getArg('only');
  if (!guild) {
    console.error('--guild <id> is required');
    process.exit(1);
  }
  if (!process.env.BENCH_TOKEN) {
    console.error('BENCH_TOKEN environment variable is required');
    process.exit(1);
  }

  const setup = JSON.parse(fs.readFileSync(path.join(resultsDir, 'setup.json'), 'utf8'));
  const merged = {
    generatedAt: new Date().toISOString(),
    guildId: guild,
    platform: { os: `${os.platform()} ${os.release()}`, node: process.version },
    results: {},
  };

  if (only && fs.existsSync(outPath)) {
    try {
      merged.results = JSON.parse(fs.readFileSync(outPath, 'utf8')).results || {};
    } catch {}
  }

  for (const [key, lib] of Object.entries(setup.libs)) {
    if (only && key !== only) continue;
    console.log(`running network benchmark: ${key}...`);
    const tmp = path.join(resultsDir, `network-${key}.tmp.json`);
    fs.rmSync(tmp, { force: true });
    const r = spawnSync(
      process.execPath,
      [__filename, '--worker', '--dir', lib.dir, '--pkg', lib.pkg, '--guild', guild, '--out', tmp],
      { env: process.env, stdio: ['ignore', 'inherit', 'inherit'], timeout: 180000 },
    );
    if (r.error) merged.results[key] = { ok: false, errors: [String(r.error)] };
    else if (fs.existsSync(tmp)) merged.results[key] = JSON.parse(fs.readFileSync(tmp, 'utf8'));
    else merged.results[key] = { ok: false, errors: [`no result (status ${r.status})`] };
  }

  fs.writeFileSync(outPath, JSON.stringify(merged, null, 2));
  console.log(`written ${path.relative(process.cwd(), outPath)}`);
}

if (argv.includes('--worker')) {
  worker().catch((e) => {
    console.error(e);
    process.exit(1);
  });
} else {
  driver();
}
