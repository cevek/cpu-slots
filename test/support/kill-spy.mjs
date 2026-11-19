// A preload for a wrapper under test (`node --import <this> <bin>`): journals to `KILL_SPY` each
// signal the wrapper sends (`process.kill`, its one way to send) and when its SIGINT listeners have
// all run, with their number: this one, ahead of the wrapper's own, defers its line past the whole
// emit, and keeps the wrapper alive by itself — the count says the wrapper has a listener of its own.
import { appendFileSync } from 'node:fs';

const journal = process.env.KILL_SPY;
const log = (line) => appendFileSync(journal, `${line}\n`);
const kill = process.kill.bind(process);
process.kill = (pid, sig = 'SIGTERM') => {
  log(`kill ${pid} ${sig}`);
  return kill(pid, sig);
};
process.on('SIGINT', () => setImmediate(() => log(`SIGINT handled ${process.listenerCount('SIGINT')}`)));
