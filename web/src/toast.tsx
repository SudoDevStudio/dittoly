import { useEffect, useState } from 'react';
import { Icon } from './ui';

/**
 * Short messages after an action: "Approved", "Saved", or what went wrong.
 * Shown at the bottom of the screen for a few seconds and announced to screen readers.
 */

export interface Toast {
  id: number;
  kind: 'success' | 'error';
  text: string;
}

let next = 1;
let current: Toast[] = [];
const listeners = new Set<(t: Toast[]) => void>();

function publish(): void {
  for (const l of listeners) l(current);
}

export function toast(kind: Toast['kind'], text: string): void {
  const t = { id: next++, kind, text };
  current = [...current.slice(-3), t];
  publish();
  setTimeout(() => dismiss(t.id), kind === 'error' ? 8000 : 4000);
}

export function dismiss(id: number): void {
  current = current.filter((t) => t.id !== id);
  publish();
}

export function Toasts() {
  const [list, setList] = useState<Toast[]>(current);
  useEffect(() => {
    listeners.add(setList);
    return () => {
      listeners.delete(setList);
    };
  }, []);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {list.map((t) => (
        <div key={t.id} className={`toast toast-${t.kind}`} role={t.kind === 'error' ? 'alert' : undefined}>
          <Icon name={t.kind === 'success' ? 'check' : 'alert'} size={16} />
          <span>{t.text}</span>
          <button type="button" className="ghost icon-button" aria-label="Dismiss" onClick={() => dismiss(t.id)}>
            <Icon name="close" size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
