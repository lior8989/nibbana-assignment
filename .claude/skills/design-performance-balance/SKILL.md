---
name: design-performance-balance
description: Balance clean design (SOLID / design patterns) against performance, and prefer the simplest solution that is correct. Use on every code change, refactor, and code review, together with the solid-design-patterns and performance skills.
---

# Balance: Design vs. Performance vs. Simplicity

The `solid-design-patterns` and `performance` skills pull in different
directions. Neither wins automatically. Apply this order of priorities:

1. **Correctness first.** Neither elegant structure nor speed justifies a
   change that weakens a correctness guarantee.
2. **Simplicity.** If a simple solution solves the problem, use it. Do not
   add abstractions, layers, patterns, caches, or micro-optimisations that
   are not needed *now* or clearly needed *soon*.
3. **Design vs. performance trade-off:**
   - If following a SOLID rule or pattern would cost real performance
     (e.g. an abstraction forces N extra queries, extra copies of large
     data, or prevents batching) → **don't force the design**; choose the
     efficient form and keep it readable and documented.
   - If an optimisation would seriously hurt the design (tight coupling,
     duplicated logic, untestable code) for a gain that is small or
     unmeasured → **don't force the optimisation**.
   - Optimise only what is measurably or obviously hot (DB round trips in
     the processing loop, lock duration, memory per item). Elsewhere,
     favour clarity.

## Decision heuristics

- "Would a reviewer understand this in one read?" If not, simplify.
- "Is there a second implementation of this interface today or planned?"
  If not, an interface/pattern is probably premature.
- "Is this measurably slow, or am I guessing?" Measure or reason concretely
  before optimising.
- Three similar lines are better than a premature abstraction.

## Documenting a trade-off

When a trade-off is made deliberately, leave a one- or two-line comment at
the spot explaining *what was traded for what* — e.g.
`// Inlined instead of using the repository: saves one round trip per message on the hot path.`
Significant trade-offs also belong in DESIGN.md.
