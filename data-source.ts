import 'reflect-metadata';
import { DataSource } from 'typeorm';
import * as path from 'path';

export const AppDataSource = new DataSource({
  type: 'postgres',
  host: 'postgres',
  port: 5432,
  username: 'postgres',
  password: 'F9u!vX2rT2a4er',
  database: 'KiraMind',
  synchronize: false,
  logging: process.env.NODE_ENV === 'development',
  entities: [path.join(__dirname, './entity/**/*.ts')],
  migrations: [path.join(__dirname, './migration/**/*.ts')],
  subscribers: [path.join(__dirname, './subscriber/**/*.ts')],
});
