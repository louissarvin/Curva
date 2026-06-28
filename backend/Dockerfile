# syntax=docker/dockerfile:1
# Curva Companion — Bun + Fastify + Prisma 7.
# Single-stage build is fine at hackathon scale; multi-stage can come later.
# Pattern source: https://bun.sh/guides/ecosystem/docker

FROM oven/bun:1 AS base
WORKDIR /usr/src/app

# Install dependencies first for better layer caching.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# Copy the rest of the source. The seeder/ directory MUST be present even when
# ENABLE_SEEDER=false so flipping the flag at runtime works without a rebuild.
COPY . .

# Generate the Prisma client. The custom prisma.config.ts holds the schema path.
RUN bunx prisma generate --config prisma/prisma.config.ts

ENV NODE_ENV=production
# Drop root inside the container.
USER bun

# APP_PORT default in src/config/main-config.ts.
EXPOSE 3700

CMD ["bun", "run", "index.ts"]
