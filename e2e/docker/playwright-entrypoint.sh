#!/bin/sh
# Chromium on Linux trusts the roots in the user's NSS database; add the stack's fresh dev CA there, then run.
set -eu
nssdb="sql:${HOME}/.pki/nssdb"
mkdir -p "${HOME}/.pki/nssdb"
certutil -N -d "${nssdb}" --empty-password
certutil -A -d "${nssdb}" -n ptbk-e2e-dev-ca -t C,, -i /pki/ca-cert.pem
exec "$@"
