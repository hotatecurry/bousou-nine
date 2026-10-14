/**
 * CPU守備の追い方（フェーズBBB-83。CLAUDE.md (51)）。
 *
 * BBB-82 までのCPU守備は**いま球にいちばん近い野手を球へ向ける**だけで、打った瞬間に動き出していた。
 * 一斉移動（説明書p20）は全員が同じ向きへ動くので、内野を抜けたゴロを投手が後ろから追い、外野手は
 * 球から遠ざかるほうへ下がっていた（単打のはずの当たりが二塁打・三塁打になっていた）。
 *
 * ここが固定するのは：
 * 1. **先回り**（`planCpuChase`）＝いちばん早く球に触れる野手が、球と出会う点へ向かう。
 *    落ちる前に捕れるなら必ずそちら／捕れなければ落ちた後の球の通り道へ。
 * 2. **打球への反応**（`CPU_FIELD_REACTION_SEC`）＝動き出すまでは向きを持たず、遅れは計画に入る。
 * 3. **帰結**（計測の土台＝実機と同じ動き）＝抜けたゴロ・内野の後ろに落ちる当たりが単打になる。
 */
import { describe, expect, it } from 'vitest';
import { type BattedBallLaunch, createBattedBall } from '../src/core/batting';
import { DEFAULT_BALLPARK } from '../src/core/ballpark';
import {
  CATCH_MIN_PLAY_SEC,
  CATCH_RADIUS,
  CONTROLLABLE_FIELDERS,
  CPU_FIELD_REACTION_SEC,
  FIELDER_HOME_POSITIONS,
  FIELDER_SPEED,
  cpuChase,
  distance,
  planCpuChase,
  predictBallPath,
  predictLandingAt,
} from '../src/core/fielding';
import { simulatePlay } from '../tools/balance/sim';

const DEG = Math.PI / 180;

/** 打球の初速・方向（0＝中堅、正＝一塁側）・打ち上げ角から打ち出しを作る */
function launchOf(speed: number, directionDeg: number, launchDeg: number): BattedBallLaunch {
  const h = speed * Math.cos(launchDeg * DEG);
  return {
    vx: h * Math.sin(directionDeg * DEG),
    vy: speed * Math.sin(launchDeg * DEG),
    vz: -h * Math.cos(directionDeg * DEG),
  };
}

/** その打球の、打った瞬間の計画（野手は定位置・反応の遅れなし） */
function planFor(launch: BattedBallLaunch, holdSec = 0, pool = CONTROLLABLE_FIELDERS) {
  const ball = createBattedBall(launch, 0);
  const path = predictBallPath(ball, DEFAULT_BALLPARK);
  return {
    ball,
    path,
    landing: predictLandingAt(ball),
    plan: planCpuChase(path, 0, FIELDER_HOME_POSITIONS, pool, DEFAULT_BALLPARK, holdSec),
  };
}

// 打球の例（初速 m/s・方向°・打ち上げ角°）
const GROUNDER_RIGHT = launchOf(32, 25, 2); // 右中間寄りのゴロ（内野を抜ける）
const GROUNDER_HOLE = launchOf(36, 35, 2); // 一二塁間を抜けるゴロ
const BLOOPER = launchOf(23, 20, 47); // 内野の後ろ・右に落ちる当たり
const FLY_CENTER = launchOf(33, 0, 35); // 中堅の後ろへのフライ（走って捕れる）
const DEEP_DRIVE = launchOf(41, -6, 21); // 中堅の頭上を越える大飛球
const DROPPED_DRIVE = launchOf(42, -6, 21); // 同・追いかける守備（跳んで固まる）が落とす大飛球
const OVER_MOUND = launchOf(30, 0, 12); // 投手の頭上を越えるライナー
const FOUL_FLY = launchOf(30, 52, 48); // 一塁側のファウルフライ

describe('CPU守備の先回り（planCpuChase）', () => {
  it('内野を抜けるゴロは、投手ではなく外野手が前へ出て拾う', () => {
    for (const launch of [GROUNDER_RIGHT, GROUNDER_HOLE]) {
      const { plan, landing } = planFor(launch);
      // ゴロは本塁のすぐ前で地面に着く＝いちばん近いのはマウンドの投手（BBB-82 まではここで投手が追った）
      expect(Math.hypot(landing.point.x, landing.point.z)).toBeLessThan(25);
      expect(plan?.chaser).toBe('RF');
      expect(plan?.kind).toBe('ground');
      // 右翼手は本塁のほうへ出る（z は外野が負＝前へ出るのは正の向き）
      const dir = cpuChase(FIELDER_HOME_POSITIONS, landing.point, planFor(launch).path, 0).dir;
      expect(dir.z).toBeGreaterThan(0.5);
      expect(Math.hypot(dir.x, dir.z)).toBeCloseTo(1, 6);
    }
  });

  it('届くフライは落ちる前に、落下点のそばで捕る', () => {
    const { plan, landing } = planFor(FLY_CENTER);
    expect(plan?.chaser).toBe('CF');
    expect(plan?.kind).toBe('fly');
    expect(plan!.sec).toBeLessThan(landing.sec);
    // いちばん余裕のある点＝落下点の手前（捕り損ねても球は足元に落ちる）
    expect(distance(plan!.point, landing.point)).toBeLessThan(5);
    expect(plan!.slack).toBeGreaterThan(5);
  });

  it('計画どおりに走れば、その時刻に球は手の届く所にある', () => {
    for (const launch of [GROUNDER_RIGHT, GROUNDER_HOLE, BLOOPER, FLY_CENTER]) {
      const { plan } = planFor(launch);
      const from = FIELDER_HOME_POSITIONS[plan!.chaser];
      // まっすぐ全速で向かって、球より遅くない
      expect(distance(from, plan!.point) - CATCH_RADIUS).toBeLessThanOrEqual(FIELDER_SPEED * plan!.sec + 1e-9);
    }
  });

  it('走っても届かないフライは、落ちた後の球の通り道へ先回りする', () => {
    // 動き出しが1秒遅れれば、中堅の頭上を越える大飛球には落ちる前に届かない
    const late = planFor(DEEP_DRIVE, 1);
    expect(late.plan?.kind).toBe('ground');
    expect(late.plan!.sec).toBeGreaterThan(late.landing.sec);
    // すぐ動けば、跳べば届く高さで間に合う（落ちる前の捕球を必ず先に採る）
    const now = planFor(DEEP_DRIVE, 0);
    expect(now.plan?.kind).not.toBe('ground');
    expect(now.plan!.sec).toBeLessThan(now.landing.sec);
  });

  it('投手はファインプレイができない＝頭上を越える球を跳んで捕る計画にはならない', () => {
    const everyone = planFor(OVER_MOUND);
    // 全員から選べば、後ろの遊撃手が走って捕る
    expect(everyone.plan?.chaser).toBe('SS');
    expect(everyone.plan?.kind).toBe('fly');
    // 投手だけなら、落ちる前には捕れない（跳ぶ・跳び込む計画を持たない）
    const pitcherOnly = planFor(OVER_MOUND, 0, ['P']);
    expect(pitcherOnly.plan?.chaser).toBe('P');
    expect(pitcherOnly.plan?.kind).toBe('ground');
  });

  it('守備範囲のスキルは届く範囲に入る（上乗せのぶん、落ちる前の捕球が計画に入る）', () => {
    const ball = createBattedBall(DEEP_DRIVE, 0);
    const path = predictBallPath(ball, DEFAULT_BALLPARK);
    const plan = (bonus: number) =>
      planCpuChase(path, 0, FIELDER_HOME_POSITIONS, CONTROLLABLE_FIELDERS, DEFAULT_BALLPARK, 1, () => bonus);
    expect(plan(0)?.kind).toBe('ground');
    expect(plan(8)?.kind).not.toBe('ground');
  });

  it('追う役は渡した候補からだけ選ぶ／候補が無ければ計画も無い', () => {
    const { path, landing } = planFor(GROUNDER_RIGHT);
    expect(planCpuChase(path, 0, FIELDER_HOME_POSITIONS, ['P', 'SS'])?.chaser).not.toBe('RF');
    expect(planCpuChase(path, 0, FIELDER_HOME_POSITIONS, [])).toBeNull();
    expect(cpuChase(FIELDER_HOME_POSITIONS, landing.point, path, 0, []).dir).toEqual({ x: 0, z: 0 });
  });

  it('通り道が無ければ（こぼれ球など）、いちばん近い野手を球へ向ける＝BBB-82 までと同じ', () => {
    const target = { x: 30, z: -60 };
    const { dir, plan } = cpuChase(FIELDER_HOME_POSITIONS, target, null, 0);
    expect(plan).toBeNull();
    // いちばん近いのは右翼手（45, -68）→ 球のほうへ
    const rf = FIELDER_HOME_POSITIONS.RF;
    const d = distance(rf, target);
    expect(dir.x).toBeCloseTo((target.x - rf.x) / d, 9);
    expect(dir.z).toBeCloseTo((target.z - rf.z) / d, 9);
  });

  it('打った直後（CATCH_MIN_PLAY_SEC）の点は、捕れる点として選ばない', () => {
    for (const launch of [GROUNDER_RIGHT, GROUNDER_HOLE, BLOOPER, FLY_CENTER, DEEP_DRIVE, OVER_MOUND]) {
      expect(planFor(launch).plan!.sec).toBeGreaterThanOrEqual(CATCH_MIN_PLAY_SEC);
    }
  });

  it('ファウル地域に落ちる球の通り道は、落ちた所で終わる（捕れなくても落下点へ向かう）', () => {
    const { path, landing, plan } = planFor(FOUL_FLY);
    const last = path[path.length - 1];
    expect(last.landed).toBe(true);
    expect(Math.abs(last.sec - landing.sec)).toBeLessThan(0.05);
    // 高く上がるので右翼手が落ちる前に捕る
    expect(plan?.chaser).toBe('RF');
    expect(plan?.kind).toBe('fly');
    // とても遅れれば届かない＝それでも向かう先は落ちた所（その先の転がる球は追わない）
    const late = planFor(FOUL_FLY, 3).plan;
    expect(late?.kind).toBe('ground');
    expect(distance(late!.point, landing.point)).toBeLessThan(1);
  });
});

describe('打球への反応（CPU_FIELD_REACTION_SEC）', () => {
  it('値は 0.45秒（BBB-85：野手の足を 7.0m/s にしたぶん、遅れて動き出して釣り合いを取る）', () => {
    // BBB-83 は「確保→送球・乱闘のCPUと同じ 0.25秒」だった。野手が速くなったぶんCPU守備が
    // 強くなると、人間が打つときの安打が減る（計測：反応 0.25 のままだと 7.5→5.9点/試合）。
    expect(CPU_FIELD_REACTION_SEC).toBe(0.45);
  });

  it('動き出す前は向きを持たない（計画は立つ）', () => {
    const { path, landing } = planFor(GROUNDER_RIGHT);
    const waiting = cpuChase(FIELDER_HOME_POSITIONS, landing.point, path, 0, CONTROLLABLE_FIELDERS, DEFAULT_BALLPARK, 1e-6, 0.25);
    expect(waiting.dir).toEqual({ x: 0, z: 0 });
    expect(waiting.plan?.chaser).toBe('RF');
    // 通り道が無いとき（従来の追い方）も同じ
    const follow = cpuChase(FIELDER_HOME_POSITIONS, landing.point, null, 0, CONTROLLABLE_FIELDERS, DEFAULT_BALLPARK, 1e-6, 0.25);
    expect(follow.dir).toEqual({ x: 0, z: 0 });
  });

  it('遅れは計画に入る＝遅れるほど、球と出会うのは遅い（か同じ）', () => {
    for (const launch of [GROUNDER_RIGHT, GROUNDER_HOLE, BLOOPER]) {
      const secs = [0, 0.25, 0.5, 1].map((hold) => planFor(launch, hold).plan!.sec);
      for (let i = 1; i < secs.length; i += 1) expect(secs[i]).toBeGreaterThanOrEqual(secs[i - 1]);
    }
  });
});

describe('先回りの帰結（計測の土台＝実機と同じ動き）', () => {
  const OLD = { chase: 'follow', reactionSec: 0 } as const; // BBB-82 までのCPU守備

  it('一二塁間を抜けたゴロ：追いかける守備では投手が拾って二塁打、先回りでは右翼手が拾って単打', () => {
    const before = simulatePlay(GROUNDER_HOLE, 0, OLD);
    const after = simulatePlay(GROUNDER_HOLE, 0);
    expect(before.outcome).toEqual({ kind: 'beatThrow', by: 'P', bases: 2 });
    expect(after.outcome).toEqual({ kind: 'beatThrow', by: 'RF' });
    // 拾うのは4秒早い（7.5秒 → 3.5秒）
    expect(before.fielded!.sec - after.fielded!.sec).toBeGreaterThan(3);
  });

  it('内野の後ろに落ちる当たり：遊撃手が後ろから追って二塁打だったのが、外野手が前へ出て単打', () => {
    // 野手の足 6.0m/s（BBB-83）では 三塁打→右翼手の単打だった。7.0m/s（BBB-85）では
    // 追いかける守備でも二塁打で止まり、先回りでは中堅手が拾う（どちらも単打に収まるのは同じ）
    const before = simulatePlay(BLOOPER, 0, OLD);
    const after = simulatePlay(BLOOPER, 0);
    expect(before.outcome).toEqual({ kind: 'beatThrow', by: 'SS', bases: 2 });
    expect(after.outcome).toEqual({ kind: 'beatThrow', by: 'CF' });
    // 拾うのは2秒以上早い
    expect(before.fielded!.sec - after.fielded!.sec).toBeGreaterThan(2);
  });

  it('走って捕れるフライは跳ばずに捕る（追いかける守備が落としていた大飛球を、同じ反応で捕る）', () => {
    // 反応の遅れなしどうしで比べる＝違いは追い方と「走って捕れる野手は跳ばない」だけ
    expect(simulatePlay(DROPPED_DRIVE, 0, OLD).outcome.kind).toBe('beatThrow');
    expect(simulatePlay(DROPPED_DRIVE, 0, { chase: 'intercept', reactionSec: 0 }).outcome).toEqual({
      kind: 'flyout',
      by: 'CF',
    });
  });

  it('打球への反応のぶん、拾うのは遅くなる（遅れは反応の秒数まで。球が自分へ向かって来るぶん縮む）', () => {
    for (const launch of [GROUNDER_RIGHT, GROUNDER_HOLE, BLOOPER]) {
      const instant = simulatePlay(launch, 0, { chase: 'intercept', reactionSec: 0 });
      const reacting = simulatePlay(launch, 0);
      const late = reacting.fielded!.sec - instant.fielded!.sec;
      expect(late).toBeGreaterThanOrEqual(0);
      expect(late).toBeLessThan(CPU_FIELD_REACTION_SEC + 0.05);
    }
    // 内野を抜けるゴロは、遅れのぶんがほぼそのまま出る
    const instant = simulatePlay(GROUNDER_HOLE, 0, { chase: 'intercept', reactionSec: 0 });
    expect(simulatePlay(GROUNDER_HOLE, 0).fielded!.sec - instant.fielded!.sec).toBeGreaterThan(0.2);
  });

  it('届くフライの帰結は変わらない（反応してから走っても捕れる）', () => {
    expect(simulatePlay(FLY_CENTER, 0).outcome).toEqual({ kind: 'flyout', by: 'CF' });
    expect(simulatePlay(FOUL_FLY, 0).outcome).toEqual({ kind: 'flyout', by: 'RF' });
  });

  it('決定的（同じ打球は必ず同じ帰結）', () => {
    for (const launch of [GROUNDER_RIGHT, BLOOPER, DEEP_DRIVE]) {
      expect(simulatePlay(launch, 0)).toEqual(simulatePlay(launch, 0));
    }
  });
});
