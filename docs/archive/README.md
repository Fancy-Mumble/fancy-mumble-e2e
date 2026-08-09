# Archived handovers

Superseded, kept because other documents still cite them and because they record
*why* things are the way they are. Nothing here describes current work.

| File | Written | Superseded by |
|---|---|---|
| `HANDOFF-e2e-remaining.md` | 2026-07-31 | Targets `vendor/server`, which is obsolete — the suite runs against Starling. Build traps live in `vendor/starling/FLEET-PLAN.md` §10, current status in `E2E-STATUS.md`. |
| `HANDOVER-starling-audit.md` | 2026-07-28 | Moderation fixes + first Starling e2e runs; landed. Current audit status is `E2E-STATUS.md` §3.3. |
| `HANDOVER-audit-opaque.md` | 2026-07-19 | Opaque-plugin audit architecture; landed. Still cited by `vendor/starling/docs/STORAGE.md` for its rationale. |
| `HANDOVER-channel-listeners.md` | 2026-08-02 | Channel listeners in Starling; committed and landed. |

Current, non-archived documents in this directory: the two `SECURITY-AUDIT-*`
files (findings, still the reference for those areas) and `SERVER-COVERAGE.md`
(the murmur-compatibility contract).

The live plan for the e2e effort is `vendor/starling/FLEET-PLAN.md`.
