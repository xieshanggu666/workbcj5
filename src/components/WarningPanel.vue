<template>
  <div class="warning-panel">
    <!-- 监测数据接入 -->
    <div class="panel-sub">
      📡 监测数据接入（气象 / 地质）
      <button
        class="monitor-btn"
        :class="{ on: warning.monitorOn }"
        @click="warning.monitorOn ? warning.stopMonitor() : warning.startMonitor()"
      >{{ warning.monitorOn ? '⏹ 监测模拟' : '▶ 监测模拟' }}</button>
    </div>
    <div class="feeds">
      <div v-if="!warning.feeds.length" class="tiny-empty">当前场景未配置监测站</div>
      <div
        v-for="f in warning.feeds" :key="f.id"
        class="feed-card"
        :class="{ alarm: !!warning.feedLevel(f) }"
        :style="feedBorder(f)"
      >
        <div class="fd-head">
          <span class="fd-icon">{{ warning.metricOf(f.metric).icon }}</span>
          <div class="fd-info">
            <strong>{{ f.station }}</strong>
            <p>{{ warning.metricOf(f.metric).label }} · 关联「{{ eventTitle(f.eventId) }}」</p>
          </div>
          <span class="fd-value" :style="{ color: feedColor(f) }">
            {{ f.value }}<i>{{ warning.metricOf(f.metric).unit }}</i>
          </span>
        </div>
        <div class="fd-th">
          <span
            v-for="lv in ['yellow', 'orange', 'red']" :key="lv"
            class="th-chip"
            :class="{ hit: thresholdHit(f, lv) }"
            :style="thresholdHit(f, lv) ? { background: warning.levelColorOf(lv), borderColor: warning.levelColorOf(lv) } : {}"
          >{{ warning.levelText(lv).slice(0, 3) }}≥{{ f.thresholds[lv] }}</span>
          <span class="fd-kind">{{ warning.metricOf(f.metric).kind === 'geo' ? '地质' : '气象' }}</span>
        </div>
      </div>
    </div>

    <!-- 手动注入读数（模拟外部数据平台推送） -->
    <div class="ingest">
      <div class="form-title">手动注入监测读数</div>
      <div class="ingest-row">
        <select v-model="ingestForm.feedId">
          <option v-for="f in warning.feeds" :key="f.id" :value="f.id">
            {{ f.station }}（{{ warning.metricOf(f.metric).label }}）
          </option>
        </select>
        <input type="number" min="0" step="0.1" v-model.number="ingestForm.value" placeholder="读数" />
        <button class="mini-btn" :disabled="!ingestForm.feedId" @click="onIngest">注入</button>
      </div>
      <p v-if="ingestFb" class="fb" :class="ingestFb.ok ? 'ok' : 'err'">{{ ingestFb.msg }}</p>
    </div>

    <!-- 人工发布预警 -->
    <div class="ingest">
      <div class="form-title">人工发布预警</div>
      <div class="ingest-row">
        <select v-model="manualForm.eventId">
          <option v-for="e in store.events" :key="e.id" :value="e.id">{{ e.title }}</option>
        </select>
        <select v-model="manualForm.level">
          <option value="blue">Ⅳ级·蓝色</option>
          <option value="yellow">Ⅲ级·黄色</option>
          <option value="orange">Ⅱ级·橙色</option>
          <option value="red">Ⅰ级·红色</option>
        </select>
      </div>
      <div class="ingest-row">
        <input v-model="manualForm.reason" placeholder="研判依据（可空）" />
        <button class="mini-btn warn" :disabled="!manualForm.eventId" @click="onIssue">发布</button>
      </div>
      <p v-if="manualFb" class="fb" :class="manualFb.ok ? 'ok' : 'err'">{{ manualFb.msg }}</p>
    </div>

    <!-- 预警单列表 -->
    <div class="panel-sub">
      🚨 预警单（{{ warning.alerts.length }}）
      <span v-if="warning.stats.pending" class="sub-badge">{{ warning.stats.pending }} 待确认</span>
    </div>
    <div class="alerts">
      <div v-if="!warning.alerts.length" class="tiny-empty">暂无预警，监测数据正常</div>
      <div
        v-for="a in warning.alerts" :key="a.id"
        class="alert-card"
        :class="[a.status, { focused: warning.focusAlertId === a.id }]"
      >
        <div class="al-head">
          <span class="al-level" :style="{ background: warning.levelColorOf(a.level) }">{{ warning.levelText(a.level) }}</span>
          <strong>{{ a.eventTitle }}</strong>
          <span class="al-status" :style="{ color: warning.statusColor(a.status) }">{{ warning.statusText(a.status) }}</span>
        </div>
        <p class="al-sub">
          {{ a.station }} · {{ a.metricLabel }}<template v-if="a.value != null"> {{ a.value }}{{ a.unit }}</template>
          · {{ a.source }} · {{ a.issuedAt }}
        </p>

        <!-- 多角色签收 -->
        <div class="al-roles">
          <button
            v-for="n in a.notices" :key="n.role"
            class="role-chip"
            :class="{ acked: !!n.ackAt }"
            :disabled="!!n.ackAt || a.status === 'revoked' || a.status === 'closed'"
            :title="n.ackAt ? `${n.label} 已签收：${n.ackBy} ${n.ackAt}` : `${n.label}（${n.channel}）点击代签收`"
            @click="onAck(a, n)"
          >
            {{ n.icon }} {{ n.label }}
            <em v-if="n.ackAt">✓</em><em v-else class="wait">…</em>
          </button>
        </div>

        <!-- 调度建议 -->
        <div v-if="a.suggestion && a.suggestion.length && a.status !== 'revoked' && a.status !== 'closed'" class="al-sug">
          <span class="sug-lab">调度建议：</span>
          <span v-for="s in a.suggestion" :key="s.type" class="sug-chip">
            {{ resLabel(s.type) }} {{ s.qty }}{{ resUnit(s.type) }}
          </span>
          <button
            v-if="!a.suggestionApplied"
            class="mini-btn go"
            @click="onApply(a)"
          >一键调度</button>
          <span v-else class="sug-done">✓ 已联动出库</span>
        </div>

        <!-- 操作 -->
        <div v-if="a.status === 'issued' || a.status === 'confirmed'" class="al-actions">
          <button
            v-if="pendingAck(a) > 0"
            class="act-btn confirm"
            @click="onConfirmAll(a)"
          >🤝 全部确认（{{ pendingAck(a) }} 待签）</button>
          <button class="act-btn esc" :disabled="a.level === 'red'" @click="onEscalate(a)">⬆️ 升级</button>
          <button class="act-btn close" @click="onClose(a)">🟢 解除</button>
          <button class="act-btn revoke" @click="onRevoke(a)">⚪ 撤销</button>
        </div>
        <p v-if="a.status === 'revoked'" class="al-end">⚪ 已撤销：{{ a.revokeReason }}（{{ a.revokedAt }}）</p>
        <p v-if="a.status === 'closed'" class="al-end ok">🟢 已解除（{{ a.closedAt }}）</p>

        <!-- 处置日志 -->
        <div class="al-log">
          <p v-for="(l, i) in [...a.log].slice(-3).reverse()" :key="i">
            <span class="lg-time">{{ l.at }}</span>{{ l.text }}
          </p>
        </div>
        <p v-if="fb[a.id]" class="fb" :class="fb[a.id].ok ? 'ok' : 'err'">{{ fb[a.id].msg }}</p>
      </div>
    </div>
  </div>
</template>

<script setup>
import { reactive, ref } from 'vue'
import { useCommandStore } from '@/store/command'
import { useWarningStore } from '@/store/warning'
import { RESOURCE_TYPES } from '@/mock/data'

const store = useCommandStore()
const warning = useWarningStore()

const ingestForm = ref({ feedId: '', value: null })
const manualForm = ref({ eventId: '', level: 'yellow', reason: '' })
const ingestFb = ref(null)
const manualFb = ref(null)
const fb = reactive({})

const resLabel = (t) => RESOURCE_TYPES[t]?.label || t
const resUnit = (t) => RESOURCE_TYPES[t]?.unit || ''
const eventTitle = (id) => store.events.find((e) => e.id === id)?.title || id
const pendingAck = (a) => warning.pendingAckOf(a)

function feedColor(f) {
  const lv = warning.feedLevel(f)
  return lv ? warning.levelColorOf(lv) : '#7ef0c9'
}
function feedBorder(f) {
  const lv = warning.feedLevel(f)
  return lv ? { borderColor: warning.levelColorOf(lv) } : {}
}
function thresholdHit(f, lv) {
  return f.value >= (f.thresholds[lv] ?? Infinity)
}

function onIngest() {
  const r = warning.ingestReading(ingestForm.value.feedId, ingestForm.value.value)
  ingestFb.value = r.ok
    ? { ok: true, msg: r.level ? `读数已注入，触发${warning.levelText(r.level)}预警评估` : '读数已注入，未超阈值' }
    : { ok: false, msg: r.msg }
}
function onIssue() {
  const r = warning.issueAlert({ ...manualForm.value })
  manualFb.value = r.ok
    ? { ok: true, msg: `预警已发布（${r.alert.id}），已通知 ${r.alert.notices.length} 个角色` }
    : { ok: false, msg: r.msg }
  if (r.ok) manualForm.value.reason = ''
}
function onAck(a, n) {
  const r = warning.confirmAlert(a.id, { role: n.role })
  fb[a.id] = r.ok
    ? { ok: true, msg: r.confirmed ? '全员确认完毕，预警响应生效' : `${n.label} 已签收` }
    : { ok: false, msg: r.msg }
}
function onConfirmAll(a) {
  const r = warning.confirmAll(a.id)
  fb[a.id] = r.ok
    ? { ok: true, msg: '全员确认完毕，预警响应生效' }
    : { ok: false, msg: r.msg }
}
function onEscalate(a) {
  const r = warning.escalateAlert(a.id, { reason: '指挥员研判升级' })
  fb[a.id] = r.ok
    ? { ok: true, msg: `已升级为${warning.levelText(r.alert.level)}` }
    : { ok: false, msg: r.msg }
}
function onRevoke(a) {
  const reason = window.prompt('撤销原因（误报需留痕）', '研判为误报')
  if (reason == null) return
  const r = warning.revokeAlert(a.id, { reason })
  fb[a.id] = r.ok ? { ok: true, msg: '预警已撤销并留痕' } : { ok: false, msg: r.msg }
}
function onClose(a) {
  const r = warning.closeAlert(a.id, { reason: '现场核实风险消除' })
  fb[a.id] = r.ok ? { ok: true, msg: '预警已解除' } : { ok: false, msg: r.msg }
}
function onApply(a) {
  const r = warning.applySuggestion(a.id)
  fb[a.id] = r.ok
    ? { ok: true, msg: `已联动出库 ${r.sent.length} 批物资` }
    : { ok: false, msg: r.msg }
}
</script>

<style scoped>
.warning-panel { display: flex; flex-direction: column; gap: 10px; }
.panel-sub {
  font-size: 12px; color: #6f8cb8; font-weight: 600;
  border-left: 3px solid #ff5252; padding-left: 8px; margin: 4px 0;
  display: flex; align-items: center; gap: 8px;
}
.sub-badge {
  background: #ffab40; color: #201200; font-size: 10px;
  padding: 1px 7px; border-radius: 8px; font-weight: 700;
}
.monitor-btn {
  margin-left: auto; background: transparent; border: 1px dashed rgba(120,160,220,0.35);
  color: #8ea1c4; font-size: 10px; border-radius: 5px; padding: 2px 8px; cursor: pointer;
}
.monitor-btn.on { border-color: #4caf50; color: #7ef0c9; background: rgba(76,175,80,0.12); }

/* 监测站卡片 */
.feeds { display: flex; flex-direction: column; gap: 6px; }
.feed-card {
  background: rgba(16,29,57,0.6); border: 1px solid rgba(120,160,220,0.12);
  border-radius: 9px; padding: 8px 10px;
}
.feed-card.alarm { background: rgba(60,20,16,0.35); }
.fd-head { display: flex; align-items: center; gap: 8px; }
.fd-icon { font-size: 16px; }
.fd-info { flex: 1; min-width: 0; }
.fd-info strong { color: #dbe4f3; font-size: 12px; display: block; }
.fd-info p { font-size: 10px; color: #5b6f94; margin: 1px 0 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.fd-value { font-size: 16px; font-weight: 800; font-variant-numeric: tabular-nums; }
.fd-value i { font-style: normal; font-size: 9px; color: #5b6f94; margin-left: 2px; font-weight: 400; }
.fd-th { display: flex; align-items: center; gap: 5px; margin-top: 6px; }
.th-chip {
  font-size: 9px; color: #5b6f94; border: 1px solid rgba(120,160,220,0.18);
  border-radius: 4px; padding: 1px 5px;
}
.th-chip.hit { color: #fff; font-weight: 700; }
.fd-kind { margin-left: auto; font-size: 9px; color: #4a5875; }

/* 注入 / 人工发表单 */
.ingest { background: #101d39; border: 1px solid rgba(120,160,220,0.15); border-radius: 10px; padding: 10px; }
.form-title { font-size: 11px; font-weight: 600; color: #8ba2c8; margin-bottom: 7px; }
.ingest-row { display: flex; gap: 6px; margin-bottom: 6px; }
.ingest-row:last-child { margin-bottom: 0; }
.ingest-row select, .ingest-row input {
  flex: 1; min-width: 0; background: #0c1730; border: 1px solid rgba(120,160,220,0.2);
  color: #dbe4f3; border-radius: 6px; padding: 6px 8px; font-size: 11px; box-sizing: border-box;
}
.mini-btn {
  background: #0c1730; border: 1px solid rgba(120,160,220,0.3); color: #8ba2c8;
  font-size: 11px; border-radius: 6px; padding: 5px 12px; cursor: pointer; flex-shrink: 0;
}
.mini-btn:hover:not(:disabled) { color: #fff; border-color: #4d8dff; }
.mini-btn:disabled { opacity: 0.45; cursor: not-allowed; }
.mini-btn.warn { border-color: rgba(255,82,82,0.5); color: #ff8a80; }
.mini-btn.go { border-color: rgba(38,166,154,0.5); color: #7ef0c9; padding: 2px 9px; font-size: 10px; }

/* 预警单卡片 */
.alerts { display: flex; flex-direction: column; gap: 8px; }
.alert-card {
  background: rgba(16,29,57,0.6); border: 1px solid rgba(255,82,82,0.3);
  border-radius: 9px; padding: 9px 10px;
}
.alert-card.confirmed { border-color: rgba(255,82,82,0.55); box-shadow: 0 0 10px rgba(255,82,82,0.12); }
.alert-card.closed, .alert-card.revoked { opacity: 0.62; border-color: rgba(120,160,220,0.15); }
.alert-card.focused { box-shadow: 0 0 0 1.5px rgba(255,171,64,0.5); }
.al-head { display: flex; align-items: center; gap: 7px; }
.al-level { color: #fff; font-size: 10px; font-weight: 700; padding: 2px 7px; border-radius: 4px; flex-shrink: 0; }
.al-head strong { color: #fff; font-size: 12px; flex: 1; min-width: 0; }
.al-status { font-size: 10px; font-weight: 700; flex-shrink: 0; }
.al-sub { font-size: 10px; color: #8ba2c8; margin: 5px 0 0; }

.al-roles { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 7px; }
.role-chip {
  background: #0c1730; border: 1px solid rgba(255,171,64,0.35); color: #ffcc80;
  font-size: 10px; border-radius: 5px; padding: 2px 7px; cursor: pointer;
}
.role-chip em { font-style: normal; font-weight: 700; }
.role-chip .wait { animation: blink 1.2s infinite; }
@keyframes blink { 50% { opacity: 0.25; } }
.role-chip.acked { border-color: rgba(38,166,154,0.5); color: #7ef0c9; cursor: default; }
.role-chip:disabled:not(.acked) { opacity: 0.5; cursor: not-allowed; }

.al-sug { display: flex; flex-wrap: wrap; align-items: center; gap: 5px; margin-top: 7px; }
.sug-lab { font-size: 10px; color: #8ba2c8; }
.sug-chip {
  font-size: 10px; background: rgba(41,98,255,0.14); border: 1px solid rgba(77,141,255,0.35);
  color: #9fc1ff; padding: 1px 6px; border-radius: 4px;
}
.sug-done { font-size: 10px; color: #7ef0c9; }

.al-actions { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 8px; }
.act-btn {
  background: #0c1730; border: 1px solid rgba(120,160,220,0.25);
  color: #8ba2c8; font-size: 10px; border-radius: 5px; padding: 3px 9px; cursor: pointer;
}
.act-btn:hover:not(:disabled) { color: #fff; border-color: #4d8dff; }
.act-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.act-btn.confirm { border-color: rgba(38,166,154,0.5); color: #7ef0c9; }
.act-btn.esc { border-color: rgba(255,152,0,0.5); color: #ffcc80; }
.act-btn.close { border-color: rgba(76,175,80,0.45); color: #a5d6a7; }
.act-btn.revoke { border-color: rgba(158,158,158,0.4); color: #b0bec5; margin-left: auto; }

.al-end { font-size: 10px; color: #b0bec5; margin: 7px 0 0; }
.al-end.ok { color: #a5d6a7; }
.al-log { margin-top: 7px; border-top: 1px dashed rgba(120,160,220,0.15); padding-top: 5px; }
.al-log p { font-size: 9px; color: #5b6f94; margin: 2px 0; }
.lg-time { color: #ffc107; font-family: monospace; margin-right: 5px; }

.fb { font-size: 10px; margin: 6px 0 0; }
.fb.ok { color: #7ef0c9; }
.fb.err { color: #ef9a9a; }
.tiny-empty { color: #5b6f94; font-size: 11px; text-align: center; padding: 8px; }
</style>
