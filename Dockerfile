FROM node:20-alpine

WORKDIR /app

# Zero external dependencies — copy project files directly
COPY package.json ./
COPY server ./server
COPY public ./public
COPY tests ./tests

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1

CMD ["npm", "start"]
