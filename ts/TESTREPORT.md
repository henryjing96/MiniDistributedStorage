# MiniDSS (TypeScript) — 测试报告

- 日期: 2026-05-29
- 分支: `claude/explore-repository-8kGXC`
- 环境: Ubuntu 24.04 / x86_64,Node.js v22.22.2,TypeScript 5.7
- 测试框架: 内建 `node:test`(零第三方依赖)

## 1. 概述

按工作流三阶段交付:**需求梳理 (`REQUIREMENTS.md`) → TypeScript 重写 → 测试**。
测试分两层:
1. **单元测试** — 分块/哈希逻辑(`test/chunk.test.ts`)
2. **端到端测试** — 在进程内拉起 1 coordinator + 3 storage 的真集群,用真实
   HTTP 跑完整上传/下载/故障路径(`test/e2e.test.ts` + `test/cluster.ts`)

最终结果:**10 / 10 通过**,耗时约 1.9 s。

```
ok 1  - buildManifest round-trips for various sizes
ok 2  - AC1: upload/download round-trip preserves sha256
ok 3  - AC1b: zero-byte file round-trips
ok 4  - AC2: re-upload (dedup/resume) reports all blocks present
ok 5  - AC3+AC4+AC5: resume missing blocks, early commit 400, conflict 409
ok 6  - AC6: storage + coordinator reject hash mismatches
ok 7  - AC7: bad index and unknown file handled
ok 8  - AC8: download survives one downed node (replicas=2)
ok 9  - AC8b: replicas=3 survives 2 downed nodes; fails when all down
ok 10 - AC9: ls lists files, rm deletes file and blocks
# tests 10 | pass 10 | fail 0
```

## 2. 验收标准对照

| AC | 标准 | 对应测试 | 结果 |
|---|---|---|---|
| AC1 | 任意大小(含 0 字节、非整块倍数)round-trip SHA 一致 | chunk 单测 + AC1/AC1b | PASS |
| AC2 | 重复上传同文件,`init` 返回空缺失(去重/续传) | AC2 | PASS |
| AC3 | 上传部分块后重入 `init`,只返回未传块 | AC3+4+5 | PASS |
| AC4 | 所有块未齐时 `commit` 返回 400 | AC3+4+5 | PASS |
| AC5 | 同名不同内容 `init` 返回 409,原文件不受影响 | AC3+4+5 | PASS |
| AC6 | body 与块 id 不符时 storage/coordinator 拒收(400) | AC6 | PASS |
| AC7 | 非法块 id、缺失文件、路径穿越名返回 400/404 | AC7 | PASS |
| AC8 | 副本=2 时杀掉一个 storage 节点仍可下载 | AC8 | PASS |
| AC9 | `ls`/`rm` 正确,删除后块被清理 | AC9 | PASS |

附加(超出最初 AC):AC8b 验证 replicas=3 容忍 2 节点离线、三节点全离线则下载失败。

## 3. 单元测试细节

`buildManifest` 在 7 种边界尺寸下逐块校验:
`0, 1, 1024, blockSize-1, blockSize, blockSize+17, blockSize*2+5`。
- 整文件 SHA-256 与一次性 hash 一致
- 每个块的 SHA-256 与切片重算一致
- 块覆盖的字节数 == 文件大小
- 块数 == `ceil(size/blockSize)`(0 字节 → 0 块)

## 4. 测试中发现并修正的问题

### 4.1 测试设计错误:replicas=2 的容错边界
**现象**:初版 AC8 在 replicas=2、3 节点的集群里"杀两个节点"后还期望下载成功,
实际报 `fetch terminated`。
**根因**:replicas=2 只保证**每块有 2 份副本**;杀 2 个节点时,某个块的两份副本
恰好都在被杀的两台上 → 该块彻底不可达,coordinator 流式下载中途
`res.destroy()`,客户端 fetch 被中断。这是**正确的系统行为**(数据确实丢了),
错的是测试预期。
**修正**:把容错断言改对——
- replicas=2 → 只容忍 1 节点离线(AC8)
- replicas=3 → 容忍 2 节点离线,3 节点全离线则下载失败(AC8b)

这与 Go 版测试报告里的结论一致(Go 版也是在 replicas=3 下才杀 2 台)。

### 4.2 编译期类型问题:`@types/node` v22 的 `Buffer` 泛型化
`Buffer.alloc()` 返回 `Buffer<ArrayBuffer>`,而 `subarray()` 返回
`Buffer<ArrayBufferLike>`,直接赋值在 strict 下报 TS2322。
**修正**:把累加变量显式标注为 `let carry: Buffer`,消除泛型不匹配。

### 4.3 产物路径
`tsconfig` 同时编译 `src/` 和 `test/`(rootDir `.`),产物落在 `dist/src/...`
与 `dist/test/...`。已把 `package.json` 的运行脚本与 README 全部对齐到
`dist/src/...`。

## 5. 真实进程冒烟测试(非自动化,手工验证部署路径)

在沙盒里用真实独立进程(非进程内)跑了一遍,验证 `node dist/src/...` 部署路径:

| 步骤 | 结果 |
|---|---|
| 拉起 3 storage(18982/3/4)+ coordinator(18981,replicas=2) | 4 个 `/healthz` 全 OK |
| `dssctl upload` 50 MiB(4 MiB 块,13 块) | 成功,SHA 一致 |
| 块分布 | stor1=9 / stor2=9 / stor3=8(共 26 = 13×2)|
| `dssctl download` 反向校验 | ROUND-TRIP SHA OK |
| `dssctl rm` | 删除成功,`ls` 变空 |

## 6. 沙盒环境限制(非代码问题)

- **Docker 构建**:`docker compose up --build` 需要拉 `node:22-slim` 基础镜像,
  本沙盒从 Docker CDN 拉该镜像的 blob 返回 **403 Forbidden**(网络限制,与 Go
  版报告里 `proxy.golang.org` TLS 受限同类)。`Dockerfile` 与 `docker-compose.yml`
  配置本身有效,在正常网络环境可直接 `docker compose up --build`。
  本轮已用"真实独立进程"路径替代验证部署可行性(见第 5 节)。

## 7. 如何复现

```bash
cd ts
npm install
npm test          # 10 个测试,约 2s
npm run typecheck # 严格模式类型检查,0 error
```

## 8. 与 Go 版的对照

| 维度 | Go 版 | TS 版 |
|---|---|---|
| 协议 | `/v1/files` REST + 内容寻址 | **完全相同**(可互换) |
| 元数据 | SQLite (modernc) | SQLite (`node:sqlite`) |
| 副本选择 | rendezvous (HRW) | rendezvous (HRW) |
| 运行时依赖 | 纯 Go,无 CGO | **零运行时依赖**,仅 Node 内建 |
| 测试 | `go test`(chunk 单测 + 手工 e2e) | `node:test`(chunk 单测 + 自动化 e2e 集群) |
| 并发写 DB | 需 `SetMaxOpenConns(1)` 修复 | `node:sqlite` 单线程同步,天然无竞争 |

> 注:TS 版的 e2e 测试比 Go 版更进一步——把整个集群拉进单进程用 `node:test`
> 自动化,CI 里 `npm test` 一条命令即可跑完所有故障注入场景。
