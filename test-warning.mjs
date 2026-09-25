// 实时预警协同：气象/地质数据接入 → 阈值评估自动发布 → 多角色告警扇出
// → 角色确认/一键确认 → 升级补发 → 撤销/解除留痕 → 回写事件状态/调度/大屏 → 复盘集成
import { setActivePinia, createPinia } from 'pinia'
import { useCommandStore } from '@/store/command'
import { useTransferStore } from '@/store/transfer'
import { useRoadblockStore } from '@/store/roadblock'
import { useRepairStore } from '@/store/repair'
import { useWarningStore } from '@/store/warning'
import { useReplayStore, installReplayRecorder } from '@/store/replay'

setActivePinia(createPinia())
const cmd = useCommandStore()
const tr = useTransferStore()
const rb = useRoadblockStore()
const rp = useRepairStore()
const wn = useWarningStore()
const replay = useReplayStore()
cmd.loadScenario('s1')
tr.load()
rb.load()
rp.load()
wn.load()

let failed = 0
const assert = (cond, msg) => {
  if (!cond) { failed++; console.error('  ✗ FAIL:', msg) }
  else console.log('  ✓', msg)
}
const ev = (id) => cmd.events.find((e) => e.id === id)
const base = (id) => cmd.bases.find((b) => b.id === id)
const tl = (id) => ev(id).timeline.map((t) => t.text).join('\n')

console.log('— 场景载入：监测站接入，无预警 —')
assert(wn.feeds.length === 5, 's1 场景挂载 5 个监测站（气象+地质）')
assert(wn.feeds.find((f) => f.id === 'fd-001').station === '江油水文站', '监测站元数据就绪')
assert(wn.alerts.length === 0, '初始无预警单')
const s0 = wn.stats
assert(s0.active === 0 && s0.pending === 0 && s0.stations === 5 && s0.abnormal === 0, '大屏统计初始为零')

console.log('— 数据接入：注入超阈读数 → 自动发布 + 多角色扇出 + 事件回写 —')
assert(!wn.ingestReading('fd-x', 35).ok, '非法监测点注入被拒')
assert(!wn.ingestReading('fd-001', -5).ok, '负值读数被拒')
const ing = wn.ingestReading('fd-001', 35)
assert(ing.ok && ing.level === 'yellow', '雨量 35mm/h 越过黄色阈值')
assert(wn.alerts.length === 1, '自动发布一张预警单')
const a1 = wn.alerts[0]
assert(a1.level === 'yellow' && a1.status === 'issued' && a1.source === '监测自动', '黄色预警待确认')
assert(a1.notices.length === 3, '黄色预警扇出 3 个角色（值班长/调度员/现场队伍）')
assert(a1.notices.every((n) => !n.ackAt), '各角色均未签收')
assert(tl('ev-001').includes('预警发布'), '事件时间线已回写预警发布')
assert(ev('ev-001').severity === 'red', '黄色预警不降低红色事件等级')
assert(wn.stats.active === 1 && wn.stats.pending === 1 && wn.stats.abnormal === 1, '大屏统计：预警中1/待确认1/监测异常1')

console.log('— 幂等：同级读数不重复建单；恶化自动升级并补发角色 —')
wn.ingestReading('fd-001', 40)
assert(wn.alerts.length === 1, '同级读数不重复建单')
wn.ingestReading('fd-001', 55)
assert(wn.alerts.length === 1 && a1.level === 'orange', '持续恶化自动升级为橙色')
assert(a1.notices.length === 5, '升级补发通知（新增指挥长/专家组）')
assert(a1.status === 'issued', '升级后回到待确认（新增角色待签收）')
assert(tl('ev-001').includes('预警升级'), '事件时间线回写预警升级')

console.log('— 人工发布：事件等级联动抬升 + 防重复 —')
assert(!wn.issueAlert({ eventId: 'ev-x', level: 'yellow' }).ok, '非法事件发布被拒')
const m1 = wn.issueAlert({ eventId: 'ev-003', level: 'orange', reason: '专家会商研判' })
assert(m1.ok, '人工发布橙色预警')
assert(ev('ev-003').severity === 'orange', '事件等级联动抬升：黄 → 橙')
assert(tl('ev-003').includes('等级联动调整'), '事件时间线回写等级联动')
assert(!wn.issueAlert({ eventId: 'ev-003', level: 'orange' }).ok, '同事件同等级人工预警防重复')

console.log('— 多角色确认：逐角色签收 → 全员确认 → 事件状态回写 —')
const a2 = m1.alert
assert(!wn.confirmAlert(a2.id, { role: 'shelter' }).ok, '不在通知范围的角色被拒')
assert(wn.confirmAlert(a2.id, { role: 'duty', by: '值班员小王' }).ok, '值班长签收')
assert(a2.status === 'issued', '部分签收仍待确认')
assert(!wn.confirmAlert(a2.id, { role: 'duty' }).ok, '重复签收被拦截')
assert(wn.confirmAll(a2.id).ok, '一键全员确认')
assert(a2.status === 'confirmed' && a2.confirmedAt, '全员确认后转已确认')
assert(ev('ev-003').status === 'assessing', '事件状态回写：已上报 → 研判中')
assert(tl('ev-003').includes('全员确认'), '事件时间线回写全员确认')

console.log('— 升级红色：重新确认后自动联动调度（回写调度/事件状态） —')
const esc = wn.escalateAlert(a2.id, { reason: '余震频次上升' })
assert(esc.ok && a2.level === 'red', '人工升级为红色预警')
assert(a2.notices.length === 6, '红色预警扇出 6 个角色（含安置点联络员）')
assert(a2.status === 'issued', '升级后需重新确认')
assert(ev('ev-003').severity === 'red', '事件等级联动抬升至红色')
const stock0 = { food: base('rb-2').stock.food, water: base('rb-2').stock.water, tent: base('rb-2').stock.tent }
const dp0 = cmd.dispatches.length
wn.confirmAll(a2.id)
assert(a2.status === 'confirmed' && a2.suggestionApplied, '红色确认后自动执行调度建议')
const sent = cmd.dispatches.filter((d) => d.eventId === 'ev-003' && d.source === '预警联动')
assert(sent.length === 3 && cmd.dispatches.length === dp0 + 3, '自动联动出库 3 批（缺口前三类）')
assert(base('rb-2').stock.food === stock0.food - 800, '就近基地食品扣减 800')
assert(base('rb-2').stock.water === stock0.water - 500, '就近基地饮用水扣减 500')
assert(base('rb-2').stock.tent === stock0.tent - 300, '就近基地帐篷扣减 300')
assert(ev('ev-003').status === 'dispatching', '事件状态联动推进到处置中')
assert(!wn.escalateAlert(a2.id).ok, '已是最高等级不能再升级')

console.log('— 撤销：留痕 + 事件等级回落 + 已发物资保留 —')
const rv = wn.revokeAlert(a2.id, { reason: '复核为仪器误报' })
assert(rv.ok && a2.status === 'revoked' && a2.revokeReason === '复核为仪器误报', '红色预警撤销留痕')
assert(ev('ev-003').severity === 'yellow', '事件等级联动回落至基准（黄）')
assert(tl('ev-003').includes('预警撤销') && tl('ev-003').includes('等级联动回落'), '事件时间线回写撤销与回落')
assert(cmd.dispatches.filter((d) => d.eventId === 'ev-003').length === 3, '撤销不回收已发物资（留账）')
assert(!wn.revokeAlert(a2.id).ok, '重复撤销被拦截')
assert(!wn.confirmAlert(a2.id, { role: 'duty' }).ok, '已撤销不能再确认')
assert(!wn.escalateAlert(a2.id).ok, '已撤销不能再升级')
assert(!wn.applySuggestion(a2.id).ok, '已撤销不能联动调度')
assert(!wn.closeAlert(a2.id).ok, '已撤销不能再解除')

console.log('— 监测回落：自动解除 —')
wn.ingestReading('fd-003', 25)
const a3 = wn.alerts.find((a) => a.feedId === 'fd-003')
assert(a3 && a3.level === 'orange' && a3.status === 'issued', '风速超阈自动发布橙色预警')
wn.ingestReading('fd-003', 5)
assert(a3.status === 'closed', '读数回落自动解除预警')
assert(tl('ev-002').includes('预警解除'), '事件时间线回写预警解除')
assert(ev('ev-002').severity === 'orange', '解除后事件等级保持基准（橙）')
assert(!wn.closeAlert(a3.id).ok, '重复解除被拦截')
assert(!wn.revokeAlert(a3.id).ok, '已解除不能再撤销')

console.log('— 手动联动调度：建议执行幂等 —')
const m2 = wn.issueAlert({ eventId: 'ev-002', level: 'blue' }).alert
assert(m2.notices.length === 2, '蓝色预警仅扇出值班长/调度员')
wn.confirmAll(m2.id)
const dpBefore = cmd.dispatches.length
const st1 = { water: base('rb-1').stock.water, food: base('rb-1').stock.food, tent: base('rb-1').stock.tent }
const ap = wn.applySuggestion(m2.id)
assert(ap.ok && ap.sent.length === 3, '手动执行调度建议出库 3 批')
assert(cmd.dispatches.length === dpBefore + 3, '派发记录已生成（来源：预警联动）')
assert(base('rb-1').stock.water === st1.water - 1500, '饮用水扣减 1500')
assert(base('rb-1').stock.food === st1.food - 1500, '食品扣减 1500')
assert(base('rb-1').stock.tent === st1.tent - 600, '帐篷扣减 600')
assert(!wn.applySuggestion(m2.id).ok, '调度建议不能重复执行')
assert(wn.closeAlert(m2.id, { reason: '现场核实风险消除' }).ok, '人工解除预警')

console.log('— 大屏统计口径 —')
const st = wn.stats
assert(st.active === 1 && st.pending === 1, '仅剩 fd-001 橙色预警生效待确认')
assert(st.abnormal === 1, 'fd-001 读数仍超阈计入监测异常')
wn.revokeAlert(wn.alerts.find((a) => a.feedId === 'fd-001').id, { reason: '雨势减弱研判解除' })
assert(wn.stats.active === 0 && wn.stats.pending === 0, '全部预警终结后大屏归零')

console.log('— 监测模拟开关 —')
wn.startMonitor()
assert(wn.monitorOn === true, '监测模拟开启')
wn.stopMonitor()
assert(wn.monitorOn === false, '监测模拟停止')

console.log('— 复盘集成：预警动作录帧 + seek 还原 —')
cmd.loadScenario('s1')
tr.load(); rb.load(); rp.load(); wn.load()
installReplayRecorder()
replay.begin()
const w1 = wn.issueAlert({ eventId: 'ev-003', level: 'yellow', reason: '台网会商' }).alert
wn.confirmAll(w1.id)
const wFrames = replay.frames.filter((f) => f.category === 'warning')
assert(wFrames.length === 2, '预警动作沉淀 2 帧（发布/全员确认）')
assert(wFrames[0].title.includes('预警'), '帧标题描述预警动作')
replay.seek(0)
assert(wn.alerts.length === 0, 'seek 回基线：预警单还原为空')
replay.seek(replay.frames.length - 1)
assert(wn.alerts.length === 1 && wn.alerts[0].status === 'confirmed', 'seek 回最新：预警单与确认状态还原')
assert(replay.currentLogs.some((l) => l.source === 'warning'), '帧内预警日志已汇总')
replay.exitToLive()

console.log(failed ? `\n${failed} 项失败` : '\n全部通过')
process.exit(failed ? 1 : 0)
