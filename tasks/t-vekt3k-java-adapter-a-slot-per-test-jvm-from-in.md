---
id: t-vekt3k
title: 'Java adapter: a slot per test JVM from inside the JVM (FFM, JUnit LauncherSessionListener)'
status: backlog
priority: medium
author: mb-e214488f
created: '2026-11-19T08:54:33.665Z'
---
The protocol is language-neutral: a slot is the abstract unix socket name `\0cpu-slots/<pool>/<i>`, bound exclusively by any process; `CPU_SLOTS`, `CPU_SLOTS_POOL`, `CPU_SLOTS_HELD` are plain env. A JVM that binds the same names joins the same pool as vitest and `node --test`.

Design (agreed direction, not built):
- Inside the JVM through the FFM API (Java 22+): `socket(AF_UNIX)` + `bind` with `sun_path[0] = 0` from libc — the plain `UnixDomainSocketAddress` takes no abstract names. No extra process, no node on the host.
- JUnit Platform `LauncherSessionListener`, registered by `ServiceLoader`: putting the artifact on the test runtime classpath turns it on — a slot for the test JVM's life, taken before the first test's clock. A slot per test class (`BeforeAll`/`AfterAll` extension, release in a `CloseableResource`) only pays off where a project runs classes in parallel (JUnit parallel execution, `maxParallelForks > 1`).
- Honours `CPU_SLOTS_HELD` (an ancestor's slot: take none) and sets it for the JVM's children; the same 10-minute ceiling, loud degradation, no-op off Linux.
- Its own repo and versioning, published as a Maven artifact: control-plane's `docs/agent-notes/development/testing.md` forbids a test extension inside the repo ("moved into a dedicated repository with its own versioning and tests, and used from there") and wants a maintainer's approval.
- A `PROTOCOL.md` in this repo first: the names, env, nesting and waiting rules both implementations follow; the Node tests are its compatibility check.

Measured on mini (control-plane v2.5.0, `./gradlew :control-plane-impl:test --no-daemon`, cold): 4 min 7 s, 690 CPU-s = 2.8 cores on average; compile ~2 min at 3.6 (peak 7.2), tests ~2 cores. The unit suite runs in ONE test JVM, classes in sequence (no `junit-platform.properties`, `maxParallelForks` 1); `itest` the same with cached Spring contexts and a shared Postgres. A slot per class there holds the same one slot as a slot per JVM.

Until it exists, the whole-run wrapper covers Java: `cpu-slots-run --max 3 -- ./gradlew <task> --max-workers=@slots@` (needs the command on PATH: `npx --yes --prefer-offline --package=cpu-slots@<v> cpu-slots-run`, warm 0.2–0.7 s, cold 7.5 s). Its limit: the Gradle daemon, not the wrapper, parents the test JVMs.
