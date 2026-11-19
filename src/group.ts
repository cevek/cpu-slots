import { spawn } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { constants } from 'node:os';

/** A process as `/proc` names it: its pid and start time, so a pid reused since is not taken for it. */
export type Proc = { pid: number; start: string };

function stat(pid: number): { ppid: number; start: string } | null {
  try {
    const line = readFileSync(`/proc/${pid}/stat`, 'utf8');
    // The name (field 2) may hold spaces and parens; the fields after its last `)` start at the state.
    const fields = line.slice(line.lastIndexOf(')') + 2).split(' ');
    return { ppid: Number(fields[1]), start: fields[19]! };
  } catch {
    return null;
  }
}

/** `root` and every process under it, now (Linux). */
export function subtree(root: number): Proc[] {
  const children = new Map<number, Proc[]>();
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    const s = stat(Number(name));
    if (!s) continue;
    const list = children.get(s.ppid) ?? [];
    list.push({ pid: Number(name), start: s.start });
    children.set(s.ppid, list);
  }
  const top = stat(root);
  if (!top) return [];
  const out: Proc[] = [{ pid: root, start: top.start }];
  for (let i = 0; i < out.length; i++) out.push(...(children.get(out[i]!.pid) ?? []));
  return out;
}

/** SIGKILL to each of `procs` still running under the same pid and start time. */
export function killSurvivors(procs: Iterable<Proc>): void {
  for (const p of procs) {
    if (stat(p.pid)?.start !== p.start) continue;
    try {
      process.kill(p.pid, 'SIGKILL');
    } catch {
      // Gone since.
    }
  }
}

/**
 * Runs `command` in this process's group and exits this process with its code (a signal as 128+n).
 * In the caller's group, a kill of that group (an agent tool's timeout, `kill -- -pgid`) takes the
 * command too — a SIGKILL to this process alone cannot be passed on. SIGTERM and SIGHUP to this
 * process go to the command's whole tree (Linux; elsewhere to the command alone): the command alone
 * may exit on it and leave its children running — holding their slots. SIGINT is not passed on: a
 * terminal's Ctrl-C already reaches the whole foreground group, and a second one is a forced exit
 * with no cleanup to vitest and npm. On any of the three the tree is noted, and what of it is still
 * running when the command exits gets SIGKILL: a cancel is total. A command that exits with no
 * signal here leaves what it started running.
 */
export function runInGroup(command: string, args: string[], env: NodeJS.ProcessEnv, name: string): void {
  const child = spawn(command, args, { stdio: 'inherit', env });
  const linux = process.platform === 'linux';
  const noted = new Map<string, Proc>();
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(sig, () => {
      if (!child.pid) return;
      if (!linux) {
        if (sig !== 'SIGINT') child.kill(sig);
        return;
      }
      for (const p of subtree(child.pid)) {
        noted.set(`${p.pid} ${p.start}`, p);
        if (sig === 'SIGINT') continue;
        try {
          process.kill(p.pid, sig);
        } catch {
          // Gone since.
        }
      }
    });
  }
  child.on('error', (err) => {
    process.stderr.write(`${name}: ${err.message}\n`);
    process.exit(127);
  });
  child.on('exit', (code, signal) => {
    killSurvivors(noted.values());
    process.exit(signal ? 128 + (constants.signals[signal] ?? 0) : (code ?? 1));
  });
}
