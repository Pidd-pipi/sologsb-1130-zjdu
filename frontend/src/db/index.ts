/**
 * IndexedDB 持久化层（Dexie 封装）。
 * 库名 gbstopmotion-db，含版本号与升级迁移：
 *   v1 建 shots / frames
 *   v2 增加 props 表与 shotId 索引
 *   v3 增加 takes 表，并按实拍张数回填进度
 *   v4 帧条目增加道具绝对位置 propPosX/Y/Z、已拍标记 shotFrame、补拍标记 needsReshoot；
 *      镜头增加 reshootFromFrame。旧数据由 propOffsetMm 反推绝对位置，保证升级前后曲线/颜色/合计一致。
 */
import Dexie from 'dexie';
import type { Table } from 'dexie';
import type { Shot } from '../types/shot';
import type { FrameEntry } from '../types/frame';
import type { PropState } from '../types/prop';
import type { TakeLog } from '../types/take';
import { backfillPositionsFromOffsets } from '../utils/propPlanning';

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
      .upgrade(async (tx) => {
        // v4：帧条目增加道具绝对位置 / 已拍标记 / 补拍标记；镜头增加补拍起点。
        // 1) 由逐帧 propOffsetMm 反推绝对位置（X 累加，Y/Z 回落 0），
        //    保证升级前后累计曲线、条带着色、位移合计完全一致。
        // 2) 按各镜头累计实拍张数回填 shotFrame（帧号 ≤ 累计张数视为已拍）。
        // 3) 旧镜头 reshootFromFrame 回落 null。
        const frames = await tx.table('frames').toCollection().toArray();
        const takes = await tx.table('takes').toCollection().toArray();
        const takenByShot = new Map<number, number>();
        for (const take of takes) {
          const sid = Number(take.shotId);
          takenByShot.set(sid, (takenByShot.get(sid) ?? 0) + (Number(take.takenFrames) || 0));
        }
        const byShot = new Map<number, FrameEntry[]>();
        for (const f of frames) {
          const sid = Number(f.shotId);
          if (!byShot.has(sid)) byShot.set(sid, []);
          byShot.get(sid)!.push(f as FrameEntry);
        }
        for (const [sid, list] of byShot) {
          const boundary = takenByShot.get(sid) ?? 0;
          const backfilled = backfillPositionsFromOffsets(list);
          for (const f of backfilled) {
            const isShot = f.frameNo <= boundary;
            await tx.table('frames').update(f.id, {
              propPosX: f.propPosX,
              propPosY: f.propPosY,
              propPosZ: f.propPosZ,
              shotFrame: isShot,
              needsReshoot: false,
            });
          }
        }
        await tx
          .table('shots')
          .toCollection()
          .modify((row: Record<string, unknown>) => {
            if (row.reshootFromFrame === undefined) row.reshootFromFrame = null;
          });
      });
  }
}

export const db = new StopMotionDb();
