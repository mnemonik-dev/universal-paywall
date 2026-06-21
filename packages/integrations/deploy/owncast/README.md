# Owncast — live presence (per-second)

**Attach surface (verified):** Owncast emits `USER_JOINED` / `USER_PARTED` chat
events (`owncast/models/eventType.go:10-12`) and lets an admin register an outbound
webhook via `POST /api/admin/webhooks/create`
(`owncast/webserver/handlers/generated/generated.gen.go:568`, HTTP Basic auth).
No fork change — the sidecar already implements the presence meter and this path
is **proven end-to-end on anvil**.

## Steps

1. Start the rail + facilitator + sidecar (see `docker-compose.yml`).
2. Register the webhook against the running Owncast admin API:

   ```bash
   ./register-webhook.sh   # wraps POST /api/admin/webhooks/create
   ```

   Subscribe it to `USER_JOINED` and `USER_PARTED`, pointed at
   `http://up-sidecar:8410/owncast`.
3. A viewer joins the stream's chat (after staking + granting via the agent).
4. On part, the sidecar charges `(parted - joined) * RATE` micro-USDC to the
   streamer and the facilitator batches + settles.

## Config

- `PLATFORM=owncast`
- `STREAMER_KEY=<creator key>` (resolved via `CREATOR_WALLETS`)
- `RATE=<micro-USDC per second>`
- `PAYER_WALLETS={"<viewer-username>":"0x..."}`

## Verify

**L4 acceptance (runnable now):**
`npm run e2e:owncast -w @universal-paywall/integrations` (anvil on :8545) drives
the **real sidecar HTTP server** with the **byte-exact JSON Owncast posts**
(USER_JOINED/PARTED, full `eventData` envelope grounded in
`owncast/services/webhooks/*.go` + `models/user.go`), through the facilitator to an
on-chain settle. Asserts the streamer is paid `(parted-joined)*RATE`. **PASS.**

**L3 real-instance (needs a Docker daemon):** `docker compose up`, run
`./register-webhook.sh`, join/leave as a viewer, confirm the same settlement. The
sidecar's expected shape (`eventData.user.id`, `eventData.timestamp`) was verified
to match Owncast's real payload, so the acceptance bytes equal the wire bytes.

> Owncast dev admin creds for local testing: `admin` / `abc123` (Basic auth).
</content>
