import fs from 'node:fs'
import path from 'node:path'
import { ensureDir } from './storage.js'
import { hlcNow, hlcEncode, hlcDecode, hlcReceive } from './causal.js'

/* =========================================================================
 * FieldOutbox —— 现场端离线动作队列（也可作为现场同步服务的服务端持久层）
 *
 * 文件布局（按 simId/teamId 隔离）：
 *   <root>/<simId>/<teamId>/queue.jsonl   动作流水（queued → sent → acked / conflict）
 *   <root>/<simId>/<teamId>/clock.json     本地 HLC（离线也能单调推进）
 *
 * 设计要点：
 *  - 客户端生成稳定 clientActionId：联网重试 / 进程重启补传单条动作只处理一次
 *  - 动作在入队时即盖本地 HLC（设备时钟 + 逻辑计数），补传时由采集端据此与
 *    其它节点合并因果序；after[] 让"签收 after 派发到达"即便父事件晚到也拓扑归位
 *  - 仅追加 JSONL + 状态索引；崩溃后从流水重建内存表
 * ========================================================================= */

export class FieldOutbox {
  constructor(rootDir) {
    this.root = ensureDir(rootDir)
    this.queues = new Map() // key -> Map<actionId, action>
    this.clocks = new Map() // key -> { ts, l }
    this._recover()
  }

  _key(simId, teamId) { return `${simId}__${teamId}` }
  _dir(simId, teamId) { return ensureDir(path.join(this.root, simId, teamId)) }
  _queueFile(simId, teamId) { return path.join(this._dir(simId, teamId), 'queue.jsonl') }
  _clockFile(simId, teamId) { return path.join(this._dir(simId, teamId), 'clock.json') }

  _recover() {
    for (const simId of fs.readdirSync(this.root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)) {
      const simDir = path.join(this.root, simId)
      for (const teamId of fs.readdirSync(simDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)) {
        const key = this._key(simId, teamId)
        const map = new Map()
        for (const line of this._readLines(this._queueFile(simId, teamId))) {
          if (line.op === 'upsert') map.set(line.action.clientActionId, line.action)
          else if (line.op === 'remove') map.delete(line.actionId)
        }
        this.queues.set(key, map)
        try { this.clocks.set(key, JSON.parse(fs.readFileSync(this._clockFile(simId, teamId), 'utf8'))) } catch { /* 无时钟文件从 0 开始 */ }
      }
    }
  }

  *_readLines(file) {
    let text
    try { text = fs.readFileSync(file, 'utf8') } catch { return }
    for (const line of text.split('\n')) {
      const t = line.trim()
      if (!t) continue
      try { yield JSON.parse(t) } catch { /* 崩溃尾部半行跳过 */ }
    }
  }

  _append(simId, teamId, row) {
    fs.appendFileSync(this._queueFile(simId, teamId), JSON.stringify(row) + '\n')
  }

  _map(simId, teamId) {
    const key = this._key(simId, teamId)
    if (!this.queues.has(key)) this.queues.set(key, new Map())
    return this.queues.get(key)
  }

  _clock(simId, teamId) {
    const key = this._key(simId, teamId)
    if (!this.clocks.has(key)) this.clocks.set(key, { ts: 0, l: 0 })
    return this.clocks.get(key)
  }
  _saveClock(simId, teamId) {
    fs.writeFileSync(this._clockFile(simId, teamId), JSON.stringify(this.clocks.get(this._key(simId, teamId))))
  }

  // 推进本地 HLC：离线动作入队 / 收到服务器事件回执时调用
  tick(simId, teamId, remoteHlc = null) {
    const c = this._clock(simId, teamId)
    const next = remoteHlc ? hlcReceive(c, hlcDecode(remoteHlc) || { ts: 0, l: 0 }) : hlcNow(c)
    this.clocks.set(this._key(simId, teamId), next)
    this._saveClock(simId, teamId)
    return hlcEncode(next)
  }

  // 入队一条离线动作（幂等：同 clientActionId 不重复入队，已终态的不可改）
  enqueue(simId, teamId, action, { remoteHlc = null } = {}) {
    const id = action.clientActionId
    if (!id) throw Object.assign(new Error('缺少 clientActionId'), { status: 400, code: 'missing-action-id' })
    const map = this._map(simId, teamId)
    const existed = map.get(id)
    if (existed && existed.status !== 'queued' && existed.status !== 'conflict') {
      return { action: existed, duplicated: true }
    }
    // 冲突的动作允许现场修正后以同 id 重提
    const hlc = action.hlc || (existed?.hlc) || this.tick(simId, teamId, remoteHlc)
    const rec = {
      ...action,
      clientActionId: id,
      teamId: action.teamId || teamId,
      simId,
      hlc,
      status: existed?.status === 'conflict' ? 'queued' : (existed?.status || 'queued'),
      attempts: existed?.attempts || 0,
      queuedAt: existed?.queuedAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      result: existed?.status === 'conflict' ? null : (existed?.result || null)
    }
    map.set(id, rec)
    this._append(simId, teamId, { op: 'upsert', action: rec })
    return { action: rec, duplicated: false }
  }

  list(simId, teamId, { status } = {}) {
    const map = this._map(simId, teamId)
    let out = [...map.values()]
    if (status) out = out.filter((a) => a.status === status)
    // 因果序：HLC 升序（同批 after 由网关拓扑保证）
    return out.sort((a, b) => ((a.hlc || '') + '|' + a.clientActionId < (b.hlc || '') + '|' + b.clientActionId ? -1 : 1))
  }

  pending(simId, teamId) { return this.list(simId, teamId, { status: 'queued' }) }

  get(simId, teamId, id) { return this._map(simId, teamId).get(id) || null }

  // 补传处理结果回写
  mark(simId, teamId, id, patch) {
    const map = this._map(simId, teamId)
    const rec = map.get(id)
    if (!rec) return null
    Object.assign(rec, patch, { updatedAt: new Date().toISOString() })
    map.set(id, rec)
    this._append(simId, teamId, { op: 'upsert', action: rec })
    return rec
  }

  // 已完成动作清理（保留最近 N 条备查），冲突项不自动清理
  prune(simId, teamId, keep = 50) {
    const map = this._map(simId, teamId)
    const done = [...map.values()].filter((a) => a.status === 'acked').sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
    const remove = done.slice(0, Math.max(0, done.length - keep))
    remove.forEach((a) => {
      map.delete(a.clientActionId)
      this._append(simId, teamId, { op: 'remove', actionId: a.clientActionId })
    })
    return remove.length
  }

  listTeams(simId) {
    const out = []
    const simDir = path.join(this.root, simId)
    try {
      for (const teamId of fs.readdirSync(simDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)) {
        const all = this.list(simId, teamId)
        out.push({
          teamId,
          total: all.length,
          queued: all.filter((a) => a.status === 'queued').length,
          conflict: all.filter((a) => a.status === 'conflict').length,
          acked: all.filter((a) => a.status === 'acked').length
        })
      }
    } catch { /* 推演目录不存在 */ }
    return out
  }
}
