import { defineStore } from 'pinia'
import {
  SCENARIOS, RESOURCE_BASES, EVENT_TYPES, RESOURCE_TYPES, SEVERITY, EVENT_STATUS
} from '@/mock/data'
import { pathKm } from '@/utils/geo'
import { useRoadblockStore } from '@/store/roadblock'

// 新建派发后联动：让道路阻断模块即时复核（该 store 尚未注册时静默跳过）
function notifyDispatchChanged() {
  try {
    useRoadblockStore().assessActive()
  } catch { /* 道路阻断模块未初始化 */ }
}

// 灾情等级权重（统筹分配优先级：等级高者优先锁定库存）
const SEV_WEIGHT = { red: 4, orange: 3, yellow: 2, blue: 1 }

// 折线路径估算里程与时长（直线 x 路网系数，演示用）
export function pathMetrics(points) {
  const roadDist = Math.round(pathKm(points) * 1.25 * 10) / 10 // 路网折算
  const minutes = Math.round((roadDist / 55) * 60 + 8) // 55km/h 平均 + 装卸
  return { distance: roadDist, minutes }
}

// 派发记录的数量分账（兼容无闭环字段的旧记录：默认全部为在途）
//   received 实收 / shortage 认定短缺 / returned 退回入库 / withdrawn 撤回回库
//   outstanding 尚未闭环量 = qty - 四者（enroute 时即在途量，held 时为挂起待续派量）
//   撤回只把在途余量并入 withdrawn，已发生的实收/短缺/退回账目原样保留
export function dispatchParts(d) {
  const received = d.signedQty || 0
  const shortage = d.shortQty || 0
  const returned = d.returnedQty || 0
  const withdrawn = d.withdrawnQty || 0
  const outstanding = Math.max(0, (d.qty || 0) - received - shortage - returned - withdrawn)
  const inTransit = d.status === 'enroute' ? outstanding : 0
  const heldQty = d.status === 'held' ? outstanding : 0
  const resupplied = d.shortReplenished || 0
  return {
    received, shortage, returned, withdrawn, outstanding, inTransit, heldQty, resupplied,
    shortPending: Math.max(0, shortage - resupplied)
  }
}

// 两点直达估算（pathMetrics 的便捷封装）
export function roughPath(lng1, lat1, lng2, lat2) {
  return pathMetrics([[lng1, lat1], [lng2, lat2]])
}

let dpSeq = 0
let rvSeq = 0
let piSeq = 0
const nowStr = () => new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
const nowMs = () => Date.now()
const uid = (p) => p + '-' + Date.now().toString(36) + '-' + (++rvSeq).toString(36) + Math.random().toString(36).slice(2, 5)

// 预占有效期（演示口径 10 分钟）；每条预占独立计时，编辑/换基即续期（滑动超时）
export const PLAN_RESERVATION_TTL = 10 * 60 * 1000
// 超时扫描间隔（扫描动作在回放只读期自动跳过）
const SWEEP_INTERVAL = 5 * 1000
// 预置调度员（演示：多调度员协同编制，真实系统对接账号体系）
const PLAN_DISPATCHERS = [
  { id: 'u-zhao', name: '赵调度' },
  { id: 'u-qian', name: '钱调度' },
  { id: 'u-sun', name: '孙调度' }
]
let sweepTimer = null

export const useCommandStore = defineStore('command', {
  state: () => ({
    scenarioId: SCENARIOS[0].id,
    events: [],
    bases: [],
    // 派发记录与在途状态
    dispatches: [],
    // 多灾点统筹：未提交的跨基地分配方案 / 最近一次批量派发结果
    plan: [],
    planResult: null,
    // 协同编制：当前方案（planMeta）、预占流水（planReservations）、调度员（dispatchers）、已归档方案（submittedPlans）
    planMeta: null,
    planReservations: [],
    dispatchers: PLAN_DISPATCHERS.map((u) => ({ ...u })),
    currentDispatcherId: PLAN_DISPATCHERS[0].id,
    submittedPlans: [],
    // 测试用时钟（固定当前毫秒数），null 时用 Date.now()
    planClock: null,
    // 大屏统计
    selectedEventId: null,
    filter: { type: 'all', severity: 'all', status: 'all' },
    search: '',
    autoPlay: false,
    replayTimer: null
  }),

  getters: {
    scenario(state) {
      return SCENARIOS.find((s) => s.id === state.scenarioId)
    },
    filteredEvents(state) {
      let list = [...state.events]
      if (state.filter.type !== 'all') list = list.filter((e) => e.type === state.filter.type)
      if (state.filter.severity !== 'all') list = list.filter((e) => e.severity === state.filter.severity)
      if (state.filter.status !== 'all') list = list.filter((e) => e.status === state.filter.status)
      if (state.search) list = list.filter((e) => e.title.includes(state.search) || (e.location && e.location.name.includes(state.search)))
      return list
    },
    // 各事件在途保障量：eventId -> { type: qty }（实收 + 在途；挂起未出库/短缺/退回均不计）
    sentMap(state) {
      const m = {}
      state.dispatches.forEach((d) => {
        if (!d.eventId) return
        const p = dispatchParts(d)
        const cover = p.received + p.inTransit
        if (cover > 0) {
          m[d.eventId] = m[d.eventId] || {}
          m[d.eventId][d.type] = (m[d.eventId][d.type] || 0) + cover
        }
      })
      return m
    },
    // 各事件实际签收量：eventId -> { type: qty }（闭环核算的实收口径）
    receivedMap(state) {
      const m = {}
      state.dispatches.forEach((d) => {
        if (!d.eventId) return
        const received = d.signedQty || 0
        if (received > 0) {
          m[d.eventId] = m[d.eventId] || {}
          m[d.eventId][d.type] = (m[d.eventId][d.type] || 0) + received
        }
      })
      return m
    },
    // 各事件已认定但尚未补派的短缺量：eventId -> { type: qty }
    shortageMap(state) {
      const m = {}
      state.dispatches.forEach((d) => {
        if (!d.eventId) return
        const p = dispatchParts(d)
        if (p.shortPending > 0) {
          m[d.eventId] = m[d.eventId] || {}
          m[d.eventId][d.type] = (m[d.eventId][d.type] || 0) + p.shortPending
        }
      })
      return m
    },
    // 当前方案的生效预占（held）：超时释放 / 提交消费 / 撤销归还后的预占不再占用库存
    activeReservations(state) {
      return state.planReservations.filter((r) => r.status === 'held')
    },
    // 各基地各类型「物理库存 - 生效预占」后的可支配量（方案协同的真实可分配口径）
    availableStock(state) {
      const m = {}
      state.bases.forEach((b) => {
        m[b.id] = { ...b.stock }
      })
      state.planReservations.forEach((r) => {
        if (r.status !== 'held') return
        m[r.baseId] = m[r.baseId] || {}
        m[r.baseId][r.type] = Math.max(0, (m[r.baseId][r.type] || 0) - r.qty)
      })
      return m
    },
    // 各事件需求缺口：需求 - 在途 - 方案生效预占（超时释放的预占项不抵扣缺口）
    gaps(state) {
      const planned = {}
      state.plan.forEach((p) => {
        if (p.status === 'expired') return // 超时释放：库存回归，缺口重新暴露
        planned[p.eventId] = planned[p.eventId] || {}
        planned[p.eventId][p.type] = (planned[p.eventId][p.type] || 0) + p.qty
      })
      return state.events.map((ev) => {
        const gap = {}
        Object.entries(ev.demand || {}).forEach(([t, need]) => {
          const g = need - (this.sentMap[ev.id]?.[t] || 0) - (planned[ev.id]?.[t] || 0)
          if (g > 0) gap[t] = g
        })
        return { eventId: ev.id, gap }
      })
    },
    // 方案冲突检测：按 基地+类型 汇总「生效预占」，超出当前物理库存即冲突（提交时将触发重分配）
    planConflicts(state) {
      const use = {}
      state.plan.forEach((p) => {
        if (p.status === 'expired') return
        const k = p.baseId + '|' + p.type
        use[k] = (use[k] || 0) + p.qty
      })
      const conflicts = {}
      Object.entries(use).forEach(([k, qty]) => {
        const [baseId, type] = k.split('|')
        const base = state.bases.find((b) => b.id === baseId)
        const stock = base ? base.stock[type] || 0 : 0
        if (qty > stock) conflicts[k] = { planned: qty, stock }
      })
      return conflicts
    },
    // 大屏统计卡片
    stats(state) {
      const counts = { listed: state.events.length }
      SEVERITY.forEach((s) => {
        counts[s.value] = state.events.filter((e) => e.severity === s.value).length
      })
      counts.dispatching = state.events.filter((e) => e.status === 'dispatching').length
      counts.closed = state.events.filter((e) => e.status === 'closed').length
      counts.dispatchedToday = state.dispatches.length
      counts.signedToday = state.dispatches.reduce((n, d) => n + ((d.signLogs || []).length > 0 ? 1 : 0), 0)
      counts.shortagePending = state.dispatches.reduce((n, d) => n + (dispatchParts(d).shortPending > 0 ? 1 : 0), 0)
      const totalAffected = state.events.reduce((sum, e) => sum + (e.affected || 0), 0)
      return { ...counts, totalAffected }
    },
    typeLabels() {
      return EVENT_TYPES
    },
    currentDispatcher(state) {
      return state.dispatchers.find((u) => u.id === state.currentDispatcherId) || null
    }
  },

  actions: {
    loadScenario(id) {
      this.scenarioId = id
      const s = this.scenario
      this.events = s.events.map((e) => ({
        ...e,
        timeline: [
          { at: e.reportedAt, text: `事件上报：${e.title}` }
        ]
      }))
      this.bases = RESOURCE_BASES.map((b) => ({ ...b, stock: { ...b.stock } }))
      this.dispatches = []
      this.plan = []
      this.planResult = null
      this.planMeta = null
      this.planReservations = []
      this.submittedPlans = []
      this._stopPlanSweeper()
      this.selectedEventId = this.events[0] ? this.events[0].id : null
    },
    selectEvent(id) {
      this.selectedEventId = id
    },
    // 状态流转到下一步
    advanceStatus(eventId, toStatus) {
      const ev = this.events.find((e) => e.id === eventId)
      if (!ev) return
      const from = EVENT_STATUS.find((s) => s.value === ev.status)
      const to = EVENT_STATUS.find((s) => s.value === toStatus)
      ev.status = toStatus
      ev.timeline.push({ at: nowStr(), text: `状态变更：${from.label} → ${to.label}` })
    },
    // 内部：扣库存 + 生成派发记录 + 联动事件状态/时间线（库存需已校验）
    _pushDispatch(baseId, eventId, type, qty, source = '手动', planId = null) {
      const base = this.bases.find((b) => b.id === baseId)
      const ev = this.events.find((e) => e.id === eventId)
      if (!base || !ev || qty <= 0) return null
      base.stock[type] = (base.stock[type] || 0) - qty
      const path = roughPath(base.lng, base.lat, ev.location.lng, ev.location.lat)
      const record = {
        id: 'dp-' + Date.now() + '-' + ++dpSeq,
        baseId, baseName: base.name, eventId, eventTitle: ev.title,
        lng: ev.location.lng, lat: ev.location.lat,
        type, typeLabel: RESOURCE_TYPES[type].label, qty, unit: RESOURCE_TYPES[type].unit,
        distance: path.distance, minutes: path.minutes, at: nowStr(),
        color: EVENT_TYPES[ev.type].color, source,
        // 协同统筹：归属方案（撤销方案时按方案归还在途余量），旧派发无此字段
        planId,
        // 道路阻断处置：在途/挂起状态、绕行途经点、来源阻断
        status: 'enroute', via: [], detourBy: null, holdBy: null,
        // 派发闭环：分批签收 / 短缺补派 / 退回入库（在途 = qty - 实收 - 短缺 - 退回 - 撤回）
        signedQty: 0, shortQty: 0, shortReplenished: 0, returnedQty: 0, withdrawnQty: 0,
        signLogs: [], returnLogs: [], withdrawLogs: [], replenishOf: null
      }
      this.dispatches.unshift(record)
      ev.timeline.push({ at: record.at, text: `${source}派发 ${record.typeLabel} ${qty}${record.unit}👈${base.name}` })
      if (ev.status === 'assessing' || ev.status === 'reported') ev.status = 'dispatching'
      notifyDispatchChanged()
      return record
    },
    // 从资源库派发资源到受灾点
    dispatchResource({ baseId, eventId, type, qty }) {
      const base = this.bases.find((b) => b.id === baseId)
      if (!base) return null
      qty = Math.max(0, Math.min(qty, base.stock[type] || 0))
      if (qty === 0) return null
      return this._pushDispatch(baseId, eventId, type, qty, '手动')
    },
    // 向安置点补给物资（联动转移安置模块，不计入事件需求缺口）
    dispatchToShelter({ baseId, shelterId, shelterName, lng, lat, type, qty }) {
      const base = this.bases.find((b) => b.id === baseId)
      if (!base || qty <= 0) return null
      qty = Math.min(qty, base.stock[type] || 0)
      if (qty === 0) return null
      base.stock[type] = (base.stock[type] || 0) - qty
      const path = roughPath(base.lng, base.lat, lng, lat)
      const record = {
        id: 'dp-' + Date.now() + '-' + ++dpSeq,
        baseId, baseName: base.name, shelterId, shelterName,
        lng, lat,
        type, typeLabel: RESOURCE_TYPES[type].label, qty, unit: RESOURCE_TYPES[type].unit,
        distance: path.distance, minutes: path.minutes, at: nowStr(),
        color: '#26a69a', source: '安置补给',
        status: 'enroute', via: [], detourBy: null, holdBy: null,
        // 派发闭环字段（同事件派发）
        signedQty: 0, shortQty: 0, shortReplenished: 0, returnedQty: 0, withdrawnQty: 0,
        signLogs: [], returnLogs: [], withdrawLogs: [], replenishOf: null
      }
      this.dispatches.unshift(record)
      notifyDispatchChanged()
      return record
    },

    /* ---------- 派发闭环：分批签收 / 短缺认定补派 / 退回入库 ---------- */

    _destName(d) { return d.eventTitle || d.shelterName || '目的地' },
    _logDest(d, text) {
      const ev = this.events.find((e) => e.id === d.eventId)
      if (ev) ev.timeline.push({ at: nowStr(), text })
    },

    // 现场签收：支持分批；可同批认定短缺（在途剩余按 qty-实收-短缺 留账）
    // 幂等防护：已办结（在途+挂起余量为 0）记录、挂起中记录一律拒绝
    signDispatch(recordId, { qty, shortQty = 0, receiver = '' } = {}) {
      const rec = this.dispatches.find((d) => d.id === recordId)
      if (!rec) return { ok: false, msg: '派发记录不存在' }
      if (rec.status === 'held') return { ok: false, msg: '派发挂起中，待恢复通行续派后再签收' }
      if (rec.status === 'withdrawn') return { ok: false, msg: '该派发已撤回，剩余在途已回库，不能再签收' }
      if (rec.status === 'done') return { ok: false, msg: '该派发已办结，不能重复签收' }
      qty = Math.max(0, Math.round(qty || 0))
      shortQty = Math.max(0, Math.round(shortQty || 0))
      if (qty === 0 && shortQty === 0) return { ok: false, msg: '请填写本次签收或短缺数量' }
      const parts = dispatchParts(rec)
      if (qty + shortQty > parts.outstanding) {
        return { ok: false, msg: `本次签认数量超出在途余量 ${parts.outstanding}${rec.unit}，不能重复签收` }
      }
      const at = nowStr()
      if (qty > 0) {
        rec.signedQty = parts.received + qty
        if (!Array.isArray(rec.signLogs)) rec.signLogs = [] // 兼容无闭环字段的旧记录
        rec.signLogs.push({ at, qty, receiver: (receiver || '').trim() || '现场签收员' })
      }
      if (shortQty > 0) rec.shortQty = parts.shortage + shortQty
      const left = dispatchParts(rec).outstanding
      if (left === 0) {
        rec.status = 'done'
        rec.doneReason = rec.shortQty > 0 ? 'short' : 'signed'
      }
      this._logDest(rec, `📥 物资签收：${rec.typeLabel} ${qty}${rec.unit}（累计实收 ${rec.signedQty}/${rec.qty}${rec.unit}）`
        + (shortQty ? `，现场认定短缺 ${shortQty}${rec.unit}` : ''))
      // 道路阻断联动：全部签收后该任务自动退出影响评估，部分签收则刷新在途余量
      notifyDispatchChanged()
      return { ok: true, record: rec, received: rec.signedQty, shortage: rec.shortQty, outstanding: left }
    },

    // 短缺补派：按已认定尚未补派的短缺量就近重新出库（可跨基地拆单）
    // 防重复补派：仅按 短缺量 - 已补派量 补发
    replenishShortage(recordId, opts = {}) {
      const rec = this.dispatches.find((d) => d.id === recordId)
      if (!rec) return { ok: false, msg: '派发记录不存在' }
      if (rec.status === 'withdrawn') return { ok: false, msg: '该派发已撤回，剩余在途已回库，不能再补派' }
      const parts = dispatchParts(rec)
      let need = parts.shortPending
      if (opts.qty != null) need = Math.min(need, Math.max(0, Math.round(opts.qty)))
      if (need <= 0) return { ok: false, msg: '该派发无待补派的短缺量（短缺可能已补派）' }
      const source = rec.shelterId ? '补给补派' : '短缺补派'
      const sent = []
      // 候选基地按运输时长升序，库存不足时跨基地拆单
      const cands = this.bases
        .filter((b) => (b.stock[rec.type] || 0) > 0)
        .map((b) => ({ b, path: roughPath(b.lng, b.lat, rec.lng, rec.lat) }))
        .sort((x, y) => x.path.minutes - y.path.minutes)
      for (const c of cands) {
        if (need <= 0) break
        const take = Math.min(need, c.b.stock[rec.type])
        c.b.stock[rec.type] -= take
        need -= take
        const child = {
          id: 'dp-' + Date.now() + '-' + ++dpSeq,
          baseId: c.b.id, baseName: c.b.name,
          eventId: rec.eventId || null, eventTitle: rec.eventTitle || null,
          shelterId: rec.shelterId || null, shelterName: rec.shelterName || null,
          lng: rec.lng, lat: rec.lat,
          type: rec.type, typeLabel: rec.typeLabel, qty: take, unit: rec.unit,
          distance: c.path.distance, minutes: c.path.minutes, at: nowStr(),
          color: rec.color, source,
          status: 'enroute', via: [], detourBy: null, holdBy: null,
          signedQty: 0, shortQty: 0, shortReplenished: 0, returnedQty: 0, withdrawnQty: 0,
          signLogs: [], returnLogs: [], withdrawLogs: [], replenishOf: rec.id
        }
        this.dispatches.unshift(child)
        sent.push(child)
      }
      const made = sent.reduce((s, x) => s + x.qty, 0)
      if (made > 0) {
        rec.shortReplenished = parts.resupplied + made
        this._logDest(rec, `🔁 短缺补派：${rec.typeLabel} ${made}${rec.unit} 已重新出库（${sent.map((x) => x.baseName).join('、')}）`)
        notifyDispatchChanged()
      }
      return {
        ok: made > 0,
        sent,
        unmet: need,
        msg: made > 0
          ? `已补派 ${made}${rec.unit}` + (need > 0 ? `，库存不足仍缺 ${need}${rec.unit}` : '')
          : `各基地 ${rec.typeLabel} 库存不足，暂无法补派`
      }
    },

    // 退回入库：在途余量原路退回出库基地，库存回补、数量不再计入保障量
    // 幂等防护：已办结 / 挂起中 / 无在途余量的记录拒绝重复退回
    returnDispatch(recordId, { qty, reason = '' } = {}) {
      const rec = this.dispatches.find((d) => d.id === recordId)
      if (!rec) return { ok: false, msg: '派发记录不存在' }
      if (rec.status === 'held') return { ok: false, msg: '挂起中记录的物资已在库，无需退回' }
      if (rec.status === 'withdrawn') return { ok: false, msg: '该派发已撤回，在途余量已随撤回回库' }
      if (rec.status === 'done') return { ok: false, msg: '该派发已办结，不能重复退回' }
      const parts = dispatchParts(rec)
      qty = Math.max(0, Math.round(qty || 0))
      if (qty <= 0) return { ok: false, msg: '请填写退回数量' }
      if (qty > parts.outstanding) {
        return { ok: false, msg: `退回数量超出在途余量 ${parts.outstanding}${rec.unit}，不能重复回库` }
      }
      const base = this.bases.find((b) => b.id === rec.baseId)
      if (base) base.stock[rec.type] = (base.stock[rec.type] || 0) + qty
      rec.returnedQty = parts.returned + qty
      if (!Array.isArray(rec.returnLogs)) rec.returnLogs = [] // 兼容旧记录
      rec.returnLogs.push({ at: nowStr(), qty, reason: (reason || '').trim() || '现场退回' })
      const left = dispatchParts(rec).outstanding
      if (left === 0) {
        rec.status = 'done'
        rec.doneReason = 'returned'
      }
      this._logDest(rec, `↩️ 物资退回：${rec.typeLabel} ${qty}${rec.unit} 退回 ${rec.baseName}（累计退回 ${rec.returnedQty}/${rec.qty}${rec.unit}）`)
      // 道路阻断联动：余量清零后该任务不再构成在途影响
      notifyDispatchChanged()
      return { ok: true, record: rec, returned: rec.returnedQty, outstanding: left }
    },
    /* ---------- 道路阻断处置：改道 / 改派 / 挂起 / 续派 ---------- */

    // 绕行改道：写入途经点并重算里程与到达时间（地图路线联动更新；仅在途余量任务可改道）
    rerouteDispatch(id, via, blockId = null, silent = false) {
      const rec = this.dispatches.find((d) => d.id === id)
      if (!rec || rec.status !== 'enroute' || dispatchParts(rec).outstanding <= 0) return null
      const base = this.bases.find((b) => b.id === rec.baseId)
      if (!base) return null
      const m = pathMetrics([[base.lng, base.lat], ...via, [rec.lng, rec.lat]])
      rec.via = via
      rec.distance = m.distance
      rec.minutes = m.minutes
      rec.detourBy = blockId
      const ev = this.events.find((e) => e.id === rec.eventId)
      if (ev && !silent) ev.timeline.push({ at: nowStr(), text: `🔀 派发绕行改道：${rec.typeLabel} ${rec.qty}${rec.unit}，约 ${m.distance}km·${m.minutes}min` })
      return rec
    },
    // 改派出货基地：在途余量退回旧基地、新基地扣减，路线与 ETA 重算（已签收/短缺/退回部分不动）
    reassignDispatch(id, newBaseId) {
      const rec = this.dispatches.find((d) => d.id === id)
      const nb = this.bases.find((b) => b.id === newBaseId)
      if (!rec || !nb || rec.status !== 'enroute' || rec.baseId === newBaseId) return null
      const moveQty = dispatchParts(rec).outstanding
      if (moveQty <= 0) return null
      if ((nb.stock[rec.type] || 0) < moveQty) return null
      const ob = this.bases.find((b) => b.id === rec.baseId)
      if (ob) ob.stock[rec.type] = (ob.stock[rec.type] || 0) + moveQty
      nb.stock[rec.type] -= moveQty
      rec.baseId = nb.id
      rec.baseName = nb.name
      rec.via = []
      rec.detourBy = null
      const m = pathMetrics([[nb.lng, nb.lat], [rec.lng, rec.lat]])
      rec.distance = m.distance
      rec.minutes = m.minutes
      rec.source = '改派'
      const ev = this.events.find((e) => e.id === rec.eventId)
      if (ev) ev.timeline.push({ at: nowStr(), text: `🔀 派发改派：${rec.typeLabel} 在途 ${moveQty}${rec.unit} 改由 ${nb.name} 出库` })
      return rec
    },
    // 挂起：在途余量退回基地、不计入保障量，待恢复通行后续派（已签收/短缺部分不受影响）
    holdDispatch(id, blockId) {
      const rec = this.dispatches.find((d) => d.id === id)
      if (!rec || rec.status === 'held') return null
      const holdQty = dispatchParts(rec).outstanding
      if (holdQty <= 0) return null
      const base = this.bases.find((b) => b.id === rec.baseId)
      if (base) base.stock[rec.type] = (base.stock[rec.type] || 0) + holdQty
      rec.status = 'held'
      rec.holdBy = blockId
      rec.via = []
      rec.detourBy = null
      const ev = this.events.find((e) => e.id === rec.eventId)
      if (ev) ev.timeline.push({ at: nowStr(), text: `⏸ 派发挂起：${rec.typeLabel} 在途 ${holdQty}${rec.unit} 因道路阻断退回 ${rec.baseName}，待恢复通行后续派` })
      return rec
    },
    // 续派：按在途挂起余量复核库存后重新出库，重置路线与出发时间
    resumeDispatch(id) {
      const rec = this.dispatches.find((d) => d.id === id)
      if (!rec || rec.status !== 'held') return { ok: false, msg: '记录不存在或未挂起' }
      const qty = dispatchParts(rec).outstanding
      if (qty <= 0) return { ok: false, msg: '该派发已无待续派余量' }
      const base = this.bases.find((b) => b.id === rec.baseId)
      if (!base || (base.stock[rec.type] || 0) < qty) {
        return { ok: false, msg: `${base?.name || rec.baseName} 库存不足（需 ${qty}${rec.unit}），无法续派` }
      }
      base.stock[rec.type] -= qty
      rec.status = 'enroute'
      rec.holdBy = null
      rec.via = []
      rec.detourBy = null
      const m = pathMetrics([[base.lng, base.lat], [rec.lng, rec.lat]])
      rec.distance = m.distance
      rec.minutes = m.minutes
      rec.at = nowStr()
      const ev = this.events.find((e) => e.id === rec.eventId)
      if (ev) ev.timeline.push({ at: nowStr(), text: `▶️ 恢复续派：${rec.typeLabel} ${qty}${rec.unit} 重新出库，约 ${m.distance}km·${m.minutes}min` })
      return { ok: true }
    },
    // 阻断解除后恢复直线（由道路阻断模块判定不再穿越其它阻断后调用）
    resetDispatchRoute(id) {
      const rec = this.dispatches.find((d) => d.id === id)
      if (!rec || rec.status !== 'enroute') return
      const base = this.bases.find((b) => b.id === rec.baseId)
      if (!base) return
      rec.via = []
      rec.detourBy = null
      const m = pathMetrics([[base.lng, base.lat], [rec.lng, rec.lat]])
      rec.distance = m.distance
      rec.minutes = m.minutes
    },
    // 内部：撤回单条派发。在途（或挂起待续派）余量原路回库，
    // 已发生的签收 / 短缺认定 / 退回 / 补派回执全部保留，记录转为 withdrawn 留档。
    // 若本单是短缺补派单，其被撤回的余量从原单 shortReplenished 冲回，缺口重新释放。
    _withdrawRecord(rec, reason = '撤回派发') {
      if (!rec || rec.status === 'withdrawn' || rec.status === 'done') return 0
      const parts = dispatchParts(rec)
      const left = parts.outstanding
      // 仅在途余量回库：挂起时物资已随挂起退回基地，不重复返还
      if (left > 0 && rec.status === 'enroute') {
        const base = this.bases.find((b) => b.id === rec.baseId)
        if (base) base.stock[rec.type] = (base.stock[rec.type] || 0) + left
      }
      if (left > 0) {
        rec.withdrawnQty = parts.withdrawn + left
        if (!Array.isArray(rec.withdrawLogs)) rec.withdrawLogs = []
        rec.withdrawLogs.push({ at: nowStr(), qty: left, reason })
      }
      rec.status = 'withdrawn'
      rec.doneReason = 'withdrawn'
      rec.holdBy = null
      rec.via = []
      rec.detourBy = null
      // 补派子单被撤回：未签收的补派量冲回原单「已补派」账，短缺缺口重新释放
      if (rec.replenishOf && left > 0) {
        const parent = this.dispatches.find((d) => d.id === rec.replenishOf)
        if (parent) {
          parent.shortReplenished = Math.max(0, (parent.shortReplenished || 0) - left)
          this._logDest(parent, `↩️ 补派撤回：${rec.typeLabel} ${left}${rec.unit} 回库，原短缺缺口重新释放`)
        }
      }
      this._logDest(rec, `🚫 派发撤回：${rec.typeLabel} 在途余量 ${left}${rec.unit} 退回 ${rec.baseName}`
        + (parts.received ? `，已实收 ${parts.received}${rec.unit} 保留` : '')
        + (parts.shortage ? `，已认定短缺 ${parts.shortage}${rec.unit} 保留` : '')
        + (parts.returned ? `，已退回 ${parts.returned}${rec.unit} 保留` : ''))
      return left
    },
    // 撤回派发：仅返还在途/挂起余量；签收、短缺认定、补派与退回记录全部留档
    withdrawDispatch(recordId) {
      const rec = this.dispatches.find((d) => d.id === recordId)
      if (!rec || rec.status === 'withdrawn') return
      this._withdrawRecord(rec)
      // 道路阻断联动：撤回后该任务退出影响评估
      notifyDispatchChanged()
    },

    /* ---------- 多灾点资源统筹 · 多调度员协同编制（预占/超时释放/冲突重算） ---------- */

    _planNow() { return this.planClock == null ? nowMs() : Number(this.planClock) },
    _dispatcherName(id) {
      return this.dispatchers.find((u) => u.id === id)?.name || (id || '—')
    },

    /* ---- 方案与版本 ---- */

    // 新建/重建协同方案：重置条目、预占流水与版本号，当前调度员作为创建人
    _ensurePlanMeta() {
      if (this.planMeta && this.planMeta.status === 'draft') return this.planMeta
      const meta = {
        id: uid('pl'),
        version: 1,
        status: 'draft',
        createdBy: this.currentDispatcherId,
        createdAt: nowStr(),
        updatedAt: nowStr(),
        logs: [{ v: 1, at: nowStr(), by: this.currentDispatcherId, text: '创建协同方案' }]
      }
      this.planMeta = meta
      this.planResult = null
      this._startPlanSweeper()
      return meta
    },
    // 方案留痕：每次协同动作沉淀一条版本日志（版本即方案草稿修订序号）
    _bumpPlanVersion(text, by = this.currentDispatcherId) {
      const meta = this.planMeta
      if (!meta) return
      meta.version += 1
      meta.updatedAt = nowStr()
      meta.logs.push({ v: meta.version, at: nowStr(), by, text })
    },

    /* ---- 预占流水（held → consumed / released / expired） ---- */

    // 为方案条目建立库存预占（不动物理库存；预占量纳入可支配量扣减与冲突检测）
    _holdReservation(item, { ttl = PLAN_RESERVATION_TTL, by = this.currentDispatcherId, reason = '方案预占' } = {}) {
      const rv = {
        id: uid('rv'),
        planId: this.planMeta.id,
        itemId: item.id,
        baseId: item.baseId,
        type: item.type,
        qty: item.qty,
        status: 'held',
        by,
        reason,
        at: nowStr(),
        expiresAt: this._planNow() + ttl,
        releasedAt: null,
        releasedReason: '',
        consumedQty: 0,
        dispatchIds: []
      }
      this.planReservations.push(rv)
      item.reservationId = rv.id
      item.status = 'held'
      item.expiresAt = rv.expiresAt
      return rv
    },
    // 释放预占：归还占用额度（流水保留留痕）；items 状态同步回 expired/normal
    _releaseReservation(rv, reason) {
      if (!rv || rv.status !== 'held') return
      rv.status = 'released'
      rv.releasedAt = nowStr()
      rv.releasedReason = reason
      const item = this.plan.find((p) => p.id === rv.itemId)
      if (item && item.reservationId === rv.id) {
        item.reservationId = null
        item.expiresAt = null
        item.status = 'normal'
      }
    },
    // 超时扫描：到期 held 预占自动释放，对应方案条目标记「已超时」等待调度员处理
    // （回放只读期由包装器拦截；定时器与手动调用同一路径，保证幂等）
    expirePlanReservations() {
      const t = this._planNow()
      const due = this.planReservations.filter((r) => r.status === 'held' && r.expiresAt <= t)
      if (!due.length) return { expired: [] }
      due.forEach((r) => {
        r.status = 'expired'
        r.releasedAt = nowStr()
        r.releasedReason = '预占超时自动释放'
        const item = this.plan.find((p) => p.id === r.itemId)
        if (item && item.reservationId === r.id) {
          item.status = 'expired'
          item.reservationId = null
          item.expiresAt = null
        }
      })
      const byList = [...new Set(due.map((r) => r.by))]
      this._bumpPlanVersion(`库存预占超时释放 ${due.length} 项（${byList.map((u) => this._dispatcherName(u)).join('、')}）`)
      return { expired: due }
    },
    // 超时条目重新预占（库存可支配量必须够；滑动续期）
    retryPlanItem(id) {
      const it = this.plan.find((p) => p.id === id)
      if (!it || it.status !== 'expired') return { ok: false, msg: '仅超时释放的条目可重新预占' }
      const free = this.availableStock[it.baseId]?.[it.type] || 0
      if (free < it.qty) return { ok: false, msg: `${this.bases.find((b) => b.id === it.baseId)?.name || it.baseId} 可支配库存不足（余 ${free}${RESOURCE_TYPES[it.type]?.unit || ''}），请减量或换基` }
      this._holdReservation(it, { reason: '超时后重新预占' })
      this._bumpPlanVersion(`重新预占：${RESOURCE_TYPES[it.type]?.label || it.type} ${it.qty}`)
      return { ok: true }
    },

    /* ---- 协同 ---- */

    switchDispatcher(userId) {
      if (this.dispatchers.some((u) => u.id === userId)) this.currentDispatcherId = userId
    },
    // 调度员加入方案（协同编制）：方案不存在则随首次生成自动创建
    joinPlan(userId = this.currentDispatcherId) {
      const meta = this._ensurePlanMeta()
      const u = this.dispatchers.find((x) => x.id === userId)
      if (!u) return null
      meta.joined = meta.joined || []
      if (!meta.joined.includes(userId)) {
        meta.joined.push(userId)
        this._bumpPlanVersion(`${u.name} 加入协同编制`, userId)
      }
      return meta
    },

    /* ---- 方案生成 / 人工调整 ---- */

    // 按 灾情等级 → 需求缺口 → 运输时长 生成跨基地分配方案
    // 协同口径：按「物理库存 - 已生效预占」的可支配量就近拆分，逐项即时预占
    generatePlan() {
      this.expirePlanReservations()
      // 旧草稿（含预占）整体作废：先归还全部 held 预占（历史 consumed/released/expired 流水保留）
      this.planReservations.filter((r) => r.status === 'held').forEach((r) => this._releaseReservation(r, '重新生成方案'))
      this.plan = []
      const meta = this._ensurePlanMeta()
      meta.joined = Array.from(new Set([...(meta.joined || []), this.currentDispatcherId]))

      const planId = meta.id
      const avail = {}
      Object.entries(this.availableStock).forEach(([bid, st]) => { avail[bid] = { ...st } })
      // 按等级权重、缺口规模排序事件
      const queue = this.events
        .filter((e) => e.status !== 'closed')
        .map((ev) => {
          const gap = {}
          let total = 0
          Object.entries(ev.demand || {}).forEach(([t, need]) => {
            const g = need - (this.sentMap[ev.id]?.[t] || 0)
            if (g > 0) { gap[t] = g; total += g }
          })
          return { ev, gap, total }
        })
        .filter((x) => x.total > 0)
        .sort((a, b) => (SEV_WEIGHT[b.ev.severity] - SEV_WEIGHT[a.ev.severity]) || (b.total - a.total))

      const items = []
      queue.forEach(({ ev, gap }) => {
        Object.entries(gap).forEach(([type, g]) => {
          let need = g
          // 候选基地按运输时长升序，就近优先、跨基地拆分（基于可支配量）
          const cands = this.bases
            .filter((b) => (avail[b.id][type] || 0) > 0)
            .map((b) => ({ b, path: roughPath(b.lng, b.lat, ev.location.lng, ev.location.lat) }))
            .sort((x, y) => x.path.minutes - y.path.minutes)
          for (const c of cands) {
            if (need <= 0) break
            const take = Math.min(need, avail[c.b.id][type])
            avail[c.b.id][type] -= take
            need -= take
            items.push({
              id: 'pi-' + ++piSeq,
              eventId: ev.id, baseId: c.b.id, type, qty: take,
              distance: c.path.distance, minutes: c.path.minutes,
              authorId: this.currentDispatcherId,
              status: 'normal', reservationId: null, expiresAt: null
            })
          }
        })
      })
      this.plan = items
      items.forEach((it) => this._holdReservation(it))
      this._bumpPlanVersion(`生成统筹方案 ${items.length} 项并预占库存`)
      return items
    },
    // 人工调整：改数量 / 换基地（自动重算运输时长，同步迁移预占并滑动续期）
    // 新基地/新数量容量不足时整体拒绝并返回原因（预占保持调整前状态）
    updatePlanItem(id, patch) {
      this.expirePlanReservations()
      const it = this.plan.find((p) => p.id === id)
      if (!it) return { ok: false, msg: '方案项不存在' }
      const prev = { baseId: it.baseId, qty: it.qty, reservationId: it.reservationId }
      let qty = it.qty
      if (patch.qty != null) qty = Math.max(1, Math.round(patch.qty))
      let baseId = it.baseId
      if (patch.baseId) baseId = patch.baseId
      if (it.status === 'expired') {
        // 超时条目：只落草稿修改，不自动预占（由「重新预占」校验容量）
        it.qty = qty
        if (baseId !== it.baseId) {
          const base = this.bases.find((b) => b.id === baseId)
          const ev = this.events.find((e) => e.id === it.eventId)
          if (base && ev) {
            it.baseId = baseId
            const path = roughPath(base.lng, base.lat, ev.location.lng, ev.location.lat)
            it.distance = path.distance
            it.minutes = path.minutes
          }
        }
        return { ok: true }
      }
      // 容量校验：目标基地扣除其它条目预占后，必须容纳本条目新数量
      const ownHeld = this.planReservations.find((r) => r.id === it.reservationId && r.status === 'held')
      const otherHeld = this.planReservations
        .filter((r) => r.status === 'held' && r.baseId === baseId && r.type === it.type && r.id !== it.reservationId)
        .reduce((s, r) => s + r.qty, 0)
      const physical = this.bases.find((b) => b.id === baseId)?.stock[it.type] || 0
      const freeForIt = physical - otherHeld
      if (qty > freeForIt) {
        return { ok: false, msg: `${this.bases.find((b) => b.id === baseId)?.name || baseId} 可支配库存不足（可分 ${freeForIt}${RESOURCE_TYPES[it.type]?.unit || ''}），可减量、换基或点「冲突重算」` }
      }
      it.qty = qty
      if (baseId !== it.baseId) {
        const base = this.bases.find((b) => b.id === baseId)
        const ev = this.events.find((e) => e.id === it.eventId)
        if (base && ev) {
          it.baseId = baseId
          const path = roughPath(base.lng, base.lat, ev.location.lng, ev.location.lat)
          it.distance = path.distance
          it.minutes = path.minutes
        }
      }
      // 数量/基地变更：旧预占归还、按新口径重新预占（滑动超时）
      if (ownHeld) this._releaseReservation(ownHeld, '人工调整方案')
      this._holdReservation(it, { reason: '人工调整后重新预占' })
      const changes = []
      if (prev.qty !== it.qty) changes.push(`数量 ${prev.qty}→${it.qty}`)
      if (prev.baseId !== it.baseId) changes.push(`基地 ${this.bases.find((b) => b.id === prev.baseId)?.name || prev.baseId}→${this.bases.find((b) => b.id === it.baseId)?.name || it.baseId}`)
      if (changes.length) this._bumpPlanVersion(`调整方案项：${RESOURCE_TYPES[it.type]?.label || it.type}（${changes.join('，')}）`)
      return { ok: true }
    },
    removePlanItem(id) {
      const it = this.plan.find((p) => p.id === id)
      if (!it) return
      const rv = this.planReservations.find((r) => r.id === it.reservationId && r.status === 'held')
      if (rv) this._releaseReservation(rv, '删除方案项')
      this.plan = this.plan.filter((p) => p.id !== id)
      this._bumpPlanVersion(`删除方案项：${RESOURCE_TYPES[it.type]?.label || it.type} ${it.qty}`)
    },
    clearPlan() {
      if (this.planMeta) {
        this.planReservations
          .filter((r) => r.planId === this.planMeta.id && r.status === 'held')
          .forEach((r) => this._releaseReservation(r, '清空方案'))
      }
      this.plan = []
      if (this.planMeta) this._bumpPlanVersion('清空协同方案')
    },

    /* ---- 冲突重算（协同编辑中库存被占时实时重新分配） ---- */

    // 按 灾情等级 → 运输时长 重排全部条目：以可支配量为口径就近拆单，
    // 冲突条目自动换基/拆单并迁移预占；仍不足的条目保留在原基地并持续高亮。
    recalcPlanConflicts() {
      this.expirePlanReservations()
      if (!this.plan.length) return { moved: 0, unmet: [] }
      const evOf = (id) => this.events.find((e) => e.id === id)
      // 重算期间全部预占归还，按新条目布局重新预占（流水保留迁移痕迹）
      this.planReservations.filter((r) => r.status === 'held').forEach((r) => this._releaseReservation(r, '冲突重算'))

      const remaining = {}
      this.bases.forEach((b) => { remaining[b.id] = { ...b.stock } })
      const items = [...this.plan].sort((a, b) => {
        const wa = SEV_WEIGHT[evOf(a.eventId)?.severity] || 0
        const wb = SEV_WEIGHT[evOf(b.eventId)?.severity] || 0
        return wb - wa || a.minutes - b.minutes
      })
      const next = []
      let moved = 0
      const unmet = []
      items.forEach((it) => {
        const ev = evOf(it.eventId)
        let need = it.qty
        const parts = []
        // 原基地优先
        const own = Math.min(need, remaining[it.baseId]?.[it.type] || 0)
        if (own > 0) { parts.push({ baseId: it.baseId, qty: own }); need -= own }
        if (need > 0 && ev) {
          const alts = this.bases
            .filter((b) => b.id !== it.baseId && (remaining[b.id][it.type] || 0) > 0)
            .map((b) => ({ b, path: roughPath(b.lng, b.lat, ev.location.lng, ev.location.lat) }))
            .sort((x, y) => x.path.minutes - y.path.minutes)
          for (const a of alts) {
            if (need <= 0) break
            const t = Math.min(need, remaining[a.b.id][it.type])
            parts.push({ baseId: a.b.id, qty: t })
            need -= t
          }
        }
        parts.forEach((p) => { remaining[p.baseId][it.type] -= p.qty })
        const movedFlag = parts.some((p) => p.baseId !== it.baseId) || parts.length > 1 || need > 0
        if (movedFlag && parts.length) moved++
        if (need > 0) {
          unmet.push({ eventTitle: ev?.title || it.eventId, type: it.type, qty: need })
        }
        const mkPath = (baseId) => {
          const base = this.bases.find((b) => b.id === baseId)
          return ev && base ? roughPath(base.lng, base.lat, ev.location.lng, ev.location.lat)
            : { distance: it.distance, minutes: it.minutes }
        }
        if (!parts.length && need > 0) {
          // 完全无库存：原条目原地保留为冲突残余
          const path = mkPath(it.baseId)
          next.push({ ...it, distance: path.distance, minutes: path.minutes, status: 'conflict', reservationId: null, expiresAt: null })
        } else {
          // 首块尽量复用原条目（保留编辑人/ID），其余拆为新条目
          parts.forEach((p, idx) => {
            const path = mkPath(p.baseId)
            if (idx === 0) {
              next.push({
                ...it,
                baseId: p.baseId, qty: p.qty,
                distance: path.distance, minutes: path.minutes,
                status: 'normal', reservationId: null, expiresAt: null
              })
            } else {
              next.push({
                id: 'pi-' + ++piSeq,
                eventId: it.eventId, baseId: p.baseId, type: it.type, qty: p.qty,
                distance: path.distance, minutes: path.minutes,
                authorId: it.authorId, status: 'normal', reservationId: null, expiresAt: null
              })
            }
          })
          if (need > 0) {
            // 无法满足的残余：留在原基地（容量不足，持续冲突高亮）
            const path = mkPath(it.baseId)
            next.push({
              id: 'pi-' + ++piSeq,
              eventId: it.eventId, baseId: it.baseId, type: it.type, qty: need,
              distance: path.distance, minutes: path.minutes,
              authorId: it.authorId, status: 'conflict', reservationId: null, expiresAt: null
            })
          }
        }
      })
      this.plan = next
      next.forEach((it) => {
        if (it.status === 'conflict') {
          // 缺口残余：尽力预占（容量不足也建 held 流水，冲突视图照常高亮）
          this._holdReservation(it, { reason: '冲突重算残余（容量不足）' })
          it.status = 'conflict'
        } else {
          this._holdReservation(it, { reason: '冲突重算后重新预占' })
        }
      })
      this._bumpPlanVersion(`冲突重算：迁移/拆单 ${moved} 项` + (unmet.length ? `，仍有 ${unmet.length} 项缺口` : ''))
      return { moved, unmet }
    },

    /* ---- 提交（原子生成派发） / 撤销（归还预占与在途余量） ---- */

    // 统一分配计算（提交与冲突重算共用）：返回每个条目落库明细 + 未满足量
    _allocatePlan() {
      const evOf = (id) => this.events.find((e) => e.id === id)
      const remaining = {}
      this.bases.forEach((b) => { remaining[b.id] = { ...b.stock } })
      const items = [...this.plan]
        .filter((it) => it.status !== 'expired')
        .sort((a, b) => {
          const wa = SEV_WEIGHT[evOf(a.eventId)?.severity] || 0
          const wb = SEV_WEIGHT[evOf(b.eventId)?.severity] || 0
          return wb - wa || a.minutes - b.minutes
        })
      const takes = []
      const result = { total: items.length, ok: 0, realloc: 0, unmet: [] }
      items.forEach((it) => {
        const ev = evOf(it.eventId)
        let need = it.qty
        const parts = []
        const own = Math.min(need, remaining[it.baseId]?.[it.type] || 0)
        if (own > 0) { parts.push({ baseId: it.baseId, qty: own }); need -= own }
        if (need > 0 && ev) {
          // 冲突：原基地库存不足（协同预占/他用导致），按运输时长从其他基地重新分配
          const alts = this.bases
            .filter((b) => b.id !== it.baseId && (remaining[b.id][it.type] || 0) > 0)
            .map((b) => ({ b, path: roughPath(b.lng, b.lat, ev.location.lng, ev.location.lat) }))
            .sort((x, y) => x.path.minutes - y.path.minutes)
          for (const a of alts) {
            if (need <= 0) break
            const t = Math.min(need, remaining[a.b.id][it.type])
            parts.push({ baseId: a.b.id, qty: t })
            need -= t
          }
        }
        if (parts.some((p) => p.baseId !== it.baseId) || parts.length > 1) result.realloc++
        else if (parts.length) result.ok++
        if (need > 0) result.unmet.push({ eventTitle: ev?.title || it.eventId, type: it.type, qty: need })
        parts.forEach((p) => {
          remaining[p.baseId][it.type] -= p.qty // 锁定库存
          takes.push({ itemId: it.id, baseId: p.baseId, eventId: it.eventId, type: it.type, qty: p.qty })
        })
      })
      return { takes, result }
    },
    // 提交：统一校验 → 锁定库存 → 冲突重分配 → 原子批量派发
    // 任一条目落库失败即整体不产出派发；方案与版本快照归档，草稿清空
    submitPlan() {
      if (!this.plan.length || !this.planMeta) return null
      const sweep = this.expirePlanReservations()
      // 超时条目未重新预占则拒绝提交（避免漏项）
      const expiredLeft = this.plan.filter((p) => p.status === 'expired')
      if (expiredLeft.length) {
        return { ok: false, msg: `有 ${expiredLeft.length} 项预占已超时释放，请重新预占或删除后再提交` }
      }
      const { takes, result } = this._allocatePlan()
      // 原子提交：先把方案版本与预占结算定稿，再批量生成派发（库存校验已在分配阶段完成）
      const planId = this.planMeta.id
      const versionSnap = this.planMeta.version
      const archive = {
        ...JSON.parse(JSON.stringify(this.planMeta)),
        submittedAt: nowStr(),
        items: JSON.parse(JSON.stringify(this.plan)),
        dispatchIds: [],
        cancel: null
      }
      const made = []
      try {
        takes.forEach((t) => {
          const rec = this._pushDispatch(t.baseId, t.eventId, t.type, t.qty, '统筹', planId)
          if (!rec) throw new Error('dispatch-failed')
          t.dispatchId = rec.id
          made.push(rec)
        })
      } catch {
        // 原子性兜底：回滚已扣库存与已建记录（正常流程不会走到，库存已预校验）
        made.forEach((rec) => {
          const base = this.bases.find((b) => b.id === rec.baseId)
          if (base) base.stock[rec.type] = (base.stock[rec.type] || 0) + rec.qty
        })
        this.dispatches = this.dispatches.filter((d) => !made.some((m) => m.id === d.id))
        return { ok: false, msg: '方案提交失败，已全部回滚' }
      }
      // 预占结算：按方案条目汇总原基地落库量——同基地出库部分 consumed，
      // 跨基重分配 / 缺口残余对应的原预占一律释放（库存未在原基地扣减，额度回归）
      const byItem = {}
      takes.forEach((t) => {
        byItem[t.itemId] = byItem[t.itemId] || []
        byItem[t.itemId].push(t)
      })
      this.planReservations.filter((r) => r.planId === planId && r.status === 'held').forEach((rv) => {
        const sameBase = (byItem[rv.itemId] || []).filter((t) => t.baseId === rv.baseId)
        const used = sameBase.reduce((s, t) => s + t.qty, 0)
        const ids = sameBase.map((t) => t.dispatchId).filter(Boolean)
        if (used > 0) {
          rv.status = 'consumed'
          rv.consumedQty = Math.min(rv.qty, used)
          rv.dispatchIds = ids
          rv.releasedAt = nowStr()
          rv.releasedReason = used >= rv.qty ? '方案提交出库' : '方案部分出库，余量释放'
          if (used < rv.qty) rv.status = 'released'
        } else {
          rv.status = 'released'
          rv.releasedAt = nowStr()
          rv.releasedReason = '提交时冲突重分配，原基地预占释放'
        }
      })
      archive.dispatchIds = made.map((m) => m.id)
      archive.status = 'submitted'
      archive.version = versionSnap
      archive.logs.push({ v: versionSnap + 1, at: nowStr(), by: this.currentDispatcherId,
        text: `提交方案：原子生成 ${made.length} 条派发（直接 ${result.ok} / 冲突重分配 ${result.realloc}）`
          + (sweep.expired.length ? `，提交时扫描到超时释放 ${sweep.expired.length} 项` : '') })
      this.submittedPlans.unshift(archive)
      this.plan = []
      this.planMeta = null
      this.planResult = { ...result, okCount: result.ok, at: nowStr(), planId }
      this._stopPlanSweeper()
      return { ok: true, ...result, planId, dispatchIds: archive.dispatchIds }
    },
    // 撤销方案：
    //  · 草稿：归还全部生效预占（物理库存从未扣减，仅释放额度），草稿留档作废
    //  · 已提交：撤回方案全部派发（在途/挂起余量原路回库，已签收/短缺/退回账目保留），归还预占
    cancelPlan(planId = null) {
      // 撤销草稿
      if (!planId && this.planMeta && this.planMeta.status === 'draft') {
        const held = this.planReservations.filter((r) => r.planId === this.planMeta.id && r.status === 'held')
        held.forEach((r) => this._releaseReservation(r, '撤销方案归还预占'))
        const archive = {
          ...JSON.parse(JSON.stringify(this.planMeta)),
          status: 'cancelled',
          cancelledAt: nowStr(),
          items: JSON.parse(JSON.stringify(this.plan)),
          dispatchIds: [],
          cancel: { at: nowStr(), by: this.currentDispatcherId, reason: '草稿撤销', returnedQty: 0, dispatchCount: 0 }
        }
        archive.logs.push({ v: archive.version + 1, at: nowStr(), by: this.currentDispatcherId, text: `撤销协同方案草稿，归还预占 ${held.length} 项` })
        this.submittedPlans.unshift(archive)
        this.plan = []
        this.planMeta = null
        this._stopPlanSweeper()
        return { ok: true, draft: true, released: held.length }
      }
      // 撤销已提交方案
      const arch = this.submittedPlans.find((p) => p.id === planId)
      if (!arch || arch.status === 'cancelled') return { ok: false, msg: '方案不存在或已撤销' }
      let returned = 0
      let count = 0
      arch.dispatchIds.forEach((id) => {
        const rec = this.dispatches.find((d) => d.id === id)
        if (rec && rec.status !== 'withdrawn' && rec.status !== 'done') {
          const left = this._withdrawRecord(rec, '撤销统筹方案')
          returned += left
          if (left > 0) count++
        }
      })
      this.planReservations
        .filter((r) => r.planId === arch.id && r.status === 'held')
        .forEach((r) => this._releaseReservation(r, '撤销方案归还预占'))
      arch.status = 'cancelled'
      arch.cancel = { at: nowStr(), by: this.currentDispatcherId, reason: '撤销已提交方案', returnedQty: returned, dispatchCount: count }
      arch.logs.push({ v: arch.version + 1, at: nowStr(), by: this.currentDispatcherId,
        text: `撤销方案：撤回派发 ${count} 条，在途余量 ${returned} 回库（已签收/短缺/退回账目保留）` })
      notifyDispatchChanged()
      return { ok: true, draft: false, returned, dispatchCount: count }
    },

    /* ---- 超时扫描定时器（演示用；回放 seek/切换分支后按快照状态重建） ---- */

    _startPlanSweeper() {
      this._stopPlanSweeper()
      sweepTimer = setInterval(() => {
        // 回放只读期业务动作被包装器拦截；无草稿时不扫描
        if (!this.planMeta || this.planMeta.status !== 'draft') return
        this.expirePlanReservations()
      }, SWEEP_INTERVAL)
    },
    _stopPlanSweeper() {
      if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null }
    },
    // 快照恢复后调用：按当前草稿状态重建扫描器（分支回放/分叉隔离）
    syncPlanSweeper() {
      if (this.planMeta && this.planMeta.status === 'draft') this._startPlanSweeper()
      else this._stopPlanSweeper()
    },
    // 测试用：推进虚拟时钟并立即扫描
    advancePlanClock(ms) {
      this.planClock = (this.planClock == null ? nowMs() : this.planClock) + ms
      return this.expirePlanReservations()
    },

    // 大屏数据自动刷新（模拟实时数据变化演示）
    startAutoPlay() {
      if (this.autoPlay) return
      this.autoPlay = true
      this.replayTimer = setInterval(() => {
        this.events.forEach((e) => {
          if (e.status !== 'closed' && Math.random() > 0.55) {
            e.affected += Math.floor(Math.random() * 60)
          }
        })
      }, 4000)
    },
    stopAutoPlay() {
      this.autoPlay = false
      clearInterval(this.replayTimer)
    },
    resetResource(eventId) {
      const ev = this.events.find((e) => e.id === eventId)
      if (!ev) return
      // 撤回该事件关联的所有派发：在途/挂起余量回库，签收/短缺/补派/退回账目留档
      const rows = this.dispatches.filter((d) => d.eventId === eventId)
      if (!rows.length) return
      let back = 0
      rows.forEach((d) => { back += this._withdrawRecord(d, '重置事件资源') })
      ev.timeline.push({ at: nowStr(), text: `🚫 重置资源：${rows.length} 条派发撤回，在途余量 ${back} 已回库，历史签收/退回记录保留` })
      notifyDispatchChanged()
    }
  }
})
