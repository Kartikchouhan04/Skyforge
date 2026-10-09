# Skyforge Stadium — Project Context

A handover document: what the game is, how it's built, what's done, what's broken, and what comes next. Read this before changing anything. Gameplay rules are also covered in `README.md`; this file adds the engineering context. Last updated 2026-10-09.

**Repository:** `github.com/Kartikchouhan04/Skyforge` (branch `main`). The local folder is `neon-relay`. If a push fails with "Repository not found", fix the remote: `git remote set-url origin https://github.com/Kartikchouhan04/Skyforge.git`.

> **Status (2026-10-09):** the earlier unverified batch now passes `npx tsc --noEmit` and `npm run build`, but it still hasn't been played in a browser. This session added Round 11 Sudden Death (safe zone, timeout tiebreak), server result logging, the first committed rule tests (`npm test`) and a few stadium additions. See [Session 2026-10-09](#session-2026-10-09). The new visuals (zone wall, spawn gates, holo adverts, broadcast booths, tower emergency strobe) have **not been looked at in a browser** yet.

---

## 1. What the game is

A competitive 5v5, objective-based aerial combat game that runs in a desktop browser. Each round, one team attacks three strategic towers with five fighter jets while the other team defends them with three ground crews and two jets. The arena is the Skyforge Stadium, a huge enclosed aerospace stadium with stands, crowd, banners, a central reactor, airfields at both ends and an energy barrier.

---

## 2. Architecture

| Layer | Technology | Notes |
|---|---|---|
| Web app | Next.js 16 (App Router), React 19, TypeScript | `AGENTS.md` warns that this Next.js version differs from older docs. Read `node_modules/next/dist/docs/` before changing Next-specific code. |
| 3D | Three.js r186, WebGL2 | Custom post chain, procedural models; no asset files. |
| Server | Node, `server.ts` run with `tsx` | A custom HTTP server wraps Next and adds the WebSocket game endpoint `/api/game` (via `ws`). |
| Audio | WebAudio, synthesised | No sound files (`src/lib/sfx.ts`). |

**Run:** `npm run dev` for development (`tsx server.ts --dev`, port 3000). Use `npm run build` then `npm run start` for production. Changes to `server.ts`, `match.ts`, `protocol.ts` or `flight.ts` need a **server restart**; client-only changes hot-reload. `npm run start` serves the last build, so always rebuild before using it.

### Authoritative simulation

```
client (game-client.tsx)  --input 20Hz-->  server.ts  --> match.ts (rules) --> flight.ts (physics)
        ^                                       |
        +------------ RoomState snapshot 30Hz --+
```

- **`src/lib/match.ts`** contains **all game rules**. It is a pure module with time passed in: roles, rounds, towers, stations, weapons, hits, repairs and results. The multiplayer server and offline training both run it, so they behave identically, and it can be unit tested headlessly.
- The server is authoritative for every hit, repair, tower destruction and round result. Clients only send inputs.
- **Offline training** (`src/lib/training.ts`) runs a `match.ts` room in *practice* mode in the browser, with AI drones, no timer and respawns.
- **Rendering** (`src/lib/arena3d.ts`) reads the latest snapshot every frame. It extrapolates jets and projectiles between 30Hz ticks for smooth 60fps motion.

### Scale model (in `src/lib/protocol.ts`)

- `ARENA_SCALE = 36` sizes the place: stadium shell, flight volume (34,560 × 26,640, ceiling 10,800), towers, stations, airfields, spawns, Weapons Tower reach and ground-unit driving speed.
- `FLIGHT_SCALE = 3` sizes the jets' world: speeds, accelerations, weapon ranges and hit radii.
- `METERS_PER_UNIT = 0.42` is used only by the instruments (knots, Mach, feet).
- The stadium shell is modelled at 1× and scaled as one group (`SHELL_SCALE`). Crowd seats are a fixed world size, so a bigger bowl holds more people.

---

## 3. Game rules (as implemented)

### Teams and format
- Ten players in two teams: **Blue Team** (internal id `azure`) and **Red Team** (`ember`). Teams auto-balance on join; the maximum is 5 per team.
- **Rounds:** up to **11**, five minutes each.
  - Rounds 1–5: Blue defends. Rounds 6–10: Red defends.
  - Round 11 is **Sudden Death**: all 10 players in jets, no towers or ground crews, played only at 5–5 (see below).
  - The **first team to 6** round wins takes the match, which ends immediately.
- **Draws** award no point and are replayed (OT1, OT2…) with the same roles and round number. Health, tower damage, repair charges and ammo reset for the replay. Draws are never settled at random.
- **Simultaneous elimination** is judged on the server's simulation tick: `checkRoundEnd` runs once per tick, after every hit, crash and zone burn. Every decided round records its `tick` and is pushed to `room.audit`, which `server.ts` drains and logs as `[result] …` lines (tick, survivors, health, score).
- **Phases:** lobby (10 s wait once both teams have a player) → **preparation** (15 s: choose equipment, instant station moves) → **countdown** (5 s, weapons safe) → combat → intermission (9 s, or 14 s at the side switch and before the tiebreaker) → … → results (shown for 90 s, then the room resets).
- **No respawns** during a round. Eliminated players spectate a chosen teammate (Q/E or click). Players who join during preparation are deployed; later joiners wait for the next round.

### Round 11 — Sudden Death
- **Duration:** `TIEBREAKER_SECONDS = 180`.
- **Safe zone** (`SUDDEN_DEATH` in protocol.ts, `zoneAt`/`stepZone` in match.ts):
  - a vertical cylinder at the centre, starting at radius √(480²+370²)·A so it covers the whole flight volume
  - holds for 60 s, then shrinks linearly over 105 s to 110·A, leaving the last 15 s at the minimum
  - jets outside lose 3 HP/s while it holds, rising linearly to 20 HP/s once fully closed
  - computed from the clock alone, sent to clients as `RoomState.zone`
- **Win order:**
  1. last squadron with a jet flying
  2. both squadrons out on the same tick: draw
  3. at time: more surviving jets
  4. then more combined health
  5. dead level: draw
- **Draws** are replayed as Sudden Death OT1, OT2… indefinitely.
- **UI:** a SUDDEN DEATH card during preparation, a red countdown, a zone and survivors panel in place of the tower chips, an OUTSIDE THE SAFE ZONE warning, the zone ring on the radar, the zone wall in 3D, and a SUDDEN DEATH VICTORY results screen.

### Roles
- **Attackers:** five jets.
- **Defenders:** two jets and three ground crews.
  - The two jets go first to players whose preference is PILOT, then ANY, then by join order.
  - Small rooms scale down: a 1-player defence gets one ground crew; 2–3 players get one jet; 4–5 players get two jets.

### Win conditions (tower rounds)
1. All three towers destroyed: **attackers win**. The objective is checked first, even if the last defender or attacker went down on the same tick (rule 10).
2. Both sides eliminated with a tower standing: **draw**.
3. All defenders eliminated: **attackers win**.
4. All attackers eliminated: **defenders win**.
5. Time runs out with at least one tower standing: **defenders win**.

### Towers (1,000 HP each)

| Tower | Position (defender's end) | Effect while standing |
|---|---|---|
| **Shield** | north flank | Radar and Weapons take **50%** damage. Can't be restored once destroyed. |
| **Weapons** | front centre | Automated leading flak, range `65 × ARENA_SCALE`: every 0.34 s, or 0.18 s when a ground crew is set up at one of its stations. |
| **Radar** | south flank | Every defender sees attackers within `560 × ARENA_SCALE`. |

- Hits count anywhere on the tower's outline (plinth to crown) and on a shield bubble, with the shield's reduction applied.
- Below 25% HP a tower goes **critical**: alarm, siren, sparks and smoke.
- Destruction plays a chain of explosions with sparks, a burning stump and smoke, and updates the scoreboard.
- Destroyed towers stay down for the rest of the round. Jets that fly into a tower crash.

### Ground crews
- Each tower has two gun stations in front of it (stations 1–6) and a repair pad behind it (7–9). Moving between them takes a few seconds; the guns can't fire on the move.
- **Flak cannon:** proximity fuse.
- **Interceptor missile (SAM):** guided onto a lock, straight without one; 6 s cooldown.
- **Loadouts** (chosen during preparation; ammo is per round):

  | Loadout | Flak | SAMs |
  |---|---|---|
  | Balanced | 450 | 4 |
  | Flak | 700 | 2 |
  | Interceptor | 250 | 7 |

- **Shield activation (F):** halves damage to the tower beside the crew for 6 s; 40 s cooldown; stacks with the Shield Tower.
- **Repair:** hold R at a repair pad for **4 s** to restore **100 HP** (capped at max). **3 charges** per round, **30 s** cooldown. Damage, letting go or leaving the pad interrupts it, and a charge is only spent on completion. Destroyed towers can't be repaired.

### Jets

| Airframe | Top speed | Afterburner adds | Max G | Thrust |
|---|---|---|---|---|
| Swift | 570S | 300S | 9 | 2.4 |
| Bastion | 496S | 320S | 7.5 | 2.1 |

(S = `FLIGHT_SCALE`.)

- **Cannon:** dispersion and gravity drop.
- **Missile:**
  - drops from alternating pylons, then the motor (about 45 g) takes it to about **Mach 4.4** (`1200S`)
  - with a lock it homes by **proportional navigation** (N=4, 45 g limit), and loses the target if it leaves the seeker's ~52° field of view; without a lock it flies straight
  - proximity fuse; self-destructs after 8 s; **5 s reload**; lock range 1400S
- **Warnings:** "LOCKED BY …" and "MISSILE INBOUND", with tones.
- **Damage effects:** smoke trail when damaged, fire below 30 HP.
- **Flight model** (`flight.ts`): quaternion orientation; the stick commands G; bank-to-turn assist; stall; Auto-GCAS; soft energy barrier.

---

## 4. Controls

| Pilot | Key |
|---|---|
| Pitch | Mouse / ↑↓ |
| Turn | A/D, ←→ or mouse sideways |
| Roll | Q/E |
| Throttle | W/S |
| Afterburner | Space |
| Air brake | Shift |
| Cannon | LMB or **F** (hold) |
| Missile | RMB or **R** |
| Sound | M |

| Ground crew | Key |
|---|---|
| Aim | Mouse or WASD |
| Flak | LMB |
| SAM | RMB |
| Move station | 1–9, Q/E |
| Repair | Hold R (at a pad) |
| Shield | F |

---

## 5. Important files

| File | Purpose |
|---|---|
| `server.ts` | HTTP + WebSocket server; one `match.ts` room per room code, stepped at 30Hz. `/api/health`. Must call `app.getUpgradeHandler()` **after** `app.prepare()`, or dev HMR breaks hydration. |
| `src/lib/protocol.ts` | **All tunable numbers** (scales, jets, combat, towers, ground, loadouts), shared types, tower and station layout. |
| `src/lib/match.ts` | Game rules and combat simulation: phases, roles, towers, repairs, abilities, projectiles, guidance, hit detection, results. |
| `src/lib/flight.ts` | Flight model shared by server and training. |
| `src/lib/training.ts` | Offline drills: attack drill (pilot vs Red towers) and defence drill (gunner; drones make strafing runs). |
| `src/lib/arena3d.ts` | Renderer: scene, post chain (bloom + single `FinalShader` for tone mapping, sRGB, FXAA and grade), cameras (chase / gunner / spectate), projectiles, particles, HUD world markers, tower and station sync. |
| `src/lib/skyforge.ts` | The stadium: bowl, **crowd shader** (people, scarves, fans' banners, tifos, phone lights), flags, roof, dome, reactor, gates, scoreboards, LED boards, industrial yard, weather, day/night cycle, alarms. |
| `src/lib/defences.ts` | Towers (per-type crowns, shield bubble), gun stations and repair pads, ground AA units, repair beam. |
| `src/lib/jets.ts` | Jet models, liveries, afterburner, nav lights, vapour trails. |
| `src/lib/arena-kit.ts` | Shared builders: sky shader, `mergeStaticMeshes` (draw-call batching), impacts, surface textures. |
| `src/lib/particles.ts` | Pooled particle fields (smoke, fire, sparks, missile trails, flak puffs). |
| `src/lib/sfx.ts` | Synthesised sound effects. |
| `src/components/game-client.tsx` | All UI and input: hangar, HUD, prep panel, results, controls → input packets, training loop. |
| `src/components/arena-view.tsx`, `radar-scope.tsx`, `attitude-indicator.tsx` | 3D view wrapper, radar canvas, artificial horizon. |
| `src/app/*.css` | Styles. `match.css` holds the match HUD (Sudden Death styles at the end). Fonts: Barlow and Barlow Condensed (Google Fonts). |
| `tests/match.test.ts` | Headless rule tests for Round 11, the zone, draws and replays, objective-first, and the audit log. Run with `npm test`. |

---

## 6. Completed work (high level)

- **Stadium:** stands with a per-pixel crowd, banners and flags, scoreboards, LED boards, roof and floodlights, dome, reactor, gates, bridges, tunnels, floating pads, industrial yard, weather, day/night cycle, destructible props, energy barrier.
- **Performance:** 60 fps on integrated AMD graphics at the 18× scale. This came from draw-call merging, no dynamic lights, no transmission, single-pass post, CSS-pixel resolution and a 10Hz HUD. Fixed a black-frame flicker caused by NaN pixels reaching bloom (`safeNormalize`, bloom input clamp).
- **Flight model** rewritten and tested (29 flight tests passed at the time).
- **Match system:** full ruleset above, including preparation phase, typed towers, repairs, loadouts, shield activation, side switch, tiebreaker, overtime and results screen. At the time it was verified, it passed 77 headless rule tests and a browser playthrough of a full match with bots.
- **Weapons and effects:** realistic firing, missile guidance, flak, damage effects, sound, HUD markers, threat warnings, radar.
- **Readable UI:** fonts, sizes and HUD layout.

---

## 7. Known bugs and open issues

1. **Firing while holding turn/roll keys (reported, unresolved).** The user reports no firing while holding A/D/Q/E, even with the F key. Code review found nothing that blocks it (the server fires whenever `input.primary` is set). Suspects:
   - (a) the user is running an **old build**: check that the HUD shows "GUN (LMB / F)", restart `npm run dev` and hard-refresh;
   - (b) laptop touchpad palm rejection (affects clicks only, not F).
   The HUD's orange **FIRING** indicator was added to tell these apart. **Needs hands-on testing in a browser.**
2. **Unverified changes:** see the next section. They may contain compile errors.
3. **Performance at `ARENA_SCALE = 36` not re-measured.** Shadow-map texels cover twice the area, and the crowd shader draws more seats per pixel.
4. **Handling at 2× jet speed:** turn radius is about 4× larger for the same G, so jets may feel sluggish. Turn rates may need raising.
5. **Test suite only partly restored.** `tests/match.test.ts` (12 rule tests, `npm test`) covers Round 11, the zone, draws, replays and the audit log. The older general rule tests, flight tests, missile tests and browser scripts are still lost.
6. `next dev` rewrites `next-env.d.ts`, which shows as a modified file. This is harmless.
7. The crowd banner atlas texture is never disposed on unmount (minor leak).
8. Results tables show nothing for players who left mid-match (their stats are removed with them).

### Unverified changes
Written after terminal access was lost. They were reviewed by reading only, never compiled or run:
- `ARENA_SCALE` 18 → 36 (stadium ×2)
- missiles Mach 4.4 with proportional-navigation guidance, seeker field of view, proximity fuse, narrower lock cone
- jets ×2 speed, stronger afterburner, higher thrust
- tower hit outline (`TOWER_PROFILE`, shield bubble hits, swept path test)
- window-level mouse input, buttons read from mouse moves, F/R fire keys, HUD trigger indicator
- crowd realism and fans' banners in the crowd shader (`createCrowdBannerAtlas`, new GLSL)

---

## Session 2026-10-09

**Verified:**
- `npx tsc --noEmit` and `npm run build` pass.
- `npm test`: 12/12.
- Live server smoke test: two WebSocket clients went from lobby → prep → countdown → active, snapshots carried `zone`, and a departure-decided round produced a `[result]` log line with its tick.

**Not yet seen in a browser:**
- the zone wall, spawn gates, holo adverts and broadcast booths
- the tower emergency strobe
- the Sudden Death HUD

**Changes:**
- **Rules:**
  - Round 11 Sudden Death: 3 minutes, shrinking safe zone with rising damage, timeout tiebreak (survivors, then health), draw/overtime on same-tick wipe or a dead-level finish
  - `RoundRecord.tick`, `room.audit` + `drainAudit`, and server `[result]` logging
- **UI:** the Sudden Death card, countdown, zone/survivor panel, out-of-zone warning, radar zone ring and victory screen. Zone events show in the feed and sound the alarm.
- **Stadium (section 11 gaps):**
  - five launch-gate rings per team at the real spawn points (`buildSpawnGates`, arena3d.ts)
  - towers strobe red and the bowl alarm runs on every `tower-hit` (not only at critical); defenders hear an alarm when their tower is hit
  - four floating holographic advert panels and two broadcast booths with camera booms (skyforge.ts)
  - the scoreboard reads SUDDEN DEATH

**Section 11 items that already existed:** enclosed bowl, bases at both ends, three towers, ground stations, open dogfight volume, airfields with runways, taxiways, aprons, shelters and fuel, radar masts, AA turrets, the reactor, tunnels, bridges and floating pads, the energy barrier and dome, stands, VIP boxes, scoreboards and LED adverts, team lighting, tower damage stages and destruction, and merged modular builders.

**Not done:** there's no offline Sudden Death drill, so seeing the zone needs a real match at 5–5. A practice "dogfight drill" would make it testable solo.

## 8. Next steps (suggested order)

1. **Play-test in a browser:** both drills, a 2-player match, and Round 11 (needs a real match at 5–5, or a new dogfight drill). Check the zone wall, spawn gates, holo adverts, broadcast booths and tower strobe. The build itself now compiles.
2. **Fix firing while turning:** reproduce in a real browser with a mouse and with a touchpad, using the FIRING indicator, and fix the root cause.
3. **Re-measure performance** at the new scale. If below 60 fps, consider a cascaded or tighter shadow camera around the player, and reducing crowd shader cost at distance.
4. **Tune handling** for 2× speed (turn rates, GCAS look-ahead) and missile balance: Mach 4.4 with proportional navigation may be too lethal. Options include flares/chaff, a lower missile G limit, or longer reload.
5. **Recreate the tests in the repo:** a `tests/` folder with rule tests for `match.ts`, flight tests for `flight.ts`, and missile guidance tests, run with `npx tsx`, plus an npm `test` script.
6. Gameplay polish: kill cam, scoreboard (Tab), chat or pings, spectator free-cam, reconnection to a running match.
7. Deployment: hosting needs a persistent Node process with WSS (e.g. Fly.io, Render, a VPS). The server isn't serverless-compatible.
8. Later, as the spec says: jet classes and loadouts **after** basic combat is balanced.
