// 移动端现场协同闭环 · 五服务真实 HTTP 集成测试
// 覆盖：离线接收预警（离线包）、离线动作本地入队、联网按因果顺序补传、
//       位置轨迹、道路变化（封闭→自动绕行 / 恢复→回直）、物资签收、抢修进度、
//       预警签收/升级重签/撤销回写事件等级、冲突处理（重复签收/超量/非法跳转）、
//       补传幂等（稳定 clientActionId 重放不重复生效）、现场服务崩溃队列恢复、回放分叉
import {
  startAll, stopAll, waitAll, sleep, call, GW, POST, FLD,
  TPORTS, restartService, cleanupData, stopService, startService, waitHealthy
} from './helpers.js'

let failed = 0
let passed = 0
const assert = (cond, msg) => {
  if (cond) { passed++; console.log('  ✓', msg) }
  else { failed++; console.error('  ✗ FAIL:', msg) }
}
const assertEq = (a, b, msg) => assert(a === b, `${msg}（期望 ${b}，实际 ${a}）`)
const j = (r) => r.body

async function stateOf(simId, branchId = 'main') {
  const r = await GW(`/sims/${simId}/state?branch=${branchId}`)
  if (r.status !== 200) throw new Error('state fetch failed ' + r.status)
  return r.body.state
}
const stock = (st, baseId, type) => st.bases.find((b) => b.id === baseId).stock[type]

// 构造确定 HLC（毫秒-计数），模拟现场设备离线时钟
function hlc(ts, l = 0) { return ts.toString(16).padStart(12, '0') + '-' + l.toString(16).padStart(6, '0') }

async function main() {
  cleanupData()
  startAll()
  await waitAll()
  console.log('— 五个服务（含现场同步 :8104）已就绪 —')
  for (const [n, p] of Object.entries(TPORTS)) {
    const r = await call('GET', p, '/healthz')
    assertEq(r.status, 200, `${n} (:${p}) 健康`)
  }

  const SIM = 'sim-field'
  const TEAM = 'team-1'
  let r = await POST('/sims', { id: SIM, name: '现场协同推演', scenarioId: 's1', clientId: 'cmdr' })
  assertEq(r.status, 200, '创建推演')
  let st = await stateOf(SIM)
  const food0 = stock(st, 'rb-2', 'food')

  /* ============ 1. 离线包：预警离线接收 ============ */
  console.log('\n— 1. 预警发布 → 现场离线包可接收（含待签收角色） —')
  r = await POST(`/sims/${SIM}/commands/issueWarning`, {
    clientId: 'cmdr', warningId: 'w-1', title: '青川上游暴雨红色预警', level: 'red',
    source: 'rain-gauge-7', dedupeKey: 'rg7:red', eventId: 'ev-001',
    targets: ['duty', 'field', 'commander']
  })
  assertEq(r.status, 200, '发布红色预警')
  st = await stateOf(SIM)
  let w = st.warnings.find((x) => x.id === 'w-1')
  assert(!!w && w.status === 'active', '预警进入投影')
  // 事件等级回写：ev-001 本为 red；换橙色事件验证抬升（ev-003 见场景）
  const ev3 = st.events.find((e) => e.id === 'ev-003')
  r = await POST(`/sims/${SIM}/commands/issueWarning`, {
    clientId: 'cmdr', warningId: 'w-2', title: '安置点边坡位移橙色预警', level: 'orange',
    source: 'slope-2', dedupeKey: 'sl2:orange', eventId: ev3?.id, targets: ['field']
  })
  if (ev3 && r.status === 200) {
    st = await stateOf(SIM)
    const e3 = st.events.find((e) => e.id === ev3.id)
    assert(e3.severity === 'orange' || SEV(e3.severity) <= SEV('orange'), '生效预警抬升关联事件等级')
  }
  // 同监测点重复发布被拦截
  r = await POST(`/sims/${SIM}/commands/issueWarning`, {
    clientId: 'cmdr', title: '重复', level: 'red', dedupeKey: 'rg7:red', targets: ['field']
  })
  assertEq(r.status, 409, '同监测点生效预警重复发布被快速失败')

  // 离线包（现场断网前最后一次同步的内容）
  r = await GW(`/sims/${SIM}/field/bundle?teamId=${TEAM}`)
  assertEq(r.status, 200, '现场离线包可拉取')
  const bw = j(r).bundle.warnings
  assert(bw.some((x) => x.id === 'w-1' && x.pendingRoles.includes('field')), '离线包含生效预警及待签收角色')
  assert(!!j(r).bundle.dispatches && !!j(r).bundle.orders, '离线包含在途任务视图')

  /* ============ 2. 离线动作入队（现场服务不可达也不丢） ============ */
  console.log('\n— 2. 现场离线：签收预警/位置等动作入队 —')
  // 先派一批物资，供后续离线签收
  r = await POST(`/sims/${SIM}/commands/dispatchResource`, {
    clientId: 'cmdr', baseId: 'rb-2', eventId: 'ev-001', type: 'food', qty: 100
  })
  assertEq(r.status, 200, '指挥员派发食品 100')
  st = await stateOf(SIM)
  const dpId = st.dispatches.find((d) => d.type === 'food' && d.baseId === 'rb-2').id

  // 停掉现场服务，动作改由"设备本地"暂存——这里直接打网关验证在线路径之外，
  // 用现场服务的 outbox 模拟：先停服务，启动后入队
  stopService('field'); await sleep(150)
  startService('field'); await waitHealthy(TPORTS.field)

  // 队伍注册 + 签收预警 + 位置 + 物资签收：全部先进现场队列（不立即要求网关可用语义，
  // 现场服务在线故 enqueue 仅入队；sync 时统一补传）
  const t0 = Date.now()
  const queueActions = [
    { clientActionId: 'offline-1', kind: 'registerTeam', teamId: TEAM, name: '青川抢修一队', capabilities: ['repair'], at: '09:00', hlc: hlc(t0 + 1000) },
    { clientActionId: 'offline-2', kind: 'ackWarning', teamId: TEAM, warningId: 'w-1', role: 'field', by: '青川抢修一队', at: '09:05', hlc: hlc(t0 + 2000) },
    { clientActionId: 'offline-3', kind: 'reportPosition', teamId: TEAM, lng: 104.742, lat: 31.55, at: '09:10', hlc: hlc(t0 + 3000) },
    { clientActionId: 'offline-4', kind: 'reportPosition', teamId: TEAM, lng: 104.743, lat: 31.58, at: '09:20', hlc: hlc(t0 + 4000) },
    { clientActionId: 'offline-5', kind: 'signDispatch', teamId: TEAM, dispatchId: dpId, qty: 70, shortQty: 20, receiver: '李现场', at: '09:30', hlc: hlc(t0 + 5000) }
  ]
  r = await FLD('POST', `/sims/${SIM}/teams/${TEAM}/actions`, { actions: queueActions })
  assertEq(r.status, 200, '离线动作入队 5 条')
  assertEq(j(r).queued, 5, '队列待补传 5 条')
  // 此时尚未补传：预警签收/签收账目未变
  st = await stateOf(SIM)
  assert(!st.warnings.find((x) => x.id === 'w-1').acks.field, '补传前预警未签收')
  assert(!st.teams.find((x) => x.id === TEAM), '补传前队伍未登记')

  /* ============ 3. 联网补传：按因果顺序逐条应用 ============ */
  console.log('\n— 3. 联网补传：按 HLC 因果顺序，逐条回执 —')
  r = await FLD('POST', `/sims/${SIM}/teams/${TEAM}/sync`, {})
  assertEq(r.status, 200, '触发补传')
  assertEq(j(r).synced, 5, '5 条动作全部补传成功')
  assertEq(j(r).remaining, 0, '队列清空')
  st = await stateOf(SIM)
  w = st.warnings.find((x) => x.id === 'w-1')
  assert(!!w.acks.field && w.acks.field.by === '青川抢修一队', '预警现场角色签收回写')
  assert(w.status === 'active', '其余角色未签收时预警仍为 active（不提前转响应态）')
  const team = st.teams.find((x) => x.id === TEAM)
  assert(!!team && team.positions.length === 2, '队伍登记 + 位置轨迹 2 点')
  assertEq(team.position.lat, 31.58, '最新位置为后一帧（因果序：09:20 在 09:10 之后）')
  const dp = st.dispatches.find((d) => d.id === dpId)
  assertEq(dp.signedQty, 70, '物资签收回写：实收 70')
  assertEq(dp.shortQty, 20, '短缺认定 20')
  assertEq(dp.status, 'enroute', '70+20=90 < 100，余量 10 仍在途（不办结）')

  /* ============ 4. 冲突处理：非法/重复/超量动作不阻塞队列 ============ */
  console.log('\n— 4. 冲突：重复签收、超量签收、非法工单跳转各自回执 —')
  const conflictActions = [
    // 已签收角色重复签
    { clientActionId: 'c-1', kind: 'ackWarning', teamId: TEAM, warningId: 'w-1', role: 'field', by: '张现场', at: '10:00', hlc: hlc(t0 + 6000) },
    // 超量：该单仅剩 10
    { clientActionId: 'c-2', kind: 'signDispatch', teamId: TEAM, dispatchId: dpId, qty: 50, at: '10:05', hlc: hlc(t0 + 7000) },
    // 不存在的工单接单
    { clientActionId: 'c-3', kind: 'reportRepair', teamId: TEAM, orderId: 'nope', stage: 'accept', at: '10:10', hlc: hlc(t0 + 8000) }
  ]
  r = await call('POST', TPORTS.gateway, `/sims/${SIM}/field/actions?branch=main`, {
    clientId: TEAM, actions: conflictActions
  })
  assertEq(r.status, 200, '冲突批次仍整体受理（逐条回执）')
  const results = j(r).results
  assertEq(results.length, 3, '3 条逐条回执')
  assert(results.every((x) => x.ok === false), '三条全部业务拒绝')
  assert(results[2].msg, '冲突原因透传给现场')
  st = await stateOf(SIM)
  assertEq(st.warnings.find((x) => x.id === 'w-1').acks.field.by, '青川抢修一队', '重复签收不覆盖原签收人')
  assertEq(st.dispatches.find((d) => d.id === dpId).signedQty, 70, '超量签收不改账（库存/四本账守恒）')

  /* ============ 5. 道路变化：现场封闭 → 自动绕行；恢复 → 回直 ============ */
  console.log('\n— 5. 现场上报道路封闭：自动评估并绕行在途任务 —')
  // 新派一单（走 rb-2 → ev-001 的近直线走廊），供阻断命中
  r = await POST(`/sims/${SIM}/commands/dispatchResource`, {
    clientId: 'cmdr', baseId: 'rb-2', eventId: 'ev-001', type: 'water', qty: 60
  })
  assertEq(r.status, 200, '派发饮用水 60')
  st = await stateOf(SIM)
  const waterDp = st.dispatches.find((d) => d.type === 'water')
  const viaBefore = (waterDp.via || []).length
  // 走廊在 lng≈104.742，纬度 31.46→31.78 之间；于 31.60~31.64 横切
  const poly = [[104.70, 31.64], [104.78, 31.64], [104.78, 31.60], [104.70, 31.60]]
  r = await call('POST', TPORTS.gateway, `/sims/${SIM}/field/actions?branch=main`, {
    clientId: TEAM,
    actions: [{
      clientActionId: 'road-1', kind: 'reportRoad', teamId: TEAM, roadKind: 'closed',
      name: '青竹路塌方段', reason: '山体塌方', by: '青川抢修一队',
      polygon: poly, at: '10:20', hlc: hlc(t0 + 9000)
    }]
  })
  assertEq(r.status, 200, '现场封闭上报受理')
  const roadRes = j(r).results[0]
  assert(roadRes.ok && roadRes.applied, '封闭上报应用成功')
  st = await stateOf(SIM)
  const blk = st.blocks.find((b) => b.name === '青竹路塌方段')
  assert(!!blk && blk.status === 'active' && blk.source === 'field', '阻断来自现场上报并生效')
  const waterAfter = st.dispatches.find((d) => d.id === waterDp.id)
  assert((waterAfter.via || []).length > viaBefore, '在途物资路线自动绕行（回写路线）')

  // 现场报告恢复通行 → 阻断清除 + 绕行回直
  r = await call('POST', TPORTS.gateway, `/sims/${SIM}/field/actions?branch=main`, {
    clientId: TEAM,
    actions: [{
      clientActionId: 'road-2', kind: 'reportRoad', teamId: TEAM, roadKind: 'reopened',
      blockId: blk.id, by: '青川抢修一队', at: '11:40', hlc: hlc(t0 + 10000)
    }]
  })
  assertEq(j(r).results[0].ok, true, '恢复通行上报受理')
  st = await stateOf(SIM)
  assertEq(st.blocks.find((b) => b.id === blk.id).status, 'cleared', '阻断已清除')
  assertEq((st.dispatches.find((d) => d.id === waterDp.id).via || []).length, 0, '路线在剩余阻断视角下回直')

  /* ============ 6. 抢修工单：接单/进度/完工现场闭环 ============ */
  console.log('\n— 6. 现场上报道路封闭 → 派抢修单 → 现场接单/进度/完工验收 —')
  r = await call('POST', TPORTS.gateway, `/sims/${SIM}/field/actions?branch=main`, {
    clientId: TEAM,
    actions: [{
      clientActionId: 'road-3', kind: 'reportRoad', teamId: TEAM, roadKind: 'closed',
      name: '擂鼓镇便道冲毁', polygon: [[104.90, 31.55], [104.99, 31.55], [104.99, 31.48], [104.90, 31.48]],
      by: '青川抢修一队', at: '12:00', hlc: hlc(t0 + 11000)
    }]
  })
  st = await stateOf(SIM)
  const blk2 = st.blocks.find((b) => b.name === '擂鼓镇便道冲毁')
  r = await POST(`/sims/${SIM}/commands/createOrder`, {
    clientId: 'cmdr', blockId: blk2.id, baseId: 'rb-5', personnel: 8, vehicles: 2,
    materials: [{ type: 'water', qty: 10 }], deadline: '16:00'
  })
  assertEq(r.status, 200, '指挥员对现场阻断派抢修单')
  st = await stateOf(SIM)
  const order = st.orders.find((o) => o.blockId === blk2.id)
  const persAfterDispatch = stock(st, 'rb-5', 'personnel')

  r = await call('POST', TPORTS.gateway, `/sims/${SIM}/field/actions?branch=main`, {
    clientId: TEAM,
    actions: [
      { clientActionId: 'rp-1', kind: 'reportRepair', teamId: TEAM, orderId: order.id, stage: 'accept', at: '12:20', hlc: hlc(t0 + 12000) },
      { clientActionId: 'rp-2', kind: 'reportRepair', teamId: TEAM, orderId: order.id, stage: 'progress', progress: 40, at: '13:10', hlc: hlc(t0 + 13000) },
      { clientActionId: 'rp-2b', kind: 'reportRepair', teamId: TEAM, orderId: order.id, stage: 'finish', used: { personnel: 6, vehicles: 2 }, at: '13:15', hlc: hlc(t0 + 13500) },
      { clientActionId: 'rp-3', kind: 'reportRepair', teamId: TEAM, orderId: order.id, stage: 'progress', progress: 30, at: '13:20', hlc: hlc(t0 + 14000) },
      { clientActionId: 'rp-4', kind: 'reportRepair', teamId: TEAM, orderId: order.id, stage: 'progress', progress: 100, at: '14:30', hlc: hlc(t0 + 15000) },
      { clientActionId: 'rp-5', kind: 'reportRepair', teamId: TEAM, orderId: order.id, stage: 'finish', used: { personnel: 6, vehicles: 2 }, at: '14:35', hlc: hlc(t0 + 16000) }
    ]
  })
  const rr = j(r).results
  assert(rr[0].applied && rr[1].applied, '接单 + 进度 40% 生效')
  assert(rr[2].ok === false, '进度 40% 时提前完工被前置校验拒绝，不阻塞后续动作')
  assert(rr[3].ok === false, '进度回退（40→30）被前置校验拒绝（快速失败），不阻塞后续动作')
  assert(rr[4].applied && rr[5].applied, '进度 100% 与完工继续生效')
  st = await stateOf(SIM)
  let o2 = st.orders.find((x) => x.id === order.id)
  assertEq(o2.progress, 100, '最终进度 100（回退帧被丢弃）')
  assertEq(o2.status, 'done', '完工进入待验收，阻断仍封闭')
  assertEq(o2.doneAt, '14:35', '完工时间取自 100% 后的合法完工帧（提前完工帧未生效）')
  assertEq(st.blocks.find((b) => b.id === blk2.id).status, 'active', '完工未验收前道路保持封闭')
  // 指挥员验收 → 解除封闭 + 剩余资源归还（实际用人 6/8）
  r = await POST(`/sims/${SIM}/commands/acceptWork`, { clientId: 'cmdr', orderId: order.id, at: '15:00' })
  assertEq(r.status, 200, '验收通过')
  st = await stateOf(SIM)
  assertEq(st.blocks.find((b) => b.id === blk2.id).status, 'cleared', '验收联动解除封闭')
  assertEq(stock(st, 'rb-5', 'personnel'), persAfterDispatch + 2, '实际消耗 6 人，剩余 2 人回库')

  /* ============ 7. 预警升级重签 + 撤销回写 ============ */
  console.log('\n— 7. 预警升级后原签收失效需重签；撤销回落事件等级 —')
  r = await POST(`/sims/${SIM}/commands/upgradeWarning`, {
    clientId: 'cmdr', warningId: 'w-1', level: 'red'
  })
  // 同级升级非法
  assert(r.status === 409, '同级升级被拒')
  // w-2: orange → red
  r = await POST(`/sims/${SIM}/commands/upgradeWarning`, {
    clientId: 'cmdr', warningId: 'w-2', level: 'red', targets: ['commander']
  })
  assertEq(r.status, 200, 'w-2 橙色升级红色并补发指挥长角色')
  st = await stateOf(SIM)
  w = st.warnings.find((x) => x.id === 'w-2')
  assertEq(Object.keys(w.acks).length, 0, '升级清空签收，需要重新签收')
  assert(w.targets.includes('field') && w.targets.includes('commander'), '升级补发角色与原角色并存')
  // 撤销预警后事件等级回落
  if (ev3) {
    r = await POST(`/sims/${SIM}/commands/revokeWarning`, {
      clientId: 'cmdr', warningId: 'w-2', reason: '监测设备误报'
    })
    assertEq(r.status, 200, '预警撤销留痕')
    st = await stateOf(SIM)
    const e3 = st.events.find((e) => e.id === ev3.id)
    assert(e3.severity === e3.baseSeverity, '无剩余生效预警时事件等级回落原级')
  }

  /* ============ 8. 补传幂等：同 clientActionId 重放不重复生效 ============ */
  console.log('\n— 8. 弱网重试：同一动作重复补传幂等 —')
  const signedBefore = (await stateOf(SIM)).dispatches.find((d) => d.id === dpId).signedQty
  r = await call('POST', TPORTS.gateway, `/sims/${SIM}/field/actions?branch=main`, {
    clientId: TEAM,
    actions: [{ clientActionId: 'offline-5', kind: 'signDispatch', teamId: TEAM, dispatchId: dpId, qty: 70, shortQty: 20, receiver: '李现场', at: '09:30', hlc: hlc(t0 + 5000) }]
  })
  // 事件 id 确定性派生（offline-5#0）：历史服务去重；动作不再二次签收
  st = await stateOf(SIM)
  assertEq(st.dispatches.find((d) => d.id === dpId).signedQty, signedBefore, '重放同一动作幂等，账目不变')

  /* ============ 9. 现场服务崩溃：队列从流水恢复不丢动作 ============ */
  console.log('\n— 9. 现场服务崩溃重启：未补传动作从 JSONL 恢复 —')
  r = await FLD('POST', `/sims/${SIM}/teams/${TEAM}/actions`, {
    actions: [{ clientActionId: 'crash-1', kind: 'reportPosition', teamId: TEAM, lng: 104.8, lat: 31.7, at: '15:30', hlc: hlc(t0 + 17000) }]
  })
  assertEq(j(r).queued >= 1, true, '新动作入队待发')
  await restartService('field', 300)
  r = await FLD('GET', `/sims/${SIM}/teams/${TEAM}/outbox?status=queued`)
  assert(j(r).actions.some((a) => a.clientActionId === 'crash-1'), '崩溃重启后待发动作从流水恢复')
  r = await FLD('POST', `/sims/${SIM}/teams/${TEAM}/sync`, {})
  assertEq(j(r).synced, 1, '恢复后补传成功')
  st = await stateOf(SIM)
  assertEq(st.teams.find((x) => x.id === TEAM).position.lng, 104.8, '崩溃期间动作最终送达')

  /* ============ 10. 回放与分叉：现场动作入帧、seek 精确还原 ============ */
  console.log('\n— 10. 现场协同动作进入回放时间轴并可分叉 —')
  r = await GW(`/sims/${SIM}/timeline`)
  const titles = j(r).frames.map((f) => f.title)
  assert(titles.some((t) => t.includes('发布预警')), '预警发布入时间轴')
  assert(titles.some((t) => t.includes('现场道路变化')), '现场道路变化入时间轴')
  assert(titles.some((t) => t.includes('现场位置上报')), '位置上报入时间轴')
  // seek 到预警发布之前：无预警
  const warnFrame = j(r).frames.find((f) => f.title.includes('发布预警'))
  const past = j(await GW(`/sims/${SIM}/state?atSeq=${Math.max(0, warnFrame.seq - 1)}`)).state
  assert(!past.warnings.some((x) => x.id === 'w-1'), 'seek 到预警前一帧：预警不存在（事件溯源精确还原）')
  // 分叉：现场分支与主干独立
  r = await POST(`/sims/${SIM}/fork`, { clientId: TEAM, name: '现场B方案' })
  assertEq(r.status, 200, '从主干分叉现场推演分支')
  const br = j(r).branch.id
  const mainTeams = (await stateOf(SIM, 'main')).teams.length
  r = await call('POST', TPORTS.gateway, `/sims/${SIM}/field/actions?branch=${br}`, {
    clientId: 'team-2',
    actions: [{ clientActionId: 'br-1', kind: 'registerTeam', teamId: 'team-2', name: '第二梯队', at: '16:00', hlc: hlc(t0 + 18000) }]
  })
  assertEq(j(r).results[0].applied, true, '分叉分支上现场动作生效')
  st = await stateOf(SIM, br)
  assert(st.teams.some((x) => x.id === 'team-2'), '新分支含第二梯队')
  assertEq((await stateOf(SIM, 'main')).teams.length, mainTeams, '主干不受分支写入污染（回放分支隔离）')

  console.log(`\n结果：${passed} 通过，${failed} 失败`)
  stopAll()
  if (failed) process.exit(1)
}

function SEV(s) { return ['red', 'orange', 'yellow', 'blue'].indexOf(s) }

main().catch((e) => { console.error(e); stopAll(); process.exit(1) })
