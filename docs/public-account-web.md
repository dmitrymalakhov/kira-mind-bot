# Личный веб-кабинет и доступ оператора

Кабинет включается только явным `KIRA_PUBLIC_WEB_ORIGIN=https://app.example.com`. Без него новые веб-маршруты отсутствуют. Origin должен совпадать с настроенным origin hCaptcha. Нативный контракт `kira.public-accounts.v1` и callback приложения сохраняются.

Кабинет открывает существующую Киру. Проверенный Google или Telegram, который ещё не привязан, получает `409 identity_not_linked`, без создания нового аккаунта и поиска по email. Для добавления способа нужны действующая сессия, свежее одноразовое подтверждение уже подключённого способа и отдельное подтверждение нового. UUID, зашифрованные привязки хранилищ и согласие на AI от входа не меняются.

## HTTP-контракт

Все JSON-запросы имеют `version:1`. Изменения требуют точного `Origin`, `X-CSRF-Token` из `/api/v1/web/config` и cookies браузера. Ошибки используют существующий `{error:{code,message}}`.

| Метод и путь | Назначение |
| --- | --- |
| GET `/account/`, `/account/account.js`, `/account/account.css` | Три фиксированных ресурса кабинета; `/account` перенаправляет на `/account/` |
| GET `/api/v1/web/config` | Публичная конфигурация, `channel:web`, `publicRegistration:false`, CSRF и `hasBrowserSession` |
| GET `/api/v1/web/session` | `{version,account,operatorAccess,operatorLinkingAvailable}` без токенов |
| POST `/api/v1/web/auth/challenges` | `{version,provider,purpose,reauthenticationToken?}`; ответ `{version,flowId,provider,purpose,nonce,expiresAt,authorizationUrl?,proofRequirement}` |
| POST `/api/v1/web/auth/password` | `{version,flowId,username,password,captchaToken}` |
| POST `/api/v1/web/auth/google` | `{version,flowId,identityToken,captchaToken}` |
| GET `/api/v1/web/auth/telegram/callback` | Одноразовые `state` и `code`, привязанные к браузеру; фиксированный redirect в кабинет |
| POST `/api/v1/web/auth/telegram` | `{version,flowId,captchaToken}`; обмен сохранённого кода только после hCaptcha |
| GET `/api/v1/web/auth/pending?flowId=UUID` | Только метаданные принадлежащего браузеру потока, без code/verifier/token |
| POST `/api/v1/web/auth/refresh` | `{version}`; ротация канонической семьи с фиксированным сроком |
| POST `/api/v1/web/auth/logout` | `{version}`; отзыв только записанной сервером сессии этого браузера, удаление привязки и cookies |

Успешный login возвращает `{version,account}`, reauthenticate — `{version,reauthenticationToken,expiresAt}`, link — существующий `IdentityView`. После потерянного ответа запрос `{version,flowId}` к тому же провайдеру восстанавливает проверенный результат в течение 120 секунд, если сессия/идентичность/свежее подтверждение ещё действуют. Изменённый полный payload получает `409 idempotency_conflict`. После истечения окна результат считается неподтверждённым; отмена не обещает отменить уже отправленную операцию.

GET `/api/v1/web/api/` допускает только `account`, `account/identities`, `account/sessions`, `account/consents`, `account/quota`, `status`, `history`, `settings`, `model-settings`, `model-preferences`. PATCH допускает `settings`; PUT — `account/consents`, `model-preferences`; DELETE — собственную identity/session по UUID с нативным телом, свежим подтверждением для identity и Idempotency-Key. Остальные маршруты, в частности ENV и Docker, отсутствуют. Обычный `/api/v1/` не принимает cookie вместо Bearer.

## Cookies и внешнее подтверждение

| Cookie | Срок и путь |
| --- | --- |
| `__Host-kira.access` | Канонический access, 15 минут, Path=/ |
| `__Secure-kira.refresh` | Канонический rotating refresh, фиксированный предел семьи 30 дней, Path=/api/v1/web/auth/refresh |
| `__Host-kira.browser` | Случайная привязка браузера/CSRF/потоков; 8 часов до входа, затем до срока семьи, Path=/ |
| `__Host-kira.operator` | Отдельная локальная сессия панели, до 8 часов; сама по себе не выдаёт роль |

Все cookies Secure, HttpOnly, без Domain; личный кабинет SameSite=Lax, оператор SameSite=Strict. JavaScript не получает access/refresh и не хранит их в local/sessionStorage или URL. Bootstrap-запись содержит хеш cookie, device/account/session UUID, сроки; она разрешает только точный семейный logout после утраты credentials, но не чтение данных, refresh, linking или права оператора. Терминальный refresh очищает credential cookies; logout остаётся доступен, очищает привязку и позволяет войти в другую существующую Киру.

Google использует официальный GIS ID token с серверным nonce и существующим Web client ID. Telegram использует RS256, S256 PKCE, `openid profile` и HTTPS callback `/api/v1/web/auth/telegram/callback`; native callback не заменяется. Code, state и verifier сохраняются зашифрованными максимум на 5 минут; JWT/профиль Google и CAPTCHA-ввод не сохраняются. Истёкшие потоки удаляются maintenance, записи аккаунта — фактическим удалением аккаунта.

## Граница оператора

`KIRA_PUBLIC_OPERATOR_ENABLED=true` вместе с origin и отдельным случайным `KIRA_OPERATOR_BRIDGE_SECRET` из 64 hex включает фиксированный `/operator/` proxy к Docker-сервису `http://admin-panel:3000`. Те же значения задаются менеджеру и admin-panel; только admin-panel использует `KIRA_ACCOUNT_AUTH_URL=http://kira-accounts:3300`. Bridge-secret не передаётся worker-ам. Сохраняется приватный loopback-доступ к панели с прежним ADMIN_USERNAME/ADMIN_PASSWORD.

Proxy пропускает только инвентарь методов/путей в `operatorProxy.ts`, отбрасывает encoded/traversal/backslash/double-slash пути и перезаписывает транспортные заголовки. `/internal/operator/session` и `/internal/operator/grants` доступны только внутреннему серверу с bridge-secret, отсутствуют в публичном инвентаре. Ни роль в заголовке, ни знание адреса, ни первая регистрация не дают доступа.

Для выдачи роли нужны login действующим паролем оператора, повторная проверка этого пароля, свежее одноразовое подтверждение текущей account-сессии и показанный пользователю точный UUID. Это ручное действие владельца после публикации. Social-вход в панель требует отдельного POST `/operator/api/operator/login-account`; каждый последующий запрос заново проверяет единым SQL snapshot сессию, identity, account, browser и активную роль. Изменение роли блокирует account, затем точную session перед потреблением доказательства. Выход из панели удаляет локальное намерение, сохраняя личный вход. Отзыв центральной сессии/идентичности или удаление аккаунта закрывают производный доступ. Приватный password recovery использует отдельное session store и не зависит от центральной проверки.

## Публикация и журналирование

Gateway передаёт эти фиксированные пути по существующему TLS upstream; новые DNS, tailnet-порты и прямой публичный доступ к admin-panel не нужны. Gateway по-прежнему перезаписывает доверенные secret/client-IP, а менеджер ограничивает попытки по проверенному IP. Произвольный `/internal/`, health, БД и другие локальные сервисы не публикуются.

Для новых маршрутов использовать access_log off либо формат только с `$uri` без query/headers/body/cookies. Особенно запрещены query callback, provider JWT, CAPTCHA, code/verifier, bearer/refresh и пароли в access/error/debug-логах. Ответы no-store/no-referrer; CSP кабинета разрешает только собственные файлы и официальные GIS/hCaptcha script/connect/frame endpoints. CSP панели разрешает собственные assets, inline styles MUI и blob worker, но не inline scripts. Не подменять эти CSP общим gateway-заголовком.

Перед выпуском: одна проверенная пара accounts/admin images, защищённая конфигурация и один рабочий recovery; свежие остановленные snapshots текущих account/identity/ledger/storage до и после candidate. Состояние владельца после его ручной привязки — текущий baseline; старые счётчики и snapshots до неё непригодны. Публикация gateway и роль владельца выполняются отдельно после review. Синтетические тесты не подтверждают фактическое человеческое прохождение Google/hCaptcha или выдачу роли владельцу.

Предлагаемое фактическое дополнение к публичной политике перед публикацией: «Личный кабинет использует защищённые cookies для входа, обновления сессии, защиты действий и продолжения подтверждения. Панель оператора использует отдельную cookie. Для входа могут загружаться Google Identity Services и hCaptcha. Привязка способа входа не включает согласие на AI; доступ оператора выдаётся отдельно после подтверждения». Это текст на review, а не утверждение, что политика уже опубликована.
