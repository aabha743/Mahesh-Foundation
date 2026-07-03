# Auth / RBAC TODO

This file tracks the remaining work from the client requirements review.

## Phase 1: Security Gaps

- [x] Add CSRF protection to `POST /auth/refresh`
- [x] Verify refresh flow still works correctly after CSRF enforcement
- [x] Audit failed OTP verification attempts
- [x] Audit OTP lockout events after max attempts
- [x] Audit OTP expiry / invalid-use scenarios where useful
- [x] Review all auth cookies for production-safe settings by environment

## Phase 2: OTP / SMS

Status: Partially complete. Remaining items are blocked on client SMS gateway / DLT details and future business-flow decisions.

- [x] Integrate env-driven SMS provider support for OTP delivery
- [x] Replace debug-only OTP usage in non-dev environments
- [x] Add delivery failure handling and clear API error messaging
- [ ] Decide whether OTP delivery status needs to be stored
- [ ] Expand `purpose` usage beyond `login` if future flows need it

## Phase 3: RBAC Hardening

- [x] Review whether `master_admin` should remain a hardcoded bypass
- [x] Document permission catalog clearly
- [x] Verify every sensitive backend endpoint uses permission-based enforcement
- [x] Review permission cache invalidation paths
- [x] Audit all permission-sensitive actions consistently

## Phase 4: Resource-Level Authorization

- [x] Define center-scoped access rules
- [x] Define user-scoped access rules
- [x] Enforce resource ownership checks in backend services/endpoints
- [x] Prevent cross-center access where permission alone is not sufficient
- [x] Add tests for allowed vs denied resource-level access

Suggested first resource rules:

- Center users should only access operational data for their own center
- Asset actions should be limited by center scope where applicable
- Lease workflows should respect assigned/preferred center rules

## Phase 5: Frontend Authorization UX

Status: Complete.

- [x] Recheck all navigation visibility against backend permissions
- [x] Recheck all protected routes for proper 401 vs 403 handling
- [x] Recheck action-level controls (`buttons`, `menus`, `forms`)
- [x] Test multi-role switching end to end
- [x] Confirm selected role/view behaves as intended without implying backend-only security

Key role-switching test cases:

- [x] `master_admin` + `center_manager`
- [x] `master_admin` + `approver`
- [x] `asset_manager` + `approver`
- [x] `asset_manager` + `center_manager`

## Phase 6: Notifications

Status: Blocked pending client-confirmed notification policy, SMS template approvals, and delivery metadata.

- [ ] Add APScheduler-based notification framework
- [ ] Define notification triggers
- [ ] Decide delivery channels (SMS, email, in-app, or mixed)
- [ ] Add retry/error handling requirements if notifications become critical

Candidate notification events:

- [ ] Overdue returns
- [ ] Upcoming warranty expiry
- [ ] Pending approvals

## Permission Catalog Review

Current permission model should be reviewed and finalized around entries like:

- [x] `users.manage`
- [x] `centers.manage`
- [x] `skus.manage`
- [x] `assets.create`
- [x] `assets.update`
- [x] `devices.issue`
- [x] `devices.collect`
- [x] `requests.approve`
- [x] `requests.reject`
- [x] `requests.edit`
- [x] `audit.view`

## Recommended Order

1. Close auth/security gaps
2. Finish OTP delivery
3. Harden RBAC rules
4. Add resource-level checks
5. Re-test frontend authorization behavior
6. Build notifications last

## Current Summary

- Complete: Phases 1, 3, 4, and 5
- Partially complete / blocked: Phase 2
- Blocked on client input: Phase 6
