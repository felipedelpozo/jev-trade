import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  // The repo root also has a bun.lock; pin the workspace root to this app.
  turbopack: { root: path.resolve(__dirname) },
  // Agent rules live in the repo-root CLAUDE.md. Do not emit web/AGENTS.md.
  agentRules: false,
  allowedDevOrigins: ["127.0.0.1", "localhost"],
  async redirects() {
    return [{ source: "/orbit", destination: "/orbit/index.html", permanent: false }];
  },
  // Keep the bot private inside the Compose network while the browser stays same-origin.
  async rewrites() {
    const bot = process.env.BOT_API_INTERNAL_URL ?? "http://bot:3000";
    return [{ source: "/api/:path*", destination: `${bot}/:path*` }];
  },
};

export default nextConfig;
