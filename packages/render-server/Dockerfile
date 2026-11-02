# Karta render server: Node + ffmpeg. Build from the repo root: docker build -f packages/render-server/Dockerfile .
FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg fonts-dejavu-core && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/art-engine packages/art-engine
COPY packages/render-server packages/render-server
RUN npm ci --workspace @karta/art-engine --workspace @karta/render-server --include-workspace-root=false && npm run build -w @karta/art-engine && npm run build -w @karta/render-server
ENV PORT=8080
CMD ["node", "packages/render-server/dist/server.js"]
