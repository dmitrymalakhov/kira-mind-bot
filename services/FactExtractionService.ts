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

    const today = new Date().toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
    const prompt = `
Проанализируй диалоги между пользователем и ботом. Извлеки достоверные факты ДВУХ типов:
1. Факты о самом пользователе (subject: "user")
2. Факты о других людях/контактах, которых пользователь упоминает (subject: "contact")

Сегодняшняя дата: ${today}

ПРАВИЛА для фактов о ПОЛЬЗОВАТЕЛЕ (subject: "user"):
1. Извлекай только из прямых высказываний пользователя о себе или его подтверждённых реакций
2. НЕ извлекай из предложений бота, которые пользователь не подтвердил
3. Если пользователь ИСПРАВЛЯЕТ ошибку бота — это важный факт, сохрани с датой
4. Информация в цитатах «[В ответ на "..." от Имя]» — это слова другого человека, не пользователя

ПРАВИЛА для фактов о КОНТАКТАХ (subject: "contact"):
1. Извлекай факты о конкретных упомянутых людях (имя обязательно)
2. Источник: пользователь рассказывает о ком-то ("Юра сменил работу", "Саша переехал", "мой коллега болеет")
3. Также: инструкции "запомни об X: ...", реплаи с информацией о третьих лицах
4. Каждый факт привязан к конкретному человеку (поле contactName обязательно)
5. Безымянных контактов (просто "коллега", "друг" без имени) — НЕ извлекай, если имя неизвестно
6. ВАЖНО: в contactName используй ПОЛНОЕ имя если оно известно из контекста — «Юрий Никишенко», а не просто «Юра». Если фамилия упомянута в диалоге — обязательно включи её. Это критично: у пользователя может быть несколько контактов с одним именем

ПРИМЕРЫ:
✅ "Я уже во Вьетнаме" → subject: "user", domain: travel
✅ "Юра сменил работу, теперь в Яндексе" → subject: "contact", contactName: "Юра", domain: work
✅ "Саша заболел, не придёт" → subject: "contact", contactName: "Саша", domain: health
✅ "Запомни про Ивана: он не пьёт алкоголь" → subject: "contact", contactName: "Иван", domain: personal
❌ "Бот предложил спорт, пользователь промолчал" → НЕ факт

АНАЛИЗИРУЕМЫЕ ДИАЛОГИ:
${dialogueText}

Верни JSON:

{
  "facts": [
    {
      "subject": "user",
      "content": "Факт о пользователе",
      "domain": "work|health|family|finance|education|hobbies|travel|social|home|personal|entertainment|general",
      "factType": "preference|skill|location|personal_info|goal|habit|relationship",
      "confidence": 0.0-1.0,
      "importance": 0.0-1.0,
      "tags": ["тег1"],
      "evidence": "Цитата"
    },
    {
      "subject": "contact",
      "contactName": "Имя контакта",
      "content": "Факт об этом человеке, от третьего лица",
      "domain": "work|health|family|finance|education|hobbies|travel|social|home|personal|entertainment|general",
      "factType": "preference|skill|location|personal_info|goal|habit|relationship",
      "confidence": 0.0-1.0,
      "importance": 0.0-1.0,
      "tags": ["тег1"],
      "evidence": "Цитата"
    }
  ]
}`;

    try {
      devLog('Dialogue fact extraction prompt:', prompt);
      const resp = await openai.chat.completions.create({
        model: 'gpt-5.4',
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
        subject: f.subject === 'contact' ? 'contact' : 'user',
        contactName: f.subject === 'contact' && f.contactName ? String(f.contactName).trim() : undefined,
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
