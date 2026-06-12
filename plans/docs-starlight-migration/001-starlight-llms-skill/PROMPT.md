Autonomous execution of the ralph contract at plans/docs-starlight-migration/001-starlight-llms-skill/.

Every iteration, in order:
1. Read CONTRACT.md and RESUME.md in that folder first.
2. Run §0 preflight. Any check fails → stop, print error, do NOT proceed.
3. Execute the next unchecked §4 task. Delegate code/file writes to `sonnet-implementer` per the CLAUDE.md orchestrator/worker split.
4. Run the task's verify command; update RESUME.md (`attempts:`, done check, files touched) per §8.
5. Honor §5 guardrails, §6 escalation (Opus review on tasks 013/014 before marking done; Opus DIAGNOSE when a task fails verify >= escalate_after), §7 abort.
6. Checkpoint commit per completed task (conventional message + Co-Authored-By trailer).

Emit the §3 completion promise `<promise>ALL ACCEPTANCE MET</promise>` ONLY after the gate is green: every task done, the §2 full gate run, prints `FULL GATE GREEN`, output pasted. NEVER to escape the loop, NEVER on self-assessment.

On the promise turn, also run §11: push the feature branch, then surface the PR offer (`gh pr create` if authed) or the compare URL (if not), targeting base `main`.
