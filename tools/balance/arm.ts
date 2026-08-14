/**
 * 投球腕（ARM）の見え方＝リリース位置のずれ（フェーズCC-50）の計測。
 *
 *   npm run balance:arm
 *
 * P-37・T-41・O-36 と同じ手順で、**入れる前に測って値を決める**
 * （CLAUDE.md「バランス調整の方針＝勘で動かさず必ず計測してから決める」）。
 * 決めたいのは1つ、確かめたいのは4つ：
 *
 * - 決めたい：**`ARM_RELEASE_REACH`（腕を真横まで倒したときのリリースの横のずれ）**。
 *   大きいほど「右投手の球は三塁側から出る」がはっきりするが、大きすぎると
 *   P-37の逆算（狙うコースから曲がり幅ぶん戻した位置）がプレートの外へ出て**削られ**、
 *   名鑑96人の変化量の差が消える（P-37が `CPU_BREAK_STEER_SEC` で避けたのと同じ失敗）。
 * - 確かめたい：(1) **CPUの本塁通過位置が動かないこと**（＝I-29の打たれ方・T-41の
 *   死球の帰結を1つも動かさない）、(2) **人間側の基準線がどれだけ動くか**と
 *   **それでも両隅に届くか**、(3) **名鑑96人でARMの4値がどう散らばるか**、
 *   (4) **打者から見た「球の出どころ」**（右投手×右打者＝背中側から、など4通り）。
 *
 * 判定・逆算は `src/core` の純粋関数をそのまま呼ぶ（このファイルに式は書かない）。
 */
import {
  type CpuPitchPlan,
  chooseCpuPitchPlan,
  cpuPitcherStyle,
  planCpuPitchShape,
} from '../../src/core/cpuPitcher';
import {
  ARM_RELEASE_REACH,
  ARM_SLOT_RAD,
  COURSE_RELEASE_VX,
  LEFT_ARM_SIDE,
  LEFT_BATTER_SIDE,
  type PitchArm,
  type PitchArmSlot,
  type PitchProfile,
  PLATE_Z,
  RELEASE_Z,
  RIGHT_ARM_SIDE,
  RIGHT_BATTER_SIDE,
  RUBBER_HALF_RANGE,
  STRIKE_ZONE_HALF_WIDTH,
  armReleaseOffsetX,
  batterStandX,
  createPitchFlight,
  fatiguedBreak,
  fatiguedControl,
  fatiguedSpeed,
  plateCrossingX,
  releaseXFor,
  stepPitchFlight,
} from '../../src/core/pitch';
import { pitchArmOf, pitcherControl } from '../../src/core/roster';
import { TEAMS, pitcherRowPitching } from '../../src/core/teams';

const row = (cells: readonly string[], w = 12): string => cells.map((c) => c.padStart(w)).join('');
const m = (v: number): string => `${v.toFixed(2)}m`;

/** 名鑑96人 */
const PITCHERS = TEAMS.flatMap((t) =>
  t.pitchers.map((r) => ({ name: r[0] as string, team: t.name, stats: pitcherRowPitching(r) })),
);
type Pitcher = (typeof PITCHERS)[number];

function profileOf(p: Pitcher, fatigue = 0): PitchProfile {
  return {
    speed: fatiguedSpeed(p.stats.speed, fatigue),
    breakLeft: fatiguedBreak(p.stats.breakLeft, fatigue),
    breakRight: fatiguedBreak(p.stats.breakRight, fatigue),
    fork: fatiguedBreak(p.stats.fork, fatigue),
  };
}
function controlOf(p: Pitcher, fatigue = 0): number {
  return fatiguedControl(pitcherControl(p.stats.era), fatigue);
}

/** 全カウント（`chooseCpuPitchPlan` が返す3区分をすべて含む12通り） */
const COUNTS = Array.from({ length: 4 }, (_, balls) =>
  Array.from({ length: 3 }, (_, strikes) => ({ balls, strikes })),
).flat();

function plansOf(p: Pitcher, fatigue = 0): CpuPitchPlan[] {
  const profile = profileOf(p, fatigue);
  return COUNTS.map((count) =>
    chooseCpuPitchPlan(count, cpuPitcherStyle(profile), controlOf(p, fatigue)),
  );
}

console.log('\n=== 1. プレートの余裕＝リリースをずらせる幅の上限 ===');
console.log('   P-37の逆算は「狙うコースから曲がり幅ぶん戻したところ」から投げる。');
console.log(`   そこがプレート（±${RUBBER_HALF_RANGE}m）の外だと曲がりが削られる＝名鑑の差が消える。`);
console.log('   腕のぶんずらすと窓もずれるので、**余裕 = プレート半幅 − 必要なリリースの最大**。');
console.log('   **窓は腕の側へずれる**ので、効くのは片側だけ＝右投げなら「一塁側へどこまで戻れるか」。');
console.log(`${'疲労'.padEnd(10)}${row(['オフセット上限', 'reach上限', '効いている投手', 'カウント'], 18)}`);
let ceiling = Infinity;
for (const fatigue of [0, 0.267, 0.6, 1] as const) {
  let worst = { offset: Infinity, reach: Infinity, who: '', count: '' };
  for (const p of PITCHERS) {
    const profile = profileOf(p, fatigue);
    const arm = pitchArmOf(p.stats.throws);
    const sin = Math.sin(ARM_SLOT_RAD[arm.slot]);
    for (const [i, plan] of plansOf(p, fatigue).entries()) {
      // オフセット0＝従来。ここで削られていないことは P-37 が確認済みなので、
      // この releaseX がそのまま「削らずに投げるのに要る位置」になる。
      const r = planCpuPitchShape(plan, profile).releaseX;
      // 腕の側へ窓がずれる＝**逆側の端**だけが効く（右投げなら +X 側）
      const limit = RUBBER_HALF_RANGE - arm.side * r;
      if (limit < worst.offset) {
        worst = {
          offset: limit,
          reach: limit / sin,
          who: `${p.name}(${p.stats.throws})`,
          count: `${COUNTS[i].balls}-${COUNTS[i].strikes}`,
        };
      }
    }
  }
  ceiling = Math.min(ceiling, worst.reach);
  console.log(
    `${(fatigue === 0 ? '無傷' : `${fatigue}`).padEnd(10)}` +
      row([m(worst.offset), worst.reach.toFixed(3), worst.who, worst.count], 18),
  );
}
console.log(`\n   → 曲がりを1球も削らずに済む reach の上限：${ceiling.toFixed(3)}（どの疲労でも）`);
console.log('     ただし疲労1.0はCPU投手には起こらない（J-30の自動継投＋Z-47の比較で最大0.600）ので、');
console.log('     実際に守るべきは 0.600 の行＝**0.133**。採用値はそれを少し超えるが、');
console.log('     2段目のとおり削られるのは 2球/1152・最大2cm・曲げ終わりは16%のまま。');
console.log(
  `     （採用 ARM_RELEASE_REACH=${ARM_RELEASE_REACH.toFixed(3)}` +
    ` ＝ 上手 ${m(ARM_RELEASE_REACH * Math.sin(ARM_SLOT_RAD.over))}` +
    ` / 下手 ${m(ARM_RELEASE_REACH * Math.sin(ARM_SLOT_RAD.under))}` +
    ` / 横手 ${m(ARM_RELEASE_REACH * Math.sin(ARM_SLOT_RAD.side))}）`,
);

console.log('\n=== 2. オフセット候補ごとの「頭打ち」（P-37と同じ見方） ===');
console.log('   頭打ち＝プレートの端で曲がり幅が変わった球（削られる／逆に大きく曲げさせられる）。');
console.log('   **本塁通過位置は必ず狙いどおり**（曲がりのほうが調整される）ので、見るのは2つ：');
console.log('   (a) 名鑑の変化量の差が消えていないか、(b) 曲げ終わりが遅くなって「見てから」間に合わなくなっていないか。');
console.log('   疲労はZ-47の実測（CPU投手が到達する最大：16球団平均 0.267／最大 0.600）で見る。');
console.log(
  `${'reach'.padEnd(7)}${row(['上手', '下手', '横手', '頭打ち0', '頭打ち.267', '頭打ち.600', '曲がりの変化', '曲げ終わり'], 12)}`,
);
const REACH_CANDIDATES = [
  0.1, 0.15, 0.16, 0.17, 0.18, 0.2, 0.25, 0.3, 0.4, 0.6, 0.825,
] as const;
function offsetFor(reach: number, arm: PitchArm): number {
  return arm.side * reach * Math.sin(ARM_SLOT_RAD[arm.slot]);
}
/** 曲げ終わりが飛行の何割か（P-37は 7〜14%＝スイングを決める前に曲がり終わる） */
function steerRatio(shape: ReturnType<typeof planCpuPitchShape>): number {
  return shape.steerSec / shape.flightSec;
}
for (const reach of REACH_CANDIDATES) {
  const clipped: Record<number, number> = { 0: 0, 0.267: 0, 0.6: 0 };
  let total = 0;
  let worstDelta = 0;
  let worstRatio = 0;
  for (const fatigue of [0, 0.267, 0.6] as const) {
    for (const p of PITCHERS) {
      const profile = profileOf(p, fatigue);
      const offset = offsetFor(reach, pitchArmOf(p.stats.throws));
      for (const plan of plansOf(p, fatigue)) {
        const base = planCpuPitchShape(plan, profile);
        const withArm = planCpuPitchShape(plan, profile, undefined, offset);
        if (fatigue === 0) total += 1;
        if (Math.abs(withArm.breakWidth - base.breakWidth) > 1e-6) clipped[fatigue] += 1;
        worstDelta = Math.max(worstDelta, Math.abs(withArm.breakWidth - base.breakWidth));
        worstRatio = Math.max(worstRatio, steerRatio(withArm));
      }
    }
  }
  const cells = (['over', 'under', 'side'] as const).map((slot) =>
    m(reach * Math.sin(ARM_SLOT_RAD[slot])),
  );
  console.log(
    `${`${reach}`.padEnd(7)}` +
      row(
        [
          ...cells,
          `${clipped[0]}/${total}`,
          `${clipped[0.267]}/${total}`,
          `${clipped[0.6]}/${total}`,
          m(worstDelta),
          `${(worstRatio * 100).toFixed(0)}%`,
        ],
        12,
      ) +
      (Math.abs(reach - ARM_RELEASE_REACH) < 1e-9 ? ' ←採用' : ''),
  );
}

console.log('\n=== 3. CPUの本塁通過位置は動かない（＝I-29の帯・T-41の死球は不変） ===');
console.log('   腕がずらすのは**リリース位置と体の位置**だけで、狙い（targetX）は1行も触らない。');
console.log('   実際に飛ばして、腕あり／なしで本塁通過位置が一致することを確かめる。');
function fly(shape: ReturnType<typeof planCpuPitchShape>): number {
  const dt = 1 / 60;
  let f = createPitchFlight(shape.releaseX, shape.speed, 0);
  let t = 0;
  for (let i = 0; i < 600; i += 1) {
    const held = Math.max(0, Math.min(dt, shape.steerSec - t));
    const next = stepPitchFlight(f, shape.steerX, dt, shape.steerAccel * (held / dt));
    t += dt;
    const cross = plateCrossingX(f, next);
    if (cross !== null) return cross;
    f = next;
  }
  throw new Error('本塁を通過しなかった');
}
let worstDrift = 0;
let worstAim = 0;
for (const p of PITCHERS) {
  const profile = profileOf(p);
  const offset = armReleaseOffsetX(pitchArmOf(p.stats.throws));
  for (const plan of plansOf(p)) {
    const a = fly(planCpuPitchShape(plan, profile));
    const b = fly(planCpuPitchShape(plan, profile, undefined, offset));
    worstDrift = Math.max(worstDrift, Math.abs(a - b));
    worstAim = Math.max(worstAim, Math.abs(b - plan.targetX));
  }
}
console.log(`   腕あり／なしの本塁通過位置の差：最大 ${m(worstDrift)}`);
console.log(`   狙いとのずれ　　　　　　　　　：最大 ${m(worstAim)}（隅の上乗せ 0.05m と比べる）`);

console.log('\n=== 4. 名鑑96人：ARMの4値がどう散らばるか ===');
const byArm = new Map<string, Pitcher[]>();
for (const p of PITCHERS) {
  const list = byArm.get(p.stats.throws) ?? [];
  list.push(p);
  byArm.set(p.stats.throws, list);
}
console.log(`${'ARM'.padEnd(8)}${row(['人数', '腕の側', 'スロット', 'リリースのずれ', 'ゾーン半幅比'], 16)}`);
for (const arm of ['R', 'L', 'S', 'U'] as const) {
  const list = byArm.get(arm) ?? [];
  const a = pitchArmOf(arm);
  const off = armReleaseOffsetX(a);
  console.log(
    `${arm.padEnd(8)}` +
      row(
        [
          `${list.length}人`,
          a.side === RIGHT_ARM_SIDE ? '三塁側(-X)' : '一塁側(+X)',
          a.slot,
          m(off),
          (Math.abs(off) / STRIKE_ZONE_HALF_WIDTH).toFixed(2),
        ],
        16,
      ),
  );
}

console.log('\n=== 5. 人間の投手：基準線はどれだけ動くか／両隅に届くか ===');
console.log('   ど真ん中に立って直球（コース入力なし）を投げたときの本塁通過位置＝腕のずれそのもの。');
console.log(`   コース入力の効き幅は ${COURSE_RELEASE_VX}m/s ＝基準速で約 ${m(COURSE_RELEASE_VX * ((PLATE_Z - RELEASE_Z) / 36))}。`);
const flightNeutral = (PLATE_Z - RELEASE_Z) / 36;
const courseSpan = COURSE_RELEASE_VX * flightNeutral;
console.log(`${'ARM'.padEnd(8)}${row(['中央に立つと', '届く範囲(直球)', '外角の隅', '内角の隅'], 18)}`);
for (const arm of ['R', 'L', 'S', 'U'] as const) {
  const off = armReleaseOffsetX(pitchArmOf(arm));
  const lo = releaseXFor(-RUBBER_HALF_RANGE, off) - courseSpan;
  const hi = releaseXFor(RUBBER_HALF_RANGE, off) + courseSpan;
  const corner = STRIKE_ZONE_HALF_WIDTH + 0.05;
  console.log(
    `${arm.padEnd(8)}` +
      row(
        [
          m(off),
          `${m(lo)} 〜 ${m(hi)}`,
          lo <= -corner ? `届く(-${corner})` : '届かない',
          hi >= corner ? `届く(+${corner})` : '届かない',
        ],
        18,
      ),
  );
}

console.log('\n=== 6. 打者から見た「球の出どころ」（4通り） ===');
console.log('   でっかいモードのカメラは -Z を向く＝**画面右が +X（一塁側）**。');
console.log(`${'投手'.padEnd(12)}${'打者'.padEnd(10)}${row(['球の出どころ', '打者の立ち位置', '見え方'], 16)}`);
for (const [armLabel, arm] of [
  ['右投げ(R)', { side: RIGHT_ARM_SIDE, slot: 'over' as PitchArmSlot }],
  ['左投げ(L)', { side: LEFT_ARM_SIDE, slot: 'over' as PitchArmSlot }],
] as const) {
  for (const [batLabel, side] of [
    ['右打者', RIGHT_BATTER_SIDE],
    ['左打者', LEFT_BATTER_SIDE],
  ] as const) {
    const off = armReleaseOffsetX(arm);
    const stand = batterStandX(side);
    const same = Math.sign(off) === Math.sign(stand);
    console.log(
      `${armLabel.padEnd(12)}${batLabel.padEnd(10)}` +
        row(
          [
            `${m(off)} ${off < 0 ? '画面左' : '画面右'}`,
            `${m(stand)} ${stand < 0 ? '画面左' : '画面右'}`,
            same ? '背中側から（同じ側）' : '正面から（反対側）',
          ],
          16,
        ),
    );
  }
}
console.log('   → 同じ側＝実際の野球の「右投げ対右打者」（球が背中から出てくる）。');

console.log('\n=== 7. 腕の側の隅／逆側の隅（CPUの曲がりが削られるのはどちらか） ===');
console.log('   腕のぶん窓がずれるので、**腕の側へは楽に・逆側へは狭く**なる。');
console.log(`${'ARM'.padEnd(8)}${row(['立てる範囲', '腕の側の隅', '逆側の隅'], 20)}`);
for (const arm of ['R', 'L', 'S', 'U'] as const) {
  const off = armReleaseOffsetX(pitchArmOf(arm));
  const lo = releaseXFor(-RUBBER_HALF_RANGE, off);
  const hi = releaseXFor(RUBBER_HALF_RANGE, off);
  const armSideBudget = off < 0 ? Math.abs(lo) : hi;
  const otherBudget = off < 0 ? hi : Math.abs(lo);
  console.log(
    `${arm.padEnd(8)}` +
      row([`${m(lo)} 〜 ${m(hi)}`, m(armSideBudget), m(otherBudget)], 20),
  );
}
