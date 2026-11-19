#!/usr/bin/env node
// `cpu-slots-node <node args>` = `node --import <this package's register, by absolute URL> <node args>`.
// By URL, not by name: a test that forks a child with a cwd of its own hands the child the same
// `--import`, and a bare `cpu-slots/register` resolved from that cwd is a module not found.
import { spawn } from 'node:child_process';
import { constants } from 'node:os';

const register = new URL('./register.js', import.meta.url).href;
// A group of its own, signalled whole: the runner alone may exit on a signal and leave its test-file
// processes running — holding their slots.
const child = spawn(process.execPath, ['--import', register, ...process.argv.slice(2)], { stdio: 'inherit', detached: true });

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.on(sig, () => {
    try {
      if (child.pid) process.kill(-child.pid, sig);
    } catch {
      // The group is already gone.
    }
  });
}
child.on('error', (err) => {
  process.stderr.write(`cpu-slots-node: ${err.message}\n`);
  process.exit(1);
});
child.on('exit', (code, signal) => {
  process.exit(signal ? 128 + (constants.signals[signal] ?? 0) : (code ?? 1));
});
