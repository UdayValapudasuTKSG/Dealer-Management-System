---
name: Reopened service work
description: Booking lifecycle and urgent technician follow-up when service work is reopened.
---
Reopening a job card must also reactivate its linked booking, clear its pickup timestamp, and create urgent technician follow-up. Finishing all job cards returns the booking to resolved, not automatically picked up/closed.

**Why:** The user reported bookings left in the wrong state after reopening and requested urgent action plus a technician reminder to keep job cards current.

**How to apply:** Keep job, booking and urgent-task changes atomic, retain paid-invoice and cancelled-booking protections, and clear urgent follow-up when the job becomes terminal. Technician notices are in-app; do not assume authorization for external WhatsApp broadcasts.
