/**
 * 実戦バランスの詰め（フェーズI-29）の**計測の土台**＝1打球のプレーを決定的に
 * シミュレートする。
 *
 * ## なぜ要るか
 *
 * `ORIGINAL_PARITY.md` の未確認事項には「何試合か遊ばないと分からない」と記録された
 * 数値が7件溜まっている（バイク・ドロップキック・好調・70スキル・ランの長さ・実寸
 * フェンスのHR・乱闘v2）。**勘で定数を動かすと根拠が残らない**ので、まず数字にする。
 *
 * これはこのプロジェクトで実績のあるやり方でもある（PROGRESS.md「CPUのHR連発は、
 * まず実機で測定して定量事実を掴んでから対処した／修正後の検証は打撃物理を複製した
 * 決定論シミュレーションで行った」）。今回はその場かぎりのスクリプトにせず、
 * **以降の調整でも使い回せる土台**として残す。
 *
 * ## 何を再利用し、何を再現しているか（この境界が重要）
 *
 * - **判定はすべて `src/core` の純粋関数をそのまま呼ぶ**（`judgeSwing` /
 *   `stepBattedBall` / `fenceAt` / `nearestCatchableFielder` / `chooseCpuFinePlay` /
 *   `fallbackHit` / `isFairPosition` / `predictLanding`）。**ここに判定式は1つも書かない**
 *   ＝定数を動かせばシミュレータの結果も一緒に動く（「見えている壁と当たる壁を同じ
 *   関数から起こす」C-14の整理と同じ）。
 * - **再現しているのは「フレームの回し方」だけ**：野手の一斉移動・塁カバー・捕球を
 *   毎フレーム試す順序は Three.js に依存する `scenes/chicchaiScene.ts` の中にあるので、
 *   ここでは同じ順序を書き写している（下の `stepPlay` のコメントが対応箇所を示す）。
 *   **この部分だけはシーン層と二重になる**ので、実機（Playwright）で突き合わせて
 *   ずれていないことを確かめてから数値を動かすこと。
 *
 * ## 前提（意図的な単純化）
 *
 * - **走者は打者走者ひとりだけ**（塁上に走者を置かない）。打球そのものの帰結を測るのが
 *   目的で、走者がいると「どの塁へ投げるか」というCPUの選択が混ざる。
 * - **守備はCPU**（人間の一斉移動は入力次第なので測れない）。CPU守備は決定的なので、
 *   同じ打球には必ず同じ帰結が出る＝測ったものが再現する。
 */
import {
  type BattedBall,
  type BattedBallLaunch,
  createBattedBall,
  isFairPosition,
  stepBattedBall,
} from '../../src/core/batting';
import { type Ballpark, DEFAULT_BALLPARK, fallbackHit } from '../../src/core/ballpark';
import {
  type BaseKey,
  type FielderId,
  type Vec2,
  BASE_ARRIVE_RADIUS,
  BASE_COVER_ASSIGNMENTS,
  BASE_POSITIONS,
  CONTROLLABLE_FIELDERS,
  FIELDER_HOME_POSITIONS,
  FIELDER_SPEED,
  FINE_PLAY_ACTIVE_SEC,
  FINE_PLAY_DIVE_RECOVERY_SEC,
  FINE_PLAY_DIVE_SPEED,
  FINE_PLAY_JUMP_RECOVERY_SEC,
  RUNNER_SPEED,
  THROW_SPEED,
  type FinePlayKind,
  chooseCpuFinePlay,
  distance,
  finePlayReach,
  nearestCatchableFielder,
  nearestFielder,
  predictLanding,
} from '../../src/core/fielding';
import type { HitType } from '../../src/core/rules';

// ---- シーン層（chicchaiScene.ts）の定数のうち、あちらがモジュール内に閉じているもの ----
//
// **export されていないので値を書き写している**。動かしたらここも直すこと
// （テスト `tests/balance.test.ts` が両者の一致を直接は守れない唯一の箇所）。

/** chicchaiScene.ts の CATCH_MIN_PLAY_SEC（打球発生直後の捕球無効時間） */
export const CATCH_MIN_PLAY_SEC = 0.3;
/** chicchaiScene.ts の RESTING_PICKUP_GRACE_SEC（静止球を拾い直せる猶予） */
export const RESTING_PICKUP_GRACE_SEC = 2.5;
/** chicchaiScene.ts の CPU_POSSESSED_REACTION_SEC（確保から送球までの反応） */
export const CPU_POSSESSED_REACTION_SEC = 0.25;
/** chicchaiScene.ts の CPU_SEEK_EPSILON（目標に着いたとみなす距離） */
export const CPU_SEEK_EPSILON = 0.05;
/** chicchaiScene.ts の FIELDER_BOUND_RADIUS（野手が出られない範囲） */
export const FIELDER_BOUND_RADIUS = 98;
/** chicchaiScene.ts の MAX_PLAY_SEC（この時間で打ち切って三塁打にする） */
export const MAX_PLAY_SEC = 15;
/** 実機と同じ 60fps 固定で回す（可変フレームの揺れを持ち込まない） */
export const SIM_DT = 1 / 60;

/**
 * 1打球の帰結。**シーン層の `FieldPlayOutcome` そのものではなく、計測に要る粒度**
 * （誰が捕ったか・どう決着したか）まで分解してある。
 */
export type PlayOutcome =
  | { kind: 'homerun' }
  /** ノーバウンドで柵越え以外＝ファウル、または着地点がファウル */
  | { kind: 'foul' }
  /** ワンバウンド柵越え（エンタイトルツーベース） */
  | { kind: 'groundRuleDouble' }
  /** ノーバウンド捕球＝フライアウト */
  | { kind: 'flyout'; by: FielderId }
  /** 拾って一塁へ送球し、打者走者を刺した */
  | { kind: 'groundout'; by: FielderId }
  /** 拾って投げたが打者走者のほうが速かった＝安打（内野安打・抜けた単打の両方） */
  | { kind: 'beatThrow'; by: FielderId }
  /** 誰も拾えず、止まった位置の距離で分類された安打 */
  | { kind: 'hit'; hit: HitType };

/** 帰結に加えて、打球そのものの数値（調整の手がかりになる） */
export interface PlayResult {
  outcome: PlayOutcome;
  /** 打球初速 m/s */
  exitSpeed: number;
  /** 打球方向（度。0=中堅、負=三塁側、正=一塁側） */
  directionDeg: number;
  /** 打ち上げ角（度） */
  launchDeg: number;
  /** 最初の着地点までの水平距離 m（柵を越えたら越えた地点までの距離） */
  carry: number;
  /** ボールが止まった／決着した地点の本塁からの距離 m */
  finalDistance: number;
  /** プレーが決着するまでの秒数 */
  seconds: number;
  /**
   * ゴロを確保して**送球できる状態になった**時刻と、そのときの野手の位置
   * （フェーズX-45で足した。フライアウト・柵越え・拾われなかった打球では undefined）。
   *
   * 送りバントの損得は「一塁以外の塁へ投げたらどうなるか」で決まるが、この
   * シミュレータは**打者走者ひとりだけ**を置く前提（このファイルの冒頭参照）なので、
   * 他の塁への送球は呼び出し側が組み立てるしかない。その材料がこの2つ
   * （送球時間＝この位置から目的の塁までの距離÷THROW_SPEED）。
   *
   * **確保から送球までの反応時間（`CPU_POSSESSED_REACTION_SEC`）は含まない**
   * （`sec` は確保の瞬間）。反応の間に野手は動かないので、`pos` は送球の瞬間の位置と同じ。
   */
  fielded?: { by: FielderId; sec: number; pos: Vec2 };
}

export interface PlayOptions {
  park?: Ballpark;
  /** 野手ごとの捕球半径の上乗せ（スキル。既定は全員 0＝素の 2.6m） */
  catchBonus?: (id: FielderId) => number;
  /** 打者走者の走力 m/s（既定は平均） */
  runnerSpeed?: number;
  /** CPU守備のファインプレイを使うか（既定 true＝実機と同じ） */
  finePlay?: boolean;
  /**
   * 1フレームごとの状態を覗く（実機照合用）。実機に一時的に仕込むフックと同じ粒度で
   * 出せるようにしてあるので、そのまま突き合わせられる。
   */
  trace?: (frame: {
    elapsed: number;
    ball: { x: number; y: number; z: number };
    fielders: Record<FielderId, Vec2>;
  }) => void;
}

interface FinePlayState {
  id: FielderId;
  kind: FinePlayKind;
  dir: Vec2;
  t: number;
  recoverSec: number;
}

function clampToField(p: Vec2): void {
  const r = Math.hypot(p.x, p.z);
  if (r > FIELDER_BOUND_RADIUS) {
    const scale = FIELDER_BOUND_RADIUS / r;
    p.x *= scale;
    p.z *= scale;
  }
}

/**
 * 打球1つぶんのプレーを最後まで回して帰結を返す（決定的）。
 *
 * フレームの順序は `chicchaiScene.ts` の `update()` の 'flying' 分岐に合わせてある：
 * ①ファインプレイの進行 → ②野手の移動 → ③CPUのファインプレイ判断 → ④捕球判定
 * → ⑤走者の移動 → ⑥ボール物理・決着のポーリング。**捕球判定はボールを進める前**に
 * 行われる（＝そのフレームの頭のボール位置で判定する）ので、ここでも同じにしている。
 */
export function simulatePlay(
  launch: BattedBallLaunch,
  contactX: number,
  opts: PlayOptions = {},
): PlayResult {
  const park = opts.park ?? DEFAULT_BALLPARK;
  const catchBonus = opts.catchBonus;
  const runSpeed = opts.runnerSpeed ?? RUNNER_SPEED;
  const useFinePlay = opts.finePlay ?? true;

  const exitSpeed = Math.hypot(launch.vx, launch.vy, launch.vz);
  const horizontal = Math.hypot(launch.vx, launch.vz);
  const directionDeg = (Math.atan2(launch.vx, -launch.vz) * 180) / Math.PI;
  const launchDeg = (Math.atan2(launch.vy, horizontal) * 180) / Math.PI;

  let ball: BattedBall = createBattedBall(launch, contactX);
  const landingPoint = predictLanding(ball);

  const pos: Record<FielderId, Vec2> = Object.fromEntries(
    (Object.keys(FIELDER_HOME_POSITIONS) as FielderId[]).map((id) => [
      id,
      { ...FIELDER_HOME_POSITIONS[id] },
    ]),
  ) as Record<FielderId, Vec2>;

  // 打者走者（本塁→一塁）。塁上の走者は置かない（このファイルの前提）
  const runnerTarget = BASE_POSITIONS.first;
  const runner: Vec2 = { ...BASE_POSITIONS.home };
  let runnerArrived = false;

  let finePlay: FinePlayState | null = null;
  let elapsed = 0;
  let restingT = 0;
  let carry = 0;

  /** ゴロを確保した時刻と位置（フェーズX-45。`throwOut` に入った瞬間に記録する） */
  let fielded: PlayResult['fielded'];

  const finish = (outcome: PlayOutcome): PlayResult => ({
    outcome,
    exitSpeed,
    directionDeg,
    launchDeg,
    carry: carry || Math.hypot(ball.x, ball.z),
    finalDistance: Math.hypot(ball.x, ball.z),
    seconds: elapsed,
    fielded,
  });

  // 拾った後の送球フェーズ（possessed → throwing）。CPUは1送球で完結する
  const throwOut = (by: FielderId): PlayResult => {
    fielded = { by, sec: elapsed, pos: { ...pos[by] } };
    // CPU守備は CPU_POSSESSED_REACTION_SEC の後に「もっとも進んだ走者の塁」へ投げる。
    // その間も走者は走り続けるので、反応時間ぶんを先に進める。
    let t = 0;
    while (t < CPU_POSSESSED_REACTION_SEC && !runnerArrived) {
      stepRunner(SIM_DT);
      t += SIM_DT;
      elapsed += SIM_DT;
    }
    if (runnerArrived) return finish({ kind: 'beatThrow', by });
    const throwTime = distance(pos[by], BASE_POSITIONS.first as Vec2) / THROW_SPEED;
    const runnerTime = distance(runner, runnerTarget) / runSpeed;
    // 同着は走者有利（releaseThrow の `throwTime < timeToSafety(runner)`）
    return finish(
      throwTime < runnerTime ? { kind: 'groundout', by } : { kind: 'beatThrow', by },
    );
  };

  function stepRunner(d: number): void {
    if (runnerArrived) return;
    const remaining = distance(runner, runnerTarget);
    if (remaining <= BASE_ARRIVE_RADIUS) {
      runnerArrived = true;
      return;
    }
    const step = Math.min(runSpeed * d, remaining);
    runner.x += ((runnerTarget.x - runner.x) / remaining) * step;
    runner.z += ((runnerTarget.z - runner.z) / remaining) * step;
  }

  while (elapsed < MAX_PLAY_SEC) {
    opts.trace?.({
      elapsed,
      ball: { x: ball.x, y: ball.y, z: ball.z },
      fielders: Object.fromEntries(
        (Object.keys(pos) as FielderId[]).map((id) => [id, { ...pos[id] }]),
      ) as Record<FielderId, Vec2>,
    });

    // ① ファインプレイの進行（updateFinePlay）
    if (finePlay) {
      finePlay.t += SIM_DT;
      if (finePlay.t >= FINE_PLAY_ACTIVE_SEC + finePlay.recoverSec) {
        finePlay = null;
      } else if (finePlay.kind === 'dive' && finePlay.t < FINE_PLAY_ACTIVE_SEC) {
        const p = pos[finePlay.id];
        p.x += finePlay.dir.x * FINE_PLAY_DIVE_SPEED * SIM_DT;
        p.z += finePlay.dir.z * FINE_PLAY_DIVE_SPEED * SIM_DT;
        clampToField(p);
      }
    }

    // ② 野手の移動（updateFielderMovement）：塁カバー4人は各塁へ、
    //    残り5人は「目標にもっとも近い野手→目標」の向きへ全員が一斉に動く
    const busy = (id: FielderId) => finePlay !== null && finePlay.id === id;
    for (const [id, base] of Object.entries(BASE_COVER_ASSIGNMENTS) as Array<
      [FielderId, BaseKey]
    >) {
      if (busy(id)) continue;
      const p = pos[id];
      const target = BASE_POSITIONS[base];
      const dist = distance(p, target);
      if (dist > CPU_SEEK_EPSILON) {
        const step = Math.min(FIELDER_SPEED * SIM_DT, dist);
        p.x += ((target.x - p.x) / dist) * step;
        p.z += ((target.z - p.z) / dist) * step;
      }
    }
    const cpuTarget: Vec2 = ball.landing !== null ? { x: ball.x, z: ball.z } : landingPoint;
    let moveDir: Vec2 = { x: 0, z: 0 };
    {
      const pool = CONTROLLABLE_FIELDERS;
      const controllablePositions = Object.fromEntries(
        pool.map((id) => [id, pos[id]]),
      ) as Record<FielderId, Vec2>;
      const chaser = nearestFielder(cpuTarget, controllablePositions);
      const p = pos[chaser];
      const dist = distance(p, cpuTarget);
      if (dist > CPU_SEEK_EPSILON) {
        moveDir = { x: (cpuTarget.x - p.x) / dist, z: (cpuTarget.z - p.z) / dist };
      }
    }
    for (const id of CONTROLLABLE_FIELDERS) {
      if (busy(id)) continue;
      const p = pos[id];
      p.x += moveDir.x * FIELDER_SPEED * SIM_DT;
      p.z += moveDir.z * FIELDER_SPEED * SIM_DT;
      clampToField(p);
    }

    // ③ CPUのファインプレイ判断
    if (useFinePlay && finePlay === null && elapsed >= CATCH_MIN_PLAY_SEC) {
      const choice = chooseCpuFinePlay(pos, ball, SIM_DT, catchBonus);
      if (choice) {
        finePlay = {
          ...choice,
          t: 0,
          recoverSec:
            choice.kind === 'jump' ? FINE_PLAY_JUMP_RECOVERY_SEC : FINE_PLAY_DIVE_RECOVERY_SEC,
        };
      }
    }

    // ④ 捕球判定（attemptCatch）。ボールを進める前＝フレーム頭の位置で判定する
    if (elapsed >= CATCH_MIN_PLAY_SEC && (ball.landing !== null || isFairPosition(ball.x, ball.z))) {
      const reach =
        finePlay && finePlay.t < FINE_PLAY_ACTIVE_SEC
          ? finePlayReach(finePlay.id, finePlay.kind)
          : undefined;
      const catcher = nearestCatchableFielder(
        pos,
        { x: ball.x, z: ball.z },
        ball.y,
        reach,
        catchBonus,
      );
      if (catcher !== null) {
        if (ball.landing === null) return finish({ kind: 'flyout', by: catcher });
        return throwOut(catcher);
      }
    }

    // ⑤ 走者の移動
    stepRunner(SIM_DT);

    // ⑥ ボール物理と決着のポーリング（decideFallback）
    if (!ball.resting) ball = stepBattedBall(ball, SIM_DT, park);
    elapsed += SIM_DT;
    if (ball.resting) restingT += SIM_DT;
    if (ball.landing !== null && carry === 0) {
      carry = Math.hypot(ball.landing.x, ball.landing.z);
    }

    if (ball.over === 'fly') {
      return finish(isFairPosition(ball.x, ball.z) ? { kind: 'homerun' } : { kind: 'foul' });
    }
    if (ball.over === 'bounce') {
      return finish(
        isFairPosition(ball.x, ball.z) ? { kind: 'groundRuleDouble' } : { kind: 'foul' },
      );
    }
    if (ball.landing && !isFairPosition(ball.landing.x, ball.landing.z)) {
      return finish({ kind: 'foul' });
    }
    if (ball.resting && restingT >= RESTING_PICKUP_GRACE_SEC) {
      return finish({ kind: 'hit', hit: fallbackHit(park, ball.x, ball.z) });
    }
  }
  return finish({ kind: 'hit', hit: 'triple' });
}

/** 帰結が打者にとって安打か（内野安打・柵越え・距離分類のヒットを含む） */
export function isHit(outcome: PlayOutcome): boolean {
  return (
    outcome.kind === 'hit' ||
    outcome.kind === 'homerun' ||
    outcome.kind === 'groundRuleDouble' ||
    outcome.kind === 'beatThrow'
  );
}

/** 帰結が長打（二塁打以上）か */
export function isExtraBase(outcome: PlayOutcome): boolean {
  if (outcome.kind === 'homerun' || outcome.kind === 'groundRuleDouble') return true;
  return outcome.kind === 'hit' && outcome.hit !== 'single';
}
