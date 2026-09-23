# Bousou Nine (暴走ナイン)

[日本語](README.md) | **English**

A browser baseball game built around the feel of the Famicom-era baseball games:
Three.js + TypeScript, played entirely with **two buttons and a D-pad**.

On top of that sit things the originals never had — a **roguelite** layer (a run is five
games; 85 skills), plus **guns** and **brawls**. The simulation is played straight; the
names and visuals are not.

> [!NOTE]
> The original games are a **reference for behaviour only**. No assets from them are
> included: every team name, player name, and rating here is original. The manual scan
> used for reference is cited by URL in `CLAUDE.md`, and no ROM is in this repository.

---

## Running it

```bash
npm install
npm run dev      # http://localhost:5173
```

Requires Node.js 20+ (Vite 7). `npm run build` to build, `npm test` to run the suite.

## Controls

| | 1P | 2P |
|---|---|---|
| Move / select | `W` `A` `S` `D` | `↑` `←` `↓` `→` |
| A (swing / pitch / throw / return) | `K` | numpad `2` |
| B (run / tag / pickoff toggle) | `J` | numpad `1` |
| Start (manager menu) | `Enter` | numpad `Enter` |
| Select (confirm) | `Shift` | numpad `0` |
| Extra (gun / dropkick / one-at-bat buff) | `G` | numpad `3` |
| Music on/off | `M` | `M` (shared) |

**A and B change meaning with the situation** — the multi-purpose button scheme the
originals used. Bases are named by absolute direction: **up = 2nd, left = 3rd,
right = 1st, down = home**.

<details>
<summary>Things worth knowing</summary>

- **Batting**: hold `K` for a full swing; release before contact to bunt. While bunting,
  left/right aims the roll and `W` pushes it. Outside the swing, left/right moves your
  **stance in the box**.
- **Pitching**: up/down during the windup sets speed, left/right at the instant of release
  sets the location, left/right after release curves the ball.
- **Leading off**: during a pickoff you leave the bag **only while you hold the direction
  of the next base**. Don't hold it and you cannot be picked off. The further you go, the
  better your jump on the next pitch (the lead carries over).
- **Fielding**: catching needs no button — just put a fielder on the ball. `K` + direction
  throws, `J` + direction starts a rundown.

</details>

## What's in it

- **Two views**, switched automatically: a close "big" view for pitching and hitting, and a
  scrolling "small" view for fielding and baserunning.
- **16 teams × 17 players** and **6 ballparks**. Ratings cover contact, power, speed and
  batting side for hitters; throwing arm, ERA, velocity, break and stamina for pitchers —
  and **every number shown on screen is derived from those ratings**.
- **Roguelite**: a run is 5 games. At the top of each inning you pick 1 of 3 skills and
  attach it to a player (3 slots each). **85 skills** (25 common / 33 uncommon / 10 rare /
  17 duos). Collect two specific skills **on the same player** and a fused skill enters the
  pool. Three rerolls per run.
- **The CPU plays the same game**: it holds skills, guns and buffs, and decides on relief
  pitchers, pinch hitters, pinch runners, intentional walks, steals and tag-ups.
  **Every rule is deterministic**, so it can be read and countered rather than guessed at.
- **1P and 2P play** (two pads share one keyboard).
- **Look and sound**: toon-shaded 3D (cel shading plus outlines) and a pixel font
  (DotGothic16). Sound effects, the crowd and the chiptune-style music are all synthesized
  in the browser — there are no audio files.

## Design rules

**No randomness in the simulation.** Hitting, pitching, fielding, baserunning and brawls
are pure functions in `src/core/`, so the same input always produces the same result.
The only draws are **which skills are offered** and **who is hot that game**, and that
state lives in the seed — fix the seed and the whole game replays identically.

**Numbers are measured, not guessed.** Home run frequency, skill strength and every
threshold come out of the tools in `tools/balance/`. Those tools contain no rules of their
own; they call the same pure functions the game does, so changing a constant moves the
measurement with it. Results are pinned in `tests/balance.test.ts` as **ranges and
orderings** rather than exact values.

```bash
npm run balance        # overall report
npm run balance:hr     # home run frequency
npm run balance:steal  # the stolen-base window
# also balance:map / :bunt / :control / :relief / :pinchrun and more
```

**One source per fact.** The batting average on the HUD card, the pitch quality the CPU
weighs when changing pitchers, the fence you see and the fence the ball collides with —
each has exactly one origin, so the screen can't disagree with the simulation.

## Layout

```
src/core/      rules and judgement (pure functions, no randomness)
src/scenes/    the big view, the small view, and brawls
src/entities/  players, ball, ballpark, props
src/render/    toon shading, outlines, lighting and shadows
src/audio/     sound effects, crowd and music (all synthesized)
src/ui/        HUD, team select, manager menu, skill draft
tools/balance/ balance measurement (not shipped with the game)
tests/         1,691 tests
assets-src/    Blender sources and the scripts that rebuild the models
```

## Documentation

This project is developed with [Claude Code](https://claude.com/claude-code), and the
reasoning behind each decision is kept in the repository. The documents are written in
Japanese.

| File | Contents |
|---|---|
| [CLAUDE.md](CLAUDE.md) | Settled specifications, controls, and design commitments |
| [PROGRESS.md](PROGRESS.md) | Per-session implementation notes: what was measured, what was decided |
| [ORIGINAL_PARITY.md](ORIGINAL_PARITY.md) | Differences from the original manual, and the phased plan |

**Rejected ideas are recorded too**, with the reason. For example: sacrifice bunts cannot
work under this fielding model, and reordering the lineup does not move run expectancy —
in both cases the measurement overruled the intended implementation.
