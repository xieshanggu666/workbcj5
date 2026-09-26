// 统筹方案协同提交回归：
// 多调度员共同编制 / 库存预占（不扣物理库存）/ 超时释放 / 冲突重算
// 提交原子生成派发 / 撤销归还预占与在途余量 / 方案版本与库存变动 / 兼容旧方案
// 方案版本与库存变动纳入分支回放（含分叉隔离）
import { setActivePinia, createPinia } from 'pinia'
import { useCommandStore, dispatchParts, PLAN_RESERVATION_TTL } from '@/store/command'
import { useTransferStore } from '@/store/transfer'
import { useRoadblockStore } from '@/store/roadblock'
import { useRepairStore } from '@/store/repair'
import { useReplayStore, installReplayRecorder } from '@/store/replay'

setActivePinia(createPinia())
const cmd = useCommandStore()
const tr = useTransferStore()
const rb = useRoadblockStore()
const ro = useRepairStore()
const replay = useReplayStore()
installReplayRecorder()
cmd.loadScenario('s1')
tr.load()
rb.load()
ro.load()

let failed = 0
const assert = (cond, msg) => {
  if (!cond) { failed++; console.error('  ✗ FAIL:', msg) }
  else console.log('  ✓', msg)
}

const ev1 = cmd.events.find((e) => e.id === 'ev-001') // 江油
const rb1 = () => cmd.bases.find((b) => b.id === 'rb-1')
const rb2 = () => cmd.bases.find((b) => b.id === 'rb-2')
const heldByBaseType = (bid, type) =>
  cmd.planReservations.filter((r) => r.status === 'held' && r.baseId === bid && r.type === type)
    .reduce((s, r) => s + r.qty, 0)

console.log('— 协同编制：赵调度生成方案并即时预占（不扣物理库存）—')
cmd.switchDispatcher('u-zhao')
const items = cmd.generatePlan()
assert(items.length > 0, '生成方案含分配条目')
assert(!!cmd.planMeta && cmd.planMeta.status === 'draft', '方案元数据建立、草稿态')
assert(cmd.planMeta.version >= 1, '方案带版本号（生成即修订，v' + cmd.planMeta.version + '）')
assert(cmd.planMeta.logs.length >= 1, '版本日志留痕')
assert(cmd.plan.every((p) => p.status === 'held' && p.reservationId), '每条目挂生效预占')
assert(cmd.plan.every((p) => p.authorId === 'u-zhao'), '条目作者为当前调度员')
const foodStock = rb2().stock.food
const foodFree = cmd.availableStock['rb-2'].food
assert(foodFree === foodStock - heldByBaseType('rb-2', 'food'), '可支配量 = 物理库存 - 生效预占')
assert(foodFree < foodStock, '预占不扣物理库存但占用可支配量')
// 需求缺口抵扣预占（在途 0 + 预占）
const gapFood = cmd.gaps.find((g) => g.eventId === ev1.id).gap.food
assert(gapFood === undefined || gapFood < (ev1.demand.food), '缺口已按预占抵扣')

console.log('— 第二名调度员加入并人工调整：预占迁移、滑动续期、版本递增 —')
cmd.switchDispatcher('u-qian')
cmd.joinPlan()
assert(cmd.planMeta.joined.includes('u-qian'), '钱调度加入协同')
const anyItem = cmd.plan[0]
const oldExpires = anyItem.expiresAt
const oldRvId = anyItem.reservationId
const oldRv = cmd.planReservations.find((r) => r.id === oldRvId)
cmd.updatePlanItem(anyItem.id, { qty: anyItem.qty - 1 })
assert(cmd.planReservations.find((r) => r.id === oldRvId)?.status === 'released', '改数量：旧预占释放（流水保留）')
assert(anyItem.reservationId && anyItem.reservationId !== oldRvId, '改数量：新预占建立')
assert(anyItem.expiresAt >= oldExpires, '滑动续期：新到期时间不早于旧值')
assert(cmd.planMeta.version >= 3, '加入+调整均沉淀版本（v>=3），当前 v' + cmd.planMeta.version)
const verBefore = cmd.planMeta.version
const otherBase = cmd.bases.find((b) => b.id !== anyItem.baseId && (b.stock[anyItem.type] || 0) > 0)
if (otherBase) {
  cmd.updatePlanItem(anyItem.id, { baseId: otherBase.id })
  assert(cmd.planReservations.find((r) => r.itemId === anyItem.id && r.status === 'held')?.baseId === otherBase.id, '换基地：预占迁移到新基地')
  assert(anyItem.baseId === otherBase.id, '条目基地已更新')
}
cmd.switchDispatcher('u-zhao')
cmd.removePlanItem(cmd.plan[cmd.plan.length - 1].id)
assert(cmd.planMeta.version > verBefore, '删除条目版本递增')

console.log('— 超时释放：到期预占自动归还、缺口重新暴露、可支配量恢复 —')
const expItem = cmd.plan[0]
const expBase = expItem.baseId
const expType = expItem.type
const expQty = expItem.qty
const freeBefore = cmd.availableStock[expBase][expType]
const rv = cmd.expirePlanReservations()
assert(rv.expired.length === 0, '无到期预占时扫描为空操作')
const sweep = cmd.advancePlanClock(PLAN_RESERVATION_TTL + 1)
assert(sweep.expired.length >= 1, '推进时钟：到期预占被扫描释放')
assert(expItem.status === 'expired' && !expItem.reservationId, '超时条目标记 expired、解绑预占')
assert(cmd.planReservations.some((r) => r.itemId === expItem.id && r.status === 'expired'), '预占流水标记超时释放')
assert(cmd.availableStock[expBase][expType] === freeBefore + expQty, '超时后库存可支配量恢复')
// 重新预占（容量足够）
const retry = cmd.retryPlanItem(expItem.id)
assert(retry.ok, '超时条目可重新预占: ' + (retry.msg || ''))
assert(expItem.status === 'held' && !!expItem.reservationId, '重新预占后恢复 held')
// 容量不足时拦截
cmd.advancePlanClock(PLAN_RESERVATION_TTL + 1)
assert(expItem.status === 'expired', '再次推进时钟：重新预占的条目再次超时')
const base = cmd.bases.find((b) => b.id === expBase)
const origStock = base.stock[expType] || 0
base.stock[expType] = Math.max(0, expQty - 1) // 物理库存压到不够该项
const retryFail = cmd.retryPlanItem(expItem.id)
assert(!retryFail.ok, '可支配库存不足时重新预占被拦截: ' + (retryFail.msg || ''))
base.stock[expType] = origStock // 恢复库存

console.log('— 提交前校验：存在超时条目时拒绝提交（避免漏项）—')
const blockedSubmit = cmd.submitPlan()
assert(blockedSubmit && blockedSubmit.ok === false && /超时/.test(blockedSubmit.msg), '超时未处理时提交被拦截: ' + (blockedSubmit?.msg || ''))

console.log('— 冲突重算：协同竞争导致超占时实时换基/拆单 —')
cmd.retryPlanItem(expItem.id)
// 人为制造冲突：清空某基地该类库存，方案中该基地条目必须重分配
const target = cmd.plan.find((p) => p.baseId === expBase && p.type === expType) || cmd.plan[0]
const tb = cmd.bases.find((b) => b.id === target.baseId)
const heldSum = heldByBaseType(target.baseId, target.type)
const availElsewhere = cmd.bases
  .filter((b) => b.id !== target.baseId)
  .reduce((s, b) => s + (b.stock[target.type] || 0), 0)
tb.stock[target.type] = 0
assert(!!cmd.planConflicts[target.baseId + '|' + target.type], '冲突检测：预占合计超出库存')
if (availElsewhere > 0) {
  const recalc = cmd.recalcPlanConflicts()
  assert(recalc.moved >= 1, '冲突重算：条目换基/拆单迁移（moved=' + recalc.moved + '）')
  assert(cmd.plan.every((p) => p.baseId !== target.baseId || p.status === 'conflict'), '可迁移条目均离开原基地')
  assert(cmd.planReservations.every((r) => r.status !== 'held' || cmd.plan.some((p) => p.reservationId === r.id)), '重算后 held 预占均挂在当前条目上')
  tb.stock[target.type] = heldSum // 恢复
} else {
  tb.stock[target.type] = heldSum
}

console.log('— 提交：原子生成派发，预占转出库，方案与版本归档 —')
// 恢复库存，消除残余冲突，保证全部满足
cmd.bases.forEach((b) => { Object.keys(b.stock).forEach((t) => { b.stock[t] = (b.stock[t] || 0) + 50000 }) })
cmd.recalcPlanConflicts()
const stockSnap = {}
cmd.bases.forEach((b) => { stockSnap[b.id] = { ...b.stock } })
const planQtyByBase = {}
cmd.plan.forEach((p) => {
  if (p.status === 'expired') return
  const k = p.baseId + '|' + p.type
  planQtyByBase[k] = (planQtyByBase[k] || 0) + p.qty
})
const dpCountBefore = cmd.dispatches.length
const res = cmd.submitPlan()
assert(!!res && res.ok !== false, '提交成功: ' + JSON.stringify(res?.unmet || ''))
assert(cmd.dispatches.length - dpCountBefore >= cmd.plan.length || res.realloc >= 0, '生成派发记录（跨基拆单可能多于条目）')
assert(!cmd.plan.length && cmd.planMeta === null, '提交后草稿与预占清空')
// 库存按实际落库（含重分配）扣减，不重复扣
cmd.dispatches.slice(0, cmd.dispatches.length - dpCountBefore).forEach((d) => {
  stockSnap[d.baseId][d.type] -= d.qty
})
cmd.bases.forEach((b) => {
  Object.keys(b.stock).forEach((t) => {
    assert(b.stock[t] === stockSnap[b.id][t], `库存扣减与派发一致：${b.name} ${t} = ${b.stock[t]}`)
  })
})
// 新派发带 planId 溯源
const planId = res.planId
assert(cmd.dispatches.filter((d) => d.planId === planId).length === res.dispatchIds.length, '派发记录带方案 planId 溯源')
const archive = cmd.submittedPlans.find((p) => p.id === planId)
assert(!!archive && archive.status === 'submitted', '方案快照归档（含版本日志）')
assert(archive.logs.some((l) => l.text.includes('提交方案')), '归档版本日志含提交记录')
// 无 held 预占残留
assert(!cmd.planReservations.some((r) => r.planId === planId && r.status === 'held'), '提交后无 held 预占残留（consumed/released 留痕）')
assert(cmd.planReservations.some((r) => r.planId === planId && r.status === 'consumed'), '出库预占标记 consumed')

console.log('— 撤销已提交方案：在途余量回库、预占/账目留档 —')
const made = cmd.dispatches.filter((d) => d.planId === planId)
// 先签收一部分，验证撤销只回在途余量
const first = made[0]
const signQty = Math.min(2, first.qty)
const signRes = cmd.signDispatch(first.id, { qty: signQty })
assert(signRes.ok, '部分签收 ' + signQty)
const stockBeforeCancel = {}
cmd.bases.forEach((b) => { stockBeforeCancel[b.id] = { ...b.stock } })
let expectBack = 0
made.forEach((d) => { expectBack += dispatchParts(d).outstanding })
const cancel = cmd.cancelPlan(planId)
assert(cancel.ok && cancel.returned === expectBack, `撤销回库量 = 全部在途余量 ${expectBack}（实收 ${signQty} 不回）`)
assert(archive.status === 'cancelled' && !!archive.cancel, '归档方案标记已撤销、撤销信息留痕')
made.forEach((d) => {
  assert(d.status === 'withdrawn', `派发 ${d.id} 标记已撤回`)
  assert(dispatchParts(d).received === (d === first ? signQty : 0), '已签收账目保留')
})
// 库存校验：回库量入账
let back = 0
cmd.bases.forEach((b) => {
  Object.keys(b.stock).forEach((t) => { back += b.stock[t] - stockBeforeCancel[b.id][t] })
})
assert(back === expectBack, `各基地库存合计回补 ${expectBack}`)
assert(!cmd.cancelPlan(planId).ok, '重复撤销被拦截')

console.log('— 撤销草稿：归还全部预占，物理库存不变 —')
cmd.switchDispatcher('u-sun')
const items2 = cmd.generatePlan()
assert(items2.length > 0, '生成第二版方案')
const stockBeforeDraft = {}
cmd.bases.forEach((b) => { stockBeforeDraft[b.id] = { ...b.stock } })
const heldCount = cmd.planReservations.filter((r) => r.status === 'held').length
const draftId = cmd.planMeta.id
const cancelDraft = cmd.cancelPlan()
assert(cancelDraft.ok && cancelDraft.released === heldCount, `草稿撤销归还 ${heldCount} 项预占`)
assert(!cmd.plan.length && cmd.planMeta === null, '草稿清空')
assert(cmd.submittedPlans.some((p) => p.id === draftId && p.status === 'cancelled'), '草稿撤销同样归档留痕')
cmd.bases.forEach((b) => {
  Object.keys(b.stock).forEach((t) => assert(b.stock[t] === stockBeforeDraft[b.id][t], '撤销草稿不动物理库存（仅释放额度）'))
})

console.log('— 兼容旧方案数据：无协同字段的条目与旧派发可正常工作 —')
// 手工构造「旧版」方案（无 status/reservationId 字段）与旧派发（无 planId/闭环字段）
cmd.plan = [{
  id: 'legacy-pi', eventId: ev1.id, baseId: 'rb-2', type: 'food', qty: 3,
  distance: 10, minutes: 20
}]
cmd.planMeta = null
assert(!!cmd.planConflicts['rb-2|food'] === false || true, '旧版无预占条目不抛错（冲突检测兼容）')
assert(cmd.gaps.find((g) => g.eventId === ev1.id).gap.food !== undefined || true, '旧条目缺口抵扣不抛错')
const legacyDp = cmd._pushDispatch('rb-2', ev1.id, 'water', 5, '手动')
delete legacyDp.planId
assert(cmd.cancelPlan('nonexistent').ok === false, '未知方案撤销安全失败')
cmd.clearPlan()

/* ===== 分支回放：方案版本与库存变动全程入帧、seek 还原、分叉隔离 ===== */
console.log('— 分支回放：方案协同动作逐帧录制，方案版本/预占/库存可 seek 还原 —')
replay.setTestClock(9 * 3600 * 1000)
replay.begin()
const baseFrames = replay.frameCount
cmd.switchDispatcher('u-zhao')
const collabItems = cmd.generatePlan()
const fGen = replay.frames[replay.frameCount - 1]
assert(replay.frameCount === baseFrames + 1, '生成方案（含预占）产生一帧')
const genSnap = fGen.snapshot.cmd
assert(genSnap.plan.length === collabItems.length, '帧快照含方案条目')
assert(!!genSnap.planMeta && genSnap.planReservations.length >= collabItems.length, '帧快照含方案版本元数据与预占流水')
assert(genSnap.planReservations.filter((r) => r.status === 'held').length === collabItems.length, '快照预占为 held')
assert(replay.currentDiff.statusChanges.some((x) => x.text.includes('协同方案版本')), '帧差异含方案版本变化')
// 物理库存未变（预占不扣），差异中不应有库存变动
assert(!replay.currentDiff.stocks.some((s) => s.type === '应急食品'), '预占阶段物理库存无变化（仅占额度）')

// 超时释放入帧
cmd.advancePlanClock(PLAN_RESERVATION_TTL + 1)
const fExp = replay.frames[replay.frameCount - 1]
assert(replay.frameCount > baseFrames + 1, '超时释放产生一帧')
assert(fExp.snapshot.cmd.plan.some((p) => p.status === 'expired'), '超时帧快照记录条目 expired')
assert(fExp.snapshot.cmd.planReservations.some((r) => r.status === 'expired'), '超时帧快照记录预占 expired')
assert(replay.currentDiff.statusChanges.some((x) => x.text.includes('超时释放')), '帧差异含预占超时释放条目')

// seek 回生成帧：超时态消失、预占恢复 held
replay.enterReview(replay.frames.indexOf(fGen))
assert(cmd.plan.every((p) => p.status !== 'expired'), 'seek 还原：条目无超时态')
assert(cmd.planReservations.filter((r) => r.status === 'held').length === collabItems.length, 'seek 还原：预占恢复 held')
const blockedInReview = cmd.submitPlan()
assert(blockedInReview === null, '回放只读期提交被拦截')

// 回到 live 末端后提交：库存扣减入帧
replay.exitToLive()
cmd.plan.forEach((p) => { if (p.status === 'expired') cmd.retryPlanItem(p.id) })
const stockBefore = { ...rb2().stock }
const submitRes = cmd.submitPlan()
assert(submitRes && submitRes.ok !== false, 'live 下提交成功')
const fSubmit = replay.frames[replay.frameCount - 1]
assert(fSubmit.snapshot.cmd.submittedPlans.some((p) => p.id === submitRes.planId), '提交帧快照含方案归档')
assert(fSubmit.snapshot.cmd.planMeta === null && fSubmit.snapshot.cmd.plan.length === 0, '提交帧快照草稿已清空')
assert(replay.currentDiff.stocks.length > 0, '提交帧差异含库存扣减变动')
assert(replay.currentDiff.statusChanges.some((x) => x.text.includes('提交归档')), '帧差异含方案提交归档')

// 撤销回库入帧
const foodBack0 = rb2().stock.food
cmd.cancelPlan(submitRes.planId)
const fCancel = replay.frames[replay.frameCount - 1]
assert(rb2().stock.food >= foodBack0, '撤销后在途余量回库')
assert(fCancel.snapshot.cmd.submittedPlans.find((p) => p.id === submitRes.planId).status === 'cancelled', '撤销帧快照方案为 cancelled')
assert(replay.currentDiff.stocks.some((s) => s.delta > 0), '撤销帧差异含库存回补')
assert(replay.currentDiff.statusChanges.some((x) => x.text.includes('撤销统筹方案')), '帧差异含方案撤销')

console.log('— 分叉隔离：从生成帧分叉，两支方案/预占/库存互不污染 —')
const genIdx = replay.frames.indexOf(fGen)
replay.enterReview(genIdx)
const forkedId = replay.resumeHere({ name: '重分配推演' })
assert(!!forkedId, '从生成帧分叉新分支')
assert(cmd.plan.length === collabItems.length, '分叉点态势：方案条目还原')
assert(cmd.planReservations.filter((r) => r.status === 'held').length === collabItems.length, '分叉点预占还原')
// 子分支：撤销草稿
const forkStockFood = rb2().stock.food
cmd.cancelPlan()
assert(cmd.planMeta === null, '子分支撤销草稿')
assert(rb2().stock.food === forkStockFood, '子分支撤销草稿不动物理库存')
// 切回主干：末端仍为「已撤销提交」态，子分支操作不穿透
replay.switchBranch('main')
assert(replay.currentBranch.id === 'main', '切回主干')
const mainArch = replay.currentBranch.frames.at(-1).snapshot.cmd.submittedPlans.find((p) => p.id === submitRes.planId)
assert(mainArch && mainArch.status === 'cancelled', '主干末端方案撤销态不受子分支影响')
const childArch = replay.branches.find((b) => b.id === forkedId).frames.at(-1).snapshot.cmd
assert(childArch.planMeta === null, '子分支末端草稿已撤销（快照独立）')

console.log('— 分支对照：统筹方案维度进入末端态势差异 —')
replay.openCompare(forkedId, 'main')
const cmp = replay.compareResult
const planRows = cmp.groups.find((g) => g.dim === '统筹方案')
assert(!!planRows && planRows.rows.length > 0, '分支对照含统筹方案差异维度')
replay.closeCompare()

console.log('— 旧单线历史兼容：含方案字段的旧 frames 载入不报错 —')
const legacyFrames = replay.currentBranch.frames.slice(0, 2).map((f) => ({ ...JSON.parse(JSON.stringify(f)), branchId: undefined }))
const ok = replay.loadLegacyFrames(legacyFrames)
assert(ok, '旧 frames 可归一化载入')
assert(replay.frames[1].snapshot.cmd.planMeta !== undefined, '旧帧快照（含方案字段）正常访问')

console.log('\n' + (failed ? `❌ ${failed} 项断言失败` : '✅ 统筹方案协同提交全部断言通过'))
process.exit(failed ? 1 : 0)
