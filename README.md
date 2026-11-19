# cpu-slots

Machine-wide CPU slots for test runners. Each test file waits for a slot of the machine before its
clock starts, so several test runs at once queue their files instead of stretching every test past
its timeout.

Built for machines shared by many agents (or people) in parallel checkouts: when a few of them start
heavy multi-process test runs at the same moment, every runner sizes itself to the whole machine,
the CPU is oversubscribed several times over, and tests fail on timeouts that say nothing about any
diff. The kernel's scheduler cannot fix that — it only chooses who waits, and a test's clock keeps
running while it waits. Waiting *before* the clock starts is what fixes it.

Linux only. Everywhere else the package is a no-op.

```sh
npm i -D cpu-slots
```

## Use

**vitest** (4.1 or later; node pools — `forks`, `threads`):

```ts
// vitest.config.ts
export default defineConfig({
  test: {
    setupFiles: ['cpu-slots/vitest'],
  },
});
```

**`node --test`** (files in processes of their own — the default isolation):

```sh
node --test --import cpu-slots/register "test/**/*.test.ts"
```

**Your own runner:**

```ts
import { acquireSlot } from 'cpu-slots';

const slot = await acquireSlot();
try {
  // start the timeout clock here, then run the work; give its children `slot.env`
  await runSuite({ env: { ...process.env, ...slot.env } });
} finally {
  slot.release();
}
```

If a run used to go through `cpu-mutex` (one heavy run at a time), drop that wrapper from the test
command: it would queue whole runs again, tail and all.

## How it works

A slot is an abstract unix socket name, `\0cpu-slots/<pool>/<i>` for `i < CPU_SLOTS`. Taking a slot
is binding the name; giving it back is closing the socket.

- **Exclusive by the kernel**: a name is bound by one socket at a time — in another process or in this
  one (a second worker thread or `node:cluster` worker included).
- **Nothing to clean up**: a holder that dies (a crash, `kill -9`) holds nothing. No lock file, no pid
  file, no stale state.
- **One unit, one slot**: a test file holds a slot while it runs, so the tail of a long run — one slow
  file — holds one slot, not the machine.

With the default size (the machine's logical CPUs), eight full runs of a 202-file suite at once on a
16-CPU machine had no timeout (31 without the pool) and stretched a file at most 2.4× (14.9×
without), for about 10% of throughput: a file waiting on its own timers holds a slot nearly idle.
24 slots kept the throughput and stretched up to 4.1×.

### vitest

The setup file takes the slot in an `aroundAll` and gives it back in its `finally`. Registered first,
it is the outermost wrapper: the slot goes back after every `afterAll`, cleanup and fixture of the
file, a throwing one included. A file whose tests are all filtered out, or that fails to import, runs
no hook and takes no slot. Importing and transforming a file run outside the slot. Not for the
browser mode: the setup file runs in node.

### `node --test`

The preload takes the slot in each test file's process before the file runs and keeps it until that
process exits; the runner's own process takes none. A wait in the preload is not counted by
`--test-timeout`. With `--test-isolation=none` there is no file process and nothing is held.

## Behavior

- **Waiting**: one poll per process and pool, every ~100 ms with jitter, every slot tried from a random
  start. There is no order among the machine's waiters. A process that waited recently sits out one
  tick after a release, so a waiter elsewhere can take the slot.
- **Loud, and bounded**: past 60 s of waiting one line on stderr names the pool and how to see the
  holders (`ss -xlp | grep cpu-slots/`). Past 10 minutes the waiter runs WITHOUT a slot and says so —
  a holder that never lets go (a hung test with no timeout) does not stop every run on the machine.
- **Nested runners pass**: a holder's children get `CPU_SLOTS_HELD` (`slot.env`), and a process that
  finds its pool there takes no slot of its own — a runner started inside a held slot (a test that
  runs a test runner) does not wait for its own. It runs as wide as it likes inside that slot.
- **Own clock**: a test that freezes `Date` or fakes the global timers does not stop a wait.
- **Degradation is loud**: an unreadable `CPU_SLOTS` / `CPU_SLOTS_POOL` is named on stderr and replaced
  by the default; a bind that fails for any reason but "taken" turns the pool off for the process, with
  a line on stderr — never an endless wait.

## Environment

| Variable         | Effect                                                                                   |
| ---------------- | ---------------------------------------------------------------------------------------- |
| `CPU_SLOTS`      | the pool's size, up to 9999; default the machine's logical CPUs; `0` — off              |
| `CPU_SLOTS_POOL` | the pool's name (`[A-Za-z0-9_.-]`, up to 64), default `default`; pools never contend     |
| `CPU_SLOTS_HELD` | set for a holder's children; the pools an ancestor holds a slot of                       |

## What it does not cover

- **Work that takes no slot**: a typecheck, a build, another project's runner without the package —
  they load the CPU unseen.
- **One size per pool**: the bound holds when every participant of a pool has the same `CPU_SLOTS`; a
  process with a larger one also takes the names past the smaller one's.
- **One network namespace**: abstract names live in a network namespace. Processes of one namespace
  share the pool; a container has its own.
- **Escaped descendants**: a holder's descendant that left its process group and outlives it runs on
  without a slot.

## API

- `acquireSlot(env = process.env): Promise<{ release(): void; env: Record<string, string> }>` —
  resolves once this process holds a slot of the pool `env` names. `env` is what the holder's children
  get; `{}` when no slot was taken here (off, an ancestor's slot, past the ceiling).
- `pool(env = process.env): { name, slots } | null` — the pool as this process sees it; `null` when off.
- `WAIT_CEILING_MS` — how long a waiter waits before running without a slot.

## Releasing (maintainers)

`npm publish` releases the version in `package.json` (`prepublishOnly` runs typecheck, build and the
tests). After that, `npm run release` (patch) or `npm run release:minor`: `npm version` makes the
commit and the tag, `npm publish` checks and publishes, `git push --follow-tags` pushes both.

The tests that exercise the pool run on Linux only; publish after CI is green.

If `npm publish` fails after `npm version` (a red check, a network error), the version commit and tag
are local only: fix, then `npm publish` again for the same version. If only the push fails, the
version is already on npm: `git push --follow-tags` again.

## License

MIT
