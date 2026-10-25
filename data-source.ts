import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { ReminderEntity } from './entity/ReminderEntity';
import { ChatEntity } from './entity/ChatEntity';
import { BotSettingEntity } from './entity/BotSettingEntity';
import { ChatGroupEntity } from './entity/ChatGroupEntity';
import { SessionEntity } from './entity/SessionEntity';
import { HealthLogEntity } from './entity/HealthLogEntity';
import { GroupChatMessageEntity } from './entity/GroupChatMessageEntity';
import { AiUsageLogEntity } from './entity/AiUsageLogEntity';
import { PersonIdentityEntity } from './entity/PersonIdentityEntity';
import { RecurringTaskEntity } from './entity/RecurringTaskEntity';
import { ApiOperationEntity } from './entity/ApiOperationEntity';

export const AppDataSource = new DataSource({
  type: 'postgres',
  host: process.env.DB_HOST ?? 'postgres',
  port: Number(process.env.DB_PORT ?? 5432),
  username: process.env.DB_USER ?? 'postgres',
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME ?? 'KiraMind',
  synchronize: process.env.KIRA_DATABASE_SYNC !== 'false',
  ...(process.env.KIRA_TENANT_ID ? { extra: { max: 3 } } : {}),
  logging: process.env.NODE_ENV === 'development',
  entities: [ReminderEntity, ChatEntity, BotSettingEntity, ChatGroupEntity, SessionEntity, HealthLogEntity, GroupChatMessageEntity, AiUsageLogEntity, PersonIdentityEntity, RecurringTaskEntity, ApiOperationEntity],
  migrations: [],
});
