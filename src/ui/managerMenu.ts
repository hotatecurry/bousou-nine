/**
 * 采配メニュー（代打・継投）。Start（ポーズ）で開き、W/Sでカーソル移動、
 * Select（メニュー確定/選択）で決定、Start再押下でキャンセルして元の場面へ戻る。
 * CLAUDE.mdのキー表「Start=ポーズ」「Select=メニュー確定/選択」をそのまま踏襲した
 * 役割分担（W/S/K/Jはゲーム中の意味と重複させず、ここでは一切使わない）。
 *
 * v1スコープ（PROGRESS.md セッション9）：
 * - 乱闘による強制退場（roster.ts の ejectBatterAndSubstitute/ejectPitcherAndSubstitute）
 *   とは独立した経路。監督采配として任意タイミングで代打（打者側の打席中のみ）／
 *   継投（投手側の守備中のみ）を選べる。呼び出し側（main.ts）は「人間が現在
 *   担っている役割（投球 or 打撃）」に応じてどちらのメニューを開くか決め、
 *   常に人間自身のチームのロスターだけを渡す（相手＝CPU側の采配はスコープ外）。
 * - 候補が0人でも開けるが、選べるのは「キャンセル」だけになる（意思決定材料は隠さない、
 *   という既存方針どおり「今は代われる人がいない」こと自体を見せる）。
 * - フェーズD-18：**候補と「今の選手」を同じ書式の能力値付きで並べる**（代打なら打席の
 *   左右・打率・本塁打数、継投なら型・残りスタミナ）。交代は差の大小の判断なので、
 *   比べる相手が見えていないと選べない。
 * - フェーズDD-51／EE-52：**どちらも「1行1人の表」にする**（継投＝型・残量・球速・変化量・
 *   制球／代打＝BOX・AV・HR・走力）。行ごとに長さの違う文章では**縦に並べても列で
 *   比べられない**＝交代の判断が「差の大小」である以上、揃っていることが表示の要件になる。
 * - フェーズB-10：**交代の結果どうなるかを見出しに出す**（何番・どの守備位置の交代なのか、
 *   投手の打席なら自動継投で誰がマウンドへ上がるのか）。代打は退いた選手の守備位置を
 *   そのまま引き継ぐので、「誰を出すか」は打撃だけでなく守りの決定でもある＝押す前に
 *   見えている必要がある（上と同じ「意思決定材料は隠さない」方針）。
 */
import {
  type PlayerId,
  type TeamRoster,
  BATTER_STAT_HEADERS,
  batterStatCells,
  canPinchHit,
  canPinchRun,
  currentBatterPosition,
  effectiveBatting,
  effectivePitching,
  fatigueOf,
  isHot,
  isPitcherAtBat,
  padName,
  positionLabel,
  pitcherRole,
  pitcherStuffOf,
  ratingBar,
  remainingStaminaOf,
  skillsOf,
} from '../core/roster';
import { skillDef } from '../core/skills';
import { type Bases, forceAdvance } from '../core/rules';
import type { VirtualPad } from '../input/keyboard';
import { applyPanelChrome } from './hud/hud';
import { createPixelLabel, uiScale } from './hud/pixelText';
import { sfx } from '../audio/sfx';

export type ManagerMenuRole = 'batting' | 'pitching';

export type ManagerMenuChoice =
  /** 代打/継投。index は roster.bench または roster.bullpen の添字 */
  | { kind: 'substitute'; index: number }
  /** 敬遠（フェーズQ-38。守備側のメニューにだけ並ぶ） */
  | { kind: 'intentionalWalk' }
  /** 代走（フェーズGG-54。打者側のメニューにだけ並ぶ）。index は roster.bench の添字 */
  | { kind: 'pinchRun'; base: 'first' | 'second' | 'third'; index: number };

/**
 * 代走（フェーズGG-54）の対象になる走者1人ぶん。**采配メニューは自分のロスターしか
 * 受け取らない**が、**塁の上に誰がいるかを持っているのは `gameMachine` の `baseRunners`**
 * （B-8）なので、敬遠（`IntentionalWalkTarget`）と同じく呼び出し側から渡す。
 */
export interface PinchRunTarget {
  base: 'first' | 'second' | 'third';
  /** その塁の走者。ロスターから引ける選手だけを渡す（無名の走者は代走を送れない） */
  runnerId: PlayerId;
}

/**
 * 敬遠（フェーズQ-38）の表示に要る相手の情報。**采配メニューは自分のロスターしか
 * 受け取らない**（相手の采配は触れないという既存の切り分け）ので、歩かせる相手の名前と
 * 塁状況だけを呼び出し側から渡す。
 */
export interface IntentionalWalkTarget {
  /** いま打席にいる相手打者の名前 */
  batterName: string;
  /** 相手の次打者の名前（敬遠は「この打者を避けて次と勝負する」手なので判断材料になる） */
  nextBatterName: string;
  bases: Bases;
}

// 背景の暗幕は 0.93（フェーズD-18で 0.82 から上げた）。下部に打者・投手カードが常時出る
// ようになり、薄い暗幕だとメニューの操作ヒントがカードの文字と重なって読みにくかった。
const OVERLAY_STYLE = `
  position: fixed;
  inset: 0;
  z-index: 30;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 32, 0.93);
`;

/**
 * 行頭のマーク欄（カーソル／選ばれていない項目／「イマ」）。
 *
 * **全角2文字ぶんに揃える**：メニューは1行1人の「表」なので、`▶`・空白・`イマ` の3つが
 * **同じ幅**でなければ、縦に並べた能力値の列が揃わず**比べるための表示にならない**
 * （`イマ` は全角2文字＝`▶ ` より半角1つぶん広い）。
 *
 * DD-51 では継投だけがこの形で、代打は1行が文章だったので従来のマーク（`▶ `）のままだった。
 * **EE-52で代打も表になった**ので、役割で分ける理由がなくなり1つに畳んだ。
 */
const MARKS = { on: '▶　', off: '　　', current: '現在' } as const;

/** 候補一覧のドット絵の拡大率（原寸16px。画面全体の倍率 `uiScale` が上に掛かる） */
const MENU_SCALE = 1;

/** 「(Nバン SS)」＝今の打席が打順の何番で、その選手がどこを守っているか */
function describeBattingSlot(roster: TeamRoster): string {
  const position = currentBatterPosition(roster);
  // 代打が入ったばかりの打順（投手の打席への代打）は守備位置を持たないので打順だけ出す
  return position === null
    ? `（${roster.lineupIndex + 1}番）`
    : `（${roster.lineupIndex + 1}番 ${positionLabel(position)}）`;
}

/** 「(9バン P)」＝継投すると打線のどのスロットが入れ替わるか（原作にDH制は無い） */
function describePitcherSlot(roster: TeamRoster): string {
  return `（${roster.pitcherSlot + 1}番 投手）`;
}

/**
 * 継投の表（フェーズB-11の型・残量＋フェーズDD-51の球の中身）。**1行＝1人**で、列は
 * 名前／型／残量／**いまの球3つ**（疲労込みの球速・変化量・制球＝Z-47でCPUの継投が
 * 比べている `pitcherQualityOf` の、足す前の3つ）。
 *
 * 型と残量が要る理由（B-11）：「今の投手はもう球威が落ちている」「次に出すのは短い回しか
 * 持たないリリーフ型」の両方が押す前に分かる必要がある。
 *
 * 球の中身が要る理由（DD-51）：ここが無い間、**継投は攻守で見ているものが違った**
 * ＝CPUは疲労込みの質を比べて「代えるか続投か」を決めるのに、人間の采配メニューには
 * 型と残量%しか出ておらず、**ブルペン候補の球速・変化量・ERAは試合中どこにも出ていな
 * かった**（HUDの投手カードはいまマウンドにいる1人ぶんしか出せない）。残量だけでは
 * 「疲れたエースと無傷の格下、どちらが良い球を投げるか」が読めない＝Z-47が作った判断が
 * 人間側にだけ材料なしで置かれていた（既存の「意思決定材料は隠さない」方針の穴）。
 *
 * **合計値（0..3）は出さない**（ユーザー判断）：CPUの結論そのものを1本のバーで出すと、
 * 継投がバーの長さ比べになる。3つに分けておけば「速いが荒れる」「曲がらないが制球は
 * 落ちない」といった中身の違いが読め、どれを取るかは人間の判断のまま残る。計測
 * （`balance:relief` の7段目）でも、**バーが同じ長さに見える場面（6.1%）は実差が
 * 1目盛りに満たない**＝そこはまさに「中身で選ぶ」場面になっている。
 *
 * 目盛り（`ratingBar`）と語彙（キュウソク/ヘンカ）と名前の幅（`padName`）は**先発選択
 * 画面と同じもの**を使う＝試合前に見た投手陣の姿と、試合中の継投の画面が同じ物差しで並ぶ。
 *
 * **表（1行1人）にしたのは実機の計測から**：3つを候補ごとに2行目として並べる形は、
 * 960x540 で**メニューが画面から溢れた**（14行＝タイトルとヒントが切れる／1行939px）。
 * 列に畳めば9行・約820pxに収まり、**縦に並んだ同じ列を目で比べられる**というおまけも付く。
 */
const STUFF_HEADERS = ['球速　　　', '変化　　　', '制球　　　'] as const;

/**
 * 表の1行。**見出しも「イマ」も候補もこの関数を通す**ので、列が縦にずれることが起きない。
 * 行頭の空白1つはマーク欄との区切り（無いと `イマ` と名前がつながって
 * `イマイソガイ` という1語に読める。実機で踏んだ）。
 */
function pitcherRow(name: string, role: string, stamina: string, cells: readonly string[]): string {
  return ` ${padName(name)} ${role} ${stamina.padStart(4, ' ')} ${cells.join(' ')}`;
}

/** 列の見出し（名前・型・残量の欄は空けて、バーの列にだけ名前を付ける） */
function pitcherHeaderRow(): string {
  return pitcherRow('', '　　', '', STUFF_HEADERS);
}

/**
 * 継投の候補1人ぶん。DOMに触らない純粋関数なのでテストから直接呼ぶ
 * （`hud.ts` の `pitcherCardText` と同じ扱い）。
 */
export function describePitcherEntry(roster: TeamRoster, id: PlayerId): string {
  // スキルの補正込みで読む（フェーズF-26-1）。`タフネス` はSTMへの補正なので、
  // **型（先発/リリーフ）の導出まで一緒に動く**＝表示と実際の持ち球数が食い違わない。
  const stats = effectivePitching(roster, id);
  const role = stats && pitcherRole(stats.stamina) === 'starter' ? '先発' : '救援';
  const { speed, breaking, control } = pitcherStuffOf(roster, id);
  return pitcherRow(
    roster.players[id].name,
    role,
    `${Math.round(remainingStaminaOf(roster, id) * 100)}%`,
    [ratingBar(speed), ratingBar(breaking), ratingBar(control)],
  );
}

/**
 * 代打の表（フェーズD-18の打席の左右・打率・本塁打数＋フェーズEE-52の走力）。
 * **1行＝1人**で、列は 名前／BOX／AV／HR／ソウリョク／（好調・スキルの但し書き）。
 *
 * 打撃の数値が要る理由（D-18）：**控え野手は打席に立つまで能力が見えない**ので、
 * 「一発のある代打」と「代走向きの俊足」の区別が押す前に付かなかった（HUDの打者カードは
 * 今打っている選手のものしか出せない）。表記はHUDの打者カードと同じ記号（説明書p26-29の
 * AV/HR）で揃え、打席の左右（BOX）も添える＝両打ちなら相手投手と逆の打席に立つので、
 * 誰を出すかの判断に効く（B-9の `effectiveBattingHand`）。
 *
 * 走力が要る理由（EE-52）：D-18は「4項目並べると1行が長くなる」ので走力を落としたが、
 * **代打はそのまま走者になる**（v1に代走は無い）ので、盗塁（A-7）・打球での余分な進塁
 * （X-45）・挟殺（K-31）まで含めると走力は代打の判断そのもの。表に畳めば**列が1つ増える
 * だけ**で、しかも走力は**試合中に数字がどこにも出ない唯一の能力値**だった。
 *
 * **好調（フェーズD-19）はここに出して初めて采配になる**：控えの絶好調選手はHUDの打者
 * カードに一度も出てこない（カードは今打っている選手のものしか出せない）ので、
 * 見せなければ「今日あたっている代打を送る」という判断が永久に成立しない。
 * AV/HR の数字も好調込みで動くので、**上がった数字とその理由が同じ行に並ぶ**。
 *
 * 列の見出し・目盛り・名前の幅は**打順の表（`teamSelect.ts`）と同じもの**を使う
 * （`BATTER_STAT_HEADERS`／`batterStatCells`／`padName`）＝試合前に見た打線の姿と、
 * 試合中の代打の画面が同じ物差しで並ぶ（DD-51が投手側でやったのと同じ）。
 */
function batterRow(name: string, bats: string, cells: readonly string[], tail = ''): string {
  return ` ${padName(name)} ${bats} ${cells.join(' ')}${tail}`;
}

/** 列の見出し（名前・BOXの欄は空けて、能力値の列にだけ名前を付ける） */
function batterHeaderRow(): string {
  return batterRow('', ' ', BATTER_STAT_HEADERS);
}

/**
 * 代打の候補1人ぶん。DOMに触らない純粋関数なのでテストから直接呼ぶ
 * （`describePitcherEntry`・`hud.ts` の `batterCardText` と同じ扱い）。
 */
export function describeBatterEntry(roster: TeamRoster, id: PlayerId, inning?: number): string {
  const stats = effectiveBatting(roster, id, inning);
  const owned = skillsOf(roster, id);
  const skills = owned.length === 0 ? '' : ` ${owned.map((s) => skillDef(s).name).join(' ')}`;
  const hot = isHot(roster, id, inning) ? ' 絶好調' : '';
  return batterRow(roster.players[id].name, stats.bats, batterStatCells(stats), `${hot}${skills}`);
}

/**
 * 代走の行（フェーズGG-54）。**1枚目に「いま塁にいる走者とその足」を出す**のがこの行の
 * 役目で、これが無いと**代えるべき走者がいるのかどうかを見るために1回入ってみるしかない**
 * （敬遠の行が「押した結果」をその場に出しているのと同じ「意思決定材料は隠さない」）。
 *
 * 走力だけをバーで添えるのは FF-53 と同じ理由＝**走力は表示用の実数値を持たない唯一の
 * 能力値**なので、ここで数値を作ると同じ選手が画面ごとに違う物差しで出る。塁の番号
 * （1/2/3）も FF-53 の状況パネル・L-32 のリードの行と同じ並びに揃える。
 */
export function describePinchRunTarget(roster: TeamRoster, target: PinchRunTarget): string {
  const base = { first: 1, second: 2, third: 3 }[target.base];
  const stats = effectiveBatting(roster, target.runnerId);
  return `代走 ${base}塁 ${roster.players[target.runnerId].name} 走力${ratingBar(stats.run)}`;
}

/** 塁状況の短い表記（敬遠の結果を1行で見せるため） */
function describeBases(bases: Bases): string {
  const names = [bases.first ? '一' : '', bases.second ? '二' : '', bases.third ? '三' : '']
    .filter(Boolean);
  if (names.length === 0) return '走者なし';
  if (names.length === 3) return '満塁';
  return `${names.join('・')}塁`;
}

/**
 * 敬遠の行（フェーズQ-38）。**押した結果をその場に出す**のがこの行の役目：
 * 誰が歩いて塁がどうなるか、満塁なら押し出しで1点入ることまで見えていないと、
 * 「歩かせる」という判断そのものが成立しない（既存の「意思決定材料は隠さない」方針）。
 * 結果は `forceAdvance`（四球・死球と同じ純粋関数）から起こすので、**表示と実際に
 * 起きることが同じ規則から出る**。
 */
function describeIntentionalWalk(target: IntentionalWalkTarget): string {
  const { bases, runs } = forceAdvance(target.bases);
  const after = runs > 0 ? `押し出し${runs}点` : describeBases(bases);
  return `敬遠 ${target.batterName}→${after} 次:${target.nextBatterName}`;
}

/**
 * メニューを開いて選択完了まで待つ。resolve される値は選ばれた采配、
 * キャンセルなら null（呼び出し側は何もしない）。
 */
export function runManagerMenu(
  root: HTMLElement,
  pad: VirtualPad,
  opts: {
    role: ManagerMenuRole;
    roster: TeamRoster;
    /** 現在のイニング（フェーズD-19。ラッキー7なら候補も現打者も全員が好調になる） */
    inning?: number;
    /**
     * 敬遠の相手（フェーズQ-38）。**守備側のメニューでだけ渡す**＝渡さなければ
     * 行そのものが出ない（打者側のメニューは従来とまったく同じ見た目のまま）。
     */
    intentionalWalk?: IntentionalWalkTarget;
    /**
     * 代走の対象になる走者（フェーズGG-54）。**打者側のメニューでだけ渡す**＝渡さなければ
     * 行そのものが出ない（走者がいない打席のメニューはGG-54の前とまったく同じ）。
     * 並びは本塁に近い順（三塁→二塁→一塁）でも塁の番号順でも呼び出し側の自由だが、
     * 実際には FF-53 の状況パネルと同じ 1→2→3 の順で渡す。
     */
    pinchRun?: readonly PinchRunTarget[];
  },
): Promise<ManagerMenuChoice | null> {
  return new Promise((resolve) => {
    const { role, roster, inning, intentionalWalk } = opts;
    const pinchRun = opts.pinchRun ?? [];
    /**
     * いま何を選んでいる段か（フェーズGG-54で2段階になった）。
     *
     * **1段目＝何をするか**（代打/継投の候補・代走の対象・敬遠）、**2段目＝代走を誰に
     * 出すか**。C-15の打順入替（選手を選んでK→打順を選んでK）・F-26-1の抽選（札→選手）と
     * 同じ2段階の操作体系で、**2段目の J は1つ前へ戻る**。
     *
     * 代打を1段階のまま据え置いているのは、代打には「誰と代えるか」の選択が無い
     * （今の打者と決まっている）から＝段を増やしても押す回数が増えるだけになる。
     */
    type Stage = { kind: 'main' } | { kind: 'pinchRun'; target: PinchRunTarget };
    let stage: Stage = { kind: 'main' };
    let cursor = 0;
    interface Item {
      label: string;
      choice: ManagerMenuChoice | null;
    }
    let items: Item[] = [];
    let notes: string[] = [];
    let candidates: PlayerId[] = [];

    /** その段の見出し・候補・「イマ」の行を組み直す（段が変わるたびに呼ぶ） */
    function buildStage(): void {
      if (stage.kind === 'pinchRun') {
        // 2段目：代走を誰にするか。**候補の表は代打とまったく同じ `batterRow`** なので、
        // 「打つ力で選ぶか、足で選ぶか」を同じ物差しで比べられる（EE-52の走力の列）。
        const target = stage.target;
        candidates = canPinchRun(roster, target.runnerId) ? roster.bench : [];
        title.setText(`作戦: ${describePinchRunTarget(roster, target)}`);
        notes = [
          `${MARKS.off}${batterHeaderRow()}`,
          `${MARKS.current}${describeBatterEntry(roster, target.runnerId, inning)}`,
        ];
        // 投手に代走を出すと自動継投になる（＝先発が降りる）。代打とまったく同じ代償なので、
        // 代打と同じ書式で押す前に見せる。
        if (candidates.length > 0 && target.runnerId === roster.pitcher) {
          notes.push(`自動で投手交代: ${roster.players[roster.bullpen[0]].name}`);
        }
        items = candidates.map((id, index) => ({
          label: describeBatterEntry(roster, id, inning),
          choice: { kind: 'pinchRun', base: target.base, index },
        }));
        items.push({ label: 'やめる', choice: null });
        cursor = 0;
        return;
      }

      // 1段目。代打は「投手の打席でブルペンが尽きている」と送れない（守備位置Pを
      // 埋められないため。roster.ts の substituteBatterAt 参照）。その場合は候補なしとして
      // 見せる＝選べない選択肢を並べて押させない。
      candidates = role === 'batting' ? (canPinchHit(roster) ? roster.bench : []) : roster.bullpen;
      title.setText(
        role === 'batting'
          ? `作戦: 代打 ${describeBattingSlot(roster)}`
          : `作戦: 投手交代 ${describePitcherSlot(roster)}`,
      );
      // 候補には判断に効く能力値を併記する：継投なら型・残量・球の中身（B-11／DD-51）、
      // 代打なら打席の左右・打率・本塁打数・走力（D-18／EE-52）。投手にスタミナ、打者に打撃と
      // 出し分けているのは、控え野手はマウンドに立たない＝スタミナが判断に効かないため。
      const names = candidates.map((id) =>
        role === 'pitching'
          ? describePitcherEntry(roster, id)
          : describeBatterEntry(roster, id, inning),
      );
      // 項目は「候補（代打/継投）→ 代走 → 敬遠 → キャンセル」の1本のリストにまとめる。
      // 選ばれたときに何を返すかを項目自身が持つので、カーソル位置と意味の対応が
      // 添字の計算に依存しない（代走・敬遠を足しても「キャンセルは最後の1つ」が壊れない）。
      items = names.map((label, index) => ({ label, choice: { kind: 'substitute', index } }));
      // 代走は**塁に走者がいて、その走者に代走を送れるときだけ**並べる（送れない走者の行を
      // 並べても押せる先が無い＝「候補なし」の2段目へ入るだけになる）。
      for (const target of pinchRun) {
        if (!canPinchRun(roster, target.runnerId)) continue;
        items.push({
          label: describePinchRunTarget(roster, target),
          // 1段目の代走の行は「2段目へ進む」だけなので、選ばれた値そのものは持たない。
          // `select` のハンドラが段の切り替えとして扱う（下の `advance`）。
          choice: { kind: 'pinchRun', base: target.base, index: -1 },
        });
      }
      if (intentionalWalk) {
        items.push({
          label: describeIntentionalWalk(intentionalWalk),
          choice: { kind: 'intentionalWalk' },
        });
      }
      items.push({ label: 'キャンセル', choice: null });
      // 「イマ」＝今その役をやっている選手を**候補とまったく同じ列**で出す（D-18で置き、
      // DD-51で継投を、EE-52で代打を表にした）＝比べる相手が同じ書式で並んでいなければ
      // 「替えるか続けるか」は選べない。マークの欄（候補と同じ幅の `イマ`）に居場所が
      // あるので、見出し・イマ・候補の列はすべて縦に揃う。
      notes = [];
      if (role === 'pitching') {
        // `キュウイダウン` の断り書きは残す：3本のバーは落ちた後の値なので、
        // **落ちているのか元からその程度なのか**はバーだけからは読めない。
        const id = roster.pitcher;
        notes.push(
          `${MARKS.off}${pitcherHeaderRow()}`,
          `${MARKS.current}${describePitcherEntry(roster, id)}${
            fatigueOf(roster, id) > 0 ? ' 球威ダウン' : ''
          }`,
        );
      } else {
        const current = roster.lineup[roster.lineupIndex];
        notes.push(
          `${MARKS.off}${batterHeaderRow()}`,
          `${MARKS.current}${describeBatterEntry(roster, current, inning)}`,
        );
        // 投手の打席への代打は自動継投を伴う（＝ブルペンを1人使う）ので、それも押す前に見せる。
        if (candidates.length > 0 && isPitcherAtBat(roster)) {
          notes.push(`自動で投手交代: ${roster.players[roster.bullpen[0]].name}`);
        }
      }
      cursor = 0;
    }

    const overlay = document.createElement('div');
    overlay.style.cssText = OVERLAY_STYLE;

    const title = createPixelLabel('', { scale: 2, color: '#ffe066' });
    applyPanelChrome(title.el);
    title.el.style.marginBottom = '10px';

    const list = createPixelLabel('', { scale: MENU_SCALE, color: '#f8f8f8' });
    applyPanelChrome(list.el);

    const hint = createPixelLabel('W/S:移動 Select:決定 Start:戻る', {
      scale: 1,
      color: '#cccccc',
    });
    Object.assign(hint.el.style, {
      marginTop: '10px',
      background: 'transparent',
      border: 'none',
      boxShadow: 'none',
    });

    overlay.append(title.el, list.el, hint.el);
    root.appendChild(overlay);

    function render(): void {
      const body = items
        .map(({ label }, i) => `${i === cursor ? MARKS.on : MARKS.off}${label}`)
        .join('\n');
      // 候補が無いときも「イマ」の行は出す（今の状態が分かったうえで代われないことが
      // 分かる＝「意思決定材料は隠さない」方針）。
      const head = [...notes, ...(candidates.length === 0 ? ['（候補なし）'] : [])]
        .map((line) => `${line}\n`)
        .join('');
      const text = `${head}${body}`;
      list.setText(text, { scale: MENU_SCALE });
      // **画面に収まる整数倍まで落とす**（フェーズDD-51）。継投は3本のバーで横に長くなり、
      // 960より狭い窓では scale 3 だと**カーソル記号ごと切れる**（実機で踏んだ：800x600 で
      // 左の `▶` と右の セイキュウ の列が消えた＝どれを選んでいるのか分からなくなる）。
      // 縮めるのは整数倍のまま（ドット絵の拡大はいつも整数倍＝②の約束）。
      // **代打側にも同じ保険が効く**：スキルを4つ持つ控えの行はもともと画面より長い。
      const fit = Math.max(1, Math.floor(root.clientWidth / (list.el.width * uiScale())));
      if (fit < MENU_SCALE) list.setText(text, { scale: fit });
      // 2段目だけ「J＝1つ前へ戻る」を案内する（1段目の J は戻り先が無いので何も起きない
      // ＝押せない操作を案内しない。抽選画面の段階①・V-43の先発の段と同じ扱い）。
      hint.setText(
        stage.kind === 'main'
          ? 'W/S:移動 Select:決定 Start:戻る'
          : 'W/S:移動 Select:決定 J:戻る',
      );
    }
    buildStage();
    render();

    function close(result: ManagerMenuChoice | null): void {
      offUp();
      offDown();
      offSelect();
      offStart();
      offBack();
      root.removeChild(overlay);
      resolve(result);
    }

    const offUp = pad.onPress('up', () => {
      sfx.menuMove();
      cursor = (cursor - 1 + items.length) % items.length;
      render();
    });
    const offDown = pad.onPress('down', () => {
      sfx.menuMove();
      cursor = (cursor + 1) % items.length;
      render();
    });
    const offSelect = pad.onPress('select', () => {
      const choice = items[cursor].choice;
      if (choice === null) sfx.menuCancel();
      else sfx.menuConfirm();
      // 1段目の代走の行（`index: -1`）だけは「決定」ではなく**2段目へ進む**
      // （C-15の打順入替が「選手を選んでK→打順を選んでK」の2段階なのと同じ）。
      if (choice !== null && choice.kind === 'pinchRun' && choice.index < 0) {
        const target = pinchRun.find((t) => t.base === choice.base);
        if (target) {
          stage = { kind: 'pinchRun', target };
          buildStage();
          render();
        }
        return;
      }
      close(choice);
    });
    const offStart = pad.onPress('start', () => {
      sfx.menuCancel();
      close(null);
    });
    // J は2段目でだけ意味を持つ（1つ前へ戻る）。1段目では戻り先が無いので何もしない。
    const offBack = pad.onPress('b', () => {
      if (stage.kind === 'main') return;
      sfx.menuCancel();
      stage = { kind: 'main' };
      buildStage();
      render();
    });
  });
}
