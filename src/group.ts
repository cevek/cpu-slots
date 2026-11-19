import { spawn } from 'node:child_process';
import { constants } from 'node:os';

/**
 * Runs `command` in a process group of its own and exits this process with its code (a signal as
 * 128+n). A signal to this process goes to the whole group: the command alone may exit on it and
 * leave its own children running — holding their slots.
 */
export function runInGroup(command: string, args: string[], env: NodeJS.ProcessEnv, name: string): void {
  const child = spawn(command, args, { stdio: 'inherit', detached: true, env });
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
    process.stderr.write(`${name}: ${err.message}\n`);
    process.exit(127);
  });
  child.on('exit', (code, signal) => {
    process.exit(signal ? 128 + (constants.signals[signal] ?? 0) : (code ?? 1));
  });
}
