import { defineStore } from 'pinia'
import { useCommandStore, roughPath } from '@/store/command'
import {
  SCENARIOS, SEVERITY, ALERT_ROLES, ALERT_LEVEL_ROLES, ALERT_STATUS, FEED_METRICS, RESOURCE_TYPES
} from '@/mock/data'

/* =========================================================================
 * 实时预警协同模块
 *
 * 数据接入：气象站（雨量/水位/风速）与地质监测（位移/含水率/微震）按场景挂载，
 *           支持「监测模拟」自动走数与手动注入读数两种接入方式。
 * 阈值评估：读数越过 黄/橙/红 阈值自动发布预警单；持续恶化自动升级、
 *           回落至阈值以下自动解除；同一监测点同时只存在一张生效预警单。
 * 多角色告警：按预警等级扇出通知（值班长/调度员/现场队伍/指挥长/专家组/安置点），
 *           各角色逐一签收确认，全员确认后预警单转入「已确认」响应态。
 * 处置闭环：确认（逐角色/一键）、升级（补发新角色通知、需重新确认）、
 *           撤销（误报，留痕）、解除（监测回落或人工确认风险消除）。
 * 回写联动：预警全生命周期写入关联事件时间线；事件严重等级随生效预警联动
 *           抬升/回落；确认后事件状态自动推进（已上报→研判中）；红色预警确认
 *           自动按需求缺口联动调度出库；大屏统计实时汇总预警态势。
 * ========================================================================= */

let waSeq = 0
const nowStr = () => new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })

// 等级权重（升级/回落比较）
const LEVEL_W = { blue: 1, yellow: 2, orange: 3, red: 4 }
const LEVEL_ORDER = ['blue', 'yellow', 'orange', 'red']
const levelLabel = (lv) => SEVERITY.find((s) => s.value === lv)?.label || lv
const levelColor = (lv) => SEVERITY.find((s) => s.value === lv)?.color || '#9e9e9e'
const statusMeta = (v) => ALERT_STATUS.find((s) => s.value === v) || { label: v, color: '#9e9e9e' }

// 读数所属预警等级（未达黄色阈值返回 null = 正常）
export function levelOfValue(feed, value = feed.value) {
  const t = feed.thresholds || {}
  if (t.red != null && value >= t.red) return 'red'
  if (t.orange != null && value >= t.orange) return 'orange'
  if (t.yellow != null && value >= t.yellow) return 'yellow'
  return null
}

export const useWarningStore = defineStore('warning', {
  state: () => ({
    feeds: [],            // 监测站数据接入（气象/地质）
    alerts: [],           // 预警单
    monitorOn: false,     // 监测模拟开关
    monitorTimer: null,
    focusAlertId: null    // 调度面板联动定位的预警单
  }),

  getters: {
    // 生效中的预警单（待确认 + 已确认）
    activeAlerts: (s) => s.alerts.filter((a) => a.status === 'issued' || a.status === 'confirmed'),
    pendingAlerts: (s) => s.alerts.filter((a) => a.status === 'issued'),
    // 超阈监测点数量（大屏「监测异常」）
    abnormalFeeds() { return this.feeds.filter((f) => levelOfValue(f)).length },
    // 大屏统计
    stats() {
      return {
        active: this.activeAlerts.length,
        pending: this.pendingAlerts.length,
        stations: this.feeds.length,
        abnormal: this.abnormalFeeds
      }
    },
    feedOf: (s) => (id) => s.feeds.find((f) => f.id === id) || null,
    alertOf: (s) => (id) => s.alerts.find((a) => a.id === id) || null,
    // 监测点当前生效预警单
    activeAlertOfFeed: (s) => (feedId) =>
      s.alerts.find((a) => a.feedId === feedId && (a.status === 'issued' || a.status === 'confirmed')) || null,
    // 事件关联的生效预警单（取等级最高者，供事件详情/列表角标）
    topAlertOfEvent() {
      return (eventId) => {
        const list = this.activeAlerts.filter((a) => a.eventId === eventId)
        if (!list.length) return null
        return list.reduce((m, a) => (LEVEL_W[a.level] > LEVEL_W[m.level] ? a : m), list[0])
      }
    },
    // 预警单待签收角色数
    pendingAckOf: () => (alert) => (alert?.notices || []).filter((n) => !n.ackAt).length
  },

  actions: {
    _cmd() { return useCommandStore() },
    _alert(id) { return this.alerts.find((a) => a.id === id) },
    _log(a, text) { a.log.push({ at: nowStr(), text }) },
    _evLog(eventId, text) {
      const ev = this._cmd().events.find((e) => e.id === eventId)
      if (ev) ev.timeline.push({ at: nowStr(), text })
      return ev
    },
    levelText(lv) { return levelLabel(lv) },
    levelColorOf(lv) { return levelColor(lv) },
    statusText(v) { return statusMeta(v).label },
    statusColor(v) { return statusMeta(v).color },
    metricOf(metric) { return FEED_METRICS[metric] || { label: metric, unit: '', icon: '📡', kind: 'weather' } },
    feedLevel(feed) { return levelOfValue(feed) },

    // 场景载入：挂载该场景监测站，清空预警单并停止监测模拟
    load() {
      this.stopMonitor()
      const cmd = this._cmd()
      const s = SCENARIOS.find((x) => x.id === cmd.scenarioId)
      this.feeds = (s?.feeds || []).map((f) => ({ ...f, thresholds: { ...f.thresholds }, updatedAt: nowStr() }))
      this.alerts = []
      this.focusAlertId = null
    },

    /* ---------- 数据接入：监测模拟 + 手动注入 ---------- */

    startMonitor() {
      if (this.monitorOn) return
      this.monitorOn = true
      this.monitorTimer = setInterval(() => this._tick(), 3000)
    },
    stopMonitor() {
      this.monitorOn = false
      if (this.monitorTimer) { clearInterval(this.monitorTimer); this.monitorTimer = null }
    },
    // 监测走数：围绕当前值随机波动（轻微上行偏置，演示预警触发），逐站评估阈值
    _tick() {
      this.feeds.forEach((f) => {
        const drift = f.drift || 1
        f.value = Math.max(0, Math.round((f.value + (Math.random() - 0.42) * drift) * 100) / 100)
        this._evaluateFeed(f)
      })
    },
    // 手动注入监测读数（模拟外部数据平台推送）
    ingestReading(feedId, value) {
      const feed = this.feeds.find((f) => f.id === feedId)
      if (!feed) return { ok: false, msg: '监测点不存在' }
      value = Number(value)
      if (!Number.isFinite(value) || value < 0) return { ok: false, msg: '读数必须为非负数值' }
      feed.value = Math.round(value * 100) / 100
      this._evaluateFeed(feed)
      return { ok: true, feed, level: levelOfValue(feed) }
    },

    /* ---------- 阈值评估：自动发布 / 自动升级 / 自动解除 ---------- */

    _evaluateFeed(feed) {
      feed.updatedAt = nowStr()
      const level = levelOfValue(feed)
      const active = this.activeAlertOfFeed(feed.id)
      if (level && !active) {
        this._issueAlert({ feed, level, source: '监测自动' })
      } else if (level && LEVEL_W[level] > LEVEL_W[active.level]) {
        this._escalate(active, level, `监测数据升至 ${feed.value}${this.metricOf(feed.metric).unit}`)
      } else if (!level && active) {
        this._close(active, '监测数据回落至阈值以下')
      }
    },

    /* ---------- 预警发布（人工 + 自动共用内部入口） ---------- */

    // 人工发布预警（不依赖监测点）
    issueAlert({ eventId, level, reason = '' } = {}) {
      const cmd = this._cmd()
      const ev = cmd.events.find((e) => e.id === eventId)
      if (!ev) return { ok: false, msg: '请选择关联事件' }
      if (!LEVEL_ORDER.includes(level)) return { ok: false, msg: '请选择预警等级' }
      const dup = this.activeAlerts.find((a) => a.eventId === eventId && !a.feedId && a.level === level)
      if (dup) return { ok: false, msg: `该事件已存在同等级生效预警（${dup.id}），可对其升级或撤销` }
      const alert = this._issueAlert({ eventId, level, source: '人工发布', reason: (reason || '').trim() })
      return { ok: true, alert }
    },

    // 内部：建单 + 多角色扇出 + 事件回写（时间线/等级）
    _issueAlert({ feed = null, eventId = null, level, source, reason = '' }) {
      const cmd = this._cmd()
      const evId = feed ? feed.eventId : eventId
      const ev = cmd.events.find((e) => e.id === evId)
      if (!ev) return null
      const metric = feed ? this.metricOf(feed.metric) : null
      const alert = {
        id: 'wa-' + Date.now() + '-' + ++waSeq,
        feedId: feed?.id || null,
        station: feed?.station || '人工研判',
        kind: feed ? this.metricOf(feed.metric).kind : 'manual',
        metric: feed?.metric || null,
        metricLabel: metric?.label || '人工预警',
        unit: metric?.unit || '',
        eventId: ev.id,
        eventTitle: ev.title,
        level,
        status: 'issued',
        value: feed ? feed.value : null,
        source,
        notices: this._fanOut(level),
        suggestion: this._buildSuggestion(ev),
        suggestionApplied: false,
        raisedFrom: null,
        issuedAt: nowStr(),
        confirmedAt: null, closedAt: null, revokedAt: null,
        revokeReason: '',
        log: []
      }
      this.alerts.unshift(alert)
      const trigger = feed
        ? `${feed.station} ${metric.label} ${feed.value}${metric.unit} 超${levelLabel(level)}阈值`
        : `人工研判发布${reason ? `：${reason}` : ''}`
      this._log(alert, `🚨 ${levelLabel(level)}预警发布（${source}）：${trigger}，已通知 ${this._roleNames(alert)}`)
      this._evLog(ev.id, `🚨 ${levelLabel(level)}预警发布：${trigger}`)
      this._raiseEventSeverity(alert)
      this.focusAlertId = alert.id
      return alert
    },

    // 按等级扇出多角色通知
    _fanOut(level) {
      return (ALERT_LEVEL_ROLES[level] || []).map((role) => ({
        role,
        label: ALERT_ROLES[role].label,
        icon: ALERT_ROLES[role].icon,
        channel: ALERT_ROLES[role].channel,
        at: nowStr(),
        ackAt: null,
        ackBy: null
      }))
    },
    _roleNames(alert) {
      return alert.notices.map((n) => n.label).join('、')
    },

    /* ---------- 确认：逐角色签收 / 一键全签 ---------- */

    // 角色签收确认；全员签收后预警单转「已确认」并触发联动回写
    confirmAlert(alertId, { role, by = '' } = {}) {
      const a = this._alert(alertId)
      if (!a) return { ok: false, msg: '预警单不存在' }
      if (a.status === 'revoked') return { ok: false, msg: '预警已撤销，不能再确认' }
      if (a.status === 'closed') return { ok: false, msg: '预警已解除，不能再确认' }
      const notice = a.notices.find((n) => n.role === role)
      if (!notice) return { ok: false, msg: '该角色不在本预警通知范围' }
      if (notice.ackAt) return { ok: false, msg: `${notice.label} 已签收，不能重复确认` }
      notice.ackAt = nowStr()
      notice.ackBy = (by || '').trim() || notice.label
      this._log(a, `✅ ${notice.label} 签收确认（${notice.ackBy}）`)
      this._afterAck(a)
      return { ok: true, alert: a, confirmed: a.status === 'confirmed' }
    },

    // 一键全部签收（指挥长权限，演示便捷操作）
    confirmAll(alertId, { by = '指挥长' } = {}) {
      const a = this._alert(alertId)
      if (!a) return { ok: false, msg: '预警单不存在' }
      if (a.status === 'revoked') return { ok: false, msg: '预警已撤销，不能再确认' }
      if (a.status === 'closed') return { ok: false, msg: '预警已解除，不能再确认' }
      const left = a.notices.filter((n) => !n.ackAt)
      if (!left.length) return { ok: false, msg: '全部角色均已签收' }
      left.forEach((n) => {
        n.ackAt = nowStr()
        n.ackBy = by
      })
      this._log(a, `✅ ${by} 一键确认：剩余 ${left.length} 个角色全部签收`)
      this._afterAck(a)
      return { ok: true, alert: a, confirmed: a.status === 'confirmed' }
    },

    // 全员签收后：转已确认 + 事件状态/调度联动回写
    _afterAck(a) {
      if (a.notices.some((n) => !n.ackAt)) return
      a.status = 'confirmed'
      a.confirmedAt = nowStr()
      this._log(a, `🤝 全员确认完毕，预警响应生效`)
      const ev = this._evLog(a.eventId, `🤝 ${levelLabel(a.level)}预警全员确认，响应生效`)
      // 回写事件状态：已上报 → 研判中（确认即响应）
      if (ev && ev.status === 'reported') {
        ev.status = 'assessing'
        ev.timeline.push({ at: nowStr(), text: `状态变更：已上报 → 研判中（预警确认联动）` })
      }
      // 回写调度：红色预警确认后按需求缺口自动联动出库
      if (a.level === 'red' && !a.suggestionApplied) this.applySuggestion(a.id)
    },

    /* ---------- 升级：等级抬升 + 新角色补发 + 重新确认 ---------- */

    // 人工升级（升一级；监测自动升级走 _escalate）
    escalateAlert(alertId, { reason = '' } = {}) {
      const a = this._alert(alertId)
      if (!a) return { ok: false, msg: '预警单不存在' }
      if (a.status === 'revoked') return { ok: false, msg: '预警已撤销，不能升级' }
      if (a.status === 'closed') return { ok: false, msg: '预警已解除，不能升级' }
      const idx = LEVEL_ORDER.indexOf(a.level)
      if (idx >= LEVEL_ORDER.length - 1) return { ok: false, msg: '已是最高等级（Ⅰ级·红色），不能继续升级' }
      this._escalate(a, LEVEL_ORDER[idx + 1], (reason || '').trim() || '人工研判升级')
      return { ok: true, alert: a }
    },

    // 内部：等级抬升，补发新增角色通知，状态回到待确认，事件等级联动
    _escalate(a, toLevel, reason) {
      const from = a.level
      const oldRoles = new Set(a.notices.map((n) => n.role))
      const added = (ALERT_LEVEL_ROLES[toLevel] || []).filter((r) => !oldRoles.has(r))
      added.forEach((role) => {
        a.notices.push({
          role,
          label: ALERT_ROLES[role].label,
          icon: ALERT_ROLES[role].icon,
          channel: ALERT_ROLES[role].channel,
          at: nowStr(),
          ackAt: null,
          ackBy: null
        })
      })
      a.level = toLevel
      // 升级后新增角色需签收：回到待确认（已有签收保留）
      if (added.length) a.status = 'issued'
      this._log(a, `⬆️ 预警升级：${levelLabel(from)} → ${levelLabel(toLevel)}（${reason}）`
        + (added.length ? `，新增通知 ${added.map((r) => ALERT_ROLES[r].label).join('、')}` : ''))
      this._evLog(a.eventId, `⬆️ 预警升级：${levelLabel(from)} → ${levelLabel(toLevel)}（${reason}）`)
      this._raiseEventSeverity(a)
    },

    /* ---------- 撤销 / 解除 ---------- */

    // 撤销：误报或研判不成立，留痕退出大屏统计，事件等级联动回落
    revokeAlert(alertId, { reason = '' } = {}) {
      const a = this._alert(alertId)
      if (!a) return { ok: false, msg: '预警单不存在' }
      if (a.status === 'revoked') return { ok: false, msg: '预警已撤销，不能重复操作' }
      if (a.status === 'closed') return { ok: false, msg: '预警已解除，不能再撤销' }
      const text = (reason || '').trim() || '研判为误报'
      a.status = 'revoked'
      a.revokedAt = nowStr()
      a.revokeReason = text
      this._log(a, `⚪ 预警撤销：${text}`)
      this._evLog(a.eventId, `⚪ ${levelLabel(a.level)}预警撤销：${text}`)
      this._settleEventSeverity(a.eventId)
      return { ok: true, alert: a }
    },

    // 解除：风险消除（监测回落自动解除走 _close）
    closeAlert(alertId, { reason = '' } = {}) {
      const a = this._alert(alertId)
      if (!a) return { ok: false, msg: '预警单不存在' }
      if (a.status === 'closed') return { ok: false, msg: '预警已解除，不能重复操作' }
      if (a.status === 'revoked') return { ok: false, msg: '预警已撤销，不能再解除' }
      this._close(a, (reason || '').trim() || '现场核实风险消除')
      return { ok: true, alert: a }
    },
    _close(a, reason) {
      a.status = 'closed'
      a.closedAt = nowStr()
      this._log(a, `🟢 预警解除：${reason}`)
      this._evLog(a.eventId, `🟢 ${levelLabel(a.level)}预警解除：${reason}`)
      this._settleEventSeverity(a.eventId)
    },

    /* ---------- 回写：事件等级联动 / 调度联动 ---------- */

    // 生效预警抬升事件严重等级（记录抬升前等级，供回落）
    _raiseEventSeverity(a) {
      const ev = this._cmd().events.find((e) => e.id === a.eventId)
      if (!ev) return
      if (ev.baseSeverity == null) ev.baseSeverity = ev.severity
      if (LEVEL_W[a.level] > LEVEL_W[ev.severity]) {
        if (a.raisedFrom == null) a.raisedFrom = ev.severity
        const from = ev.severity
        ev.severity = a.level
        ev.timeline.push({ at: nowStr(), text: `🔺 事件等级联动调整：${levelLabel(from)} → ${levelLabel(a.level)}（预警生效）` })
      }
    },
    // 预警撤销/解除后：按剩余生效预警重算事件等级（无更高预警则回落至基准等级）
    _settleEventSeverity(eventId) {
      const ev = this._cmd().events.find((e) => e.id === eventId)
      if (!ev || ev.baseSeverity == null) return
      const top = this.activeAlerts
        .filter((x) => x.eventId === eventId)
        .reduce((m, x) => Math.max(m, LEVEL_W[x.level]), 0)
      const target = top > LEVEL_W[ev.baseSeverity]
        ? LEVEL_ORDER[top - 1]
        : ev.baseSeverity
      if (target !== ev.severity) {
        const from = ev.severity
        ev.severity = target
        ev.timeline.push({ at: nowStr(), text: `🔻 事件等级联动回落：${levelLabel(from)} → ${levelLabel(target)}（预警解除/撤销）` })
      }
    },

    // 由事件需求缺口生成调度建议（缺口最大的 3 类物资）
    _buildSuggestion(ev) {
      const cmd = this._cmd()
      const gap = (cmd.gaps.find((g) => g.eventId === ev.id) || {}).gap || {}
      return Object.entries(gap)
        .filter(([, q]) => q > 0)
        .sort((x, y) => y[1] - x[1])
        .slice(0, 3)
        .map(([type, qty]) => ({ type, qty }))
    },

    // 调度联动：按建议清单就近出库（库存不足跨基地拆单），来源标记「预警联动」
    applySuggestion(alertId) {
      const a = this._alert(alertId)
      if (!a) return { ok: false, msg: '预警单不存在' }
      if (a.status === 'revoked') return { ok: false, msg: '预警已撤销，不能联动调度' }
      if (a.status === 'closed') return { ok: false, msg: '预警已解除，不能联动调度' }
      if (a.suggestionApplied) return { ok: false, msg: '调度建议已执行，不能重复派发' }
      const cmd = this._cmd()
      const ev = cmd.events.find((e) => e.id === a.eventId)
      if (!ev) return { ok: false, msg: '关联事件不存在' }
      if (ev.status === 'closed') return { ok: false, msg: '事件已结案，不能联动调度' }
      // 执行前按最新缺口重算建议（确认期间可能已有其它派发）
      a.suggestion = this._buildSuggestion(ev)
      if (!a.suggestion.length) {
        a.suggestionApplied = true
        this._log(a, `📦 调度联动：需求已保障，无需追加派发`)
        return { ok: true, sent: [], msg: '需求已保障，无需追加派发' }
      }
      const sent = []
      const unmet = []
      a.suggestion.forEach((s) => {
        let need = s.qty
        const cands = cmd.bases
          .filter((b) => (b.stock[s.type] || 0) > 0)
          .map((b) => ({ b, path: roughPath(b.lng, b.lat, ev.location.lng, ev.location.lat) }))
          .sort((x, y) => x.path.minutes - y.path.minutes)
        for (const c of cands) {
          if (need <= 0) break
          const take = Math.min(need, c.b.stock[s.type])
          const rec = cmd._pushDispatch(c.b.id, ev.id, s.type, take, '预警联动')
          if (rec) { sent.push(rec); need -= take }
        }
        if (need > 0) unmet.push({ type: s.type, qty: need })
      })
      a.suggestionApplied = true
      const made = sent.reduce((sum, r) => sum + r.qty, 0)
      const text = made > 0
        ? `📦 调度联动：按预警建议出库 ${sent.length} 批共 ${made} 单位（${sent.map((r) => `${r.typeLabel}${r.qty}${r.unit}👈${r.baseName}`).join('、')}）`
        : `📦 调度联动：各基地库存不足，建议物资未能出库`
      this._log(a, text + (unmet.length ? `；仍缺 ${unmet.map((u) => `${RESOURCE_TYPES[u.type]?.label || u.type} ${u.qty}`).join('、')}` : ''))
      this._evLog(a.eventId, text)
      return { ok: made > 0, sent, unmet, msg: text }
    },

    focusAlert(id) { this.focusAlertId = id }
  }
})
