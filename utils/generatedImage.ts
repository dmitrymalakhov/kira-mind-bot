import { InputFile } from 'grammy';
import type { ProcessingResult } from '../orchestrator';

export function generatedImageInput(result: Pick<ProcessingResult, 'generatedImagePath' | 'generatedImageUrl'>): InputFile | string | undefined {
    return result.generatedImagePath ? new InputFile(result.generatedImagePath) : result.generatedImageUrl;
}
