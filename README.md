# Mahesh Foundation - Medical Equipment Services

This repository houses the codebases for the Mahesh Foundation Medical Equipment Services application. It is organized as a unified monorepo containing both the backend API service and the frontend management portal.

## Repository Structure

* **[mahesh-meds-api/](file:///c:/Users/aabha/OneDrive/Desktop/Mahesh%20Foundation/mahesh-meds-api)**: FastAPI (Python) backend application providing the database access layer, scheduler layer for SMS reminders, and business logic APIs.
* **[mahesh-meds-manager/](file:///c:/Users/aabha/OneDrive/Desktop/Mahesh%20Foundation/mahesh-meds-manager)**: React / Vite (TypeScript) frontend application used by admins, center managers, and approvers to manage request workflows and asset inventories.

---

## 1. Backend Service (`mahesh-meds-api`)

The backend is built with FastAPI, SQLAlchemy (MySQL), and APScheduler.

### Quick Start
1. Navigate into the API directory:
   ```bash
   cd mahesh-meds-api
   ```
2. Create and activate a Python virtual environment:
   ```bash
   python -m venv .venv
   .\.venv\Scripts\activate
   ```
3. Install dependencies:
   ```bash
   pip install -r requirements.txt
   ```
4. Start the development server:
   ```bash
   uvicorn app.main:app --reload
   ```

### Core Configuration (`.env`)
Create a `.env` file inside `mahesh-meds-api/` with the following variables:
* `DATABASE_URL`: Connection string for MySQL database (e.g., `mysql+pymysql://user:password@host/mahesh_meds`).
* `JWT_SECRET`: Secret key for token authentication (generate using `secrets.token_hex(32)`).
* `SMS_ENABLED`: Set to `true` to enable SMS alerts in production.
* `SMS_API_KEY`, `SMS_USERNAME`, `SMS_SENDER`, `SMS_PEID`: Credentials for BulkSMS DLT gateway.

---

## 2. Frontend Application (`mahesh-meds-manager`)

The frontend is built with React, Vite, and Tailwind CSS.

### Quick Start
1. Navigate into the manager directory:
   ```bash
   cd mahesh-meds-manager
   ```
2. Install npm packages:
   ```bash
   npm install
   ```
3. Start the Vite development server:
   ```bash
   npm run dev
   ```

### Core Configuration (`.env`)
Create a `.env` file inside `mahesh-meds-manager/` containing:
* `VITE_API_URL`: Root URL of the running backend FastAPI server (e.g., `http://localhost:8000`).
