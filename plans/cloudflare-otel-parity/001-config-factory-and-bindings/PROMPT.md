Autonomous execution of the ralph contract at plans/cloudflare-otel-parity/001-config-factory-and-bindings/.

Every iteration, in order:
1. Read CONTRACT.md and RESUME.md in that folder first.
2. Run §0 preflight. Any check fails → stop, print error, do NOT proceed.
3. Execute the next unchecked §4 task. Delegate code writes per the CLAUDE.md orchestrator/worker split (sonnet-implementer writes; you orchestrate + review).
4. Run the task's verify command; update RESUME.md (`attempts:`, done check) per §8.
5. Honor §5 guardrails (additive only, no env auto-detection, no new runtime dep, spans only, key redaction), §6 escalation (Opus on opus-tagged tasks 001/002/003 or attempts >= escalate_after), §7 abort.
6. Checkpoint-commit one commit per completed task.

Emit the §3 completion promise `<promise>ALL ACCEPTANCE MET</promise>` ONLY after the gate is green: every §2 verify command run, all exit 0, output pasted. NEVER to escape the loop, NEVER on self-assessment.

On the promise turn, also run §11: push the feature branch, then surface the PR offer (gh if authed) or the compare URL (if not) targeting base `main`.
