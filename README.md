# SOCKS5 Proxy Server (Node.js, zero dependencies)

This project is a production-oriented SOCKS5 proxy server implemented with only Node.js built-in modules (`net`, `fs`), including username/password authentication.

## Files

- `index.js` - main SOCKS5 state machine server (RFC 1928 + RFC 1929)
- `config.js` - environment variable configuration with defaults
- `auth.js` - credential validation
- `logger.js` - structured connection lifecycle logging to stdout + file
- `socks5-proxy.log` - log file (created automatically on first run)

## Run

```bash
node index.js
PROXY_PORT=8080 PROXY_USER=myuser PROXY_PASS=mypass node index.js
```

Default configuration values:

- `PROXY_PORT=1080`
- `PROXY_HOST=0.0.0.0`
- `PROXY_USER=admin`
- `PROXY_PASS=secret123`

## Logs

All connection events are logged to **`socks5-proxy.log`** in the same directory and also printed to stdout for real-time monitoring.

Example log entries:
```
[2026-05-07T11:19:01.445Z] CONNECTED | src=0.0.0.0 | dst=proxy-listen:1080
[2026-05-07T11:30:10.123Z] CONNECTING | src=192.168.1.5 | dst=ipinfo.io:443
[2026-05-07T11:30:10.220Z] CONNECTED  | src=192.168.1.5 | dst=ipinfo.io:443
[2026-05-07T11:31:44.012Z] ERROR | src=192.168.1.5 | dst=- | error=ECONNREFUSED
```

## Test with curl

```bash
curl --socks5 127.0.0.1:1080 --proxy-user admin:secret123 https://ipinfo.io
```

For extra troubleshooting signal:

```bash
curl --verbose --socks5 127.0.0.1:1080 --proxy-user admin:secret123 https://ipinfo.io
```

## Reflection

Implementing this required understanding the SOCKS5 handshake sequence from RFC 1928 and the username/password sub-negotiation from RFC 1929, then translating that into an explicit state machine. The most important implementation detail was safe incremental parsing with a buffer accumulator, because TCP frames can be split or coalesced unpredictably across `data` events.

Debugging focused on observing protocol behavior at each phase and validating state transitions. The practical loop was running `curl --verbose`, checking whether method selection/auth/request bytes were accepted, and correlating that with byte-level parsing assumptions and connection logs to catch partial-frame and ordering issues.

With more time, I would add per-IP rate limiting and abuse controls, structured JSON log output for better ingestion in observability stacks, and full graceful shutdown behavior for active tunnels. I would also extend protocol support to UDP ASSOCIATE and optionally load settings from a config file in addition to environment variables.
