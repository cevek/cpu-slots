import { spawn } from 'node:child_process';
import { constants } from 'node:os';

/**
 * Runs `command` in a process group of its own and exits this process with its code (a signal as
 * 128+n). A signal to this process goes to the whole group: the command alone may exit on it and
 * leave its own children running — holding their slots. What the command leaves running in its group
 * when it exits goes with it: this process's slots go when it exits, and nothing of the command may
 * run on outside them. The group is a session of its own, with no controlling terminal: no prompts.
 */
export function runInGroup(command: string, args: string[], env: NodeJS.ProcessEnv, name: string): void {
  // Inside a holder's tree (its mark in the env) the command stays in that holder's group: a group of
  // its own would outlive the holder's kill of its group, and run on with the holder's slot gone.
  const own = (process.env['CPU_SLOTS_HELD'] ?? '') === '';
  const child = spawn(command, args, { stdio: 'inherit', detached: own, env });
  if (!own) {
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(sig, () => child.kill(sig));
    child.on('error', (err) => {
      process.stderr.write(`${name}: ${err.message}\n`);
      process.exit(127);
    });
    child.on('exit', (code, signal) => process.exit(signal ? 128 + (constants.signals[signal] ?? 0) : (code ?? 1)));
    return;
  }
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
    try {
      if (child.pid) process.kill(-child.pid, 'SIGKILL');
    } catch {
      // Nothing of it is left.
    }
    process.exit(signal ? 128 + (constants.signals[signal] ?? 0) : (code ?? 1));
  });
}
