/**
 * ドット絵風HUDパネル本実装（セッション8）。
 * CLAUDE.md②「HUD（スコア・カウント・走者状況）：モードごとに専用のドット絵風パネルを
 * 配置」の文言どおり、スコア（スコアボード）／カウント・走者状況（状況パネル）を
 * それぞれ独立したパネルに分割した（セッション1〜7では1枚のテキストパネルに
 * まとめていた暫定実装からの本実装）。
 *
 * 画面上の配置（フェーズD-18で整理）：
 * - 左上：スコアボード（イニングごとの得点＋合計）
 * - 右上：状況パネル（イニング・カウント・アウト・銃の残弾・操作）
 * - 中央：決着バナー（一時的）／モード別メッセージ（死球・乱闘・試合終了）／
 *   打席の切れ目の「間」（フェーズE-23）
 * - 下部：操作ヒント（中央）と、その下に 打者カード（左）｜投手カード（右）
 *
 * **各要素の帯が重ならないことが配置の要件**（一時的に出るバナーが常時表示の情報を
 * 覆い隠さない）。上を左右に分け、下を縦に積んでいるのはそのため（D-18より前は
 * 左上に2枚を縦積みしていて、中央上のバナーが必ずそこへかぶっていた）。
 *
 * ドット絵表現は pixelText.ts（低解像度canvasに描画→CSSで整数倍拡大）を使い、
 * 手作業のビットマップフォントを用意せず任意のカタカナ文言をブロック状の
 * ドット文字にする。パネルの縁取りは白縁＋硬いオフセット影というファミコン風の
 * 簡易チャンプで統一する（applyPanelChrome）。
 */
import type { GameContext } from '../../core/gameMachine';
import type { EdgeMarker } from '../../core/camera';
import type { BrawlHudView } from '../../scenes/brawlScene';
import { type BrawlCalloutTone, createBrawlHud } from './brawlHud';
import { type Half, battingTeam, fieldingTeam } from '../../core/rules';
import {
  type SideControllers,
  PLAYER_LABEL,
  isTwoPlayer,
  playerOfSide,
} from '../../core/players';
import {
  type TeamRoster,
  currentBatter,
  chargesLeftOf,
  currentBatterId,
  currentBatterPosition,
  displayHomeRuns,
  activeEffectsOf,
  effectiveBatting,
  effectivePitching,
  fatigueOf,
  formatAverage,
  positionLabel,
  formatEra,
  gunRemainingOf,
  hasSkill,
  isHot,
  liveSkillsOf,
  ratingBar,
  remainingStaminaOf,
  BOUNCING_FORK_LABEL,
  pitcherForkBouncesOf,
} from '../../core/roster';
import { NEUTRAL_RATING } from '../../core/pitch';
import { skillDef } from '../../core/skills';
import type { RunProgress } from '../../core/run';
import { CALL_BANNER_SEC, GUN_TELEGRAPH_SEC } from '../../core/tempo';
import type { PlayPromptKind } from '../../scenes/chicchaiScene';
import { createPixelLabel, uiScale } from './pixelText';

/**
 * ちっちゃいモードの操作ヒントの文言（走塁＝説明書p19の進塁B／帰塁A、
 * 守備＝説明書p23のファインプレイA・p25のランダンプレイB、けん制＝説明書p24のA）。
 * 表記はCLAUDE.md①のキー表どおり実際のキー名で出す（A=K / B=J）。押すべきキーを
 * そのまま書かないとヒントとして機能しないため、原作のボタン名（A/B）は使わない。
 */
const PLAY_PROMPT_TEXT: Record<PlayPromptKind, string> = {
  // タッチアップ（説明書p19）。**方向なしは全員**（フェーズL-32）は盗塁と同じ規則なので、
  // 同じ書き方で添える（同じキー・同じ入力が場面で違う意味になると案内が信用できなくなる）。
  tagUp: 'タッチアップ！\nJ+方向で進塁（方向なし＝全員）',
  // 塁を踏んでそのまま次の塁へ（フェーズBBB-77）。打者走者は一塁を踏むまではフォースの
  // ままなので、押しても一塁で刺されるときは刺される＝押し得ではない。K で取り消せる
  // ことまで書くのは、予約したのに止めたくなったときの抜け道が見えていないと押せないから。
  stretch: 'J+方向で次の塁へ（方向なし＝全員）\nK+方向でその塁に止まる',
  recall: 'K+方向で帰塁',
  // 塁間で止まる（フェーズN-34）。**帰塁を消さずに並べる**のは、この2つが同じ場面の
  // 2つの逃げ道だから（行く／戻る／止まる のうち押せる2つが見えていないと選択にならない）。
  // 「1プレー1カイ」を書くのは、バイク・ドロップキックと同じ回数の枷があるため。
  hold: 'Jでその場に止まる（1プレー1回）\nK+方向で帰塁',
  // 止まっている間（同上）。塁を踏んでいない＝刺されうる局面なので、「イキスギ!」と
  // 同じ「危ないことを先に伝えてから抜け道を案内する」書式で出す。
  holding: '止まっている！\nJで走る／K+方向で戻る',
  // バイク（フェーズF-26-3）で塁を行き過ぎた走者。踏んだ塁を離れているので刺されうる
  // ＝リード中と同じ「危ないことを先に伝えてから対処を案内する」書式で出す。
  overrun: '行き過ぎ！\nK+方向で塁へ戻る',
  // ドロップキック（フェーズF-26-4）。**当たるかどうかは書かない**：射程に野手がいるかを
  // 自分で測るのがこの操作の判断そのもので、「いま当たる」と出した瞬間に空振りの代償
  // （転倒）が消えて押し得になる。代わりに外したときに何が起きるかを添える。
  dropkick: 'Gでドロップキック\n外すと転ぶ',
  // ヒットエンドラン（フェーズH-28）。**この窓の間だけKは帰塁ではなくスイング**なので、
  // 出さないと「Kを押したら振ってしまった」になる（バイクの「イキスギ!」と同じ、
  // 危ない/短い局面を先に伝えてから操作を案内する書式）。他のヒントと同じ2行に収める。
  hitAndRun: 'ヒットエンドラン！\nKでスイング',
  // 守備側への警告（同上）。**射程の倍の距離で出る**ので、詰めるのをやめて塁へ投げる
  // 時間がまだある＝「見えているから避けられる」（意思決定材料は隠さない）。
  kickDanger: '蹴られる！\nK+方向で塁へ投げろ',
  // 一時効果・守備側（フェーズM-33）。**回数券であることを書く**のが要点で、
  // 「押せる」だけでは温存の判断ができない（残り回数は選手カードにも出るが、
  // 守備側のカードは画面に出ないので、ここが唯一の手がかりになる）。
  // 何回残っているかまでは書かない＝文言を場面ごとに作り分けないための割り切りで、
  // 抽選画面と采配前に確かめられる（`ドロップキック` の「ハズスト コロブ」と同じ粒度）。
  catchEffect: 'Gで守備範囲を拡大\n回数制限あり',
  finePlay: 'K+方向でファインプレー',
  rundown: 'J+方向でランダンプレー',
  pickoff: 'K+方向でけん制',
  // けん制されているが、走者はまだ塁についている（フェーズII-56）。**押している間だけ
  // リードが伸びる**ので、ここで案内しないとリードという操作が画面のどこにも現れない
  // （走者が勝手に動かない＝フィードバックも無い）。**押さなければ刺されない**ことまで
  // 書くのは、けん制されただけで慌てる必要が無いと分かって初めて「出るかどうか」の
  // 判断になるから（`ファウルハ サンシン!` と同じ「先に危なさの有無を伝える」書式）。
  leadStart: '方向を押している間リード\n押さなければけん制はセーフ',
  // けん制モードで走者がリードしている間。刺されうる局面であることを先に伝えたうえで
  // 対処（帰塁）を案内する（「意思決定材料は隠さない」方針）。
  lead: 'リード中！\nK+方向で帰塁',
  // 盗塁（説明書p13）。攻撃側にはでっかいモードで「いつ押すか」まで伝える：仕掛ける
  // タイミング（投球の残り時間）がそのまま成否を決める操作なので、キーだけ示しても
  // 判断材料にならない。守備側には塁へ投げる操作を案内する。
  //
  // **方向を入れないと全員走る**（フェーズL-32のダブルスチール）ことも書く：ここを
  // 書かないと、1人だけ走らせるつもりのJで走者全員が飛び出す＝**見えている操作と効く
  // 操作が食い違う**（無指定の意味がL-32で変わった、いちばん事故になりやすい点）。
  steal: 'J+方向で盗塁（方向なし＝全員）\nモーション中にスタート',
  // 盗塁を押したが、走り出すのは投手が本塁へ踏み出す絵から（フェーズBBB-76。原作どおり
  // 長くなったモーションの前半に押すと最大0.7秒待つ）。**押したことが受け付けられた**と
  // 分からないと、入力が落ちたと思って押し直す（＝同じ操作を二重に考えさせる）。
  stealQueued: '盗塁！ スタート待ち\n投手が踏み出したら走る',
  // リードを取りに行く（フェーズKK-58）。**まだ投げていない間だけ**出て、投球動作に
  // 入った瞬間に `steal` へ入れ替わる＝**同じJが投球前と投球中で違う意味になる**ので、
  // 並べて出すと「いまどちらが効くのか」が読めない（`bunt` / `buntTwoStrikes` と同じ
  // 「1つの操作の2つの状態」の持ち方）。
  //
  // **1打席1回であることを書く**のは、この操作の判断が「いつ取りに行くか」そのものだから
  // （`hold` が「1プレー1カイ」を書いているのと同じ理由）。2行目で盗塁の存在も残す＝
  // 入れ替えでダブルスチールの案内が消えるが、そちらは投球中に必ず出る。
  takeLead: 'Jでリードを取りに行く（1打席1回）\nモーション中のJ+方向＝盗塁',
  // 一時効果・打者側（フェーズM-33）。**「1打席だけ」を必ず書く**：切った直後の1打席で
  // 打ち取られれば効果は消える＝**いつ切るかが効果の大きさそのもの**なので、寿命を
  // 知らずに押させると判断そのものが成立しない（残り回数は打者カードに出ている）。
  battingEffect: 'Gでこの打席の打撃を強化\n使うと回数が1減る',
  // 押しバント（説明書p17「バットをななめに出し、ファールラインぎりぎりに転がすのが
  // コツ」。フェーズY-46）。**バットを出している間だけ**出る＝押せる窓と案内が同じ
  // 状態（`isBunting`）から出るので食い違わない（H-28の `hitAndRun` と同じ扱い）。
  //
  // **「ラインギワヘ」まで書く**のが要点：押しは方向を当てて初めて得で、正面へ押すと
  // 投手が空中で捕る小フライになる＝**キーだけ案内すると罠になる**（`ドロップキック` が
  // 「ハズスト コロブ」と代償を添えているのと同じ書式）。
  bunt: 'バント\nWで押す（ライン際を狙う）',
  // 2ストライクのバント（フェーズAA-48）。**ファウルが三振になる**唯一の場面なので、
  // 「危ないことを先に伝えてから操作を案内する」既存の書式（`イキスギ!`・`リード!`・
  // `ケラレル!`・`トマッテイル!`）に合わせて1行目を警告に差し替える。**知らずに三振する
  // のを防ぐのが役目**で、押せる操作そのものは `bunt` と同じ（＝2行に収まる）。
  buntTwoStrikes: 'ファウルなら三振！\nWで押す（ライン際を狙う）',
  stealThrow: '盗塁！\nK+方向で送球',
};

/**
 * 2P のキー名への読み替え（フェーズD-20）。上の文言は**1Pのキー名で書いてある**ので、
 * そのまま2Pに見せると押せないキーを案内することになる（ヒントは「意思決定材料」なので、
 * 間違ったキーを出すのは出さないより悪い）。文言に出てくる英字は K/J/G の3つと、
 * 十字キーの W（押しバント＝フェーズY-46。2Pでは矢印キー）だけなので、置換で足りる
 * （`input/keyboard.ts` の PLAYER2_KEYS と対で保つ）。
 */
const PLAYER2_KEY_LABEL: Record<string, string> = { K: '[2]', J: '[1]', G: '[3]', W: '↑' };

/** ヒント1本。**誰への案内か**を持つ（2P PLAY では両側に同時に出るため） */
export interface PlayPromptLine {
  kind: PlayPromptKind;
  /**
   * 出す相手。`null` は1P PLAY（人間が1人なので誰宛かは自明）＝D-20より前と同じ文言。
   * `'p1'`/`'p2'` は2P PLAY で、行頭に `1P:`/`2P:` が付き、2Pにはキー名も読み替えて出す。
   */
  player: 'p1' | 'p2' | null;
}

function playPromptLineText(line: PlayPromptLine): string {
  const text = PLAY_PROMPT_TEXT[line.kind];
  if (line.player === null) return text;
  const keyed =
    line.player === 'p2' ? text.replace(/[KJGW]/g, (k) => PLAYER2_KEY_LABEL[k]) : text;
  // 2行の文言（「イキスギ!」等の警告＋対処）は2行目も同じ相手のものなので、行頭の
  // ラベルは1行目にだけ付けて、2行目は字下げで続きだと分かるようにする。
  return keyed
    .split('\n')
    .map((row, i) => (i === 0 ? `${line.player === 'p1' ? '1P' : '2P'}:${row}` : `   ${row}`))
    .join('\n');
}

/** ホームラン等の決着演出バナーの種類。呼び出し側（main.ts）は効果音を別途鳴らす
 *（HUDは見た目だけを担当し、音の再生タイミングは実際のゲームイベント発生元に委ねる設計）。 */
export type BannerKind =
  | 'homerun'
  | 'triple'
  | 'double'
  | 'single'
  | 'strikeout'
  | 'walk'
  | 'out'
  | 'safe'
  // 1球ごとの判定コール（フェーズE-23）。三振・四球のような打席の決着ではないので、
  // 上のどれよりも小さく・短く出す（毎球出るものが大きいと決着の重みが消える）。
  | 'strike'
  | 'ball'
  | 'foul'
  // 投手の球威が落ち始めた（フェーズB-11）。1試合に投手1人あたり1回しか出ない告知で、
  // 継投（守備側）／狙い目（攻撃側）の判断材料になる。
  | 'stamina'
  // CPU投手が銃を構えた（フェーズF-26-2）。**避けられない一撃の予兆**なので、決着の
  // どのバナーよりも強く出す（ホームランと同じ大きさ・赤系のフラッシュ）。
  | 'gunAim'
  // 乱闘の負けで退場した選手と、代わって入った選手（フェーズWW-71）。それまでは
  // ユニフォームを別の色に塗って知らせていた（その色が以後の全選手に残っていた）。
  | 'ejected';


export interface Hud {
  /**
   * controllers：側ごとの操作者（フェーズD-20。セッション7の `humanSide` を一般化した
   * もの）。でっかい／ちっちゃいモードで「今どちらを操作しているか（投球/打撃・守備/走塁）」
   * の表示に使う。**2P PLAY では両側に人間がいる**ので、1Pと2Pの役割を並べて出す。
   */
  update(
    game: GameContext,
    modeState: string,
    gunMode: boolean,
    controllers: SideControllers,
    /**
     * ランの進行（フェーズF-26-6。何試合目・何勝目か）。ランを通していない呼び出しでは
     * 省略でき、そのときスコアボードはF-26-6の前とまったく同じ3行になる。
     */
    run?: RunProgress,
    /**
     * 持ち越したリード（フェーズL-32。塁→距離m）。**でっかいモードの状況パネルに出す**
     * ための値で、省略すれば行そのものが出ない（`leadLine` を参照）。HUDからは導出
     * できない（けん制のプレーの決着時の値＝main.ts が持つ）ので受け取る。
     */
    leads?: Partial<Record<'first' | 'second' | 'third', number>>,
  ): void;
  /** 銃命中時のシリアス演出（緊迫感重視・コミカルにしない暗転フラッシュ） */
  gunHitFlash(): void;
  /**
   * 乱闘中のみ毎フレーム呼ぶ（乱闘v3。フェーズXX-72）。体力・減りしろ・ラウンドの印・
   * 残り時間・超必殺のゲージ・連続技の数（`brawlHud.ts`）。真実は `BrawlState` の側。
   */
  updateBrawl(view: BrawlHudView, dt: number): void;
  /** 乱闘の大きな呼び出し（第1ラウンド／ファイト！／K.O.／タイムアップ／〇〇の勝ち） */
  brawlCallout(text: string, tone: BrawlCalloutTone): void;
  /** 超必殺の暗転（画面全体が一瞬暗くなる） */
  brawlSuperFlash(): void;
  /**
   * 読みの札（フェーズYY-73。`テレパシー` 等）が透かした相手の配球（`読み: 速球・内角`）。
   * null で消す。でっかいモードの上端の真ん中（スコアボードと状況パネルの間）に出す。
   */
  setReading(text: string | null): void;
  /** 時間停止（フェーズYY-73）の間だけ画面を青く沈める */
  slowTint(on: boolean): void;
  /**
   * 画面全体を真っ黒にする（フェーズBBB-76。**打った瞬間の後の7フレーム**＝原作の
   * でっかい→ちっちゃいの切り替えに挟まる黒）。HUDも含めてすべてを覆う。
   */
  blackout(on: boolean): void;
  /**
   * 乱闘中に出す操作説明と技表（フェーズG-27）。null で消す。
   * **HUDが自分では組めない**（誰がどの必殺技を持っているか＝スキル、その人が押す
   * 向き＝画面左右で前が逆、2Pのキー名の読み替え）ので、main.ts が組んで渡す。
   * 乱闘v3（XX-72）で**側ごとに2枚**（打者＝左下／投手＝右下）にした＝真ん中で戦う
   * 2人に掛からない（技表が12行に増えたので、中央に1枚だと足元がまるごと隠れた）。
   */
  setBrawlHint(hint: { batter: string | null; pitcher: string | null } | null): void;
  /** ホームラン・安打・三振・四球の決着演出バナー。一定時間で自動的に消える */
  playBanner(kind: BannerKind, text: string): void;
  /**
   * 操作ヒント。今その操作ができる間だけ出す
   * （'tagUp'=フライ捕球直後の進塁チャンス、'recall'=仕掛けた走者の帰塁、
   * 'finePlay'=跳べば届く距離にボールがある、'rundown'=確保中に塁間の走者がいる、
   * 'pickoff'=けん制モードで投げられる、'lead'=けん制モードでリードしている、
   * 'steal'=でっかいモードで盗塁を仕掛けられる、'stealThrow'=盗塁されている、
   * 空配列=消す）。'steal' だけはフィールドプレー外（でっかいモード）で main.ts が出す。
   * 自動では消えず、呼び出し側が切り替える。update() の管理外の独立チャンネル
   * （バナー・メッセージとは別要素）。
   *
   * **複数本を同時に出せる**（フェーズD-20）：2P PLAY では守備側と攻撃側の両方に人間が
   * いるので、1本しか出せないとどちらかが操作を案内されないままプレーすることになる。
   */
  showPlayPrompt(lines: readonly PlayPromptLine[]): void;
  /**
   * 打席の切れ目の「間」に見せる文言（フェーズE-23。'2バン 2B / V2' や
   * 'コウタイ / 3カイ ウラ'）。null で消す。playPrompt と同じく update() の管理外の
   * 独立チャンネルで、出し入れは呼び出し側（main.ts の updateInterlude）が行う。
   * でっかいモード専用なので、それ以外のモード・試合終了では保険として必ず消える。
   */
  showInterlude(text: string | null): void;
  /**
   * 画面外の走者を指し示す印（フェーズE-24）。ちっちゃいモードが追従カメラになり
   * 走者が画面の外へ出るようになったので、**どの塁へ投げるかの判断材料**として
   * 方向だけを画面端に残す（既存の「意思決定材料は隠さない」方針）。
   * 空配列で全部消える。毎フレーム呼ばれる前提で、要素は使い回す。
   */
  showRunnerMarkers(markers: ReadonlyArray<EdgeMarker & { color?: string }>): void;
  /**
   * デバッグモードの状態表示（フェーズPP-64。`src/debug/practice.ts`）。null で消える。
   *
   * **常に出す**：いま本番ではないこと（3カウントでアウトにならない等）と、押せる数字キーが
   * 見えていないとデバッグモードそのものが使えない。**画面上端の中央**に置くのは、
   * スコアボード（左上）・状況パネル（右上）・バナー（34%）・カード（下）のどれとも
   * 帯が重ならない唯一の場所だから（D-18で決めた配置をそのまま守る）。
   * 通常のプレイでは一度も呼ばれない＝**本番の画面は1ドットも変わらない**。
   */
  setDebugLine(text: string | null): void;
}

function halfLabel(half: 'top' | 'bottom'): string {
  return half === 'top' ? '表' : '裏';
}

function runnerDiamond(game: GameContext): string {
  const b = game.bases;
  const mark = (on: boolean) => (on ? '■' : '□');
  return ` ${mark(b.second)} \n${mark(b.third)} ${mark(b.first)}`;
}

/** スタミナゲージの目盛り数。半分（5マス）が球威の落ち始める境目にちょうど当たる */
const STAMINA_CELLS = 10;

/**
 * 打者カード／投手カードの拡大率（他のパネルと同じ＝原寸16px。ブラッシュアップで
 * DotGothic16 にしてからは1が基準で、大きな画面では画面全体の倍率 `uiScale` が掛かる）
 */
const CARD_SCALE = 1;

/**
 * 今マウンドにいる投手のスタミナ表示（フェーズB-11）。
 *
 * **攻守どちらの側でも同じものを出す**：投手側には継投の判断材料、打者側には
 * 「相手が疲れてきた＝狙い目」という材料になる（既存の「意思決定材料は隠さない」方針。
 * 銃の残弾・控え人数を常時出しているのと同じ扱い）。球威が落ち始めたら文字でも
 * 明示する＝ゲージが半分を切ったことの意味が、読み方を知らなくても分かる。
 *
 * フェーズD-18で投手カードへ移した（B-11では状況パネルの中にあり、投手名を出すと
 * パネルが横に伸びて他のパネルと重なるため名前を出せなかった）。カードには投手名が
 * 別の行で入っているので、この行は「何の」ゲージかだけを名乗る。
 *
 * 球威ダウンの警告は**次の行に分ける**（B-11ではゲージと同じ行に続けていた）。同じ行に
 * 足すとカードの最長行が一気に伸び、左右のカードが画面中央へ張り出してしまう
 * ＝疲れた瞬間だけ打者や球が隠れる、という表示のために起こしてはいけない副作用が出る。
 */
function staminaLines(roster: TeamRoster): string[] {
  const id = roster.pitcher;
  const filled = Math.round(remainingStaminaOf(roster, id) * STAMINA_CELLS);
  const gauge = '■'.repeat(filled) + '□'.repeat(STAMINA_CELLS - filled);
  const lines = [`スタミナ ${gauge}`];
  if (fatigueOf(roster, id) > 0) lines.push('球威ダウン');
  return lines;
}

/**
 * 状況パネルの銃の行（フェーズF-26-2）。**`ジュウ` を持つ投手がマウンドにいるときだけ**
 * 出す（持たない試合では行そのものが無い＝パネルは2行に戻る）。
 *
 * 残弾は投手個人のものなので、**継投すると数字が引き継がれず切り替わる**
 * （新しい投手が持っていなければ行ごと消える）。攻守どちらの側でも同じものを出す＝
 * 守備側には「あと何発撃てるか」、打者側には「撃たれうる相手か」の判断材料になる
 * （スタミナゲージを両側に見せているのと同じ「意思決定材料は隠さない」方針）。
 */
export function gunLine(roster: TeamRoster, gunMode: boolean): string {
  // **「銃を持っているか」ではなく「撃つ手段を持っているか」で出す**（フェーズF-26-8）。
  // 消費型 `ヨビジュウ` だけの投手も撃てる（`canShootGun` はチャージを数える）ので、
  // ここを `hasSkill('ju')` のままにすると**撃てるのに残弾がどこにも出ない**
  // （実機で踏んだ：Gで銃モードには入れるのにHUDが2行のままだった）。
  // 撃ち切った `ジュウ` 持ちの行が残る（弾切れが見える）性質は、そのまま保つ。
  if (!hasSkill(roster, roster.pitcher, 'ju') && gunRemainingOf(roster, roster.pitcher) <= 0) {
    return '';
  }
  const remaining = gunRemainingOf(roster, roster.pitcher);
  return gunMode ? `\n▶銃モード（残り${remaining}）` : `\n銃 残り${remaining}`;
}

/**
 * 状況パネルのリードの行（フェーズL-32）。**持ち越したリードがあるときだけ**出す
 * （＝直前にけん制のプレーがあった打席だけ。無ければ行そのものが無く、パネルは
 * L-32より前とまったく同じ高さに戻る＝銃の行・好調の行と同じ扱い）。
 *
 * 出す理由は「意思決定材料は隠さない」そのもので、この1行が**両者の判断材料**になる：
 * 走者側は「いま何メートル離れているか＝この球を走れるか」、投手側は「深いリードを
 * 許したまま投球に入るのか、もう一度けん制するのか」を、投げる前に読める。
 * リードは でっかいモードでは画面に映らない（打者と投手しか見えない）ので、
 * **表示しなければ存在しないのと同じ**になる。
 *
 * 塁は 1/2/3 の数字で出す（カウント表示 `B0 S0 O0` と同じ密度。カタカナで
 * 「イチルイ」と書くとパネルが横に伸び、決着バナーと重なる方向へ戻ってしまう）。
 */
export function leadLine(
  leads: Partial<Record<'first' | 'second' | 'third', number>> | undefined,
): string {
  if (!leads) return '';
  const cells = (['first', 'second', 'third'] as const)
    .map((base, i) => (leads[base] === undefined ? '' : `${i + 1}:${leads[base]!.toFixed(1)}`))
    .filter((s) => s !== '');
  return cells.length === 0 ? '' : `\nリード ${cells.join(' ')}`;
}

/**
 * 状況パネルの走者の走力の行（フェーズFF-53）。**塁に走者がいるときだけ**出す
 * （＝いなければ行そのものが無く、パネルは FF-53 より前とまったく同じ高さに戻る＝
 * 銃の行・リードの行・好調の行と同じ扱い）。
 *
 * EE-52 が走力の列を足したのは**采配メニューと打順の段**まで＝「足で選んだ代打」も、
 * 塁に出た瞬間に走者としての値打ちがどこにも出なくなっていた。走力が効くのは
 * **塁に出た後**（盗塁・リード・打球での余分な進塁）なので、判断がいちばん必要な
 * 場所に材料が無いままだった（既存の「意思決定材料は隠さない」方針の穴）。
 *
 * **でっかいモードにだけ出す**のはリードの行と同じ理由で、そこでは走者が画面に映らない
 * ＝表示しなければ存在しないのと同じになる（ちっちゃいモードでは実際に走るのが見える）。
 * 塁の番号（1/2/3）とその並び順もリードの行と揃える＝**同じ走者の2つの材料
 * （どれだけ離れているか・どれだけ速いか）が縦に並んで読める**。
 *
 * **バーは `ratingBar`**（EE-52・DD-51 と同じ目盛り）＝走力は表示用の実数値を持たない
 * ので、ここで数値を作ると同じ選手が画面ごとに違う物差しで出る。
 *
 * **1行は2人まで**（`RUNNERS_PER_SPEED_LINE`）。バー1本は塁の番号込みで12半角あり、
 * 満塁の3人を1行に並べると**パネルの横幅が操作の行（35半角）を超えて広がる**＝
 * 左上のスコアボードへ近づく（実測：540px + 324px で 864px。狭い窓では重なる）。
 * 3人目を次の行へ送れば幅は30半角のままで、**D-18 の「パネルの帯が重ならない」要件と
 * L-32 がテストで固定した幅の上限をどちらも動かさない**。字下げて続きだと示す書式は、
 * 打者カードのスキルの行（F-26-7）がすでに使っているものと同じ。
 */
const RUNNERS_PER_SPEED_LINE = 2;
/** 続きの行の字下げ（見出し `走力 ` とちょうど同じ表示幅＝塁の番号が縦に揃う） */
const SPEED_LINE_INDENT = '　　 ';

export function runnerSpeedLine(game: GameContext): string {
  const roster = game.rosters[battingTeam(game.half)];
  const cells = (['first', 'second', 'third'] as const)
    .map((base, i) => {
      const id = game.baseRunners[base];
      if (id === null) return '';
      // **走力の出どころは main.ts の `runnerSpeedOf` とまったく同じ**（スキル込みの
      // 派生ビュー／名鑑に無い無名の走者は基準値）＝画面に出るバーと、その走者が
      // 実際に走る速さが同じ1か所から出る（B-11の投球数→残量と同じ「真実は1か所」）。
      // **好調は渡さない**（`inning` なし）＝D-19 は打撃だけを動かし RUN には効かない。
      const run = roster.players[id] ? effectiveBatting(roster, id).run : NEUTRAL_RATING;
      return `${i + 1}:${ratingBar(run)}`;
    })
    .filter((s) => s !== '');
  if (cells.length === 0) return '';
  const lines: string[] = [];
  for (let i = 0; i < cells.length; i += RUNNERS_PER_SPEED_LINE) {
    const row = cells.slice(i, i + RUNNERS_PER_SPEED_LINE).join(' ');
    lines.push(`${i === 0 ? '走力 ' : SPEED_LINE_INDENT}${row}`);
  }
  return `\n${lines.join('\n')}`;
}

// ---- 打者カード／投手カード（フェーズD-18） ----
//
// 原作のHUDにある「バッターの名前・打率・本塁打数」「ピッチャーの名前・防御率」を出す。
// 打率・本塁打数は能力値（AV/HR）からの導出で、実数値を別に持たない（roster.ts の
// `displayAverage`/`displayHomeRuns` のコメント参照）。
//
// **この2枚は画面下部の左右に離して置く**（でっかいモードの中央＝投手と向かってくる球の
// 通り道を空けておくため）。従来 状況パネルにあった打順・代打の残り・スタミナのうち、
// **打者に属するものは打者カード、投手に属するものは投手カードへ移した**：控えの残り人数は
// 攻撃側なら「あと何回代打を出せるか」、守備側なら「あと何人継投できるか」で、
// もともと打者・投手それぞれに属する情報だった。おかげで状況パネルは
// 「イニング・カウント・銃・操作」だけに絞られ、横幅が縮んで決着バナーと重ならなくなる。
//
// 文言は原作の選手名鑑（説明書p26-29）の記号をそのまま使う（AV=打率 / HR=本塁打 /
// ERA=防御率）。カタカナで「ダリツ」「ホンルイダ」と書くより短く、原作を触った人には
// そのまま通じる。

/**
 * 打者カードの文言（打順・守備位置・名前・打率・本塁打数・代打の残り）。
 * 表示専用の純粋関数（テストから直接呼ぶ）。
 *
 * `inning`（フェーズD-19）はラッキー7の判定に要る。**省略すると絶好調選手のぶんだけ**が
 * 反映される（`effectiveBatting` と同じ既定。イニングを知らない呼び出しでも止まらない）。
 */
export function batterCardText(roster: TeamRoster, inning?: number, trailing = false): string {
  const batter = currentBatter(roster);
  const position = currentBatterPosition(roster);
  // 代打が入ったばかりの打順（投手の打席への代打）は守備位置を持たない＝打順だけ出す
  const slot = `${roster.lineupIndex + 1}番${position === null ? '' : ` ${positionLabel(position)}`}`;
  // **スキルの補正込みで表示する**（フェーズF-26-1）。AV/HR は能力値レーティングからの
  // 導出なので、`キンニク` を付ければカードの本塁打数もその場で増える＝「表示された数字が
  // 判断材料として使える」（⑥）がスキルを入れた後も保たれる。
  // **好調（フェーズD-19）も同じ経路**なので、ゼッコーチョーの打者はカードの AV/HR が
  // 上がった状態で出る（数字が「今日この打者は来ている」を語る）。
  // **`火事場の力`（YY-73）は負けているときだけ**＝カードの数字も同じ条件で動く
  const stats = effectiveBatting(roster, currentBatterId(roster), inning, trailing);
  return [
    `打者 ${slot}`,
    // **走力は AV/HR と同じ行に併記する**（フェーズFF-53。ユーザー判断）＝行を増やさない
    // ので、**D-18で詰めた「平常時のカードの高さ」の前提を1ミリも動かさない**
    // （ゼッコーチョー・一時効果・スキルの行が「持たない打者には出さない」ことで守って
    // きたものと同じ約束）。能力値は能力値の行にまとまる＝采配メニュー・打順の表
    // （EE-52）と同じ AV→HR→走力 の並び順で読める。
    //
    // **バーで出す**（EE-52 と同じ `ratingBar`）＝走力は表示用の実数値を持たない唯一の
    // 能力値なので、ここで数値を作ると**同じ選手が画面ごとに違う物差しで出る**
    // （DD-51・EE-52 が投手側・代打側で揃えたのと逆をやることになる）。見出しは
    // 表の `ソウリョク` の頭2文字で、**カードは1行を短く保つ**という D-18 の制約に従う
    // （長い見出しを足すとカードが画面中央＝投手と球の通り道へ張り出す）。
    `${batter.name} 打率${formatAverage(stats.average)} 本塁打${displayHomeRuns(stats.power)} 走力${ratingBar(stats.run)}`,
    `代打 残り${roster.bench.length}`,
    ...hotLines(roster, currentBatterId(roster), inning),
    ...effectLines(roster, currentBatterId(roster)),
    ...skillLines(roster, currentBatterId(roster)),
  ].join('\n');
}

/**
 * いま切ってある一時効果の行（フェーズM-33）。**`ゼッコーチョー!` とまったく同じ扱い**で、
 * 切っていない打者には行そのものを出さない＝平常時のカードの高さは動かない。
 *
 * 上のAV/HRは切った瞬間に跳ね上がる（同じレーティングからの導出）が、**数字だけでは
 * 「なぜ上がっているのか」が読めない**ので、理由をこの1行が受け持つ（好調の行が
 * 果たしているのと同じ役目）。相手にも見えるのは意図どおり＝切ったことは隠さない。
 */
function effectLines(roster: TeamRoster, playerId: string): string[] {
  return activeEffectsOf(roster, playerId).map((id) => `${skillDef(id).name}！`);
}

/**
 * 好調の行（フェーズD-19）。**好調でない打者には行そのものを出さない**（`skillLines` と
 * 同じ扱い）ので、好調が回ってこない打席のカードはD-18で詰めた見た目のまま＝
 * 「パネル同士が重ならない」ように決めた高さの前提を、平常時は一切動かさない。
 *
 * 上がった AV/HR だけでは「なぜ上がっているのか」（好調なのか、スキルなのか）が読めない
 * ので、理由のほうをこの1行が受け持つ。バットの回転（でっかいモードの見た目）と
 * 同じことを言っているが、**ちっちゃいモードや代打の直後でも読める**のが表示の役割。
 */
function hotLines(roster: TeamRoster, playerId: string, inning?: number): string[] {
  return isHot(roster, playerId, inning) ? ['絶好調！'] : [];
}

/**
 * 持っているスキルの行（フェーズF-26-1）。**持っていない選手には行そのものを出さない**ので、
 * スキルを取る前のカードは従来とまったく同じ見た目のまま＝D-18で「パネル同士が重ならない」
 * ように詰めた高さの前提を、取っていない間は一切動かさない。
 *
 * **1行に1つずつ縦に並べる**（フェーズF-26-7）。ラン化で1選手が最大4つ（枠3＋デュオ）持つ
 * ようになり、横に並べると `スキル タフネス ハグルマ ジュウ ホーミングダン` のような行が
 * **カードの幅を決めてしまい、画面中央（でっかいモードの視線の通り道）へ張り出す**
 * （実機で確認）。縦に伸びるぶんには画面下部のflexの列がそのまま押し上げるだけで、
 * パネル同士は構造的に重ならない＝D-18が「球威ダウンの警告をゲージと同じ行に足さず
 * 次の行へ分けた」のとまったく同じ判断。
 */
function skillLines(roster: TeamRoster, playerId: string): string[] {
  // **使い切った消費型は行ごと消える**（フェーズF-26-8）＝カードに出ているのは
  // 「いま使えるもの」だけになる（枠も同時に返っているので、表示と実際が食い違わない）。
  const owned = liveSkillsOf(roster, playerId);
  if (owned.length === 0) return [];
  // 2つ目以降は見出しぶんを空けて字下げする（何の並びなのかが1行目から続いて読める）
  return owned.map((id, i) => {
    // 消費型は**残り回数まで出す**（フェーズF-26-8）。残りがいくつかは「いま使うか、
    // 温存して強化を狙うか」という判断そのものの材料なので、隠すと判断が成立しない
    // （既存の「意思決定材料は隠さない」方針＝スタミナゲージを両側に見せているのと同じ）。
    const left = chargesLeftOf(roster, playerId, id);
    const charges = left > 0 ? ` 残り${left}` : '';
    return `${i === 0 ? 'スキル' : '　　　'} ${skillDef(id).name}${charges}`;
  });
}

/**
 * 投手カードの文言（名前・防御率・救援の残り・スタミナゲージ）。
 * 表示専用の純粋関数（テストから直接呼ぶ）。
 *
 * 投球能力を持たない選手がマウンドにいる場合（本来起きないが、没収試合の際どい状態などで
 * 読み出しに来る可能性がある）は防御率の欄を落とす＝表示で止まらないようにする。
 *
 * **能力値は `effectivePitching` から読む**（フェーズW-44で素の `player.pitching` から
 * 直した）。打者カードが D-18 以来 `effectiveBatting` を通していたのに対し、投手カードは
 * 素の名鑑を読んでいた＝W-44で **ERA がスキルの補正対象になった瞬間に、
 * 「隅を突いてくるのにカードの防御率は名鑑のまま」という食い違いが生まれる**
 * （⑧「パラメータ系はHUDの表示も自動で追従する」が投手側だけ成り立っていなかった）。
 * スタミナゲージのほうは元から `remainingStaminaOf` 経由＝`effectivePitching` を通っている。
 */
export function pitcherCardText(roster: TeamRoster): string {
  const pitcher = roster.players[roster.pitcher];
  const stats = effectivePitching(roster, roster.pitcher);
  const era = stats ? `防御率${formatEra(stats.era)} ` : '';
  return [
    `投手 ${pitcher.name}`,
    `${era}救援 残り${roster.bullpen.length}`,
    ...staminaLines(roster),
    // ワンバウンドするフォークを持つ投手にだけ出す（フェーズBBB-79。持たない投手には
    // 行そのものを出さない＝平常時のカードの高さは動かない）。**見逃せばボールになる球**
    // なので、打つ側には「追い込まれても釣られるな」、投げる側には「振らせる球がある」
    // という材料になる。疲れて落ちなくなれば消える（実際の球と同じ式から出す）。
    ...(pitcherForkBouncesOf(roster, roster.pitcher) ? [BOUNCING_FORK_LABEL] : []),
    ...skillLines(roster, roster.pitcher),
  ].join('\n');
}

/**
 * イニングごとの得点を1マス1文字で並べる。未到達（まだ表/裏が回ってきていない）は
 * '-' で空欄扱いにする（recordInningRuns のコメント参照）。10点以上のイニングは
 * 複数桁のまま表示され列がずれる簡易表示（v1の既知の簡略化、PROGRESS.md参照）。
 */
function lineScoreRow(runs: number[], totalInnings: number): string {
  const cells: string[] = [];
  for (let i = 0; i < totalInnings; i++) {
    const v = runs[i];
    cells.push(v === undefined ? '-' : String(v));
  }
  return cells.join(' ');
}

/**
 * 延長で9回を超えたら列を伸ばす。見出しの回数字は2桁目を10の位無視の1桁表示にする簡易版。
 *
 * 行の頭は**球団の略称**（フェーズB-12/C-13。従来は 'V'/'H' 固定）。略称は名鑑側で
 * 全球団カタカナ2文字に揃えてあるので（`TeamData.short`）、どのカードでも列がずれない。
 * 見出しの空白が5つなのはその2文字ぶん（全角2文字＋区切りの半角空白＝半角5つ）。
 */
export function scoreboardText(game: GameContext, run?: RunProgress): string {
  const totalInnings = Math.max(9, game.inning);
  const header = Array.from({ length: totalInnings }, (_, i) => (i + 1) % 10).join(' ');
  return [
    // ランの進行（フェーズF-26-6）。**スコアボードの上に載せる**のは、ここが
    // 「試合の記録」を出す場所だから＝ランは試合の記録の外枠にあたる。1行増えるだけなので
    // D-18で詰めた「決着バナーはパネルの下端より下（max(34%,180px)）」の前提は動かない
    // （このパネルは4行でも約110px）。ランを通していない呼び出し（テスト）では行ごと出ない。
    ...(run ? [`ラン ${run.game}/${run.total} ${run.wins}勝`] : []),
    `     ${header}  R`,
    `${game.rosters.away.team.short} ${lineScoreRow(game.lineScore.away, totalInnings)}  ${game.score.away}`,
    `${game.rosters.home.team.short} ${lineScoreRow(game.lineScore.home, totalInnings)}  ${game.score.home}`,
  ].join('\n');
}

/** 試合終了の勝者表示。球団名で出す（フェーズB-12/C-13。従来は「ビジター/ホーム」固定） */
export function winnerText(game: GameContext): string {
  if (game.winner === null) return '';
  return `${game.rosters[game.winner].team.name}の勝ち！`;
}

/**
 * 演出バナーのスタイル表。桜井ノウハウ照合（sakurai_all.txt）「音の優先度や大きさは
 * プレイヤーに大きく関係するものをより大きくする」を視覚側にも適用し、決着として
 * もっとも大きいホームランをひときわ大きく・長く、単打/四球は控えめにしている。
 */
const BANNER_STYLE: Record<
  BannerKind,
  { color: string; scale: number; durationMs: number; flashColor?: string }
> = {
  homerun: { color: '#ffe066', scale: 4, durationMs: 1400, flashColor: '#e0a83c' },
  triple: { color: '#66e0ff', scale: 3, durationMs: 900 },
  double: { color: '#66e0ff', scale: 3, durationMs: 800 },
  single: { color: '#f8f8f8', scale: 2, durationMs: 650 },
  strikeout: { color: '#ff6666', scale: 3, durationMs: 800 },
  walk: { color: '#f8f8f8', scale: 2, durationMs: 650 },
  // 守備プレーの帰結（送球・捕球）を文字でも明示する。アウトは赤系、セーフは緑系。
  out: { color: '#ff6666', scale: 3, durationMs: 900 },
  safe: { color: '#66ff88', scale: 3, durationMs: 900 },
  // 1球ごとの判定コール。捕球後の「間」（PITCH_SETTLE_SEC）の中で読み切れる長さにする。
  strike: { color: '#ffb066', scale: 2, durationMs: CALL_BANNER_SEC * 1000 },
  ball: { color: '#99ccff', scale: 2, durationMs: CALL_BANNER_SEC * 1000 },
  foul: { color: '#f8f8f8', scale: 2, durationMs: CALL_BANNER_SEC * 1000 },
  // 球威ダウンの告知。1試合に投手1人1回きりなので判定コールより長く見せるが、
  // 打席の決着（三振・本塁打）より小さくする（起きたのは「兆候」であって決着ではない）。
  stamina: { color: '#ffaa33', scale: 2, durationMs: 1400 },
  // 銃の予兆（フェーズF-26-2）。**予兆の間ずっと出ている**必要があるので、表示時間は
  // 静止時間（GUN_TELEGRAPH_SEC）と同じにする（短いと「構えた」の告知だけ消えて、
  // 何を待たされているのか分からない静止時間が残る）。色はシリアス演出のトーンに
  // 合わせた赤系で、命中時の暗転フラッシュ（gunHitFlash）と対になる。
  gunAim: {
    color: '#ff4444',
    scale: 3,
    durationMs: GUN_TELEGRAPH_SEC * 1000,
    flashColor: '#7a0000',
  },
  // 退場と交代。打席の決着と同じ大きさ（誰が消えて誰が入ったかは采配に直結する）
  ejected: { color: '#ff8866', scale: 2, durationMs: 1800 },
};

/**
 * ドット絵風パネルの共通の縁取り（白縁＋硬いオフセット影のファミコン風チャンプ）。
 * hud.ts 内のパネル以外にも、同じ見た目で統一したいUI（采配メニュー等）から再利用する
 * ため export している（詳細は ui/managerMenu.ts）。
 */
export function applyPanelChrome(el: HTMLElement): void {
  Object.assign(el.style, {
    display: 'block',
    background: 'rgba(6, 10, 36, 0.88)',
    border: '3px solid #f4f4f4',
    boxShadow: '4px 4px 0 0 rgba(0, 0, 0, 0.55)',
    margin: '8px',
  });
}

/**
 * `applyPanelChrome` がパネル1枚ごとに横へ足す幅（枠 3px×2 ＋ 余白 8px×2）。
 * **上の数値を触ったらここも一緒に動かす**：拡大率を「画面に収まるか」で決める場所
 * （`setCards`）が、canvas そのものの幅しか知らないため（縁と余白のぶんを足さずに
 * 測ると、収まっている計算なのに実際は右端がはみ出す＝実機で踏んだ）。
 */
const PANEL_CHROME_WIDTH = 3 * 2 + 8 * 2;

export function createHud(root: HTMLElement): Hud {
  // ---- スコアボード（画面左上）／状況パネル（画面右上） ----
  //
  // フェーズD-18で左上の縦積みをやめ、状況パネルを右上へ移した。縦に積むと2枚合わせて
  // 画面の上から4割ほどを占め、**中央上に出る決着バナーの帯が必ずどちらかに重なる**
  // （PROGRESS.mdのB-11の検証で記録した既存の不具合）。左右に分ければどちらも3行に収まり、
  // バナーはその下の空いた帯に置ける。
  const scoreboard = createPixelLabel('', { scale: 1, color: '#f8f8f8' });
  applyPanelChrome(scoreboard.el);
  Object.assign(scoreboard.el.style, { position: 'absolute', top: '0', left: '0' });
  root.appendChild(scoreboard.el);

  const situation = createPixelLabel('', { scale: 1, color: '#f8f8f8' });
  applyPanelChrome(situation.el);
  Object.assign(situation.el.style, { position: 'absolute', top: '0', right: '0' });
  root.appendChild(situation.el);

  // ---- モード別メッセージ（画面中央。死球/乱闘の操作案内・試合終了） ----
  // 46%→54%（フェーズD-18）：決着バナーを下げたぶん、こちらも下げて帯を分ける。
  // 同時に出うるのは「サヨナラ本塁打→試合終了」の組み合わせだけだが、そこがいちばん
  // 大きいバナー（scale 6）なので、重ならない間隔はここで確保しておく必要がある。
  const message = createPixelLabel('', { scale: 2, color: '#f8f8f8', align: 'center' });
  applyPanelChrome(message.el);
  Object.assign(message.el.style, {
    position: 'fixed',
    top: '54%',
    left: '50%',
    transform: 'translate(-50%, -50%)',
    display: 'none',
  });
  root.appendChild(message.el);

  // ---- 乱闘の操作説明と技表（フェーズG-27。update() の管理外の独立チャンネル） ----
  //
  // **画面の下端に、小さく出す**：技表は最大5行になるので、中央のメッセージ枠に出すと
  // 殴り合っている2人をまるごと覆ってしまう（実機で確認）。乱闘は画面下部に何も置かない
  // （打者・投手カードはでっかいモード専用）ので、ここが空いている。
  const brawlHintPanels = (['batter', 'pitcher'] as const).map((side) => {
    const panel = createPixelLabel('', { scale: 1, color: '#ffe066', align: 'left' });
    applyPanelChrome(panel.el);
    Object.assign(panel.el.style, {
      position: 'fixed',
      bottom: '8px',
      [side === 'batter' ? 'left' : 'right']: '8px',
      opacity: '0.88',
      display: 'none',
    });
    root.appendChild(panel.el);
    return panel;
  });

  // ---- 読みの札の表示（フェーズYY-73。update() の管理外の独立チャンネル） ----
  const readingPanel = createPixelLabel('', { scale: 2, color: '#e0b0ff', align: 'center' });
  applyPanelChrome(readingPanel.el);
  Object.assign(readingPanel.el.style, {
    position: 'fixed',
    // デバッグの行（上端の真ん中）とぶつからない高さ
    top: '104px',
    left: '50%',
    transform: 'translateX(-50%)',
    display: 'none',
  });
  root.appendChild(readingPanel.el);
  // 時間停止の間の青い沈み（画面の縁を暗く・全体を少し青く）
  const slowTintEl = document.createElement('div');
  slowTintEl.style.cssText = `
    position: fixed; inset: 0; pointer-events: none; opacity: 0;
    transition: opacity 120ms linear;
    background: radial-gradient(ellipse at center, rgba(60,110,220,0.16) 35%, rgba(10,25,90,0.72) 100%);
  `;
  root.appendChild(slowTintEl);
  let slowTintOn = false;
  // 打った後の黒（フェーズBBB-76）。原作の黒は一瞬で入って一瞬で抜ける＝フェードしない。
  // 最後に足す＝HUDのどのパネルよりも上に重なる。
  const blackoutEl = document.createElement('div');
  blackoutEl.style.cssText = `
    position: fixed; inset: 0; pointer-events: none; display: none;
    background: #000; z-index: 1000;
  `;

  // ---- デバッグモードの状態表示（フェーズPP-64。update() の管理外の独立チャンネル） ----
  const debugPanel = createPixelLabel('', { scale: 1, color: '#7ee081', align: 'center' });
  applyPanelChrome(debugPanel.el);
  Object.assign(debugPanel.el.style, {
    position: 'fixed',
    top: '8px',
    left: '50%',
    transform: 'translateX(-50%)',
    display: 'none',
  });
  root.appendChild(debugPanel.el);

  // ---- 決着演出バナー（ホームラン等。update()の管理外の独立チャンネルで
  //      一定時間後に自動的に消える。messageと混線しないよう別要素にした） ----
  //
  // 24%→「34% と 180px の大きいほう」（フェーズD-18）。上のスコアボード／状況パネルは
  // **画面の大きさによらず固定のピクセル高さ**（ドット絵を整数倍で拡大しているため）なので、
  // 位置を%だけで決めると画面が縦に小さいときだけ重なる。ピクセルの下限を併記して、
  // どちらの画面でもパネルの下端より下に出るようにする。
  const banner = createPixelLabel('', {
    scale: 3,
    color: '#f8f8f8',
    align: 'center',
    // 背景の無い大きな字は3Dの画面に直接乗るので、1ドットの縁で画面から切り離す
    outline: '#10101c',
  });
  Object.assign(banner.el.style, {
    position: 'fixed',
    top: 'max(34%, 180px)',
    left: '50%',
    transform: 'translate(-50%, -50%)',
    display: 'none',
    background: 'transparent',
    border: 'none',
    boxShadow: 'none',
  });
  root.appendChild(banner.el);
  let bannerHideTimer: ReturnType<typeof setTimeout> | null = null;
  /** 乱闘の操作説明と技表（フェーズG-27。main.ts が `setBrawlHint` で渡す） */
  let brawlHint: { batter: string | null; pitcher: string | null } | null = null;
  /**
   * 直前に `update` へ渡ってきたモード。**`update` は毎フレームではなく状態が変わったときに
   * だけ呼ばれる**（main.ts の `refresh`）ので、乱闘の最中に渡ってくる技表を出すには、
   * 受け取った側がその場で書く必要がある（実機で「技表が出ない」を踏んで気づいた）。
   */
  let lastModeState = '';

  /** 技表を実際に画面へ書く（乱闘中だけ出す。渡っていなければ出さない） */
  function syncBrawlHint(): void {
    const inBrawl = lastModeState === 'brawl';
    (['batter', 'pitcher'] as const).forEach((side, i) => {
      const text = brawlHint?.[side] ?? null;
      const show = inBrawl && text !== null;
      if (show) brawlHintPanels[i].setText(text as string);
      brawlHintPanels[i].el.style.display = show ? 'block' : 'none';
    });
    // 乱闘の画面は上端を体力ゲージが、真ん中を2人が使うので、デバッグの行は右下へ
    // （1P の乱闘では右下＝相手の技表の場所が空いている）。ちっちゃいモードも同じ
    // （上端の真ん中はカメラが追うボールの先＝落下点や外野手が隠れる。フェーズYY-73で気づいた）
    const debugLow = inBrawl || lastModeState === 'chicchai';
    Object.assign(debugPanel.el.style, debugLow
      ? { top: 'auto', bottom: '8px', left: 'auto', right: '8px', transform: 'none' }
      : { top: '8px', bottom: 'auto', left: '50%', right: 'auto', transform: 'translateX(-50%)' });
  }

  // ---- 画面下部（操作ヒント／打者・投手カード） ----
  //
  // 上から「操作ヒント（中央）」「打者カード（左）｜投手カード（右）」の順に**縦に積む**
  // （フェーズD-18）。flexの列にしてあるので、どちらが出ていても互いに重ならない：
  // 従来は操作ヒントを bottom 8% に絶対配置していたため、下部にパネルを増やすと
  // 重なりうる位置関係になっていた。
  const bottomLayer = document.createElement('div');
  Object.assign(bottomLayer.style, {
    position: 'fixed',
    left: '0',
    right: '0',
    bottom: '0',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'stretch',
    paddingBottom: '1%',
  });
  root.appendChild(bottomLayer);

  // 操作ヒント（タッチアップの猶予中／帰塁できる間／ファインプレイが届く距離に
  // ボールがある間だけ出す）
  const promptRow = document.createElement('div');
  Object.assign(promptRow.style, { display: 'flex', justifyContent: 'center' });
  bottomLayer.appendChild(promptRow);

  const playPrompt = createPixelLabel('', { scale: 1, color: '#ffe066', align: 'center' });
  applyPanelChrome(playPrompt.el);
  playPrompt.el.style.display = 'none';
  promptRow.appendChild(playPrompt.el);

  // 打者カード（左）／投手カード（右）。**中央を空ける**のは、でっかいモードの視線の
  // 通り道（投手と向かってくる球）を塞がないため。
  const cardRow = document.createElement('div');
  Object.assign(cardRow.style, {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'flex-end',
  });
  bottomLayer.appendChild(cardRow);

  // 拡大率（`CARD_SCALE`）は他のパネルと同じ3。常時見る判断材料なので小さくしない（実機で 2 を試したが、
  // 3のパネルと並ぶと読みにくかった）。そのぶん**1行を短く保つ**ほうで中央を空ける
  // ＝いちばん長い行がそのカードの幅を決める：**打者カードは能力値の行**
  // （名前＋AV＋HR＋走力のバー。フェーズFF-53で走力を併記したぶん、スキルの行を追い越して
  // ここが最長になった）、**投手カードはスタミナゲージ**（`スタミナ` ＋10目盛り）。
  const batterCard = createPixelLabel('', { scale: CARD_SCALE, color: '#f8f8f8' });
  applyPanelChrome(batterCard.el);
  cardRow.appendChild(batterCard.el);

  const pitcherCard = createPixelLabel('', { scale: CARD_SCALE, color: '#f8f8f8' });
  applyPanelChrome(pitcherCard.el);
  cardRow.appendChild(pitcherCard.el);

  /**
   * 2枚のカードを書く。**横に並べて画面に収まらなければ、整数倍のまま拡大率を落とす**
   * （フェーズFF-53。DD-51が采配メニューに入れた保険とまったく同じ形）。
   *
   * 2枚は `justify-content: space-between` の行に並ぶので、合計が画面より広いと
   * **右の投手カードが画面の外へはみ出して切れる**（実機で踏んだ：800x600 で
   * スタミナゲージの右端が消えた＝残量が読めない）。FF-53で打者カードに走力のバーが
   * 増えたぶん、狭い窓ではこれが起こりうる。**縮めるのは整数倍のまま**（ドット絵の拡大は
   * いつも整数倍＝②の約束）、**2枚とも同じ拡大率**（並べて比べるものなので、片方だけ
   * 小さいと見比べられない）。16:9の基準（1280x720・960x540）では従来どおり 3 のまま。
   */
  function setCards(batterText: string, pitcherText: string): void {
    batterCard.setText(batterText, { scale: CARD_SCALE });
    pitcherCard.setText(pitcherText, { scale: CARD_SCALE });
    // canvas.width は拡大前の論理ピクセル（pixelText.ts）＝拡大率を掛ける前の合計で測り、
    // **縁と余白（拡大率に依らない）を先に差し引く**（`PANEL_CHROME_WIDTH`）。
    const total = batterCard.el.width + pitcherCard.el.width;
    const room = root.clientWidth - PANEL_CHROME_WIDTH * 2;
    // 画面全体の倍率（`uiScale`）が掛かったうえで収まるか。収まらなければ全体の倍率を
    // 打ち消すところまで落とす（原寸の16pxより小さくはしない＝字が潰れる）
    const fit = Math.max(1, Math.floor(room / (total * uiScale())));
    if (fit < CARD_SCALE) {
      batterCard.setText(batterText, { scale: fit });
      pitcherCard.setText(pitcherText, { scale: fit });
    }
  }

  /** 打者・投手カードはでっかいモード（打席）専用。それ以外では出さない */
  function showCards(visible: boolean): void {
    batterCard.el.style.display = visible ? 'block' : 'none';
    pitcherCard.el.style.display = visible ? 'block' : 'none';
  }
  showCards(false);

  // ---- 打席の切れ目の「間」（フェーズE-23。次の打者／攻守交代を見せる） ----
  // message（死球・乱闘・試合終了）とは出る場面が排他だが、消し方が違う（あちらは
  // update() が毎回出し入れする、こちらは呼び出し側が持つ）ので別要素にする。
  //
  // 位置は**画面中央のやや下**。上寄りに置くと左上のスコアボード／状況パネルに重なって
  // カウントや控え人数を隠してしまい（実機のスクリーンショットで確認）、下寄りすぎると
  // 操作ヒント（playPrompt）とぶつかる。打者が打席に入ってくる様子のすぐ上に出る。
  const interlude = createPixelLabel('', { scale: 2, color: '#ffe066', align: 'center' });
  applyPanelChrome(interlude.el);
  Object.assign(interlude.el.style, {
    position: 'fixed',
    top: '66%',
    left: '50%',
    transform: 'translate(-50%, -50%)',
    display: 'none',
  });
  root.appendChild(interlude.el);

  // ---- 画面外の走者を指す矢印マーカー（フェーズE-24。追従カメラで画面外へ出た走者） ----
  // 色は走者メッシュ（chicchaiScene の RUNNER_COLOR）と同じ赤にする。画面外にあるものを
  // 指す印なので、**何を指しているかは色でしか伝えられない**（形は方向を表すのに使う）。
  const markerLayer = document.createElement('div');
  markerLayer.style.cssText = `
    position: fixed;
    inset: 0;
    pointer-events: none;
  `;
  root.appendChild(markerLayer);
  const markerPool: HTMLElement[] = [];

  function createMarker(): HTMLElement {
    const el = document.createElement('div');
    // 右向きの三角（CSSボーダーの定番）。回転で向きを付けるので既定は右向きに固定する。
    el.style.cssText = `
      position: absolute;
      width: 0;
      height: 0;
      border-top: 9px solid transparent;
      border-bottom: 9px solid transparent;
      border-left: 16px solid #cc3333;
      filter: drop-shadow(2px 2px 0 rgba(0, 0, 0, 0.55));
      display: none;
    `;
    markerLayer.appendChild(el);
    markerPool.push(el);
    return el;
  }

  function renderMarkers(markers: ReadonlyArray<EdgeMarker & { color?: string }>): void {
    for (let i = 0; i < markers.length; i++) {
      const el = markerPool[i] ?? createMarker();
      const m = markers[i];
      // 走者は赤。色を渡されたもの（鷹の落下点＝YY-73）はその色
      el.style.borderLeftColor = m.color ?? '#cc3333';
      el.style.left = `${m.x * 100}%`;
      el.style.top = `${m.y * 100}%`;
      el.style.transform = `translate(-50%, -50%) rotate(${m.angle}rad)`;
      el.style.display = 'block';
    }
    for (let i = markers.length; i < markerPool.length; i++) {
      markerPool[i].style.display = 'none';
    }
  }

  // 銃命中／ホームランの画面フラッシュ（共通の全画面オーバーレイを色だけ変えて使い回す）
  const flashEl = document.createElement('div');
  flashEl.style.cssText = `
    position: fixed;
    inset: 0;
    opacity: 0;
    pointer-events: none;
  `;
  root.appendChild(flashEl);

  function flashOverlay(color: string, opacity: number, fadeMs: number): void {
    flashEl.style.transition = 'none';
    flashEl.style.background = color;
    flashEl.style.opacity = String(opacity);
    requestAnimationFrame(() => {
      flashEl.style.transition = `opacity ${fadeMs}ms ease-out`;
      flashEl.style.opacity = '0';
    });
  }

  // ---- 乱闘の画面（乱闘v3。フェーズXX-72＝`brawlHud.ts`） ----
  const brawlHud = createBrawlHud(root);

  /**
   * 状況パネルの `◆ソウサ:` の行（フェーズD-20で2P対応）。
   *
   * 1P PLAY は従来どおり「自分が今どちらを操作しているか」1つだけ。2P PLAY は
   * **両方の役割を並べる**＝画面が1つしかない以上、どちらのパッドが今どちらを担って
   * いるかは表示でしか分からない（攻守交代のたびに入れ替わる）。
   */
  function controlLine(
    controllers: SideControllers,
    half: Half,
    labels: { fielding: string; batting: string },
  ): string {
    const fielding = fieldingTeam(half);
    if (!isTwoPlayer(controllers)) {
      return `◆操作:${controllers[fielding] !== 'cpu' ? labels.fielding : labels.batting}`;
    }
    const first = controllers[fielding] === 'p1' ? labels.fielding : labels.batting;
    const second = first === labels.fielding ? labels.batting : labels.fielding;
    return `◆1P:${first} 2P:${second}`;
  }

  return {
    update(game, modeState, gunMode, controllers, run, leads) {
      lastModeState = modeState;
      // 操作ヒントを出すのはちっちゃいモード（フィールドプレー中の操作）と
      // でっかいモード（盗塁を仕掛けられる、の案内）だけ。保険として、それ以外の
      // モード（死球・乱闘）と試合終了では必ず消す（通常は表示している側＝
      // フィールドプレー／main.ts が状況の変化で閉じる）。
      if ((modeState !== 'chicchai' && modeState !== 'dekkai') || game.winner) {
        playPrompt.el.style.display = 'none';
      }
      // 打席の切れ目の「間」はでっかいモードだけのものなので、そこを離れたら必ず消す
      // （通常は main.ts の updateInterlude が消化しきってから閉じる）。
      if (modeState !== 'dekkai' || game.winner) {
        interlude.el.style.display = 'none';
      }
      // 画面外マーカーはちっちゃいモード（追従カメラ）だけのもの。プレーが終われば
      // main.ts が空配列で消すが、モードが変わったときの取りこぼしを保険で塞ぐ。
      if (modeState !== 'chicchai' || game.winner) {
        renderMarkers([]);
      }

      if (game.winner) {
        scoreboard.setText(scoreboardText(game, run));
        scoreboard.el.style.display = 'block';
        situation.el.style.display = 'none';
        showCards(false);
        message.setText(winnerText(game));
        message.el.style.display = 'block';
        brawlHud.setVisible(false);
        return;
      }

      // 乱闘中はHP体力ゲージが画面上部を使うため、スコアボード/状況パネルは隠す
      const showFieldPanels = modeState !== 'brawl';
      scoreboard.setText(scoreboardText(game, run));
      scoreboard.el.style.display = showFieldPanels ? 'block' : 'none';
      situation.el.style.display = showFieldPanels ? 'block' : 'none';
      brawlHud.setVisible(modeState === 'brawl');
      // 打者・投手カード（フェーズD-18）は打席の情報なので、でっかいモードだけで出す。
      showCards(modeState === 'dekkai');

      if (modeState === 'dekkai') {
        message.el.style.display = 'none';
        // 銃の行はスキル `ジュウ` を持つ投手がマウンドにいるときだけ出す（フェーズF-26-2）。
        // **持っていなければ行ごと消える**＝銃はランごとの当たりになったので、取っていない
        // 試合では存在しないものとして扱う（スキルの行をカードに出さないのと同じ整理）。
        // 弾切れ（ノコリ 0）は「銃持ちだが撃てない」ことの表示なので、行は残す。
        const gun = gunLine(game.rosters[fieldingTeam(game.half)], gunMode);
        // 2P/CPU操作分離（セッション9でっかいモード拡張）：今この打席で人間が
        // 投球・打撃のどちらを操作しているかを明示する（chicchaiの「◆ソウサ」表示と同じ方針）。
        // Startキーで開ける采配メニュー（代打/継投）の存在も常時ヒント表示する
        // （意思決定材料は隠さない、という既存方針をメニューの発見しやすさにも適用）。
        const control = controlLine(controllers, game.half, {
          fielding: '投球',
          batting: '打撃',
        });
        // イニングとカウントは1行にまとめている（フェーズB-11でスタミナの行が増えたぶん、
        // パネルの高さを元に戻すため）。打順・控えの残り人数・スタミナは
        // フェーズD-18で打者カード／投手カードへ移した（パネルの横幅を縮めて
        // 決着バナーとの重なりを解消するため。カード側のコメント参照）。
        // リードの行（フェーズL-32）は銃の行と同じく、あるときだけ差し込む。
        // **カウントの行の直後**に置くのは、走るか投げるかの判断がカウントと一体だから
        // （0-2 で深いリード、といった読み方が1か所でできる）。
        // 走力の行（フェーズFF-53）はそのリードの行の直後＝**同じ走者についての
        // 2つの材料（どれだけ離れているか・どれだけ速いか）が縦に並ぶ**。リードは
        // けん制のプレーの後にしか無く、走力は走者がいれば必ずあるので、順序を
        // 逆にすると「あったり無かったりする行」が下に来て並びが安定しない。
        situation.setText(
          `${game.inning}回${halfLabel(game.half)}  B${game.count.balls} S${game.count.strikes} O${game.outs}${leadLine(leads)}${runnerSpeedLine(game)}${gun}\n${control}  Start:作戦`,
        );
        // 打者は攻撃側／投手は守備側のロスターから引く（＝カードは常に「今の対戦」を出す。
        // 人間がどちらを操作しているかによらず同じものを見せる既存方針どおり）。
        setCards(
          batterCardText(
            game.rosters[battingTeam(game.half)],
            game.inning,
            game.score[battingTeam(game.half)] < game.score[fieldingTeam(game.half)],
          ),
          pitcherCardText(game.rosters[fieldingTeam(game.half)]),
        );
      } else if (modeState === 'chicchai') {
        message.el.style.display = 'none';
        // 2P/CPU操作分離：今このプレーで人間が何を操作しているか（守備/走塁）を明示する
        const control = controlLine(controllers, game.half, {
          fielding: '守備',
          batting: '走塁',
        });
        situation.setText(`O ${game.outs}\n${runnerDiamond(game)}\n${control}`);
      } else if (modeState === 'deadBall') {
        situation.setText('デッドボール！');
        // **乱闘に持ち込むかを決めるのは殴られた打者側**（CLAUDE.md ③）。2P PLAY では
        // それがどちらのプレイヤーかと、その人が押すキーまで出す（フェーズD-20。
        // ヒントに1Pのキー名を固定で書くと、2Pには押せないキーを案内することになる）。
        const batterPlayer = playerOfSide(controllers, battingTeam(game.half));
        const twoPlayer = isTwoPlayer(controllers);
        if (!batterPlayer) {
          // 打者側がCPU（1P PLAYで人間が投手）：**投手の側は決められない**（フェーズWW-71）。
          // CPUの打者が決めるまで待つ（`CPU_BRAWL_DECISION_SEC`）ことだけを出す
          message.setText('打者の出方を待つ…');
        } else {
          const who = twoPlayer ? `${PLAYER_LABEL[batterPlayer]}が決める\n` : '';
          const keys = batterPlayer === 'p2' ? '（[1]=はい / [2]=いいえ）' : '（J=はい / K=いいえ）';
          message.setText(`${who}乱闘する？\n${keys}`);
        }
        message.el.style.display = 'block';
      } else if (modeState === 'brawl') {
        // 乱闘v2（フェーズG-27）：**操作と技表は main.ts が組んで渡す**（`setBrawlHint`）。
        // どの必殺技を持っているか（スキル）と、その人が押す向き（画面左右で前が逆）は
        // HUDからは見えないため。中央のメッセージ枠は使わず、下端の専用パネルに出す。
        message.el.style.display = 'none';
      }
      syncBrawlHint();
    },

    gunHitFlash() {
      flashOverlay('#3a0000', 0.6, 280);
    },

    updateBrawl(view, dt) {
      brawlHud.update(view, dt);
    },

    brawlCallout(text, tone) {
      brawlHud.callout(text, tone);
    },

    brawlSuperFlash() {
      flashOverlay('#000010', 0.6, 650);
    },

    setReading(text) {
      if (text === null) {
        readingPanel.el.style.display = 'none';
        return;
      }
      readingPanel.setText(text);
      readingPanel.el.style.display = 'block';
    },

    slowTint(on) {
      if (on === slowTintOn) return;
      slowTintOn = on;
      slowTintEl.style.opacity = on ? '1' : '0';
    },

    blackout(on) {
      // 黒はほかのどのパネルより上に重なる（後から足されたパネルがあっても必ず最後尾へ）
      if (on && blackoutEl.parentElement !== root) root.appendChild(blackoutEl);
      if (on && root.lastElementChild !== blackoutEl) root.appendChild(blackoutEl);
      blackoutEl.style.display = on ? 'block' : 'none';
    },

    setDebugLine(text) {
      if (text === null) {
        debugPanel.el.style.display = 'none';
        return;
      }
      debugPanel.setText(text);
      debugPanel.el.style.display = 'block';
    },

    setBrawlHint(hint) {
      if (
        hint === brawlHint ||
        (hint !== null && brawlHint !== null && hint.batter === brawlHint.batter && hint.pitcher === brawlHint.pitcher)
      ) {
        return;
      }
      brawlHint = hint;
      // 渡ってきたぶんはその場で書く（`update` が呼ばれるのは**状態が変わったときだけ**
      // なので、変数を書くだけでは画面に出ない＝実機で「技表が出ない」を踏んで気づいた）。
      // playPrompt・interlude と同じ「update の管理外の独立チャンネル」の扱いに揃えた形。
      syncBrawlHint();
    },

    playBanner(kind, text) {
      const style = BANNER_STYLE[kind];
      if (bannerHideTimer) clearTimeout(bannerHideTimer);
      banner.setText(text, { color: style.color, scale: style.scale });
      banner.el.style.display = 'block';
      if (style.flashColor) flashOverlay(style.flashColor, 0.45, 420);
      bannerHideTimer = setTimeout(() => {
        banner.el.style.display = 'none';
        bannerHideTimer = null;
      }, style.durationMs);
    },

    showPlayPrompt(lines) {
      if (lines.length === 0) {
        playPrompt.el.style.display = 'none';
        return;
      }
      playPrompt.setText(lines.map(playPromptLineText).join('\n'));
      playPrompt.el.style.display = 'block';
    },

    showInterlude(text) {
      if (text === null) {
        interlude.el.style.display = 'none';
        return;
      }
      interlude.setText(text);
      interlude.el.style.display = 'block';
    },

    showRunnerMarkers(markers) {
      renderMarkers(markers);
    },
  };
}
