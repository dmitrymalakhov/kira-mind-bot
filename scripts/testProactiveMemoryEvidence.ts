import assert from 'assert';
import { formatProactiveMemoryEvidence } from '../utils/proactiveMemoryEvidence';

function testEpisodeSourceIsHumanReadable(): void {
    const memory = {
        content: [
            '[ЭПИЗОД ПАМЯТИ: episode-1]',
            'Источник: личная переписка с контактом из переписки (@contact)',
            'Когда: 2026-07-04T18:00:00.000Z — 2026-07-04T18:20:00.000Z',
            'Кратко: обсуждали рабочий вопрос и не нашли решение.',
            'Открытые линии: решить, что делать с проблемой проекта',
        ].join('\n'),
        tags: ['memory-episode', 'source_contact:Контакт'],
        sourceMessageIds: ['123:10', '123:11', '123:12', '123:13'],
    };
    const evidence = formatProactiveMemoryEvidence(memory);

    assert.ok(evidence.includes('откуда: личная переписка с контактом из переписки (@contact)'));
    assert.ok(evidence.includes('когда: 2026-07-04T18:00:00.000Z'));
    assert.ok(evidence.includes('незакрыто: решить, что делать с проблемой проекта'));
    assert.ok(!evidence.includes('messageIds'));

    const diagnosticEvidence = formatProactiveMemoryEvidence(memory, { includeMessageIds: true });
    assert.ok(diagnosticEvidence.includes('messageIds: 123:11, 123:12, 123:13'));
}

function testFallbackSourceContextAndContactTag(): void {
    const withContext = formatProactiveMemoryEvidence({
        content: 'По проекту нужно отправить варианты решения.',
        sourceContext: 'Личная переписка с контактом: 2026-07-05T06:00:00.000Z — 2026-07-05T06:10:00.000Z.',
    });
    assert.ok(withContext.includes('откуда: Личная переписка с контактом'));

    const withTag = formatProactiveMemoryEvidence({
        content: 'Есть открытый вопрос по проекту.',
        tags: ['source_contact:Контакт'],
    });
    assert.ok(withTag.includes('откуда: Контакт'));
}

function testEmptyContentAndTimestampFallback(): void {
    const evidence = formatProactiveMemoryEvidence({
        content: '',
        timestamp: new Date('2026-07-04T18:00:00.000Z'),
    });

    assert.ok(evidence.includes('откуда: источник не указан'));
    assert.ok(evidence.includes('когда: 04.07.2026, 18:00'));
}

testEpisodeSourceIsHumanReadable();
testFallbackSourceContextAndContactTag();
testEmptyContentAndTimestampFallback();

console.log('proactiveMemory evidence formatting tests passed');
