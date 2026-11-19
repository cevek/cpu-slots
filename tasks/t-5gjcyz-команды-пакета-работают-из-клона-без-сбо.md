---
id: t-5gjcyz
title: 'Команды пакета работают из клона без сборки: запускатели bin/*.mjs, исходники с .ts-импортами'
status: in-progress
priority: high
author: mb-e214488f
assignee: mb-e214488f
created: '2026-11-19T07:04:32.377Z'
---
claude-ui раскатывает `cpu-slots` на хосты как инструмент («Commands on PATH»): клонирует репо, ставит зависимости по lock и кладёт в PATH команды из `bin`. `bin` указывает в `dist/`, который в git не хранится и раскаткой не собирается: на mini «not on PATH — ./dist/run-bin.js is not a file in the clone».

## План
Схема task-manager (`bin/tm.mjs`):
- `bin/cpu-slots-run.mjs`, `bin/cpu-slots-node.mjs` — запускатели: есть `src/` рядом и путь не под `node_modules` → `import` исходника `src/*.ts` (Node ≥22.18 снимает типы сам, сборка не нужна, устаревшего `dist/` нет); иначе — `dist/*.js` (пакет из npm: `src/` не в `files`).
- `package.json`: `bin` → запускатели, `files`: `dist`, `bin`; `chmod` в сборке не нужен.
- `tsconfig.json`: `allowImportingTsExtensions` + `rewriteRelativeImportExtensions`; импорты в `src` — на `.ts` (tsc переписывает их в `.js` в `dist/`).
- `cpu-slots-node`: preload рядом с собой — `register.ts` из исходника, `register.js` из сборки.
- Тесты: обе команды из копии с `src/` и без `dist/` (клон) и из копии с `dist/` и без `src/` (пакет из npm).
- README: команды в чекауте и клоне идут из исходника.
- Проверка вживую: после пуша в `main` раскатка claude-ui на mini подтягивает клон — команды в PATH агентов mini и запускаются.
- Выпуск 0.1.1 — юзер (`npm run release`).
- Ревью: plan-reviewer; bug-reviewer — один круг.
