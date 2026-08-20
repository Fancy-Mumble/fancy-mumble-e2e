# botroom, the bot process itself. The models live in their own containers;
# this one is node, ffmpeg and about a thousand lines of TypeScript.
#
# Built from the repository root, because it needs `src/util/audio-bot.ts` —
# the Mumble client the bots are built on — as well as `botroom/`:
#
#   docker compose -f botroom/docker-compose.yml build
FROM node:22-slim

# ffmpeg is not a convenience here: it is the Opus encoder and the resampler,
# and `botroom/speech.ts` shells out to it for every utterance. The slim image
# has no ffmpeg, and Debian's is built with libopus.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dependencies first, so a code change does not reinstall them. There are only
# dev dependencies that matter here (tsx and typescript); `--omit=optional`
# keeps the selenium stack from being pulled in for a program that never drives
# a browser.
COPY package.json package-lock.json ./
RUN npm ci --omit=optional

COPY tsconfig.json ./
COPY src/util ./src/util
COPY botroom ./botroom

ENTRYPOINT ["npx", "tsx", "botroom/main.mts"]
CMD ["--help"]
