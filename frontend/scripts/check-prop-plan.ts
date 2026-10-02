/** 规划器核心行为的一次性自检（node --import tsx 跑，不进生产包） */
import {
  deltaAgainst,
  findReshootStart,
  keyframesOf,
  LEGACY_PROP_NAME,
  planFramesFrom,
  poseAtFrame,
  validatePropSegments,
} from '../src/utils/propPlan';
import type { FrameEntry } from '../src/types/frame';
import type { PropState } from '../src/types/prop';

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) {
    failures += 1;
    console.error('FAIL:', msg);
  } else {
    console.log('ok:', msg);
  }
}

function frame(frameNo: number, extra: Partial<FrameEntry> = {}): FrameEntry {
  return {
    frameNo,
    shotId: 1,
    shotCount: 2,
    exposureSec: 0.25,
    aperture: 5.6,
    iso: 200,
    shutterAngle: 180,
    lighting: '',
    propOffsetMm: extra.propOffsetMm ?? 0,
    note: '',
    updatedAt: 0,
    ...extra,
  };
}

function prop(p: Partial<PropState>): PropState {
  return {
    name: p.name ?? 'A',
    shotId: 1,
    fromFrame: p.fromFrame ?? 1,
    toFrame: p.toFrame ?? 4,
    posX: p.posX ?? 0,
    posY: p.posY ?? 0,
    posZ: p.posZ ?? 0,
    rotation: p.rotation ?? 0,
    fixation: '支架',
    updatedAt: 0,
    ...p,
  };
}

// 1) 段内逐帧线性插值：区间 1–4 终点 X=12 => 帧1=0 帧2=4 帧3=8 帧4=12
{
  const kf = keyframesOf([prop({ fromFrame: 1, toFrame: 4, posX: 12 })]).get('A')!;
  assert(poseAtFrame(kf, 1).posX === 0, '区间起点承接零点（帧1=0）');
  assert(poseAtFrame(kf, 2).posX === 4, '帧2插值=4');
  assert(poseAtFrame(kf, 3).posX === 8, '帧3插值=8');
  assert(poseAtFrame(kf, 4).posX === 12, '帧4到终点=12');
  assert(poseAtFrame(kf, 9).posX === 12, '区间外保持终点');
}

// 2) 相邻位移
{
  const base = [frame(1), frame(2), frame(3), frame(4)];
  const out = planFramesFrom(base, [prop({ fromFrame: 1, toFrame: 4, posX: 12 })], 1);
  const offsets = out.map((f) => f.propOffsetMm);
  assert(JSON.stringify(offsets) === JSON.stringify([0, 4, 4, 4]), `相邻位移 [0,4,4,4]，实际 ${JSON.stringify(offsets)}`);
}

// 3) 两段相接：第二段自动承接第一段终点
{
  const kf = keyframesOf([
    prop({ name: 'A', fromFrame: 1, toFrame: 2, posX: 10 }),
    prop({ name: 'A', fromFrame: 2, toFrame: 4, posX: 30 }),
  ]).get('A')!;
  assert(poseAtFrame(kf, 2).posX === 10, '接点帧=第一段终点10');
  assert(poseAtFrame(kf, 3).posX === 20, '第二段插值20');
  assert(poseAtFrame(kf, 4).posX === 30, '第二段终点30');
}

// 4) 从段起点重算 + 已实拍帧不被覆盖
{
  // 旧计划：1–4 帧 X 到 12，前两帧已实拍
  const base = planFramesFrom([frame(1), frame(2), frame(3), frame(4)], [prop({ fromFrame: 1, toFrame: 4, posX: 12 })], 1);
  base[0] = { ...base[0], id: 1, shotTaken: true, takenAt: 1 };
  base[1] = { ...base[1], id: 2, shotTaken: true, takenAt: 1 };
  // 新计划：终点改 24，从段起点（1）重算
  const out = planFramesFrom(base, [prop({ fromFrame: 1, toFrame: 4, posX: 24 })], 1);
  assert(out[0].planPose!.A.posX === 0, '已实拍帧1保持旧计划0');
  assert(out[1].planPose!.A.posX === 4, '已实拍帧2保持旧计划4');
  assert(out[2].planPose!.A.posX === 16, `未拍帧3按新计划=16，实际 ${out[2].planPose!.A.posX}`);
  assert(out[3].planPose!.A.posX === 24, '未拍帧4按新计划=24');
  assert(out[0].shotTaken === true && out[1].shotTaken === true, '实拍标记保留');
}

// 5) 补拍起点：已实拍帧与新计划不一致时从最早一格标出
{
  const base = planFramesFrom([frame(1), frame(2), frame(3), frame(4)], [prop({ fromFrame: 1, toFrame: 4, posX: 12 })], 1);
  base[0] = { ...base[0], id: 1, shotTaken: true };
  base[1] = { ...base[1], id: 2, shotTaken: true };
  const start = findReshootStart(base, [prop({ fromFrame: 1, toFrame: 4, posX: 24 })]);
  assert(start === 2, `补拍起点=帧2（帧1位姿恰好一致），实际 ${start}`);

  const noReshoot = findReshootStart(base, [prop({ fromFrame: 1, toFrame: 4, posX: 12 })]);
  assert(noReshoot === null, '计划未变时无需补拍');
}

// 6) 修改区间从中段开始：fromFrame 之前不动
{
  const base = planFramesFrom([frame(1), frame(2), frame(3), frame(4)], [prop({ fromFrame: 1, toFrame: 4, posX: 12 })], 1);
  const untouched = JSON.stringify(base.slice(0, 2));
  // 新段 3–4 是该道具唯一区间：第3帧承接零点、第4帧到 40
  const out = planFramesFrom(base, [prop({ fromFrame: 3, toFrame: 4, posX: 40 })], 3);
  assert(JSON.stringify(out.slice(0, 2)) === untouched, '第3帧之前原样保留');
  assert(out[2].planPose!.A.posX === 0, `第3帧承接新段起点（零点），实际 ${out[2].planPose!.A.posX}`);
  assert(out[3].planPose!.A.posX === 40, `第4帧到新终点40，实际 ${out[3].planPose!.A.posX}`);
}

// 7) 区间校验
{
  let threw = false;
  try {
    validatePropSegments([prop({ name: 'A', fromFrame: 1, toFrame: 3 }), prop({ name: 'A', fromFrame: 2, toFrame: 5 })]);
  } catch {
    threw = true;
  }
  assert(threw, '同道具区间重叠应报错（触发回滚）');
  let touchOk = true;
  try {
    validatePropSegments([prop({ name: 'A', fromFrame: 1, toFrame: 3 }), prop({ name: 'A', fromFrame: 3, toFrame: 5 })]);
  } catch {
    touchOk = false;
  }
  assert(touchOk, '区间首尾相接允许');
}

// 8) 旧数据升级等价：逐帧偏移 [0,5,5,5] 累计成绝对位姿后，重算位移与累计曲线相同
{
  const legacyOffsets = [0, 5, 5, 5];
  let acc = 0;
  const migrated = legacyOffsets.map((o, i) => {
    acc += o;
    return frame(i + 1, {
      propOffsetMm: o,
      planPose: { [LEGACY_PROP_NAME]: { posX: acc, posY: 0, posZ: 0, rotation: 0 } },
    });
  });
  const totalAcc = acc; // 15
  const legacySegment = prop({
    name: LEGACY_PROP_NAME,
    system: true,
    fromFrame: 1,
    toFrame: 4,
    posX: totalAcc,
  });
  const out = planFramesFrom(migrated, [legacySegment], 1);
  const offsets = out.map((f) => f.propOffsetMm);
  assert(JSON.stringify(offsets) === JSON.stringify(legacyOffsets), `旧数据重算位移一致 ${JSON.stringify(offsets)}`);
  const cumulative: number[] = [];
  let s = 0;
  for (const o of offsets) {
    s += o;
    cumulative.push(s);
  }
  assert(JSON.stringify(cumulative) === JSON.stringify([0, 5, 10, 15]), '旧数据累计曲线一致 [0,5,10,15]');
}

// 9) deltaAgainst：首帧无参照时按零点计；多道具合计
{
  const frames = planFramesFrom(
    [frame(1), frame(2)],
    [
      prop({ name: 'A', fromFrame: 1, toFrame: 2, posX: 3 }),
      prop({ name: 'B', fromFrame: 1, toFrame: 2, posY: 4 }),
    ],
    1,
  );
  assert(deltaAgainst(frames[1], frames[0]).total === 7, `相邻合计位移按道具距离求和 3+4=7mm，实际 ${deltaAgainst(frames[1], frames[0]).total}`);
}

console.log(failures ? `\n${failures} 个断言失败` : '\n全部通过');
process.exit(failures ? 1 : 0);
