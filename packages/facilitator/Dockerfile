# syntax=docker/dockerfile:1.7
#
# Build from the Universal Paywall repository root:
#   docker build -f packages/facilitator/Dockerfile -t ghcr.io/mnemonik-xyz/universal-paywall-facilitator:TAG .
#
# The hosted Phase-1 facilitator is deliberately exact-only. Runtime secrets
# and the durable payment store are injected by the staging compose contract;
# they are never included in this image.
FROM node:22-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/facilitator/package.json packages/facilitator/package.json
RUN npm ci --ignore-scripts

COPY packages/facilitator packages/facilitator
RUN npm run --workspace @universal-paywall/facilitator build

FROM node:22-bookworm-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production \
    PORT=8403

COPY package.json package-lock.json ./
COPY packages/facilitator/package.json packages/facilitator/package.json
RUN npm ci --omit=dev --ignore-scripts \
    && useradd --system --uid 10001 --home-dir /app --shell /usr/sbin/nologin paywall

COPY --from=build /app/packages/facilitator/dist packages/facilitator/dist

RUN mkdir -p /data /run/secrets \
    && chown -R paywall:paywall /app /data /run/secrets

USER paywall
EXPOSE 8403

# The CLI validates every required configuration variable before it opens a
# listener, so a bad staging secret fails closed instead of serving payments.
ENTRYPOINT ["node", "packages/facilitator/dist/session-cli.js"]
