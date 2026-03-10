# QA Failure Report — GME, AMG, GLE, AMC

Generated at: 2026-03-09T20:28:17.006Z
Report ID: fl_mmjmvfk7_qt5wc7

## Period Basis
- GME: current=2025-02-01, prior=2024-02-03 (Peer figures use each company’s latest annual filing with prominent disclosure that fiscal periods can differ across peers.)
- AMG: current=2025-12-31, prior=2024-12-31 (Peer figures use each company’s latest annual filing with prominent disclosure that fiscal periods can differ across peers.)
- GLE: current=2025-06-30, prior=2024-06-30 (Peer figures use each company’s latest annual filing with prominent disclosure that fiscal periods can differ across peers.)
- AMC: current=2025-12-31, prior=2024-12-31 (Peer figures use each company’s latest annual filing with prominent disclosure that fiscal periods can differ across peers.)

## Mapping Fixes / Signals
- None

## Metrics Computed (previously missing-sensitive)
- GME: Free Cash Flow (prior), Diluted EPS (prior), Book Value Per Share (prior)
- AMG: Free Cash Flow (prior), Diluted EPS (prior), Book Value Per Share (prior)
- GLE: Diluted EPS (prior), Book Value Per Share (prior)
- AMC: Free Cash Flow (prior), Diluted EPS (prior), Book Value Per Share (prior)

## Validation Failures
- [ERROR] [data.sanity] AMG:pretax_income: Pretax income identity gap: pretax_income (1186300000) does not reconcile with net_income + income_tax_expense (998900000).
