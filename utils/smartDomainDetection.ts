import { MessageHistory } from '../types';
import { PREDEFINED_DOMAINS, DOMAIN_DESCRIPTIONS } from '../constants/domains';
import { devLog } from '../utils';
import openai from '../openai';

export class SmartDomainDetector {

    async detectDomain(message: string, userId: string, recentHistory: MessageHistory[]): Promise<string> {
        const prompt = `
        Определи наиболее подходящий домен для сообщения: "${message}"
        
        Доступные домены:
        ${Object.entries(DOMAIN_DESCRIPTIONS).map(([key, desc]) => 
            `- ${key}: ${desc.name} (${desc.keywords.join(', ')})`
        ).join('\n')}
        
        Верни только название домена на английском языке.
        Если не подходит ни один домен, верни "general".
        `;

        try {
            devLog('Domain detection prompt:', prompt);
            const resp = await openai.chat.completions.create({
                model: 'gpt-5-nano',
                messages: [
                    { role: 'system', content: 'Ты определяешь домен для сообщения по ключевым словам' },
                    { role: 'user', content: prompt }
                ],
                temperature: 0.1,
            });

            const detectedDomain = resp.choices[0]?.message?.content?.trim().toLowerCase() || PREDEFINED_DOMAINS.GENERAL;
            devLog('Domain detection response:', detectedDomain);
            
            if (Object.values(PREDEFINED_DOMAINS).includes(detectedDomain as any)) {
                return detectedDomain;
            }
            
            return PREDEFINED_DOMAINS.GENERAL;
        } catch (e) {
            console.error('Domain detection error', e);
            return PREDEFINED_DOMAINS.GENERAL;
        }
    }
}
