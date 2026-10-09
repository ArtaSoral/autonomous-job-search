import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { sql as drizzleSql } from "drizzle-orm";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import "dotenv/config";
import { normalize } from "./text";
let connection: Database.Database | undefined;
export function sqlite() {
  if (!connection) {
    const path = process.env.DATABASE_PATH || "data/job-finder.sqlite";
    mkdirSync(dirname(path), { recursive: true });
    connection = new Database(path);
    connection.exec(
      "PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;",
    );
    connection.exec(
      "CREATE TABLE IF NOT EXISTS schema_migrations(name TEXT PRIMARY KEY,applied_at TEXT NOT NULL)",
    );
    connection
      .transaction(() => {
        for (const name of [
          "0001_initial.sql",
          "0002_listing_verification.sql",
          "0003_openai_auth.sql",
        ]) {
          if (
            connection!
              .prepare("SELECT name FROM schema_migrations WHERE name=?")
              .get(name)
          )
            continue;
          connection!.exec(readFileSync(`migrations/${name}`, "utf8"));
          if (name === "0002_listing_verification.sql") {
            for (const job of connection!
              .prepare(
                "SELECT id,employer,official_verified,last_seen FROM jobs",
              )
              .all() as {
              id: string;
              employer: string;
              official_verified: number;
              last_seen: string;
            }[])
              connection!
                .prepare(
                  "UPDATE jobs SET normalized_employer=?,last_verified_at=? WHERE id=?",
                )
                .run(
                  normalize(job.employer),
                  job.official_verified ? job.last_seen : null,
                  job.id,
                );
          }
          connection!
            .prepare(
              "INSERT INTO schema_migrations(name,applied_at) VALUES(?,?)",
            )
            .run(name, new Date().toISOString());
        }
      })
      .immediate();
  }
  return connection;
}
export const orm = () => drizzle(sqlite());
export const uid = () => randomUUID();
export const now = () => new Date().toISOString();
export function rows<T>(
  sql: string,
  ...params: (string | number | null)[]
): T[] {
  return orm().all(boundQuery(sql, params)) as T[];
}
export function row<T>(
  sql: string,
  ...params: (string | number | null)[]
): T | undefined {
  return rows<T>(sql, ...params)[0];
}
export function exec(sql: string, ...params: (string | number | null)[]) {
  return orm().run(boundQuery(sql, params));
}
function boundQuery(query: string, params: (string | number | null)[]) {
  const chunks = query.split("?");
  if (chunks.length !== params.length + 1)
    throw Error("SQL parameter count mismatch");
  return drizzleSql.join(
    chunks.flatMap((chunk, index) =>
      index
        ? [drizzleSql`${params[index - 1]}`, drizzleSql.raw(chunk)]
        : [drizzleSql.raw(chunk)],
    ),
    drizzleSql.raw(""),
  );
}
export function transaction<T>(fn: () => T): T {
  return sqlite().transaction(fn).immediate();
}
