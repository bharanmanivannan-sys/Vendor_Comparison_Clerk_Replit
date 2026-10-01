import { PDFDocument, PDFFont, PDFPage, rgb } from 'pdf-lib';
import type { createPdfAccessibility } from './pdf-accessibility';
import type { requirementsChartData } from './RequirementsScoreView';

type Accessibility = ReturnType<typeof createPdfAccessibility>;
type Chart = ReturnType<typeof requirementsChartData>;
type Frameworks = Record<'soar' | 'swot' | 'pestle' | 'porter' | 'tows', [string, string[]][]> & {
  vendors: string[];
  presented: Record<'soar' | 'swot' | 'pestle', { vendor: string; entries: { dimension: string; text: string }[] }[]>;
};

/** Append vector-only, tagged working detail without altering the concise export pages. */
export function appendExpandedAnalysis({
  pdf, accessibility, regular, bold, comparison, chart, frameworks, vrio,
}: {
  pdf: PDFDocument; accessibility: Accessibility; regular: PDFFont; bold: PDFFont;
  comparison: any; chart: Chart; frameworks: Frameworks;
  vrio: { vendor: any; criteria: [string, { status?: string; rationale: string }][]; implication: string | null }[];
}) {
  const navy = rgb(.125, .157, .251);
  const teal = rgb(.059, .463, .431);
  const grey = rgb(.38, .42, .5);
  const pale = rgb(.89, .87, .81);
  const colors = [teal, rgb(.47, .38, .77), rgb(.22, .46, .68), rgb(.69, .47, .14), rgb(.71, .29, .47), rgb(.29, .45, .26)];
  const clean = (value: unknown) => String(value ?? '').normalize('NFKD').replace(/[^\x20-\x7e]/g, ' ').replace(/\s+/g, ' ').trim();
  const width = 511;
  let page!: PDFPage;
  let y = 0;
  const newPage = (title: string) => {
    page = pdf.addPage([595.28, 841.89]);
    accessibility.artifact(page, () => page.drawRectangle({ x: 0, y: 758, width: 595.28, height: 84, color: navy }));
    accessibility.heading(page, 2, () => page.drawText(clean(title), { x: 42, y: 788, size: 17, font: bold, color: rgb(.973, .957, .91) }));
    accessibility.artifact(page, () => page.drawText(`DecisionIntel  |  Expanded analysis  |  Page ${pdf.getPageCount()}`, { x: 42, y: 14, size: 6.8, font: regular, color: grey }));
    y = 734;
  };
  const ensure = (height: number, title: string) => { if (y - height < 43) newPage(title); };
  const lines = (text: unknown, size = 8.5) => {
    const result: string[] = [];
    let line = '';
    for (const word of clean(text).split(' ')) {
      if (!word) continue;
      // Splitting long URLs prevents a line from crossing the page boundary.
      let part = '';
      const pieces: string[] = [];
      for (const char of word) {
        if (part && regular.widthOfTextAtSize(part + char, size) > width) {
          pieces.push(part);
          part = '';
        }
        part += char;
      }
      pieces.push(part);
      for (const piece of pieces) {
        if (line && regular.widthOfTextAtSize(`${line} ${piece}`, size) > width) {
          result.push(line);
          line = piece;
        } else line = line ? `${line} ${piece}` : piece;
      }
    }
    if (line) result.push(line);
    return result.length ? result : [''];
  };
  const paragraph = (text: unknown, title: string, size = 8.5) => {
    const rows = lines(text, size);
    for (let index = 0; index < rows.length;) {
      ensure(15, title);
      const count = Math.min(rows.length - index, Math.floor((y - 43) / 12));
      accessibility.paragraph(page, () => rows.slice(index, index + count).forEach((row, offset) =>
        page.drawText(row, { x: 42, y: y - offset * 12, size, font: regular, color: navy })));
      y -= count * 12 + 4;
      index += count;
    }
  };
  const heading = (text: string, title: string, level: 2 | 3 = 2) => {
    ensure(36, title);
    accessibility.heading(page, level, () => page.drawText(clean(text), { x: 42, y, size: level === 2 ? 12 : 9, font: bold, color: teal }));
    y -= 20;
  };
  const title = 'Expanded requirements and strategic analysis';
  newPage(title);
  heading('Requirements profile and weighted totals', title);
  paragraph('Saved score x priority weight. Modelled, not independently verified. Missing and neutral fallback ratings are gaps, never zero. Partial totals are not comparable.', title);
  if (chart.criteria.length >= 3) {
    ensure(267, title);
    const center = { x: 290, y: y - 119 };
    const point = (index: number, radius: number) => ({
      x: center.x + Math.cos(-Math.PI / 2 + index * 2 * Math.PI / chart.criteria.length) * radius,
      y: center.y + Math.sin(-Math.PI / 2 + index * 2 * Math.PI / chart.criteria.length) * radius,
    });
    const description = `Requirements radar: ${chart.options.map((option) =>
      `${option.name}: ${chart.criteria.map((criterion) => {
        const row = option.ratings.find((rating) => rating.criterion === criterion);
        return `${criterion} ${row ? `${row.score} out of 100` : 'missing'}`;
      }).join(', ')}`).join('; ')}. Missing ratings are gaps, not zero.`;
    accessibility.figure(page, description, () => {
      for (const level of [25, 50, 75, 100]) {
        chart.criteria.forEach((_, index) => page.drawLine({
          start: point(index, level * 1.04), end: point((index + 1) % chart.criteria.length, level * 1.04),
          thickness: .5, color: pale,
        }));
      }
      chart.criteria.forEach((_, index) => page.drawLine({ start: center, end: point(index, 104), thickness: .4, color: pale }));
      chart.options.forEach((option, optionIndex) => {
        chart.criteria.forEach((criterion, index) => {
          const row = option.ratings.find((rating) => rating.criterion === criterion);
          const next = option.ratings.find((rating) => rating.criterion === chart.criteria[(index + 1) % chart.criteria.length]);
          if (row && next) page.drawLine({
            start: point(index, row.score * 1.04), end: point((index + 1) % chart.criteria.length, next.score * 1.04),
            thickness: 1.6, color: colors[optionIndex % colors.length],
          });
          if (row) {
            const p = point(index, row.score * 1.04);
            page.drawRectangle({ x: p.x - 2, y: p.y - 2, width: 4, height: 4, color: colors[optionIndex % colors.length] });
          }
        });
      });
    });
    y -= 230;
  } else paragraph('A radar profile needs at least three scored requirements. Available ratings follow.', title);
  heading('Weighted total / 100', title, 3);
  for (const [index, option] of chart.options.entries()) {
    const total = !option.ratings.length ? 'Not scored' : option.complete
      ? `${option.points.toFixed(1)} / 100`
      : `${option.points.toFixed(1)} pts - partial (${option.weight.toFixed(0)}% scored weight; incomplete totals are not comparable)`;
    paragraph(`${option.name}: ${total}`, title);
    if (option.ratings.length) {
      ensure(13, title);
      accessibility.figure(page, `Weighted total bar for ${option.name}: ${total}. Saved score times priority weight; missing ratings are not zero.`, () => {
        page.drawRectangle({ x: 42, y: y - 3, width: width, height: 7, color: pale });
        page.drawRectangle({ x: 42, y: y - 3, width: width * Math.min(100, option.points) / 100, height: 7, color: colors[index % colors.length] });
      });
      y -= 15;
    }
  }
  heading('Saved requirement ratings and priority weights', title);
  for (const criterion of chart.criteria) {
    const weights = [...new Set(chart.options.flatMap((option) => option.ratings.filter((row) => row.criterion === criterion).map((row) => row.weight)))];
    paragraph(`${criterion} (${weights.length === 1 ? `${weights[0]}% priority weight` : 'weights vary by option'}): ${chart.options.map((option) => {
      const row = option.ratings.find((rating) => rating.criterion === criterion);
      return `${option.name} ${row ? `${row.score}/100; ${ (row.score * row.weight / 100).toFixed(1)} weighted pts` : 'N/A - not scored'}`;
    }).join('; ')}`, title);
  }
  if (!chart.criteria.length) paragraph('No substantive saved requirement ratings are available.', title);

  for (const [key, label] of [['soar', 'SOAR'], ['swot', 'SWOT'], ['pestle', 'PESTLE']] as const) {
    const sectionTitle = `${label} by option`;
    newPage(sectionTitle);
    paragraph('Modelled, not independently verified. Source links in saved findings are retained where available; verify before acting.', sectionTitle);
    const entries = frameworks[key];
    if (!entries.length || !frameworks.presented[key].some(({ entries: findings }) => findings.length)) {
      paragraph(`No substantive ${label} findings${key === 'soar' ? ' or eligible criterion scores' : ''} are available for this report.`, sectionTitle);
      continue;
    }
    for (const { vendor, entries: findings } of frameworks.presented[key]) {
      if (!findings.length) continue;
      heading(vendor, sectionTitle, 3);
      for (const finding of findings) paragraph(`${finding.dimension}: ${finding.text}`, sectionTitle);
    }
  }
  const vrioTitle = 'VRIO framework across the shortlist';
  newPage(vrioTitle);
  paragraph('Stored VRIO assessments are modelled, not independently verified. Missing dimensions are not inferred.', vrioTitle);
  if (!vrio.length) paragraph('No substantive VRIO assessment is available for this report.', vrioTitle);
  for (const { vendor, criteria, implication } of vrio) {
    heading(String(vendor.vendor), vrioTitle, 3);
    for (const [dimension, item] of criteria) paragraph(`${dimension}: ${String(item.status || 'Modelled').replaceAll('_', ' ')}. ${item.rationale}`, vrioTitle);
    if (implication) paragraph(`Implication: ${implication}`, vrioTitle);
  }
  // The current report's version is the source for every chart and finding.
  pdf.setKeywords([`Report version ${Number(comparison.reportVersion) || 1}`, 'Expanded decision analysis']);
}