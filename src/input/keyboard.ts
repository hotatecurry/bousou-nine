/**
 * WASD / K / J / Enter / Shift の入力抽象化レイヤー。
 * ファミコンパッド相当の論理ボタンに変換する。
 * 将来のゲームパッド対応（D-pad 8方向）は VirtualPad 実装を差し替えるだけで済む構成。
 *
 * 2P PLAY（フェーズD-20）で**同じキーボードに2枚のパッドが乗る**ようになった。
 * 増えたのはキーマップを引数に取ることと、下の「パッドの合成」3つだけで、
 * `VirtualPad` の形は変えていない＝各コントローラーは相手が何枚目のパッドかを知らない。
 */

export type PadButton =
  | 'up'
  | 'down'
  | 'left'
  | 'right'
  | 'a'
  | 'b'
  | 'start'
  | 'select'
  /** 銃モードON/OFF切替の専用キー（仕様③）。ファミコンパッド外の拡張ボタン。暫定でGキー。 */
  | 'gun';

/** 1P のキー割り当て（CLAUDE.md ①のキー表。D-20でも一切変えていない） */
export const PLAYER1_KEYS: Record<string, PadButton> = {
  KeyW: 'up',
  KeyS: 'down',
  KeyA: 'left',
  KeyD: 'right',
  KeyK: 'a',
  KeyJ: 'b',
  Enter: 'start',
  ShiftLeft: 'select',
  ShiftRight: 'select',
  KeyG: 'gun',
};

/**
 * 2P のキー割り当て（フェーズD-20）。**矢印キー＋テンキー**で、1P（WASD＋K/J）とは
 * 1つも重ならない＝投球と打撃のように**両者が同時に押す場面**でも取り合いにならない
 * （原作の 2P PLAY はコントローラーIとIIなので、そもそも同時押しが前提の操作体系）。
 *
 * 読むのは `KeyboardEvent.code` なので、NumLockの状態によらず同じキーが同じボタンになる。
 */
export const PLAYER2_KEYS: Record<string, PadButton> = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  Numpad2: 'a',
  Numpad1: 'b',
  NumpadEnter: 'start',
  Numpad0: 'select',
  Numpad3: 'gun',
};

/** 8方向D-pad相当。斜め入力は x/y 同時に非0になる。 */
export interface DirectionState {
  x: -1 | 0 | 1;
  y: -1 | 0 | 1;
}

export interface VirtualPad {
  isPressed(button: PadButton): boolean;
  direction(): DirectionState;
  /** 押した瞬間のみ発火（キーリピート無視）。戻り値は購読解除関数。 */
  onPress(button: PadButton, handler: () => void): () => void;
  dispose(): void;
}

export function createKeyboardPad(
  keys: Record<string, PadButton> = PLAYER1_KEYS,
  target: Window = window,
): VirtualPad {
  const pressed = new Set<PadButton>();
  const handlers = new Map<PadButton, Set<() => void>>();

  const onKeyDown = (e: KeyboardEvent) => {
    const button = keys[e.code];
    if (!button || e.repeat) return;
    e.preventDefault();
    pressed.add(button);
    // 呼び出す前にスナップショットを取る（Set.forEach は反復中に追加された要素も
    // 巡回してしまう仕様があり、スナップショット無しだと「あるハンドラが同じボタンに
    // 新しいハンドラを動的登録する」ケースで、その新ハンドラが同一の押下イベント内で
    // 即座に呼ばれてしまう。采配メニュー（ui/managerMenu.ts）がStart押下時に自分自身の
    // キャンセル用Startハンドラをその場で登録する実装で、これが無いとメニューが
    // 開いた直後の同フレームで即座に閉じてしまう再入バグがあった）。
    const snapshot = handlers.get(button);
    if (snapshot) [...snapshot].forEach((h) => h());
  };

  const onKeyUp = (e: KeyboardEvent) => {
    const button = keys[e.code];
    if (!button) return;
    pressed.delete(button);
  };

  // ウィンドウフォーカス喪失時に押しっぱなし状態が残るのを防ぐ
  const onBlur = () => pressed.clear();

  target.addEventListener('keydown', onKeyDown);
  target.addEventListener('keyup', onKeyUp);
  target.addEventListener('blur', onBlur);

  return {
    isPressed: (button) => pressed.has(button),
    direction: () => ({
      x: (pressed.has('right') ? 1 : 0) - (pressed.has('left') ? 1 : 0) as -1 | 0 | 1,
      y: (pressed.has('up') ? 1 : 0) - (pressed.has('down') ? 1 : 0) as -1 | 0 | 1,
    }),
    onPress: (button, handler) => {
      let set = handlers.get(button);
      if (!set) {
        set = new Set();
        handlers.set(button, set);
      }
      set.add(handler);
      return () => set.delete(handler);
    },
    dispose: () => {
      target.removeEventListener('keydown', onKeyDown);
      target.removeEventListener('keyup', onKeyUp);
      target.removeEventListener('blur', onBlur);
      pressed.clear();
      handlers.clear();
    },
  };
}

// ---- パッドの合成（フェーズD-20） ----
//
// 各コントローラー（投球・打撃・守備・走塁・乱闘）は**1枚の `VirtualPad` を受け取る**形で
// 作ってあるので、2人ぶんに広げるときも**その形を変えない**。代わりに「どのパッドを読むか」
// を包み直したパッドを渡す＝呼び出し先は自分が何枚目のパッドを読んでいるかを知らないまま
// 2P PLAY に対応できる（E-25で `player.ts` が「人型のGroupをもらう」だけにしたのと同じ立て方）。

/** 何も押されていないパッド。**CPUが担っている役割**に渡す（人間のキーが漏れ込まない） */
export const NULL_PAD: VirtualPad = {
  isPressed: () => false,
  direction: () => ({ x: 0, y: 0 }),
  onPress: () => () => {},
  dispose: () => {},
};

/**
 * 役割に束縛したパッド。**読むたびに「いまその役割を担っているパッド」を解決する**ので、
 * 攻守が入れ替わっても渡し直しが要らない（投球は守備側のパッド、打撃は攻撃側のパッド）。
 *
 * `resolve` が null を返す間（＝その役割はCPU）は `NULL_PAD` と同じ振る舞いになる。
 * これが要るのは、旧実装が「人間のキー状態」をCPUの動作にも流用していた箇所
 * （`isSwingHeld` がCPUのスイングをバントに化けさせた既知のバグ）を、構造として塞ぐため。
 */
export function createRolePad(
  /** 解決先になりうる物理パッド全部（押下の購読先。`resolve` はこの中の1枚か null を返す） */
  pads: readonly VirtualPad[],
  resolve: () => VirtualPad | null,
): VirtualPad {
  const active = () => resolve() ?? NULL_PAD;
  return {
    isPressed: (button) => active().isPressed(button),
    direction: () => active().direction(),
    // 押下は購読の時点ではまだ誰が担っているか決まらないので、**全部に購読して発火時に絞る**。
    onPress: (button, handler) => {
      const offs = pads.map((pad) =>
        pad.onPress(button, () => {
          if (active() === pad) handler();
        }),
      );
      return () => offs.forEach((off) => off());
    },
    dispose: () => {},
  };
}

/**
 * 複数のパッドを1枚に見せる（**どちらが押しても同じ**）。モード選択・試合結果のように
 * 「どちらのプレイヤーが押してもよい画面」に渡す。
 */
export function createMergedPad(pads: readonly VirtualPad[]): VirtualPad {
  return {
    isPressed: (button) => pads.some((pad) => pad.isPressed(button)),
    direction: () => {
      for (const pad of pads) {
        const dir = pad.direction();
        if (dir.x !== 0 || dir.y !== 0) return dir;
      }
      return { x: 0, y: 0 };
    },
    onPress: (button, handler) => {
      const offs = pads.map((pad) => pad.onPress(button, handler));
      return () => offs.forEach((off) => off());
    },
    dispose: () => {},
  };
}
