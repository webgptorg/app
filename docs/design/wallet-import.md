# Importing website logins into the Wallet

Open **Wallet → Import logins**, choose a local export, review the sites and accounts, select the logins and import. English and Czech use the same flow. The action requires `wallet.manage`, `wallet@1` and a ready Wallet.

## Supported exports

| Source                              | Format         | Fields used                                                                                                                                            |
| ----------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Bitwarden / compatible Vaultwarden  | Plaintext JSON | `items[].name`, `login.username`, `login.password`, website `login.uris[].uri`                                                                         |
| Bitwarden                           | CSV            | `name`, `login_uri`, `login_username`, `login_password`; only `type=login`                                                                             |
| 1Password                           | CSV            | `Title`, `Url` or `Website`, `Username`, `Password`; archived items skipped                                                                            |
| LastPass                            | CSV            | `name`, `url`, `username`, `password`                                                                                                                  |
| Chrome / Edge / compatible browsers | CSV            | `name`, `url`, `username`, `password`                                                                                                                  |
| Other compatible CSV                | CSV            | Case-insensitive `url`/`website`/`hostname`/`login_uri`, `username`/`user name`/`login_username`, `password`/`login_password`, optional `name`/`title` |

Export references: [Bitwarden formats](https://bitwarden.com/help/condition-bitwarden-import/), [Bitwarden export](https://bitwarden.com/help/export-your-data/), [1Password export](https://support.1password.com/export/), [LastPass export](https://community.lastpass.com/kb/articles/40-export-vault-data-from-lastpass-as-a-generic-csv-file%EF%BB%BF).

CSV is comma-delimited UTF-8, optionally with a BOM. Quoted commas, doubled quotes, embedded newlines, CRLF and empty cells are supported. Password whitespace is preserved. Malformed quotes, inconsistent row widths and ambiguous required headers reject the file. Combined URI cells and embedded control characters in website addresses are skipped; use JSON for multiple websites per login. Export envelopes and rows are parsed as untrusted data; provider-specific metadata is discarded, while every imported field must satisfy the existing Wallet limits.

This is a conversion to ordinary website login saves, not an engine Wallet archive restore or an additional import API. It needs no engine change. It copies website, username, password and name only. Cards, identities, notes, folders, attachments, passkeys, OTP seeds and custom fields stay in the original manager. Deleted Bitwarden records, regular-expression or Never URI matching, unsupported URLs and incomplete logins are skipped. JSON website URLs expand to separate service-bound logins; equivalent URLs within one item collapse. Paths are dropped, consistently with manual Wallet entry.

The input limit is 5 MiB and 1,000 source records or expanded website logins. A full overview at the contract's 1,000-record limit cannot prove that every existing account is enumerated, so import refuses to write in that case. Encrypted JSON, ZIP, 1PUX and other vault archives are not accepted. Delete the plaintext export after use.

## Selection and saves

New accounts are selected by default. Existing accounts require individual selection to replace their password. Matching conservatively follows the reference engine's upsert: same scheme and host/port without a leading `www.`, and case-insensitive usernames. A record with hidden username metadata protects all accounts on its service by default. Every member of a duplicate service/account group within the file is skipped, so conflicting passwords cannot silently choose a winner.

The queue refreshes the Wallet before writing, including after passkey step-up. A newly discovered existing account is skipped unless its replacement was explicitly selected in the preview. The existing API upserts and has no create-only precondition, so this read and write are not atomic against another client saving the same account concurrently; this limitation cannot be eliminated in the UI alone.

Writes are sequential. Progress counts confirmed saves, and failures stop the queue. Already completed writes stay saved. Selecting the export again leaves existing logins unselected; a connection failure can leave the last attempted write uncertain, so the member is asked to check it. Cancel aborts the active request and prevents all subsequent writes, but cannot undo a request the engine already accepted.

Popup step-up retains the private queue in memory and resumes its cursor after confirmation. Full-page step-up drops the file and all secrets: the member selects the export again. The import creates no storage intent containing passwords or file contents. Closing/unmounting cancels even a pending step-up retry.

## Privacy and verification

The file is parsed on the engine's browser origin. No complete export is uploaded, no new service or dependency is introduced, and the dashboard receives nothing. Only selected credentials go through existing engine Wallet writes. Passwords remain outside React state, preview props, form/query data, storage, URLs, DOM, toasts and logs. The preview and queue hold secrets in private one-time holders; serialising them yields an empty object. Unselected passwords are discarded when import starts; queued values are cleared on completion, permanent failure, close or unmount. JavaScript strings cannot promise forensic memory erasure.

Parser and UI tests cover formats, quoting, bounds, duplicates, default preservation, selection, secret canaries, failures, cancellation and popup step-up. The Wallet Playwright scenario imports synthetic Bitwarden entries and checks the DOM, responses, storage, console and outgoing requests: only selected credentials are sent. No real password export is used in development or tests.
