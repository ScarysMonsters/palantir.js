'use strict';

const { execSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');

const resultsDir = path.join(__dirname, 'results');
const setup = JSON.parse(fs.readFileSync(path.join(resultsDir, 'setup.json'), 'utf8'));

const COLD =
  'const t=process.hrtime.bigint();require(process.env.ENTRY);process.stdout.write(String(Number(process.hrtime.bigint()-t)/1e6));';
const MEM =
  'require(process.env.ENTRY);const m=process.memoryUsage();process.stdout.write(JSON.stringify({rss:m.rss,heapUsed:m.heapUsed,heapTotal:m.heapTotal,external:m.external}));';
const INST =
  'const {Client}=require(process.env.ENTRY);const t=process.hrtime.bigint();for(let i=0;i<100;i++)new Client();process.stdout.write(String(Number(process.hrtime.bigint()-t)/1e6));';

const findBun = () => {
  try {
    return (
      execSync('where bun', { encoding: 'utf8' })
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)[0] || null
    );
  } catch {
    return null;
  }
};

const bunPath = findBun();

const stats = (samples) => {
  if (!samples.length) return null;
  const s = [...samples].sort((a, b) => a - b);
  const sum = s.reduce((a, b) => a + b, 0);
  const r = (x) => +x.toFixed(3);
  return { min: r(s[0]), median: r(s[Math.floor(s.length / 2)]), mean: r(sum / s.length), max: r(s[s.length - 1]), samples: s.map(r) };
};

const runEval = (runtime, script, entry) => {
  const [cmd, args] = runtime === 'bun' ? [bunPath, ['-e', script]] : [process.execPath, ['-e', script]];
  const r = spawnSync(cmd, args, { encoding: 'utf8', env: { ...process.env, ENTRY: entry }, timeout: 60000 });
  const stdout = (r.stdout || '').trim();
  if (r.error || r.status !== 0 || !stdout) {
    return { error: (r.error && r.error.message) || stdout || (r.stderr || '').trim() || `exit ${r.status}` };
  }
  return { stdout };
};

const measure = (lib) => {
  const entry = createRequire(path.join(lib.dir, 'package.json')).resolve(lib.pkg);
  const runtimes = ['node', ...(bunPath ? ['bun'] : [])];
  const out = {
    dir: lib.dir,
    pkg: lib.pkg,
    entry,
    version: lib.version,
    coldRequireMs: {},
    memoryAfterRequire: {},
    instantiate100Ms: {},
    instantiateMs: {},
    errors: [],
  };

  for (const rt of runtimes) {
    const cold = [];
    for (let i = 0; i < 6; i++) {
      const r = runEval(rt, COLD, entry);
      if (r.stdout !== undefined) cold.push(Number(r.stdout));
      else out.errors.push(`cold[${rt}]: ${r.error}`);
    }
    out.coldRequireMs[rt] = stats(cold);

    const mem = [];
    for (let i = 0; i < 3; i++) {
      const r = runEval(rt, MEM, entry);
      if (r.stdout !== undefined) {
        try {
          mem.push(JSON.parse(r.stdout));
        } catch (e) {
          out.errors.push(`mem[${rt}]: ${e.message}`);
        }
      } else out.errors.push(`mem[${rt}]: ${r.error}`);
    }
    out.memoryAfterRequire[rt] = mem;

    const inst = [];
    for (let i = 0; i < 3; i++) {
      const r = runEval(rt, INST, entry);
      if (r.stdout !== undefined) inst.push(Number(r.stdout));
      else out.errors.push(`instantiate[${rt}]: ${r.error}`);
    }
    out.instantiate100Ms[rt] = stats(inst);
    out.instantiateMs[rt] =
      out.instantiate100Ms[rt] && {
        min: +(out.instantiate100Ms[rt].min / 100).toFixed(4),
        median: +(out.instantiate100Ms[rt].median / 100).toFixed(4),
        mean: +(out.instantiate100Ms[rt].mean / 100).toFixed(4),
        max: +(out.instantiate100Ms[rt].max / 100).toFixed(4),
      };
  }
  return out;
};

let bunVersion = null;
if (bunPath) {
  try {
    bunVersion = execSync(`"${bunPath}" --version`, { encoding: 'utf8' }).trim();
  } catch {}
}

const out = {
  generatedAt: new Date().toISOString(),
  platform: {
    os: `${os.platform()} ${os.release()} ${os.arch()}`,
    cpu: os.cpus()[0].model,
    cpuCount: os.cpus().length,
    totalMemGB: +(os.totalmem() / 1073741824).toFixed(1),
    node: process.version,
    bun: bunVersion,
  },
  libs: {},
};

for (const [key, lib] of Object.entries(setup.libs)) {
  console.log(`measuring ${key}...`);
  out.libs[key] = measure(lib);
}

fs.writeFileSync(path.join(resultsDir, 'local.json'), JSON.stringify(out, null, 2));
console.log('written benchmarks/results/local.json');
