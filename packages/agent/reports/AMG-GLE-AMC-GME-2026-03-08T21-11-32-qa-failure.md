# QA Failure Report — AMG, GLE, AMC, GME

Generated at: 2026-03-08T21:11:33.031Z
Report ID: fl_mmi8z80f_6b5fra

## Period Basis
- AMG: current=2025-12-31, prior=2024-12-31 (Peer figures are screening-only and use each company’s latest annual filing.)
- GLE: current=2025-06-30, prior=2024-06-30 (Peer figures are screening-only and use each company’s latest annual filing.)
- AMC: current=2025-12-31, prior=2024-12-31 (Peer figures are screening-only and use each company’s latest annual filing.)
- GME: current=2025-02-01, prior=2024-02-03 (Peer figures are screening-only and use each company’s latest annual filing.)

## Mapping Fixes / Signals
- None

## Metrics Computed (previously missing-sensitive)
- AMG: Free Cash Flow (prior), Diluted EPS (prior), Book Value Per Share (prior)
- GLE: Diluted EPS (prior), Book Value Per Share (prior)
- AMC: Free Cash Flow (prior), Diluted EPS (prior), Book Value Per Share (prior)
- GME: Free Cash Flow (prior), Diluted EPS (prior), Book Value Per Share (prior)

## Validation Failures
- [data.no_fake_na] AMG:total_debt: Total Debt is missing even though long-term or short-term debt is present.
- [data.no_fake_na] comparison:AMG:Cash, Cash Equivalents & Restricted Cash: Current value is N/A in comparison output but computable in canonical metrics.
- [data.no_fake_na] comparison:AMG:Total Debt: Metric missing despite all current-period inputs existing.
- [data.no_fake_na] comparison:AMG:Debt-to-Equity: Metric missing despite all current-period inputs existing.
- [data.no_fake_na] comparison:GLE:Cash, Cash Equivalents & Restricted Cash: Current value is N/A in comparison output but computable in canonical metrics.
- [data.cross_section_equality] AMG:comparison_groups:Liquidity & Leverage: Comparison rows drifted from the sealed report-level row contract.
- [data.cross_section_equality] GLE:comparison_groups:Liquidity & Leverage: Comparison rows drifted from the sealed report-level row contract.
