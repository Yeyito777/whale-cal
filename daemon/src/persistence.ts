import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { CalendarDatabase } from "@whale-cal/shared/types";
import { validateDatabase } from "./validation";

export function initialTimeZone(): string {
  const zone = process.env.CAL_TIME_ZONE ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  new Intl.DateTimeFormat("en", { timeZone: zone }); // reject invalid configuration
  return zone;
}

/** One daemon owns this database. Never open it directly from a client. */
export class CalendarPersistence {
  readonly sql: Database;
  readonly path: string;

  constructor(path: string) {
    // Accept an old JSON path as migration input, never overwrite that file.
    this.path = path.endsWith(".json") ? path.slice(0, -5) + ".sqlite" : path;
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    // Preflight before running any DDL, changing journal mode or adding users.
    if (existsSync(this.path)) {
      const existing = new Database(this.path, { readonly: true });
      try {
        const tables = existing.query("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
        if (tables.some(table => table.name === "metadata")) {
          const version = existing.query("SELECT value FROM metadata WHERE key='schema'").get() as { value: string } | null;
          if (version && version.value !== "1") throw new Error("Unsupported SQLite schema; refusing to modify calendar data.");
          if (version) {
            const expected: Record<string, string[]> = {
              metadata: ["key", "value"], users: ["id", "name", "admin"],
              calendar_groups: ["id", "owner_id", "payload"], calendars: ["id", "owner_id", "group_id", "payload"],
              events: ["id", "calendar_id", "payload"], tokens: ["hash", "user_id", "label", "created_at"],
              requests: ["user_id", "req_id", "command", "response"],
            };
            for (const [table, columns] of Object.entries(expected)) {
              const actual = (existing.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(column => column.name);
              if (JSON.stringify(actual) !== JSON.stringify(columns)) throw new Error(`Incompatible SQLite table ${table}; refusing to modify calendar data.`);
            }
          } else {
            // Retrying an interrupted first import is safe only if no calendar
            // data has ever committed. Never initialize over an unversioned DB.
            for (const table of ["calendars", "calendar_groups", "events"]) {
              if (tables.some(item => item.name === table) && existing.query(`SELECT 1 FROM ${table} LIMIT 1`).get()) {
                throw new Error("Unversioned SQLite calendar data; refusing to initialize over it.");
              }
            }
          }
        } else if (tables.length) throw new Error("Not a Whale Cal database; refusing to modify it.");
      } finally { existing.close(); }
    }
    this.sql = new Database(this.path, { create: true, strict: true });
    chmodSync(this.path, 0o600);
    this.sql.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    this.sql.transaction(() => this.sql.exec(`
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, admin INTEGER NOT NULL DEFAULT 0);
      INSERT OR IGNORE INTO users VALUES ('local', 'Local owner', 1);
      CREATE TABLE IF NOT EXISTS calendar_groups (
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), payload TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS calendars (
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id),
        group_id TEXT REFERENCES calendar_groups(id), payload TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY, calendar_id TEXT NOT NULL REFERENCES calendars(id), payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_calendar ON events(calendar_id);
      CREATE INDEX IF NOT EXISTS calendars_owner ON calendars(owner_id);
      CREATE TABLE IF NOT EXISTS tokens (
        hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
        label TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS requests (
        user_id TEXT NOT NULL REFERENCES users(id), req_id TEXT NOT NULL,
        command TEXT NOT NULL, response TEXT NOT NULL, PRIMARY KEY(user_id, req_id)
      );
    `))();
    for (const suffix of ["-wal", "-shm"]) {
      if (existsSync(this.path + suffix)) chmodSync(this.path + suffix, 0o600);
    }
  }

  load(initial: () => CalendarDatabase, legacyPath: string): CalendarDatabase {
    const row = this.sql.query("SELECT value FROM metadata WHERE key='revision'").get() as { value: string } | null;
    if (row) {
      const rows = <T>(table: string): T[] => (this.sql.query(`SELECT payload FROM ${table} ORDER BY rowid`).all() as { payload: string }[])
        .map(item => JSON.parse(item.payload) as T);
      const db: CalendarDatabase = {
        version: 1, revision: Number(row.value),
        timeZone: (this.sql.query("SELECT value FROM metadata WHERE key='timezone'").get() as { value: string } | null)?.value ?? initialTimeZone(),
        calendars: rows("calendars"), events: rows("events"),
        ...(this.sql.query("SELECT 1 FROM calendar_groups LIMIT 1").get() ? { groups: rows("calendar_groups") } : {}),
      };
      validateDatabase(db);
      new Intl.DateTimeFormat("en", { timeZone: db.timeZone });
      return db;
    }
    let db = initial();
    if (existsSync(legacyPath)) {
      // Fail closed: never silently replace a corrupt calendar with an empty one.
      const source: unknown = JSON.parse(readFileSync(legacyPath, "utf8"));
      validateDatabase(source);
      db = source;
    }
    db.timeZone ??= initialTimeZone();
    new Intl.DateTimeFormat("en", { timeZone: db.timeZone });
    for (const calendar of db.calendars) calendar.ownerUserId = "local";
    for (const group of db.groups ?? []) group.ownerUserId = "local";
    this.write(db);
    return db;
  }

  write(db: CalendarDatabase): void {
    this.sql.transaction(() => {
      // Preserve array ordering and all legacy recurrence/completion fields.
      this.sql.exec("DELETE FROM events; DELETE FROM calendars; DELETE FROM calendar_groups;");
      const group = this.sql.query("INSERT INTO calendar_groups VALUES (?, ?, ?)");
      for (const value of db.groups ?? []) group.run(value.id, value.ownerUserId ?? "local", JSON.stringify(value));
      const calendar = this.sql.query("INSERT INTO calendars VALUES (?, ?, ?, ?)");
      for (const value of db.calendars) calendar.run(value.id, value.ownerUserId ?? "local", value.groupId ?? null, JSON.stringify(value));
      const event = this.sql.query("INSERT INTO events VALUES (?, ?, ?)");
      for (const value of db.events) event.run(value.id, value.calendarId, JSON.stringify(value));
      this.sql.query("INSERT OR REPLACE INTO metadata VALUES ('schema', '1')").run();
      this.sql.query("INSERT OR REPLACE INTO metadata VALUES ('revision', ?)").run(String(db.revision));
      this.sql.query("INSERT OR REPLACE INTO metadata VALUES ('timezone', ?)").run(db.timeZone ?? initialTimeZone());
    })();
  }

  close(): void { this.sql.close(); }
}
