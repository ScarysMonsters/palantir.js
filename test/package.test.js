'use strict';

const { describe, test, expect } = require('bun:test');
const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

const SRC = path.join(__dirname, '..', 'src');

describe('package integrity', () => {
  test('package.json has the expected identity and dependency layout', () => {
    const pkg = require('../package.json');
    expect(pkg.name).toBe('palantir.js');
    expect(pkg.main).toBe('./src/index.js');
    expect(pkg.engines.bun).toBeDefined();
    // Real dependencies are allowed only for what cannot be implemented in JS.
    expect(Object.keys(pkg.dependencies ?? {})).toEqual(['@snazzah/davey']);
    const optional = Object.keys(pkg.optionalDependencies ?? {});
    expect(optional).toContain('opusscript');
    expect(optional.filter(name => name.startsWith('@snazzah/davey-')).length).toBeGreaterThanOrEqual(3);
  });

  test('default options enable gateway compression', () => {
    const Options = require('../src/util/Options.js');
    const options = Options.createDefault();
    expect(options.ws.compress).toBe(true);
  });

  test('index.js loads lazily and fast', () => {
    const start = performance.now();
    const index = require('../src/index.js');
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(100);
    expect(Object.keys(index).length).toBe(163);
    expect(index.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  test('lazy exports resolve to the same modules', () => {
    const index = require('../src/index.js');
    expect(index.Client).toBe(require('../src/client/Client.js'));
    expect(index.Collection).toBe(require('../src/util/Collection.js').Collection);
    expect(index.Formatters).toBe(require('../src/util/Formatters.js'));
    expect(index.Constants).toBe(require('../src/util/Constants.js'));
  });

  test('no bare external require remains (outside optional loaders)', () => {
    const allowed = new Set([
      'src/client/voice/util/Prism.js',
      'src/client/voice/networking/DAVESession.js',
      'src/client/voice/WebRtcStreamSession.js',
    ]);
    const failures = [];
    const walk = dir => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.js')) {
          const relative = path.relative(path.join(__dirname, '..'), full).replace(/\\/g, '/');
          if (allowed.has(relative)) continue;
          const content = fs.readFileSync(full, 'utf8');
          const regex = /require\('(?!node:|\.)/g;
          if (regex.test(content)) failures.push(relative);
        }
      }
    };
    walk(SRC);
    expect(failures).toEqual([]);
  });

  test('every source file is loadable', () => {
    require('../src/index.js'); // establish the production load order first
    const failures = [];
    const walk = dir => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.js')) {
          try {
            require(full);
          } catch (error) {
            failures.push(`${path.relative(SRC, full)}: ${error.message}`);
          }
        }
      }
    };
    walk(SRC);
    expect(failures).toEqual([]);
  });
});

describe('optional integrations', () => {
  test('DAVE protocol advertises a version when @snazzah/davey is installed', () => {
    const { getMaxProtocolVersion } = require('../src/client/voice/networking/DAVESession.js');
    const version = getMaxProtocolVersion();
    // The dependency is declared: after `bun install` the protocol must be available.
    expect(typeof version).toBe('number');
    expect(version).toBeGreaterThan(0);
  });

  test('an opus engine is available for PCM transcoding', () => {
    const { findOpusEngine } = require('../src/client/voice/util/Prism.js');
    const engine = findOpusEngine();
    expect(engine?.name).toBeTruthy();
  });
});
