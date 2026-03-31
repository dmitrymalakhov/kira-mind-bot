import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { ReminderEntity } from './entity/ReminderEntity';
import { ChatEntity } from './entity/ChatEntity';

export const AppDataSource = new DataSource({
  type: 'postgres',
  host: process.env.DB_HOST ?? 'postgres',
  port: Number(process.env.DB_PORT ?? 5432),
  username: process.env.DB_USER ?? 'postgres',
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME ?? 'KiraMind',
  synchronize: true,
  logging: process.env.NODE_ENV === 'development',
  entities: [ReminderEntity, ChatEntity],
  migrations: [],
});
