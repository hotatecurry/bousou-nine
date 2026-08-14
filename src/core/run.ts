/**
 * ラン（試合をまたぐローグライト。フェーズF-26-6。CLAUDE.md ⑧）。
 *
 * v1は「1試合＝1ラン」だった（試合が終わればスキルは消える）。ここでそれを
 * **5試合の勝ち抜き**に広げる：勝てば次の試合へ進み、**スキルは選手に付いたまま持ち越す**。
 * 1つでも落とせばランはそこで終わり（2026-07-29 ユーザー判断）。
 *
 * ## このファイルが持つもの
 *
 * `core/tempo.ts`（間の長さ）・`core/condition.ts`（好調）と同じ立て方で、
 * **ランの規則と調整したくなる値だけ**を集める。試合そのものの状態は従来どおり
 * `gameMachine` が持ち、**ランは試合の外側にある**（main.ts が `RunState` を持ち回る）。
 * 球場を `gameMachine` のコンテキストに入れなかった（C-14）のと同じ理由で、
 * ランは1試合のルール・判定には一切効かない。
 *
 * ## すべては「シード1つ」から決まる
 *
 * ランのシードから **試合ごと・扉ごとのシード**（`gameSeed`）が決まり、そこから
 * その試合の**乱数列・系統の絞り込み・絶好調選手・相手の蓄積スキル**がすべて導出される。
 * D-19（好調）とF-26-5（系統）が「本編の乱数を消費せず、塩を混ぜた別系列から引く」形に
 * してあるので、**同じシードのランは何度でもまったく同じ5試合になる**（テストが決定的に
 * 書ける／実機検証で同じ場面を再現できる）。
 *
 * ## 相手も同じだけ蓄積している（2026-07-29 ユーザー判断）
 *
 * 毎試合ちがう球団と当たるが、相手は**ここまでの試合数ぶんの抽選をCPU規則で先に
 * 済ませた状態**で出てくる（`preloadedSkills`）。人間側だけが育つと、進むほど一方的に
 * なる（B-11の「CPUは自動継投しない」と同じ非対称の拡大）。CPUの選択規則
 * （`cpuChooseSkill`）は決定的なので、**相手の顔ぶれも読める**＝「引きがズルい」に
 * ならない（⑧の桜井ノウハウ照合）。
 */
import { type BallparkId, BALLPARKS } from './ballpark';
import { type RngState, createRngState, nextIndex, sampleWithoutReplacement } from './rng';
import {
  NEUTRAL_STAMINA,
  type PlayerId,
  type RosterPlan,
  type TeamRoster,
  createTeamRoster,
  effectivePitching,
  grantSkill,
  maxPitchesFor,
  skillHoldersOf,
  withCarriedFatigue,
  withCarriedSkills,
} from './roster';
import { REGULATION_INNINGS, type TeamSide } from './rules';
import {
  type SkillId,
  type SkillLineage,
  activeLineagesFor,
  cpuChooseSkill,
  drawSkillDraft,
  rerollsLeft,
  shouldCpuReroll,
} from './skills';
import { type TeamId, TEAMS, teamById } from './teams';

/**
 * 勝ち抜く試合数（2026-07-29 ユーザー判断）。
 *
 * 5試合＝抽選 5×`DRAFTS_PER_GAME`＝45回に対して、スキルを置ける枠はロスター17人×
 * `MAX_SKILLS_PER_PLAYER`。**この2つの数の関係がランのバランスそのもの**なので、
 * ここを動かすときは `skills.ts` の枠上限と一緒に見る（枠のほうが少ないと、
 * 終盤の抽選が「候補が作れず何も起きない回」になる）。
 */
export const RUN_GAMES = 5;

/** 試合と試合の間に提示する「扉」の数（ハデスの部屋選択に相当） */
export const RUN_DOOR_COUNT = 2;

/**
 * 1試合あたりの抽選回数＝**攻撃の回数**（その回の攻撃が始まる前に1つ。F-26-1）。
 * 9回制なので9回で、延長・サヨナラで多少前後するが、相手の蓄積を見積もる基準はこれでよい
 * （相手が「ここまで何試合ぶん引いてきたか」の換算に使うだけの値）。
 */
export const DRAFTS_PER_GAME = REGULATION_INNINGS;

/**
 * 試合・扉ごとのシードの刻み。**扉ごとに別のシード**にしてあるので、扉を選ぶことは
 * 「相手」だけでなく**次の試合の系統・絶好調選手まで選ぶ**ことになる（ハデスの
 * 「どの神の恵みが出る部屋へ入るか」）。値そのものに意味は無く、系列が混ざらない
 * 間隔であればよい。
 */
const GAME_SEED_STRIDE = 1013;
const DOOR_SEED_STRIDE = 71;

/** 扉に並べる球場の抽選に混ぜる塩（系統の抽選＝素のシードと同じ系列にしないため） */
const PARK_SEED_SALT = 0x9a11;
/** 扉に並べる相手の抽選に混ぜる塩（同上） */
const OPPONENT_SEED_SALT = 0x4f0e;
/**
 * 相手の蓄積スキルを引く系列に混ぜる塩。**本編の乱数（`GameContext.rngState`）は
 * 消費しない**＝人間側の3択の出方は、相手が何を持ってこようと変わらない
 * （F-26-5の系統の絞り込み・D-19の好調の抽選と同じ整理）。
 */
const PRELOAD_SEED_SALT = 0x51e1;

/** 選手ID→その選手が取った順のスキル（`TeamRoster.skills` と同じ形＝そのまま持ち越せる） */
export type CarriedSkills = Record<PlayerId, readonly SkillId[]>;

// ---- 疲労の持ち越し（フェーズV-43） ----
//
// F-26-6は「**新しい試合は必ず全員そろった状態から始まる**」と決めていた（投球数・退場・
// 好調・カウントは試合ごとに仕切り直す）。V-43で**先発を試合ごとに選び直せる**ようにした
// ので、この約束をそのままにすると**毎試合エースが支配戦略**になる（選択肢は増えるのに
// 判断が生まれない）＝F-26-8が消費型で出した結論「試合ごとに回復させると温存の判断
// そのものが消える」とまったく同じ形。そこで**投げた投手全員に疲れが残る**
// （2026-08-08 ユーザー判断）。
//
// **真実は「投球数」の側**（B-11）をそのまま試合の外へ延長する：持ち越すのは残量でも
// 疲労でもなく**投球数**で、残量・疲労・先発型かどうかは従来どおりそこからの導出。
// おかげで判定側（`pitch.ts`・`batting.ts`）にはV-43が見えず、**HUDのゲージも采配
// メニューの残量%も、持ち越した投手については最初から減った状態で出る**（表示のための
// 別フィールドを持たないので食い違いようがない）。

/**
 * 1試合ぶんの休養で戻る残りスタミナの割合（フェーズV-43）。
 *
 * **値は `npm run balance:rotation` の3段目が決めた**（CLAUDE.md「バランス調整の方針」）。
 * 満たすべき条件は3つで、**0.40 は3つすべてが成り立つ最小の値**：
 *
 * 1. **CPUの4人ローテーション（R-39）が必ず全快で回る**＝⑧の「CPUも対等」。CPUは
 *    `cpuStarterIndex` で先発型4人を順に回すので、同じ投手が次に投げるのは4試合後
 *    ＝`4 × REST_RECOVERY ≥ 1`。**相手が規則どおり回していることが、そのまま人間側の
 *    手本になる**（R-39のローテーションが「なぜ正しいか」を後から説明する形になった）。
 * 2. **連投（次の試合にもう一度先発）は球威が落ちた状態から始まる**
 *    （`REST_RECOVERY < STAMINA_FRESH_THRESHOLD`）＝代償が実際に効く。
 * 3. **1試合空ければほぼ無傷**（`2 × REST_RECOVERY ≥ 0.8`）＝5試合のランを3人でも
 *    回せる余地を残す（4人ローテだけが正解にならない）。
 *
 * **回復は「割合」で持つ**（球数の定数ではなく）。残量そのものが `maxPitchesFor` で
 * 割った割合なので、**容量の小さいリリーフも大きい先発も同じ速さでゲージが戻る**＝
 * 「短く使えば毎試合出られる」がリリーフの値打ちとして自然に出る。
 */
export const REST_RECOVERY = 0.4;

/**
 * 選手ID→次の試合へ持ち越す投球数（`TeamRoster.pitchCounts` と同じ形＝そのまま渡せる）。
 * `CarriedSkills`・`CarriedUses` と同じ「試合をまたいで残るもの」の棚。
 */
export type CarriedFatigue = Record<PlayerId, number>;

/**
 * 試合が終わった時点のロスターから、次の試合へ持ち越す投球数を出す。
 *
 * **投げた投手だけでなく全員が回復する**（投げなかった投手は前の試合から持ち越した
 * ぶんが減るだけ）。読むのは `pitchCounts` で、そこには**持ち越したぶん＋この試合で
 * 投げたぶん**が入っている（`withCarriedFatigue` が試合の頭で載せる）ので、
 * この1本で「積む」と「戻す」の両方が閉じる。
 *
 * 回復量に `effectivePitching` を通すのは、スキルの補正込みのスタミナで割るため
 * （`タフネス` を持つ投手は限界球数が増えるので、**同じ割合の回復が球数としては多くなる**
 * ＝残量ゲージの読み方が持ち主でも他の投手でも変わらない。B-11の
 * `remainingStaminaOf` とまったく同じ読み方）。
 */
export function restedPitchCounts(roster: TeamRoster): CarriedFatigue {
  const next: CarriedFatigue = {};
  for (const playerId of Object.keys(roster.pitchCounts)) {
    const thrown = roster.pitchCounts[playerId] ?? 0;
    if (thrown <= 0) continue;
    const stats = effectivePitching(roster, playerId);
    const recovered = REST_RECOVERY * maxPitchesFor(stats?.stamina ?? NEUTRAL_STAMINA);
    // **球数として持つので整数に丸める**（持ち越すのは「投球数」だという約束を、値の形でも
    // 保つ。端数のまま持っても残量の導出は割り算なので結果は変わらないが、`pitchCounts` に
    // 小数が混ざると「真実は投球数の側」という読み方が崩れる）。
    const left = Math.max(0, Math.round(thrown - recovered));
    // 0 は「無傷」＝持ち越す意味が無いのでキーごと落とす（`skillUses` と同じ扱い）
    if (left > 0) next[playerId] = left;
  }
  return next;
}

/**
 * 選手ID→消費型スキルを使った回数（`TeamRoster.skillUses` と同じ形。フェーズF-26-8）。
 *
 * **スキル本体と対で持ち越す**：チャージはラン全体で使い切りなので、前の試合で撃った
 * 1発は次の試合でも戻らない。ここを持ち越さないと試合ごとに全回復してしまい、
 * 「温存する／しない」という判断そのものが消える（＝消費型を入れた意味が無くなる）。
 */
export type CarriedUses = Record<PlayerId, Partial<Record<SkillId, number>>>;

/** 1試合ぶんの「どこで誰と」（＝扉を選んだ結果。シードがその試合のすべてを決める） */
export interface RunGame {
  /** この試合のシード（乱数列・系統・絶好調選手・相手の蓄積が全部ここから決まる） */
  seed: number;
  opponent: TeamId;
  park: BallparkId;
}

/** 試合と試合の間に提示する選択肢（ハデスの「報酬が見えている扉」） */
export interface RunDoor extends RunGame {
  /** その扉を選んだ場合に出る系統（F-26-5の絞り込み）。**選ぶ前に見せる**のが扉の要件 */
  lineages: readonly SkillLineage[];
}

export interface RunState {
  /** 何試合目か（1..RUN_GAMES） */
  game: number;
  /** 勝った試合数。**負けた瞬間にランは終わる**ので、進行中は常に `game - 1` */
  wins: number;
  /** ランのシード。試合・扉のシードはここから導出する */
  seed: number;
  /** 人間の球団（ラン中ずっと同じ＝育てる対象そのもの） */
  teamId: TeamId;
  /** 人間が操作する側（先攻/後攻。ラン中不変） */
  side: TeamSide;
  /**
   * 人間側の試合前の采配（先発・打順。C-15）。
   *
   * **V-43より前はラン中不変**で、ランの最初に決めた先発が5試合すべてを投げていた
   * （R-39でCPUには4人ローテーションが付いたのに、人間側だけが1人の先発を使い続ける
   * という非対称が残っていた）。いまは**試合と試合の間に選び直せる**ので、ここは
   * 「いま選ばれている采配」＝扉を選んだ後の段で書き換わる。
   */
  plan: RosterPlan;
  /**
   * 持ち越すスキル。**ラン化で持ち越すのはこのフィールドだけ**（F-26-1で
   * `TeamRoster.skills` を「試合中に変わる状態」の棚として分けておいた狙いどおり）。
   * 投球数・退場・好調は試合ごとに仕切り直す＝**新しい試合は必ず全員そろった状態**から
   * 始まる（乱闘の永久退場は CLAUDE.md ③のとおり「その試合から」）。
   */
  skills: CarriedSkills;
  /**
   * 消費型スキルをここまでのランで使った回数（フェーズF-26-8）。`skills` と対で持ち越す
   * ＝**チャージはラン全体で使い切り**（試合ごとには回復しない）。
   */
  uses: CarriedUses;
  /**
   * リロール（フェーズU-42）をここまでのランで使った回数。**`uses` と同じ扱い**＝
   * 回数券はラン全体で使い切りなので、試合をまたいでも回復しない
   * （回復させると「今引き直すか、終盤に残すか」という温存の判断そのものが消える）。
   * 残りは `rerollsLeft` の導出で、真実はこの「使った数」の側にある。
   */
  rerollsUsed: number;
  /**
   * 前の試合までに投げた球数（フェーズV-43の疲労の持ち越し）。**`skills`・`uses`・
   * `rerollsUsed` と同じ「試合をまたいで残るもの」**で、`restedPitchCounts` が
   * 試合ごとに休養ぶんを引いて更新する。**投げていない投手はキーを持たない**（＝無傷）。
   */
  fatigue: CarriedFatigue;
  /** これまで当たった球団（人間の球団を含む）。同じ相手を2度出さないために持つ */
  faced: readonly TeamId[];
  /** 今の試合 */
  current: RunGame;
}

/** ランの続き方 */
export type RunOutcome = 'continue' | 'clear' | 'over';

/** その試合・その扉のシード（ランのシードからの導出＝どの試合も再現できる） */
export function gameSeed(runSeed: number, game: number, door = 0): number {
  return runSeed + game * GAME_SEED_STRIDE + door * DOOR_SEED_STRIDE;
}

/**
 * ランを始める（1試合目の相手・球場はチーム選択で人間が選んだものをそのまま使う）。
 * 2試合目以降は扉（`runDoors`）から選ぶ。
 */
export function createRun(opts: {
  seed: number;
  teamId: TeamId;
  side: TeamSide;
  plan: RosterPlan;
  opponent: TeamId;
  park: BallparkId;
}): RunState {
  return {
    game: 1,
    wins: 0,
    seed: opts.seed,
    teamId: opts.teamId,
    side: opts.side,
    plan: opts.plan,
    skills: {},
    uses: {},
    rerollsUsed: 0,
    // 1試合目は全員無傷（ランの最初なので投げた球が1つも無い）
    fatigue: {},
    faced: [opts.teamId, opts.opponent],
    current: { seed: gameSeed(opts.seed, 1), opponent: opts.opponent, park: opts.park },
  };
}

/**
 * この試合の結果を反映したらランがどうなるか。**状態を書き換える前に問う**
 * （`withGameResult` を通した後は「負けた」という事実が勝ち数の差としてしか残らない）。
 */
export function runOutcomeAfter(run: RunState, won: boolean): RunOutcome {
  if (!won) return 'over';
  return run.game >= RUN_GAMES ? 'clear' : 'continue';
}

/** 試合の勝敗をランに記録する（負けたときは何も増えない＝そこでランが終わる） */
export function withGameResult(run: RunState, won: boolean): RunState {
  return won ? { ...run, wins: run.wins + 1 } : run;
}

/**
 * 次の試合へ進む。相手・球場・シードは選んだ扉のもので、同じ相手と2度当たらないよう
 * `faced` に積む。
 *
 * 持ち越すものは4つ（どれも「ラン全体で1つの資源」という同じ考え方）：**スキル**
 * （F-26-6）・**消費型のチャージ**（F-26-8）・**リロールの回数券**（U-42）・
 * **投手の疲れ**（V-43）。`plan` は試合と試合の間に選び直せる（V-43）ので、
 * **渡されなければ前の試合のものを引き継ぐ**（＝選び直さなかったときは従来どおり）。
 */
export function withNextGame(
  run: RunState,
  door: RunDoor,
  skills: CarriedSkills,
  uses: CarriedUses = {},
  rerollsUsed: number = run.rerollsUsed,
  fatigue: CarriedFatigue = run.fatigue,
  plan: RosterPlan = run.plan,
): RunState {
  return {
    ...run,
    game: run.game + 1,
    plan,
    skills,
    uses,
    rerollsUsed,
    fatigue,
    faced: [...run.faced, door.opponent],
    current: { seed: door.seed, opponent: door.opponent, park: door.park },
  };
}

/**
 * 次の試合の候補（扉）。**相手は重複なく引き、まだ当たっていない球団から選ぶ**
 * （同じ相手が続くと「次はどこへ行くか」というランの進行感が消える）。
 *
 * 扉ごとにシードが違うので、**球場も系統も扉ごとに変わる**＝扉を選ぶことが
 * 「どんな試合をしに行くか」の選択になる（ハデスの部屋選択）。
 * 16球団あるので5試合のランで候補が尽きることはないが、尽きた場合は
 * `sampleWithoutReplacement` があるだけ返す（呼び出し側で止めないための保険）。
 */
export function runDoors(run: RunState): readonly RunDoor[] {
  const nextGame = run.game + 1;
  const candidates = TEAMS.map((t) => t.id).filter((id) => !run.faced.includes(id));
  const { picked } = sampleWithoutReplacement(
    createRngState(gameSeed(run.seed, nextGame) + OPPONENT_SEED_SALT),
    candidates,
    RUN_DOOR_COUNT,
  );
  return picked.map((opponent, i) => {
    const seed = gameSeed(run.seed, nextGame, i + 1);
    const park = nextIndex(createRngState(seed + PARK_SEED_SALT), BALLPARKS.length);
    return {
      seed,
      opponent,
      park: BALLPARKS[park.index].id,
      lineages: activeLineagesFor(createRngState(seed)),
    };
  });
}

/**
 * 相手（CPU）がその試合に持ってくるスキル（2026-07-29 ユーザー判断「相手も同じだけ蓄積」）。
 *
 * **「ここまでの試合数ぶん」を、その場でCPU規則どおりに引き直す**：`(game-1) × 9` 回の
 * 抽選を回し、そのつど `cpuChooseSkill`（最もレアなものを打線の上位から）で1つ付ける。
 * 過去の試合の履歴を持ち回らないので、**相手が何を持ってくるかはシードと試合数だけの
 * 関数**になる（＝テストでも実機でも同じ相手が再現できる）。
 *
 * 系統はその試合の絞り込み（`activeLineagesFor`）をそのまま使う。相手の顔ぶれが
 * **その試合の系統に染まる**ので、扉で `メカ` を選べば「メカで固めた相手」が出てくる
 * ＝扉の選択が相手の性格にも効く。
 *
 * 引く系列は塩を混ぜた別系列（`PRELOAD_SEED_SALT`）で、**本編の乱数は消費しない**。
 *
 * **リロールもここで消費する**（フェーズU-42）：回数券はラン全体で使い切りなので、
 * 過去の試合ぶんを引き直しに使っていれば、その試合に持ってくる残りはそのぶん少ない
 * ＝**人間とまったく同じ資源のもとで蓄積している**（⑧の「CPUも対等」）。
 * 使った回数も返すのは、続きの試合（＝いま始まる試合）を残りから始めるため。
 */
export function preloadedSkills(opts: {
  team: TeamId;
  seed: number;
  /** 何試合目か（1なら空＝初戦の相手は素のまま） */
  game: number;
}): { skills: CarriedSkills; rerollsUsed: number } {
  const drafts = Math.max(0, opts.game - 1) * DRAFTS_PER_GAME;
  if (drafts === 0) return { skills: {}, rerollsUsed: 0 };
  const lineages = activeLineagesFor(createRngState(opts.seed));
  let roster = createTeamRoster(teamById(opts.team));
  let state: RngState = createRngState(opts.seed + PRELOAD_SEED_SALT);
  let rerollsUsed = 0;
  for (let i = 0; i < drafts; i += 1) {
    const holders = skillHoldersOf(roster);
    let drawn = drawSkillDraft(state, holders, lineages);
    state = drawn.state;
    // 候補が作れない（全員の枠が埋まった）ら、以降も作れないので打ち切る
    if (drawn.draft.options.length === 0) break;
    // CPUは温存しない（F-26-8と同じ）＝規則が言うたびに切り、尽きたら黙る
    while (rerollsLeft(rerollsUsed) > 0 && shouldCpuReroll(drawn.draft)) {
      const again = drawSkillDraft(state, holders, lineages);
      state = again.state;
      if (again.draft.options.length === 0) break;
      drawn = again;
      rerollsUsed += 1;
    }
    const picked = cpuChooseSkill(drawn.draft, holders);
    if (!picked) break;
    roster = grantSkill(roster, picked.holderId, picked.skillId).roster;
  }
  return { skills: roster.skills, rerollsUsed };
}

/** ランが持ち越すもの（スキル・使った回数・疲れ）。次の試合のロスターを組むのに要る一式 */
export interface CarriedState {
  skills: CarriedSkills;
  uses: CarriedUses;
  fatigue: CarriedFatigue;
}

/**
 * 次の試合を始める時点での、人間側のロスター（フェーズV-43／DD-51／EE-52）。
 *
 * 試合と試合の間の采配（`runRosterPlanSelect`）が「今日は誰に投げさせるか」「どの並びで
 * 打つか」を出すために使う。**次の試合と同じ手順で組む**（スキル→疲れの順は
 * `reduceMatchSetup` とまったく同じ）ので、**画面に出る数字と実際に試合が始まったときの
 * 中身が食い違わない**（C-15が選択画面の表示を `createTeamRoster` から起こしたのと同じ整理）。
 *
 * **返すのはロスターそのもの**（フェーズEE-52。DD-51では投手陣6人ぶんの残量と能力値だけを
 * 返していた）＝画面は投手だけでなく**打線9人も並べる**ので、投手ぶんだけを別の入口から
 * 渡すと**打者の側だけ名鑑を直読みする経路が残る**（実際そうなっていた＝スキルで打率が
 * 動いた打者も名鑑の値のまま出ていた。DD-51が投手側で塞いだのとまったく同じ食い違い）。
 * 1つのロスターから両方を読めば、その経路そのものが無い。
 *
 * 誰を先発にするか（`plan`）は渡されたものをそのまま使う：スキルも疲れも**選手に付く値**
 * なので采配では変わらないが、打順の表示は `plan` の並びで出す必要がある。
 */
export function nextGameRoster(opts: {
  teamId: TeamId;
  carried?: CarriedState;
  plan?: RosterPlan;
}): TeamRoster {
  const base = createTeamRoster(teamById(opts.teamId), opts.plan);
  // 持ち越しが無ければ名鑑どおり・全員無傷（試合前のチーム選択＝C-15はこちらを通る）
  if (!opts.carried) return base;
  const { skills, uses, fatigue } = opts.carried;
  return withCarriedFatigue(withCarriedSkills(base, skills, uses), fatigue);
}

/** 持っているスキルの総数（相手がどれだけ蓄積しているかの表示に使う） */
export function skillCount(skills: CarriedSkills): number {
  return Object.values(skills).reduce((sum, ids) => sum + ids.length, 0);
}

/**
 * 表示に要るぶんだけのラン進行（HUDのスコアボードの1行）。**`RunState` そのものを
 * HUDへ渡さない**のは、HUDが試合の外側の状態（シード・持ち越し・扉）を知る必要が
 * まったく無いため（humanSide だけを渡している既存の作りと同じ粒度）。
 */
export interface RunProgress {
  game: number;
  wins: number;
  total: number;
}

export function runProgress(run: RunState): RunProgress {
  return { game: run.game, wins: run.wins, total: RUN_GAMES };
}
