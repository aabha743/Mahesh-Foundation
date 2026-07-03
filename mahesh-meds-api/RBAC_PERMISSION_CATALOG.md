# RBAC Permission Catalog

This document captures the current permission catalog and default role mappings used by the Mahesh Meds backend.

## Enforcement Model

- Permissions are the enforcement unit
- Roles are groupings of permissions
- Backend authorization resolves permissions from the database
- Frontend UI should use the flattened permissions returned by `/me`
- `master_admin` receives all permissions through role-permission assignments in the database

## Permission Catalog

| Permission | Purpose |
| --- | --- |
| `users.manage` | Create, update, disable, and review staff users |
| `roles.manage` | Create and manage role / permission definitions |
| `assets.create` | Create new assets in the system |
| `assets.update` | Update asset details, status, soft delete, and ownership assignments |
| `skus.manage` | Create, update, and soft delete SKUs |
| `centers.manage` | Create and soft delete centers |
| `requests.approve` | Approve lease requests |
| `requests.reject` | Reject lease requests |
| `requests.edit` | Edit lease requests and fulfillment notes |
| `devices.issue` | Assign issued devices to approved requests |
| `devices.collect` | Record returns and closure of issued devices |
| `audit.view` | View audit logs and operational activity history |

## Default Role Mappings

### `master_admin`

Receives all permissions.

### `asset_manager`

- `assets.create`
- `assets.update`
- `skus.manage`

### `center_manager`

- `assets.update`
- `devices.issue`
- `devices.collect`

### `approver`

- `requests.approve`
- `requests.reject`
- `requests.edit`

## Current Protected Workflow Areas

### Admin / Master Admin

- users
- centers
- SKUs
- assets
- audit logs
- lease request fallback actions for pending requests

### Approver

- approve requests
- reject requests
- edit pending requests

### Center Operations

- issue devices
- collect returns

## Notes

- Cross-center asset transfer workflow is not part of the current production API. Assets are issued and returned at their own center.
- `/api/v1/lease-requests/by-token/{token}/issue-context/{center_id}` is treated as a staff workflow endpoint and requires `devices.issue`.
- Public token lookup endpoints remain public by design.
- User-scoped identity access is currently limited to `/me`; staff-admin endpoints cannot be used to deactivate or re-role the currently logged-in user.
- If a new permission is introduced, update:
  - database seed data
  - role mappings
  - frontend permission usage where needed
