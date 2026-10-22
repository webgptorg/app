# A relay image for the VM test only (vm-test.sh): the built bundle on Node, as uid 10001. The signed production
# image comes from I-03's release-relay.yml; the host treats both the same way.
FROM docker.io/library/node:24.22.0-trixie-slim@sha256:a6155384446670e9719bdc4fd0ebe4d4b29fb32a8d6aa523da3547a6cfbcf22c

COPY apps/relay/dist/main.mjs /app/main.mjs
USER 10001:10001
ENTRYPOINT ["node", "/app/main.mjs"]
