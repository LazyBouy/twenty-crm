# Multi-stage build: compile TypeScript with all deps, ship only runtime deps + lib/.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json tsconfig.json ./
RUN npm install --no-audit --no-fund --ignore-scripts
COPY src ./src
RUN npx tsc -p tsconfig.json

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund --ignore-scripts
COPY --from=build /app/lib ./lib
EXPOSE 4441
CMD ["node", "lib/index.js"]
