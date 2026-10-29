/** Fictional AR-room utterances for the intent decision made before any camera frame (stage "prepare").
 *  They are evaluation cases, not command definitions: wording, fillers, word order and speech-recognition noise vary
 *  on purpose. `intents` lists the acceptable decisions; `frame` whether a camera frame must be requested; `label` a
 *  stem the thing to show must contain (find/clarify). */
import type { SceneFollowUp, SceneIntent } from '../../api/scene';

export interface SceneIntentCase {
    id: string;
    text: string;
    intents: SceneIntent[];
    frame: boolean;
    label?: string;
    followUp?: SceneFollowUp;
    /** The recent dialogue, oldest first; `image` lines are what Kira said about an earlier frame. */
    history?: Array<{ role: 'user' | 'assistant'; content: string; image?: true }>;
}

const askedWhich = [
    { role: 'user' as const, content: 'покажи телефон' },
    { role: 'assistant' as const, content: 'На столе два телефона: чёрный у ноутбука и белый у края. Какой показать?', image: true as const },
];
const askedToAim = [
    { role: 'user' as const, content: 'где пульт' },
    { role: 'assistant' as const, content: 'Пульта на кадре не вижу. Наведи камеру на диван, он может быть там.', image: true as const },
];
const justShown = [
    { role: 'user' as const, content: 'покажи книгу' },
    { role: 'assistant' as const, content: 'Вот она, на полке справа.', image: true as const },
];

export function sceneIntentCases(): SceneIntentCase[] {
    return [
        // finding a thing, said in everyday ways
        { id: 'find-help', text: 'Не могу найти очки, поможешь?', intents: ['find'], frame: true, label: 'очк' },
        { id: 'find-again', text: 'Куда у меня опять запропастился пульт?', intents: ['find'], frame: true, label: 'пульт' },
        { id: 'find-polite', text: 'Можешь показать, где лежит зарядка?', intents: ['find'], frame: true, label: 'заряд' },
        { id: 'find-deictic', text: 'Видишь ту синюю штуку? Покажи на неё', intents: ['find'], frame: true },
        { id: 'find-asr', text: 'кира а где мой телефон я его только что тут положил', intents: ['find'], frame: true, label: 'телефон' },
        { id: 'find-filler', text: 'слушай ну ээ ключи мои где не видела', intents: ['find'], frame: true, label: 'ключ' },
        { id: 'find-slang', text: 'помоги отыскать кошелёк плиз', intents: ['find'], frame: true, label: 'кошел' },
        { id: 'find-past', text: 'ты не в курсе куда я дела наушники', intents: ['find'], frame: true, label: 'наушник' },
        { id: 'find-cut', text: 'покаж ноутбук', intents: ['find'], frame: true, label: 'ноут' },
        { id: 'find-offer', text: 'а книжка где-то тут была, найдёшь?', intents: ['find'], frame: true, label: 'кни' },
        { id: 'find-order', text: 'зарядку от ноута не видишь нигде?', intents: ['find'], frame: true, label: 'заряд' },
        // looking at what the camera shows
        { id: 'look-hand', text: 'что у меня в руке?', intents: ['look'], frame: true },
        { id: 'look-opinion', text: 'как тебе мой стол, не слишком захламлён?', intents: ['look'], frame: true },
        { id: 'look-read', text: 'прочитай, что написано на этой коробке', intents: ['look'], frame: true },
        { id: 'look-check', text: 'глянь, нормально я рубашку погладил?', intents: ['look'], frame: true },
        // ordinary talk that needs no camera, also when it names a thing
        { id: 'chat-recipe', text: 'расскажи рецепт борща', intents: ['chat'], frame: false },
        { id: 'chat-number', text: 'какой номер телефона у мамы?', intents: ['chat'], frame: false },
        { id: 'chat-weather', text: 'какая завтра погода', intents: ['chat'], frame: false },
        { id: 'chat-story', text: 'вчера потерял ключи в метро, представляешь, полдня искал', intents: ['chat'], frame: false },
        { id: 'chat-remind', text: 'напомни завтра купить зарядку', intents: ['chat'], frame: false },
        { id: 'chat-taste', text: 'а ты вообще любишь книги?', intents: ['chat'], frame: false },
        { id: 'chat-price', text: 'сколько сейчас стоит новый айфон', intents: ['chat'], frame: false },
        // answers to her question: which one, can she see it now, the other one
        { id: 'clarify-relative', text: 'вон тот, справа от ноутбука', intents: ['clarify', 'find'], frame: true, label: 'телефон',
            followUp: { label: 'телефон', reason: 'ambiguous' }, history: askedWhich },
        { id: 'clarify-colour', text: 'чёрный', intents: ['clarify', 'find'], frame: true, label: 'телефон', followUp: { label: 'телефон', reason: 'ambiguous' }, history: askedWhich },
        { id: 'clarify-near', text: 'который поближе ко мне', intents: ['clarify', 'find'], frame: true, label: 'телефон', followUp: { label: 'телефон', reason: 'ambiguous' }, history: askedWhich },
        { id: 'clarify-now', text: 'а теперь?', intents: ['clarify', 'find'], frame: true, label: 'пульт', followUp: { label: 'пульт', reason: 'not_found' }, history: askedToAim },
        { id: 'clarify-look', text: 'вот, смотри сейчас', intents: ['clarify', 'find'], frame: true, label: 'пульт', followUp: { label: 'пульт', reason: 'not_found' }, history: askedToAim },
        { id: 'clarify-other', text: 'нет, другую', intents: ['clarify', 'find'], frame: true, label: 'книг', followUp: { label: 'книга', reason: 'shown' }, history: justShown },
        { id: 'clarify-not-this', text: 'не эту а синюю', intents: ['clarify', 'find'], frame: true, label: 'книг', followUp: { label: 'книга', reason: 'shown' }, history: justShown },
        // changing her mind
        { id: 'cancel-forget', text: 'забей', intents: ['cancel'], frame: false, followUp: { label: 'телефон', reason: 'ambiguous' }, history: askedWhich },
        { id: 'cancel-later', text: 'ладно, не надо уже', intents: ['cancel'], frame: false, followUp: { label: 'пульт', reason: 'not_found' }, history: askedToAim },
        { id: 'cancel-wait', text: 'погоди, не надо', intents: ['cancel'], frame: false, history: [{ role: 'user', content: 'найди очки' }] },
        { id: 'cancel-stop', text: 'стоп, хватит искать', intents: ['cancel'], frame: false, history: [{ role: 'user', content: 'где ключи' }] },
        // a new topic while she was asking
        { id: 'topic-dinner', text: 'кстати, что у нас на ужин?', intents: ['chat'], frame: false, followUp: { label: 'телефон', reason: 'ambiguous' }, history: askedWhich },
        { id: 'topic-other-thing', text: 'покажи лучше где пульт', intents: ['find'], frame: true, label: 'пульт', followUp: { label: 'телефон', reason: 'ambiguous' }, history: askedWhich },
        { id: 'topic-thanks', text: 'спасибо!', intents: ['chat', 'cancel'], frame: false, followUp: { label: 'книга', reason: 'shown' }, history: justShown },
        // the body without the camera
        { id: 'body-sit', text: 'присядь куда-нибудь', intents: ['chat'], frame: false },
    ];
}
