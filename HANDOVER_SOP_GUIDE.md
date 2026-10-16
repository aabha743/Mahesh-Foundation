# Mahesh Foundation — Medical Equipment Services (MES)
## Official Handover & Operational Standard Operating Procedure (SOP)

Welcome to the **Mahesh Foundation Medical Equipment Services (MES) Portal** operational guide. This document provides step-by-step instructions for patients, center managers, approvers, and administrators.

---

### 1. Portal Overview & Access Links

* **Live Public Website**: [https://maheshfoundation-medical.com](https://maheshfoundation-medical.com)
* **Staff Login Portal**: [https://maheshfoundation-medical.com/login](https://maheshfoundation-medical.com/login)
* **Authentication Method**: Mobile Number + 6-digit SMS OTP (No password required).

---

### 2. User Roles & Permissions Matrix

| Role | Access Level | Responsibilities |
| :--- | :--- | :--- |
| **Public Requestor** | Public Access (No Login Required) | Submits equipment requests, tracks request status via Token Number, submits extension requests. |
| **Approver** | Staff Portal (`requests.approve`) | Reviews patient requests, patient Aadhaar/ID, medical documents, approves/rejects requests. |
| **Center Manager** | Staff Portal (`devices.issue`, `devices.collect`) | Manages local center inventory, issues physical equipment (serial tags), collects returned equipment. |
| **Master Admin** | Full System Access (`users.manage`, `centers.manage`, etc.) | Manages user accounts, assigns roles to staff, configures center locations, views full audit log ledger. |

---

### 3. Step-by-Step Workflows & SOPs

#### **SOP 1: Patient / Family Equipment Request Process**
1. Visit [https://maheshfoundation-medical.com](https://maheshfoundation-medical.com) and click **Request Equipment**.
2. Select preferred distribution center and required equipment (e.g. Oxygen Concentrator, Wheelchair, Hospital Bed).
3. Fill in Patient details (Name, Aadhaar Number, Delivery Address, Mobile Number, Expected Lease Duration).
4. Click **Submit Request**.
5. Save the generated **Token Number** (e.g., `MHSF-2026-XXXX`). An SMS notification with the token is also sent to the mobile number.

#### **SOP 2: Request Approval Workflow (For Approvers)**
1. Log in to the Staff Portal using your registered mobile number and OTP.
2. Navigate to **Approvals Dashboard**.
3. Click on a pending request to view patient details and requested equipment lines.
4. Verify stock availability (the system automatically locks stock upon submission).
5. Click **Approve** (adds pickup guidance notes) OR **Reject** (enters rejection reason).
6. The patient receives an SMS notification with the decision and pickup instructions.

#### **SOP 3: Equipment Issuance Workflow (For Center Managers)**
1. Patient arrives at the center with their Token Number.
2. Center Manager logs into Staff Portal -> **Center Dashboard** -> **Issue Device**.
3. Search for the Token Number.
4. Select the specific physical **Asset Serial Tag / Barcode** (e.g. `OXY-BEL-004`).
5. Confirm Expected Return Date.
6. Click **Confirm Issuance**. The patient receives an SMS receipt with the expected return date.

#### **SOP 4: Asset QR Sticker Printing & Physical Labeling**
1. In the Staff Portal, navigate to **Inventory Catalog**.
2. Click **View QR Code / Sticker** next to any asset.
3. Click **Download Sticker / Print**.
4. Stick the QR label onto the physical equipment frame. Scanning the QR code with any smartphone camera opens the asset status page instantly.

#### **SOP 5: Equipment Return Workflow (For Center Managers)**
1. Patient returns equipment to the center.
2. Center Manager opens **Center Inventory** -> Locate Asset Tag / Token.
3. Click **Collect Return**.
4. Inspect physical condition:
   - If clean & functional: Status returns to **`available`** immediately.
   - If needs repair: Status changes to **`maintenance`**.

---

### 4. System Maintenance & Operational Commands

#### **Database Daily Backup Verification**
Automated backups run every night at **2:00 AM IST** (systemd timer `mahesh-db-backup.timer`).
* Each dump is verified, kept on the VM for 7 days at `/var/backups/mahesh-meds/` (root only), and uploaded to the private Cloud Storage bucket `gs://mf-medical-equipment-seva-db-backups`.
* In the bucket, `daily/` copies are kept for 35 days and `monthly/` copies (taken on the 1st) for 13 months; Cloud Storage deletes older ones automatically.
* The VM runs as the `mes-vm-runtime` service account, which can only *add* backups to the bucket; it cannot read or delete them.

```bash
# When did the last backup run, and when is the next one?
sudo systemctl list-timers mahesh-db-backup.timer

# Result of the last backup (look for "backup ok")
sudo journalctl -u mahesh-db-backup.service -n 20

# Run a backup right now
sudo systemctl start mahesh-db-backup.service

# Prove the newest local backup restores (uses a temporary database, then drops it)
sudo /usr/local/sbin/mahesh-db-verify-restore
```

#### **Restoring the Database from a Backup**
Only do this to recover from data loss; it replaces the live data.
1. On a machine signed in to the Google Cloud project as an owner, download the backup you need:
   `gcloud storage ls gs://mf-medical-equipment-seva-db-backups/daily/` then `gcloud storage cp gs://mf-medical-equipment-seva-db-backups/daily/<file>.sql.gz .`
   (Files written on the last 7 nights are also on the VM in `/var/backups/mahesh-meds/`.)
2. Copy it to the VM if needed, then stop the API: `sudo systemctl stop mahesh-meds-api.service`
3. Check the file first: `sudo /usr/local/sbin/mahesh-db-verify-restore /path/to/<file>.sql.gz`
4. Restore: `zcat /path/to/<file>.sql.gz | sudo mariadb mahesh_meds`
5. Start the API: `sudo systemctl start mahesh-meds-api.service`

Backup files contain patient Aadhaar numbers and addresses: never email them or keep copies on personal devices.

#### **Checking System Service Status**
```bash
# Check Backend API status
sudo systemctl status mahesh-meds-api.service

# Check Web Server status
sudo systemctl status nginx

# View Backend Live Logs
sudo journalctl -u mahesh-meds-api.service -f
```

---

### 5. Emergency Contacts & Support Escalation

* **System Administration**: Abha (Mobile: `+91 7815972631`)
* **Mahesh Foundation Helpline**: `support@maheshfoundation.org`
