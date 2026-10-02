/** 数据访问层：所有读写都在这里收口，写入前统一脱代理 */
import { db, toPlain } from './index';
import type { Shot } from '../types/shot';
import type { FrameEntry } from '../types/frame';
import type { PropState } from '../types/prop';
import type { TakeLog } from '../types/take';
import { findReshootStart, planFramesFrom, validatePropSegments } from '../utils/propPlan';

export interface PropReplanResult {
  /** 重算后的完整帧序 */
  frames: FrameEntry[];
  /** 从哪一格（帧号）开始需要补拍；无需补拍为 null */
  reshootFrom: number | null;
  /** 受影响道具区间的 id（新增/编辑/删除） */
  propId: number;
}

export async function initDb(): Promise<void> {
  if (!db.isOpen()) await db.open();
}

/* ---------------- shots ---------------- */

export async function listShots(): Promise<Shot[]> {
  const rows = await db.shots.toArray();
  return rows.sort((a, b) => a.code.localeCompare(b.code, 'zh-Hans-CN'));
}

export async function getShot(id: number): Promise<Shot | undefined> {
  return db.shots.get(id);
}

export async function addShot(shot: Shot): Promise<number> {
  return db.shots.add(toPlain(shot));
}

export async function updateShot(id: number, patch: Partial<Shot>): Promise<void> {
  await db.shots.update(id, toPlain({ ...patch, updatedAt: Date.now() }));
}

export async function deleteShot(id: number): Promise<void> {
  await db.transaction('rw', db.shots, db.frames, db.props, db.takes, async () => {
    await db.frames.where('shotId').equals(id).delete();
    await db.props.where('shotId').equals(id).delete();
    await db.takes.where('shotId').equals(id).delete();
    await db.shots.delete(id);
  });
}

/* ---------------- frames ---------------- */

export async function listFrames(shotId: number): Promise<FrameEntry[]> {
  const rows = await db.frames.where('shotId').equals(shotId).toArray();
  return rows.sort((a, b) => a.frameNo - b.frameNo);
}

export async function listAllFrames(): Promise<FrameEntry[]> {
  return db.frames.toArray();
}

export async function addFrame(frame: FrameEntry): Promise<number> {
  return db.frames.add(toPlain(frame));
}

export async function addFrames(frames: FrameEntry[]): Promise<void> {
  if (!frames.length) return;
  await db.frames.bulkAdd(frames.map((f) => toPlain(f)));
}

export async function updateFrame(id: number, patch: Partial<FrameEntry>): Promise<void> {
  await db.frames.update(id, toPlain({ ...patch, updatedAt: Date.now() }));
}

export async function updateFrames(rows: FrameEntry[]): Promise<void> {
  await db.transaction('rw', db.frames, async () => {
    for (const row of rows) {
      if (typeof row.id !== 'number') continue;
      const { id, ...rest } = row;
      await db.frames.update(id, toPlain({ ...rest, updatedAt: Date.now() }));
    }
  });
}

export async function deleteFrame(id: number): Promise<void> {
  await db.frames.delete(id);
}

export async function replaceShotFrames(shotId: number, frames: FrameEntry[]): Promise<void> {
  const plain = frames.map((f) => toPlain(f));
  await db.transaction('rw', db.frames, async () => {
    await db.frames.where('shotId').equals(shotId).delete();
    if (plain.length) await db.frames.bulkAdd(plain);
  });
}

/* ---------------- props ---------------- */

export async function listProps(shotId: number): Promise<PropState[]> {
  const rows = await db.props.where('shotId').equals(shotId).toArray();
  return rows.sort((a, b) => a.fromFrame - b.fromFrame || a.name.localeCompare(b.name, 'zh-Hans-CN'));
}

export async function listAllProps(): Promise<PropState[]> {
  return db.props.toArray();
}

export async function addProp(prop: PropState): Promise<number> {
  return db.props.add(toPlain(prop));
}

export async function updateProp(id: number, patch: Partial<PropState>): Promise<void> {
  await db.props.update(id, toPlain({ ...patch, updatedAt: Date.now() }));
}

export async function getProp(id: number): Promise<PropState | undefined> {
  return db.props.get(id);
}

export async function deleteProp(id: number): Promise<void> {
  await db.props.delete(id);
}

/**
 * 道具区间落库后，以该区间起点重算该镜头帧序（props 与 frames 同一事务）。
 * apply 负责把新增/编辑/删除动作写入 props 表并返回受影响区间 id；
 * 任何一步抛错（校验失败、写库失败等）事务都会回滚，轨迹与帧序恢复到动手前。
 */
async function mutatePropAndReplan(
  shotId: number,
  recomputeFrom: number,
  apply: () => Promise<number>,
): Promise<PropReplanResult> {
  const result = await db.transaction('rw', db.props, db.frames, async () => {
    const propId = await apply();
    const [freshProps, freshFrames] = await Promise.all([listProps(shotId), listFrames(shotId)]);
    validatePropSegments(freshProps);
    const start = freshFrames.length ? Math.max(freshFrames[0].frameNo, Math.floor(recomputeFrom)) : recomputeFrom;
    const planned = planFramesFrom(freshFrames, freshProps, start);
    const now = Date.now();
    for (let i = 0; i < planned.length; i += 1) {
      const next = planned[i];
      const prev = freshFrames[i];
      if (typeof next.id !== 'number' || next.frameNo < start) continue;
      if (next === prev) continue;
      const { id, ...rest } = next;
      await db.frames.update(id, toPlain({ ...rest, updatedAt: now }));
    }
    const reshootFrom = findReshootStart(planned, freshProps);
    const frames = await listFrames(shotId);
    return { frames, reshootFrom, propId } satisfies PropReplanResult;
  });
  return result;
}

/** 新增道具区间并从该段起点重算帧序；失败整体回滚 */
export async function addPropAndReplan(prop: PropState): Promise<PropReplanResult> {
  const payload = toPlain({ ...prop, updatedAt: Date.now() });
  return mutatePropAndReplan(prop.shotId, prop.fromFrame, async () => db.props.add(payload));
}

/** 编辑道具区间：从「旧起点 / 新起点」较早的一格重算；失败整体回滚 */
export async function updatePropAndReplan(id: number, patch: Partial<PropState>): Promise<PropReplanResult> {
  const before = await db.props.get(id);
  if (!before) throw new Error('该道具记录不存在或已被删除');
  const merged: PropState = { ...before, ...patch, id };
  const shotId = merged.shotId;
  const recomputeFrom = Math.min(before.fromFrame, merged.fromFrame);
  const payload = toPlain({ ...merged, updatedAt: Date.now() });
  return mutatePropAndReplan(shotId, recomputeFrom, async () => {
    await db.props.put(payload);
    return id;
  });
}

/** 删除道具区间并从该段起点重算帧序；失败整体回滚 */
export async function deletePropAndReplan(id: number): Promise<PropReplanResult> {
  const before = await db.props.get(id);
  if (!before) throw new Error('该道具记录不存在或已被删除');
  return mutatePropAndReplan(before.shotId, before.fromFrame, async () => {
    await db.props.delete(id);
    return id;
  });
}

/** 不改道具，仅按当前轨迹从指定帧起重算（供手动重算/异常修复） */
export async function replanShotFrom(shotId: number, fromFrame: number): Promise<PropReplanResult> {
  return mutatePropAndReplan(shotId, fromFrame, async () => 0);
}

/* ---------------- 实拍确认（帧粒度镜头进度） ---------------- */

export async function listFramesByIds(ids: number[]): Promise<FrameEntry[]> {
  if (!ids.length) return [];
  return db.frames.where('id').anyOf(ids).toArray();
}

/**
 * 场记确认：把帧标记为已实拍（含确认时间与实拍张数）。
 * 只追加实拍记录，不改动任何计划位姿；原有 takes 记录原样保留。
 */
/** 场记确认实拍的选项 */
export interface ConfirmTakenOptions {
  /**
   * 补拍确认时传 true：先按当前道具轨迹完整重展开（含已实拍帧），
   * 再把这些格子的新计划位姿/相邻位移固化为实拍结果——
   * 计划不变、原有实拍记录保留，补拍起点随之消除。
   */
  applyNewPlan?: boolean;
  /** applyNewPlan 时使用的道具轨迹（通常为该镜头当前 props） */
  props?: PropState[];
}

export async function confirmFramesTaken(
  frameIds: number[],
  takenCount?: number,
  options: ConfirmTakenOptions = {},
): Promise<FrameEntry[]> {
  const ids = [...new Set(frameIds.filter((id) => typeof id === 'number'))];
  if (!ids.length) return [];
  const now = Date.now();
  await db.transaction('rw', db.frames, async () => {
    // 补拍确认：一次性按当前轨迹重展开（含已实拍帧），供逐格固化
    let replannedById = new Map<number, FrameEntry>();
    if (options.applyNewPlan) {
      const anyFrame = await db.frames.get(ids[0]);
      if (anyFrame) {
        const shotFrames = await db.frames.where('shotId').equals(anyFrame.shotId).toArray();
        const firstNo = shotFrames.length ? Math.min(...shotFrames.map((f) => f.frameNo)) : 1;
        const replanned = planFramesFrom(shotFrames, options.props ?? [], firstNo, { includeTaken: true });
        replannedById = new Map(
          replanned.filter((x) => typeof x.id === 'number').map((x) => [x.id as number, x]),
        );
      }
    }
    for (const id of ids) {
      const frame = await db.frames.get(id);
      if (!frame) continue;
      const patch: Partial<FrameEntry> = {
        shotTaken: true,
        takenAt: now,
        takenCount: typeof takenCount === 'number' ? takenCount : frame.shotCount,
        updatedAt: now,
      };
      if (options.applyNewPlan) {
        const target = replannedById.get(id);
        if (target) {
          patch.planPose = target.planPose;
          patch.propOffsetMm = target.propOffsetMm;
        }
      }
      await db.frames.update(id, toPlain(patch));
    }
  });
  return db.frames.where('id').anyOf(ids).toArray();
}

/** 撤销单帧实拍确认（场记误点撤销，不动计划） */
export async function clearFrameTaken(id: number): Promise<void> {
  await db.frames.update(id, toPlain({ shotTaken: false, takenAt: undefined, takenCount: undefined, updatedAt: Date.now() }));
}

/* ---------------- takes ---------------- */

export async function listTakes(): Promise<TakeLog[]> {
  const rows = await db.takes.toArray();
  return rows.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : (b.id ?? 0) - (a.id ?? 0)));
}

export async function listTakesByShot(shotId: number): Promise<TakeLog[]> {
  return db.takes.where('shotId').equals(shotId).toArray();
}

export async function addTake(take: TakeLog): Promise<number> {
  return db.takes.add(toPlain(take));
}

export async function updateTake(id: number, patch: Partial<TakeLog>): Promise<void> {
  await db.takes.update(id, toPlain({ ...patch, updatedAt: Date.now() }));
}

export async function deleteTake(id: number): Promise<void> {
  await db.takes.delete(id);
}

/** 按实拍张数回写镜头进度（Shot 表保存完成百分比快照，便于总览页快速读取） */
export async function syncShotProgress(shotId: number, percent: number): Promise<void> {
  await db.shots.update(shotId, toPlain({ progressPercent: percent, updatedAt: Date.now() }));
}
