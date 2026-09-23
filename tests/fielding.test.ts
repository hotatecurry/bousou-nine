import { describe, expect, it } from 'vitest';
import { type BaseRunners, type Bases, EMPTY_BASES } from '../src/core/rules';
import { type BattedBall, createBattedBall, stepBattedBall } from '../src/core/batting';
import { CATCH_Z, RELEASE_Z, SPEED_NEUTRAL, SPEED_SLOW } from '../src/core/pitch';
import { TEAMS, fielderRowStats } from '../src/core/teams';
// 守備側の入口（`shouldCpuPickoff`）と攻撃側の入口（`canTakeLeadOff`）が噛み合って
// いることを固定するため（フェーズKK-58）。
import { shouldCpuPickoff } from '../src/core/cpuPitcher';
import {
  type CpuStealOptions,
  type FielderId,
  type Vec2,
  BASE_ARRIVE_RADIUS,
  BASE_PATH,
  BASE_POSITIONS,
  BASE_COVER_ASSIGNMENTS,
  BIKE_CPU_RETURN_SEC,
  BIKE_ENGAGE_SEC,
  BIKE_OVERRUN_DISTANCE,
  BIKE_SPEED_SCALE,
  bikeOverrunTarget,
  bikeOverrunsAt,
  CATCH_MAX_HEIGHT,
  CATCH_RADIUS,
  CONTROLLABLE_FIELDERS,
  CPU_TAG_UP_MARGIN_SEC,
  CPU_TAG_UP_MIN_DEPTH,
  cpuTagUpDefenseSlack,
  DROPKICK_DOWN_SEC,
  DROPKICK_LOOSE_BALL_DISTANCE,
  DROPKICK_RANGE,
  DROPKICK_STUMBLE_SEC,
  DROPKICK_WARN_RANGE,
  dropkickLooseBallPos,
  dropkickTarget,
  dropkickWarnRange,
  FIELDER_HOME_POSITIONS,
  FIELDER_SPEED,
  FINE_PLAY_ACTIVE_SEC,
  FINE_PLAY_DIVE_RADIUS,
  FINE_PLAY_DIVE_SPEED,
  FINE_PLAY_DIVE_RECOVERY_SEC,
  FINE_PLAY_ELIGIBLE,
  FINE_PLAY_JUMP_HEIGHT,
  FINE_PLAY_TRIGGER_RANGE,
  FLY_CATCH_RELEASE_SEC,
  RUNNER_SPEED,
  RUNNER_SPEED_MAX,
  RUNNER_SPEED_MIN,
  runnerSpeed,
  THROW_SPEED,
  advancedBase,
  applyForcedResult,
  baseFromPadDirection,
  canCatch,
  canTakeLeadOff,
  chooseCpuFinePlay,
  chooseCpuPickoffThrow,
  chooseCpuSteals,
  chooseCpuTagUp,
  chooseSendRunners,
  cpuStealDefenseSlack,
  CPU_STEAL_MAX_DEFENSE_SLACK_SEC,
  resolveCarriedLeads,
  stealableBases,
  CPU_STEAL_JUMP_SEC,
  STEAL_CATCH_RELEASE_SEC,
  STEAL_LEAD,
  stealSafeJumpSec,
  CPU_LEAD_AGGRESSIVE,
  CPU_LEAD_CAUTIOUS,
  CPU_PICKOFF_MARGIN,
  cpuLeadDistance,
  distance,
  finePlayFielder,
  LEAD_SPEED,
  leadDirectionBase,
  leadPosition,
  MAX_LEAD,
  pickoffBases,
  pickoffOutLead,
  finePlayKindFromPad,
  finePlayReach,
  nearestCatchableFielder,
  forcedRunners,
  nearestBaseByDirection,
  nearestFielder,
  originOf,
  predictLanding,
  recallTargetBase,
  resolveDefensePlay,
  sendableRunnerBases,
  TAG_RADIUS,
  tagTarget,
} from '../src/core/fielding';

describe('forcedRunners（強制走者の連鎖判定）', () => {
  it('走者なしは打者のみ一塁へフォース', () => {
    expect(forcedRunners(EMPTY_BASES)).toEqual([{ from: 'batter', to: 'first' }]);
  });

  it('一塁のみ埋まっていれば一塁走者も二塁へフォース', () => {
    const bases: Bases = { first: true, second: false, third: false };
    expect(forcedRunners(bases)).toEqual([
      { from: 'batter', to: 'first' },
      { from: 'first', to: 'second' },
    ]);
  });

  it('二塁のみ埋まっている（一塁が空）と二塁走者はフォースされない', () => {
    const bases: Bases = { first: false, second: true, third: false };
    expect(forcedRunners(bases)).toEqual([{ from: 'batter', to: 'first' }]);
  });

  it('一・二塁が埋まっていれば二塁走者が三塁へフォース', () => {
    const bases: Bases = { first: true, second: true, third: false };
    expect(forcedRunners(bases)).toEqual([
      { from: 'batter', to: 'first' },
      { from: 'first', to: 'second' },
      { from: 'second', to: 'third' },
    ]);
  });

  it('満塁なら三塁走者も本塁へフォース（押し出し）', () => {
    const bases: Bases = { first: true, second: true, third: true };
    expect(forcedRunners(bases)).toEqual([
      { from: 'batter', to: 'first' },
      { from: 'first', to: 'second' },
      { from: 'second', to: 'third' },
      { from: 'third', to: 'home' },
    ]);
  });

  it('三塁のみ（一・二塁空）は三塁走者はフォースされない', () => {
    const bases: Bases = { first: false, second: false, third: true };
    expect(forcedRunners(bases)).toEqual([{ from: 'batter', to: 'first' }]);
  });
});

describe('applyForcedResult（フォース結果の塁反映）', () => {
  it('無死走者なし、打者を一塁で刺すとアウトのみ・走者なし', () => {
    const result = applyForcedResult(EMPTY_BASES, forcedRunners(EMPTY_BASES), 'first');
    expect(result).toEqual({
      bases: { first: false, second: false, third: false },
      outsAdded: 1,
      runs: 0,
    });
  });

  it('無死走者なし、送球が空振り（誰もいない塁への悪送球相当）なら打者は安全に一塁へ', () => {
    const result = applyForcedResult(EMPTY_BASES, forcedRunners(EMPTY_BASES), 'second');
    expect(result).toEqual({
      bases: { first: true, second: false, third: false },
      outsAdded: 0,
      runs: 0,
    });
  });

  it('一塁走者あり、二塁への送球でフォースアウト。打者は一塁に安全進塁（フィルダースチョイス）', () => {
    const bases: Bases = { first: true, second: false, third: false };
    const result = applyForcedResult(bases, forcedRunners(bases), 'second');
    expect(result).toEqual({
      bases: { first: true, second: false, third: false },
      outsAdded: 1,
      runs: 0,
    });
  });

  it('満塁で本塁へ送球しフォースアウト。他の全走者は安全に進塁し1点も入らない', () => {
    const bases: Bases = { first: true, second: true, third: true };
    const result = applyForcedResult(bases, forcedRunners(bases), 'home');
    expect(result).toEqual({
      bases: { first: true, second: true, third: true },
      outsAdded: 1,
      runs: 0,
    });
  });

  it('満塁で一塁へ送球しても、押し出しの本塁走者は生還する', () => {
    const bases: Bases = { first: true, second: true, third: true };
    const result = applyForcedResult(bases, forcedRunners(bases), 'first');
    expect(result).toEqual({
      bases: { first: false, second: true, third: true },
      outsAdded: 1,
      runs: 1,
    });
  });
});

describe('resolveDefensePlay（送球と走者の競争）', () => {
  const bases: Bases = { first: true, second: false, third: false };
  const forced = forcedRunners(bases); // batter->first, first->second

  it('送球が走者より速く到達すればアウト', () => {
    const result = resolveDefensePlay(
      bases,
      forced,
      { batter: 100 }, // 打者はまだ遠い（一塁送球には無関係）
      'first',
      1, // 至近距離からの送球＝ほぼ瞬時
    );
    expect(result.outsAdded).toBe(1);
    expect(result.bases.first).toBe(false);
  });

  it('同着（走者到達時間と送球到達時間が等しい）は走者有利でセーフ', () => {
    const throwDistance = 10;
    const throwTime = throwDistance / THROW_SPEED;
    const runnerRemaining = throwTime * RUNNER_SPEED;
    const result = resolveDefensePlay(
      bases,
      forced,
      { batter: runnerRemaining },
      'first',
      throwDistance,
    );
    expect(result.outsAdded).toBe(0);
    expect(result.bases.first).toBe(true);
  });

  it('走者が送球より速ければセーフ', () => {
    const result = resolveDefensePlay(bases, forced, { batter: 0.1 }, 'first', 50);
    expect(result.outsAdded).toBe(0);
    expect(result.bases.first).toBe(true);
  });

  it('アウトにした走者以外は競争なしで安全に進塁する', () => {
    const result = resolveDefensePlay(
      bases,
      forced,
      { batter: 100, first: 100 }, // 一塁走者はまだ遠いが、二塁への送球ではないので無関係
      'first',
      1,
    );
    expect(result.outsAdded).toBe(1); // 打者アウト
    expect(result.bases.second).toBe(true); // 一塁走者は安全に二塁へ
    expect(result.bases.first).toBe(false);
  });
});

describe('canCatch（捕球可否）', () => {
  it('射程内・低い高さなら捕球できる', () => {
    expect(canCatch({ x: 0, z: 0 }, { x: 1, z: 0 }, 1)).toBe(true);
  });

  it('射程外なら捕球できない', () => {
    expect(canCatch({ x: 0, z: 0 }, { x: CATCH_RADIUS + 1, z: 0 }, 0.5)).toBe(false);
  });

  it('高すぎるボールは捕球できない（ジャンプ・リーチの限界）', () => {
    expect(canCatch({ x: 0, z: 0 }, { x: 0, z: 0 }, CATCH_MAX_HEIGHT + 1)).toBe(false);
  });

  it('境界値（射程・高さぴったり）は捕球できる', () => {
    expect(canCatch({ x: 0, z: 0 }, { x: CATCH_RADIUS, z: 0 }, CATCH_MAX_HEIGHT)).toBe(true);
  });
});

describe('自動捕球の成立性（回帰防止）', () => {
  // 実機テストプレイで「捕球ができず自動でツーベースヒットになる」と報告された不具合の
  // 根本原因は、捕球が「射程内でタイミングよくAを押す」操作だったこと。打球は水平速度が
  // 大きく（36m/s前後）、捕球半径2.6mを100〜200ミリ秒で通り抜けるため、人間の反応速度
  // ではタイミング押しが実質不可能だった（詳細はPROGRESS.md「実装メモ」）。
  // 修正後は、シーン層（chicchaiScene.ts）が毎フレーム自動で捕球を試みる（原作準拠：
  // 捕球にボタンは使わない）。このテストはその前提となる純粋ロジック側の性質、すなわち
  // 「CPU守備と同じ追跡アルゴリズムで打球を追えば、毎フレームのcanCatch判定のどこかで
  // 必ず捕球が成立する」ことを、実機で採取した実際の打球ベクトルで検証する。
  // FIELDER_SPEED・CATCH_RADIUS・CATCH_MAX_HEIGHT・打球物理のいずれかが変わって
  // この打球を捕れなくなったら、このテストが検知する。
  it('着地予測点を追う野手は、標準的な外野フライを毎フレーム判定の自動捕球で捕れる', () => {
    // 実機のCPU打者（決定論的）がストレートを打ち返した実測の打球ベクトル。
    // 中堅手の頭上やや左へ約2.8秒滞空して落ちる、外野フライの代表例。
    const launch = { vx: -4.494709261619378, vy: 13.820715952053684, vz: -35.7225379522667 };
    const landingPoint = predictLanding(createBattedBall(launch, 0));
    const fielderId = nearestFielder(landingPoint, FIELDER_HOME_POSITIONS);
    const fielderPos = { ...FIELDER_HOME_POSITIONS[fielderId] };

    let ball = createBattedBall(launch, 0);
    const dt = 1 / 60;
    let elapsed = 0;
    let caughtBeforeLanding = false;
    while (elapsed < 10 && !ball.resting) {
      // chicchaiScene.ts のCPU追跡と同じ：着地前は着地予測点へ、着地後はボールの現在地へ直進
      const target = ball.landing !== null ? { x: ball.x, z: ball.z } : landingPoint;
      const dx = target.x - fielderPos.x;
      const dz = target.z - fielderPos.z;
      const dist = Math.hypot(dx, dz);
      if (dist > 0.05) {
        const step = Math.min(FIELDER_SPEED * dt, dist);
        fielderPos.x += (dx / dist) * step;
        fielderPos.z += (dz / dist) * step;
      }

      ball = stepBattedBall(ball, dt);
      elapsed += dt;
      // 毎フレームの自動捕球判定（シーン層と同じ）。着地前に成立すればフライアウト
      if (canCatch(fielderPos, { x: ball.x, z: ball.z }, ball.y)) {
        caughtBeforeLanding = ball.landing === null;
        break;
      }
    }

    // ノーバウンドで捕れている（＝フライアウトが成立する）こと
    expect(caughtBeforeLanding).toBe(true);
  });
});

describe('baseFromPadDirection（説明書準拠の絶対塁指定）', () => {
  it('上=二塁、左=三塁、右=一塁、下=本塁', () => {
    expect(baseFromPadDirection(0, 1)).toBe('second');
    expect(baseFromPadDirection(-1, 0)).toBe('third');
    expect(baseFromPadDirection(1, 0)).toBe('first');
    expect(baseFromPadDirection(0, -1)).toBe('home');
  });

  it('無入力は null（呼び出し側が既定の塁を使う）', () => {
    expect(baseFromPadDirection(0, 0)).toBeNull();
  });

  it('斜め入力は上下を優先する（説明書は4方向想定のため決定的フォールバック）', () => {
    expect(baseFromPadDirection(1, 1)).toBe('second');
    expect(baseFromPadDirection(-1, -1)).toBe('home');
  });
});

describe('nearestCatchableFielder（全野手の捕球候補判定）', () => {
  it('射程内の野手がいなければ null', () => {
    expect(
      nearestCatchableFielder(FIELDER_HOME_POSITIONS, { x: 30, z: -45 }, 0.5),
    ).toBeNull();
  });

  it('射程内の野手を返す（塁カバー野手も候補になる）', () => {
    const ballAtFirstBase = { x: FIELDER_HOME_POSITIONS['1B'].x + 1, z: FIELDER_HOME_POSITIONS['1B'].z };
    expect(nearestCatchableFielder(FIELDER_HOME_POSITIONS, ballAtFirstBase, 0.5)).toBe('1B');
  });

  it('複数が射程内なら最も近い野手を返す', () => {
    const positions = {
      ...FIELDER_HOME_POSITIONS,
      SS: { x: 0, z: -30 },
      '2B': { x: 1.5, z: -30 },
    };
    expect(nearestCatchableFielder(positions, { x: 0.2, z: -30 }, 0.5)).toBe('SS');
  });

  it('高すぎるボールは捕球候補なし', () => {
    const ballAtCF = { x: 0, z: -80 };
    expect(
      nearestCatchableFielder(FIELDER_HOME_POSITIONS, ballAtCF, CATCH_MAX_HEIGHT + 1),
    ).toBeNull();
  });
});

describe('塁カバー割当と一斉移動対象（説明書p20準拠）', () => {
  it('塁カバーは4人（捕手=本塁/一塁手=一塁/二塁手=二塁/三塁手=三塁）', () => {
    expect(BASE_COVER_ASSIGNMENTS).toEqual({
      C: 'home',
      '1B': 'first',
      '2B': 'second',
      '3B': 'third',
    });
  });

  it('一斉移動対象は残り5人で、塁カバーと重複しない', () => {
    expect(CONTROLLABLE_FIELDERS).toHaveLength(5);
    for (const id of CONTROLLABLE_FIELDERS) {
      expect(BASE_COVER_ASSIGNMENTS[id]).toBeUndefined();
    }
  });
});

describe('nearestBaseByDirection（十字キーによる塁指定）', () => {
  const home = BASE_POSITIONS.home;

  it('一塁方向の入力は一塁を選ぶ', () => {
    const dir = { x: BASE_POSITIONS.first.x - home.x, z: BASE_POSITIONS.first.z - home.z };
    expect(nearestBaseByDirection(home, dir, ['first', 'second', 'third', 'home'])).toBe('first');
  });

  it('三塁方向の入力は三塁を選ぶ', () => {
    const dir = { x: BASE_POSITIONS.third.x - home.x, z: BASE_POSITIONS.third.z - home.z };
    expect(nearestBaseByDirection(home, dir, ['first', 'second', 'third', 'home'])).toBe('third');
  });

  it('候補が絞られていればその中から選ぶ', () => {
    const dir = { x: BASE_POSITIONS.first.x - home.x, z: BASE_POSITIONS.first.z - home.z };
    expect(nearestBaseByDirection(home, dir, ['second', 'third'])).toBe('second');
  });
});

describe('nearestFielder', () => {
  it('もっとも近い守備位置を返す', () => {
    const near = { x: FIELDER_HOME_POSITIONS['1B'].x + 0.1, z: FIELDER_HOME_POSITIONS['1B'].z };
    expect(nearestFielder(near, FIELDER_HOME_POSITIONS)).toBe('1B');
  });
});

describe('distance', () => {
  it('ユークリッド距離を返す', () => {
    expect(distance({ x: 0, z: 0 }, { x: 3, z: 4 })).toBe(5);
  });
});

describe('advancedBase（走者の次の塁）', () => {
  it('一塁の次は二塁、二塁の次は三塁、三塁の次は本塁', () => {
    expect(advancedBase('first')).toBe('second');
    expect(advancedBase('second')).toBe('third');
    expect(advancedBase('third')).toBe('home');
  });
});

describe('sendableRunnerBases（手動走塁で送れる走者の候補）', () => {
  it('フォースされていない占有塁を本塁に近い順（三塁→二塁→一塁）で返す', () => {
    const bases: Bases = { first: true, second: true, third: true };
    // 満塁はすべてフォースされているので候補なし
    expect(sendableRunnerBases(bases, forcedRunners(bases), [])).toEqual([]);
  });

  it('二塁のみ占有（フォースなし）なら二塁走者が候補になる', () => {
    const bases: Bases = { first: false, second: true, third: false };
    expect(sendableRunnerBases(bases, forcedRunners(bases), [])).toEqual(['second']);
  });

  it('一・三塁が埋まっている場合、一塁はフォース対象なので候補は三塁のみ', () => {
    const bases: Bases = { first: true, second: false, third: true };
    // batter->first, first->second がフォース。三塁走者はフォースされない。
    expect(sendableRunnerBases(bases, forcedRunners(bases), [])).toEqual(['third']);
  });

  it('既に送った走者は候補から除外される', () => {
    const bases: Bases = { first: false, second: true, third: true };
    expect(sendableRunnerBases(bases, forcedRunners(bases), ['third'])).toEqual(['second']);
  });
});

describe('recallTargetBase（帰塁の塁指定・説明書p19）', () => {
  it('十字キーで指定した塁へ帰れる走者を選ぶ（上=二塁/左=三塁/右=一塁）', () => {
    const candidates: Array<'first' | 'second' | 'third'> = ['first', 'second', 'third'];
    expect(recallTargetBase(candidates, baseFromPadDirection(0, 1))).toBe('second');
    expect(recallTargetBase(candidates, baseFromPadDirection(-1, 0))).toBe('third');
    expect(recallTargetBase(candidates, baseFromPadDirection(1, 0))).toBe('first');
  });

  it('無入力なら直近に仕掛けた走者（候補の末尾）を呼び戻す', () => {
    expect(recallTargetBase(['third', 'first'], null)).toBe('first');
    expect(recallTargetBase(['first', 'third'], null)).toBe('third');
  });

  it('指定した塁へ帰れる走者がいなければ何もしない（null）', () => {
    // 三塁走者だけを仕掛けている状態で「一塁へ帰れ」と指定しても該当者なし
    expect(recallTargetBase(['third'], 'first')).toBeNull();
    // 本塁（下入力）は帰る先になり得ない
    expect(recallTargetBase(['third'], baseFromPadDirection(0, -1))).toBeNull();
  });

  it('呼び戻せる走者がいなければ無入力でも null', () => {
    expect(recallTargetBase([], null)).toBeNull();
    expect(recallTargetBase([], 'second')).toBeNull();
  });
});

describe('predictLanding（着地予測）', () => {
  it('実際に stepBattedBall で飛ばした着地点と一致する（同一ロジックの影シミュレーション）', () => {
    const dtStep = 1 / 60;
    const ball = createBattedBall({ vx: 5, vy: 15, vz: -25 }, 0);
    const predicted = predictLanding(ball, dtStep);

    let actual = ball;
    for (let i = 0; i < 10000 && actual.landing === null; i++) {
      actual = stepBattedBall(actual, dtStep);
    }
    expect(actual.landing).not.toBeNull();
    expect(predicted.x).toBeCloseTo(actual.landing!.x);
    expect(predicted.z).toBeCloseTo(actual.landing!.z);
    expect(predicted.x).toBeGreaterThan(0); // +vx 方向へ流れる
    expect(predicted.z).toBeLessThan(0); // 外野方向へ飛ぶ
  });

  it('元のボール状態を変更しない（純粋関数）', () => {
    const ball = createBattedBall({ vx: 0, vy: 10, vz: -20 }, 0);
    const before = structuredClone(ball);
    predictLanding(ball);
    expect(ball).toEqual(before);
  });
});

describe('chooseCpuTagUp（CPU攻撃側のタッチアップ判断）', () => {
  const bases: Bases = { first: false, second: false, third: true };

  it('三塁走者がいなければ本塁は狙わない', () => {
    const deep = { x: 0, z: -95 };
    expect(chooseCpuTagUp({ first: true, second: false, third: false }, deep)).toEqual([]);
  });

  it('内野フライ（浅い捕球）では仕掛けない', () => {
    expect(chooseCpuTagUp(bases, { x: 0, z: -30 })).toEqual([]);
  });

  it('深い外野フライなら三塁走者が本塁を狙う', () => {
    expect(chooseCpuTagUp(bases, { x: 0, z: -95 })).toEqual(['third']);
  });

  it('捕球点は本塁からの距離で見る（左右に流れたフライも同じ深さ扱い）', () => {
    const diagonal = {
      x: -CPU_TAG_UP_MIN_DEPTH / Math.SQRT2,
      z: -CPU_TAG_UP_MIN_DEPTH / Math.SQRT2,
    };
    expect(chooseCpuTagUp(bases, diagonal)).toEqual(['third']);
  });

  it('乱数を使わない（同一入力→同一出力）', () => {
    const point = { x: 10, z: -90 };
    expect(chooseCpuTagUp(bases, point)).toEqual(chooseCpuTagUp(bases, point));
  });

  // ---- フェーズS-40：走力を見る時間の比較へ置き換え、二塁→三塁も対象にした ----

  it('基準速の走者では従来の境界（CPU_TAG_UP_MIN_DEPTH=78m）と一致する', () => {
    // S-40の前は「深さ78m以上なら仕掛ける」の固定値だった。平均的な走者の手触りを
    // 動かさないことが CPU_TAG_UP_MARGIN_SEC の決め方そのもの（balance:identity 4b段目）。
    expect(chooseCpuTagUp(bases, { x: 0, z: -CPU_TAG_UP_MIN_DEPTH })).toEqual(['third']);
    expect(chooseCpuTagUp(bases, { x: 0, z: -(CPU_TAG_UP_MIN_DEPTH - 0.5) })).toEqual([]);
  });

  it('俊足は浅いフライでも還り、鈍足は同じフライで自重する（球団の個性）', () => {
    const point = { x: 0, z: -70 };
    const fast = () => runnerSpeed(1);
    const slow = () => runnerSpeed(0);
    expect(chooseCpuTagUp(bases, point, fast)).toEqual(['third']);
    expect(chooseCpuTagUp(bases, point, slow)).toEqual([]);
    // 基準速はこの深さでは還れない（＝俊足だけが得をする）
    expect(chooseCpuTagUp(bases, point)).toEqual([]);
  });

  it('守備に残る余裕は走力で縮む（正なら完璧な送球で刺せる）', () => {
    const point = { x: 0, z: -78 };
    const fast = cpuTagUpDefenseSlack('third', point, runnerSpeed(1));
    const slow = cpuTagUpDefenseSlack('third', point, runnerSpeed(0));
    expect(fast).toBeLessThan(slow);
    // 基準速はちょうどしきい値の境界（従来の78m）
    expect(cpuTagUpDefenseSlack('third', point)).toBeCloseTo(-CPU_TAG_UP_MARGIN_SEC, 2);
  });

  it('二塁→三塁は右方向の打球でだけ成立する（三塁は本塁より左に寄っている）', () => {
    const second: Bases = { first: false, second: true, third: false };
    const depth = 95;
    const at = (deg: number) => ({
      x: Math.sin((deg * Math.PI) / 180) * depth,
      z: -Math.cos((deg * Math.PI) / 180) * depth,
    });
    expect(chooseCpuTagUp(second, at(45))).toEqual(['second']); // 右翼線
    expect(chooseCpuTagUp(second, at(-45))).toEqual([]); // 左翼線
  });

  it('三塁が埋まっていて三塁走者が走らないなら、二塁走者も走らない（追い越しにならない）', () => {
    // 右方向のやや浅いフライ＝本塁までは近い（三塁走者は刺される）が、三塁までは遠い
    // （二塁走者だけなら還れる）。三塁が埋まったままなので二塁走者も動けない。
    const shallowForThird = { x: 55, z: -50 };
    expect(chooseCpuTagUp({ first: false, second: true, third: false }, shallowForThird)).toEqual([
      'second',
    ]);
    expect(chooseCpuTagUp({ first: false, second: false, third: true }, shallowForThird)).toEqual(
      [],
    );
    const both: Bases = { first: false, second: true, third: true };
    expect(chooseCpuTagUp(both, shallowForThird)).toEqual([]);
  });

  it('両方が成立するなら本塁に近い順に並ぶ（chooseCpuSteals と同じ畳み方）', () => {
    const both: Bases = { first: false, second: true, third: true };
    const deepRight = { x: 90, z: -90 };
    expect(chooseCpuTagUp(both, deepRight)).toEqual(['third', 'second']);
  });
});

describe('タッチアップの時間バランス（犠牲フライが成立する深さ）', () => {
  // 三塁→本塁の走者時間。送球は「持ち替え(FLY_CATCH_RELEASE_SEC)＋距離÷THROW_SPEED」で
  // 本塁へ届く（chicchaiScene の releaseThrow は release 時点の残り距離で競争するため、
  // 捕球からの合計時間で比較するこの式と等価になる）。
  const runnerSec = BASE_PATH / RUNNER_SPEED;
  const throwSec = (depth: number) => FLY_CATCH_RELEASE_SEC + depth / THROW_SPEED;

  it('外野の定位置（約80m）で捕られたフライなら三塁走者は還れる', () => {
    expect(throwSec(80)).toBeGreaterThan(runnerSec);
  });

  it('浅い外野（60m）・内野（30m）のフライでは刺される', () => {
    expect(throwSec(60)).toBeLessThan(runnerSec);
    expect(throwSec(30)).toBeLessThan(runnerSec);
  });

  it('CPUが仕掛ける深さ（CPU_TAG_UP_MIN_DEPTH）は必ず走者が勝つ範囲にある', () => {
    expect(throwSec(CPU_TAG_UP_MIN_DEPTH)).toBeGreaterThan(runnerSec);
  });

  it('二塁→三塁のタッチアップは通常の外野フライでは刺される（三塁は本塁より捕球点に近いため）', () => {
    // 同じ深さのセンターフライでも、本塁より手前にある三塁への送球は距離が短く時間も短い
    // ＝三塁を狙うタッチアップは本塁狙いより不利。だからCPUは二塁走者を走らせない
    // （chooseCpuTagUp。人間はフェンス際の特大フライで賭けに出られる）。
    const catchPoint = { x: 0, z: -80 };
    const toThird = distance(catchPoint, BASE_POSITIONS.third);
    const toHome = distance(catchPoint, BASE_POSITIONS.home);
    expect(toThird).toBeLessThan(toHome);
    expect(FLY_CATCH_RELEASE_SEC + toThird / THROW_SPEED).toBeLessThan(runnerSec);
  });
});

describe('ファインプレイ（説明書p23：捕球のとき+を入れA）', () => {
  describe('finePlayKindFromPad（方向→動作）', () => {
    it('上=ジャンプ、左右・下=とび込み（横っとび/ダイビング）', () => {
      expect(finePlayKindFromPad(0, 1)).toBe('jump');
      expect(finePlayKindFromPad(-1, 0)).toBe('dive');
      expect(finePlayKindFromPad(1, 0)).toBe('dive');
      expect(finePlayKindFromPad(0, -1)).toBe('dive');
    });

    it('無入力は null＝発動しない（原作も「ボールに向けて+を入れA」）', () => {
      expect(finePlayKindFromPad(0, 0)).toBeNull();
    });

    it('斜め入力は塁指定と同じく上下を優先する', () => {
      expect(finePlayKindFromPad(1, 1)).toBe('jump');
      expect(finePlayKindFromPad(-1, -1)).toBe('dive');
    });
  });

  describe('finePlayReach（伸びるリーチ）', () => {
    it('ジャンプは高さだけ伸びる（横の捕球半径は通常のまま）', () => {
      const reach = finePlayReach('CF', 'jump');
      expect(reach.maxHeight).toBe(FINE_PLAY_JUMP_HEIGHT);
      expect(reach.maxHeight).toBeGreaterThan(CATCH_MAX_HEIGHT);
      expect(reach.radius).toBe(CATCH_RADIUS);
    });

    it('とび込みは距離だけ伸びる（届く高さは通常のまま＝低い球を捕る動作）', () => {
      const reach = finePlayReach('SS', 'dive');
      expect(reach.radius).toBe(FINE_PLAY_DIVE_RADIUS);
      expect(reach.radius).toBeGreaterThan(CATCH_RADIUS);
      expect(reach.maxHeight).toBe(CATCH_MAX_HEIGHT);
    });

    it('通常のリーチでは届かない球に、伸びたリーチなら届く', () => {
      const fielder = { x: 0, z: -30 };
      const lowBallJustOut = { x: 3, z: -30 }; // 3m先（通常2.6mでは届かない）
      expect(canCatch(fielder, lowBallJustOut, 1)).toBe(false);
      const dive = finePlayReach('SS', 'dive');
      expect(canCatch(fielder, lowBallJustOut, 1, dive.radius, dive.maxHeight)).toBe(true);

      const highBall = { x: 0.5, z: -30 };
      expect(canCatch(fielder, highBall, 3.5)).toBe(false);
      const jump = finePlayReach('SS', 'jump');
      expect(canCatch(fielder, highBall, 3.5, jump.radius, jump.maxHeight)).toBe(true);
    });
  });

  describe('nearestCatchableFielder（伸びたリーチは跳んだ1人だけに効く）', () => {
    const positions = { ...FIELDER_HOME_POSITIONS, SS: { x: 0, z: -30 }, '2B': { x: 6, z: -30 } };
    const ball = { x: 3, z: -30 }; // SSから3m、2Bから3m（どちらも通常リーチ外）

    it('リーチ指定なしなら誰も捕れない', () => {
      expect(nearestCatchableFielder(positions, ball, 1)).toBeNull();
    });

    it('跳んだ野手だけが捕れる（他の野手のリーチは伸びない）', () => {
      expect(nearestCatchableFielder(positions, ball, 1, finePlayReach('SS', 'dive'))).toBe('SS');
      expect(nearestCatchableFielder(positions, ball, 1, finePlayReach('2B', 'dive'))).toBe('2B');
    });

    it('ジャンプでは横の距離は縮まらない（高さだけの動作）', () => {
      expect(nearestCatchableFielder(positions, ball, 1, finePlayReach('SS', 'jump'))).toBeNull();
    });

    /**
     * 守備範囲のスキル（フェーズF-26-5のドウブツ系統）。**上乗せは野手ごと**で、
     * 渡さなければ全員0＝スキルを入れる前とまったく同じ判定になる。
     */
    it('捕球半径の上乗せはその野手だけに効く（跳ばなくても届くようになる）', () => {
      expect(nearestCatchableFielder(positions, ball, 1, undefined, () => 0)).toBeNull();
      const onlySS = (id: FielderId) => (id === 'SS' ? 1 : 0);
      expect(nearestCatchableFielder(positions, ball, 1, undefined, onlySS)).toBe('SS');
    });

    it('上乗せは跳んだときの伸びたリーチにも乗る（跳ぶとスキルが消えたりしない）', () => {
      const far = { x: -6.5, z: -30 }; // SSから6.5m＝ダイビング(3.4m)でも届かない（2Bからは12.5m）
      expect(nearestCatchableFielder(positions, far, 1, finePlayReach('SS', 'dive'))).toBeNull();
      expect(
        nearestCatchableFielder(positions, far, 1, finePlayReach('SS', 'dive'), () => 3.5),
      ).toBe('SS');
    });

    it('負の上乗せは無視する（守備範囲がスキルで狭くなることはない）', () => {
      const near = { x: 2, z: -30 }; // 通常リーチ（2.6m）の内側
      expect(nearestCatchableFielder(positions, near, 1, undefined, () => -2)).toBe('SS');
    });
  });

  describe('finePlayFielder（跳ぶ野手の選択）', () => {
    it('投手はファインプレイができない（説明書p23）', () => {
      expect(FINE_PLAY_ELIGIBLE).not.toContain('P');
      // 投手の真上の打球でも、跳ぶのは投手以外のもっとも近い野手になる
      const ballAtPitcher = { ...FIELDER_HOME_POSITIONS.P };
      expect(finePlayFielder(FIELDER_HOME_POSITIONS, ballAtPitcher, 100)).not.toBe('P');
    });

    it('ボールにもっとも近い野手が跳ぶ', () => {
      const positions = { ...FIELDER_HOME_POSITIONS, SS: { x: -2, z: -30 }, '2B': { x: 6, z: -30 } };
      expect(finePlayFielder(positions, { x: 0, z: -30 })).toBe('SS');
    });

    it('射程内に誰もいなければ null＝何も起きない（塁指定と同じ空振りの扱い）', () => {
      // 二遊間のど真ん中の深い位置（どの野手からも FINE_PLAY_TRIGGER_RANGE より遠い）
      const ball = { x: 0, z: -50 };
      for (const id of FINE_PLAY_ELIGIBLE) {
        expect(distance(FIELDER_HOME_POSITIONS[id], ball)).toBeGreaterThan(FINE_PLAY_TRIGGER_RANGE);
      }
      expect(finePlayFielder(FIELDER_HOME_POSITIONS, ball)).toBeNull();
    });

    it('射程は「跳べば届くかもしれない」範囲（とび込みの到達距離＋伸びた半径）を覆う', () => {
      expect(FINE_PLAY_TRIGGER_RANGE).toBeGreaterThanOrEqual(
        FINE_PLAY_DIVE_SPEED * FINE_PLAY_ACTIVE_SEC + FINE_PLAY_DIVE_RADIUS,
      );
    });
  });

  describe('chooseCpuFinePlay（CPU守備の判断・決定的）', () => {
    // SSだけがボールの近くにいる配置にする（跳ぶ野手の選択そのものは finePlayFielder のテスト）
    const positions = {
      ...FIELDER_HOME_POSITIONS,
      SS: { x: 0, z: -30 },
      '2B': { x: 22, z: -28 },
      '3B': { x: -22, z: -13 },
    };

    /** SSの4m手前から、指定の横ずれ・高さでSSの脇を通過していく打球を作る */
    const passingBall = (offsetX: number, height: number): BattedBall => ({
      x: offsetX,
      y: height,
      z: -26, // 0.4秒の先読み窓の中でSSの真横に来る
      vx: 0,
      vy: 0,
      vz: -15,
      landing: null,
      over: null,
      resting: false,
      bunt: false,
    });

    it('跳ばなくても届く球には跳ばない（無駄跳びをしない）', () => {
      expect(chooseCpuFinePlay(positions, passingBall(1, 0.2))).toBeNull();
    });

    it('立っていては届かないが、とび込めば届く低い球はダイビング（ボール方向へ跳ぶ）', () => {
      const choice = chooseCpuFinePlay(positions, passingBall(3, 0.2));
      expect(choice?.id).toBe('SS');
      expect(choice?.kind).toBe('dive');
      expect(choice?.dir.x).toBeGreaterThan(0.5); // +X側（ボールのある方）へ跳ぶ
    });

    it('頭上を越える高い球はジャンプ（跳ぶ方向は持たない）', () => {
      const choice = chooseCpuFinePlay(positions, passingBall(0.5, 3.2));
      expect(choice).toEqual({ id: 'SS', kind: 'jump', dir: { x: 0, z: 0 } });
    });

    it('跳んでも届かない球には跳ばない', () => {
      expect(chooseCpuFinePlay(positions, passingBall(8, 0.2))).toBeNull();
      expect(chooseCpuFinePlay(positions, passingBall(0.5, FINE_PLAY_JUMP_HEIGHT + 1))).toBeNull();
    });

    it('まだ遠い打球には跳ばない（跳ぶ判断はボールが来る直前だけ）', () => {
      const farBall: BattedBall = { ...passingBall(3, 0.2), z: -50 };
      expect(chooseCpuFinePlay(positions, farBall)).toBeNull();
    });

    /**
     * 守備範囲のスキル（F-26-5）は**跳ぶかどうかの判断にも同じだけ効かせる**。効かせないと、
     * 立ったまま届く球にもCPUが跳んでしまい、外せば起き上がりまで動けない
     * ＝守備範囲を広げるスキルが不利益として現れる（取ったのに弱くなる、が起きる）。
     */
    it('守備範囲が広ければ、立ったまま届く球には跳ばなくなる', () => {
      // 素の状態ならとび込む球
      expect(chooseCpuFinePlay(positions, passingBall(3, 0.2))?.kind).toBe('dive');
      // 半径が伸びていれば跳ばずに捕れる＝跳ばない
      expect(chooseCpuFinePlay(positions, passingBall(3, 0.2), undefined, () => 1)).toBeNull();
    });

    it('守備範囲が広ければ、跳んでも届かなかった球に跳ぶようになる', () => {
      expect(chooseCpuFinePlay(positions, passingBall(8, 0.2))).toBeNull();
      const choice = chooseCpuFinePlay(positions, passingBall(8, 0.2), undefined, () => 5);
      expect(choice?.id).toBe('SS');
      expect(choice?.kind).toBe('dive');
    });

    it('投手のすぐ横を抜ける球でも投手は跳ばない（説明書p23）', () => {
      // 投手の3m横を抜けるゴロ。他の野手は跳んでも届かない位置にいるので、誰も跳ばない
      const onlyPitcherNear = {
        ...FIELDER_HOME_POSITIONS,
        P: { x: 0, z: -30 },
        SS: { x: 9, z: -30 },
        '2B': { x: 22, z: -28 },
        '3B': { x: -22, z: -13 },
      };
      expect(chooseCpuFinePlay(onlyPitcherNear, passingBall(3, 0.2))).toBeNull();
    });

    it('乱数を使わない（同一入力→同一出力）', () => {
      const ball = passingBall(3, 0.2);
      expect(chooseCpuFinePlay(positions, ball)).toEqual(chooseCpuFinePlay(positions, ball));
    });
  });
});

describe('ランダンプレイ（説明書p25：ボールを捕ってから+で塁を指示しB）', () => {
  const runner = (name: string, x: number, z: number) => ({ origin: name, pos: { x, z } });

  describe('tagTarget（タッチ判定）', () => {
    it('範囲内の走者にタッチできる', () => {
      const carrier = { x: 0, z: -20 };
      expect(tagTarget(carrier, [runner('first', 1, -20)])?.origin).toBe('first');
    });

    it('範囲外の走者にはタッチできない（間をつめる操作が要る）', () => {
      const carrier = { x: 0, z: -20 };
      expect(tagTarget(carrier, [runner('first', TAG_RADIUS + 0.1, -20)])).toBeNull();
    });

    it('ちょうど範囲の縁なら触れている', () => {
      const carrier = { x: 0, z: -20 };
      expect(tagTarget(carrier, [runner('first', TAG_RADIUS, -20)])?.origin).toBe('first');
    });

    it('複数の走者が範囲内ならもっとも近い走者にタッチする', () => {
      const carrier = { x: 0, z: -20 };
      const target = tagTarget(carrier, [
        runner('second', 1.2, -20),
        runner('first', 0.4, -20),
      ]);
      expect(target?.origin).toBe('first');
    });

    it('候補がいなければ何も起きない', () => {
      expect(tagTarget({ x: 0, z: -20 }, [])).toBeNull();
    });

    it('タッチできる距離は捕球半径より狭い（すれ違いざまの自動タッチを避ける）', () => {
      expect(TAG_RADIUS).toBeLessThan(CATCH_RADIUS);
    });
  });

  describe('走る速さの関係（挟殺が読み合いになる前提）', () => {
    it('ボールを持った野手のほうが走者より速い＝追えばいつかは詰められる', () => {
      expect(FIELDER_SPEED).toBeGreaterThan(RUNNER_SPEED);
    });

    it('ただし1秒で詰められるのは1mだけ＝塁に近い走者は逃げ切れる', () => {
      // 塁間27.4mの中央（13.7m）で挟んでも、走者が塁へ着くまでに詰められるのは
      // (FIELDER_SPEED - RUNNER_SPEED) * (13.7 / RUNNER_SPEED) ≒ 1.8m しかない。
      // つまり「走って追うだけ」では届かず、送球と組み合わせる必要がある。
      const runnerTime = BASE_PATH / 2 / RUNNER_SPEED;
      const closed = (FIELDER_SPEED - RUNNER_SPEED) * runnerTime;
      expect(closed).toBeLessThan(BASE_PATH / 2);
    });
  });
});

describe('けん制球（説明書p24：Bでちっちゃいモードに切替→+で塁を指示→A）', () => {
  const MOUND = FIELDER_HOME_POSITIONS.P;

  describe('leadPosition（リード中の立ち位置）', () => {
    it('リード0なら塁の上', () => {
      expect(leadPosition('first', 0)).toEqual(BASE_POSITIONS.first);
    });

    it('次の塁の方向へ離れる（一塁走者は二塁方向）', () => {
      const p = leadPosition('first', 5);
      // 一塁(19.4,-19.4)から二塁(0,-38.8)へ向かうので、Xは減りZも減る
      expect(p.x).toBeLessThan(BASE_POSITIONS.first.x);
      expect(p.z).toBeLessThan(BASE_POSITIONS.first.z);
      expect(distance(p, BASE_POSITIONS.first)).toBeCloseTo(5, 6);
    });

    it('三塁走者は本塁方向へ離れる', () => {
      const p = leadPosition('third', 5);
      expect(distance(p, BASE_POSITIONS.home)).toBeCloseTo(BASE_PATH - 5, 6);
    });

    it('塁間を超えるリードはしない（次の塁を踏んでしまわない）', () => {
      const p = leadPosition('second', BASE_PATH + 10);
      expect(p).toEqual(BASE_POSITIONS.third);
    });

    it('リードは走る速さよりずっと遅い（じりじり離れる）', () => {
      expect(LEAD_SPEED).toBeLessThan(RUNNER_SPEED);
    });
  });

  /**
   * フェーズII-56：人間の走者は**押している間だけ**リードする（それまでは自動で伸び、
   * 何も押さずに2秒待つだけでけん制に刺された）。押す向きは「次の塁」＝盗塁と同じ入力の
   * 延長で、そのまま J を足せばその塁への盗塁になる。
   */
  describe('leadDirectionBase（リードを取るときに押す方向）', () => {
    it('一塁走者は二塁・二塁走者は三塁・三塁走者は本塁の方向', () => {
      expect(leadDirectionBase('first')).toBe('second');
      expect(leadDirectionBase('second')).toBe('third');
      expect(leadDirectionBase('third')).toBe('home');
    });

    it('リードで離れていく先（leadPosition）と同じ塁を指す', () => {
      for (const from of ['first', 'second', 'third'] as const) {
        const p = leadPosition(from, 5);
        const toward = BASE_POSITIONS[leadDirectionBase(from)];
        // 5m 離れた位置は、押す方向の塁へ 5m 近づいている
        expect(distance(p, toward)).toBeCloseTo(distance(BASE_POSITIONS[from], toward) - 5, 6);
      }
    });

    it('盗塁で指定する塁とまったく同じ（押したまま J で走り出せる）', () => {
      for (const from of ['first', 'second', 'third'] as const) {
        expect(leadDirectionBase(from)).toBe(advancedBase(from));
      }
    });
  });

  describe('pickoffOutLead（刺せるリードの深さ）', () => {
    it('送球が届く間に走者が戻れる距離そのもの', () => {
      const throwTime = distance(MOUND, BASE_POSITIONS.first) / THROW_SPEED;
      expect(pickoffOutLead('first', MOUND)).toBeCloseTo(throwTime * RUNNER_SPEED, 6);
    });

    it('人間の走者はリード上限まで離れれば刺されうる（けん制が機能する前提）', () => {
      for (const base of ['first', 'second', 'third'] as const) {
        expect(MAX_LEAD).toBeGreaterThan(pickoffOutLead(base, MOUND));
      }
    });
  });

  describe('cpuLeadDistance（CPU走者のリード）', () => {
    const RUNS = [0, 0.25, 0.5, 0.75, 1] as const;

    it('一塁・二塁の走者はけん制で刺される深さまでリードする', () => {
      expect(cpuLeadDistance('first')).toBeGreaterThan(pickoffOutLead('first', MOUND));
      expect(cpuLeadDistance('second')).toBeGreaterThan(pickoffOutLead('second', MOUND));
    });

    it('三塁走者は刺されない深さで止まる（アウトの損失が大きいので慎重）', () => {
      expect(cpuLeadDistance('third')).toBeLessThan(pickoffOutLead('third', MOUND));
    });

    it('リードは上限（人間の最大リード）を超えない', () => {
      expect(CPU_LEAD_AGGRESSIVE).toBeLessThanOrEqual(MAX_LEAD);
      expect(CPU_LEAD_CAUTIOUS).toBeLessThanOrEqual(MAX_LEAD);
    });

    // ---- フェーズS-40：深さだけが走力で決まる（固定2値をやめた） ----

    it('基準速（走力0.5）では従来の固定2値と一致する＝平均的な走者の手触りは不変', () => {
      expect(cpuLeadDistance('first', runnerSpeed(0.5))).toBeCloseTo(CPU_LEAD_AGGRESSIVE, 1);
      expect(cpuLeadDistance('third', runnerSpeed(0.5))).toBeCloseTo(CPU_LEAD_CAUTIOUS, 1);
    });

    it('走力が上がるほど深くリードする（単調）', () => {
      for (const base of ['first', 'second', 'third'] as const) {
        const leads = RUNS.map((r) => cpuLeadDistance(base, runnerSpeed(r)));
        for (let i = 1; i < leads.length; i += 1) {
          expect(leads[i]).toBeGreaterThan(leads[i - 1]);
        }
      }
    });

    it('けん制はどの走力の走者にも効く（一・二塁は必ず境界を踏み越す）', () => {
      // 踏み越し幅を距離ではなく**時間**で持つ理由そのもの。距離で一定にすると
      // 俊足ほど「時間で見た踏み越し」が浅くなり、いずれけん制が効かなくなる。
      for (const r of RUNS) {
        const speed = runnerSpeed(r);
        for (const base of ['first', 'second'] as const) {
          expect(cpuLeadDistance(base, speed)).toBeGreaterThan(pickoffOutLead(base, MOUND, speed));
        }
      }
    });

    it('三塁走者はどの走力でも刺されない深さで止まる', () => {
      for (const r of RUNS) {
        const speed = runnerSpeed(r);
        expect(cpuLeadDistance('third', speed)).toBeLessThan(pickoffOutLead('third', MOUND, speed));
      }
    });

    it('どの走力でも人間の上限（MAX_LEAD）を超えない', () => {
      for (const r of RUNS) {
        for (const base of ['first', 'second', 'third'] as const) {
          expect(cpuLeadDistance(base, runnerSpeed(r))).toBeLessThanOrEqual(MAX_LEAD);
        }
      }
    });

    it('けん制で刺されるまでの「不足の時間」はどの走者でも同じ（S-40の設計の要点）', () => {
      const shortfall = (speed: number) =>
        (cpuLeadDistance('first', speed) - pickoffOutLead('first', MOUND, speed)) / speed;
      const values = RUNS.map((r) => shortfall(runnerSpeed(r)));
      for (const v of values) expect(v).toBeCloseTo(values[0], 6);
    });
  });

  describe('chooseCpuPickoffThrow（CPU投手のけん制送球判断）', () => {
    it('リードが浅いうちは投げない（無駄弾を撃たない）', () => {
      expect(chooseCpuPickoffThrow(MOUND, { first: 1 })).toBeNull();
    });

    it('刺せる深さちょうどでもまだ投げない（走者に帰塁の余地を残すマージン）', () => {
      expect(chooseCpuPickoffThrow(MOUND, { first: pickoffOutLead('first', MOUND) })).toBeNull();
    });

    it('刺せる深さ＋マージンを超えたら投げる', () => {
      const lead = pickoffOutLead('first', MOUND) + CPU_PICKOFF_MARGIN + 0.1;
      expect(chooseCpuPickoffThrow(MOUND, { first: lead })).toBe('first');
    });

    it('複数の塁が刺せるなら本塁に近い塁を選ぶ（アウトの価値が高い）', () => {
      const deep = MAX_LEAD;
      expect(chooseCpuPickoffThrow(MOUND, { first: deep, second: deep, third: deep })).toBe('third');
      expect(chooseCpuPickoffThrow(MOUND, { first: deep, second: deep })).toBe('second');
    });

    it('走者のいない塁へは投げない', () => {
      expect(chooseCpuPickoffThrow(MOUND, {})).toBeNull();
    });

    it('乱数を使わない（同一入力→同一出力）', () => {
      const leads = { first: MAX_LEAD };
      expect(chooseCpuPickoffThrow(MOUND, leads)).toEqual(chooseCpuPickoffThrow(MOUND, leads));
    });
  });

  describe('pickoffBases（けん制できる塁）', () => {
    it('走者なしなら空＝けん制モードに入る意味がない', () => {
      expect(pickoffBases(EMPTY_BASES)).toEqual([]);
    });

    it('埋まっている塁を本塁に近い順に返す', () => {
      expect(pickoffBases({ first: true, second: false, third: true })).toEqual(['third', 'first']);
    });
  });
});

describe('盗塁（説明書p13：投球中も走塁操作が可能）', () => {
  // 投球が捕手のミットへ届くまでの時間（core/pitch.ts の座標・球速から算出）。
  // 盗塁の窓は「仕掛けた瞬間の投球の残り時間」で決まるので、この2つが比較の基準になる。
  const FLIGHT_NEUTRAL = (CATCH_Z - RELEASE_Z) / SPEED_NEUTRAL;
  const FLIGHT_SLOW = (CATCH_Z - RELEASE_Z) / SPEED_SLOW;
  /** ワインドアップの長さ（dekkaiScene.ts の WINDUP_SEC）。ここでは下限の目安としてのみ使う */
  const WINDUP_SEC = 0.35;

  describe('stealSafeJumpSec（間に合うスタートの境界）', () => {
    it('捕手の持ち替えと送球時間ぶんだけ、走者の所要時間から引いた値', () => {
      const throwTime = distance(BASE_POSITIONS.home, BASE_POSITIONS.second) / THROW_SPEED;
      const runnerTime = (BASE_PATH - STEAL_LEAD) / RUNNER_SPEED;
      expect(stealSafeJumpSec('first')).toBeCloseTo(
        runnerTime - throwTime - STEAL_CATCH_RELEASE_SEC,
        6,
      );
    });

    it('一塁走者はモーション中〜リリース直後に走れば間に合う', () => {
      // 境界が「飛行時間まるごと」より短い＝リリースの瞬間に走ってもまだ間に合う。
      // かつ0より大きい＝捕手が捕ってから走ったのでは間に合わない（遅れれば刺される）。
      expect(stealSafeJumpSec('first')).toBeGreaterThan(0);
      expect(stealSafeJumpSec('first')).toBeLessThan(FLIGHT_NEUTRAL);
    });

    it('二塁走者（三塁への盗塁）は一塁走者より窓が狭い＝モーション中でないと間に合わない', () => {
      // 本塁→三塁の送球は塁間そのもので短いぶん、より早いスタートが要る。
      expect(stealSafeJumpSec('second')).toBeGreaterThan(stealSafeJumpSec('first'));
      expect(stealSafeJumpSec('second')).toBeGreaterThan(FLIGHT_NEUTRAL);
      expect(stealSafeJumpSec('second')).toBeLessThan(WINDUP_SEC + FLIGHT_NEUTRAL);
    });

    it('本塁への盗塁はどんなスタートでも間に合わない（捕手が本塁に立っている）', () => {
      // もっとも遅い球（＝残り時間がもっとも長い）でモーションの頭から走っても届かない。
      expect(stealSafeJumpSec('third')).toBeGreaterThan(WINDUP_SEC + FLIGHT_SLOW);
    });

    it('リードが深いほど窓が広い（塁の上からでは基準速の球に間に合わない）', () => {
      expect(stealSafeJumpSec('first', BASE_POSITIONS.home, 0)).toBeGreaterThan(
        stealSafeJumpSec('first'),
      );
      expect(stealSafeJumpSec('first', BASE_POSITIONS.home, 0)).toBeGreaterThan(
        WINDUP_SEC + FLIGHT_NEUTRAL,
      );
    });

    it('盗塁のリードはけん制で取れるリードの範囲に収まる（別の体系にしない）', () => {
      expect(STEAL_LEAD).toBeLessThanOrEqual(MAX_LEAD);
    });
  });

  describe('chooseCpuSteals（CPU攻撃側の盗塁判断。L-32でダブルスチール／R-39で走力）', () => {
    /** 俊足（走力0.9）＝守備に残る余裕がしきい値を下回る＝仕掛ける値打ちのある走者 */
    const fast: CpuStealOptions = { speedOf: () => runnerSpeed(0.9) };

    it('一塁走者がいて二塁が空いていれば走る', () => {
      expect(chooseCpuSteals({ first: true, second: false, third: false }, fast)).toEqual([
        'first',
      ]);
      expect(chooseCpuSteals({ first: true, second: false, third: true }, fast)).toEqual(['first']);
    });

    // ダブルスチールは**けん制で深いリードを持ち越した後**に成立する（R-39）。標準リードの
    // 三盗はどんな走力でも守備の余裕が残る＝二塁走者が走らないので、後ろの一塁走者にも
    // 行き先が無い。L-32が「二塁からの三盗も現実的になるのは深いリードのとき」と
    // 記録していたのと同じ帰結で、**けん制の駆け引きの見返り**という形になっている。
    const fastDeep: CpuStealOptions = { ...fast, leadOf: () => MAX_LEAD };

    it('一・二塁は二人とも走る（ダブルスチール。前の走者が空けるので後ろも走れる）', () => {
      expect(chooseCpuSteals({ first: true, second: true, third: false }, fastDeep)).toEqual([
        'second',
        'first',
      ]);
    });

    it('標準リードの一・二塁では走らない（三盗が成立しない＝一塁走者の行き先も無い）', () => {
      expect(chooseCpuSteals({ first: true, second: true, third: false }, fast)).toEqual([]);
    });

    it('三塁が埋まっていれば二塁走者は走らない＝一塁走者の行き先も無い', () => {
      expect(chooseCpuSteals({ first: true, second: true, third: true }, fastDeep)).toEqual([]);
    });

    it('二塁走者だけでも走る（三塁が空いていて、深いリードを持ち越していれば）', () => {
      // 標準リードの二塁走者は三盗の窓が狭すぎて走らない（下の「三盗」の項）。
      expect(
        chooseCpuSteals(
          { first: false, second: true, third: false },
          { ...fast, leadOf: () => MAX_LEAD },
        ),
      ).toEqual(['second']);
    });

    it('三塁走者は走らせない（捕手が本塁に立っている＝どんな走力でも刺される）', () => {
      // L-32までは明示的な特例だったが、R-39では**規則から導出される**：本塁への送球は
      // 距離0なので、走力1.0・最大リードでも守備の余裕がしきい値を大きく上回る。
      expect(
        chooseCpuSteals(
          { first: false, second: false, third: true },
          { speedOf: () => RUNNER_SPEED_MAX, leadOf: () => MAX_LEAD },
        ),
      ).toEqual([]);
      expect(chooseCpuSteals(EMPTY_BASES, fast)).toEqual([]);
    });

    it('並びは本塁に近い順（sendableRunnerBases と同じ）', () => {
      expect(chooseCpuSteals({ first: true, second: true, third: false }, fastDeep)[0]).toBe(
        'second',
      );
    });

    it('乱数を使わない（同一入力→同一出力）', () => {
      const bases: Bases = { first: true, second: false, third: false };
      expect(chooseCpuSteals(bases, fast)).toEqual(chooseCpuSteals(bases, fast));
    });

    it('CPUのスタートは「完璧な送球なら刺せる」遅さ＝人間の捕手に対処の余地がある', () => {
      expect(CPU_STEAL_JUMP_SEC).toBeLessThan(stealSafeJumpSec('first'));
    });

    // ---- 走力（RUN）を見る（フェーズR-39。球団の個性） ----

    it('平均の走者は走らない（＝走力を渡さない既定でも走らない）', () => {
      const bases: Bases = { first: true, second: false, third: false };
      expect(chooseCpuSteals(bases)).toEqual([]);
      expect(chooseCpuSteals(bases, { speedOf: () => RUNNER_SPEED })).toEqual([]);
    });

    it('鈍足は走らず、俊足は走る（同じ塁状況で結論が分かれる）', () => {
      const bases: Bases = { first: true, second: false, third: false };
      expect(chooseCpuSteals(bases, { speedOf: () => RUNNER_SPEED_MIN })).toEqual([]);
      expect(chooseCpuSteals(bases, { speedOf: () => RUNNER_SPEED_MAX })).toEqual(['first']);
    });

    it('走力のしきい値は「守備に残る余裕」1本で決まる（塁・リードによらず同じ見方）', () => {
      const slack = (run: number) => cpuStealDefenseSlack('first', { speedOf: () => runnerSpeed(run) });
      // 足が速いほど守備の余裕は小さい（＝刺しにくい）
      expect(slack(1)).toBeLessThan(slack(0.5));
      expect(slack(0.5)).toBeLessThan(slack(0));
      // 平均の走者は人の反応時間（約0.2秒）ぶんの余裕を守備に残す＝しきい値の外
      expect(slack(0.5)).toBeGreaterThan(CPU_STEAL_MAX_DEFENSE_SLACK_SEC);
      // 完璧な送球でも間に合わない走者（余裕が負）は当然しきい値の内
      expect(slack(1)).toBeLessThan(0);
    });

    it('深いリードを持ち越していれば鈍足でも走る（L-32との噛み合い）', () => {
      const bases: Bases = { first: true, second: false, third: false };
      const slow = { speedOf: () => runnerSpeed(0.3) };
      expect(chooseCpuSteals(bases, slow)).toEqual([]);
      expect(chooseCpuSteals(bases, { ...slow, leadOf: () => MAX_LEAD })).toEqual(['first']);
    });

    it('標準リードでは三盗しない（窓が狭い）が、深いリードの俊足なら仕掛ける', () => {
      const bases: Bases = { first: false, second: true, third: false };
      expect(chooseCpuSteals(bases, { speedOf: () => RUNNER_SPEED_MAX })).toEqual([]);
      expect(
        chooseCpuSteals(bases, { speedOf: () => RUNNER_SPEED_MAX, leadOf: () => MAX_LEAD }),
      ).toEqual(['second']);
    });

    it('名鑑16球団で規則が死んでいない（走る走者がいる球団とほぼ走らない球団が両方ある）', () => {
      const counts = TEAMS.map(
        (team) =>
          [...team.lineup.map((r) => fielderRowStats(r).run), ...team.bench.map((r) => r[4])].filter(
            (run) =>
              chooseCpuSteals(
                { first: true, second: false, third: false },
                { speedOf: () => runnerSpeed(run) },
              ).length > 0,
          ).length,
      );
      // 全球団に「走れる走者」が最低1人はいる（＝規則が発火しない球団を作らない）
      expect(Math.min(...counts)).toBeGreaterThanOrEqual(1);
      // かつ全員が走るわけではない（＝球団の個性が数字に出る）
      expect(Math.max(...counts)).toBeLessThan(12);
      expect(Math.max(...counts)).toBeGreaterThan(Math.min(...counts) * 2);
    });
  });

  describe('chooseSendRunners（進塁・盗塁で走らせる走者の選択。フェーズL-32）', () => {
    const all = sendableRunnerBases({ first: true, second: true, third: true }, [], []);

    it('無指定なら走れる走者が全員（同時スタート）', () => {
      expect(chooseSendRunners(all, null)).toEqual(['third', 'second', 'first']);
    });

    it('塁を指定すればその塁へ進む走者1人だけ（L-32の前と同じ）', () => {
      expect(chooseSendRunners(all, 'second')).toEqual(['first']);
      expect(chooseSendRunners(all, 'third')).toEqual(['second']);
      expect(chooseSendRunners(all, 'home')).toEqual(['third']);
    });

    it('指定した塁へ進める走者がいなければ何もしない', () => {
      expect(chooseSendRunners(['first'], 'home')).toEqual([]);
      expect(chooseSendRunners([], 'second')).toEqual([]);
      expect(chooseSendRunners([], null)).toEqual([]);
    });

    it('候補を書き換えない（呼び出し側の配列を共有しない）', () => {
      const chosen = chooseSendRunners(all, null);
      chosen.pop();
      expect(all).toHaveLength(3);
    });
  });

  describe('stealableBases（一斉スタートの対象。フェーズL-32）', () => {
    const all = sendableRunnerBases({ first: true, second: true, third: true }, [], []);

    it('本塁へ向かう走者（三塁走者）だけを外す＝無指定のJが罠にならない', () => {
      expect(stealableBases(all)).toEqual(['second', 'first']);
    });

    it('外した走者も塁を指定すれば走れる（ギャンブルは裁量に残す）', () => {
      expect(chooseSendRunners(all, 'home')).toEqual(['third']);
    });

    it('本塁への盗塁は投球の残り時間の上限を超える＝外す根拠', () => {
      // ワインドアップ(0.35s)＋いちばん遅い球の飛行時間より、必要な持ち時間のほうが長い
      expect(stealSafeJumpSec('third')).toBeGreaterThan(1.3);
      expect(stealSafeJumpSec('third')).toBeGreaterThan(stealSafeJumpSec('first'));
    });
  });

  describe('resolveCarriedLeads（リードの持ち越し。フェーズL-32）', () => {
    const runners: BaseRunners = { first: 'r1', second: 'r2', third: null };

    it('同じ走者が同じ塁にいれば持ち越す', () => {
      expect(resolveCarriedLeads(runners, { first: { id: 'r1', lead: 5.2 } })).toEqual({
        first: 5.2,
      });
    });

    it('リード0も持ち越す（帰塁した走者の代償そのもの）', () => {
      expect(resolveCarriedLeads(runners, { first: { id: 'r1', lead: 0 } })).toEqual({ first: 0 });
    });

    it('走者が入れ替わった塁は無効（既定のリードに戻る）', () => {
      expect(resolveCarriedLeads(runners, { first: { id: 'other', lead: 5.2 } })).toEqual({});
    });

    it('走者がいなくなった塁は無効', () => {
      expect(resolveCarriedLeads(runners, { third: { id: 'r3', lead: 5.2 } })).toEqual({});
    });

    it('複数の塁をまとめて解ける（ダブルスチールの前提）', () => {
      expect(
        resolveCarriedLeads(runners, {
          first: { id: 'r1', lead: 1.5 },
          second: { id: 'r2', lead: 6 },
        }),
      ).toEqual({ first: 1.5, second: 6 });
    });

    it('持ち越しが無ければ空＝呼び出し側は既定のリードを使う', () => {
      expect(resolveCarriedLeads(runners, {})).toEqual({});
    });
  });

  describe('リードの持ち越しが盗塁の窓を動かす（フェーズL-32。npm run balance:steal）', () => {
    it('深くリードするほど窓が縮む（＝走りやすい）', () => {
      const deep = stealSafeJumpSec('first', BASE_POSITIONS.home, MAX_LEAD);
      const standard = stealSafeJumpSec('first', BASE_POSITIONS.home, STEAL_LEAD);
      const none = stealSafeJumpSec('first', BASE_POSITIONS.home, 0);
      expect(deep).toBeLessThan(standard);
      expect(standard).toBeLessThan(none);
    });

    it('帰塁した走者（リード0）は標準球には走れない＝「押し得」の代償', () => {
      // 投球の残り時間の上限＝ワインドアップ 0.35s ＋ 標準球(36m/s)の飛行 19.84/36 ≒ 0.55s
      const maxJumpNeutral = 0.35 + 19.84 / 36;
      expect(stealSafeJumpSec('first', BASE_POSITIONS.home, 0)).toBeGreaterThan(maxJumpNeutral);
      // 既定のリードなら十分間に合う（A-7で調整した窓＝ここは動かしていない）
      expect(stealSafeJumpSec('first', BASE_POSITIONS.home, STEAL_LEAD)).toBeLessThan(
        maxJumpNeutral,
      );
    });

    it('深いリードなら三盗の窓が「一塁からの盗塁の既定」と同じ帯まで縮む', () => {
      // 二塁→三塁は既定のリードだと窓 0.78秒＝ワインドアップの頭でしか走れない。
      // 上限までリードすると 0.45秒になり、一塁からの通常の盗塁と同じ難度になる
      // ＝**深いリードは「三盗を可能にする」という質の変化を生む**（npm run balance:steal）。
      const deep = stealSafeJumpSec('second', BASE_POSITIONS.home, MAX_LEAD);
      expect(deep).toBeLessThan(stealSafeJumpSec('second', BASE_POSITIONS.home, STEAL_LEAD));
      expect(Math.abs(deep - stealSafeJumpSec('first', BASE_POSITIONS.home, STEAL_LEAD))).toBeLessThan(
        0.05,
      );
    });

    it('既定のリードを渡したときは A-7 の窓のまま（持ち込みで手触りが動いていない）', () => {
      expect(stealSafeJumpSec('first', BASE_POSITIONS.home, STEAL_LEAD)).toBeCloseTo(
        stealSafeJumpSec('first'),
        10,
      );
    });
  });

  /**
   * フェーズKK-58：**攻撃側から「リードを取りに行く」入口**。
   *
   * II-56（人間の走者はけん制モード中に押している間だけリードする）と JJ-57（CPUは
   * リード>0の走者がいるときだけけん制する）が輪になり、**塁についたままの走者は
   * 永久に塁を離れられなくなっていた**。ここが守備側の `shouldCpuPickoff` と対になる
   * 攻撃側の入口で、輪を切っているのはこの関数ひとつ。
   */
  describe('canTakeLeadOff（攻撃側からにらみ合いへ入る。フェーズKK-58）', () => {
    const first = { first: true, second: false, third: false };

    it('走者がいて、まだ使っておらず、投手が投球動作に入っていなければ入れる', () => {
      expect(canTakeLeadOff(first, false, false)).toBe(true);
    });

    it('走者がいなければ入らない（にらみ合う相手がいない）', () => {
      expect(canTakeLeadOff(EMPTY_BASES, false, false)).toBe(false);
    });

    it('どの塁の走者でも入れる（三塁走者だけでもリードは取れる）', () => {
      expect(canTakeLeadOff({ first: false, second: true, third: false }, false, false)).toBe(true);
      expect(canTakeLeadOff({ first: false, second: false, third: true }, false, false)).toBe(true);
    });

    /**
     * 1打席1回（CPU投手のけん制と対称）。**入っただけで消費する**ので、この関数は
     * 「リードを取れたか」を引数に取らない＝バイクの点火・ドロップキック・引き返しと
     * 同じ「空振りでも1回」。
     */
    it('その打席で一度使っていれば入れない', () => {
      expect(canTakeLeadOff(first, true, false)).toBe(false);
    });

    /**
     * 投球動作中のJは従来どおり盗塁（A-7）＝**同じキーが同時に2つの意味を持たない**。
     * 門番を `canStartPickoff`（守備側の入口）と揃えてあるので、捕球後の settle にも
     * 割り込まない。
     */
    it('投手が投球動作に入っていれば入れない（そのJは盗塁のもの）', () => {
      expect(canTakeLeadOff(first, false, true)).toBe(false);
    });

    /**
     * KK-58 が切った輪そのもの：**入口を通ってリードを取れば、JJ-57 のけん制が
     * 発火するようになる**（リード0のままでは撃たれない＝JJ-57 のユーザー要望は不変）。
     * 攻撃側の入口と守備側の入口が噛み合っていることを、両方の純粋関数で固定する。
     */
    it('入ってリードを取れば、CPUのけん制（JJ-57）が発火する側へ回る', () => {
      // 入る前：塁についたままなので、CPUは見に来ない（＝リードを取る機会が無い）
      expect(shouldCpuPickoff(first, false, {})).toBe(false);
      // その状況でも攻撃側からは入れる（ここが KK-58 で開いた唯一の入口）
      expect(canTakeLeadOff(first, false, false)).toBe(true);
      // 取ったリードが持ち越されれば、次の球からは JJ-57 の条件を満たす
      expect(shouldCpuPickoff(first, false, { first: 4.0 })).toBe(true);
    });
  });
});

describe('runnerSpeed（走力→走者速度：フェーズB-8）', () => {
  it('走力の中央は従来の基準速度と一致する（平均的な走者は今までどおり）', () => {
    expect(runnerSpeed(0.5)).toBeCloseTo(RUNNER_SPEED, 10);
  });

  it('走力が高いほど速い', () => {
    expect(runnerSpeed(1)).toBeGreaterThan(runnerSpeed(0.5));
    expect(runnerSpeed(0.5)).toBeGreaterThan(runnerSpeed(0));
  });

  it('0..1 の外を渡されても上下限で頭打ちになる', () => {
    expect(runnerSpeed(5)).toBe(RUNNER_SPEED_MAX);
    expect(runnerSpeed(-5)).toBe(RUNNER_SPEED_MIN);
  });

  /**
   * どんな俊足でも野手より遅いことが、守備側の操作（追いつく・詰める）が
   * 無意味にならない条件そのもの。挟殺プレイの読み合いはこの大小関係で成立している。
   */
  it('最速の走者でも野手の足より遅い（守備が追いつける前提を壊さない）', () => {
    expect(RUNNER_SPEED_MAX).toBeLessThan(FIELDER_SPEED);
  });

  it('走力の差は塁間の所要時間の差として出る（俊足は鈍足より0.5秒以上速い）', () => {
    const timeToNextBase = (run: number) => BASE_PATH / runnerSpeed(run);
    expect(timeToNextBase(0) - timeToNextBase(1)).toBeGreaterThan(0.5);
  });
});

// ---- バイク（フェーズF-26-3。★3メカのスキル `バイク`） ----

describe('バイク（フェーズF-26-3：直線2倍速・曲がれない）', () => {
  const MOUND = FIELDER_HOME_POSITIONS.P;

  describe('速さと、その代償が釣り合っているか', () => {
    /**
     * このスキルだけが CLAUDE.md ⑥の不変条件（走者の上限は野手より遅い）を踏み越える。
     * 踏み越えていることをテストで明示しておく＝代償（オーバーラン）が消えたら
     * 挟殺が壊れる、という関係をコードのほうに残しておくため。
     */
    it('バイクの走者は野手の足より速い（＝代償なしでは挟殺が成立しなくなる）', () => {
      expect(RUNNER_SPEED_MIN * BIKE_SPEED_SCALE).toBeGreaterThan(FIELDER_SPEED);
    });

    it('塁間の所要時間が半分になる（間に合わせるための道具として効く）', () => {
      const onFoot = BASE_PATH / RUNNER_SPEED;
      const onBike = BASE_PATH / (RUNNER_SPEED * BIKE_SPEED_SCALE);
      expect(onBike).toBeCloseTo(onFoot / 2, 6);
    });

    /**
     * 行き過ぎる深さは、けん制で刺される境界（すでに実機で調整済み）より深い。
     * ＝「塁を離れて止まっている」ことが確実にアウトになりうる深さだと分かる。
     */
    it('行き過ぎる深さは、けん制で刺される深さより深い', () => {
      for (const base of ['first', 'second', 'third'] as const) {
        expect(BIKE_OVERRUN_DISTANCE).toBeGreaterThan(pickoffOutLead(base, MOUND));
      }
    });

    it('行き過ぎても次の塁には着かない（塁間より十分短い）', () => {
      expect(BIKE_OVERRUN_DISTANCE).toBeLessThan(BASE_PATH / 2);
    });

    /**
     * 戻りは徒歩（シーン層が降ろす）。行きが速いほど、戻りの遅さが相対的に効く。
     */
    it('行きと帰りの時間差＝オーバーランの危うさになる', () => {
      const out = BIKE_OVERRUN_DISTANCE / (RUNNER_SPEED * BIKE_SPEED_SCALE);
      const back = BIKE_OVERRUN_DISTANCE / RUNNER_SPEED;
      expect(back).toBeGreaterThan(out);
    });
  });

  describe('bikeOverrunsAt（どの塁で行き過ぎるか）', () => {
    it('本塁だけは行き過ぎない（駆け抜けた時点で得点＝走者でなくなる）', () => {
      expect(bikeOverrunsAt('home')).toBe(false);
    });

    it('一塁も対象（ユーザー判断：本塁以外すべて）＝打者走者が乗るのも賭けになる', () => {
      expect(bikeOverrunsAt('first')).toBe(true);
      expect(bikeOverrunsAt('second')).toBe(true);
      expect(bikeOverrunsAt('third')).toBe(true);
    });
  });

  describe('bikeOverrunTarget（行き過ぎて止まる位置）', () => {
    it('走ってきた向きの延長に、決まった距離だけ行き過ぎる', () => {
      const p = bikeOverrunTarget(BASE_POSITIONS.first, 'second');
      expect(distance(p, BASE_POSITIONS.second)).toBeCloseTo(BIKE_OVERRUN_DISTANCE, 6);
      // 一塁→二塁の延長なので、二塁よりさらに三塁側（X負）・奥（Z負）へ抜ける
      expect(p.x).toBeLessThan(BASE_POSITIONS.second.x);
      expect(p.z).toBeLessThan(BASE_POSITIONS.second.z);
    });

    it('打者走者は本塁から一塁への延長へ抜ける（原点は originOf が返す本塁）', () => {
      const p = bikeOverrunTarget(originOf('batter'), 'first');
      expect(distance(p, BASE_POSITIONS.first)).toBeCloseTo(BIKE_OVERRUN_DISTANCE, 6);
      expect(p.x).toBeGreaterThan(BASE_POSITIONS.first.x);
      expect(p.z).toBeLessThan(BASE_POSITIONS.first.z);
    });

    it('止まる位置は次の塁より手前（行き過ぎで勝手に進塁しない）', () => {
      const p = bikeOverrunTarget(BASE_POSITIONS.first, 'second');
      expect(distance(p, BASE_POSITIONS.third)).toBeGreaterThan(BASE_ARRIVE_RADIUS);
    });
  });

  describe('点火とCPUの反応（時間の設計）', () => {
    it('点火は短く押しただけでは起きない（乗らない選択ができる）', () => {
      expect(BIKE_ENGAGE_SEC).toBeGreaterThan(0);
      // 塁間を走り切る時間よりずっと短い＝走り出してからでも間に合う
      expect(BIKE_ENGAGE_SEC).toBeLessThan(BASE_PATH / RUNNER_SPEED / 2);
    });

    it('CPUが行き過ぎてから戻り切るまでが、人間の守備が狙える窓になる', () => {
      const exposure =
        BIKE_OVERRUN_DISTANCE / (RUNNER_SPEED * BIKE_SPEED_SCALE) +
        BIKE_CPU_RETURN_SEC +
        BIKE_OVERRUN_DISTANCE / RUNNER_SPEED;
      // 内野からの送球（もっとも遠い三塁→本塁でも1秒未満）が間に合う長さ
      expect(exposure).toBeGreaterThan(BASE_PATH / THROW_SPEED);
    });
  });
});

// ---- ドロップキック（フェーズF-26-4。★2ボウリョクのスキル `ドロップキック`） ----

describe('ドロップキック（フェーズF-26-4：野手を蹴り倒す／外すと転ぶ）', () => {
  /** 全員をはるか遠く（外野の外）へ置いた盤面。テストごとに要る野手だけを近くへ動かす */
  function farField(): Record<FielderId, Vec2> {
    const positions = {} as Record<FielderId, Vec2>;
    for (const id of Object.keys(FIELDER_HOME_POSITIONS) as FielderId[]) {
      positions[id] = { x: 300, z: -300 };
    }
    return positions;
  }

  describe('効果と代償が釣り合っているか（射程・秒数の根拠）', () => {
    /**
     * このスキルの意味そのもの＝**タッチされる前に蹴れる**。射程がタッチ半径以下だと、
     * 蹴ろうとした時点ですでにタッチアウトが成立していて、押す機会が存在しない。
     */
    it('射程はタッチ半径より広い（追いつかれる前に蹴れる）', () => {
      expect(DROPKICK_RANGE).toBeGreaterThan(TAG_RADIUS);
    });

    /**
     * 逆に広すぎると「ボールを持って走者へ寄る」以外の守備まで巻き込まれ、守備側に
     * 逃げ道が無くなる。ファインプレイを仕掛けられる距離（10m）よりはっきり狭いことで、
     * **離れたまま塁へ投げる**という対処が常に残る（＝挟殺の読み合いが壊れない条件）。
     */
    it('射程はファインプレイの発動距離よりはっきり狭い（離れて投げる立ち回りが残る）', () => {
      expect(DROPKICK_RANGE).toBeLessThan(FINE_PLAY_TRIGGER_RANGE / 2);
    });

    /**
     * 守備側への警告（`ケラレル!`）は射程より外で出る。桜井ノウハウ「人に反応できない
     * 動作をするとすっごい理不尽感がある」＝警告と被弾が同時では通知にしかならない。
     * 野手と走者が正面から詰め合う最悪の場合でも、0.3秒（人の単純反応時間の帯）は残る。
     */
    it('警告は射程の外側で出て、対処する時間が残る', () => {
      expect(DROPKICK_WARN_RANGE).toBeGreaterThan(DROPKICK_RANGE);
      // 正面から詰め合う最悪の場合でも、人の単純反応時間（約0.2秒）を上回る猶予がある
      const closingSpeed = FIELDER_SPEED + RUNNER_SPEED_MAX;
      expect((DROPKICK_WARN_RANGE - DROPKICK_RANGE) / closingSpeed).toBeGreaterThan(0.3);
    });

    /**
     * 一方で警告が広すぎると、蹴られる気配が無いのに出っぱなしになって意味を失う。
     * ファインプレイの発動距離（10m）＝「そのプレーに関わっている」と言える距離の帯に収める。
     */
    it('警告が出っぱなしにならない広さに収まっている', () => {
      expect(DROPKICK_WARN_RANGE).toBeLessThanOrEqual(FINE_PLAY_TRIGGER_RANGE);
    });

    /**
     * 射程がスキルで伸びても（デュオ `ロケットキック`。F-26-5）、**警告は射程からの
     * 導出なので同じだけ早く出る**＝「対処する時間が残る」という上の不変条件が、
     * 射程の値によらず成り立つ。定数として持たず関数にしてあるのはこのため。
     */
    it('射程が伸びても、対処する時間は同じだけ残る', () => {
      const closingSpeed = FIELDER_SPEED + RUNNER_SPEED_MAX;
      for (const range of [DROPKICK_RANGE, DROPKICK_RANGE + 2.5, DROPKICK_RANGE * 2]) {
        const warn = dropkickWarnRange(range);
        expect(warn).toBeGreaterThan(range);
        expect((warn - range) / closingSpeed).toBeGreaterThan(0.3);
      }
    });

    it('引数なしの dropkickWarnRange は素の定数と一致する', () => {
      expect(dropkickWarnRange()).toBe(DROPKICK_WARN_RANGE);
    });

    /**
     * 蹴られたほうが、自分で跳んで外した（ダイビング）より重い。同じ「起き上がるまで
     * 動けない」でも、選んで跳んだ結果と一方的に蹴られた結果を同じ重さにはしない。
     */
    it('行動不能はファインプレイを外した起き上がりより長い', () => {
      expect(DROPKICK_DOWN_SEC).toBeGreaterThan(FINE_PLAY_DIVE_RECOVERY_SEC);
    });

    /**
     * 一方で、1回蹴れば必ず次の塁に着けるほどではない（塁間 27.4m を走り切れない）。
     * ここが逆転すると「蹴った＝進塁確定」になり、蹴るタイミングの判断が消える。
     */
    it('行動不能の間に走者は塁間を走り切れない（蹴れば必ず進塁、にはならない）', () => {
      expect(RUNNER_SPEED_MAX * DROPKICK_DOWN_SEC).toBeLessThan(BASE_PATH);
    });

    /**
     * 空振りの代償は「止まって失う距離」で、バイクのオーバーラン（6m）と同じ帯に置く
     * ＝走塁スキルの失敗はどれも同じくらい痛い、という手触りを揃える。
     */
    it('空振りで失う距離がバイクのオーバーランと同じ帯にある', () => {
      const lost = RUNNER_SPEED * DROPKICK_STUMBLE_SEC;
      expect(lost).toBeGreaterThan(BIKE_OVERRUN_DISTANCE * 0.8);
      expect(lost).toBeLessThan(BIKE_OVERRUN_DISTANCE * 1.5);
    });

    /**
     * **落球でプレーが宙に浮かないことの担保**：こぼれ球は蹴られた野手の捕球半径の
     * 内側に落ちるので、遅くともその野手が起き上がった瞬間に拾い直される。
     * ここが逆転すると、誰も拾いに行かない限りボールが地面に残り続ける。
     */
    it('こぼれ球は蹴られた野手の捕球半径の内側に落ちる（起き上がれば必ず拾える）', () => {
      expect(DROPKICK_LOOSE_BALL_DISTANCE).toBeLessThan(CATCH_RADIUS);
    });
  });

  describe('dropkickTarget: 蹴る相手を選ぶ', () => {
    it('射程内にいる野手を返す', () => {
      const positions = farField();
      positions['1B'] = { x: 10, z: -10 };
      const runner = { x: 10 + DROPKICK_RANGE - 0.1, z: -10 };
      expect(dropkickTarget(runner, positions)).toBe('1B');
    });

    it('射程外なら null（＝空振り。塁指定の「該当者なしなら何もしない」と同じ扱い）', () => {
      const positions = farField();
      positions['1B'] = { x: 10, z: -10 };
      const runner = { x: 10 + DROPKICK_RANGE + 0.1, z: -10 };
      expect(dropkickTarget(runner, positions)).toBeNull();
    });

    it('射程内に複数いれば、もっとも近い野手を蹴る', () => {
      const positions = farField();
      positions['1B'] = { x: 3, z: 0 };
      positions['2B'] = { x: 1, z: 0 };
      expect(dropkickTarget({ x: 0, z: 0 }, positions)).toBe('2B');
    });

    /**
     * ファインプレイは投手だけができない（説明書p23の規則）が、**蹴られる側に原作の
     * 規則は無い**。一塁カバーに入った投手を蹴れないほうが不自然なので除外しない。
     */
    it('投手も蹴られる（ファインプレイの FINE_PLAY_ELIGIBLE とは対象が違う）', () => {
      const positions = farField();
      positions.P = { x: 1, z: 0 };
      expect(FINE_PLAY_ELIGIBLE).not.toContain('P');
      expect(dropkickTarget({ x: 0, z: 0 }, positions)).toBe('P');
    });

    /**
     * シーン層は「どの走者が蹴るか」を決めるのに射程を外して最寄りを問い合わせる
     * （射程判定はそのあと距離で行う）ので、射程を引数で変えられることを固定する。
     */
    it('射程は引数で変えられる（無限大にすれば単なる最寄り探索になる）', () => {
      const positions = farField();
      positions['1B'] = { x: 50, z: 0 };
      expect(dropkickTarget({ x: 0, z: 0 }, positions)).toBeNull();
      expect(dropkickTarget({ x: 0, z: 0 }, positions, Number.POSITIVE_INFINITY)).toBe('1B');
    });

    it('同じ距離に2人いても結果が決定的（先に並んでいるほうを蹴る）', () => {
      const positions = farField();
      positions['1B'] = { x: 2, z: 0 };
      positions['2B'] = { x: -2, z: 0 };
      const first = dropkickTarget({ x: 0, z: 0 }, positions);
      expect(first).toBe(dropkickTarget({ x: 0, z: 0 }, positions));
      expect(first).toBe('1B');
    });
  });

  describe('dropkickLooseBallPos: 叩き落としたボールの落ち着き先', () => {
    it('走者→野手の向きの延長へ、規定の距離だけ転がる', () => {
      const loose = dropkickLooseBallPos({ x: 0, z: 0 }, { x: 5, z: 0 });
      expect(loose.x).toBeCloseTo(5 + DROPKICK_LOOSE_BALL_DISTANCE, 6);
      expect(loose.z).toBeCloseTo(0, 6);
    });

    it('野手からの距離は走者がどこにいても一定（＝拾い直しの時間が場所で変わらない）', () => {
      const fielder = { x: -12, z: -30 };
      for (const runner of [{ x: -20, z: -25 }, { x: -5, z: -40 }, { x: -12, z: -20 }]) {
        const loose = dropkickLooseBallPos(runner, fielder);
        expect(Math.hypot(loose.x - fielder.x, loose.z - fielder.z)).toBeCloseTo(
          DROPKICK_LOOSE_BALL_DISTANCE,
          6,
        );
      }
    });

    it('走者と野手が重なっていても壊れない（向きが決まらないのでその場に落とす）', () => {
      const loose = dropkickLooseBallPos({ x: 3, z: -4 }, { x: 3, z: -4 });
      expect(loose).toEqual({ x: 3, z: -4 });
    });
  });
});
