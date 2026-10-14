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
 * - **CPU守備の向き（誰が追い、どこへ向かうか）は写していない**（フェーズBBB-83）＝シーンと同じ
 *   `fielding.ts` の `cpuChase` を呼ぶ。それまでは「いちばん近い野手を球へ向ける」をここにも
 *   書き写していて、シーンだけを直した UU-69（静止した球の猶予を、野手が近づいている間は数え直す）が
 *   こちらに入っていなかった。BBB-83 で写し、実機の打球24本と確保の時刻が一致することを確かめた。
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
import { clampToPark } from '../../src/core/stands';
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
  PICKUP_RELEASE_SEC,
  type FinePlayKind,
  advancedBase,
  chooseCpuFinePlay,
  chooseCpuStretches,
  distance,
  finePlayReach,
  nearestCatchableFielder,
  type CpuChaseMode,
  CATCH_MIN_PLAY_SEC,
  CPU_FIELD_REACTION_SEC,
  cpuChase,
  predictBallPath,
  predictLandingAt,
  predictSecureAt,
  shouldCpuRoundBase,
  type DefenseBallState,
  shouldCpuRetreat,
  isCatchableFly,
} from '../../src/core/fielding';
import type { HitType } from '../../src/core/rules';

// ---- シーン層（chicchaiScene.ts）の定数のうち、あちらがモジュール内に閉じているもの ----
//
// **export されていないので値を書き写している**。動かしたらここも直すこと
// （テスト `tests/balance.test.ts` が両者の一致を直接は守れない唯一の箇所）。

/** 打球発生直後の捕球無効時間（シーンと同じ `fielding.ts` の値。`bunt.ts` が使う） */
export { CATCH_MIN_PLAY_SEC };
/**
 * chicchaiScene.ts の RESTING_PICKUP_GRACE_SEC（静止球を拾い直せる猶予）。
 * **最寄りの野手が近づいている間は数え直す**（UU-69。下の `restingNearest`）。
 */
export const RESTING_PICKUP_GRACE_SEC = 2.5;
/** chicchaiScene.ts の CPU_POSSESSED_REACTION_SEC（確保から送球までの反応） */
export const CPU_POSSESSED_REACTION_SEC = 0.25;
/**
 * 地面の打球を拾ってから最初の送球までの時間（フェーズBBB-82）＝CPUの反応と、持ち替え
 * （`PICKUP_RELEASE_SEC`）の長いほう（反応は持ち替えの間に済む）。塁で受けた後の投げ継ぎは
 * 反応だけ（`CPU_POSSESSED_REACTION_SEC`）。
 */
export const PICKUP_THROW_DELAY_SEC = Math.max(CPU_POSSESSED_REACTION_SEC, PICKUP_RELEASE_SEC);
/** chicchaiScene.ts の CPU_SEEK_EPSILON（目標に着いたとみなす距離） */
export const CPU_SEEK_EPSILON = 0.05;
/** chicchaiScene.ts の MAX_PLAY_SEC（この時間で打ち切って三塁打にする） */
export const MAX_PLAY_SEC = 15;
/** 計測の守備の追い方の既定＝実機のCPU守備と同じ（フェーズBBB-83） */
export const SIM_CHASE: CpuChaseMode = 'intercept';
/** 計測の守備が打球に反応するまでの秒数の既定＝実機のCPU守備と同じ（フェーズBBB-83） */
export const SIM_REACTION_SEC = CPU_FIELD_REACTION_SEC;
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
  /**
   * 拾って送球し、打者走者を刺した（一塁で。または一塁を踏んで先の塁へ向かったところを。
   * フェーズBBB-77）
   */
  | { kind: 'groundout'; by: FielderId }
  /**
   * 拾って投げたが打者走者のほうが速かった＝安打（内野安打・抜けた単打の両方）。
   * `bases` は打者走者が落ち着いた塁（2＝二塁打・3＝三塁打。**一塁を踏んでそのまま先の塁へ
   * 行った**とき。フェーズBBB-77）。省略は単打。
   */
  | { kind: 'beatThrow'; by: FielderId; bases?: 2 | 3 }
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
   * 打者走者が**一塁を踏んでそのまま先の塁へ**行くかを、CPU攻撃と同じ判断
   * （打球の瞬間の `chooseCpuStretches`＝BBB-77 と、塁を踏んだ瞬間の `shouldCpuRoundBase`＝
   * BBB-78）で決めるか。既定 true＝実機のCPU攻撃と同じ。false はBBB-77より前（打者走者は
   * 野手が拾えば必ず一塁で止まる）。
   */
  stretch?: boolean;
  /**
   * 計測用：打者走者が一塁から先へ狙う塁の数を**決め打ちする**（0＝一塁で止まる／1＝二塁へ…）。
   * 判断の見込みが厳しすぎないかを、「必ず狙ったらどうなったか」と比べるのに使う。
   */
  stretchOverride?: number;
  /**
   * 野手の定位置の差し替え（計測用。フェーズBBB-83）。渡した野手だけ置き換わる＝
   * **定数を書き換えずに外野の深さの候補を比べる**。既定は `FIELDER_HOME_POSITIONS`＝実機と同じ。
   */
  home?: Partial<Record<FielderId, Vec2>>;
  /**
   * CPU守備の追い方（フェーズBBB-83。`fielding.ts` の `CpuChaseMode`）。既定は実機のCPU守備と同じ
   * `SIM_CHASE`。`'follow'` は BBB-82 までの追い方（比べる用）。
   */
  chase?: CpuChaseMode;
  /**
   * 一斉移動の野手が打球に反応して動き出すまでの秒数（フェーズBBB-83。既定は実機のCPU守備と同じ
   * `SIM_REACTION_SEC`）。塁カバーの4人は待たずに塁へ入る。
   */
  reactionSec?: number;
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
  const chase = opts.chase ?? SIM_CHASE;
  const reactionSec = opts.reactionSec ?? SIM_REACTION_SEC;
  /** 打球の通り道（先回りの材料。chicchaiScene.ts が打球の瞬間に一度だけ作るのと同じ） */
  const ballPath = chase === 'intercept' ? predictBallPath(ball, park, SIM_DT, MAX_PLAY_SEC) : null;
  const landingAt = predictLandingAt(ball);
  const landingPoint = landingAt.point;

  const pos: Record<FielderId, Vec2> = Object.fromEntries(
    (Object.keys(FIELDER_HOME_POSITIONS) as FielderId[]).map((id) => [
      id,
      { ...(opts.home?.[id] ?? FIELDER_HOME_POSITIONS[id]) },
    ]),
  ) as Record<FielderId, Vec2>;

  // 打者走者（本塁→一塁）。塁上の走者は置かない（このファイルの前提）
  const runner: Vec2 = { ...BASE_POSITIONS.home };
  let runnerArrived = false;
  // 打者走者が通る塁の並び（フェーズBBB-77）。**打球の瞬間にCPU攻撃と同じ判断で決める**
  // （`chicchaiScene.ts` の `startCpuExtraBases`＝見込みは着地点の予測と、そこへいちばん近い
  // 野手が着く時刻の遅いほう）。一塁を踏むまではフォース、その先はタッチプレー。
  const path: BaseKey[] = ['first'];
  /**
   * 塁を踏んだ瞬間にCPUと同じ判断で決め直すか（フェーズBBB-78）。比べる用の決め打ち
   * （`stretch: false`＝BBB-77より前／`stretchOverride`）では決め直さず、決めた塁の並びどおりに走る。
   */
  const cpuJudges = opts.stretchOverride === undefined && (opts.stretch ?? true);
  if (opts.stretchOverride !== undefined) {
    for (let i = 0; i < opts.stretchOverride; i++) {
      const last = path[path.length - 1];
      if (last === 'home') break;
      path.push(advancedBase(last));
    }
  } else if (opts.stretch ?? true) {
    // 見込みは**転がる球をCPU守備と同じ動きで追って拾う時刻**（`predictSecureAt`。
    // chicchaiScene.ts の `startCpuExtraBases` と同じ）
    const secure = predictSecureAt(ball, park, SIM_DT, 12, pos, chase, reactionSec);
    const extra =
      chooseCpuStretches(
        [{ from: 'batter', to: 'first', forced: true, canStretch: true, start: { ...runner }, speed: runSpeed }],
        { securePoint: secure.point, secureSec: secure.sec },
      ).get('batter') ?? 0;
    for (let i = 0; i < extra; i++) {
      const last = path[path.length - 1];
      if (last === 'home') break;
      path.push(advancedBase(last));
    }
  }
  /** いま向かっている塁（`path` の添字） */
  let leg = 0;
  /** その塁の塁カバー（送球が着いたらこの野手がボールを持つ。chicchaiScene.ts の BASE_COVER_FIELDER） */
  const coverOf = (b: BaseKey): FielderId | undefined =>
    (Object.entries(BASE_COVER_ASSIGNMENTS) as Array<[FielderId, BaseKey]>).find(([, base]) => base === b)?.[0];
  /** 打者走者が最後に落ち着いた塁の数（1＝一塁）。安打の帰結に使う */
  const basesReached = (): 1 | 2 | 3 => (Math.min(3, leg + 1) as 1 | 2 | 3);
  const hitOf = (by: FielderId): PlayOutcome => {
    const b = basesReached();
    return b === 1 ? { kind: 'beatThrow', by } : { kind: 'beatThrow', by, bases: b };
  };

  let finePlay: FinePlayState | null = null;
  let elapsed = 0;
  let restingT = 0;
  /**
   * 静止した球にいちばん近づいた野手の距離（chicchaiScene.ts の `restingNearest`。UU-69）。
   * **最寄りの野手が近づいている間は猶予を数え直す**＝走っている最中に「誰も拾えなかった」で
   * 打ち切らない。BBB-83 で写した（それまでこの計測だけが固定の2.5秒で打ち切っていて、
   * 野手の足を 6.0m/s にした BBB-82 からは、拾えたはずの打球が距離の分類で安打になっていた）。
   */
  let restingNearest = Infinity;
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

  // 拾った後の送球フェーズ（possessed → throwing）。CPU守備は「いま向かっている塁」へ投げる
  // （chicchaiScene.ts の `chooseCpuThrowTarget`＝打者走者ひとりなら先頭＝その走者の塁）。
  // 一塁を踏んで先の塁へ向かう打者走者（フェーズBBB-77）がいれば、投げ継ぎ・引き返し・
  // 塁での踏みとどまりまで実機と同じ順で回す。
  const throwOut = (by: FielderId): PlayResult => {
    fielded = { by, sec: elapsed, pos: { ...pos[by] } };
    let carrier: Vec2 = { ...pos[by] };
    let receiver: FielderId = by;
    for (let throws = 0; throws < 4; throws++) {
      // CPU走者の引き返し（`updateCpuRetreat`）：先の塁へ向かっている（タッチプレーの）区間で、
      // 進めば刺されるが戻れば助かるなら、踏んだ塁へ戻る
      if (!runnerArrived && leg >= 1) {
        const back = BASE_POSITIONS[path[leg - 1]];
        if (
          shouldCpuRetreat({
            carrier,
            runner: { ...runner },
            ahead: BASE_POSITIONS[path[leg]],
            behind: back,
            speed: runSpeed,
            throwDelaySec: throws === 0 ? PICKUP_RELEASE_SEC : 0,
          })
        ) {
          leg -= 1;
          path.length = leg + 1;
        }
      }
      // CPU守備は反応（CPU_POSSESSED_REACTION_SEC）の後に投げる。**拾った直後の1投目は
      // 持ち替え（PICKUP_RELEASE_SEC）も待つ**（フェーズBBB-82）。その間も走者は走り続ける
      let t = 0;
      const wait = throws === 0 ? PICKUP_THROW_DELAY_SEC : CPU_POSSESSED_REACTION_SEC;
      const release = throws === 0 ? PICKUP_RELEASE_SEC : 0;
      while (t < wait && !runnerArrived) {
        const delaySec = Math.max(0, release - t);
        stepRunner(SIM_DT, () => ({ kind: 'held', carrier: { ...carrier }, delaySec }));
        t += SIM_DT;
        elapsed += SIM_DT;
      }
      if (runnerArrived) return finish(hitOf(receiver));
      const thrownTo = path[leg];
      const target = BASE_POSITIONS[thrownTo];
      const throwTime = distance(carrier, target) / THROW_SPEED;
      const runnerTime = distance(runner, target) / runSpeed;
      // 同着は走者有利（releaseThrow の `throwTime < timeToSafety(runner)`）。一塁はフォース、
      // その先はタッチプレーだが、**走り続ける走者は塁で待つ野手に必ず触れられる**ので帰結は同じ
      if (throwTime < runnerTime) return finish({ kind: 'groundout', by: receiver });
      // 間に合った。送球が飛んでいる間も走者は走る（ボールは誰の手にも無い＝踏みとどまらない）
      let flown = 0;
      while (flown < throwTime && !runnerArrived) {
        stepRunner(SIM_DT, () => ({ kind: 'throw', target: thrownTo, remainingSec: Math.max(0, throwTime - flown) }));
        flown += SIM_DT;
        elapsed += SIM_DT;
      }
      if (runnerArrived) return finish(hitOf(receiver));
      // その塁の野手がボールを持った。**2投目は刺せるときだけ**（`chooseCpuThrowTarget`）
      carrier = { ...target };
      receiver = coverOf(thrownTo) ?? receiver;
      const next = BASE_POSITIONS[path[leg]];
      const can =
        distance(carrier, next) / THROW_SPEED + CPU_POSSESSED_REACTION_SEC < distance(runner, next) / runSpeed;
      if (!can) {
        // 刺せない＝畳む。走っている走者は行き先の塁へ着いたものとして扱う（finalizePlay）
        return finish(hitOf(receiver));
      }
    }
    return finish(hitOf(receiver));
  };

  /**
   * 打者走者を1フレーム進める。塁を踏んだら、**その瞬間の守備の状況で次の塁へ行くかを
   * 決め直す**（フェーズBBB-78。`chicchaiScene.ts` の `cpuRoundsBase`＝`shouldCpuRoundBase`）。
   * 打球がまだ落ちていなければ打球の瞬間の見込み（`path`）どおり。`defenseOf` は踏んだ瞬間に
   * だけ呼ぶ（転がる球の見込みは打球と野手を影で回すので重い）。
   *
   * **塁の上で止まっている間に走り出す規則（シーンの `updateCpuRoundBases`）はここでは
   * 回さない**：計測の守備は見込み（`predictSecureAt`）と同じ動きをするので、踏んだ瞬間に
   * 「止まる」なら後で「行ける」に変わることは無い（走者の残りは変わらず、守備の残りだけが
   * 減っていく）。変わるのは守備が見込みより遅いとき＝人間の守備だけ。
   */
  function stepRunner(d: number, defenseOf: () => DefenseBallState | null = () => null): void {
    if (runnerArrived) return;
    const target = BASE_POSITIONS[path[leg]];
    const remaining = distance(runner, target);
    if (remaining <= BASE_ARRIVE_RADIUS) {
      const base = path[leg];
      if (base !== 'home') {
        const planned = leg < path.length - 1;
        const defense = defenseOf();
        const go =
          !cpuJudges || defense === null
            ? planned
            : shouldCpuRoundBase({ runner: { ...runner }, base, speed: runSpeed, defense });
        if (go) {
          if (!planned) path.push(advancedBase(base));
          leg += 1;
          return;
        }
        path.length = leg + 1;
      }
      runnerArrived = true;
      return;
    }
    const step = Math.min(runSpeed * d, remaining);
    runner.x += ((target.x - runner.x) / remaining) * step;
    runner.z += ((target.z - runner.z) / remaining) * step;
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
        clampToPark(park, p);
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
    // 追う役は動ける野手から（跳んでいる・起き上がっている最中の野手は除く。chicchaiScene.ts と同じ）
    const runnable = CONTROLLABLE_FIELDERS.filter((id) => !busy(id));
    const { dir: moveDir, plan: chasePlan } = cpuChase(
      pos,
      cpuTarget,
      ballPath,
      elapsed,
      runnable.length > 0 ? runnable : CONTROLLABLE_FIELDERS,
      park,
      CPU_SEEK_EPSILON,
      Math.max(0, reactionSec - elapsed),
      catchBonus,
    );
    for (const id of CONTROLLABLE_FIELDERS) {
      if (busy(id)) continue;
      const p = pos[id];
      p.x += moveDir.x * FIELDER_SPEED * SIM_DT;
      p.z += moveDir.z * FIELDER_SPEED * SIM_DT;
      clampToPark(park, p);
    }

    // ③ CPUのファインプレイ判断
    if (useFinePlay && finePlay === null && elapsed >= CATCH_MIN_PLAY_SEC) {
      const choice = chooseCpuFinePlay(pos, ball, SIM_DT, catchBonus);
      // 走って手で捕れる見込みの野手は跳ばない（フェーズBBB-83。chicchaiScene.ts と同じ）
      const runsItDown = chasePlan !== null && chasePlan.kind === 'fly' && choice?.id === chasePlan.chaser;
      if (choice && !runsItDown) {
        finePlay = {
          ...choice,
          t: 0,
          recoverSec:
            choice.kind === 'jump' ? FINE_PLAY_JUMP_RECOVERY_SEC : FINE_PLAY_DIVE_RECOVERY_SEC,
        };
      }
    }

    // ④ 捕球判定（attemptCatch）。ボールを進める前＝フレーム頭の位置で判定する
    // 飛球はファウル地域でも捕ればアウト（ファウルフライ。フェーズBBB-79）＝シーンの
    // `attemptCatch` と同じ `isCatchableFly`（捕れないのはスタンドに入った球だけ）
    if (elapsed >= CATCH_MIN_PLAY_SEC && (ball.landing !== null || isCatchableFly(park, ball.x, ball.z))) {
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

    // ⑤ 走者の移動（踏んだ瞬間の判断は、打球が落ちていれば転がる球を拾うまでの見込みで）
    stepRunner(SIM_DT, () =>
      ball.landing === null ? null : { kind: 'loose', secure: predictSecureAt(ball, park, SIM_DT, 12, pos, chase, Math.max(0, reactionSec - elapsed)) },
    );

    // ⑥ ボール物理と決着のポーリング（decideFallback）
    if (!ball.resting) ball = stepBattedBall(ball, SIM_DT, park);
    elapsed += SIM_DT;
    if (ball.resting) {
      let near = Infinity;
      for (const id of Object.keys(pos) as FielderId[]) near = Math.min(near, distance(pos[id], ball));
      if (near < restingNearest) {
        restingNearest = near;
        restingT = 0;
      } else {
        restingT += SIM_DT;
      }
    }
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
  // 一塁を踏んでそのまま先の塁へ行った打者走者（フェーズBBB-77）
  if (outcome.kind === 'beatThrow') return (outcome.bases ?? 1) >= 2;
  return outcome.kind === 'hit' && outcome.hit !== 'single';
}
