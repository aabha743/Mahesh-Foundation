# Mahesh Meds API

FastAPI backend for Mahesh Foundation Medical Device Management System.

## Quick start

1. Create a virtual environment and activate it.
2. Install dependencies:
   - `pip install -r requirements.txt`
3. Copy `.env.example` to `.env` and set values.
4. Create the MySQL database and apply the schema:
   - `mysql -u <user> -p < db/schema.sql`
5. Run:
   - `uvicorn app.main:app --reload --host 127.0.0.1 --port 8000`

## Phone / tablet on the same Wi‑Fi

**Recommended (with frontend Vite proxy):** Only the frontend port needs to be reachable from your phone.

1. In `.env`, keep `DEBUG=true` (enables CORS for private LAN IPs such as `192.168.x.x:8080`).
2. Run the API on your PC:
   - `uvicorn app.main:app --reload --host 127.0.0.1 --port 8000`
3. In `mahesh-meds-manager`, run `npm run dev` and `npm run lan:url`, then open the printed `http://<LAN-IP>:8080` URL on your phone.

**Alternative (phone calls API directly):**

1. Run: `uvicorn app.main:app --reload --host 0.0.0.0 --port 8000`
2. Add your frontend LAN URL to `CORS_ORIGINS`, e.g. `http://192.168.1.10:8080`
3. Set `VITE_API_URL=http://<your-PC-LAN-IP>:8000` in the frontend `.env`

## SMS Configuration

SMS delivery is handled through a reusable service layer used by OTP and transactional request messages.

Relevant variables:

- `SMS_ENABLED`
- `SMS_PEID`
- `SMS_API_KEY`
- `SMS_USERNAME`
- `SMS_SENDER`
- `SMS_BASE_URL`
- `SMS_TIMEOUT_SECONDS`

Behavior:

- When `SMS_ENABLED=false`
  - business flows still succeed
  - no provider call is made
  - a `notifications_log` row is still written with status `skipped`
- When `SMS_ENABLED=true`
  - the backend uses the BulkSMS Apps v2 `apismsv2.aspx` GET format
  - each message event reads its DLT `template_id` from the `sms_templates` table
  - OTP login still returns `debug_otp` when `DEBUG=true`

Before enabling live sending:

1. Confirm `SMS_PEID`
2. Populate DLT template IDs in `sms_templates.template_id`
3. Set `SMS_ENABLED=true`

If live OTP SMS delivery fails, the OTP request returns `503` with a safe user-facing message and records the failure in both audit logs and `notifications_log`.

## Endpoints

- `GET /health` - health check
- `GET /api/v1/centers` - list centers
- `POST /api/v1/centers` - create center
- `GET /api/v1/skus` - list skus
- `POST /api/v1/skus` - create sku
- `GET /api/v1/assets` - list assets
- `POST /api/v1/assets` - create asset
- `GET /api/v1/lease-requests` - list lease requests
- `POST /api/v1/lease-requests` - create lease request

## Database

SQL schema is in `db/schema.sql`. For now, this file is the database source of truth.

Apply it to a fresh MySQL database before starting the API.

Fresh schema now includes:

- `notifications_log`
- `sms_templates`
- seed rows for default SMS event templates

## Railway notes

- Set `DATABASE_URL` in service variables.
- Set `DEBUG=false`.
- Set `JWT_SECRET` to a long random value.
- Set `COOKIE_SECURE=true`.
- Set `CORS_ORIGINS` to the deployed frontend origin when frontend and API are on different origins.
- Keep `SMS_ENABLED=false` until provider credentials, PEID, and DLT template IDs are configured.
- Start command:
  - `uvicorn app.main:app --host 0.0.0.0 --port $PORT`

## Schema change workflow

Alembic has been removed for now. When the database structure changes, update these together:

1. `app/models.py` for ORM table definitions
2. `app/schemas.py` for API request/response shapes
3. `db/schema.sql` for fresh database setup
4. Tests and seed data when roles, permissions, or workflows change
