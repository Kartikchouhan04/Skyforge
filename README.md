# Skyforge Stadium

Skyforge Stadium is a competitive, objective-based 5v5 aerial combat game for desktop browsers. In each round one team attacks three strategic towers with five fighter jets while the other defends them with three ground crews and two jets.

## Stack

- Next.js App Router, React 19, and TypeScript
- Three.js procedural Skyforge Stadium, Red Mesa, and Ice Fjord arenas, plus jets, towers, gun stations and weapons
- Authoritative Node.js WebSocket room server
- Barlow for HUD and menu text and Barlow Condensed for large headings and numbers (from Google Fonts), with a shadow behind HUD text so it reads over the 3D scene

## The match

- **Teams.** Ten players, two teams of five: **Blue Team** (Team A) and **Red Team** (Team B). Teams balance automatically as players join.
- **Format.** Up to 11 rounds of five minutes. Rounds 1–5: Blue defends, Red attacks. Teams swap after round 5, so in rounds 6–10 Red defends and Blue attacks. Each round won is one point, and the first team to **six** wins the match, which ends as soon as a team gets there.
- **Tiebreaker.** If it's 5–5 after round 10, round 11 is a straight 5v5 jet battle with no towers. The last squadron flying wins.
- **Draws.** A drawn round awards no point and is replayed with the same roles as overtime (shown as OT1, OT2…). The round number doesn't change.
- **Each round:** a 15-second **preparation phase**, then a 5-second **countdown** with weapons safe, then five minutes of combat.
  - During preparation, pilots pick an airframe, ground crews pick a loadout, and crews can move between stations instantly.
  - Attackers launch over their own airbase; defender pilots launch over theirs; ground crews start at their gun stations.
- **No respawns** during a round. Anyone eliminated, or joining once combat has started, spectates a surviving teammate (Q / E or click to switch) until the next round. Players who join during preparation still play the round.
- **Visible at all times:** the timer, every tower's health and your own health. The server decides every hit, repair, tower destruction and round result.
- **Results.** The results screen shows the final score, every round (who defended, who won, overtime), and each player's kills, deaths, damage, tower damage, repairs and score, with an MVP.

### The three towers

Each tower has 1,000 HP and its own health bar, and damage lasts for the whole round. A destroyed tower stays down until the next round, and repairs can't bring it back.

| Tower | While it stands | When it falls |
|---|---|---|
| **Shield** (north flank) | Radar and Weapons take **50% damage** | They take full damage. It can't be restored. |
| **Radar** (south flank) | Every defender sees attackers within range (radar scope and HUD markers) | Defender radar goes offline |
| **Weapons** (front centre) | Automated, leading flak at attackers within range: one burst every 0.34 s, or every 0.18 s when a ground crew is set up at one of its stations | Its guns go silent |

Below 25% HP a tower goes **critical**: warning lights, the stadium alarm and a siren, sparks and smoke. Destruction plays out as a chain of explosions down the shaft, with sparks, a burning stump and a smoke column, and updates the stadium scoreboard.

### Attackers — five jets

Destroy **all three towers**, or eliminate **all five defenders**, before time runs out. Cannons and lock-on missiles work against jets, ground crews and towers. Take out the Shield Tower first, or split up to spread the defence. The tunnels, bridges and flight gates are there for flanking.

If the last tower falls on the same server tick as the last defender (or the last attacker), the attackers win: the objective decides first. If both sides are wiped out with a tower still standing, the round is a draw and is replayed.

### Defenders — three ground crews and two jets

Win by keeping **at least one tower standing until the timer expires**, or by eliminating **all five attackers**.

Ground crews drive mobile anti-aircraft units. Each tower has two gun stations in front of it (1–6) and a repair pad behind it (7–9). Each unit has:

- **Anti-aircraft cannon:** flak with a proximity fuse.
- **Interceptor missiles (SAM):** radar-guided, lock the jet nearest the crosshair, 6-second cooldown.
- **Ammunition per round, set by the loadout chosen in preparation:**

  | Loadout | Flak | Interceptors |
  |---|---|---|
  | Balanced | 450 | 4 |
  | Flak | 700 | 2 |
  | Interceptor | 250 | 7 |

- **Shield activation (F):** halves damage to the tower beside you for 6 seconds, with a 40-second cooldown. It stacks with the Shield Tower.
- **Station rotation:** driving to another station takes a few seconds to pack up, drive and set up again. The guns can't fire on the move, and the unit can still be hit.
- **Repairs**, at a repair pad. Pressing R at a gun station drives you to that tower's pad.

  | Repair rule | Value |
  |---|---|
  | Charges | 3 per ground defender per round |
  | Amount | 100 HP, never above maximum |
  | Duration | Hold R for 4 seconds; the guns are stowed meanwhile |
  | Cooldown | 30 seconds between successful repairs |
  | Interrupted by | Taking damage, letting go, or leaving the pad |

  A charge is only spent when a repair completes. Destroyed towers can't be repaired.

**Defender jets** intercept the attackers and protect the crews.

**Who flies.** Before joining, each player picks a defence preference: PILOT, GROUND or ANY. The two defender jets go to players who asked to fly, then to ANY, then by join order. Smaller rooms scale down: a 1-player defence crews a gun, a 2–3 player defence gets one jet, and 4–5 players get two.

All of these are starting playtest values, not final balance. They live in `TOWER`, `GROUND` and `GROUND_LOADOUTS` in `src/lib/protocol.ts`.

### Jets in combat

- **Weapons:**
  - **Cannon.** Rounds leave with slight dispersion and drop under gravity. They show as glowing tracers with a muzzle flash.
  - **Missiles.** Missiles drop from alternating wing pylons, then the motor lights and accelerates them, leaving a flame and smoke trail. With a lock they guide; without one they fly straight. They end in a fireball.
  - **Flak.** Shells burst in black puffs.
  - **Sound.** Each weapon has its own.
- **Threat warnings:**
  - LOCKED BY …, with a steady tone, while an enemy holds a lock on you.
  - MISSILE INBOUND, with a fast beep, while a missile or SAM is homing on you. Incoming missiles are also marked on screen.
- **Damage:** a damaged jet trails smoke, and below 30 HP it burns. A destroyed jet explodes.
- **HUD markers:** teammates, detected enemies (with distance) and towers (with health) are labelled in team colours, and your current lock gets a bracket.
- **Sound:** synthesised with WebAudio. **M** mutes it.
- **Loadouts:** jets have no loadouts beyond the airframe choice until basic combat is balanced.

Towers are solid: a jet that flies into one is destroyed.

The rules live in `src/lib/match.ts`, a pure module with time passed in. The multiplayer server and offline training both run it, so they behave identically.

## Skyforge Stadium

The arena runs along the long (X) axis. Blue's home end is the west and Red's is the east, each with two military airfields. The Skyforge reactor stands at dead centre with open airspace around it. The defending team's three towers, six gun stations and three repair pads stand at its own end: west in rounds 1–5, east in rounds 6–10.

- **Flight volume** — 17280 × 13320 with a 5400-unit ceiling, wrapped in a hex-latticed energy barrier drawn exactly on the server's play volume. Hitting it ripples the barrier at the contact point.
- **Stands** — three elliptical tiers separated by concourses, closed by a glazed facade and a cantilevered roof ring edged with lights. The crowd is drawn per pixel by a shader rather than as geometry: seated spectators with shirts, heads and hair, team-coloured home ends behind each base, aisles, vomitory tunnels, a travelling Mexican wave, card-stunt tifos in the home ends every 40s and after core alerts, and phone lights after dark. Far stands fade to smoothly filtered crowd colour instead of shimmering, and phone flashes only appear where individual people are resolved.
- **Banners and flags** — twenty Blue and Red drapes with crests and fringes hang from the roof ring; their cloth ripples and the folds catch the light. About 1,400 fan flags wave in the stands, clustered in the home ends.
- **Screens** — two giant end scoreboards plus four angled corner broadcast panels sharing one live canvas (score and round pips, round clock, which team defends, ticker, alert card), and continuous LED ribbon boards on the pitch wall and both tier fascias.
- **Centerpiece** — the Skyforge reactor: stacked glow rings, service decks and an exhaust plume.
- **Combat levels** — six lit flight gates on three stacked routes, service bridges, tunnels and bobbing floating pads, all kept off the center line.
- **Industrial yard** — hangars, cooling towers with steam, a generator hall with spinning turbines, pipelines, gantry cranes with sliding trolleys, vent stacks, lattice comms masts and a container yard, ringing the stadium outside its facade.
- **Live environment** — a wall-clock driven day → golden → sunset → night → dawn cycle (sun, sky gradient, stars, fog and floodlit fill all follow it), drifting weather with rain and lightning outside the dome, warning strobes and alarm states.
- **Destructible props** — perimeter crates, fuel tanks, generators and masts take damage from nearby impacts, scorch, topple and burn.

The lighting cycle is driven from `Date.now()`, so pilots in the same room see roughly the same sky.

### Jets

Jets are built in `src/lib/jets.ts`: a flattened blended fuselage with nose chines, swept wings with hinge lines, canted twin tails, a gold-tinted canopy with the pilot's helmet, twin nozzles with petals, and missiles on pylons. Each team has a splinter-camo livery texture with panel lines, rivets, roundels and tail numbers. Afterburners are layered (core, plume, haze) with shock diamonds that appear under boost; navigation lights, a tail strobe and a belly beacon blink; and wingtip vapour trails form at speed and in hard turns.

### Scale

Two dials in `src/lib/protocol.ts` multiply values authored against the original 480-unit arena:

- `ARENA_SCALE` (currently `18`) sizes the place: flight volume, stadium shell, airfields, boundaries and spawn spread.
- `FLIGHT_SCALE` (currently `3`) sizes the jets' world: speeds, accelerations, weapon ranges, lock ranges and hit radii.

Crossing time is `ARENA_SCALE / FLIGHT_SCALE` times the original, so it is the **ratio** that decides how roomy a 5v5 feels — about 20 seconds nose-to-tail at full throttle today. Raise `FLIGHT_SCALE` to make the arena feel tighter without shrinking it. Scaling both by the same factor makes the stadium look bigger but leaves the fight exactly as cramped. Angular rates never scale.

The stadium shell is modelled against the original 1x arena and scaled up as one group (`SHELL_SCALE`). Only the energy barrier, weather and spark bursts are built in world space, because they must line up with server coordinates exactly. Seats are a fixed world size (`SEAT_WIDTH`, `ROW_DEPTH` in `skyforge.ts`), so a bigger bowl simply holds more people.

### Performance

The scene holds 60fps on integrated graphics. What mattered, measured on an AMD Radeon integrated GPU against the production build:

1. **Draw calls.** On Windows every WebGL draw is translated to D3D11 in a separate GPU process, so draw count — not pixels — set the frame time (~145 draws held 60fps, ~880 dropped to 45). `mergeStaticMeshes` in `src/lib/arena-kit.ts` merges by what a material *looks like* rather than its identity, bakes colour into vertex colours so parts differing only in colour batch together, and is run inside moving groups as well. Materials animated at runtime are pinned so they keep working.
2. **No transmissive materials.** A material with `transmission > 0` makes three.js re-render the whole scene into a backdrop buffer every frame.
3. **No dynamic lights.** Only the sun, sky and ambient light the scene. Every extra light is evaluated for every lit pixel, and adding or removing one (as explosion lights did) recompiles every shader mid-fight.
4. **No 4x MSAA by default.** On integrated GPUs it cost the last few frames in flight. `MSAA` in `src/lib/arena3d.ts` turns it back on for discrete GPUs.
5. **Canvas textures repaint only on change.** Every repaint re-uploads the texture and rebuilds its mipmaps; the scoreboard's alert flashes by swapping between two pre-painted textures.
6. **Warm-up.** Shaders are compiled and textures uploaded behind the loading state, so the first look at the stands doesn't stall.
7. **CSS-pixel resolution.** The canvas renders at a pixel ratio of 1, which on displays scaled to 125-150% is a large fill-rate saving for little softness.
8. **The HUD updates at 10Hz.** The 3D view reads game state directly every frame; re-rendering the React HUD on every 30Hz tick only stole main-thread time from it.
9. **One final post pass.** Bloom runs on the HDR buffer; tone mapping, colour grade and FXAA are folded into a single full-screen pass, because each extra full-screen pass costs ~1ms on integrated graphics.
10. **No NaN reaches bloom.** One NaN pixel (normalize() of a zero normal, pow() of a slightly negative number) is blurred by bloom across its smallest mip and blacks out the whole frame, which showed as flicker in flight. Hand-written shaders use `safeNormalize` and clamped pow bases, and bloom's input is clamped so a bad pixel stays one pixel.
11. **Towers and gun stations merge too.** Each tower is a few draws, all six stations share one number atlas, and projectiles share a geometry and material per kind (flak fires ten rounds a second per gun).
12. **Effects are pooled.** Smoke, fire and sparks for every jet and tower share four particle draws, and the HUD markers only touch the DOM when their text changes.

Results, at a 1920px display scaled to 125%: 60fps in the lobby, and 60fps every second of 20-second day and night flights, in both the production build and `npm run dev`. Both training drills, including a gunner looking straight at the towers, hold 60fps.

### Smooth motion

The simulation ticks at 30Hz (server and offline training) while the screen draws at 60Hz or more, and at combat speed a jet moves about a body length per tick. The renderer therefore never draws raw tick positions: each jet and projectile keeps its latest sample and extrapolates along its heading to the current frame, then eases toward that with frame-rate-independent damping. The chase camera follows the smoothed jet with its own eased heading. Measured camera judder dropped from 19.5% to 1.5% of speed per frame.

## Offline training

Choose **Enter Offline Training** in the hangar, pick a drill, then click an arena. Training runs the real match rules in a practice room, with no timer and drones that respawn:

- **Attack drill.** Fly against Red's three towers while five target drones circle mid-stadium.
- **Defence drill.** Crew a gun station at Blue's towers while drones make strafing runs on them. Practise flak leads, SAM locks, changing stations, shield activation and timed repairs. Ammunition and repair charges refill on the range, and the loadout can be swapped any time.

You can also link to it directly with `/?mode=training&role=ground` or `role=pilot`.

## Backend

The Node.js WebSocket server (`server.ts`) owns the sockets. Every room is a `match.ts` room stepped at 30Hz, and the server is authoritative for flight, weapons, towers, roles, round timing and results. The arena is pinned when a room is created. A finished match holds on the results screen for 90 seconds, then the room resets for a rematch. `GET /api/health` returns server status, active rooms, player counts and the available arenas.

## Run locally

Requires Node.js 20.9 or newer.

```sh
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000), enter a callsign, pick a defence preference, and share the room link. Teams auto-balance as players join, and the countdown starts once both teams have a player. For devices on the same network, use the host machine's local IP address. Public hosting needs a persistent Node.js process and HTTPS/WSS support.

## Controls

**Pilots**

- **Mouse** (or **↑ / ↓**) to pitch: mouse up or ↑ raises the nose. The mouse acts as a stick that springs back to centre.
- **A / D**, **← / →** or mouse sideways to turn: the jet banks into a coordinated, altitude-holding turn.
- **Q / E** to roll by hand, for aerobatics such as barrel rolls, inverted flight and the split-S.
- **W / S** to advance or retard the throttle lever (it stays where you leave it).
- **Space** for afterburner, **Shift** for air brake.
- **Left mouse** fires the cannon. **Right mouse** launches a missile, and works while the cannon is firing. With a lock (MISSILE LOCK on the HUD) the missile guides onto that jet, ground unit or tower. Without one it flies dead straight. 5-second reload.

**Ground crews**

- **Mouse** (or **WASD / arrows**) aims the gun. A lead ring shows where to aim so the flak meets the nearest jet.
- **Left mouse** fires the flak cannon. **Right mouse** fires an interceptor: it guides onto your lock, or flies straight if you have none.
- **1–6** drives to a gun station and **7–9** to a repair pad; **Q / E** steps to the previous or next one.
- **Hold R** at a repair pad to repair. At a gun station, R drives you to the pad.
- **F** activates the shield on the tower beside you.

**Everyone:** **M** toggles sound. While spectating, **Q / E** or a click switches teammate.

Touch controls appear on phones.

## Flight model

Both the server and offline training fly every jet through one shared model in `src/lib/flight.ts`, so offline practice handles exactly like a match.

- **Full 3D orientation** (a quaternion), so loops, rolls and inverted flight all work.
- **Lift turns the jet.** The stick commands load factor (G); lift acts along the banked wing. Neutral stick holds the current flight path — level, climbing, banked or inverted — so the jet goes where you point it.
- **Energy.** Gravity, thrust, drag and induced drag trade speed for altitude and manoeuvre: dives build speed, climbs and hard turns bleed it. Each airframe has a G limit (Swift 9G, Bastion 7.5G), roll rate and stall speed.
- **Stall.** Lift available falls with the square of speed; below stall speed the jet can't hold itself up and its nose drops until it has flying speed again.
- **Assists.** A/D banks to a turn the jet can actually hold at its current speed; wings return level when you let go; automatic ground-collision avoidance rolls level and pulls up before you hit the floor; near the energy barrier the jet turns back in rather than bouncing off.
- **Instruments.** The HUD shows an artificial horizon, altitude (ft), airspeed (kt and Mach), G, throttle and heading, with STALL and PULL UP warnings.

`flight.ts` and the airframe numbers in `JET_FLIGHT` (`src/lib/protocol.ts`) are the place to tune handling.
