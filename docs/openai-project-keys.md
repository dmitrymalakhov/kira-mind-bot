# OpenAI: project API keys и проверка legacy credentials

Проверено 5 ноября 2026 года по `main` на коммите `1f12a345245fcc0575a13ebddcc5c0fa6ef4b3f5`.
Этот документ и сопровождающие тесты не заменяют production-секреты.

## Что установлено и чего пока не известно

По предоставленному владельцем уведомлению от 28 октября OpenAI начала поэтапно отключать неактивные legacy user keys с 29 октября; порог неактивности — минимум 14 дней. Уведомление об одном ключе организации Personal **не подтверждает**, что он используется этим приложением или уже отключён. Письмо в рамках этой проверки повторно не запрашивалось.

В исходниках нет требования использовать именно legacy key. Project key передаётся тем же `Authorization: Bearer …`; переименовывать переменные или обновлять модели для миграции не нужно. Префикс ключа, наличие переменной и успешный `/models` сами по себе не подтверждают тип/статус ключа и доступ ко всем операциям.

## Зависимости по коду

| Сценарий | Источник credentials и маршрут | Где проверено |
| --- | --- | --- |
| Диалог, планирование, tool use, фон, облачный анализ изображений | `config.openAiApiKey` из `OPENAI_API_KEY`; SDK с `OPENAI_BASE_URL` | `config.ts`, `openai.ts`, `ai/providers/openai.ts` |
| Веб-поиск при выборе OpenAI | Тот же SDK, `/responses` с web-search tool | `agents/webSearchAgent.ts`, `ai/responseCompletion.ts` |
| Векторная память при OpenAI-профиле | Основной ключ, `/embeddings`; админка имеет отдельный HTTP-путь | `ai/embedding.ts`, `ai/memoryEmbeddingHttp.js` |
| Whisper при соответствующем маршруте transcription | Основной ключ, `/audio/transcriptions` | `ai/providers/openai.ts`, `ai/transcription.ts`, `services/speechRecognition.ts` |
| Генерация и редактирование картинок | `OPENAI_IMAGE_API_KEY || OPENAI_API_KEY`; `OPENAI_IMAGE_BASE_URL || OPENAI_BASE_URL` | `ai/imageGeneration.js` |
| Модерация публичных account workers | `KIRA_PUBLIC_MODERATION_API_KEY || OPENAI_API_KEY`; отдельный URL override или основной gateway | `ai/accountModeration.ts`, `ai/accountPolicy.ts` |
| Необязательный Decisions | Основной SDK, `/decisions`, только при включённых соответствующих сценариях | `ai/providers/openai.ts` |
| Проверка подключения в админке | Основной ключ, `/models` через настроенный gateway | `ai/provider-registry.json`, `admin-panel/server.js` |

Клиент SDK может обслуживать и vision через Chat Completions/Responses: отдельного vision-key нет. Озвучивание через ElevenLabs использует другой сервис. Gemini, Kimi, OpenRouter, ZAI и LM Studio имеют собственные credentials, но наличие локального текстового маршрута не отменяет отдельные сервисные маршруты, профиль памяти или модерацию публичного аккаунта. Фактическая зависимость определяется сохранёнными настройками и разрешённым fallback, а не только `.env`.

`platform/runtime.ts:tenantEnvironment` передаёт модельные ключи менеджера в дочерние workers. Это общая workload identity для приложения, а не отдельный OpenAI project каждого tenant. Изменение env родителя требует пересоздания менеджера и workers; уже запущенные процессы не получат новый секрет автоматически. Не помещайте административные OpenAI credentials в окружение менеджера: его allowlist включает `OPENAI_*`.

## Окружения и права

Рекомендуемая схема: отдельные OpenAI projects `kira-prod` и `kira-staging`, service account приложения в каждом; для личной разработки — собственный user-owned project key. Это предлагаемые имена, существование проектов не проверялось. Ключи выдаёт владелец/уполномоченный администратор нужного проекта, runtime получает только workload key. Admin API key не нужен приложению.

| Credential | Минимально необходимые операции при включённом сценарии |
| --- | --- |
| Основной `OPENAI_API_KEY` | POST Chat Completions, Responses, embeddings, audio/transcriptions; доступ к реально выбранным моделям |
| Основной ключ для мониторинга | GET models, только если этот health check используется |
| Image override либо основной ключ при наследовании | POST images/generations и images/edits |
| Moderation override либо основной ключ при наследовании | POST moderations |
| Необязательный Decisions | Проверить поддержку endpoint и доступ в конкретном project/gateway перед включением |

Выдавайте права на фактически включённые endpoint-ы; права ключа и его owner/service-account role должны разрешать запрос. Для основного ключа учитывайте операции, унаследованные при пустых image/moderation overrides. Управление проектом, ключами, Assistants, fine-tuning, Vector Stores и Files не требуется по перечисленным путям. Multipart-запрос изображения или аудио не равен использованию `/files`.

Не добавляйте `OPENAI_PROJECT_ID` как способ миграции: заголовок не превращает legacy key в project key. SDK и прямые HTTP-пути обрабатывают такие настройки по-разному. Для project key используйте его собственный project scope; отдельно проверьте старые org/project headers в окружении SDK и настройках gateway на конфликт.

## Безопасный порядок перехода

1. **Инвентаризация без замены.** На каждом активном хосте/инстансе установите версию приложения, Compose project и источник env. Server/accounts Compose читает `.env.production`; админка монтирует его как `/app/env/bot.env`. Корневой `.env` служит также интерполяции Compose и не заменяет runtime-файл. Для обычного Node-запуска проверьте фактически загруженный `.env.<NODE_ENV>`. Учтите локальные установки, резервные инстансы, регулярные задачи, админку и workers.
2. **Сверка ключа.** В правильной организации OpenAI (проверьте ID, а не только название Personal) сопоставьте запись из уведомления: key ID/владелец, redacted value, последнее использование и доступный статус/события. Секреты сравнивайте только локально в доверенном окружении; наружу передавайте `match / no match / unknown`. Один совпавший суффикс — кандидат, а не достаточное доказательство. Не выводите `printenv`, полный `docker inspect`, `docker compose config`, Authorization, provider exception/config или содержимое `.env` в чат/CI.
3. **Прокси.** Для каждого base URL выясните, проходит ли OpenAI key напрямую, является ли токен виртуальным и где хранится upstream OpenAI credential. Проверка gateway token не доказывает исправность upstream. Не отправляйте действующий ключ на новый непроверенный endpoint; используйте доверенный HTTPS-маршрут, а внутренний HTTP — только в уже защищённой сети.
4. **Подготовка.** Если обнаружен затронутый legacy key либо отдельно согласован плановый переход, создайте project/service-account key с нужными правами, model access и лимитами. Сохраните его в secret manager/защищённом env-файле с правами `0600`. Новый staging project не даёт гарантии доступа к моделям production.
5. **Staging.** Установите новый ключ только в staging, сохранив модели, embedding dimension/profile, URL, fallback и identity/storage. Проверьте матрицу ниже. Ротация credentials не требует переиндексации памяти.
6. **Production — отдельное решение.** После подтверждения зависимости/необходимости перехода и успешного staging обновите нужные env-секреты, включая независимые overrides и upstream gateway. Пересоздайте сервисы штатным workflow того же инстанса; проверяйте сохранность volumes/namespace. Не запускайте второй Telegram poller с production bot token ради canary.
7. **Наблюдение и завершение.** Сверьте успешные пользовательские сценарии, provider/model, request IDs, 401/403/429, расход в целевом OpenAI project и фон после рестартов. До завершения проверки оставьте предыдущую secret version для отката, только если ключ ещё действителен и допустим. Уже отключённый ключ не является рабочим rollback. Отзывать старый ключ можно после проверки всех потребителей, включая другие проекты владельца, и отдельного согласования.

## Проверки работоспособности

| Проверка в staging/подтверждённом deployment | Критерий |
| --- | --- |
| Короткий диалог и один инструмент | Нужный provider/model, осмысленный ответ и реальный результат инструмента |
| Актуальный вопрос через веб | Выполнен web-search tool, есть источники; локальный ответ без поиска не засчитывается |
| Embedding + чтение памяти | Запись/поиск синтетического факта с прежней размерностью; отдельно admin embeddings |
| Короткий тестовый WAV | Получена transcription; это не проверяется текстовым диалогом |
| Синтетическая картинка на входе | Успех выбранного vision-маршрута |
| Генерация и edit с продуктовым reference | Получены оба результата с ожидаемым key source |
| Публичный account worker | Запрос/ответ прошли moderation, при 401/403 контроль остаётся fail-closed |
| Decisions, если используется | Отдельный успешный вызов поддерживаемой модели/endpoint |
| Фон/регулярные задачи и рестарт | Проверен новый процесс и один разрешённый тестовый запуск, без дублей доставки |

Используйте только синтетические тексты/файлы; платные live-проверки выполняются оператором после выдачи ключа и выбора окружения. Не публикуйте ответы с персональными данными. `/models` полезен для диагностики, но не заменяет проверки POST endpoint-ов. 401 означает проблему аутентификации, 403 — проверку прав/доступа/политик; 429 может быть лимитом или квотой и сам по себе не доказывает отключение legacy key. Сохраняйте HTTP status и безопасный request ID, а не сырое тело ошибки.

## Что проверяется автоматически

`tests/openai-project-keys.test.ts` использует синтетический `sk-proj-…` и подменяет HTTP: два SDK-клиента, Chat/Responses, embedding, transcription, Decisions, admin embedding, обе image-операции, независимая moderation, отказ 401 и наследование worker env. Это проверяет конфигурацию и передачу credentials, **не** действительность ключа, OpenAI permissions, доступность модели или качество live-сценария.

```sh
NODE_ENV=test KIRA_BOT_TOKEN=1234567890:abcdefghijklmnopqrstuvwxyzABCDE OPENAI_API_KEY=test node --require ts-node/register tests/openai-project-keys.test.ts
npm test
```

Итоги прогона фиксируются в описании PR. Production-секреты, OpenAI Dashboard и реальные развертывания этим изменением не проверялись.

## Официальная документация

- [API keys and service accounts](https://developers.openai.com/api/docs/guides/api-keys)
- [Permissions and RBAC](https://developers.openai.com/api/docs/guides/rbac)
- [Authentication and organization/project headers](https://developers.openai.com/api/reference/overview)
