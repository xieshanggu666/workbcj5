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
let mvSeq = 0
const nowStr = () => new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
const nowMs = () => Date.now()

/* ---------- 协同编制 ---------- */

// 预置调度员（多名调度员共同编制同一统筹方案；演示用身份切换）
export const DISPATCHERS = [
  { id: 'u-zhao', name: '赵调度', role: '值班调度员' },
  { id: 'u-qian', name: '钱调度', role: '物资调度员' },
  { id: 'u-sun', name: '孙调度', role: '现场联络员' }
]

// 库存预占超时时长（ms）：超时未提交的预占自动释放、方案项标失效，需重新预占
const RESERVATION_TTL = 5 * 60 * 1000
// 库存变动流水上限（分支回放/帧差异展示用）
const MOVEMENT_CAP = 400

// 库存变动口径标签（资源占用维度回放）
const MOVEMENT_META = {
  dispatch: { icon: '📦', label: '派发扣减' },
  replenish: { icon: '🔁', label: '短缺补派扣减' },
  supply: { icon: '🥫', label: '安置补给扣减' },
  sign: { icon: '📥', label: '签收入账' },
  return: { icon: '↩️', label: '退回入库' },
  hold: { icon: '⏸', label: '挂起回库' },
  resume: { icon: '▶️', label: '续派扣减' },
  reassignOut: { icon: '🔀', label: '改派旧库回补' },
  reassignIn: { icon: '🔀', label: '改派新库扣减' },
  withdraw: { icon: '🚫', label: '撤回回库' },
  repair: { icon: '🔧', label: '抢修派工扣减' },
  repairBack: { icon: '🔧', label: '抢修结算归还' },
  vehicle: { icon: '🚌', label: '转移车辆占用' },
  vehicleBack: { icon: '🚌', label: '车辆回收' }
}

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
    // 统筹方案协同编制：当前调度员身份 / 方案版本（每次结构性改动自增）
    currentDispatcherId: DISPATCHERS[0].id,
    planVersion: 0,
    // 方案协同会话：{ id, name, createdAt, createdBy, status, submittedAt, revokedAt, dispatchIds }
    planSession: null,
    // 库存预占台账：{ id, itemId, baseId, type, qty, owner, createdAt, expiresAt, status }
    reservations: [],
    // 库存变动流水（实际出入库，方案预占/释放不产生实际库存变化，单独记版本）
    stockMovements: [],
    // 协同会话流水（方案版本留痕：建会/编制/超时释放/提交/撤销）
    planAudit: [],
    // 协同方案预占 TTL（ms）；null=不超时。测试可固定/缩短
    reservationTtl: RESERVATION_TTL,
    // 演示/测试时钟（ms），null=真实时间
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
    // 各事件需求缺口：需求 - 在途 - 方案预占
    gaps(state) {
      const planned = {}
      state.plan.forEach((p) => {
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
    // 方案冲突检测：按 基地+类型 汇总预占，超出当前库存即冲突（提交时将触发重分配）
    // 兼容旧方案项（无预占字段）：按当前方案项数量汇总
    planConflicts(state) {
      const use = {}
      state.plan.forEach((p) => {
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
    // 当前调度员
    currentDispatcher(state) {
      return DISPATCHERS.find((u) => u.id === state.currentDispatcherId) || DISPATCHERS[0]
    },
    // 协同会话
    activePlanSession(state) {
      return state.planSession && state.planSession.status === 'editing' ? state.planSession : null
    },
    // 协同方案中的调度员（在线编制者）
    planParticipants(state) {
      const ids = new Set()
      state.plan.forEach((p) => { if (p.owner) ids.add(p.owner) })
      if (state.planSession?.createdBy) ids.add(state.planSession.createdBy)
      return [...ids].map((id) => DISPATCHERS.find((u) => u.id === id) || { id, name: id, role: '' }).filter(Boolean)
    },
    // 方案项 id -> 生效预占（不含已释放/超时/已提交）
    reservationByItem(state) {
      const m = {}
      state.reservations.filter((r) => r.status === 'active').forEach((r) => {
        m[r.itemId] = r
      })
      return m
    },
    // 各 基地+类型 的生效预占总量（含本方案之外的预占；当前仅协同方案使用）
    reservedMap(state) {
      const m = {}
      state.reservations.filter((r) => r.status === 'active').forEach((r) => {
        const k = r.baseId + '|' + r.type
        m[k] = (m[k] || 0) + r.qty
      })
      return m
    },
    // 各 基地+类型 可用量 = 实物库存 − 生效预占
    availableMap() {
      const m = {}
      this.bases.forEach((b) => {
        Object.keys(b.stock).forEach((t) => {
          const k = b.id + '|' + t
          m[k] = Math.max(0, (b.stock[t] || 0) - (this.reservedMap[k] || 0))
        })
      })
      return m
    },
    // 方案项超时的 id 集合（预占已失效，需重新预占后才能提交）
    expiredItemIds(state) {
      const now = state.planClock != null ? state.planClock : nowMs()
      const s = new Set()
      state.reservations.forEach((r) => {
        if (r.status === 'active' && state.reservationTtl != null && now - r.createdAt >= state.reservationTtl) s.add(r.itemId)
      })
      // 旧方案项（无预占）不判超时，提交时按旧口径即时校验
      return s
    },
    // 超时但尚未落账释放的预占（供 UI 一键清理 / 提交前清理）
    expiredReservations(state) {
      const now = state.planClock != null ? state.planClock : nowMs()
      if (state.reservationTtl == null) return []
      return state.reservations.filter((r) => r.status === 'active' && now - r.createdAt >= state.reservationTtl)
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
      this.planVersion = 0
      this.planSession = null
      this.reservations = []
      this.stockMovements = []
      this.planAudit = []
      this.planClock = null
      this.reservationTtl = RESERVATION_TTL
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

    /* ---------- 库存变动流水（实际出入库统一入账，供分支回放/帧差异） ---------- */

    _nowMs() { return this.planClock != null ? this.planClock : nowMs() },
    // 供测试/演示固定时钟
    setPlanClock(ms) { this.planClock = ms == null ? null : Number(ms) },
    setReservationTtl(ms) { this.reservationTtl = ms == null ? null : Math.max(0, Number(ms)) },
    // 内部：实物库存增减并落一笔变动流水（delta>0 入库，<0 出库；预占不经过此处）
    _moveStock(baseId, type, delta, kind, ref = {}) {
      if (!delta) return
      const base = this.bases.find((b) => b.id === baseId)
      if (!base) return
      base.stock[type] = Math.max(0, (base.stock[type] || 0) + delta)
      const meta = MOVEMENT_META[kind] || { icon: '🔁', label: kind }
      this.stockMovements.push({
        id: 'mv-' + ++mvSeq,
        at: nowStr(), t: this._nowMs(),
        baseId, baseName: base.name, type,
        typeLabel: RESOURCE_TYPES[type]?.label || type,
        unit: RESOURCE_TYPES[type]?.unit || '',
        delta, kind, icon: meta.icon, label: meta.label,
        eventId: ref.eventId || null, dispatchId: ref.dispatchId || null,
        detail: ref.detail || ''
      })
      if (this.stockMovements.length > MOVEMENT_CAP) this.stockMovements.splice(0, this.stockMovements.length - MOVEMENT_CAP)
    },
    // 转移批次/抢修工单跨模块出库入口（车辆/人员/物资）
    stockOutExternal(baseId, type, qty, kind, ref = {}) {
      this._moveStock(baseId, type, -Math.abs(qty), kind, ref)
    },
    stockInExternal(baseId, type, qty, kind, ref = {}) {
      this._moveStock(baseId, type, Math.abs(qty), kind, ref)
    },

    /* ---------- 库存预占（协同方案） ---------- */

    // 内部：为方案项建立/追加预占（每个方案项至多一笔生效预占；qty 超过可用量时按可用量预占）
    _reserveItem(item, qty, owner) {
      const avail = this.availableMap[item.baseId + '|' + item.type] ?? 0
      const add = Math.max(0, Math.min(qty, avail))
      const t = this._nowMs()
      let r = this.reservations.find((x) => x.itemId === item.id && x.status === 'active')
      if (r) {
        r.qty += add
        r.expiresAt = this.reservationTtl != null ? t + this.reservationTtl : null
        return r
      }
      // 可用量为 0：返回 qty=0 占位结果，不落台账（提交时冲突重算）
      if (add <= 0) {
        return {
          id: null, itemId: item.id, baseId: item.baseId, type: item.type,
          qty: 0, owner: owner || item.owner || this.currentDispatcherId,
          createdAt: t, expiresAt: this.reservationTtl != null ? t + this.reservationTtl : null,
          status: 'none'
        }
      }
      r = {
        id: 'rs-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7),
        itemId: item.id, baseId: item.baseId, type: item.type,
        qty: add, owner: owner || item.owner || this.currentDispatcherId,
        createdAt: t, expiresAt: this.reservationTtl != null ? t + this.reservationTtl : null,
        status: 'active'
      }
      this.reservations.push(r)
      return r
    },
    // 内部：释放指定方案项的生效/超时预占（撤销/删除/提交锁定时调用）
    _releaseItemReservation(itemId, reason = '') {
      let n = 0
      this.reservations.forEach((r) => {
        if (r.itemId === itemId && (r.status === 'active' || r.status === 'expired')) {
          if (r.status === 'active') n += r.qty
          r.status = 'released'
          r.reason = reason
        }
      })
      return n
    },
    // 内部：方案版本留痕
    _planAudit(text, extra = {}) {
      this.planVersion += 1
      this.planAudit.push({
        v: this.planVersion, at: nowStr(), t: this._nowMs(),
        who: this.currentDispatcherId, whoName: this.currentDispatcher.name,
        text, ...extra
      })
      if (this.planAudit.length > MOVEMENT_CAP) this.planAudit.splice(0, this.planAudit.length - MOVEMENT_CAP)
    },

    // 内部：扣库存 + 生成派发记录 + 联动事件状态/时间线（库存需已校验）
    _pushDispatch(baseId, eventId, type, qty, source = '手动') {
      const base = this.bases.find((b) => b.id === baseId)
      const ev = this.events.find((e) => e.id === eventId)
      if (!base || !ev || qty <= 0) return null
      const path = roughPath(base.lng, base.lat, ev.location.lng, ev.location.lat)
      const record = {
        id: 'dp-' + Date.now() + '-' + ++dpSeq,
        baseId, baseName: base.name, eventId, eventTitle: ev.title,
        lng: ev.location.lng, lat: ev.location.lat,
        type, typeLabel: RESOURCE_TYPES[type].label, qty, unit: RESOURCE_TYPES[type].unit,
        distance: path.distance, minutes: path.minutes, at: nowStr(),
        color: EVENT_TYPES[ev.type].color, source,
        // 道路阻断处置：在途/挂起状态、绕行途经点、来源阻断
        status: 'enroute', via: [], detourBy: null, holdBy: null,
        // 派发闭环：分批签收 / 短缺补派 / 退回入库（在途 = qty - 实收 - 短缺 - 退回 - 撤回）
        signedQty: 0, shortQty: 0, shortReplenished: 0, returnedQty: 0, withdrawnQty: 0,
        signLogs: [], returnLogs: [], withdrawLogs: [], replenishOf: null
      }
      this._moveStock(baseId, type, -qty, source === '短缺补派' || source === '补给补派' ? 'replenish' : 'dispatch',
        { eventId, dispatchId: record.id })
      this.dispatches.unshift(record)
      ev.timeline.push({ at: record.at, text: `${source}派发 ${record.typeLabel} ${qty}${record.unit}👈${base.name}` })
      if (ev.status === 'assessing' || ev.status === 'reported') ev.status = 'dispatching'
      notifyDispatchChanged()
      return record
    },
    // 从资源库派发资源到受灾点（实物库存须扣除其它协同方案的生效预占）
    dispatchResource({ baseId, eventId, type, qty }) {
      const base = this.bases.find((b) => b.id === baseId)
      if (!base) return null
      const cap = this.availableMap[baseId + '|' + type] ?? (base.stock[type] || 0)
      qty = Math.max(0, Math.min(qty, cap))
      if (qty === 0) return null
      return this._pushDispatch(baseId, eventId, type, qty, '手动')
    },
    // 向安置点补给物资（联动转移安置模块，不计入事件需求缺口）
    dispatchToShelter({ baseId, shelterId, shelterName, lng, lat, type, qty }) {
      const base = this.bases.find((b) => b.id === baseId)
      if (!base || qty <= 0) return null
      const cap = this.availableMap[baseId + '|' + type] ?? (base.stock[type] || 0)
      qty = Math.min(qty, cap)
      if (qty === 0) return null
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
      this._moveStock(baseId, type, -qty, 'supply', { dispatchId: record.id })
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
      // 候选基地按运输时长升序，库存不足时跨基地拆单（可用量须扣除生效预占）
      const cands = this.bases
        .filter((b) => (this.availableMap[b.id + '|' + rec.type] ?? 0) > 0)
        .map((b) => ({ b, path: roughPath(b.lng, b.lat, rec.lng, rec.lat) }))
        .sort((x, y) => x.path.minutes - y.path.minutes)
      for (const c of cands) {
        if (need <= 0) break
        const take = Math.min(need, this.availableMap[c.b.id + '|' + rec.type] ?? 0)
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
        this._moveStock(c.b.id, rec.type, -take, 'replenish', { eventId: rec.eventId || null, dispatchId: child.id })
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
      this._moveStock(rec.baseId, rec.type, qty, 'return', { eventId: rec.eventId || null, dispatchId: rec.id })
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
      if ((this.availableMap[newBaseId + '|' + rec.type] ?? 0) < moveQty) return null
      const ob = this.bases.find((b) => b.id === rec.baseId)
      this._moveStock(rec.baseId, rec.type, moveQty, 'reassignOut', { eventId: rec.eventId || null, dispatchId: rec.id })
      this._moveStock(newBaseId, rec.type, -moveQty, 'reassignIn', { eventId: rec.eventId || null, dispatchId: rec.id })
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
      this._moveStock(rec.baseId, rec.type, holdQty, 'hold', { eventId: rec.eventId || null, dispatchId: rec.id })
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
      if (!base || (this.availableMap[rec.baseId + '|' + rec.type] ?? 0) < qty) {
        return { ok: false, msg: `${base?.name || rec.baseName} 可用库存不足（需 ${qty}${rec.unit}），无法续派` }
      }
      this._moveStock(rec.baseId, rec.type, -qty, 'resume', { eventId: rec.eventId || null, dispatchId: rec.id })
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
        this._moveStock(rec.baseId, rec.type, left, 'withdraw', { eventId: rec.eventId || null, dispatchId: rec.id })
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

    /* ---------- 多灾点资源统筹 · 协同编制 ----------
     * 多名调度员在同一会话内共同编制方案；每个方案项即时「预占」库存（不扣实物），
     * 预占有 TTL，超时自动释放、方案项失效；提交时原子锁定（预占转实物扣减 + 冲突重算），
     * 撤销整单时归还全部预占、已生成派发作撤回回库。方案版本与库存变动均入分支回放。 */

    // 切换当前调度员身份（演示多调度员协同）
    switchDispatcher(id) {
      if (DISPATCHERS.some((u) => u.id === id)) this.currentDispatcherId = id
    },
    // 开启协同方案会话（已有编辑中会话时直接复用）
    beginPlanSession(name = '') {
      if (this.planSession && this.planSession.status === 'editing') return this.planSession
      const s = {
        id: 'ps-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
        name: (name || '').trim() || '多灾点统筹方案',
        createdAt: this._nowMs(), at: nowStr(),
        createdBy: this.currentDispatcherId, createdByName: this.currentDispatcher.name,
        status: 'editing', submittedAt: null, revokedAt: null, dispatchIds: []
      }
      this.planSession = s
      this.planResult = null
      this._planAudit('协同方案建会：' + s.name, { kind: 'begin', sessionId: s.id })
      return s
    },
    // 内部：建一个方案项并预占（owner 缺省为当前调度员）
    _addPlanItem({ eventId, baseId, type, qty, owner = null, reserve = true }) {
      const ev = this.events.find((e) => e.id === eventId)
      const base = this.bases.find((b) => b.id === baseId)
      if (!ev || !base || qty <= 0) return null
      const path = roughPath(base.lng, base.lat, ev.location.lng, ev.location.lat)
      const item = {
        id: 'pi-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7),
        eventId, baseId, type, qty: Math.round(qty),
        distance: path.distance, minutes: path.minutes,
        owner: owner || this.currentDispatcherId,
        ownerName: DISPATCHERS.find((u) => u.id === (owner || this.currentDispatcherId))?.name || '',
        createdAt: this._nowMs(), updatedAt: this._nowMs(),
        // 旧方案兼容：无预占字段（reserved 缺省 0）的历史项按旧口径提交时即时校验
        reserved: 0
      }
      this.plan.push(item)
      if (reserve) {
        const r = this._reserveItem(item, item.qty, item.owner)
        item.reserved = r.qty
        if (r.qty < item.qty) item.shortReserve = item.qty - r.qty
      }
      return item
    },
    // 按 灾情等级 → 需求缺口 → 运输时长 生成跨基地分配方案
    // 协同语义：生成即开启会话并逐项预占库存（不扣实物），预占不足的缺口照列、待提交冲突重算
    generatePlan(opts = {}) {
      this.sweepExpiredReservations({ silent: true })
      const session = this.beginPlanSession(opts.name || '')
      const owner = opts.owner || this.currentDispatcherId
      // 可用量 = 实物库存 − 生效预占（含他人已在本方案中的预占）
      const avail = {}
      this.bases.forEach((b) => {
        avail[b.id] = {}
        Object.keys(b.stock).forEach((t) => { avail[b.id][t] = this.availableMap[b.id + '|' + t] ?? 0 })
      })
      // 按等级权重、缺口规模排序事件（缺口已抵扣在途与本方案预占）
      const queue = this.gaps
        .map((g) => ({ ev: this.events.find((e) => e.id === g.eventId), gap: g.gap }))
        .filter((x) => x.ev && x.ev.status !== 'closed')
        .map((x) => ({ ev: x.ev, gap: x.gap, total: Object.values(x.gap).reduce((s, n) => s + n, 0) }))
        .filter((x) => x.total > 0)
        .sort((a, b) => (SEV_WEIGHT[b.ev.severity] - SEV_WEIGHT[a.ev.severity]) || (b.total - a.total))

      let added = 0
      queue.forEach(({ ev, gap }) => {
        Object.entries(gap).forEach(([type, g]) => {
          let need = g
          // 候选基地按运输时长升序，就近优先、跨基地拆分
          const cands = this.bases
            .filter((b) => (avail[b.id][type] || 0) > 0)
            .map((b) => ({ b, path: roughPath(b.lng, b.lat, ev.location.lng, ev.location.lat) }))
            .sort((x, y) => x.path.minutes - y.path.minutes)
          for (const c of cands) {
            if (need <= 0) break
            const take = Math.min(need, avail[c.b.id][type])
            avail[c.b.id][type] -= take
            need -= take
            const item = this._addPlanItem({ eventId: ev.id, baseId: c.b.id, type, qty: take, owner })
            if (item) added++
          }
          // 各基地可用量仍不足：缺口照列（无预占），提交时冲突重算/如实反馈
          if (need > 0) {
            const fb = this.bases
              .map((b) => ({ b, path: roughPath(b.lng, b.lat, ev.location.lng, ev.location.lat) }))
              .sort((x, y) => x.path.minutes - y.path.minutes)[0]?.b
            if (fb) {
              const item = this._addPlanItem({ eventId: ev.id, baseId: fb.id, type, qty: need, owner, reserve: false })
              if (item) { item.shortReserve = need; added++ }
            }
          }
        })
      })
      this._planAudit(`${this.currentDispatcher.name} 生成统筹方案：${added} 个方案项已预占库存`, { kind: 'generate', added })
      return { session, added }
    },
    // 协同加项：当前调度员手动追加一个方案项并预占
    addPlanItem({ eventId, baseId, type, qty }) {
      if (!this.planSession || this.planSession.status !== 'editing') this.beginPlanSession()
      const item = this._addPlanItem({ eventId, baseId, type, qty: Math.max(1, Math.round(qty || 0)) })
      if (!item) return null
      this._planAudit(`${this.currentDispatcher.name} 追加方案项：${RESOURCE_TYPES[item.type]?.label || item.type} ${item.qty}`, { kind: 'add', itemId: item.id })
      return item
    },
    // 人工调整：改数量（同步增减预占）/ 换基地（释放旧预占、在新基地重新预占、重算时长）
    updatePlanItem(id, patch) {
      const it = this.plan.find((p) => p.id === id)
      if (!it) return
      let changed = false
      if (patch.qty != null) {
        const q = Math.max(1, Math.round(patch.qty))
        if (q !== it.qty) {
          if (q > it.qty) {
            // 增量预占：可用量不足则只预占到上限，差额留待提交冲突重算（r.qty 为累计预占）
            const r = this._reserveItem(it, q - it.qty, it.owner)
            it.reserved = r.qty
          } else {
            // 减量：从其生效预占中核减（释放差额）
            this._trimReservation(it, Math.min(it.reserved || 0, q))
            it.reserved = Math.min(it.reserved || 0, q)
          }
          it.qty = q
          it.shortReserve = Math.max(0, it.qty - (it.reserved || 0))
          it.updatedAt = this._nowMs()
          changed = true
        }
      }
      if (patch.baseId && patch.baseId !== it.baseId) {
        const base = this.bases.find((b) => b.id === patch.baseId)
        const ev = this.events.find((e) => e.id === it.eventId)
        if (base && ev) {
          this._releaseItemReservation(it.id, '换基地')
          it.baseId = patch.baseId
          const path = roughPath(base.lng, base.lat, ev.location.lng, ev.location.lat)
          it.distance = path.distance
          it.minutes = path.minutes
          const r = this._reserveItem(it, it.qty, it.owner)
          it.reserved = r.qty
          it.shortReserve = Math.max(0, it.qty - r.qty)
          it.updatedAt = this._nowMs()
          changed = true
        }
      }
      if (changed) this._planAudit(`${this.currentDispatcher.name} 调整方案项（数量/基地）`, { kind: 'update', itemId: id })
    },
    // 内部：把方案项生效预占核减到 targetQty（不低于 0；归零即释放）
    _trimReservation(item, targetQty) {
      const r = this.reservations.find((x) => x.itemId === item.id && x.status === 'active')
      if (!r) return
      r.qty = Math.max(0, Math.round(targetQty))
      if (r.qty === 0) { r.status = 'released'; r.reason = '方案核减' }
    },
    // 删除方案项（归还该项预占）
    removePlanItem(id) {
      const it = this.plan.find((p) => p.id === id)
      if (!it) return
      this._releaseItemReservation(id, '删除方案项')
      this.plan = this.plan.filter((p) => p.id !== id)
      this._planAudit(`${this.currentDispatcher.name} 删除方案项`, { kind: 'remove', itemId: id })
    },
    // 超时清理：把已超时的生效预占落账释放，对应方案项标记失效（保留在方案中，可重新预占/删除）
    sweepExpiredReservations(opts = {}) {
      const now = this._nowMs()
      if (this.reservationTtl == null) return []
      const expired = this.reservations.filter((r) => r.status === 'active' && now - r.createdAt >= this.reservationTtl)
      const released = []
      expired.forEach((r) => {
        r.status = 'expired'
        r.releasedAt = now
        released.push(r)
        const it = this.plan.find((p) => p.id === r.itemId)
        if (it) {
          it.reserved = 0
          it.expired = true
          it.expiredAt = now
        }
      })
      if (released.length && !opts.silent) {
        const who = DISPATCHERS.find((u) => u.id === released[0].owner)?.name || '调度员'
        this._planAudit(`⏰ 预占超时自动释放：${released.length} 笔预占（${who}等编制的方案项需重新预占）`,
          { kind: 'expire', count: released.length })
      }
      return released
    },
    // 重新预占失效/旧方案项（调度员续期；提交前统一复核亦可）
    reReserveItem(id) {
      const it = this.plan.find((p) => p.id === id)
      if (!it) return { ok: false, msg: '方案项不存在' }
      // 旧的失效/生效预占先落账为 released，再按当前可用量新建生效预占
      this.reservations.forEach((r) => {
        if (r.itemId === id && (r.status === 'active' || r.status === 'expired')) { r.status = 'released'; r.reason = '重新预占' }
      })
      const r = this._reserveItem(it, it.qty, it.owner)
      it.reserved = r.qty
      it.shortReserve = Math.max(0, it.qty - r.qty)
      it.expired = false
      it.expiredAt = null
      it.updatedAt = this._nowMs()
      this._planAudit(`${this.currentDispatcher.name} 重新预占方案项：${r.qty}${RESOURCE_TYPES[it.type]?.unit || ''}`,
        { kind: 'rereserve', itemId: id, qty: r.qty })
      return { ok: true, reserved: r.qty, short: it.shortReserve }
    },
    // 清空方案（归还全部生效/超时预占；会话保留为编辑态以便重新编制）
    clearPlan() {
      this.plan.forEach((p) => this._releaseItemReservation(p.id, '清空方案'))
      this.plan = []
      this._planAudit(`${this.currentDispatcher.name} 清空统筹方案，全部预占归还`, { kind: 'clear' })
    },
    // 内部：提交前归一化——旧方案项（无预占字段）按当前可用量即时补预占
    _ensureReservations() {
      this.plan.forEach((it) => {
        if (it.reserved == null) it.reserved = 0 // 旧记录兼容
        if (it.owner == null) { it.owner = this.currentDispatcherId; it.ownerName = this.currentDispatcher.name }
        if (it.reserved <= 0 && !it.expired) {
          const r = this._reserveItem(it, it.qty, it.owner)
          it.reserved = r.qty
          it.shortReserve = Math.max(0, it.qty - r.qty)
        }
      })
    },
    // 提交：先清理超时 → 统一校验 → 预占锁定 + 冲突重分配 → 原子批量生成派发
    // 任一项的计算在提交快照内完成，全部 takes 落库后才生效；仍不足的缺口如实反馈
    submitPlan() {
      if (!this.plan.length) return null
      if (this.planSession && this.planSession.status !== 'editing') return null
      // 1) 超时预占落账释放（失效项不参与，须重新预占后再提交）
      this.sweepExpiredReservations()
      const dead = this.plan.filter((p) => p.expired)
      if (dead.length) {
        return { ok: false, msg: `${dead.length} 个方案项预占已超时失效，请重新预占后再提交`, expiredItems: dead.map((p) => p.id) }
      }
      // 2) 旧方案项兼容补预占
      this._ensureReservations()

      // 3) 提交快照：实物库存与全部生效预占（计算阶段不改状态，保证原子性）
      const evOf = (id) => this.events.find((e) => e.id === id)
      const items = [...this.plan].sort((a, b) => {
        const wa = SEV_WEIGHT[evOf(a.eventId)?.severity] || 0
        const wb = SEV_WEIGHT[evOf(b.eventId)?.severity] || 0
        return wb - wa || a.minutes - b.minutes
      })
      // 各 基地+类型：预占池 / 自由库存池（实物 − 生效预占）。两池互不重叠，分别核减避免重复占用。
      const reservedPool = {}
      this.reservations.filter((r) => r.status === 'active').forEach((r) => {
        const k = r.baseId + '|' + r.type
        reservedPool[k] = (reservedPool[k] || 0) + r.qty
      })
      const free = {}
      this.bases.forEach((b) => {
        Object.keys(b.stock).forEach((t) => {
          const k = b.id + '|' + t
          // 期间实物可能被其它动作挪用：预占池超出实物时截断，自由池不出现负值
          reservedPool[k] = Math.min(reservedPool[k] || 0, b.stock[t] || 0)
          free[k] = Math.max(0, (b.stock[t] || 0) - (reservedPool[k] || 0))
        })
      })
      const takes = []
      const result = { ok: true, total: items.length, direct: 0, realloc: 0, unmet: [], at: nowStr(), dispatchIds: [] }
      // 从自由库存池出库（本基地兜底 / 跨基地冲突重算）
      const consumeFree = (baseId, type, qty, eventId) => {
        if (qty <= 0) return
        takes.push({ baseId, eventId, type, qty })
        const k = baseId + '|' + type
        free[k] = Math.max(0, (free[k] ?? 0) - qty)
      }
      items.forEach((it) => {
        const ev = evOf(it.eventId)
        const k = it.baseId + '|' + it.type
        let need = it.qty
        let moved = false
        // 3.1 预占保障：该项已预占部分从「预占池」锁定（不动自由池）
        const own = Math.min(need, it.reserved || 0, reservedPool[k] || 0)
        if (own > 0) {
          takes.push({ baseId: it.baseId, eventId: it.eventId, type: it.type, qty: own })
          reservedPool[k] -= own
          need -= own
        }
        // 3.2 预占不足：本基地自由库存兜底
        if (need > 0) {
          const ownFree = Math.min(need, free[k] ?? 0)
          if (ownFree > 0) { consumeFree(it.baseId, it.type, ownFree, it.eventId); need -= ownFree; moved = true }
        }
        // 3.3 冲突重算：本基地仍不足，按运输时长从其他基地的自由库存重分配
        if (need > 0 && ev) {
          const alts = this.bases
            .filter((b) => b.id !== it.baseId)
            .map((b) => ({ b, path: roughPath(b.lng, b.lat, ev.location.lng, ev.location.lat), f: free[b.id + '|' + it.type] ?? 0 }))
            .filter((x) => x.f > 0)
            .sort((x, y) => x.path.minutes - y.path.minutes)
          for (const a of alts) {
            if (need <= 0) break
            const t = Math.min(need, a.f)
            consumeFree(a.b.id, it.type, t, it.eventId)
            need -= t
            moved = true
          }
        }
        if (moved || (it.reserved || 0) < it.qty) result.realloc++
        else result.direct++
        if (need > 0) result.unmet.push({ eventTitle: ev?.title || it.eventId, type: it.type, qty: need })
      })

      // 4) 原子提交：仅核销本方案项的预占（其它会话/游离预占不受影响）→ 一次性扣库存并生成派发
      const planItemIds = new Set(items.map((it) => it.id))
      this.reservations.filter((r) => r.status === 'active' && planItemIds.has(r.itemId)).forEach((r) => {
        r.status = 'committed'
        r.committedAt = this._nowMs()
      })
      takes.forEach((t) => {
        const rec = this._pushDispatch(t.baseId, t.eventId, t.type, t.qty, '统筹协同')
        if (rec) result.dispatchIds.push(rec.id)
      })

      const session = this.planSession
      if (session) {
        session.status = 'submitted'
        session.submittedAt = this._nowMs()
        session.dispatchIds = result.dispatchIds
      }
      this.plan = []
      this.planResult = {
        total: result.total, ok: result.direct, realloc: result.realloc,
        unmet: result.unmet, at: result.at, dispatchIds: result.dispatchIds
      }
      this._planAudit(`✅ 协同方案原子提交：${takes.length} 批派发已生成（直接 ${result.direct} · 冲突重算 ${result.realloc}）`
        + (result.unmet.length ? `，${result.unmet.length} 项缺口未满足` : ''),
        { kind: 'submit', takes: takes.length, unmet: result.unmet.length })
      // 提交后通知道路阻断模块即时复核新派发
      notifyDispatchChanged()
      return this.planResult
    },
    // 撤销协同方案：已生成的整批派发作撤回（在途余量回库，签收/短缺账目留档），会话标记已撤销
    // 若方案尚在编辑态，则仅归还全部预占、作废方案
    undoPlan(reason = '调度员撤销方案') {
      const session = this.planSession
      // 编辑态撤销：归还预占
      if (session && session.status === 'editing') {
        const n = this.plan.length
        this.plan.forEach((p) => this._releaseItemReservation(p.id, '撤销方案'))
        this.plan = []
        session.status = 'revoked'
        session.revokedAt = this._nowMs()
        session.revokeReason = reason
        this._planAudit(`🚫 撤销协同方案（编制中）：${n} 个方案项预占全部归还`, { kind: 'undo', mode: 'editing' })
        return { ok: true, mode: 'editing', released: n }
      }
      // 已提交撤销：整批派发作撤回回库
      if (session && session.status === 'submitted') {
        let back = 0
        const ids = session.dispatchIds || []
        ids.forEach((id) => {
          const rec = this.dispatches.find((d) => d.id === id)
          if (rec) back += this._withdrawRecord(rec, '协同方案撤销：' + reason)
        })
        session.status = 'revoked'
        session.revokedAt = this._nowMs()
        session.revokeReason = reason
        this._planAudit(`🚫 撤销协同方案（已提交）：${ids.length} 批派发作撤回，在途余量 ${back} 已回库`,
          { kind: 'undo', mode: 'submitted', dispatches: ids.length, back })
        notifyDispatchChanged()
        return { ok: true, mode: 'submitted', dispatches: ids.length, back }
      }
      return { ok: false, msg: '没有可撤销的协同方案' }
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
      // 该事件在协同方案中尚未提交的方案项一并移除、预占归还
      const pending = this.plan.filter((p) => p.eventId === eventId)
      if (!rows.length && !pending.length) return
      pending.forEach((p) => this._releaseItemReservation(p.id, '重置事件资源'))
      if (pending.length) this.plan = this.plan.filter((p) => p.eventId !== eventId)
      let back = 0
      rows.forEach((d) => { back += this._withdrawRecord(d, '重置事件资源') })
      ev.timeline.push({ at: nowStr(), text: `🚫 重置资源：${rows.length} 条派发撤回，在途余量 ${back} 已回库，历史签收/退回记录保留`
        + (pending.length ? `；${pending.length} 个未提交方案项移除、预占归还` : '') })
      notifyDispatchChanged()
    }
  }
})
