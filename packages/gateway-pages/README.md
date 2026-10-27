# @ptbk/gateway-pages

Reference pages for an engine gateway's owner setup (`/setup`), sign-in (`/auth/sign-in`) and step-up (`/auth/step-up`), with the copy, states and recovery hints from [onboarding.md](../../docs/design/onboarding.md) in English and Czech, and the Promptbook design tokens so the first screen an owner sees matches the engine UI.

They are meant to be copied. Static HTML, one stylesheet and one small browser script; no build step, no framework, and no dependency besides `@simplewebauthn/browser` 14.0.0, vendored byte for byte and pinned by SHA-256 and Subresource Integrity. They run unchanged under `ENGINE_UI_CSP` with Trusted Types: no inline script or style, no HTML sinks, no external origins. The mock engine serves them; the engine team owns and reviews whatever it ships, and may change the structure.

MIT, imports nothing from `@ptbk/*` (ESLint enforces it), and moves to the public repo with the contracts ([ADR 0002](../../docs/adr/0002-public-private-split.md)). Plan: task M-08.

## Files

`pages/` holds everything a browser loads:

| File                                | Served at                                        | What                                                                      |
| ----------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------- |
| `setup.html`                        | `/setup`                                         | Template: the owner's first passkey from the setup link                   |
| `sign-in.html`                      | `/auth/sign-in`                                  | Template: usernameless passkey sign-in                                    |
| `step-up.html`                      | `/auth/step-up`                                  | Template: a fresh passkey assertion for a sensitive change                |
| `gateway.css`                       | `/auth/assets/gateway.css`                       | Design tokens (light, dark by the OS, reduced motion) and the page styles |
| `gateway.js`                        | `/auth/assets/gateway.js`                        | ES module: switches between the states the page holds; it has no copy     |
| `next-path.js`                      | `/auth/assets/next-path.js`                      | The safe `next` rule, imported by `gateway.js` and by the server          |
| `simplewebauthn-browser.umd.min.js` | `/auth/assets/simplewebauthn-browser.umd.min.js` | Vendored; defines the global `SimpleWebAuthnBrowser`                      |

`src/index.ts` is for a server written in TypeScript or JavaScript: `GATEWAY_PAGES_DIR`, `GATEWAY_PAGES`, `GATEWAY_ASSETS` (file name to content type), `GATEWAY_ASSET_PATH`, `SIMPLEWEBAUTHN_BROWSER_SHA256`, `renderGatewayPage`, `pickGatewayLanguage` and `isSafeNextPath`. Serve the pages as `text/html; charset=utf-8` with `Cache-Control: no-store`, and the assets with their content types.

## Placeholders

The server renders a page with `renderGatewayPage(template, values)`, which HTML-escapes every value and throws on an unknown placeholder or a missing or malformed value. Every page takes the same set:

| Placeholder            | Value                                                                                         |
| ---------------------- | --------------------------------------------------------------------------------------------- |
| `{{lang}}`             | `en` or `cs`, from `pickGatewayLanguage(Accept-Language)`; Czech only if ranked above English |
| `{{engineId}}`         | The engine ID                                                                                 |
| `{{hostname}}`         | The engine's hostname, without scheme                                                         |
| `{{fingerprint}}`      | `deriveEngineFingerprint(engineId).formatted`, `XXXX-XXXX-XXXX-XXXX-XXXX`                     |
| `{{fingerprintCells}}` | Its 5×5 cells row by row as 25 characters, `1` filled                                         |
| `{{command}}`          | The engine's CLI name in recovery hints, such as `promptbook-engine`                          |
| `{{owner}}`            | `none` or `set`: whether the engine has an owner (public; sign-in shows it anyway)            |

Both languages are in every page; `<html lang>` selects one through the stylesheet.

## Endpoints

All requests are `POST` with a JSON body, same-origin, `cache: 'no-store'`, `redirect: 'error'` and a 15 s timeout. Errors are `application/problem+json` with a `code`; the script reads them tolerantly and decides mostly by status.

| Page    | Request                                                    | Answers and the state they show                                                                                                           |
| ------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| setup   | `/setup/options` `{ secret }`, validates without consuming | 200 `{ options }` (WebAuthn creation options JSON): `valid`; 403 `setup-link-invalid`: `expired`; 409 `owner-exists`; 429: `rate-limited` |
| setup   | `/setup/verify` `{ secret, response }`                     | 200 `{ next? }`: `done`, linking to `next` or `/`; 400 `passkey-not-verified`: `not-verified`; 403, 409 and 429 as above                  |
| sign-in | `/auth/sign-in/options` `{}`                               | 200 `{ options }` (request options JSON): `ready`; 429: `rate-limited`                                                                    |
| sign-in | `/auth/sign-in/verify` `{ response, next? }`               | 200 `{ next? }`: navigates there or to `/`; 400 or 401 (`passkey-not-recognised`): `not-recognised`; 429                                  |
| step-up | `/auth/step-up/options` `{}`                               | 200 `{ options }`: `ready`; 401: `signed-out`; 429                                                                                        |
| step-up | `/auth/step-up/verify` `{ response, next? }`               | 200 `{ next? }`: navigates there or to `/`; 401 `unauthenticated`: `signed-out`; other 400 or 401: `not-recognised`; 429                  |

Any other status shows `error`, a network failure or timeout `offline`. The setup secret is the URL fragment (`/setup#<22 base64url characters>`): the page reads it once, removes it with `history.replaceState` before anything else, keeps it only in memory and sends it only in these two bodies. A malformed or absent fragment shows `missing` without a request, and `{{owner}}` = `set` shows `owner-exists`. Sign-in takes `?next=`, step-up `?returnTo=` (as the engine UI sends them); either is passed on only if `isSafeNextPath` accepts it, and the server's answer is checked again before navigating. Browser errors map to `cancelled` (`NotAllowedError`, `AbortError`), `unsupported` (`NotSupportedError`, `SecurityError`, no WebAuthn) or `failed`.

## Copying

Copy `pages/` and serve it as above; keep `gateway.css`'s token block in sync with the design tokens if you want the same look (here, `src/tokens.test.ts` compares it with `packages/ui`). To update the vendored library, copy `dist/bundle/index.umd.min.js` from the new `@simplewebauthn/browser` and update the hash in `src/assets.ts` and the `integrity` attribute in each page; the tests check all three.
