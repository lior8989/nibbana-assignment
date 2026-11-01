---
name: solid-design-patterns
description: Apply SOLID principles and fitting design patterns to every piece of code that is added, edited, or deleted in this repository. Use on every code change, refactor, and code review.
---

# SOLID & Design Patterns

Every code change (add / edit / delete) must leave the code at least as well
structured as it was. Check the change against each principle below before
proposing it.

## SOLID checklist

- **S — Single Responsibility.** A module/class/function has one reason to
  change. Separate concerns such as: DB access, domain logic (pure
  computation), process orchestration, configuration, and logging.
  Red flag: a function that both queries Postgres *and* computes business
  results *and* handles retries.
- **O — Open/Closed.** Extend behaviour by adding code, not by editing
  stable code. Prefer a map/registry of handlers over growing
  `if/else`/`switch` chains when new variants are expected.
- **L — Liskov Substitution.** Any implementation of an interface must be
  usable wherever the interface is expected, without surprising callers
  (same error semantics, same transactional guarantees).
- **I — Interface Segregation.** Depend on small, focused interfaces. A
  component that only reads should not receive an interface that also
  writes.
- **D — Dependency Inversion.** Domain logic depends on abstractions
  (interfaces / function types), not on `pg` directly. Inject dependencies
  (DB client, clock, logger, worker id) through constructors or parameters
  so they can be replaced in tests.

## Design patterns — use when they fit, never for decoration

Patterns that commonly fit this kind of system:

| Pattern | Typical use |
|---|---|
| Repository | Hide SQL behind a typed interface per aggregate/table group |
| Strategy | Interchangeable handlers per message kind / policy |
| Unit of Work / transaction wrapper | One helper that owns BEGIN/COMMIT/ROLLBACK |
| Factory | Build configured workers / dependencies in one place |
| Template Method / pipeline | Fixed processing loop with pluggable steps |
| Supervisor | Parent process that spawns and monitors child workers |

Rules:
1. Name the pattern in a short doc comment when one is used deliberately,
   so reviewers recognise it.
2. Do not introduce a pattern that has a single trivial implementation and
   no foreseeable second one — a plain function is better.
3. Keep pure logic pure: functions that transform data must not perform I/O,
   which makes them trivially unit-testable.

## Before finishing a change

- [ ] Each new/changed unit has one clear responsibility.
- [ ] Dependencies are injected, not imported-and-called from deep inside logic.
- [ ] No duplicated logic that should be shared.
- [ ] Any pattern used is justified (see the `design-performance-balance` skill).
