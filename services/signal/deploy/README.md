# Deploying CapMac's signaling server

Remote access lets CapMac reach your Mac from anywhere. The signaling server is the meeting point:

- **Introduces** your PC to the Mac: the service on the Mac stays connected to it, so CapMac can find the Mac on whatever network it is.
- **Relays** the connection when the two networks don't allow a direct one (some hotel, office and mobile networks). Most of the time they connect **peer to peer** and the server is out of the way.
- **Answers STUN** on UDP 3478, so each end learns its public address.

It never sees inside a connection (the SSH session inside is encrypted end to end), stores nothing on disk, and keeps only who is online in memory. One small VPS serves many PCs and Macs.

## What you need

- A server with a public IP address: any small VPS (1 vCPU and 512 MB are plenty). Linux with Docker is easiest.
- A domain name pointing at it, for example `signal.example.com`: an **A** record (and **AAAA** if the server has IPv6).
- These ports open in the server's firewall:

  | Port | For |
  |---|---|
  | 80/tcp, 443/tcp | HTTPS (Caddy gets the certificate on port 80) |
  | 3478/udp | STUN |

## With Docker (recommended)

On your PC, build the server and copy this folder to the server:

```sh
npm run build -w @capmac/signal              # makes services/signal/dist/capmac-signal.mjs
scp -r services/signal/deploy services/signal/dist you@your-server:capmac-signal/
```

On the server:

```sh
cd capmac-signal/deploy
cp .env.example .env            # set DOMAIN=signal.example.com
docker compose up -d --build
curl https://signal.example.com/healthz
```

`/healthz` answers like `{"ok":true,"protocol":1,"version":"0.1.0","macsOnline":0,…}`. Logs: `docker compose logs -f signal`. To update, copy a new `dist/capmac-signal.mjs` and run `docker compose up -d --build` again.

## Without Docker

You need Node.js 22 or later on the server, and a TLS proxy in front.

```sh
sudo mkdir -p /opt/capmac-signal
sudo cp dist/capmac-signal.mjs /opt/capmac-signal/
sudo cp deploy/capmac-signal.service /etc/systemd/system/   # edit PUBLIC_HOST in it first
sudo systemctl daemon-reload && sudo systemctl enable --now capmac-signal
```

Then serve it over HTTPS:

- **With Caddy:** the two lines of `deploy/Caddyfile` (with your domain), then `sudo systemctl reload caddy`.
- **With nginx:** proxy to `127.0.0.1:8787` with WebSocket upgrades:

  ```nginx
  location / {
      proxy_pass http://127.0.0.1:8787;
      proxy_http_version 1.1;
      proxy_set_header Upgrade $http_upgrade;
      proxy_set_header Connection "upgrade";
      proxy_set_header X-Forwarded-For $remote_addr;
      proxy_read_timeout 3600s;
  }
  ```

The server can also serve HTTPS itself: set `TLS_CERT_FILE` and `TLS_KEY_FILE`, and `PORT=443`.

## Connect CapMac to it

On your PC:

```sh
capmac remote server wss://signal.example.com
```

Or set it in CapMac Studio › Settings › Remote access. Then turn remote access on for your Mac while you are on its network: `capmac remote on`, or Macs › Remote access. A release of CapMac can also be built with your server as its default (`CAPMAC_DEFAULT_SIGNAL_URL=wss://signal.example.com` at build time).

## Settings

All from the environment (`.env` with Docker, `Environment=` lines with systemd):

| Variable | Default | What it does |
|---|---|---|
| `PORT`, `HOST` | `8787`, all addresses | Where the server listens. |
| `PUBLIC_HOST` | (none) | Your server's name; CapMac is told to use `stun:PUBLIC_HOST:STUN_PORT`. |
| `STUN_PORT` | `3478` | UDP port for STUN; `0` turns it off. |
| `STUN_URLS` | this server's STUN, then Google's | STUN servers handed to CapMac (comma-separated). |
| `TRUST_PROXY` | off | Take clients' addresses from `X-Forwarded-For` (behind Caddy or nginx), for rate limits. |
| `TLS_CERT_FILE`, `TLS_KEY_FILE` | (none) | Serve wss:// directly, without a proxy. |
| `TURN_URLS`, `TURN_SECRET`, `TURN_TTL` | (none), (none), `86400` | Optional TURN via coturn (below). |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error`. |

## Optional: TURN with coturn

CapMac's own relay through this server works on every network that allows HTTPS, so TURN is not needed. If you run coturn anyway (for example on another server), CapMac uses it over UDP before falling back to the relay:

```ini
# /etc/turnserver.conf
listening-port=3478     # or another port when the STUN above uses 3478
fingerprint
use-auth-secret
static-auth-secret=<a long random secret>
realm=signal.example.com
no-cli
no-tcp-relay
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.168.0.0-192.168.255.255
```

Then give the signaling server the same secret: `TURN_URLS=turn:turn.example.com:3478?transport=udp` and `TURN_SECRET=<the secret>`. It hands out credentials that expire after `TURN_TTL` seconds.

## Security

- Every PC and Mac proves who it is with its own Ed25519 key. The server only introduces a PC to a Mac; the service on the Mac decides, and lets in only PCs that were paired with it.
- Both ends sign their WebRTC certificates, so even a compromised server cannot put itself in the middle of a peer-to-peer connection. A relayed connection carries SSH, encrypted end to end and checked against the Mac's pinned host key.
- Limits per address and per key slow down abuse: new connections per minute, open sockets, connection attempts, and a 10-minute lockout after repeated bad signatures.
