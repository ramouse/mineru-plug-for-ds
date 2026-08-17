// Package root entry — the harness's internal loader resolves a bare package
// name to <dir>/index.js (it does not honor package.json exports/main), so
// the host plugin re-exports from here.
export { apply, inject, name } from './lib/entry.js'
