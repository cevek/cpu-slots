---
id: t-5gjcyz
title: 'Команды пакета работают из клона без сборки: запускатели bin/*.mjs, исходники с .ts-импортами'
status: done
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


## Разбор
- npm кладёт в tarball файлы из `bin` при любом `files` (`npm pack --dry-run` без `"bin"` в `files` их перечисляет). Поэтому раскладку опубликованного пакета тест берёт из списка самого npm (`npm pack --dry-run --json`), а не из `files`: свой список разошёлся бы с npm как раз там.
- Выключенное снятие типов (`--no-experimental-strip-types`, Node 22.6–22.17) в чекауте — только строка в README, без отката на `dist/`. Откат не помогает клону раскатки (там `dist/` нет), а в собранном чекауте молча запустил бы устаревший `dist/` — то, что запрещает правило «src первым».
- Признак «под node_modules» смотрит в URL, не в путь: в пути Windows разделитель `\`, и `'/node_modules/'` там не находился, лаунчер брал `src/` и падал на `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`. На CI Windows нет — эта ветка не прогнана.
- Нижняя граница `engines` (Node 22.0) на CI не проверяется — t-tmrhh9 вне скоупа.

- Зависимость по git-URL вне контракта: в git нет `dist/`, а `prepare` (его npm гоняет при git-установке, `prepack` — нет) встроил бы `tsc` в каждый `npm ci` раскатки claude-ui, и упавшая сборка уронила бы раскатку. В 0.1.0 git-установка ломала и импорт, и команды так же. README: ставить из реестра.
- `--preserve-symlinks-main` при запуске через `node_modules/.bin` — t-yqmae9; не регрессия (0.1.0 падал так же), падение громкое.
- Кругов bug-reviewer два, не один: первый дал два [BLOCK]. Второй — тоже два: git-установка (понижена, выше) и тест preload, сверявший лишь суффикс URL при cwd = корень репо; починен без третьего круга (потолок): запуск из tmp-каталога, точное равенство URL, мутация «URL от cwd» краснит все четыре раскладки.

- Проверено вживую: раскатка claude-ui на mini подтянула клон до 19f656b и положила шимы `cpu-slots-run`, `cpu-slots-node` в `~/.myclaude/run/bin`; под agent `cpu-slots-run --max 2` дал ширину 2 и код выхода команды, `cpu-slots-node --test` взял слот через `src/register.ts`. CI 19f656b зелёный.
