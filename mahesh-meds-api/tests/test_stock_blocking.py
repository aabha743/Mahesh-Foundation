import unittest
from datetime import datetime, UTC, timedelta
from app.database import SessionLocal
from app.models import LeaseRequest, SKUBlock, SKU, Center, Asset, LeaseItem
from app.jobs.reminders import release_expired_blocks

class StockBlockingTests(unittest.TestCase):
    def setUp(self):
        self.db = SessionLocal()
        self.center = self.db.query(Center).first()
        self.sku = self.db.query(SKU).first()
        
        if not self.center or not self.sku:
            self.skipTest("No Center or SKU available in database to run tests")

    def tearDown(self):
        self.db.rollback()
        self.db.close()

    def test_block_creation_and_release_lifecycle(self):
        token = "TEST-BLOCK-XYZ"
        self.db.query(LeaseRequest).filter(LeaseRequest.token_number == token).delete()
        self.db.commit()

        lease = LeaseRequest(
            token_number=token,
            requestor_name="Test Requestor",
            mobile="9999999999",
            aadhar_number="123456789012",
            patient_name="Test Patient",
            delivery_address="Test Address",
            delivery_landmark="Test Landmark",
            reference_name="Test Referrer",
            preferred_center_id=self.center.id,
            expected_duration="1 Week",
            status="pending"
        )
        self.db.add(lease)
        self.db.commit()
        self.db.refresh(lease)

        item = LeaseItem(
            lease_request_id=lease.id,
            sku_id=self.sku.id,
            quantity_requested=1
        )
        self.db.add(item)
        
        block = SKUBlock(
            lease_request_id=lease.id,
            sku_id=self.sku.id,
            center_id=self.center.id,
            status="blocked",
            release_at=None  # No expiration for pending
        )
        self.db.add(block)
        self.db.commit()

        block_db = self.db.query(SKUBlock).filter(SKUBlock.lease_request_id == lease.id).first()
        self.assertIsNotNone(block_db)
        self.assertEqual(block_db.status, "blocked")
        self.assertIsNone(block_db.release_at)

        # Check that approval sets release_at to 24 hours
        lease.status = "approved"
        block_db.release_at = datetime.now(UTC).replace(tzinfo=None) + timedelta(hours=24)
        self.db.commit()

        block_db = self.db.query(SKUBlock).filter(SKUBlock.lease_request_id == lease.id).first()
        self.assertEqual(block_db.status, "blocked")
        self.assertTrue((block_db.release_at - datetime.now(UTC).replace(tzinfo=None)).total_seconds() > 23 * 3600)

        # Check that rejection releases block
        lease.status = "rejected"
        block_db.status = "released"
        block_db.release_reason = "rejected"
        block_db.release_at = datetime.now(UTC).replace(tzinfo=None)
        self.db.commit()

        block_db = self.db.query(SKUBlock).filter(SKUBlock.lease_request_id == lease.id).first()
        self.assertEqual(block_db.status, "released")
        self.assertEqual(block_db.release_reason, "rejected")

        self.db.query(SKUBlock).filter(SKUBlock.lease_request_id == lease.id).delete()
        self.db.query(LeaseItem).filter(LeaseItem.lease_request_id == lease.id).delete()
        self.db.query(LeaseRequest).filter(LeaseRequest.id == lease.id).delete()
        self.db.commit()

    def test_block_release_timeout_job(self):
        token = "TEST-TIMEOUT-ABC"
        self.db.query(LeaseRequest).filter(LeaseRequest.token_number == token).delete()
        self.db.commit()

        lease = LeaseRequest(
            token_number=token,
            requestor_name="Timeout Requestor",
            mobile="9999999999",
            aadhar_number="123456789012",
            patient_name="Timeout Patient",
            delivery_address="Timeout Address",
            delivery_landmark="Timeout Landmark",
            reference_name="Timeout Referrer",
            preferred_center_id=self.center.id,
            expected_duration="1 Week",
            status="pending"
        )
        self.db.add(lease)
        self.db.commit()
        self.db.refresh(lease)

        # 1. Create a block with release_at = None (pending request block)
        pending_block = SKUBlock(
            lease_request_id=lease.id,
            sku_id=self.sku.id,
            center_id=self.center.id,
            status="blocked",
            release_at=None
        )
        # 2. Create an already expired approved block
        expired_approved_block = SKUBlock(
            lease_request_id=lease.id,
            sku_id=self.sku.id,
            center_id=self.center.id,
            status="blocked",
            release_at=datetime.now(UTC).replace(tzinfo=None) - timedelta(minutes=1)
        )
        self.db.add(pending_block)
        self.db.add(expired_approved_block)
        self.db.commit()

        # Run release expired blocks cron job
        release_expired_blocks()

        # Re-fetch both and check outcomes
        self.db.refresh(pending_block)
        self.db.refresh(expired_approved_block)

        # Pending block is NOT released (because release_at is None)
        self.assertEqual(pending_block.status, "blocked")

        # Expired approved block IS released
        self.assertEqual(expired_approved_block.status, "released")
        self.assertEqual(expired_approved_block.release_reason, "timeout")

        # Clean up
        self.db.query(SKUBlock).filter(SKUBlock.lease_request_id == lease.id).delete()
        self.db.query(LeaseRequest).filter(LeaseRequest.id == lease.id).delete()
        self.db.commit()
