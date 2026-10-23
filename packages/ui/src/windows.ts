/**
 * Minimal floating-window layer: drag by header, resize from the corner,
 * click to focus. Deliberately not a framework — six windows do not need one.
 */

export interface WindowSpec {
  id: string;
  title: string;
  body: HTMLElement;
  width?: number;
  height?: number;
  x?: number;
  y?: number;
  resizable?: boolean;
  onOpen?: () => void;
  onClose?: () => void;
}

let zCounter = 20;

export class FloatingWindow {
  readonly id: string;
  readonly element: HTMLDivElement;
  private readonly body: HTMLElement;
  private open = false;
  private readonly onOpen?: () => void;
  private readonly onClose?: () => void;

  constructor(spec: WindowSpec, layer: HTMLElement) {
    this.id = spec.id;
    this.onOpen = spec.onOpen;
    this.onClose = spec.onClose;

    const element = document.createElement('div');
    element.className = 'win';
    element.dataset.window = spec.id;
    element.style.width = `${spec.width ?? 360}px`;
    element.style.height = `${spec.height ?? 240}px`;
    element.style.left = `${spec.x ?? 24}px`;
    element.style.top = `${spec.y ?? 64}px`;

    const header = document.createElement('div');
    header.className = 'win-header';
    const title = document.createElement('span');
    title.className = 'win-title';
    title.textContent = spec.title;
    const close = document.createElement('button');
    close.className = 'win-close';
    close.textContent = '✕';
    close.addEventListener('click', (event) => {
      event.stopPropagation();
      this.hide();
    });
    header.append(title, close);

    const bodyEl = document.createElement('div');
    bodyEl.className = 'win-body';
    bodyEl.append(spec.body);
    this.body = bodyEl;

    element.append(header, bodyEl);

    if (spec.resizable !== false) {
      const grip = document.createElement('div');
      grip.className = 'win-grip';
      element.append(grip);
      this.enableResize(grip, element);
    }

    this.enableDrag(header, element);
    element.addEventListener('pointerdown', () => this.focus());

    this.element = element;
    layer.append(element);
  }

  get isOpen(): boolean {
    return this.open;
  }

  show(): void {
    if (this.open) return;
    this.open = true;
    this.element.classList.add('open');
    this.focus();
    this.onOpen?.();
  }

  hide(): void {
    if (!this.open) return;
    this.open = false;
    this.element.classList.remove('open', 'focused');
    this.onClose?.();
  }

  toggle(): void {
    if (this.open) this.hide();
    else this.show();
  }

  focus(): void {
    zCounter += 1;
    this.element.style.zIndex = String(zCounter);
    for (const win of document.querySelectorAll('.win')) win.classList.remove('focused');
    this.element.classList.add('focused');
  }

  /** Move and/or resize in one call (used by render-mode presets). */
  setRect(rect: { x?: number; y?: number; width?: number; height?: number }): void {
    if (rect.x !== undefined) this.element.style.left = `${rect.x}px`;
    if (rect.y !== undefined) this.element.style.top = `${rect.y}px`;
    if (rect.width !== undefined) this.element.style.width = `${rect.width}px`;
    if (rect.height !== undefined) this.element.style.height = `${rect.height}px`;
  }

  /** Content layer of the window; callers mount canvases here. */
  get content(): HTMLElement {
    return this.body;
  }

  private enableDrag(handle: HTMLElement, element: HTMLElement): void {
    let startX = 0;
    let startY = 0;
    let originX = 0;
    let originY = 0;

    handle.addEventListener('pointerdown', (event) => {
      if ((event.target as HTMLElement).closest('.win-close')) return;
      event.preventDefault();
      handle.setPointerCapture(event.pointerId);
      startX = event.clientX;
      startY = event.clientY;
      originX = element.offsetLeft;
      originY = element.offsetTop;

      const move = (e: PointerEvent): void => {
        const maxX = window.innerWidth - 80;
        const maxY = window.innerHeight - 40;
        element.style.left = `${Math.min(maxX, Math.max(0, originX + e.clientX - startX))}px`;
        element.style.top = `${Math.min(maxY, Math.max(0, originY + e.clientY - startY))}px`;
      };
      const up = (): void => {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
    });
  }

  private enableResize(grip: HTMLElement, element: HTMLElement): void {
    let startX = 0;
    let startY = 0;
    let originW = 0;
    let originH = 0;

    grip.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      event.stopPropagation();
      grip.setPointerCapture(event.pointerId);
      startX = event.clientX;
      startY = event.clientY;
      originW = element.offsetWidth;
      originH = element.offsetHeight;
      this.focus();

      const move = (e: PointerEvent): void => {
        element.style.width = `${Math.max(220, originW + e.clientX - startX)}px`;
        element.style.height = `${Math.max(140, originH + e.clientY - startY)}px`;
      };
      const up = (): void => {
        grip.removeEventListener('pointermove', move);
        grip.removeEventListener('pointerup', up);
      };
      grip.addEventListener('pointermove', move);
      grip.addEventListener('pointerup', up);
    });
  }
}

export class WindowLayer {
  private readonly windows = new Map<string, FloatingWindow>();
  private lastFocused: FloatingWindow | null = null;

  constructor(private readonly root: HTMLElement) {}

  create(spec: WindowSpec): FloatingWindow {
    const win = new FloatingWindow(spec, this.root);
    this.windows.set(spec.id, win);
    win.element.addEventListener('pointerdown', () => {
      this.lastFocused = win;
    });
    return win;
  }

  get(id: string): FloatingWindow | undefined {
    return this.windows.get(id);
  }

  toggle(id: string): void {
    const win = this.windows.get(id);
    if (!win) return;
    if (!win.isOpen) this.lastFocused = win;
    win.toggle();
  }

  /** Close whichever window was focused last; used by Esc. */
  closeLast(): boolean {
    const target = this.lastFocused;
    if (!target?.isOpen) return false;
    target.hide();
    this.lastFocused = null;
    return true;
  }

  closeAll(): void {
    for (const win of this.windows.values()) win.hide();
  }

  isOpen(id: string): boolean {
    return this.windows.get(id)?.isOpen ?? false;
  }

  setActiveDock(active: Set<string>): void {
    for (const button of document.querySelectorAll<HTMLButtonElement>('#dock button')) {
      button.classList.toggle('active', active.has(button.dataset.win ?? ''));
    }
  }
}
