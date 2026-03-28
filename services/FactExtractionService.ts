import { v4 as uuidv4 } from 'uuid';
import { MessageHistory } from '../types';
import { ExtractedFact } from '../types/FactTypes';
import { FACT_EXTRACTION_PROMPT } from '../utils/factExtraction';
import { devLog } from '../utils';
import openai from '../openai';

export class FactExtractionService {

  async extractFacts(dialog: MessageHistory[]): Promise<ExtractedFact[]> {
    const dialogText = dialog
      .map(m => `${m.role === 'user' ? 'Пользователь' : 'Бот'}: ${m.content}`)
      .join('\n');
    const prompt = FACT_EXTRACTION_PROMPT.replace('{dialog}', dialogText);

    try {
      devLog('Fact extraction prompt:', prompt);
      const resp = await openai.chat.completions.create({
        model: 'gpt-5-nano',
        messages: [
          { role: 'system', content: 'Ты извлекаешь факты из диалога и возвращаешь JSON.' },
          { role: 'user', content: prompt }
        ],
        temperature: 1,
      });

      const content = resp.choices[0]?.message?.content || '';
      devLog('Fact extraction response:', content);
      const data = JSON.parse(content).facts as any[];
      return data.map(f => ({
        id: uuidv4(),
        content: f.content,
        domain: f.domain,
        factType: f.factType,
        confidence: f.confidence,
        sourceContext: dialogText.slice(0, 200),
        extractedAt: new Date(),
        importance: f.importance,
        tags: Array.isArray(f.tags) ? f.tags : [],
      })) as ExtractedFact[];
    } catch (e) {
      console.error('Fact extraction error', e);
      return [];
    }
  }

  async extractFactsFromDialogue(dialoguePairs: DialoguePair[]): Promise<ExtractedFact[]> {
    if (dialoguePairs.length === 0) {
      devLog('Нет диалоговых пар, пропускаем извлечение фактов');
      return [];
    }

    devLog(`Извлечение фактов из ${dialoguePairs.length} диалоговых пар`);
    dialoguePairs.forEach((pair, i) => {
      devLog(`  Пара ${i}: "${pair.userMessage}" -> "${pair.botResponse}"`);
    });

    const dialogueText = dialoguePairs.map((pair, index) => {
        let text = `Диалог ${index + 1}:\n`;
        text += `Пользователь: ${pair.userMessage}\n`;
        text += `Бот: ${pair.botResponse}\n`;
        if (pair.userReply) {
            text += `Ответ пользователя: ${pair.userReply}\n`;
        } else {
            text += `[Пользователь не ответил]\n`;
        }
        return text;
    }).join('\n---\n');

    const prompt = `
Проанализируй диалоги между пользователем и ботом и извлеки ТОЛЬКО достоверные факты о пользователе.

ВАЖНЫЕ ПРАВИЛА:
1. Извлекай факты ТОЛЬКО из сообщений пользователя или его подтвержденных реакций
2. НЕ извлекай факты из предложений бота, которые пользователь не подтвердил
3. Если пользователь не ответил на предложение бота - это НЕ факт о его интересах
4. Факт считается достоверным только если пользователь явно согласился или подтвердил

ПРИМЕРЫ:
✅ Пользователь: "Мне нравится итальянская кухня" → Факт: предпочитает итальянскую кухню
✅ Бот: "Могу предложить пиццерию", Пользователь: "Да, отлично!" → Факт: интересуется пиццериями
❌ Бот: "Вот несколько ресторанов", Пользователь: [не ответил] → НЕ факт об интересах
❌ Бот: "Попробуй заняться спортом", Пользователь: [не ответил] → НЕ факт о спортивных интересах

АНАЛИЗИРУЕМЫЕ ДИАЛОГИ:
${dialogueText}

Верни JSON с фактами только о том, что пользователь ДЕЙСТВИТЕЛЬНО подтвердил или сказал сам:

{
  "facts": [
    {
      "content": "Конкретный подтвержденный факт о пользователе",
      "domain": "work|health|family|finance|education|hobbies|travel|social|home|personal|entertainment|general",
      "factType": "preference|skill|location|personal_info|goal|habit|relationship",
      "confidence": 0.0-1.0,
      "importance": 0.0-1.0,
      "tags": ["тег1", "тег2"],
      "evidence": "Цитата из диалога, подтверждающая факт"
    }
  ]
}`;

    try {
        devLog('Dialogue fact extraction prompt:', prompt);
        const resp = await openai.chat.completions.create({
            model: 'gpt-4.1',
            messages: [
                {
                    role: 'system',
                    content: 'Ты эксперт по извлечению фактов из диалогов. Извлекай ТОЛЬКО подтвержденные пользователем факты. Будь строгим в оценке достоверности.'
                },
                { role: 'user', content: prompt }
            ],
            temperature: 1,
        });

        const content = resp.choices[0]?.message?.content || '';
        devLog('Dialogue fact extraction response:', content);

        const jsonMatch = content.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
            devLog('No JSON found in dialogue fact extraction response');
            return [];
        }

        const parsedData = JSON.parse(jsonMatch[0]);

        if (!parsedData.facts || !Array.isArray(parsedData.facts)) {
            devLog('Invalid facts structure in dialogue extraction:', parsedData);
            return [];
        }

        return parsedData.facts.map((f: any) => ({
            id: uuidv4(),
            content: f.content,
            domain: f.domain,
            factType: f.factType,
            confidence: f.confidence || 0.5,
            sourceContext: f.evidence || dialogueText.slice(0, 200),
            extractedAt: new Date(),
            importance: f.importance || 0.5,
            tags: Array.isArray(f.tags) ? f.tags : [],
        })) as ExtractedFact[];

    } catch (e) {
        console.error('Dialogue fact extraction error:', e);
        return [];
    }
  }
}

export interface DialoguePair {
    userMessage: string;
    botResponse: string;
    userReply?: string;
    timestamp: Date;
    isUserInitiated: boolean;
}
