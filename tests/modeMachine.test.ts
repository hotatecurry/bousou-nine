import { describe, expect, it } from 'vitest';
import { createActor } from 'xstate';
import { modeMachine } from '../src/core/modeMachine';

function startMode() {
  return createActor(modeMachine).start();
}

describe('modeMachine: モード遷移', () => {
  it('初期状態はでっかいモード（通常投球）', () => {
    const actor = startMode();
    expect(actor.getSnapshot().matches({ dekkai: 'normal' })).toBe(true);
  });

  it('銃モードをON/OFF切り替えできる', () => {
    const actor = startMode();
    actor.send({ type: 'GUN_TOGGLE' });
    expect(actor.getSnapshot().matches({ dekkai: 'gun' })).toBe(true);
    actor.send({ type: 'GUN_TOGGLE' });
    expect(actor.getSnapshot().matches({ dekkai: 'normal' })).toBe(true);
  });

  it('打球発生で自動的にちっちゃいモードへ', () => {
    const actor = startMode();
    actor.send({ type: 'BATTED_BALL' });
    expect(actor.getSnapshot().matches('chicchai')).toBe(true);
  });

  it('プレー完了ででっかいモードへ自動復帰（銃モードは解除される）', () => {
    const actor = startMode();
    actor.send({ type: 'GUN_TOGGLE' });
    actor.send({ type: 'BATTED_BALL' });
    actor.send({ type: 'PLAY_COMPLETE' });
    expect(actor.getSnapshot().matches({ dekkai: 'normal' })).toBe(true);
  });

  it('死球後は乱闘選択状態になり、仕掛ければ乱闘へ', () => {
    const actor = startMode();
    actor.send({ type: 'DEAD_BALL' });
    expect(actor.getSnapshot().matches('deadBall')).toBe(true);
    actor.send({ type: 'BRAWL_START' });
    expect(actor.getSnapshot().matches('brawl')).toBe(true);
  });

  it('乱闘を仕掛けなければでっかいモードへ戻る', () => {
    const actor = startMode();
    actor.send({ type: 'DEAD_BALL' });
    actor.send({ type: 'BRAWL_DECLINED' });
    expect(actor.getSnapshot().matches({ dekkai: 'normal' })).toBe(true);
  });

  it('乱闘決着後はでっかいモードへ戻る', () => {
    const actor = startMode();
    actor.send({ type: 'DEAD_BALL' });
    actor.send({ type: 'BRAWL_START' });
    actor.send({ type: 'BRAWL_END' });
    expect(actor.getSnapshot().matches({ dekkai: 'normal' })).toBe(true);
  });

  it('ちっちゃいモード中は銃モードに切り替えられない', () => {
    const actor = startMode();
    actor.send({ type: 'BATTED_BALL' });
    actor.send({ type: 'GUN_TOGGLE' });
    expect(actor.getSnapshot().matches('chicchai')).toBe(true);
  });
});

describe('modeMachine: けん制球（説明書p24）', () => {
  it('けん制でちっちゃいモードへ切り替わり、プレー完了ででっかいモードへ戻る', () => {
    const actor = startMode();
    actor.send({ type: 'PICKOFF' });
    expect(actor.getSnapshot().matches('chicchai')).toBe(true);
    actor.send({ type: 'PLAY_COMPLETE' });
    expect(actor.getSnapshot().matches({ dekkai: 'normal' })).toBe(true);
  });

  it('ちっちゃいモード中のけん制入力は無視される（二重に入らない）', () => {
    const actor = startMode();
    actor.send({ type: 'BATTED_BALL' });
    actor.send({ type: 'PICKOFF' });
    expect(actor.getSnapshot().matches('chicchai')).toBe(true);
    actor.send({ type: 'PLAY_COMPLETE' });
    expect(actor.getSnapshot().matches({ dekkai: 'normal' })).toBe(true);
  });
});

describe('modeMachine: 盗塁（説明書p13）', () => {
  it('盗塁でちっちゃいモードへ切り替わり、プレー完了ででっかいモードへ戻る', () => {
    const actor = startMode();
    actor.send({ type: 'STEAL' });
    expect(actor.getSnapshot().matches('chicchai')).toBe(true);
    actor.send({ type: 'PLAY_COMPLETE' });
    expect(actor.getSnapshot().matches({ dekkai: 'normal' })).toBe(true);
  });

  it('ちっちゃいモード中の盗塁入力は無視される（プレー中に二重で入らない）', () => {
    const actor = startMode();
    actor.send({ type: 'BATTED_BALL' });
    actor.send({ type: 'STEAL' });
    expect(actor.getSnapshot().matches('chicchai')).toBe(true);
  });
});
