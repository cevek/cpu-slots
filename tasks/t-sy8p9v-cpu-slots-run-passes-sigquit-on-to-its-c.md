---
id: t-sy8p9v
title: cpu-slots-run passes SIGQUIT on to its command
status: backlog
priority: low
author: mb-e214488f
created: '2026-11-19T08:29:57.237Z'
---
`runInGroup` (`src/group.ts`) hands SIGTERM, SIGHUP and SIGINT to the command; a SIGQUIT sent to the wrapper's pid alone (not the group) kills the wrapper and leaves the command running. admin-frontend wraps `tsgo` as `cpu-slots-run --max 4 -- cpu-mutex --timeout 180 -- env GOMAXPROCS=@slots@ tsgo`: a SIGQUIT addressed to the `cpu-slots-run` pid never reaches `tsgo`. Ctrl-\ hits the whole foreground group, so only a pid-addressed SIGQUIT is affected.

Found by bug-reviewer on admin-frontend t-ydr1hs (judged a nit there).
