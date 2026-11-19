---
id: t-ve7e88
title: 'npm-пакет из @lib/cpu-slots: сборка в JS и публичный вход preload для node --test'
status: done
priority: medium
author: mb-e214488f
assignee: mb-e214488f
created: '2026-11-19T02:30:17.301Z'
---
Цель — подключать машинный пул CPU-слотов (`libs/cpu-slots`, t-zsfrb6) к `node --test` и vitest в других проектах установкой из npm.

Почему сейчас нельзя: Node не снимает типы с `.ts` под `node_modules` (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`, Node 24.22.3), а шаблон lib (`libs/README.md`) запрещает ключи exports кроме `.`/`./node`/`./browser`/`./testing` — у preload `src/node/register.ts` нет публичного входа.

Нужно: сборка исходников lib в JS, манифест публикуемого пакета с входами `acquireSlot` и preload (и vitest-адаптером из t-mgvaje), проверка установленного tarball в чужом проекте. Решить, где пакет живёт: отдельный пакет или режим в `cpu-mutex` (npm, свой репо). Абстрактные сокеты привязывают пакет к Linux; на macOS он должен оставаться no-op.


## План
Репо `github.com/cevek/cpu-slots` (публичный), пакет `cpu-slots` 0.1.0 в npm; публикует юзер одной командой. Ядро — перенос `libs/cpu-slots`; vitest-адаптер (t-mgvaje) — в этой же версии.

**Раскладка репо** (зеркало `cpu-mutex`, `~/Dev/process-mutex`): `src/` → `dist/` через `tsc` (ESM, `.d.ts`), `test/` на vitest, `tsconfig.json` + `tsconfig.test.json`, `LICENSE` (MIT), `README.md`, `.github/workflows/ci.yml`: ubuntu на Node 22 и 24, один job на macOS, где пул выключен.
- Входы `exports`: `.` (`acquireSlot`, `pool`, типы), `./register` (preload для `node --test`), `./vitest` (setup-файл).
- `files: ["dist"]`, `engines.node >=22`.
- `prepublishOnly`: typecheck + build + test. Публикация первой версии — `npm publish`; дальше `npm run release` (patch: `npm version patch && npm publish && git push --follow-tags`) и варианты minor/major.

**vitest-адаптер.** Слот берётся в `beforeAll` (таймаут хука больше потолка ожидания), отдаётся в `afterAll`; хуки регистрирует setup-файл. Пара хуков у vitest либо обе идут, либо обе пропускаются (файл отфильтрован, упал импорт), поэтому слот не залипает на воркере. Захват на верхнем уровне setup-файла оставил бы его занятым у воркера, чей последний файл упал на импорте; при малом пуле это взаимная блокировка. Цена: импорт и трансформация файла идут без слота. `CPU_SLOTS_HELD` ставится в `process.env` после захвата и снимается в `afterAll`.

**Совместимость (проверено чтением):**
- **codemaster** — `node --test "test/**/*.test.ts"` на Node 22: добавить `--import cpu-slots/register`.
- **task-manager** — vitest 4.1.9, пул по умолчанию, setup-файл чистит только переменные автора: добавить `cpu-slots/vitest` в `setupFiles`, убрать `cpu-mutex --` из `test`.
- **admin-frontend** — vitest 4.1.8; линия `unit` с `isolate: false` перед каждым файлом сбрасывает `process.env` и глобалы (`restoreProcessState`) и перезагружает модули. Адаптер не держит состояние в `process.env`, метку ставит заново на каждом файле; пакет внешний (`node_modules`) и `vi.resetModules` его не перезагружает. Убрать `cpu-mutex --name vitest --` из `test`.

**Проверка**
- Тесты пакета на Linux, локально пропуск. Ядро — те же случаи, что `libs/cpu-slots/scripts/test-slots.ts`, включая кластер. `node --test` с preload: файлы при `CPU_SLOTS=1` не пересекаются, прогон кончается.
- vitest-адаптер — настоящие прогоны vitest на фикстурах при `CPU_SLOTS=1`, пулы `forks` и `threads`, `isolate` true и false: тест-файлы не пересекаются; прогон с отфильтрованным файлом и с файлом, упавшим на импорте, кончается.
- CI на GitHub (ubuntu 22/24, macOS) зелёный.
- Встройка: `npm pack` → tarball ставится в копии codemaster, task-manager и admin-frontend на mini (не в живые чекауты); их тесты с пулом зелёные, время — против прогона без пула.
- claude-ui переходит с `libs/cpu-slots` на пакет после публикации — отдельным шагом.

**Ревьюверы:** plan-reviewer (1 круг); bug-reviewer по коду репо (до 2 кругов).


## Сделано
- Репо `github.com/cevek/cpu-slots` (публичный), пакет `cpu-slots` 0.1.0 — не опубликован, публикует юзер (`npm publish`, дальше `npm run release`).
- Входы: `.` (`acquireSlot`, `pool`, `WAIT_CEILING_MS`), `./register` (preload), `./vitest` (setup-файл), бинарь `cpu-slots-node` (= `node --import <register по абсолютному URL>`).
- vitest-адаптер — `aroundAll` с `finally` (vitest ≥ 4.1): обёртка снаружи всех хуков файла, освобождение даже при падающем `afterAll`; отфильтрованный файл и файл, упавший на импорте, хуков не запускают и слот не берут.
- Ядро на монотонных часах и `node:timers/promises`: тест, замораживающий `Date` или подменяющий таймеры, ожидание не ломает.
- CI на GitHub: ubuntu Node 22 и 24, vitest 5, macOS (no-op) — зелёный.

## Встройка (копии на mini, Linux, пул по умолчанию 16)
| проект | без пакета | с пакетом |
|---|---|---|
| task-manager (vitest 4.1.9) | 1754/1754, 16.5 с | 1754/1754, 14.8 с |
| admin-frontend (vitest 4.1.8, линии `unit` и `isolated`) | 9054/9054, 20.7 с | 9054/9054, 21.5 с |
| codemaster (`node --test`, через `cpu-slots-node`) | 1 красный, 101.9 с | 2 красных, 101.2 с |

- codemaster: `codemaster’s own repo … does NOT escalate` красный в обоих — копия без `.git`. `daemon CLI: … restart over a real socket` упал один раз с пакетом и прошёл 4/4 с пакетом и без, и прошёл в прогоне под тремя нагрузками; в одиночном прогоне файлов одновременно 15 при 16 слотах — пакет ожиданий не создал. Флак самого теста под нагрузкой.
- Три полных прогона одновременно с пакетом: task-manager 62 с, admin-frontend 95 с, codemaster 132 с (1 красный — тот же без `.git`). Узкий прогон одного файла task-manager посреди них — 3.5 с (в одиночку 0.6 с).
- Встраивание: task-manager — `setupFiles: ['cpu-slots/vitest', …]` первым; его тест обвязки `test/unit/heavy-runs-serialized.test.ts` требует `cpu-mutex` в скриптах `test`/`coverage`/`fix-and-check` — при снятии обёртки править и его. admin-frontend — в `REUSED_WORKER.setupFiles` первым и в линии `isolated`; `cpu-mutex --name vitest --timeout 300` снимает и потолок прогона в 300 с. codemaster — `cpu-slots-node --test …` вместо `node --test …`; документированный полный прогон через `with-test-lock.mjs` останется под своим локом.

## Ревью пакета
- plan-reviewer: 4 [BLOCK] — пара `beforeAll`/`afterAll` ненадёжна (заменено на `aroundAll`), часы теста ломают потолок (монотонные часы), тест обвязки task-manager, недискриминирующие тесты — закрыты.
- bug-reviewer, круг 1: 3 [BLOCK] — `--import cpu-slots/register` ломает `fork()` в чужом `cwd` (бинарь `cpu-slots-node` с абсолютным URL), Node 22 засчитывает ожидание в `--test-timeout` (README; тест для Node 24), тест «afterAll бросает» не ловил отсутствие `finally` (проверка метки и свободы слота при импорте) — закрыты.
- bug-reviewer, круг 2 (последний): 2 [BLOCK] — `SIGHUP` обёртке оставлял тест-файлы со слотами (своя группа процессов и сигнал группе), пустые проверки отсутствия при `lineIn(…, 0)` — закрыты без нового круга; 3 should-fix (группы процессов в тестах, `close` вместо `exit`, свежий пустой слот) — закрыты.
- Мутациями на Linux проверено, что тесты ловят: пару хуков вместо `aroundAll`, глобальный `setTimeout` в ядре, отсутствие таймаута хука, отсутствие `finally`, адаптер и preload без захвата, сигнал только раннеру.
- Npm 10.9.4 из `/usr/local/bin` падает на установке этого репо (`edgesOut`), npm 11 из Homebrew ставит.


## Опубликовано
`cpu-slots@0.1.0` в npm (юзер), с `main` @ `caea3d5`: ядро, `cpu-slots/vitest`, `cpu-slots/register`, бинари `cpu-slots-node` и `cpu-slots-run`. claude-ui перешёл на зависимость (`run-suites.mjs`), `libs/cpu-slots` там удалён.
