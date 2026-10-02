/**
 * 道具规划：把「按区间登记的绝对位置」展开成「逐帧绝对位置 + 相邻位移」。
 *
 * 语义约定：
 *  - PropState.posX/Y/Z 是道具在该帧区间结束时所处的绝对位置（mm）。
 *  - 区间内各帧由上一段终点绝对位置线性插值到本段终点绝对位置。
 *  - 帧条上的 propOffsetMm = 相邻帧绝对位置之差（ΔX），由规划推导，不再独立填写。
 *  - 已拍帧（shotFrame 或帧号 ≤ 实拍边界）保留实拍实际值，新规划不覆盖；
 *    仅标出与新规划不一致的帧为需补拍。
 */
import type { FrameEntry } from '../types/frame';
import type { PropState } from '../types/prop';

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface ReplanResult {
  /** 重算后的帧数组（已拍帧保留实际值，未拍帧写入规划值） */
  frames: FrameEntry[];
  /** 规划值与实际值不一致的帧号（含已拍与未拍） */
  changedFrameNos: number[];
  /** 需要补拍的帧号（已拍帧中规划与实际不一致的） */
  reshootFrameNos: number[];
  /** 需补拍的起始帧号（无则 null） */
  reshootFromFrame: number | null;
  /** 本次重算使用的区间起点 */
  anchorFrame: number;
}

/** 位置比较容差（mm），小于该值视为一致 */
const TOL = 1e-6;

function vec(x = 0, y = 0, z = 0): Vec3 {
  return { x, y, z };
}
function sub(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}
function add(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}
function scale(a: Vec3, s: number): Vec3 {
  return { x: a.x * s, y: a.y * s, z: a.z * s };
}
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
function r2v(a: Vec3): Vec3 {
  return { x: round2(a.x), y: round2(a.y), z: round2(a.z) };
}
function targetOf(p: PropState): Vec3 {
  return vec(p.posX, p.posY, p.posZ);
}

/** 帧的实际绝对位置（缺省回落 0） */
export function framePos(frame: FrameEntry): Vec3 {
  return vec(frame.propPosX ?? 0, frame.propPosY ?? 0, frame.propPosZ ?? 0);
}

/** 两帧之间的相邻位移（ΔX/ΔY/ΔZ） */
export function frameDelta(a: FrameEntry, b: FrameEntry): Vec3 {
  return r2v(sub(framePos(b), framePos(a)));
}

/**
 * 从道具区间绝对位置重算逐帧位置与位移。
 *
 * @param frames 该镜头全部帧条目
 * @param props  该镜头全部道具区间
 * @param opts.anchorFrame 重算区间起点（修改某个区间时传该区间的 fromFrame）
 * @param opts.shotBoundary 实拍边界：帧号 ≤ 该值视为已拍（由实拍张数累计得到）
 */
export function replanFromProps(
  frames: FrameEntry[],
  props: PropState[],
  opts: { anchorFrame?: number; shotBoundary?: number } = {},
): ReplanResult {
  const sortedFrames = frames.slice().sort((a, b) => a.frameNo - b.frameNo);
  const sortedProps = props.slice().sort((a, b) => a.fromFrame - b.fromFrame || a.toFrame - b.toFrame);

  const anchorFrame =
    opts.anchorFrame ?? (sortedProps.length ? Math.min(...sortedProps.map((p) => p.fromFrame)) : 1);
  const shotBoundary = opts.shotBoundary ?? 0;

  // 帧号 → 覆盖它的道具区间（重叠时后登记者优先）
  const cover = new Map<number, PropState>();
  for (const p of sortedProps) {
    for (let f = p.fromFrame; f <= p.toFrame; f++) cover.set(f, p);
  }

  // 区间 I 的上一段终点绝对位置：toFrame < I.fromFrame 的区间中 toFrame 最大者
  function prevTargetOf(I: PropState): Vec3 | null {
    let best: PropState | null = null;
    for (const p of sortedProps) {
      if (p.toFrame < I.fromFrame) {
        if (!best || p.toFrame > best.toFrame) best = p;
      }
    }
    return best ? targetOf(best) : null;
  }

  // 重算起点的锚点位置 = anchorFrame 前一帧的实际位置
  const anchorIdx = sortedFrames.findIndex((f) => f.frameNo === anchorFrame);
  const prevFrame = anchorIdx > 0 ? sortedFrames[anchorIdx - 1] : undefined;
  const anchorPos: Vec3 = prevFrame ? framePos(prevFrame) : vec();

  const newFrames: FrameEntry[] = [];
  const changedFrameNos: number[] = [];
  const reshootFrameNos: number[] = [];
  let reshootFromFrame: number | null = null;

  // 重算区间内的累计位置（从前一帧推导）
  let runPos: Vec3 = anchorPos;

  for (const frame of sortedFrames) {
    const fno = frame.frameNo;
    const isShot = frame.shotFrame === true || fno <= shotBoundary;

    // 起点之前的帧属于更早的区间，原样保留
    if (fno < anchorFrame) {
      newFrames.push({ ...frame });
      runPos = framePos(frame);
      continue;
    }

    const I = cover.get(fno);

    if (!I) {
      // 该帧不在任何道具区间内：保留已有值（不覆盖、不改位移），
      // 位置保持为该帧实际值，供后续覆盖帧计算相邻位移
      newFrames.push({ ...frame });
      runPos = framePos(frame);
      continue;
    }

    // 区间可能跨过 anchorFrame：有效起点取 max(I.fromFrame, anchorFrame)
    const effFrom = Math.max(I.fromFrame, anchorFrame);
    const span = Math.max(1, I.toFrame - effFrom);
    const t = (fno - effFrom) / span;
    // 跨过锚点的区间以锚点位置为起点；其余区间以上一段终点为起点
    const base = I.fromFrame < anchorFrame ? anchorPos : prevTargetOf(I) ?? anchorPos;
    const planned = r2v(add(base, scale(sub(targetOf(I), base), t)));
    const plannedOffset = round2(planned.x - runPos.x);

    const differs =
      Math.abs((frame.propPosX ?? 0) - planned.x) > TOL ||
      Math.abs((frame.propPosY ?? 0) - planned.y) > TOL ||
      Math.abs((frame.propPosZ ?? 0) - planned.z) > TOL ||
      Math.abs((frame.propOffsetMm ?? 0) - plannedOffset) > TOL;

    if (isShot) {
      // 已拍帧：保留实际值，仅标注是否需要补拍
      newFrames.push({ ...frame, needsReshoot: differs });
      if (differs) {
        changedFrameNos.push(fno);
        reshootFrameNos.push(fno);
        if (reshootFromFrame === null) reshootFromFrame = fno;
      }
    } else {
      // 未拍帧：写入规划值
      newFrames.push({
        ...frame,
        propPosX: planned.x,
        propPosY: planned.y,
        propPosZ: planned.z,
        propOffsetMm: plannedOffset,
        needsReshoot: false,
      });
      if (differs) {
        changedFrameNos.push(fno);
      }
    }

    runPos = planned;
  }

  return { frames: newFrames, changedFrameNos, reshootFrameNos, reshootFromFrame, anchorFrame };
}

/**
 * 旧数据升级：由逐帧 propOffsetMm 反推绝对位置（X 方向累加，Y/Z 回落 0）。
 * 保证升级后曲线、条带着色、合计与升级前完全一致。
 */
export function backfillPositionsFromOffsets(frames: FrameEntry[]): FrameEntry[] {
  let accX = 0;
  return frames
    .slice()
    .sort((a, b) => a.frameNo - b.frameNo)
    .map((f) => {
      accX += Number.isFinite(f.propOffsetMm) ? f.propOffsetMm : 0;
      return {
        ...f,
        propPosX: round2(accX),
        propPosY: f.propPosY ?? 0,
        propPosZ: f.propPosZ ?? 0,
      };
    });
}
