// Worker process entry point (one of the 4 OS processes started by src/main.ts).
// Placeholder: the processing loop is implemented in the next branch (feat/work-coordination).
const slot = process.env.WORKER_SLOT ?? '?'
console.log(`[worker ${process.pid}] slot ${slot} started — no processing loop yet, exiting`)
