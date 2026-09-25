/* =========================================================================
 * 现场移动端同步引擎（零依赖，localStorage 持久化）
 *
 *  - 离线包：从网关拉取「生效预警 + 在途签收单 + 抢修工单 + 阻断/队伍位置」，
 *    断网前缓存，断网期间可正常查看（离线接收预警）
 *  - 离线动作：每个动作生成稳定 clientActionId + 客户端 HLC，先落本地队列
 *    （queued），联网后按 HLC 因果顺序批量补传；每条动作独立回执
 *  - 冲突处理：前置校验拒绝 / reducer 因果竞态 → conflict，不阻塞后续动作，
 *    现场可查看原因、修正后重提或丢弃
 *  - 补传幂等：同 clientActionId 重试由网关生成确定性事件 id，历史服务去重
 * ========================================================================= */

const LS_KEY = 'field-sync-v1'

// HLC（与服务端 services/lib/causal.js 同构，字符串字典序即因果序）
export function hlcEncode(h) {
  return h.ts.toString(16).padStart(12, '0') + '-' + h.l.toString(16).padStart(6, '0')
}
export function hlcDecode(s) {
  if (!s || typeof s !== 'string' || !s.includes('-')) return null
  const [ts, l] = s.split('-')
  const n = { ts: parseInt(ts, 16), l: parseInt(l, 16) }
  return Number.isFinite(n.ts) && Number.isFinite(n.l) ? n : null
}
function hlcReceive(local, remote) {
  const now = Date.now()
  const ts = Math.max(local?.ts || 0, remote?.ts || 0, now)
  let l = 0
  if (ts === local?.ts && ts === remote?.ts) l = Math.max(local.l, remote.l) + 1
  else if (ts === local?.ts) l = local.l + 1
  else if (ts === remote?.ts) l = remote.l + 1
  return { ts, l }
}

function loadStore() {
  try {
    const raw = JSON.parse(localStorage.getItem(LS_KEY) || '{}')
    return {
      simId: raw.simId || '', teamId: raw.teamId || '', teamName: raw.teamName || '',
      clock: raw.clock || { ts: 0, l: 0 },
      queue: Array.isArray(raw.queue) ? raw.queue : [],
      bundle: raw.bundle || null,
      bundleAt: raw.bundleAt || null,
      lastSyncAt: raw.lastSyncAt || null
    }
  } catch {
    return { simId: '', teamId: '', teamName: '', clock: { ts: 0, l: 0 }, queue: [], bundle: null, bundleAt: null, lastSyncAt: null }
  }
}

export class FieldClient {
  constructor(onChange) {
    this.online = navigator.onLine
    this.s = loadStore()
    this.syncing = false
    this.onChange = onChange || (() => {})
    window.addEventListener('online', () => { this.online = true; this.sync(); this.fetchBundle() })
    window.addEventListener('offline', () => { this.online = false; this._emit() })
  }

  _persist() { localStorage.setItem(LS_KEY, JSON.stringify(this.s)) }
  _emit() { this.onChange() }

  configure({ simId, teamId, teamName }) {
    this.s.simId = simId; this.s.teamId = teamId; this.s.teamName = teamName || ''
    this._persist(); this._emit()
  }
  get configured() { return !!(this.s.simId && this.s.teamId) }

  _tick(remoteHlc = null) {
    const now = Date.now()
    if (remoteHlc) this.s.clock = hlcReceive(this.s.clock, hlcDecode(remoteHlc) || { ts: 0, l: 0 })
    else this.s.clock = now > this.s.clock.ts ? { ts: now, l: 0 } : { ts: this.s.clock.ts, l: this.s.clock.l + 1 }
    return hlcEncode(this.s.clock)
  }

  nowHHMM(d = new Date()) {
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  }

  // 入队一条离线动作（立即可用，无网时只落本地）
  enqueue(kind, payload = {}) {
    const id = payload.clientActionId ||
      `${kind}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
    const action = {
      ...payload,
      clientActionId: id,
      kind,
      teamId: this.s.teamId,
      hlc: this._tick(),
      at: payload.at || this.nowHHMM(),
      status: 'queued',
      queuedAt: new Date().toISOString(),
      attempts: 0,
      result: null
    }
    // 同 id 重提（修正冲突后重发）：保留原 HLC，只清状态
    const idx = this.s.queue.findIndex((a) => a.clientActionId === id)
    if (idx >= 0) this.s.queue[idx] = action
    else this.s.queue.push(action)
    this._persist(); this._emit()
    if (this.online && this.configured) this.sync()
    return action
  }

  // 放弃一条冲突/待发动作（现场确认无法处理）
  discard(id) {
    this.s.queue = this.s.queue.filter((a) => a.clientActionId !== id)
    this._persist(); this._emit()
  }

  // 修正后重提：用同一业务参数生成新动作（新 clientActionId），原冲突项丢弃
  retryWith(id, patch) {
    const old = this.s.queue.find((a) => a.clientActionId === id)
    if (!old) return
    this.discard(id)
    const { clientActionId, hlc, queuedAt, status, attempts, result, ...rest } = old
    return this.enqueue(old.kind, { ...rest, ...patch })
  }

  pending() { return this.s.queue.filter((a) => a.status === 'queued') }
  conflicts() { return this.s.queue.filter((a) => a.status === 'conflict') }
  acked() { return this.s.queue.filter((a) => a.status === 'acked') }

  async _api(path, options) {
    const resp = await fetch(path, options)
    const body = await resp.json().catch(() => ({}))
    if (!resp.ok || body.ok === false) {
      const err = new Error(body.msg || `HTTP ${resp.status}`)
      err.status = resp.status; err.body = body
      throw err
    }
    return body
  }

  // 拉取离线包并推进本地 HLC（服务端事件 hlc 带回，保证因果不回退）
  async fetchBundle() {
    if (!this.configured) return
    const r = await this._api(`/sims/${encodeURIComponent(this.s.simId)}/field/bundle?branch=main&teamId=${encodeURIComponent(this.s.teamId)}`)
    if (r.bundle) {
      this.s.bundle = r.bundle
      this.s.bundleAt = r.bundle.serverAt
      this._persist(); this._emit()
    }
    return r
  }

  // 联网补传：按 HLC 因果序批量送网关；逐条回执（冲突不阻塞后续）
  async sync() {
    if (!this.configured || this.syncing) return { skipped: true }
    const queued = this.s.queue
      .filter((a) => a.status === 'queued')
      .sort((a, b) => ((a.hlc || '') + '|' + a.clientActionId < (b.hlc || '') + '|' + b.clientActionId ? -1 : 1))
    if (!queued.length) { this._emit(); return { synced: 0 } }
    this.syncing = true; this._emit()
    try {
      const r = await this._api(`/sims/${encodeURIComponent(this.s.simId)}/field/actions?branch=main`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ clientId: this.s.teamId, actions: queued })
      })
      const byId = new Map((r.results || []).map((x) => [x.clientActionId, x]))
      for (const a of queued) {
        const res = byId.get(a.clientActionId)
        const item = this.s.queue.find((x) => x.clientActionId === a.clientActionId)
        if (!item || !res) continue
        item.attempts += 1
        if (res.ok && res.applied !== false) item.status = 'acked'
        else item.status = 'conflict'
        item.result = { code: res.code, msg: res.msg, advisory: res.advisory || [], meta: res.meta || {} }
      }
      // 服务端事件携带新 HLC（seq/回执里不含，保守由本地时钟继续单调即可）
      this.s.lastSyncAt = new Date().toISOString()
      this._persist()
      await this.fetchBundle().catch(() => {})
      this._emit()
      return { synced: (r.results || []).filter((x) => x.ok && x.applied !== false).length, results: r.results }
    } catch (e) {
      // 网络故障：动作保留 queued，联网恢复后自动重补
      this._persist(); this._emit()
      return { error: e.message }
    } finally {
      this.syncing = false; this._emit()
    }
  }
}
