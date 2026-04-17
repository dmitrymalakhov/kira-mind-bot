export interface ExtractedFact {
  id: string;
  content: string;
  domain: string;
  factType: string;
  confidence: number;
  sourceContext: string;
  extractedAt: Date;
  importance: number;
  tags: string[];
  /** 'user' — факт о владельце бота, 'contact' — факт о стороннем человеке */
  subject?: 'user' | 'contact';
  /** Имя контакта (только при subject === 'contact') */
  contactName?: string;
}
