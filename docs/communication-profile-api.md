# Настройки общения приложения

`GET/PATCH /api/v1/profile/communication` работает в аутентифицированном аккаунте. Capability в `GET /api/v1/capabilities`:

```json
{"profile":{"communication":{"read":true,"write":true,"version":1,"path":"/api/v1/profile/communication"}}}
```

Полный ответ GET и успешного PATCH имеет одну форму:

```json
{
  "revision":"11111111-1111-4111-8111-111111111111",
  "name":{"value":"Лис","state":"known","source":"memory","updatedAt":"2026-01-01T00:00:00.000Z"},
  "address":{"value":null,"state":"unknown","source":null,"updatedAt":null},
  "replyLength":{"value":"short","state":"known","source":"setting","updatedAt":"2026-01-02T00:00:00.000Z"}
}
```

`name` — строка 1–80 символов без управляющих символов или `null`; `address` — `informal/formal/null`; `replyLength` — `short/detailed/null`. `revision` — непрозрачная строка. `updatedAt` — ISO 8601 либо `null`. `state` определяется наличием значения, `source` — `setting/memory/null`. Email, имя аккаунта и Telegram display name не используются как предпочтительное обращение.

PATCH отправляет **только изменённые скалярные поля**, без вложенных объектов GET, и `expectedRevision`:

```json
{"expectedRevision":"11111111-1111-4111-8111-111111111111","name":null,"address":"formal"}
```

Пропущенное поле сохраняет значение, источник и время. Явный `null` очищает поле: `state:"unknown", source:"setting", updatedAt:<время очистки>`. Каноническая запись переживает перезапуск и запрещает повторный импорт прежней памяти, включая очищенное значение. Не отправляйте полный отображаемый объект как PATCH и не сохраняйте автоматически при открытии экрана. `Idempotency-Key` не требуется: конкурентные изменения защищены compare-and-set по ревизии.

При конфликте `409` возвращает полный текущий профиль:

```json
{
  "error":{"code":"revision_conflict","message":"Настройки уже изменились. Обнови профиль и повтори изменение."},
  "requestId":"22222222-2222-4222-8222-222222222222",
  "profile":{
    "revision":"33333333-3333-4333-8333-333333333333",
    "name":{"value":null,"state":"unknown","source":"setting","updatedAt":"2026-01-02T00:00:00.000Z"},
    "address":{"value":"formal","state":"known","source":"setting","updatedAt":"2026-01-02T00:00:00.000Z"},
    "replyLength":{"value":"short","state":"known","source":"setting","updatedAt":"2026-01-02T00:00:00.000Z"}
  }
}
```

Другие ошибки: `400 invalid_communication_profile` (поля/значения), `401 unauthorized`, `405 method_not_allowed` с `Allow: GET, PATCH`, `503 communication_profile_unavailable` (чтение, повреждённая запись, недоступная/частичная память при первичном переносе, запись). Ошибка чтения не возвращает пустой профиль и не разрешает перезапись.

Первичное заполнение читает только действующие атомарные owner-предпочтения через существующий scoped memory pool, без embedding/AI-вызова. Поддерживаются явные предикаты `preferred_name/preferredName/communication_name/prefers_to_be_called`, `preferred_address/preferred_form_of_address/address_form` и `reply_length/preferred_response_length/preferred_reply_length`; объект должен дословно присутствовать в утверждении. Общий `name`, произвольный неподтверждённый пересказ и неразмеченный свободный текст не интерпретируются как предпочтение. Чужие/контактные источники, производные сводки, отрицания, слабые и недействующие свидетельства исключены. Равнозначные конфликтующие свидетельства дают `unknown`. Это ограничение переноса старых данных, а не отсутствие сохранённой памяти вообще.

Сохранённые настройки читаются без process-cache перед следующим обычным ответом Telegram/приложения и перед существующим fastDialogue-вызовом. Группы и другие пользователи этот контекст не получают. Никакие профильные значения не становятся инструкциями инструментам.

Ответы настоящих синтетических обработчиков сохранены в `tests/fixtures/communication-settings-wire.synthetic.json`: профиль known/cleared, успешный PATCH и 409, GET manual/automatic, автоматический PUT и отказ недоступного провайдера. Корневые ключи обозначают отдельные response/request bodies; HTTP headers и токены в файл не входят. Fixture пригоден для offline-проверки DTO другого клиента.

Чтобы обновить примеры, запустите `tests/external-api-communication-settings.test.ts` стандартным unit-раннером, задав `KIRA_API_CONTRACT_OUTPUT_DIR` в отдельном scratch-каталоге; он создаст `wire-examples.synthetic.json`. Данные целиком вымышлены. Изменение runtime-маршрутов и capability требует обычной интеграции; этот документ не подтверждает публикацию через внешний gateway.
