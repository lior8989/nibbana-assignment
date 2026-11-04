# AI usage

I used **Claude Code** (model Claude Opus 5.5) in VS Code for the whole assignment. This
file describes honestly what it did, what I did, and where it went wrong.

## How I set it up

- Before any code, I had the AI create **project skills** (`.claude/skills/`) and a
  `CLAUDE.md` that apply to every change: SOLID and design patterns, performance, a balance
  rule (correctness first, then simplicity — don't force patterns or optimisations),
  testing for everything, and documentation.
- I required **one branch per task**. The AI had to show me the changes and test results
  before every commit, and could commit, push, open the PR, and merge only after my
  approval. The 6 PRs in the history are that process.

## What I did

- **Learned the domain by questioning the AI** step by step: what a snapshot and a delta
  contain, why `seq` exists, what is (and isn't) in the spec about the store side and the
  infrastructure, how the seed reaches Postgres, and the tables.
- **Proposed design directions**, several of which were kept:
  - one transaction per message (stock update + log row together);
  - the lock must be per store and must live in Postgres, since the workers are separate
    processes;
  - a claims table with a lease, and the processing loop in worker code (not a stored
    procedure);
  - several stores processed concurrently in each worker;
  - a supervisor that restarts a crashed worker.
- **Had my wrong ideas corrected** — useful learning, listed here because it shaped the design:
  - finding unapplied messages by joining on `chain_id + store_id` (that key is per store,
    not per message);
  - using `GROUP BY` to process each store's messages (it aggregates, it doesn't iterate);
  - thinking `await` coordinates the workers (it only orders work inside one process; I
    also had the .NET thread-pool model in mind, while Node runs on one event loop);
  - scaling the number of workers by load (the spec requires exactly 4).
- **Confirmed the open business assumption**: in a delta that both sets and unsets the same
  item, the unset wins.
- **Reviewed and approved every branch** before it was committed.

## What the AI did

Because I was short on time, I **delegated the rest to the AI**:

- **Risk identification and the final design decisions** — it read `seed.js`, queried the
  seeded data, and produced the risk list and the rules in `DESIGN.md`, which I reviewed.
- **All code and tests**: migrations, supervisor, worker loop, SQL, domain rules, the
  `verify` reconciliation, and the chaos suite.
- **Environment setup**: installed Docker Desktop and the GitHub CLI, ran Postgres and the seed.
- **Drafted `DESIGN.md` and this file** at my request; I reviewed them.

## Understanding the generated code

Since the AI wrote the code, I needed to understand it well enough to explain and extend
it myself. I considered asking for an animated video walkthrough, but chose a cheaper,
more direct route: a **question-by-question walkthrough in my native language (Hebrew)**,
folder by folder in dependency order, with short explanations of what each file does and
which requirement it serves:

1. **`config`, `db`, `migrations`** — connection pool, the transaction helper (all-or-nothing
   writes), the migration runner (additive schema changes, since `schema.sql` is read-only),
   and what each added column, index, and table is for.
2. **`domain`** — the pure rules: `applyUpdate` (snapshot replaces, delta set-then-unset) and
   `decideNext` (apply / discard / wait / skip-to-snapshot / blocked), and why the same rules
   also exist in SQL.
3. **`worker`** — all SQL in one module, one message per transaction with the lease fence,
   and the scheduling loop (8 stores per worker, release a store that must wait, exit when
   no work is left).
4. **`supervisor` and entry points** — exactly 4 slots, restart on crash, `spawn` instead of
   `fork` (no IPC), migrations before workers, and the exit codes.

I stopped the walkthrough there; `verify`, the chaos scripts, and the tests I know from
their results and from `DESIGN.md` §4 rather than line by line.

## Where the AI got it wrong

All of these were caught by the AI's own test runs and checks during development, before
the code reached me for review:

1. **Wrong test, not wrong code.** Its first version of a test helper never released the
   store's claim, so a test that processes the same store twice failed. It traced the
   failure to the helper and fixed it.
2. **IPC channel against the spec.** It first started workers with `child_process.fork`,
   which always opens an IPC channel, although the spec allows only Postgres between
   workers. It switched to `spawn` before the commit.
3. **Toolchain config.** Its first `tsconfig.json` didn't load the Node types (TypeScript 7
   no longer includes them automatically), so the first typecheck failed.
4. **Tooling.** A PR description was split by PowerShell's argument quoting; it re-sent the
   description through a file.

Lesson for me: the AI's confidence is not evidence. What made me trust the result was the
independent checks — `npm run verify` against a naive replay, and the chaos runs that kill
processes — not the AI saying it was done.
