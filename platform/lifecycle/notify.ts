// Task-finished notifications (W2-4 §5.3): one line per finished top-level task in
// platform/state/notifications.ndjson (an IDE agent or a person can tail it); optional Windows toast when
// AUTOTEST_DESKTOP_NOTIFY=1 (off by default). Never blocks or fails the state change.
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { appendLine, stateRoot } from './store';
import type { TaskRecord } from './task';

export const notificationsFile = () => join(stateRoot(), 'notifications.ndjson');

export interface Notification {
  at: string;
  task: string;
  issue?: string;
  planId?: string;
  state: string;
  code?: string;
  summary?: string;
  endedBy?: string;
}

/** Pure: the notification line for a finished task (undefined for series children: their parent reports). */
export function notificationOf(t: TaskRecord): Notification | undefined {
  if (t.parent) return undefined;
  return { at: t.finishedAt ?? new Date().toISOString(), task: t.id, issue: t.issue, planId: t.planId, state: t.state, code: t.outcome?.code, summary: t.outcome?.summary, endedBy: t.endedBy };
}

export function notifyFinished(t: TaskRecord): void {
  const n = notificationOf(t);
  if (!n) return;
  try {
    appendLine(notificationsFile(), n);
  } catch {
    /* state dir unwritable: the task record still has it */
  }
  if (process.env.AUTOTEST_DESKTOP_NOTIFY === '1' && process.platform === 'win32') toast(`autotest：${n.issue ?? n.task}`, `${n.summary ?? n.state}${n.code ? `（${n.code}）` : ''}`);
}

function toast(title: string, body: string): void {
  const esc = (s: string) => s.replace(/'/g, "''").replace(/[<>&]/g, ' ');
  const ps = `[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null; $x = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02); $t = $x.GetElementsByTagName('text'); $t.Item(0).AppendChild($x.CreateTextNode('${esc(title)}')) > $null; $t.Item(1).AppendChild($x.CreateTextNode('${esc(body)}')) > $null; [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('autotest').Show([Windows.UI.Notifications.ToastNotification]::new($x))`;
  try {
    spawn('powershell.exe', ['-NoProfile', '-Command', ps], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } catch {
    /* no toast */
  }
}
