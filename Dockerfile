FROM node:25-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY web ./web
RUN npm run build

FROM node:25-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist

# Run unprivileged; the ledger and generated token live in /data.
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]

# Bind every interface inside the container so published ports work. Only
# requests addressed to these Host names are served; add your public name
# (for example, -e CROSSCHAT_ALLOWED_HOSTS=localhost,relay.example.com).
ENV CROSSCHAT_DATA_DIR=/data \
    CROSSCHAT_HOST=0.0.0.0 \
    CROSSCHAT_ALLOWED_HOSTS=localhost,127.0.0.1
EXPOSE 4318

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:4318/health || exit 1

CMD ["node", "dist/index.js"]
