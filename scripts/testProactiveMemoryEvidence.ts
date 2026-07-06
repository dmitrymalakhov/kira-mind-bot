import assert from 'assert';
import { formatProactiveMemoryEvidence } from '../utils/proactiveMemoryEvidence';

function testEpisodeSourceIsHumanReadable(): void {
    const evidence = formatProactiveMemoryEvidence({
        content: [
            '[ЭПИЗОД ПАМЯТИ: episode-1]',
            'Источник: личная переписка с Коля (@kolya)',
            'Когда: 2026-07-04T18:00:00.000Z — 2026-07-04T18:20:00.000Z',
            'Кратко: обсуждали проблему Максима и не нашли решение.',
            'Открытые линии: решить, что делать с проблемой Максима',
        ].join('\n'),
        tags: ['memory-episode', 'source_contact:Коля'],
        sourceMessageIds: ['123:10', '123:11', '123:12', '123:13'],
    });

    assert.ok(evidence.includes('откуда: личная переписка с Коля (@kolya)'));
    assert.ok(evidence.includes('когда: 2026-07-04T18:00:00.000Z'));
    assert.ok(evidence.includes('незакрыто: решить, что делать с проблемой Максима'));
    assert.ok(evidence.includes('messageIds: 123:11, 123:12, 123:13'));
}

function testFallbackSourceContextAndContactTag(): void {
    const withContext = formatProactiveMemoryEvidence({
        content: 'Максиму нужно отправить варианты решения.',
        sourceContext: 'Личная переписка с Димой: 2026-07-05T06:00:00.000Z — 2026-07-05T06:10:00.000Z.',
    });
    assert.ok(withContext.includes('откуда: Личная переписка с Димой'));

    const withTag = formatProactiveMemoryEvidence({
        content: 'Есть открытый вопрос по Максу.',
        tags: ['source_contact:Дима'],
    });
    assert.ok(withTag.includes('откуда: Дима'));
}

testEpisodeSourceIsHumanReadable();
testFallbackSourceContextAndContactTag();

console.log('proactiveMemory evidence formatting tests passed');
