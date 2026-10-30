import { drizzle, type DrizzleD1Database } from 'drizzle-orm/d1';

/**
 * No schema is passed on purpose: it would enable the relational query API, which is banned until Drizzle 1.0. The raw
 * binding is there for the few transactions drizzle's own `batch` cannot express (raw INSERT … SELECT statements).
 */
export type Database = DrizzleD1Database & { readonly $client: D1Database };

export function createDatabase(d1: D1Database): Database {
    return drizzle(d1);
}
