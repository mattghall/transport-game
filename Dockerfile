# Multi-stage build: compile front-end assets then run the session server.
# Stage 1: build the Vite app
FROM node:22-alpine AS builder

WORKDIR /app
COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build


# Stage 2: production image — only ships the built assets + session server
FROM node:22-alpine AS runner

WORKDIR /app

# Copy only what the server needs
COPY package*.json ./
RUN npm ci --omit=dev

# Copy built front-end (served as static files by the session server)
COPY --from=builder /app/dist ./dist

# Copy server and source needed at runtime (tsx transpiles on-the-fly)
COPY --from=builder /app/server ./server
COPY --from=builder /app/src ./src

EXPOSE 8787

ENV PORT=8787
ENV NODE_ENV=production

CMD ["node", "--import", "tsx/esm", "server/sessionServer.mjs"]
