/**
 * 試合と試合の間の画面（フェーズF-26-6のラン化。CLAUDE.md ⑧）。
 *
 * 3つの場面を持つ：
 * - **`runNextSelect`**：勝った直後。結果を見せてから**次の相手・球場を2択で選ぶ**
 *   （2026-07-29 ユーザー判断。ハデスの「報酬が見えている扉」に相当）。
 * - **`runEnd`**：ランの終わり（5連勝でクリア／1つ落として敗退）。育てたスキルを
 *   並べて見せてから、新しいランへ戻る。
 * - **`matchEnd`**：2P PLAY の試合結果（フェーズD-20）。2P はランの外＝1試合完結なので、
 *   勝った側を見せてチーム選択へ戻すだけ。
 *
 * **扉には中身を全部見せる**（相手・球場・その試合に出る系統）。見えていないものを
 * 選ばせるのはただの二者択一で、判断にならない（既存の「意思決定材料は隠さない」方針。
 * 球場選択に距離を並べた C-14、抽選画面に系統の絞り込みを出した F-26-5 と同じ）。
 *
 * 見た目は抽選画面（`skillDraft.ts`）と同じドット絵パネルで揃える：どちらも
 * 「試合を止めてランの選択をする画面」なので、同じ家族に見えるほうが操作を迷わない。
 */
import { ballparkById } from '../core/ballpark';
import type { RunDoor } from '../core/run';
import { LINEAGE_NAME } from '../core/skills';
import { teamById } from '../core/teams';
import type { VirtualPad } from '../input/keyboard';
import { applyPanelChrome } from './hud/hud';
import { createPixelLabel } from './hud/pixelText';
import { sfx } from '../audio/sfx';

// 抽選画面と同じ暗幕（同じ「試合を止めて選ぶ画面」の家族）
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

/** 扉1つぶんの3行（相手・球場・系統）。カーソルが乗っている扉だけ ▶ が付く */
function describeDoor(door: RunDoor, selected: boolean): string {
  const park = ballparkById(door.park);
  const lineages = door.lineages.map((l) => LINEAGE_NAME[l]).join(' ');
  return [
    `${selected ? '▶ ' : '　 '}${teamById(door.opponent).name}`,
    `　　 ${park.name} ${park.center}m/${park.wing}m`,
    `　　 系統: ${lineages}`,
  ].join('\n');
}

/**
 * 次の相手を選ぶ画面。選んだ扉の添字を返す（**キャンセルできない**＝抽選画面と同じで、
 * 進まない選択に意味が無い）。
 */
export function runNextSelect(
  root: HTMLElement,
  pad: VirtualPad,
  opts: {
    /** 「1試合目 勝利！」 */
    headline: string;
    /** 「ウィンズ 5 - 3 ロケッツ」 */
    score: string;
    /** 「次は 2/5試合目」 */
    progress: string;
    /**
     * 次の相手が持ってくるスキルの数（フェーズF-26-6）。**相手も同じだけ蓄積している**
     * ことは、見せなければプレイヤーには分からない（相手のカードは打席が回ってきて
     * 初めて見える）。ここで先に出しておくと「こちらも積まないと置いていかれる」という
     * ランの緊張感がそのまま判断材料になる。
     */
    opponentSkills: number;
    /**
     * 残っているリロールの回数（フェーズU-42）。**温存の判断は試合と試合の間にする**
     * ので、次の相手を選ぶこの画面に出しておく（抽選画面だけに出すと「引き直せると
     * 知るのが押す直前」になり、残すかどうかを考える機会がどこにも無い）。
     * 残り0なら行そのものを出さない＝押せない案内を並べない、という既存の方針。
     */
    rerollsLeft: number;
    doors: readonly RunDoor[];
  },
): Promise<number> {
  return new Promise((resolve) => {
    let cursor = 0;

    const overlay = document.createElement('div');
    overlay.style.cssText = OVERLAY_STYLE;

    const title = createPixelLabel('', { scale: 2, color: '#ffe066' });
    applyPanelChrome(title.el);
    title.el.style.marginBottom = '10px';

    const list = createPixelLabel('', { scale: 1, color: '#f8f8f8' });
    applyPanelChrome(list.el);

    const hint = createPixelLabel('W/S:選択 K:決定', {
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
      title.setText(`${opts.headline}\n${opts.score}`);
      const doors = opts.doors.map((door, i) => describeDoor(door, i === cursor)).join('\n');
      list.setText(
        [
          `${opts.progress}　相手のスキル ${opts.opponentSkills}個`,
          ...(opts.rerollsLeft > 0 ? [`引き直し 残り${opts.rerollsLeft}回`] : []),
          '',
          '次の相手を選択',
          doors,
        ].join('\n'),
      );
    }

    function move(delta: number): void {
      cursor = (cursor + delta + opts.doors.length) % opts.doors.length;
      render();
    }

    const offUp = pad.onPress('up', () => {
      sfx.menuMove();
      move(-1);
    });
    const offDown = pad.onPress('down', () => {
      sfx.menuMove();
      move(1);
    });
    const offA = pad.onPress('a', () => {
      sfx.menuConfirm();
      offUp();
      offDown();
      offA();
      root.removeChild(overlay);
      resolve(cursor);
    });

    render();
  });
}

/**
 * 2P PLAY の試合結果（フェーズD-20）。**2P PLAY はランの外＝1試合完結**なので、扉も
 * 持ち越しも無く、勝った側と最終スコアを見せてチーム選択へ戻るだけ（ユーザー判断）。
 *
 * 画面の家族は `runEnd` と同じ（同じ「試合を止めて結果を読む画面」）。どちらのパッドでも
 * 閉じられるよう、呼び出し側は合成パッド（`createMergedPad`）を渡す。
 */
export function matchEnd(
  root: HTMLElement,
  pad: VirtualPad,
  opts: {
    /** 「1Pの勝ち！」／「引き分け」 */
    headline: string;
    /** 「ウィンズ 5 - 3 ロケッツ」 */
    score: string;
    /** 「1P: ウィンズ」の並び（どちらがどの球団だったか。攻守が入れ替わるので最後に確認できる） */
    lines: readonly string[];
  },
): Promise<void> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.style.cssText = OVERLAY_STYLE;

    const title = createPixelLabel('', {
      scale: 3,
      color: '#ffe066',
      align: 'center',
    });
    applyPanelChrome(title.el);
    title.el.style.marginBottom = '10px';
    title.setText(`${opts.headline}\n${opts.score}`);

    const list = createPixelLabel('', { scale: 1, color: '#f8f8f8' });
    applyPanelChrome(list.el);
    list.setText(opts.lines.join('\n'));

    const hint = createPixelLabel('Kでチーム選択へ', {
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

    const offA = pad.onPress('a', () => {
      offA();
      root.removeChild(overlay);
      resolve();
    });
  });
}

/**
 * ランの終わり（クリア／敗退）。**育てたスキルを並べて見せる**：1試合完結だった頃と違い、
 * 5試合かけて積み上げたものがランの成果そのものなので、それを見ないまま次へ行くと
 * 「何をしていたのか」が残らない。K で閉じ、呼び出し側が新しいランを始める。
 */
export function runEnd(
  root: HTMLElement,
  pad: VirtualPad,
  opts: {
    /** 5試合勝ち抜いたか */
    cleared: boolean;
    /** 何試合目で終わったか */
    game: number;
    wins: number;
    total: number;
    /** 「村瀬: 筋肉 粘り」の並び（呼び出し側がロスターから起こす） */
    build: readonly string[];
  },
): Promise<void> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.style.cssText = OVERLAY_STYLE;

    const title = createPixelLabel('', {
      scale: 3,
      color: opts.cleared ? '#ffe066' : '#ff6666',
      align: 'center',
    });
    applyPanelChrome(title.el);
    title.el.style.marginBottom = '10px';
    title.setText(
      opts.cleared
        ? `ランクリア！\n${opts.total}連勝`
        : `敗退\n${opts.game}試合目 ${opts.wins}勝`,
    );

    const list = createPixelLabel('', { scale: 1, color: '#f8f8f8' });
    applyPanelChrome(list.el);
    list.setText(
      ['育てたスキル', ...(opts.build.length > 0 ? opts.build : ['　 なし'])].join('\n'),
    );

    const hint = createPixelLabel('Kで新しいラン', {
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

    const offA = pad.onPress('a', () => {
      offA();
      root.removeChild(overlay);
      resolve();
    });
  });
}
