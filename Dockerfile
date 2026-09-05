FROM oven/bun:1.4.0 AS build

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .
RUN bun run build \
  && bun build scripts/migrate.ts --target bun --external bun:sqlite --outfile dist/migrate.js \
  && bun run check:output

FROM oven/bun:1.4.0 AS runtime

WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000 \
    DATABASE_PATH=/app/data/vaporstats.sqlite \
    DATABASE_SNAPSHOT_DIR=/app/data/snapshots

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY --from=build /app/dist ./dist
COPY --from=build /app/migrations ./migrations

CMD ["bun", "dist/server/server.js"]
