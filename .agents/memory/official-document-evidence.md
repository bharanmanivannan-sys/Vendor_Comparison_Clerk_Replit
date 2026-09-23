---
name: Official document evidence
description: Safe ingestion and attribution rules for official PDFs and canonical product reports.
---

Official PDFs may be used as evidence only through bounded extraction that preserves publisher permissions, retrieval limits, document hashes, and exact source-text spans. Governed documents must be bound to their exact product owner before metric extraction; document-wide mentions of another product cannot transfer claims across vendors.

**Why:** Official vehicle pages were access-restricted while crawl-permitted brochures and newsroom documents were available. PDF table layout separated labels from values, and loose document-wide identity matching briefly attributed one product's metrics to another.

**How to apply:** Parse only exact configured layouts when generic extraction is ambiguous, retain raw units and normalize units only for scoring, reject incomparable test protocols, and verify the final canonical product names, winner, and scores agree across API, browser, and PDF.