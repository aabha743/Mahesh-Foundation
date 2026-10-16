#!/bin/bash
# =========================================================
# GCP e2-micro One-Click Deployment Script
# Mahesh Foundation - Medical Equipment Services
# =========================================================

set -e

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

DB_PASS="MaheshAppPass2026!"

sudo mysql -e "CREATE DATABASE IF NOT EXISTS mahesh_meds CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
sudo mysql -e "CREATE USER IF NOT EXISTS 'mahesh_app'@'localhost' IDENTIFIED BY '${DB_PASS}';"
sudo mysql -e "GRANT ALL PRIVILEGES ON mahesh_meds.* TO 'mahesh_app'@'localhost';"
sudo mysql -e "FLUSH PRIVILEGES;"

PROJECT_ROOT="$(pwd)"

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

if [ ! -f /var/www/mahesh-meds-api/.env ]; then
    echo "Creating initial /var/www/mahesh-meds-api/.env file..."
    sudo cat <<EOF | sudo tee /var/www/mahesh-meds-api/.env
DATABASE_URL=mysql+pymysql://mahesh_app:${DB_PASS}@127.0.0.1:3306/mahesh_meds
DEBUG=false
COOKIE_SECURE=true
COOKIE_SAMESITE=lax
PICKUP_WINDOW_HOURS=72
SMS_ENABLED=true
SMS_PEID=1201159102043751902
SMS_API_KEY=a620ec90-84b6-4bc5-b28d-21303df51b49
SMS_USERNAME=oz07-hostello
SMS_SENDER=MHSFND
SMS_BASE_URL=http://www.bulksmsapps.com/api/apismsv2.aspx
SMS_TIMEOUT_SECONDS=10
JWT_SECRET=${JWT_SECRET}
BOOTSTRAP_ADMIN_MOBILE=7815972631
BOOTSTRAP_ADMIN_NAME=Abha
CORS_ORIGINS=http://35.222.32.191,https://maheshfoundation-medical.com,https://www.maheshfoundation-medical.com
EOF
else
    echo "Existing .env found at /var/www/mahesh-meds-api/.env. Preserving custom values and ensuring production settings..."
    sudo sed -i 's/^SMS_ENABLED=.*/SMS_ENABLED=true/' /var/www/mahesh-meds-api/.env
    sudo sed -i 's/^COOKIE_SECURE=.*/COOKIE_SECURE=true/' /var/www/mahesh-meds-api/.env
    if ! grep -q "SMS_PEID" /var/www/mahesh-meds-api/.env; then
        sudo cat <<EOF | sudo tee -a /var/www/mahesh-meds-api/.env
SMS_PEID=1201159102043751902
SMS_API_KEY=a620ec90-84b6-4bc5-b28d-21303df51b49
SMS_USERNAME=oz07-hostello
SMS_SENDER=MHSFND
SMS_BASE_URL=http://www.bulksmsapps.com/api/apismsv2.aspx
SMS_TIMEOUT_SECONDS=10
EOF
    fi
fi

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
