# The load generator: plain TypeScript run by Node's own type stripping,
# no dependencies to install.
FROM node:24-alpine

WORKDIR /load
COPY plan.ts metrics.ts api.ts virtualUser.ts main.ts ./
COPY package.json ./

USER node
CMD ["node", "main.ts"]
