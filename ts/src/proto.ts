// Shared protocol types and constants. Mirrors go/internal/proto.

export const DEFAULT_BLOCK_SIZE = 4 * 1024 * 1024; // 4 MiB
export const HASH_HEX_LEN = 64; // sha256 hex length

export interface BlockInfo {
  index: number;
  size: number;
  sha256: string;
}

export interface Manifest {
  name: string;
  size: number;
  sha256: string;
  block_size: number;
  blocks: BlockInfo[];
}

export interface InitResponse {
  missing: number[];
}

export interface FileEntry {
  name: string;
  size: number;
  sha256: string;
  state: string;
  updated_at: number;
}

export interface CommitResponse {
  ok: boolean;
}

const HASH_RE = /^[0-9a-f]{64}$/;

export function isValidHash(s: string): boolean {
  return HASH_RE.test(s);
}

/** Reject path traversal / control chars / empty / overly long names. */
export function isValidName(name: string): boolean {
  if (name.length === 0 || name.length > 255) return false;
  if (name.includes("/") || name.includes("\\") || name.includes("..")) {
    return false;
  }
  for (const ch of name) {
    if (ch.charCodeAt(0) < 0x20) return false;
  }
  return true;
}
