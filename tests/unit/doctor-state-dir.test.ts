import { describe, expect, it } from 'vitest';

import {
  type DoctorConnectorEntry,
  annotateCodexStateDir,
  renderDoctorReport,
} from '../../src/cli/doctor.js';
import { terminalPalette } from '../../src/cli/terminal-style.js';
import type { ConnectorHealthCheck } from '../../src/connectors/health.js';

// Doctor's codex section carries the state-directory writability probe: the
// sandboxed-session failure class where codex is installed and signed in but
// cannot write ~/.codex from this environment. The diagnosis sentence is the
// same one run intake and the mid-run interpreter use.

const okCodex: ConnectorHealthCheck = {
  connector: 'codex',
  executable: 'codex',
  state: 'ok',
  detail: 'codex-cli 1.2.3; Logged in using ChatGPT',
};

describe('annotateCodexStateDir', () => {
  it('appends a writable line when the state directory takes a real write', () => {
    const annotated = annotateCodexStateDir(okCodex, { writable: true, dir: '/Users/op/.codex' });
    expect(annotated.state).toBe('ok');
    expect(annotated.detail).toContain('state directory is writable (/Users/op/.codex)');
  });

  it('flags an unwritable state directory with the shared sandbox diagnosis', () => {
    const annotated = annotateCodexStateDir(okCodex, {
      writable: false,
      dir: '/Users/op/.codex',
      detail: 'EROFS: read-only file system',
    });
    expect(annotated.state).toBe('needs_attention');
    expect(annotated.detail).toContain('could not write state directory (/Users/op/.codex)');
    expect(annotated.remediation).toContain('setup problem, not a task failure');
    expect(annotated.remediation).toContain('sandboxed session');
  });

  it('leaves non-codex and already-failing checks untouched', () => {
    const claude: ConnectorHealthCheck = { ...okCodex, connector: 'claude-code' };
    expect(annotateCodexStateDir(claude, { writable: false, dir: '/x', detail: 'nope' })).toEqual(
      claude,
    );
    const broken: ConnectorHealthCheck = { ...okCodex, state: 'needs_attention' };
    expect(annotateCodexStateDir(broken, { writable: false, dir: '/x', detail: 'nope' })).toEqual(
      broken,
    );
  });
});

describe('renderDoctorReport environment note', () => {
  it('says the checks reflect the environment doctor ran in', () => {
    const entries: DoctorConnectorEntry[] = [{ ...okCodex, chosen: true, chosen_by: ['auto'] }];
    const report = renderDoctorReport(terminalPalette(false), entries);
    expect(report).toContain('environment doctor ran in');
  });
});
