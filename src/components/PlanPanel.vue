<template>
  <div class="plan-panel">
    <!-- 调度员身份切换（多名调度员共同编制） -->
    <div class="pp-collab">
      <span class="pc-label">👤 当前调度员</span>
      <div class="pc-users">
        <button
          v-for="u in dispatchers" :key="u.id"
          class="pc-user" :class="{ active: store.currentDispatcherId === u.id }"
          @click="store.switchDispatcher(u.id)"
        >
          <i class="pc-dot" :class="['d-' + u.id]"></i>{{ u.name }}
        </button>
      </div>
    </div>

    <div class="pp-actions">
      <button class="gen-btn" @click="store.generatePlan()">⚙️ 生成统筹方案</button>
      <button v-if="store.plan.length" class="ghost-btn" @click="store.clearPlan()">清空</button>
    </div>
    <p class="pp-hint">
      多名调度员协同编制：方案项即时<span class="hl">预占库存（不扣实物）</span>，预占 {{ ttlText }} 未提交自动释放；
      提交时原子锁定 + 冲突重算，撤销时归还预占 / 整批撤回回库
    </p>

    <!-- 协同会话状态 -->
    <div v-if="session" class="pp-session" :class="session.status">
      <div class="ps-head">
        <strong>🗂️ {{ session.name }}</strong>
        <span class="ps-status" :class="'st-' + session.status">{{ statusText(session.status) }}</span>
      </div>
      <div class="ps-meta">
        <span>发起：{{ session.createdByName }}</span>
        <span>版本 v{{ store.planVersion }}</span>
        <span v-if="participants.length">编制：{{ participants.map((u) => u.name).join('、') }}</span>
      </div>
      <div class="ps-actions">
        <button v-if="session.status === 'editing'" class="undo-btn" @click="undoEditing">🚫 撤销方案（归还预占）</button>
        <button v-if="session.status === 'submitted'" class="undo-btn" @click="undoSubmitted">↩️ 撤销已提交方案（整批撤回回库）</button>
      </div>
    </div>

    <!-- 批量派发结果 -->
    <div v-if="store.planResult" class="pp-result">
      <div class="pr-head">
        <strong>🧾 批量派发结果（{{ store.planResult.at }}）</strong>
        <button class="x" @click="store.planResult = null">✕</button>
      </div>
      <p class="pr-line">✅ 直接执行 {{ store.planResult.ok }} 项 · 🔀 冲突重分配 {{ store.planResult.realloc }} 项</p>
      <template v-if="store.planResult.unmet && store.planResult.unmet.length">
        <p class="pr-line warn">⚠️ 库存不足，{{ store.planResult.unmet.length }} 项缺口未满足：</p>
        <p v-for="(u, i) in store.planResult.unmet" :key="i" class="pr-unmet">
          · {{ u.eventTitle }} — {{ resLabel(u.type) }} 缺 {{ u.qty }}{{ resUnit(u.type) }}
        </p>
      </template>
    </div>

    <!-- 提交被拦截：存在超时失效项 -->
    <div v-if="submitBlockMsg" class="pp-block">
      ⏰ {{ submitBlockMsg }}
      <button class="rereserve-all" @click="renewAll">一键全部重新预占</button>
    </div>

    <!-- 需求缺口总览 -->
    <div class="pp-gaps">
      <div class="panel-sub">📊 需求缺口（已抵扣在途与方案预占）</div>
      <div v-if="!gapList.length" class="tiny-empty">各事件需求均已满足 🎉</div>
      <div v-for="g in gapList" :key="g.ev.id" class="gap-row">
        <i class="sev-dot" :style="{ background: sevColor(g.ev.severity) }"></i>
        <span class="g-title" :title="g.ev.title">{{ g.ev.title }}</span>
        <span class="g-chips">
          <em v-for="(q, t) in g.gap" :key="t">{{ resIcon(t) }}{{ q }}</em>
        </span>
      </div>
    </div>

    <!-- 方案明细（协同编制区） -->
    <template v-if="store.plan.length">
      <div class="panel-sub">
        📦 跨基地分配方案（{{ store.plan.length }} 项）
        <span class="sub-meta">🔒 生效预占 {{ reservedTotal }} · ⏰ 超时 {{ expiredIds.size }} 项</span>
      </div>
      <div v-for="grp in groups" :key="grp.ev.id" class="plan-group">
        <div class="pg-head">
          <i class="sev-dot" :style="{ background: sevColor(grp.ev.severity) }"></i>
          <strong>{{ grp.ev.title }}</strong>
          <span class="pg-sev" :style="{ color: sevColor(grp.ev.severity) }">{{ sevLabel(grp.ev.severity) }}</span>
        </div>
        <div
          v-for="it in grp.items" :key="it.id"
          class="plan-item" :class="{ conflict: isConflict(it), expired: isExpired(it), mine: it.owner === store.currentDispatcherId }"
        >
          <div class="pi-top">
            <span class="pi-owner" :title="it.ownerName">
              <i class="pc-dot" :class="['d-' + it.owner]"></i>{{ it.ownerName || '调度员' }}
            </span>
            <span class="pi-type">{{ resIcon(it.type) }} {{ resLabel(it.type) }}</span>
            <input
              class="pi-qty" type="number" min="1" :value="it.qty"
              :disabled="isExpired(it)"
              @change="(e) => store.updatePlanItem(it.id, { qty: +e.target.value })"
            />
            <span class="pi-unit">{{ resUnit(it.type) }}</span>
            <button class="pi-del" title="移除该项（归还预占）" @click="store.removePlanItem(it.id)">✕</button>
          </div>
          <div class="pi-bottom">
            <select
              :value="it.baseId" :disabled="isExpired(it)"
              @change="(e) => store.updatePlanItem(it.id, { baseId: e.target.value })"
            >
              <option v-for="b in store.bases" :key="b.id" :value="b.id">
                {{ b.name }}（库 {{ b.stock[it.type] || 0 }} · 可预 {{ availableOf(b.id, it.type) }}）
              </option>
            </select>
            <span class="pi-eta">🚚 {{ it.distance }}km·{{ it.minutes }}min</span>
          </div>
          <!-- 预占状态 -->
          <div v-if="isExpired(it)" class="pi-rsv expired">
            ⏰ 预占已超时释放，需重新预占
            <button class="mini-btn" @click="store.reReserveItem(it.id)">🔒 重新预占</button>
          </div>
          <template v-else>
            <div class="pi-rsv" :class="{ short: (it.reserved || 0) < it.qty }">
              🔒 已预占 {{ it.reserved || 0 }}{{ resUnit(it.type) }}<span v-if="(it.reserved || 0) < it.qty"> / 需 {{ it.qty }}（提交时冲突重算）</span>
            </div>
            <p v-if="isConflict(it)" class="pi-warn">⚠️ {{ baseName(it.baseId) }} 库存不足，提交时将自动重新分配</p>
          </template>
        </div>
      </div>
      <button class="submit-btn" @click="submit">✅ 统一校验 · 原子锁定 · 批量派发</button>
    </template>
    <div v-else-if="!store.planResult" class="tiny-empty">点击「生成统筹方案」自动计算跨基地分配，多名调度员可协同调整</div>
  </div>
</template>

<script setup>
import { computed, ref } from 'vue'
import { useCommandStore, DISPATCHERS } from '@/store/command'
import { RESOURCE_TYPES, SEVERITY } from '@/mock/data'

const store = useCommandStore()
const dispatchers = DISPATCHERS
const submitBlockMsg = ref('')

const resLabel = (k) => RESOURCE_TYPES[k]?.label || k
const resIcon = (k) => RESOURCE_TYPES[k]?.icon || ''
const resUnit = (k) => RESOURCE_TYPES[k]?.unit || ''
const sevColor = (s) => SEVERITY.find((x) => x.value === s)?.color || '#999'
const sevLabel = (s) => SEVERITY.find((x) => x.value === s)?.label || s
const baseName = (id) => store.bases.find((b) => b.id === id)?.name || ''
const availableOf = (baseId, type) => store.availableMap[baseId + '|' + type] ?? 0

const session = computed(() => store.planSession)
const participants = computed(() => store.planParticipants)
const ttlText = computed(() => {
  const m = Math.round((store.reservationTtl || 0) / 60000)
  return m > 0 ? `${m} 分钟` : '不超时'
})
const statusText = (st) => ({ editing: '编制中', submitted: '已提交', revoked: '已撤销' }[st] || st)

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

const expiredIds = computed(() => store.expiredItemIds)
const isExpired = (it) => expiredIds.value.has(it.id)
// 该项所属 基地+类型 预占超出库存即冲突（超时项单独提示）
const isConflict = (it) => !isExpired(it) && !!store.planConflicts[it.baseId + '|' + it.type]
const reservedTotal = computed(() =>
  store.reservations.filter((r) => r.status === 'active').reduce((s, r) => s + r.qty, 0)
)

function submit() {
  submitBlockMsg.value = ''
  const r = store.submitPlan()
  if (r && r.ok === false) submitBlockMsg.value = r.msg
}
function renewAll() {
  store.plan.filter((it) => isExpired(it)).forEach((it) => store.reReserveItem(it.id))
  submitBlockMsg.value = ''
}
function undoEditing() {
  submitBlockMsg.value = ''
  store.undoPlan('协同编制撤销')
}
function undoSubmitted() {
  submitBlockMsg.value = ''
  store.undoPlan('协同方案提交后撤销')
}
</script>

<style scoped>
.plan-panel { display: flex; flex-direction: column; gap: 10px; }

/* 调度员协同 */
.pp-collab {
  background: rgba(16,29,57,0.6); border: 1px solid rgba(120,160,220,0.14);
  border-radius: 9px; padding: 7px 9px; display: flex; flex-direction: column; gap: 6px;
}
.pc-label { font-size: 10px; color: #6f8cb8; }
.pc-users { display: flex; gap: 6px; flex-wrap: wrap; }
.pc-user {
  display: flex; align-items: center; gap: 5px;
  background: #101d39; border: 1px solid rgba(120,160,220,0.2);
  color: #aebadd; border-radius: 20px; padding: 3px 10px; font-size: 11px; cursor: pointer;
}
.pc-user.active { border-color: #9c4dff; color: #fff; background: rgba(156,77,255,0.18); }
.pc-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
.d-u-zhao { background: #42a5f5; }
.d-u-qian { background: #ffb300; }
.d-u-sun { background: #66bb6a; }

.pp-actions { display: flex; gap: 8px; }
.gen-btn {
  flex: 1; padding: 9px; border: none; border-radius: 8px;
  background: linear-gradient(135deg, #7b1fa2, #9c4dff);
  color: #fff; font-size: 12px; font-weight: 600; cursor: pointer; transition: all 0.2s;
}
.gen-btn:hover { filter: brightness(1.15); box-shadow: 0 4px 14px rgba(156,77,255,0.4); }
.ghost-btn {
  padding: 9px 12px; background: transparent; border: 1px solid rgba(120,160,220,0.3);
  color: #8ba2c8; font-size: 12px; border-radius: 8px; cursor: pointer;
}
.ghost-btn:hover { color: #fff; border-color: #4d8dff; }
.pp-hint { font-size: 10px; color: #5b6f94; margin: 0; line-height: 1.6; }
.pp-hint .hl { color: #ce93ff; }

/* 协同会话 */
.pp-session {
  background: rgba(20,30,55,0.7); border: 1px solid rgba(156,77,255,0.35);
  border-radius: 9px; padding: 8px 10px; display: flex; flex-direction: column; gap: 6px;
}
.pp-session.submitted { border-color: rgba(76,175,80,0.45); }
.pp-session.revoked { border-color: rgba(150,150,150,0.35); opacity: 0.85; }
.ps-head { display: flex; justify-content: space-between; align-items: center; }
.ps-head strong { color: #e1d4f5; font-size: 12px; }
.ps-status { font-size: 10px; padding: 2px 8px; border-radius: 10px; }
.st-editing { background: rgba(156,77,255,0.2); color: #ce93ff; }
.st-submitted { background: rgba(76,175,80,0.2); color: #a5d6a7; }
.st-revoked { background: rgba(150,150,150,0.2); color: #bbb; }
.ps-meta { display: flex; gap: 10px; flex-wrap: wrap; font-size: 10px; color: #8ba2c8; }
.ps-actions { display: flex; gap: 6px; }
.undo-btn {
  background: transparent; border: 1px solid rgba(239,83,80,0.4); color: #ef9a9a;
  border-radius: 7px; padding: 4px 10px; font-size: 11px; cursor: pointer;
}
.undo-btn:hover { background: rgba(239,83,80,0.12); color: #fff; }

/* 提交拦截 */
.pp-block {
  background: rgba(60,40,10,0.6); border: 1px solid rgba(255,193,7,0.4);
  border-radius: 9px; padding: 8px 10px; font-size: 11px; color: #ffc107;
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
}
.rereserve-all {
  margin-left: auto; background: rgba(255,193,7,0.15); border: 1px solid rgba(255,193,7,0.5);
  color: #ffc107; border-radius: 7px; padding: 3px 10px; font-size: 11px; cursor: pointer;
}

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
.panel-sub .sub-meta { font-size: 10px; color: #8ba2c8; font-weight: 400; margin-left: 6px; }
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
.plan-item.mine { border-left: 2px solid #9c4dff; }
.plan-item.conflict { border-color: rgba(255,193,7,0.55); }
.plan-item.expired { border-color: rgba(239,83,80,0.5); opacity: 0.92; }
.pi-top { display: flex; align-items: center; gap: 6px; }
.pi-owner {
  display: flex; align-items: center; gap: 4px; flex-shrink: 0;
  font-size: 10px; color: #aebadd; background: rgba(120,160,220,0.1);
  padding: 2px 7px; border-radius: 10px;
}
.pi-type { flex: 1; font-size: 11px; color: #dbe4f3; min-width: 0; }
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
.pi-warn { font-size: 10px; color: #ffc107; margin: 6px 0 0; }
.pi-rsv { font-size: 10px; color: #a5d6a7; margin-top: 6px; display: flex; align-items: center; gap: 6px; }
.pi-rsv.short { color: #ffc107; }
.pi-rsv.expired { color: #ef9a9a; }
.mini-btn {
  background: rgba(156,77,255,0.15); border: 1px solid rgba(156,77,255,0.5);
  color: #ce93ff; border-radius: 6px; padding: 2px 8px; font-size: 10px; cursor: pointer;
}
.mini-btn:hover { background: rgba(156,77,255,0.3); }

.submit-btn {
  width: 100%; padding: 10px; border: none; border-radius: 8px;
  background: linear-gradient(135deg, #1d6f3f, #2e7d32);
  color: #fff; font-size: 13px; font-weight: 600; cursor: pointer; transition: all 0.2s;
}
.submit-btn:hover { filter: brightness(1.15); box-shadow: 0 4px 14px rgba(46,125,50,0.45); }
</style>
