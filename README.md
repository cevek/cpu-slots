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
cpu-slots-node --test "test/**/*.test.ts"
```

`cpu-slots-node` is `node --import <cpu-slots/register by absolute URL>`. Not `--import cpu-slots/register`
by name: a test that forks a node child with a cwd of its own hands it the same `--import`, and the name
resolved from there is a module not found. Signals and the process group are as for `cpu-slots-run`
(below).

On Node 22 a file's `--test-timeout` starts before its process does, so it counts the wait for a slot:
there, set timeouts on the tests (`test(name, { timeout }, fn)`) rather than on the command line. Node 24
counts it from the file's own start.

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

**ESLint, `tsgo`, a build** — a heavy command with no test file to wait for runs in slots for its whole
run, with a width:

```sh
cpu-slots-run --max 4 -- eslint . --concurrency @slots@
cpu-slots-run --max 4 -- env GOMAXPROCS=@slots@ tsgo
cpu-slots-run -- eslint src test        # single-threaded: one slot
```

`cpu-slots-run` waits for one slot, takes the free ones up to `--max` (default 1) without waiting, and
hands their number to the command: every `@slots@` in its arguments, and `CPU_SLOTS_WIDTH`. The token is
`@slots@`, not `{slots}`: zsh and bash read `{word}>file` as a redirection to a named descriptor, and the
argument would be gone before the wrapper sees it. The width is fixed at the start — one that started
on a busy machine stays narrow.

The command runs in the wrapper's process group, with its terminal: its exit code passes through, and
its slots are held until it ends.

- **A kill of the caller's group** (an agent tool's timeout, `kill -- -pgid`) or of its cgroup takes
  the wrapper, the command and all it runs that stayed in the group. A `kill -9` to the wrapper's pid
  alone cannot be passed on and leaves the command running: it is in the caller's group, and the kill
  of that group takes it.
- **SIGTERM, SIGHUP, SIGINT** to the wrapper go to the command alone; what becomes of its children is
  the command's, as with `npm` or `sh`. `cpu-slots-node` hands a SIGHUP to its command as SIGTERM —
  to any, not only `node --test`, the reason for it: the runner ends its test files on SIGTERM, but
  dies of a SIGHUP and leaves them running. Sent to the
  whole group, a signal may reach the command twice: from the sender, and from the wrapper unless the
  command has exited by then.
- **SIGINT** is not passed on while the wrapper is in its terminal's foreground group (elsewhere than
  Linux: while its stdin is a terminal): Ctrl-C has reached every process of it, and a second one is a
  forced exit with no cleanup to vitest and npm. A Ctrl-C that comes while the wrapper is starting
  the command, before it runs, reaches neither.
- **Limits**: a command that ignores the signal keeps the wrapper and its slots until it exits. What a
  command leaves running when it exits — on its own or on a signal — runs on.

- **Width without a slot**: inside an ancestor's slot of the pool it takes none and the width is 1 (the
  ancestor holds one slot for its whole tree); with no pool (not Linux, `CPU_SLOTS=0`) or past the
  wait's ceiling it takes none and the width is `--max`.
- **A command with no width knob** (`vite build`, `knip`): `--max` is what it reserves; its own
  parallelism stays as it is.
- **Wide and narrow side by side**: a wide command takes what is free when it starts — under steady load
  that may be one slot, and on an idle machine a `--max` as large as the pool takes all of it for the
  run. There is no queue among waiters.

Linting has no timeouts to break: what this buys is that its CPU counts, and the tests running in slots
beside it are not stretched by it.

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

The pool's size follows the machine: by default its logical CPUs (`os.cpus()`) — 16 slots on a
16-CPU host, 4 on a 4-vCPU CI runner. `CPU_SLOTS` overrides it.

With the default size, eight full runs of a 202-file suite at once on a
16-CPU machine had no timeout (31 without the pool) and stretched a file at most 2.4× (14.9×
without), for about 10% of throughput: a file waiting on its own timers holds a slot nearly idle.
24 slots kept the throughput and stretched up to 4.1×.

### vitest

The setup file takes the slot in an `aroundAll` and gives it back in its `finally`. List it first in
`setupFiles` (and, if another setup file registers an `aroundAll` of its own, set
`sequence: { setupFiles: 'list' }`): registered first, it is the outermost wrapper — the slot goes
back after every `afterAll`, cleanup and fixture of the file, a throwing one included. A file whose
tests are all filtered out, or that fails to import, runs no hook and takes no slot. Importing and
transforming a file run outside the slot. Not for the browser mode: the setup file runs in node.

### `node --test`

The preload takes the slot in each test file's process before the file runs and keeps it until that
process exits; the runner's own process takes none. With `--test-isolation=none` there is no file
process and nothing is held.

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
| `CPU_SLOTS_WIDTH`| set by `cpu-slots-run` for its command: the slots it took                                |
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
  without a slot. What a `cpu-slots-run` / `cpu-slots-node` command leaves running when it exits runs
  on: the wrapper's slots go free, and a descendant that took a slot of its own keeps it.

## API

- `acquireSlot(env = process.env): Promise<{ release(): void; env: Record<string, string> }>` —
  resolves once this process holds a slot of the pool `env` names. `env` is what the holder's children
  get; `{}` when no slot was taken here (off, an ancestor's slot, past the ceiling).
- `tryAcquireSlot(env = process.env): Promise<Slot | null>` — one pass over the names, no wait: a slot
  if one is free now, else `null` (also when off or inside an ancestor's slot).
- `pool(env = process.env): { name, slots } | null` — the pool as this process sees it; `null` when off.
- `WAIT_CEILING_MS` — how long a waiter waits before running without a slot.

## Releasing (maintainers)

`npm publish` releases the version in `package.json` (`prepublishOnly` runs typecheck, build and the
tests). After that, `npm run release` (patch) or `npm run release:minor`: `npm version` makes the
commit and the tag, `npm publish` checks and publishes, `git push --follow-tags` pushes both.

The tests that exercise the pool run on Linux only; publish after CI is green.

If `npm publish` fails after `npm version`, first check whether the version reached the registry
(`npm view cpu-slots@<version> version`) — a network error may hide a publish that went through. Not
there: fix, then `npm publish` again for the same version. There (or only the push failed):
`git push --follow-tags`.

## License

MIT
