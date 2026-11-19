---
id: t-q2tyf2
title: 'Квота cgroup меньше машины: ширина cpu-slots-run и под-пул на cgroup с cpu.max'
status: backlog
priority: medium
author: mb-e214488f
created: '2026-11-19T05:35:30.313Z'
---
Пул машинный: `CPU_SLOTS` = CPU машины. Раннер с шириной по умолчанию в cgroup с `cpu.max` укладывается в квоту сам: Node `availableParallelism()` и JVM `availableProcessors()` её учитывают (замер claude-ui t-pmc15r на mini: группа с 2 ядрами → 2; при квоте меньше 1 ядра Node видит все ядра). Ломает явная ширина больше квоты (`--maxWorkers 8`, `cpu-slots-run --max 8`, `gradle --max-workers 8` в группе на 2 ядра): внутри группы переподписка и таймауты, а машинные слоты заняты без пользы.

Предложение:
1. `cpu-slots-run`: ширина = `min(--max, floor(квоты))`, квота — самый жёсткий `cpu.max` по цепочке cgroup процесса.
2. Под-пул на cgroup с квотой: единица берёт сперва слот группы (`\\0cpu-slots/<pool>/cg/<id группы>/<j>`, j < floor(квоты)), потом машинный. Порядок «свой → машинный» одинаков у всех, взаимной блокировки нет. Группа держит не больше единиц, чем у неё ядер, при любой ширине раннера.

Проверка — на настоящей cgroup на mini (`systemd-run --scope -p CPUQuota=200%`); у CI GitHub делегирования CPU-контроллера, вероятно, нет. macOS — без изменений (cgroups нет).
