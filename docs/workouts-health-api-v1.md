# Тренировки и Apple Health — wire contract v1

Канонический идентификатор: kira.workouts-health.v1. Типы: api/workouts/contracts.ts.
Мобильная часть реализуется в существующем клиенте с iOS 18.0; этот репозиторий содержит backend.

## Общие правила

- Bearer определяет аккаунт. userId/accountId/profile из тела не принимаются.
- Все мутации требуют Idempotency-Key (8–128 букв, цифр, _ или -). Повтор ключа с другим телом — 409 idempotency_conflict. Неизвестный результат не исполняется повторно.
- UUID — lowercase; даты — RFC3339 UTC; timeZone — IANA; расстояние — метры, вес — кг, пульс — уд/мин, энергия — ккал, интервалы — миллисекунды. Неизвестное измерение — null.
- Максимальное JSON-тело — 64 KiB. События и изменения отправляются пачками до 100 элементов, вписывающимися в этот лимит. История постраничная, limit 1–100 (по умолчанию 20).
- Очереди устройства разделены по account.id из login/account. Смена аккаунта отменяет сеть и управление прежнего binding; старые локальные записи остаются в разделе прежнего аккаунта.
- Возможности включаются только через /capabilities.workouts: {version:1, contract:'kira.workouts-health.v1', features:[...], limits:{maxBatchItems:100,maxBodyBytes:65536,pollIntervalMs:5000,commandTtlMs:30000}}. Допустимые features: records, localSync, deviceCommands, appleHealthSync, plans, analysis. Неподдержанный этап не объявляется работающим.

## Маршруты (все с префиксом /api/v1)

| Метод | Путь | Назначение / JSON |
|---|---|---|
| POST | /workouts/devices | {installationId,platform}; ответ {device} с device.id и bindingId |
| DELETE | /workouts/devices/{id} | Отзыв binding и ожидающих команд |
| GET | /workouts | from,to,activityType,cursor,limit; ответ WorkoutListResponse: {workouts:WorkoutSummary[],nextCursor:string\\|null} без events, notes и sets |
| GET | /workouts/active | {workout:null\|Workout}; фактическая или запрошенная сессия |
| GET | /workouts/{id} | {workout:Workout} |
| POST | /workouts/sync | WorkoutSyncInput; ответ {workout:Workout} |
| POST | /workouts/commands | WorkoutStartCommandInput либо WorkoutExistingCommandInput; ответ {command:WorkoutCommand} |
| GET | /workouts/commands | deviceId,bindingId; ответ {commands,serverTime}; проверка раз в 5 с при доступном исполнении |
| POST | /workouts/commands/{id}/claim | {deviceId,bindingId}; подтверждение права исполнить до локального эффекта |
| POST | /workouts/commands/{id}/result | {deviceId,bindingId,status,eventId?,seq?,code?}; ответ {command} |
| GET | /workouts/plans | {plans} |
| POST | /workouts/plans | {id,title,activityType,kind,steps}; ответ {plan} |
| PUT | /workouts/plans/{id} | {expectedRevision,title,activityType,kind,steps}; ответ {plan} |
| DELETE | /workouts/plans/{id} | expectedRevision в query |
| GET | /workouts/analysis | from,to,activityType; необязательные ids (2–10 UUID через запятую); статистика и сравнение |
| GET | /health-sync | {sync,dailySteps}; состояние не утверждает, выдано ли разрешение HealthKit |
| PUT | /health-sync/consent | {enabled,consentVersion:1,deviceId,bindingId}; ответ {sync}; явное согласие на серверный обмен |
| POST | /health-sync/batch | {deviceId,bindingId,generation,changes:HealthChange[]}; ответ {sync,accepted} |
| DELETE | /health-sync/data | Отозвать обмен, удалить импорт и импортированные дополнения, сохранив ручные тренировки и дневник |

## Запись и команды

Для локального старта workoutId и recordingId создаются локально до первого запроса. POST /workouts/sync привязывает запись к аутентифицированному устройству. Один основной recorder отправляет события; paired Watch передаёт их через координатор iPhone. binding проверяется во всех запросах. Повтор seq+eventId с тем же содержимым — no-op; конфликт или пропуск последовательности — 409. Новые события должны иметь непрерывный seq и неубывающий elapsedMs. occurredAt хранит время наблюдения, но не решает конфликты.

WorkoutSummary — точный Omit<Workout,'events'|'notes'|'sets'>. WorkoutListResponse всегда содержит nextCursor, включая null на последней странице. Детальная и active-выдача содержат полный Workout. metrics содержит nullable totalDurationMs, activeDurationMs и pausedDurationMs. Для событий total — elapsedMs последнего наблюдения, для терминального занятия — elapsedMs события finished/cancelled; active — сумма интервалов running; paused = total - active. Аннотация после завершения не увеличивает продолжительность.

После отзыва привязки и входа в тот же аккаунт та же installationId получает прежний deviceId и новый bindingId. Для досылки собственной локальной записи /workouts/sync может явно передать previousBindingId и expectedSeq вместе: сервер проверяет прежнюю привязку, тот же deviceId/recordingId и точный текущий seq, затем атомарно перепривязывает запись. Другой телефон и устаревший seq не принимаются. Это восстановление, не timestamp last-write-wins; обычные запросы не меняют recorder.

События: started, paused, resumed, finished, cancelled, set_upserted, set_deleted, rest_started, note_added, metrics_updated. data содержит соответственно set (WorkoutSet), setId, durationMs, text либо metrics (distanceM, meanHeartRateBpm, maxHeartRateBpm, activeEnergyKcal). Финиш и отмена терминальны; поздние команды их не отменяют. После финиша разрешены аннотации и дополнение показателей.

Для удалённого старта POST /workouts/commands принимает {deviceId,bindingId,action:'start',args:{activityType,location,mode,timeZone}} БЕЗ workoutId/expectedSeq. Сервер выделяет workoutId и recordingId, создаёт requested (seq=0), возвращает command с обоими ID, expectedSeq=0 и указанными args. Если на сервере уже известна активная/запрошенная сессия, возвращает 409 active_workout_conflict без создания новой.

Получив start, устройство сначала проверяет отсутствие локальной running/paused-сессии, затем claim и durable-квитанцию. Оно принимает серверные workoutId/recordingId и отправляет started (seq=1,elapsedMs=0,commandId). Если локальная сессия уже есть, возвращает result rejected/code active_workout_conflict; её ID никогда не заменяет. Сервер закрывает только пустую requested-запись отклонённого старта. Офлайн-занятия всегда сохраняют собственные исходные ID. Конфликт другой активной записи при их загрузке возвращает 409, локальные данные клиент сохраняет до разрешения конфликта.

Для остальных действий нужны workoutId/deviceId/bindingId/expectedSeq/action/args. Все команды действуют 30 с, привязаны к конкретной сессии и recorder. claim сохраняется до эффекта. Устройство ведёт собственную durable-квитанцию commandId. Результат applied требует соответствующего сохранённого события с commandId. До этого Кира говорит «запрошено», а не «выполнено». Неподтверждённый claim после срока — unknown; автоматического повторного исполнения нет. GET никогда не исполняет действие.

Локальная остановка не ждёт сервера и имеет приоритет над ещё не применённой командой. Старый seq отклоняется; отложенная pause/resume/start не оживляет завершённую запись. Без связи используйте локальную кнопку; гарантированного пробуждения устройства и push в v1 нет.

## Apple Health

Согласие возвращает generation и закрепляет один iPhone как источник обмена. Смена устройства, отключение и очистка отзывают generation. После отзыва старые пачки отвергаются даже с ранее допустимой ревизией.

HealthChange имеет стабильные changeId/sourceKey и непрерывный seq в generation. workout_upsert передаёт healthKitId, sourceBundleId, syncIdentifier/syncVersion при наличии, activityType, location, startedAt, endedAt, timeZone и metrics. Для own-export добавляется kiraWorkoutId; связь допустима только с записью того же аккаунта и подтверждённым ранее export HealthKit ID. У чужих источников metadata syncVersion может отсутствовать; её нельзя придумывать. Для HealthKit-показателей в /workouts/sync дополнительно требуется актуальная healthSyncGeneration; lifecycle без новых показателей можно дослать после отключения интеграции.

Удаление — только явный workout_delete/daily_steps_delete, sourceKey и seq. Пустая выдача HealthKit не означает ни удаление, ни отказ в разрешениях. iPhone фиксирует anchor после durable-постановки пачки в локальную очередь; удаляет очередь только после подтверждения сервера.

daily_steps_upsert содержит localDate (YYYY-MM-DD), timeZone, intervalStart, intervalEnd и steps (целое число или null). Это уже объединённый дневной результат HealthKit, а не сумма сырых записей iPhone и Watch; последующая версия заменяет его. Разные дневные интервалы не складываются автоматически. Backend сохраняет происхождение и свежесть. Исходные записи HealthKit сервер не удаляет.

Для дневной записи используйте постоянные границы полного локального дня: от полуночи до следующей полуночи (23/24/25 часов с учётом DST). Сегодняшний результат содержит измерения, доступные на момент обновления; intervalEnd не является временем синхронизации. UUID из Swift/HealthKit перед отправкой приводите к lowercase.

## Простой старт и совместимость

Apple Health не обязателен для создания и завершения ручной тренировки. Включение интеграции не меняет старый ApiReply.messages. Сразу после финиша локально показывается детерминированная карточка; разбор моделью выполняется отдельно. Показатели не отправляются в векторную память и технические логи.

HTTP-ошибки используют существующий {error:{code,message},requestId}. Конфликты: workout_conflict, event_conflict, device_binding_conflict, command_stale, consent_required, sync_generation_conflict, sync_sequence_conflict. Недоступный аккаунту ID возвращает 404.

DELETE /health-sync/data также удаляет сохранённые тела прежних API-квитанций тренировок этого аккаунта, сохраняя их идентификаторы/отпечатки для защиты от повторного исполнения. Повтор старого ключа после очистки возвращает 410 operation_result_erased; он не восстанавливает удалённые данные.

## Минимальные примеры

Регистрация устройства:
~~~json
{"installationId":"10000000-0000-4000-a000-000000000001","platform":"ios"}
~~~

Локальный старт (deviceId/bindingId берутся из регистрации):
~~~json
{"deviceId":"10000000-0000-4000-a000-000000000002","bindingId":"10000000-0000-4000-a000-000000000003","workoutId":"10000000-0000-4000-a000-000000000004","recordingId":"10000000-0000-4000-a000-000000000005","activityType":"running","location":"outdoor","mode":"manual","timeZone":"Europe/Amsterdam","events":[{"eventId":"10000000-0000-4000-a000-000000000006","seq":1,"type":"started","occurredAt":"2026-11-02T12:00:00Z","elapsedMs":0}]}
~~~

Удалённый старт:
~~~json
{"deviceId":"10000000-0000-4000-a000-000000000002","bindingId":"10000000-0000-4000-a000-000000000003","action":"start","args":{"activityType":"running","location":"outdoor","mode":"manual","timeZone":"Europe/Amsterdam"}}
~~~

Ответ содержит только подтверждение запроса; ID в примере синтетические:
~~~json
{"command":{"id":"20000000-0000-4000-a000-000000000001","workoutId":"20000000-0000-4000-a000-000000000002","recordingId":"20000000-0000-4000-a000-000000000003","deviceId":"10000000-0000-4000-a000-000000000002","bindingId":"10000000-0000-4000-a000-000000000003","expectedSeq":0,"action":"start","args":{"activityType":"running","location":"outdoor","mode":"manual","timeZone":"Europe/Amsterdam"},"status":"queued","createdAt":"2026-11-02T12:00:00.000Z","expiresAt":"2026-11-02T12:00:30.000Z"}}
~~~
