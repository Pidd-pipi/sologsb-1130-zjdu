/**
 * IndexedDB 持久化层（Dexie 封装）。
 * 库名 gbstopmotion-db，含版本号与升级迁移：
 *   v1 建 shots / frames
 *   v2 增加 props 表与 shotId 索引
 *   v3 增加 takes 表，并按实拍张数回填进度
 *   v4 道具轨迹改为唯一规划来源：帧条目增加 planPose/shotTaken 等字段，
 *      旧数据按既有逐帧位移回填 planPose 并生成系统占位道具「旧轨迹」，
 *      保证升级后逐帧位置、相邻位移、累计曲线与升级前完全一致。
 */
import Dexie from 'dexie';
import type { Table, Transaction } from 'dexie';
import type { Shot } from '../types/shot';
import type { FrameEntry } from '../types/frame';
import type { PropState } from '../types/prop';
import type { TakeLog } from '../types/take';
import { LEGACY_PROP_NAME } from '../utils/propPlan';

export const DB_NAME = 'gbstopmotion-db';

/**
 * 脱代理：Pinia 里的对象是 Proxy，直接写进 IndexedDB 会抛 DataCloneError。
 * 这里统一做一次结构化克隆后的纯对象转换。
 */
export function toPlain<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  try {
    return JSON.parse(JSON.stringify(value)) as T;
  } catch {
    return value;
  }
}

const round1 = (v: number) => Math.round(v * 10) / 10;

/**
 * v4 迁移：旧数据升级后要生成相同结果——
 * 把每帧的标量位移 propOffsetMm 当作沿 X 轴的相邻位移，逐帧累计成绝对位姿
 * 写入 planPose（Y/Z/旋转保持 0），并登记一条系统道具区间承载这条轨迹；
 * 之后由轨迹重算出的每帧位移与累计曲线和升级前逐项相同。
 */
async function migrateV4FromOffsets(tx: Transaction) {
  const frames = await tx.table('frames').toCollection().toArray();
  const props = await tx.table('props').toCollection().toArray();

  const byShot = new Map<number, Array<Record<string, unknown>>>();
  for (const row of frames as Array<Record<string, unknown>>) {
    const shotId = Number(row.shotId);
    if (!Number.isFinite(shotId)) continue;
    const list = byShot.get(shotId) ?? [];
    list.push(row);
    byShot.set(shotId, list);
  }

  const legacyNames = new Set((props as PropState[]).map((p) => p.name));
  const now = Date.now();

  for (const [shotId, shotFrames] of byShot) {
    const ordered = shotFrames.sort((a, b) => Number(a.frameNo) - Number(b.frameNo));
    let acc = 0;
    let firstFrame = 0;
    let lastFrame = 0;
    for (const row of ordered) {
      const offset = Number(row.propOffsetMm) || 0;
      acc = round1(acc + offset);
      const planPose = { [LEGACY_PROP_NAME]: { posX: acc, posY: 0, posZ: 0, rotation: 0 } };
      const frameNo = Number(row.frameNo);
      if (!firstFrame) firstFrame = frameNo;
      lastFrame = frameNo;
      await tx.table('frames').update(row.id as number, {
        planPose,
        shotTaken: false,
      });
    }

    // 生成一条系统占位道具：终点 X = 累计位移，重算时按旧口径线性展开
    let name = LEGACY_PROP_NAME;
    if (legacyNames.has(name)) {
      let suffix = 2;
      while (legacyNames.has(`${LEGACY_PROP_NAME}${suffix}`)) suffix += 1;
      name = `${LEGACY_PROP_NAME}${suffix}`;
    }
    legacyNames.add(name);
    const legacyProp: Record<string, unknown> = {
      name,
      shotId,
      fromFrame: firstFrame || 1,
      toFrame: lastFrame || firstFrame || 1,
      posX: acc,
      posY: 0,
      posZ: 0,
      rotation: 0,
      fixation: '支架',
      system: true,
      updatedAt: now,
    };
    await tx.table('props').add(legacyProp);
  }
}

export class StopMotionDb extends Dexie {
  shots!: Table<Shot, number>;
  frames!: Table<FrameEntry, number>;
  props!: Table<PropState, number>;
  takes!: Table<TakeLog, number>;

  constructor() {
    super(DB_NAME);
    this.version(1).stores({
      shots: '++id, code, status, sceneName',
      frames: '++id, shotId, frameNo, [shotId+frameNo]',
    });
    this.version(2)
      .stores({
        shots: '++id, code, status, sceneName',
        frames: '++id, shotId, frameNo, [shotId+frameNo]',
        props: '++id, shotId, name, [shotId+fromFrame]',
      })
      .upgrade(async (tx) => {
        // v2：为已有帧补齐道具位移字段，保证轨迹页可直接读取
        await tx
          .table('frames')
          .toCollection()
          .modify((row: Record<string, unknown>) => {
            if (typeof row.propOffsetMm !== 'number') row.propOffsetMm = 0;
          });
      });
    this.version(3)
      .stores({
        shots: '++id, code, status, sceneName',
        frames: '++id, shotId, frameNo, [shotId+frameNo]',
        props: '++id, shotId, name, [shotId+fromFrame]',
        takes: '++id, shotId, date, shotCode',
      })
      .upgrade(async (tx) => {
        // v3：按已登记的实拍张数回填完成百分比
        const takes = await tx.table('takes').toCollection().toArray();
        const shots = await tx.table('shots').toCollection().toArray();
        for (const take of takes) {
          const shot = shots.find((s: Record<string, unknown>) => s.id === take.shotId);
          if (!shot || typeof shot.durationSec !== 'number' || typeof shot.fps !== 'number') continue;
          const total = Math.max(1, Math.ceil(shot.durationSec * shot.fps));
          const percent = Math.min(100, Math.round((take.takenFrames / total) * 100));
          await tx.table('takes').update(take.id, { percent });
        }
      });
    this.version(4)
      .stores({
        shots: '++id, code, status, sceneName',
        frames: '++id, shotId, frameNo, [shotId+frameNo]',
        props: '++id, shotId, name, [shotId+fromFrame]',
        takes: '++id, shotId, date, shotCode',
      })
      .upgrade((tx) => migrateV4FromOffsets(tx));
  }
}

export const db = new StopMotionDb();
