// Loaded before every test file (`node --test --import`): machine-wide plugin state goes to a
// throwaway folder, never the developer's real one.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.ORCA_CLOUDFLARE_RELAY_STATE_DIR = mkdtempSync(join(tmpdir(), 'orca-cf-state-'))
