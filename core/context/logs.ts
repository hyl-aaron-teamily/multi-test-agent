// Per-run model logs (W3-2 §1.1, §1.3): while a run is active, every model call it makes — the loop's own, the
// pre-tap check's, the evidence review's — is appended to <runDir>/model-raw.jsonl (raw answer, failure, usage)
// and <runDir>/context-manifest.jsonl (what went into the prompt). Nested scopes restore the outer one.
import { join } from 'node:path';
import { setModelRawLog } from '../model/llm';
import { setContextManifestLog } from './assemble';

export const RAW_LOG = 'model-raw.jsonl';
export const MANIFEST_LOG = 'context-manifest.jsonl';

const stack: string[] = [];

/** Log this run's model calls into `runDir`; call the returned function when the run ends. */
export function useCallLogs(runDir: string): () => void {
  stack.push(runDir);
  const apply = () => {
    const top = stack.at(-1);
    setModelRawLog(top ? join(top, RAW_LOG) : undefined);
    setContextManifestLog(top ? join(top, MANIFEST_LOG) : undefined);
  };
  apply();
  let done = false;
  return () => {
    if (done) return;
    done = true;
    const i = stack.lastIndexOf(runDir);
    if (i >= 0) stack.splice(i, 1);
    apply();
  };
}
