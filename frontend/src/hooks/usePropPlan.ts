/**
 * 道具轨迹规划编排：以 PropState 绝对位姿区间为唯一规划来源，
 * 保存/删除区间后从该段起点重算帧序，标出补拍起始帧；
 * 场记确认后才推进镜头进度。失败时恢复动手前的轨迹与帧序（事务回滚 + 本地快照）。
 */
import { ref } from 'vue';
import * as api from '../db/api';
import type { PropReplanResult } from '../db/api';
import type { FrameEntry } from '../types/frame';
import type { PropState } from '../types/prop';
import { findReshootStart } from '../utils/propPlan';

export function usePropPlan() {
  const props = ref<PropState[]>([]);
  const frames = ref<FrameEntry[]>([]);
  const reshootFrom = ref<number | null>(null);
  const busy = ref(false);

  async function load(shotId: number) {
    const [propRows, frameRows] = await Promise.all([api.listProps(shotId), api.listFrames(shotId)]);
    props.value = propRows;
    frames.value = frameRows;
    reshootFrom.value = findReshootStart(frameRows, propRows);
  }

  /** 保存动手前快照，失败时恢复页面状态（数据库由事务保证回滚） */
  function snapshot() {
    return {
      props: props.value.map((p) => ({ ...p })),
      frames: frames.value.map((f) => ({ ...f, planPose: f.planPose ? { ...f.planPose } : f.planPose })),
    };
  }

  function restore(saved: { props: PropState[]; frames: FrameEntry[] }, error: unknown): never {
    props.value = saved.props;
    frames.value = saved.frames;
    throw error instanceof Error ? error : new Error('轨迹重算失败，已恢复到动手前的轨迹与帧序');
  }

  async function run(shotId: number, task: () => Promise<PropReplanResult>): Promise<PropReplanResult> {
    const saved = snapshot();
    busy.value = true;
    try {
      const result = await task();
      // 重新读取道具表，保证列表与库一致
      props.value = await api.listProps(shotId);
      frames.value = result.frames;
      reshootFrom.value = result.reshootFrom;
      return result;
    } catch (e) {
      restore(saved, e);
    } finally {
      busy.value = false;
    }
  }

  async function saveProp(shotId: number, prop: PropState): Promise<PropReplanResult> {
    return run(shotId, () =>
      typeof prop.id === 'number' ? api.updatePropAndReplan(prop.id, prop) : api.addPropAndReplan(prop),
    );
  }

  async function removeProp(shotId: number, id: number): Promise<PropReplanResult> {
    return run(shotId, () => api.deletePropAndReplan(id));
  }

  /** 不改动区间，仅从指定帧起按当前轨迹重算（手动重算按钮） */
  async function recompute(shotId: number, fromFrame: number): Promise<PropReplanResult> {
    return run(shotId, () => api.replanShotFrom(shotId, fromFrame));
  }

  return {
    props,
    frames,
    reshootFrom,
    busy,
    load,
    saveProp,
    removeProp,
    recompute,
  };
}
