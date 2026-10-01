import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('./index.css', import.meta.url), 'utf8');

function lum(hex: string) {
  const n = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(n.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const ratio = (a: string, b: string) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

const PAGE = '#171d2e';   // dark page (bg-[#f2eee2] mapping)
const PANEL = '#232c46';  // dark navy panel
const TILE = '#252d43';   // stat tile
const LIME = '#d9ef66';

test('dark text pairs meet WCAG AA 4.5:1', () => {
  const pairs: [string, string, string][] = [
    ['teal accent / page', '#5fd4c0', PAGE],
    ['teal accent / panel', '#5fd4c0', PANEL],
    ['muted label / tile', '#b8c1d3', TILE],
    ['body / page', '#f4f0e5', PAGE],
    ['error text / page', '#f4a199', PAGE],
    ['warning text / page', '#ecd27e', PAGE],
    ['placeholder / input', '#a3adc2', PAGE],
    ['ink on lime CTA', '#202840', LIME],
    ['ink on disabled lime', '#202840', '#8a9651'],
  ];
  for (const [name, fg, bg] of pairs) assert.ok(ratio(fg, bg) >= 4.5, `${name}: ${ratio(fg, bg).toFixed(2)}`);
});

test('dark control boundaries meet 3:1', () => {
  assert.ok(ratio('#6b7794', PAGE) >= 3, 'input border');
  assert.ok(ratio('#f5d74a', PAGE) >= 3, 'focus ring');
});

test('lime surfaces keep dark ink after the blanket text override', () => {
  const blanket = css.indexOf('.dark [class~="text-[#202840]"]');
  const lime = css.indexOf('.dark [class~="bg-[#d9ef66]"] *');
  assert.ok(blanket > -1 && lime > blanket, 'lime rule must follow blanket mapping');
  assert.match(css, /\.dark \[class~="bg-\[#d9ef66\]"\] \*,\s*\.dark \.action-lime,\s*\.dark \.action-lime \* \{ color: #202840; \}/);
  assert.match(css, /\.dark \[class~="bg-\[#f2eee2\]\/90"\]/);
  assert.match(css, /\.dark \[class~="text-\[#0f766e\]"\][^{]*\{ color: #5fd4c0; \}/);
});

test('light theme tokens unchanged', () => {
  assert.match(css, /:root \{\s*--background: 43 33% 94%;/);
});
