import { parseOptimizationInput, summarizeOptimization } from "../src/optimization";

const DEFAULT_BASE_URL = "https://jev-trade.jungloria.com";
const timeout = 10_000;
const baseUrl = (process.argv.find((arg) => arg.startsWith("--base-url="))?.slice(11) || DEFAULT_BASE_URL).replace(/\/$/, "");

async function read(path: string): Promise<unknown> {
  const response = await fetch(`${baseUrl}/api${path}`, { signal: AbortSignal.timeout(timeout), headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  const body: unknown = await response.json();
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error(`${path}: expected JSON object`);
  return body;
}

try {
  const [meta, history, usage] = await Promise.all([read(""), read("/history"), read("/usage")]);
  process.stdout.write(`${JSON.stringify(summarizeOptimization(parseOptimizationInput(meta, history, usage)))}\n`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
