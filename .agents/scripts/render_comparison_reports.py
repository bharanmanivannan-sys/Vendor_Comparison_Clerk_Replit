from pathlib import Path

import pymupdf


REPORTS = [
    Path("attached_assets/electric-vehicles-complete-decision-report_(1)_1790141677753.pdf"),
    Path("attached_assets/automotive-diesel-automatic-suvs-in-india-complete-decision-re_1790141711284.pdf"),
]
OUTPUT = Path(".agents/outputs/comparison-report-pages")
OUTPUT.mkdir(parents=True, exist_ok=True)

for report in REPORTS:
    document = pymupdf.open(report)
    selected_pages = sorted({0, 1, min(3, document.page_count - 1)})
    print(f"{report.name}: {document.page_count} pages")
    for page_index in selected_pages:
        page = document[page_index]
        pixmap = page.get_pixmap(matrix=pymupdf.Matrix(1.5, 1.5), alpha=False)
        output_path = OUTPUT / f"{report.stem}-page-{page_index + 1}.png"
        pixmap.save(output_path)
        print(output_path)