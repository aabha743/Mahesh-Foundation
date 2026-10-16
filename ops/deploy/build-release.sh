#!/bin/bash
# Build the release bundle for one master commit. Runs on the deploy machine (Git Bash is fine), not the VM.
#
#   ops/deploy/build-release.sh <commit> [--out <dir>] [--previous <commit>]
#
# Refuses unless the commit is on origin/master and both CI workflows passed for it. The bundle holds the
# whole mahesh-meds-api tree from git, the frontend build CI made for that commit (checksums verified),
# RELEASE (the commit) and release.sha256 (every file). --previous adds expected-live.sha256, the files the
# server should be running now; preflight uses it when the server has no record of its last deploy yet.
set -euo pipefail

die() { echo "ERROR: $*" >&2; exit 1; }
GH="${GH:-$(command -v gh || echo "/c/Program Files/GitHub CLI/gh.exe")}"
[ -x "$GH" ] || die "GitHub CLI not found (set GH=/path/to/gh)"

commit="" out="${TMPDIR:-/tmp}" previous=""
while [ $# -gt 0 ]; do
    case "$1" in
        --out) out="$2"; shift 2 ;;
        --previous) previous="$2"; shift 2 ;;
        -*) die "unknown option $1" ;;
        *) commit="$1"; shift ;;
    esac
done
[ -n "$commit" ] || die "usage: build-release.sh <commit> [--out <dir>] [--previous <commit>]"

cd "$(git rev-parse --show-toplevel)"
git fetch -q origin master
SHA="$(git rev-parse --verify "$commit^{commit}")"
SHORT="${SHA:0:7}"
git merge-base --is-ancestor "$SHA" origin/master || die "$SHORT is not on origin/master"
REPO="$("$GH" repo view --json nameWithOwner --jq .nameWithOwner | tr -d '\r')"

echo "=== CI for $SHORT"
ci_run() {  # prints the run id of a successful push run of workflow $1 for $SHA, or fails
    local row
    row="$("$GH" run list --repo "$REPO" --workflow "$1" --commit "$SHA" --event push \
        --json databaseId,status,conclusion --jq '.[0] | "\(.databaseId) \(.status) \(.conclusion)"' | tr -d '\r')"
    [ -n "$row" ] && [ "$row" != "null null null" ] || die "no $1 run for $SHORT"
    set -- $row
    [ "$2" = "completed" ] && [ "$3" = "success" ] || die "$1 for $SHORT is $2/$3"
    echo "$1"
}
api_run="$(ci_run api-ci.yml)"
manager_run="$(ci_run manager-ci.yml)"
echo "API CI run $api_run passed; Manager CI run $manager_run passed"

REL="$out/release-$SHORT"
rm -rf "$REL" "$REL.tar.gz"
mkdir -p "$REL/.artifact" "$REL/mahesh-meds-manager"

echo "=== API tree from git"
git -c core.autocrlf=false archive "$SHA" mahesh-meds-api | tar -x -C "$REL"

echo "=== frontend build from CI"
fetch_dist() {  # fetch_dist <run id> <dir>: download the manager-dist artifact and verify its checksums
    "$GH" run download "$1" --repo "$REPO" --name manager-dist --dir "$2"
    (cd "$2/dist" && sha256sum --quiet -c ../dist.sha256) || die "frontend build checksums do not match"
}
fetch_dist "$manager_run" "$REL/.artifact"
mv "$REL/.artifact/dist" "$REL/mahesh-meds-manager/dist"
rm -rf "$REL/.artifact"

# "hash  path" lines sorted by path (sha256sum on Windows writes "hash *path"; the VM compares Linux-style lines).
manifest() { xargs -0 sha256sum | sed -E 's/^([0-9a-f]{64}) [ *]/\1  /' | LC_ALL=C sort -k2; }

echo "$SHA" > "$REL/RELEASE"
(cd "$REL" && find mahesh-meds-api mahesh-meds-manager -type f -print0 | manifest) > "$REL/release.sha256"

if [ -n "$previous" ]; then
    echo "=== files the server should be running now ($previous)"
    PREV_SHA="$(git rev-parse --verify "$previous^{commit}")"
    tmp="$(mktemp -d)"
    git -c core.autocrlf=false archive "$PREV_SHA" mahesh-meds-api | tar -x -C "$tmp"
    if git cat-file -e "$PREV_SHA:mahesh-meds-manager/dist/index.html" 2>/dev/null; then
        git -c core.autocrlf=false archive "$PREV_SHA" mahesh-meds-manager/dist | tar -x -C "$tmp"
    else
        prev_run="$(SHA="$PREV_SHA" ci_run manager-ci.yml)"
        mkdir -p "$tmp/.artifact" "$tmp/mahesh-meds-manager"
        fetch_dist "$prev_run" "$tmp/.artifact"
        mv "$tmp/.artifact/dist" "$tmp/mahesh-meds-manager/dist"
    fi
    (cd "$tmp" && find mahesh-meds-api/app mahesh-meds-api/requirements.txt mahesh-meds-manager/dist -type f -print0 \
        | manifest) > "$REL/expected-live.sha256"
    echo "$PREV_SHA" > "$REL/PREVIOUS"
    rm -rf "$tmp"
fi

tar -czf "$REL.tar.gz" -C "$REL" .
BUNDLE_SHA256="$(sha256sum "$REL.tar.gz" | cut -d' ' -f1)"
cat > "$REL.env" <<EOF
RELEASE=$SHA
SHORT=$SHORT
BUNDLE_SHA256=$BUNDLE_SHA256
EOF

echo
echo "bundle:  $REL.tar.gz"
echo "commit:  $SHA"
echo "sha256:  $BUNDLE_SHA256"
echo "files:   $(wc -l < "$REL/release.sha256") ($(grep -c '  mahesh-meds-manager/' "$REL/release.sha256") frontend)"
echo "migrations in this release: $(ls "$REL/mahesh-meds-api/db/migrations" | grep -c '\.sql$')"
