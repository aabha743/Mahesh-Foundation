# Deploy a release bundle (run with -Sudo after preflight passes). Needs:
#   RELEASE        full commit sha (from build-release.sh)
#   BUNDLE_SHA256  bundle checksum (from build-release.sh)
#   PREV           label for this deploy's rollback copies, normally the tag of the release being replaced
#   MARK_APPLIED   optional, comma-separated migration files applied by hand earlier, recorded without running
#
# Steps: verify bundle -> database backup -> rollback copy of API and frontend -> sync API tree ->
# migrations -> restart + health check -> frontend swap -> record what is installed.
# Stops at the first error. A failed migration or health check puts the previous API files back.
set -euo pipefail
: "${RELEASE:?set RELEASE}" "${BUNDLE_SHA256:?set BUNDLE_SHA256}" "${PREV:?set PREV}"
SHORT="${RELEASE:0:7}"
BUNDLE="$DEPLOY_DIR/release-$SHORT.tar.gz"
REL="$DEPLOY_DIR/release-$SHORT"
API_PREV="$API.prev-$PREV"
WEB_PREV="$WEB.prev-$PREV"
SYNC_EXCLUDES=(--exclude '/.venv/' --exclude '/.env' --exclude '/.env.*' --exclude '__pycache__/')

restore_api() {
    echo "restoring the previous API files from $API_PREV" >&2
    rsync -a --delete "${SYNC_EXCLUDES[@]}" "$API_PREV/" "$API/"
}

step "1/7 unpack and verify release $SHORT"
[ "$(sum "$BUNDLE")" = "$BUNDLE_SHA256" ] || { echo "bundle checksum mismatch" >&2; exit 1; }
[ ! -e "$API_PREV" ] && [ ! -e "$WEB_PREV" ] || { echo "rollback copies for $PREV already exist; pick another PREV" >&2; exit 1; }
rm -rf "$REL" && mkdir -p "$REL"
tar -xzf "$BUNDLE" -C "$REL"
[ "$(cat "$REL/RELEASE")" = "$RELEASE" ] || { echo "bundle is not $RELEASE" >&2; exit 1; }
(cd "$REL" && sha256sum --quiet -c release.sha256) || { echo "files do not match release.sha256" >&2; exit 1; }
echo "all $(wc -l < "$REL/release.sha256") files match release.sha256"
cmp -s "$REL/mahesh-meds-api/requirements.txt" "$API/requirements.txt" \
    || { echo "requirements.txt changed: install the new packages first (see README)" >&2; exit 1; }
find "$REL/mahesh-meds-api/app" -name '*.py' -print0 | xargs -0 "$API/.venv/bin/python" -m py_compile
find "$REL/mahesh-meds-api" -name __pycache__ -type d -prune -exec rm -rf {} +
echo "API code compiles on Python $("$API/.venv/bin/python" -V 2>&1 | cut -d' ' -f2)"

step "2/7 database backup"
systemctl start mahesh-db-backup.service
[ "$(systemctl show mahesh-db-backup.service -p Result --value)" = "success" ] || { echo "backup failed" >&2; exit 1; }
journalctl -u mahesh-db-backup.service -n 4 -o cat --no-pager | grep -E 'uploaded|backup ok' || true

step "3/7 rollback copies"
rsync -a "${SYNC_EXCLUDES[@]}" "$API/" "$API_PREV/"
cp -a "$WEB" "$WEB_PREV"
echo "$API_PREV and $WEB_PREV"

step "4/7 API files"
rsync -a --delete --chown=www-data:www-data "${SYNC_EXCLUDES[@]}" --itemize-changes "$REL/mahesh-meds-api/" "$API/" \
    > "$REL/sync.log"
echo "$(grep -c '^>f' "$REL/sync.log" || true) files written, $(grep -c '^\*deleting' "$REL/sync.log" || true) removed:"
grep -E '^(>f|\*deleting)' "$REL/sync.log" | sed 's/^/  /' | head -80 || true

step "5/7 migrations"
if [ -n "${MARK_APPLIED:-}" ]; then
    for name in ${MARK_APPLIED//,/ }; do
        as_app -m app.migrate mark-applied "$name" || { restore_api; exit 1; }
    done
fi
if ! as_app -m app.migrate apply; then
    echo "MIGRATION FAILED - the API was not restarted and still runs the previous code" >&2
    restore_api
    exit 1
fi

step "6/7 restart API"
systemctl restart mahesh-meds-api
if healthy; then
    echo "API healthy after restart"
else
    echo "API UNHEALTHY after restart" >&2
    restore_api
    systemctl restart mahesh-meds-api
    healthy && echo "rolled back; API healthy on previous code" >&2
    journalctl -u mahesh-meds-api -n 30 --no-pager >&2
    exit 1
fi

step "7/7 frontend swap"
rm -rf "$WEB.new" && mkdir "$WEB.new"
cp -r "$REL/mahesh-meds-manager/dist/." "$WEB.new/"
chown -R www-data:www-data "$WEB.new" && chmod -R u=rwX,go=rX "$WEB.new"
rm -rf "$WEB" && mv "$WEB.new" "$WEB"
echo "site now serves: $(curl -sk --resolve maheshfoundation-medical.com:443:127.0.0.1 https://maheshfoundation-medical.com/ \
    | grep -oE 'assets/index-[A-Za-z0-9_-]+\.js' || echo 'NO SCRIPT TAG FOUND')"

mkdir -p "$STATE"
# Same files as the sync: .env and .env.* (e.g. .env.example) stay as they are on the server.
grep -vE '  mahesh-meds-api/\.env(\..*)?$' "$REL/release.sha256" > "$STATE/installed.sha256"
echo "$RELEASE" > "$STATE/installed-commit"
echo; echo "DEPLOY COMPLETE: $SHORT (rollback copies: $API_PREV, $WEB_PREV)"
