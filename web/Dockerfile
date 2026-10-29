FROM oven/bun:1.3 AS deps

WORKDIR /app

COPY web/package.json web/bun.lock ./
RUN bun install --frozen-lockfile

COPY web ./

FROM node:22-bookworm-slim AS build

WORKDIR /app
COPY --from=deps /app ./

# The browser uses the same-origin /api rewrite in next.config.ts.
ENV NODE_ENV=production
ENV NEXT_PUBLIC_API_URL=/api
RUN node_modules/.bin/next build

EXPOSE 3001
CMD ["node_modules/.bin/next", "start", "-p", "3001"]
