import type { CompletionState } from "./completion";
import { theme } from "./theme";
import { pad, truncate, width } from "./text";

// Same layout and palette roles as Exocortex's renderAutocompletePopup.
const MAX_VISIBLE_ROWS = 10;
const displayText = (text: string) => text.replace(/[\r\n\t]+/g, " ").replace(/[\x00-\x1f\x7f]/g, "");
const fit = (text: string, columns: number) => pad(truncate(text, columns), columns);

export function completionMenu(menu: CompletionState, columns: number, separatorRow: number) {
  const maxVisible = Math.max(1, Math.min(MAX_VISIBLE_ROWS, separatorRow - 3));
  const total = menu.items.length;
  const count = Math.min(total, maxVisible);
  const start = total > maxVisible && menu.selection >= 0
    ? Math.max(0, Math.min(menu.selection - Math.floor(count / 2), total - count)) : 0;
  const visible = menu.items.slice(start, start + count);
  const names = visible.map(item => displayText(item.label));
  const descriptions = visible.map(item => displayText(item.description));
  const maxWidth = Math.max(1, columns - 2);
  const markerWidth = maxWidth >= 2 ? 2 : 0;
  const indicatorWidth = total > count && maxWidth - markerWidth >= 2 ? 2 : 0;
  const maxName = Math.max(0, ...names.map(width));
  const maxDescription = Math.max(0, ...descriptions.map(width));
  const desiredNameWidth = Math.min(maxName + (maxDescription > 0 ? 1 : 0), maxWidth);
  const popupWidth = Math.max(1, Math.min(maxWidth, markerWidth + indicatorWidth + desiredNameWidth + maxDescription));
  const contentWidth = Math.max(0, popupWidth - markerWidth - indicatorWidth);
  const nameWidth = Math.min(desiredNameWidth, contentWidth);
  const descriptionWidth = Math.max(0, contentWidth - nameWidth);
  const rows = visible.map((_, i) => {
    const selected = menu.selection === start + i;
    const marker = markerWidth ? fit(selected ? "▸ " : "  ", markerWidth) : "";
    const up = i === 0 && start > 0;
    const down = i === count - 1 && start + count < total;
    const indicator = indicatorWidth ? fit(up ? " ▲" : down ? " ▼" : "", indicatorWidth) : "";
    return `${selected ? theme.sidebarSelBg : theme.sidebarBg}${theme.accent}${marker}${theme.text}${fit(names[i]!, nameWidth)}${theme.dim}${fit(descriptions[i]!, descriptionWidth)}${indicator}${theme.reset}`;
  });
  return { rows, width: popupWidth, top: separatorRow - count, start };
}
