# READ-ONLY checks after a deploy (run with -Sudo). Prints no secret values or personal data.
set +e
SITE=maheshfoundation-medical.com
since="$(systemctl show mahesh-meds-api -p ActiveEnterTimestamp --value)"

step "API process"
echo "restarted at: $since   automatic restarts: $(systemctl show mahesh-meds-api -p NRestarts --value)"
check "errors since restart" "$(journalctl -u mahesh-meds-api --since "$since" --no-pager | grep -cE ' ERROR |Traceback')" "0"
check "one worker holds the scheduler lock" "$(journalctl -u mahesh-meds-api --since "$since" --no-pager | grep -c 'acquired the scheduler advisory lock')" "1"
check "the database still has the scheduler lock taken" "$(mariadb -N -e "SELECT IS_USED_LOCK('mahesh_meds_scheduler') IS NOT NULL")" "1"

step "through nginx (public hostname, resolved locally)"
code() { curl -sk --resolve "$SITE:443:127.0.0.1" -o /dev/null -w '%{http_code}' "$@"; }
script="$(curl -sk --resolve "$SITE:443:127.0.0.1" "https://$SITE/" | grep -oE 'assets/index-[A-Za-z0-9_-]+\.js')"
check "GET /api/health" "$(code "https://$SITE/api/health")" "200"
check "GET /api/v1/stock (public, reads the database)" "$(code "https://$SITE/api/v1/stock")" "200"
check "home page script $script" "$(code "https://$SITE/$script")" "200"
check "GET /center/return (app route)" "$(code "https://$SITE/center/return")" "200"
check "GET /api/v1/lease-requests without login is refused" "$(code "https://$SITE/api/v1/lease-requests")" "401"

step "installed files"
if [ -f "$STATE/installed.sha256" ]; then
    echo "installed commit: $(cat "$STATE/installed-commit")"
    diff_out="$(diff <(by_path < "$STATE/installed.sha256") <(live_manifest | by_path))"
    check "every file on the server matches the release (none missing, changed or extra)" "$([ -z "$diff_out" ] && echo yes || echo no)" "yes"
    [ -n "$diff_out" ] && echo "$diff_out" | head -20 | sed 's/^/      /'
    echo "files checked: $(wc -l < "$STATE/installed.sha256")"
else
    echo "no deploy recorded on this server yet"
fi

step "database"
as_app -m app.migrate status 2>&1 | grep -v Warning
echo "requests: $(mariadb -N mahesh_meds -e "SELECT CONCAT(status, '=', COUNT(*)) FROM lease_requests GROUP BY status;" | tr '\n' ' ')"
echo "devices out on open lines: $(mariadb -N mahesh_meds -e "SELECT COUNT(*) FROM lease_items WHERE asset_id IS NOT NULL AND returned_at IS NULL;")"
echo "SMS since restart: $(mariadb -N mahesh_meds -e "SELECT CONCAT(status, '=', COUNT(*)) FROM notifications_log WHERE sent_at >= '$(date -u -d "$since" '+%F %T')' GROUP BY status;" | tr '\n' ' ')(end)"
echo "SMS delivery, last 7 days (app/jobs/sms_delivery.py): $(mariadb -N mahesh_meds -e "SELECT CONCAT(delivery_status, '=', COUNT(*)) FROM notifications_log WHERE delivery_status IS NOT NULL AND sent_at >= NOW() - INTERVAL 7 DAY GROUP BY delivery_status;" | tr '\n' ' ')(end)"
as_app -c "from app.jobs.reminders import release_expired_blocks; release_expired_blocks(); print('expiry job ran without error')" 2>&1 | grep -vE 'apscheduler|Warning'

step "rollback copies"
ls -d "$API".prev-* "$WEB".prev-* 2>/dev/null
echo "$(find "$API" -maxdepth 3 -name '*.prev-*' -not -path '*/.venv/*' | wc -l) old *.prev-* files inside $API, $(ls "$API"/.env.prev-* 2>/dev/null | wc -l) old .env copies"

echo
[ "$fail_count" -eq 0 ] && echo "POSTDEPLOY OK" || echo "POSTDEPLOY: $fail_count CHECK(S) FAILED"
