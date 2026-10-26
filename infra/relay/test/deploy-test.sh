#!/usr/bin/env bash
# The deploy test (I-03). Two Debian 13 containers stand in for two relays: systemd and rootful Podman, with the user
# data's own files, units and users, the deploy timer, and the cosign its install script fetches. A registry with a
# pull account stands in for GHCR (its deploy tags included), fake-sigstore (test/fake-sigstore) for Sigstore, and a
# mock engine keeps a tunnel to each relay. The relays verify with the real cosign and the production flags; only the
# trusted root, the image repository, the deploy timeout and timer interval and the relay's registry URL differ from
# production (see `install_host`). It checks that:
#
#   - nobody can push a deploy: the user data has no deploy user and no deploy key;
#   - a relay refuses an unsigned image and images signed by another repository, workflow, branch or issuer, or
#     without a timestamp, and keeps running what it ran without even pulling them; and, with Sigstore's real trusted
#     root, refuses a genuine public-good signature from another repository's workflow that verifies under its own
#     identity;
#   - rolling-deploy.sh moves both relays to a new image one at a time by moving their tags, each after the engine's
#     tunnel is back, and watches /healthz report the new image;
#   - a signed image that crashes stops the rollout at the first relay, which rolls back while its tag is moved back,
#     and leaves the second relay untouched (same image, the broken one never pulled);
#   - a signed image that starts but loses the engine is rolled back;
#   - the downgrade guard refuses a signed image built long before the running one, unless it is the previous image
#     (a rollback by digest) or an admin lists it in allow-downgrade; `rollback` and `resume` work for an admin;
#   - it also refuses a signed image without a build time, counts from the newest image a relay ever ran, so two small
#     steps back cannot add up to a large one, and on a rebuilt host, which knows no newest image, holds the
#     PTBK_DEPLOY_MIN_CREATED floor;
#   - an outage (the registry gone from the network, Sigstore's trusted root unavailable) fails the run without
#     remembering the image as refused, and the run after it deploys.
#
# Needs Docker (privileged containers: systemd and Podman run inside), `bun install`, and the built mock engine
# (`bun run --filter @ptbk/mock-engine build`). Run from the repo root. Every key, password and certificate is
# generated for this run and thrown away with it; DEPLOY_TEST_WORK keeps the work directory for a look afterwards.
set -euo pipefail
((BASH_VERSINFO[0] >= 4)) || {
    echo "deploy-test.sh needs bash 4 or later" >&2
    exit 1
}

TOFU_IMAGE=ghcr.io/opentofu/opentofu:1.11.14@sha256:6913ba3b281b0b7d2c2cb286e3aaf64d48c8c113e692218066b1b308fa2a2c8a
NODE_IMAGE=docker.io/library/node:24.22.0-trixie-slim@sha256:a6155384446670e9719bdc4fd0ebe4d4b29fb32a8d6aa523da3547a6cfbcf22c
REGISTRY_IMAGE=docker.io/library/registry:3.0.0@sha256:6c5666b861f3505b116bb9aa9b25175e71210414bd010d92035ff64018f9457e
COSIGN_IMAGE=ghcr.io/sigstore/cosign/cosign:v3.1.3@sha256:9e5c2f2edc34351160407ca3416c61855bdf9403c3c5936e0f0be7fc261611b8
# A real signature on Sigstore's public-good instance from another repository, another (reusable) workflow and a tag,
# with an RFC 3161 timestamp: Flux's source-controller v1.9.6, recorded with the identity it verifies under.
FIXTURE_IMAGE=ghcr.io/fluxcd/source-controller@sha256:6a6693172589f8ff26123a231d5fa6ceb194a6efb4dc647cdf057c959f76a2e3
FIXTURE_IDENTITY=https://github.com/fluxcd/gha-workflows/.github/workflows/controller-release.yaml@refs/tags/v0.11.0
FIXTURE_REPOSITORY=fluxcd/source-controller

RELAYS=(relay-a relay-b)
RELAY_DOMAIN=relays.ptbk.test
ENGINE_DOMAIN=engines.ptbk.test
REGISTRY=registry.ptbk.test
REPOSITORY=$REGISTRY/webgptorg/relay
IDENTITY=https://github.com/webgptorg/app/.github/workflows/release-relay.yml@refs/heads/main

run=ptbk-deploy-test-$$
repo=$(pwd)
work=${DEPLOY_TEST_WORK:-$(mktemp -d)}
mkdir -p "$work"/{images,pki,sigstore,engine}
chmod 700 "$work/engine"

step() { printf '\n== %s\n' "$*"; }
fail() {
    echo "FAIL: $*" >&2
    exit 1
}

cleanup() {
    local status=$?
    if ((status != 0)); then
        for relay in "${RELAYS[@]}"; do
            echo "-- $relay: the deploy's and the relay's journal"
            docker exec "$run-$relay" journalctl --no-pager -n 60 -u ptbk-relay-deploy.service -u ptbk-relay.service \
                2>/dev/null || true
        done
        docker logs --tail 30 "$run-engine" 2>&1 | sed 's/^/engine: /' || true
    fi
    if [[ -n ${DEPLOY_TEST_KEEP:-} ]]; then
        echo "kept the containers and network $run"
        exit "$status"
    fi
    local containers
    containers=$(docker ps -aq --filter "label=ptbk-deploy-test=$run")
    if [[ -n $containers ]]; then
        # shellcheck disable=SC2086 # one ID per word
        docker rm -f -v $containers >/dev/null
    fi
    docker network rm "$run" >/dev/null 2>&1 || true
    if [[ -z ${DEPLOY_TEST_WORK:-} ]]; then rm -rf "$work"; fi
    exit "$status"
}
trap cleanup EXIT

# Runs one of the test's own images on the test network as the calling user, with the work directory mounted.
tool() {
    local image=$1
    shift
    docker run --rm --label "ptbk-deploy-test=$run" --network "$run" --user "$(id -u):$(id -g)" -v "$work:/work" \
        -e SSL_CERT_FILE=/work/pki/ca.crt -e DOCKER_CONFIG=/work/sigstore/docker "$image" "$@"
}
sigstore() { tool ptbk-fake-sigstore:test "$@"; }
on() {
    local relay=$1
    shift
    docker exec -i "$run-$relay" "$@"
}
status_of() { on "$1" /usr/local/sbin/ptbk-relay-deploy status | sed -n "s/^$2 //p"; }
# The runner: what release-relay.yml's deploy job does, from a container on the test network that trusts the test CA,
# with the registry login the job gets and the test's timing.
runner() {
    docker run --rm --label "ptbk-deploy-test=$run" --network "$run" -v "$work:/work:ro" \
        -v "$repo/infra/relay/scripts:/scripts:ro" -e REGISTRY_AUTH_FILE=/work/sigstore/docker/config.json \
        -e "RELAY_IMAGE_REPOSITORY=$REPOSITORY" -e RELAY_DEPLOY_INTERVAL_S=5 -e RELAY_DEPLOY_WINDOW_S=20 \
        -e RELAY_PULL_ALLOWANCE_S=40 --entrypoint bash ptbk-deploy-host:test -c \
        'cp /work/pki/ca.crt /usr/local/share/ca-certificates/ptbk-test.crt && update-ca-certificates >/dev/null 2>&1 &&
         exec "$@"' runner "$@"
}
rollout() { runner /scripts/rolling-deploy.sh "${digest[$1]}" "${RELAYS[@]/%/.$RELAY_DOMAIN}"; }
# Moves a relay's deploy tag by hand, as whoever can push to the registry could, and runs its deploy at once instead
# of waiting for the timer. The timer may have run it already, so callers judge by the outcome, not the exit status.
point() {
    local relay=$1 image=$2
    runner skopeo copy --quiet --all --preserve-digests "docker://$image" "docker://$REPOSITORY:deploy-$relay.$RELAY_DOMAIN"
    on "$relay" systemctl start ptbk-relay-deploy.service 2>/dev/null || true
}
point_to() { point "$1" "$REPOSITORY@${digest[$2]}"; }
journal_has() { on "$1" journalctl --no-pager -o cat -u ptbk-relay-deploy.service | grep -F -- "$2"; }
expect_current() {
    local relay=$1 variant=$2 current
    current=$(status_of "$relay" current)
    [[ $current == "$REPOSITORY@${digest[$variant]}" ]] || fail "$relay runs ${current:-nothing}, expected $variant"
    echo "$relay runs $variant"
}
wait_engine() {
    local relay=$1
    for _ in $(seq 60); do
        if (($(status_of "$relay" engines) >= 1)); then
            echo "the engine is connected to $relay"
            return
        fi
        sleep 1
    done
    fail "the engine did not connect to $relay"
}

step "images: test host, fake-sigstore, the relay (apps/relay/Dockerfile) and its test variants"
docker build --quiet --tag ptbk-deploy-host:test --file infra/relay/test/host.Containerfile infra/relay/test >/dev/null
docker build --quiet --tag ptbk-fake-sigstore:test --file infra/relay/test/fake-sigstore/Containerfile \
    infra/relay/test/fake-sigstore >/dev/null
docker build --quiet --tag ptbk-relay:test --file apps/relay/Dockerfile . >/dev/null
# Each variant has its own digest. broken-crash exits at once; broken-tunnels starts and answers /healthz but cannot
# reach the registry, so no engine gets a tunnel.
declare -A variant_lines=(
    [good-1]=''
    [good-2]=''
    [broken-crash]='ENTRYPOINT ["node", "-e", "process.exit(1)"]'
    [broken-tunnels]='ENTRYPOINT ["sh", "-c", "RELAY_REGISTRY_URL=http://127.0.0.1:9 exec node /app/main.mjs"]'
    [unsigned]=''
    [other-repository]=''
    [other-workflow]=''
    [other-branch]=''
    [other-issuer]=''
    [no-timestamp]=''
    [old]=''
    [no-created]=''
    [back-1]=''
    [back-2]=''
)
# Build times, as the downgrade guard sees them: good-1 is 40 days older than good-2, old 60 days. back-2 is 25 days
# older than back-1, but 45 days older than good-2. no-created has none.
declare -A age_days=([good-1]=40 [old]=60 [back-1]=20 [back-2]=45)
for variant in "${!variant_lines[@]}"; do
    printf 'FROM ptbk-relay:test\nLABEL org.ptbk.deploy-test.variant=%s\n%s\n' "$variant" "${variant_lines[$variant]}" |
        docker build --quiet --tag "ptbk-relay-test:$variant" - >/dev/null
    docker save --output "$work/images/$variant.tar" "ptbk-relay-test:$variant"
done

step "keys, certificates and the registry's pull account"
ssh-keygen -q -t ed25519 -N '' -C deploy-test-admin -f "$work/admin"
tool_pki() {
    docker run --rm --user "$(id -u):$(id -g)" -v "$work/pki:/pki" -w /pki --entrypoint bash ptbk-deploy-host:test -c "$1"
}
tool_pki 'openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 2 -subj /CN=ptbk-deploy-test-ca \
    -addext basicConstraints=critical,CA:TRUE -addext keyUsage=critical,keyCertSign -keyout ca.key -out ca.crt 2>/dev/null'
for name in "$REGISTRY" "${RELAYS[@]/%/.$RELAY_DOMAIN}"; do
    tool_pki "openssl req -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -subj /CN=$name -keyout $name.key \
        -out $name.csr 2>/dev/null && printf 'subjectAltName=DNS:%s\nextendedKeyUsage=serverAuth\n' $name >$name.ext &&
        openssl x509 -req -in $name.csr -CA ca.crt -CAkey ca.key -CAcreateserial -days 2 -extfile $name.ext \
        -out $name.crt 2>/dev/null && chmod 0644 $name.key"
done
pull_password=$(openssl rand -hex 24)
mkdir -p "$work/sigstore/docker"
printf '{"auths":{"%s":{"auth":"%s"}}}\n' "$REGISTRY" "$(printf 'deploy-test:%s' "$pull_password" | base64 | tr -d '\n')" \
    >"$work/sigstore/docker/config.json"

step "network, registry and fake Sigstore"
docker network create --label "ptbk-deploy-test=$run" "$run" >/dev/null
docker run --rm --entrypoint /usr/local/bin/fake-sigstore ptbk-fake-sigstore:test htpasswd -user deploy-test \
    -password "$pull_password" >"$work/pki/htpasswd"
docker run -d --label "ptbk-deploy-test=$run" --name "$run-registry" --network "$run" --network-alias "$REGISTRY" \
    -v "$work/pki:/pki:ro" -e REGISTRY_HTTP_ADDR=:443 -e "REGISTRY_HTTP_TLS_CERTIFICATE=/pki/$REGISTRY.crt" \
    -e "REGISTRY_HTTP_TLS_KEY=/pki/$REGISTRY.key" -e REGISTRY_AUTH=htpasswd -e REGISTRY_AUTH_HTPASSWD_REALM=test \
    -e REGISTRY_AUTH_HTPASSWD_PATH=/pki/htpasswd "$REGISTRY_IMAGE" >/dev/null
sigstore init -dir /work/sigstore
declare -A digest
for variant in "${!variant_lines[@]}"; do
    push_flags=(-age-days "${age_days[$variant]:-0}")
    if [[ $variant == no-created ]]; then push_flags+=(-no-created); fi
    for _ in $(seq 10); do
        if digest[$variant]=$(sigstore push -archive "/work/images/$variant.tar" -ref "$REPOSITORY:$variant" \
            "${push_flags[@]}" 2>/dev/null); then
            break
        fi
        sleep 1
    done
    [[ ${digest[$variant]:-} =~ ^sha256:[0-9a-f]{64}$ ]] || fail "could not push $variant"
done
for variant in good-1 good-2 broken-crash broken-tunnels old no-created back-1 back-2; do
    sigstore sign -dir /work/sigstore -image "$REPOSITORY@${digest[$variant]}"
done
sigstore sign -dir /work/sigstore -image "$REPOSITORY@${digest[other-repository]}" -repository someone-else/app
sigstore sign -dir /work/sigstore -image "$REPOSITORY@${digest[other-workflow]}" -workflow .github/workflows/ci.yml
sigstore sign -dir /work/sigstore -image "$REPOSITORY@${digest[other-branch]}" -ref refs/heads/feature
sigstore sign -dir /work/sigstore -image "$REPOSITORY@${digest[other-issuer]}" -issuer https://token.example.test
sigstore sign -dir /work/sigstore -image "$REPOSITORY@${digest[no-timestamp]}" -no-timestamp

step "the mock engine's identity and registry entry"
(cd apps/mock-engine && PTBK_DATA_DIR="$work/engine" PTBK_ENGINE_DOMAIN=$ENGINE_DOMAIN bun run --silent identity) \
    >"$work/identity.json"
engine_id=$(node -p "require('$work/identity.json').engineId")
node -e "const i = require('$work/identity.json');
    process.stdout.write(JSON.stringify({ enginePublicKey: i.enginePublicKey, hostnames: [i.hostname], claims: [],
        status: 'active' }))" >"$work/registry-entry.json"

step "user data for each relay (test/render)"
tofu() {
    docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp -e TF_IN_AUTOMATION=1 -v "$repo/infra:/infra:ro" \
        -v "$work:/work" -e TF_DATA_DIR=/work/.terraform -w /infra/relay/test/render "$TOFU_IMAGE" "$@" -no-color
}
tofu init -backend=false -input=false -lockfile=readonly >/dev/null
for relay in "${RELAYS[@]}"; do
    tofu apply -auto-approve -input=false -state="/work/render-$relay.tfstate" -var "name=$relay" \
        -var "admin_key=$(cat "$work/admin.pub")" >/dev/null
    tofu output -state="/work/render-$relay.tfstate" -raw user_data >"$work/user-data-$relay"
done

# What cloud-init would do on first boot, minus what a container cannot or need not do (kernel modules, sysctl,
# nftables, unbound, chrony, sshd, the certificate timer), then the test's own settings and secrets.
install_host() {
    local relay=$1
    on "$relay" bash -s "$relay" "$engine_id" <<'HOST'
set -euo pipefail
relay=$1 engine_id=$2
# On a host, systemd makes / a shared mount; Docker starts the container's mounts private, which would hide the
# credential mounts systemd sets up for LoadCredential.
mount --make-rshared /
python3 - "/test/user-data-$relay" <<'PY'
import os, subprocess, sys, yaml

with open(sys.argv[1]) as f:
    config = yaml.safe_load(f)
for entry in config["write_files"]:
    os.makedirs(os.path.dirname(entry["path"]), exist_ok=True)
    with open(entry["path"], "w") as out:
        out.write(entry["content"])
    os.chmod(entry["path"], int(entry["permissions"], 8))
# Admins log in over SSH, which the test does not use; anyone else with a key would be a way to push a deploy.
users = [user for user in config["users"] if "ssh_authorized_keys" not in user]
assert all(user["name"] != "ptbk-deploy" for user in config["users"]), "the user data has a deploy user"
assert not any("sudoers" in entry["path"] for entry in config["write_files"]), "the user data writes a sudoers rule"
for user in users:
    subprocess.run(["useradd", "--system", "--uid", str(user["uid"]), "--no-create-home", "--shell", user["shell"],
                    user["name"]], check=True)
PY
install -d -m 0700 -o root -g root /etc/ptbk-relay/credentials
/usr/local/libexec/ptbk-relay/install-cosign

sed -i 's|^RELAY_REGISTRY_URL=.*|RELAY_REGISTRY_URL=http://127.0.0.1:8080|' /etc/ptbk-relay/relay.env
sed -i -e 's|^PTBK_DEPLOY_IMAGE_REPOSITORY=.*|PTBK_DEPLOY_IMAGE_REPOSITORY=registry.ptbk.test/webgptorg/relay|' \
    -e 's|^PTBK_DEPLOY_TRUSTED_ROOT=.*|PTBK_DEPLOY_TRUSTED_ROOT=/etc/ptbk-relay/test-trusted-root.json|' \
    -e 's|^PTBK_DEPLOY_TIMEOUT_S=.*|PTBK_DEPLOY_TIMEOUT_S=20|' /etc/ptbk-relay/deploy.env
# The timer every 5 s instead of every minute.
install -D -m 0644 /dev/stdin /etc/systemd/system/ptbk-relay-deploy.timer.d/test.conf <<'UNIT'
[Timer]
OnBootSec=5s
OnUnitInactiveSec=5s
AccuracySec=1s
UNIT
install -m 0644 /test/sigstore/trusted_root.json /etc/ptbk-relay/test-trusted-root.json
install -m 0644 /test/pki/ca.crt /usr/local/share/ca-certificates/ptbk-deploy-test.crt
update-ca-certificates >/dev/null 2>&1

install -m 0600 "/test/pki/$relay.relays.ptbk.test.crt" /etc/ptbk-relay/credentials/tls.crt
install -m 0600 "/test/pki/$relay.relays.ptbk.test.key" /etc/ptbk-relay/credentials/tls.key
printf 'ptbk_rt_%s\n' "$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=')" |
    install -m 0600 /dev/stdin /etc/ptbk-relay/credentials/registry-token
printf 'deploy-test:%s\n' "$(cat /test/pull-password)" | install -m 0600 /dev/stdin /etc/ptbk-relay/credentials/registry-auth
# The metrics token (I-04): the deploy reads the relay's tunnel gauge with it.
printf 'ptbk_mt_%s\n' "$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=')" |
    install -m 0600 /dev/stdin /etc/ptbk-relay/credentials/metrics-token

# The dashboard's registry API, as far as the relay asks it: one engine, over HTTP on loopback.
install -D -m 0644 /test/registry-entry.json "/srv/registry/internal/v1/engines/$engine_id"
cat >/etc/systemd/system/ptbk-test-registry.service <<'UNIT'
[Service]
ExecStart=/usr/bin/python3 -m http.server 8080 --bind 127.0.0.1 --directory /srv/registry
UNIT

systemctl daemon-reload
systemctl enable --quiet ptbk-relay.service ptbk-relay-deploy.timer
systemctl start ptbk-test-registry.service ptbk-relay-deploy.timer
HOST
}

step "relay hosts"
printf '%s' "$pull_password" >"$work/pull-password"
for relay in "${RELAYS[@]}"; do
    docker run -d --label "ptbk-deploy-test=$run" --name "$run-$relay" --hostname "$relay" --network "$run" \
        --network-alias "$relay.$RELAY_DOMAIN" --privileged --cgroupns=private \
        --sysctl net.ipv6.conf.all.disable_ipv6=0 -v /var/lib/containers -v "$work:/test:ro" \
        ptbk-deploy-host:test >/dev/null
    # shellcheck disable=SC2016 # runs in the container
    on "$relay" bash -c 'until systemctl is-system-running --wait >/dev/null 2>&1 || \
        [[ $(systemctl is-system-running) == degraded ]]; do sleep 1; done'
    install_host "$relay"
    echo "$relay is up: $(on "$relay" cosign version 2>&1 | sed -n 's/^GitVersion: *//p')"
done

step "the mock engine, dialling both relays"
docker run -d --label "ptbk-deploy-test=$run" --name "$run-engine" --network "$run" --user "$(id -u):$(id -g)" \
    -v "$repo/apps/mock-engine/dist:/app:ro" -v "$work/engine:/data" -v "$work/pki/ca.crt:/ca.crt:ro" \
    -e PTBK_DATA_DIR=/data -e PTBK_ENGINE_DOMAIN=$ENGINE_DOMAIN -e MOCK_EXTRA_CA_FILE=/ca.crt -e MOCK_SEED=1 \
    -e "PTBK_RELAYS=wss://relay-a.$RELAY_DOMAIN,wss://relay-b.$RELAY_DOMAIN" "$NODE_IMAGE" node /app/main.mjs >/dev/null

step "first rollout: good-1 to both relays, one tag at a time"
rollout good-1
for relay in "${RELAYS[@]}"; do
    expect_current "$relay" good-1
    wait_engine "$relay"
done

# The deploy counts engines with the relay's tunnel gauge (I-04's /metrics and the host's metrics token).
# shellcheck disable=SC2016 # runs on the relay
gauge=$(on relay-a bash -c 'printf "header = \"Authorization: Bearer %s\"\n" "$(tr -d "\n" </etc/ptbk-relay/credentials/metrics-token)" |
    curl -fsS -K - --resolve relay-a.relays.ptbk.test:443:127.0.0.1 https://relay-a.relays.ptbk.test/metrics' |
    grep '^ptbk_relay_tunnels_active ') || fail "relay-a has no tunnel gauge"
echo "relay-a: $gauge"

step "second rollout: good-2, each relay waits for the engine to come back"
rollout good-2
for relay in "${RELAYS[@]}"; do
    expect_current "$relay" good-2
    [[ $(status_of "$relay" previous) == "$REPOSITORY@${digest[good-1]}" ]] || fail "$relay lost its previous image"
    journal_has "$relay" 'engines connected (1 of 1 needed)' >/dev/null || fail "$relay did not wait for its engine"
    wait_engine "$relay"
done
echo "both relays waited for their engine: $(journal_has relay-b 'engines connected (1 of 1 needed)' | tail -n 1)"

step "refused: unsigned, other repository, workflow, branch or issuer, no timestamp"
for variant in unsigned other-repository other-workflow other-branch other-issuer no-timestamp; do
    point_to relay-a "$variant"
    journal_has relay-a "refused: $REPOSITORY@${digest[$variant]} has no valid signature from $IDENTITY" >/dev/null ||
        fail "relay-a did not refuse $variant"
    expect_current relay-a good-2 >/dev/null
    if on relay-a podman image exists "$REPOSITORY@${digest[$variant]}"; then fail "relay-a pulled $variant"; fi
    echo "refused $variant: $(journal_has relay-a 'cosign: Error' | tail -n 1 | cut -c1-200)"
done
[[ $(status_of relay-a refused) == "${digest[no-timestamp]}" ]] || fail "relay-a did not remember the refusal"
point_to relay-a good-2
expect_current relay-a good-2

step "refused with Sigstore's real trusted root: a genuine signature from another repository, workflow and tag"
tool_pki 'cat /etc/ssl/certs/ca-certificates.crt ca.crt >bundle.crt'
docker run --rm --label "ptbk-deploy-test=$run" --network "$run" --user "$(id -u):$(id -g)" -v "$work:/work" \
    -e HOME=/tmp -e SSL_CERT_FILE=/work/pki/bundle.crt -e DOCKER_CONFIG=/work/sigstore/docker "$COSIGN_IMAGE" \
    copy --force "$FIXTURE_IMAGE" "$REPOSITORY:public-good-fixture" >/dev/null 2>&1
fixture=$REPOSITORY@${FIXTURE_IMAGE##*@}
on relay-b sed -i 's|^PTBK_DEPLOY_TRUSTED_ROOT=.*|PTBK_DEPLOY_TRUSTED_ROOT=|' /etc/ptbk-relay/deploy.env
point relay-b "$fixture"
journal_has relay-b "refused: $fixture has no valid signature from $IDENTITY" >/dev/null || fail "no refusal"
expect_current relay-b good-2
echo "refused the fixture: $(journal_has relay-b 'cosign: Error' | tail -n 1 | cut -c1-200)"
# The same cosign on the same host accepts it under its own identity, so the refusal is the identity, not the bundle.
# shellcheck disable=SC2016 # runs on the relay
on relay-b bash -c 'mkdir -p /run/fixture/docker && printf "{\"auths\":{\"%s\":{\"auth\":\"%s\"}}}" "$1" \
    "$(tr -d "\n" </etc/ptbk-relay/credentials/registry-auth | base64 -w0)" >/run/fixture/docker/config.json &&
    HOME=/run/fixture DOCKER_CONFIG=/run/fixture/docker cosign verify --certificate-identity "$2" \
    --certificate-oidc-issuer https://token.actions.githubusercontent.com --certificate-github-workflow-repository "$3" \
    --use-signed-timestamps "$4" >/dev/null 2>&1' fixture "$REGISTRY" "$FIXTURE_IDENTITY" "$FIXTURE_REPOSITORY" "$fixture" ||
    fail "the fixture does not verify under its own identity"
echo "the fixture verifies as $FIXTURE_IDENTITY"
on relay-b sed -i 's|^PTBK_DEPLOY_TRUSTED_ROOT=.*|PTBK_DEPLOY_TRUSTED_ROOT=/etc/ptbk-relay/test-trusted-root.json|' \
    /etc/ptbk-relay/deploy.env
point_to relay-b good-2
expect_current relay-b good-2

step "a signed image that crashes: the rollout stops at relay-a, which rolls back; relay-b is untouched"
if rollout broken-crash >"$work/rollout-broken.log" 2>&1; then
    cat "$work/rollout-broken.log"
    fail "the rollout of a crashing image succeeded"
fi
cat "$work/rollout-broken.log"
grep -q "moved $REPOSITORY:deploy-relay-a.$RELAY_DOMAIN back to ${digest[good-2]}" "$work/rollout-broken.log" ||
    fail "the rollout did not move relay-a's tag back"
journal_has relay-a "deploy of $REPOSITORY@${digest[broken-crash]} failed; rolled back to" || fail "no rollback"
expect_current relay-a good-2
expect_current relay-b good-2
if on relay-b podman image exists "$REPOSITORY@${digest[broken-crash]}"; then fail "relay-b pulled the broken image"; fi
echo "relay-b never pulled the broken image"
wait_engine relay-a

step "a signed image that loses the engine is rolled back"
point_to relay-a broken-tunnels
journal_has relay-a '0 engines connected (1 of 1 needed)' || fail "the tunnel check did not fail"
journal_has relay-a "deploy of $REPOSITORY@${digest[broken-tunnels]} failed; rolled back to" || fail "no rollback"
expect_current relay-a good-2
point_to relay-a good-2
wait_engine relay-a

step "downgrade guard: back to the previous image by digest is allowed, an older one only when an admin lists it"
rollout good-1
expect_current relay-a good-1
expect_current relay-b good-1
rollout good-2
point_to relay-a old
journal_has relay-a "refused: $REPOSITORY@${digest[old]} was built" || fail "the downgrade guard did not refuse"
expect_current relay-a good-2
on relay-a sh -c "echo ${digest[old]} >/etc/ptbk-relay/allow-downgrade"
on relay-a /usr/local/sbin/ptbk-relay-deploy resume
on relay-a systemctl start ptbk-relay-deploy.service
expect_current relay-a old
point_to relay-a good-2
expect_current relay-a good-2

step "an admin's emergency rollback holds until resume"
on relay-b /usr/local/sbin/ptbk-relay-deploy rollback
expect_current relay-b good-1
on relay-b systemctl start ptbk-relay-deploy.service
expect_current relay-b good-1
on relay-b /usr/local/sbin/ptbk-relay-deploy resume
on relay-b systemctl start ptbk-relay-deploy.service
expect_current relay-b good-2

step "downgrade guard: a signed image without a build time is refused"
point_to relay-a no-created
journal_has relay-a "refused: $REPOSITORY@${digest[no-created]} has no build time" || fail "no refusal"
expect_current relay-a good-2
[[ $(status_of relay-a refused) == "${digest[no-created]}" ]] || fail "relay-a did not remember the refusal"
if on relay-a podman image exists "$REPOSITORY@${digest[no-created]}"; then fail "relay-a pulled no-created"; fi

step "downgrade guard: counted from the newest image ever run, so two small steps back cannot add up"
on relay-a rm /etc/ptbk-relay/allow-downgrade
point_to relay-a back-1
expect_current relay-a back-1
echo "high-water mark: $(status_of relay-a high-water)"
# 25 days before the running back-1, which a guard counting from the running image would let through.
point_to relay-a back-2
journal_has relay-a "refused: $REPOSITORY@${digest[back-2]} was built" || fail "the high-water mark did not refuse"
expect_current relay-a back-1
point_to relay-a good-2
expect_current relay-a good-2

step "downgrade guard: a rebuilt host, which knows no newest image, holds PTBK_DEPLOY_MIN_CREATED"
on relay-b rm -f /var/lib/ptbk-relay-deploy/high-water /var/lib/ptbk-relay-deploy/previous-image
# shellcheck disable=SC2016 # runs on the relay, whose date (unlike macOS's) takes -d
on relay-b bash -c 'sed -i "s|^PTBK_DEPLOY_MIN_CREATED=.*|PTBK_DEPLOY_MIN_CREATED=$(date -u -d "-50 days" +%F)|" \
    /etc/ptbk-relay/deploy.env && grep "^PTBK_DEPLOY_MIN_CREATED=" /etc/ptbk-relay/deploy.env'
point_to relay-b old
journal_has relay-b "refused: $REPOSITORY@${digest[old]} was built" || fail "the floor did not refuse"
expect_current relay-b good-2
# good-1 is 40 days old: above the floor, and with no high-water mark nothing else holds it back.
point_to relay-b good-1
expect_current relay-b good-1

step "an outage is not a refusal: the run fails, nothing is remembered, the next run deploys"
on relay-a systemctl stop ptbk-relay-deploy.timer
# Waits for a run the timer may have started; the tag still names what runs, so it does nothing.
on relay-a systemctl start ptbk-relay-deploy.service
runner skopeo copy --quiet --all --preserve-digests "docker://$REPOSITORY@${digest[back-1]}" \
    "docker://$REPOSITORY:deploy-relay-a.$RELAY_DOMAIN"
docker network disconnect "$run" "$run-registry"
if on relay-a systemctl start ptbk-relay-deploy.service 2>/dev/null; then fail "the run passed without the registry"; fi
journal_has relay-a "cannot read $REPOSITORY:deploy-relay-a.$RELAY_DOMAIN, trying again next time" ||
    fail "the registry outage was not reported"
docker network connect --alias "$REGISTRY" "$run" "$run-registry"
on relay-a mv /etc/ptbk-relay/test-trusted-root.json /etc/ptbk-relay/test-trusted-root.json.away
if on relay-a systemctl start ptbk-relay-deploy.service 2>/dev/null; then fail "the run passed without Sigstore"; fi
journal_has relay-a "could not verify $REPOSITORY@${digest[back-1]}, trying again next time" ||
    fail "the Sigstore outage was not reported"
[[ -z $(status_of relay-a refused) ]] || fail "relay-a remembered an outage as a refusal"
expect_current relay-a good-2
on relay-a mv /etc/ptbk-relay/test-trusted-root.json.away /etc/ptbk-relay/test-trusted-root.json
on relay-a systemctl start ptbk-relay-deploy.service
expect_current relay-a back-1
on relay-a systemctl start ptbk-relay-deploy.timer

printf '\nThe deploy test passed.\n'
