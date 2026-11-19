import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { constants } from 'node:os';
import { isatty } from 'node:tty';

export type Forwarded = 'SIGINT' | 'SIGTERM' | 'SIGHUP';

/** In its terminal's foreground group: a Ctrl-C there has reached the command already. */
function foreground(): boolean {
  if (process.platform !== 'linux') return isatty(0);
  try {
    const line = readFileSync('/proc/self/stat', 'utf8');
    // The name (field 2) may hold spaces and parens; the fields after its last `)` start at the state.
    const f = line.slice(line.lastIndexOf(')') + 2).split(' ');
    const [pgrp, tty, tpgid] = [Number(f[2]), Number(f[4]), Number(f[5])];
    return tty !== 0 && tpgid === pgrp;
  } catch {
    return isatty(0);
  }
}

/**
 * Runs `command` in this process's group and exits this process with its code (a signal as 128+n).
 * In the caller's group, a kill of that group (an agent tool's timeout, `kill -- -pgid`) or of its
 * cgroup takes the command and all it runs; a SIGKILL to this process alone cannot be passed on.
 * SIGTERM, SIGHUP and SIGINT to this process go to the command alone (`translate` may turn one into
 * another); what becomes of its children is the command's, as with npm or sh. SIGINT is not passed on in the
 * terminal's foreground group: Ctrl-C has reached every process of it, and a second one is a forced
 * exit with no cleanup to vitest and npm.
 */
export function runInGroup(command: string, args: string[], env: NodeJS.ProcessEnv, name: string, translate: Partial<Record<Forwarded, Forwarded>> = {}): void {
  const failed = (err: Error) => {
    process.stderr.write(`${name}: ${err.message}\n`);
    process.exit(127);
  };
  let child: ChildProcess | undefined;
  // Before the spawn: a signal while it waits for the child's exec would end this process with no
  // handler, the command starting on with its slots gone. The handler runs once `spawn` returns.
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(sig, () => {
      if (sig === 'SIGINT' && foreground()) return;
      if (child?.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
      // Not `child.kill`: its failure (EPERM) is an `error` event, taken for a failed spawn.
      try {
        process.kill(child.pid, translate[sig] ?? sig);
      } catch {
        // Gone, or not ours to signal any more.
      }
    });
  }
  try {
    child = spawn(command, args, { stdio: 'inherit', env });
  } catch (err) {
    // An argument `spawn` rejects at once (an empty command) is a failed spawn too.
    failed(err as Error);
    return;
  }
  child.on('error', failed);
  child.on('exit', (code, signal) => process.exit(signal ? 128 + (constants.signals[signal] ?? 0) : (code ?? 1)));
}
