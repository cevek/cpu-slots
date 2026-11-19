---
id: t-yqmae9
title: Commands fail under --preserve-symlinks-main when run through node_modules/.bin
status: backlog
priority: low
author: mb-e214488f
created: '2026-11-19T07:30:40.529Z'
---
With `NODE_OPTIONS=--preserve-symlinks-main`, node keeps the main module's URL at the link `node_modules/.bin/cpu-slots-run`, so the launchers `bin/cpu-slots-{run,node}.mjs` look for `node_modules/src/…` and `node_modules/dist/…` beside the link and fail with ERR_MODULE_NOT_FOUND. Not new: 0.1.0's `dist/run-bin.js` resolved its `./group.js` from the link the same way. Loud, and the flag is not a default.

Fix idea: in the launchers, resolve `src`/`dist` from `pathToFileURL(realpathSync(fileURLToPath(import.meta.url)))` instead of `import.meta.url`.

Found by bug-reviewer (codex) on t-5gjcyz.
