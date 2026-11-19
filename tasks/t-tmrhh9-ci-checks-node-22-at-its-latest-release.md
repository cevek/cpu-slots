---
id: t-tmrhh9
title: CI checks Node 22 at its latest release, not the engines lower bound 22.0
status: backlog
priority: low
author: mb-e214488f
created: '2026-11-19T07:21:46.986Z'
---
`package.json` `engines.node` is `>=22`, and the published `dist/` is meant to run there; CI's matrix (`.github/workflows/ci.yml`, job `node ${{ matrix.node }} · ubuntu`) installs `node: 22`, which is the newest 22.x. Nothing checks that dist/ runs on 22.0. Either a job on the lower bound (`22.0.0`, the tests that run dist only — the clone layouts need 22.18+ type stripping) or `engines` raised to what CI proves.

Found by plan-reviewer (codex) on t-5gjcyz.
