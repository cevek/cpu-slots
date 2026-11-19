// A child process of the tests. `hold`: takes a slot of the pool its env names, says HELD, holds it
// until stdin closes. `nest`: the same, then starts a `hold` child with the env its slot gives.
// `cluster`: two `node:cluster` workers, each saying HELD once it holds a slot.
import { spawn } from 'node:child_process';
import cluster from 'node:cluster';
import { fileURLToPath } from 'node:url';
import { acquireSlot } from '../../dist/index.js';

const self = fileURLToPath(import.meta.url);
const mode = process.argv[2] ?? 'hold';

if (mode === 'cluster') {
  if (cluster.isPrimary) {
    for (let i = 0; i < 2; i++) cluster.fork();
    process.stdin.on('end', () => process.exit(0)).resume();
  } else {
    process.on('disconnect', () => process.exit(0));
    await acquireSlot();
    process.stdout.write('HELD\n');
  }
} else {
  const slot = await acquireSlot();
  process.stdout.write('HELD\n');
  if (mode === 'nest') {
    const inner = spawn(process.execPath, [self, 'hold'], { env: { ...process.env, ...slot.env }, stdio: ['pipe', 'inherit', 'inherit'] });
    process.stdin.on('end', () => inner.stdin.end());
  }
  process.stdin.on('end', () => process.exit(0)).resume();
}
