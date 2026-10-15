'use strict';

const fs = require('node:fs');
const path = require('node:path');

const resultsDir = path.join(__dirname, 'results');
const read = (file) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(resultsDir, file), 'utf8'));
  } catch {
    return null;
  }
};

const setup = read('setup.json');
const local = read('local.json');
const network = read('network.json');

const P = 'palantir';
const D = 'djs-selfbot-v13';
const r2 = (x) => (typeof x === 'number' ? +x.toFixed(2) : null);
const cmp = (a, b) => ({
  palantir: r2(a),
  'djs-selfbot-v13': r2(b),
  djsOverPalantir: a && b ? r2(b / a) : null,
});

const pick = (obj, keyPath) => keyPath.split('.').reduce((acc, k) => (acc == null ? acc : acc[k]), obj);

const summary = {
  generatedAt: new Date().toISOString(),
  sources: {
    setup: 'benchmarks/results/setup.json',
    local: 'benchmarks/results/local.json',
    network: 'benchmarks/results/network.json',
  },
  libs: {},
  package: {},
  runtime: {},
  network: {},
};

if (setup) {
  for (const key of [P, D]) {
    const lib = setup.libs[key];
    if (!lib) continue;
    summary.libs[key] = { displayName: lib.displayName, version: lib.version };
  }
  summary.package = {
    installMs: cmp(pick(setup, `libs.${P}.installMs`), pick(setup, `libs.${D}.installMs`)),
    installedPackages: cmp(pick(setup, `libs.${P}.nodeModules.packages`), pick(setup, `libs.${D}.nodeModules.packages`)),
    installedFiles: cmp(pick(setup, `libs.${P}.nodeModules.files`), pick(setup, `libs.${D}.nodeModules.files`)),
    nodeModulesBytes: cmp(pick(setup, `libs.${P}.nodeModules.bytes`), pick(setup, `libs.${D}.nodeModules.bytes`)),
    unpackedBytes: cmp(pick(setup, `libs.${P}.tarball.unpackedBytes`), pick(setup, `libs.${D}.tarball.unpackedBytes`)),
    tarballFileCount: cmp(pick(setup, `libs.${P}.tarball.fileCount`), pick(setup, `libs.${D}.tarball.fileCount`)),
    topLevelPackages: {
      palantir: pick(setup, `libs.${P}.nodeModules.topLevel`),
      'djs-selfbot-v13': pick(setup, `libs.${D}.nodeModules.topLevel`),
    },
  };
}

if (local) {
  const rssMB = (key) => {
    const v = pick(local, `libs.${key}.memoryAfterRequire.node.0.rss`);
    return typeof v === 'number' ? v / 1048576 : null;
  };
  summary.runtime = {
    coldRequireMsNode: cmp(pick(local, `libs.${P}.coldRequireMs.node.median`), pick(local, `libs.${D}.coldRequireMs.node.median`)),
    coldRequireMsBun: cmp(pick(local, `libs.${P}.coldRequireMs.bun.median`), pick(local, `libs.${D}.coldRequireMs.bun.median`)),
    memoryRssMBAfterRequireNode: cmp(rssMB(P), rssMB(D)),
    instantiateMsNode: cmp(pick(local, `libs.${P}.instantiateMs.node.median`), pick(local, `libs.${D}.instantiateMs.node.median`)),
    instantiateMsBun: cmp(pick(local, `libs.${P}.instantiateMs.bun.median`), pick(local, `libs.${D}.instantiateMs.bun.median`)),
  };
}

if (network) {
  const np = network.results[P];
  const nd = network.results[D];
  summary.network = {
    guildId: network.guildId,
    ok: { palantir: !!(np && np.ok), 'djs-selfbot-v13': !!(nd && nd.ok) },
    loginToReadyMs: cmp(np && np.steps.loginToReadyMs, nd && nd.steps.loginToReadyMs),
    wsPingMs: cmp(np && np.steps.wsPingMs, nd && nd.steps.wsPingMs),
    errors: { palantir: (np && np.errors) || [], 'djs-selfbot-v13': (nd && nd.errors) || [] },
  };
  for (const op of [
    'guildFetch',
    'channelsFetch',
    'messagesFetch',
    'userFetchSelf',
    'rolesFetch',
    'roleCreate',
    'roleEdit',
    'roleDelete',
    'membersFetch',
    'memberFetch',
    'guildEdit',
    'channelEdit',
    'send',
    'edit',
    'react',
    'unreact',
    'delete',
  ]) {
    summary.network[op] = cmp(np && np.samples[op] && np.samples[op].median, nd && nd.samples[op] && nd.samples[op].median);
  }
}

fs.writeFileSync(path.join(resultsDir, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
