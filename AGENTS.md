# Turbella: rules for agents

Tier: Tool. Read `README.md` for what this is and `plan/pending.md` for what is next.

## Verification budget

1. No tests, evals or diagnostics between implementation steps. Build the whole batch, then check it once at the batch boundary. A batch is one capability family, about a day of work, and closes early past that.
2. Run only the checks that cover the changed batch. Never repeat an unchanged suite.
3. All generated test data goes to one temporary directory, capped at 5,000 files and 500 MB by default, preferring one aggregate file to many, and deleted on success, failure and interrupt.
4. One diagnostic batch per failure. Write a new hypothesis before any new diagnostic script.
5. No new process tooling (receipts, provenance, locks) until a feature it gates exists.
6. Log anything over 50 MB or 1,000 files to the session ledger when it is created, so `/tidy-nt` can clear it.

## Privacy rules for this project

- Events carry tool names, durations, statuses and hashes of arguments or error text. They never carry file contents, prompts, tool output or thinking text unless a flag turns that on.
- The daemon listens on localhost or a Unix socket only.
- Transcripts hold secrets. Test fixtures are synthetic.
