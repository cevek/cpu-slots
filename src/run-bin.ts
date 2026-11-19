#!/usr/bin/env node
// `cpu-slots-run [--max N] [--] <command> [args…]`: a heavy command with no test file to wait for
// (ESLint, tsgo, a build) runs in slots for its whole run. It waits for one, takes the free ones up
// to N without waiting, and hands their number to the command: every `{slots}` in its arguments and
// `CPU_SLOTS_WIDTH`. The width is fixed at the start, so one that started on a busy machine stays
// narrow. Inside an ancestor's slot of the pool it takes none and the width is 1: that ancestor holds
// one slot for its whole tree. With no pool (not Linux, `CPU_SLOTS=0`, broken) or past the wait's
// ceiling it takes none, and the width is N — unbounded by the pool, as the command was without it.
import { runInGroup } from './group.js';
import { acquireSlot, pool, tryAcquireSlot, type Slot } from './index.js';

const USAGE = 'usage: cpu-slots-run [--max N] [--] <command> [args...]';

function usage(problem: string): never {
  process.stderr.write(`cpu-slots-run: ${problem}\n${USAGE}\n`);
  process.exit(2);
}

const argv = process.argv.slice(2);
let max = 1;
let i = 0;
for (; i < argv.length; i++) {
  const arg = argv[i]!;
  if (arg === '--') {
    i++;
    break;
  }
  if (arg === '-h' || arg === '--help') {
    process.stdout.write(`${USAGE}\n`);
    process.exit(0);
  }
  if (arg === '--max' || arg.startsWith('--max=')) {
    const value = arg === '--max' ? argv[++i] : arg.slice('--max='.length);
    if (value === undefined || !/^[1-9]\d{0,3}$/.test(value)) usage(`--max needs a whole number from 1 to 9999, got ${value ?? 'nothing'}`);
    max = Number(value);
    continue;
  }
  if (arg.startsWith('-')) usage(`unknown option ${arg}`);
  break;
}
const [command, ...rest] = argv.slice(i);
if (command === undefined) usage('no command to run');

const p = pool();
const nested = p !== null && (process.env['CPU_SLOTS_HELD'] ?? '').split(',').includes(p.name);
const first = await acquireSlot();
// Held by this process for the command's life; the kernel takes them back when it exits.
const held: Slot[] = [first];
const taken = first.env['CPU_SLOTS_HELD'] !== undefined;
while (taken && held.length < max) {
  const more = await tryAcquireSlot();
  if (!more) break;
  held.push(more);
}
const width = taken ? held.length : nested ? 1 : max;
runInGroup(
  command,
  rest.map((a) => a.replaceAll('{slots}', String(width))),
  { ...process.env, ...first.env, CPU_SLOTS_WIDTH: String(width) },
  'cpu-slots-run',
);
