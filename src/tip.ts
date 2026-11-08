/**
 * Labels on buttons and menus are short commands ("Edit area", "Remove from map"). When a label can't say
 * everything, a tip explains it, but only after the pointer rests on it a moment, so it never gets in the way.
 */
import { setTooltip } from 'obsidian';

/** How long the pointer rests on a button before its tip appears (milliseconds). */
export const TIP_DELAY = 1500;

export function tip(el: HTMLElement, text: string) { setTooltip(el, text, { delay: TIP_DELAY }); }
