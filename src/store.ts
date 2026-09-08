// Plugin-owned runtime state (design entry §2 R9): one SQLite database under the OpenClaw state dir,
// via Node's built-in `node:sqlite` (zero dependencies; unflagged on both supported Node floors).
//   watermarks       — per account: the device id the account is bound to and the last ADOPTED seq
//                      (the commit that makes a cumulative ack truthful; §2 R2b).
//   daemon_ownership — per canonical data dir: who owns the daemon there and in which lifecycle state
//                      (`claimed | starting | pending-publication | bound | stopping | stopped | stale`),
//                      with the instance facts that authorize a stop, and a generation that fences
//                      every transition (§2 R2, T5).
//   daemon_holders   — cross-process leases (gateway runtime, CLI wizard, chat tool) with heartbeats;
//                      a daemon may be stopped only when no other live holder remains (T5 fence).
// Transactions are synchronous commit sections (`BEGIN IMMEDIATE … COMMIT`); WAL + synchronous=FULL
// + busy_timeout for the gateway/CLI sharing the file. Losing this DB is safe in both directions:
// watermarks → the daemon replays at most the un-acked tail; ownership → our daemon degrades to
// foreign (attach-only, never killed).
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

export const SCHEMA_VERSION = 1;
export const BUSY_TIMEOUT_MS = 2000;

export type OwnershipState = "claimed" | "starting" | "pending-publication" | "bound" | "stopping" | "stopped" | "stale";
export const OWNERSHIP_STATES: readonly OwnershipState[] = [
  "claimed",
  "starting",
  "pending-publication",
  "bound",
  "stopping",
  "stopped",
  "stale",
];

export type OwnershipRow = {
  dataDir: string;
  state: OwnershipState;
  generation: number;
  controlSocket: string;
  sessionSocket: string;
  /** Who holds the current transition (claimed/starting/stopping): pid + its start time. */
  ownerPid: number | null;
  ownerPidStartedAt: string | null;
  deadlineMs: number | null;
  /** Bound instance facts (authorize stop/upgrade). */
  daemonPid: number | null;
  daemonPidStartedAt: string | null;
  daemonStartedAtMs: number | null;
  daemonDataDir: string | null;
  daemonSocketPath: string | null;
  daemonSessionSocketPath: string | null;
  adcVersion: string | null;
  bundledVersion: string | null;
  reason: string | null;
  claimedAtMs: number;
  updatedAtMs: number;
};

export type HolderRow = {
  holderId: string;
  dataDir: string;
  role: "runtime" | "setup";
  pid: number;
  pidStartedAt: string;
  heartbeatMs: number;
};

export type Watermark = { deviceId: string; adoptedSeq: number };

export const HOLDER_STALE_MS = 90_000;

function rowToOwnership(r: Record<string, unknown>): OwnershipRow {
  return {
    dataDir: r.data_dir as string,
    state: r.state as OwnershipState,
    generation: Number(r.generation),
    controlSocket: r.control_socket as string,
    sessionSocket: r.session_socket as string,
    ownerPid: (r.owner_pid as number | null) ?? null,
    ownerPidStartedAt: (r.owner_pid_started_at as string | null) ?? null,
    deadlineMs: (r.deadline_ms as number | null) ?? null,
    daemonPid: (r.daemon_pid as number | null) ?? null,
    daemonPidStartedAt: (r.daemon_pid_started_at as string | null) ?? null,
    daemonStartedAtMs: (r.daemon_started_at_ms as number | null) ?? null,
    daemonDataDir: (r.daemon_data_dir as string | null) ?? null,
    daemonSocketPath: (r.daemon_socket_path as string | null) ?? null,
    daemonSessionSocketPath: (r.daemon_session_socket_path as string | null) ?? null,
    adcVersion: (r.adc_version as string | null) ?? null,
    bundledVersion: (r.bundled_version as string | null) ?? null,
    reason: (r.reason as string | null) ?? null,
    claimedAtMs: Number(r.claimed_at_ms),
    updatedAtMs: Number(r.updated_at_ms),
  };
}

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
      db.exec(`CREATE TABLE IF NOT EXISTS daemon_ownership (
        data_dir TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        generation INTEGER NOT NULL DEFAULT 0,
        control_socket TEXT NOT NULL,
        session_socket TEXT NOT NULL,
        owner_pid INTEGER,
        owner_pid_started_at TEXT,
        deadline_ms INTEGER,
        daemon_pid INTEGER,
        daemon_pid_started_at TEXT,
        daemon_started_at_ms INTEGER,
        daemon_data_dir TEXT,
        daemon_socket_path TEXT,
        daemon_session_socket_path TEXT,
        adc_version TEXT,
        bundled_version TEXT,
        reason TEXT,
        claimed_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL
      ) STRICT;`);
      db.exec(`CREATE TABLE IF NOT EXISTS daemon_holders (
        holder_id TEXT PRIMARY KEY,
        data_dir TEXT NOT NULL,
        role TEXT NOT NULL,
        pid INTEGER NOT NULL,
        pid_started_at TEXT NOT NULL,
        heartbeat_ms INTEGER NOT NULL
      ) STRICT;`);
      db.exec(`CREATE INDEX IF NOT EXISTS daemon_holders_data_dir ON daemon_holders (data_dir);`);
      db.exec("COMMIT;");
    } catch (err) {
      db.exec("ROLLBACK;");
      throw err;
    }
  }

  /** Runs `fn` inside one BEGIN IMMEDIATE … COMMIT section (synchronous — no awaits inside). */
  transaction<T>(fn: () => T): T {
    this.#db.exec("BEGIN IMMEDIATE;");
    try {
      const out = fn();
      this.#db.exec("COMMIT;");
      return out;
    } catch (err) {
      this.#db.exec("ROLLBACK;");
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

  // ------------------------------------------------------------------ ownership rows (§2 R2)

  getOwnership(dataDir: string): OwnershipRow | undefined {
    const r = this.#db.prepare("SELECT * FROM daemon_ownership WHERE data_dir = ?").get(dataDir) as Record<string, unknown> | undefined;
    return r ? rowToOwnership(r) : undefined;
  }

  listOwnership(): OwnershipRow[] {
    return (this.#db.prepare("SELECT * FROM daemon_ownership").all() as Record<string, unknown>[]).map(rowToOwnership);
  }

  /** Claim-before-spawn (fresh dir). Returns false when a row already exists (someone else claimed). */
  claim(params: { dataDir: string; controlSocket: string; sessionSocket: string; ownerPid: number; ownerPidStartedAt: string }): boolean {
    const now = this.#now();
    const res = this.#db
      .prepare(
        `INSERT OR IGNORE INTO daemon_ownership
           (data_dir, state, generation, control_socket, session_socket, owner_pid, owner_pid_started_at, claimed_at_ms, updated_at_ms)
         VALUES (?, 'claimed', 0, ?, ?, ?, ?, ?, ?)`,
      )
      .run(params.dataDir, params.controlSocket, params.sessionSocket, params.ownerPid, params.ownerPidStartedAt, now, now);
    return res.changes === 1;
  }

  /**
   * Generation-fenced state transition. Succeeds only when the row is in one of `from` AND (when
   * given) at `expectedGeneration`; the generation is bumped when `bumpGeneration` is set. Returns
   * the new row or undefined when the CAS lost.
   */
  cas(params: {
    dataDir: string;
    from: readonly OwnershipState[];
    to: OwnershipState;
    expectedGeneration?: number;
    bumpGeneration?: boolean;
    set?: Partial<
      Pick<
        OwnershipRow,
        | "ownerPid"
        | "ownerPidStartedAt"
        | "deadlineMs"
        | "daemonPid"
        | "daemonPidStartedAt"
        | "daemonStartedAtMs"
        | "daemonDataDir"
        | "daemonSocketPath"
        | "daemonSessionSocketPath"
        | "adcVersion"
        | "bundledVersion"
        | "reason"
      >
    >;
  }): OwnershipRow | undefined {
    const set = params.set ?? {};
    const cols: string[] = ["state = ?", "updated_at_ms = ?"];
    const vals: unknown[] = [params.to, this.#now()];
    if (params.bumpGeneration) cols.push("generation = generation + 1");
    const map: Record<string, string> = {
      ownerPid: "owner_pid",
      ownerPidStartedAt: "owner_pid_started_at",
      deadlineMs: "deadline_ms",
      daemonPid: "daemon_pid",
      daemonPidStartedAt: "daemon_pid_started_at",
      daemonStartedAtMs: "daemon_started_at_ms",
      daemonDataDir: "daemon_data_dir",
      daemonSocketPath: "daemon_socket_path",
      daemonSessionSocketPath: "daemon_session_socket_path",
      adcVersion: "adc_version",
      bundledVersion: "bundled_version",
      reason: "reason",
    };
    for (const [k, col] of Object.entries(map)) {
      if (k in set) {
        cols.push(`${col} = ?`);
        vals.push((set as Record<string, unknown>)[k] ?? null);
      }
    }
    const placeholders = params.from.map(() => "?").join(", ");
    vals.push(params.dataDir, ...params.from);
    let where = `data_dir = ? AND state IN (${placeholders})`;
    if (params.expectedGeneration !== undefined) {
      where += " AND generation = ?";
      vals.push(params.expectedGeneration);
    }
    const res = this.#db.prepare(`UPDATE daemon_ownership SET ${cols.join(", ")} WHERE ${where}`).run(...(vals as never[]));
    return res.changes === 1 ? this.getOwnership(params.dataDir) : undefined;
  }

  /** Exact-state, exact-generation delete (the probe-race loser removes its own row). */
  deleteOwnership(params: { dataDir: string; state: OwnershipState; generation: number }): boolean {
    const res = this.#db
      .prepare("DELETE FROM daemon_ownership WHERE data_dir = ? AND state = ? AND generation = ?")
      .run(params.dataDir, params.state, params.generation);
    return res.changes === 1;
  }

  // ------------------------------------------------------------------ holders (cross-process fence)

  /**
   * Registers a lease. FAILS (returns false) while the daemon's ownership row is `stopping`, so no
   * acquisition can slip between the zero-holder check and the shutdown (T5 fence). The insert and
   * the state read are one transaction.
   */
  addHolder(row: HolderRow): boolean {
    return this.transaction(() => {
      const own = this.getOwnership(row.dataDir);
      if (own?.state === "stopping") return false;
      this.#db
        .prepare(
          `INSERT INTO daemon_holders (holder_id, data_dir, role, pid, pid_started_at, heartbeat_ms) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(holder_id) DO UPDATE SET heartbeat_ms = excluded.heartbeat_ms`,
        )
        .run(row.holderId, row.dataDir, row.role, row.pid, row.pidStartedAt, row.heartbeatMs);
      return true;
    });
  }

  /** Refreshes the heartbeat; returns false when the row is gone (swept) — the lease must fail closed. */
  heartbeat(holderId: string): boolean {
    const res = this.#db.prepare("UPDATE daemon_holders SET heartbeat_ms = ? WHERE holder_id = ?").run(this.#now(), holderId);
    return res.changes === 1;
  }

  removeHolder(holderId: string): void {
    this.#db.prepare("DELETE FROM daemon_holders WHERE holder_id = ?").run(holderId);
  }

  listHolders(dataDir: string): HolderRow[] {
    return (this.#db.prepare("SELECT * FROM daemon_holders WHERE data_dir = ?").all(dataDir) as Record<string, unknown>[]).map((r) => ({
      holderId: r.holder_id as string,
      dataDir: r.data_dir as string,
      role: r.role as HolderRow["role"],
      pid: Number(r.pid),
      pidStartedAt: r.pid_started_at as string,
      heartbeatMs: Number(r.heartbeat_ms),
    }));
  }

  /** Deletes holders whose heartbeat is stale or whose process is dead. Returns the removed ids. */
  sweepStaleHolders(dataDir: string, isProcessAlive: (pid: number, pidStartedAt: string) => boolean): string[] {
    const now = this.#now();
    const removed: string[] = [];
    for (const h of this.listHolders(dataDir)) {
      if (now - h.heartbeatMs > HOLDER_STALE_MS || !isProcessAlive(h.pid, h.pidStartedAt)) {
        this.removeHolder(h.holderId);
        removed.push(h.holderId);
      }
    }
    return removed;
  }

  /**
   * THE atomic shutdown fence (T5): in one transaction, sweep stale holders, and if no OTHER live
   * holder remains, CAS the ownership row `bound → stopping` (new generation, stopper facts).
   * Returns the new row, or undefined when another live holder exists or the CAS lost.
   */
  tryClaimShutdown(params: {
    dataDir: string;
    holderId: string;
    expectedGeneration: number;
    stopperPid: number;
    stopperPidStartedAt: string;
    deadlineMs: number;
    reason: string;
    isProcessAlive: (pid: number, pidStartedAt: string) => boolean;
  }): OwnershipRow | undefined {
    return this.transaction(() => {
      this.sweepStaleHolders(params.dataDir, params.isProcessAlive);
      const others = this.listHolders(params.dataDir).filter((h) => h.holderId !== params.holderId);
      if (others.length > 0) return undefined;
      return this.cas({
        dataDir: params.dataDir,
        from: ["bound", "pending-publication"],
        to: "stopping",
        expectedGeneration: params.expectedGeneration,
        bumpGeneration: true,
        set: {
          ownerPid: params.stopperPid,
          ownerPidStartedAt: params.stopperPidStartedAt,
          deadlineMs: params.deadlineMs,
          reason: params.reason,
        },
      });
    });
  }
}
