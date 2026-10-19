#!/bin/bash
# =========================================================
# GCP e2-micro One-Click Deployment Script
# Mahesh Foundation - Medical Equipment Services
# =========================================================

set -e

# No secrets live in this file. On a fresh install, provide them as environment
# variables or in an untracked deploy.env next to this script (see deploy.env.example):
#   SMS_API_KEY, SMS_USERNAME, SMS_PEID          BulkSMS / DLT; SMS stays off without them
#   BOOTSTRAP_ADMIN_MOBILE, BOOTSTRAP_ADMIN_NAME  first master admin (optional)
# The database password is generated on first install and kept only in the API's .env.
PROJECT_ROOT="$(pwd)"
if [ -f "${PROJECT_ROOT}/deploy.env" ]; then
    set -a
    . "${PROJECT_ROOT}/deploy.env"
    set +a
fi
API_ENV=/var/www/mahesh-meds-api/.env

echo "=== Step 1: Setting up 2GB Swap space ==="
if [ ! -f /swapfile ]; then
    sudo fallocate -l 2G /swapfile || sudo dd if=/dev/zero of=/swapfile bs=1M count=2048
    sudo chmod 600 /swapfile
    sudo mkswap /swapfile
    sudo swapon /swapfile
    echo '/swapfile swap swap defaults 0 0' | sudo tee -a /etc/fstab
    echo "Swap space created and enabled successfully."
else
    echo "Swap space already exists."
fi

echo "=== Step 2: Installing Required System Packages ==="
sudo apt-get update
sudo apt-get install -y mariadb-server mariadb-client python3 python3-venv python3-pip nginx certbot python3-certbot-nginx curl ufw

echo "=== Step 3: Setting up MariaDB Database ==="
sudo systemctl enable mariadb
sudo systemctl start mariadb

if sudo test -f "$API_ENV"; then
    # Existing install: keep using the password the API is already configured with.
    DB_PASS="$(sudo sed -n 's#^DATABASE_URL=mysql+pymysql://mahesh_app:\([^@]*\)@.*#\1#p' "$API_ENV")"
    if [ -z "$DB_PASS" ]; then
        echo "ERROR: could not read the database password from $API_ENV" >&2
        exit 1
    fi
else
    DB_PASS="$(python3 -c 'import secrets; print(secrets.token_urlsafe(24))')"
fi

sudo mysql -e "CREATE DATABASE IF NOT EXISTS mahesh_meds CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
sudo mysql -e "CREATE USER IF NOT EXISTS 'mahesh_app'@'localhost' IDENTIFIED BY '${DB_PASS}';"
sudo mysql -e "GRANT ALL PRIVILEGES ON mahesh_meds.* TO 'mahesh_app'@'localhost';"
sudo mysql -e "FLUSH PRIVILEGES;"

if [ -f /var/www/mahesh-meds-api/db/schema.sql ]; then
    echo "Importing schema into mahesh_meds..."
    sudo mysql --force mahesh_meds < /var/www/mahesh-meds-api/db/schema.sql || true
elif [ -f "${PROJECT_ROOT}/mahesh-meds-api/db/schema.sql" ]; then
    echo "Importing schema into mahesh_meds from local path..."
    sudo mysql --force mahesh_meds < "${PROJECT_ROOT}/mahesh-meds-api/db/schema.sql" || true
fi

echo "=== Step 4: Setting up Backend (mahesh-meds-api) ==="
sudo mkdir -p /var/www/mahesh-meds-api
if [ -d "${PROJECT_ROOT}/mahesh-meds-api" ]; then
    sudo cp -r "${PROJECT_ROOT}/mahesh-meds-api/"* /var/www/mahesh-meds-api/
fi

cd /var/www/mahesh-meds-api
if [ ! -d ".venv" ]; then
    sudo python3 -m venv .venv
fi
sudo .venv/bin/pip install --upgrade pip
sudo .venv/bin/pip install -r requirements.txt -r requirements.dev.txt

JWT_SECRET=$(python3 -c "import secrets; print(secrets.token_hex(32))")

if [ -n "${SMS_API_KEY:-}" ] && [ -n "${SMS_USERNAME:-}" ] && [ -n "${SMS_PEID:-}" ]; then
    SMS_ENABLED=true
else
    SMS_ENABLED=false
fi

if ! sudo test -f "$API_ENV"; then
    echo "Creating initial $API_ENV file..."
    [ "$SMS_ENABLED" = true ] || echo "WARNING: SMS_API_KEY / SMS_USERNAME / SMS_PEID not provided; SMS is disabled until they are added to $API_ENV."
    {
        cat <<EOF
DATABASE_URL=mysql+pymysql://mahesh_app:${DB_PASS}@127.0.0.1:3306/mahesh_meds
DEBUG=false
COOKIE_SECURE=true
COOKIE_SAMESITE=lax
PICKUP_WINDOW_HOURS=72
AADHAR_PHOTO_BUCKET=${AADHAR_PHOTO_BUCKET:-}
SMS_ENABLED=${SMS_ENABLED}
SMS_PEID=${SMS_PEID:-}
SMS_API_KEY=${SMS_API_KEY:-}
SMS_USERNAME=${SMS_USERNAME:-}
SMS_SENDER=MHSFND
SMS_BASE_URL=http://www.bulksmsapps.com/api/apismsv2.aspx
SMS_TIMEOUT_SECONDS=10
JWT_SECRET=${JWT_SECRET}
CORS_ORIGINS=http://35.222.32.191,https://maheshfoundation-medical.com,https://www.maheshfoundation-medical.com
EOF
        if [ -n "${BOOTSTRAP_ADMIN_MOBILE:-}" ]; then
            echo "BOOTSTRAP_ADMIN_MOBILE=${BOOTSTRAP_ADMIN_MOBILE}"
            echo "BOOTSTRAP_ADMIN_NAME=${BOOTSTRAP_ADMIN_NAME:-System Admin}"
        fi
    } | sudo tee "$API_ENV" >/dev/null
else
    echo "Existing $API_ENV found. Keeping its values and ensuring production settings..."
    sudo sed -i 's/^COOKIE_SECURE=.*/COOKIE_SECURE=true/' "$API_ENV"
    if ! sudo grep -q '^SMS_API_KEY=.' "$API_ENV" && [ "$SMS_ENABLED" = true ]; then
        sudo sed -i '/^SMS_\(ENABLED\|PEID\|API_KEY\|USERNAME\)=/d' "$API_ENV"
        printf 'SMS_ENABLED=true\nSMS_PEID=%s\nSMS_API_KEY=%s\nSMS_USERNAME=%s\n' "$SMS_PEID" "$SMS_API_KEY" "$SMS_USERNAME" | sudo tee -a "$API_ENV" >/dev/null
    fi
fi
sudo chown www-data:www-data "$API_ENV"
sudo chmod 600 "$API_ENV"

echo "=== Setting up Automated Daily Database Backups ==="
# Nightly dump at 02:00 IST, uploaded to gs://mf-medical-equipment-seva-db-backups.
# Uploads need the VM to run as the mes-vm-runtime service account (see HANDOVER_SOP_GUIDE.md).
sudo install -o root -g root -m 0750 "${PROJECT_ROOT}/ops/backup/mahesh-db-backup.sh" /usr/local/sbin/mahesh-db-backup
sudo install -o root -g root -m 0750 "${PROJECT_ROOT}/ops/backup/verify-restore.sh" /usr/local/sbin/mahesh-db-verify-restore
sudo install -o root -g root -m 0644 "${PROJECT_ROOT}/ops/backup/mahesh-db-backup.service" /etc/systemd/system/mahesh-db-backup.service
sudo install -o root -g root -m 0644 "${PROJECT_ROOT}/ops/backup/mahesh-db-backup.timer" /etc/systemd/system/mahesh-db-backup.timer
sudo rm -f /usr/local/bin/backup_mahesh_meds.sh
sudo systemctl daemon-reload
sudo systemctl enable --now mahesh-db-backup.timer


sudo chown -R www-data:www-data /var/www/mahesh-meds-api

echo "=== Step 5: Setting up Systemd Service ==="
sudo cat <<EOF | sudo tee /etc/systemd/system/mahesh-meds-api.service
[Unit]
Description=Mahesh Meds FastAPI Service
After=network.target mariadb.service

[Service]
User=www-data
WorkingDirectory=/var/www/mahesh-meds-api
EnvironmentFile=/var/www/mahesh-meds-api/.env
ExecStart=/var/www/mahesh-meds-api/.venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8000 --workers 2
Restart=always

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable mahesh-meds-api.service
sudo systemctl restart mahesh-meds-api.service

echo "=== Step 6: Setting up Frontend Bundle ==="
sudo mkdir -p /var/www/mahesh-meds-manager
if [ -d "${PROJECT_ROOT}/mahesh-meds-manager/dist" ]; then
    echo "Copying pre-built frontend dist bundle to /var/www/mahesh-meds-manager..."
    sudo cp -r "${PROJECT_ROOT}/mahesh-meds-manager/dist/"* /var/www/mahesh-meds-manager/
else
    echo "ERROR: mahesh-meds-manager/dist folder not found!"
    exit 1
fi
sudo chown -R www-data:www-data /var/www/mahesh-meds-manager
sudo chmod -R 755 /var/www/mahesh-meds-manager

echo "=== Step 7: Configuring Nginx Reverse Proxy ==="
sudo cat <<EOF | sudo tee /etc/nginx/sites-available/mahesh-meds
server {
    listen 80;
    server_name maheshfoundation-medical.com www.maheshfoundation-medical.com 35.222.32.191;

    root /var/www/mahesh-meds-manager;
    index index.html;

    include /etc/nginx/mime.types;

    location / {
        try_files \$uri \$uri/ /index.html;
    }

    location ~ ^/(api|auth|me|health|docs|openapi.json) {
        # Request forms carry two Aadhaar card photos (the browser shrinks each to well under 1.5 MB).
        client_max_body_size 6m;
        proxy_pass http://127.0.0.1:8000;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
EOF

sudo ln -sf /etc/nginx/sites-available/mahesh-meds /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl reload nginx

echo "========================================================="
echo " SUCCESS! Backend and Frontend configured on GCP VM."
echo " To issue trusted HTTPS SSL certificate, run:"
echo " sudo certbot --nginx -d maheshfoundation-medical.com -d www.maheshfoundation-medical.com"
echo "========================================================="
