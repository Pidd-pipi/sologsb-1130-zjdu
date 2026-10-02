/** 单帧拍摄张数（定格动画常用 1/2/3 张） */
export type ShotCount = 1 | 2 | 3;

export const SHOT_COUNT_OPTIONS: ShotCount[] = [1, 2, 3];

/** 一帧上某道具的规划绝对位姿（由道具轨迹展开生成） */
export interface FramePlanPose {
  posX: number;
  posY: number;
  posZ: number;
  rotation: number;
}

/** 帧条目：一帧的曝光参数、道具逐帧位姿与实拍记录 */
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
  /**
   * 道具位移量（mm）：与上一帧之间的标量位移。
   * 由道具轨迹（PropState）规划展开时回写，保留给旧曲线/速度统计使用。
   */
  propOffsetMm: number;
  /**
   * 规划绝对位姿（由道具轨迹（PropState）规划展开时回写，规划来源为 PropState）。
   * 按道具名各存一份：planPose[name] = { posX, posY, posZ, rotation }。
   */
  planPose?: Record<string, FramePlanPose>;
  /** 该帧是否已经实拍确认（场记确认后置 true，重算只动计划、不覆盖实拍） */
  shotTaken?: boolean;
  /** 实拍确认时间戳（ms） */
  takenAt?: number;
  /** 实拍张数（场记确认时登记，缺省取 shotCount） */
  takenCount?: number;
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
  propOffsetMm: 0,
  planPose: {},
  shotTaken: false,
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
