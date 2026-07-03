# MF MEDICAL EQUIPMENT SEVA(MES) (frontend)

React + Vite UI for the Mahesh Meds API.

## Run on your phone (same Wi‑Fi)

1. Start the **API** on your PC (from `mahesh-meds-api`):

   ```bash
   uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
   ```

   Ensure `.env` has `DEBUG=true` (allows CORS from private LAN IPs).

2. Install and start the **frontend**:

   ```bash
   npm install
   npm run dev
   ```

3. Print URLs to open on your phone:

   ```bash
   npm run lan:url
   ```

4. On your phone’s browser, open e.g. `http://192.168.x.x:8080` (use the address from step 3).

**How it works:** In dev, API requests use the Vite dev server as a proxy (`/auth`, `/me`, `/api` → `http://127.0.0.1:8000`), so cookies and CSRF work without putting `localhost` in `VITE_API_URL`.

**Firewall:** Allow Node/Vite inbound on port **8080** if Windows Firewall blocks your phone.

### Optional: call API by LAN IP (no proxy)

- API: `uvicorn app.main:app --reload --host 0.0.0.0 --port 8000`
- Frontend `.env`: `VITE_API_URL=http://<your-PC-LAN-IP>:8000`
- API `.env`: add `http://<your-PC-LAN-IP>:8080` to `CORS_ORIGINS`

## Local desktop only

```bash
npm run dev
```

Open `http://localhost:8080`. Leave `VITE_API_URL` unset in `.env`.

## Production

Build the static frontend:

```bash
npm run build
```

Serve the generated `dist/` directory from your web host.

- Same-origin deployment: leave `VITE_API_URL` unset and proxy `/auth`, `/me`, and `/api` to `mahesh-meds-api`.
- Separate API domain: set `VITE_API_URL=https://your-api-domain.example` and add the frontend origin to the API `CORS_ORIGINS`.
