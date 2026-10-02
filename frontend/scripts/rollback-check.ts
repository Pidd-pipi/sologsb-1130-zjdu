import 'fake-indexeddb/auto';
import Dexie from 'dexie';

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) { failures++; console.error('FAIL:', msg); } else console.log('ok:', msg);
}

async function main() {
  const oldDb = new Dexie('gbstopmotion-db');
  oldDb.version(4).stores({
    shots: '++id, code, status, sceneName',
    frames: '++id, shotId, frameNo, [shotId+frameNo]',
    props: '++id, shotId, name, [shotId+fromFrame]',
    takes: '++id, shotId, date, shotCode',
  });
  await oldDb.shots.add({
    code: 'S01', sceneName: 's', fps: 24, durationSec: 1, startFrame: 1, endFrame: 4,
    status: '未开机', owner: '', progressPercent: 0, createdAt: 1, updatedAt: 1,
  });
  await oldDb.frames.bulkAdd([1, 2, 3, 4].map((n) => ({
    frameNo: n, shotId: 1, shotCount: 2, exposureSec: 0.25, aperture: 5.6, iso: 200,
    shutterAngle: 180, lighting: '', propOffsetMm: 0, planPose: {}, shotTaken: false, note: '', updatedAt: 1,
  })));
  await oldDb.close();

  const { db } = await import('../src/db/index');
  const api = await import('../src/db/api');
  await db.open();

  // 正常登记一段：1–4 到 X=12
  const ok = await api.addPropAndReplan({
    name: 'A', shotId: 1, fromFrame: 1, toFrame: 4, posX: 12, posY: 0, posZ: 0,
    rotation: 0, fixation: '支架', updatedAt: 1,
  });
  assert(ok.frames[3].planPose.A.posX === 12, '初次重算成功，帧4绝对位置=12');

  const beforeProps = await api.listProps(1);
  const beforeFrames = await api.listFrames(1);

  // 制造冲突：另起一段与现有区间重叠，校验必须失败并整体回滚
  let threw = false;
  try {
    await api.addPropAndReplan({
      name: 'A', shotId: 1, fromFrame: 2, toFrame: 3, posX: 99, posY: 0, posZ: 0,
      rotation: 0, fixation: '支架', updatedAt: 2,
    });
  } catch (e) {
    threw = true;
    console.log('   报错信息：', (e as Error).message);
  }
  assert(threw, '区间重叠时报错');

  const afterProps = await api.listProps(1);
  const afterFrames = await api.listFrames(1);
  assert(afterProps.length === beforeProps.length, '道具表回滚：冲突区间未落库');
  assert(JSON.stringify(afterProps) === JSON.stringify(beforeProps), '道具记录恢复到动手前');
  assert(afterFrames.length === 4, '帧序行数不变');
  assert(afterFrames[3].planPose.A.posX === 12, '帧序恢复：帧4绝对位置仍是12');
  assert(afterFrames.every((f, i) => f.frameNo === i + 1), '帧序号完好');

  // 已实拍帧保护：帧1–2 标记实拍，再改计划到 24
  await api.confirmFramesTaken([1, 2]);
  const edit = await api.updatePropAndReplan(ok.propId, { posX: 24 });
  const f = await api.listFrames(1);
  assert(f[0].shotTaken && f[1].shotTaken, '实拍帧标记保留');
  assert(f[1].planPose.A.posX === 4, `已实拍帧2不被新计划覆盖（仍=4），实际 ${f[1].planPose.A.posX}`);
  assert(f[3].planPose.A.posX === 24, '未拍帧4按新计划=24');
  assert(edit.reshootFrom === 2, `标出从帧2起补拍，实际 ${edit.reshootFrom}`);

  // 场记确认补拍（帧2–4）：按当前轨迹固化为实拍，补拍标记消除、原有记录保留
  const ids = f.filter((x) => x.frameNo >= 2).map((x) => x.id as number);
  await api.confirmFramesTaken(ids, undefined, { applyNewPlan: true, props: await api.listProps(1) });
  const { findReshootStart } = await import('../src/utils/propPlan');
  const finalFrames = await api.listFrames(1);
  const finalProps = await api.listProps(1);
  assert(findReshootStart(finalFrames, finalProps) === null, '场记确认补拍后计划已收敛，补拍标记消除');
  assert(finalFrames[1].planPose.A.posX === 8, `补拍后帧2绝对位置固化为新计划8，实际 ${finalFrames[1].planPose.A.posX}`);
  assert(finalFrames.every((x) => x.shotTaken), '四格全部已实拍');

  await db.close();
  console.log(failures ? `\n${failures} 个失败` : '\n回滚与补拍全部通过');
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
