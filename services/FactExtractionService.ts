import { v4 as uuidv4 } from 'uuid';
import { MessageHistory } from '../types';
import { ExtractedFact } from '../types/FactTypes';
import { FACT_EXTRACTION_PROMPT } from '../utils/factExtraction';
import { devLog, parseLLMJson } from '../utils';
import { createChatCompletionForTask } from '../ai/chatCompletion';
import { PREDEFINED_DOMAINS } from '../constants/domains';
import { normalizeMemoryTemporalScope } from '../utils/memoryRetention';

function normalizeDomain(domain: unknown): string {
  const normalized = String(domain || '').trim().toLowerCase();
  return Object.values(PREDEFINED_DOMAINS).includes(normalized as any)
    ? normalized
    : PREDEFINED_DOMAINS.GENERAL;
}

function normalizeFactType(type: unknown): string {
  const value = String(type || '').trim();
  return value || 'personal_info';
}

export class FactExtractionService {

  async extractFacts(dialog: MessageHistory[]): Promise<ExtractedFact[]> {
    const dialogText = dialog
      .map(m => `${m.role === 'user' ? 'Пользователь' : 'Бот'}: ${m.content}`)
      .join('\n');
    const prompt = FACT_EXTRACTION_PROMPT.replace('{dialog}', dialogText);

    try {
      devLog('Fact extraction prompt:', prompt);
      const resp = await createChatCompletionForTask('memoryExtraction', {
        messages: [
          { role: 'system', content: 'Ты извлекаешь факты из диалога и возвращаешь JSON.' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.3,
      });

      const content = resp.choices[0]?.message?.content || '';
      devLog('Fact extraction response:', content);

      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        devLog('No JSON found in fact extraction response');
        return [];
      }
      const parsed = parseLLMJson<{ facts?: any[] }>(jsonMatch[0]);
      if (!parsed) return [];
      const data: any[] = Array.isArray(parsed.facts) ? parsed.facts : [];
      return data
        .filter(f => f?.content && String(f.content).trim().length > 0)
        .filter(f => (f.confidence ?? 0.5) >= 0.4)
        .map(f => ({
          id: uuidv4(),
          content: String(f.content).trim(),
          domain: normalizeDomain(f.domain),
          factType: normalizeFactType(f.factType),
          confidence: f.confidence ?? 0.5,
          sourceContext: dialogText.slice(0, 200),
          extractedAt: new Date(),
          importance: f.importance ?? 0.5,
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
Проанализируй диалоги между пользователем и ботом. Извлеки достоверные факты следующих типов:
1. Факты о самом пользователе (subject: "user")
2. Факты о конкретных контактах (subject: "contact")
3. Факты о родственниках/знакомых контакта (subject: "third_party")
4. Факты с потерянным референтом (subject: "unknown")

Сегодняшняя дата: ${today}

ПРАВИЛА для фактов о ПОЛЬЗОВАТЕЛЕ (subject: "user"):
1. Извлекай только из прямых высказываний пользователя о себе или его подтверждённых реакций
2. НЕ извлекай из предложений бота, которые пользователь не подтвердил
3. Если пользователь ИСПРАВЛЯЕТ ошибку бота — это важный факт, сохрани с датой
4. Информация в цитатах «[В ответ на "..." от Имя]» — это слова другого человека, не пользователя
5. Вопросы «какая задача?», «о чём ты?», «что за ...?» и ответы с отрицанием/сомнением НЕ подтверждают утверждение бота
6. Один факт — одно утверждение. Отделяй постоянные сведения от временных планов и не считай разные связи/детей/события взаимоисключающими без прямой поправки.
7. temporalScope: stable — устойчивые сведения о личности/биографии; relationship — связь людей; preference/routine — предпочтение/привычка; current_state — изменяемое состояние; future_plan — план/ожидание; past_event — установленное прошлое событие; unknown — неясно. Дата упоминания не ограничивает истинность биографического факта.
8. Имя, наличие и тип собственного родственника/питомца описывают связь пользователя: subject=user. Собственное событие родственника — отдельный факт о нём, без присвоения пользователю. Не теряй постоянную связь из-за плана в соседнем предложении; сохраняй каждое независимое утверждение отдельно. Явное отрицание устойчивой связи не делает её временной.
9. Для каждого факта верни predicate/object/negated и evidence — дословный непрерывный фрагмент слов пользователя, который поддерживает этот факт. Слова бота не являются evidence. Сохраняй отрицание в тексте и negated; поле factType является категорией, а не заменой атомарного предиката. Если прямой опоры нет, не возвращай факт.
10. predicate обозначает положительную связь/свойство без отрицания (например works_at, has_pet); отрицание этой связи кодируется negated=true, а не отдельным отрицательным предикатом. Текст content при этом сохраняет отрицание. «Не работает» и «больше не работает» означают works_at с negated=true; «нет питомца» — has_pet с negated=true. Не прячь отрицание в predicate при negated=false. Для утвердительного события используй его собственный предикат, не меняя смысл на отрицание другого события.

ПРАВИЛА для фактов о КОНТАКТАХ (subject: "contact"):
1. Извлекай факты о конкретных упомянутых людях (имя обязательно)
2. Источник: пользователь рассказывает о ком-то ("Юра сменил работу", "Саша переехал", "мой коллега болеет")
3. Также: инструкции "запомни об X: ...", реплаи с информацией о третьих лицах
4. Каждый факт привязан к конкретному человеку (поле contactName обязательно)
5. Безымянных контактов (просто "коллега", "друг" без имени) — НЕ извлекай, если имя неизвестно
6. ВАЖНО: в contactName используй полное имя, если оно известно из контекста — «Контакт Альфа Полный», а не «Контакт Альфа». Если в диалоге есть дополнительная часть имени, обязательно включи её: у пользователя может быть несколько одноимённых контактов
7. Родственник или знакомый контакта — subject: "third_party", а не сам контакт
8. Если из реплики нельзя доказать субъект — subject: "unknown"; не подставляй владельца чата

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
      "predicate": "один атомарный предикат",
      "object": "объект того же утверждения",
      "negated": false,
      "temporalScope": "stable|relationship|preference|routine|current_state|future_plan|past_event|unknown",
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
      "predicate": "один атомарный предикат",
      "object": "объект того же утверждения",
      "negated": false,
      "temporalScope": "stable|relationship|preference|routine|current_state|future_plan|past_event|unknown",
      "confidence": 0.0-1.0,
      "importance": 0.0-1.0,
      "tags": ["тег1"],
      "evidence": "Цитата"
    },
    {
      "subject": "third_party|unknown",
      "content": "Факт о третьем лице или событие с неизвестным субъектом",
      "domain": "work|health|family|finance|education|hobbies|travel|social|home|personal|entertainment|general",
      "factType": "personal_info|relationship|event",
      "predicate": "один атомарный предикат",
      "object": "объект того же утверждения",
      "negated": false,
      "temporalScope": "stable|relationship|preference|routine|current_state|future_plan|past_event|unknown",
      "confidence": 0.0-1.0,
      "importance": 0.0-1.0,
      "tags": ["evidence-only"],
      "evidence": "Цитата"
    }
  ]
}`;

    try {
      devLog('Dialogue fact extraction prompt:', prompt);
      const resp = await createChatCompletionForTask('messageAnalysis', {
        messages: [
          {
            role: 'system',
            content: 'Ты эксперт по извлечению фактов из диалогов. Извлекай ТОЛЬКО подтвержденные пользователем факты. Будь строгим в оценке достоверности.'
          },
          { role: 'user', content: prompt }
        ],
        temperature: 0.3,
      });

      const content = resp.choices[0]?.message?.content || '';
      devLog('Dialogue fact extraction response:', content);

      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        devLog('No JSON found in dialogue fact extraction response');
        return [];
      }

      const parsedData = parseLLMJson<{ facts?: any[] }>(jsonMatch[0]);

      if (!parsedData?.facts || !Array.isArray(parsedData.facts)) {
        devLog('Invalid facts structure in dialogue extraction:', parsedData);
        return [];
      }

      return parsedData.facts
        .filter((f: any) => f?.content && String(f.content).trim().length > 0)
        .filter((f: any) => typeof f.confidence === 'number' && Number.isFinite(f.confidence) && f.confidence >= 0.4 && f.confidence <= 1)
        .filter((f: any) => f.subject !== 'contact' || (f.contactName && String(f.contactName).trim().length > 0 && String(f.contactName).trim().length < 100))
        .filter((f: any) => typeof f.evidence === 'string' && f.evidence.trim().length > 0 &&
          dialoguePairs.some(pair => [pair.userMessage, pair.userReply].some(text => text?.includes(f.evidence.trim()))))
        .filter((f: any) => typeof f.predicate === 'string' && f.predicate.trim() && typeof f.object === 'string' && f.object.trim() && typeof f.negated === 'boolean')
        .map((f: any) => ({
          id: uuidv4(),
          content: String(f.content).trim(),
          domain: normalizeDomain(f.domain),
          factType: normalizeFactType(f.factType),
          predicate: f.predicate.trim(),
          object: f.object.trim(),
          negated: f.negated,
          confidence: f.confidence ?? 0.5,
          sourceContext: f.evidence.trim(),
          extractedAt: new Date(),
          importance: f.importance ?? 0.5,
          tags: [...(Array.isArray(f.tags) ? f.tags.filter((tag: unknown) => typeof tag === 'string' && !tag.startsWith('temporal_scope:')) : []),
            `temporal_scope:${normalizeMemoryTemporalScope(f.temporalScope)}`],
          subject: ['user', 'contact', 'third_party', 'unknown'].includes(f.subject)
            ? f.subject
            : 'unknown',
          contactName: f.subject === 'contact' ? String(f.contactName).trim() : undefined,
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
