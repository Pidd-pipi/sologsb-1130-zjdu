/**
 * 道具轨迹规划器（唯一规划来源：PropState 区间绝对位姿）。
 *
 * 规则：
 * - 每条 PropState 表示道具在 [fromFrame, toFrame] 区间终点的绝对位姿；
 *   同道具的下一段自动承接上一段终点，段前 / 段后保持位姿，段内逐帧线性插值。
 * - planFramesFrom 把规划展开成逐帧绝对位姿（FrameEntry.planPose），
 *   并回写相邻帧的标量位移 propOffsetMm；只重算 frameNo >= fromFrame 的帧，
 *   已实拍帧（shotTaken）的规划位姿不覆盖，改由 findReshootStart 标出补拍起点。
 */
import type { FrameEntry, FramePlanPose } from '../types/frame';
import type { Fixation, PropPose, PropState } from '../types/prop';
import { lerpPose, roundPose, ZERO_POSE } from '../types/prop';

/** 旧数据迁移时承载逐帧累计位姿的系统道具名 */
export const LEGACY_PROP_NAME = '旧轨迹';

export interface PropKeyframe {
  name: string;
  frame: number;
  pose: PropPose;
  fixation?: Fixation;
}

const round1 = (v: number) => Math.round(v * 10) / 10;

/** 位姿欧氏移动量（mm，旋转不计入距离） */
export function poseDistance(a: PropPose, b: PropPose): number {
  return round1(
    Math.sqrt((b.posX - a.posX) ** 2 + (b.posY - a.posY) ** 2 + (b.posZ - a.posZ) ** 2),
  );
}

/** 逐分量差（curr - prev），用于显示 ΔX/ΔY/ΔZ */
export function poseDiff(curr: PropPose, prev: PropPose): PropPose {
  return {
    posX: round1(curr.posX - prev.posX),
    posY: round1(curr.posY - prev.posY),
    posZ: round1(curr.posZ - prev.posZ),
    rotation: round1(((curr.rotation - prev.rotation + 540) % 360) - 180),
  };
}

/** 把同道具的区间拆成关键帧：区间起点承接上一段终点（首段承接零点） */
export function keyframesOf(props: PropState[]): Map<string, PropKeyframe[]> {
  const groups = new Map<string, PropState[]>();
  for (const p of props) {
    const list = groups.get(p.name) ?? [];
    list.push(p);
    groups.set(p.name, list);
  }
  const result = new Map<string, PropKeyframe[]>();
  for (const [name, segments] of groups) {
    const ordered = segments.slice().sort((a, b) => a.fromFrame - b.fromFrame || a.toFrame - b.toFrame);
    const byFrame = new Map<number, PropKeyframe>();
    let prevEnd: PropPose | null = null;
    for (const seg of ordered) {
      const startPose = prevEnd ?? ZERO_POSE;
      const endPose: PropPose = { posX: seg.posX, posY: seg.posY, posZ: seg.posZ, rotation: seg.rotation };
      byFrame.set(seg.fromFrame, { name, frame: seg.fromFrame, pose: startPose });
      byFrame.set(seg.toFrame, { name, frame: seg.toFrame, pose: endPose, fixation: seg.fixation });
      prevEnd = endPose;
    }
    result.set(
      name,
      [...byFrame.values()].sort((a, b) => a.frame - b.frame),
    );
  }
  return result;
}

/** 关键帧序列上某一帧的绝对位姿：段外保持、段内线性插值 */
export function poseAtFrame(keyframes: PropKeyframe[], frameNo: number): PropPose {
  if (!keyframes.length) return { ...ZERO_POSE };
  const first = keyframes[0];
  const last = keyframes[keyframes.length - 1];
  if (frameNo <= first.frame) return { ...first.pose };
  if (frameNo >= last.frame) return { ...last.pose };
  for (let i = 0; i < keyframes.length - 1; i += 1) {
    const a = keyframes[i];
    const b = keyframes[i + 1];
    if (frameNo >= a.frame && frameNo <= b.frame) {
      if (a.frame === b.frame) return { ...b.pose };
      const t = (frameNo - a.frame) / (b.frame - a.frame);
      return roundPose(lerpPose(a.pose, b.pose, t));
    }
  }
  return { ...last.pose };
}

/** 区间校验：帧号合法、同道具区间不得交叉（首尾相接允许） */
export function validatePropSegments(props: PropState[]): void {
  const groups = new Map<string, PropState[]>();
  for (const p of props) {
    if (!p.name.trim()) throw new Error('道具名不能为空');
    if (!Number.isFinite(p.fromFrame) || !Number.isFinite(p.toFrame) || p.fromFrame < 1) {
      throw new Error(`道具「${p.name}」的帧区间帧号不合法`);
    }
    if (p.toFrame < p.fromFrame) {
      throw new Error(`道具「${p.name}」的结束帧不能早于起始帧（第 ${p.fromFrame} – ${p.toFrame} 帧）`);
    }
    const list = groups.get(p.name) ?? [];
    list.push(p);
    groups.set(p.name, list);
  }
  for (const [name, segments] of groups) {
    const ordered = segments.slice().sort((a, b) => a.fromFrame - b.fromFrame || a.toFrame - b.toFrame);
    for (let i = 1; i < ordered.length; i += 1) {
      const prev = ordered[i - 1];
      const cur = ordered[i];
      if (cur.fromFrame < prev.toFrame) {
        throw new Error(
          `道具「${name}」的帧区间重叠：第 ${prev.fromFrame}–${prev.toFrame} 帧与第 ${cur.fromFrame}–${cur.toFrame} 帧`,
        );
      }
    }
  }
}

type StoredPose = FramePlanPose;

function posesEqual(a: StoredPose | undefined, b: StoredPose | undefined, tol = 0.15): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    Math.abs(a.posX - b.posX) <= tol &&
    Math.abs(a.posY - b.posY) <= tol &&
    Math.abs(a.posZ - b.posZ) <= tol &&
    Math.abs(a.rotation - b.rotation) <= tol
  );
}

/**
 * 以 props 为规划来源，从 fromFrame 起重算帧序。
 * - frameNo < fromFrame 的帧原样保留（含实拍记录）；
 * - 已实拍帧（shotTaken）默认保留动手前的 planPose 与 propOffsetMm，不被新计划覆盖；
 *   传入 includeTaken=true 时连实拍帧一并按新轨迹展开（仅用于补拍判定的目标计划）；
 * - 其余帧写入新计划的绝对位姿，propOffsetMm = 与上一帧各道具移动量之和。
 */
export function planFramesFrom(
  baseFrames: FrameEntry[],
  props: PropState[],
  fromFrame: number,
  options: { includeTaken?: boolean } = {},
): FrameEntry[] {
  const includeTaken = options.includeTaken ?? false;
  const sorted = baseFrames.slice().sort((a, b) => a.frameNo - b.frameNo);
  const start = sorted.length ? Math.max(sorted[0].frameNo, Math.floor(fromFrame)) : fromFrame;
  const keyframeMap = keyframesOf(props);
  const names = [...keyframeMap.keys()];

  let prevOut: FrameEntry | undefined;
  return sorted.map((frame) => {
    if (frame.frameNo < start) {
      prevOut = frame;
      return { ...frame };
    }
    if (frame.shotTaken && !includeTaken) {
      // 已实拍帧保留动手前的计划与记录，作为后续帧的相邻位移基准
      const kept = { ...frame };
      prevOut = kept;
      return kept;
    }

    const planPose: Record<string, PropPose> = {};
    let totalOffset = 0;
    for (const name of names) {
      const keyframes = keyframeMap.get(name);
      if (!keyframes) continue;
      const pose = poseAtFrame(keyframes, frame.frameNo);
      planPose[name] = pose;
      // 相邻位移：上一帧没有该道具时按零点计（迁移数据首帧位移由此保持一致）
      const prevPose = prevOut?.planPose?.[name] ?? ZERO_POSE;
      totalOffset += poseDistance(pose, prevPose);
    }
    const next: FrameEntry = {
      ...frame,
      planPose,
      propOffsetMm: names.length ? round1(totalOffset) : frame.propOffsetMm,
    };
    prevOut = next;
    return next;
  });
}

/**
 * 规划位姿与实拍记录比对：返回最早一帧「已实拍但计划已变」的帧号，
 * 即场记需要开始补拍的格子；没有需要补拍的帧时返回 null。
 * 目标计划用 includeTaken 重新完整展开，保证已实拍帧也能拿到新计划做比对。
 */
export function findReshootStart(frames: FrameEntry[], props: PropState[]): number | null {
  const sorted = frames.slice().sort((a, b) => a.frameNo - b.frameNo);
  if (!sorted.length) return null;
  const planned = planFramesFrom(sorted, props, sorted[0].frameNo, { includeTaken: true });
  for (let i = 0; i < sorted.length; i += 1) {
    const actual = sorted[i];
    if (!actual.shotTaken) continue;
    const target = planned[i];
    const actualNames = Object.keys(actual.planPose ?? {});
    const targetNames = Object.keys(target.planPose ?? {});
    if (actualNames.length !== targetNames.length) return actual.frameNo;
    for (const name of targetNames) {
      if (!posesEqual(actual.planPose?.[name], target.planPose?.[name])) return actual.frameNo;
    }
    // 已实拍帧原本登记过道具位姿，但新计划里这些道具已消失，仍需补拍
    for (const name of actualNames) {
      if (target.planPose?.[name] === undefined) return actual.frameNo;
    }
    // 计划是否需要补拍只以绝对位姿为准（标量位移是派生显示值，不参与判定）
  }
  return null;
}

/** 某帧相对上一帧的逐道具位姿差与合计移动量（帧序展示用） */
export function deltaAgainst(
  frame: FrameEntry,
  prev: FrameEntry | undefined,
): { perName: Record<string, PropPose>; total: number } {
  const current = frame.planPose ?? {};
  const previous = prev?.planPose;
  const names = new Set([...Object.keys(current), ...Object.keys(previous ?? {})]);
  if (!names.size) {
    return { perName: {}, total: Number.isFinite(frame.propOffsetMm) ? frame.propOffsetMm : 0 };
  }
  const perName: Record<string, PropPose> = {};
  let total = 0;
  for (const name of names) {
    const curr = current[name];
    const before = previous?.[name];
    // 上一帧没有、本帧出现：按零点计；本帧消失：按保持计（不计移动）
    const a = curr ?? before ?? ZERO_POSE;
    const b = before ?? (curr ? ZERO_POSE : a);
    const d = poseDiff(a, b);
    perName[name] = d;
    // 每个道具按自身空间移动距离求和，不能先把分量各自相加（A 沿 X、B 沿 Y 时会少算）
    total += poseDistance(a, b);
  }
  return { perName, total: round1(total) };
}
