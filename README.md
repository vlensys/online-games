# Online Games Arcade

**Play:** https://vlensys.github.io/online-games/

Free 3D browser games (WebGL, [three.js](https://threejs.org)) that run on school laptops / Chromebooks in Chrome or Firefox.
Pure static files — no build step, no server, no external CDNs (everything is vendored in `lib/`), so it works on GitHub Pages as-is.

| Game | Folder | Status |
| --- | --- | --- |
| **Slope+** — endless neon slope with jump, dash, shields, skins | [`slope/`](slope/) | ✅ Playable |
| **Storm Royale** — 3D battle royale with building, bots and private online matches | `storm/` | 🚧 In progress |
| Game 3 | — | 🚧 Planned |

## Hosting on GitHub Pages (one-time setup)

1. Push this repository to GitHub (already done if you're reading this there).
2. On GitHub open **Settings → Pages**.
3. Under **Build and deployment → Source** choose **Deploy from a branch**.
4. Pick branch **`main`** and folder **`/ (root)`**, then **Save**.
5. Wait ~1 minute. Your arcade is live at `https://<your-username>.github.io/<repo-name>/`
   (for this repo: `https://vlensys.github.io/online-games/`).

Every push to `main` redeploys automatically. The `.nojekyll` file makes GitHub serve the files untouched.

## Running locally

Browsers block ES modules from `file://`, so use any static server from the repo root:

```bash
npx http-server -c-1 .      # or: python3 -m http.server 8080
```

then open <http://localhost:8080/>.

## Slope+

- **Steer** A/D or ←/→ · **Jump** Space/W/↑ · **Dash** Shift/S/↓ (phase through red for a moment; hold a direction to side-step; works mid-air) · **Pause** Esc/P · **Restart** R · **Mute** M
- Touchscreens: hold the left/right half of the screen to steer, swipe up to jump, swipe down to dash (or use the buttons). Gamepads work too.
- Built like the original: sections of early (RNG blocks, slants, straights), middle (treblocks, tunnels, snakes, spinners) and late (hors, verts, sliding gates) obstacles, each ending in a speed-tunnel building that boosts you and launches you into the next section. It gets harder every section: faster, narrower, and more of the obstacles move.
- Every platform is the rooftop of a building that goes all the way down; big gaps between buildings are crossed by rolling off onto a lower roof or by hitting a ramp.
- **Score** = platforms you land on. **Secret routes**: small gold ramps at the edge of some rooftops launch you onto a hidden gold lane above the track, full of coins and power-ups (shield, coin magnet, 2x points, slow-mo).
- **Plus** mode adds jump gaps, hurdles, dash-gates and sweeping blockers. **Classic** mode is steering-only and every section is survivable without jumping.
- Coins unlock 10 ball skins. Best scores, coins and settings are saved in the browser (localStorage).
- Graphics: *Auto* drops to *Low* if the frame rate is poor. Force a level in Settings or with `slope/?quality=low`. `slope/?seed=123` replays the same track.

How it's built to be less buggy than the original:

- Fixed-timestep physics (120 Hz) with sub-stepping, so fast speeds never tunnel through the floor.
- Track tiles treat shared edges as one continuous surface → no "invisible bumps" at seams.
- A speed governor keeps the ball near the intended speed instead of snowballing on long drops.
- The generator sizes every gap / ramp from the real physics constants for the current speed, and keeps a runway after anything that launches the ball.
- A headless bot drives thousands of generated segments in both modes to check nothing is unclearable.

## Project layout

```
index.html        arcade hub
lib/              vendored three.js r186 (+ addons) and PeerJS
slope/            Slope+ (index.html, style.css, js/*.js)
```
