# ICAT Cricket Live Docker-only development/runtime image.
# Playwright's base image keeps browser-based acceptance checks inside Docker.
FROM mcr.microsoft.com/playwright:v1.61.1-noble

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates ffmpeg gosu openssl \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV PORT=3333 \
    NODE_ENV=development \
    HOME=/home/cricket \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    NPM_CONFIG_CACHE=/tmp/.npm \
    XDG_CACHE_HOME=/tmp/.cache \
    XDG_CONFIG_HOME=/tmp/.config \
    PATH=/app/node_modules/.bin:$PATH

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
COPY docker/app-entrypoint.sh /usr/local/bin/cricketops-entrypoint
RUN groupadd --system cricket \
  && useradd --system --gid cricket --home-dir /home/cricket --create-home cricket \
  && mkdir -p /tmp/.npm /tmp/.cache /tmp/.config \
  && chown -R cricket:cricket /app /home/cricket /tmp/.npm /tmp/.cache /tmp/.config \
  && chmod +x /usr/local/bin/cricketops-entrypoint

EXPOSE 3333
ENTRYPOINT ["cricketops-entrypoint"]
CMD ["npm", "run", "dev"]
