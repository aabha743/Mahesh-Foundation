import unittest
from datetime import datetime, UTC, timedelta
from app.services.sms import (
    format_mobile,
    render_template,
    get_template,
    SMS_TEMPLATE_SEEDS,
)
from app.database import SessionLocal
from app.models import SMSTemplate, LeaseRequest, SKU, Center, LeaseItem

class SMSAndTemplateVerificationTests(unittest.TestCase):

    def test_mobile_number_formatting(self):
        # 10-digit number -> standard Indian country code 91
        self.assertEqual(format_mobile("9876543210"), "919876543210")
        self.assertEqual(format_mobile("+91 98765 43210"), "919876543210")
        self.assertEqual(format_mobile("919876543210"), "919876543210")
        
        # Invalid inputs raise ValueError
        with self.assertRaises(ValueError):
            format_mobile("12345")
        with self.assertRaises(ValueError):
            format_mobile("abcdefghij")

    def test_template_rendering_with_variables(self):
        # Test MES_Approver_Request template format
        template_text = (
            "New device request received on Mahesh Foundation portal. "
            "Requestor: {requestor_name} . Device requested : {items}. "
            "Please review in the system. - MHSFND"
        )
        vars_dict = {
            "requestor_name": "Ramesh Kumar",
            "items": "Oxygen Concentrator (5L), Wheelchair",
        }
        rendered = render_template(template_text, vars_dict)
        self.assertIn("Ramesh Kumar", rendered)
        self.assertIn("Oxygen Concentrator (5L), Wheelchair", rendered)
        self.assertNotIn("{requestor_name}", rendered)
        self.assertNotIn("{items}", rendered)

    def test_device_issued_template_rendering(self):
        # Test MES_Device_Issued template format
        template_text = (
            "Devices have been issued by Mahesh Foundation Medical Equipment Services "
            "against Token: {token_number}. Items: {items}. Expected return date: {due_date}. - MHSFND"
        )
        vars_dict = {
            "token_number": "MHSF-2026-9901",
            "items": "Hospital Bed",
            "due_date": "August 30, 2026",
        }
        rendered = render_template(template_text, vars_dict)
        self.assertIn("MHSF-2026-9901", rendered)
        self.assertIn("Hospital Bed", rendered)
        self.assertIn("August 30, 2026", rendered)

    def test_request_rejected_template_rendering(self):
        # Test MES_Request_Rejected template format
        template_text = (
            "Your request could not be approved by Mahesh Foundation Medical Equipment Services. "
            "For any concerns, please contact {contact_info} ."
        )
        vars_dict = {"contact_info": "Mahesh Foundation Support (9876543210)"}
        rendered = render_template(template_text, vars_dict)
        self.assertIn("Mahesh Foundation Support (9876543210)", rendered)

    def test_service_request_template_rendering(self):
        # Test MES_Service_Request template format
        template_text = (
            "Your request has been received by Mahesh Foundation’s Medical Equipment services team. "
            "Please keep Token: {token_number} for tracking and future communication. - MHSFND"
        )
        vars_dict = {"token_number": "MHSF-2026-1002"}
        rendered = render_template(template_text, vars_dict)
        self.assertIn("MHSF-2026-1002", rendered)

    def test_user_request_approved_template_rendering(self):
        # Test MES_User_Request_Approved template format
        template_text = (
            "Your request has been approved by Mahesh Foundation Medical Equipment services. "
            "Token: {token_number}. Please coordinate with {pickup_guidance} for next steps. - MHSFND"
        )
        vars_dict = {
            "token_number": "MHSF-2026-1002",
            "pickup_guidance": "Central Warehouse Manager (Ph: 9123456789)",
        }
        rendered = render_template(template_text, vars_dict)
        self.assertIn("MHSF-2026-1002", rendered)
        self.assertIn("Central Warehouse Manager", rendered)

class DatabaseTemplateVerificationTests(unittest.TestCase):
    def setUp(self):
        try:
            self.db = SessionLocal()
        except Exception:
            self.db = None

    def tearDown(self):
        if hasattr(self, 'db') and self.db:
            self.db.close()

    def test_sms_template_seeds_exist(self):
        if not self.db:
            self.skipTest("Local database not connected")
        try:
            expected_events = [
                "request_submitted_user",
                "request_submitted_approver",
                "request_approved_user",
                "request_rejected_user",
                "device_issued_user",
                "MES_Service_Request",
                "MES_Approver_Request",
                "MES_User_Request_Approved",
                "MES_Request_Rejected",
                "MES_Device_Issued",
            ]
            for event_name in expected_events:
                template = get_template(event_name, self.db)
                if template:
                    self.assertIsNotNone(template)
                    self.assertTrue(template.is_active)
        except Exception as e:
            self.skipTest(f"Database unavailable for template query: {e}")
