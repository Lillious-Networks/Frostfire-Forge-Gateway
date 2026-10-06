---
title: Authentication
description: Accounts, registration, login, the session token, guest mode, password reset, two-factor authentication, and the webserver HTTP API.
order: 40
---

The webserver (`src/webserver/server.ts`) owns player accounts. This page describes how an account is created and verified, what happens during a login, how the session token works, the three two-factor methods, and every HTTP route the webserver exposes.

Players see these flows as pages. The player facing description is in [Account Security](#/player-guide/account-security).

## Accounts

An account is a row in the `accounts` table of the shared game database.

| Field | Rule |
| --- | --- |
| Username | 3 to 15 characters: letters, digits and underscore. Stored in lower case. May not start with `guest_`. Must be unique. |
| Email | Must look like an email address and be unique. Stored in lower case. |
| Password | 8 to 20 characters with at least one upper case letter, one lower case letter, one digit and one special character from the set below. |

```text title="Accepted special characters"
! @ # $ % ^ & * ( ) , . ? " : { } | < >
```

Passwords are hashed with `Bun.password.hash` and never stored in plain text. A banned account (`banned = 1`) cannot log in.

Creating an account also creates the player's rows in `stats`, `clientconfig`, `quest_log`, `currency`, `equipment` and `collectables`.

## Registration and email verification

The registration page is `/registration`.

1. The page sends `POST /register` with `username`, `email`, `password` and `password2`.
2. The server validates the fields, creates the account, issues a session token and turns on the email code requirement for the new account (`require_email_2fa = 1`).
3. A six character verification code is emailed to the address. The response is `200` and sets the `token` cookie.
4. The page swaps its form for a code field and sends `POST /verify?username=<name>&code=<code>`.
5. The server marks the email as verified, clears the code and clears the session token. The response is `{"emailVerified": true}`.
6. The page sends the player back to `/` to sign in.

:::note New accounts get an email code at every login
Registration switches the email requirement on. Until the player turns it off on the profile page, each login sends a fresh code by email. See [Two-factor authentication](#/gateway/authentication/two-factor-authentication).
:::

:::warning Registration needs working email
If the email cannot be sent, `POST /register` answers `500` with `Failed to send verification email`. Set `EMAIL_SERVICE`, `EMAIL_USER` and `EMAIL_PASSWORD` first. See [Configuration](#/gateway/configuration/email).
:::

## Login flow

The login page is `/`. It sends `POST /login` with `username` and `password`.

| Server decision | Response | What the page does next |
| --- | --- | --- |
| Bad input, unknown user, wrong password or banned | `400` with a message | Shows the message |
| Email not verified yet | `200`, `code: "unverified"`, code emailed | Shows the code field, then calls `/verify` |
| Email code required | `200`, code emailed | Shows the code field, then calls `/verify` |
| TOTP or a security key required | `200`, `requires2FA: true` | Goes to `/2fa-challenge` |
| Nothing more required | `301` | Goes to `/realm-selection` |

Every successful step sets the `token` cookie. While a challenge is open, the account is flagged `twofa_pending`. In that state the webserver refuses to issue a connection token, so the player cannot enter a realm.

`POST /verify` checks the code against the account that owns the cookie token. For a login it answers `{"verified": true}`, or `{"requires2FA": true}` when a TOTP or security key requirement still has to be met after the email code.

:::note Status 301 means success
`POST /login` and `POST /guest-login` answer a full success with status `301` and no `Location` header. The page scripts treat that status as the signal to move on to realm selection. A custom client should do the same.
:::

After login the player picks a realm and the client asks for a connection token. That part is described in [Game Servers](#/gateway/game-servers).

## Session token

The session token is 64 hexadecimal characters (32 random bytes), stored in `accounts.token`.

```text title="Cookie set at login"
Set-Cookie: token=<64 hex characters>; Path=/
```

- The cookie is a session cookie: it has no `Max-Age` and no `Expires`. Some responses add `SameSite=Lax`.
- It is not `HttpOnly`. The page scripts and the game client read it, and the game client presents it to the game server when it authenticates.
- API routes accept the token from the cookie or from an `Authorization: Bearer <token>` header.
- A login reuses the token already stored for the account and only creates a new one when none exists.
- Verifying the email of a new account clears the token, which is why the player signs in again afterwards.

## Guest mode

With `GUEST_MODE_ENABLED=true` the "Continue as guest" link on the login page calls `POST /guest-login`. The server:

1. Creates an account named `guest_` followed by 24 random hexadecimal characters, flagged `guest_mode = 1`.
2. Gives it a placeholder email at the host name from `DOMAIN` and a random password nobody knows.
3. Logs it in and answers `301` with the `token` cookie.

With guest mode off the route answers `403` with `Guest mode is disabled`.

`POST /guest-bulk` creates many guest accounts in one request for load tests. It needs guest mode on and the value of `GATEWAY_GAME_SERVER_SECRET` in an `X-Benchmark-Secret` header or as a bearer token. The body `{"count": 500}` asks for that many accounts (1 to 2000, default 100) and the response lists their tokens. See [Benchmarking](#/engine/benchmarking).

## Password reset

1. The player opens `/forgot-password` and enters an email address.
2. The page sends `POST /reset-password` with `email`. The answer is always the same sentence, whether or not the address belongs to an account.
3. If the account exists, a reset code is stored and a link to `/manage-profile` with the email and the code is emailed. The link is built from `DOMAIN`.
4. The profile page shows the reset form and sends `POST /update-password` with `email`, `code`, `password` and `password2`. If the account has an authenticator app enabled, `totp` is required as well.
5. The server stores the new password hash and clears the reset code. The code works once.

## Two-factor authentication

An account can register methods and, separately, mark each one as required at login. Everything is managed on `/manage-profile`.

| Method | Setup | Used at login when |
| --- | --- | --- |
| Email code | Always available | `require_email_2fa` is on. It is on by default for new accounts. |
| Authenticator app (TOTP) | Scan a QR code, confirm with one code | `require_totp` is on and the app is enabled |
| Security key or passkey (WebAuthn) | Register a key in the browser | `require_webauthn` is on and at least one key is registered |

The email code is sent and checked on the login page itself. TOTP and security keys are checked on `/2fa-challenge`, which asks `GET /api/2fa/status` for the methods that apply and shows them.

### Authenticator app

- `POST /api/profile/setup-totp` with the account password returns a QR code image and the `otpauth://` URI. The issuer shown in the app is `GAME_NAME`.
- `POST /api/profile/verify-totp` with a six digit code enables the app.
- Codes are standard TOTP: SHA-1, six digits, 30 second steps. One step before and after the current one is accepted.
- Disabling asks for the password and then a code sent by email.

### Security keys

- `POST /api/profile/register-webauthn` with the account password returns the registration options. The browser creates the credential and `POST /api/profile/verify-webauthn-registration` stores it with a name.
- Only ES256 keys are accepted. User verification is `preferred`.
- The relying party id is the host name of the request, so keys are bound to the domain the player registered on.
- Removing a key asks for the password plus an authenticator code, or an email code when no authenticator app is enabled.

:::warning Changing the domain breaks registered keys
Because the relying party id is the request host, a key registered on one host name does not work on another. Pending WebAuthn challenges are also kept in the memory of the webserver process, so a restart in the middle of a registration or login means starting that step again.
:::

### Requirements

`POST /api/profile/2fa-requirements` with `method` (`webauthn`, `totp` or `email`) and `value` switches a requirement on or off. Switching one on needs the method to be set up. Switching one off needs proof with that same method: a key assertion, an authenticator code, or an email code.

## Sensitive profile changes

| Change | Proof asked for |
| --- | --- |
| Change email | A code sent to the current address, then a code sent to the new one. With TOTP or a security key enabled, an authenticator code first. |
| Change password | Current password, plus an authenticator code if TOTP is enabled, otherwise an email code when the email requirement is on. |
| Reveal email | Current password. The profile API otherwise returns the address masked. |

## HTTP API

All routes are served by the webserver behind the reverse proxy. "Token" in the Auth column means the session token, sent as the `token` cookie or as a bearer token. Request and response bodies are JSON.

### Pages

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/` | None | Login page |
| GET | `/registration` | None | Registration page |
| GET | `/forgot-password` | None | Request a password reset |
| GET | `/2fa-challenge` | None | TOTP and security key challenge. The page calls the API with the token. |
| GET | `/realm-selection` | None | Realm list. The page sends visitors without a `token` cookie back to `/`. |
| GET | `/manage-profile` | None | Profile, password and two-factor settings. Also the target of reset links. |
| GET | `/game` | None | The game client. It authenticates against the game server. |
| GET | `/map-editor`, `/control-panel` and the other tool routes | None | Tool windows. See [Tools Overview](#/tools/overview). |
| GET | `/service-worker.js` | None | Service worker that caches sprites and assets |
| GET | `/img/...`, `/fonts/...` | None | Images and fonts, cached for one hour |

Any other path redirects to `/` with a `301`.

### Accounts and sessions

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/status` | None | Health check. Answers `{"status":"ok"}`. |
| POST | `/register` | None | Create an account and email a verification code |
| POST | `/login` | None | Check the password and start a session |
| POST | `/verify` | Token cookie | Check an emailed code. `username` and `code` go in the query string. |
| POST | `/guest-login` | None | Create and log in a guest account. Needs guest mode. |
| POST | `/guest-bulk` | Game server secret | Create many guest accounts for load tests |
| POST | `/reset-password` | None | Email a password reset link |
| POST | `/update-password` | Reset code | Set a new password with the emailed code |

### Gateway

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/api/gateway/servers` | None | The realm list, read from the gateway server |
| GET | `/api/gateway/connection-token` | None | A signed connection token valid for 60 seconds. Refused with `403` while the caller's account has an open 2FA challenge. |
| POST | `/api/client-log` | Token | Forward browser console errors to the server log. Limited to 120 lines per minute per player. |

### Profile

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/api/profile` | Token, no open challenge | Username, masked email, methods and requirements |
| POST | `/api/profile/change-email` | Token | Change the email address in three steps |
| POST | `/api/profile/change-password` | Token | Change the password |
| POST | `/api/profile/reveal-email` | Token and password | Return the unmasked email |
| GET | `/api/profile/generate-password` | None | Return a random 16 character password that passes the rules |
| POST | `/api/profile/setup-totp` | Token and password | Start authenticator setup, returns the QR code |
| POST | `/api/profile/verify-totp` | Token | Confirm setup with a code and enable the app |
| POST | `/api/profile/disable-totp` | Token and password | Remove the authenticator app |
| POST | `/api/profile/register-webauthn` | Token and password | Start security key registration |
| POST | `/api/profile/verify-webauthn-registration` | Token | Finish registration and store the key |
| POST | `/api/profile/remove-webauthn` | Token and password | Remove a security key |
| POST | `/api/profile/auth-webauthn` | Token | Get assertion options to prove a key for a profile change |
| POST | `/api/profile/2fa-requirements` | Token | Switch a login requirement on or off |

### Two-factor challenge

These routes only work while the account has an open challenge. Otherwise they answer `400`.

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/api/2fa/status` | Token | Which methods the challenge accepts |
| POST | `/api/2fa/verify-totp` | Token | Finish the challenge with an authenticator code |
| POST | `/api/2fa/auth-webauthn` | Token | Get assertion options for a security key |
| POST | `/api/2fa/verify-webauthn` | Token | Finish the challenge with a key assertion |
| POST | `/api/2fa/send-email` | Token | Email a six character code |
| POST | `/api/2fa/verify-email` | Token | Finish the challenge with the emailed code |

```bash title="Log in and fetch the profile"
curl -i -X POST https://play.example.com/login \
  -H "Content-Type: application/json" \
  -d '{"username":"aldric","password":"change-me"}'

curl https://play.example.com/api/profile \
  -H "Authorization: Bearer <token from the cookie>"
```

:::note No rate limiting in the webserver
The login, registration and code routes have no attempt counter of their own. The only automatic blocking is the path based blacklist of the [Reverse Proxy](#/gateway/reverse-proxy). Put a rate limiter in front of the gateway if you expose it to the internet.
:::
