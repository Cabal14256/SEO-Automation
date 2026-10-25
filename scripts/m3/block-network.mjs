// Acceptance adapters inject their transport. Any accidental default HTTP call
// must fail before it can reach an external service.
globalThis.fetch = async () => { throw new Error('Default HTTP transport is disabled in isolated M3/M2 regression'); };
