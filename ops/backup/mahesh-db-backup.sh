#!/bin/bash
# =========================================================
# Nightly MariaDB backup - Mahesh Foundation MES
# Dump -> verify -> keep locally -> upload to Cloud Storage.
#
# Installed as /usr/local/sbin/mahesh-db-backup and run as root
# by mahesh-db-backup.timer (02:00 IST).
#
# Root logs in to MariaDB over the local socket, so no database
# password is stored here. Uploads use the VM's service account
# (mes-vm-runtime), which can create objects in the bucket but
# cannot read, overwrite or delete them.
# =========================================================

set -euo pipefail

DB_NAME="${DB_NAME:-mahesh_meds}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/mahesh-meds}"
BUCKET="${BACKUP_BUCKET:-mf-medical-equipment-seva-db-backups}"
KEEP_LOCAL="${KEEP_LOCAL:-7}"
METADATA_URL="http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token"

umask 077
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

stamp="$(TZ=Asia/Kolkata date +%Y%m%d_%H%M%S)IST"
name="${DB_NAME}_${stamp}.sql.gz"
partial="${BACKUP_DIR}/.${name}.partial"
final="${BACKUP_DIR}/${name}"
trap 'rm -f "$partial"' EXIT

# Upload a file as a new object; refuses to overwrite and checks the MD5 GCS reports back.
upload() {
    local file="$1" object="$2" token response remote_md5 local_md5
    token="$(curl -sS --fail -H 'Metadata-Flavor: Google' "$METADATA_URL" |
        python3 -c 'import json, sys; print(json.load(sys.stdin)["access_token"])')"
    if ! response="$(curl -sS --fail-with-body -X POST \
        -H "Authorization: Bearer ${token}" \
        -H 'Content-Type: application/gzip' \
        --data-binary @"$file" \
        "https://storage.googleapis.com/upload/storage/v1/b/${BUCKET}/o?uploadType=media&ifGenerationMatch=0&name=${object//\//%2F}")"; then
        echo "upload of ${object} failed: ${response}" >&2
        return 1
    fi
    remote_md5="$(printf '%s' "$response" | python3 -c 'import json, sys; print(json.load(sys.stdin)["md5Hash"])')"
    local_md5="$(python3 -c 'import base64, hashlib, sys; print(base64.b64encode(hashlib.md5(open(sys.argv[1], "rb").read()).digest()).decode())' "$file")"
    if [ "$remote_md5" != "$local_md5" ]; then
        echo "checksum mismatch for ${object} (local ${local_md5}, remote ${remote_md5})" >&2
        return 1
    fi
    echo "uploaded gs://${BUCKET}/${object} (md5 ${remote_md5})"
}

# --single-transaction gives a consistent InnoDB snapshot without locking the app.
mariadb-dump --single-transaction --quick --routines --triggers --events \
    --hex-blob --default-character-set=utf8mb4 "$DB_NAME" | gzip -9 > "$partial"

gzip -t "$partial"
if ! zcat "$partial" | tail -n 1 | grep -q '^-- Dump completed'; then
    echo "dump is incomplete: missing '-- Dump completed' trailer" >&2
    exit 1
fi
mv "$partial" "$final"

upload "$final" "daily/${name}"
if [ "$(TZ=Asia/Kolkata date +%d)" = "01" ]; then
    upload "$final" "monthly/${name}"
fi

# The bucket keeps the long-term history; only the newest copies stay on the VM.
ls -1t "$BACKUP_DIR"/"${DB_NAME}"_*.sql.gz | tail -n +"$((KEEP_LOCAL + 1))" | xargs -r rm -f --

echo "backup ok: ${name} ($(stat -c %s "$final") bytes)"
