#!/bin/bash
# =========================================================
# Restore check - Mahesh Foundation MES
# Restores a backup into a throwaway database, compares row
# counts with the live database, then drops the throwaway copy.
#
# Usage (as root on the VM):
#   verify-restore.sh                 # newest local backup
#   verify-restore.sh /path/file.sql.gz
# =========================================================

set -euo pipefail

DB_NAME="${DB_NAME:-mahesh_meds}"
TEST_DB="${DB_NAME}_restore_check"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/mahesh-meds}"

backup="${1:-$(ls -1t "$BACKUP_DIR"/"${DB_NAME}"_*.sql.gz | head -n 1)}"
echo "restoring ${backup} into ${TEST_DB}"

mariadb -e "DROP DATABASE IF EXISTS \`${TEST_DB}\`; CREATE DATABASE \`${TEST_DB}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
trap 'mariadb -e "DROP DATABASE IF EXISTS \`${TEST_DB}\`"' EXIT
zcat "$backup" | mariadb "$TEST_DB"

# Tables like audit_log keep growing after the dump, so live >= restored is expected;
# an empty restored table that has rows live means the backup is broken.
failed=0
printf '%-20s %8s %8s\n' table live restored
for table in $(mariadb -N -e "SELECT table_name FROM information_schema.tables WHERE table_schema='${DB_NAME}' AND table_type='BASE TABLE' ORDER BY table_name"); do
    live="$(mariadb -N -e "SELECT COUNT(*) FROM \`${DB_NAME}\`.\`${table}\`")"
    restored="$(mariadb -N -e "SELECT COUNT(*) FROM \`${TEST_DB}\`.\`${table}\`" 2>/dev/null || echo missing)"
    note=""
    if [ "$restored" = "missing" ] || { [ "$restored" -eq 0 ] && [ "$live" -gt 0 ]; }; then
        note="  <-- PROBLEM"
        failed=1
    elif [ "$restored" != "$live" ]; then
        note="  (changed since dump)"
    fi
    printf '%-20s %8s %8s%s\n' "$table" "$live" "$restored" "$note"
done
mariadb -N -e "SELECT CONCAT('view sku_stock_by_center rows: ', COUNT(*)) FROM \`${TEST_DB}\`.sku_stock_by_center"

if [ "$failed" -ne 0 ]; then
    echo "RESTORE CHECK FAILED" >&2
    exit 1
fi
echo "restore check ok"
