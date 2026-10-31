import assert from 'node:assert/strict';
import test from 'node:test';
import * as responses from '../ai/responseCompletion';
import { performWebSearch, webSearchAgent } from '../agents/webSearchAgent';
import { evaluateAvailabilityReview, AVAILABILITY_UNVERIFIED } from '../utils/availabilityVerification';

const now = new Date('2026-10-30T12:00:00Z');
function item(status = 'verified') {
    return { name: 'Тестовая обсерватория', status, summary: 'На субботу указаны экскурсии в 18:00. Наличие свободных мест отдельно не подтверждено.', sources: [
        { url: 'https://observatory.example/schedule', evidence: 'Официальное расписание субботы', datedAt: '2026-10-20' },
        { url: 'https://tickets.example/observatory', evidence: 'Действующее место и экскурсия', datedAt: '2026-10-21' },
    ] };
}
const review = (items: any[]) => JSON.stringify({ items });

test('only corroborated fresh entries become recommendations; old, conflicting and malformed evidence fails closed', () => {
    const good = evaluateAvailabilityReview(review([item()]), now);
    assert.equal(good.verified, true); assert.match(good.text, /субботу.*18:00/); assert.match(good.text, /свободных мест.*не подтверждено/);
    for (const candidate of [
        item('uncertain'), item('unavailable'),
        { ...item(), sources: [] }, { ...item(), sources: [item().sources[0]] },
        { ...item(), sources: item().sources.map(s => ({ ...s, url: 'https://observatory.example/same-site' })) },
        { ...item(), sources: item().sources.map(s => ({ ...s, datedAt: '2020-01-01' })) },
        { ...item(), sources: item().sources.map(s => ({ ...s, datedAt: '2026-11-30' })) },
        { ...item(), sources: item().sources.map(s => ({ ...s, datedAt: null })) },
        { ...item(), sources: item().sources.map(s => ({ ...s, url: 'javascript:alert(1)' })) },
        { ...item(), sources: item().sources.map(s => ({ ...s, datedAt: '2026-09-31' })) },
    ]) {
        const result = evaluateAvailabilityReview(review([candidate]), now);
        assert.equal(result.verified, false); assert.doesNotMatch(result.text, /18:00|Проверено:/);
    }
    for (const raw of ['', 'не JSON', '{}', 'null', review(Array.from({ length: 5 }, () => item()))]) {
        assert.equal(evaluateAvailabilityReview(raw, now).text, AVAILABILITY_UNVERIFIED);
    }
});

test('search performs another web check before delivery and never falls back to the draft on failure', async t => {
    const draft = 'Старая рекомендация: Тестовая обсерватория открыта ежедневно.';
    let attempt = 0; let fails = false;
    const call = t.mock.method(responses, 'createResponseForTask', async (task: string, params: any) => {
        assert.equal(task, 'webSearchReasoning'); assert.equal(params.tool_choice, 'required');
        attempt++;
        if (attempt % 2 === 1) return { output_text: draft } as any;
        assert.match(JSON.stringify(params.input), /Черновик может содержать устаревшие сведения/);
        assert.match(JSON.stringify(params.input), /субботу/);
        if (fails) throw Error('private-provider-error');
        return { output_text: review([item('unavailable')]) } as any;
    });
    const closed = await webSearchAgent('Подбери экскурсию', false, '', [{ role: 'user', content: 'Мы можем в субботу', timestamp: now }], '', { verifyAvailability: true });
    assert.equal(closed.webSearchSucceeded, false); assert.match(closed.responseText, /исключено из рекомендаций/); assert.doesNotMatch(closed.responseText, /открыта ежедневно/);
    fails = true;
    const failed = await performWebSearch('Экскурсия в субботу', { verifyAvailability: true });
    assert.equal(failed.success, false); assert.equal(failed.results, AVAILABILITY_UNVERIFIED); assert.equal(call.mock.callCount(), 4);
    assert.doesNotMatch(JSON.stringify(failed), /private-provider-error|открыта ежедневно/);
});

test('ordinary web queries keep one call; verified recommendations retain sources', async t => {
    let count = 0;
    t.mock.method(responses, 'createResponseForTask', async () => {
        count++;
        const candidate = item(); candidate.sources.forEach(s => { s.datedAt = new Date().toISOString().slice(0, 10); });
        return { output_text: count === 3 ? review([candidate]) : 'Краткий результат поиска.' } as any;
    });
    assert.equal((await performWebSearch('Общий поисковый вопрос')).results, 'Краткий результат поиска.');
    assert.equal(count, 1);
    const checked = await performWebSearch('Куда сходить в субботу?', { verifyAvailability: true });
    assert.equal(count, 3); assert.equal(checked.success, true);
    assert.match(checked.results!, /observatory.example\/schedule/);
});
