import { Api, InputFile } from 'grammy';
import { ApiError, ApiMessage, ApiReply } from './contracts';
import { ApiActionTokens } from './actionTokens';
import { ApiFiles } from './files';

let sequence = 0;
export function nextApiMessageId(): number { return -(Date.now() * 1000 + sequence++ % 1000); }

/** Converts the existing handlers' delivery calls to channel-neutral mobile messages. */
export class ApiTransport {
    readonly api: Api;
    private readonly messages: ApiMessage[] = [];

    constructor(
        botToken: string,
        private readonly owner: number,
        private readonly actions: ApiActionTokens,
        private readonly files: ApiFiles,
        private readonly telegramApi: Api,
        private readonly allowExternalDelivery = false,
        private readonly actionVersion = '',
    ) {
        this.api = new Api(botToken);
        // No call falls through to the Bot API implicitly.
        this.api.config.use(async (_prev, method, payload) => {
            const result = await this.call(method, payload);
            return { ok: true, result } as any;
        });
    }

    result(): ApiReply { return { messages: this.messages }; }

    private async call(method: string, payload: any): Promise<unknown> {
        if (['getChat', 'getChatMember', 'getMe'].includes(method)) {
            return (this.telegramApi.raw as any)[method](payload);
        }
        if (payload.chat_id != null && Number(payload.chat_id) !== this.owner) {
            if (this.allowExternalDelivery && ['sendMessage', 'sendRichMessage'].includes(method)) {
                return (this.telegramApi.raw as any)[method](payload);
            }
            throw new ApiError(422, 'confirmation_required', 'Внешняя отправка требует подтверждения.');
        }
        if (['sendChatAction', 'setMessageReaction'].includes(method)) return true;
        if (method === 'answerCallbackQuery') {
            if (payload.text) this.messages.push({ id: nextApiMessageId(), type: 'notice', text: payload.text });
            return true;
        }
        const editing = method.startsWith('editMessage');
        const id = editing || method === 'deleteMessage' ? Number(payload.message_id) : nextApiMessageId();
        if (!Number.isSafeInteger(id) || id >= 0) {
            throw new ApiError(422, 'invalid_message', 'API может изменять только собственные сообщения.');
        }
        if (method === 'deleteMessage') {
            // Deletion carries the original API message id, just like edits.
            this.messages.push({ id: Number(payload.message_id), type: 'delete' });
            return true;
        }
        if (!['sendMessage', 'sendRichMessage', 'editMessageText', 'editMessageReplyMarkup',
            'sendPhoto', 'sendDocument', 'sendVoice'].includes(method)) {
            throw new ApiError(422, 'unsupported_delivery', 'Этот формат пока недоступен через API.');
        }
        const html = payload.rich_message?.html;
        const text = html ?? payload.text ?? payload.caption;
        const message: ApiMessage = {
            id,
            type: method === 'sendPhoto' ? 'photo' : method === 'sendDocument' ? 'document'
                : method === 'sendVoice' ? 'voice' : 'text',
            text,
            format: html || payload.parse_mode === 'HTML' ? 'html' : 'plain',
            ...(editing ? { replacesMessageId: id } : {}),
        };
        const rows = payload.reply_markup?.inline_keyboard;
        if (rows) {
            message.buttons = rows.map((row: any[]) => row.map(button => ({
                text: String(button.text),
                ...(button.callback_data ? { actionToken: this.actions.sign(id, button.callback_data, text ?? '', this.actionVersion) } : {}),
                ...(button.url && /^https?:\/\//i.test(button.url) ? { url: button.url } : {}),
            })).filter((button: any) => button.actionToken || button.url));
        }
        const media = payload.photo ?? payload.document ?? payload.voice;
        if (media instanceof InputFile) Object.assign(message, await this.files.save(media));
        else if (typeof media === 'string' && /^https?:\/\//i.test(media)) message.fileUrl = media;
        else if (media) throw new ApiError(422, 'unsupported_media', 'Файл Telegram недоступен через API.');
        this.messages.push(message);
        return {
            message_id: id, text: text ?? '', date: Math.floor(Date.now() / 1000),
            chat: { id: this.owner, type: 'private', first_name: 'Владелец' },
            reply_markup: payload.reply_markup,
        };
    }
}
