import { expect, test } from "bun:test";

test("simulation rejects costs that would prevent an emergency exit", () => {
  const result = Bun.spawnSync([process.execPath, "-e", "await import('./src/config.ts')"], {
    cwd: import.meta.dir + "/..",
    env: { ...process.env, JEV_PROVIDER: "typesafe", PAPER_SLIPPAGE_BPS: "6", CLOSE_SLIPPAGE_BPS: "5" },
  });
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString()).toContain("PAPER_SLIPPAGE_BPS must not exceed CLOSE_SLIPPAGE_BPS");
});
