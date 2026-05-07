package metastore

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	_ "modernc.org/sqlite"
)

const schema = `
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
`

var (
	ErrNotFound = errors.New("not found")
	ErrConflict = errors.New("conflict: file exists with different content")
)

type FileRow struct {
	ID        int64
	Name      string
	Size      int64
	SHA256    string
	BlockSize int
	State     string
	CreatedAt int64
	UpdatedAt int64
}

type BlockRow struct {
	FileID       int64
	Idx          int
	SHA256       string
	Size         int
	Uploaded     bool
	StorageNodes []string
}

type Store struct {
	db *sql.DB
}

func Open(dsn string) (*Store, error) {
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	for _, p := range []string{
		"PRAGMA foreign_keys = ON",
		"PRAGMA journal_mode = WAL",
		"PRAGMA synchronous = NORMAL",
	} {
		if _, err := db.Exec(p); err != nil {
			db.Close()
			return nil, fmt.Errorf("pragma %q: %w", p, err)
		}
	}
	if _, err := db.Exec(schema); err != nil {
		db.Close()
		return nil, fmt.Errorf("schema: %w", err)
	}
	return &Store{db: db}, nil
}

func (s *Store) Close() error { return s.db.Close() }

func (s *Store) GetFile(name string) (*FileRow, error) {
	row := s.db.QueryRow(
		`SELECT id, name, size, sha256, block_size, state, created_at, updated_at
		 FROM files WHERE name = ?`, name)
	f := &FileRow{}
	err := row.Scan(&f.ID, &f.Name, &f.Size, &f.SHA256, &f.BlockSize, &f.State, &f.CreatedAt, &f.UpdatedAt)
	if err == sql.ErrNoRows {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return f, nil
}

// CreateOrResume registers an upload. If the file already exists with the same
// (size, sha256), it returns the existing row (resume). If a file with the
// same name but different content exists, it returns ErrConflict. Block rows
// are inserted only on first creation.
func (s *Store) CreateOrResume(name string, size int64, sha string, blockSize int, blocks []BlockRow) (*FileRow, error) {
	tx, err := s.db.Begin()
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()

	var existing FileRow
	err = tx.QueryRow(
		`SELECT id, name, size, sha256, block_size, state, created_at, updated_at
		 FROM files WHERE name = ?`, name).
		Scan(&existing.ID, &existing.Name, &existing.Size, &existing.SHA256,
			&existing.BlockSize, &existing.State, &existing.CreatedAt, &existing.UpdatedAt)
	now := time.Now().Unix()

	if err == nil {
		if existing.SHA256 != sha || existing.Size != size {
			return nil, ErrConflict
		}
		if _, err := tx.Exec(`UPDATE files SET updated_at = ? WHERE id = ?`, now, existing.ID); err != nil {
			return nil, err
		}
		if err := tx.Commit(); err != nil {
			return nil, err
		}
		return s.GetFile(name)
	}
	if err != sql.ErrNoRows {
		return nil, err
	}

	res, err := tx.Exec(
		`INSERT INTO files(name, size, sha256, block_size, state, created_at, updated_at)
		 VALUES(?,?,?,?,?,?,?)`,
		name, size, sha, blockSize, "pending", now, now)
	if err != nil {
		return nil, err
	}
	fid, err := res.LastInsertId()
	if err != nil {
		return nil, err
	}

	stmt, err := tx.Prepare(
		`INSERT INTO blocks(file_id, idx, sha256, size, uploaded, storage_nodes)
		 VALUES(?, ?, ?, ?, 0, ?)`)
	if err != nil {
		return nil, err
	}
	defer stmt.Close()
	for _, b := range blocks {
		nodes, err := json.Marshal(b.StorageNodes)
		if err != nil {
			return nil, err
		}
		if _, err := stmt.Exec(fid, b.Idx, b.SHA256, b.Size, string(nodes)); err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return s.GetFile(name)
}

func (s *Store) MissingBlocks(fileID int64) ([]int, error) {
	rows, err := s.db.Query(
		`SELECT idx FROM blocks WHERE file_id = ? AND uploaded = 0 ORDER BY idx`, fileID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []int
	for rows.Next() {
		var i int
		if err := rows.Scan(&i); err != nil {
			return nil, err
		}
		out = append(out, i)
	}
	return out, rows.Err()
}

func (s *Store) GetBlock(fileID int64, idx int) (*BlockRow, error) {
	b := &BlockRow{}
	var up int
	var nodesJSON string
	err := s.db.QueryRow(
		`SELECT file_id, idx, sha256, size, uploaded, storage_nodes
		 FROM blocks WHERE file_id = ? AND idx = ?`, fileID, idx).
		Scan(&b.FileID, &b.Idx, &b.SHA256, &b.Size, &up, &nodesJSON)
	if err == sql.ErrNoRows {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	b.Uploaded = up == 1
	if err := json.Unmarshal([]byte(nodesJSON), &b.StorageNodes); err != nil {
		return nil, fmt.Errorf("decode storage_nodes: %w", err)
	}
	return b, nil
}

func (s *Store) ListBlocks(fileID int64) ([]BlockRow, error) {
	rows, err := s.db.Query(
		`SELECT file_id, idx, sha256, size, uploaded, storage_nodes
		 FROM blocks WHERE file_id = ? ORDER BY idx`, fileID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []BlockRow
	for rows.Next() {
		var b BlockRow
		var up int
		var nodesJSON string
		if err := rows.Scan(&b.FileID, &b.Idx, &b.SHA256, &b.Size, &up, &nodesJSON); err != nil {
			return nil, err
		}
		b.Uploaded = up == 1
		if err := json.Unmarshal([]byte(nodesJSON), &b.StorageNodes); err != nil {
			return nil, err
		}
		out = append(out, b)
	}
	return out, rows.Err()
}

func (s *Store) MarkUploaded(fileID int64, idx int) error {
	res, err := s.db.Exec(
		`UPDATE blocks SET uploaded = 1 WHERE file_id = ? AND idx = ?`, fileID, idx)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return ErrNotFound
	}
	_, err = s.db.Exec(`UPDATE files SET updated_at = ? WHERE id = ?`, time.Now().Unix(), fileID)
	return err
}

func (s *Store) MarkComplete(fileID int64) error {
	var pending int
	if err := s.db.QueryRow(
		`SELECT COUNT(*) FROM blocks WHERE file_id = ? AND uploaded = 0`, fileID).
		Scan(&pending); err != nil {
		return err
	}
	if pending > 0 {
		return fmt.Errorf("still %d block(s) pending", pending)
	}
	_, err := s.db.Exec(
		`UPDATE files SET state = 'complete', updated_at = ? WHERE id = ?`,
		time.Now().Unix(), fileID)
	return err
}

func (s *Store) ListFiles() ([]FileRow, error) {
	rows, err := s.db.Query(
		`SELECT id, name, size, sha256, block_size, state, created_at, updated_at
		 FROM files ORDER BY name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []FileRow
	for rows.Next() {
		var f FileRow
		if err := rows.Scan(&f.ID, &f.Name, &f.Size, &f.SHA256, &f.BlockSize, &f.State, &f.CreatedAt, &f.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, f)
	}
	return out, rows.Err()
}

func (s *Store) Delete(name string) error {
	res, err := s.db.Exec(`DELETE FROM files WHERE name = ?`, name)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return ErrNotFound
	}
	return nil
}
