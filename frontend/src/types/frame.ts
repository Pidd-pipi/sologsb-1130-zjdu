/** 单帧拍摄张数（定格动画常用 1/2/3 张） */
export type ShotCount = 1 | 2 | 3;

export const SHOT_COUNT_OPTIONS: ShotCount[] = [1, 2, 3];

/** 帧条目：一帧的曝光参数、道具位移与实拍记录 */
export interface FrameEntry {
  id?: number;
  /** 帧序号，从 1 开始，随排序重排 */
  frameNo: number;
  /** 所属镜头 id */
  shotId: number;
  /** 拍摄张数 */
  shotCount: ShotCount;
  /** 曝光时间（秒） */
  exposureSec: number;
  /** 光圈 f 值 */
  aperture: number;
  /** 感光度 */
  iso: number;
  /** 快门角度（度） */
  shutterAngle: number;
  /** 灯光配置 */
  lighting: string;
  /** 道具绝对位置 X（mm）：由道具区间绝对位置规划而来，已拍帧保留实拍实际值 */
  propPosX: number;
  /** 道具绝对位置 Y（mm） */
  propPosY: number;
  /** 道具绝对位置 Z（mm） */
  propPosZ: number;
  /** 道具位移量（mm）：相邻帧绝对位置之差（ΔX），由规划推导，不再独立填写 */
  propOffsetMm: number;
  /** 该帧是否已拍摄（场记确认或由实拍张数回填），已拍帧不被新规划直接覆盖 */
  shotFrame: boolean;
  /** 该帧是否因规划变更需要补拍（已拍帧实际值与新规划不一致时置位） */
  needsReshoot: boolean;
  /** 备注 */
  note: string;
  updatedAt: number;
}

export const createEmptyFrame = (shotId: number, frameNo: number): FrameEntry => ({
  frameNo,
  shotId,
  shotCount: 2,
  exposureSec: 0.25,
  aperture: 5.6,
  iso: 200,
  shutterAngle: 180,
  lighting: '主灯 + 柔光箱',
  propPosX: 0,
  propPosY: 0,
  propPosZ: 0,
  propOffsetMm: 0,
  shotFrame: false,
  needsReshoot: false,
  note: '',
  updatedAt: Date.now(),
});

/** 批量曝光设置（供 /frames 编排台使用） */
export interface BatchExposure {
  exposureSec: number;
  aperture: number;
  iso: number;
  shutterAngle: number;
}
