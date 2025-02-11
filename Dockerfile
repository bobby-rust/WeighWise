FROM node:18-alpine
RUN apk add --no-cache openssl

EXPOSE 8080

WORKDIR /app

ENV NODE_ENV=production

COPY package.json pnpm-lock.yaml* ./

COPY prisma ./prisma

RUN corepack enable && corepack prepare pnpm@latest --activate

RUN pnpm install --frozen-lockfile && pnpm prune --prod
# Remove CLI packages since we don't need them in production by default.
# Remove this line if you want to run CLI commands in your container.
# RUN pnpm remove @shopify/cli

COPY . .

RUN pnpm add vite -w -D
RUN pnpm run build

CMD ["pnpm", "run", "docker-start"]
