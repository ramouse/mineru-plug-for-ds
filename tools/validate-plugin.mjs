// Regression guard: every tool's `parameters` MUST be a JSON-Schema object
// with a `type: 'object'` root — the real tool registry passes it through
// verbatim and the DeepSeek API rejects a missing root type, which fails the
// whole turn. Run: node tools/validate-plugin.mjs
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const src = readFileSync(fileURLToPath(new URL('../packages/mineru-plugin/lib/entry.js', import.meta.url)), 'utf8')
const toolCount = (src.match(/ctx\.tools\.register\(/g) || []).length
const objectShaped = (src.match(/parameters:\s*\{\s*type:\s*'object'/g) || []).length
const emptyShaped = (src.match(/parameters:\s*\{\s*\}/g) || []).length
const pass = toolCount > 0 && objectShaped === toolCount && emptyShaped === 0
console.log(`tools=${toolCount} object-shaped=${objectShaped} empty-shaped=${emptyShaped} -> ${pass ? 'OK' : 'FAIL'}`)
process.exit(pass ? 0 : 1)
