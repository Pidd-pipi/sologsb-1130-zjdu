/** 帧条目 store：条带选中、帧序数组、批量曝光、持久化、道具规划与场记确认 */
import { defineStore } from 'pinia';
import * as api from '../db/api';
import { db, toPlain } from '../db';
import { accumulateOffsets, estimateSpeed, frameColor, framesToDuration, durationToFrames } from '../utils/frameMath';
import { replanFromProps, type ReplanResult } from '../utils/propPlanning';
import { useShotStore } from './shotStore';
import type { BatchExposure, FrameEntry } from '../types/frame';
import { createEmptyFrame } from '../types/frame';

/** 暂存的规划变更（需场记确认后才落库） */
export interface PendingPlan {
  shotId: number;
  result: ReplanResult;
  anchorFrame: number;
}

interface FrameState {
  frames: FrameEntry[];
  shotId: number | null;
  selectedFrameNo: number | null;
  dirty: boolean;
  /** 待场记确认的规划变更（null 表示无） */
  pendingPlan: PendingPlan | null;
}

export const useFrameStore = defineStore('frame', {
  state: (): FrameState => ({
    frames: [],
    shotId: null,
    selectedFrameNo: null,
    dirty: false,
    pendingPlan: null,
  }),
  getters: {
    count(state): number {
      return state.frames.length;
    },
    selected(state): FrameEntry | undefined {
      if (state.selectedFrameNo === null) return undefined;
      return state.frames.find((f) => f.frameNo === state.selectedFrameNo);
    },
    /** 全部帧的累计位移轨迹（mm） */
    offsets(state): number[] {
      return accumulateOffsets(state.frames.map((f) => f.propOffsetMm));
    },
    /** 整段帧序按张数折算的总时长（秒） */
    totalDuration(state): number {
      return Math.round(state.frames.reduce((sum, f) => sum + 1 / (f.shotCount || 1), 0) * 100) / 100;
    },
    /** 帧序在给定帧率下的实际时长（秒） */
    durationAtFps(state) {
      return (fps: number) => framesToDuration(state.frames.length, fps);
    },
  },
  actions: {
    async loadForShot(shotId: number) {
      this.shotId = shotId;
      this.frames = await api.listFrames(shotId);
      this.dirty = false;
      if (this.frames.length && !this.frames.some((f) => f.frameNo === this.selectedFrameNo)) {
        this.selectedFrameNo = this.frames[0].frameNo;
      }
    },
    select(frameNo: number | null) {
      this.selectedFrameNo = frameNo;
    },
    /** 整段帧序落库（脱代理后写入），帧序号按数组顺序重排 */
    async persist() {
      if (this.shotId === null) return;
      const ordered = this.frames.map((f, idx) => ({ ...f, frameNo: idx + 1, shotId: this.shotId as number }));
      await api.replaceShotFrames(this.shotId, toPlain(ordered));
      this.frames = await api.listFrames(this.shotId);
      this.dirty = false;
    },
    async insertAt(index: number, seed?: Partial<FrameEntry>) {
      const base = createEmptyFrame(this.shotId ?? 0, index + 1);
      const anchor = this.frames[index - 1] ?? this.frames[0];
      const merged: FrameEntry = {
        ...base,
        ...(anchor
          ? {
              shotCount: anchor.shotCount,
              exposureSec: anchor.exposureSec,
              aperture: anchor.aperture,
              iso: anchor.iso,
              shutterAngle: anchor.shutterAngle,
              lighting: anchor.lighting,
            }
          : {}),
        ...seed,
        frameNo: index + 1,
        id: undefined,
      };
      this.frames = [...this.frames.slice(0, index), merged, ...this.frames.slice(index)];
      this.frames = this.frames.map((f, idx) => ({ ...f, frameNo: idx + 1 }));
      this.dirty = true;
      await this.persist();
    },
    async removeAt(index: number) {
      if (this.frames.length <= 1) return;
      this.frames = this.frames.filter((_, i) => i !== index);
      this.frames = this.frames.map((f, idx) => ({ ...f, frameNo: idx + 1 }));
      this.dirty = true;
      await this.persist();
    },
    async move(from: number, to: number) {
      if (from === to || from < 0 || to < 0 || from >= this.frames.length || to >= this.frames.length) return;
      const next = this.frames.slice();
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      this.frames = next.map((f, idx) => ({ ...f, frameNo: idx + 1 }));
      this.dirty = true;
      await this.persist();
    },
    /** 批量套用曝光参数 */
    async applyBatch(batch: BatchExposure, indexes?: number[]) {
      const target = indexes && indexes.length ? new Set(indexes) : null;
      this.frames = this.frames.map((f, idx) => {
        if (target && !target.has(idx)) return f;
        return {
          ...f,
          exposureSec: batch.exposureSec,
          aperture: batch.aperture,
          iso: batch.iso,
          shutterAngle: batch.shutterAngle,
          updatedAt: Date.now(),
        };
      });
      await this.persist();
    },
    /** 就地更新单帧字段（镜头详情页表格 / 条带位移量） */
    async patchFrame(frameNo: number, patch: Partial<FrameEntry>) {
      const idx = this.frames.findIndex((f) => f.frameNo === frameNo);
      if (idx < 0) return;
      const next = { ...this.frames[idx], ...patch, updatedAt: Date.now() };
      this.frames = this.frames.map((f, i) => (i === idx ? next : f));
      if (typeof next.id === 'number') {
        const { id, ...rest } = next;
        await api.updateFrame(id, toPlain(rest));
      }
    },
    /** 条带单帧颜色：按曝光与位移量着色 */
    colorOf(frame: FrameEntry): string {
      return frameColor({ propOffsetMm: frame.propOffsetMm, exposureSec: frame.exposureSec });
    },
    speedOf(frame: FrameEntry, fps: number): number {
      return estimateSpeed(frame.propOffsetMm, fps);
    },

    /**
     * 以道具绝对位置为规划来源重算逐帧位置与相邻位移。
     * - 从 anchorFrame（修改区间的起点）之后重算，之前的帧原样保留。
     * - 已拍帧不被覆盖；若仅未拍帧受影响，直接落库。
     * - 若已拍帧受影响（需补拍），暂存为 pendingPlan，待场记确认后才写入。
     * - 任何一步失败都恢复动手前的帧序（内存快照 + 异常上抛）。
     */
    async replanFromProps(anchorFrame?: number): Promise<ReplanResult | null> {
      if (this.shotId === null) return null;
      const shotId = this.shotId;
      const snapFrames = toPlain(this.frames);
      try {
        const [props, takes] = await Promise.all([api.listProps(shotId), api.listTakesByShot(shotId)]);
        // 实拍边界：累计实拍张数对应已拍到第 N 帧
        const shotBoundary = takes.reduce((sum, t) => sum + (t.takenFrames || 0), 0);
        const result = replanFromProps(this.frames, props, { anchorFrame, shotBoundary });
        if (result.reshootFrameNos.length > 0) {
          // 已拍帧受影响：暂存，等场记确认
          this.pendingPlan = { shotId, result, anchorFrame: result.anchorFrame };
        } else if (result.changedFrameNos.length > 0) {
          // 仅未拍帧变化：直接落库
          this.frames = result.frames;
          this.pendingPlan = null;
          await api.bulkPutFrames(result.frames);
        } else {
          this.pendingPlan = null;
        }
        return result;
      } catch (e) {
        // 回滚到动手前
        this.frames = snapFrames;
        this.pendingPlan = null;
        throw e;
      }
    },

    /** 场记确认暂存的规划变更：原子写入帧序、按保留的实拍记录回写进度、标出补拍起点 */
    async confirmPlan(): Promise<void> {
      const plan = this.pendingPlan;
      if (!plan || this.shotId === null) return;
      const shotId = this.shotId;
      const snapFrames = toPlain(this.frames);
      const shot = await api.getShot(shotId);
      const snapShot = shot ? toPlain(shot) : null;
      try {
        const framesToWrite = plan.result.frames;
        await db.transaction('rw', db.frames, db.shots, db.takes, async () => {
          await db.frames.bulkPut(framesToWrite.map((f) => toPlain(f)));
          // 进度由保留的实拍记录重算（take 记录一条都不删）
          const takes = await db.takes.where('shotId').equals(shotId).toArray();
          const taken = takes.reduce((sum, t) => sum + (t.takenFrames || 0), 0);
          const planned = durationToFrames(shot?.durationSec ?? 0, shot?.fps ?? 24);
          const percent = Math.min(100, Math.round((taken / Math.max(1, planned)) * 100));
          await db.shots.update(shotId, {
            progressPercent: percent,
            reshootFromFrame: plan.result.reshootFromFrame ?? null,
            updatedAt: Date.now(),
          });
        });
        this.frames = framesToWrite;
        this.pendingPlan = null;
        // 刷新镜头 store，使补拍起点与进度快照反映到 UI
        await useShotStore().load();
      } catch (e) {
        // 回滚到动手前的帧序与镜头
        this.frames = snapFrames;
        if (snapShot) await api.updateShot(shotId, snapShot);
        throw e;
      }
    },

    /** 放弃暂存的规划变更：帧序恢复到重算前 */
    discardPlan() {
      this.pendingPlan = null;
      // 帧序未被改写（暂存阶段不落库），无需恢复；这里仅清状态
    },

    /** 标记补拍完成：清除帧上的补拍标记与镜头的补拍起点 */
    async markReshootDone(): Promise<void> {
      if (this.shotId === null) return;
      const shotId = this.shotId;
      const snapFrames = toPlain(this.frames);
      try {
        const updated = this.frames.map((f) => ({ ...f, needsReshoot: false }));
        await api.bulkPutFrames(updated);
        await api.updateShot(shotId, { reshootFromFrame: null });
        this.frames = updated;
        await useShotStore().load();
      } catch (e) {
        this.frames = snapFrames;
        throw e;
      }
    },
  },
});
