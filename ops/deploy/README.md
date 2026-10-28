# Deploying to production

Production is one e2-micro VM (`instance-20260730-111750`, project `mf-medical-equipment-seva`,
zone `us-central1-a`): MariaDB, the API under systemd (`mahesh-meds-api`) in `/var/www/mahesh-meds-api`,
and the frontend served by nginx from `/var/www/mahesh-meds-manager`.

A release is one master commit. Its API files come from git, its frontend from the build Manager CI made
for that commit, so only commits whose API CI and Manager CI both passed can be deployed.

## Steps

Run from the repository root on the deploy machine (Git Bash for `.sh`, PowerShell for `.ps1`; needs the
GitHub CLI and gcloud, both signed in).

1. **Build the bundle** (checks CI, downloads the frontend build, writes checksums):

   ```bash
   ops/deploy/build-release.sh <commit> --out <dir>
   ```

   Add `--previous <commit of what production runs now>` the first time a server is deployed with these
   scripts (it has no record of its last deploy yet). The script prints the bundle path and its sha256;
   `<dir>/release-<short>.env` holds `RELEASE`, `SHORT` and `BUNDLE_SHA256`.

2. **Upload it:**

   ```powershell
   gcloud compute scp <dir>\release-<short>.tar.gz instance-20260730-111750:mes-deploy/ --project mf-medical-equipment-seva --zone us-central1-a
   ```

3. **Preflight (read-only).** Must end with `PREFLIGHT OK`:

   ```powershell
   ops\deploy\vm-run.ps1 -Script preflight.sh -Sudo -Vars @{ RELEASE = '<sha>'; BUNDLE_SHA256 = '<sha256>' }
   ```

   It checks the bundle, that the running files are exactly what the last deploy installed, that
   `requirements.txt` is unchanged, the service and backups, and lists pending migrations and anyone
   working in the app in the last 15 minutes.

4. **Deploy:**

   ```powershell
   ops\deploy\vm-run.ps1 -Script deploy.sh -Sudo -Vars @{ RELEASE = '<sha>'; BUNDLE_SHA256 = '<sha256>'; PREV = '<tag of the release being replaced>' }
   ```

   Database backup to Cloud Storage, rollback copies (`/var/www/mahesh-meds-api.prev-<PREV>` without
   `.venv`/`.env`, and `/var/www/mahesh-meds-manager.prev-<PREV>`), the API tree synced from the bundle
   (`.env`, `.env.*`, `.venv` and bytecode are left alone; files no longer in the repo are removed),
   migrations, restart with a health check, frontend swap, and a record of what is installed in
   `/var/lib/mahesh-deploy/`. A failed migration or health check puts the previous API files back.
   `MARK_APPLIED='<file>,<file>'` records migrations that were applied by hand without running them.

5. **Check (read-only).** Must end with `POSTDEPLOY OK`:

   ```powershell
   ops\deploy\vm-run.ps1 -Script postdeploy.sh -Sudo
   ```

   Errors since restart, scheduler lock, public pages through nginx, every file on the server against the
   release checksums, migration status, data counts, SMS sent since the restart, SMS delivery over the last 7 days, rollback copies.

6. **Tag the release:**

   ```bash
   git tag -a prod-YYYY-MM-DD[.N] <sha> -m "<what changed>" && git push origin prod-YYYY-MM-DD[.N]
   ```

7. **Clean up** older rollback copies once you are happy (lists first; `APPLY=yes` deletes):

   ```powershell
   ops\deploy\vm-run.ps1 -Script cleanup.sh -Sudo -Vars @{ KEEP = '<PREV used in step 4>' }
   ops\deploy\vm-run.ps1 -Script cleanup.sh -Sudo -Vars @{ KEEP = '<PREV used in step 4>'; APPLY = 'yes' }
   ```

## Rolling back

The previous release's files are in the `.prev-<PREV>` copies made by step 4:

```bash
sudo rsync -a --delete --exclude '/.venv/' --exclude '/.env' --exclude '/.env.*' --exclude '__pycache__/' \
    /var/www/mahesh-meds-api.prev-<PREV>/ /var/www/mahesh-meds-api/
sudo systemctl restart mahesh-meds-api
sudo rm -rf /var/www/mahesh-meds-manager && sudo cp -a /var/www/mahesh-meds-manager.prev-<PREV> /var/www/mahesh-meds-manager
```

Migrations are not undone; they are written to work with the previous code (see
`mahesh-meds-api/db/migrations/README.md`). The nightly and pre-deploy database backups are in
`gs://mf-medical-equipment-seva-db-backups`.

## When requirements.txt changes

`deploy.sh` stops if it does. Install the new packages into the virtualenv first, then deploy:

```bash
sudo -u www-data /var/www/mahesh-meds-api/.venv/bin/pip install -r <unpacked release>/mahesh-meds-api/requirements.txt
```
