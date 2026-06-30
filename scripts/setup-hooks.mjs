// Point git at the repo's tracked hooks (.githooks/) so the pre-commit secret
// scanner runs for everyone, without each clone having to wire it up by hand.
// Runs from `postinstall`; a no-op outside a git checkout (e.g. release tarball).
import { execFileSync } from 'node:child_process';

try {
  execFileSync('git', ['config', 'core.hooksPath', '.githooks'], { stdio: 'ignore' });
  console.log('Configured git core.hooksPath -> .githooks');
} catch {
  // Not a git working copy, or git unavailable — nothing to wire up.
}
