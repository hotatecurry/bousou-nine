/**
 * CPUの采配・守備・走塁の判断規則（フェーズJ-30）。
 *
 * ここまでCPUは「疲れても交代しない」「捕ったら1回投げて終わり」「追われても引き返さない」
 * 「けん制で走り出さない」「乱闘は3秒周期の固定スクリプト」で、**1P PLAY だけに非対称が
 * 残っていた**（2P PLAY にはCPUがいないので影響しない）。
 *
 * 固定するのは**規則の形**：どれも決定的（乱数不使用）で、**同じ状況からは必ず同じ手**が
 * 出ること、そして**人間が同じ操作でできる範囲を超えないこと**（桜井ノウハウ「人ができる
 * 範囲のこともずるいと思われるのはCPの常」）。
 */
import { describe, expect, it } from 'vitest';
import {
  CPU_RELIEF_QUALITY_MARGIN,
  CPU_RELIEF_REMAINING_THRESHOLD,
  chooseCpuRelief,
  type CpuReliefCandidate,
} from '../src/core/cpuPitcher';
import { STAMINA_FRESH_THRESHOLD } from '../src/core/roster';
import {
  BASE_POSITIONS,
  FIELDER_HOME_POSITIONS,
  FIELDER_SPEED,
  FLY_CATCH_RELEASE_SEC,
  RUNNER_SPEED,
  TAG_RADIUS,
  THROW_SPEED,
  advancedBase,
  canTagByRunning,
  chooseCpuRundown,
  chooseCpuThrowTarget,
  closestApproachDistance,
  distance,
  leadPosition,
  shouldCpuBreakForNextBase,
  shouldCpuRetreat,
  type Vec2,
} from '../src/core/fielding';
import {
  CPU_BRAWL_REACTION_SEC,
  DEFAULT_LOADOUT,
  MOVES,
  chooseCpuBrawlAction,
  createFighterState,
  strongestStrike,
  type FighterState,
} from '../src/core/brawl';

// ---- 1. CPU投手の自動継投（B-11で保留していた非対称／Z-47で「代えるか続投か」に） ----

/**
 * 控え。**質は既定で 3（最高）**にしてある＝Z-47の比較を素通りするので、
 * J-30 で固定した「誰を選ぶか」の帰結をそのまま書ける（1つも変えていないことの確認になる）。
 */
const bullpen = (...rows: Array<[number, boolean, number?]>): CpuReliefCandidate[] =>
  rows.map(([remaining, reliever, quality], index) => ({
    index,
    remaining,
    reliever,
    quality: quality ?? 3,
  }));

/** いまマウンドにいる投手。**質は既定で 0（最低）**＝上と対で「必ず代える」側に倒す */
const mound = (remaining: number, quality = 0) => ({ remaining, quality });

describe('chooseCpuRelief（CPU投手の自動継投）', () => {
  it('人間側と同じ合図で動く：しきい値は「球威が落ち始める残量」と同じ値', () => {
    // 別々の数字を持つと「CPUだけ違う基準で代える」ことになり、規則が読めなくなる
    expect(CPU_RELIEF_REMAINING_THRESHOLD).toBe(STAMINA_FRESH_THRESHOLD);
  });

  it('球威が落ちていないうちは交代しない', () => {
    expect(chooseCpuRelief(mound(1), bullpen([1, true]))).toBeNull();
    expect(chooseCpuRelief(mound(CPU_RELIEF_REMAINING_THRESHOLD), bullpen([1, true]))).toBeNull();
  });

  it('球威が落ちたらリリーフ型へ交代する', () => {
    // 先発型（添字0）が先に並んでいてもリリーフ型（添字1）を選ぶ
    expect(chooseCpuRelief(mound(0.4), bullpen([1, false], [1, true]))).toBe(1);
  });

  it('リリーフ型が複数いれば残量が多いほう、同じなら並び順の先', () => {
    expect(chooseCpuRelief(mound(0.4), bullpen([0.6, true], [1, true]))).toBe(1);
    expect(chooseCpuRelief(mound(0.4), bullpen([1, true], [1, true]))).toBe(0);
  });

  it('リリーフ型がいなければ先発型から選ぶ（残量が多い順）', () => {
    expect(chooseCpuRelief(mound(0.4), bullpen([0.7, false], [1, false]))).toBe(1);
  });

  it('ブルペンが空、または全員が疲れていれば交代しない（続投）', () => {
    expect(chooseCpuRelief(mound(0.1), [])).toBeNull();
    expect(chooseCpuRelief(mound(0.1), bullpen([0.2, true], [0.3, false]))).toBeNull();
  });

  it('同じ状況からは必ず同じ相手を選ぶ（決定的）', () => {
    const pen = bullpen([1, false], [0.8, true], [1, true]);
    const first = chooseCpuRelief(mound(0.3), pen);
    for (let i = 0; i < 5; i += 1) expect(chooseCpuRelief(mound(0.3), pen)).toBe(first);
  });

  // ---- Z-47：質を比べて「代えるか続投か」を決める ----

  it('格下の控えには代えない＝疲れたエースが続投する（このフェーズの芯）', () => {
    // 質2.0のエースが球威ダウン域に入っても、控えの一番手が1.5なら出さない
    expect(chooseCpuRelief(mound(0.4, 2), bullpen([1, true, 1.5]))).toBeNull();
  });

  it('格上の控えには代える（同じ質なら代える＝マージンは置かない）', () => {
    expect(chooseCpuRelief(mound(0.4, 1), bullpen([1, true, 1.5]))).toBe(0);
    expect(chooseCpuRelief(mound(0.4, 1.5), bullpen([1, true, 1.5]))).toBe(0);
    expect(CPU_RELIEF_QUALITY_MARGIN).toBe(0);
  });

  it('投げ続ければ質が落ちるので、続投はいつか必ず終わる', () => {
    // 疲労で質が下がっていく様子を「同じ投手を残量だけ減らして呼ぶ」形で再現する
    const pen = bullpen([1, true, 1.5]);
    expect(chooseCpuRelief(mound(0.4, 2.0), pen)).toBeNull(); // まだ格上
    expect(chooseCpuRelief(mound(0.2, 1.7), pen)).toBeNull();
    expect(chooseCpuRelief(mound(0.05, 1.4), pen)).toBe(0); // 追い抜かれたら代わる
  });

  it('比べる相手は「選ばれた一番手」だけ＝原作p8の型の優先は崩れない', () => {
    // 先発型（添字0）のほうが質は高いが、リリーフ型（添字1）が一番手として比較に立つ。
    // その一番手が格下なら**続投**＝格上の先発型を救援に引っぱり出したりはしない。
    expect(chooseCpuRelief(mound(0.4, 2), bullpen([1, false, 2.5], [1, true, 1.5]))).toBeNull();
  });

  it('無傷なら質を見るまでもなく続投（判断の入口はJ-30のまま）', () => {
    expect(chooseCpuRelief(mound(1, 0), bullpen([1, true, 3]))).toBeNull();
  });
});

// ---- 2. ランダンプレイ（走って追えば触れるか） ----

describe('closestApproachDistance（等速直線の最接近）', () => {
  it('止まっている2点の距離はそのまま', () => {
    const d = closestApproachDistance({ x: 0, z: 0 }, { x: 0, z: 0 }, { x: 3, z: 4 }, { x: 0, z: 0 }, 5);
    expect(d).toBeCloseTo(5, 6);
  });

  it('すれ違う2点は「区間の端」ではなく途中の最小値を返す', () => {
    // 右へ進む点と、そのすぐ上を左へ進む点。t=0 と t=2 では離れているが t=1 で最接近
    const d = closestApproachDistance(
      { x: -10, z: 0 },
      { x: 10, z: 0 },
      { x: 10, z: 1 },
      { x: -10, z: 0 },
      2,
    );
    expect(d).toBeCloseTo(1, 6);
  });

  it('最接近が区間より後なら、区間の端での距離を返す（区間でクランプする）', () => {
    const d = closestApproachDistance(
      { x: -10, z: 0 },
      { x: 10, z: 0 },
      { x: 10, z: 1 },
      { x: -10, z: 0 },
      0.5,
    );
    expect(d).toBeGreaterThan(1);
  });
});

describe('canTagByRunning（走って追えば仕留められるか）', () => {
  const base = BASE_POSITIONS.second;
  const path = (t: number): Vec2 => ({
    x: BASE_POSITIONS.first.x + (base.x - BASE_POSITIONS.first.x) * t,
    z: BASE_POSITIONS.first.z + (base.z - BASE_POSITIONS.first.z) * t,
  });

  it('塁に先着できるなら仕留められる', () => {
    // 走者は塁間の半分、野手は塁のすぐ隣
    const carrier = { x: base.x + 1, z: base.z + 1 };
    expect(canTagByRunning(carrier, { pos: path(0.5), target: base, speed: RUNNER_SPEED })).toBe(true);
  });

  it('走者より塁から遠ければ追いつけない', () => {
    const carrier = { x: base.x, z: base.z + 40 };
    expect(canTagByRunning(carrier, { pos: path(0.9), target: base, speed: RUNNER_SPEED })).toBe(false);
  });

  it('止まっている走者（転倒中）は必ず追いつかれる', () => {
    const carrier = { x: base.x, z: base.z + 40 };
    expect(canTagByRunning(carrier, { pos: path(0.9), target: base, speed: 0 })).toBe(true);
  });

  it('タッチ半径を広げれば追いつける相手が増える（半径が効いている）', () => {
    const runner = { pos: path(0.55), target: base, speed: RUNNER_SPEED };
    const carrier = path(0.35); // 走者の真後ろ（同じ線上）
    const narrow = canTagByRunning(carrier, runner, FIELDER_SPEED, TAG_RADIUS);
    const wide = canTagByRunning(carrier, runner, FIELDER_SPEED, 12);
    expect(wide).toBe(true);
    expect(narrow).toBe(false);
  });
});

describe('chooseCpuRundown（CPU守備が追う相手）', () => {
  const base = BASE_POSITIONS.second;

  it('候補がいなければ null（呼び出し側は従来どおり送球する）', () => {
    expect(chooseCpuRundown({ x: 0, z: 0 }, [])).toBeNull();
  });

  it('追える相手のうち、もっとも進んだ走者（配列の末尾）を選ぶ', () => {
    const near = { pos: { x: base.x + 3, z: base.z + 3 }, target: base, speed: RUNNER_SPEED };
    const carrier = { x: base.x + 1, z: base.z + 1 };
    const chosen = chooseCpuRundown(carrier, [
      { ...near, label: 'behind' },
      { ...near, label: 'lead' },
    ]);
    expect(chosen?.label).toBe('lead');
  });

  it('追えない相手しかいなければ null', () => {
    const far = { pos: { x: base.x + 1, z: base.z + 1 }, target: base, speed: RUNNER_SPEED };
    expect(chooseCpuRundown({ x: base.x, z: base.z + 60 }, [far])).toBeNull();
  });
});

/**
 * **計測の結論を固定する**（`npm run balance:rundown`。CLAUDE.md「測った結果は帯として
 * `tests/balance.test.ts` に固定する」と同じ扱い）。
 *
 * 送球もランダンも**同じ塁**を目指すので、塁への競争では送球が必ず勝つ。したがって
 * 「送球では刺せないが走れば追える」帯は**空**で、CPU守備のランダンは現在の定数では
 * 発火しない。これは実装の誤りではなく守備モデルの帰結なので、**関係が崩れたら
 * 気づけるように**ここで固定しておく（送球を遅くするスキル等が入れば、この式が
 * 先に変わる）。
 */
describe('ランダンの帯（計測の結論。J-30）', () => {
  it('送球で刺せない走者は走っても刺せない（帯は空。フィールド全域を格子で舐めて0件）', () => {
    const base = BASE_POSITIONS.second;
    let band = 0;
    for (let s = 1; s < 20; s += 1) {
      const runner = {
        pos: {
          x: BASE_POSITIONS.first.x + (base.x - BASE_POSITIONS.first.x) * (s / 20),
          z: BASE_POSITIONS.first.z + (base.z - BASE_POSITIONS.first.z) * (s / 20),
        },
        target: base,
        speed: RUNNER_SPEED,
      };
      const runnerTime = distance(runner.pos, base) / RUNNER_SPEED;
      for (let x = -60; x <= 60; x += 4) {
        for (let z = 0; z >= -110; z -= 4) {
          const carrier = { x, z };
          if (distance(carrier, base) / THROW_SPEED < runnerTime) continue;
          if (canTagByRunning(carrier, runner)) band += 1;
        }
      }
    }
    expect(band).toBe(0);
  });

  it('帯が空である理由：同じ塁を目指す限り、走るのは投げるより必ず遅い', () => {
    // 「送球で刺せない」＝野手は塁から走者の (THROW_SPEED/走力) 倍以上遠い、という意味。
    // ランダンも同じ塁を目指すので、この関係が成り立つ限り帯は開かない。
    // **送球が野手の足より遅くなれば開く**が、そのときは内野ゴロ・犠飛・盗塁・けん制の
    // 境界がすべて壊れる（`npm run balance:rundown` の下段）。
    expect(THROW_SPEED).toBeGreaterThan(FIELDER_SPEED);
  });
});

// ---- 3. CPU走者の引き返し・走り出し ----

describe('shouldCpuRetreat（CPU走者の引き返し＝挟殺の逃げる側）', () => {
  const ahead = BASE_POSITIONS.second;
  const behind = BASE_POSITIONS.first;
  const midway = (t: number): Vec2 => ({
    x: behind.x + (ahead.x - behind.x) * t,
    z: behind.z + (ahead.z - behind.z) * t,
  });

  it('進んでも助かるなら引き返さない', () => {
    // 野手はフェンス際＝どちらの塁へ投げても間に合わない
    const decided = shouldCpuRetreat({
      carrier: { x: 0, z: -110 },
      runner: midway(0.5),
      ahead,
      behind,
      speed: RUNNER_SPEED,
    });
    expect(decided).toBe(false);
  });

  it('塁を出たばかりで次の塁に野手がいたら引き返す（実際に起きる挟殺の入口）', () => {
    // 野手は行き先の塁のすぐそば＝進めば刺される。走者はまだ起点の塁の近くなので戻れる
    const decided = shouldCpuRetreat({
      carrier: { x: ahead.x + 1, z: ahead.z + 1 },
      runner: midway(0.1),
      ahead,
      behind,
      speed: RUNNER_SPEED,
    });
    expect(decided).toBe(true);
  });

  it('進みすぎたら引き返さない（戻っても送球が先に着くので、進塁の目が残るほうを選ぶ）', () => {
    const decided = shouldCpuRetreat({
      carrier: { x: ahead.x + 1, z: ahead.z + 1 },
      runner: midway(0.75),
      ahead,
      behind,
      speed: RUNNER_SPEED,
    });
    expect(decided).toBe(false);
  });

  it('どちらへ行っても刺されるなら引き返さない（進塁の目が残るほうを選ぶ）', () => {
    // 走者のすぐ横に野手がいる＝どちらへ走っても触れられる
    const decided = shouldCpuRetreat({
      carrier: midway(0.5),
      runner: midway(0.5),
      ahead,
      behind,
      speed: RUNNER_SPEED,
    });
    expect(decided).toBe(false);
  });

  it('同じ状況からは必ず同じ判断（決定的）', () => {
    const opts = {
      carrier: { x: ahead.x + 1, z: ahead.z + 1 },
      runner: midway(0.1),
      ahead,
      behind,
      speed: RUNNER_SPEED,
    };
    const first = shouldCpuRetreat(opts);
    for (let i = 0; i < 5; i += 1) expect(shouldCpuRetreat(opts)).toBe(first);
  });

  /**
   * **CPUの2つの規則が同じ場面で反対の結論を出さないこと**（実装中に踏んだ回帰）。
   * `chooseCpuTagUp` は「深い外野フライなら送球が間に合わないから走れ」と判断するが、
   * その根拠は持ち替え（`FLY_CATCH_RELEASE_SEC`）を含んだ時間。引き返しの判断が同じ遅れを
   * 見ないと、走り出した犠牲フライの走者をその場で引き返させてしまう。
   */
  it('タッチアップ中は引き返さない（持ち替えの残り時間を勘定に入れる）', () => {
    const outfield = { x: 0, z: -80 }; // 深い中堅で捕った野手
    const justLeftThird = {
      x: BASE_POSITIONS.third.x + (BASE_POSITIONS.home.x - BASE_POSITIONS.third.x) * 0.04,
      z: BASE_POSITIONS.third.z + (BASE_POSITIONS.home.z - BASE_POSITIONS.third.z) * 0.04,
    };
    const opts = {
      carrier: outfield,
      runner: justLeftThird,
      ahead: BASE_POSITIONS.home,
      behind: BASE_POSITIONS.third,
      speed: RUNNER_SPEED,
    };
    // 持ち替えを無視すると「進めば刺される」と読んで引き返してしまう（＝犠牲フライが消える）
    expect(shouldCpuRetreat({ ...opts, throwDelaySec: 0 })).toBe(true);
    // 持ち替え（1.5秒）を渡せば、chooseCpuTagUp と同じ結論＝そのまま本塁を狙う
    expect(shouldCpuRetreat({ ...opts, throwDelaySec: FLY_CATCH_RELEASE_SEC })).toBe(false);
  });
});

describe('shouldCpuBreakForNextBase（けん制のにらみ合いからの走り出し）', () => {
  const from = 'first' as const;
  const next = BASE_POSITIONS[advancedBase(from)];

  it('投手がマウンドでボールを持っている間は走らない（従来どおりのにらみ合い）', () => {
    const decided = shouldCpuBreakForNextBase({
      carrier: FIELDER_HOME_POSITIONS.P,
      runner: leadPosition(from, 5),
      next,
      speed: RUNNER_SPEED,
    });
    expect(decided).toBe(false);
  });

  it('内野に寄られた程度では走らない（送球はまだ間に合う）', () => {
    // ボールを持った野手が一塁まで寄っても、そこから二塁は塁間27.4m＝0.81秒。
    // 5mリードの走者は22.4mを2.99秒かけて走るので、走れば必ず刺される。
    const decided = shouldCpuBreakForNextBase({
      carrier: BASE_POSITIONS.first,
      runner: leadPosition(from, 5),
      next,
      speed: RUNNER_SPEED,
    });
    expect(decided).toBe(false);
  });

  it('境界は「送球の時間 ≧ 走者の時間」ちょうど（ここも他の判定と同じ時間競争）', () => {
    const runner = leadPosition(from, 5);
    const runnerTime = distance(runner, next) / RUNNER_SPEED;
    // 送球がちょうど間に合わなくなる距離を逆算して、その内外で判断が切り替わることを見る
    const boundary = runnerTime * THROW_SPEED;
    const at = (d: number): Vec2 => ({ x: next.x, z: next.z + d });
    expect(
      shouldCpuBreakForNextBase({ carrier: at(boundary + 1), runner, next, speed: RUNNER_SPEED }),
    ).toBe(true);
    expect(
      shouldCpuBreakForNextBase({ carrier: at(boundary - 1), runner, next, speed: RUNNER_SPEED }),
    ).toBe(false);
  });

  /**
   * **計測の結論（ランダンと同じ理由。J-30）**：けん制のにらみ合いでは、投手がボールを
   * 持っている限りどこにいても送球が先に着く。上の境界は**フェンスの外**にあるので、
   * この規則は実際の試合では発火しない＝「CPU走者はけん制中に走り出さない」は
   * 割り切りではなく**この守備モデルでは正しい走塁**だった。
   */
  it('走り出しが成立する送球距離はフィールドの外（＝実際には走らないのが正しい）', () => {
    const runner = leadPosition(from, 5);
    const runnerTime = distance(runner, next) / RUNNER_SPEED;
    expect(runnerTime * THROW_SPEED).toBeGreaterThan(100);
  });
});

// ---- 4. CPUの乱闘（相手の状態を見る決定的な規則） ----

const hurt = (): FighterState => ({ ...createFighterState(), phase: 'hitstun', timer: 0.4 });
const winding = (): FighterState => ({
  ...createFighterState(),
  phase: 'startup',
  timer: 0.2,
  pendingMove: 'punch',
});
const guarding = (): FighterState => ({ ...createFighterState(), guarding: true });

describe('chooseCpuBrawlAction（CPUの乱闘。三すくみを規則で使う）', () => {
  const idle = createFighterState();

  it('相手が技を出そうとしていたらガードする', () => {
    expect(chooseCpuBrawlAction(idle, winding(), DEFAULT_LOADOUT)).toEqual({ kind: 'guard' });
  });

  it('相手がガードしていたら投げる（ガードを崩す唯一の手段）', () => {
    expect(chooseCpuBrawlAction(idle, guarding(), DEFAULT_LOADOUT)).toEqual({
      kind: 'attack',
      move: 'throw',
    });
  });

  it('相手が硬直・のけぞり中なら、装備でいちばん強い打撃を叩き込む', () => {
    const loadout = { ...DEFAULT_LOADOUT, moves: ['jab', 'punch', 'throw', 'shoryu'] as const };
    const action = chooseCpuBrawlAction(idle, hurt(), { ...loadout, moves: [...loadout.moves] });
    expect(action).toEqual({ kind: 'attack', move: 'shoryu' });
  });

  it('にらみ合いではジャブ（いちばん発生が速く、当たればコンボの起点になる）', () => {
    expect(chooseCpuBrawlAction(idle, idle, DEFAULT_LOADOUT)).toEqual({
      kind: 'attack',
      move: 'jab',
    });
  });

  it('自分が動けない間は何もしない', () => {
    const self: FighterState = { ...createFighterState(), phase: 'hitstun', timer: 0.3 };
    expect(chooseCpuBrawlAction(self, idle, DEFAULT_LOADOUT)).toEqual({ kind: 'wait' });
  });

  it('技を当てた直後は格上へキャンセルする（人間と同じコンボ）', () => {
    const self: FighterState = {
      ...createFighterState(),
      phase: 'recovery',
      timer: 0.2,
      lastMove: 'jab',
      cancelable: true,
    };
    expect(chooseCpuBrawlAction(self, hurt(), DEFAULT_LOADOUT)).toEqual({
      kind: 'attack',
      move: 'punch',
    });
  });

  it('ガードされた直後（cancelable=false）は繋げない＝守り切れば相手の番になる', () => {
    const self: FighterState = {
      ...createFighterState(),
      phase: 'recovery',
      timer: 0.2,
      lastMove: 'jab',
      cancelable: false,
    };
    expect(chooseCpuBrawlAction(self, idle, DEFAULT_LOADOUT)).toEqual({ kind: 'wait' });
  });

  it('持っていない技は選ばない（素の選手はジャブ・パンチ・投げだけ）', () => {
    const action = chooseCpuBrawlAction(createFighterState(), hurt(), DEFAULT_LOADOUT);
    expect(action).toEqual({ kind: 'attack', move: 'punch' });
    expect(strongestStrike(DEFAULT_LOADOUT)).toBe('punch');
  });

  it('反応時間はジャブの発生より長い＝見てから防がれない技が残る（差し込む価値）', () => {
    expect(CPU_BRAWL_REACTION_SEC).toBeGreaterThan(MOVES.jab.startupSec);
    // 人間の単純反応（およそ0.2秒）より遅い＝人間に不可能な速さでは反応しない
    expect(CPU_BRAWL_REACTION_SEC).toBeGreaterThanOrEqual(0.2);
  });

  it('同じ状況からは必ず同じ手（決定的・乱数不使用）', () => {
    const seen = guarding();
    const first = chooseCpuBrawlAction(idle, seen, DEFAULT_LOADOUT);
    for (let i = 0; i < 5; i += 1) {
      expect(chooseCpuBrawlAction(idle, seen, DEFAULT_LOADOUT)).toEqual(first);
    }
  });
});

describe('CPU守備の送球先（Y-46。押しバントで先頭走者が送球に勝てるようになった）', () => {
  // 並びはシーン層の `live` と同じ＝**もっとも進んだ走者が最後**
  const batter = { name: 'batter' };
  const first = { name: 'first' };
  const second = { name: 'second' };
  const runners = [batter, first, second];
  const only = (...ids: Array<{ name: string }>) => (v: { name: string }) => ids.includes(v);

  it('1投目は先頭の塁へ投げる（刺せるとき＝従来どおり）', () => {
    expect(chooseCpuThrowTarget(runners, only(batter, first, second), false)).toBe(second);
  });

  it('先頭を刺せないなら、刺せる走者のうち最も進んだ者へ投げる（送りバントの確実なアウト）', () => {
    expect(chooseCpuThrowTarget(runners, only(batter, first), false)).toBe(first);
    expect(chooseCpuThrowTarget(runners, only(batter), false)).toBe(batter);
  });

  it('誰も刺せなければ従来どおり先頭の塁へ投げる（ボールが内野へ返る絵は変わらない）', () => {
    expect(chooseCpuThrowTarget(runners, () => false, false)).toBe(second);
  });

  it('2投目以降は刺せる走者だけを狙う（K-31から不変）', () => {
    expect(chooseCpuThrowTarget(runners, only(batter), true)).toBe(batter);
    expect(chooseCpuThrowTarget(runners, () => false, true)).toBeNull();
  });

  it('走者がいなければ投げない', () => {
    expect(chooseCpuThrowTarget([], () => true, false)).toBeNull();
  });

  it('同じ状況からは必ず同じ送球先（決定的・乱数不使用）', () => {
    const pick = () => chooseCpuThrowTarget(runners, only(batter, first), false);
    const firstPick = pick();
    for (let i = 0; i < 5; i += 1) expect(pick()).toBe(firstPick);
  });
});
