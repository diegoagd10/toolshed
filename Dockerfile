# syntax=docker/dockerfile:1
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci
COPY tsconfig.json vite.config.ts ./
COPY src src
RUN npm run build && npm prune --omit=dev \
  && find node_modules -name "*.test.*" -o -name "*.spec.*" | xargs rm -f

FROM node:24-alpine
# setpriv starts each tool job so that the kernel kills it if the server dies.
RUN apk add --no-cache setpriv && mkdir /data && chown node:node /data
WORKDIR /app
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/dist dist
COPY drizzle drizzle
COPY package.json ./
USER node
ENV NODE_ENV=production DATA=/data
EXPOSE 4400 4401
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:4400/health && wget -q -O /dev/null http://127.0.0.1:4401/health
# The same flags as npm start.
CMD ["node", "--max-semi-space-size=1", "dist/main.js"]
