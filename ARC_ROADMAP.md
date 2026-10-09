# ARC roadmap — at a glance

**Revised:** 2026-10-08, at repository version `1.34.0`.

The roadmap itself is
[docs/architecture/ARC_IMPLEMENTATION_ROADMAP.md](docs/architecture/ARC_IMPLEMENTATION_ROADMAP.md).
It is the one the console's Roadmap Assistant reads, and it holds the card for every step
below. This page is only the order.

**Direction:** simple automations first. One HVAC company, one phone line, missed calls texted
back, every step shown in a proof ledger. The CRM track and the other complex work are paused,
not deleted.

**Done:** `ARC-MK-100` (`1.34.0`), `ARC-MK-110` (`1.35.0`), `ARC-MK-120` (`1.36.0`), `ARC-MK-200` (`1.37.0`), `ARC-MK-210` (`1.38.0`), `ARC-MK-220` (`1.39.0`). **Drafted:** `ARC-MK-130` (pilot numbers to agree). **Mapped:** `ARC-GO-300` ([the readiness map](docs/architecture/ARC_LEAD_RECOVERY_READINESS.md)). **Next:** `ARC-GO-310`.

| Phase | ID | Step |
|---|---|---|
| 1. A clear offer | `ARC-MK-100` | Public site offer rewrite |
| | `ARC-MK-110` | Missed-call count intake |
| | `ARC-MK-120` | Proof ledger demo |
| | `ARC-MK-130` | Sales assets and pilot terms |
| 2. The owner portal | `ARC-MK-200` | Four-screen owner portal |
| | `ARC-MK-210` | Proof ledger events and counting rules |
| | `ARC-MK-220` | Owner outcome answers and disputes |
| 3. Missed-call text-back, live | `ARC-GO-300` | Lead Recovery readiness map |
| | `ARC-GO-310` | Close the readiness gaps |
| | `ARC-GO-320` | Safety test pass |
| | `ARC-GO-330` | Live backend and real telephony |
| | `ARC-GO-340` | First HVAC pilot |
| 4. The next automations | `ARC-AUTO-400` | Quiet estimate follow-up |
| | `ARC-AUTO-410` | Review requests |
| | `ARC-AUTO-420` | Come-back reminders (blocked on consent records) |

Built already: the whole platform, `ARC-000` to `ARC-390`.  
Paused: `ARC-395`, the old `ARC-LR-*` and `ARC-OPT-*` steps, CRM connectors, the n8n bridge.
The canonical file says what replaced each one.
