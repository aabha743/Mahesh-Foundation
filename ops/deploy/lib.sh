# Shared by the VM-side deploy scripts; vm-run.ps1 puts it in front of each script it runs.
# shellcheck shell=bash

API="${API:-/var/www/mahesh-meds-api}"
WEB="${WEB:-/var/www/mahesh-meds-manager}"
STATE="${STATE:-/var/lib/mahesh-deploy}"         # installed-commit and installed.sha256 of the last deploy
DEPLOY_DIR="${DEPLOY_DIR:-$(getent passwd "${SUDO_USER:-$USER}" | cut -d: -f6)/mes-deploy}"   # uploaded bundles

# Files the running site depends on; drift in anything else on the server does not block a deploy.
RUNTIME_RE='^[0-9a-f]{64}  (mahesh-meds-api/(app/|requirements\.txt$)|mahesh-meds-manager/dist/)'

step() { echo; echo "=== $*"; }
sum() { sha256sum "$1" | cut -d' ' -f1; }

fail_count=0
check() {  # check "<what>" "<actual>" "<expected>"
    if [ "$2" = "$3" ]; then echo "PASS  $1"; else echo "FAIL  $1 (expected '$3', got '$2')"; fail_count=$((fail_count + 1)); fi
}

# sha256 of every deployed file as "hash  mahesh-meds-api/<path>" / "hash  mahesh-meds-manager/dist/<path>",
# leaving out secrets (.env*), the virtualenv, bytecode and old rollback copies (*.prev-*).
live_manifest() {
    (cd "$API" && find . -type f -not -path './.venv/*' -not -path '*/__pycache__/*' \
        -not -name '.env' -not -name '.env.*' -not -name '*.prev-*' -print0 \
        | xargs -0 -r sha256sum | sed -E 's#^([0-9a-f]{64}) [ *]\./#\1  mahesh-meds-api/#')
    (cd "$WEB" && find . -type f -print0 | xargs -0 -r sha256sum | sed -E 's#^([0-9a-f]{64}) [ *]\./#\1  mahesh-meds-manager/dist/#')
}
by_path() { sed -E 's/^([0-9a-f]{64}) [ *]/\1  /' | LC_ALL=C sort -k2; }   # also accepts Windows-style "hash *path"
runtime_only() { by_path | grep -E "$RUNTIME_RE"; }

healthy() {  # API answers on /health and a public endpoint that hits the database
    for _ in $(seq 1 30); do
        if curl -sf http://127.0.0.1:8000/health >/dev/null && curl -sf http://127.0.0.1:8000/api/v1/stock >/dev/null; then
            return 0
        fi
        sleep 1
    done
    return 1
}

# Run a command in the API directory as the service user (reads DATABASE_URL from .env).
as_app() { (cd "$API" && sudo -u www-data "$API/.venv/bin/python" "$@"); }
