/**
 * 判定ロジック（純粋関数のみ）。
 * ボール/ストライクカウント、押し出し進塁、イニング進行・試合決着の判定を担う。
 * 状態は一切持たず、gameMachine から呼び出される。
 */

export type Half = 'top' | 'bottom';
export type TeamSide = 'away' | 'home';

export interface Count {
  balls: number;
  strikes: number;
}

export interface Bases {
  first: boolean;
  second: boolean;
  third: boolean;
}

export interface Score {
  away: number;
  home: number;
}

export const EMPTY_COUNT: Count = { balls: 0, strikes: 0 };
export const EMPTY_BASES: Bases = { first: false, second: false, third: false };

export const BALLS_FOR_WALK = 4;
export const STRIKES_FOR_OUT = 3;
export const OUTS_PER_HALF = 3;
export const REGULATION_INNINGS = 9;
// 銃の使用可能回数はここには無い（フェーズF-26-2）。銃はスキル `ジュウ` に吸収され、
// **チーム共有の回数から投手個人の残弾**になったので、定数は `skills.ts` の
// `GUN_SHOTS_PER_PITCHER`、残弾の導出は `roster.ts` の `gunRemainingOf` が持つ。

/** 表はビジター攻撃、裏はホーム攻撃 */
export function battingTeam(half: Half): TeamSide {
  return half === 'top' ? 'away' : 'home';
}

export function fieldingTeam(half: Half): TeamSide {
  return half === 'top' ? 'home' : 'away';
}

export function opponent(side: TeamSide): TeamSide {
  return side === 'away' ? 'home' : 'away';
}

/**
 * 1球の判定。**`buntFoul`（バントの打球がファウルになった）だけが `foul` と別**で、
 * こちらはファウルの頭打ちを適用しない＝**2ストライク後は三振**（フェーズAA-48。
 * 説明書p32「実際の野球のルールにできるだけ合わせてある」）。
 *
 * 2ストライク未満では `strike` とまったく同じ結果になる（0→1、1→2）ので、
 * **実際の野球と同じく「バントのファウルはストライクとして数える」1つの規則**に
 * なっている＝三振の場合だけを特別扱いする分岐は持たない。
 */
export type PitchJudgement = 'ball' | 'strike' | 'foul' | 'buntFoul';

export type PitchOutcome =
  | { kind: 'inProgress'; count: Count }
  | { kind: 'walk' }
  | { kind: 'strikeout' };

/**
 * 1球の判定をカウントに適用する。ファウルは3ストライク目にはならない
 * （**バントのファウル＝`buntFoul` だけは例外**。上記の型のコメントを参照）。
 */
export function applyPitch(count: Count, judgement: PitchJudgement): PitchOutcome {
  switch (judgement) {
    case 'ball': {
      const balls = count.balls + 1;
      if (balls >= BALLS_FOR_WALK) return { kind: 'walk' };
      return { kind: 'inProgress', count: { balls, strikes: count.strikes } };
    }
    case 'strike':
    case 'buntFoul': {
      const strikes = count.strikes + 1;
      if (strikes >= STRIKES_FOR_OUT) return { kind: 'strikeout' };
      return { kind: 'inProgress', count: { balls: count.balls, strikes } };
    }
    case 'foul': {
      const strikes = Math.min(count.strikes + 1, STRIKES_FOR_OUT - 1);
      return { kind: 'inProgress', count: { balls: count.balls, strikes } };
    }
  }
}

export interface AdvanceResult {
  bases: Bases;
  runs: number;
}

// ---- 走者の識別（能力値モデル：フェーズB-8） ----

/**
 * 塁上にいる走者そのもの（roster.ts の PlayerId）。
 *
 * `Bases` は「その塁が埋まっているか」しか持たないので、**塁上の走者が誰なのかは
 * これまで試合状態から失われていた**。走力（RUN）を全走者に効かせるには「一塁にいるのは
 * 誰か」を打席をまたいで覚えている必要があるため、識別情報を持つ層をここに足す。
 *
 * `Bases`（真偽値）は**占有状況の派生ビュー**として残し（`occupancy`）、既存の
 * 「埋まっているか」だけを見るロジック（けん制の可否・CPUの判断・HUD表示など）は
 * 一切変更せずに済むようにしてある。塁の占有と走者の識別で真実が二重化しないよう、
 * gameMachine は必ず `BaseRunners` を先に更新し、`Bases` はそこから導出する。
 */
export type RunnerId = string;

export interface BaseRunners {
  first: RunnerId | null;
  second: RunnerId | null;
  third: RunnerId | null;
}

export const EMPTY_BASE_RUNNERS: BaseRunners = { first: null, second: null, third: null };

/**
 * 識別情報が与えられなかった場合に充てる無名の走者。
 * 真偽値の `Bases` しか渡されない経路（真偽値版の進塁関数、テストが直接送る
 * PLAY_RESOLVED など）で「誰かがいる」ことだけを表すために使う。実プレイでは
 * main.ts が必ず実在の PlayerId を渡すので、この値が試合中に現れることはない。
 */
export const ANONYMOUS_RUNNER: RunnerId = '?';

/** 走者の識別情報から塁の占有状況（真偽値）を導出する */
export function occupancy(runners: BaseRunners): Bases {
  return {
    first: runners.first !== null,
    second: runners.second !== null,
    third: runners.third !== null,
  };
}

/** 真偽値の塁状況を走者の識別情報へ持ち上げる（識別情報が無い経路の後方互換用） */
export function runnersFromBases(bases: Bases, id: RunnerId = ANONYMOUS_RUNNER): BaseRunners {
  return {
    first: bases.first ? id : null,
    second: bases.second ? id : null,
    third: bases.third ? id : null,
  };
}

export interface AdvanceRunnersResult {
  runners: BaseRunners;
  runs: number;
}

/**
 * 四球・死球による進塁（走者の識別つき）。フォースされた走者のみ1つ進み、
 * 誰がどの塁へ動いたかを保つ。満塁時は三塁走者が生還して1点。
 *
 * 真偽値版（forceAdvance）はこの関数の薄いアダプタで、占有状況の計算は1本しかない。
 */
export function forceAdvanceRunners(
  runners: BaseRunners,
  batterId: RunnerId,
): AdvanceRunnersResult {
  const firstOn = runners.first !== null;
  const secondOn = runners.second !== null;
  const thirdOn = runners.third !== null;
  return {
    runners: {
      first: batterId,
      second: firstOn ? runners.first : runners.second,
      third: firstOn && secondOn ? runners.second : runners.third,
    },
    runs: firstOn && secondOn && thirdOn ? 1 : 0,
  };
}

/**
 * 四球・死球による進塁。フォースされた走者のみ1つ進む。
 * 満塁時は三塁走者が生還して1点。
 */
export function forceAdvance(bases: Bases): AdvanceResult {
  const { runners, runs } = forceAdvanceRunners(runnersFromBases(bases), ANONYMOUS_RUNNER);
  return { bases: occupancy(runners), runs };
}

export type HitType = 'single' | 'double' | 'triple' | 'homerun';

const HIT_ADVANCE: Record<HitType, number> = {
  single: 1,
  double: 2,
  triple: 3,
  homerun: 4,
};

/**
 * 安打による進塁の簡易モデル（全走者が打者と同じ塁数だけ進む・走者の識別つき）。
 * 全員が同じ塁数だけ動くので行き先が重なることはなく、誰がどの塁に着いたかが保たれる。
 *
 * `extraBases` は**もう1つ先まで進める走者**の起点（フェーズH-28のヒットエンドラン
 * ＝投球の前にスタートを切っていた走者。単打で一塁走者が三塁まで行く、という走らせて
 * 打つことの見返りそのもの）。**省略時は誰も進まない**＝渡さない呼び出しは従来と
 * 完全に同じ結果になる（B-9で `BatterSide` の既定を右打者にしたのと同じ整理）。
 *
 * 追い越しは起きない：**先の走者から順に行き先を決め、前の走者が空けた塁より先へは
 * 進めない**（前が生還したら上限は消える）。全員が同じ塁数だけ動く従来の呼び出しでは
 * 行き先が必ず単調に増えるので、この上限は一度も効かない。
 */
export function advanceOnHitRunners(
  runners: BaseRunners,
  batterId: RunnerId,
  hit: HitType,
  extraBases: ReadonlyArray<'first' | 'second' | 'third'> = [],
): AdvanceRunnersResult {
  const n = HIT_ADVANCE[hit];
  const extra = new Set(extraBases);
  // 0 = 打者（本塁からスタート）。打者走者は誰の後ろにも並べないので extra の対象外。
  const occupants: Array<{ base: number; id: RunnerId; bonus: number }> = [
    { base: 0, id: batterId, bonus: 0 },
  ];
  if (runners.first !== null) {
    occupants.push({ base: 1, id: runners.first, bonus: extra.has('first') ? 1 : 0 });
  }
  if (runners.second !== null) {
    occupants.push({ base: 2, id: runners.second, bonus: extra.has('second') ? 1 : 0 });
  }
  if (runners.third !== null) {
    occupants.push({ base: 3, id: runners.third, bonus: extra.has('third') ? 1 : 0 });
  }

  const result: BaseRunners = { first: null, second: null, third: null };
  let runs = 0;
  // 前を走る走者の行き先（これ以上は前へ出られない）。4＝前がいない/生還した＝上限なし。
  let ahead = 4;
  for (const { base, id, bonus } of [...occupants].reverse()) {
    const dest = Math.min(base + n + bonus, ahead === 4 ? 4 : ahead - 1);
    if (dest >= 4) {
      runs += 1;
      continue; // 生還した走者は塁を空けるので上限は据え置き
    }
    if (dest === 1) result.first = id;
    else if (dest === 2) result.second = id;
    else if (dest === 3) result.third = id;
    ahead = dest;
  }
  return { runners: result, runs };
}

/**
 * 安打による進塁の簡易モデル（全走者が打者と同じ塁数だけ進む）。
 * 実際の守備・走塁プレーの結果は将来ちっちゃいモードの物理判定が決めるが、
 * その結果の記録・自動決着用の共通処理として使う。
 */
export function advanceOnHit(bases: Bases, hit: HitType): AdvanceResult {
  const { runners, runs } = advanceOnHitRunners(
    runnersFromBases(bases),
    ANONYMOUS_RUNNER,
    hit,
  );
  return { bases: occupancy(runners), runs };
}

/**
 * イニングごとの得点記録（スコアボード表示用）。表/裏どちらもイニング番号（1始まり）を
 * 添字にして揃える（away は表、home は裏で記録するため、同じイニング番号が
 * 常に同じ添字を指す）。該当イニングにまだ到達していない側は配列が短いままになる
 * （＝表示側で「空欄（未到達）」と「0（無得点で終了）」を区別できる）。
 */
export interface LineScore {
  away: number[];
  home: number[];
}

export const EMPTY_LINE_SCORE: LineScore = { away: [], home: [] };

/**
 * 指定イニング・チームの得点を加算する。runs が 0 でも必ず呼ぶことで、
 * そのイニングのマスを「未到達（undefined）」から「0（無得点で終了/進行中）」へ
 * 確定させる（gameMachine 側は毎打席の決着ごとに runs=0 でも呼ぶ設計）。
 * 万一イニングを飛ばして呼ばれても、間のマスは0で埋める。
 */
export function recordInningRuns(
  lineScore: LineScore,
  side: TeamSide,
  inning: number,
  runs: number,
): LineScore {
  const arr = [...lineScore[side]];
  while (arr.length < inning) arr.push(0);
  arr[inning - 1] += runs;
  return { ...lineScore, [side]: arr };
}

export type GameProgress =
  | { kind: 'continue' }
  | { kind: 'nextHalf'; inning: number; half: Half }
  | { kind: 'gameOver'; winner: TeamSide };

/**
 * プレー完了後の試合進行判定。
 * - 9回以降の裏にホームがリード → サヨナラで即決着（アウト数を問わない）
 * - 3アウトで攻守交代。ただし
 *   - 9回以降の表終了時にホームがリード → 裏を行わず決着
 *   - 9回以降の裏終了時に同点でなければ決着（同点なら延長へ、無制限）
 */
export function evaluateProgress(
  inning: number,
  half: Half,
  outs: number,
  score: Score,
): GameProgress {
  if (half === 'bottom' && inning >= REGULATION_INNINGS && score.home > score.away) {
    return { kind: 'gameOver', winner: 'home' };
  }
  if (outs >= OUTS_PER_HALF) {
    if (half === 'top') {
      if (inning >= REGULATION_INNINGS && score.home > score.away) {
        return { kind: 'gameOver', winner: 'home' };
      }
      return { kind: 'nextHalf', inning, half: 'bottom' };
    }
    if (inning >= REGULATION_INNINGS && score.away !== score.home) {
      return {
        kind: 'gameOver',
        winner: score.away > score.home ? 'away' : 'home',
      };
    }
    return { kind: 'nextHalf', inning: inning + 1, half: 'top' };
  }
  return { kind: 'continue' };
}
