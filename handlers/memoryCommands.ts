import { Bot, InlineKeyboard, Keyboard } from 'grammy';
import { BotContext } from '../types';
import { getMemoryStats, cleanupOldMemories, searchAllDomainsMemoriesWithFallback, getRecentMemories, getLastSaveError, generateMemoryBiography, findMemoryByContent, deleteMemoryById, generateMemoryInsights, compressOldMemories, getMemoryHealthReport } from '../utils/enhancedDomainMemory';
import { getVectorService } from '../services/VectorServiceFactory';
import { factAnalysisManager } from '../utils/factAnalysisTimer';
import { config } from '../config';
import { repairLegacyContactIdentities } from '../utils/contactMemoryRepair';
import { contactOptionLabel, resolveContactIdentity } from '../utils/contactMemory';
import { runMemoryConsolidationForContext } from '../services/MemoryConsolidationService';
import { runMemorySchemaConsolidationForContext } from '../services/MemorySchemaConsolidationService';
import { runMemorySleepCycleForUser } from '../services/MemorySleepCycleService';
import { getPersonalChatMemoryIndexStatus, runPersonalChatMemoryIndexingCycle } from '../services/personalChatMemoryIndexer';

function isAdmin(ctx: BotContext): boolean {
    return ctx.from?.id === config.adminUserId;
}

function getMemoryAdminKeyboard() {
    return new Keyboard()
        .text('/memory_stats')
        .text('/memory_cleanup')
        .text('/memory_last_insight')
        .row()
        .text('/debug_facts')
        .text('/admin_menu')
        .row()
        .text('/memory_consolidate')
        .text('/personal_chat_memory_status')
        .resized();
}

function isBareContactQuery(query: string): boolean {
    const trimmed = query.trim();
    return /^@[a-zA-Z0-9_]{3,32}$/.test(trimmed) ||
        /^[А-ЯЁA-Z][А-ЯЁA-Zа-яёa-z-]+(?:\s+[А-ЯЁA-Z][А-ЯЁA-Zа-яёa-z-]+){0,2}$/u.test(trimmed);
}

function ambiguousContactGuard(query: string): string | null {
    const target = isBareContactQuery(query)
        ? query.trim()
        : query.match(/^(@[a-zA-Z0-9_]{3,32}|[А-ЯЁA-Z][А-ЯЁA-Zа-яёa-z-]+(?:\s+[А-ЯЁA-Z][А-ЯЁA-Zа-яёa-z-]+){0,2})(?=\s|$|[:,.-])/u)?.[1]?.trim();
    if (!target) return null;

    const resolution = resolveContactIdentity(target);
    if (resolution.status !== 'ambiguous') return null;

    const variants = resolution.candidates
        .slice(0, 6)
        .map(contactOptionLabel)
        .join(', ');
    return `Имя «${target}» неоднозначно (${variants}). Уточни фамилию или username, чтобы я не выбрала не тот факт.`;
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
                '/memory_search <запрос> — ручная проверка поиска памяти (векторный + текстовый fallback)',
                '/memory_last_insight — последнее проактивное сообщение и его источники',
                '/memory_cleanup — очистка старых фактов',
                '/memory_consolidate [домен] — собрать сводные главы, модели и индексы памяти',
                '/personal_chat_memory_status — статус фонового изучения личных переписок',
                '/personal_chat_memory_run — запустить один цикл изучения личных переписок',
                '/debug_facts — диагностика извлечения фактов',
                '/memory_repair_contacts — проставить contact_id старым контактным фактам',
                '/chats — список чатов, в которых присутствует бот',
                '/public_mode — вкл/выкл публичный режим в текущей группе',
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

        const found = await searchAllDomainsMemoriesWithFallback(ctx, query, 5);
        if (found.length === 0) {
            console.warn(`⚠️ [memory_search] По запросу ничего не найдено: "${query}"`);
            await ctx.reply(`По запросу "${query}" ничего не найдено.`);
            return;
        }

        const response = found
            .map((item, idx) => {
                const tags = item.tags?.length ? `\ntags: ${item.tags.slice(0, 8).join(', ')}` : '';
                const history = item.previousVersions?.length
                    ? `\nраньше: ${item.previousVersions.slice(0, 2).map(v => v.content).join(' -> ')}`
                    : '';
                return [
                    `${idx + 1}. [${item.domain}] score=${item.score.toFixed(3)} importance=${item.importance.toFixed(2)} confidence=${(item.confidence ?? 0.6).toFixed(2)}`,
                    item.isAnchor ? 'anchor: yes' : undefined,
                    item.expiresAt ? `expiresAt: ${item.expiresAt.toISOString()}` : undefined,
                    item.content,
                    tags.trim() || undefined,
                    history.trim() || undefined,
                ].filter(Boolean).join('\n');
            })
            .join('\n\n');

        await ctx.reply(`🔎 Результаты поиска для: "${query}"\n\n${response}`);
    });


    bot.command('memory_last_insight', async (ctx) => {
        if (!isAdmin(ctx)) {
            await ctx.reply('⛔️ Доступ только для администратора.');
            return;
        }

        const insight = ctx.session.lastProactiveInsight;
        if (!insight) {
            await ctx.reply('Последней проактивной подсказки в сессии нет или она уже протухла.');
            return;
        }

        const createdAt = new Date(insight.createdAt).toLocaleString('ru-RU', {
            day: '2-digit',
            month: '2-digit',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
        });
        const sources = insight.sourceMemories.length > 0
            ? insight.sourceMemories.map((memory, index) => `${index + 1}. ${memory}`).join('\n\n')
            : 'Источник не сохранён.';

        await ctx.reply([
            `🧭 Последняя проактивная подсказка (${insight.kind}, ${createdAt}):`,
            '',
            insight.message,
            '',
            'Источники, на которых она была основана:',
            sources,
            '',
            'Если источник выглядит лишним, попробуй /memory_search по точной фразе из источника.',
        ].join('\n'));
    });

    bot.command('memory_cleanup', async (ctx) => {
        const removed = await cleanupOldMemories(ctx, 30);
        await ctx.reply(`Удалено старых воспоминаний: ${removed}`);
    });

    bot.command('memory_consolidate', async (ctx) => {
        if (!isAdmin(ctx)) {
            await ctx.reply('⛔️ Доступ только для администратора.');
            return;
        }

        const rawText = ctx.message?.text || '';
        const domain = rawText.replace('/memory_consolidate', '').trim();
        await ctx.reply(domain
            ? `Собираю сводные главы памяти для домена "${domain}"...`
            : 'Собираю сводные главы, устойчивые модели и индексы памяти...');

        const result = await runMemoryConsolidationForContext(ctx, {
            domain: domain || undefined,
            minFacts: domain ? 4 : 6,
            limit: 700,
            periodDays: 180,
            maxDomains: 8,
        });
        const schemas = await runMemorySchemaConsolidationForContext(ctx, {
            domain: domain || undefined,
            minSources: domain ? 8 : 12,
            limit: 800,
            periodDays: 240,
        });
        const sleep = ctx.from?.id
            ? await runMemorySleepCycleForUser(String(ctx.from.id))
            : undefined;

        const lines = [
            '✅ Консолидация памяти завершена.',
            `Создано глав: ${result.created}`,
            `Заменено старых глав: ${result.replaced}`,
            `Создано моделей пользователя: ${schemas.created}`,
            `Заменено старых моделей: ${schemas.replaced}`,
            sleep ? `Индекс открытых линий: ${sleep.openLoopIndexCreated ? 'обновлён' : 'не создан'}` : undefined,
            sleep ? `Индекс сомнений: ${sleep.uncertaintyIndexCreated ? 'обновлён' : 'не создан'}` : undefined,
            sleep ? `Смягчено устаревающих временных фактов: ${sleep.staleFactsSoftened}` : undefined,
            `Использовано источников: ${result.sourceCount}`,
            schemas.schemaTitles.length ? `Модели: ${schemas.schemaTitles.join(', ')}` : undefined,
            result.domains.length ? `Домены: ${result.domains.join(', ')}` : undefined,
            [...result.skipped, ...schemas.skipped, ...(sleep?.skipped ?? [])].length ? `Пропущено: ${[...result.skipped, ...schemas.skipped, ...(sleep?.skipped ?? [])].join('; ')}` : undefined,
        ].filter(Boolean);

        await ctx.reply(lines.join('\n'));
    });

    bot.command('personal_chat_memory_status', async (ctx) => {
        if (!isAdmin(ctx)) {
            await ctx.reply('⛔️ Доступ только для администратора.');
            return;
        }

        const status = await getPersonalChatMemoryIndexStatus();
        await ctx.reply(status);
    });

    bot.command('personal_chat_memory_run', async (ctx) => {
        if (!isAdmin(ctx)) {
            await ctx.reply('⛔️ Доступ только для администратора.');
            return;
        }

        await ctx.reply('Запускаю один цикл фонового изучения личных переписок...');
        const result = await runPersonalChatMemoryIndexingCycle({ force: true });
        await ctx.reply([
            '✅ Цикл завершён.',
            `Просмотрено личных диалогов: ${result.scannedDialogs}`,
            `Обработано чатов: ${result.processedChats}`,
            `Пропущено чатов: ${result.skippedChats}`,
            `Сообщений проанализировано: ${result.messagesAnalyzed}`,
            `Эпизодов переписок сохранено: ${result.episodesCreated}`,
            `Фактов найдено: ${result.factsFound}`,
            `Фактов сохранено: ${result.factsSaved}`,
            result.postConsolidation
                ? `Пост-консолидация: моделей ${result.postConsolidation.schemasCreated}, open-loop=${result.postConsolidation.openLoopIndexCreated ? 'да' : 'нет'}, uncertainty=${result.postConsolidation.uncertaintyIndexCreated ? 'да' : 'нет'}, softened=${result.postConsolidation.staleFactsSoftened}`
                : undefined,
            result.errors.length ? `Ошибки: ${result.errors.slice(0, 5).join('; ')}` : undefined,
        ].filter(Boolean).join('\n'));
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
        /^(?:что\s+(?:ты\s+)?(?:знаешь|помнишь|помнила)\s+обо?\s+мне|расскажи\s+что\s+(?:ты\s+)?(?:знаешь|помнишь)(?:\s+обо?\s+мне)?|покажи\s+(?:мою\s+)?память|что\s+ты\s+обо\s+мне(?:\s+знаешь)?)\??$/i,
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

        const guard = ambiguousContactGuard(query);
        if (guard) {
            await ctx.reply(guard);
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

    // /memory_repair_contacts — миграция старых contact:* фактов на contact_id/contact_key
    bot.command('memory_repair_contacts', async (ctx) => {
        if (!isAdmin(ctx)) {
            await ctx.reply('⛔️ Доступ только для администратора.');
            return;
        }

        await ctx.reply('Проверяю старые контактные факты и проставляю стабильные идентификаторы...');
        const result = await repairLegacyContactIdentities(ctx);
        await ctx.reply(
            [
                '✅ Проверка контактных фактов завершена.',
                `Просмотрено: ${result.scanned}`,
                `Исправлено: ${result.repaired}`,
                `Неоднозначных: ${result.ambiguous}`,
                `Пропущено: ${result.skipped}`,
            ].join('\n')
        );
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

        const guard = ambiguousContactGuard(query);
        if (guard) {
            await ctx.reply(guard);
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
