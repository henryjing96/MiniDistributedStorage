# MiniDSS — TypeScript MVP

Mini distributed storage, rewritten in TypeScript. Protocol- and
behavior-equivalent to the Go version in [`../go`](../go). Zero runtime
dependencies — uses only Node 22 built-ins (`node:http`, `node:sqlite`,
`node:crypto`, `node:test`).

See [`REQUIREMENTS.md`](./REQUIREMENTS.md) for the full MVP requirements /
feature breakdown, and [`TESTREPORT.md`](./TESTREPORT.md) for test results.

## Architecture

```
dssctl (CLI) ──HTTP/JSON──▶ coordinator ──HRW replica select──▶ storage ×N
                            (SQLite meta)                       (content-addressed blocks)
```

- **coordinator** (`src/coordinator`) — `/v1/files` REST API, SQLite metadata,
  rendezvous (HRW) hashing to pick replicas, fan-out block writes.
- **storage** (`src/storage`) — content-addressed blocks at `/blocks/{sha256}`,
  atomic temp+rename, hash verification on write.
- **client** (`src/client`) — chunk → SHA-256 → resumable upload / download.

## Requirements

- Node.js ≥ 22.5 (for stable-ish `node:sqlite`)

## Build & test

```bash
npm install
npm run build      # tsc -> dist/
npm test           # build + node:test (unit + e2e)
npm run typecheck  # tsc --noEmit
```

## Run locally (4 terminals)

```bash
npm run build
node dist/src/storage/main.js     --addr :9982 --data data1 --id n1
node dist/src/storage/main.js     --addr :9983 --data data2 --id n2
node dist/src/storage/main.js     --addr :9984 --data data3 --id n3
node dist/src/coordinator/main.js --addr :9981 --db coordinator.db \
  --nodes 'http://127.0.0.1:9982,http://127.0.0.1:9983,http://127.0.0.1:9984' --replicas 2
```

Then:

```bash
export MINIDSS_COORDINATOR=http://127.0.0.1:9981
node dist/src/client/main.js upload ./somefile.bin
node dist/src/client/main.js ls
node dist/src/client/main.js download somefile.bin ./out.bin
node dist/src/client/main.js rm somefile.bin
```

## Docker

```bash
docker compose up --build
```

## Configuration

| Component | flag | env | default |
|---|---|---|---|
| coordinator | `--addr` | `MINIDSS_ADDR` | `:9981` |
| coordinator | `--db` | `MINIDSS_DB` | `coordinator.db` |
| coordinator | `--nodes` | `MINIDSS_NODES` | three localhost nodes |
| coordinator | `--replicas` | `MINIDSS_REPLICAS` | `1` |
| storage | `--addr` | `MINIDSS_ADDR` | `:9982` |
| storage | `--data` | `MINIDSS_DATA` | `data` |
| client | `--coordinator` | `MINIDSS_COORDINATOR` | `http://127.0.0.1:9981` |
| client | `--block-size` | — | `4194304` (4 MiB) |
