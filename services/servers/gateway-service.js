#!/usr/bin/env node
// 推演网关：指挥员/前端唯一业务入口
//  - 多人并行推演：会话(clientId) ↔ 推演(sim) ↔ 分支(branch)
//  - 业务命令 → 领域事件（命令工厂前置校验 + 阻断联动编排）
//  - 经事件采集服务写入（乱序缓冲/HLC/WAL），从回放服务读取最新态势
//  - 真实调度隔离：真实流 'live' 只能经带外令牌的 /live/* 直连接口访问，推演命令一律拒绝
import { createApp, ok, fail, listen, call, waitFor } from '../lib/http.js'
import { PORTS, LIVE_SIM_ID, LIVE_WRITE_TOKEN } from '../lib/config.js'
import {
  buildCommand, scanImpacts, optionsFor, applyImpactEvents,
  clearBlockRerouteEvents, resumeHeldEvents, buildFieldAction
} from '../domain/commands.js'
import { bedMap, dispatchParts } from '../domain/reducer.js'

const app = createApp([
  ['GET', '/healthz', async (req, res) => ok(res, { service: 'gateway' })],

  /* ---------------- 推演会话管理 ---------------- */

  // 创建推演（多人可随后加入同一会话，也可各自分叉）
  ['POST', '/sims', async (req, res, params, query, body) => {
    const r = await call('POST', PORTS.history, '/sims', {
      id: body.id, name: body.name, scenarioId: body.scenarioId
    })
    if (r.status !== 200) return fail(res, r.status, r.body?.code || 'error', r.body?.msg || '创建失败')
    const session = await ensureSession(body.clientId, r.body.sim.id, 'main')
    ok(res, { sim: r.body.sim, clientId: session.clientId })
  }],

  ['GET', '/sims', async (req, res) => {
    const r = await call('GET', PORTS.history, '/sims')
    proxy(res, r)
  }],

  // 断线续演：用 clientId 拿回会话与分支位置
  ['POST', '/sims/:simId/resume', async (req, res, { simId }, query, body) => {
    if (simId === LIVE_SIM_ID) return fail(res, 403, 'live-protected', '真实调度流不接受推演续演')
    const r = await call('POST', PORTS.history, `/sims/${encodeURIComponent(simId)}/resume`, { clientId: body.clientId })
    if (r.status !== 200) return fail(res, r.status, r.body?.code, r.body?.msg)
    const session = await ensureSession(body.clientId, simId, body.branchId || 'main')
    // 带回当前末端态势，客户端可立即重绘
    const st = await replayState(simId, body.branchId || 'main')
    ok(res, { ...r.body, clientId: session.clientId, state: st?.state || null })
  }],

  // 分叉新分支（多人各自推演，原分支保留）
  ['POST', '/sims/:simId/fork', async (req, res, { simId }, query, body) => {
    if (simId === LIVE_SIM_ID) return fail(res, 403, 'live-protected', '真实调度流禁止分叉')
    const r = await call('POST', PORTS.history, `/sims/${encodeURIComponent(simId)}/branches`, {
      parentBranchId: body.parentBranchId || 'main', name: body.name, atSeq: body.atSeq
    })
    if (r.status !== 200) return fail(res, r.status, r.body?.code, r.body?.msg)
    if (body.clientId) await ensureSession(body.clientId, simId, r.body.branch.id)
    ok(res, { branch: r.body.branch, clientId: body.clientId || null })
  }],

  ['GET', '/sims/:simId/branches', async (req, res, { simId }) => {
    const r = await call('GET', PORTS.history, `/sims/${encodeURIComponent(simId)}/branches`)
    proxy(res, r)
  }],

  // 切换某客户端正在推演的分支
  ['POST', '/sims/:simId/switch', async (req, res, { simId }, query, body) => {
    if (!body.branchId) return fail(res, 400, 'need-branch', '缺少 branchId')
    const session = await ensureSession(body.clientId, simId, body.branchId)
    const st = await replayState(simId, body.branchId)
    ok(res, { clientId: session.clientId, branchId: body.branchId, state: st?.state || null })
  }],

  /* ---------------- 读态势（回放服务投影） ---------------- */

  ['GET', '/sims/:simId/state', async (req, res, { simId }, { branch, atSeq }) => {
    const r = await call('GET', PORTS.replay,
      `/sims/${encodeURIComponent(simId)}/branches/${encodeURIComponent(branch || 'main')}/replay${atSeq != null ? `?atSeq=${atSeq}` : ''}`)
    proxy(res, r)
  }],
  ['GET', '/sims/:simId/timeline', async (req, res, { simId }, { branch }) => {
    const r = await call('GET', PORTS.replay, `/sims/${encodeURIComponent(simId)}/branches/${encodeURIComponent(branch || 'main')}/timeline`)
    proxy(res, r)
  }],
  ['GET', '/sims/:simId/diff', async (req, res, { simId }, { branch, atSeq }) => {
    const r = await call('GET', PORTS.replay,
      `/sims/${encodeURIComponent(simId)}/branches/${encodeURIComponent(branch || 'main')}/diff${atSeq != null ? `?atSeq=${atSeq}` : ''}`)
    proxy(res, r)
  }],
  ['GET', '/sims/:simId/compare', async (req, res, { simId }, { a, b }) => {
    const r = await call('GET', PORTS.replay,
      `/sims/${encodeURIComponent(simId)}/compare?a=${encodeURIComponent(a || 'main')}&b=${encodeURIComponent(b || '')}`)
    proxy(res, r)
  }],
  ['GET', '/sims/:simId/poll', async (req, res, { simId }, { branch, afterSeq }) => {
    const r = await call('GET', PORTS.replay,
      `/sims/${encodeURIComponent(simId)}/branches/${encodeURIComponent(branch || 'main')}/poll?afterSeq=${encodeURIComponent(afterSeq ?? '-1')}`)
    proxy(res, r)
  }],

  /* ---------------- 阻断影响评估 / 处置编排 ---------------- */

  ['POST', '/sims/:simId/blocks/:blockId/assess', async (req, res, { simId, blockId }, { branch }, body) => {
    const branchId = body.branchId || branch || 'main'
    const st = await replayState(simId, branchId)
    if (!st) return fail(res, 404, 'no-state', '态势不可用')
    const impacts = scanImpacts(st.state, blockId)
    const withOptions = impacts.map((i) => ({ ...i, options: optionsFor(st.state, blockId, i.kind, i.id) }))
    ok(res, { blockId, impacts: withOptions })
  }],

  // 执行单个处置（执行前按最新态势复核；自动降级 detour→reassign→suspend）
  ['POST', '/sims/:simId/blocks/:blockId/apply', async (req, res, { simId, blockId }, { branch }, body) => {
    const branchId = body.branchId || branch || 'main'
    const { kind, id, action, baseId, shelterId, clientId } = body
    if (!['dispatch', 'batch'].includes(kind)) return fail(res, 400, 'bad-kind', 'kind 必须是 dispatch / batch')
    const st = await replayState(simId, branchId)
    if (!st) return fail(res, 404, 'no-state', '态势不可用')
    const built = applyImpactEvents(st.state, blockId, kind, id, { action, baseId, shelterId })
    if (!built.ok) return fail(res, built.status || 409, 'no-plan', built.msg)
    const pushed = await pushEvents(simId, branchId, built.events, { clientId, at: body.at })
    if (!pushed.ok) return fail(res, pushed.status, pushed.code, pushed.msg)
    ok(res, { applied: built.plan, adjusted: built.adjusted, ...pushed.body })
  }],

  // 恢复通行：清除阻断 + 剩余生效阻断视角下联合重排路线 + 工单联动
  ['POST', '/sims/:simId/blocks/:blockId/clear', async (req, res, { simId, blockId }, { branch }, body) => {
    const branchId = body.branchId || branch || 'main'
    const st = await replayState(simId, branchId)
    if (!st) return fail(res, 404, 'no-state', '态势不可用')
    const built = clearBlockRerouteEvents(st.state, blockId)
    const pushed = await pushEvents(simId, branchId, built.events, { clientId: body.clientId, at: body.at })
    if (!pushed.ok) return fail(res, pushed.status, pushed.code, pushed.msg)
    ok(res, { rerouted: built.events.length - 1, ...pushed.body })
  }],

  // 一键续派挂起任务（路线与库存复核）
  ['POST', '/sims/:simId/resume-held', async (req, res, { simId }, { branch }, body) => {
    const branchId = body.branchId || branch || 'main'
    const st = await replayState(simId, branchId)
    if (!st) return fail(res, 404, 'no-state', '态势不可用')
    const built = resumeHeldEvents(st.state)
    const pushed = await pushEvents(simId, branchId, built.events, { clientId: body.clientId, at: body.at })
    if (!pushed.ok) return fail(res, pushed.status, pushed.code, pushed.msg)
    ok(res, { resumed: built.events.length, keptHeld: built.kept, ...pushed.body })
  }],

  /* ---------------- 通用业务命令入口 ---------------- */

  ['POST', '/sims/:simId/commands/:command', async (req, res, { simId, command }, { branch }, body) => {
    if (simId === LIVE_SIM_ID) {
      return fail(res, 403, 'live-protected',
        '推演命令不得写入真实调度流；真实操作请使用带 X-Live-Token 的 /live/commands 通道')
    }
    const branchId = body.branchId || branch || 'main'
    const st = await replayState(simId, branchId)
    if (!st) return fail(res, 404, 'no-state', '推演态势不可用，请先确认会话')
    const built = buildCommand(st.state, command, body)
    if (!built.ok) return fail(res, built.status || 400, 'command-rejected', built.msg)
    const pushed = await pushEvents(simId, branchId, built.events, { clientId: body.clientId, at: body.at, day: body.day })
    if (!pushed.ok) return fail(res, pushed.status, pushed.code, pushed.msg)
    ok(res, { command, events: pushed.body.events, seq: pushed.body.seq, conflicts: pushed.body.conflicts })
  }],

  /* ---------------- 移动端现场协同（离线接收预警 / 联网补传） ---------------- */

  // 现场端离线包：当前态势精简 + 生效预警（按队伍待签收过滤），供断网前缓存
  ['GET', '/sims/:simId/field/bundle', async (req, res, { simId }, { branch, teamId }) => {
    const branchId = branch || 'main'
    const st = await replayState(simId, branchId)
    if (!st) return fail(res, 404, 'no-state', '态势不可用')
    const s = st.state
    const warnings = s.warnings
      .filter((w) => ['active', 'responded'].includes(w.status))
      .map((w) => ({
        id: w.id, title: w.title, level: w.level, source: w.source,
        eventId: w.eventId, issuedAt: w.issuedAt, targets: w.targets,
        acks: w.acks, status: w.status,
        // 该队伍视角的待签收角色（升级补发后需要重新签收）
        pendingRoles: w.targets.filter((r) => !w.acks[r])
      }))
    ok(res, {
      atSeq: st.atSeq, branchId,
      bundle: {
        serverAt: Date.now(),
        warnings,
        // 与本队伍相关的在途任务（签收物资 / 抢修工单），离线期间可直接操作
        dispatches: s.dispatches
          .filter((d) => !['done', 'withdrawn'].includes(d.status))
          .map((d) => ({ id: d.id, type: d.type, typeLabel: d.typeLabel, qty: d.qty, unit: d.unit, status: d.status, baseName: d.baseName, dest: d.eventTitle || d.shelterName, outstanding: dispatchParts(d).outstanding })),
        orders: s.orders
          .filter((o) => ['dispatched', 'accepted', 'done'].includes(o.status))
          .map((o) => ({ id: o.id, blockId: o.blockId, blockName: o.blockName, status: o.status, progress: o.progress, deadline: o.deadline })),
        blocks: s.blocks.filter((b) => b.status === 'active').map((b) => ({ id: b.id, name: b.name })),
        events: s.events.map((e) => ({ id: e.id, title: e.title, severity: e.severity, status: e.status })),
        teams: s.teams.map((t) => ({ id: t.id, name: t.name, position: t.position }))
      },
      mine: teamId ? warnings.filter((w) => w.targets.includes('field') || w.targets.includes(teamId)).length : null
    })
  }],

  // 联网补传：现场离线动作按因果顺序逐条应用；每条独立回执，冲突不阻塞后续动作
  ['POST', '/sims/:simId/field/actions', async (req, res, { simId }, { branch }, body) => {
    if (simId === LIVE_SIM_ID) return fail(res, 403, 'live-protected', '现场动作不得直写真实流')
    const branchId = body.branchId || branch || 'main'
    const actions = Array.isArray(body.actions) ? body.actions : [body.action]
    if (!actions.length) return fail(res, 400, 'empty-actions', '缺少现场动作')
    const results = []
    for (const action of actions) {
      const aid = action.clientActionId
      // 逐条动作读取最新态势：前一动作引发的路线/库存变化立即对后续动作可见
      // eslint-disable-next-line no-await-in-loop
      const st = await replayState(simId, branchId, true)
      if (!st) { results.push({ clientActionId: aid, ok: false, code: 'no-state', msg: '态势不可用' }); continue }
      const conflictsBefore = (st.state.conflicts || []).length
      const built = buildFieldAction(st.state, action)
      if (!built.ok) { results.push({ clientActionId: aid, ok: false, code: 'rejected', status: built.status, msg: built.msg, ...(built.meta || {}) }); continue }
      // 复合事件（如道路封闭→自动绕行）用稳定 id 前缀，保证重试幂等
      // eslint-disable-next-line no-await-in-loop
      const pushed = await pushEvents(simId, branchId, built.events, {
        clientId: body.clientId || action.teamId, at: action.at, day: action.day,
        idPrefix: aid, hlc: action.hlc
      })
      if (!pushed.ok) { results.push({ clientActionId: aid, ok: false, code: pushed.code, msg: pushed.msg }); continue }
      // reducer 层冲突（并发竞态/因果乱序）：事件幂等入账但业务前置未满足。
      // conflicts 为追加账，取本动作新增的切片判定
      const newConflicts = (pushed.body.conflicts || []).slice(conflictsBefore)
      results.push({
        clientActionId: aid, ok: true,
        events: pushed.body.events, seq: pushed.body.seq,
        conflicts: pushed.body.conflicts,
        applied: newConflicts.length === 0,
        meta: built.meta || {},
        // 复合动作内部冲突（如自动绕行在执行瞬间失效）提示现场/指挥员
        advisory: newConflicts.map((c) => c.reason)
      })
    }
    ok(res, { results, branchId })
  }],

  /* ---------------- 真实调度（生产流）：独立通道 + 带外令牌 + 与推演隔离 ---------------- */

  ['POST', '/live/commands/:command', async (req, res, params, query, body) => {
    if (!LIVE_WRITE_TOKEN) return fail(res, 403, 'token-disabled', '未配置 LIVE_WRITE_TOKEN，真实流写入关闭（演练安全模式）')
    if (req.headers['x-live-token'] !== LIVE_WRITE_TOKEN) return fail(res, 401, 'bad-token', '真实调度写入令牌无效')
    // 确保 live 流已按场景初始化（带令牌经历史服务建立，独立于所有推演分支）
    await ensureLive(req, body.scenarioId)
    // 初始化后回放服务可能短暂未感知新流：强制刷新并短暂重试
    let st = await replayState(LIVE_SIM_ID, 'main', true)
    for (let i = 0; i < 8 && !st; i++) {
      await new Promise((r) => setTimeout(r, 120))
      st = await replayState(LIVE_SIM_ID, 'main', true)
    }
    if (!st) return fail(res, 502, 'no-live-state', '真实流态势不可用')
    const built = buildCommand(st.state, params.command, body)
    if (!built.ok) return fail(res, built.status || 400, 'command-rejected', built.msg)
    // 直写历史服务的 /live/events（绕过采集缓冲，带令牌），不经任何推演分支
    const resp = await call('POST', PORTS.history, '/live/events', {
      branchId: 'main', events: withChain(built.events, body.at, body.day)
    }, { 'x-live-token': LIVE_WRITE_TOKEN })
    if (resp.status !== 200) return fail(res, resp.status, resp.body?.code, resp.body?.msg)
    ok(res, { command: params.command, seq: resp.body.seq, conflicts: resp.body.conflicts, live: true })
  }],
  ['GET', '/live/state', async (req, res) => {
    const r = await call('GET', PORTS.replay, `/sims/${LIVE_SIM_ID}/branches/main/replay`)
    proxy(res, r)
  }]
])

/* ---------------- 辅助 ---------------- */

function proxy(res, r) {
  res.writeHead(r.status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(r.body))
}

async function replayState(simId, branchId, refresh = false) {
  const q = refresh ? '?refresh=1' : ''
  const r = await call('GET', PORTS.replay, `/sims/${encodeURIComponent(simId)}/branches/${encodeURIComponent(branchId)}/replay${q}`)
  if (r.status !== 200) return null
  return r.body
}

async function ensureSession(clientId, simId, branchId) {
  if (!clientId) return { clientId: null }
  const r = await call('POST', PORTS.ingestion, '/sessions', { clientId, simId, branchId })
  if (r.status === 200) return r.body
  return { clientId }
}

async function ensureLive(req, scenarioId) {
  const headers = {}
  if (req.headers['x-live-token']) headers['x-live-token'] = req.headers['x-live-token']
  const exist = await call('GET', PORTS.history, '/live')
  if (exist.status !== 200) {
    const init = await call('POST', PORTS.history, '/live/init', { scenarioId: scenarioId || 's1' }, headers)
    if (init.status !== 200) throw new Error('真实流初始化失败：' + (init.body?.msg || init.status))
  }
}

// 同批多事件串 after 链，保证编排事件（如清除阻断→路线重排→工单办结）按因果顺序应用。
// 事件 id 在采集端允许显式指定；idPrefix 提供确定性幂等 id（现场补传重试去重），
// 否则生成稳定临时 id（非业务 payload id，避免幂等碰撞）。
function withChain(events, at, day, { idPrefix, hlc } = {}) {
  let prevId = null
  return events.map((e, i) => {
    const id = idPrefix
      ? `${idPrefix}#${i}`
      : `cmd-${Date.now().toString(36)}-${i}-${Math.random().toString(36).slice(2, 7)}`
    const out = { ...e, id, after: prevId ? [prevId] : (e.after || []) }
    if (at && !out.at) out.at = at
    if (day != null && out.day == null) out.day = day
    // 现场离线动作携带客户端 HLC：补传时按真实发生时间归位，而非补传时刻
    if (hlc && i === 0 && !out.hlc) out.hlc = hlc
    prevId = id
    return out
  })
}

// 推送一批领域事件：经采集服务（乱序缓冲 + WAL），随后强制冲刷并回读确认
async function pushEvents(simId, branchId, events, { clientId, at, day, idPrefix, hlc } = {}) {
  const payload = { clientId, events: withChain(events, at, day, { idPrefix, hlc }) }
  const r = await call('POST', PORTS.ingestion,
    `/sims/${encodeURIComponent(simId)}/branches/${encodeURIComponent(branchId)}/events`, payload)
  if (r.status !== 200) return { ok: false, status: r.status, code: r.body?.code, msg: r.body?.msg }
  // 立即冲刷乱序窗口，保证命令返回时事件已落历史日志
  const f = await call('POST', PORTS.ingestion, '/flush', { simId, branchId })
  if (f.status !== 200) return { ok: false, status: 502, code: 'flush-failed', msg: '采集冲刷失败' }
  // 回读确认末端 seq
  const h = await call('GET', PORTS.history, `/sims/${encodeURIComponent(simId)}/branches/${encodeURIComponent(branchId)}/events?afterSeq=-1`)
  if (h.status !== 200) return { ok: false, status: 502, code: 'history-unavailable', msg: h.body?.msg || '' }
  const last = h.body.events[h.body.events.length - 1]
  // 回读折叠后的冲突账（并发竞态最终守恒）
  const st = await replayState(simId, branchId, true)
  return {
    ok: true,
    body: {
      seq: h.body.seq,
      events: r.body.events,
      conflicts: st?.state?.conflicts || []
    }
  }
}

Promise.all([
  waitFor(PORTS.ingestion, '/healthz', 100, 200).catch(() => null),
  waitFor(PORTS.history, '/healthz', 100, 200).catch(() => null),
  waitFor(PORTS.replay, '/healthz', 100, 200).catch(() => null)
]).then(() => listen(app, PORTS.gateway, 'gateway'))
  .catch((e) => { console.error(e); process.exit(1) })
