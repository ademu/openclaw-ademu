// Plugin-owned runtime state (design entry §2 R9): one SQLite database under the OpenClaw state dir,
// via Node's built-in `node:sqlite` (zero dependencies; unflagged on both supported Node floors).
//   watermarks — per account: the device id the account is bound to and the last ADOPTED seq (the
//                commit that makes a cumulative ack truthful; §2 R2b).
// The plugin owns no daemon state (AdemuMLS #712: it attaches to an installed adc and never runs one);
// databases written by an earlier build keep their dead `daemon_ownership`/`daemon_holders` tables,
// which nothing reads. Transactions are synchronous commit sections (`BEGIN IMMEDIATE … COMMIT`);
// WAL + synchronous=FULL + busy_timeout for the gateway/CLI sharing the file. Losing this DB is safe:
// the daemon replays at most the un-acked tail.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

export const SCHEMA_VERSION = 1;
export const BUSY_TIMEOUT_MS = 2000;

export type Watermark = { deviceId: string; adoptedSeq: number };

export class AdemuStore {
  readonly path: string;
  readonly #db: DatabaseSync;
  readonly #now: () => number;

  private constructor(path: string, db: DatabaseSync, now: () => number) {
    this.path = path;
    this.#db = db;
    this.#now = now;
  }

  /** Opens (creating) `<stateDir>/ademu/ademu.sqlite`. Pass `":memory:"` as `path` for tests. */
  static open(params: { stateDir?: string; path?: string; now?: () => number }): AdemuStore {
    const path = params.path ?? join(params.stateDir ?? "", "ademu", "ademu.sqlite");
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const db = new DatabaseSync(path);
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};`);
    if (path !== ":memory:") db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA synchronous = FULL;");
    db.exec("PRAGMA foreign_keys = ON;");
    const store = new AdemuStore(path, db, params.now ?? (() => Date.now()));
    store.#ensureSchema();
    return store;
  }

  close(): void {
    this.#db.close();
  }

  #ensureSchema(): void {
    const db = this.#db;
    db.exec("BEGIN IMMEDIATE;");
    try {
      db.exec(`CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL) STRICT;`);
      const row = db.prepare("SELECT version FROM schema_version LIMIT 1").get() as { version: number } | undefined;
      if (!row) db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(SCHEMA_VERSION);
      else if (row.version > SCHEMA_VERSION) {
        throw new Error(`ademu.sqlite schema version ${row.version} is newer than this plugin supports (${SCHEMA_VERSION})`);
      }
      db.exec(`CREATE TABLE IF NOT EXISTS watermarks (
        account_id TEXT PRIMARY KEY,
        device_id TEXT NOT NULL,
        adopted_seq INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL
      ) STRICT;`);
      db.exec("COMMIT;");
    } catch (err) {
      db.exec("ROLLBACK;");
      throw err;
    }
  }

  // ------------------------------------------------------------------ watermarks (§2 R2b)

  getWatermark(accountId: string): Watermark | undefined {
    const r = this.#db.prepare("SELECT device_id, adopted_seq FROM watermarks WHERE account_id = ?").get(accountId) as
      | { device_id: string; adopted_seq: number }
      | undefined;
    return r ? { deviceId: r.device_id, adoptedSeq: Number(r.adopted_seq) } : undefined;
  }

  /** The durable adoption commit. Monotonic per device: a lower seq never overwrites a higher one. */
  setWatermark(accountId: string, deviceId: string, adoptedSeq: number): void {
    if (!Number.isSafeInteger(adoptedSeq) || adoptedSeq < 0) throw new RangeError(`adoptedSeq must be a non-negative safe integer`);
    this.#db
      .prepare(
        `INSERT INTO watermarks (account_id, device_id, adopted_seq, updated_at_ms) VALUES (?, ?, ?, ?)
         ON CONFLICT(account_id) DO UPDATE SET
           adopted_seq = CASE WHEN excluded.device_id = watermarks.device_id THEN MAX(watermarks.adopted_seq, excluded.adopted_seq) ELSE excluded.adopted_seq END,
           device_id = excluded.device_id,
           updated_at_ms = excluded.updated_at_ms`,
      )
      .run(accountId, deviceId, adoptedSeq, this.#now());
  }

  /** Device reset: the account is now bound to another device; the old cursor is meaningless. */
  resetWatermark(accountId: string, deviceId: string): void {
    this.#db
      .prepare(
        `INSERT INTO watermarks (account_id, device_id, adopted_seq, updated_at_ms) VALUES (?, ?, -1, ?)
         ON CONFLICT(account_id) DO UPDATE SET device_id = excluded.device_id, adopted_seq = -1, updated_at_ms = excluded.updated_at_ms`,
      )
      .run(accountId, deviceId, this.#now());
  }

  deleteWatermark(accountId: string): void {
    this.#db.prepare("DELETE FROM watermarks WHERE account_id = ?").run(accountId);
  }
}
