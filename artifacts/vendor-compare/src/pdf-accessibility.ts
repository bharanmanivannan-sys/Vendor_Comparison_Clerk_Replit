import {
  PDFDocument, PDFHexString, PDFName, PDFOperator, PDFPage,
} from 'pdf-lib';

type Tag = 'H1' | 'H2' | 'H3' | 'P' | 'Figure';
type AccessiblePage = PDFPage & {
  drawText: PDFPage['drawText'];
  drawRectangle: PDFPage['drawRectangle'];
  drawLine: PDFPage['drawLine'];
};

/**
 * pdf-lib exposes the PDF object graph and content operators, but does not
 * provide a high-level structure tree API. Keep all low-level tagging here.
 * StandardFonts are not embedded; these exports are not claimed to be PDF/UA
 * conformant until an independent validator and assistive-tech review pass.
 */
export function createPdfAccessibility(pdf: PDFDocument) {
  const { context } = pdf;
  const name = (value: string) => PDFName.of(value);
  const root = context.obj({ Type: 'StructTreeRoot', K: [] });
  const rootRef = context.register(root);
  const parents: Array<{ page: PDFPage; children: any[] }> = [];
  const readingOrder: any[] = [];
  let active: { tag: Tag; alt?: string } | 'Artifact' | null = null;

  const operator = (page: PDFPage, value: string) =>
    page.pushOperators(PDFOperator.of('BMC' as any, [value]) as any);
  const end = (page: PDFPage) => page.pushOperators(PDFOperator.of('EMC' as any));
  const artifact = (page: PDFPage, draw: () => void) => {
    if (active) return draw();
    active = 'Artifact';
    operator(page, '/Artifact');
    try { draw(); } finally { end(page); active = null; }
  };
  const tag = (page: PDFPage, kind: Tag, draw: () => void, alt?: string) => {
    if (active) return draw();
    const entry = parents.find((item) => item.page === page);
    if (!entry) throw new Error('PDF accessibility: page has no StructParents');
    const mcid = entry.children.length;
    const element = context.obj({
      Type: 'StructElem', S: kind, P: rootRef, Pg: page.ref, K: mcid,
      ...(alt ? { Alt: PDFHexString.fromText(alt) } : {}),
    });
    const ref = context.register(element);
    entry.children.push(ref);
    readingOrder.push(ref);
    active = { tag: kind, alt };
    // A literal property dictionary is an allowed PDF operator argument; the
    // pdf-lib operator type omits PDFDict even though PDF BDC requires one.
    page.pushOperators(PDFOperator.of('BDC' as any, [name(kind), `<< /MCID ${mcid} >>`]));
    try { draw(); } finally { end(page); active = null; }
  };
  const originalAddPage = pdf.addPage.bind(pdf);
  pdf.addPage = ((...args: Parameters<PDFDocument['addPage']>) => {
    const page = originalAddPage(...args);
    const index = parents.length;
    page.node.set(name('StructParents'), context.obj(index));
    page.node.set(name('Tabs'), name('S'));
    parents.push({ page, children: [] });
    const typed = page as AccessiblePage;
    const original = {
      text: page.drawText.bind(page),
      rectangle: page.drawRectangle.bind(page),
      line: page.drawLine.bind(page),
    };
    typed.drawText = ((...textArgs: Parameters<PDFPage['drawText']>) => {
      if (active) return original.text(...textArgs);
      const [text, options] = textArgs;
      // Running folios and the fixed brand label are not reading content.
      if (options?.y === 14 || text === 'DECISIONINTEL') {
        return artifact(page, () => original.text(...textArgs));
      }
      return tag(page, 'P', () => original.text(...textArgs));
    }) as PDFPage['drawText'];
    typed.drawRectangle = ((...args: Parameters<PDFPage['drawRectangle']>) => {
      if (active) return original.rectangle(...args);
      return artifact(page, () => original.rectangle(...args));
    }) as PDFPage['drawRectangle'];
    typed.drawLine = ((...args: Parameters<PDFPage['drawLine']>) => {
      if (active) return original.line(...args);
      return artifact(page, () => original.line(...args));
    }) as PDFPage['drawLine'];
    return page;
  }) as PDFDocument['addPage'];

  return {
    paragraph(page: PDFPage, draw: () => void) {
      tag(page, 'P', draw);
    },
    heading(page: PDFPage, level: 1 | 2 | 3, draw: () => void) {
      tag(page, `H${level}`, draw);
    },
    figure(page: PDFPage, alt: string, draw: () => void) {
      if (!alt.trim()) throw new Error('PDF accessibility: Figure needs alternative text');
      tag(page, 'Figure', draw, alt);
    },
    artifact,
    finish(title: string) {
      if (!parents.length) throw new Error('PDF accessibility: report has no pages');
      const parentTree = context.obj({
        Nums: parents.flatMap(({ children }, index) => [index, children]),
      });
      root.set(name('K'), context.obj(readingOrder));
      root.set(name('ParentTree'), context.register(parentTree));
      root.set(name('ParentTreeNextKey'), context.obj(parents.length));
      pdf.catalog.set(name('StructTreeRoot'), rootRef);
      pdf.catalog.set(name('MarkInfo'), context.obj({ Marked: true }));
      pdf.setLanguage('en');
      pdf.setTitle(title, { showInWindowTitleBar: true });
      // Also emit the viewer preference even in versions where setTitle does
      // not update an existing ViewerPreferences dictionary.
      pdf.catalog.getOrCreateViewerPreferences().dict.set(name('DisplayDocTitle'), context.obj(true));
    },
  };
}