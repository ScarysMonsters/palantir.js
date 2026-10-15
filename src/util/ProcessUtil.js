'use strict';

const { execFile, spawn } = require('node:child_process');

/**
 * @typedef {Object} ProcessInfo
 * @property {number} pid The process id
 * @property {number} ppid The parent process id
 * @property {string} name The process name
 * @property {string} cmd The command line
 */

/**
 * Lists running processes matching a name.
 * Zero dependency replacement for `find-process`.
 * @param {'name'} type The search type (only `name` is supported)
 * @param {string} name The process name to search for
 * @param {boolean} [strict=false] Whether the match must be exact (case insensitive)
 * @returns {Promise<ProcessInfo[]>}
 */
function findProcess(type, name, strict = false) {
  if (type !== 'name') return Promise.resolve([]);
  return new Promise(resolve => {
    const lower = name.toLowerCase();
    const match = processName => {
      const value = (processName ?? '').toLowerCase();
      return strict ? value === lower : value.includes(lower);
    };

    if (process.platform === 'win32') {
      const script = [
        'Get-CimInstance Win32_Process |',
        'Select-Object ProcessId,ParentProcessId,Name,CommandLine |',
        'ConvertTo-Json -Compress',
      ].join(' ');
      execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { maxBuffer: 32 * 1024 * 1024 }, (error, stdout) => {
        if (error || !stdout) return resolve([]);
        let list;
        try {
          list = JSON.parse(stdout);
        } catch {
          return resolve([]);
        }
        if (!Array.isArray(list)) list = [list];
        resolve(
          list
            .filter(entry => match(entry.Name))
            .map(entry => ({
              pid: entry.ProcessId,
              ppid: entry.ParentProcessId,
              name: entry.Name,
              cmd: entry.CommandLine ?? '',
            })),
        );
      });
      return;
    }

    execFile('ps', ['-ax', '-o', 'pid=,ppid=,comm=,args='], { maxBuffer: 32 * 1024 * 1024 }, (error, stdout) => {
      if (error || !stdout) return resolve([]);
      const list = [];
      for (const line of stdout.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const matchResult = trimmed.match(/^(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/);
        if (!matchResult) continue;
        const [, pid, ppid, command, args] = matchResult;
        if (match(command) || match(args)) {
          list.push({ pid: Number(pid), ppid: Number(ppid), name: command, cmd: args });
        }
      }
      resolve(list);
    });
  });
}

/**
 * Kills a process and all of its descendants.
 * Zero dependency replacement for `tree-kill`.
 * @param {number} pid The process id
 * @param {string|number} [signal='SIGTERM'] The signal to send
 * @param {Function} [callback] Callback invoked with an optional error
 * @returns {void}
 */
function treeKill(pid, signal = 'SIGTERM', callback = () => null) {
  if (typeof signal === 'function') {
    callback = signal;
    signal = 'SIGTERM';
  }
  if (typeof pid !== 'number') return callback(new Error('pid must be a number'));
  if (typeof signal === 'number') signal = `SIG${signal}`;

  if (process.platform === 'win32') {
    const child = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
    child.on('error', callback);
    child.on('exit', code => callback(code === 0 ? undefined : new Error(`taskkill exited with code ${code}`)));
    return;
  }

  collectChildren(pid)
    .then(children => {
      for (const child of children.reverse()) {
        try {
          process.kill(child, signal);
        } catch {
          // Process already gone
        }
      }
      try {
        process.kill(pid, signal);
      } catch {
        return callback(new Error(`Failed to kill process ${pid}`));
      }
      callback();
    })
    .catch(callback);
}

/**
 * Recursively collects the descendants of a process (POSIX only).
 * @param {number} pid The process id
 * @returns {Promise<number[]>}
 */
function collectChildren(pid) {
  return new Promise(resolve => {
    execFile('ps', ['-o', 'pid=', '--ppid', String(pid)], (error, stdout) => {
      if (error || !stdout) return resolve([]);
      const children = stdout
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean)
        .map(Number);
      Promise.all(children.map(child => collectChildren(child))).then(grandChildren => {
        resolve([...grandchildren.flat(), ...children]);
      });
    });
  });
}

module.exports = { findProcess, treeKill };
