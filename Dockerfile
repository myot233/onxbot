FROM node:24-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9

WORKDIR /app
RUN npm install --global pnpm@10.32.1
COPY . .
RUN pnpm install --frozen-lockfile && pnpm build

USER node
CMD ["node", "apps/bot/dist/index.js"]
