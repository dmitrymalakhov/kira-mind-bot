FROM node:23-alpine

RUN apk add --no-cache chromium ffmpeg libstdc++

ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium-browser \
    NPM_CONFIG_AUDIT=false \
    NPM_CONFIG_FUND=false

WORKDIR /usr/src/app

ARG NODE_ENV=production
ENV NODE_ENV=${NODE_ENV}

COPY package*.json ./
RUN apk add --no-cache --virtual .build-deps python3 make g++ gcc \
    && npm ci --omit=dev --no-audit --no-fund \
    && npm cache clean --force \
    && apk del .build-deps

COPY . .

EXPOSE 3011
CMD ["npm", "start"]
