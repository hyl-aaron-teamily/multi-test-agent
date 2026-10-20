// A UI client is one logged-in app instance (Android app on a device, or chat-web in a browser)
// with one conversation open. imui talks to clients only through what a user sees and does.

export type SeenHandler = (token: string, at: number) => void;

export interface UiClient {
  /** Stable id used in metrics, e.g. `android:4f2ebdf2`, `web:test`. */
  readonly id: string;
  readonly kind: 'android' | 'web';
  /** Observation resolution in ms (Android polling); 0 = event-driven. */
  readonly resolutionMs: number;
  /** Observation attempts that failed (Android: UI never idle while animating). */
  readonly idleFailures?: number;
  /** Launch / load and open `conversation`. Resolves when the composer is usable. */
  open(conversation: string): Promise<void>;
  /** Type `text` and press send. Returns host epoch ms of the send press. */
  send(text: string): Promise<number>;
  /** Start reporting first appearance of this run's tokens. */
  startWatch(runId: string, onSeen: SeenHandler): void;
  stopWatch(): Promise<void>;
  /** Extra bubbles beyond one per token currently rendered (duplicate display). */
  duplicates(runId: string): Promise<number>;
  /** Visible conversation names on the client's chat list (discover). */
  listConversations(): Promise<string[]>;
  close(): Promise<void>;
}

/** `android:<udid>@<conversation>` / `web:<env>@<conversation>` (conversation optional). Pure. */
export function parseClientSpec(spec: string): { kind: 'android' | 'web'; ref: string; conversation?: string } {
  const at = spec.indexOf('@');
  const head = at < 0 ? spec : spec.slice(0, at);
  const conversation = at < 0 ? undefined : spec.slice(at + 1).trim() || undefined;
  const [kind, ...rest] = head.split(':');
  if (kind !== 'android' && kind !== 'web') throw new Error(`client "${spec}": kind must be android or web`);
  return { kind, ref: rest.join(':'), conversation };
}
