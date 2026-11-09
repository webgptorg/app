#!/bin/bash
# The offline checks for everything under infra/ (I-01), as CI's infra job runs them: tofu fmt, validate and test
# (mocked providers, no backend), then the rendered user data and the scripts through cloud-init, nft,
# systemd-analyze, sshd, unbound and ShellCheck. Needs only Docker: no account, token or provider API call; OpenTofu
# downloads the locked providers.
set -euo pipefail

TOFU_IMAGE=ghcr.io/opentofu/opentofu:1.11.14@sha256:6913ba3b281b0b7d2c2cb286e3aaf64d48c8c113e692218066b1b308fa2a2c8a
TOOLS_IMAGE=ptbk-relay-tools:local

infra=$(cd "$(dirname "$0")/../.." && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

step() { printf '\n== %s\n' "$*"; }

# Runs tofu in $1 (relative to infra/) as the calling user, so nothing in the checkout ends up owned by root.
tofu() {
    local dir=$1 command=$2
    shift 2
    docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp -e TF_IN_AUTOMATION=1 \
        -v "$infra:/infra" -v "$work:/work" -w "/infra/$dir" "$TOFU_IMAGE" "$command" -no-color "$@"
}

step "tofu fmt"
tofu . fmt -check -recursive -diff

# Every directory with .tf files: environment roots, modules and the render fixture.
for dir in $(cd "$infra" && find . -name '*.tf' -not -path '*/.terraform/*' -exec dirname {} \; | sort -u); do
    step "tofu validate ${dir#./}"
    tofu "$dir" init -backend=false -input=false -lockfile=readonly >/dev/null
    tofu "$dir" validate
done

for tests in $(cd "$infra" && find . -type d -name tests -not -path '*/.terraform/*' | sort); do
    step "tofu test ${tests%/tests}"
    tofu "${tests%/tests}" test
done

# The state bucket's R2 endpoint names each environment's Cloudflare account, which a backend cannot take as a variable.
step "staging and production roots differ only in their names and state accounts"
r2_account='s|https://[^.]*\.r2\.cloudflarestorage\.com|https://ACCOUNT.r2.cloudflarestorage.com|'
diff <(sed -e 's/staging/ENV/g' -e "$r2_account" "$infra/relay/environments/staging/main.tf") \
    <(sed -e 's/production/ENV/g' -e "$r2_account" "$infra/relay/environments/production/main.tf")

step "render the user data (test/render)"
tofu relay/test/render apply -auto-approve -input=false -state=/work/render.tfstate >/dev/null
# Decodes what Hetzner gets (gzip, base64) back to the cloud-config the host sees.
tofu relay/test/render output -state=/work/render.tfstate -raw user_data | base64 -d | gzip -d >"$work/user-data"

step "build the tools image"
docker build --quiet --tag "$TOOLS_IMAGE" --file "$infra/relay/test/tools.Containerfile" "$infra/relay/test"

docker run --rm --cap-add=NET_ADMIN -v "$infra:/infra:ro" -v "$work:/work:ro" "$TOOLS_IMAGE" \
    bash /infra/relay/scripts/check-host.sh /work/user-data
