import * as dotenv from "dotenv";
import { BotContext, DomainMemory } from "../types";
import { getDomainContextVector, searchAllDomainsMemories, searchMemories, getAnchorMemories } from './enhancedDomainMemory';
import { SmartDomainDetector } from './smartDomainDetection';
import { devLog } from '../utils';
import openai from "../openai";

dotenv.config({ path: `.env.${process.env.NODE_ENV}` });

const detector = new SmartDomainDetector();
const botId = process.env.BOT_ID || 'kira-mind-bot';

const MAX_FACTS = 10;

export function rememberFact(ctx: BotContext, domain: string, fact: string) {
    if (!ctx.session.domains[domain]) {
        ctx.session.domains[domain] = { summary: "", facts: [] };
    }
    ctx.session.domains[domain].facts.push(fact);
    if (ctx.session.domains[domain].facts.length > MAX_FACTS) {
        summarizeDomain(ctx, domain);
    }
}

export async function getDomainContext(ctx: BotContext, domain: string, query: string): Promise<string> {
    const memory = ctx.session.domains[domain];
    let context = '';

    if (memory) {
        context = memory.summary;
        if (memory.facts.length > 0) {
            context += `\n${memory.facts.slice(-5).join("\n")}`;
        }
    }

    const anchorResults = await getAnchorMemories(ctx, 2);
    const primaryVectorResults = await searchMemories(ctx, query, { domain, limit: 5 });
    const seen = new Set(anchorResults.map(r => r.id));
    let merged = [...anchorResults];
    for (const r of primaryVectorResults) {
        if (seen.has(r.id)) continue;
        merged.push(r);
        seen.add(r.id);
    }

    if (merged.length < 5) {
        devLog('Domain context fallback: expanding search globally', {
            domain,
            primaryCount: primaryVectorResults.length,
        });
        const fallbackResults = await searchAllDomainsMemories(ctx, query, 5);
        for (const result of fallbackResults) {
            if (seen.has(result.id)) continue;
            merged.push(result);
            seen.add(result.id);
            if (merged.length >= 7) break;
        }
    }

    merged = merged.slice(0, 7);
    const vectorContext = merged.map(result => result.content).join('\n');
    const fallback = await getDomainContextVector(ctx, domain, query, 5);
    const finalContext = vectorContext || fallback;

    return `${context}\n${finalContext}`.trim();
}

export async function detectDomain(ctx: BotContext, message: string): Promise<string> {
    devLog('Detect domain for message:', message);
    const domain = await detector.detectDomain(message, String(ctx.from?.id), ctx.session.messageHistory);
    devLog('Detected domain:', domain);
    return domain.toLowerCase();
}

async function summarizeDomain(ctx: BotContext, domain: string) {
    const memory = ctx.session.domains[domain];
    if (!memory) return;
    const prompt = `${memory.summary ? `Предыдущее резюме:\n${memory.summary}\n\n` : ""}` +
        `Вот факты о теме \"${domain}\":\n` +
        memory.facts.map((f, i) => `${i + 1}. ${f}`).join("\n") +
        "\nСделай короткое резюме фактов, сохранив ключевые моменты.";
    try {
        devLog('Domain summarization prompt:', prompt);
        const resp = await openai.chat.completions.create({
            model: "gpt-5-nano",
            messages: [{ role: "user", content: prompt }],
            temperature: 0.3,
        });
        devLog('Domain summarization response:', resp.choices[0]?.message?.content);
        memory.summary = resp.choices[0]?.message?.content || memory.summary;
        memory.facts = memory.facts.slice(-5);
    } catch (err) {
        console.error("Error summarizing domain", err);
    }
}
