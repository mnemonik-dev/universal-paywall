# syntax=docker/dockerfile:1.7
# Immutable build artifact for the approval page.  It is copied into a named
# volume by the staging compose init service so mnemonic-mcp can serve it on
# the same origin as its authenticated /api routes.
FROM node:22-bookworm-slim AS build

WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/approval-ui/package.json packages/approval-ui/package.json
RUN npm ci --ignore-scripts

COPY packages/approval-ui packages/approval-ui
RUN npm run --workspace @universal-paywall/approval-ui build

FROM busybox:1.37.0-musl
COPY --from=build /app/packages/approval-ui/dist /opt/approval-ui
COPY packages/approval-ui/copy-assets.sh /usr/local/bin/copy-approval-ui-assets
RUN chmod 0755 /usr/local/bin/copy-approval-ui-assets
ENTRYPOINT ["/usr/local/bin/copy-approval-ui-assets"]
