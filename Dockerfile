# Architecture-neutral: works on linux/amd64 and linux/arm64 (Oracle Cloud A1, Render).
FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
# One dependency: pg (pure JS, same install on amd64 and arm64).
RUN npm ci --omit=dev
COPY src ./src
COPY public ./public
RUN mkdir -p /app/data && chown -R node:node /app
USER node
EXPOSE 3000
VOLUME ["/app/data"]
CMD ["node", "src/server.js"]
