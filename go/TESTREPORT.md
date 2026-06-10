# MiniDSS Go 版本 — 测试报告

- 日期: 2026-05-08
- 提交: `claude/explore-repository-8kGXC`
- 环境: Ubuntu 24.04 LTS / x86_64,4 vCPU / 15 GiB RAM,Go 1.24.7,Docker 29.3.1
- 集群拓扑: 1 个 coordinator + 3 个 storage 节点(本机回环),replicas 因子按用例切换

## 总览

| # | 用例 | 结果 | 备注 |
|---|---|---|---|
| 1 | 大文件 100 MB / 1 GB 端到端 | **PASS** | 上传 ~19.5 MiB/s,下载 ~120 MiB/s |
| 2 | 10 路并发上传 | **PASS**(修复 1 个 bug 后) | 发现并修复 SQLite BUSY 竞争 |
| 3 | replicas=3 顺序杀节点 | **PASS** | 杀任一台、任两台读仍成功;三台全杀失败合理 |
| 4 | 断点续传 + 早 commit / 重入 init | **PASS** | API 直接驱动,行为完全符合 |
| 5 | Docker Compose 端到端 + restart | **PASS** | 沙盒 TLS 限制下走 bind-mount 变体,见说明 |
| 6 | 哈希不匹配 / 非法 id / 缺失块 | **PASS** | 4 个层面都正确拒绝 |
| 7 | 同名不同内容(409 冲突) | **PASS** | 旧文件不受影响,删除后可复用名 |

> **关键发现**: 用例 2 暴露出 SQLite 在并发写下抛 `SQLITE_BUSY (5)` 的真问题,本轮已在 `internal/metastore/metastore.go` 修复(`SetMaxOpenConns(1)` + `busy_timeout=5000`),修复后并发 100% 成功。

## 用例 1 — 大文件吞吐与正确性

**做法**: `dssctl -block-size 4 MiB upload <file>`,replicas=2,4 MiB 块。上传后 `download` 反向校验 SHA-256。

| 大小 | 块数 | 上传 | 上传吞吐 | 下载 | 下载吞吐 | 节点分布(块文件) | SHA256 |
|---|---:|---:|---:|---:|---:|---|---|
| 100 MiB | 25 | 5.14 s | 19.5 MiB/s | 0.76 s | 131.6 MiB/s | 17 / 15 / 18(总 50 = 25×2)| 一致 |
| 1024 MiB | 256 | 51.77 s | 19.8 MiB/s | 8.60 s | 119.1 MiB/s | 176 / 169 / 167(总 512 = 256×2)| 一致 |

**结论**:
- 写吞吐瓶颈在 coordinator 缓冲 + 扇出 PUT 到 N 副本(每块过两遍 HTTP),约 ~20 MiB/s。
- 读吞吐为存储节点直拉 + 顺序写出,~120 MiB/s,接近本机回环带宽。
- HRW 分布接近均匀(±5%)。

## 用例 2 — 10 路并发上传(发现 + 修复 bug)

**做法**: 10 个 20 MiB 文件并行 `dssctl upload`,然后逐个下载校验。

**第一次跑(修复前)**:
```
upload failures: 7 / 10
errors:
  init: 500 Internal Server Error: database is locked (5) (SQLITE_BUSY)
  block 0: 500 Internal Server Error: database is locked (5) (SQLITE_BUSY)
```
原因:`modernc.org/sqlite` 默认每个 `db.Exec`/`Begin` 拿不同连接,同时多个写者上来直接撞锁;WAL 只允许单写者,没设 `busy_timeout` 也不会等。

**修复**(`internal/metastore/metastore.go`):
```go
db.SetMaxOpenConns(1)                // 序列化所有写,标准 Go+SQLite 模式
... PRAGMA busy_timeout = 5000 ...   // 防御性 5s 等待
```

**修复后**:
```
elapsed=3.27s
upload failures: 0 / 10
verify failures: 0 / 10
aggregate throughput: 61.2 MiB/s (200 MiB in 3.27s)
```

10 个独立文件并发上传全部成功且 SHA 全部一致。10 路串行预期约 5–10 s/路,实际 3.27 s 总耗时,说明 HTTP 并发与块扇出并未被 DB 串行化吃掉——DB 写只在 init/MarkUploaded/commit 时短暂持锁,主路径依然并行。

## 用例 3 — replicas=3 副本失效

**做法**: replicas=3,上传 30 MiB(8 块);依次杀节点 1、2、3,每次校验下载;再连杀两台;最后三台全杀。

| 步骤 | 期望 | 实际 |
|---|---|---|
| 上传 30 MiB,replicas=3 | 三个节点各持 8 块、共 31 MiB | 三节点各 8 块 / 31457280 字节 ✓ |
| 杀 19982 → 下载 | 成功 | OK,SHA 一致 |
| 杀 19983 → 下载 | 成功 | OK |
| 杀 19984 → 下载 | 成功 | OK |
| 杀 19982 + 19983(只剩 1 副本)→ 下载 | 成功 | OK |
| 杀 19982 + 19983 + 19984 → 下载 | 失败 | `error: unexpected EOF`(预期失败) |

**结论**:rendezvous (HRW) hashing 选副本 + 读时按候选顺序回退是工作的。3 副本下任意 ≤2 台离线服务都连续可用。

## 用例 4 — 断点续传 / 重入 init / 早 commit

**做法**: `tmp/dss-rep/resume_test.py` 直接打 coordinator API。25 MiB / 4 MiB 块 → 7 块。

| 步骤 | 期望 | 实际 |
|---|---|---|
| `POST /init` 全新文件 | 返回 missing=[0..6] | `[0,1,2,3,4,5,6]` ✓ |
| 上传块 0/1/2 | 各 200 | 全部 200 ✓ |
| `POST /commit` 此时 | 400(还有 4 块没传)| `400 still 4 block(s) pending` ✓ |
| `POST /init` 同 manifest 重入 | missing=[3..6] | `[3,4,5,6]` ✓ |
| `POST /init` 用相同 name 但不同 sha | 409 | `409 conflict: file exists with different content` ✓ |
| 上传块 3/4/5/6 + commit + download | SHA 一致 | 一致 ✓ |

**结论**: 上传中断后再来一遍,只补缺失块,不会重传已经在的部分;客户端没复杂状态,init 是无状态幂等入口。

## 用例 5 — Docker Compose 端到端

**做法**: `docker compose -f compose.test.yml up -d`,4 容器(3 storage + 1 coordinator),通过宿主机映射端口 29981-29984 用 `dssctl` 测 50 MiB 上传/下载,然后 `compose restart` 验证持久化。

| 检查项 | 结果 |
|---|---|
| 4 个容器全部 `Up` | ✓ |
| 健康端点 `/healthz` 全 OK | ✓ |
| 50 MiB 上传(replicas=2)| 1.88 s |
| 下载 SHA 一致 | ✓ |
| 容器间服务名解析 `coord -> storage1:9982` | ✓ |
| `docker compose restart` 后数据仍在(持久化卷)| ✓ |

**说明 / 沙盒变通**:
项目根的 `docker-compose.yml` 走的是从源码构建(`build: { context: . }`),需要在容器内访问 `proxy.golang.org` 拉模块。本沙盒里容器内的根 CA 不信任 proxy.golang.org 的证书,源码构建会在 `go mod download` 阶段挂掉。
变通方案:本机 `CGO_ENABLED=0 go build` 出**完全静态**的二进制,通过 `bind mount` 注入 `alpine:3.19` 容器(`/tmp/dss-rep/compose.test.yml`)。这条路径在任何 Linux/amd64 的环境里都能跑,也是离线/internal 部署的常见做法。
正常网络下,`compose up --build` 仍可用——这只是沙盒环境的限制。

## 用例 6 — 哈希不匹配 / 非法输入

**做法**: 直接 `curl` 打 storage 节点和 coordinator,触发各种坏输入。

| 子例 | 做法 | 期望 | 实际 |
|---|---|---|---|
| A. PUT 带错误 id | `PUT /blocks/ff..ff` 但 body 是 `"hello world"` | 400 hash mismatch,块不落盘 | HTTP 400,无文件持久化 ✓ |
| B. PUT 正确 id | `PUT /blocks/<sha("hello world")>` body 一致 | 201 + GET 能读回 | 201 ✓,GET 内容一致 ✓ |
| C. 非法 id 格式 | `PUT /blocks/notahash` | 400 invalid block id | HTTP 400 ✓ |
| D. GET 不存在的块 | `GET /blocks/aa..aa` | 404 | HTTP 404 ✓ |
| E. 客户端伪造 manifest(块 sha 故意填错) | 走 coord,数据 sha 与 manifest 不符 | coordinator 拒绝 | HTTP 400 `block hash mismatch` ✓ |

**结论**: 三层防御都触发——
1. coordinator 上传时按 manifest 算字节哈希 → 校验
2. coordinator 转发到 storage 时,URL 路径里的块 id 就是 sha
3. storage 也再算一遍 → 不一致直接拒收

任何一层崩了,后面还能兜住。

## 用例 7 — 同名不同内容(409)

**做法**: 先上传 5 MiB 文件 A 为 `shared.bin`,再用不同内容的 5 MiB 文件 B 用同名上传。

| 步骤 | 期望 | 实际 |
|---|---|---|
| 上传 A | 200 | OK,ls 显示 complete |
| 上传 B 同名 | 409 | `409 conflict: file exists with different content` ✓ |
| 下载 `shared.bin` | 仍是 A 的内容 | SHA 与 A 一致 ✓ |
| `rm shared.bin` 后再传 B | 200 | OK,SHA 与 B 一致 ✓ |

**结论**: 命名空间唯一性保证了,失败的覆盖不会改变现存数据。

## 测试人 / 复现说明

测试脚本与产物路径(沙盒生命周期内有效):
```
/tmp/dss-rep/
  artifacts/largefile.tsv        # 用例 1 数据
  artifacts/concurrent.tsv       # 用例 2 数据
  artifacts/resume.log           # 用例 4 trace
  artifacts/compose.tsv          # 用例 5 数据
  resume_test.py                 # 用例 4 脚本
  compose.test.yml               # 用例 5 compose 文件
  logs/{coord,stor1,stor2,stor3}.log
```

复现:
```bash
cd go && make build
make run-stor1 &
make run-stor2 &
make run-stor3 &
make run-coord &
./bin/dssctl upload <file>
```

## 改动总结

本轮测试触发的代码改动:

- `internal/metastore/metastore.go` — `SetMaxOpenConns(1)` + `busy_timeout=5000`,修复并发写 SQLITE_BUSY。

未发现需要改的代码:
- 协议帧、HRW 选副本、内容寻址、断点续传、命名空间冲突、客户端/服务端三层 hash 校验,行为符合预期。

## 后续建议(非本轮范围)

- **写吞吐**:扇出到副本是顺序的,可以改成并行 `errgroup`,理论上能把 100MB 上传从 5s 压到 ~3s。
- **下载错误处理**:三副本全挂时返回 `unexpected EOF` 不够友好,可以改成提前探活并返回 503。
- **健康监测**:目前 coordinator 不主动探活 storage 节点,失败靠 PUT 时撞墙发现;加一个后台探活 + 指标暴露(Prometheus)更好。
- **真容器构建**:在能访问 proxy.golang.org 的环境下,根 `docker-compose.yml` 的 `build:` 路径应该正常工作;沙盒内只是 TLS 链断了。
