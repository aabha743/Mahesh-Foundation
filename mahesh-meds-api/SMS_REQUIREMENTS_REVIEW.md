# SMS Requirements Review

This document summarizes the proposed SMS events, draft template copy, and the remaining client inputs needed before implementation.

## Goal

SMS is planned for more than OTP. The system will use SMS for:

- Request submission confirmation
- Request review notifications
- Approval / rejection updates
- Device issue confirmation
- Return reminders
- Overdue alerts
- Staff OTP login

The recommended implementation is a shared SMS/notification layer, not an OTP-only setup.

## Gateway Details Received

Provider details currently available:

- SMS Gateway Provider: BulkSMS Apps
- Username: `oz07-hostello`
- Sender ID: `MHSFND`
- Base URL: `http://www.bulksmsapps.com/api/apismsv2.aspx?apikey=a620ec90-84b6-4bc5-b28d-21303df51b49&`

Likely required parameters:

- `apikey`
- `user`
- `password`
- `sender`
- `number`
- `message`
- `coding`
- `templateid`
- `peid`

Example format:

```text
http://www.bulksmsapps.com/apismsv2.aspx
?apikey=...
&user=...
&password=...
&sender=MHSFND
&number=91XXXXXXXXXX
&message=URL_ENCODED_TEXT
&coding=1
&templateid=...
&peid=...
```

## Important Missing Gateway Inputs

These are still required before production SMS can be completed:

- SMS gateway password
- DLT Principal Entity ID (`peid`)
- DLT Template ID for each SMS type
- Confirmation of exact provider response format for success / failure
- Confirmation whether `password` is mandatory when `apikey` is already present

## Product Rules Confirmed

- Public screens should keep requestor mobile numbers masked
- Staff screens should show full requestor mobile numbers
- New request notifications go to:
  - requestor
  - all approvers
- Approved request notifications go to:
  - requestor
  - all center managers of the relevant center
- Rejected request notifications go to:
  - requestor only
- Device issue notification goes to:
  - requestor only
- Return reminders go to:
  - requestor at 7, 3, and 1 day before due date
- Overdue notifications go to:
  - requestor at day 1, day 3, and day 7 overdue
  - center managers daily
  - master admins daily after 7+ overdue days
- Transfer notifications go to:
  - both source and destination center managers on dispatch
  - both source and destination center managers on receive
- If a center has multiple center managers, all should receive the relevant SMS
- If there are multiple approvers, all approvers should receive new request SMS

## Recommended Design

Recommended implementation approach:

- Use DB-backed SMS templates from day one
- Use a dedicated SMS log table for sent / failed messages
- Keep OTP and transactional SMS in the same shared notification layer
- Keep template wording flexible, especially for rejection messages where a reason may or may not be included

## Draft SMS Events

Initial event set proposed:

- `otp_login`
- `request_submitted_user`
- `request_submitted_approver`
- `request_approved_user`
- `request_approved_center_manager`
- `request_rejected_user`
- `device_issued_user`
- `return_reminder_7d`
- `return_reminder_3d`
- `return_reminder_1d`
- `overdue_user_day_1`
- `overdue_user_day_3`
- `overdue_user_day_7`
- `overdue_center_manager_daily`
- `overdue_master_admin_daily_after_7d`

## Draft Template Copy

### 1. OTP Login

`Your Mahesh Foundation OTP is {otp}. It is valid for 5 minutes. Do not share it with anyone. - MHSFND`

### 2. Request Submitted - User

`Your request has been received by Mahesh Foundation. Token: {token_number}. Please keep this token for tracking and future communication. - MHSFND`

### 3. Request Submitted - Approver

`New device request submitted. Token: {token_number}. Requestor: {requestor_name}. Preferred center: {center_name}. Please review in the system. - MHSFND`

### 4. Request Approved - User

`Your request has been approved by Mahesh Foundation. Token: {token_number}. Please coordinate with {center_name} for next steps. - MHSFND`

### 5. Request Approved - Center Manager

`Approved request requires center action. Token: {token_number}. Requestor: {requestor_name}. Please review fulfillment planning in the system. - MHSFND`

### 6. Request Rejected - User

Without reason:

`Your request could not be approved by Mahesh Foundation. Token: {token_number}. For support, please contact the center. - MHSFND`

With reason:

`Your request could not be approved. Token: {token_number}. Reason: {rejection_reason}. For support, please contact the center. - MHSFND`

### 7. Device Issued - User

`Devices have been issued against Token: {token_number}. Items: {device_list}. Expected return/due date: {due_date}. - MHSFND`

### 8. Return Reminder - 7 Days

`Reminder: Devices for Token: {token_number} are due on {due_date}. Please plan return with the center. - MHSFND`

### 9. Return Reminder - 3 Days

`Reminder: Devices for Token: {token_number} are due on {due_date} in 3 days. Please arrange return. - MHSFND`

### 10. Return Reminder - 1 Day

`Reminder: Devices for Token: {token_number} are due tomorrow ({due_date}). Please return them to the center. - MHSFND`

### 11. Overdue - User Day 1

`Devices for Token: {token_number} are overdue by 1 day. Please contact {center_name} and arrange return immediately. - MHSFND`

### 12. Overdue - User Day 3

`Devices for Token: {token_number} are overdue by 3 days. Please return them or contact {center_name} urgently. - MHSFND`

### 13. Overdue - User Day 7

`Urgent: Devices for Token: {token_number} are overdue by 7 days. Please contact {center_name} immediately and arrange return. - MHSFND`

### 14. Overdue - Center Manager Daily

`Overdue alert. Token: {token_number}. Requestor: {requestor_name}. Mobile: {requestor_mobile}. Overdue by {days_overdue} day(s). Please follow up. - MHSFND`

### 15. Overdue - Master Admin Daily After 7 Days

`Escalation: Token {token_number} is overdue by {days_overdue} day(s). Center: {center_name}. Requestor: {requestor_name}, Mobile: {requestor_mobile}. - MHSFND`

## Template Variables

Common placeholders expected:

- `{otp}`
- `{token_number}`
- `{requestor_name}`
- `{requestor_mobile}`
- `{center_name}`
- `{from_center}`
- `{to_center}`
- `{device_list}`
- `{due_date}`
- `{days_overdue}`
- `{rejection_reason}`

## Open Questions For Client

Please confirm the following before implementation:

### Gateway / DLT

1. What is the SMS gateway password?
2. What is the DLT Principal Entity ID (`peid`)?
3. What is the approved DLT Template ID for each SMS message type?
4. Does BulkSMS Apps require both `apikey` and `password`, or is `apikey` alone sufficient?
5. What exact response format does the gateway return on success and failure?
6. Should `coding=1` always be used, or will any templates require Unicode (`coding=3`)?

### Message Content

7. Should rejection SMS include the rejection reason when available?
8. Should device issue SMS list all devices, or use a generic message when multiple items exist?
9. Is there any preferred support phone number or helpline that should be included in rejection / overdue templates?
10. Should any SMS include the center contact number directly?

### Notification Policy

11. For new request notifications, should all approvers across the system receive SMS, or only approvers associated with the preferred center?
12. For approval notifications, should all center managers at that center receive SMS?
13. For overdue alerts to master admins, should they receive:
    - one SMS per overdue token, or
    - a daily summary SMS?
14. For center manager overdue alerts, should they receive:
    - one SMS per overdue token daily, or
    - a daily summary SMS?
15. For requestor overdue alerts, is the planned cadence of day 1, day 3, and day 7 correct?

### Transfer Flow

17. On dispatch and receive, should both source and destination center managers receive SMS?

### Operations / Data

19. Should SMS templates be managed in the database so they can be updated without code deployment?
20. Should every sent SMS be stored in a dedicated SMS log table for tracking and troubleshooting?
21. Should failed SMS be retried automatically in future versions?

## Implementation Recommendation

Recommended order after client confirmation:

1. Finalize approved SMS event list
2. Finalize template wording and placeholders
3. Collect DLT template IDs and PE ID
4. Build DB tables for:
   - SMS templates
   - SMS message log
5. Integrate gateway sending
6. Wire OTP and immediate transactional events
7. Add scheduled reminders and overdue alerts
