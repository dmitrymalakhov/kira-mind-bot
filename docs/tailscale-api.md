# Подключение другого устройства через Tailscale

API работает на устройстве с ботом. Клиентскому MacBook, телефону или другому компьютеру нужны включённый Tailscale, адрес API и отдельный токен владельца. Копировать `.env.production`, Telegram-сессию или ключи AI на клиент не нужно.

Для подключения из интернета без Tailscale на клиенте используй [HTTPS-шлюз на VPS](public-api-gateway.md). Прямое приватное подключение может работать параллельно.

## Подключение клиента

Администратор инстанса может подготовить личный архив `runtime-data/api-client/kira-api-client.zip`. В нём находятся `README.md`, `connection.json`, `check_connection.py` и OpenAPI-контракт. Этот архив содержит токен владельца: передавай его только своим устройствам через AirDrop или другой приватный канал, вне Git и публичных ссылок.

1. На клиенте установи и включи Tailscale, войди в тот же tailnet.
2. Распакуй личный архив и открой Terminal в полученной папке.
3. Выполни:

   ```bash
   chmod 600 connection.json
   python3 check_connection.py
   ```

Успешная проверка подтверждает HTTPS, доступ через Tailscale и токен. Она вызывает только `/status`, не отправляет сообщения и не расходует AI-токены. Значение `baseUrl` из `connection.json` — адрес для настройки приложения; значение `token` — Bearer-токен. В мобильном приложении сохраняй токен в Keychain / Keystore.

Проверке нужны Python 3 и системный `curl` (на macOS он уже есть). Токен передаётся curl через stdin и не попадает в аргументы процесса. Проверка использует проверку TLS-сертификата и не следует перенаправлениям.

Для собственной интеграции используй [контракт API](external-api.md) и [OpenAPI](../api/openapi.json). Все запросы требуют `Authorization: Bearer <token>`. POST дополнительно требует `Content-Type: application/json` и уникальный `Idempotency-Key`; при сетевом сбое повторяй исходное тело с тем же ключом.

## Настройка устройства с ботом

В приватном `.env.production` включи `KIRA_API_ENABLED=true` и задай случайный `KIRA_API_TOKEN` минимум из 32 символов; для генерации подходит `openssl rand -hex 32`. `KIRA_ALLOWED_USER_ID` должен содержать ID владельца. Токен API не является ключом Tailscale или Telegram.

В compose `.env` укажи свободный порт и постоянную публикацию API:

```dotenv
API_PORT=8320
KIRA_API_PUBLISH=true
```

Локальный запуск сам добавит `docker-compose.api.yml`, проверив project identity и существующие тома:

```bash
./scripts/ops/local.sh up -d --build --no-deps kira-mind-bot
```

Если `.env.production` заменён атомарно, пересоздай также админку, чтобы её bind mount ссылался на актуальный файл:

```bash
./scripts/ops/local.sh up -d --no-deps --force-recreate admin-panel
```

Внутри контейнера API слушает `3200`; на хосте опубликован только `127.0.0.1:8320`. Добавь отдельный Tailscale Serve listener, например `8443`, предварительно проверив `tailscale serve status`:

```bash
# macOS с приложением Tailscale:
/Applications/Tailscale.app/Contents/MacOS/Tailscale \
  serve --bg --https=8443 http://127.0.0.1:8320

/Applications/Tailscale.app/Contents/MacOS/Tailscale serve status
```

Адрес клиента: `https://<имя-устройства>.<tailnet>.ts.net:8443/api/v1`. HTTPS завершается на Tailscale; путь `/api/v1` сохраняется. Listener на другом порту, например для LM Studio, остаётся отдельным. Флаг `--bg` сохраняет Serve после перезапуска Tailscale. Доступ определяется правилами tailnet; при ограничениях разреши нужным устройствам TCP `8443` к хосту бота. [Официальная справка Serve](https://tailscale.com/docs/reference/tailscale-cli/serve).

Для обычных локальных обновлений достаточно `./scripts/ops/local.sh up ...`: флаг `KIRA_API_PUBLISH=true` сохраняет API overlay. В VPS workflow используй `SERVER_COMPOSE_OVERRIDE=docker-compose.api.yml`.

## Если подключение не работает

| Результат | Что проверить |
| --- | --- |
| DNS / timeout | Tailscale включён на обоих устройствах, хост не спит, доступ разрешён правилами tailnet |
| HTTP 502 | Serve работает, но backend недоступен: проверить контейнер и `127.0.0.1:8320` |
| HTTP 401 | Сеть и API доступны; токен отсутствует, неверен или заменён |
| HTTP 409 | Прочитать `error.code`: занятый диалог можно повторить с тем же ключом; неопределённое действие не пересылать с новым ключом автоматически |
| HTTP 410 | Кнопка устарела; запросить актуальное меню |
| HTTP 429 | Подождать `Retry-After` |

Mac с ботом должен оставаться включённым, а Docker Desktop и Tailscale — работать. Клиент использует общие знания и задачи, но отдельную мобильную сессию; фоновые уведомления пока приходят в Telegram.

Отключить только API listener, сохранив другие Serve-прокси:

```bash
/Applications/Tailscale.app/Contents/MacOS/Tailscale serve --bg --https=8443 off
```

Для отзыва доступа замени `KIRA_API_TOKEN`, пересоздай бот и админку, затем обнови личные клиентские файлы. Архивы со старым токеном больше не предоставляют доступ.
