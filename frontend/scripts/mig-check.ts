import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import {
  accumulateOffsets,
} from '../src/utils/frameMath';
import { LEGACY_PROP_NAME } from '../src/utils/propPlan';

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) { failures++; console.error('FAIL:', msg); } else console.log('ok:', msg);
}

async function main() {
  // —— 模拟旧库（v3 结构）：镜头 48 帧 24fps，每帧标量位移 0.5mm ——
  const oldDb = new Dexie('gbstopmotion-db');
  oldDb.version(3).stores({
    shots: '++id, code, status, sceneName',
    frames: '++id, shotId, frameNo, [shotId+frameNo]',
    props: '++id, shotId, name, [shotId+fromFrame]',
    takes: '++id, shotId, date, shotCode',
  });
  await oldDb.shots.add({
    code: 'S01', sceneName: '书房', fps: 24, durationSec: 2,
    startFrame: 1, endFrame: 48, status: '拍摄中', owner: '', progressPercent: 0,
    createdAt: 1, updatedAt: 1,
  });
  const oldOffsets = Array.from({ length: 48 }, (_, i) => (i === 0 ? 0 : 0.5));
  await oldDb.frames.bulkAdd(
    oldOffsets.map((o, i) => ({
      frameNo: i + 1, shotId: 1, shotCount: 2, exposureSec: 0.25, aperture: 5.6,
      iso: 200, shutterAngle: 180, lighting: '主灯', propOffsetMm: o, note: '', updatedAt: 1,
    })),
  );
  // 一条旧道具区间（v2/v3 时代人工登记的绝对位姿，保留不动）
  await oldDb.props.add({
    name: '杯子', shotId: 1, fromFrame: 1, toFrame: 48, posX: 100, posY: 20, posZ: 0,
    rotation: 0, fixation: '黏土', updatedAt: 1,
  });
  await oldDb.close();

  const oldCurve = accumulateOffsets(oldOffsets);

  // —— 用应用当前的 db 模块打开（触发 v4 upgrade）——
  const { db } = await import('../src/db/index');
  await db.open();

  const frames = await db.frames.where('shotId').equals(1).toArray();
  assert(frames.length === 48, `帧数保持 48，实际 ${frames.length}`);
  assert(typeof frames[0].planPose === 'object', '帧已带 planPose');
  assert(frames[0].shotTaken === false, '旧帧默认未实拍');

  // 旧数据逐帧偏移必须逐项相同
  const newOffsets = frames.sort((a, b) => a.frameNo - b.frameNo).map((f) => f.propOffsetMm);
  assert(JSON.stringify(newOffsets) === JSON.stringify(oldOffsets), '升级后每帧相邻位移与旧数据逐项相同');

  // 累计曲线相同
  const newCurve = accumulateOffsets(newOffsets);
  assert(JSON.stringify(newCurve) === JSON.stringify(oldCurve), '升级后累计位移曲线相同');
  assert(newCurve[47] === 23.5, `末帧累计 23.5mm，实际 ${newCurve[47]}`);

  // 回填的绝对位姿 = 累计
  assert(frames[47].planPose[LEGACY_PROP_NAME].posX === 23.5, '旧轨迹末帧绝对位置 X=23.5');

  // 系统占位道具已生成
  const props = await db.props.where('shotId').equals(1).toArray();
  const legacy = props.find((p) => p.name.startsWith(LEGACY_PROP_NAME));
  assert(!!legacy && legacy.system === true && legacy.posX === 23.5 && legacy.fromFrame === 1 && legacy.toFrame === 48,
    `系统占位道具已生成，实际 ${JSON.stringify(legacy)}`);
  const cup = props.find((p) => p.name === '杯子');
  assert(!!cup && cup.posX === 100 && !cup.system, '原有道具区间保留且不被标记为系统占位');

  await db.close();
  console.log(failures ? `\n${failures} 个失败` : '\n迁移全部通过');
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
