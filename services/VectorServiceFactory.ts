import { IDomainVectorService } from './interfaces/IDomainVectorService';
import { QdrantVectorService } from './QdrantVectorService';
import { PineconeVectorService } from './PineconeVectorService';
import { config } from '../config';

let vectorServiceInstance: IDomainVectorService | null = null;

export function createVectorService(): IDomainVectorService | null {
    if (vectorServiceInstance !== null) {
        return vectorServiceInstance;
    }
    console.log(`🏭 Создание векторного сервиса для бота ${config.characterName}...`);

    const provider = (process.env.VECTOR_PROVIDER || 'qdrant').toLowerCase();
    console.log(`📋 Выбранный провайдер: ${provider}`);

    if (provider === 'qdrant') {
        console.log(`✅ Создание QdrantVectorService для ${config.characterName}`);
        vectorServiceInstance = new QdrantVectorService();
        return vectorServiceInstance;
    }
    if (provider === 'pinecone') {
        console.log(`✅ Создание PineconeVectorService для ${config.characterName}`);
        vectorServiceInstance = new PineconeVectorService();
        return vectorServiceInstance;
    }

    console.warn(`⚠️ Неизвестный провайдер векторного сервиса: "${provider}", используем qdrant по умолчанию`);
    vectorServiceInstance = new QdrantVectorService();
    return vectorServiceInstance;
}

/** Единый экземпляр векторного сервиса для всего приложения */
export function getVectorService(): IDomainVectorService | null {
    return vectorServiceInstance ?? createVectorService();
}
