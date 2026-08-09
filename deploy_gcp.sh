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

if [ -f /var/www/mahesh-meds-api/db/schema.sql ]; then
    echo "Importing schema into mahesh_meds..."
    sudo mysql mahesh_meds < /var/www/mahesh-meds-api/db/schema.sql
elif [ -f ./mahesh-meds-api/db/schema.sql ]; then
    echo "Importing schema into mahesh_meds from local path..."
    sudo mysql mahesh_meds < ./mahesh-meds-api/db/schema.sql
fi

echo "=== Step 4: Setting up Backend (mahesh-meds-api) ==="
sudo mkdir -p /var/www/mahesh-meds-api
if [ -d "./mahesh-meds-api" ]; then
    sudo cp -r ./mahesh-meds-api/* /var/www/mahesh-meds-api/
fi

cd /var/www/mahesh-meds-api
if [ ! -d ".venv" ]; then
    sudo python3 -m venv .venv
fi
sudo .venv/bin/pip install --upgrade pip
sudo .venv/bin/pip install -r requirements.txt -r requirements.dev.txt

JWT_SECRET=$(python3 -c "import secrets; print(secrets.token_hex(32))")

sudo cat <<EOF | sudo tee /var/www/mahesh-meds-api/.env
DATABASE_URL=mysql+pymysql://mahesh_app:${DB_PASS}@127.0.0.1:3306/mahesh_meds
DEBUG=false
COOKIE_SECURE=true
COOKIE_SAMESITE=lax
SMS_ENABLED=false
JWT_SECRET=${JWT_SECRET}
CORS_ORIGINS=https://maheshfoundation-medical.com,https://www.maheshfoundation-medical.com
EOF

sudo chown -R www-data:www-data /var/www/mahesh-meds-api

echo "=== Step 5: Setting up Systemd Service ==="
sudo cat <<EOF | sudo tee /etc/systemd/system/mahesh-meds-api.service
[Unit]
Description=Mahesh Meds FastAPI Service
After=network.target mariadb.service

[Service]
User=www-data
WorkingDirectory=/var/www/mahesh-meds-api
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
if [ -d "./mahesh-meds-manager/dist" ]; then
    sudo cp -r ./mahesh-meds-manager/dist/* /var/www/mahesh-meds-manager/
fi
sudo chown -R www-data:www-data /var/www/mahesh-meds-manager

echo "=== Step 7: Configuring Nginx Reverse Proxy ==="
sudo cat <<EOF | sudo tee /etc/nginx/sites-available/mahesh-meds
server {
    listen 80;
    server_name maheshfoundation-medical.com www.maheshfoundation-medical.com 35.222.32.191;

    root /var/www/mahesh-meds-manager;
    index index.html;

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
