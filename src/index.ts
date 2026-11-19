import { createServer, type Server } from 'node:net';
import { cpus } from 'node:os';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';

// The test file this process runs may freeze `Date` or fake the global timers, at import or in a
// test: the waits here keep their own clock and their own timer.
const now = performance.now.bind(performance);

/** `env` — what the holder's children carry (`CPU_SLOTS_HELD`): set only when a slot was taken here. */
export type Slot = { release(): void; env: Record<string, string> };
/** The machine's pool as this process sees it; `null` — off (not Linux, `CPU_SLOTS=0`, or broken). */
export type Pool = { name: string; slots: number };

const HELD = 'CPU_SLOTS_HELD';
const TICK_MS = 100;
const NOTICE_MS = 60_000;
/** Past it a waiter runs without a slot, and says so: a holder that never lets go (a hung test file
 * with no timeout of its own) must not stop every test run of the machine. */
export const WAIT_CEILING_MS = 10 * 60_000;
// Fresh each time: a caller may add to the `env` it gets.
const noSlot = (): Slot => ({ release() {}, env: {} });

// Strong references for the holder's life: a collected server would close its fd, and the slot with it.
const held = new Set<Server>();
// One queue and one poller per pool: a waiter of one pool is never handed another's name.
type Waiter = { resolve: (slot: Slot) => void; since: number; mark: string };
type Queue = { pool: Pool; waiters: Waiter[]; polling: boolean };
const queues = new Map<string, Queue>();
let broken = false;
// Set after an acquire that had to wait: this process competes with others, so after a release it
// sits out one tick and a waiter elsewhere gets the slot, instead of this process's next file
// taking it back at once.
let contendedAt = -Infinity;
let yieldUntil = 0;

const noted = new Set<string>();
const note = (msg: string) => {
  if (noted.has(msg)) return;
  noted.add(msg);
  process.stderr.write(`[cpu-slots] ${msg}\n`);
};

export function pool(env: NodeJS.ProcessEnv = process.env): Pool | null {
  if (process.platform !== 'linux' || broken) return null;
  const raw = env['CPU_SLOTS'] ?? '';
  let slots = cpus().length;
  // A typo must not switch the pool off unseen, nor a value nobody asked for become its size — nor
  // a run of digits `Infinity`, which no scan of the names would ever finish.
  if (/^\d{1,4}$/.test(raw)) slots = Number(raw);
  else if (raw !== '') note(`ignoring CPU_SLOTS=${JSON.stringify(raw)} — using ${slots}`);
  if (slots === 0) return null;
  const name = env['CPU_SLOTS_POOL'] || 'default';
  // Bounded: an abstract name past the socket address's ~107 bytes fails every bind with EINVAL.
  if (!/^[\w.-]{1,64}$/.test(name)) {
    note(`ignoring CPU_SLOTS_POOL=${JSON.stringify(name)} — using "default"`);
    return { name: 'default', slots };
  }
  return { name, slots };
}

// A list: a holder in one pool may start a runner of another, whose children hold slots of both.
const heldPools = (env: NodeJS.ProcessEnv) => (env[HELD] ?? '').split(',').filter(Boolean);

/**
 * Resolves once this process holds one of the machine's slots of the pool. A slot is an abstract unix
 * socket name (`\0cpu-slots/<pool>/<i>`): bound by one socket at a time, in this process or any
 * other, and freed by the kernel when its holder closes it or dies. Off — an empty slot at once.
 * Its `env` makes a runner nested in the holder's children pass instead of waiting for its own slot.
 */
export function acquireSlot(env: NodeJS.ProcessEnv = process.env): Promise<Slot> {
  const p = pool(env);
  if (!p || heldPools(env).includes(p.name)) return Promise.resolve(noSlot());
  const key = `${p.name}/${p.slots}`;
  const q = queues.get(key) ?? { pool: p, waiters: [], polling: false };
  queues.set(key, q);
  const mark = [...heldPools(env), p.name].join(',');
  return new Promise((resolve) => {
    q.waiters.push({ resolve, since: now(), mark });
    void poll(q);
  });
}

/**
 * One pass over the pool's names, no wait: a slot if one is free now, else `null` — also when the
 * pool is off or an ancestor's slot covers this process.
 */
export async function tryAcquireSlot(env: NodeJS.ProcessEnv = process.env): Promise<Slot | null> {
  const p = pool(env);
  if (!p || heldPools(env).includes(p.name)) return null;
  const mark = [...heldPools(env), p.name].join(',');
  const from = Math.floor(Math.random() * p.slots);
  for (let k = 0; k < p.slots; k++) {
    const server = await bind(nameOf(p, (from + k) % p.slots));
    if (server) return hold(server, mark);
  }
  return null;
}

const nameOf = (p: Pool, i: number) => `\0cpu-slots/${p.name}/${i}`;

async function poll(q: Queue): Promise<void> {
  if (q.polling) return;
  q.polling = true;
  const { pool: p, waiters } = q;
  try {
    while (waiters.length > 0) {
      if (broken) {
        for (const w of waiters.splice(0)) w.resolve(noSlot());
        return;
      }
      while (waiters.length > 0 && now() - waiters[0]!.since > WAIT_CEILING_MS) {
        note(`no slot of pool "${p.name}" in ${WAIT_CEILING_MS / 60_000} min — running WITHOUT one (holders: ss -xlp | grep 'cpu-slots/${p.name}/')`);
        waiters.shift()!.resolve(noSlot());
      }
      if (now() >= yieldUntil) {
        // No order among the machine's waiters: concurrent runs finish together.
        const from = Math.floor(Math.random() * p.slots);
        for (let k = 0; k < p.slots && waiters.length > 0; k++) {
          const server = await bind(nameOf(p, (from + k) % p.slots));
          if (!server) continue;
          const w = waiters.shift()!;
          w.resolve(hold(server, w.mark));
        }
      }
      if (waiters.length === 0) return;
      contendedAt = now();
      if (now() - waiters[0]!.since > NOTICE_MS) {
        note(`waiting over ${NOTICE_MS / 1000}s for a slot of pool "${p.name}" (${p.slots} slots) — holders: ss -xlp | grep 'cpu-slots/${p.name}/'`);
      }
      // Not unref'd: a caller awaiting a slot has nothing else keeping its process alive.
      await sleep(TICK_MS / 2 + Math.random() * TICK_MS);
    }
  } finally {
    q.polling = false;
  }
}

function bind(path: string): Promise<Server | null> {
  return new Promise((resolve) => {
    const server = createServer((socket) => socket.destroy());
    server.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code !== 'EADDRINUSE' && !broken) {
        // Not "taken" but "cannot": waiting would never end. Loud, and every run goes unlimited.
        broken = true;
        note(`cannot bind a slot (${err.code ?? err.message}) — running without the pool`);
      }
      resolve(null);
    });
    // `exclusive`: a `node:cluster` worker would otherwise have the primary bind once and share the
    // handle — two workers, one slot.
    server.listen({ path, exclusive: true }, () => {
      // A held slot never keeps its process alive.
      server.unref();
      resolve(server);
    });
  });
}

function hold(server: Server, mark: string): Slot {
  held.add(server);
  return {
    env: { [HELD]: mark },
    release() {
      if (!held.delete(server)) return;
      server.close();
      if (now() - contendedAt < 10 * TICK_MS) yieldUntil = now() + TICK_MS;
    },
  };
}
