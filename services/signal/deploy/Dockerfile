# CapMac's signaling server, as a container. Build the server first, then the image,
# from services/signal:
#   npm run build -w @capmac/signal
#   docker build -f deploy/Dockerfile -t capmac-signal .
# (deploy/docker-compose.yml does the second step for you.)
FROM node:24-alpine
WORKDIR /app
COPY dist/capmac-signal.mjs ./
ENV NODE_ENV=production \
    PORT=8787 \
    STUN_PORT=3478
EXPOSE 8787/tcp 3478/udp
USER node
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- "http://127.0.0.1:${PORT}/healthz" >/dev/null || exit 1
CMD ["node", "capmac-signal.mjs"]
