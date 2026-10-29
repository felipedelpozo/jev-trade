# Jev Orbit production integration

The Orbit canvas is served by the Next dashboard at `/orbit/` (redirecting to
`/orbit/index.html`). Its browser runtime uses same-origin read-only endpoints:

- `/api` for the current bot metadata and BTC reading
- `/api/history` for bounded live history used by replay mode

Runtime JavaScript, CSS, bundled artwork, audio, font, and license files are
kept under this directory. The production copy does not include the local
preview server, recorded snapshots, generation files, or test artifacts. Replay
is unavailable until `/api/history` returns valid live data; it never falls
back to a historical fixture.
