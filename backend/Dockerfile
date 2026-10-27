# Backend API + agents. Build context: repo root (see docker-compose.yml).
#
# Based on the official Playwright image so headless Chromium and its system libraries are
# already present (devemail/qarelease browser clients, cfBrowserAutomation). The tag must
# match the `playwright` version in backend/package-lock.json — bump both together.
FROM mcr.microsoft.com/playwright:v1.61.0-noble

ENV NODE_ENV=production \
    PORT=5000

# Layout mirrors the repo so the relative paths in src/ keep working:
#   /app/backend/...         code, data/, logs/, config/
#   /app/group-mapping.csv   read via path.join(__dirname, '../../../..') from agents/validators
WORKDIR /app/backend

COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY backend/ ./
COPY *.csv /app/

RUN mkdir -p logs data config

EXPOSE 5000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||5000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
