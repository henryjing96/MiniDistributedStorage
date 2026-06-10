// SQLite-backed metadata store. Mirrors go/internal/metastore.

import { DatabaseSync } from "node:sqlite";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS files (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL UNIQUE,
    size        INTEGER NOT NULL,
    sha256      TEXT NOT NULL,
    block_size  INTEGER NOT NULL,
    state       TEXT NOT NULL DEFAULT 'pending',
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS blocks (
    file_id       INTEGER NOT NULL,
    idx           INTEGER NOT NULL,
    sha256        TEXT NOT NULL,
    size          INTEGER NOT NULL,
    uploaded      INTEGER NOT NULL DEFAULT 0,
    storage_nodes TEXT NOT NULL,
    PRIMARY KEY (file_id, idx),
    FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_blocks_sha256 ON blocks(sha256);
`;

export class ConflictError extends Error {
  constructor() {
    super("conflict: file exists with different content");
    this.name = "ConflictError";
  }
}

export class NotFoundError extends Error {
  constructor(msg = "not found") {
    super(msg);
    this.name = "NotFoundError";
  }
}

export interface FileRow {
  id: number;
  name: string;
  size: number;
  sha256: string;
  block_size: number;
  state: string;
  created_at: number;
  updated_at: number;
}

export interface BlockRow {
  file_id: number;
  idx: number;
  sha256: string;
  size: number;
  uploaded: boolean;
  storage_nodes: string[];
}

interface BlockInput {
  idx: number;
  sha256: string;
  size: number;
  storage_nodes: string[];
}

function now(): number {
  return Math.floor(Date.now() / 1000);
}

export class MetaStore {
  private db: DatabaseSync;

  constructor(dsn: string) {
    this.db = new DatabaseSync(dsn);
    // WAL + busy_timeout for the same robustness reasons as the Go version.
    // node:sqlite runs synchronously on the single Node event loop, so there
    // is no concurrent-writer race, but these are still good hygiene.
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = NORMAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  getFile(name: string): FileRow | null {
    const row = this.db
      .prepare(
        `SELECT id, name, size, sha256, block_size, state, created_at, updated_at
         FROM files WHERE name = ?`,
      )
      .get(name) as Record<string, unknown> | undefined;
    return row ? this.toFileRow(row) : null;
  }

  /**
   * Register an upload. If a file with the same name already exists:
   *   - same (size, sha256) -> resume (return existing row, blocks untouched)
   *   - different content    -> ConflictError
   * Otherwise create the file row + all block rows in one transaction.
   */
  createOrResume(
    name: string,
    size: number,
    sha: string,
    blockSize: number,
    blocks: BlockInput[],
  ): FileRow {
    const existing = this.getFile(name);
    if (existing) {
      if (existing.sha256 !== sha || existing.size !== size) {
        throw new ConflictError();
      }
      this.db
        .prepare(`UPDATE files SET updated_at = ? WHERE id = ?`)
        .run(now(), existing.id);
      return this.getFile(name)!;
    }

    const ts = now();
    this.db.exec("BEGIN");
    try {
      const res = this.db
        .prepare(
          `INSERT INTO files(name, size, sha256, block_size, state, created_at, updated_at)
           VALUES(?,?,?,?,?,?,?)`,
        )
        .run(name, size, sha, blockSize, "pending", ts, ts);
      const fileId = Number(res.lastInsertRowid);

      const stmt = this.db.prepare(
        `INSERT INTO blocks(file_id, idx, sha256, size, uploaded, storage_nodes)
         VALUES(?, ?, ?, ?, 0, ?)`,
      );
      for (const b of blocks) {
        stmt.run(fileId, b.idx, b.sha256, b.size, JSON.stringify(b.storage_nodes));
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    return this.getFile(name)!;
  }

  missingBlocks(fileId: number): number[] {
    const rows = this.db
      .prepare(`SELECT idx FROM blocks WHERE file_id = ? AND uploaded = 0 ORDER BY idx`)
      .all(fileId) as Array<{ idx: number }>;
    return rows.map((r) => r.idx);
  }

  getBlock(fileId: number, idx: number): BlockRow | null {
    const row = this.db
      .prepare(
        `SELECT file_id, idx, sha256, size, uploaded, storage_nodes
         FROM blocks WHERE file_id = ? AND idx = ?`,
      )
      .get(fileId, idx) as Record<string, unknown> | undefined;
    return row ? this.toBlockRow(row) : null;
  }

  listBlocks(fileId: number): BlockRow[] {
    const rows = this.db
      .prepare(
        `SELECT file_id, idx, sha256, size, uploaded, storage_nodes
         FROM blocks WHERE file_id = ? ORDER BY idx`,
      )
      .all(fileId) as Array<Record<string, unknown>>;
    return rows.map((r) => this.toBlockRow(r));
  }

  markUploaded(fileId: number, idx: number): void {
    const res = this.db
      .prepare(`UPDATE blocks SET uploaded = 1 WHERE file_id = ? AND idx = ?`)
      .run(fileId, idx);
    if (res.changes === 0) throw new NotFoundError();
    this.db.prepare(`UPDATE files SET updated_at = ? WHERE id = ?`).run(now(), fileId);
  }

  /** Mark the file complete; throws if any block is still pending. */
  markComplete(fileId: number): void {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS c FROM blocks WHERE file_id = ? AND uploaded = 0`)
      .get(fileId) as { c: number };
    if (row.c > 0) throw new Error(`still ${row.c} block(s) pending`);
    this.db
      .prepare(`UPDATE files SET state = 'complete', updated_at = ? WHERE id = ?`)
      .run(now(), fileId);
  }

  listFiles(): FileRow[] {
    const rows = this.db
      .prepare(
        `SELECT id, name, size, sha256, block_size, state, created_at, updated_at
         FROM files ORDER BY name`,
      )
      .all() as Array<Record<string, unknown>>;
    return rows.map((r) => this.toFileRow(r));
  }

  delete(name: string): void {
    const res = this.db.prepare(`DELETE FROM files WHERE name = ?`).run(name);
    if (res.changes === 0) throw new NotFoundError();
  }

  private toFileRow(r: Record<string, unknown>): FileRow {
    return {
      id: Number(r.id),
      name: String(r.name),
      size: Number(r.size),
      sha256: String(r.sha256),
      block_size: Number(r.block_size),
      state: String(r.state),
      created_at: Number(r.created_at),
      updated_at: Number(r.updated_at),
    };
  }

  private toBlockRow(r: Record<string, unknown>): BlockRow {
    return {
      file_id: Number(r.file_id),
      idx: Number(r.idx),
      sha256: String(r.sha256),
      size: Number(r.size),
      uploaded: Number(r.uploaded) === 1,
      storage_nodes: JSON.parse(String(r.storage_nodes)) as string[],
    };
  }
}
