import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import bigInt from 'big-integer';
import { Api, type TelegramClient } from 'telegram';
import * as telegram from '../services/telegram';
import { lookupTelegramProfile } from '../services/telegramProfileService';
import { ContactsStore } from '../stores/ContactsStore';

const user = (id = 81001, values: Partial<Api.User> = {}) => new Api.User({ id: bigInt(id), firstName: 'Мирон', lastName: 'Тестовый', ...values });
function fixture(t: TestContext, options: { contacts?: Api.TypeUser[]; dialogs?: unknown[]; total?: number; fresh?: Api.TypeUser[]; fullId?: number; entity?: Api.TypeUser | Api.TypeChat; fail?: boolean } = {}) {
    const calls: string[] = [];
    const client = {
        invoke: async (request: unknown) => {
            if (options.fail) throw Error('private provider payload');
            if (request instanceof Api.contacts.GetContacts) {
                calls.push('contacts'); assert.equal(request.hash.toString(), '0');
                return new Api.contacts.Contacts({ users: options.contacts ?? [user()], contacts: [], savedCount: 0 });
            }
            assert.ok(request instanceof Api.users.GetFullUser); calls.push('profile');
            assert.equal((request.id as Api.User).id.toString(), '81001');
            return new Api.users.UserFull({ fullUser: new Api.UserFull({ id: bigInt(options.fullId ?? 81001), about: 'Синтетическое bio',
                settings: new Api.PeerSettings({}), notifySettings: new Api.PeerNotifySettings({}), commonChatsCount: 0 }),
                users: options.fresh ?? [user(81001, { phone: '12025550123', username: 'synthetic_miron' })], chats: [] });
        },
        getDialogs: async () => { calls.push('dialogs'); return Object.assign(options.dialogs ?? [], { total: options.total ?? options.dialogs?.length ?? 0 }); },
        getEntity: async () => { calls.push('username'); return options.entity ?? user(); },
    };
    t.mock.method(telegram, 'initTelegramClient', async (opts?: { preloadContacts?: boolean; silent?: boolean }) => {
        assert.deepEqual(opts, { preloadContacts: false, silent: true }); return client as unknown as TelegramClient;
    });
    return calls;
}

test('reads the live phone and profile of the unique contact, without cached private fields', async t => {
    const calls = fixture(t);
    const result = await lookupTelegramProfile('Мирон Тестовый');
    assert.equal(result.state, 'found'); assert.equal(result.source, 'telegram_profile'); assert.ok(result.checkedAt);
    assert.equal(result.profile?.phone, '+12025550123'); assert.equal(result.profile?.phoneStatus, 'available');
    assert.equal(result.profile?.username, 'synthetic_miron'); assert.equal(result.profile?.bio, 'Синтетическое bio');
    assert.deepEqual(calls, ['contacts', 'profile']);
});

test('emoji and invisible display-name decorations do not hide an exact contact', async t => {
    fixture(t, { contacts: [user(81001, { firstName: 'Ми\u200bрон', lastName: 'Тестовый 🙂' })] });
    assert.equal((await lookupTelegramProfile('Мирон Тестовый')).state, 'found');
});

test('a full decorated name stored in firstName is searchable without splitting the Telegram fields', async t => {
    fixture(t, { contacts: [user(81001, { firstName: 'Мирон\u00a0Тестовый ✨', lastName: undefined })] });
    assert.equal((await lookupTelegramProfile('Мирон Тестовый')).state, 'found');
});

test('decorated and undecorated namesakes remain ambiguous before any profile read', async t => {
    const calls = fixture(t, { contacts: [user(), user(81002, { lastName: 'Тестовый 🙂' })] });
    assert.equal((await lookupTelegramProfile('Мирон Тестовый')).state, 'ambiguous');
    assert.ok(!calls.includes('profile'));
});

test('an extra name component cannot be discarded to declare an exact person match', async t => {
    const calls = fixture(t);
    assert.notEqual((await lookupTelegramProfile('Мирон Тестовый Другой')).state, 'found');
    assert.ok(!calls.includes('profile'));
});

for (const query of ['Мирона Тестового', 'Тестовому Мирону']) test(`inflection proposes a candidate without silently choosing a person: ${query}`, async t => {
    const calls = fixture(t);
    const result = await lookupTelegramProfile(query);
    assert.equal(result.state, 'ambiguous'); assert.equal(result.candidates?.[0].id, 81001);
    assert.ok(!calls.includes('profile'));
});

test('decoration-only input cannot identify a person with an empty surname', async t => {
    const calls = fixture(t, { contacts: [user(81001, { lastName: undefined })] });
    assert.equal((await lookupTelegramProfile('🙂')).state, 'not_found');
    assert.ok(!calls.includes('profile'));
});

test('read-only contact lookup treats е and ё equally and keeps normalized namesakes ambiguous', async t => {
    fixture(t, { contacts: [user(81001, { firstName: 'Семен' })] });
    assert.equal((await lookupTelegramProfile('Семён Тестовый')).state, 'found');
});

test('е and ё normalization does not select between namesakes', async t => {
    const calls = fixture(t, { contacts: [user(81001, { firstName: 'Семен' }), user(81002, { firstName: 'Семён' })] });
    assert.equal((await lookupTelegramProfile('Семён Тестовый')).state, 'ambiguous');
    assert.ok(!calls.includes('profile'));
});

test('a confirmed ID resolves directly even when absent from the current contact and dialog pages', async t => {
    const calls = fixture(t, { contacts: [], dialogs: [], total: 600 });
    assert.equal((await lookupTelegramProfile('81001', ['phone'], 81001)).state, 'found');
    assert.deepEqual(calls, ['username', 'profile']);
});

test('a username reassigned to another account cannot replace the confirmed person', async t => {
    const calls = fixture(t, { entity: user(81002, { username: 'synthetic_miron' }) });
    assert.equal((await lookupTelegramProfile('@synthetic_miron', ['phone'], 81001)).state, 'unavailable');
    assert.ok(!calls.includes('profile'));
});

test('a hidden phone clears stale evidence and never falls back to cached phone', async t => {
    const store = ContactsStore.getInstance(), snapshot = store.serialize();
    store.saveContact({ id: 81001, firstName: 'Мирон', lastName: 'Тестовый', phone: '12025550199' });
    t.after(() => { store.deserialize(snapshot); });
    fixture(t, { contacts: [user(81001, { phone: '12025550199' })], fresh: [user()] });
    const result = await lookupTelegramProfile('Мирон Тестовый', ['phone']);
    assert.equal(result.state, 'found'); assert.equal(result.profile?.phoneStatus, 'not_visible');
    assert.equal(result.profile?.phone, undefined); assert.doesNotMatch(JSON.stringify(result), /12025550199/);
    assert.equal(store.getContact(81001)?.phone, '12025550199');
});

test('uses a personal dialog outside the address book and never interprets a group as a person', async t => {
    const calls = fixture(t, { contacts: [], dialogs: [{ entity: new Api.Chat({ id: bigInt(81002), title: 'Мирон Тестовый', photo: new Api.ChatPhotoEmpty(), participantsCount: 2, date: 0, version: 1 }) }, { entity: user() }] });
    const result = await lookupTelegramProfile('Мирон Тестовый');
    assert.equal(result.profile?.id, 81001); assert.deepEqual(calls, ['contacts', 'dialogs', 'profile']);
});

test('same names and fuzzy single matches require clarification without revealing phones', async t => {
    const calls = fixture(t, { contacts: [user(81001, { phone: '12025550123' }), user(81002, { username: 'synthetic_other', phone: '12025550124' })] });
    const result = await lookupTelegramProfile('Мирон Тестовый');
    assert.equal(result.state, 'ambiguous'); assert.equal(result.candidates?.length, 2); assert.ok(!calls.includes('profile'));
    assert.doesNotMatch(JSON.stringify(result), /1202555/);
    const fuzzy = await lookupTelegramProfile('Мирон Тестово');
    assert.equal(fuzzy.state, 'ambiguous');
});

test('a single fuzzy candidate is not automatically selected', async t => {
    const calls = fixture(t);
    assert.equal((await lookupTelegramProfile('Мирон Тестово')).state, 'ambiguous');
    assert.ok(!calls.includes('profile'));
});

test('a unique name in an incomplete dialog scan cannot prove identity', async t => {
    const calls = fixture(t, { contacts: [], dialogs: [{ entity: user() }], total: 500 });
    const result = await lookupTelegramProfile('Мирон Тестовый');
    assert.equal(result.state, 'incomplete'); assert.ok(!calls.includes('profile'));
    assert.doesNotMatch(JSON.stringify(result), /1202555/);
});

test('a strong Telegram ID can select a known correspondent on an incomplete scan', async t => {
    fixture(t, { contacts: [], dialogs: [{ entity: user() }], total: 500 });
    assert.equal((await lookupTelegramProfile('81001', ['phone'])).state, 'found');
});

test('resolves explicit username directly and only returns requested fields', async t => {
    const calls = fixture(t);
    const result = await lookupTelegramProfile('@synthetic_miron', ['username']);
    assert.equal(result.state, 'found'); assert.equal(result.profile?.username, 'synthetic_miron');
    assert.equal(result.profile?.phone, undefined); assert.equal(result.profile?.bio, undefined);
    assert.deepEqual(calls, ['username', 'profile']);
});

test('not found, hidden phone and unavailable Telegram are distinct outcomes', async t => {
    fixture(t, { contacts: [], dialogs: [] });
    assert.equal((await lookupTelegramProfile('Северин Вымышленный')).state, 'not_found');
});

test('errors are safe and never imply that a phone is hidden', async t => {
    fixture(t, { fail: true });
    const result = await lookupTelegramProfile('Мирон Тестовый');
    assert.equal(result.state, 'unavailable'); assert.equal(result.profile, undefined);
    assert.doesNotMatch(JSON.stringify(result), /private provider payload/);
});

test('no personal Telegram session cannot be replaced by a cached contact', async t => {
    t.mock.method(telegram, 'initTelegramClient', async () => undefined);
    assert.equal((await lookupTelegramProfile('Мирон Тестовый')).state, 'unavailable');
});

test('fresh result must contain the requested strong ID, not another returned user', async t => {
    fixture(t, { fresh: [user(81002, { phone: '12025550124' })] });
    const result = await lookupTelegramProfile('Мирон Тестовый');
    assert.equal(result.state, 'unavailable'); assert.doesNotMatch(JSON.stringify(result), /12025550124/);
});

test('a partial or mismatched full profile does not prove current phone visibility', async t => {
    fixture(t, { fresh: [user(81001, { min: true, phone: '12025550123' })] });
    assert.equal((await lookupTelegramProfile('Мирон Тестовый')).state, 'unavailable');
});

test('the full profile ID must match the selected account', async t => {
    fixture(t, { fullId: 81002 });
    assert.equal((await lookupTelegramProfile('Мирон Тестовый')).state, 'unavailable');
});

test('an explicit username pointing to a group is not a personal profile', async t => {
    const calls = fixture(t, { entity: new Api.Channel({ id: bigInt(81002), title: 'Синтетическая группа', photo: new Api.ChatPhotoEmpty(), date: 0 }) });
    assert.equal((await lookupTelegramProfile('@synthetic_group')).state, 'not_found');
    assert.ok(!calls.includes('profile'));
});

test('an unoccupied username is not confused with transport failure', async t => {
    t.mock.method(telegram, 'initTelegramClient', async () => ({ getEntity: async () => { throw { errorMessage: 'USERNAME_NOT_OCCUPIED' }; } }) as unknown as TelegramClient);
    assert.equal((await lookupTelegramProfile('@synthetic_missing')).state, 'not_found');
});
