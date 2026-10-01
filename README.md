# Online Games Arcade

**Play:** https://vlensys.github.io/online-games/

Free 3D browser games (WebGL, [three.js](https://threejs.org)) that run on school laptops / Chromebooks in Chrome or Firefox.
Pure static files — no build step, no server, no external CDNs (everything is vendored in `lib/`), so it works on GitHub Pages as-is.

| Game | Folder | Status |
| --- | --- | --- |
| **Slope+** — the original Slope rebuilt (same obstacles, gaps and sections), plus jump, dash, shields, skins | [`slope/`](slope/) | ✅ Playable |
| **Storm Royale** — 3D battle royale with building, bots and private online matches | [`storm/`](storm/) | ✅ Playable — solo vs bots and private online matches |
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
- A rebuild of the original's level generator: the same pieces with the same sizes, gaps and offsets, on the same 45° descent — RNG blocks, slants, straights (early), treblocks, red tunnels, snakes (middle), hors and verts (late), every section ending in a speed tunnel. Like the original, section 1 is one early obstacle; section 2 adds a set of middle ones; from section 3 there's a set of each, and each set is one obstacle repeated 1, 2, 3, then 4 times. Straights and snakes stop after 50 points.
- Every obstacle is its own building with open air before it, and red death towers stand either side of where each one starts. Each speed tunnel ups the speed, and gravity and steering scale with it, so the lines stay the same but you have less time.
- **Score** = obstacles you get through. **Secret routes:** some obstacles have a gold strip on the right of their first rooftop. Steer onto it and a gold road runs round the obstacle, full of coins, then comes back down beside the track so you can rejoin it. The original's own secrets work too: the green roof over a red tunnel, and up the side of a speed tunnel and over the top. In Plus the secret spots hold power-ups (shield, coin magnet, 2x points, slow-mo).
- **Plus** mode adds jump and dash. **Classic** mode is steering-only, like the original.
- Coins unlock 10 ball skins. Best scores, coins and settings are saved in the browser (localStorage).
- Graphics: *Auto* drops to *Low* if the frame rate is poor. Force a level in Settings or with `slope/?quality=low`. `slope/?seed=123` replays the same track.

How it's built to be less buggy than the original:

- Fixed-timestep physics (120 Hz) with sub-stepping, so fast speeds never tunnel through the floor.
- Track tiles treat shared edges as one continuous surface → no "invisible bumps" at seams.
- A speed governor keeps the ball near the intended speed instead of snowballing on long drops.
- Gravity, steering and drift all scale with the square of each section's speed, so every gap and ramp in the original's layout stays clearable at any speed.
- A headless bot drives generated runs to check the pieces are clearable.

## Project layout

```
index.html        arcade hub
lib/              vendored three.js r186 (+ addons) and PeerJS
slope/            Slope+ (index.html, style.css, js/*.js)
```
