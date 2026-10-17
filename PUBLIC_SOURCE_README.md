# ScopeProof

ScopeProof helps a static-site freelancer and client agree what “done” means, review delivery evidence and pay for one exact source version. This is a local single-merchant hackathon prototype: React, TypeScript, Node.js, SQLite and PayPal Orders v2.

**Start with [JUDGE_SETUP.md](JUDGE_SETUP.md)** for credential-free Windows/POSIX setup and the full UI journey. [EVIDENCE.md](EVIDENCE.md) separates controlled tests, saved live AI and historical sandbox evidence from unmeasured human benefit. [BUILD_VERIFICATION.json](BUILD_VERIFICATION.json) records fresh-extraction checks; overlapping suites must not be added together.

## Workflow

1. Record the brief and fixed USD price. Gemini drafts exact quotations and unanswered questions; manual drafting also works.
2. Both parties correct and explicitly confirm the same scope version. Scope edits require fresh confirmations.
3. Upload immutable static ZIP versions. A restricted browser observes text, destinations, decoded raster images and horizontal overflow in sanitized content.
4. The client reviews evidence/design. Acceptance pins scope, artifact/hash and server-stored price.
5. A human buyer approves the PayPal sandbox order. The server verifies seller, amount, order and completed capture before source delivery. UNKNOWN stays locked and allows retrieval only.
6. Later v3 cannot replace accepted v2 or its download entitlement.

AI cannot accept work, decide payment, invent missing literal values or silently modify confirmed scope. Four screens cover setup, agreement, review/payment and receipt.

## Evidence and limits

Fresh extraction verification: build passed; the full suite passed **129/129 on rerun** and browser-unavailable checks passed **112/112**, with no skips. The initial full run was 128/129: its first browser asset check returned review-required. The cause is unconfirmed; its focused rerun passed without source, timeout or expectation changes. The initial failure remains in BUILD_VERIFICATION.json. Suites overlap and are not live provider evaluations.

The current compiler includes the literal-grounding prompt repair and regressions. The prior incident's 45 controlled compiler checks were mocked responses, not 45 model evaluations. A saved seven-row live draft preserved grounding and scope; one success is not a reliability estimate. Historical validation completed one USD 1.00 PayPal sandbox capture and exact v2 download with v3 present. Test funds are not real money. No real incoming webhook is demonstrated.

The separate clean recording is **2:28.48**, silent, with pointer movement and no captions/added text. It shows saved live Gemini, a distinct LOCAL_TEST journey and an existing sandbox receipt read-only. It records no fresh generation or PayPal approval/capture. Its video/public URL is a separate submission asset, not embedded or linked to a nonexistent file here.

Human usefulness, demand, time saving and production readiness remain unmeasured. Earlier separate-Linux-VM AI evaluation was PARTIAL with substitute-browser/install limits. Fresh-folder checks here use the same Windows host, not another physical computer. **Change-request triage was DISCARDED** after misleading evidence support in a synthetic diagnostic; it is not shipped. The differentiator is this agreement-to-exact-source-purchase workflow, not a first-ever claim or new verification algorithm.

Only root-index HTML/CSS/raster ZIPs are supported. Scripts/external assets are stripped from preview. Static observations do not prove booking functionality, source-site behavior or design quality. Browser failure yields review-required, never fabricated PASS. Link holders have role access, not verified identity. Keep full seller links/storage private; one process owns a data directory. This is not escrow, multi-tenant hosting or chargeback prevention. Copies/downloads cannot be revoked.

Narrow abandoned-checkout recovery requires trusted server-only lifetime non-submission evidence and exclusive runtime control. Cancel/404 is insufficient; UNKNOWN history never becomes another capture. Unresolved create retries retain keys and stop at six hours.

## Source and license

[EXPORT_NOTES.md](EXPORT_NOTES.md) explains scope/integrity. Source is [MIT licensed](LICENSE). [DEPENDENCY_NOTICES.json](DEPENDENCY_NOTICES.json) identifies dependency licenses; direct notices are under licenses/. Actual .env, private data, work, node_modules and dist are excluded. Packaging does not publish or submit anything.
