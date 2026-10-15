'use strict';

const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const resultsDir = path.join(__dirname, 'results');
const benchRoot = process.env.BENCH_ROOT || 'C:/Users/J/AppData/Local/Temp/opencode/bench';

fs.mkdirSync(resultsDir, { recursive: true });
fs.mkdirSync(benchRoot, { recursive: true });

const sh = (cmd, cwd) => {
  const t0 = Date.now();
  const out = execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return { out, ms: Date.now() - t0 };
};

const walkNodeModules = (nm) => {
  const info = { files: 0, bytes: 0, packages: 0 };
  const stack = [nm];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fp = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== '.bin') stack.push(fp);
      } else if (entry.isFile()) {
        info.files++;
        try {
          info.bytes += fs.statSync(fp).size;
        } catch {}
        if (entry.name === 'package.json') info.packages++;
      }
    }
  }
  return info;
};

const collect = (dir, pkg) => {
  const nm = path.join(dir, 'node_modules');
  return {
    version: JSON.parse(fs.readFileSync(path.join(nm, pkg, 'package.json'), 'utf8')).version,
    installDir: dir,
    nodeModules: {
      ...walkNodeModules(nm),
      topLevel: fs.readdirSync(nm).filter((n) => !n.startsWith('.')),
    },
  };
};

const djsVersion = execSync('npm view djs-selfbot-v13 version', { encoding: 'utf8' }).trim();
const djsDist = JSON.parse(execSync(`npm view djs-selfbot-v13@${djsVersion} dist --json`, { encoding: 'utf8' }));
const packed = JSON.parse(sh(`npm pack --json --pack-destination "${benchRoot.replace(/\\/g, '/')}"`, repoRoot).out)[0];
const tgz = path.join(benchRoot, packed.filename);

const palantirDir = path.join(benchRoot, 'palantir');
fs.rmSync(palantirDir, { recursive: true, force: true });
fs.mkdirSync(palantirDir, { recursive: true });
fs.writeFileSync(path.join(palantirDir, 'package.json'), JSON.stringify({ name: 'bench-palantir', private: true }, null, 2));
const palantirInstall = sh(`npm install "${tgz.replace(/\\/g, '/')}" --no-audit --no-fund --loglevel=error`, palantirDir);

const djsDir = path.join(benchRoot, 'djsselfbot');
fs.rmSync(djsDir, { recursive: true, force: true });
fs.mkdirSync(djsDir, { recursive: true });
fs.writeFileSync(path.join(djsDir, 'package.json'), JSON.stringify({ name: 'bench-djs-selfbot', private: true }, null, 2));
const djsInstall = sh(`npm install djs-selfbot-v13@${djsVersion} --no-audit --no-fund --loglevel=error`, djsDir);

const result = {
  generatedAt: new Date().toISOString(),
  benchRoot,
  libs: {
    palantir: {
      displayName: 'palantir.js (hipalantir)',
      pkg: 'hipalantir',
      dir: palantirDir,
      installCommand: `npm install ${packed.filename}`,
      installMs: palantirInstall.ms,
      tarball: {
        filename: packed.filename,
        bytes: packed.size,
        unpackedBytes: packed.unpackedSize,
        fileCount: packed.entryCount ?? (packed.files && packed.files.length) ?? null,
      },
      ...collect(palantirDir, 'hipalantir'),
    },
    'djs-selfbot-v13': {
      displayName: 'djs-selfbot-v13',
      pkg: 'djs-selfbot-v13',
      dir: djsDir,
      installCommand: `npm install djs-selfbot-v13@${djsVersion}`,
      installMs: djsInstall.ms,
      tarball: {
        filename: `djs-selfbot-v13-${djsVersion}.tgz`,
        bytes: null,
        unpackedBytes: djsDist.unpackedSize,
        fileCount: djsDist.fileCount,
        tarballUrl: djsDist.tarball,
      },
      ...collect(djsDir, 'djs-selfbot-v13'),
    },
  },
};

fs.writeFileSync(path.join(resultsDir, 'setup.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
