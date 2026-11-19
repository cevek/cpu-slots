// A preload for a wrapper under test (`node --import <this> <bin>`): journals to `KILL_SPY` each
// signal the wrapper sends (`process.kill`, its one way to send) and when its SIGINT listeners have
// all run. Registered ahead of the wrapper's own, this listener defers its line past the whole emit.
import { appendFileSync } from 'node:fs';

const journal = process.env.KILL_SPY;
const log = (line) => appendFileSync(journal, `${line}\n`);
const kill = process.kill.bind(process);
process.kill = (pid, sig = 'SIGTERM') => {
  log(`kill ${pid} ${sig}`);
  return kill(pid, sig);
};
process.on('SIGINT', () => setImmediate(() => log('SIGINT handled')));
