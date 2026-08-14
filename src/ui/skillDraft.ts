/**
 * スキル抽選の3択画面（フェーズF-26-1。CLAUDE.md ⑧ローグライト要素）。
 *
 * **選択は2段階**：①3つのスキルから1つ選ぶ → ②付ける選手を選ぶ。
 * C-15の打順入替（選手を選んでK→打順を選んでK）と同じ2段階の操作体系で、
 * **どちらの段階も W/S で選び K で決定、J で1つ前へ戻る**。
 *
 * 2段階にしているのは、**「誰に付けるか」がこのローグライトの中心的な判断だから**
 * （CLAUDE.md ⑧「枠の奪い合い」「デュオ」）。スキルと選手を1つの組として提示すると、
 * 「4番に2つ目を積むか、空いている7番に付けるか」という選択が消えてしまう。
 *
 * トーン（CLAUDE.md ⑧）：**画面は真面目な野球ゲームの見た目のまま**にする。
 * 采配メニュー（`managerMenu.ts`）と同じドット絵パネル・同じ配色・同じ操作ヒントで、
 * 中身だけが `ラントウデ ヒッサツワザ` になっている、という落差そのものが狙い。
 *
 * ## リロール（フェーズU-42）
 *
 * **段階①の J はもともと空いていた**（戻り先が無いのでキャンセル不可）ので、そこへ
 * 「まるごと引き直す」を入れた＝**新しいキーは1つも増えていない**（M-33がGの空きスロットへ
 * 一時効果を入れたのと同じ切り分け）。段階②の J は従来どおり「1つ前へ戻る」。
 */
import {
  type SkillDraft,
  type SkillId,
  type SkillLineage,
  LINEAGE_NAME,
  MAX_SKILLS_PER_PLAYER,
  eligibleHolders,
  rarityStars,
  skillDef,
} from '../core/skills';
import {
  type PlayerId,
  type TeamRoster,
  chargesLeftOf,
  liveSkillsOf,
  positionOf,
  skillHoldersOf,
} from '../core/roster';
import type { VirtualPad } from '../input/keyboard';
import { applyPanelChrome } from './hud/hud';
import { createPixelLabel } from './hud/pixelText';

export interface SkillDraftChoice {
  skillId: SkillId;
  playerId: PlayerId;
}

/**
 * 段階②で一度に見せる選手の数（フェーズF-26-1）。
 *
 * 候補は最大で**17人**（打順9＋ブルペン5＋控え3）あり、全部並べると 800x600 では
 * 画面をはみ出してスコアボード・打者カードの上に重なった（実機検証で確認）。D-18で
 * 詰めた「パネル同士が重ならない」配置を、この画面が壊してはいけない。
 *
 * そこで**カーソルに追従する窓**にして、パネルの高さを候補の人数によらず固定する。
 * 8人は「打順9人がほぼ一望できる」下限で、これ以上減らすと打線を見渡しながら
 * 選べなくなる（＝誰に付けるかの判断がしづらくなる）。
 */
const VISIBLE_CANDIDATES = 8;

// 采配メニューと同じ暗幕（同じ「試合を止めて選ぶ画面」なので見た目を揃える）
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

/** 「4バン 1B ヤマダ」＝どの打順・守備位置の誰か（采配メニューの見出しと同じ粒度） */
function describePlayer(roster: TeamRoster, id: PlayerId): string {
  const name = roster.players[id].name;
  const position = positionOf(roster, id);
  const order = roster.lineup.indexOf(id);
  const slot = order >= 0 ? `${order + 1}バン` : 'ヒカエ';
  return `${slot}${position ? ` ${position}` : ''} ${name}`;
}

/**
 * 「(1/2) スケボー」＝その選手が今いくつ持っていて、何を持っているか。
 * **押す前に見えている必要がある**（既存の「意思決定材料は隠さない」方針）：
 * 枠の残りはこのゲームの中心的な資源で、デュオの前提が揃うかもここで読む。
 */
function describeSkills(roster: TeamRoster, id: PlayerId): string {
  // **使い切った消費型は数えない**（フェーズF-26-8）＝枠の表示が実際の空きと一致する。
  // 残りチャージも出すのは、**強化デュオの前提が生きているかがここでしか読めない**ため
  // （使い切っていれば強化版はもう出ない＝この選手に集める意味が変わる）。
  const owned = liveSkillsOf(roster, id);
  const names = owned
    .map((s) => {
      const left = chargesLeftOf(roster, id, s);
      return left > 0 ? `${skillDef(s).name}${left}` : skillDef(s).name;
    })
    .join(' ');
  return `(${owned.length}/${MAX_SKILLS_PER_PLAYER})${names ? ` ${names}` : ''}`;
}

/** 「★★☆☆ ボウリョク ショウリュウケン」＝レアリティ・系統・名前 */
function describeSkill(skillId: SkillId): string {
  const def = skillDef(skillId);
  return `${rarityStars(def.rarity)} ${LINEAGE_NAME[def.lineage]} ${def.name}`;
}

/**
 * 抽選画面を開いて選択完了まで待つ。
 *
 * **キャンセルできない**（采配メニューと違い、必ず1つ選んで閉じる）。取らない選択に
 * 意味が無い＝スキルを取らないことでリターンが増える場面が無いため、選択肢に置くと
 * ただの手数になる。候補が1つも無ければ呼び出し側が開かない。
 */
export function runSkillDraft(
  root: HTMLElement,
  pad: VirtualPad,
  opts: {
    draft: SkillDraft;
    roster: TeamRoster;
    teamName: string;
    /**
     * この試合で候補に出る系統（フェーズF-26-5）。**見出しに出す**のは、絞り込みが
     * 隠れていると「なぜこの系統ばかり出るのか」が分からず、デュオを揃えにいく判断が
     * できないため（既存の「意思決定材料は隠さない」方針）。
     */
    lineages?: readonly SkillLineage[];
    /**
     * リロール（フェーズU-42）。**押されたら呼び出し側が引き直して新しい3択を返す**
     * （画面は閉じない）。引き直せなかった（回数券が尽きた）ときは `null` を返す。
     *
     * 抽選そのものを持たせない（`drawSkillDraft` をここから呼ばない）のは、
     * **乱数の状態も回数券も `gameMachine` の側にある**ため＝UIは「押された」ことだけを
     * 伝え、何が起きるかは状態を持つ側が決める（`SKILL_GRANTED` と同じ切り分け）。
     */
    reroll?: () => { draft: SkillDraft; left: number } | null;
    /** 残りのリロール回数（**押す前に見えている**＝意思決定材料は隠さない） */
    rerollsLeft?: number;
  },
): Promise<SkillDraftChoice> {
  return new Promise((resolve) => {
    const { roster, teamName, lineages } = opts;
    const holders = skillHoldersOf(roster);
    // リロールで差し替わるので `let`（`opts.draft` は初回の3択）
    let draft = opts.draft;
    let rerollsLeft = opts.rerollsLeft ?? 0;

    /** 'skill' = ①スキルを選ぶ / 'player' = ②付ける選手を選ぶ */
    let stage: 'skill' | 'player' = 'skill';
    let skillCursor = 0;
    let playerCursor = 0;
    let chosenSkill: SkillId = draft.options[0];
    // 段階②の候補（選んだスキルを実際に付けられる選手だけ。押しても何も起きない
    // 選択肢は並べない＝`canGrant` の判定をそのままUIの並びにする）
    let candidates: PlayerId[] = [];

    const overlay = document.createElement('div');
    overlay.style.cssText = OVERLAY_STYLE;

    const title = createPixelLabel('', { fontSize: 10, scale: 3, color: '#ffe066' });
    applyPanelChrome(title.el);
    title.el.style.marginBottom = '10px';

    const list = createPixelLabel('', { fontSize: 9, scale: 3, color: '#f8f8f8' });
    applyPanelChrome(list.el);

    const hint = createPixelLabel('', { fontSize: 7, scale: 2, color: '#cccccc' });
    Object.assign(hint.el.style, {
      marginTop: '10px',
      background: 'transparent',
      border: 'none',
      boxShadow: 'none',
    });

    overlay.append(title.el, list.el, hint.el);
    root.appendChild(overlay);

    function render(): void {
      if (stage === 'skill') {
        // 「コンカイ: メカ ドウブツ コンジョウ」＝この試合に出る系統（F-26-5）。
        // 系統名は `ALL_LINEAGES` の順に揃えて渡ってくるので、抽選のたびに並びが変わらない。
        const active = lineages?.length
          ? `\nコンカイ: ${lineages.map((l) => LINEAGE_NAME[l]).join(' ')}`
          : '';
        title.setText(`スキル ハッケン: ${teamName}${active}`);
        const body = draft.options
          .map((id, i) => {
            const cursor = i === skillCursor ? '▶ ' : '　 ';
            // 効果の説明は選択中のものだけ字下げして出す（3つぶん常時出すと縦に伸びて
            // 一覧性が落ちる。読みたいのは今カーソルがある1つ）
            const detail = i === skillCursor ? `\n　　 ${skillDef(id).text}` : '';
            return `${cursor}${describeSkill(id)}${detail}`;
          })
          .join('\n');
        list.setText(body);
        // **残り0のときは行ごと出さない**（押しても何も起きない案内を出さない＝
        // D-19の `ゼッコーチョー!` の行・L-32のリードの行と同じ扱い）。
        hint.setText(
          rerollsLeft > 0
            ? `W/S:センタク K:ケッテイ　J:ヒキナオス(ノコリ${rerollsLeft})`
            : 'W/S:センタク K:ケッテイ',
        );
        return;
      }

      const def = skillDef(chosenSkill);
      title.setText(`ダレニ ツケル?: ${def.name}`);
      // カーソルが必ず窓の中に入るように、先頭位置をカーソルから決める（候補が
      // VISIBLE_CANDIDATES 以下なら常に0＝従来どおり全部出る）
      const start = Math.max(
        0,
        Math.min(candidates.length - VISIBLE_CANDIDATES, playerCursor - Math.floor(VISIBLE_CANDIDATES / 2)),
      );
      const end = Math.min(candidates.length, start + VISIBLE_CANDIDATES);
      const rows = candidates
        .slice(start, end)
        .map(
          (id, i) =>
            `${start + i === playerCursor ? '▶ ' : '　 '}${describePlayer(roster, id)} ${describeSkills(roster, id)}`,
        );
      // 窓の外にまだ候補があることを示す（無いと「これで全員」と読めてしまう）
      if (start > 0) rows.unshift(`　 ▲ ホカ${start}ニン`);
      if (end < candidates.length) rows.push(`　 ▼ ホカ${candidates.length - end}ニン`);
      list.setText(`${def.text}\n\n${rows.join('\n')}`);
      hint.setText('W/S:センタク K:ケッテイ J:モドル');
    }

    function enterPlayerStage(): void {
      chosenSkill = draft.options[skillCursor];
      candidates = eligibleHolders(holders, chosenSkill).map((h) => h.id);
      // 候補がいないスキルは抽選に出さない設計（drawSkillDraft）なので通常ここは通らない。
      // 万一通ったら段階①に留まる＝押しても何も起きないより、選び直せるほうが親切。
      if (candidates.length === 0) return;
      playerCursor = 0;
      stage = 'player';
      render();
    }

    function close(result: SkillDraftChoice): void {
      offUp();
      offDown();
      offA();
      offB();
      root.removeChild(overlay);
      resolve(result);
    }

    function move(delta: number): void {
      if (stage === 'skill') {
        skillCursor = (skillCursor + delta + draft.options.length) % draft.options.length;
      } else {
        playerCursor = (playerCursor + delta + candidates.length) % candidates.length;
      }
      render();
    }

    const offUp = pad.onPress('up', () => move(-1));
    const offDown = pad.onPress('down', () => move(1));
    const offA = pad.onPress('a', () => {
      if (stage === 'skill') {
        enterPlayerStage();
        return;
      }
      close({ skillId: chosenSkill, playerId: candidates[playerCursor] });
    });
    const offB = pad.onPress('b', () => {
      // 段階②からは①へ戻れる（選び直せる）。**①には戻り先が無いので、そこだけ
      // リロールに割り当てる**（フェーズU-42。新しいキーを増やさない）。
      if (stage !== 'player') {
        if (rerollsLeft <= 0) return;
        const rolled = opts.reroll?.();
        // 引き直せなかった（回数券が尽きた等）ら何も起きない＝回数券は減らない
        if (!rolled) return;
        draft = rolled.draft;
        rerollsLeft = rolled.left;
        // カーソルは先頭へ戻す（並びが総取り替えになるので、前の位置には意味が無い）
        skillCursor = 0;
        render();
        return;
      }
      stage = 'skill';
      render();
    });

    render();
  });
}
