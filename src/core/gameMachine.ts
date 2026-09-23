/**
 * XState: 試合全体（イニング/アウト/カウント/得点/銃残弾）のステートマシン。
 * 数値計算・判定はすべて rules.ts の純粋関数に委譲し、ここでは
 * 「イベント → コンテキスト更新 → 決着チェック」の流れだけを持つ。
 */
import { assign, setup } from 'xstate';
import {
  type BaseRunners,
  type Bases,
  type Count,
  type Half,
  type LineScore,
  type PitchJudgement,
  type RunnerId,
  type Score,
  type TeamSide,
  EMPTY_BASES,
  EMPTY_BASE_RUNNERS,
  EMPTY_COUNT,
  EMPTY_LINE_SCORE,
  applyPitch,
  battingTeam,
  evaluateProgress,
  fieldingTeam,
  forceAdvanceRunners,
  occupancy,
  opponent,
  recordInningRuns,
  runnersFromBases,
} from './rules';
import {
  type RosterPlan,
  type TeamRoster,
  activateEffect,
  advanceBatter,
  canShootGun,
  clearActiveEffects,
  createTeamRoster,
  currentBatterId,
  ejectBatterAndSubstitute,
  ejectPitcherAndSubstitute,
  grantSkill,
  recordGunShot,
  recordPitch,
  setLineupIndex,
  skillHoldersOf,
  substituteBatterAt,
  substitutePitcherAt,
  substituteRunnerAt,
  useVerb,
  withCarriedFatigue,
  withCarriedSkills,
  withHotBatters,
} from './roster';
import { type RngState, DEFAULT_SEED, createRngState } from './rng';
import {
  type EffectRole,
  type SkillDraft,
  type SkillId,
  type SkillLineage,
  activeLineagesFor,
  drawSkillDraft,
  rerollsLeft,
} from './skills';
import {
  type TeamId,
  DEFAULT_AWAY_TEAM_ID,
  DEFAULT_HOME_TEAM_ID,
  teamById,
} from './teams';

export interface GameContext {
  inning: number;
  half: Half;
  outs: number;
  count: Count;
  /**
   * 塁の占有状況（真偽値）。**baseRunners から導出される派生ビュー**で、直接書き換えては
   * ならない（必ず withBaseRunners を通す）。「埋まっているか」だけを見る既存のロジック
   * （けん制の可否・CPUの判断・HUDのランナー表示）はこちらを読み続ける。
   */
  bases: Bases;
  /**
   * それぞれの塁にいる走者そのもの（フェーズB-8）。走力（RUN）を全走者に効かせるには
   * 「一塁にいるのは誰か」を打席をまたいで覚えている必要があるため、ここが真実になる。
   */
  baseRunners: BaseRunners;
  score: Score;
  /**
   * イニングごとの得点（スコアボード表示用）。score（合計）とは別に保持し、
   * 打席の決着のたびに現在のイニングへ加算する（詳細は rules.ts recordInningRuns）。
   */
  lineScore: LineScore;
  /**
   * 選手ロスター（打順・控え・投手・ブルペン・永久退場者）。
   * 乱闘敗北時の自動代打/継投、および控え/ブルペンが尽きた場合の
   * 没収試合（FORFEIT）判定はここの状態を突き合わせて行う
   * （旧 `ejections` カウンタをセッション7で本ロスターに置き換えた）。
   */
  rosters: { away: TeamRoster; home: TeamRoster };
  /**
   * ローグライトのスキル抽選の乱数状態（フェーズF-26-1。CLAUDE.md ⑧）。
   * **このゲームで乱数を引くのは抽選だけ**で、打撃・投球・守備・乱闘の判定は従来どおり
   * 完全に決定的なまま。ここに状態を持つことで**シードを固定すれば試合まるごと再現できる**
   * （`Math.random` を直に呼ぶと再現も「いつ何回引いたか」の追跡もできない）。
   */
  rngState: RngState;
  /**
   * この試合で候補に出る系統（フェーズF-26-5。CLAUDE.md ⑧「試合ごとに系統を絞る」）。
   * ハデスの「そのランに出る神」に相当し、**両チーム共通**＝どちらが有利かが引きの前に
   * 決まらない。シードから決まる（`activeLineagesFor`）ので、シードを固定すれば
   * 系統の顔ぶれごと再現できる。
   *
   * **本編の乱数（`rngState`）は消費しない**：系統は試合開始時に一度決まるだけの値なので、
   * 抽選の系列に割り込ませると「何回目の抽選か」と乱数の位置がずれる。
   */
  lineages: readonly SkillLineage[];
  /**
   * 提示中の3択（まだ選ばれていない抽選）。**選択の途中を状態として持つ**ので、
   * 「候補を引いたのに選ばれないまま消えた」「同じ回に二重に引いた」が起きない。
   * side は引いた側＝これから攻撃するチーム。
   */
  pendingDraft: { side: TeamSide; draft: SkillDraft } | null;
  /**
   * リロール（抽選のやり直し。フェーズU-42）を**ここまでに使った回数**。
   * 残りは `rerollsLeft` の導出＝「もう引き直せないのに残り回数だけ出ている」が起きない
   * （B-11の投球数→残りスタミナ、F-26-8のチャージと同じ整理）。
   *
   * **回数券はラン全体で使い切り**（ユーザー判断）なので、`MATCH_SETUP` で前の試合までの
   * 使用回数を受け取り、試合が終われば main.ts がランへ書き戻す＝**`gameMachine` は
   * ランを知らないまま**（CLAUDE.md ⑧「ランは試合の外側にある」）。総数だけが
   * `skills.ts` の `REROLLS_PER_RUN` にある（消費型の総数が `SkillDef.charges` に
   * あるのと同じ形）。
   */
  rerollsUsed: Record<TeamSide, number>;
  winner: TeamSide | null;
}

export type GameEvent =
  /**
   * 1球リリースした（フェーズB-11）。判定の前に、投げた瞬間に送る＝**1リリース1球**。
   * 守備側の現在の投手の投球数だけが増え、そこからスタミナの残量・疲労が導出される。
   * 判定（PITCH_RESULT）と分けているのは、打たれた球は判定を経ずに打球のプレーへ
   * 移るため：決着のイベントで数えると、打たれた球だけ投球数に入らない。
   */
  | { type: 'PITCH_THROWN' }
  | { type: 'PITCH_RESULT'; judgement: PitchJudgement }
  /**
   * **デバッグモード専用**（フェーズPP-64。`src/debug/practice.ts`）＝**カウントを 0-0 に
   * 戻すだけ**。アウト・得点・打順・イニング・塁・投球数のどれにも触らないので、
   * **三振・四球になる球をこれに差し替えると打席が終わらない**（＝同じ場面を永遠に
   * 繰り返して投球や打撃を確認できる）。
   *
   * **試合のルールではない**ので `withProgress` を通さない（通す必要が無い＝カウントは
   * 決着に関わらない唯一の状態）。本番の経路からは一度も送られない（送るのは
   * デバッグモードの main.ts だけ）＝この1イベントが「判定には触らない」という
   * デバッグモードの柱そのもので、これ以外に `core` へ足したものは無い。
   */
  | { type: 'DEBUG_RESET_COUNT' }
  /**
   * 敬遠（フェーズQ-38）。**投げずに打者を一塁へ歩かせる**（実際の野球の申告敬遠）。
   * `side` は宣言した側＝守備側で、攻撃側から飛んできても何も起きない
   * （`reduceIntentionalWalk`）。投球そのものが無いので `PITCH_THROWN` は伴わない
   * ＝投球数もスタミナも動かない。
   */
  | { type: 'INTENTIONAL_WALK'; side: TeamSide }
  | { type: 'HIT_BY_PITCH' }
  /**
   * 銃を1発撃った（フェーズF-26-2）。守備側の**現在の投手**の発射数だけが増え、
   * 残弾はそこから導出される（`gunRemainingOf`）。`PITCH_THROWN` と同じく side を
   * 持たないのは、撃つのは常に守備側＝状態から一意に決まるため。
   * `ジュウ` を持たない投手のときは何も起きない（`canUseGun` ガード）。
   */
  | { type: 'GUN_USED' }
  /**
   * 打球のプレーの決着。bases は塁の占有状況で、baseRunners は「どの塁に誰がいるか」。
   * **baseRunners は任意**で、渡されなければ bases から無名の走者として合成する
   * （能力値を持たないテストからそのまま送れるようにするため。実プレイでは
   * ちっちゃいモードが実在の走者を返すので必ず渡される）。
   */
  | {
      type: 'PLAY_RESOLVED';
      outsAdded: number;
      runs: number;
      bases: Bases;
      baseRunners?: BaseRunners;
    }
  /**
   * 打席を終わらせない走塁だけのプレー（けん制球。説明書p24／盗塁。説明書p13）。
   * アウト・得点・塁状況は PLAY_RESOLVED と同じように反映するが、**カウントと打順には
   * 一切触れない**（打者は同じカウントで打席に立ち続ける）。3アウトになった場合の
   * 攻守交代は withProgress が共通で扱い、そこでカウントがリセットされる。
   */
  | {
      type: 'RUNNER_PLAY_RESOLVED';
      outsAdded: number;
      runs: number;
      bases: Bases;
      baseRunners?: BaseRunners;
    }
  | {
      type: 'BRAWL_RESOLVED';
      loser: 'batter' | 'pitcher';
      /**
       * 死球送信直前（＝乱闘が起こらなければ確定していたはずの状態）のスナップショット。
       * battingLineupIndex は打者側チームの打順インデックス（HIT_BY_PITCHで
       * 楽観的に1つ進めていたものを、乱闘決着で「同じ打席が継続」する場合に戻すため）。
       */
      restore: {
        count: Count;
        bases: Bases;
        /** 走者の識別（任意。PLAY_RESOLVED と同じ理由で、無ければ bases から合成する） */
        baseRunners?: BaseRunners;
        battingLineupIndex: number;
      };
    }
  | { type: 'FORFEIT'; loser: TeamSide }
  /**
   * 采配としての任意代打（セッション9）。乱闘による強制退場（BRAWL_RESOLVED）とは独立した
   * 経路で、カウント・走者状況には一切触れない（現在の打席をそのまま継続するだけ）。
   * side は呼び出し側（main.ts）が「人間が打者側のときだけ」開けるメニューから
   * 送るため常に人間側チームだが、テスト容易性のため明示的に受け取る。
   */
  | { type: 'SUBSTITUTE_BATTER'; side: TeamSide; benchIndex: number }
  /** 采配としての任意継投（セッション9）。BRAWL_RESOLVED とは独立し、カウント等は不変。 */
  | { type: 'SUBSTITUTE_PITCHER'; side: TeamSide; bullpenIndex: number }
  /**
   * 采配としての任意代走（フェーズGG-54）。代打・継投と同じく、カウント・アウトには
   * 一切触れない（現在の打席をそのまま継続する）。
   *
   * **代打・継投と1つだけ違うのは、ロスターだけでなく `baseRunners` も書き換える**点：
   * 走者の識別は `baseRunners` が持っている（B-8）ので、ロスターだけ入れ替えると
   * **塁の上には退いたはずの選手が立ったまま**になる。`base` はどの塁の走者を代えるかで、
   * その塁が空いていれば何も起きない。
   */
  | {
      type: 'SUBSTITUTE_RUNNER';
      side: TeamSide;
      base: 'first' | 'second' | 'third';
      benchIndex: number;
    }
  /**
   * 試合前のチーム選択の反映（フェーズB-12/C-13）。先攻・後攻の球団を名鑑から起こして
   * ロスターを丸ごと差し替える。**まだ1球も投げていないときだけ効く**（reduceMatchSetup
   * のコメント参照）＝試合が始まってから飛んできても、進行中の打席や記録を壊さない。
   *
   * `plans` は試合前の采配＝先発投手と打順（フェーズC-15）。**指定が無い側は名鑑どおり**に
   * 組む（v1で試合前の采配を決められるのは人間が操作する側だけ＝CPUの采配はスコープ外という
   * 既存方針。両側を持てる形にしてあるのは、2P PLAY（フェーズD-20）で両者が決めるため）。
   */
  | {
      type: 'MATCH_SETUP';
      away: TeamId;
      home: TeamId;
      plans?: Partial<Record<TeamSide, RosterPlan>>;
      /**
       * スキル抽選のシード（フェーズF-26-1）。省略すると `DEFAULT_SEED` のまま＝
       * **毎回まったく同じ抽選の試合になる**（テストと自動検証はこれを使う）。
       * 実プレイでは main.ts が時刻から渡すので試合ごとに変わる。
       */
      seed?: number;
      /**
       * 試合開始時点で選手が持っているスキル（フェーズF-26-6のラン化）。
       * **人間側は前の試合からの持ち越し、CPU側はここまでの試合数ぶんの蓄積**
       * （`core/run.ts` の `preloadedSkills`）が入る。
       *
       * 指定が無い側は素のまま＝**ラン化を通さない呼び出し（1試合だけのテスト・
       * 自動検証）はF-26-6の前とまったく同じロスターになる**（B-9で `BatterSide` の
       * 既定を右打者にしたのと同じ整理）。載せ方は `withCarriedSkills` が
       * `grantSkill` 経由で行うので、枠上限・対象・デュオの前提は持ち越しでも守られる。
       */
      skills?: Partial<Record<TeamSide, Record<string, readonly SkillId[]>>>;
      /**
       * 消費型スキルをここまでに使った回数（フェーズF-26-8）。**`skills` と対で持ち越す**
       * ＝チャージはラン全体で使い切りなので、前の試合で撃った1発は次の試合でも戻らない。
       * 指定が無ければ全部未使用＝1試合だけの呼び出しはF-26-8の前と同じ挙動になる。
       */
      uses?: Partial<Record<TeamSide, Record<string, Partial<Record<SkillId, number>>>>>;
      /**
       * リロールをここまでに使った回数（フェーズU-42）。`skills`・`uses` と同じく
       * **ラン全体で使い切り**なので前の試合から持ち越す。指定が無ければ未使用＝
       * 1試合だけの呼び出し（テスト・2P PLAY）は満タンから始まる。
       */
      rerolls?: Partial<Record<TeamSide, number>>;
      /**
       * 前の試合から持ち越した投球数（フェーズV-43の疲労の持ち越し）。**残量でも疲労でもなく
       * 投球数**を渡すのは、B-11の「真実は投球数の側」を試合の外へ延長したため＝載せた
       * 時点から残量ゲージ・球威・自動継投がそのまま従来の導出で動く。
       * 指定が無い側は全員無傷＝**ラン化を通さない呼び出し（テスト・2P PLAY）は
       * V-43の前とまったく同じ**（`skills`・`uses`・`rerolls` と同じ既定の考え方）。
       */
      fatigue?: Partial<Record<TeamSide, Record<string, number>>>;
    }
  /**
   * スキルの3択を引く（フェーズF-26-1）。**その回の攻撃が始まる前に、攻撃側が1回**
   * （1回表・1回裏も含むので両チーム9回ずつで完全に対称）。
   * すでに提示中の抽選があれば何もしない＝二重に引かない。
   */
  | { type: 'SKILL_DRAFT_DRAWN' }
  /**
   * 提示中の3択を**まるごと引き直す**（フェーズU-42）。回数券が残っているときだけ効く。
   * `side` は引いた側＝提示中の側で、そうでなければ何も起きない
   * （`SKILL_GRANTED` が提示中の側しか受け付けないのと同じ防御）。
   */
  | { type: 'SKILL_DRAFT_REROLLED'; side: TeamSide }
  /**
   * 3択から選んで選手に付ける。提示中の候補に無いスキル・付けられない選手なら
   * 何も起きない（`grantSkill` が roster を変更せず ok:false を返す）が、
   * **提示は必ず畳む**＝選び損ねた抽選が残り続けて次の回の抽選を塞ぐことがない。
   */
  | { type: 'SKILL_GRANTED'; side: TeamSide; playerId: string; skillId: SkillId }
  /**
   * 消費型スキルの動詞を使った（フェーズF-26-8）。**バイクの点火・ドロップキックの発動を
   * 実際に行った瞬間**にシーン層から届く（当たっても外れても消費するのは既存の
   * 「1プレーに1回」と同じ規則）。常設の札を持っている選手なら `useVerb` が何もしないので、
   * シーン層は「常設か消費型か」を知らずに同じ経路で報告できる。
   *
   * 銃だけはこの経路を通らない：発射は既に `GUN_USED` が `recordGunShot` を通しており、
   * そちらが常設の弾とチャージの順序を1か所で解決している。
   */
  | { type: 'VERB_USED'; side: TeamSide; playerId: string; verb: SkillId }
  /**
   * 一時効果を切った（フェーズM-33）。**どの札が切れるかは受け取る側が決める**
   * （`activateEffect` が役割から宣言順で選ぶ）ので、イベントが運ぶのは「誰が、どちらの
   * 役割で切ったか」だけ＝押した側は札の名前を知らなくてよい。
   *
   * 切れない指定（持っていない・使い切った・すでに切ってある）なら何も起きない。
   */
  | { type: 'EFFECT_ACTIVATED'; side: TeamSide; playerId: string; role: EffectRole };

const INITIAL_CONTEXT: GameContext = {
  inning: 1,
  half: 'top',
  outs: 0,
  count: EMPTY_COUNT,
  bases: EMPTY_BASES,
  baseRunners: EMPTY_BASE_RUNNERS,
  score: { away: 0, home: 0 },
  lineScore: EMPTY_LINE_SCORE,
  // 起動直後（チーム選択の前）の既定カード。実際の対戦相手は MATCH_SETUP で差し替わる。
  rosters: {
    away: withHotBatters(createTeamRoster(teamById(DEFAULT_AWAY_TEAM_ID)), DEFAULT_SEED, 'away'),
    home: withHotBatters(createTeamRoster(teamById(DEFAULT_HOME_TEAM_ID)), DEFAULT_SEED, 'home'),
  },
  rngState: createRngState(DEFAULT_SEED),
  lineages: activeLineagesFor(createRngState(DEFAULT_SEED)),
  pendingDraft: null,
  rerollsUsed: { away: 0, home: 0 },
  winner: null,
};

/**
 * 塁の状態を更新する唯一の入口。走者の識別（baseRunners）を真実として受け取り、
 * 占有状況（bases）は必ずそこから導出する＝**2つが食い違うことが構造的に起きない**。
 */
function withBaseRunners(ctx: GameContext, runners: BaseRunners): GameContext {
  return { ...ctx, baseRunners: runners, bases: occupancy(runners) };
}

/** 今この瞬間に打席に立っている選手＝打者走者になる選手 */
function battingRunnerId(ctx: GameContext): RunnerId {
  return currentBatterId(ctx.rosters[battingTeam(ctx.half)]);
}

/**
 * イベントが走者の識別を持っていればそれを、持っていなければ占有状況から無名の走者を
 * 合成して返す（能力値を持たないテストからそのままイベントを送れるようにするため）。
 */
function eventRunners(bases: Bases, baseRunners?: BaseRunners): BaseRunners {
  return baseRunners ?? runnersFromBases(bases);
}

/** 得点・アウト更新後に攻守交代／決着を反映させる */
function withProgress(ctx: GameContext): GameContext {
  const progress = evaluateProgress(ctx.inning, ctx.half, ctx.outs, ctx.score);
  switch (progress.kind) {
    case 'continue':
      return ctx;
    case 'nextHalf':
      return withBaseRunners(
        {
          ...ctx,
          inning: progress.inning,
          half: progress.half,
          outs: 0,
          count: EMPTY_COUNT,
        },
        EMPTY_BASE_RUNNERS,
      );
    case 'gameOver':
      return { ...ctx, winner: progress.winner };
  }
}

function addRuns(score: Score, side: TeamSide, runs: number): Score {
  if (runs === 0) return score;
  return { ...score, [side]: score[side] + runs };
}

/**
 * 打席の決着（三振・四死球・打球の決着）のたびに呼ぶ。runs=0 でも必ず呼び、
 * 現在のイニング（ctx.inning/ctx.half）のマスをスコアボード上で確定させる
 * （recordInningRuns のコメント参照。「未到達」と「無得点で決着」を区別するため）。
 */
function withLineScore(ctx: GameContext, runs: number): GameContext {
  return {
    ...ctx,
    lineScore: recordInningRuns(ctx.lineScore, battingTeam(ctx.half), ctx.inning, runs),
  };
}

/**
 * 打席終了（三振・四死球・打球の決着）のたびに、打者側チームの打順を1つ進める。
 *
 * **一時効果（M-33）が消えるのもここ。** 「1打席だけ」という寿命の定義と、実際に効果が
 * 切れる場所が**同じ1つの出来事**になっているので、「打席が終わったのに効果が残る」が
 * 構造的に起きない。**両チームぶん落とす**のは、守備側の札（`ケモノガエリ`）も
 * 打席の単位で切ってあるため＝打っている側だけを畳むと、守備の効果だけが次の打席へ漏れる。
 *
 * 逆に、**ここを通らない決着では効果は残る**（けん制・盗塁の決着＝`reduceRunnerPlayResolved`、
 * 走塁プレーでの3アウトによる攻守交代）。これは正しい：打順が進まない＝**同じ打席が
 * 続いている**（イニングをまたいでも同じ打者から始まる）という既存の規則に、
 * 一時効果の寿命がそのまま乗っている。
 */
function advanceLineup(ctx: GameContext): GameContext {
  const side = battingTeam(ctx.half);
  return {
    ...ctx,
    rosters: {
      away: clearActiveEffects(side === 'away' ? advanceBatter(ctx.rosters.away) : ctx.rosters.away),
      home: clearActiveEffects(side === 'home' ? advanceBatter(ctx.rosters.home) : ctx.rosters.home),
    },
  };
}

/**
 * 1球リリースした（フェーズB-11）。投げたのは守備側チームの現在の投手なので、
 * 「誰の球数か」は状態から一意に決まる（投手交代は投球動作中には起きない）。
 */
function reducePitchThrown(ctx: GameContext): GameContext {
  const side = fieldingTeam(ctx.half);
  return { ...ctx, rosters: { ...ctx.rosters, [side]: recordPitch(ctx.rosters[side]) } };
}

/**
 * 四球（打者は一塁へ）。**フォースされた走者だけが1つ進み、満塁なら押し出しで1点**。
 *
 * ボール4つで歩かせた場合（`reducePitchResult`）と、投げずに歩かせた場合
 * （敬遠＝`reduceIntentionalWalk`。フェーズQ-38）の**両方がこの1本を通る**ので、
 * 「敬遠だけ押し出しの点が入らない」「敬遠だけ打順が進まない」が構造的に起きない
 * （死球と四球が `forceAdvanceRunners` を共有しているのと同じ整理）。
 */
function applyWalk(ctx: GameContext): GameContext {
  const { runners, runs } = forceAdvanceRunners(ctx.baseRunners, battingRunnerId(ctx));
  return advanceLineup(
    withLineScore(
      withBaseRunners(
        {
          ...ctx,
          count: EMPTY_COUNT,
          score: addRuns(ctx.score, battingTeam(ctx.half), runs),
        },
        runners,
      ),
      runs,
    ),
  );
}

/**
 * 敬遠（フェーズQ-38。説明書に項目は無いが、実際の野球の申告敬遠＝p32「実際の野球の
 * ルールにできるだけ合わせてある」）。**宣言した瞬間に打者は一塁へ**。
 *
 * - **投げないので投球数は増えない**（`PITCH_THROWN` を通らない＝B-11のスタミナは減らない。
 *   けん制球・銃を投球数に数えないのと同じ扱いで、実際の申告敬遠とも一致する）。
 * - **カウントの途中でも宣言できる**（残りのボール数を数えない）＝`applyWalk` が
 *   カウントを畳むので、追い込んでから外す判断が成立する。
 * - **宣言できるのは守備側だけ**。攻撃側から飛んできたら何も起きない（自分で自分を
 *   歩かせられない）＝`side` を受け取るのはこの1点のためで、`SUBSTITUTE_*` と同じ形。
 */
function reduceIntentionalWalk(ctx: GameContext, side: TeamSide): GameContext {
  if (side !== fieldingTeam(ctx.half)) return ctx;
  return applyWalk(ctx);
}

function reducePitchResult(ctx: GameContext, judgement: PitchJudgement): GameContext {
  const outcome = applyPitch(ctx.count, judgement);
  switch (outcome.kind) {
    case 'inProgress':
      return { ...ctx, count: outcome.count };
    case 'walk':
      return applyWalk(ctx);
    case 'strikeout':
      return advanceLineup(
        withLineScore({ ...ctx, outs: ctx.outs + 1, count: EMPTY_COUNT }, 0),
      );
  }
}

/**
 * 死球（通常・銃とも）。打者は一塁へ。退場は発生しない。
 * 打順もここで進める（=楽観的に「打席終了」を確定する）。乱闘が起きて決着した場合は
 * reduceBrawlResolved が restore.battingLineupIndex でこの進行を巻き戻す
 * （「同じ打席が継続する」という仕様のため）。BRAWL_DECLINED の場合は
 * この巻き戻しが走らないので、死球はそのまま確定＝打順の進行もそのまま残る。
 */
function reduceHitByPitch(ctx: GameContext): GameContext {
  const { runners, runs } = forceAdvanceRunners(ctx.baseRunners, battingRunnerId(ctx));
  return advanceLineup(
    withLineScore(
      withBaseRunners(
        {
          ...ctx,
          count: EMPTY_COUNT,
          score: addRuns(ctx.score, battingTeam(ctx.half), runs),
        },
        runners,
      ),
      runs,
    ),
  );
}

function reducePlayResolved(
  ctx: GameContext,
  outsAdded: number,
  runs: number,
  runners: BaseRunners,
): GameContext {
  return advanceLineup(
    withLineScore(
      withBaseRunners(
        {
          ...ctx,
          outs: ctx.outs + outsAdded,
          count: EMPTY_COUNT,
          score: addRuns(ctx.score, battingTeam(ctx.half), runs),
        },
        runners,
      ),
      runs,
    ),
  );
}

/**
 * 走塁だけのプレー（けん制球。説明書p24）の決着。
 *
 * reducePlayResolved との違いは「打席が終わらない」こと一点で、**カウントのリセットも
 * 打順の進行も行わない**（advanceLineup を呼ばない）。得点はスコアボードに記録する
 * 必要があるので withLineScore は共通で通す。3アウトになった場合は呼び出し側の
 * withProgress が攻守交代させ、そこでカウント・塁がリセットされる（打順は進まないので、
 * 打席の途中でイニングが終われば次のイニングは同じ打者から始まる＝実際の野球と同じ）。
 */
function reduceRunnerPlayResolved(
  ctx: GameContext,
  outsAdded: number,
  runs: number,
  runners: BaseRunners,
): GameContext {
  return withLineScore(
    withBaseRunners(
      {
        ...ctx,
        outs: ctx.outs + outsAdded,
        score: addRuns(ctx.score, battingTeam(ctx.half), runs),
      },
      runners,
    ),
    runs,
  );
}

/**
 * 乱闘決着。CLAUDE.md「打者敗北時：代打が同じカウント・同じ走者状況を引き継いで
 * 打席を継続（アウトにはならない）」「投手敗北時：援護投手が同じカウント・同じ
 * 打者で継投」の両方とも、要は「死球そのものが無かったことになり、同じ打席が
 * 継続する。ただし負けた側の要員だけ入れ替わる」という一点で共通している
 * （PROGRESS.md 未確定事項に記録していた「乱闘敗北時の死球処理の整合」の結論）。
 * そのため、死球で即座に適用済みの進塁・カウント・打順の進行（reduceHitByPitch）を
 * ここで巻き戻す。乱闘を選ばなかった場合（BRAWL_DECLINED）は死球がそのまま
 * 確定するので、この巻き戻しは一切走らない。
 *
 * セッション7で本実装：巻き戻しに加えて、負けた側の現在の打者/投手をロスターから
 * 永久退場させ、控え/ブルペンから自動的に代打/救援投手を送る。控え・ブルペンが
 * どちらも尽きていた場合は「出場可能な打者・投手が尽きた」として、その場で
 * 没収試合（相手チームの勝ち）を確定する（CLAUDE.md④の没収試合ルール）。
 */
function reduceBrawlResolved(
  ctx: GameContext,
  loser: 'batter' | 'pitcher',
  restore: {
    count: Count;
    bases: Bases;
    baseRunners?: BaseRunners;
    battingLineupIndex: number;
  },
): GameContext {
  const battingSide = battingTeam(ctx.half);
  const loserSide = loser === 'batter' ? battingSide : fieldingTeam(ctx.half);

  // 打順の巻き戻しは勝敗どちらのケースでも共通（「同じ打席が継続」するため）。
  const restoredBattingRoster = setLineupIndex(
    ctx.rosters[battingSide],
    restore.battingLineupIndex,
  );
  const rostersAfterRestore = { ...ctx.rosters, [battingSide]: restoredBattingRoster };

  const loserRoster = rostersAfterRestore[loserSide];
  const sub =
    loser === 'batter'
      ? ejectBatterAndSubstitute(loserRoster)
      : ejectPitcherAndSubstitute(loserRoster);

  const nextCtx: GameContext = withBaseRunners(
    {
      ...ctx,
      count: restore.count,
      rosters: { ...rostersAfterRestore, [loserSide]: sub.roster },
    },
    eventRunners(restore.bases, restore.baseRunners),
  );

  if (!sub.ok) {
    // 出場可能な代打/救援投手が尽きた＝没収試合（相手チームの勝ち）
    return { ...nextCtx, winner: opponent(loserSide) };
  }
  return nextCtx;
}

/**
 * 采配としての任意代打（セッション9）。乱闘決着（reduceBrawlResolved）と違い、
 * カウント・走者状況・打順インデックスのいずれにも触れない（今の打席の「中身」だけが
 * 入れ替わる）。控えが尽きている等で交代が成立しなくても（ok:false）没収試合には
 * しない（任意采配は「できなければ何もしない」だけで、乱闘の強制退場のような
 * 「負けた事実」を伴わないため）。呼び出し側（main.ts の采配メニュー）が候補の
 * 無い交代を送らせない設計だが、念のためここでも同じ防御をもう一段掛けている。
 */
function reduceSubstituteBatter(ctx: GameContext, side: TeamSide, benchIndex: number): GameContext {
  const result = substituteBatterAt(ctx.rosters[side], benchIndex);
  if (!result.ok) return ctx;
  return { ...ctx, rosters: { ...ctx.rosters, [side]: result.roster } };
}

/**
 * 代走（フェーズGG-54）。**ロスターと塁の上を必ず同時に書き換える**のがこの関数の役目で、
 * どちらか片方だけが動くと「退いたはずの選手が塁に立っている」「塁に誰もいないのに
 * 打順だけ入れ替わった」という食い違いが生まれる。
 *
 * 塁の更新は `withBaseRunners` を通す（＝占有状況 `bases` は必ずそこから導出される）。
 * **代走は塁を動かさない**ので `bases` の中身自体は変わらず、変わるのは識別だけ。
 *
 * 攻撃側でなくても弾かない（`side` は呼び出し側が決める）＝代打・継投と同じ扱いだが、
 * **守備側のロスターには走者がいない**ので、その `baseRunners` を書き換えないよう
 * 「いま攻撃している側かどうか」で塁を触るかを決める。
 */
function reduceSubstituteRunner(
  ctx: GameContext,
  side: TeamSide,
  base: 'first' | 'second' | 'third',
  benchIndex: number,
): GameContext {
  // 塁上の走者は攻撃側の選手なので、守備側から送られた代走は成立しない
  if (side !== battingTeam(ctx.half)) return ctx;
  const runnerId = ctx.baseRunners[base];
  if (runnerId === null) return ctx;
  const roster = ctx.rosters[side];
  const incoming = roster.bench[benchIndex];
  const result = substituteRunnerAt(roster, runnerId, benchIndex);
  if (!result.ok) return ctx;
  const next = { ...ctx, rosters: { ...ctx.rosters, [side]: result.roster } };
  return withBaseRunners(next, { ...ctx.baseRunners, [base]: incoming });
}

// ---- ローグライトのスキル抽選（フェーズF-26-1。CLAUDE.md ⑧） ----

/**
 * 3択を引く。**引く側はこれから攻撃するチーム**（`battingTeam`）＝状態から一意に決まるので、
 * イベントに side を持たせない（持たせると「誰の回に誰が引いたか」が呼び出し側の都合で
 * ずれうる。B-11で PITCH_THROWN に side を持たせなかったのと同じ整理）。
 *
 * すでに提示中なら何もしない＝**同じ回に二重に引かない**。試合が終わっていれば引かない
 * （もう使う場面が無いスキルを選ばせても、間が伸びるだけで判断にならない）。
 */
function reduceSkillDraftDrawn(ctx: GameContext): GameContext {
  if (ctx.pendingDraft !== null || ctx.winner !== null) return ctx;
  const side = battingTeam(ctx.half);
  const { draft, state } = drawSkillDraft(
    ctx.rngState,
    skillHoldersOf(ctx.rosters[side]),
    ctx.lineages,
  );
  // 候補が1つも作れなければ（全員の枠が埋まった等）抽選そのものを起こさない
  if (draft.options.length === 0) return { ...ctx, rngState: state };
  return { ...ctx, rngState: state, pendingDraft: { side, draft } };
}

/**
 * 残りのリロール回数（**使った数からの導出**。フェーズU-42）。総数は `skills.ts` にあり、
 * `gameMachine` はランを知らない（CLAUDE.md ⑧「ランは試合の外側にある」）。
 */
export function rerollsLeftOf(ctx: GameContext, side: TeamSide): number {
  return rerollsLeft(ctx.rerollsUsed[side]);
}

/**
 * 提示中の3択をまるごと引き直す（フェーズU-42）。
 *
 * **抽選そのものは `SKILL_DRAFT_DRAWN` と同じ経路**（`drawSkillDraft` を同じ引数で
 * もう一度呼ぶだけ）＝リロール専用の抽選規則を持たない。乱数の系列は素直に進むので、
 * **シードを固定すれば「何回目に引き直したか」まで含めて再現できる**。
 *
 * 回数券が尽きていれば何も起きない（提示もそのまま）＝押しても何も起きない操作を
 * UIが出さない（`rerollsLeftOf` を見てヒントを出す）という約束と対になっている。
 */
function reduceSkillDraftRerolled(ctx: GameContext, side: TeamSide): GameContext {
  const pending = ctx.pendingDraft;
  if (!pending || pending.side !== side) return ctx;
  if (rerollsLeftOf(ctx, side) <= 0) return ctx;
  const { draft, state } = drawSkillDraft(
    ctx.rngState,
    skillHoldersOf(ctx.rosters[side]),
    ctx.lineages,
  );
  // 候補が作れなくなった（＝引き直す前の3択より悪くなる）ときは回数券を払わせない。
  // 通常は同じ持ち主・同じ系統なので起きないが、払ったのに何も出ないのは理不尽になる。
  if (draft.options.length === 0) return ctx;
  return {
    ...ctx,
    rngState: state,
    pendingDraft: { side, draft },
    rerollsUsed: { ...ctx.rerollsUsed, [side]: ctx.rerollsUsed[side] + 1 },
  };
}

/**
 * 選ばれたスキルを付ける。**提示は成否によらず必ず畳む**（選び損ねた抽選が残ると、
 * 次の回の `SKILL_DRAFT_DRAWN` が「すでに提示中」で弾かれて抽選が止まる）。
 * 提示されていない候補は付けない＝UIの外から任意のスキルを流し込めない。
 */
function reduceSkillGranted(
  ctx: GameContext,
  side: TeamSide,
  playerId: string,
  skillId: SkillId,
): GameContext {
  const pending = ctx.pendingDraft;
  const cleared: GameContext = { ...ctx, pendingDraft: null };
  if (!pending || pending.side !== side || !pending.draft.options.includes(skillId)) {
    return cleared;
  }
  const result = grantSkill(ctx.rosters[side], playerId, skillId);
  if (!result.ok) return cleared;
  return { ...cleared, rosters: { ...ctx.rosters, [side]: result.roster } };
}

/**
 * 消費型の動詞を1回使ったことを記録する（フェーズF-26-8）。
 *
 * **常設の札を持っている選手なら何も起きない**（`useVerb`）ので、シーン層は
 * 「いま乗ったのは常設のバイクか `ニトロ` か」を判断しなくてよい。チャージが尽きていても
 * 同じく何も起きない＝二重に送られても残り回数が負にならない。
 */
function reduceVerbUsed(
  ctx: GameContext,
  side: TeamSide,
  playerId: string,
  verb: SkillId,
): GameContext {
  const roster = ctx.rosters[side];
  if (!roster.players[playerId]) return ctx;
  return { ...ctx, rosters: { ...ctx.rosters, [side]: useVerb(roster, playerId, verb) } };
}

/**
 * 一時効果を切ったことを記録する（フェーズM-33）。チャージの支払いと「この打席のあいだ
 * 効く」の記録を `activateEffect` が1か所で済ませるので、ここは棚を差し替えるだけ。
 *
 * **切れなければ何も起きない**（二重に送られても残り回数が負にならない＝`reduceVerbUsed`
 * と同じ防御）。スキルの棚しか触らないので `withProgress` は要らない。
 */
function reduceEffectActivated(
  ctx: GameContext,
  side: TeamSide,
  playerId: string,
  role: EffectRole,
): GameContext {
  const roster = ctx.rosters[side];
  if (!roster.players[playerId]) return ctx;
  const { roster: next, skillId } = activateEffect(roster, playerId, role);
  if (skillId === null) return ctx;
  return { ...ctx, rosters: { ...ctx.rosters, [side]: next } };
}

/** 采配としての任意継投（セッション9）。reduceSubstituteBatter と同じ設計方針。 */
function reduceSubstitutePitcher(
  ctx: GameContext,
  side: TeamSide,
  bullpenIndex: number,
): GameContext {
  const result = substitutePitcherAt(ctx.rosters[side], bullpenIndex);
  if (!result.ok) return ctx;
  return { ...ctx, rosters: { ...ctx.rosters, [side]: result.roster } };
}

/**
 * 試合前のチーム選択の反映（フェーズB-12/C-13）。選ばれた球団の名鑑からロスターを
 * 組み直して丸ごと差し替える。
 *
 * **まだ何も起きていないときだけ効く**（`isPreGame`）。ロスターの全取り替えは、
 * 塁上の走者・投球数・退場者といった「試合中に積み上がった記録」をすべて無効にするので、
 * 試合が始まってから通ると走者のIDだけが宙に浮く（`baseRunners` は選手IDで塁を覚えて
 * いるため、その選手が居なくなると走力を引けない）。呼び出し側（main.ts）はメインループ
 * 開始前に1度だけ送る設計だが、経路が1本しかないことに頼らず、ここでも成立条件を持つ。
 */
function isPreGame(ctx: GameContext): boolean {
  return (
    ctx.inning === 1 &&
    ctx.half === 'top' &&
    ctx.outs === 0 &&
    ctx.count.balls === 0 &&
    ctx.count.strikes === 0 &&
    ctx.score.away === 0 &&
    ctx.score.home === 0 &&
    ctx.winner === null
  );
}

function reduceMatchSetup(
  ctx: GameContext,
  away: TeamId,
  home: TeamId,
  plans?: Partial<Record<TeamSide, RosterPlan>>,
  seed?: number,
  skills?: Partial<Record<TeamSide, Record<string, readonly SkillId[]>>>,
  uses?: Partial<Record<TeamSide, Record<string, Partial<Record<SkillId, number>>>>>,
  rerolls?: Partial<Record<TeamSide, number>>,
  fatigue?: Partial<Record<TeamSide, Record<string, number>>>,
): GameContext {
  if (!isPreGame(ctx)) return ctx;
  // シードもここで確定させる（ロスターを組み直す＝スキルもまっさらに戻るので、
  // 抽選の状態も一緒に仕切り直すのが筋。省略なら既定シードのまま＝毎回同じ試合）。
  const rngState = seed === undefined ? ctx.rngState : createRngState(seed);
  // ラン化（フェーズF-26-6）で持ち越すスキルを載せてから好調を決める。順番はどちらでも
  // 結果は同じ（好調はロスターの並びだけを見る）が、**能力に関わるものを先に組み終えて
  // から試合固有の状態を載せる**という読み順に揃えてある。
  const build = (team: TeamId, side: TeamSide): TeamRoster =>
    withHotBatters(
      // 疲れの持ち越し（V-43）はスキルを載せた**後**に載せる：回復量は
      // `effectivePitching`（スキル込みのSTM）で決まるので、`タフネス` を持つ投手の
      // 残量ゲージが持ち主のスタミナで読まれる（順序が逆だと素のSTMで読んでしまう）。
      withCarriedFatigue(
        withCarriedSkills(
          createTeamRoster(teamById(team), plans?.[side]),
          skills?.[side] ?? {},
          uses?.[side] ?? {},
        ),
        fatigue?.[side] ?? {},
      ),
      rngState,
      side,
    );
  return {
    ...ctx,
    rosters: {
      // この試合の絶好調選手もここで確定する（フェーズD-19）。**系統の絞り込みと同じく
      // シードから決まり、本編の乱数は消費しない**ので、シードを固定すれば「誰が好調か」
      // まで含めて試合まるごと再現できる。ロスターを組み直す＝好調も仕切り直すのが筋
      // （スキル・投球数と同じ「試合中の状態」の扱い）。
      away: build(away, 'away'),
      home: build(home, 'home'),
    },
    rngState,
    // この試合の系統もここで決まる（フェーズF-26-5）。**乱数の状態は消費せず**、同じ
    // シードから別系列として起こす＝「シードを渡さない MATCH_SETUP は既定シードのまま」
    // という既存の約束（テストが決定的に書ける）を保ったまま、系統だけが試合ごとに変わる。
    lineages: activeLineagesFor(rngState),
    pendingDraft: null,
    // リロールの回数券もスキル・チャージと同じく持ち越す（フェーズU-42）。
    // 渡さない側は満タン＝1試合だけの呼び出しはU-42の前と同じ挙動になる。
    rerollsUsed: { away: rerolls?.away ?? 0, home: rerolls?.home ?? 0 },
  };
}

export const gameMachine = setup({
  types: {
    context: {} as GameContext,
    events: {} as GameEvent,
  },
  guards: {
    hasWinner: ({ context }) => context.winner !== null,
    // 銃はスキル `ジュウ` を持つ投手だけが撃てる（フェーズF-26-2）。残弾も投手個人の
    // 発射数からの導出なので、判定は守備側ロスターへの問い合わせ1本になる。
    canUseGun: ({ context }) => canShootGun(context.rosters[fieldingTeam(context.half)]),
  },
}).createMachine({
  id: 'game',
  context: INITIAL_CONTEXT,
  initial: 'playing',
  states: {
    playing: {
      always: { guard: 'hasWinner', target: 'gameOver' },
      on: {
        MATCH_SETUP: {
          // 試合開始前のチーム選択の反映（イニング・カウント等には触れないので
          // withProgress は不要）。試合が始まっていれば reduceMatchSetup が握りつぶす。
          actions: assign(({ context, event }) =>
            reduceMatchSetup(
              context,
              event.away,
              event.home,
              event.plans,
              event.seed,
              event.skills,
              event.uses,
              event.rerolls,
              event.fatigue,
            ),
          ),
        },
        // スキル抽選（フェーズF-26-1）。イニング・カウント・塁には触れないので
        // withProgress は不要。引く/付けるのどちらも「試合の進行そのもの」ではない。
        SKILL_DRAFT_DRAWN: {
          actions: assign(({ context }) => reduceSkillDraftDrawn(context)),
        },
        // 提示中の3択をまるごと引き直す（フェーズU-42）。抽選の棚だけを触るので
        // withProgress は不要＝イニング・カウント・塁には一切影響しない。
        SKILL_DRAFT_REROLLED: {
          actions: assign(({ context, event }) => reduceSkillDraftRerolled(context, event.side)),
        },
        SKILL_GRANTED: {
          actions: assign(({ context, event }) =>
            reduceSkillGranted(context, event.side, event.playerId, event.skillId),
          ),
        },
        // 消費型のチャージを1つ使う（フェーズF-26-8）。スキルの棚だけを触るので
        // withProgress は不要＝イニング・カウント・塁には一切影響しない。
        VERB_USED: {
          actions: assign(({ context, event }) =>
            reduceVerbUsed(context, event.side, event.playerId, event.verb),
          ),
        },
        // 一時効果を切る（フェーズM-33）。同じくスキルの棚だけを触る。
        EFFECT_ACTIVATED: {
          actions: assign(({ context, event }) =>
            reduceEffectActivated(context, event.side, event.playerId, event.role),
          ),
        },
        PITCH_THROWN: {
          // 投球数を増やすだけ（アウト・カウント・塁には触れないので withProgress は不要）
          actions: assign(({ context }) => reducePitchThrown(context)),
        },
        PITCH_RESULT: {
          actions: assign(({ context, event }) =>
            withProgress(reducePitchResult(context, event.judgement)),
          ),
        },
        // デバッグモード専用（フェーズPP-64）。カウント以外は1つも書き換えない。
        DEBUG_RESET_COUNT: {
          actions: assign(() => ({ count: { balls: 0, strikes: 0 } })),
        },
        // 敬遠（フェーズQ-38）。押し出しで点が入りうる（＝9回裏ならサヨナラもある）ので、
        // 四球とまったく同じく withProgress を通す。
        INTENTIONAL_WALK: {
          actions: assign(({ context, event }) =>
            withProgress(reduceIntentionalWalk(context, event.side)),
          ),
        },
        HIT_BY_PITCH: {
          actions: assign(({ context }) => withProgress(reduceHitByPitch(context))),
        },
        GUN_USED: {
          guard: 'canUseGun',
          actions: assign(({ context }) => {
            const side = fieldingTeam(context.half);
            return {
              rosters: { ...context.rosters, [side]: recordGunShot(context.rosters[side]) },
            };
          }),
        },
        PLAY_RESOLVED: {
          actions: assign(({ context, event }) =>
            withProgress(
              reducePlayResolved(
                context,
                event.outsAdded,
                event.runs,
                eventRunners(event.bases, event.baseRunners),
              ),
            ),
          ),
        },
        RUNNER_PLAY_RESOLVED: {
          actions: assign(({ context, event }) =>
            withProgress(
              reduceRunnerPlayResolved(
                context,
                event.outsAdded,
                event.runs,
                eventRunners(event.bases, event.baseRunners),
              ),
            ),
          ),
        },
        BRAWL_RESOLVED: {
          actions: assign(({ context, event }) =>
            withProgress(reduceBrawlResolved(context, event.loser, event.restore)),
          ),
        },
        FORFEIT: {
          // 没収試合：退場者続出で出場可能選手が尽きた側の不戦敗
          actions: assign(({ event }) => ({ winner: opponent(event.loser) })),
        },
        SUBSTITUTE_BATTER: {
          actions: assign(({ context, event }) =>
            reduceSubstituteBatter(context, event.side, event.benchIndex),
          ),
        },
        SUBSTITUTE_PITCHER: {
          actions: assign(({ context, event }) =>
            reduceSubstitutePitcher(context, event.side, event.bullpenIndex),
          ),
        },
        SUBSTITUTE_RUNNER: {
          actions: assign(({ context, event }) =>
            reduceSubstituteRunner(context, event.side, event.base, event.benchIndex),
          ),
        },
      },
    },
    gameOver: {
      type: 'final',
    },
  },
});
