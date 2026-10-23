/** Transient notifications. Errors stay longer than confirmations. */
type ToastKind = 'info' | 'success' | 'error';

export function toast(message: string, kind: ToastKind = 'info'): void {
  let host = document.querySelector<HTMLElement>('#toasts');
  if (!host) {
    host = document.createElement('div');
    host.id = 'toasts';
    document.body.append(host);
  }
  const element = document.createElement('div');
  element.className = `toast ${kind}`;
  element.textContent = message;
  host.append(element);
  const ttl = kind === 'error' ? 4200 : 2200;
  window.setTimeout(() => {
    element.classList.add('leaving');
    window.setTimeout(() => element.remove(), 220);
  }, ttl);
}
