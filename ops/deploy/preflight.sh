# READ-ONLY checks before a deploy. Needs RELEASE (full commit) and BUNDLE_SHA256 from build-release.sh.
# Prints PASS/FAIL per check and ends with PREFLIGHT OK / PREFLIGHT FAILED. Never prints secret values.
set +e
: "${RELEASE:?set RELEASE}" "${BUNDLE_SHA256:?set BUNDLE_SHA256}"
SHORT="${RELEASE:0:7}"
BUNDLE="$DEPLOY_DIR/release-$SHORT.tar.gz"
from_bundle() { tar -xOzf "$BUNDLE" "./$1" 2>/dev/null; }

check "bundle uploaded" "$([ -f "$BUNDLE" ] && echo yes || echo no)" "yes"
check "bundle checksum" "$(sum "$BUNDLE" 2>/dev/null)" "$BUNDLE_SHA256"
check "bundle is for $SHORT" "$(from_bundle RELEASE)" "$RELEASE"

# Drift: the files the site runs must be exactly what the last deploy installed.
if [ -f "$STATE/installed.sha256" ]; then
    expected="$(runtime_only < "$STATE/installed.sha256")"
    source_of_truth="last deploy ($(cat "$STATE/installed-commit" 2>/dev/null | cut -c1-7))"
else
    expected="$(from_bundle expected-live.sha256 | runtime_only)"
    source_of_truth="bundle's expected-live.sha256 ($(from_bundle PREVIOUS | cut -c1-7); no deploy recorded on this server yet)"
fi
drift="$(diff <(echo "$expected") <(live_manifest | runtime_only))"
check "running files match the $source_of_truth" "$([ -n "$expected" ] && [ -z "$drift" ] && echo same || echo different)" "same"
[ -n "$drift" ] && echo "$drift" | head -20 | sed 's/^/      /'

check "requirements.txt unchanged (no package install needed)" \
    "$(sha256sum < "$API/requirements.txt" | cut -d' ' -f1)" "$(from_bundle mahesh-meds-api/requirements.txt | sha256sum | cut -d' ' -f1)"
check "API service active" "$(systemctl is-active mahesh-meds-api)" "active"
check "backup timer active" "$(systemctl is-active mahesh-db-backup.timer)" "active"
check "last nightly backup succeeded" "$(systemctl show mahesh-db-backup.service -p Result --value)" "success"
since="$(systemctl show mahesh-meds-api -p ActiveEnterTimestamp --value)"
check "API errors since its last restart" "$(journalctl -u mahesh-meds-api --since "$since" --no-pager | grep -cE ' ERROR |Traceback')" "0"

echo "--- migrations (recorded in schema_migrations vs. files in the bundle)"
recorded="$(mariadb -N mahesh_meds -e "SELECT name FROM schema_migrations ORDER BY name;" 2>/dev/null)"
[ -z "$recorded" ] && echo "      schema_migrations table not created yet (first deploy with the migration runner)"
for f in $(tar -tzf "$BUNDLE" | grep -E '^\./mahesh-meds-api/db/migrations/[^/]+\.sql$' | xargs -r -n1 basename | sort); do
    if echo "$recorded" | grep -qx "$f"; then echo "      applied  $f"; else echo "      PENDING  $f"; fi
done

echo "--- staff write activity in the last 15 minutes (someone mid-workflow?): $(journalctl -u mahesh-meds-api --since '15 min ago' --no-pager | grep -cE '"(PATCH|POST|DELETE) /api/v1/')"
echo "--- requests: $(mariadb -N mahesh_meds -e "SELECT CONCAT(status, '=', COUNT(*)) FROM lease_requests GROUP BY status;" | tr '\n' ' ')"
echo "--- devices out on open lines: $(mariadb -N mahesh_meds -e "SELECT COUNT(*) FROM lease_items WHERE asset_id IS NOT NULL AND returned_at IS NULL;")"
echo "--- free disk on /: $(df -h / | awk 'NR==2{print $4}')   memory available: $(free -m | awk '/Mem:/{print $7}') MB"
echo "--- rollback copies on the server now:"
ls -d "$API".prev-* "$WEB".prev-* 2>/dev/null | sed 's/^/      /'
echo "      $(find "$API" -maxdepth 3 -name '*.prev-*' -not -path '*/.venv/*' | wc -l) old *.prev-* files inside $API"
[ "$fail_count" -eq 0 ] && echo "PREFLIGHT OK" || echo "PREFLIGHT FAILED ($fail_count)"
