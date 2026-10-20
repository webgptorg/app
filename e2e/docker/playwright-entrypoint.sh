#!/bin/sh
# Chromium on Linux trusts the roots in the user's NSS database: add the stack's fresh dev CA to pwuser's, then run.
set -eu
if [ "$(id -u)" = 0 ]; then
    echo "playwright-entrypoint: refusing to run as root; the service runs as pwuser" >&2
    exit 1
fi
nssdir="${HOME}/.pki/nssdb"
mkdir -p "${nssdir}"
certutil -N -d "sql:${nssdir}" --empty-password
certutil -A -d "sql:${nssdir}" -n ptbk-e2e-dev-ca -t C,, -i /pki/ca-cert.pem
exec "$@"
