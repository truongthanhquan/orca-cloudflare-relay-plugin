# Orca Cloudflare Relay

![Orca Mobile, from anywhere: your own relay on Cloudflare](images/cover.png)

> Community plugin for Orca. Not affiliated with or endorsed by Cloudflare, Inc.

An [Orca](https://github.com/stablyai/orca) plugin that adds a third way for **Orca Mobile**
to reach your desktop, alongside **LAN** and **Orca Relay**: **your own relay on Cloudflare's
free plan**. That is either a one-click Worker + Durable Object relay, or a Cloudflare Tunnel.

The phone app needs **no update and no extra steps**. You pair with a normal Orca QR code, just
as you do over LAN. The only difference is the address the phone dials, which is served by
Cloudflare instead of a LAN IP.

## Three connection types

| | **Worker relay** (recommended) | Tunnel on your domain | Quick tunnel |
| --- | --- | --- | --- |
| Needs | free Cloudflare account | free account + a domain on it | nothing |
| Address | stable `orca-relay.<you>.workers.dev` | stable `orca.example.com` | random `*.trycloudflare.com` |
| After restarting Orca | phone stays paired | phone stays paired | **address changes, pair again** |
| Installs on desktop | nothing | `cloudflared` (auto, checksum-verified) | `cloudflared` |

### Worker relay (Worker + Durable Object, Free plan)

```
Orca Mobile ──wss /v1/c/<hostId>──▶ Cloudflare Worker ─▶ RelayHost Durable Object
                                                              ▲   (splices sockets)
Orca desktop ── plugin bridge ──wss control + data sockets────┘
      └─▶ ws://127.0.0.1:6768 (Orca's own mobile server, same as LAN)
```

- `worker/src/index.js` is a dependency-free Worker with one SQLite-backed Durable Object per
  desktop. It runs on the Workers Free plan.
- The plugin keeps an outbound **control** socket to the Durable Object. When a phone connects,
  the Durable Object asks the desktop to open a **data** socket. The plugin opens that socket,
  plus a local socket to Orca's mobile server, and splices them. To Orca, the phone looks like a
  LAN client.
- The relay is a blind pipe. Orca's end-to-end encryption (keys pinned from the QR code) runs
  inside the phone's socket, so Cloudflare and the Worker only ever see ciphertext.
- The phone's address is `wss://orca-relay.<you>.workers.dev/v1/c/<hostId>`. It never changes, so
  phones stay paired across Orca restarts and redeploys.
- Each desktop registers its host id with a secret key, and only that desktop can attach to it.

**Free plan budget:** Durable Objects get 100,000 requests/day, and incoming WebSocket messages
count 20 to 1. That is about 2 million relayed frames per day, plenty for personal use. The limits
reset at 00:00 UTC.

#### One-click setup (in the plugin)

1. In the panel, choose **Cloudflare Worker relay** and click **Create Cloudflare token**.
   Cloudflare opens with the permission already filled in (Account · Workers Scripts · Edit).
   Click **Continue to summary → Create Token** and copy it.
2. Paste the token and click **Deploy and connect**.

The plugin uploads the Worker through the Cloudflare API. No wrangler, Node or git is needed.
It enables `workers.dev` (registering a subdomain for brand-new accounts), registers this
desktop, connects, and is ready for **Show pairing QR code**.

#### Already have a Cloudflare account?

Use it. Any account works, free or paid, and nothing existing is changed:
- **Signing in:** the token button opens Cloudflare, where you sign in as usual.
- **Several accounts** (for example personal and a team): the panel asks which one should host
  the relay. It never guesses, and nothing is deployed before you choose.
- **A Worker already named `orca-relay`** that isn't this relay: the plugin refuses to touch it
  and asks for another name, such as `orca-relay-2`.
- **Your existing `workers.dev` subdomain** is reused. A subdomain is registered only for accounts
  that have none.

#### Or: Deploy to Cloudflare button

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/truongthanhquan/orca-cloudflare-relay-plugin/tree/main/worker)

Deploy from GitHub, then paste the Worker URL into the plugin under **Already deployed with the
"Deploy to Cloudflare" button?**. A button-deployed relay has no admin secret. The first desktop
to register a host id claims it, and others cannot take it over. To restrict registration, add a
`RELAY_ADMIN_TOKEN` secret in the Worker settings. Note that the in-plugin deploy sets this secret
automatically.

### Tunnel on your domain / Quick tunnel

```
Orca Mobile ──wss──▶ Cloudflare edge ──tunnel──▶ cloudflared (this Mac/PC) ──▶ 127.0.0.1:6768 (Orca)
```

For **your domain**, the plugin creates (or reuses) a remotely managed tunnel, routes
`hostname → http://127.0.0.1:<port>`, and adds a proxied CNAME to `<tunnel>.cfargotunnel.com`.
It never overwrites an existing non-tunnel record. Token permissions: Account · Cloudflare Tunnel
· Edit, Zone · DNS · Edit and Zone · Zone · Read.

A **quick tunnel** cannot keep its address. That is how Cloudflare's anonymous `trycloudflare.com`
works. For a stable address with no domain, use the Worker relay.

### Pairing works like LAN pairing

In every mode, the plugin asks the running Orca for a standard mobile pairing offer, using the
bundled `orca pair --mobile --address wss://…`, and shows it as a QR code. Orca Mobile scans it
exactly as it scans a LAN code. The app needs no update and no settings change.

## Use it

1. Install the plugin: `orca plugin install https://github.com/truongthanhquan/orca-cloudflare-relay-plugin`.
   For development, use `orca plugin dev load .`.
2. The **Cloudflare Relay** panel opens by itself the first time. Later, open it with
   `Set up relay` (cloud icon) in the status bar, the cloud icon in the right sidebar, or
   **Cloudflare Relay: Set up / open panel**, which you can also run from the plugin's page in
   Orca.
3. Follow the three setup steps. They are shown together, and the one you're on is
   highlighted:
   1. **Choose how your phone connects.** This stays editable, and changing it updates step 2
      right away.
   2. **Connect** your Cloudflare account (or domain). A short guide covers just this step:
      open Cloudflare, create the token, paste it, then **Deploy relay**. Progress appears
      under the button.
   3. **Pair your phone.** Shows the QR code once the relay is connected.

   Finished steps get a ✓ and later ones stay dimmed until it's their turn. **Change setup**
   later reopens the same steps.
4. Scan the QR code in Orca Mobile.

The plugin's Settings page lists the everyday options first. The first one, Connection type,
points to the panel, which is where setup happens. Options only needed for special setups are
labeled **Advanced:**.

**How the panel adapts:**
- **After setup:** the panel shows the status, the pairing card and a one-line summary such as
  "✓ Worker relay · https://orca-relay.you.workers.dev". Editing is collapsed under
  **Change or update setup**.
- **Saved token:** if a Cloudflare token is saved and still valid (checked with Cloudflare's
  verify endpoint, which changes nothing), the create and paste steps collapse to
  "✓ Using your saved token" with a **Use a different token** link. After a Worker deploy the
  token is forgotten by default, so you only see the token steps again when you redeploy.
- **Errors that need setup:** for example "not set up yet", "relay Worker out of date" or "relay
  does not recognise this desktop". The setup card is highlighted, opens by itself, and a
  **Fix in setup** button jumps to it.

**Status bar** (cloud icon): `Relay off | Relay… | Relay on | Relay · <n> phones | Relay error`. Clicking it always opens
the panel. It does not toggle the relay, so a stray click can't disconnect your phones. The
tooltip on an error carries the reason. `Cloudflare Relay: Toggle`, `Start` and `Stop` are still
in the command palette.

### Paired devices

Pairing through Cloudflare uses Orca's normal pairing code, so a phone paired this way is stored
in Orca's device registry like a LAN phone. It appears under **Paired devices** once it has
connected, as "Mobile <date>", and can be renamed or revoked there. Revoking ends its relay
connections too. Unused pairing codes never show up in that list.

The plugin doesn't read Orca's device list (it holds each phone's credentials, and Orca has no
plugin API for it), so the panel points you to **Paired devices** on Orca's **Mobile** page. Its
pairing card shows a new code whenever you want one; when the relay isn't connected, it says why
the button is waiting.

**Removing a phone** happens in Orca, because Orca offers plugins no supported way to revoke one
(no host API method and no CLI command). The card's **Remove a phone, or lost one?** section
walks you through it:
1. Open Orca's **Mobile** page (Orca's help calls it **Settings → Mobile**).
2. Under **Paired devices**, find the phone ("Mobile" plus the date it paired).
3. Remove it. Orca ends its access and closes its connections, including through this relay.

**Lost a phone and can't tell which entry it is?** With the Worker relay, **Disconnect all phones
from the relay** cuts every phone off the Cloudflare route at once:
- **How:** it moves the relay to a new address with a new desktop key, and gives the old address a
  key nobody holds.
- **What remains:** phones stay paired in Orca (for your local network) until you remove them on
  the Mobile page.
- **Afterwards:** the phones you keep pair again from the panel.
- **Safety:** it asks for confirmation first, and other copies of the plugin follow the new address.

### Prefer Orca's own Mobile page?

Once connected, you can also generate the QR code from Orca's built-in **Mobile** page. Choose a
custom address and enter the `wss://…` address shown in the panel's status card.

### Combine with Orca Relay

Turn on **Also offer Orca Relay** to put Orca Relay into the same QR code as a fallback. This
needs the desktop signed in to Orca. The phone then uses Cloudflare first and Orca Relay if the
tunnel is down.

## Automatic or manual setup

In step 2, both Cloudflare connection types offer **Automatic · token** or **Manual · no token**.
Manual setup never gives the plugin API access to your Cloudflare account.

| Connection type | Automatic (the plugin uses a token) | Manual (you do it in Cloudflare) |
| --- | --- | --- |
| **Worker relay** | **Create token** opens Cloudflare with Workers Scripts · Edit pre-filled. Paste the token, and the plugin deploys the Worker and forgets the token. | Deploy `worker/` with the **Deploy to Cloudflare** button or `npx wrangler deploy`, then paste the Worker URL. Optionally add a `RELAY_ADMIN_TOKEN` secret to restrict registration. |
| **Tunnel on your domain** | **Create token** opens Cloudflare with Cloudflare Tunnel · Edit, DNS · Edit and Zone · Read pre-filled; check the summary lists all three. The plugin checks the token read-only first and names any missing permission before creating anything. Then it creates the tunnel, route and DNS record. | Create the tunnel in Cloudflare (**Networks → Tunnels → Create a tunnel → Cloudflared**), add a public hostname with service `HTTP → 127.0.0.1:6768`, then paste the install command or its token. The plugin only runs `cloudflared` with that tunnel token. |
| **Quick tunnel** | Nothing to set up. | n/a |
| **Your own address** (advanced) | n/a | You run any tunnel or reverse proxy with TLS that forwards to `http://127.0.0.1:6768`, such as your own `cloudflared` service. Enter its `wss://` address. The plugin starts nothing; every minute it checks that the address reaches this Orca, and uses it in the pairing QR code. |

The panel shows the actual Orca port when it is not 6768. With a manual tunnel, if Orca's port ever
changes, the status tells you which service address to update in Cloudflare.

## Updates

**Plugin updates are Orca's job**, as Orca's [plugin guide](https://github.com/stablyai/orca/blob/main/docs/reference/plugin-authoring.md#5-publish-to-a-catalog)
describes. The plugin never installs an update on its own, but it makes updating one click:
1. **You see it:** the status bar reads `Relay on · update` (its tooltip names the new version),
   and the panel shows an **Update available** card with the release notes.
2. **You click Update now:** the plugin runs Orca's own updater (`orca plugin update <its key>`),
   only because you clicked. Your setup and paired phones are kept, and Orca restarts the plugin.
3. **If Orca needs your OK** (the version adds settings, commands or access), the card says what
   is new and where to approve it: Settings → Plugins → Cloudflare Relay. The plugin never
   approves anything itself.

The card also lists the other ways: Settings → Plugins → **Update**, or the terminal command.
- **Installed from the directory or a catalog:** Orca installs new versions by itself while
  **Update plugins automatically** is on (the default). A release installs once it has been
  listed for 12 hours, so a takedown has time to land.
- **Installed from a Git URL:** click **Update** on the plugin in Orca's Settings → Plugins, or
  run `orca plugin update truongthanhquan.cloudflare-relay`.
- **Approval:** an update that asks for no new access keeps its approval. One that asks for more
  shows **Update needs review** in Orca until you approve it.
- **How it knows:** 15 seconds after start, then every 6 hours (or **Check now**), it reads
  this repository's `update-manifest.json`. The file can never install anything. Its only power
  is the `minimum` described below.

**Required (security) updates.** If a version turns out to have a security problem that an attacker
could use, the next release raises `minimum` in `update-manifest.json`. Older copies then **fail
closed**: the relay turns off until the fix is in, so phones can't reach your desktop through
the vulnerable version. It works the same way for the plugin and the Worker:

| | The plugin is below `plugin.minimum` | The relay Worker is below `relay.minimum` (or on an older protocol) |
|---|---|---|
| The relay | Off until updated. The status bar reads `Update required`, and the panel shows a **Security update** card | Off until redeployed. Same status bar and card |
| The fix | **Update now** (one click), Settings → Plugins → **Update**, or Orca's automatic catalog updates Click **Update relay** (paste a token if none is kept). Automatic only if you opted in under **Relay Worker updates** and keep a token. A Deploy-button relay is updated from your GitHub copy |
| Afterwards | Orca restarts the plugin and the relay reconnects by itself | The relay reconnects by itself |

Phones stay paired through both fixes. Safeguards:
- **Offline:** a known minimum is saved, so being offline (or GitHub being blocked) can't skip it.
- **Always a way out:** a minimum counts only when a version that meets it is published.
- **Nothing installs or deploys by itself** unless you opt in: the plugin is only installed by
  Orca or your click, and the relay Worker only redeploys on your click by default.
- **Development copies** never block.
- **Worker fixes that need a newer plugin** (the plugin can deploy only the Worker it ships) ask
  for the plugin update first.

**Relay Worker updates:** the relay runs in *your* Cloudflare account, so Orca can't update it.
The plugin does that part.
- **How it is detected:** at the same times, the plugin reads the deployed Worker's public `/health` version and compares it with the Worker it
  ships (`worker/src/index.js`). Nothing else is fetched.
- **Required relay updates:** when the deployed relay speaks an older protocol than the plugin.
- **How it updates:** a redeploy keeps the same host id and keys, so **phones stay paired**.
- **The "Relay Worker updates" setting** decides what deploys without asking: nothing (the
  default: the panel asks and you click **Update relay**), required updates only, or all
  updates. The automatic choices are opt-in and need a Cloudflare token kept on this computer
  ("Keep the Cloudflare API token").
- **Deploy-button relays** update from your GitHub copy, not from the plugin.

**Phones stay paired through updates.** A paired phone dials
`<your relay>/v1/c/<host id>`, and every case below keeps that address the same:

| What happens | Why phones keep working |
| --- | --- |
| Orca updates the plugin | Same plugin key, so the same storage and secrets |
| The plugin redeploys the relay Worker | Same host id and key; the Worker's Durable Object data survives a redeploy |
| You reinstall the plugin, switch from a Git install to the directory one, or run a development copy | The host id is also remembered per Worker for the whole computer, and every copy reuses it |
| Another copy of the plugin registered a different address earlier | On start, the plugin takes over the address your phones use and logs "Switched to the relay address your paired phones already use" |

Phones need to pair again only when the relay address itself changes: a different Worker name,
another Cloudflare account, or switching connection type. To cut a phone off, revoke it in
Orca → Paired devices.

**The status bar** adds `· update` when a plugin or relay update is available, and shows
`Update relay` when the relay must be redeployed.

### Releasing a new version (maintainers)

1. Bump `version` in `orca-plugin.json`. If the Worker changed, bump `RELAY_VERSION` in
   `worker/src/index.js`, and `RELAY_PROTOCOL` only when the desktop-to-relay contract breaks.
2. Set `plugin.latest` and `relay.latest` in `update-manifest.json`. `npm test` checks that they
   match. Raise `minimum` only for a security or compatibility fix: every older copy turns its
   relay off until updated.
3. Run `orca plugin validate .` and `npm test`, commit to `main`, then tag and push:
   `git tag -a vX.Y.Z -m vX.Y.Z && git push origin vX.Y.Z`. The Orca directory lists the newest tag.

## What this plugin does on your machine

This plugin runs as an Orca **trusted worker** (Orca's "Full access" label): a Node process with
your user's permissions. That is a lot of trust, so here is everything it does with it. The
source is plain, unminified JavaScript in [`src/`](src/) and [`worker/src/`](worker/src/), with
no dependencies besides a vendored MIT QR code generator.

**Processes it starts**

| Process | When | Why |
| --- | --- | --- |
| `orca pair --mobile --address <endpoint> --json [--rotate] [--relay]` | You click **Show pairing QR code**, and again when a code is hidden or expires | Creates Orca's normal pairing code for your relay address, or replaces it so an old one stops working |
| `orca pair --mobile --address 127.0.0.1 --json` | When the relay starts or is set up (skipped if **Local Orca port** is set) | Reads only the local port from Orca's answer, so no Orca file is read. Without `--rotate` it reuses Orca's unused code, and the link in the answer is discarded |
| `orca plugin list --json` / `orca plugin open <this plugin> --panel cloudflare-relay` | First run, the status bar item, and when a newer version is announced | Opens this plugin's own panel, and finds its key for the `orca plugin update <key>` line in the update card |
| `orca plugin update <this plugin> --json` | Only when you click **Update now** | Runs Orca's own updater. Orca applies its checks and asks you to approve an update that adds access |
| `cloudflared tunnel run` / `cloudflared tunnel --url …` | Tunnel modes only, while the tunnel is on | Runs the Cloudflare tunnel. The tunnel token goes in an environment variable, never in the command line |
| `tar -xzf` | macOS only, once, when it downloads `cloudflared` | Unpacks the downloaded `cloudflared` archive |
| `ps -p <pid> -o comm=` | At startup, tunnel modes only | Stops a `cloudflared` this plugin left behind after a crash, and only if that pid really is `cloudflared` |

The Worker relay mode starts no processes at all. It opens WebSockets from the plugin itself.

**Network connections**

| Host | When | What is sent |
| --- | --- | --- |
| `api.cloudflare.com` | Only during setup, update or removal, with the token you pasted | Deploys or deletes the relay Worker, or creates or deletes the tunnel and its DNS record, in **your** account |
| Your relay Worker (`<name>.<you>.workers.dev` or the URL you entered) | While the relay is on, plus a GET of its public `/health` every 6 hours to compare versions | This desktop's relay key (in a header), and the phone traffic, which is end-to-end encrypted |
| `github.com/cloudflare/cloudflared/releases` | Tunnel modes, the first time only | Downloads `cloudflared` version 2026.11.1. Its SHA-256 is checked against values pinned in [`src/cloudflared-binary.mjs`](src/cloudflared-binary.mjs) before it is used. Skipped if you set **cloudflared path** |
| `raw.githubusercontent.com` (this repository's `update-manifest.json`) | 15 seconds after start, then every 6 hours | A plain GET with no identifiers, to show "Update available" and to turn the relay off when this version is below a published security minimum. Nothing about you or your setup is sent, and nothing is installed |
| Your own address (custom mode) | Every 60 seconds while on | A plain HTTPS GET of `/web-index.html`, to show whether it reaches your Orca |
| `127.0.0.1:<Orca port>` | For each relayed phone | The phone's encrypted traffic, handed to Orca's own mobile server |

Links such as **Create token** or **Deploy to Cloudflare** open in your browser only when you
click them. There is **no telemetry, analytics or crash reporting**, and no server run by the
plugin author: the relay runs in your own Cloudflare account.

**Files and secrets**

- **Secrets** (Cloudflare API token, tunnel token, relay key and admin or owner token) live in
  Orca's plugin secret store, which is encrypted with the OS key store. Where Orca reports none
  (`secrets.protection` is `unavailable`, such as Linux without a keyring), setup stops and says
  so rather than store them some other way. The API token is deleted right after setup unless you turn on
  **Keep the Cloudflare API token**.
- **Plugin storage and settings** hold only non-secret state: the connection type, the Worker
  URL and host id, the tunnel id and hostname.
- **Cache folder** (`~/Library/Caches/orca-cloudflare-relay` on macOS,
  `%LOCALAPPDATA%\orca-cloudflare-relay` on Windows, `~/.cache/orca-cloudflare-relay` on Linux)
  holds the downloaded `cloudflared`, an empty config file and a pid file.
- **Relay identity** (`~/Library/Application Support/orca-cloudflare-relay/relay-identity.json`
  on macOS, `%APPDATA%\orca-cloudflare-relay` on Windows, `~/.config/orca-cloudflare-relay` on
  Linux): each relay Worker URL and the host id this computer registered on it, so a reinstall
  or another copy of the plugin keeps the address paired phones use. Nothing secret: the host id
  is already in every pairing code. The file is readable only by you.
- **Orca's files:** none. The plugin never reads or writes Orca's private files (its device
  list, runtime metadata or settings). It asks Orca only through Orca's own CLI: `orca pair
  --mobile` for pairing codes and for the local port Orca listens on (unless you set **Local
  Orca port**), and `orca plugin` for its own key and updates. Pairing secrets are never logged
  or sent to the panel.

**Removing it:** **Remove setup** deletes what it created in Cloudflare (when it still has a
token) and forgets every secret. Uninstalling the plugin then leaves only the cache folder and
the relay identity folder, which you can delete (phones paired before then would need to pair
again).

## Security

Pairing through Cloudflare keeps the same guarantees as LAN pairing, and adds relay-specific
protections.

**What protects your Orca (the same as LAN):**
- **Keys pinned from the QR code.** The QR code carries the desktop's Curve25519 public key, and
  the phone pins it. A relay, Cloudflare, or anyone in the middle cannot impersonate the desktop
  or read the traffic. Every connection is end-to-end encrypted, and the device must prove its
  token inside that encryption before Orca answers anything.
- **No special trust for relayed connections.** Orca grants loopback connections no
  authentication bypass. Relayed phones go through exactly the same E2EE and token checks as LAN
  phones.

**What the relay adds:**

| Risk | Protection |
| --- | --- |
| Replaying recorded traffic (legacy E2EE v1 has no per-session desktop nonce) | The bridge refuses any connection whose first frame is not an **E2EE v2** hello. v2 binds fresh nonces from both sides, so recorded sessions cannot be replayed. This is the rule Orca's own relay enforces (`requireV2`). Orca never sees a refused connection. |
| A leaked or photographed QR code | Codes are **single use**: Orca swaps the code for the phone's own credential at first sign-in. Every **Show** makes a new code and cancels the previous one. A code is **invalidated after 5 minutes**, on **Done, hide code**, or when the relay stops. The pairing link itself never leaves the plugin process; the panel only receives the QR image. |
| Someone else attaching as your desktop | Each desktop has a 128-bit random host id and a 256-bit secret key. The key is sent only in the `Authorization` header over TLS, never in a URL. The Worker stores only a SHA-256 of it and compares in constant time. Registering a host id needs the admin secret the plugin deploys. |
| Strangers using your Worker (and its free quota) as their own relay | A plugin-deployed Worker accepts registrations only with its admin secret. A **Deploy-button** Worker has no admin secret, so the first desktop to register **locks it to that desktop's owner token**; anyone else gets "belongs to another Orca desktop". Relays set up before 1.2.0 are locked automatically once the Worker is updated. |
| Flooding your Orca or your free quota | Orca exempts loopback from its per-source limits, so the relay enforces its own: 12 new phone connections per minute per IP, at most 4 concurrent connections per IP and 16 per desktop, and a 10-second first-frame deadline (Orca then gives a connection 10 seconds to authenticate). At most 64 KiB may be buffered before the desktop answers, and 1 MiB while the local connection opens. The bridge opens a local connection to Orca only after a valid v2 hello arrives. |
| Probing whether you are online | The phone URL answers nothing without a WebSocket upgrade. |
| A stolen Cloudflare API token | The token is needed only to deploy, so it is **deleted after deploy** by default. The setting is "Keep the Cloudflare API token". You can also revoke it in Cloudflare right away. Removing setup without a token still forgets this desktop's relay key. |
| Secrets on disk | All tokens and keys live in Orca's plugin secret store (OS keychain). None are in settings, logs or process arguments. |

**Limits to be aware of:**
- **Cloudflare can see metadata:** when and how much traffic flows, and the phone's IP address.
  It cannot see content.
- **Tunnel modes don't get the v2 check:** in the two tunnel modes, `cloudflared` forwards bytes
  directly, so the bridge's v2 check does not apply. Orca Mobile still latches every desktop to v2
  after its first v2 connection and refuses to downgrade. Use the Worker relay for the full set of
  protections.
- **Someone with many IP addresses can still slow pairing down:** limits are per IP. Even when
  they hold every slot, they cannot get in: every connection must still pass Orca's E2EE and
  token checks. If it happens, rotate the address by removing and redoing setup. Your phones
  will need to pair again.
- **Revoke a lost phone in Orca:** use **Paired devices** on Orca's Mobile page. A paired phone holds its
  own long-term credential, and removing the device there cuts it off immediately, relay or not.
- **Pairing widens Orca's listener:** like Orca's own network pairing, creating an offer makes
  Orca's mobile server listen on all interfaces (LAN), not only loopback.

## Notes

- Phones reach the desktop only while Orca is running with the plugin enabled, as with LAN.
- Requires Orca ≥ 1.4.248 and the bundled Orca CLI (used to create pairing offers).
- `cloudflared` binaries: <https://github.com/cloudflare/cloudflared/releases> (version pinned in
  `src/cloudflared-binary.mjs`). Set **cloudflared path** to use your own.

## Development

```sh
npm test                    # unit tests (Node ≥ 24)
cd worker && npx wrangler dev   # run the relay Worker locally
orca plugin validate .      # manifest check
orca plugin dev load .      # load into the running Orca
```
