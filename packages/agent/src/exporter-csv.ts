/**
 * CSV exporter — writes deterministic metric and ratio data to CSV files.
 *
 * Produces two files per run:
 * 1. {slug}_metrics.csv — one row per metric per period
 * 2. {slug}_ratios.csv — one row per ratio per period
 *
 * For comparison reports, all tickers are combined into the same files.
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import type { Report, AnalysisContext, Ratio } from '@dolph/shared';
import type { ReportModel } from './report-model.js';

interface CSVExportResult {
  metricsPath: string;
  ratiosPath: string;
}

/**
 * Export report data as CSV files alongside the report output.
 */
export async function exportCSV(
  report: Report,
  context: AnalysisContext,
  reportModel: ReportModel,
  outputDir: string,
): Promise<CSVExportResult> {
  await mkdir(outputDir, { recursive: true });

  const slug = report.tickers.join('-');
  const metricsPath = resolve(outputDir, `${slug}_metrics.csv`);
  const ratiosPath = resolve(outputDir, `${slug}_ratios.csv`);

  // Build metrics CSV
  const metricsRows: string[][] = [
    ['ticker', 'period', 'metric', 'value', 'unit', 'form', 'accession'],
  ];

  for (const company of reportModel.companies) {
    const { ticker } = company;
    for (const [period, values] of company.canonicalPeriodMap.entries()) {
      // Look up filing reference for this period
      const filing = company.filingReferences.find(
        f => f.periods.includes(period),
      );
      const form = filing?.form ?? '';
      const accession = filing?.accessionNumber ?? '';

      for (const [metric, value] of Object.entries(values)) {
        metricsRows.push([
          ticker,
          period,
          metric,
          String(value),
          guessUnit(metric),
          form,
          accession,
        ]);
      }
    }
  }

  // Build ratios CSV
  const ratiosRows: string[][] = [
    ['ticker', 'period', 'ratio', 'value', 'formula', 'components', 'notes'],
  ];

  for (const ticker of report.tickers) {
    const ratios: Ratio[] = context.ratios[ticker] || [];
    for (const ratio of ratios) {
      const componentsStr = Object.entries(ratio.components)
        .map(([k, v]) => `${k}=${v}`)
        .join(';');
      ratiosRows.push([
        ticker,
        ratio.period,
        ratio.name,
        String(ratio.value),
        ratio.formula,
        componentsStr,
        (ratio.notes || []).join('; '),
      ]);
    }
  }

  await Promise.all([
    writeFile(metricsPath, toCSV(metricsRows), 'utf8'),
    writeFile(ratiosPath, toCSV(ratiosRows), 'utf8'),
  ]);

  return { metricsPath, ratiosPath };
}

/** Escape and format rows as RFC 4180 CSV. */
function toCSV(rows: string[][]): string {
  return rows
    .map(row =>
      row
        .map(cell => {
          if (cell.includes(',') || cell.includes('"') || cell.includes('\n')) {
            return `"${cell.replace(/"/g, '""')}"`;
          }
          return cell;
        })
        .join(','),
    )
    .join('\n') + '\n';
}

/** Best-effort unit guess from metric name. */
function guessUnit(metric: string): string {
  if (metric.endsWith('_margin') || metric.endsWith('_yield')) return '%';
  if (metric === 'eps_diluted' || metric === 'eps_basic') return 'USD/share';
  if (metric === 'shares_outstanding') return 'shares';
  return 'USD';
}
