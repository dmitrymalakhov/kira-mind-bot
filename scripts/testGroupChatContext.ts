import assert from "assert";
import { pushGroupChatMessage } from "../stores/GroupChatBuffer";
import {
    buildGroupChatContext,
    isContextDependentGroupMessage,
    isMessageReplyToBot,
} from "../utils/groupChatContext";
import { isStatusCommandArg, parseBooleanCommandArg } from "../utils/booleanCommandArg";

function mentionEntity(text: string, mention: string) {
    return {
        type: "mention",
        offset: text.indexOf(mention),
        length: mention.length,
    };
}

async function main() {
    {
        const chatId = -1001001;
        const text = "А ты что думаешь? @KiraMindBot";

        pushGroupChatMessage(chatId, {
            senderName: "OuroborosWithLove",
            text: "Наказание должно быть банковское, бюрократическое и максимально безболезненное.",
            date: new Date(),
            messageId: 10,
            senderId: 100,
            isBot: true,
        });
        pushGroupChatMessage(chatId, {
            senderName: "Дим",
            text,
            date: new Date(),
            messageId: 11,
            senderId: 92174505,
        });

        const ctx: any = {
            chat: { id: chatId, type: "supergroup" },
            from: { id: 92174505, first_name: "Дим" },
            message: {
                message_id: 11,
                text,
                entities: [mentionEntity(text, "@KiraMindBot")],
            },
            session: {},
        };

        const snapshot = await buildGroupChatContext(ctx, text, { botUsername: "KiraMindBot" });
        assert.equal(snapshot.isGroupChat, true);
        assert.equal(snapshot.isContextDependent, true);
        assert(snapshot.triggerReasons.includes("mention"));
        assert(snapshot.promptBlock.includes("OuroborosWithLove (бот)"));
        assert(snapshot.promptBlock.includes("банковское"));
        assert(!snapshot.recentMessages.some(m => m.messageId === 11));
    }

    {
        const chatId = -1001002;
        const text = "да, продолжай";
        const ctx: any = {
            chat: { id: chatId, type: "supergroup" },
            from: { id: 42, first_name: "Лена" },
            message: {
                message_id: 22,
                text,
                reply_to_message: {
                    message_id: 21,
                    text: "Я бы выбрала мягкий вариант.",
                    from: { id: 777, first_name: "Kira", username: "KiraMindBot", is_bot: true },
                },
            },
            session: {},
        };

        assert.equal(isMessageReplyToBot(ctx, "KiraMindBot"), true);
        const snapshot = await buildGroupChatContext(ctx, text, { botUsername: "KiraMindBot" });
        assert(snapshot.triggerReasons.includes("reply_to_bot"));
        assert(snapshot.triggerReasons.includes("reply"));
        assert(snapshot.promptBlock.includes("Пользователь отвечает на сообщение"));
        assert(snapshot.promptBlock.includes("мягкий вариант"));
    }

    {
        const chatId = -1001003;
        const text = "что думаешь?";
        const ctx: any = {
            chat: { id: chatId, type: "group" },
            from: { id: 42, first_name: "Лена" },
            message: { message_id: 31, text },
            session: {},
        };

        assert.equal(isContextDependentGroupMessage(text), true);
        const snapshot = await buildGroupChatContext(ctx, text);
        assert.equal(snapshot.isContextDependent, true);
        assert(snapshot.systemHint.includes("не выдумывай"));
    }

    {
        const chatId = -1001004;
        const text = "@KiraMindBot что тут было?";
        const ctx: any = {
            chat: { id: chatId, type: "supergroup" },
            from: { id: 42, first_name: "Лена" },
            message: {
                message_id: 41,
                text,
                entities: [mentionEntity(text, "@KiraMindBot")],
            },
            session: {},
        };

        const snapshot = await buildGroupChatContext(ctx, text, {
            botUsername: "KiraMindBot",
            enabled: false,
        });
        assert.equal(snapshot.isGroupChat, true);
        assert.equal(snapshot.promptBlock, "");
        assert.equal(snapshot.recentMessages.length, 0);
        assert(snapshot.debugSummary.includes("recent-disabled"));
    }

    {
        const chatId = -1001005;
        const text = "а почему?";
        const ctx: any = {
            chat: { id: chatId, type: "supergroup" },
            from: { id: 42, first_name: "Лена" },
            message: {
                message_id: 51,
                text,
                reply_to_message: {
                    message_id: 50,
                    text: "Потому что до этого бот уже выбрал мягкий вариант.",
                    from: { id: 777, first_name: "Kira", username: "KiraMindBot", is_bot: true },
                },
            },
            session: {},
        };

        const snapshot = await buildGroupChatContext(ctx, text, {
            botUsername: "KiraMindBot",
            enabled: false,
        });
        assert.equal(snapshot.isGroupChat, true);
        assert.equal(snapshot.recentMessages.length, 0);
        assert(snapshot.triggerReasons.includes("reply_to_bot"));
        assert(snapshot.promptBlock.includes("Пользователь отвечает на сообщение"));
        assert(snapshot.promptBlock.includes("мягкий вариант"));
        assert(snapshot.debugSummary.includes("recent=disabled"));
    }

    {
        assert.equal(parseBooleanCommandArg("on"), true);
        assert.equal(parseBooleanCommandArg("выкл"), false);
        assert.equal(parseBooleanCommandArg("offf"), undefined);
        assert.equal(isStatusCommandArg(""), true);
        assert.equal(isStatusCommandArg("статус"), true);
        assert.equal(isStatusCommandArg("offf"), false);
    }

    console.log("groupChatContext checks passed");
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
