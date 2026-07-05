# ICAT Cricket Live — single-process server, match data in /app/data.
# ffmpeg is included so phone-only YouTube broadcasting (Tier 2) works.
FROM node:20-alpine
RUN apk add --no-cache ffmpeg
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY engine ./engine
COPY server ./server
COPY client ./client
COPY scripts ./scripts
COPY config ./config
EXPOSE 3333
VOLUME /app/data
ENV PORT=3333
CMD ["node", "server/index.js"]
