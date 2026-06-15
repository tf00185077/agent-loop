import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

export interface DatabaseOptions {
  path?: string;
}

export type AppDatabase = Database.Database;

export const defaultDatabasePath = resolve("data", "auto-agent.sqlite");

export function resolveDatabasePath(options: DatabaseOptions = {}): string {
  return options.path ?? process.env.AUTO_AGENT_DB_PATH ?? defaultDatabasePath;
}

export function openDatabase(options: DatabaseOptions = {}): AppDatabase {
  const path = resolveDatabasePath(options);
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("foreign_keys = ON");
  return db;
}
