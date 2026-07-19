import path from 'node:path';

/** Изолированное окружение TS smoke/regression-тестов без production-секретов. */
export function buildSyntheticTestEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
    return {
        ...base,
        NODE_ENV: 'test',
        KIRA_BOT_TOKEN: 'synthetic-test-token',
        OPENAI_API_KEY: 'synthetic-test-openai-key',
        GEMINI_API_KEY: 'synthetic-test-gemini-key',
        TELEGRAM_API_ID: '100000',
        TELEGRAM_API_HASH: 'synthetic-test-hash',
        ALLOWED_USER_ID: '100001',
        ADMIN_USER_ID: '100002',
        OWNER_NAME: 'Тестовый пользователь',
        OWNER_USERNAME: 'synthetic_owner',
        USER_NAME: 'Тестовый пользователь',
        BOT_USERNAME: 'synthetic_test_bot',
        DB_PASSWORD: 'synthetic-test-password',
        PERSONALITY_FILE: path.join(process.cwd(), 'fixtures', 'nonexistent-test-personality.json'),
    };
}
