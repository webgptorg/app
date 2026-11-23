# Engine-first installation, 18 November 2026

The existing Reborn engine owns durable onboarding, identity, private drafts, the passkey gateway, prompts, files and harness sign-in. This change completes Dashboard's installation presentation without replacing those mechanisms, adding heartbeat fields or billing, or sending project content to Dashboard.

## Configuration and response

`ENGINE_INSTALLATION` is optional reviewed fallback metadata: `version`, `windowsSha256`, `bootstrapRevision` (an immutable commit) and `bootstrapSha256`. Supported semantic versions start at `0.119.0-117`, including later prereleases and release lines. The pinned Ubuntu installer accepts versions without build metadata. Invalid or older versions fail startup. URLs derive from official release naming and the immutable bootstrap path. HTTPS Dashboard origin is required. A requester cannot supply an installer URL or shell fragment.

On each personal or team link-code issuance outside development, Dashboard reads `https://registry.npmjs.org/ptbk/latest`. A newer supported version is selected only when its exact `v<version>` GitHub release is published, is not a draft, and has exactly one uploaded `Promptbook-Setup-<version>-windows-x64.exe` with a GitHub SHA-256 digest. Commands, localized AI prompts, Ubuntu's `--version`, the Windows URL/checksum and its continuation all use that same exact version. Future releases need no Dashboard redeploy. Previously issued commands stay pinned to their issuance; creating a new link resolves again.

Both metadata requests share a ten-second deadline and each response is capped at 512 KiB. The Worker requests a five-minute edge cache for successful public metadata to bound registry/GitHub traffic; error responses are not cached. URLs are fixed official endpoints, redirects are not followed, and no pairing code, cookie, credential or project content is sent. Missing assets during publication, malformed metadata, upstream errors/timeouts, or a version no newer than the fallback preserve the complete configured version/checksum pair. This means an upstream outage can temporarily offer the reviewed fallback instead of the newest release. Caller cancellation propagates. Development and tests use an in-memory configured source; legacy command-only configuration makes no metadata requests.

At link-code issuance, optional `installationOptions` separates these payloads:

| Kind       | UI                    | Payload                                                             |
| ---------- | --------------------- | ------------------------------------------------------------------- |
| `command`  | New project (default) | Bash/zsh, Windows PowerShell, verified Ubuntu bootstrap             |
| `ai`       | Install with AI       | CS/EN prompts for this computer or an existing VPS over SSH         |
| `download` | Windows EXE           | Exact release URL, SHA-256, checked PowerShell pairing continuation |

Legacy configurations keep their original tabs. `INSTALL_COMMANDS` still validates its 512-character shell templates and one placeholder; long prompts/downloads never enter it. With new metadata, the generated local block is also retained as the legacy `installer` command, and configured connect/Compose choices move behind a secondary disclosure.

New setup installs the exact package, checks the executable actually on PATH, then invokes `init --prepare-only --link`. PowerShell uses `$LASTEXITCODE`, including on 5.1. Bash/zsh short-circuit on failure. Ubuntu verifies downloaded bytes before sudo, prepares sudo authentication before piping input when it is not already root, passes the link on stdin to the dedicated engine account, and removes its temporary script. Neither path uses the working directory as a project or resumes a paused existing project.

The command panel explains how to open Terminal on macOS/Linux, PowerShell on Windows, or an SSH session for Ubuntu. It asks users to paste the whole block and explains that no folder selection is needed. The continuation names the first-access link in plain language, states that connection precedes agenda setup, and explains automatic progress and saved setup. These instructions are available in Czech and English.

Windows has no assumed pairing deep link: a fresh-terminal follow-up block is required. AI prompts retain the issuance's link/version, preserve data/sign-ins and native approvals, and leave agenda/harness choices to the engine UI. No engine name is represented as a known project path. Dashboard and its payloads never know an owner setup secret.

## Reviewed artifacts and limits

Staging's reviewed fallback is npm `ptbk@0.119.0-131` (git `d35a811b`) and `Promptbook-Setup-0.119.0-131-windows-x64.exe` (SHA-256 `1bb46215441c35edaf8012935d245603c382f268de9bef979f5d062288ce938f`, hashed locally and matching GitHub's digest and the `.sha256` asset), published on 22 November 2026. Bootstrap commit `eda1a109787d164046d1f73732705e8a9afa76ec` and its checksum remain independently pinned; its verified script accepts the selected exact `--version`. This is a prerelease. Matching macOS DMGs remain in the public catalogue. Production's remaining placeholders are not credentials or a deployment instruction.

Source-checkout versions are never used for release selection. A verified command/asset is not proof that every provider flow succeeds. Update fallback version and Windows digest together after checking the published npm package and asset. Bootstrap bytes/revision remain a separate manual review; automatic version discovery does not replace the pinned script or weaken signed UI verification.

## Review and release gates

- Related draft #256 covers the older Ubuntu-only path. Coordinate this broader follow-up; do not land duplicate default flows.
- Preserve issuance-only handling, expiry/copy feedback, CZ/EN and mobile tabs. No pairing secret enters URL queries, persistent client storage, project files or logs.
- Owner setup happens on the engine origin. Continue through `onboarding@1`/`files@1`; stale `promptId` submissions remain the engine's responsibility.
- Full UI needs approved `PTBK_UI_RELEASE_URL` and `PTBK_UI_TRUST_POLICY_FILE`. Check signatures, manifest/API range, delay, revocations and `/api/v1/security` UI facts. Relay reachability is insufficient.
- Before release, complete one real engine walkthrough from a new pairing through passkey, brief/file, native harness login and usable project, including deferral. Record Windows 5.1, native EXE/DMG and real VPS runs separately from portable PowerShell and fixtures.

Targeted tests execute copied Bash/zsh/PowerShell with inert commands, cover failed installs/version mismatches, quote/fragment handling, valid/corrupt bootstrap and stdin handoff, validate typed configuration/responses, and render/copy both locales. They do not install system software, buy hosting or authenticate a real provider.
