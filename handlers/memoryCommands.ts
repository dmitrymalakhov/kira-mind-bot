import { Bot, InlineKeyboard, Keyboard } from 'grammy';
import { BotContext } from '../types';
import { getMemoryStats, cleanupOldMemories, searchAllDomainsMemories, getRecentMemories, getLastSaveError, generateMemoryBiography, findMemoryByContent, deleteMemoryById, generateMemoryInsights, compressOldMemories, getMemoryHealthReport } from '../utils/enhancedDomainMemory';
import { getVectorService } from '../services/VectorServiceFactory';
import { factAnalysisManager } from '../utils/factAnalysisTimer';
import { config } from '../config';

function isAdmin(ctx: BotContext): boolean {
    return ctx.from?.id === config.adminUserId;
}

function getMemoryAdminKeyboard() {
    return new Keyboard()
        .text('/memory_stats')
        .text('/memory_cleanup')
        .row()
        .text('/debug_facts')
        .text('/admin_menu')
        .resized();
}

export function registerMemoryCommands(bot: Bot<BotContext>) {
    bot.command(['admin_menu', 'admin'], async (ctx) => {
        if (!isAdmin(ctx)) {
            await ctx.reply('⛔️ Доступ только для администратора.');
            return;
        }

        await ctx.reply(
            [
                '🛠 Административное меню памяти и проверок',
                '',
                'Команды раздела:',
                '/memory_stats — статистика + последние 5 сохраненных фактов',
                '/memory_search <запрос> — ручная проверка векторного поиска',
                '/memory_cleanup — очистка старых фактов',
                '/debug_facts — диагностика извлечения фактов',
            ].join('\n'),
            { reply_markup: getMemoryAdminKeyboard() },
        );
    });

    bot.hears(['/memory_stats', '/memory_cleanup', '/debug_facts'], async (ctx, next) => {
        if (!isAdmin(ctx)) {
            await ctx.reply('⛔️ Доступ только для администратора.');
            return;
        }
        await next();
    });

    bot.command('memory_stats', async (ctx) => {
        const stats = await getMemoryStats(ctx);
        const recentFacts = await getRecentMemories(ctx, 5);

        let message = `Всего воспоминаний: ${stats.total}\n`;
        for (const [domain, count] of Object.entries(stats.domains)) {
            message += `- ${domain}: ${count}\n`;
        }

        message += '\n🕒 Последние сохраненные факты:\n';
        if (recentFacts.length === 0) {
            message += '- Нет сохраненных фактов';
        } else {
            recentFacts.forEach((fact, index) => {
                message += `${index + 1}. [${fact.domain}] ${new Date(fact.timestamp).toLocaleString('ru-RU')} — ${fact.content}\n`;
            });
        }

        await ctx.reply(message);
    });

    bot.command('memory_search', async (ctx) => {
        if (!isAdmin(ctx)) {
            await ctx.reply('⛔️ Доступ только для администратора.');
            return;
        }

        const rawText = ctx.message?.text || '';
        const query = rawText.replace('/memory_search', '').trim();

        if (!query) {
            await ctx.reply('Использование: /memory_search <запрос>');
            return;
        }

        const found = await searchAllDomainsMemories(ctx, query, 5);
        if (found.length === 0) {
            console.warn(`⚠️ [memory_search] По запросу ничего не найдено: "${query}"`);
            await ctx.reply(`По запросу "${query}" ничего не найдено.`);
            return;
        }

        const response = found
            .map((item, idx) => `${idx + 1}. [${item.domain}] score=${item.score.toFixed(3)}\n${item.content}`)
            .join('\n\n');

        await ctx.reply(`🔎 Результаты поиска для: "${query}"\n\n${response}`);
    });

    bot.command('memory_cleanup', async (ctx) => {
        const removed = await cleanupOldMemories(ctx, 30);
        await ctx.reply(`Удалено старых воспоминаний: ${removed}`);
    });

    bot.command('debug_facts', async (ctx) => {
        const analysis = factAnalysisManager.getPendingAnalysis(ctx.from?.id);
        const lastIndex = ctx.session.lastFactAnalysisIndex ?? 0;
        const vectorSvc = getVectorService();

        let message = `🔍 Отладка извлечения фактов:\n\n`;
        message += `Векторный сервис: ${vectorSvc ? '✅ подключен' : '❌ недоступен'}\n`;
        message += `Ожидающий анализ: ${analysis ? 'Да' : 'Нет'}\n`;
        message += `Последний анализ: индекс ${lastIndex}\n`;
        message += `Сообщений в истории: ${ctx.session.messageHistory.length}\n`;
        message += `Новых сообщений: ${Math.max(0, ctx.session.messageHistory.length - lastIndex)}\n`;
        const lastErr = getLastSaveError();
        if (lastErr) {
            message += `\n⚠️ Последняя ошибка сохранения: ${lastErr}`;
        }

        await ctx.reply(message);
    });

    // "Что ты знаешь обо мне?" — любой пользователь может спросить
    bot.hears(
        /что ты знаешь обо мне|что помнишь обо мне|расскажи что знаешь|покажи мою память|что ты обо мне знаешь/i,
        async (ctx) => {
            await ctx.reply('Собираю всё, что помню о тебе...');
            const biography = await generateMemoryBiography(ctx);
            await ctx.reply(biography);
        }
    );

    // "Забудь что я..." — поиск с подтверждением перед удалением
    bot.hears(/^(забудь[,\s]|удали из памяти|убери из памяти)/i, async (ctx) => {
        const raw = ctx.message?.text || '';
        const query = raw
            .replace(/^(забудь[,\s]+что я|забудь[,\s]+про|забудь[,\s]+|удали из памяти[,\s]+|убери из памяти[,\s]+)/i, '')
            .trim();

        if (!query) {
            await ctx.reply('Уточни, что именно забыть. Например: "Забудь, что я работаю в Сбере"');
            return;
        }

        const found = await findMemoryByContent(ctx, query);
        if (!found) {
            await ctx.reply(`Не нашла в памяти ничего похожего на "${query}". Попробуй сформулировать иначе.`);
            return;
        }

        const keyboard = new InlineKeyboard()
            .text('✅ Да, удалить', `mem_del:${found.id}:${found.domain}`)
            .text('❌ Отмена', 'mem_del_cancel');

        await ctx.reply(
            `Нашла в памяти:\n\n"${found.content}"\n\nУдалить этот факт?`,
            { reply_markup: keyboard }
        );
    });

    // Подтверждение удаления
    bot.callbackQuery(/^mem_del:(.+):(.+)$/, async (ctx) => {
        await ctx.answerCallbackQuery();
        const match = ctx.callbackQuery.data.match(/^mem_del:(.+):(.+)$/);
        if (!match) return;
        const [, memoryId, domain] = match;
        await deleteMemoryById(ctx, memoryId, domain);
        await ctx.editMessageText('Готово, этот факт удалён из памяти.');
    });

    bot.callbackQuery('mem_del_cancel', async (ctx) => {
        await ctx.answerCallbackQuery();
        await ctx.editMessageText('Удаление отменено.');
    });

    // /insights — анализ паттернов в долговременной памяти
    bot.command('insights', async (ctx) => {
        await ctx.reply('Анализирую паттерны в твоей памяти...');
        const insights = await generateMemoryInsights(ctx);
        await ctx.reply(insights);
    });

    // /memory_health — отчёт о качестве памяти
    bot.command('memory_health', async (ctx) => {
        const report = await getMemoryHealthReport(ctx);
        await ctx.reply(report);
    });

    // /memory_compress <домен> — эпизодическая компрессия старых фактов домена
    bot.command('memory_compress', async (ctx) => {
        if (!isAdmin(ctx)) {
            await ctx.reply('⛔️ Доступ только для администратора.');
            return;
        }

        const rawText = ctx.message?.text || '';
        const domain = rawText.replace('/memory_compress', '').trim();

        if (!domain) {
            await ctx.reply(
                'Использование: /memory_compress <домен>\n' +
                'Домены: work, health, family, finance, education, hobbies, travel, social, home, personal, entertainment, general'
            );
            return;
        }

        await ctx.reply(`Сжимаю факты домена "${domain}" старше 60 дней...`);
        const { compressed, deleted } = await compressOldMemories(ctx, domain, 60);

        if (deleted === 0) {
            await ctx.reply(`В домене "${domain}" нет фактов старше 60 дней (или их меньше 5).`);
        } else {
            await ctx.reply(
                `✅ Готово!\n` +
                `Сжато фактов: ${deleted} → ${compressed} эпизодных воспоминаний\n` +
                `Домен: ${domain}`
            );
        }
    });

    // /memory_history <запрос> — история изменений факта (previousVersions)
    bot.command('memory_history', async (ctx) => {
        const rawText = ctx.message?.text || '';
        const query = rawText.replace('/memory_history', '').trim();

        if (!query) {
            await ctx.reply('Использование: /memory_history <запрос>\nПример: /memory_history работа');
            return;
        }

        const found = await findMemoryByContent(ctx, query);
        if (!found) {
            await ctx.reply(`Не нашла в памяти ничего похожего на "${query}".`);
            return;
        }

        const lines: string[] = [`📜 История факта:\n\n🔹 Сейчас: "${found.content}"`];

        if (found.previousVersions && found.previousVersions.length > 0) {
            lines.push('\nПредыдущие версии:');
            for (const v of found.previousVersions) {
                const date = new Date(v.timestamp).toLocaleDateString('ru-RU');
                const conf = (v.confidence * 100).toFixed(0);
                lines.push(`• [${date}, достоверность ${conf}%] "${v.content}"`);
            }
        } else {
            lines.push('\nИстория изменений пока пуста — факт не менялся.');
        }

        await ctx.reply(lines.join('\n'));
    });
}
