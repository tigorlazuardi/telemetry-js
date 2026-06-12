Autonomous execution of the ralph contract at plans/browser-lazy-facade/001-facade-lazy-swap/.

Every iteration, in order:
1. Read CONTRACT.md and RESUME.md in that folder first.
2. Run §0 preflight. Any check fails → stop, print error, do NOT proceed.
3. Execute the next unchecked §4 task. Delegate code writes per the CLAUDE.md orchestrator/worker split (sonnet-implementer for code).
4. Run the task's verify command; update RESUME.md (`attempts:`, done check) per §8.
5. Honor §5 guardrails, §6 escalation (Opus on opus-tagged tasks 006/007, on any public-API/entrypoint/package.json-exports diff, or attempts >= escalate_after), §7 abort.
6. Checkpoint-commit per completed task.

Hard invariants (from the design — do not drift):
- Eager `src/browser/index.ts` facade has ZERO `@opentelemetry/*` static import. Heavy SDK only via `await import()`.
- `initSDK(config): Promise<SDKResult>` — async, idempotent, internal dynamic import + impl swap; failure → passthrough + noopSDKResult.
- Pre-init API passes through synchronously (wrappers run fn return T; logger silent). Keep withAction/scopeAction/traced/withTrace SYNCHRONOUS.
- `dev` gates console only; endpoint gates OTLP only; independent. Pre-init logger silent.
- Do NOT touch fetch/* or react/* behaviour, or node/cloudflare/bun adapters.

Emit the §3 completion promise `<promise>ALL ACCEPTANCE MET</promise>` ONLY after the gate is green: every §2 verify command run, all exit 0, output pasted. NEVER to escape the loop, NEVER on self-assessment.

On the promise turn, also run §11: push the feature branch, then surface the PR/MR offer (gh/glab if authed) or the compare URL (if not) targeting base `main`.
