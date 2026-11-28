# D-38. One-line install and pair command

- **Lane:** D · **Module:** `apps/dashboard` · **Milestone:** M5
- **Depends on:** D-37
- **Status:** in progress (fix/dashboard-terminal-powershell-install)
- **Spec:** [Engine-first installation](../../design/engine-first-installation.md)

## Goal

The copied "install and pair" command is one short line per platform that points at one script of ours, instead of a block with a pinned checksum, version and here-string.

## Scope

- `curl -fsSL <origin>/install.sh | PTBK_LINK=<code> bash`, the same with `/install-server.sh` for an Ubuntu VPS, and `$env:PTBK_LINK='<code>'; irm <origin>/install.ps1 | iex`. The code travels in the environment, never in argv.
- The scripts are public Worker routes declared through the route helper (no input, `public-read-ip`), rendered with the release selected the same way as at link-code issuance. Version, Ubuntu bootstrap revision and SHA-256, and Windows EXE SHA-256 live in the scripts, which still verify those downloads before running them.
- Integrity without a checksum in the command: Worker routes at exact paths (never the SPA fallback), `text/plain` with `no-store`, and scripts that run nothing before their last line.
- Installer behaviour otherwise unchanged: sudo only after an explicit y, prerequisites, Ubuntu path, AI prompts in both locales.
- Found on a real server: reuse a CLI only from the script's own prefix, never another `ptbk` on PATH (a wrapper there ran the project as another user), and on Linux with systemd ask to enable linger so the engine survives a reboot.

## Acceptance criteria

- [x] One line per platform in New project, the AI prompts and the legacy `installCommands` entry.
- [x] The scripts are never the SPA shell, in the in-memory app and the built Worker.
- [x] Invalid codes, truncated downloads, wrong checksums and failed installs run nothing further; the CLI and the bootstrap never see `PTBK_LINK`.
- [x] A matching `ptbk` elsewhere on PATH is never used; linger is enabled only after an explicit y, never for root, unattended runs or hosts without systemd.
- [x] The copied-command tests have explicit timeouts and run the served scripts in Bash 3.2 and 5, zsh and PowerShell.
- [ ] The PowerShell command prepares Git, Node.js, npm and the selected CLI under the current account and pairs in the same terminal. The native wizard is available through Windows EXE.
