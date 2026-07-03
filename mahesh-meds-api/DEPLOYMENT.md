# Deployment Guide — Mahesh Meds Backend

## Server
- Provider: A2 Hosting
- Panel: cPanel
- Subdomain: medicalequipments.maheshfoundation.com
- Python: Available via cPanel
- Database: MySQL (same server)

## Environment Variables
Copy .env.example to .env and fill in all values.
Never commit .env to version control.

Required variables:
- DATABASE_URL
- JWT_SECRET (generate with: python -c "import secrets; print(secrets.token_hex(32))")
- SMS_API_KEY
- SMS_USERNAME
- SMS_PEID
- ENVIRONMENT=production
- IS_PRODUCTION=true
- SMS_ENABLED=true (only after DLT template IDs are populated in sms_templates table)
- CORS_ORIGINS=https://medicalequipments.maheshfoundation.com

## Database Setup
1. Create database mahesh_meds in cPanel MySQL
2. Run db/schema.sql to create all tables
3. Verify seed data: 
   SELECT * FROM permissions; (should return 13)
   SELECT * FROM roles; (should return 4)
   SELECT * FROM role_permissions;

## Database Backups
cPanel automatic backups must be enabled.
Verify with Susheel that:
- Daily automatic backups are ON
- Backup retention is minimum 7 days
- Backups include the mahesh_meds database
- Restore procedure has been tested at least once

Manual backup command if needed:
mysqldump -u {user} -p mahesh_meds > backup_$(date +%Y%m%d).sql

## First Deployment Steps
1. Upload backend code to server
2. Create virtual environment: python3 -m venv .venv
3. Install dependencies: pip install -r requirements.txt
4. Copy and fill .env file
5. Run schema: mysql -u user -p mahesh_meds < db/schema.sql
6. Configure Python app in cPanel
7. Test health endpoint: curl https://medicalequipments.maheshfoundation.com/health

## Updating the Application
1. Pull latest code
2. pip install -r requirements.txt
3. Restart the Python app in cPanel
4. Check /health endpoint responds
