# Engine-first installation, 18 November 2026

The existing Reborn engine owns durable onboarding, identity, private drafts, the passkey gateway, prompts, files and harness sign-in. This change completes Dashboard's installation presentation without replacing those mechanisms, adding heartbeat fields or billing, or sending project content to Dashboard.

## Configuration and response

`ENGINE_INSTALLATION` is optional reviewed metadata: `version`, `windowsSha256`, `bootstrapRevision` (an immutable commit) and `bootstrapSha256`. The supported line starts at `0.119.0-117`; malformed or older versions fail startup. URLs derive from official release naming and the immutable bootstrap path. HTTPS Dashboard origin is required. A requester cannot supply an installer URL or shell fragment.

At link-code issuance, optional `installationOptions` separates these payloads:

| Kind       | UI                    | Payload                                                             |
| ---------- | --------------------- | ------------------------------------------------------------------- |
| `command`  | New project (default) | Bash/zsh, Windows PowerShell, verified Ubuntu bootstrap             |
| `ai`       | Install with AI       | CS/EN prompts for this computer or an existing VPS over SSH         |
| `download` | Windows EXE           | Exact release URL, SHA-256, checked PowerShell pairing continuation |

Legacy configurations keep their original tabs. `INSTALL_COMMANDS` still validates its 512-character shell templates and one placeholder; long prompts/downloads never enter it. With new metadata, the generated local block is also retained as the legacy `installer` command, and configured connect/Compose choices move behind a secondary disclosure.

New setup installs the exact package, checks the executable actually on PATH, then invokes `init --prepare-only --link`. PowerShell uses `$LASTEXITCODE`, including on 5.1. Bash/zsh short-circuit on failure. Ubuntu verifies downloaded bytes before sudo, prepares sudo authentication before piping input when it is not already root, passes the link on stdin to the dedicated engine account, and removes its temporary script. Neither path uses the working directory as a project or resumes a paused existing project.

Windows has no assumed pairing deep link: a fresh-terminal follow-up block is required. AI prompts retain the issuance's link/version, preserve data/sign-ins and native approvals, and leave agenda/harness choices to the engine UI. No engine name is represented as a known project path. Dashboard and its payloads never know an owner setup secret.

## Reviewed artifacts and limits

Staging is prepared for npm `ptbk@0.119.0-117`, `Promptbook-Setup-0.119.0-117-windows-x64.exe`, and bootstrap commit `eda1a109787d164046d1f73732705e8a9afa76ec`. This is a prerelease. Matching macOS DMGs remain in the public catalogue. Production's remaining placeholders are not credentials or a deployment instruction.

The reviewed 117 package includes the native Codex/Claude fixes from 115. The source branch is already `0.119.0-118`; it is not selected until all its artifacts are published and checked. A verified command/asset is not proof that every provider flow succeeds. Update all reviewed metadata together after checking npm, assets, bootstrap bytes and the real flow.

## Review and release gates

- Related draft #256 covers the older Ubuntu-only path. Coordinate this broader follow-up; do not land duplicate default flows.
- Preserve issuance-only handling, expiry/copy feedback, CZ/EN and mobile tabs. No pairing secret enters URL queries, persistent client storage, project files or logs.
- Owner setup happens on the engine origin. Continue through `onboarding@1`/`files@1`; stale `promptId` submissions remain the engine's responsibility.
- Full UI needs approved `PTBK_UI_RELEASE_URL` and `PTBK_UI_TRUST_POLICY_FILE`. Check signatures, manifest/API range, delay, revocations and `/api/v1/security` UI facts. Relay reachability is insufficient.
- Before release, complete one real engine walkthrough from a new pairing through passkey, brief/file, native harness login and usable project, including deferral. Record Windows 5.1, native EXE/DMG and real VPS runs separately from portable PowerShell and fixtures.

Targeted tests execute copied Bash/zsh/PowerShell with inert commands, cover failed installs/version mismatches, quote/fragment handling, valid/corrupt bootstrap and stdin handoff, validate typed configuration/responses, and render/copy both locales. They do not install system software, buy hosting or authenticate a real provider.
