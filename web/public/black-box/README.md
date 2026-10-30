# Jev Black Box

Independent read-only vertical broadcast at `/black-box/index.html`.
Use `/black-box/index.html?broadcast=1` for a clean 1080x1920 scene.
Orbit and the trading dashboard keep their own routes and assets.

## Live data and visual states

The page reads same-origin GET `/api`, GET `/api/history` and the lite price SSE
`/api/events?lite=1`. It sends no orders, model requests or account mutations.
Only a validated wallet-free paper account is accepted. There are no recorded or
synthetic financial fallbacks. PnL is `paper.netPnlUsd`, already net of simulated
fees, funding and model charges; IA cost is shown separately, never subtracted again.
Missing billing confirmation remains visibly estimated. The chart covers observed
BTC prices from the last 15 minutes, not a projection or strategy return.

- **Observe**: market observation following an open/close intent. An intent is not a fill.
- **Evaluate**: a 12-second visual presentation triggered only by a newly received,
  valid decision in the same runtime and account. It is not a live inference timer
  or a visualization of the model's private reasoning.
- **Wait**: HOLD, unavailable/stale decisions, risk stops or budget pauses. The fluid
  continues circulating. Pauses and retained old data are explicitly identified.

Three 5-second state loops and six 3-second directed transitions use the same
sphere/camera anchors. The player waits for a loop boundary, keeps the outgoing
frame, and swaps only once a frame from the next clip has decoded. A newer target
is queued through the current transition. Two video buffers bound decoder use.
The first render/reconnect never replays missed decisions or resets the ledger.

`assets/manifest.json` records the state graph and generation provenance. Media is
silent H.264/yuv420p 1080x1920 at 30fps. Small generative reflection changes remain;
first/last frame metrics do not prove physical or perceptual seamlessness.

## OBS and TikTok LIVE

1. Set OBS canvas/output to **1080x1920**, 30fps.
2. Add a **Browser Source**, width 1080, height 1920, with the public broadcast URL.
3. Leave the default OBS custom CSS or clear it. Keep source audio disabled.
4. Keep “Shutdown source when not visible” and “Refresh browser when scene becomes
   active” off to preserve animation/connection continuity when switching scenes.
5. In the preparation page, turn on TikTok guides to check the composition.
   Top 160px, right 150px and bottom 410px are reserved. Guides are absent in broadcast.
6. Start OBS Virtual Camera, then select it in TikTok LIVE Studio. Preview the actual
   crop and native chat/actions before going live. No live session starts automatically.

The URL needs no key, wallet or login. On an OBS Browser Source, use Interact only
if playback is blocked; the clips are muted and normally autoplay. The studio has
an explicit resume button, motion toggle, all-state preview and return to live.
Entering broadcast cancels the visual test and removes guides and controls.
Respect `prefers-reduced-motion`; a static state poster replaces motion when enabled.
No casino sounds, slots, jackpots, invented chat/engagement, giveaways or gift-to-trade
controls are included. A disclosure alone does not guarantee TikTok eligibility.
