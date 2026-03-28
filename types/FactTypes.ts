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
}
