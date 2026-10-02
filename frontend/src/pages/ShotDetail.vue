<script setup lang="ts">
/**
 * 镜头详情：上部镜头参数与进度，中部帧序条带，
 * 下部帧条目表格与道具轨迹；可就地插入帧、修改曝光或登记实拍。
 * 消费 Shot、FrameEntry、PropState、TakeLog 四个模型。
 */
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { storeToRefs } from 'pinia';
import { useShotStore } from '../stores/shotStore';
import { useFrameStore } from '../stores/frameStore';
import { useFrameSequence } from '../hooks/useFrameSequence';
import { useProgress } from '../hooks/useProgress';
import { usePropPlan } from '../hooks/usePropPlan';
import * as api from '../db/api';
import { durationToFrames, estimateSpeed, framesToDuration } from '../utils/frameMath';
import { deltaAgainst, keyframesOf, poseAtFrame } from '../utils/propPlan';
import { FIXATION_OPTIONS, type Fixation, type PropPose, type PropState } from '../types/prop';
import { SHOT_STATUS_OPTIONS, type ShotStatus } from '../types/shot';
import type { FrameEntry } from '../types/frame';
import { SHOT_COUNT_OPTIONS } from '../types/frame';
import { today } from '../utils/format';
import FrameStrip from '../components/common/FrameStrip.vue';
import ExposureForm from '../components/common/ExposureForm.vue';
import ShotProgress from '../components/common/ShotProgress.vue';
import StatusTag from '../components/common/StatusTag.vue';
import EmptyState from '../components/common/EmptyState.vue';

const route = useRoute();
const router = useRouter();
const shotStore = useShotStore();
const frameStore = useFrameStore();
const { frames, selectedFrameNo } = storeToRefs(frameStore);

const { insertAfter, removeAt, move, patch, select, syncShotRange } = useFrameSequence();
const { registerTake, summaries, loadTakes, computeProgress, syncFrameProgress } = useProgress();
const { load: loadPlan, props, reshootFrom, saveProp, removeProp: removePropPlan } = usePropPlan();

const takeForm = ref({ date: today(), takenFrames: 8, wastedFrames: 0 });
const propForm = ref({ name: '', fromFrame: 1, toFrame: 12, posX: 0, posY: 0, posZ: 0, rotation: 0, fixation: '支架' as Fixation });
const exposureDraft = ref<Partial<FrameEntry>>({});
const feedback = ref('');
const notFound = ref(false);

const shotId = computed(() => Number(route.params.id));
const shot = computed(() => shotStore.byId(shotId.value));
const planned = computed(() => (shot.value ? durationToFrames(shot.value.durationSec, shot.value.fps) : 0));
const summary = computed(() => summaries.value.find((s) => s.shotId === shotId.value));
const sceneProgress = computed(() =>
  shot.value ? framesToDuration(shot.value.endFrame - shot.value.startFrame + 1, shot.value.fps) : 0,
);
const statusOptions = SHOT_STATUS_OPTIONS;
const fixationOptions = FIXATION_OPTIONS;
const shotCountOptions = SHOT_COUNT_OPTIONS;

async function bootstrap(id: number) {
  if (!shotStore.ready) await shotStore.load();
  const row = await api.getShot(id);
  if (!row) {
    notFound.value = true;
    return;
  }
  notFound.value = false;
  await frameStore.loadForShot(id);
  await loadTakes();
  await loadPlan(id);
  if (typeof row.id === 'number') shotStore.currentId = row.id;
  const first = frames.value[0];
  exposureDraft.value = first
    ? {
        shotCount: first.shotCount,
        exposureSec: first.exposureSec,
        aperture: first.aperture,
        iso: first.iso,
        shutterAngle: first.shutterAngle,
        lighting: first.lighting,
        propOffsetMm: first.propOffsetMm,
        note: '',
      }
    : {};
}

onMounted(() => bootstrap(shotId.value));
watch(shotId, (id) => {
  if (Number.isFinite(id)) void bootstrap(id);
});

function flash(text: string) {
  feedback.value = text;
  window.setTimeout(() => {
    if (feedback.value === text) feedback.value = '';
  }, 3200);
}

async function changeStatus(status: ShotStatus) {
  if (!shot.value) return;
  await shotStore.setStatus(shotId.value, status);
  flash(`拍摄状态已更新为「${status}」`);
}

async function changeDuration(value: number) {
  if (!shot.value) return;
  await shotStore.update(shotId.value, { durationSec: value });
  flash('已按新时长重排帧区间');
}

async function changeFps(value: number) {
  if (!shot.value) return;
  await shotStore.update(shotId.value, { fps: value });
  await syncShotRange();
  flash('已按新帧率重排帧区间');
}

async function addFrameWithExposure() {
  await insertAfter(selectedFrameNo.value ?? frames.value[frames.value.length - 1]?.frameNo ?? null);
  const last = frames.value[frames.value.length - 1];
  if (last) {
    await patch(last.frameNo, exposureDraft.value as Partial<FrameEntry>);
    select(last.frameNo);
  }
  flash('已在帧序中插入一帧');
}

async function reorder(from: number, to: number) {
  await move(from, to);
  flash('已移动帧并重排序号');
}

async function patchFrame(frameNo: number, value: Partial<FrameEntry>) {
  await patch(frameNo, value);
}

async function editCell(frame: FrameEntry, key: keyof FrameEntry, raw: string, numeric = true) {
  const value = numeric ? Number(raw) : raw;
  await patch(frame.frameNo, { [key]: value } as Partial<FrameEntry>);
}

async function removeFrameRow(frameNo: number) {
  await removeAt(frameNo);
  flash('已删除该帧并重排序号');
}

async function submitTake() {
  if (!shot.value) return;
  const taken = Math.max(0, Math.floor(takeForm.value.takenFrames));
  const wasted = Math.max(0, Math.floor(takeForm.value.wastedFrames));
  if (taken <= 0) {
    flash('实拍张数需大于 0');
    return;
  }
  await registerTake(shot.value, takeForm.value.date, taken, wasted);
  await loadTakes();
  flash(`已登记 ${taken} 张实拍，进度已回写`);
}

async function addProp() {
  if (!shot.value) return;
  if (!propForm.value.name.trim()) {
    flash('请填写道具名');
    return;
  }
  const payload: PropState = {
    name: propForm.value.name.trim(),
    shotId: shotId.value,
    fromFrame: Math.max(1, Math.floor(propForm.value.fromFrame)),
    toFrame: Math.max(1, Math.floor(propForm.value.toFrame)),
    posX: propForm.value.posX,
    posY: propForm.value.posY,
    posZ: propForm.value.posZ,
    rotation: propForm.value.rotation,
    fixation: propForm.value.fixation,
    updatedAt: Date.now(),
  };
  try {
    const result = await saveProp(shotId.value, payload);
    await frameStore.loadForShot(shotId.value);
    propForm.value.name = '';
    flash(
      result.reshootFrom === null
        ? '已登记道具轨迹并重算帧序'
        : `轨迹已重算：第 ${result.reshootFrom} 格起需要补拍，场记确认后才推进进度`,
    );
  } catch (e) {
    flash(e instanceof Error ? e.message : '登记失败，已恢复到动手前的轨迹与帧序');
  }
}

async function removeProp(id: number | undefined) {
  if (typeof id !== 'number') return;
  try {
    const result = await removePropPlan(shotId.value, id);
    await frameStore.loadForShot(shotId.value);
    flash(result.reshootFrom === null ? '已删除该道具轨迹并重算' : `删除后第 ${result.reshootFrom} 格起需要补拍`);
  } catch (e) {
    flash(e instanceof Error ? e.message : '删除失败，已恢复到动手前的轨迹与帧序');
  }
}

/** 场记确认补拍：从提示帧格起按当前轨迹固化实拍并回写镜头进度，原有实拍记录保留 */
async function confirmReshoot() {
  if (!shot.value || reshootFrom.value === null) return;
  await frameStore.confirmReshootFrom(reshootFrom.value, props.value);
  await loadPlan(shotId.value);
  await loadTakes();
  const p = await syncFrameProgress(shot.value);
  flash(`场记已确认第 ${reshootFrom.value} 格起的实拍，镜头进度更新为 ${p.percent}%`);
}

async function toggleFrameTaken(frame: FrameEntry) {
  if (!shot.value || typeof frame.id !== 'number') return;
  if (frame.shotTaken) await frameStore.clearTaken(frame.frameNo);
  else await frameStore.confirmTakenFrom(frame.frameNo);
  await loadPlan(shotId.value);
  await loadTakes();
  const p = await syncFrameProgress(shot.value);
  flash(`第 ${frame.frameNo} 帧实拍状态已更新，镜头进度 ${p.percent}%`);
}

/** 逐帧相邻位移（与道具轨迹页同算法） */
function frameDelta(frameNo: number): number {
  const idx = frames.value.findIndex((f) => f.frameNo === frameNo);
  if (idx < 0) return 0;
  return deltaAgainst(frames.value[idx], frames.value[idx - 1]).total;
}

/** 按帧号查询该帧展开后的道具绝对位姿（与道具轨迹页同一规划口径） */
function propsAtFrame(frameNo: number) {
  const kfMap = keyframesOf(props.value);
  const result: Array<{ name: string; pose: PropPose }> = [];
  for (const [name, keyframes] of kfMap) result.push({ name, pose: poseAtFrame(keyframes, frameNo) });
  return result;
}

const selectedProps = computed(() => (selectedFrameNo.value === null ? [] : propsAtFrame(selectedFrameNo.value)));
const takeRows = computed(() => summaries.value.find((s) => s.shotId === shotId.value));
const consumed = computed(() => {
  const s = takeRows.value;
  if (s) return computeProgress(s.planned, s.taken, s.wasted);
  const plan = planned.value;
  return { planned: plan, taken: 0, wasted: 0, remaining: plan, percent: 0 };
});

function speedOf(frame: FrameEntry) {
  return estimateSpeed(frame.propOffsetMm, shot.value?.fps ?? 24);
}
</script>

<template>
  <section class="page">
    <header class="page-head">
      <div>
        <h1>
          镜头详情
          <span v-if="shot" class="mono">{{ shot.code }}</span>
        </h1>
        <p class="sub" v-if="shot">{{ shot.sceneName }} · {{ shot.fps }} fps · 帧区间 {{ shot.startFrame }} – {{ shot.endFrame }}</p>
      </div>
      <div class="head-actions">
        <StatusTag v-if="shot" :status="shot.status" />
        <button type="button" class="btn" @click="router.push('/frames')">去帧序编排台</button>
        <button type="button" class="btn" @click="router.push('/')">返回总览</button>
      </div>
    </header>

    <EmptyState
      v-if="notFound"
      title="镜头不存在"
      description="该 id 在本地库中没有对应镜头，可能已被删除。"
      action-text="返回总览"
      @action="router.push('/')"
    />

    <template v-else-if="shot">
      <p v-if="feedback" class="feedback" data-testid="detail-feedback">{{ feedback }}</p>

      <div v-if="reshootFrom !== null" class="reshoot-banner" data-testid="reshoot-banner">
        <div class="reshoot-text">
          <strong>第 {{ reshootFrom }} 格起需要补拍</strong>
          <span>已实拍帧保留原计划未被覆盖；补拍完成后请场记确认，镜头进度才会推进（原有实拍记录保留）。</span>
        </div>
        <button type="button" class="btn primary" data-testid="reshoot-confirm" @click="confirmReshoot">场记确认补拍完成</button>
      </div>

      <div class="panel">
        <div class="panel-head"><h2>镜头参数与进度</h2></div>
        <div class="two-col">
          <dl class="kv">
            <div><dt>镜号</dt><dd class="mono" data-testid="detail-code">{{ shot.code }}</dd></div>
            <div><dt>场景名</dt><dd>{{ shot.sceneName }}</dd></div>
            <div>
              <dt>帧率</dt>
              <dd>
                <select :value="shot.fps" data-testid="detail-fps" @change="changeFps(Number(($event.target as HTMLSelectElement).value))">
                  <option v-for="f in [8, 12, 15, 24, 25, 30]" :key="f" :value="f">{{ f }} fps</option>
                </select>
              </dd>
            </div>
            <div>
              <dt>预计时长</dt>
              <dd>
                <input
                  type="number"
                  min="0.5"
                  max="60"
                  step="0.5"
                  :value="shot.durationSec"
                  data-testid="detail-duration"
                  @change="changeDuration(Number(($event.target as HTMLInputElement).value))"
                />
                s
              </dd>
            </div>
            <div><dt>帧区间</dt><dd class="mono">{{ shot.startFrame }} – {{ shot.endFrame }}（{{ sceneProgress }} s）</dd></div>
            <div><dt>负责人</dt><dd>{{ shot.owner || '未指派' }}</dd></div>
            <div>
              <dt>拍摄状态</dt>
              <dd>
                <select :value="shot.status" data-testid="detail-status" @change="changeStatus(($event.target as HTMLSelectElement).value as ShotStatus)">
                  <option v-for="s in statusOptions" :key="s" :value="s">{{ s }}</option>
                </select>
              </dd>
            </div>
          </dl>
          <ShotProgress
            :code="shot.code"
            :status="shot.status"
            :planned="consumed.planned"
            :taken="consumed.taken"
            :wasted="consumed.wasted"
            :remaining="consumed.remaining"
            :percent="consumed.percent"
          />
        </div>
      </div>

      <div class="panel">
        <div class="panel-head">
          <h2>帧序条带</h2>
          <span class="muted">点击色块选中该帧，可查看道具位置与就地改参数</span>
        </div>
        <FrameStrip
          :frames="frames"
          :selected="selectedFrameNo"
          :reshoot-from="reshootFrom"
          @update:selected="select"
          @reorder="reorder"
          @patch="patchFrame"
        />
        <div v-if="selectedFrameNo !== null" class="prop-lookup" data-testid="prop-lookup">
          <strong>第 {{ selectedFrameNo }} 帧道具绝对位置：</strong>
          <span v-if="!selectedProps.length" class="muted">还没有登记该帧上的道具轨迹</span>
          <span v-for="item in selectedProps" :key="item.name" class="chip">
            {{ item.name }} ({{ item.pose.posX }}, {{ item.pose.posY }}, {{ item.pose.posZ }}) mm · 旋转 {{ item.pose.rotation }}°
          </span>
        </div>
      </div>

      <div class="panel">
        <div class="panel-head">
          <h2>帧条目表格</h2>
          <div class="head-actions">
            <button type="button" class="btn small" data-testid="insert-frame" @click="addFrameWithExposure">插入帧</button>
            <button type="button" class="btn small" @click="syncShotRange">重算时长</button>
          </div>
        </div>

        <table v-if="frames.length" class="table" data-testid="frame-table">
          <thead>
            <tr>
              <th>帧号</th>
              <th>张数</th>
              <th>曝光 s</th>
              <th>光圈</th>
              <th>ISO</th>
              <th>快门角</th>
              <th>灯光</th>
              <th>相邻位移 mm</th>
              <th>位移速度</th>
              <th>实拍</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="frame in frames"
              :key="frame.id ?? frame.frameNo"
              :class="{ active: frame.frameNo === selectedFrameNo, reshoot: reshootFrom !== null && frame.frameNo >= reshootFrom }"
              @click="select(frame.frameNo)"
            >
              <td class="mono">{{ frame.frameNo }}</td>
              <td>
                <select :value="frame.shotCount" @change="editCell(frame, 'shotCount', ($event.target as HTMLSelectElement).value)">
                  <option v-for="c in shotCountOptions" :key="c" :value="c">{{ c }}</option>
                </select>
              </td>
              <td><input type="number" min="0.008" max="8" step="0.008" :value="frame.exposureSec" @change="editCell(frame, 'exposureSec', ($event.target as HTMLInputElement).value)" /></td>
              <td><input type="number" min="1.4" max="22" step="0.1" :value="frame.aperture" @change="editCell(frame, 'aperture', ($event.target as HTMLInputElement).value)" /></td>
              <td><input type="number" min="100" max="3200" step="100" :value="frame.iso" @change="editCell(frame, 'iso', ($event.target as HTMLInputElement).value)" /></td>
              <td><input type="number" min="45" max="360" step="1" :value="frame.shutterAngle" @change="editCell(frame, 'shutterAngle', ($event.target as HTMLInputElement).value)" /></td>
              <td><input type="text" maxlength="20" :value="frame.lighting" @change="editCell(frame, 'lighting', ($event.target as HTMLInputElement).value, false)" /></td>
              <td class="mono">
                <strong>{{ frameDelta(frame.frameNo) }}</strong>
                <span class="muted">（规划 {{ frame.propOffsetMm }}）</span>
              </td>
              <td class="muted">{{ speedOf(frame) }} mm/s</td>
              <td>
                <button
                  type="button"
                  class="taken-btn"
                  :class="{ on: frame.shotTaken, reshoot: reshootFrom !== null && frame.frameNo >= reshootFrom }"
                  :data-testid="`frame-taken-${frame.frameNo}`"
                  :title="frame.shotTaken ? '已实拍，点击撤销确认' : '场记点击确认实拍'"
                  @click.stop="toggleFrameTaken(frame)"
                >
                  {{ frame.shotTaken ? '✓ 已拍' : '○ 待拍' }}
                </button>
              </td>
              <td class="row-actions">
                <button type="button" class="btn tiny" @click.stop="insertAfter(frame.frameNo)">后插</button>
                <button type="button" class="btn tiny danger" :disabled="frames.length <= 1" @click.stop="removeFrameRow(frame.frameNo)">删除</button>
              </td>
            </tr>
          </tbody>
        </table>
        <EmptyState v-else title="该镜头还没有帧条目" description="点击「插入帧」按当前曝光参数生成第一帧。" action-text="插入帧" @action="addFrameWithExposure" />
      </div>

      <div class="two-panel">
        <div class="panel">
          <div class="panel-head">
            <h2>插入帧曝光参数</h2>
            <span class="muted">插入后自动重排帧序号并联动帧区间</span>
          </div>
          <ExposureForm v-model="exposureDraft" :fps="shot.fps" />
        </div>

        <div class="panel">
          <div class="panel-head">
            <h2>登记实拍</h2>
            <span class="muted">剩余 {{ consumed.remaining }} 张</span>
          </div>
          <div class="take-form">
            <label class="field"><span>拍摄日期</span><input v-model="takeForm.date" type="date" data-testid="take-date" /></label>
            <label class="field"><span>实拍张数</span><input v-model.number="takeForm.takenFrames" type="number" min="1" max="2000" step="1" data-testid="take-taken" /></label>
            <label class="field"><span>废帧数</span><input v-model.number="takeForm.wastedFrames" type="number" min="0" max="500" step="1" data-testid="take-wasted" /></label>
            <button type="button" class="btn primary" data-testid="take-submit" @click="submitTake">登记并回写进度</button>
          </div>
        </div>
      </div>

      <div class="panel">
        <div class="panel-head"><h2>道具轨迹（规划来源）</h2><span class="muted">登记区间终点绝对位姿，保存后从该段起点重算；完整逐帧表在「道具位移轨迹」页</span></div>
        <div class="prop-form">
          <label class="field"><span>道具名</span><input v-model="propForm.name" type="text" maxlength="20" data-testid="prop-name" /></label>
          <label class="field"><span>起始帧</span><input v-model.number="propForm.fromFrame" type="number" min="1" step="1" data-testid="prop-from" /></label>
          <label class="field"><span>结束帧</span><input v-model.number="propForm.toFrame" type="number" min="1" step="1" data-testid="prop-to" /></label>
          <label class="field"><span>终点 X mm</span><input v-model.number="propForm.posX" type="number" step="0.5" /></label>
          <label class="field"><span>终点 Y mm</span><input v-model.number="propForm.posY" type="number" step="0.5" /></label>
          <label class="field"><span>终点 Z mm</span><input v-model.number="propForm.posZ" type="number" step="0.5" /></label>
          <label class="field"><span>终点旋转 °</span><input v-model.number="propForm.rotation" type="number" step="1" /></label>
          <label class="field">
            <span>固定方式</span>
            <select v-model="propForm.fixation">
              <option v-for="f in fixationOptions" :key="f" :value="f">{{ f }}</option>
            </select>
          </label>
          <button type="button" class="btn primary" data-testid="prop-submit" @click="addProp">登记并重算</button>
        </div>

        <table v-if="props.length" class="table" data-testid="prop-table">
          <thead>
            <tr><th>道具</th><th>帧区间</th><th>终点X</th><th>终点Y</th><th>终点Z</th><th>旋转</th><th>固定</th><th>来源</th><th>操作</th></tr>
          </thead>
          <tbody>
            <tr v-for="p in props" :key="p.id">
              <td>{{ p.name }}</td>
              <td class="mono">{{ p.fromFrame }} – {{ p.toFrame }}</td>
              <td>{{ p.posX }}</td>
              <td>{{ p.posY }}</td>
              <td>{{ p.posZ }}</td>
              <td>{{ p.rotation }}°</td>
              <td>{{ p.fixation }}</td>
              <td class="muted">{{ p.system ? '旧数据' : '人工' }}</td>
              <td><button type="button" class="btn tiny danger" @click="removeProp(p.id)">删除重算</button></td>
            </tr>
          </tbody>
        </table>
        <EmptyState v-else title="还没有道具轨迹" description="登记区间终点绝对位姿后，帧序会显示逐帧绝对位置与相邻位移。" />
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
h1 .mono {
  font-size: 16px;
  color: #2f6fed;
  margin-left: 8px;
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
.two-col {
  display: grid;
  grid-template-columns: 1.4fr 1fr;
  gap: 18px;
}
.two-panel {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
}
@media (max-width: 1100px) {
  .two-col,
  .two-panel {
    grid-template-columns: 1fr;
  }
}
.kv {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 10px 18px;
  margin: 0;
}
.kv div {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.kv dt {
  font-size: 12px;
  color: #8a94a6;
}
.kv dd {
  margin: 0;
  font-size: 13px;
  color: #1f2d3d;
  display: flex;
  align-items: center;
  gap: 6px;
}
.kv input,
.kv select,
.table input,
.table select,
.take-form input,
.prop-form input,
.prop-form select {
  height: 30px;
  border: 1px solid #cfd6e0;
  border-radius: 6px;
  padding: 0 8px;
  font-size: 13px;
  background: #fff;
  color: #1f2d3d;
  width: 100%;
  box-sizing: border-box;
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
.table tbody tr.active {
  background: #f5f8ff;
}
.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.muted {
  color: #8a94a6;
  font-size: 12px;
}
.prop-lookup {
  margin-top: 10px;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  font-size: 13px;
}
.chip {
  background: #f0f4ff;
  border: 1px solid #dbe6ff;
  border-radius: 999px;
  padding: 2px 10px;
  font-size: 12px;
}
.take-form,
.prop-form {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
  gap: 10px;
  align-items: end;
  margin-bottom: 12px;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: #5a6472;
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
.btn.small {
  height: 28px;
  padding: 0 10px;
  font-size: 12px;
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
.reshoot-banner {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 14px;
  background: #fff5f0;
  border: 1px solid #f3c9b4;
  color: #9c4a24;
  border-radius: 10px;
  padding: 12px 16px;
}
.reshoot-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 13px;
}
.reshoot-text strong {
  font-size: 14px;
}
.table tbody tr.reshoot {
  background: #fff7f3;
}
.taken-btn {
  border-radius: 999px;
  border: 1px solid #cfd6e0;
  background: #fff;
  color: #8a94a6;
  cursor: pointer;
  font-size: 12px;
  padding: 3px 10px;
  white-space: nowrap;
}
.taken-btn.on {
  background: #2fae6a;
  border-color: #2fae6a;
  color: #fff;
}
.taken-btn.reshoot {
  border-color: #d98a5f;
  color: #c06a36;
}
</style>
