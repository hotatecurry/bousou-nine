/**
 * 試合開始前の選択画面（フェーズC-13。モード＋16球団＋球場＋操作する側＋試合前の采配）。
 *
 * 最初に**モードを選ぶ**（フェーズD-20。説明書p4の「1P PLAY / 2P PLAY」。WATCHと
 * リーグ戦は対象外）。続いて原作（説明書p6-7）と同じく**先攻・後攻の2球団を順に選ぶ**。
 * さらに**6球場から球場を選ぶ**（フェーズC-14。説明書p24-25「グランドの紹介」）。
 * **1P PLAY のときだけ**、原作には無い追加ステップとして「どちらを人間が操作するか」を
 * 選ぶ（原作の1P PLAYは先攻/後攻の指定がモード選択側にある）。最後に**先発投手**と
 * **打順**を決める（フェーズC-15。説明書p8-9）。
 *
 * **2P PLAY では「操作する側」の段が要らない**（先攻＝1P・後攻＝2Pに固定＝原作準拠）
 * かわりに、**先発投手と打順を両側ぶん決める**（先攻→後攻の順。それぞれ自分のパッドで）。
 *
 * **どの段を誰が操作できるかは `ownerOf` の1か所**（フェーズD-20）。1P PLAY は全段 1P、
 * 2P PLAY は「自分の球団・自分の采配は自分のパッドで」＝先攻の段は1P、後攻の段は2P、
 * 両者に関わる段（モード・球場）はどちらでも動かせる。
 *
 * 球場を球団の後に置くのは、**球場が「どちらの球団に有利か」の選択になる**から
 * （説明書：狭いかせんじきは長打力、広いどうむは俊足に有利）。先に球場を決めると
 * 比べる相手がいない（B-12で采配メニューに「イマ:」で今の選手を並べたのと同じ理由）。
 * **先発投手・打順を最後に置く**のも同じ理由で、相手の打線と球場の広さが決まって
 * いなければ「誰を先発に立てるか」は決められない。
 *
 * 試合前の采配を決めるのは**人間が操作する側だけ**（CPUの采配はスコープ外という既存方針。
 * B-11でCPU投手が自動継投しないのと同じ）。CPU側は名鑑どおり＝先頭の投手が先発、
 * 打順も名鑑の並びになる。
 *
 * ここで選んだ操作側のチームが攻撃のときは打撃（でっかいモード）と走塁（ちっちゃい
 * モード）を、守備のときは投球（でっかいモード）と守備（ちっちゃいモード）を、表裏の
 * 入れ替わりに合わせてプレイヤーが操作する。もう一方の役割は常にCPUが自動で行う：
 * ちっちゃいモードは着地点へ自動追跡→自動捕球→自動送球の簡易CPU（セッション7、詳細は
 * chicchaiScene.ts）、でっかいモードはカウントに応じて狙うコース・球速を決めるCPU投球AI
 * （core/cpuPitcher.ts）とスイングタイミングを判断するCPU打撃AI（core/cpuBatter.ts）。
 *
 * **入力ハンドラは起動時に1回だけ登録し、進行はこのモジュール内の `step` で切り替える**。
 * ボタン押下の処理の中で同じボタンに新しいハンドラを登録すると、同一の押下でその新しい
 * ハンドラまで走る（`input/keyboard.ts` の Set.forEach の再入バグ。PROGRESS.md参照）。
 */
import { type BallparkId, BALLPARKS } from '../core/ballpark';
import {
  type PitcherStats,
  type RosterPlan,
  type TeamRoster,
  BATTER_STAT_HEADERS,
  DEFAULT_ROSTER_PLAN,
  PITCHING_STAFF_SIZE,
  STAMINA_FRESH_THRESHOLD,
  batterStatCells,
  effectiveBatting,
  effectivePitching,
  eraStatCell,
  fatigueFromRemaining,
  formatEra,
  padName,
  pitcherRole,
  pitcherStuff,
  positionOf,
  ratingBar,
  remainingStaminaOf,
  staffPlayerId,
  swapBattingOrder,
} from '../core/roster';
import { type CarriedState, nextGameRoster } from '../core/run';
import { type PlayMode, type PlayerSlot, PLAYER_LABEL } from '../core/players';
import type { TeamSide } from '../core/rules';
import { type TeamId, TEAMS, pitcherRowPitching, teamById } from '../core/teams';
import type { VirtualPad } from '../input/keyboard';

/**
 * チーム選択の結果。モードと、先攻・後攻の球団と、球場と、（1P PLAYなら）人間が操作する側と、
 * **人間が操作する側ぶんの試合前の采配**（フェーズC-15。CPU側は名鑑どおり）。
 */
export interface MatchSelection {
  /** フェーズD-20。`'2p'` なら先攻＝1P・後攻＝2P（原作準拠） */
  mode: PlayMode;
  away: TeamId;
  home: TeamId;
  park: BallparkId;
  /** 1P PLAY で人間が操作する側（2P PLAY では両側が人間なので使わない） */
  humanSide: TeamSide;
  /**
   * 側ごとの先発投手と打順（フェーズC-15）。1P PLAY は人間側の1つだけ、2P PLAY は両側。
   * `MATCH_SETUP` の `plans` にそのまま渡せる形にしてある。
   */
  plans: Partial<Record<TeamSide, RosterPlan>>;
}

/** 球団グリッドの列数（16球団を4×4で並べる） */
const COLUMNS = 4;
/** 球場グリッドの列数（6球場を3×2で並べる） */
const PARK_COLUMNS = 3;
/** 投手陣グリッドの列数（6人を3×2で並べる。球場と同じ形） */
const STAFF_COLUMNS = 3;

const OVERLAY_STYLE = `
  position: fixed;
  inset: 0;
  z-index: 20;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 32, 0.94);
  color: #fff;
  font-family: "MS Gothic", "ＭＳ ゴシック", monospace;
  font-size: 20px;
  letter-spacing: 2px;
`;

const GRID_STYLE = `
  display: grid;
  grid-template-columns: repeat(${COLUMNS}, 200px);
  gap: 8px 12px;
  margin: 20px 0;
`;

const PARK_GRID_STYLE = `
  display: grid;
  grid-template-columns: repeat(${PARK_COLUMNS}, 240px);
  gap: 10px 14px;
  margin: 20px 0;
`;

const STAFF_GRID_STYLE = `
  display: grid;
  grid-template-columns: repeat(${STAFF_COLUMNS}, 260px);
  gap: 10px 14px;
  margin: 16px 0;
`;

const CELL_BASE_STYLE = `
  padding: 6px 10px;
  border: 3px solid transparent;
  text-align: center;
  font-size: 20px;
`;

/** 打順の表（9行）。等幅で桁を揃えたいので中央寄せにはしない */
const ORDER_LIST_STYLE = `
  margin: 16px 0;
  padding: 8px 14px;
  border: 3px solid transparent;
  font-size: 20px;
  line-height: 1.55;
  white-space: pre;
`;

type Step = 'mode' | 'away' | 'home' | 'park' | 'side' | 'starter' | 'order';

/** モード選択（フェーズD-20）の並び。説明書p4の順に 1P PLAY → 2P PLAY */
const MODES: readonly { id: PlayMode; label: string; note: string }[] = [
  { id: '1p', label: '1P PLAY', note: 'ヒトリ デ アソブ（アイテハ CPU）' },
  { id: '2p', label: '2P PLAY', note: 'フタリ デ タイセン（センコウ=1P コウコウ=2P）' },
];

/** その段階でカーソルが動くグリッドの形（段階ごとに並ぶものが変わる） */
function gridOf(step: Step, staffSize: number): { columns: number; count: number } {
  if (step === 'mode') return { columns: 1, count: MODES.length };
  if (step === 'park') return { columns: PARK_COLUMNS, count: BALLPARKS.length };
  if (step === 'starter') return { columns: STAFF_COLUMNS, count: staffSize };
  // 打順は1列の縦並び（1行が長いので横に並べると読めない）
  if (step === 'order') return { columns: 1, count: DEFAULT_ROSTER_PLAN.order.length };
  return { columns: COLUMNS, count: TEAMS.length };
}

/**
 * 投手1人の紹介（先発を選ぶ画面）。**型・防御率・球速・変化量・制球・スタミナを全部出す**：
 * 先発を選ぶことは「どの球で押すか」「何球まで持つか」の選択なので、押す前にこれが
 * 見えていなければ選べない（既存の「意思決定材料は隠さない」方針）。
 *
 * 選んでいるのは**名鑑の何人目か**（まだ誰が先発かは決まっていないので、ロスターの
 * `pitcher`/`bullpen` から引くと並びが割れる）だが、**出す数字は名鑑そのものではなく
 * 「次の試合に実際に出てくる球」**にする（フェーズDD-51）：
 *
 * - **スキル込みで読む**（`stats` は呼び出し側が `effectivePitching` で作る）。V-43で
 *   試合の間にもこの画面を通るようになったのに、ここは名鑑を直読みしていたので
 *   **`シネンセイギョ` で防御率が動いた投手も名鑑のERAのまま**だった＝W-44がHUDの投手
 *   カードで直したのとまったく同じ食い違いが、選択画面にだけ残っていた。
 * - **球速・変化量・制球は疲労を織り込む**（`pitcherStuff`）。持ち越した疲れ（V-43）は
 *   1球目から球威に効くので、**残量だけ見せて能力は無傷の値、では選べない**。
 *   疲労は残量からの導出（`fatigueFromRemaining`）なので、ここに新しい入力は増えない。
 * - **スタミナだけは疲労を掛けない**：これは「何球持つか」という容量そのもの（B-11）で、
 *   減っているぶんは下の `ザンリョウ` が受け持つ（二重に減らすと読み方が壊れる）。
 */
function describeStaffPitcher(name: string, stats: PitcherStats, remaining?: number): string {
  const role = pitcherRole(stats.stamina) === 'starter' ? 'センパツ' : 'リリーフ';
  // 変化量は左右の平均（カーブとシュートを別々に出すと1人が6行になる）＝采配メニューの
  // 継投（DD-51）とまったく同じ3つを、同じ目盛りで出す。
  const stuff = pitcherStuff(stats, fatigueFromRemaining(remaining ?? 1));
  return [
    `${name} ${role}`,
    `ERA${formatEra(stats.era)}`,
    `キュウソク ${ratingBar(stuff.speed)}`,
    `ヘンカ　　 ${ratingBar(stuff.breaking)}`,
    `セイキュウ ${ratingBar(stuff.control)}`,
    `スタミナ　 ${ratingBar(stats.stamina)}`,
    // 疲れの持ち越し（フェーズV-43）。**無傷なら行そのものを出さない**ので、試合前の
    // 選択画面（C-15。全員が無傷）ではこの行が出ない
    // （銃の残弾・持ち越したリード・ゼッコーチョーの行と同じ扱い）。
    // ここが見えていなければ「今日は誰に投げさせるか」を選びようがない
    // （既存の「意思決定材料は隠さない」方針）。
    ...(remaining !== undefined && remaining < 1
      ? [`ザンリョウ ${ratingBar(remaining)}${remaining < STAMINA_FRESH_THRESHOLD ? ' ツカレ' : ''}`]
      : []),
  ].join('\n');
}

/**
 * 打順1行（打順・守備位置・名前・能力値）。**守備位置を出す**のは、打順を入れ替えても
 * 守備位置は選手に付いて回る＝「打つ順番だけが変わる」ことがこの表で分かるようにするため。
 * 能力値は打者ならAV/HR/走力、投手なら防御率＋走力（HUDのカードと同じ記号）。
 *
 * **能力値はスキル込みで読む**（フェーズEE-52。`effectiveBatting`／`effectivePitching`）：
 * V-43で**試合の間にもこの画面を通る**ようになったのに、ここは名鑑を直読みしていたので
 * **`カジバノチカラ` で長打力が動いた打者も名鑑の値のまま**出ていた（DD-51が投手カードで
 * 直したのとまったく同じ食い違いが、打線の表にだけ残っていた）。**好調（D-19）は乗らない**
 * ＝次の試合の絶好調選手はまだ決まっていない（試合開始時にシードから決まる）。
 *
 * **走力の列を足した**（EE-52）：代打の表（`managerMenu.ts`）と同じ物差しで並べる
 * ＝打線を組むときと代打を送るときで、同じ選手が同じ見え方をする。
 * 投手の行の防御率は**打者のAV+HRとまったく同じ幅**（`eraStatCell`）なので、
 * 9行のどこでも走力のバーが同じ位置に来る。
 */
export function describeLineupRow(roster: TeamRoster, slot: number): string {
  const id = roster.lineup[slot];
  const player = roster.players[id];
  const position = positionOf(roster, id);
  const batting = effectiveBatting(roster, id);
  const pitching = slot === roster.pitcherSlot ? effectivePitching(roster, id) : undefined;
  const cells = pitching
    ? [eraStatCell(pitching.era), ratingBar(batting.run)]
    : batterStatCells(batting);
  return `${slot + 1}バン ${(position ?? '　').padEnd(2, ' ')} ${padName(player.name)} ${cells.join(' ')}`;
}

/**
 * 打順の表の見出し（`describeLineupRow` の能力値の列に名前を付ける）。
 * 行と同じ幅の空欄（`1バン`＝全角2＋半角1／守備位置＝半角2／名前＝全角4）を置いてから
 * 列名を出す＝見出しと値が縦に揃う（等幅フォント前提。`ORDER_LIST_STYLE`）。
 */
function lineupHeaderRow(): string {
  const mark = '　 '; // カーソル欄（`▶ `／`◆ `／`　 `）ぶん
  const slot = '　　 '; // 「1バン」ぶん（全角2＋半角1）
  const position = '  '; // 守備位置ぶん（半角2）
  return `${mark}${slot} ${position} ${padName('')} ${BATTER_STAT_HEADERS.join(' ')}`;
}

/** 采配の段（先発を選ぶ／打順を決める）。`Step` の部分集合 */
type PlanStep = 'starter' | 'order';

/**
 * 先発＋打順の采配を編集する部品（フェーズC-15の2段。**V-43で共有化した**）。
 *
 * 使うのは2か所：**試合前のチーム選択**（`runTeamSelect`）と、**試合と試合の間の
 * 選び直し**（`runRosterPlanSelect`。フェーズV-43）。切り出したのは
 * **DOM・描画・入替の意味づけ**だけで、`step`／`cursor` は呼び出し側が持ったまま
 * （チーム選択のほうは球団・球場の段と同じカーソルを使い回しているので、ここに
 * 二重の真実を作らない）。
 *
 * これで**「試合前に見た画面」と「試合の間に見る画面」が同じ関数から出る**＝
 * 片方だけ表示が変わることが構造的に起きない（C-14で描画と当たり判定を同じ
 * `fenceAt` から起こしたのと同じ整理）。
 */
interface PlanEditor {
  readonly staffGrid: HTMLElement;
  readonly orderList: HTMLElement;
  /** いま編集中の采配（決定時に呼び出し側が読む） */
  plan: RosterPlan;
  /** 打順入替で「入れ替える1人目」を選んでいる最中か（Jの二役・決定の可否に要る） */
  picking(): boolean;
  /** 采配の段へ入り直す（前のチームの打順を残さないための初期化） */
  reset(plan?: RosterPlan): void;
  /** その段を描く。`step` が `null` なら両方隠す */
  render(step: PlanStep | null, cursor: number): void;
  /** K。先発の段なら先発を確定（呼び出し側が打順の段へ進める）、打順の段なら選択/入替 */
  press(step: PlanStep, cursor: number): void;
  /** J。取り消せたら true（＝段は戻さない）／false なら呼び出し側が1つ前の段へ */
  cancel(step: PlanStep): boolean;
}

function createPlanEditor(opts: {
  /** 采配を組む球団（チーム選択では段の途中で変わるので関数で受ける） */
  teamId: () => TeamId;
  /**
   * ランが持ち越しているもの（フェーズV-43の疲れ＋F-26-6のスキル）。
   *
   * **省略すれば名鑑どおり・全員無傷**＝試合前のチーム選択（まだスキルも疲れも無い）は
   * これを渡さない。**投手陣も打線も、これで組んだ1つのロスターから読む**（`nextGameRoster`）
   * ＝入口を分けると片方だけ名鑑を直読みする経路が生まれる（実際そうなっていた：V-43で
   * 試合の間にもこの画面を通るようになったのに、DD-51で直したのは投手側だけで、
   * **打線の表はスキルが乗る前の名鑑の値のまま**だった）。
   */
  carried?: CarriedState;
}): PlanEditor {
  // 投手陣（フェーズC-15）。中身は選んだ球団で変わるので、枠だけ先に作って
  // render() で書き換える（球団グリッド・球場グリッドは中身が固定なので作り置き）。
  const staffGrid = document.createElement('div');
  staffGrid.style.cssText = STAFF_GRID_STYLE;
  const staffCells = Array.from({ length: PITCHING_STAFF_SIZE }, () => {
    const cell = document.createElement('div');
    cell.style.cssText = CELL_BASE_STYLE;
    cell.style.whiteSpace = 'pre';
    cell.style.lineHeight = '1.45';
    cell.style.fontSize = '17px';
    staffGrid.appendChild(cell);
    return cell;
  });

  // 打順（フェーズC-15）。9行を1つの要素にまとめて出す（行ごとに要素を分けると
  // 等幅の桁揃えが崩れやすく、カーソル記号のぶん行頭がずれる）。
  const orderList = document.createElement('div');
  orderList.style.cssText = ORDER_LIST_STYLE;

  let picked: number | null = null;

  const editor: PlanEditor = {
    staffGrid,
    orderList,
    plan: DEFAULT_ROSTER_PLAN,
    picking: () => picked !== null,
    reset(plan = DEFAULT_ROSTER_PLAN) {
      editor.plan = plan;
      picked = null;
    },
    render(step, cursor) {
      staffGrid.style.display = step === 'starter' ? 'grid' : 'none';
      orderList.style.display = step === 'order' ? 'block' : 'none';
      if (step === null) return;
      // **投手陣の段も打順の段も、この1つのロスターから読む**（フェーズEE-52）。
      // 次の試合とまったく同じ手順で組む（`nextGameRoster`）ので、画面の数字と試合が
      // 始まったときの中身が食い違わない（C-15の「表示は実際に使うロスターから起こす」）。
      const teamId = opts.teamId();
      const roster = nextGameRoster({ teamId, carried: opts.carried, plan: editor.plan });
      // 先発の候補は投手陣6人を**名鑑の並びのまま**出す（上4人が先発型・下2人がリリーフ型）。
      // ロスターの `pitcher`/`bullpen` から組み直さないのは、選んだ先発によって並びが
      // 変わってしまい、カーソルの位置と候補の対応が崩れるため。
      const staff = teamById(teamId).pitchers;
      staffCells.forEach((cell, i) => {
        const active = step === 'starter' && i === cursor;
        const chosen = i === editor.plan.starterIndex;
        const id = staffPlayerId(teamId, i);
        cell.textContent = describeStaffPitcher(
          staff[i][0],
          effectivePitching(roster, id) ?? pitcherRowPitching(staff[i]),
          remainingStaminaOf(roster, id),
        );
        cell.style.borderColor = active ? '#ffe066' : chosen ? '#7fd4ff' : 'transparent';
        cell.style.color = active ? '#ffe066' : '#fff';
      });
      orderList.textContent = [
        lineupHeaderRow(),
        ...editor.plan.order.map((_, slot) => {
          // ▶＝カーソル、◆＝入れ替える1人目として選んだ打順
          const mark = picked === slot ? '◆ ' : step === 'order' && slot === cursor ? '▶ ' : '　 ';
          return `${mark}${describeLineupRow(roster, slot)}`;
        }),
      ].join('\n');
    },
    press(step, cursor) {
      if (step === 'starter') {
        editor.plan = { ...editor.plan, starterIndex: cursor };
        return;
      }
      // 打順：原作（説明書p9）と同じ「選手を選んでA→入れたい打順を選んでAで交換」。
      // 同じ打順をもう一度押したときは取り消し（選び直しのために J を押させない）。
      if (picked === null) {
        picked = cursor;
      } else {
        editor.plan = { ...editor.plan, order: swapBattingOrder(editor.plan.order, picked, cursor) };
        picked = null;
      }
    },
    cancel(step) {
      // 打順の段階のJは二役：入れ替える選手を選んでいる最中なら**その取り消し**、
      // そうでなければ1つ前（先発選び）へ戻る。取り消しを別のキーにすると、
      // 「間違えて選んだ」ときに押すキーが増えてしまう。
      if (step === 'order' && picked !== null) {
        picked = null;
        return true;
      }
      return false;
    },
  };
  return editor;
}

export function runTeamSelect(
  root: HTMLElement,
  /** プレイヤーごとの実パッド（フェーズD-20。どの段を誰が動かせるかは `ownerOf` が決める） */
  pads: Record<PlayerSlot, VirtualPad>,
): Promise<MatchSelection> {
  return new Promise((resolve) => {
    let step: Step = 'mode';
    let cursor = 0;
    let mode: PlayMode = MODES[0].id;
    let away: TeamId = TEAMS[0].id;
    let home: TeamId = TEAMS[1].id;
    let park: BallparkId = BALLPARKS[0].id;
    let humanSide: TeamSide = 'away';
    // 試合前の采配（フェーズC-15）。操作する側を選んだ時点で初期化するので、
    // 戻って球団や操作する側を選び直しても前のチームの打順が残らない。
    // **2P PLAY では両側ぶん決める**（フェーズD-20）ので、いま誰の采配を決めているかを
    // `planSide` が持つ（1P PLAY では常に humanSide）。
    let plans: Partial<Record<TeamSide, RosterPlan>> = {};
    let planSide: TeamSide = 'away';
    // 先発＋打順の編集はV-43で共有部品にした（試合と試合の間の選び直しと同じ画面）。
    // 残量は渡さない＝試合前は全員無傷なので、見た目はV-43の前とまったく同じ。
    const planEditor = createPlanEditor({ teamId: () => planTeamId() });

    /**
     * その段を動かせるプレイヤー（`null` はどちらでも可）。**2P PLAYでも画面は1つ**なので、
     * 「自分の球団・自分の采配は自分のパッドで」決める形にしてある（相手の打順を勝手に
     * 触れない）。両者に関わる段（モード・球場）はどちらのパッドでも動かせる。
     */
    function ownerOf(current: Step): PlayerSlot | null {
      if (mode === '1p') return current === 'mode' ? null : 'p1';
      if (current === 'mode' || current === 'park') return null;
      if (current === 'away') return 'p1';
      if (current === 'home') return 'p2';
      // 先発・打順は「いま誰の采配を決めているか」で決まる（先攻=1P・後攻=2P）
      return planSide === 'away' ? 'p1' : 'p2';
    }

    function canAct(player: PlayerSlot): boolean {
      const owner = ownerOf(step);
      return owner === null || owner === player;
    }

    const overlay = document.createElement('div');
    overlay.style.cssText = OVERLAY_STYLE;

    const title = document.createElement('div');
    title.style.fontSize = '24px';

    // モード（フェーズD-20。説明書p4）。1列の縦並び＝原作のモード選択と同じ並び方で、
    // それぞれ何が起きるか（相手はCPUか人間か・どちらのパッドがどちらの側か）を添える。
    const modeGrid = document.createElement('div');
    modeGrid.style.cssText = PARK_GRID_STYLE;
    modeGrid.style.gridTemplateColumns = '460px';
    const modeCells = MODES.map((m) => {
      const cell = document.createElement('div');
      cell.style.cssText = CELL_BASE_STYLE;
      cell.style.whiteSpace = 'pre';
      cell.style.lineHeight = '1.5';
      cell.textContent = `${m.label}\n${m.note}`;
      modeGrid.appendChild(cell);
      return cell;
    });

    const grid = document.createElement('div');
    grid.style.cssText = GRID_STYLE;
    const cells = TEAMS.map((team) => {
      const cell = document.createElement('div');
      cell.style.cssText = CELL_BASE_STYLE;
      cell.textContent = team.name;
      grid.appendChild(cell);
      return cell;
    });

    // 球場（フェーズC-14）。**距離を名前と一緒に出す**のは、球場選びが
    // 「長打力の球団か俊足の球団か」の判断そのものだから（説明書p24-25）。
    const parkGrid = document.createElement('div');
    parkGrid.style.cssText = PARK_GRID_STYLE;
    const parkCells = BALLPARKS.map((p) => {
      const cell = document.createElement('div');
      cell.style.cssText = CELL_BASE_STYLE;
      cell.style.whiteSpace = 'pre';
      cell.style.lineHeight = '1.5';
      cell.textContent = `${p.name}\nセンター ${p.center}m\nリョウヨク ${p.wing}m`;
      parkGrid.appendChild(cell);
      return cell;
    });

    const { staffGrid, orderList } = planEditor;

    // 選んだカードは常時見えるようにしておく（後攻を選んでいる最中に先攻を忘れない）
    const card = document.createElement('div');
    card.style.cssText = 'margin-top: 8px; font-size: 20px; line-height: 1.6; text-align: center;';

    const hint = document.createElement('div');
    hint.style.cssText = 'margin-top: 20px; font-size: 15px; opacity: 0.8;';

    overlay.append(title, modeGrid, grid, parkGrid, staffGrid, orderList, card, hint);
    root.appendChild(overlay);

    function teamName(id: TeamId): string {
      return TEAMS.find((t) => t.id === id)?.name ?? '';
    }

    function parkName(id: BallparkId): string {
      return BALLPARKS.find((p) => p.id === id)?.name ?? '';
    }

    /** いま采配（先発・打順）を決めている側の球団。1P PLAY では人間が操作する側 */
    function planTeamId(): TeamId {
      return planSide === 'away' ? away : home;
    }

    /** 采配の段の見出しに付ける操作者（2P PLAY のときだけ。誰の番かが分からないと押せない） */
    function planOwnerLabel(): string {
      if (mode === '1p') return '';
      return `${PLAYER_LABEL[planSide === 'away' ? 'p1' : 'p2']} `;
    }

    function render(): void {
      const onTeamGrid = step === 'away' || step === 'home';
      modeGrid.style.display = step === 'mode' ? 'grid' : 'none';
      grid.style.display = onTeamGrid ? 'grid' : 'none';
      parkGrid.style.display = step === 'park' ? 'grid' : 'none';
      planEditor.render(step === 'starter' || step === 'order' ? step : null, cursor);
      title.textContent =
        step === 'mode'
          ? 'モード ヲ エラベ'
          : step === 'away'
            ? 'センコウ ノ チーム ヲ エラベ'
            : step === 'home'
              ? 'コウコウ ノ チーム ヲ エラベ'
              : step === 'park'
                ? 'キュウジョウ ヲ エラベ'
                : step === 'side'
                  ? 'ソウサ スル チーム ヲ エラベ'
                  : step === 'starter'
                    ? `${planOwnerLabel()}センパツ ピッチャー ヲ エラベ`
                    : `${planOwnerLabel()}ダジュン ヲ キメロ`;
      modeCells.forEach((cell, i) => {
        const active = step === 'mode' && i === cursor;
        cell.style.borderColor = active ? '#ffe066' : 'transparent';
        cell.style.color = active ? '#ffe066' : '#fff';
      });
      cells.forEach((cell, i) => {
        const active = onTeamGrid && i === cursor;
        cell.style.borderColor = active ? '#ffe066' : 'transparent';
        cell.style.color = active ? '#ffe066' : '#fff';
      });
      parkCells.forEach((cell, i) => {
        const active = step === 'park' && i === cursor;
        cell.style.borderColor = active ? '#ffe066' : 'transparent';
        cell.style.color = active ? '#ffe066' : '#fff';
      });

      // 決まった側だけを出す（先攻を選ぶ段階では、まだ何も決まっていない）
      const lines: string[] = [];
      const decided = step !== 'mode';
      if (decided && step !== 'away') lines.push(`センコウ: ${teamName(away)}`);
      if (decided && step !== 'away' && step !== 'home') lines.push(`コウコウ: ${teamName(home)}`);
      // 球場の紹介文はカーソルが乗っている球場のもの＝決める前に特徴が読める
      if (step === 'park') lines.push(BALLPARKS[cursor].note);
      if (decided && step !== 'away' && step !== 'home' && step !== 'park') {
        lines.push(`キュウジョウ: ${parkName(park)}`);
      }
      if (step === 'side') {
        lines.push(
          `${humanSide === 'away' ? '▶ ' : '　 '}センコウ　　${humanSide === 'home' ? '▶ ' : '　 '}コウコウ`,
        );
      }
      // 先発・打順を決めているのが誰のチームなのかを出す（対戦カードだけだと、
      // 自分がどちらを操作しているのかがこの段階で分からなくなる）。**2P PLAY では
      // どちらのパッドで押すのかまで出す**（画面は1つなので、番が見えないと押せない）。
      if (step === 'starter' || step === 'order') {
        lines.push(`ソウサ: ${planOwnerLabel()}${teamName(planTeamId())}`);
      }
      card.textContent = lines.join('\n');
      card.style.whiteSpace = 'pre';

      // 2P PLAY のときは、その段を動かすキーがどちらのパッドのものかを添える
      // （1P PLAY ではこれまでどおり何も付かない）。
      const owner = ownerOf(step);
      const keys = owner === 'p2' ? 'ヤジルシ/テンキー' : owner === 'p1' ? '1P' : '';
      const prefix = mode === '2p' && keys !== '' ? `[${keys}] ` : '';
      hint.textContent =
        prefix +
        (step === 'mode'
          ? 'W/S デ センタク　　K デ ケッテイ'
          : step === 'side'
            ? '← → デ センタク　　K デ ケッテイ　　J デ モドル'
            : step === 'away'
              ? 'WASD デ センタク　　K デ ケッテイ　　J デ モドル'
              : step === 'order'
                ? !planEditor.picking()
                  ? 'W/S デ センタク　　K デ センシュ ヲ エラブ　　Shift デ ケッテイ　　J デ モドル'
                  : 'W/S デ センタク　　K デ イレカエ　　J デ トリケシ'
                : 'WASD デ センタク　　K デ ケッテイ　　J デ モドル');
    }

    /** グリッドの移動。端では止まる（一巡させると今どこにいるか見失いやすい） */
    function moveCursor(dx: number, dy: number): void {
      if (step === 'side') {
        if (dx !== 0) humanSide = dx < 0 ? 'away' : 'home';
        render();
        return;
      }
      const { columns, count } = gridOf(step, PITCHING_STAFF_SIZE);
      const column = cursor % columns;
      const row = Math.floor(cursor / columns);
      const rows = Math.ceil(count / columns);
      const nextColumn = Math.max(0, Math.min(columns - 1, column + dx));
      const nextRow = Math.max(0, Math.min(rows - 1, row + dy));
      const next = nextRow * columns + nextColumn;
      if (next < count) cursor = next;
      render();
    }

    /**
     * 采配の段へ入る（先発の選び直しから）。**入るたびに采配を初期化する**ので、
     * 球団・操作する側・モードを選び直しても前のチームの打順が残らない。
     */
    function enterPlan(side: TeamSide): void {
      planSide = side;
      planEditor.reset();
      step = 'starter';
      cursor = planEditor.plan.starterIndex;
    }

    /** 采配の段の中で「戻る」先。2P PLAY の後攻の采配からは、先攻の采配へ戻る */
    function planBackStep(): void {
      if (mode === '2p' && planSide === 'home') {
        // 先攻ぶんは決め終わっているので、そこからやり直せるようにする
        // （2人目が納得しないまま試合が始まらないよう、両者ぶん引き返せる形にしてある）
        enterPlan('away');
        return;
      }
      step = mode === '2p' ? 'park' : 'side';
      cursor = mode === '2p' ? BALLPARKS.findIndex((p) => p.id === park) : 0;
    }

    /** 采配を決め終えた（Shift）。2P PLAY で先攻ぶんだけなら、後攻の采配へ移る */
    function commitPlan(): boolean {
      plans = { ...plans, [planSide]: planEditor.plan };
      if (mode === '2p' && planSide === 'away') {
        enterPlan('home');
        render();
        return false;
      }
      return true;
    }

    /** J＝1つ前の段階へ戻る（押し間違いを取り消せないと16球団から選ぶのが怖くなる） */
    function onB(): void {
      if (step === 'away') {
        step = 'mode';
        cursor = MODES.findIndex((m) => m.id === mode);
      } else if (step === 'home') {
        step = 'away';
        cursor = TEAMS.findIndex((t) => t.id === away);
      } else if (step === 'park') {
        step = 'home';
        cursor = TEAMS.findIndex((t) => t.id === home);
      } else if (step === 'side') {
        step = 'park';
        cursor = BALLPARKS.findIndex((p) => p.id === park);
      } else if (step === 'starter') {
        planBackStep();
      } else if (step === 'order') {
        // Jの二役（入替の取り消し／1つ前の段へ）は `PlanEditor.cancel` が握っている
        if (!planEditor.cancel('order')) {
          step = 'starter';
          cursor = planEditor.plan.starterIndex;
        }
      }
      render();
    }

    function onA(): void {
      if (step === 'mode') {
        mode = MODES[cursor].id;
        step = 'away';
        cursor = TEAMS.findIndex((t) => t.id === away);
        render();
        return;
      }
      if (step === 'away') {
        away = TEAMS[cursor].id;
        step = 'home';
        render();
        return;
      }
      if (step === 'home') {
        home = TEAMS[cursor].id;
        step = 'park';
        cursor = BALLPARKS.findIndex((p) => p.id === park);
        render();
        return;
      }
      if (step === 'park') {
        park = BALLPARKS[cursor].id;
        // 2P PLAY は先攻＝1P・後攻＝2Pに固定（原作準拠）なので「操作する側」の段は無く、
        // そのまま先攻の采配へ進む。
        if (mode === '2p') {
          plans = {};
          enterPlan('away');
        } else {
          step = 'side';
        }
        render();
        return;
      }
      if (step === 'side') {
        // 操作する側が決まって初めて「誰の采配か」が決まるので、ここで采配を初期化する
        plans = {};
        enterPlan(humanSide);
        render();
        return;
      }
      if (step === 'starter') {
        planEditor.press('starter', cursor);
        step = 'order';
        cursor = 0;
        render();
        return;
      }
      planEditor.press('order', cursor);
      render();
    }

    // **押下のハンドラは2枚のパッドとも起動時に1回だけ登録する**（フェーズD-20）。
    // 段が進むたびに登録し直すと、同一の押下で新しいハンドラまで走る既知の再入バグを踏む
    // （`input/keyboard.ts` の Set.forEach。PROGRESS.md参照）。どちらのパッドの押下を
    // 受け付けるかは `canAct` が段ごとに判定する＝1P PLAY では2P側のキーは常に無効。
    const offs: (() => void)[] = [];
    function bind(player: PlayerSlot): void {
      const pad = pads[player];
      const guard = (fn: () => void) => () => {
        if (canAct(player)) fn();
      };
      offs.push(pad.onPress('left', guard(() => moveCursor(-1, 0))));
      offs.push(pad.onPress('right', guard(() => moveCursor(1, 0))));
      offs.push(pad.onPress('up', guard(() => moveCursor(0, -1))));
      offs.push(pad.onPress('down', guard(() => moveCursor(0, 1))));
      offs.push(pad.onPress('b', guard(onB)));
      offs.push(pad.onPress('a', guard(onA)));
      // Shift（Select）＝采配を決め終えて試合開始。Kは打順の入替に使っているので、
      // 「決定」は別のキーになる（CLAUDE.mdのキー表のSelect＝メニュー確定/選択）。
      offs.push(
        pad.onPress(
          'select',
          guard(() => {
            if (step !== 'order' || planEditor.picking()) return;
            if (!commitPlan()) return;
            offs.forEach((off) => off());
            root.removeChild(overlay);
            resolve({ mode, away, home, park, humanSide, plans });
          }),
        ),
      );
    }
    bind('p1');
    bind('p2');

    render();
  });
}

/**
 * 試合と試合の間の采配（フェーズV-43。**先発の選び直しと打順の組み直し**）。
 *
 * ⑧が「入れていない」と明記していたもう1つ（リロールと並んでいた「試合ごとの先発の
 * 選び直し」）で、それまで**先発・打順はランの最初に決めたものを5試合ずっと使っていた**
 * ＝R-39でCPUに4人ローテーションが付いた後も、人間側だけが1人の先発を使い続けるという
 * 非対称が残っていた。
 *
 * **画面は試合前のチーム選択（C-15）とまったく同じもの**（同じ `createPlanEditor` から
 * 出す）＝操作も見た目も覚え直さなくていい。違うのは2つだけ：
 *
 * - **投手カードに `ザンリョウ` の行が出る**（疲れている投手だけ）＝「今日は誰に
 *   投げさせるか」の判断材料。無傷の投手には行が出ないので、全員休んでいる試合の
 *   見た目は試合前とまったく同じ。
 * - **能力値がスキル込み・疲れ込みになる**（DD-51の投手陣／EE-52の打線）＝どちらも
 *   `nextGameRoster` で組んだ**同じ1つのロスター**から読む。
 * - **先発の段で J を押しても戻る先が無い**（扉はもう選んでしまっている）＝
 *   抽選画面の段階①と同じ「戻り先が無いのでキャンセル不可」。
 *
 * 決定は Shift（C-15と同じ＝K は打順の入替に使っている）。
 */
export function runRosterPlanSelect(
  root: HTMLElement,
  pad: VirtualPad,
  opts: {
    teamId: TeamId;
    /** 前の試合の采配（ここから始める＝毎回いちから組み直さなくてよい） */
    plan: RosterPlan;
    /** ランが持ち越しているスキル・使った回数・疲れ（`nextGameRoster` にそのまま渡す） */
    carried: CarriedState;
    /** 「2シアイメ ノ センパツ」 */
    headline: string;
  },
): Promise<RosterPlan> {
  return new Promise((resolve) => {
    let step: PlanStep = 'starter';
    const editor = createPlanEditor({ teamId: () => opts.teamId, carried: opts.carried });
    editor.reset(opts.plan);
    let cursor = editor.plan.starterIndex;

    const overlay = document.createElement('div');
    overlay.style.cssText = OVERLAY_STYLE;

    const title = document.createElement('div');
    title.style.fontSize = '24px';

    const card = document.createElement('div');
    card.style.cssText = 'margin-top: 8px; font-size: 20px; line-height: 1.6; text-align: center;';

    const hint = document.createElement('div');
    hint.style.cssText = 'margin-top: 20px; font-size: 15px; opacity: 0.8;';

    overlay.append(title, editor.staffGrid, editor.orderList, card, hint);
    root.appendChild(overlay);

    function render(): void {
      editor.render(step, cursor);
      title.textContent =
        step === 'starter' ? `${opts.headline} センパツ ピッチャー ヲ エラベ` : 'ダジュン ヲ キメロ';
      card.textContent = `${TEAMS.find((t) => t.id === opts.teamId)?.name ?? ''}`;
      hint.textContent =
        step === 'starter'
          ? 'WASD デ センタク　　K デ ケッテイ'
          : !editor.picking()
            ? 'W/S デ センタク　　K デ センシュ ヲ エラブ　　Shift デ ケッテイ　　J デ モドル'
            : 'W/S デ センタク　　K デ イレカエ　　J デ トリケシ';
    }

    function moveCursor(dx: number, dy: number): void {
      const { columns, count } = gridOf(step, PITCHING_STAFF_SIZE);
      const column = cursor % columns;
      const row = Math.floor(cursor / columns);
      const rows = Math.ceil(count / columns);
      const nextColumn = Math.max(0, Math.min(columns - 1, column + dx));
      const nextRow = Math.max(0, Math.min(rows - 1, row + dy));
      const next = nextRow * columns + nextColumn;
      if (next < count) cursor = next;
      render();
    }

    const offs: (() => void)[] = [];
    offs.push(pad.onPress('left', () => moveCursor(-1, 0)));
    offs.push(pad.onPress('right', () => moveCursor(1, 0)));
    offs.push(pad.onPress('up', () => moveCursor(0, -1)));
    offs.push(pad.onPress('down', () => moveCursor(0, 1)));
    offs.push(
      pad.onPress('b', () => {
        // 先発の段のJは何もしない（戻り先が無い＝扉はもう選んでいる）
        if (step === 'order' && !editor.cancel('order')) {
          step = 'starter';
          cursor = editor.plan.starterIndex;
        }
        render();
      }),
    );
    offs.push(
      pad.onPress('a', () => {
        if (step === 'starter') {
          editor.press('starter', cursor);
          step = 'order';
          cursor = 0;
        } else {
          editor.press('order', cursor);
        }
        render();
      }),
    );
    offs.push(
      pad.onPress('select', () => {
        if (step !== 'order' || editor.picking()) return;
        offs.forEach((off) => off());
        root.removeChild(overlay);
        resolve(editor.plan);
      }),
    );

    render();
  });
}
