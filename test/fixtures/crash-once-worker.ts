// Test fixture worker: the first attempt of slot 0 crashes, every other start exits 0.
const crash = process.env.WORKER_SLOT === '0' && process.env.WORKER_ATTEMPT === '0'
process.exit(crash ? 3 : 0)
