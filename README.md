# sock-torch 🔦

A lightweight SOCKS5 proxy server built with Node.js using **zero external dependencies** — only the built-in `net` module. Implements RFC 1928 (SOCKS5) and RFC 1929 (username/password authentication).

---

## Features

- TCP CONNECT tunneling
- Username/password authentication (RFC 1929)
- IPv4 and domain name (FQDN) destination support
- Per-connection logging with timestamps and source IP
- Fully configurable via environment variables

---

## Requirements

- Node.js v14 or higher
- No `npm install` needed — zero dependencies

---

## Configuration

All configuration is done via environment variables:

| Variable     | Default     | Description                       |
|--------------|-------------|-----------------------------------|
| `PROXY_PORT` | `1080`      | Port the proxy listens on         |
| `PROXY_HOST` | `0.0.0.0`   | Network interface to bind to      |
| `PROXY_USER` | `admin`     | Authentication username           |
| `PROXY_PASS` | `secret123` | Authentication password           |

---

## How to Run

### Clone the repo

```bash
git clone https://github.com/adhilNuckz/sock-torch.git
cd sock-torch
```

### Start with defaults (port 1080)

```bash
node index.js
```

### Start with custom configuration

```bash
PROXY_PORT=8080 PROXY_USER=myuser PROXY_PASS=mypassword node index.js
```

You should see:

```
[2026-05-07T13:11:54.519Z] CONNECTED | src=0.0.0.0 | dst=proxy-listen:1080
```

---

## Testing the Proxy

### Fetch your public IP through the proxy

```bash
curl --socks5 127.0.0.1:1080 --proxy-user admin:secret123 https://ipinfo.io
```

Expected output — a JSON response showing the **proxy server's** public IP, not your local machine's:

```json
{
  "ip": "178.128.107.85",
  "city": "Singapore",
  "region": "Singapore",
  "country": "SG",
  "org": "AS14061 DigitalOcean, LLC",
  ...
}
```

### Test from a remote machine (replace with your server IP)

```bash
curl --socks5 YOUR_SERVER_IP:1080 --proxy-user admin:secret123 https://ipinfo.io
```

### Test authentication failure (should be rejected)

```bash
curl --socks5 127.0.0.1:1080 --proxy-user wrong:credentials https://ipinfo.io
```

Expected: connection closes immediately with no data returned.

### Test with verbose output to see the handshake

```bash
curl --verbose --socks5 127.0.0.1:1080 --proxy-user admin:secret123 https://ipinfo.io
```

---

## Deploying on a Remote Server (e.g. DigitalOcean)

```bash
# 1. SSH into your server
ssh root@YOUR_SERVER_IP

# 2. Clone and enter the project
git clone https://github.com/adhilNuckz/sock-torch.git
cd sock-torch

# 3. Allow the port through the firewall
ufw allow 1080/tcp

# 4. Start the proxy
node index.js

# 5. Also open port 1080 in your cloud provider's firewall/security group
#    (e.g. DigitalOcean Cloud Firewall → Inbound Rules → TCP 1080)
```

---

## Project Structure

```
sock-torch/
├── index.js      — SOCKS5 server, state machine, connection handler
├── config.js     — Environment variable configuration
├── auth.js       — Username/password credential validation
├── logger.js     — Timestamped connection logging
└── README.md     — This file
```

---

## Reflection

### What I had to learn

Before this project, I had a general understanding of proxies but had never worked at the raw protocol level. I had to study RFC 1928 (SOCKS5) and RFC 1929 (username/password sub-negotiation) to understand the exact byte-level handshake sequence. The most important insight was that the client-server exchange happens in three distinct phases — greeting, authentication, and request — before any real traffic flows. I also had to learn how to safely handle TCP streams in Node.js, since data arrives in arbitrary chunks rather than neat complete messages. This required building a buffer accumulator and a proper state machine that only consumes bytes once a full message is available, which was a new pattern for me.

### How I approached debugging

My primary tool was `curl --verbose` with the `--socks5` flag, which prints exactly which phase of the handshake succeeded or failed. When connections were hanging externally but working locally, I used `ss -tlnp` to confirm the port was bound, and `ufw status` to check the local firewall. The key debugging insight was distinguishing between the OS-level firewall (ufw) and the cloud provider's external firewall (DigitalOcean Cloud Firewall) — both need to allow the port independently. I also added detailed per-state logging to the server so I could see exactly which phase a connection reached before failing, which made it easy to isolate whether the problem was in the handshake or the tunneling.

### What I would improve with more time

Given more time, I would add several improvements. First, structured JSON logging so connection logs can be piped into a log aggregator like Loki or Datadog for monitoring at scale. Second, connection rate limiting and IP-based access control to prevent the proxy from being abused if credentials are ever leaked. Third, graceful shutdown handling — currently in-flight connections are abruptly terminated when the server process exits; a proper implementation would stop accepting new connections while allowing active tunnels to drain. I would also add a YAML or JSON config file as an alternative to environment variables, and explore adding UDP ASSOCIATE support for completeness with the SOCKS5 spec.

---

## References

- [RFC 1928 — SOCKS Protocol Version 5](https://datatracker.ietf.org/doc/html/rfc1928)
- [RFC 1929 — Username/Password Authentication for SOCKS V5](https://datatracker.ietf.org/doc/html/rfc1929)
- [Node.js `net` module documentation](https://nodejs.org/api/net.html)
