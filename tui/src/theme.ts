import { color, detectColorLevel } from "./terminalcolors";

export interface Theme {
  name: string;
  reset: string;
  bold: string;
  boldOff: string;
  dim: string;
  italic: string;
  accent: string;
  text: string;
  muted: string;
  error: string;
  warning: string;
  success: string;
  goal: string;
  command: string;
  vimNormal: string;
  vimInsert: string;
  topbarBg: string;
  userBg: string;
  sidebarBg: string;
  sidebarSelBg: string;
  cursorBg: string;
  selectionBg: string;
  appBg: string;
  borderFocused: string;
  borderUnfocused: string;
  cursorColor: string;
}

const ESC = "\x1b[";
const level = detectColorLevel();
const fg = (hex: string) => color(38, hex, level);
const bg = (hex: string) => color(48, hex, level);

/** Exocortex's default Whale palette, adapted to terminal color depth. */
export const theme: Theme = {
  name: "whale",
  reset: `${ESC}0m`, bold: `${ESC}1m`, boldOff: `${ESC}22m`, dim: `${ESC}2m`, italic: `${ESC}3m`,
  accent: fg("#1d9bf0"), text: fg("#ffffff"), muted: fg("#646464"), error: `${ESC}31m`,
  warning: `${ESC}33m`, success: fg("#50c878"), goal: fg("#c792ea"), command: fg("#aed6fe"),
  vimNormal: fg("#48cae4"), vimInsert: fg("#2ec4b6"),
  topbarBg: bg("#1d9bf0"), userBg: bg("#090d35"), sidebarBg: bg("#030814"),
  sidebarSelBg: bg("#0f193c"), cursorBg: bg("#48cae4"), selectionBg: bg("#4f5258"),
  appBg: bg("#00050f"), borderFocused: fg("#1c94e5"), borderUnfocused: fg("#555555"),
  cursorColor: "#48cae4",
};

export function eventColor(hex: string): string { return color(38, hex, level); }
