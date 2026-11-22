# Orca Cloudflare Relay Plugin

This Orca plugin adds settings and commands that generate a compatible
Cloudflare Wrangler deployment config for the Orca relay runtime.

## What it does

- Stores Cloudflare account, domain, Hyperdrive, JWKS, JWT, and director settings.
- Generates `.wrangler-deploy-cloudflare.jsonc` with separate director and edge hostnames.
- Lets a panel download the generated config with the Orca save dialog.
- Provides the same config generator as a standalone Node CLI.

## What it does not do

Orca plugins cannot replace the desktop pairing transport or deploy Durable Objects:
that core implementation belongs in the Orca desktop and `cloud/apps/relay-edge` runtime.
The plugin is a setup/deployment configuration helper, not a second relay implementation.

The existing Orca iOS/Android app needs no rebuild when the generated relay is fully
compatible with Orca relay-v1 and uses canonical HTTPS/WSS origins.

## Install for development

```sh
orca plugin dev load .
```

Configure the plugin under Orca Settings, then run:

- **Cloudflare Relay: Validate deployment settings**
- **Cloudflare Relay: Generate deployment config**

Open the **Cloudflare Relay** panel and download `.wrangler-deploy-cloudflare.jsonc`.

## Standalone CLI

```sh
node bin/generate.mjs \
  --accountId 0123456789abcdef0123456789abcdef \
  --workerName orca-relay-edge \
  --domain relay.example.com \
  --edgeDomain edge.relay.example.com \
  --hyperdriveId abcdef0123456789abcdef0123456789 \
  --jwksUrl https://login.example.com/.well-known/jwks.json \
  --authIssuer https://login.example.com \
  --audience orca-relay \
  --adminIssuer https://director.example.com
```

Set `ADMIN_SIGNING_KEY` and ingress secrets through `wrangler secret put`:

```sh
wrangler secret put ADMIN_SIGNING_KEY --config .wrangler-deploy-cloudflare.jsonc
```

Deploy the public-compatible relay runtime separately, and configure the Orca desktop
build with `ORCA_RELAY_URL=https://relay.example.com`.
