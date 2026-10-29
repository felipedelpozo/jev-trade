import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const orbit = join(import.meta.dir, "../web/public/orbit");
const read = (name: string) => readFileSync(join(orbit, name), "utf8");

const runtimeModules = ["app.js", "audio.js", "core.js", "reel-motion.js", "slot-engine.js", "stage.js"];
const runtimeAssets = [
  "assets/scene.png",
  "assets/shell-complete-raw.png",
  "assets/shell-complete-alpha.png",
  "assets/shell-complete-layout.json",
  "assets/mascot-alpha.png",
  "assets/lilita-one.ttf",
  "assets/lilita-one-OFL.txt",
  "assets/icons/btc.png",
  "assets/icons/bull.png",
  "assets/icons/bear.png",
  "assets/icons/hold.png",
  "assets/icons/exit.png",
  "assets/icons/processor.png",
  "assets/audio/LICENSE.txt",
  "assets/audio/music.wav",
  "assets/audio/spin.wav",
  "assets/audio/reel-stop.wav",
  "assets/audio/opening.wav",
  "assets/audio/win.wav",
  "assets/audio/loss.wav",
  "assets/audio/miss.wav",
  "assets/audio/robot-curious.wav",
  "assets/audio/robot-win.wav",
  "assets/audio/robot-loss.wav",
  "assets/audio/robot-signal.wav",
  "assets/mascot-idle.webm",
  "assets/mascot-curious.webm",
  "assets/mascot-win.webm",
  "assets/mascot-loss.webm",
];

describe("Orbit public integration", () => {
  test("serves the page and every runtime module and asset", () => {
    const html = read("index.html");
    expect(html).toContain('href="/orbit/style.css"');
    expect(html).toContain('href="/orbit/slot.css"');
    expect(html).toContain('src="/orbit/app.js"');
    expect(html).not.toContain('href="/style.css"');
    expect(html).not.toContain('src="/app.js"');

    for (const file of ["index.html", "README.md", "style.css", "slot.css", ...runtimeModules]) {
      const path = join(orbit, file);
      expect(existsSync(path)).toBe(true);
      expect(statSync(path).size).toBeGreaterThan(0);
    }
    for (const asset of runtimeAssets) {
      const path = join(orbit, asset);
      expect(existsSync(path)).toBe(true);
      expect(statSync(path).size).toBeGreaterThan(0);
    }
  });

  test("uses live same-origin API routes without recorded fallback", () => {
    const app = read("app.js");
    const audio = read("audio.js");
    const nextConfig = readFileSync(join(orbit, "../../next.config.ts"), "utf8");

    expect(app).toContain("fetch('/api'");
    expect(app).toContain("fetch('/api/history'");
    expect(app).toContain("/orbit/assets/");
    expect(app).not.toContain("/api/bot");
    expect(app).not.toContain("recorded.json");
    expect(audio).toContain("/orbit/assets/audio/");
    expect(nextConfig).toContain('source: "/orbit"');
    expect(nextConfig).toContain('destination: "/orbit/index.html"');
    expect(nextConfig).toContain('source: "/api/:path*"');
  });
});
