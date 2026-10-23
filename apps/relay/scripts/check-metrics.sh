#!/bin/sh
# `promtool check metrics` over what GET /metrics really answers (I-04): test/metrics.test.ts scrapes a relay that has
# routed a browser connection and writes the body to a file, which promtool lints in a pinned container. Needs Docker.
set -eu

PROMETHEUS_IMAGE=prom/prometheus:v3.5.0@sha256:63805ebb8d2b3920190daf1cb14a60871b16fd38bed42b857a3182bc621f4996

relay=$(cd "$(dirname "$0")/.." && pwd)
sample=$(mktemp)
trap 'rm -f "$sample"' EXIT

(cd "$relay" && RELAY_METRICS_SAMPLE="$sample" bun x vitest run test/metrics.test.ts)
test -s "$sample"
docker run --rm -i --network=none --entrypoint promtool "$PROMETHEUS_IMAGE" check metrics <"$sample"
echo "promtool: $(grep -c '^ptbk_relay_' "$sample") samples pass"
