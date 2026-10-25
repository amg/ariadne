# The load generator: plain TypeScript run by Node's own type stripping.
# Built from the repository root, because the root lockfile pins its
# dependencies: undici carries the direct path's client certificate, and
# zod validates what the generator reads.
FROM node:24-alpine

WORKDIR /app
COPY package*.json ./
COPY backend/package*.json ./backend/
COPY frontend/package*.json ./frontend/
COPY lib/package.json ./lib/
COPY load/package*.json ./load/
ENV LEFTHOOK=0
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund --workspace=load

COPY lib/api ./lib/api
COPY lib/metrics ./lib/metrics
COPY load/src ./load/src

USER node
WORKDIR /app/load
CMD ["node", "src/generator/main.ts"]
