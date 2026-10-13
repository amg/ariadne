# The load generator: plain TypeScript run by Node's own type stripping.
# Its one dependency, undici, carries the direct path's client certificate.
FROM node:24-alpine

WORKDIR /load
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY plan.ts metrics.ts api.ts directPath.ts virtualUser.ts main.ts ./

USER node
CMD ["node", "main.ts"]
