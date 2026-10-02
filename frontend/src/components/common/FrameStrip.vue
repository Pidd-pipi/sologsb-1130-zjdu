<script setup lang="ts">
/**
 * 帧序横向条带：按曝光时间 / 道具相邻位移着色，支持点击选中与拖拽换序。
 * 选中帧后可在条带内就地修改张数、曝光参数与道具位移量。
 * 色块同时标注：相邻位移、✓ 已实拍、从某格起待补拍的描边。
 * 仅渲染色块与文字标注，不涉及任何图像处理与成片输出。
 */
import { computed, ref } from 'vue';
import type { FrameEntry, ShotCount } from '../../types/frame';
import { SHOT_COUNT_OPTIONS } from '../../types/frame';
import { frameColor, type FrameColorInput } from '../../utils/frameMath';
import { deltaAgainst } from '../../utils/propPlan';

interface Props {
  frames: FrameEntry[];
  selected?: number | null;
  readonly?: boolean;
  colorBy?: 'offset' | 'exposure';
  /** 从该帧号（含）起需要补拍，色块描红边；null 表示无待补拍 */
  reshootFrom?: number | null;
}

const props = withDefaults(defineProps<Props>(), {
  selected: null,
  readonly: false,
  colorBy: 'offset',
  reshootFrom: null,
});

const emit = defineEmits<{
  (e: 'update:selected', frameNo: number | null): void;
  (e: 'reorder', from: number, to: number): void;
  (e: 'patch', frameNo: number, patch: Partial<FrameEntry>): void;
}>();

const dragFrom = ref<number | null>(null);

function colorOf(frame: FrameEntry): string {
  const input: FrameColorInput = {
    propOffsetMm: props.colorBy === 'offset' ? frame.propOffsetMm : 0,
    exposureSec: props.colorBy === 'exposure' ? frame.exposureSec : 0.25,
  };
  return frameColor(input);
}

function onSelect(frameNo: number) {
  emit('update:selected', props.selected === frameNo ? null : frameNo);
}

function onDragStart(index: number, ev: DragEvent) {
  if (props.readonly) return;
  dragFrom.value = index;
  ev.dataTransfer?.setData('text/plain', String(index));
}

function onDrop(index: number) {
  if (props.readonly) return;
  const from = dragFrom.value;
  dragFrom.value = null;
  if (from === null || from === index) return;
  emit('reorder', from, index);
}

function patchSelected(patch: Partial<FrameEntry>) {
  if (props.selected === null || props.selected === undefined) return;
  emit('patch', props.selected, patch);
}

const selectedFrame = computed(() => props.frames.find((f) => f.frameNo === props.selected) ?? null);

const totalOffset = computed(() =>
  Math.round(props.frames.reduce((sum, f) => sum + (f.propOffsetMm || 0), 0) * 100) / 100,
);

const takenCount = computed(() => props.frames.filter((f) => f.shotTaken).length);

/** 每格相对上一格的相邻位移（与 PropTrack 逐帧表同一算法） */
function deltaOf(index: number): number {
  return deltaAgainst(props.frames[index], props.frames[index - 1]).total;
}

const selectedIndex = computed(() => props.frames.findIndex((f) => f.frameNo === props.selected));
const selectedDelta = computed(() => (selectedIndex.value >= 0 ? deltaOf(selectedIndex.value) : 0));

const shotCountOptions = SHOT_COUNT_OPTIONS;
</script>

<template>
  <div class="frame-strip" data-testid="frame-strip">
    <div class="strip-meta">
      <span>帧序条带：{{ frames.length }} 帧</span>
      <span>相邻位移合计 {{ totalOffset }} mm</span>
      <span>已实拍 {{ takenCount }} 格</span>
      <span v-if="reshootFrom !== null" class="reshoot-hint">第 {{ reshootFrom }} 格起待补拍</span>
      <span v-else-if="!readonly" class="hint">点击选中 · 拖拽换序</span>
    </div>

    <div class="strip-track">
      <div
        v-for="(frame, index) in frames"
        :key="frame.frameNo"
        class="strip-cell"
        :class="{
          active: frame.frameNo === selected,
          readonly,
          taken: frame.shotTaken,
          reshoot: reshootFrom !== null && frame.frameNo >= reshootFrom,
        }"
        :style="{ background: colorOf(frame) }"
        :draggable="!readonly"
        :data-testid="`strip-cell-${frame.frameNo}`"
        :title="`第 ${frame.frameNo} 帧 · ${frame.shotCount} 张 · ${frame.exposureSec}s · f/${frame.aperture} · ISO${frame.iso} · 相邻位移 ${deltaOf(index)}mm${frame.shotTaken ? ' · 已实拍' : ''}${reshootFrom !== null && frame.frameNo >= reshootFrom ? ' · 待补拍' : ''}`"
        @click="onSelect(frame.frameNo)"
        @dragstart="onDragStart(index, $event)"
        @dragover.prevent
        @drop="onDrop(index)"
      >
        <span class="cell-no">{{ frame.frameNo }}</span>
        <span class="cell-sub">Δ{{ deltaOf(index) }}mm</span>
        <span class="cell-sub">{{ frame.shotCount }}张{{ frame.shotTaken ? ' ✓' : '' }}</span>
      </div>
      <div v-if="!frames.length" class="strip-empty">当前镜头还没有帧条目，请先插入一帧</div>
    </div>

    <div v-if="selectedFrame && !readonly" class="strip-editor" data-testid="strip-editor">
      <div class="editor-title">第 {{ selectedFrame.frameNo }} 帧参数</div>
      <div class="editor-grid">
        <label class="field">
          <span>拍摄张数</span>
          <select
            :value="selectedFrame.shotCount"
            :data-testid="`strip-shotcount-${selectedFrame.frameNo}`"
            @change="patchSelected({ shotCount: Number(($event.target as HTMLSelectElement).value) as ShotCount })"
          >
            <option v-for="opt in shotCountOptions" :key="opt" :value="opt">{{ opt }} 张</option>
          </select>
        </label>
        <label class="field">
          <span>曝光时间 s</span>
          <input
            type="number"
            min="0.008"
            max="8"
            step="0.008"
            :value="selectedFrame.exposureSec"
            @change="patchSelected({ exposureSec: Number(($event.target as HTMLInputElement).value) })"
          />
        </label>
        <label class="field">
          <span>光圈 f</span>
          <input
            type="number"
            min="1.4"
            max="22"
            step="0.1"
            :value="selectedFrame.aperture"
            @change="patchSelected({ aperture: Number(($event.target as HTMLInputElement).value) })"
          />
        </label>
        <label class="field">
          <span>ISO</span>
          <input
            type="number"
            min="100"
            max="3200"
            step="100"
            :value="selectedFrame.iso"
            @change="patchSelected({ iso: Number(($event.target as HTMLInputElement).value) })"
          />
        </label>
        <label class="field">
          <span>快门角度 °</span>
          <input
            type="number"
            min="45"
            max="360"
            step="1"
            :value="selectedFrame.shutterAngle"
            @change="patchSelected({ shutterAngle: Number(($event.target as HTMLInputElement).value) })"
          />
        </label>
        <label class="field readonly-field">
          <span>相邻位移 mm（道具轨迹折算）</span>
          <div class="readonly-value" :data-testid="`strip-offset-${selectedFrame.frameNo}`">{{ selectedDelta }} mm</div>
          <small>逐帧位移由道具绝对位置区间生成，请到「道具位移轨迹」修改</small>
        </label>
      </div>
    </div>
  </div>
</template>

<style scoped>
.frame-strip {
  border: 1px solid #d8dee9;
  border-radius: 10px;
  padding: 12px;
  background: #fbfcfe;
}
.strip-meta {
  display: flex;
  gap: 16px;
  font-size: 12px;
  color: #5a6472;
  margin-bottom: 10px;
}
.strip-meta .hint {
  color: #8a94a6;
}
.strip-meta .reshoot-hint {
  color: #c06a36;
  font-weight: 600;
}
.strip-track {
  display: flex;
  gap: 6px;
  overflow-x: auto;
  padding-bottom: 6px;
}
.strip-cell {
  min-width: 54px;
  height: 74px;
  border-radius: 8px;
  color: #fff;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  user-select: none;
  border: 2px solid transparent;
  flex: 0 0 auto;
  transition: transform 0.12s ease;
}
.strip-cell:hover {
  transform: translateY(-2px);
}
.strip-cell.active {
  border-color: #1f2d3d;
  box-shadow: 0 0 0 2px rgba(31, 45, 61, 0.18);
}
.strip-cell.taken::after {
  content: '';
  position: absolute;
  top: 3px;
  right: 3px;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #7be0a8;
}
.strip-cell.reshoot {
  border-color: #d98a5f;
  box-shadow: inset 0 0 0 1px #d98a5f;
}
.strip-cell {
  position: relative;
}
.strip-cell.readonly {
  cursor: default;
}
.cell-no {
  font-weight: 700;
  font-size: 14px;
}
.cell-sub {
  font-size: 11px;
  opacity: 0.92;
}
.strip-empty {
  color: #8a94a6;
  font-size: 13px;
  padding: 18px 4px;
}
.strip-editor {
  margin-top: 12px;
  border-top: 1px dashed #d8dee9;
  padding-top: 10px;
}
.editor-title {
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 8px;
}
.editor-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 8px;
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
  height: 30px;
  border: 1px solid #cfd6e0;
  border-radius: 6px;
  padding: 0 8px;
  font-size: 13px;
  background: #fff;
  color: #1f2d3d;
}
.field small {
  color: #9aa3b2;
  font-size: 11px;
}
.readonly-value {
  height: 30px;
  line-height: 30px;
  border: 1px dashed #cfd6e0;
  border-radius: 6px;
  padding: 0 8px;
  font-size: 13px;
  background: #f5f7fa;
  color: #2f6fed;
  font-weight: 600;
}
</style>
