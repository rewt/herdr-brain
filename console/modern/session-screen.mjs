// Shared embedded session grid: preserve native cells, colours and cursor.
import { cropTerminalSpans } from './terminal.mjs';
import { cutSpans } from '../lib/frame.mjs';

export function sessionScreenRows(screen, width, available) {
  if (!screen) return [];
  const start = Math.max(0, screen.height - available), shownWidth = Math.min(screen.width, width), cursor = screen.cursor;
  return screen.lines.slice(start).map((line, i) => {
    let grid = cropTerminalSpans(line.spans, 0, shownWidth);
    if (cursor?.visible && cursor.y === start + i && cursor.x < shownWidth) {
      grid = [...cutSpans(grid, 0, cursor.x), ...cutSpans(grid, cursor.x, cursor.x + 1).map(c => ({ ...c, inverse: !c.inverse })), ...cutSpans(grid, cursor.x + 1, shownWidth)];
    }
    return [...grid, ...(width > shownWidth ? [{ text: ' '.repeat(width - shownWidth), fg: 'terminalFg', bg: 'terminalBg' }] : [])];
  });
}
