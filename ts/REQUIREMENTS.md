# MiniDSS (TypeScript) — MVP 需求与功能梳理

本文档用工作流方式梳理 MVP 版本的需求、范围与验收标准。TypeScript 版本与
Go 版本（`../go`）保持**协议与行为等价**，便于互相替换与对照。

## 1. 背景与目标

把原 C++ 的"迷你分布式存储"重写为一个**可部署、可测试**的 MVP：
- 一个 **coordinator**（协调/元数据服务）
- N 个 **storage node**（内容寻址块存储）
- 一个 **client CLI**（分块上传/下载）

目标用户：内部工具 / 教学 / 小规模文件存储。非目标：高并发对象存储、纠删码、
跨机房一致性。

## 2. MVP 范围（In Scope）

| 编号 | 功能 | 说明 |
|---|---|---|
| F1 | 文件分块 | 客户端按固定块大小（默认 4 MiB）切分，逐块算 SHA-256，整文件算 SHA-256 |
| F2 | 内容寻址存储 | 块以其 SHA-256 为唯一 id 存放（`/blocks/{sha256}`），天然去重 |
| F3 | 元数据持久化 | coordinator 用 SQLite 记录 文件→块→(块 md5/大小/上传状态/副本节点) |
| F4 | 副本与分布 | rendezvous (HRW) hashing 选 N 个副本节点，可配置副本因子 |
| F5 | 断点续传 | `init` 幂等返回缺失块；中断后重传只补缺失部分 |
| F6 | 完整性校验 | 三层 hash 校验：客户端→coordinator→storage 都验，不一致拒收 |
| F7 | 命名空间唯一 | 同名不同内容返回 409；删除后可复用名 |
| F8 | 故障容忍读 | 副本数≥2 时，部分 storage 节点离线仍可下载 |
| F9 | CLI 操作 | `upload` / `download` / `ls` / `rm` |
| F10 | 部署 | 单一可执行（node + 编译产物），支持 flag/env 配置，可容器化 |

## 3. 非范围（Out of Scope，MVP 不做）

- 鉴权 / 多租户 / ACL
- 节点主动健康探测与自动再平衡（失败靠请求时发现）
- 纠删码 / 压缩 / 加密
- 并行副本写入（MVP 串行扇出）
- 范围请求（HTTP Range）/ 断点续下

## 4. 架构与组件

```
        ┌──────────┐  upload/download/ls/rm   ┌──────────────┐
        │  dssctl  │ ───────HTTP/JSON───────▶  │ coordinator  │
        │  (CLI)   │ ◀──────stream──────────── │  (元数据+路由)│
        └──────────┘                            └──────┬───────┘
                                                       │ HRW 选副本
                              ┌────────────────────────┼────────────────────────┐
                              ▼                         ▼                         ▼
                       ┌────────────┐           ┌────────────┐           ┌────────────┐
                       │ storage #1 │           │ storage #2 │           │ storage #3 │
                       │ /blocks/.. │           │ /blocks/.. │           │ /blocks/.. │
                       └────────────┘           └────────────┘           └────────────┘
```

- **coordinator**：无状态路由 + SQLite 元数据。不落块数据，只转发。
- **storage node**：内容寻址，块落盘到 `{data}/{aa}/{bb...}`，原子 temp+rename。
- **client**：本地分块、与 coordinator 走 REST、块体 octet-stream。

## 5. HTTP API 契约

### Coordinator（默认 :9981）
| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/healthz` | 健康检查 |
| GET | `/v1/files` | 列出所有文件 |
| POST | `/v1/files/{name}/init` | 注册 manifest，返回缺失块 `{missing:[...]}` |
| PUT | `/v1/files/{name}/blocks/{idx}` | 上传第 idx 块（校验 size+sha 后扇出副本） |
| GET | `/v1/files/{name}/blocks/{idx}` | 下载单块 |
| POST | `/v1/files/{name}/commit` | 标记完成（所有块齐才成功） |
| GET | `/v1/files/{name}/manifest` | 取 manifest |
| GET | `/v1/files/{name}` | 流式下载整文件 |
| DELETE | `/v1/files/{name}` | 删除文件及其块 |

### Storage（默认 :9982+）
| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/healthz` | 健康检查 |
| PUT | `/blocks/{sha256}` | 写块（校验 body sha == 路径 id，幂等） |
| GET | `/blocks/{sha256}` | 读块 |
| HEAD | `/blocks/{sha256}` | 探块是否存在 |
| DELETE | `/blocks/{sha256}` | 删块 |

## 6. 数据模型（SQLite）

```sql
files(id PK, name UNIQUE, size, sha256, block_size, state, created_at, updated_at)
blocks(file_id, idx, sha256, size, uploaded, storage_nodes(JSON), PK(file_id, idx))
```
- `state`: `pending` → `complete`
- `storage_nodes`: 该块被分配到的副本节点 base URL 列表

## 7. 验收标准（对应测试）

| 编号 | 验收标准 | 测试 |
|---|---|---|
| AC1 | 任意大小文件（含 0 字节、非整块倍数）上传后下载 SHA-256 一致 | chunk 单测 + e2e |
| AC2 | 重复上传同一文件，`init` 返回空缺失（去重/续传） | e2e |
| AC3 | 上传部分块后重入 `init`，只返回未传块 | e2e |
| AC4 | 所有块未齐时 `commit` 返回 400 | e2e |
| AC5 | 同名不同内容 `init` 返回 409，原文件不受影响 | e2e |
| AC6 | body 与块 id 不符时 storage/coordinator 拒收（400） | e2e |
| AC7 | 非法块 id、缺失块的请求返回 400/404 | e2e |
| AC8 | 副本=2 时杀掉一个 storage 节点仍可下载 | e2e |
| AC9 | `ls` / `rm` 行为正确，删除后块被清理 | e2e |

## 8. 配置项

| 组件 | flag | env | 默认 |
|---|---|---|---|
| coordinator | `--addr` | `MINIDSS_ADDR` | `:9981` |
| coordinator | `--db` | `MINIDSS_DB` | `coordinator.db` |
| coordinator | `--nodes` | `MINIDSS_NODES` | 三个本机节点 |
| coordinator | `--replicas` | `MINIDSS_REPLICAS` | `1` |
| storage | `--addr` | `MINIDSS_ADDR` | `:9982` |
| storage | `--data` | `MINIDSS_DATA` | `data` |
| client | `--coordinator` | `MINIDSS_COORDINATOR` | `http://127.0.0.1:9981` |
| client | `--block-size` | — | `4194304` |

## 9. 技术选型

- **Node.js 22**（内建 `node:http` / `node:sqlite` / `node:crypto` / `node:test`）
- **TypeScript strict**，编译到 `dist/`
- **零运行时依赖**（仅 dev: `typescript` + `@types/node`）
- 选 `node:sqlite` 而非第三方驱动：免编译、免 CGO、与 Go 版 SQLite 行为对齐
