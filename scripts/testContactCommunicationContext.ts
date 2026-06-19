import assert from 'assert';
import { formatContactCommunicationContext } from '../utils/contactCommunicationContext';

function testEmptyContext(): void {
    const context = formatContactCommunicationContext({ contactName: 'Иван' });

    assert.strictEqual(context.contactName, 'Иван');
    assert.deepStrictEqual(context.facts, []);
    assert.strictEqual(context.promptBlock, '');
}

function testPortraitAndFactsFormatting(): void {
    const context = formatContactCommunicationContext({
        contactName: 'Иван Петров',
        portrait: 'Пишет кратко, ценит конкретику.',
        facts: [
            '[Иван Петров] предпочитает короткие сообщения по делу.',
            'Лучше реагирует на варианты выбора, чем на открытые вопросы.',
        ],
    });

    assert.ok(context.promptBlock.includes('Иван Петров'));
    assert.ok(context.promptBlock.includes('Пишет кратко, ценит конкретику.'));
    assert.ok(context.promptBlock.includes('предпочитает короткие сообщения по делу'));
    assert.ok(context.promptBlock.includes('Лучше реагирует на варианты выбора'));
}

function testSafetyRulesArePresent(): void {
    const context = formatContactCommunicationContext({
        contactName: 'Мария',
        facts: ['Мария не любит длинные объяснения.'],
    });

    assert.ok(context.promptBlock.includes('Не раскрывай'));
    assert.ok(context.promptBlock.includes('память'));
    assert.ok(context.promptBlock.includes('Не добавляй новые факты'));
    assert.ok(context.promptBlock.includes('Не используй чувствительные сведения'));
}

testEmptyContext();
testPortraitAndFactsFormatting();
testSafetyRulesArePresent();

console.log('Contact communication context tests passed');
