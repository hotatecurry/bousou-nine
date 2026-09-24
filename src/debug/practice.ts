/**
 * **デバッグモード（フェーズPP-64）＝確認したい1つの局面だけを繰り返す土台**。
 *
 * 原作にもゲーム性にも関係しない**開発用の道具**（`tools/balance/` が計測の道具なのと同じ
 * 立て方で、こちらは実機確認の道具）。実機検証の方針（CLAUDE.mdの運用ルール）が
 * 「**目的の事象が実際に起きたことを数値か画面で確認する**」と決めている一方で、
 * 1つの事象を起こすまでに打席・カウント・アウト・攻守交代を通らないといけないため、
 * **確認したい局面を作るコストが高い**（PP-63のフォークの確認でも、CPU打者に振られて
 * ミットまで届く球を作るのに何度も投げ直した）。それを1か所に畳んだもの。
 *
 * 3つの局面：
 *
 * | モード | 誰が何をする | 何を確認する |
 * |---|---|---|
 * | `pitch` | 人間が投げる／CPU打者は**振る/振らないを切替** | 球の軌道・コース・変化・判定 |
 * | `bat` | 人間が打つ／CPU投手が投げる | 打撃のタイミング・立ち位置・CPUの配球 |
 * | `field` | 人間が守る／**ノックで打球を打ち出す** | 捕球・送球・タッチ・走者の帰結 |
 * | `brawl` | 人間が打者で乱闘／**必殺技と超必殺を全部持つ**・相手の動きを切替 | 乱闘v3の技・当たり方（XX-72） |
 *
 * ## 設計の柱：判定には1つも触らない
 *
 * **`core` の判定は1行も変えない**（`gameMachine` に足すのは「カウントを 0-0 に戻す」
 * 1イベントだけ）。デバッグモードがしていることは**main.ts が試合状態へ送るイベントを
 * 選ぶ**ことだけ＝**投球・打撃・守備・走塁の帰結は本番とまったく同じものが出る**
 * （デバッグ用の別経路を作ると「デバッグでは動くのに本番では動かない」が起きる）。
 *
 * - **打席が終わる球（三振・四球・死球）だけ試合状態へ送らず、カウントを 0-0 に戻す**
 *   ＝アウト・得点・打順・イニングが動かないので**永遠に同じ場面を繰り返せる**
 *   （2026-08-18 ユーザー判断）。
 * - **打球のプレーは従来どおり走らせ、結果（アウト・得点・進塁）だけ記録しない**
 *   （同ユーザー判断）＝打った結果も守備の帰結も画面で見えるが、場面は元のまま。
 */
import { type BattedBallLaunch, type BattedBall, createBattedBall } from '../core/batting';
import {
  type FighterLoadout,
  type SpecialId,
  type SuperId,
  DEFAULT_LOADOUT,
  MOVE_NAME,
} from '../core/brawl';
import type { BrawlDummy } from '../core/brawlAi';
import type { TeamSide } from '../core/rules';

/** デバッグモードの種類（モード選択の DEBUG の下に並ぶ順） */
export type PracticeMode = 'pitch' | 'bat' | 'field' | 'brawl';

/** モード選択の DEBUG の中身。ラベルはモード選択の他の行と同じカタカナ表記に揃える */
export const PRACTICE_MODES: readonly { id: PracticeMode; label: string; note: string }[] = [
  { id: 'pitch', label: '投球', note: '自分が投げる（打者は振る／振らないを切り替え）' },
  { id: 'bat', label: '打撃', note: '自分が打つ（CPUが投げる）' },
  { id: 'field', label: '守備', note: 'ノックで打ち出して守備する' },
  { id: 'brawl', label: '乱闘', note: '必殺技を全部試す（相手の動きを切り替え）' },
];

/**
 * そのモードで人間が操作する側。**1回表から始まる**ので、
 * **守備側＝後攻（`home`）／攻撃側＝先攻（`away`）**。
 *
 * `pitch` と `field` は守備側（投げる・守る）、`bat` は攻撃側（打つ）＝
 * **モードを選んだ時点で操作する側が決まる**ので、デバッグの入口では「操作する側」を
 * 選ばせない（段を1つ減らす＝確認したい局面へ最短で入る、というこのモードの目的そのもの）。
 */
export function practiceHumanSide(mode: PracticeMode): TeamSide {
  // 乱闘は**殴られた打者の側**（画面左）で戦う＝攻撃側（先攻）
  return mode === 'bat' || mode === 'brawl' ? 'away' : 'home';
}

// ---------------------------------------------------------------------------
// 乱闘の練習（`brawl` モード。フェーズXX-72）
// ---------------------------------------------------------------------------
//
// テストプレイ「スキルの波動拳とかも作り込んで試してみたい」。スキルを揃えないと出ない
// 技を**全部持った状態**で始め、相手の動きを数字キーで切り替える。**体力は減っても戻り、
// ゲージは常に満タン・時間は止まる**（`core/brawl.ts` の練習の扱い＝判定そのものは本番と同じ）。

/** 練習で持たせる必殺技（名鑑の全部。技表と同じ順） */
export const PRACTICE_SPECIALS: readonly SpecialId[] = [
  'hadou',
  'shoryu',
  'tatsu',
  'zutsuki',
  'hyakuretsu',
  'screw',
  'buki',
  'somersault',
  'divekick',
  'kobun',
];

/** 練習で切り替える超必殺 */
export const PRACTICE_SUPERS: readonly SuperId[] = ['shinku', 'batto'];

/** 練習の相手の動き（数字キー1で回す） */
export const PRACTICE_DUMMIES: readonly { id: BrawlDummy; label: string }[] = [
  { id: 'stand', label: '棒立ち' },
  { id: 'guard', label: '立ちガード' },
  { id: 'crouchGuard', label: 'しゃがみガード' },
  { id: 'jump', label: 'ジャンプし続ける' },
  { id: 'cpu', label: 'CPU' },
];

export interface BrawlPracticeSetup {
  dummy: number;
  super: number;
  /** 相手にも必殺技を持たせる（CPUの対空・飛び道具を見る） */
  foeSpecials: boolean;
}

export const INITIAL_BRAWL_PRACTICE: BrawlPracticeSetup = { dummy: 0, super: 0, foeSpecials: false };

export function practiceBrawlLoadout(superIdx: number): FighterLoadout {
  return { ...DEFAULT_LOADOUT, specials: [...PRACTICE_SPECIALS], super: PRACTICE_SUPERS[superIdx % PRACTICE_SUPERS.length] };
}

export function practiceFoeLoadout(setup: BrawlPracticeSetup): FighterLoadout {
  return setup.foeSpecials ? { ...DEFAULT_LOADOUT, specials: ['hadou', 'shoryu', 'tatsu'] } : DEFAULT_LOADOUT;
}

// ---------------------------------------------------------------------------
// ノック（`field` モードの打球）
// ---------------------------------------------------------------------------
//
// **CPU打者に打たせる案は採らなかった**（2026-08-18 ユーザー判断）：CPU打者は常に
// t=0（ジャストミート）で振るので**打球が中堅方向に偏る**（I-29が記録した既知の偏り）＝
// 左右の浅いフライや二遊間のゴロを狙って見られない。ノックなら**狙った打球だけを
// 何度でも**出せる。
//
// 打ち出しは `createBattedBall`＝**打撃とまったく同じ純粋関数**を通す（デバッグ専用の
// 打球を作らない）ので、飛行・バウンド・フェンス・守備の帰結は本番と完全に同じ。

/** ノックの方向（度。0=中堅／負=左翼側／正=右翼側。±45°がファウルライン） */
export const KNOCK_DIRECTIONS: readonly { label: string; deg: number }[] = [
  { label: 'サード', deg: -40 },
  { label: '左中間', deg: -20 },
  { label: 'センター', deg: 0 },
  { label: '右中間', deg: 20 },
  { label: 'ファースト', deg: 40 },
];

/**
 * ノックの種類。**打球の質は「初速と打ち上げ角」だけで決まる**（`judgeSwing` と同じ）ので、
 * 見たい帯（内野ゴロ／ライナー／外野フライ／フェンス際）をその2つで書く。
 *
 * 値は `npm run balance` の帯と揃えてある：ゴロは内野で拾われる速さ、フライは外野の
 * 定位置（約80m）に落ちる高さ、大飛球はフェンス（ところざわ中堅120m）に届く速さ。
 */
export const KNOCK_KINDS: readonly { label: string; speed: number; launchDeg: number }[] = [
  { label: 'ゴロ', speed: 26, launchDeg: 4 },
  { label: 'ライナー', speed: 34, launchDeg: 12 },
  { label: 'フライ', speed: 30, launchDeg: 40 },
  { label: '大飛球', speed: 44, launchDeg: 28 },
];

/** ノックで置く走者のパターン（送球先の判断＝フォース/タッチの違いを見るため） */
export const KNOCK_RUNNER_PATTERNS: readonly {
  label: string;
  bases: readonly ('first' | 'second' | 'third')[];
}[] = [
  { label: '走者なし', bases: [] },
  { label: '一塁', bases: ['first'] },
  { label: '一・二塁', bases: ['first', 'second'] },
  { label: '満塁', bases: ['first', 'second', 'third'] },
];

/** いま選んでいるノックの設定（十字キーではなく数字キーで回す＝守備の操作と衝突しない） */
export interface KnockSetup {
  direction: number;
  kind: number;
  runners: number;
}

export const INITIAL_KNOCK: KnockSetup = { direction: 2, kind: 0, runners: 0 };

/** 設定を1つ進める（端で折り返す＝押し続ければ全部見られる） */
export function cycleKnock(setup: KnockSetup, field: keyof KnockSetup): KnockSetup {
  const length =
    field === 'direction'
      ? KNOCK_DIRECTIONS.length
      : field === 'kind'
        ? KNOCK_KINDS.length
        : KNOCK_RUNNER_PATTERNS.length;
  return { ...setup, [field]: (setup[field] + 1) % length };
}

/**
 * ノックの打球。**`judgeSwing` の打球と同じ形**（初速ベクトル＋接触点）で作るので、
 * 飛行もフェンスも守備も本番と同じ経路を通る。外野方向が -Z（`batting.ts` と同じ約束）。
 */
export function knockLaunch(setup: KnockSetup): BattedBall {
  const kind = KNOCK_KINDS[setup.kind];
  const dirRad = (KNOCK_DIRECTIONS[setup.direction].deg * Math.PI) / 180;
  const launchRad = (kind.launchDeg * Math.PI) / 180;
  const horizontal = kind.speed * Math.cos(launchRad);
  const launch: BattedBallLaunch = {
    vx: horizontal * Math.sin(dirRad),
    vy: kind.speed * Math.sin(launchRad),
    vz: -horizontal * Math.cos(dirRad),
  };
  // 接触点は本塁の真上（打席の左右で打球が変わらない＝ノックは「狙った打球」を出す道具）
  return createBattedBall(launch, 0);
}

/** ノックの設定を1行で（HUDのデバッグ行に出す） */
export function knockLabel(setup: KnockSetup): string {
  return `${KNOCK_DIRECTIONS[setup.direction].label} ${KNOCK_KINDS[setup.kind].label} / ${KNOCK_RUNNER_PATTERNS[setup.runners].label}`;
}

/**
 * HUDのデバッグ行（**常に出す**＝いま本番ではないことと、押せるキーが見えていないと
 * デバッグモードそのものが使えない）。キーは**ゲームのキーマップの外**（数字キー）から
 * 取るので、本番の操作は1つも奪わない。
 */
export function practiceHudLines(
  mode: PracticeMode,
  state: { swing: boolean; knock: KnockSetup; brawl?: BrawlPracticeSetup },
): string {
  if (mode === 'brawl') {
    const b = state.brawl ?? INITIAL_BRAWL_PRACTICE;
    return (
      `DEBUG 乱闘  体力は戻る・ゲージ満タン・時間は止まる
` +
      `1:相手 ${PRACTICE_DUMMIES[b.dummy].label}  2:超必殺 ${MOVE_NAME[PRACTICE_SUPERS[b.super]]}  ` +
      `3:相手の必殺技 ${b.foeSpecials ? 'あり' : 'なし'}`
    );
  }
  const head = `DEBUG ${PRACTICE_MODES.find((m) => m.id === mode)?.label ?? ''}  カウントは0-0に戻る`;
  if (mode === 'pitch') {
    return `${head}\n1:打者のスイング ${state.swing ? '振る' : '振らない'}`;
  }
  if (mode === 'bat') return head;
  return `${head}\n1:方向 2:種類 3:走者 4:ノック\n次のノック ${knockLabel(state.knock)}`;
}

/** デバッグ用の数字キー（ゲームのキーマップ（`input/keyboard.ts`）には1つも足さない） */
export const PRACTICE_KEYS = {
  toggleSwing: 'Digit1',
  cycleDirection: 'Digit1',
  cycleKind: 'Digit2',
  cycleRunners: 'Digit3',
  knock: 'Digit4',
  brawlDummy: 'Digit1',
  brawlSuper: 'Digit2',
  brawlFoe: 'Digit3',
} as const;
