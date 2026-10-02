<script setup lang="ts">
/**
 * 道具位移轨迹：按镜头与帧区间登记 X/Y/Z 绝对位置与旋转角度，
 * 以绝对位置为规划来源重算逐帧位置与相邻位移，并标出需补拍的已拍帧。
 * 消费 PropState、FrameEntry、frameStore.pendingPlan。
 */
import { computed, onMounted, ref, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { useShotStore } from '../stores/shotStore';
import { useFrameStore } from '../stores/frameStore';
import * as api from '../db/api';
import { accumulateOffsets, buildCurvePoints, estimateSpeed } from '../utils/frameMath';
import { frameDelta, framePos, type Vec3 } from '../utils/propPlanning';
import { formatMm } from '../utils/format';
import { FIXATION_OPTIONS, type Fixation, type PropState } from '../types/prop';
import type { FrameEntry } from '../types/frame';
import EmptyState from '../components/common/EmptyState.vue';
import StatusTag from '../components/common/StatusTag.vue';
import PlanBanner from '../components/common/PlanBanner.vue';

const shotStore = useShotStore();
const frameStore = useFrameStore();
const { shots } = storeToRefs(shotStore);
const { frames, pendingPlan } = storeToRefs(frameStore);

const activeShotId = ref<number | null>(null);
const props = ref<PropState[]>([]);
const feedback = ref('');
const editingId = ref<number | null>(null);
const replanning = ref(false);

const form = ref({
  name: '',
  fromFrame: 1,
  toFrame: 12,
  posX: 0,
  posY: 0,
  posZ: 0,
  rotation: 0,
  fixation: '支架' as Fixation,
});

const fixationOptions = FIXATION_OPTIONS;
const activeShot = computed(() => (activeShotId.value === null ? undefined : shotStore.byId(activeShotId.value)));
const orderedFrames = computed(() => frames.value.slice().sort((a, b) => a.frameNo - b.frameNo));
const offsetSeries = computed(() => accumulateOffsets(orderedFrames.value.map((f) => f.propOffsetMm)));
const curvePoints = computed(() => buildCurvePoints(offsetSeries.value, 640, 160));
const totalOffset = computed(() => (offsetSeries.value.length ? offsetSeries.value[offsetSeries.value.length - 1] : 0));
/** 曲线上的采样点坐标（与 buildCurvePoints 同一坐标系） */
const curveDots = computed(() =>
  orderedFrames.value.map((f, i) => {
    const n = orderedFrames.value.length;
    const x = 8 + (n > 1 ? ((640 - 16) / (n - 1)) * i : 0);
    const values = offsetSeries.value;
    const max = values.length ? Math.max(...values, 1) : 1;
    const min = values.length ? Math.min(...values, 0) : 0;
    const span = max - min || 1;
    const y = 160 - 8 - (((values[i] ?? 0) - min) / span) * (160 - 16);
    return { key: `${f.frameNo}-${i}`, x: Number(x.toFixed(1)), y: Number(y.toFixed(1)) };
  }),
);
const avgSpeed = computed(() => {
  if (!orderedFrames.value.length) return 0;
  const fps = activeShot.value?.fps ?? 24;
  const sum = orderedFrames.value.reduce((s, f) => s + Math.abs(estimateSpeed(f.propOffsetMm, fps)), 0);
  return Math.round((sum / orderedFrames.value.length) * 100) / 100;
});

/** 逐帧行：绝对位置 + 相邻位移（ΔX/ΔY/ΔZ）+ 补拍标记 */
interface FrameRow {
  frame: FrameEntry;
  pos: Vec3;
  delta: Vec3;
}
const frameRows = computed<FrameRow[]>(() => {
  const rows: FrameRow[] = [];
  let prev: FrameEntry | null = null;
  for (const f of orderedFrames.value) {
    const pos = framePos(f);
    const delta = prev ? frameDelta(prev, f) : { ...pos };
    rows.push({ frame: f, pos, delta });
    prev = f;
  }
  return rows;
});
const reshootCount = computed(() => frameRows.value.filter((r) => r.frame.needsReshoot).length);

onMounted(async () => {
  if (!shotStore.ready) await shotStore.load();
  const first = shots.value[0];
  if (first && typeof first.id === 'number') {
    activeShotId.value = first.id;
    await load(first.id);
  }
});

watch(activeShotId, async (id) => {
  if (typeof id === 'number') await load(id);
});

async function load(id: number) {
  props.value = await api.listProps(id);
  await frameStore.loadForShot(id);
  editingId.value = null;
}

function flash(text: string) {
  feedback.value = text;
  window.setTimeout(() => {
    if (feedback.value === text) feedback.value = '';
  }, 3200);
}

function resetForm() {
  editingId.value = null;
  form.value = { name: '', fromFrame: 1, toFrame: Math.max(1, orderedFrames.value.length), posX: 0, posY: 0, posZ: 0, rotation: 0, fixation: '支架' };
}

function startEdit(row: PropState) {
  editingId.value = row.id ?? null;
  form.value = {
    name: row.name,
    fromFrame: row.fromFrame,
    toFrame: row.toFrame,
    posX: row.posX,
    posY: row.posY,
    posZ: row.posZ,
    rotation: row.rotation,
    fixation: row.fixation,
  };
}

/** 以修改区间的起点为重算起点，失败自动回滚 */
async function runReplan(anchorFrame: number) {
  if (activeShotId.value === null) return;
  replanning.value = true;
  try {
    const result = await frameStore.replanFromProps(anchorFrame);
    if (result && result.reshootFrameNos.length > 0) {
      flash(`已重算：从第 ${result.reshootFromFrame} 帧起需补拍，待场记确认`);
    } else if (result && result.changedFrameNos.length) {
      flash(`已按绝对位置重算 ${result.changedFrameNos.length} 帧位移`);
    } else {
      flash('重算完成，帧序无变化');
    }
  } catch {
    flash('重算失败，已恢复动手前的轨迹与帧序');
  } finally {
    replanning.value = false;
  }
}

async function submit() {
  if (activeShotId.value === null) return;
  if (!form.value.name.trim()) {
    flash('请填写道具名');
    return;
  }
  const fromFrame = Math.max(1, Math.floor(form.value.fromFrame));
  const toFrame = Math.max(fromFrame, Math.floor(form.value.toFrame));
  if (editingId.value !== null) {
    await api.updateProp(editingId.value, { ...form.value, name: form.value.name.trim(), fromFrame, toFrame });
    flash('已更新道具记录');
  } else {
    const payload: PropState = {
      name: form.value.name.trim(),
      shotId: activeShotId.value,
      fromFrame,
      toFrame,
      posX: form.value.posX,
      posY: form.value.posY,
      posZ: form.value.posZ,
      rotation: form.value.rotation,
      fixation: form.value.fixation,
      updatedAt: Date.now(),
    };
    await api.addProp(payload);
    flash('已登记道具记录');
  }
  await load(activeShotId.value);
  resetForm();
  await runReplan(fromFrame);
}

async function removeProp(id: number | undefined) {
  if (typeof id !== 'number' || activeShotId.value === null) return;
  const target = props.value.find((p) => p.id === id);
  const anchor = target ? target.fromFrame : 1;
  await api.deleteProp(id);
  await load(activeShotId.value);
  flash('已删除该道具记录');
  await runReplan(anchor);
}

/** 手动重算：从最早区间起点开始 */
async function manualReplan() {
  const anchor = props.value.length ? Math.min(...props.value.map((p) => p.fromFrame)) : 1;
  await runReplan(anchor);
}
</script>

<template>
  <section class="page">
    <header class="page-head">
      <div>
        <h1>道具位移轨迹</h1>
        <p class="sub">按镜头与帧区间登记道具 X/Y/Z 绝对位置，以绝对位置为规划来源重算逐帧位置与相邻位移</p>
      </div>
      <div class="head-actions">
        <select v-model.number="activeShotId" class="shot-select" data-testid="prop-shot-select">
          <option :value="null" disabled>选择镜头</option>
          <option v-for="s in shots" :key="s.id" :value="s.id">{{ s.code }} · {{ s.sceneName }}</option>
        </select>
        <StatusTag v-if="activeShot" :status="activeShot.status" />
      </div>
    </header>

    <EmptyState
      v-if="!shots.length"
      title="还没有镜头"
      description="道具轨迹需要先有镜头，请到「新建镜头」创建。"
    />

    <template v-else-if="activeShot">
      <p v-if="feedback" class="feedback" data-testid="prop-feedback">{{ feedback }}</p>
      <PlanBanner />

      <div class="panel">
        <div class="panel-head">
          <h2>登记道具位置</h2>
          <span class="muted">{{ editingId === null ? '新增记录' : '编辑记录 #' + editingId }}</span>
        </div>
        <div class="form-grid">
          <label class="field"><span>道具名</span><input v-model="form.name" type="text" maxlength="20" data-testid="prop-track-name" /></label>
          <label class="field"><span>起始帧</span><input v-model.number="form.fromFrame" type="number" min="1" max="9999" step="1" data-testid="prop-track-from" /></label>
          <label class="field"><span>结束帧</span><input v-model.number="form.toFrame" type="number" min="1" max="9999" step="1" data-testid="prop-track-to" /></label>
          <label class="field"><span>位置 X（mm）</span><input v-model.number="form.posX" type="number" step="0.5" data-testid="prop-track-x" /></label>
          <label class="field"><span>位置 Y（mm）</span><input v-model.number="form.posY" type="number" step="0.5" data-testid="prop-track-y" /></label>
          <label class="field"><span>位置 Z（mm）</span><input v-model.number="form.posZ" type="number" step="0.5" data-testid="prop-track-z" /></label>
          <label class="field"><span>旋转角度（°）</span><input v-model.number="form.rotation" type="number" step="1" data-testid="prop-track-rotation" /></label>
          <label class="field">
            <span>固定方式</span>
            <select v-model="form.fixation" data-testid="prop-track-fixation">
              <option v-for="f in fixationOptions" :key="f" :value="f">{{ f }}</option>
            </select>
          </label>
        </div>
        <div class="actions">
          <button type="button" class="btn primary" data-testid="prop-track-submit" @click="submit">
            {{ editingId === null ? '登记道具并重算' : '保存修改并重算' }}
          </button>
          <button type="button" class="btn" :disabled="replanning" @click="manualReplan">
            {{ replanning ? '重算中…' : '重算轨迹' }}
          </button>
          <button type="button" class="btn" @click="resetForm">清空表单</button>
        </div>
      </div>

      <div class="panel">
        <div class="panel-head">
          <h2>累计位移曲线</h2>
          <span class="muted">共 {{ orderedFrames.length }} 帧 · 累计 {{ formatMm(totalOffset) }} · 平均位移速度 {{ avgSpeed }} mm/s</span>
        </div>
        <svg v-if="orderedFrames.length" class="curve" viewBox="0 0 640 160" preserveAspectRatio="none" data-testid="offset-curve">
          <line x1="8" y1="152" x2="632" y2="152" stroke="#dbe2ec" stroke-width="1" />
          <line x1="8" y1="8" x2="8" y2="152" stroke="#dbe2ec" stroke-width="1" />
          <polyline :points="curvePoints" fill="none" stroke="#2f6fed" stroke-width="2" />
          <circle v-for="d in curveDots" :key="d.key" :cx="d.x" :cy="d.y" r="2.5" fill="#2f6fed" />
        </svg>
        <p v-else class="muted">该镜头还没有帧条目，先到帧序编排台插入帧。</p>
      </div>

      <div class="panel">
        <div class="panel-head"><h2>道具记录</h2><span class="muted">共 {{ props.length }} 条</span></div>
        <table v-if="props.length" class="table" data-testid="prop-track-table">
          <thead>
            <tr><th>道具</th><th>帧区间</th><th>绝对 X</th><th>绝对 Y</th><th>绝对 Z</th><th>旋转</th><th>固定方式</th><th>操作</th></tr>
          </thead>
          <tbody>
            <tr v-for="p in props" :key="p.id">
              <td>{{ p.name }}</td>
              <td class="mono">{{ p.fromFrame }} – {{ p.toFrame }}</td>
              <td>{{ formatMm(p.posX) }}</td>
              <td>{{ formatMm(p.posY) }}</td>
              <td>{{ formatMm(p.posZ) }}</td>
              <td>{{ p.rotation }}°</td>
              <td>{{ p.fixation }}</td>
              <td class="row-actions">
                <button type="button" class="btn tiny" @click="startEdit(p)">编辑</button>
                <button type="button" class="btn tiny danger" @click="removeProp(p.id)">删除</button>
              </td>
            </tr>
          </tbody>
        </table>
        <EmptyState v-else title="还没有道具记录" description="填写道具名与帧区间后登记，轨迹会显示在上方曲线中。" />
      </div>

      <div class="panel">
        <div class="panel-head">
          <h2>逐帧位置与相邻位移</h2>
          <span class="muted">
            绝对位置由道具区间规划 · 相邻位移 = 本帧位置 − 上一帧位置
            <template v-if="reshootCount"> · <span class="reshoot-tag">{{ reshootCount }} 帧需补拍</span></template>
          </span>
        </div>
        <table v-if="frameRows.length" class="table" data-testid="prop-frames-table">
          <thead>
            <tr>
              <th>帧号</th>
              <th>拍摄</th>
              <th>绝对位置 X</th>
              <th>绝对位置 Y</th>
              <th>绝对位置 Z</th>
              <th>相邻位移 ΔX</th>
              <th>相邻位移 ΔY</th>
              <th>相邻位移 ΔZ</th>
              <th>状态</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in frameRows" :key="row.frame.id ?? row.frame.frameNo" :class="{ 'row-reshoot': row.frame.needsReshoot }">
              <td class="mono">{{ row.frame.frameNo }}</td>
              <td>
                <span v-if="row.frame.shotFrame" class="shot-done">已拍</span>
                <span v-else class="muted">未拍</span>
              </td>
              <td>{{ formatMm(row.pos.x) }}</td>
              <td>{{ formatMm(row.pos.y) }}</td>
              <td>{{ formatMm(row.pos.z) }}</td>
              <td>{{ formatMm(row.delta.x) }}</td>
              <td>{{ formatMm(row.delta.y) }}</td>
              <td>{{ formatMm(row.delta.z) }}</td>
              <td>
                <span v-if="row.frame.needsReshoot" class="reshoot-tag">需补拍</span>
                <span v-else class="muted">—</span>
              </td>
            </tr>
          </tbody>
        </table>
        <p v-else class="muted">登记道具并重算后，这里给出逐帧绝对位置与相邻位移。</p>
      </div>
    </template>
  </section>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.page-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-end;
  gap: 12px;
}
h1 {
  margin: 0;
  font-size: 22px;
}
.sub {
  margin: 4px 0 0;
  color: #6b7686;
  font-size: 13px;
}
.head-actions {
  display: flex;
  gap: 8px;
  align-items: center;
}
.shot-select {
  height: 32px;
  border: 1px solid #cfd6e0;
  border-radius: 6px;
  padding: 0 8px;
  font-size: 13px;
  background: #fff;
}
.panel {
  background: #fff;
  border: 1px solid #e2e7ef;
  border-radius: 10px;
  padding: 16px;
}
.panel-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
}
.panel-head h2 {
  margin: 0;
  font-size: 16px;
}
.form-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 10px;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: #5a6472;
}
.field input,
.field select {
  height: 32px;
  border: 1px solid #cfd6e0;
  border-radius: 6px;
  padding: 0 8px;
  font-size: 13px;
  background: #fff;
  color: #1f2d3d;
}
.actions {
  display: flex;
  gap: 10px;
  margin-top: 12px;
}
.curve {
  width: 100%;
  height: 160px;
  background: #fbfcfe;
  border: 1px solid #eef1f6;
  border-radius: 8px;
}
.table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
.table th,
.table td {
  text-align: left;
  padding: 8px 6px;
  border-bottom: 1px solid #eef1f6;
}
.table th {
  color: #6b7686;
  font-weight: 600;
  font-size: 12px;
}
.table tr.row-reshoot {
  background: #fff7e6;
}
.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.muted {
  color: #8a94a6;
  font-size: 12px;
}
.row-actions {
  display: flex;
  gap: 6px;
}
.btn {
  height: 32px;
  padding: 0 14px;
  border-radius: 6px;
  border: 1px solid #cfd6e0;
  background: #fff;
  color: #1f2d3d;
  cursor: pointer;
  font-size: 13px;
}
.btn.primary {
  background: #2f6fed;
  border-color: #2f6fed;
  color: #fff;
}
.btn.tiny {
  height: 24px;
  padding: 0 8px;
  font-size: 12px;
}
.btn.danger {
  color: #c45656;
  border-color: #f0c8c8;
}
.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.feedback {
  margin: 0;
  background: #eef6ff;
  border: 1px solid #d3e4ff;
  color: #24559c;
  border-radius: 8px;
  padding: 8px 12px;
  font-size: 13px;
}
.reshoot-tag {
  display: inline-block;
  background: #fff7e6;
  border: 1px solid #ffd591;
  color: #c45600;
  border-radius: 4px;
  padding: 1px 8px;
  font-size: 12px;
}
.shot-done {
  display: inline-block;
  background: #f0f9eb;
  border: 1px solid #b3e19d;
  color: #389e0d;
  border-radius: 4px;
  padding: 1px 8px;
  font-size: 12px;
}
</style>
