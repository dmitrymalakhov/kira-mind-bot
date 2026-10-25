import assert from 'node:assert/strict';
import test from 'node:test';
import { conversationAgent } from '../agents/conversationAgent';
import * as completions from '../ai/chatCompletion';
import * as selfMemory from '../utils/kiraSelfMemory';
import * as evolution from '../services/kiraSelfEvolutionService';
import * as residence from '../services/kiraResidenceService';
import * as groupSettings from '../services/groupChatFeatureSettings';
import type { BotContext } from '../types';
import { buildConversationFailureReply } from '../utils/conversationFailureReply';

test('conversation reports context overflow safely and recovers on the next turn', async t => {
    t.mock.method(groupSettings, 'isGroupChatContextEnabled', async () => false);
    t.mock.method(selfMemory, 'getRecentKiraSelfEvents', async () => []);
    t.mock.method(selfMemory, 'searchKiraSelfEventsByQuery', async () => []);
    t.mock.method(selfMemory, 'getKiraSelfMemoryState', async () => null as any);
    t.mock.method(residence, 'getKiraResidence', async () => ({ city: 'Синтетический город' }) as any);
    const evolve = t.mock.method(evolution, 'maybeEvolveKiraSelfFromConversation', async () => undefined);
    const log = t.mock.method(console, 'error', () => undefined);
    let shouldFail = true;
    const completion = t.mock.method(completions, 'createChatCompletionForTask', async () => {
        if (shouldFail) {
            throw Object.assign(new Error('400 Engine protocol: request (9000 tokens) exceeds the available context size (8192 tokens), synthetic-private-payload'), {
                status: 400,
                request: { headers: { authorization: 'synthetic-secret' } },
            });
        }
        return { choices: [{ message: { content: 'Дважды два — четыре.' } }] } as any;
    });
    const ctx = { from: { id: -100 }, chat: { id: -100, type: 'private' }, session: { messageHistory: [] } } as unknown as BotContext;
    const memory = { domain: 'personal', context: '' };

    const failed = await conversationAgent(ctx, 'Сколько будет дважды два?', false, '', [], undefined, memory);
    assert.match(failed.responseText, /контекст.*не помещается/iu);
    assert.match(failed.responseText, /увеличь окно контекста/iu);
    assert.doesNotMatch(failed.responseText, /давай обсудим|synthetic-private-payload|synthetic-secret/iu);
    assert.equal(failed.skipOptionalFollowups, true);
    assert.equal(evolve.mock.callCount(), 0);
    assert.equal(completion.mock.callCount(), 1);
    assert.equal(log.mock.callCount(), 1);
    assert.doesNotMatch(JSON.stringify(log.mock.calls[0].arguments), /synthetic-private-payload|synthetic-secret/iu);
    assert.equal((log.mock.calls[0].arguments as any[])[1].contextOverflow, true);

    shouldFail = false;
    const recovered = await conversationAgent(ctx, 'Сколько будет дважды два?', false, '', [], undefined, memory);
    assert.equal(recovered.responseText, 'Дважды два — четыре.');
    assert.equal(evolve.mock.callCount(), 1);
});

test('other conversation failures do not masquerade as a successful answer or expose provider data', () => {
    const reply = buildConversationFailureReply(new Error('synthetic-private-provider-payload'));
    assert.match(reply, /технической ошибки/iu);
    assert.doesNotMatch(reply, /давай обсудим|synthetic-private-provider-payload|увеличь окно/iu);
    assert.equal(buildConversationFailureReply(null), reply);
});

test('structured provider errors and escaped LM Studio engine errors identify context overflow', () => {
    for (const error of [
        { error: { code: 'context_length_exceeded' } },
        { error: { type: 'exceed_context_size_error' } },
        new Error('400 "Engine protocol: {\\"error\\":{\\"type\\":\\"exceed_context_size_error\\"}}"'),
        new Error('maximum context length exceeded'),
    ]) {
        assert.match(buildConversationFailureReply(error), /увеличь окно контекста/iu);
    }
});
