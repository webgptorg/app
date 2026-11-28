#!/bin/bash
set -euo pipefail
umask 077
work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT
curl -fsSL --retry 3 -o "$work/install" https://raw.githubusercontent.com/webgptorg/promptbook/__REVISION__/deploy/ubuntu/install.sh
printf '%s  %s\n' '__SHA256__' "$work/install" | sha256sum --check --status -
bash "$work/install" --version '__VERSION__' --prepare-only </dev/null

# Bind the engine to its cloud owner before the dashboard can see the pairing.
runuser --login promptbook --command \
    'cd ~ && PTBK_LOGIN_LOCATION=remote exec ptbk init --prepare-only --non-interactive --json' </dev/null > "$work/project"
id=$(/opt/promptbook/node/bin/node -e 'const fs = require("node:fs"); const {engineId} = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); if (!/^[a-z2-7]{26}$/.test(engineId)) process.exit(1); process.stdout.write(engineId)' "$work/project")
markers=/etc/promptbook/digitalocean-first-owner
install -d -m 0755 /etc/promptbook "$markers"
printf '%s\n' '__OWNER__' > "$work/owner"
install -m 0644 "$work/owner" "$markers/$id"
for attempt in 1 2 3; do
    if printf '%s\n' '__LINK__' | runuser --login promptbook --command \
        "cd ~ && read -r PTBK_LINK_CODE && export PTBK_LINK_CODE PTBK_LOGIN_LOCATION=remote && exec ptbk connect --onboarding $id --json" >/dev/null; then
        exit 0
    fi
    sleep 10
done
exit 1
