# 应急推演 · 微服务后端（事件采集 / 历史存储 / 回放计算 / 推演网关 / 现场同步）

把原纯前端单体（Pinia 四 store + 全量快照帧）重构为五个**独立进程**的事件溯源系统，
支撑多人并行推演、断线续演、事件乱序、分支并发写入、移动端现场离线协同与故障恢复，并与真实调度物理隔离。

零外部依赖（仅 Node.js 内置模块），数据落本地文件，便于演示与测试。

## 五个独立服务

| 服务 | 端口 | 职责 |
| --- | --- | --- |
| 推演网关 `gateway` | 7100 | 指挥员/前端唯一业务入口；会话↔推演↔分支；业务命令→领域事件；阻断联动编排；**现场离线动作因果补传**；真实流令牌门禁 |
| 事件采集 `ingestion` | 7101 | 多端事件统一入口；分配 clientId 与 **HLC**；乱序窗口重排；本地 **WAL** 崩溃重投；断线会话 |
| 历史存储 `history` | 7102 | **权威事实流**：每分支追加事件日志（JSONL）+ 分支树（fork copy-on-write）+ 快照检查点 + 故障恢复 |
| 回放计算 `replay` | 7103 | 从历史拉事件，按**因果序折叠**重建库存/床位/运输/预警/现场队伍状态；任意节点 seek；四维度 diff；双分支对照；旧快照迁移 |
| 现场同步 `field` | 7104 | 移动端门户：**离线包**（预警/签收单/工单缓存）、现场动作离线队列（JSONL 持久化）、联网按因果序补传、逐条回执与冲突落账 |

> 实际默认端口见 `lib/config.js`（网关 7100 / 采集 7101 / 历史 7102 / 回放 7103 / 现场 7104），
> 均可用环境变量覆盖，便于同机多实例。

```
指挥员/指挥端 ──HTTP──▶ [gateway:7100]
                          │  命令前置校验/阻断几何编排/现场动作因果补传
                          ▼
现场队伍移动端 ─▶ [field:7104] ──▶ [ingestion:7101]  HLC + 乱序窗口 + WAL（离线队列 + WAL 双保险）
  · 离线包缓存预警/任务           │  可靠投递（重连重试/崩溃重放）
  · 离线动作本地队列              ▼
  · 联网按因果序补传         [history:7102]   事件日志(权威) + 分支 + 检查点
                                 ▲  拉取事件
                                 │
                             [replay:7103]    因果折叠 → 库存/床位/运输/预警/队伍投影
                                 ▲
                     gateway 读取当前态势、seek、diff、compare
```

## 快速开始

```bash
# 一键拉起四个服务（supervisor 同时管生命周期）
npm run services
# 或开发脚本（可自定义端口/数据目录/令牌）
npm run services:up
npm run services:down

# 健康检查
curl localhost:7100/healthz
```

### 一次完整推演

```bash
# 1) 建推演（拿到 clientId）
curl -X POST localhost:7100/sims -H 'content-type: application/json' \
  -d '{"id":"sim-1","scenarioId":"s1","clientId":"cmdr-1"}'

# 2) 下业务命令（网关翻译为领域事件 → 采集 → 历史）
curl -X POST localhost:7100/sims/sim-1/commands/dispatchResource \
  -H 'content-type: application/json' \
  -d '{"clientId":"cmdr-1","baseId":"rb-2","eventId":"ev-001","type":"food","qty":100}'

# 3) 读当前态势（库存/床位/派发/批次/阻断/工单由事件因果重建）
curl 'localhost:7100/sims/sim-1/state?branch=main'

# 4) 多人分叉：另一指挥员从主干末端分叉独立推演
curl -X POST localhost:7100/sims/sim-1/fork -H 'content-type: application/json' \
  -d '{"clientId":"cmdr-2","name":"B方案"}'
# 之后命令带 "branchId":"<返回的 branch.id>" 即写入该分支，主干不受影响

# 5) 双分支末端对照
curl 'localhost:7100/sims/sim-1/compare?a=main&b=<branchId>'

# 6) 断线续演：用同一 clientId 恢复，带回末端态势
curl -X POST localhost:7100/sims/sim-1/resume -H 'content-type: application/json' \
  -d '{"clientId":"cmdr-2","branchId":"<branchId>"}'
```

## 关键设计

### 事件模型与因果序
- 信封：`{id, simId, branchId, type, payload, at, day, hlc, after[], clientId, ts, seq}`。
- **HLC（混合逻辑时钟）**：`物理毫秒-逻辑计数`，各采集节点本地生成、跨节点接收时单调推进，
  无依赖并发事件按 HLC 得到确定全局序（解决事件乱序）。
- **`after[]` 显式因果**：子事件声明父事件 id（如"签收 after 派发"、"路线重排 after 阻断清除"），
  历史服务用 Kahn 拓扑 + HLC 稳定排序，**即便子事件先到也会被排到父之后**。
- **幂等**：同 `id` 事件重复投递（客户端重试/崩溃重放）只生效一次。

### 状态 = fold(events)
`domain/reducer.js` 是纯函数：`state = fold(events)`。库存、床位、运输（派发四本账、
转移批次、道路阻断、抢修工单）全部由事件序列折叠重建；任意节点 seek = 折叠到该 seq。
- 乐观因果冲突（并发超扣库存/床位、状态机非法跳转）不抛异常、不改状态，
  追加到 `state.conflicts`——并发写入后最终状态仍守恒（库存绝不为负）。
- 每分支串行归并 + 全量重写日志，得到确定全序；检查点存投影偏移，崩溃后从偏移续算。

### 多人并行与分支隔离
- `fork` = copy-on-write 复制父分支 `[0..forkSeq]` 事件到独立日志，之后两分支各自追加。
- 各分支独立维护库存/床位/派发/批次/阻断/工单（不同事件日志，天然隔离、互不污染）。
- 支持多层分叉、兄弟分支并存、双分支末端逐维度对照。

### 故障恢复
- **历史服务**：每分支追加 JSONL 日志（fsync），崩溃重放时截断尾部半行；
  周期性/手动检查点（`cp-<branch>.json`）记录投影状态 + 已应用偏移，重启从检查点续算。
- **采集服务**：`wal.jsonl` 先落 `pending` 再投递，历史 ACK 后记 `ack`；
  历史不可达时留在 WAL 并重试，采集进程崩溃重启后重放未确认事件，**不丢事件**。
- 下游启动顺序解耦：采集/网关都带就绪等待与重连。

### 移动端现场协同闭环（离线 → 因果补传 → 冲突处理 → 回写）

- **离线接收预警**：`GET /sims/:simId/field/bundle` 给出离线包——生效预警（含每角色签收状态与
  本队待签收角色）、在途签收单（四本账余量）、抢修工单、生效阻断与灾情事件；移动端断网前缓存，
  断网期间照常查看。预警发布/升级/撤销/解除（`warning.*` 事件）回写事件时间线与严重等级：
  生效预警抬升事件等级，终态后按剩余生效预警回落原级。
- **离线动作队列**：现场每个动作（预警签收 / 位置 / 道路变化 / 物资签收 / 抢修接单·进度·延期·完工）
  在端上生成稳定 `clientActionId` + 客户端 **HLC** 先落本地队列；现场服务也有一份 JSONL outbox
  （`FieldOutbox`），崩溃重启从流水重建，未确认动作不丢。
- **联网因果补传**：`POST /sims/:simId/field/actions` 按 HLC 顺序逐条应用——每条动作读取最新投影、
  经命令工厂快速失败校验，复合事件（道路封闭→自动绕行）用 `after` 串链；同批动作互不阻塞，
  逐条回执 `{ok, applied, msg, advisory}`。事件 id 由 `clientActionId#i` 确定性派生，
  弱网重试/崩溃重放经历史服务幂等去重，只生效一次。
- **冲突处理**：前置不满足（重复签收 / 超签 / 进度回退 / 非法状态跳转）快速失败；并发竞态由
  reducer 记冲突账且不改状态（库存绝不为负）；冲突动作落 `conflict` 状态、原因透传，现场可
  原样重提或丢弃，后续动作不受影响。
- **回写五个面**：预警（签收/升级重签/终态）、路线（现场封闭自动评估在途任务并联合绕行，
  无路可绕出 advisory 交指挥员；现场报告恢复则阻断清除、绕行在剩余生效阻断视角下回直/重排）、
  库存（物资签收四本账、抢修按实际消耗结算归还）、工单（接单/进度/完工/验收联动解封）、
  回放分支（现场动作逐帧入时间轴，可 seek 精确还原，可分叉独立推演）。
- **移动端页面**：`npm run dev` 后访问 `http://localhost:5173/mobile.html`（经 Vite 代理访问网关；
  现场同步服务 :7104 提供等价的 outbox/sync/bundle HTTP 门户）。

### 旧快照迁移
`POST /sims/migrate-snapshot`（回放服务）把前端 v1 单线 `frames`（含 `{cmd,tr,rb,ro}`
全量快照）转换为一串有序 `state.snapshot` 事件（用 `after` 串链保持旧时间轴顺序），
落到新推演主干后即可正常回放、分叉与续写；reducer 自动补全缺失的闭环/补给账目字段。

### 真实调度隔离
- 真实流保留 simId `live`，**不出现在推演列表**、**禁止分叉**。
- 推演命令通道写 `live` 一律 403；网关在历史服务两层都做带外令牌（`X-Live-Token`）校验。
- 未配置 `LIVE_WRITE_TOKEN` 时真实流为只读安全模式。演练分支与真实流是不同的事件日志，物理隔离。

## 目录

```
services/
├── lib/            配置 / 零依赖 HTTP 框架与客户端 / JSONL 日志·检查点 / HLC·因果排序 / 几何 / 现场离线队列
├── domain/         constants(常量) reducer(纯函数折叠) projection(回放/diff/对照)
│                   commands(命令→事件 + 现场动作 + 阻断评估/绕行/续派编排) seed(场景)
├── store/          BranchStore（分支事件日志 + fork + 检查点 + 恢复）
├── servers/        五个可独立启动的服务进程 + start-all 监管
├── dev-up.sh / dev-down.sh
└── test/           integration.test.mjs(92 项真实 HTTP) domain.test.mjs(36 项纯领域)
                    field.test.mjs(71 项现场协同闭环真实 HTTP)
```

## 测试

```bash
npm run test:domain     # 36 项：纯函数因果/守恒/几何/迁移/投影，不启服务、秒级
npm run test:services   # 92 项：四（五）服务真实 HTTP，覆盖下列全部能力
npm run test:field      # 71 项：现场协同闭环（离线包/离线队列/因果补传/冲突/道路联动/
                        #         抢修/预警回写/幂等重放/队列崩溃恢复/回放分叉）
```

集成测试覆盖：命令→事件→投影因果重建、派发四本账守恒、床位/车辆守恒、
阻断联合绕行/恢复回直、抢修结算幂等、多人分叉隔离、双分支对照、断线续演+长轮询、
HLC 乱序重排、after 因果、幂等去重、并发超扣冲突守恒、**历史/采集进程崩溃重启恢复**、
旧快照迁移、真实调度令牌隔离。

现场协同测试覆盖：离线包预警接收与待签收角色、离线动作入队不提前生效、联网按 HLC 因果序补传、
逐条回执（重复签收/超量/进度回退/非法工单互不阻塞）、道路封闭自动绕行与恢复回直、
抢修接单/进度/完工/验收/按实消耗回库、预警升级清空签收与撤销回落事件等级、
弱网同动作重放幂等、现场服务崩溃后队列从流水恢复、现场动作入回放帧/seek/分叉隔离。
