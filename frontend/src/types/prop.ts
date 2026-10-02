/** 道具固定方式 */
export type Fixation = '支架' | '磁吸' | '黏土';

export const FIXATION_OPTIONS: Fixation[] = ['支架', '磁吸', '黏土'];

/** 道具在某一帧上的绝对位姿（位置 mm + 旋转角） */
export interface PropPose {
  /** 位置 X（mm） */
  posX: number;
  /** 位置 Y（mm） */
  posY: number;
  /** 位置 Z（mm） */
  posZ: number;
  /** 旋转角度（度） */
  rotation: number;
}

export const ZERO_POSE: PropPose = { posX: 0, posY: 0, posZ: 0, rotation: 0 };

/** 道具位姿逐分量四舍五入到 0.1mm / 0.1°，避免插值产生长小数 */
export function roundPose(pose: PropPose): PropPose {
  const r = (v: number) => Math.round(v * 10) / 10;
  return { posX: r(pose.posX), posY: r(pose.posY), posZ: r(pose.posZ), rotation: r(pose.rotation) };
}

/** 两个位姿是否逐分量相同 */
export function samePose(a: PropPose | undefined, b: PropPose | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.posX === b.posX && a.posY === b.posY && a.posZ === b.posZ && a.rotation === b.rotation;
}

/** 线性插值：t=0 取 a，t=1 取 b */
export function lerpPose(a: PropPose, b: PropPose, t: number): PropPose {
  const k = Number.isFinite(t) ? Math.min(1, Math.max(0, t)) : 0;
  return {
    posX: a.posX + (b.posX - a.posX) * k,
    posY: a.posY + (b.posY - a.posY) * k,
    posZ: a.posZ + (b.posZ - a.posZ) * k,
    rotation: a.rotation + (b.rotation - a.rotation) * k,
  };
}

/**
 * 道具状态（规划来源）：登记道具在 [fromFrame, toFrame] 这段区间
 * 终点的绝对位姿；规划器以此为关键帧，把位姿按帧展开到帧序中。
 * 同道具的下一段起点自动承接上一段终点，段内逐帧线性插值。
 */
export interface PropState {
  id?: number;
  /** 道具名（同一道具的区间按同名串成一条轨迹） */
  name: string;
  /** 所属镜头 id */
  shotId: number;
  /** 适用帧区间起点（该帧开始离开上一位姿） */
  fromFrame: number;
  /** 适用帧区间终点（该帧落到 posX/posY/posZ/rotation） */
  toFrame: number;
  /** 终点位置 X（mm） */
  posX: number;
  /** 终点位置 Y（mm） */
  posY: number;
  /** 终点位置 Z（mm） */
  posZ: number;
  /** 终点旋转角度（度） */
  rotation: number;
  /** 固定方式 */
  fixation: Fixation;
  /** 系统迁移生成的旧轨迹占位区间，页面默认折叠展示 */
  system?: boolean;
  updatedAt: number;
}

export const createEmptyProp = (shotId: number): PropState => ({
  name: '',
  shotId,
  fromFrame: 1,
  toFrame: 24,
  posX: 0,
  posY: 0,
  posZ: 0,
  rotation: 0,
  fixation: '支架',
  updatedAt: Date.now(),
});
