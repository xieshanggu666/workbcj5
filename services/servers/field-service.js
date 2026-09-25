#!/usr/bin/env node
// 现场同步服务：移动端现场协同闭环的服务端门户
//  - 队伍注册 / 离线动作入队（本地持久化，断网期间现场端也可由网关直推）
//  - 联网补传：按 HLC 因果序逐条推送网关应用，回执落账（acked / conflict）
//  - 离线包代理：预警 + 在途任务 + 位置，供移动端断网前缓存（离线接收预警）
//  - 崩溃恢复：重启后队列状态从 JSONL 流水重建，未确认动作不丢
import { createApp, ok, fail, listen, call, waitFor } from '../lib/http.js'
import { PORTS, DATA_DIR } from '../lib/config.js'
import { FieldOutbox } from '../lib/fieldOutbox.js'

const outbox = new FieldOutbox(`${DATA_DIR}/field`)

const GW = (method, p, body) => call(method, PORTS.gateway, p, body)

const app = createApp([
  ['GET', '/healthz', async (req, res) => ok(res, { service: 'field' })],

  // 队伍注册（幂等）：登记即入队一条 registerTeam 动作并立即尝试同步
  ['POST', '/sims/:simId/teams/:teamId/register', async (req, res, { simId, teamId }, query, body) => {
    const r = outbox.enqueue(simId, teamId, {
      clientActionId: body.clientActionId || `reg-${teamId}`,
      kind: 'registerTeam', teamId,
      name: body.name, capabilities: body.capabilities || [],
      at: body.at
    })
    const sync = await syncTeam(simId, teamId, { branchId: body.branchId })
    ok(res, { registered: true, duplicated: r.duplicated, sync })
  }],

  // 离线动作入队（断网时现场端本地也持有同样队列；联网后调用 /sync 补传）
  ['POST', '/sims/:simId/teams/:teamId/actions', async (req, res, { simId, teamId }, query, body) => {
    const list = Array.isArray(body.actions) ? body.actions : [body.action || body]
    if (!list.length || list.some((a) => !a?.kind)) {
      return fail(res, 400, 'bad-actions', 'actions 需为带 kind 的对象或数组')
    }
    const accepted = []
    for (const a of list) {
      try {
        const r = outbox.enqueue(simId, teamId, { ...a, teamId: a.teamId || teamId })
        accepted.push({ clientActionId: r.action.clientActionId, status: r.action.status, duplicated: r.duplicated })
      } catch (e) {
        return fail(res, e.status || 400, e.code || 'bad-action', e.message)
      }
    }
    ok(res, { accepted, queued: outbox.pending(simId, teamId).length })
  }],

  ['GET', '/sims/:simId/teams/:teamId/outbox', async (req, res, { simId, teamId }, { status }) => {
    ok(res, { actions: outbox.list(simId, teamId, status ? { status } : {}) })
  }],

  ['GET', '/sims/:simId/field-teams', async (req, res, { simId }) => {
    ok(res, { teams: outbox.listTeams(simId) })
  }],

  // 联网补传：把 queued 动作按因果序（HLC）逐条送网关，回执落账
  ['POST', '/sims/:simId/teams/:teamId/sync', async (req, res, { simId, teamId }, query, body) => {
    const r = await syncTeam(simId, teamId, { branchId: body?.branchId })
    ok(res, r)
  }],

  // 离线包（代理网关）：断网前拉取缓存 → 离线期间可查看预警/任务并继续入队动作
  ['GET', '/sims/:simId/teams/:teamId/bundle', async (req, res, { simId, teamId }, { branch }) => {
    const r = await GW('GET', `/sims/${encodeURIComponent(simId)}/field/bundle?branch=${encodeURIComponent(branch || 'main')}&teamId=${encodeURIComponent(teamId)}`)
    if (r.status !== 200) return fail(res, r.status, r.body?.code || 'bundle-failed', r.body?.msg || '离线包获取失败')
    ok(res, r.body)
  }]
])

// 同步一支队伍的待发动作：逐条推网关（网关按最新态势校验 + 稳定 id 幂等），
// 成功/冲突都落账；网关不可达时保留队列稍后重试（不丢动作）
async function syncTeam(simId, teamId, { branchId = 'main' } = {}) {
  const pending = outbox.pending(simId, teamId)
  if (!pending.length) return { synced: 0, remaining: 0, results: [] }
  const results = []
  // 批量提交（网关逐条应用），单批失败按连接故障处理：整体保留重试
  const r = await GW('POST', `/sims/${encodeURIComponent(simId)}/field/actions?branch=${encodeURIComponent(branchId)}`, {
    clientId: teamId,
    actions: pending.map((a) => ({ ...a, teamId: a.teamId || teamId }))
  }).catch((e) => ({ status: 502, body: { code: 'gateway-down', msg: e.message } }))
  if (r.status !== 200) {
    pending.forEach((a) => outbox.mark(simId, teamId, a.clientActionId, { attempts: (a.attempts || 0) + 1 }))
    return { synced: 0, remaining: pending.length, deferred: true, reason: r.body?.msg || `gateway ${r.status}` }
  }
  const byId = new Map((r.body.results || []).map((x) => [x.clientActionId, x]))
  let synced = 0
  for (const a of pending) {
    const res = byId.get(a.clientActionId)
    if (!res) continue
    if (res.ok && res.applied !== false) {
      outbox.mark(simId, teamId, a.clientActionId, { status: 'acked', result: res, attempts: (a.attempts || 0) + 1 })
      synced++
    } else if (res.ok && res.applied === false) {
      // 事件入账但业务前置未满足（因果竞态）：记冲突，待现场/指挥员处置，不自动重试
      outbox.mark(simId, teamId, a.clientActionId, { status: 'conflict', result: res, attempts: (a.attempts || 0) + 1 })
    } else {
      outbox.mark(simId, teamId, a.clientActionId, { status: 'conflict', result: res, attempts: (a.attempts || 0) + 1 })
    }
    results.push({ clientActionId: a.clientActionId, kind: a.kind, ...pickResult(res) })
  }
  outbox.prune(simId, teamId)
  return { synced, remaining: outbox.pending(simId, teamId).length, results }
}

function pickResult(res) {
  return {
    ok: !!res.ok, applied: res.applied !== false,
    msg: res.msg || (res.advisory || []).join('；') || '',
    advisory: res.advisory || [], meta: res.meta || {}
  }
}

waitFor(PORTS.gateway, '/healthz', 100, 200).catch(() => null)
  .then(() => listen(app, PORTS.field, 'field'))
  .catch((e) => { console.error(e); process.exit(1) })
