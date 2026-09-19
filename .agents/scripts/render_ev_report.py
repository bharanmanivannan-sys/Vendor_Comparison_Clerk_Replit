from pathlib import Path

import fitz


source = Path("attached_assets/electric-vehicle-comparison-complete-decision-report_1789814723751.pdf")
output = Path(".agents/outputs/ev-report")
output.mkdir(parents=True, exist_ok=True)

document = fitz.open(source)
print(f"pages={document.page_count}")
for index, page in enumerate(document):
    pixmap = page.get_pixmap(matrix=fitz.Matrix(1.5, 1.5), alpha=False)
    path = output / f"page-{index + 1:02d}.png"
    pixmap.save(path)
    print(path)