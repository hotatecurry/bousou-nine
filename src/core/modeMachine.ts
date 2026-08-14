/**
 * XState: でっかい／ちっちゃい／銃モード／乱闘のモード遷移。
 * 画面遷移は瞬時カット（原作準拠）なので、遷移アニメーション用の中間状態は持たない。
 *
 * 銃を撃てるかの条件（スキル `ジュウ` と投手個人の残弾。フェーズF-26-2）はロスター側が
 * 持つため、GUN_TOGGLE を送る前に呼び出し側（main.ts）が `canShootGun` で確認する。
 */
import { setup } from 'xstate';

export type ModeEvent =
  | { type: 'GUN_TOGGLE' }
  | { type: 'BATTED_BALL' }
  /** けん制球（説明書p24「Bで"ちっちゃいモード"に切替」）。打球なしでちっちゃいモードへ */
  | { type: 'PICKOFF' }
  /** 盗塁（説明書p13「盗塁しようとすると"ちっちゃいモード"に変わる」）。投球中の走塁 */
  | { type: 'STEAL' }
  | { type: 'DEAD_BALL' }
  | { type: 'PLAY_COMPLETE' }
  | { type: 'BRAWL_START' }
  | { type: 'BRAWL_DECLINED' }
  | { type: 'BRAWL_END' };

export const modeMachine = setup({
  types: {
    events: {} as ModeEvent,
  },
}).createMachine({
  id: 'mode',
  initial: 'dekkai',
  states: {
    /** 投手対打者のクローズアップ。投球・打撃・銃モード切替はここ。 */
    dekkai: {
      initial: 'normal',
      states: {
        normal: {
          on: { GUN_TOGGLE: 'gun' },
        },
        /** 銃モード。打席が変わると normal に戻る（initial が normal のため） */
        gun: {
          on: { GUN_TOGGLE: 'normal' },
        },
      },
      on: {
        BATTED_BALL: 'chicchai',
        DEAD_BALL: 'deadBall',
        // けん制球（説明書p24）。打球と同じちっちゃいモードへ入り、同じ PLAY_COMPLETE で
        // 戻る（原作も画面としては同じ「ちっちゃいモード」で、打球か走者かの違いしかない）。
        PICKOFF: 'chicchai',
        // 盗塁（説明書p13）。投球中でも同じちっちゃいモードへ切り替わる。投球そのものは
        // 裏で最後まで進み、カウントとして決着する（gameMachine 側の PITCH_RESULT）。
        STEAL: 'chicchai',
      },
    },
    /** フィールド全体表示。守備・走塁プレーの完了で自動復帰。 */
    chicchai: {
      on: { PLAY_COMPLETE: 'dekkai' },
    },
    /** 死球直後。打者側が乱闘を仕掛けるか選択する分岐点。 */
    deadBall: {
      on: {
        BRAWL_START: 'brawl',
        BRAWL_DECLINED: 'dekkai',
      },
    },
    /** 乱闘（v1: 簡易実装）。決着後は同カウント・同走者状況で再開。 */
    brawl: {
      on: { BRAWL_END: 'dekkai' },
    },
  },
});
