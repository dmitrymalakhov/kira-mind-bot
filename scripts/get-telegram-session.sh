#!/bin/bash
# =============================================================================
# Получение Telegram Session String для Kira Mind Bot
#
# Запусти ОДИН РАЗ на своём компьютере, скопируй результат в .env.production
# =============================================================================

set -e

echo ""
echo "================================================"
echo "  Получение Telegram Session String"
echo "================================================"
echo ""
echo "Этот скрипт авторизует тебя в Telegram и выдаст"
echo "строку сессии для бота."
echo ""
echo "Требования:"
echo "  1. Аккаунт на my.telegram.org/apps (создать приложение)"
echo "  2. Docker (используется для запуска auth-сессии)"
echo ""

# Проверяем Docker
if ! command -v docker &> /dev/null; then
    echo "❌ Docker не найден. Установи Docker и повтори."
    exit 1
fi

read -p "Введи TELEGRAM_API_ID: " API_ID
read -p "Введи TELEGRAM_API_HASH: " API_HASH
read -p "Введи номер телефона (формат +79001234567): " PHONE

echo ""
echo "▶ Запуск контейнера авторизации..."

SESSION=$(docker run --rm -it \
    -e API_ID="$API_ID" \
    -e API_HASH="$API_HASH" \
    -e PHONE="$PHONE" \
    node:23-alpine sh -c '
        npm install -g telegram 2>/dev/null
        node -e "
const { TelegramClient, StringSession } = require(\"telegram\");
const readline = require(\"readline\");
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise(r => rl.question(q, r));
(async () => {
    const client = new TelegramClient(new StringSession(\"\"), parseInt(process.env.API_ID), process.env.API_HASH, { connectionRetries: 3 });
    await client.start({
        phoneNumber: process.env.PHONE,
        phoneCode: () => ask(\"Введи код из Telegram: \"),
        password: () => ask(\"Введи пароль 2FA (если есть, иначе Enter): \"),
        onError: (err) => { console.error(err); process.exit(1); }
    });
    console.log(\"\\n✅ SESSION_STRING=\" + client.session.save());
    await client.disconnect();
    rl.close();
})();
"
    ' 2>/dev/null | grep "SESSION_STRING=")

if [ -z "$SESSION" ]; then
    echo "❌ Не удалось получить Session String."
    exit 1
fi

echo ""
echo "================================================"
echo "✅ Готово! Добавь в .env.production:"
echo ""
echo "TELEGRAM_API_ID=$API_ID"
echo "TELEGRAM_API_HASH=$API_HASH"
echo "$SESSION"
echo "================================================"
echo ""
