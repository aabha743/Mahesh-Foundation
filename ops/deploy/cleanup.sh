# Remove old rollback copies once a deploy has been verified (run with -Sudo).
#   KEEP   the rollback label to keep (the PREV of the latest deploy), e.g. prod-2026-10-16.3
#   APPLY  set to "yes" to delete; otherwise only lists what would be deleted
#
# Removes: $API.prev-* and $WEB.prev-* other than KEEP, old *.prev-* files inside the API directory,
# old .env.prev-* copies, and uploaded bundles other than the one installed now.
set -euo pipefail
: "${KEEP:?set KEEP}"
[ -d "$API.prev-$KEEP" ] && [ -d "$WEB.prev-$KEEP" ] || { echo "no rollback copies named $KEEP; refusing" >&2; exit 1; }
installed="$(cut -c1-7 "$STATE/installed-commit" 2>/dev/null || true)"
[ -n "$installed" ] || { echo "no installed release recorded; refusing" >&2; exit 1; }

targets=()
for dir in "$API".prev-* "$WEB".prev-*; do
    [ -e "$dir" ] && [ "$dir" != "$API.prev-$KEEP" ] && [ "$dir" != "$WEB.prev-$KEEP" ] && targets+=("$dir")
done
while IFS= read -r -d '' file; do targets+=("$file"); done < <(find "$API" -name '*.prev-*' -not -path '*/.venv/*' -print0)
for file in "$API"/.env.prev-*; do [ -e "$file" ] && targets+=("$file"); done
for item in "$DEPLOY_DIR"/release-*; do
    case "$item" in
        "$DEPLOY_DIR/release-$installed"|"$DEPLOY_DIR/release-$installed.tar.gz") ;;
        *) [ -e "$item" ] && targets+=("$item") ;;
    esac
done

if [ ${#targets[@]} -eq 0 ]; then echo "nothing to remove"; exit 0; fi
for target in "${targets[@]}"; do echo "$(du -sh "$target" | cut -f1)	$target"; done
if [ "${APPLY:-}" = "yes" ]; then
    rm -rf -- "${targets[@]}"
    echo "removed ${#targets[@]} item(s); kept $API.prev-$KEEP and $WEB.prev-$KEEP"
else
    echo "(dry run: ${#targets[@]} item(s) would be removed; run again with APPLY=yes)"
fi
