---
title: TLS and Certificates
description: Certificate setup for the website and the gateway port, local development without certificates, and WebTransport certificate hash pinning.
order: 70
---

The website and the gateway server share one certificate and one switch. This page covers where the files go, which variables control them, what happens in local development, and how the game client pins the certificate of a game server with `GAME_WT_CERT_HASH`.

## One certificate, one switch

| Variable | Purpose |
| --- | --- |
| `HTTP_USE_SSL` | `true` turns TLS on for both public listeners: the website and the gateway port. |
| `TLS_CERT_PATH` | PEM file with the server certificate. |
| `TLS_KEY_PATH` | PEM file with the private key. |
| `TLS_CA_PATH` | Optional PEM file with the CA chain. When the file exists it is appended to the certificate. |

```env title=".env.production"
HTTP_USE_SSL=true
TLS_CERT_PATH=./src/certs/cert.pem
TLS_KEY_PATH=./src/certs/key.pem
TLS_CA_PATH=./src/certs/cert.ca-bundle
WEBSRV_PORT=80
WEBSRV_PORTSSL=443
GATEWAY_PORT=9999
GATEWAY_PORTSSL=9443
```

With TLS on:

| Listener | HTTPS port | Plain HTTP port |
| --- | --- | --- |
| Website (reverse proxy) | `WEBSRV_PORTSSL` (443) | `WEBSRV_PORT` (80) answers with a `301` redirect to HTTPS |
| Gateway server | `GATEWAY_PORTSSL` (9443) | `GATEWAY_PORT` (9999) answers with a `301` redirect to HTTPS |

The HTTPS listeners serve HTTP/1.1, HTTP/2 and HTTP/3. HTTP/3 uses UDP, so open the HTTPS ports for UDP as well as TCP, or switch it off with `WEBSRV_HTTP3=false`.

:::note Older variable names
The repository README names `WEBSRV_USESSL` and `GATEWAY_USESSL`. The code reads neither. `HTTP_USE_SSL` is the only switch and it covers both listeners.
:::

## File locations

The paths are whatever the three variables say. The example environment file uses the `src/certs` folder:

```text title="src/certs"
src/certs/
  cert.pem          server certificate
  key.pem           private key
  cert.ca-bundle    CA chain (optional)
  db.crt            database certificate, only when SQL_SSL_MODE is not DISABLED
```

Certificate and key files in `src/certs` are ignored by git. Relative paths are resolved from the directory you start the gateway in, which is the repository root when you use `bun production`.

The certificate must be valid for the host name in `DOMAIN`. The same certificate is presented on the gateway port, so game servers that reach the gateway by another name need that name on the certificate too.

:::warning A missing file silently means plain HTTP
If `HTTP_USE_SSL=true` but the certificate or key file does not exist, the listener logs `SSL requested but certificates not found` with both paths and then starts on the plain HTTP port instead. Check the startup log after every certificate change. It prints `HTTPS proxy started on port 443` when TLS is really on.
:::

## Renewing a certificate

The files are read once at startup. After replacing them, restart the gateway.

## The internal hop

Each public listener forwards to an application bound to `127.0.0.1` (the webserver on `WEBSRV_INTERNAL_PORT`, the gateway application on `GATEWAY_INTERNAL_PORT`). Those internal servers use the same certificate files:

- When both files exist, the internal servers serve HTTPS and the proxies connect to them over TLS.
- When the files are missing, the internal servers serve plain HTTP.

This depends only on whether the files exist, not on `HTTP_USE_SSL`. Calls between the gateway's own processes do not verify the certificate name, since they connect to `127.0.0.1`.

## Local development

For work on one machine, leave TLS off:

```env title=".env.development"
HTTP_USE_SSL=false
DOMAIN=http://localhost
WEBSRV_PORT=80
GATEWAY_PORT=9999
```

- The website is at `http://localhost` and the gateway server at `http://localhost:9999`.
- No certificate files are needed for the gateway.
- Browsers treat `localhost` as a secure context, so security keys and WebTransport still work.

The game server is different: WebTransport always needs TLS, even on localhost. The engine generates a short lived local certificate by itself, and the client trusts it through hash pinning, described next. See [Networking](#/engine/networking).

## WebTransport certificate pinning

The browser connects to a game server at `https://<publicHost>:<wtPort>`. A certificate from a public CA just works. A self signed development certificate does not, unless the client tells the browser the exact certificate to expect. WebTransport supports that with a list of SHA-256 certificate hashes.

`GAME_WT_CERT_HASH` on the gateway decides what the client does:

| Value | Client behaviour |
| --- | --- |
| Empty (default) | Asks the chosen game server for its hash with `GET /wt-cert-hash` and pins it. If the server reports that its certificate is not suitable for pinning, the client connects with normal certificate validation. |
| A base64 hash | Pins that hash for every realm and does not ask the game server. |
| `off` | Never pins. The game server certificate must be trusted by the browser. |

:::tabs
```env title="Development"
# Empty: the client fetches the hash from the game server
GAME_WT_CERT_HASH=
```
```env title="Production"
# A CA signed certificate on the game server needs no pin
GAME_WT_CERT_HASH=off
```
:::

The game server answers the hash request like this:

```json title="GET /wt-cert-hash on the game server"
{
  "algorithm": "sha-256",
  "value": "<base64 SHA-256 of the DER certificate>"
}
```

It answers `404` when its certificate cannot be pinned. Browsers only accept a pinned certificate that uses an ECDSA P-256 key and is valid for no more than 14 days. The certificate the engine generates for local use meets both rules.

To compute the hash of a certificate yourself:

```bash title="Hash a certificate"
openssl x509 -in cert.pem -outform der | openssl dgst -sha256 -binary | openssl base64
```

Things to know:

- The value is injected into the client when the gateway starts. Restart the gateway after changing it.
- A fixed hash applies to all realms. With more than one game server they would all need the same certificate.
- Development certificates are replaced when they expire, which changes the hash. A fixed hash then stops working, so leave the variable empty in development.
- The browser console of the game page logs which mode was used: `with a pinned certificate hash` or `using normal certificate validation`.

:::warning Pinning is not a substitute for a real certificate
Hash pinning exists for development and short lived certificates. For a public realm, give the game server a CA signed certificate for its `PUBLIC_HOST` and set `GAME_WT_CERT_HASH=off`, or leave it empty and let the game server report that no pin is needed.
:::

## Database TLS

`SQL_SSL_MODE` controls TLS to the database. With any value other than `DISABLED` the gateway loads `src/certs/db.crt` and uses it for the connection. See [Configuration](#/gateway/configuration/database).

## Checklist for production

1. Put the certificate, key and chain in place and set the three `TLS_*_PATH` variables.
2. Set `HTTP_USE_SSL=true` and `DOMAIN` to the HTTPS origin of the site.
3. Open 80 and 443 (TCP, and UDP 443 for HTTP/3) for the website. Open the gateway ports only to game servers and admins.
4. Point each game server's `GATEWAY_URL` at the HTTPS address of the gateway port.
5. Start the gateway and confirm the two `HTTPS proxy started` lines in the log.

The full deployment walk through is in [Production](#/getting-started/production).
