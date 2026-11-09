/**
 * Buttons that open a menu or a box work as switches: clicking the same button again closes it,
 * instead of closing on the press and opening again on the release (a flicker in place).
 */
import { Menu } from 'obsidian';

/** A button that drops a menu. `build` makes the menu; `place` shows it. A second click on the button closes it. */
export function menuButton(btn: HTMLElement, build: () => Menu, place: (m: Menu) => void) {
  let open: Menu | null = null, closedAt = 0, skip = false;
  // The press is seen before the menu notices the outside click, or just after it closes: either way it was open.
  btn.addEventListener('pointerdown', () => { skip = !!open || Date.now() - closedAt < 80; });
  btn.addEventListener('click', e => {
    e.preventDefault();
    if (skip || open) { skip = false; open?.hide(); return; }
    const m = build(); open = m;
    m.onHide(() => { if (open === m) { open = null; closedAt = Date.now(); } });
    place(m);
  });
}

/** A box opened by a button: true when this click should only close it (the box is open and belongs to this button). */
export function closesOwnBox(box: Element | null, anchor: HTMLElement, close: () => void) {
  if (!box || (box as any).__anchor !== anchor) return false;
  close(); return true;
}
/** Remember which button opened a box, for closesOwnBox. */
export function ownBox(box: HTMLElement, anchor: HTMLElement) { (box as any).__anchor = anchor; }
