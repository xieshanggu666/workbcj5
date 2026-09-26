<template>
  <div class="plan-panel">
    <!-- 当前调度员身份（协同编制） -->
    <div class="pp-collab">
      <div class="pc-me">
        <span class="pc-label">🧑‍💼 当前调度员</span>
        <select :value="store.currentDispatcherId" @change="(e) => store.switchDispatcher(e.target.value)">
          <option v-for="u in store.dispatchers" :key="u.id" :value="u.id">{{ u.name }}</option>
        </select>
      </div>
      <div class="pc-ops">
        <button class="gen-btn" @click="store.generatePlan()">⚙️ 生成统筹方案</button>
        <button v-if="store.plan.length" class="ghost-btn" @click="onClear()">清空</button>
      </div>
    </div>
    <p class="pp-hint">多调度员协同编制：生成即按「库存-已预占」口径预占，预占 10 分钟超时自动释放，可冲突重算后统一提交</p>

    <!-- 方案协同状态条 -->
    <div v-if="store.planMeta" class="pp-meta">
      <div class="pm-row">
        <span class="pm-ver">🧮 方案 v{{ store.planMeta.version }}</span>
        <span class="pm-id">NO.{{ store.planMeta.id.slice(-6) }}</span>
        <span class="pm-count">{{ store.plan.length }} 项</span>
        <button class="pm-cancel" title="撤销草稿、归还全部预占" @click="onCancelDraft()">撤销草稿</button>
      </div>
      <div class="pm-authors">
        <span class="pa-label">协同：</span>
        <em v-for="u in authors" :key="u.id" class="pa-chip">{{ u.name }}</em>
      </div>
      <div class="pm-held">
        🔒 已预占
        <em v-for="(q, k) in heldSummary" :key="k" class="ph-chip">{{ resLabel(k) }} {{ q }}</em>
      </div>
      <div v-if="expiredItems.length" class="pm-expired">
        ⏰ {{ expiredItems.length }} 项预占超时已释放，库存回归——可减量/换基后点「重新预占」，或提交前删除
      </div>
    </div>

    <!-- 批量派发结果 -->
    <div v-if="store.planResult" class="pp-result">
      <div class="pr-head">
        <strong>🧾 批量派发结果（{{ store.planResult.at }}）</strong>
        <button class="x" @click="store.planResult = null">✕</button>
      </div>
      <p class="pr-line">✅ 直接执行 {{ store.planResult.ok }} 项 · 🔀 冲突重分配 {{ store.planResult.realloc }} 项</p>
      <template v-if="store.planResult.unmet.length">
        <p class="pr-line warn">⚠️ 库存不足，{{ store.planResult.unmet.length }} 项缺口未满足：</p>
        <p v-for="(u, i) in store.planResult.unmet" :key="i" class="pr-unmet">
          · {{ u.eventTitle }} — {{ resLabel(u.type) }} 缺 {{ u.qty }}{{ resUnit(u.type) }}
        </p>
      </template>
      <div v-if="lastArchive" class="pr-undo">
        <button class="undo-btn" @click="onCancelSubmitted(lastArchive.id)">🚫 撤销本方案（在途余量回库，已签收账目保留）</button>
      </div>
    </div>

    <!-- 需求缺口总览 -->
    <div class="pp-gaps">
      <div class="panel-sub">📊 需求缺口（已抵扣在途与生效预占）</div>
      <div v-if="!gapList.length" class="tiny-empty">各事件需求均已满足 🎉</div>
      <div v-for="g in gapList" :key="g.ev.id" class="gap-row">
        <i class="sev-dot" :style="{ background: sevColor(g.ev.severity) }"></i>
        <span class="g-title" :title="g.ev.title">{{ g.ev.title }}</span>
        <span class="g-chips">
          <em v-for="(q, t) in g.gap" :key="t">{{ resIcon(t) }}{{ q }}</em>
        </span>
      </div>
    </div>

    <!-- 方案明细（协同调整区） -->
    <template v-if="store.plan.length">
      <div class="pp-tools">
        <button class="recalc-btn" :class="{ hot: conflictKeys.size }" @click="onRecalc()">
          🔀 冲突重算<span v-if="conflictKeys.size">（{{ conflictKeys.size }} 组冲突）</span>
        </button>
      </div>
      <div class="panel-sub">📦 跨基地分配方案（{{ store.plan.length }} 项）</div>
      <div v-for="grp in groups" :key="grp.ev.id" class="plan-group">
        <div class="pg-head">
          <i class="sev-dot" :style="{ background: sevColor(grp.ev.severity) }"></i>
          <strong>{{ grp.ev.title }}</strong>
          <span class="pg-sev" :style="{ color: sevColor(grp.ev.severity) }">{{ sevLabel(grp.ev.severity) }}</span>
        </div>
        <div v-for="it in grp.items" :key="it.id" class="plan-item" :class="{ conflict: isConflict(it), expired: it.status === 'expired' }">
          <div class="pi-top">
            <span class="pi-type">{{ resIcon(it.type) }} {{ resLabel(it.type) }}</span>
            <input
              class="pi-qty" type="number" min="1" :value="it.qty"
              @change="(e) => onUpdate(it.id, { qty: +e.target.value })"
            />
            <span class="pi-unit">{{ resUnit(it.type) }}</span>
            <button class="pi-del" title="移除该项（归还预占）" @click="store.removePlanItem(it.id)">✕</button>
          </div>
          <div class="pi-bottom">
            <select :value="it.baseId" @change="(e) => onUpdate(it.id, { baseId: e.target.value })">
              <option v-for="b in store.bases" :key="b.id" :value="b.id">
                {{ b.name }}（存 {{ b.stock[it.type] || 0 }} · 可支配 {{ availableOf(b.id, it.type) }}）
              </option>
            </select>
            <span class="pi-eta">🚚 {{ it.distance }}km·{{ it.minutes }}min</span>
          </div>
          <div class="pi-foot">
            <span class="pi-author">✍️ {{ authorName(it.authorId) }}</span>
            <span v-if="it.status === 'expired'" class="pi-expired">⏰ 预占已超时释放</span>
            <template v-else>
              <span class="pi-ttl" :class="{ soon: ttlLeft(it) <= 120 }">🔒 {{ ttlText(it) }}</span>
            </template>
          </div>
          <p v-if="isConflict(it)" class="pi-warn">⚠️ {{ baseName(it.baseId) }} 库存不足，点「冲突重算」自动换基/拆单</p>
          <p v-if="it.status === 'expired'" class="pi-warn expired-warn">
            <button class="retry-btn" @click="onRetry(it.id)">重新预占</button>
            或减量 / 换基后再预占
          </p>
        </div>
      </div>
      <button class="submit-btn" @click="onSubmit()">✅ 统一校验 · 原子批量派发</button>
      <p v-if="submitMsg" class="submit-msg err">{{ submitMsg }}</p>
    </template>
    <div v-else-if="!store.planResult" class="tiny-empty">点击「生成统筹方案」自动计算跨基地分配并预占库存</div>
  </div>
</template>

<script setup>
import { computed, ref, onUnmounted, reactive } from 'vue'
import { useCommandStore } from '@/store/command'
import { RESOURCE_TYPES, SEVERITY } from '@/mock/data'

const store = useCommandStore()

const resLabel = (k) => RESOURCE_TYPES[k]?.label || k
const resIcon = (k) => RESOURCE_TYPES[k]?.icon || ''
const resUnit = (k) => RESOURCE_TYPES[k]?.unit || ''
const sevColor = (s) => SEVERITY.find((x) => x.value === s)?.color || '#999'
const sevLabel = (s) => SEVERITY.find((x) => x.value === s)?.label || s
const baseName = (id) => store.bases.find((b) => b.id === id)?.name || ''
const authorName = (id) => store.dispatchers.find((u) => u.id === id)?.name || '调度员'
const availableOf = (baseId, type) => store.availableStock[baseId]?.[type] ?? 0

// 本地秒针：驱动预占倒计时显示（不入快照、不入帧）
const tick = ref(Date.now())
const tickTimer = setInterval(() => { tick.value = Date.now() }, 1000)
onUnmounted(() => clearInterval(tickTimer))
const ttlLeft = (it) => {
  if (!it.expiresAt) return 0
  // 测试/推演虚拟时钟固定时按固定值展示，否则按真实时间倒计时
  if (store.planClock != null) return Math.max(0, Math.round((it.expiresAt - store.planClock) / 1000))
  return Math.max(0, Math.round((it.expiresAt - Date.now()) / 1000))
}
const ttlText = (it) => {
  const s = ttlLeft(it)
  const m = Math.floor(s / 60)
  return m > 0 ? `剩 ${m}分${s % 60}秒` : `剩 ${s}秒`
}

const submitMsg = ref('')

const SEV_ORDER = { red: 0, orange: 1, yellow: 2, blue: 3 }
const bySeverity = (a, b) => (SEV_ORDER[a.ev.severity] ?? 9) - (SEV_ORDER[b.ev.severity] ?? 9)

// 有缺口的事件（按等级排序）
const gapList = computed(() =>
  store.gaps
    .map((g) => ({ ev: store.events.find((e) => e.id === g.eventId), gap: g.gap }))
    .filter((x) => x.ev && Object.keys(x.gap).length)
    .sort(bySeverity)
)

// 方案按事件分组展示
const groups = computed(() => {
  const m = new Map()
  store.plan.forEach((it) => {
    if (!m.has(it.eventId)) m.set(it.eventId, [])
    m.get(it.eventId).push(it)
  })
  return [...m.entries()]
    .map(([eventId, items]) => ({ ev: store.events.find((e) => e.id === eventId), items }))
    .filter((g) => g.ev)
    .sort(bySeverity)
})

// 该项所属 基地+类型 预占超出库存即冲突
const conflictKeys = computed(() => new Set(Object.keys(store.planConflicts)))
const isConflict = (it) => it.status !== 'expired' && !!store.planConflicts[it.baseId + '|' + it.type]

const expiredItems = computed(() => store.plan.filter((p) => p.status === 'expired'))

// 参与协同的调度员
const authors = computed(() => {
  const ids = new Set([store.planMeta?.createdBy, ...(store.planMeta?.joined || [])])
  store.plan.forEach((p) => p.authorId && ids.add(p.authorId))
  return store.dispatchers.filter((u) => ids.has(u.id))
})

// 当前生效预占按物资汇总
const heldSummary = computed(() => {
  const m = {}
  store.activeReservations.forEach((r) => { m[r.type] = (m[r.type] || 0) + r.qty })
  return m
})

const lastArchive = computed(() =>
  store.submittedPlans.find((p) => p.id === store.planResult?.planId && p.status === 'submitted') || null
)

function onClear() {
  submitMsg.value = ''
  store.clearPlan()
}
function onUpdate(id, patch) {
  submitMsg.value = ''
  const r = store.updatePlanItem(id, patch)
  if (r && r.ok === false) submitMsg.value = r.msg
}
function onRecalc() {
  submitMsg.value = ''
  const r = store.recalcPlanConflicts()
  if (!r.unmet.length) submitMsg.value = ''
}
function onRetry(id) {
  submitMsg.value = ''
  const r = store.retryPlanItem(id)
  if (!r.ok) submitMsg.value = r.msg
}
function onSubmit() {
  submitMsg.value = ''
  const r = store.submitPlan()
  if (r && r.ok === false) submitMsg.value = r.msg
}
function onCancelDraft() {
  submitMsg.value = ''
  store.cancelPlan()
}
function onCancelSubmitted(id) {
  const r = store.cancelPlan(id)
  if (!r.ok) submitMsg.value = r.msg
}
</script>

<style scoped>
.plan-panel { display: flex; flex-direction: column; gap: 10px; }
.pp-collab { display: flex; gap: 8px; align-items: center; }
.pc-me { display: flex; align-items: center; gap: 6px; }
.pc-label { font-size: 11px; color: #8ba2c8; white-space: nowrap; }
.pc-me select {
  background: #101d39; border: 1px solid rgba(120,160,220,0.25);
  color: #ffc107; border-radius: 7px; padding: 6px 8px; font-size: 11px;
}
.pc-ops { display: flex; gap: 6px; flex: 1; justify-content: flex-end; }
.gen-btn {
  padding: 8px 12px; border: none; border-radius: 8px;
  background: linear-gradient(135deg, #7b1fa2, #9c4dff);
  color: #fff; font-size: 12px; font-weight: 600; cursor: pointer; transition: all 0.2s;
}
.gen-btn:hover { filter: brightness(1.15); box-shadow: 0 4px 14px rgba(156,77,255,0.4); }
.ghost-btn {
  padding: 8px 10px; background: transparent; border: 1px solid rgba(120,160,220,0.3);
  color: #8ba2c8; font-size: 12px; border-radius: 8px; cursor: pointer;
}
.ghost-btn:hover { color: #fff; border-color: #4d8dff; }
.pp-hint { font-size: 10px; color: #5b6f94; margin: 0; line-height: 1.5; }

/* 协同状态条 */
.pp-meta {
  background: rgba(50,30,70,0.35); border: 1px solid rgba(156,77,255,0.35);
  border-radius: 9px; padding: 8px 10px; display: flex; flex-direction: column; gap: 5px;
}
.pm-row { display: flex; align-items: center; gap: 8px; }
.pm-ver { font-size: 12px; color: #ce93ff; font-weight: 700; }
.pm-id { font-size: 9px; color: #5b6f94; font-family: monospace; }
.pm-count { font-size: 10px; color: #8ba2c8; background: rgba(120,160,220,0.12); padding: 1px 6px; border-radius: 4px; }
.pm-cancel {
  margin-left: auto; background: none; border: 1px solid rgba(239,83,80,0.4);
  color: #ef9a9a; font-size: 10px; border-radius: 5px; padding: 2px 8px; cursor: pointer;
}
.pm-cancel:hover { background: rgba(239,83,80,0.12); }
.pm-authors { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
.pa-label { font-size: 10px; color: #5b6f94; }
.pa-chip {
  font-style: normal; font-size: 10px; color: #ce93ff;
  background: rgba(156,77,255,0.15); border: 1px solid rgba(156,77,255,0.3);
  padding: 1px 7px; border-radius: 8px;
}
.pm-held { font-size: 10px; color: #7ea8e8; display: flex; align-items: center; gap: 5px; flex-wrap: wrap; }
.ph-chip { font-style: normal; font-size: 9px; color: #ffd54f; background: rgba(255,193,7,0.1); border-radius: 4px; padding: 1px 5px; }
.pm-expired { font-size: 10px; color: #ffab91; }

.pp-tools { display: flex; }
.recalc-btn {
  width: 100%; padding: 7px; border-radius: 7px; cursor: pointer; font-size: 11px;
  background: #101d39; border: 1px solid rgba(120,160,220,0.3); color: #8ba2c8;
}
.recalc-btn:hover { color: #fff; border-color: #4d8dff; }
.recalc-btn.hot { border-color: rgba(255,193,7,0.6); color: #ffd54f; }

.panel-sub {
  font-size: 12px; color: #6f8cb8; font-weight: 600;
  border-left: 3px solid #9c4dff; padding-left: 8px; margin: 4px 0 2px;
}
.tiny-empty { color: #5b6f94; font-size: 11px; text-align: center; padding: 8px; }

/* 结果反馈 */
.pp-result {
  background: rgba(20,40,30,0.6); border: 1px solid rgba(76,175,80,0.35);
  border-radius: 9px; padding: 9px 10px;
}
.pr-head { display: flex; justify-content: space-between; align-items: center; }
.pr-head strong { color: #a5d6a7; font-size: 12px; }
.pr-head .x { background: none; border: none; color: #5b6f94; cursor: pointer; font-size: 12px; }
.pr-head .x:hover { color: #fff; }
.pr-line { font-size: 11px; color: #8ba2c8; margin: 6px 0 0; }
.pr-line.warn { color: #ffc107; }
.pr-unmet { font-size: 10px; color: #ef9a9a; margin: 3px 0 0; }
.pr-undo { margin-top: 8px; }
.undo-btn {
  width: 100%; padding: 6px; font-size: 10px; border-radius: 6px; cursor: pointer;
  background: transparent; border: 1px solid rgba(239,83,80,0.45); color: #ef9a9a;
}
.undo-btn:hover { background: rgba(239,83,80,0.12); }

/* 缺口总览 */
.pp-gaps { display: flex; flex-direction: column; gap: 5px; }
.gap-row {
  display: flex; align-items: center; gap: 7px;
  background: rgba(16,29,57,0.6); border: 1px solid rgba(120,160,220,0.12);
  border-radius: 8px; padding: 6px 8px;
}
.sev-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
.g-title {
  flex: 1; min-width: 0; font-size: 11px; color: #dbe4f3;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.g-chips { display: flex; gap: 4px; flex-shrink: 0; }
.g-chips em { font-style: normal; font-size: 10px; color: #ffc107; }

/* 方案分组与条目 */
.plan-group {
  background: rgba(16,29,57,0.6); border: 1px solid rgba(120,160,220,0.12);
  border-radius: 9px; padding: 8px; display: flex; flex-direction: column; gap: 7px;
}
.pg-head { display: flex; align-items: center; gap: 7px; }
.pg-head strong {
  flex: 1; min-width: 0; font-size: 12px; color: #fff;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.pg-sev { font-size: 10px; flex-shrink: 0; }
.plan-item {
  background: #0c1730; border: 1px solid rgba(120,160,220,0.15);
  border-radius: 8px; padding: 7px 8px;
}
.plan-item.conflict { border-color: rgba(255,193,7,0.55); }
.plan-item.expired { border-color: rgba(239,83,80,0.5); opacity: 0.92; }
.pi-top { display: flex; align-items: center; gap: 6px; }
.pi-type { flex: 1; font-size: 11px; color: #dbe4f3; }
.pi-qty {
  width: 64px; background: #101d39; border: 1px solid rgba(120,160,220,0.25);
  color: #ffc107; border-radius: 6px; padding: 4px 6px; font-size: 12px; text-align: right;
}
.pi-unit { font-size: 10px; color: #8ba2c8; width: 16px; }
.pi-del {
  background: none; border: none; color: #5b6f94; font-size: 11px;
  cursor: pointer; padding: 2px 4px;
}
.pi-del:hover { color: #ef5350; }
.pi-bottom { display: flex; align-items: center; gap: 6px; margin-top: 6px; }
.pi-bottom select {
  flex: 1; min-width: 0; background: #101d39; border: 1px solid rgba(120,160,220,0.2);
  color: #aebadd; border-radius: 6px; padding: 4px 6px; font-size: 10px;
}
.pi-eta { font-size: 10px; color: #5b6f94; flex-shrink: 0; }
.pi-foot { display: flex; align-items: center; gap: 8px; margin-top: 5px; }
.pi-author { font-size: 9px; color: #7e9ff5; }
.pi-ttl { margin-left: auto; font-size: 9px; color: #7ef0c9; }
.pi-ttl.soon { color: #ffab91; }
.pi-expired { margin-left: auto; font-size: 9px; color: #ef9a9a; }
.pi-warn { font-size: 10px; color: #ffc107; margin: 6px 0 0; }
.expired-warn { display: flex; align-items: center; gap: 8px; color: #ef9a9a; }
.retry-btn {
  background: rgba(239,83,80,0.12); border: 1px solid rgba(239,83,80,0.45);
  color: #ef9a9a; font-size: 10px; border-radius: 5px; padding: 2px 10px; cursor: pointer;
}
.retry-btn:hover { background: rgba(239,83,80,0.22); }

.submit-btn {
  width: 100%; padding: 10px; border: none; border-radius: 8px;
  background: linear-gradient(135deg, #1d6f3f, #2e7d32);
  color: #fff; font-size: 13px; font-weight: 600; cursor: pointer; transition: all 0.2s;
}
.submit-btn:hover { filter: brightness(1.15); box-shadow: 0 4px 14px rgba(46,125,50,0.45); }
.submit-msg { font-size: 10px; color: #ef9a9a; margin: 0; }
.submit-msg.err { text-align: center; }
</style>
