# Lelouch HQ — Node 24 runs the TypeScript sources directly (type stripping), no compile step.
# Chromium is included so an Edge board refresh can run the site's own projection page.
FROM node:24-slim
ENV NODE_ENV=production \
    PORT=8080 \
    DATABASE_PATH=/data/picks.db \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
WORKDIR /app
COPY package.json package-lock.json ./
# Chromium is only launched during an Edge board refresh, then closed.
# Playwright's browser build matches this playwright-core. /ms-playwright stays readable by the node user.
RUN npm ci --omit=dev --no-audit --no-fund \
 && npx playwright-core install --with-deps chromium \
 && chmod -R a+rX /ms-playwright \
 && npm cache clean --force
COPY src ./src
COPY public ./public
RUN mkdir -p /data && chown -R node:node /data /app /ms-playwright
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--disable-warning=ExperimentalWarning", "src/main.ts"]
