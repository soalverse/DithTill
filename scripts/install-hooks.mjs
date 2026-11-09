// Installs the DithTill git pre-commit quality gate: every commit must
// pass `verify:precommit` (typecheck + lint + format + test) so broken code never
// lands. .git/hooks is local (not version-controlled), so this script reproduces
// the hook — run `npm run install-hooks` after cloning. It only writes pre-commit;
// the workspace dash's post-checkout/commit/merge hooks are left untouched.
import { writeFileSync, chmodSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const HOOK = join('.git', 'hooks', 'pre-commit');
const BODY = `#!/bin/sh
# DithTill quality gate — installed by scripts/install-hooks.mjs.
# Runs the fast verify (typecheck + lint + format + test) before each commit.
# Emergency bypass:  DITHTILL_SKIP_VERIFY=1 git commit ...
if [ "$DITHTILL_SKIP_VERIFY" = "1" ]; then exit 0; fi
echo "[pre-commit] npm run verify:precommit"
npm run verify:precommit || {
  echo "[pre-commit] FAILED — commit aborted. Fix the gate, or set DITHTILL_SKIP_VERIFY=1 to bypass."
  exit 1
}
`;

if (!existsSync('.git')) {
  console.error('install-hooks: no .git directory here — run from the repo root.');
  process.exit(1);
}
writeFileSync(HOOK, BODY, 'utf8');
try {
  chmodSync(HOOK, 0o755);
} catch {
  /* chmod is a no-op / unsupported on some platforms; the shebang still runs under git's sh */
}
console.log('install-hooks: wrote .git/hooks/pre-commit (verify:precommit gate)');
