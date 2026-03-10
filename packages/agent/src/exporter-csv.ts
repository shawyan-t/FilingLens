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
import { resolve } from 'node:path';
import type { Report, AnalysisContext } from '@dolph/shared';
import { getMappingByName } from '@dolph/shared';
import type { ReportModel } from './report-model.js';

interface CSVExportResult {
  factsPath: string;
  metricsPath: string;
  ratiosPath: string;
}

const RATIO_EXPORT_DEFS: Array<{ key: string; label: string; formula: string }> = [
  { key: 'gross_margin', label: 'Gross Margin', formula: 'gross_profit / revenue' },
  { key: 'operating_margin', label: 'Operating Margin', formula: 'operating_income / revenue' },
  { key: 'net_margin', label: 'Net Margin', formula: 'net_income / revenue' },
  { key: 'roe', label: 'Return on Equity', formula: 'net_income / equity_basis' },
  { key: 'roa', label: 'Return on Assets', formula: 'net_income / asset_basis' },
  { key: 'current_ratio', label: 'Current Ratio', formula: 'current_assets / current_liabilities' },
  { key: 'quick_ratio', label: 'Quick Ratio', formula: '(current_assets - inventory) / current_liabilities' },
  { key: 'de', label: 'Debt-to-Equity', formula: 'total_debt / stockholders_equity' },
  { key: 'asset_turnover', label: 'Asset Turnover', formula: 'revenue / asset_basis' },
];

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
  const factsPath = resolve(outputDir, `${slug}_facts.csv`);
  const metricsPath = resolve(outputDir, `${slug}_metrics.csv`);
  const ratiosPath = resolve(outputDir, `${slug}_ratios.csv`);

  const factsRows: string[][] = [
    [
      'ticker',
      'cik',
      'company_name',
      'metric',
      'reported_label',
      'reported_description',
      'reported_value',
      'reported_unit',
      'period',
      'form',
      'fiscal_year',
      'fiscal_period',
      'filed',
      'xbrl_tag',
      'namespace',
      'selection_policy',
      'concept_scope',
      'accession',
      'filing_url',
    ],
  ];

  for (const ticker of report.tickers) {
    const facts = context.facts[ticker];
    if (!facts) continue;
    for (const fact of facts.facts) {
      for (const period of fact.periods) {
        factsRows.push([
          facts.ticker,
          facts.cik,
          facts.company_name,
          fact.metric,
          fact.label || '',
          fact.description || '',
          String(period.value),
          period.unit,
          period.period,
          period.form,
          period.fiscal_year?.toString() || '',
          period.fiscal_period || '',
          period.filed,
          period.provenance?.xbrl_tag || '',
          period.provenance?.namespace || '',
          period.provenance?.selection_policy || '',
          period.provenance?.concept_scope || '',
          period.provenance?.accession_number || '',
          period.provenance?.filing_url || '',
        ]);
      }
    }
  }

  // Build canonical metrics CSV
  const metricsRows: string[][] = [
    [
      'ticker',
      'period',
      'metric_key',
      'metric_label',
      'resolved_value',
      'resolved_unit',
      'source_kind',
      'reported_or_derived',
      'reported_value',
      'reported_unit',
      'reported_label',
      'detail',
      'form',
      'filed',
      'accession',
      'filing_url',
      'xbrl_tag',
      'namespace',
    ],
  ];

  for (const company of reportModel.companies) {
    const { ticker } = company;
    const periods = Array.from(company.canonicalPeriodMap.keys()).sort((a, b) => b.localeCompare(a));
    for (const period of periods) {
      const values = company.canonicalPeriodMap.get(period) || {};
      const sourceBucket = company.sourceMap.get(period) || {};

      for (const [metric, value] of Object.entries(values)) {
        const source = sourceBucket[metric];
        const mapping = getMappingByName(metric);
        metricsRows.push([
          ticker,
          period,
          metric,
          mapping?.displayName || metric,
          String(value),
          mapping?.unit || source?.reportedUnit || '',
          source?.kind || '',
          source?.kind === 'derived' || source?.kind === 'adjusted' ? 'derived' : 'reported',
          source?.reportedValue !== undefined ? String(source.reportedValue) : '',
          source?.reportedUnit || '',
          source?.reportedLabel || '',
          source?.detail || '',
          source?.form || '',
          source?.filed || '',
          source?.provenance?.accession_number || '',
          source?.provenance?.filing_url || '',
          source?.provenance?.xbrl_tag || '',
          source?.provenance?.namespace || '',
        ]);
      }
    }
  }

  // Build canonical ratio CSV from the sealed report model only
  const ratiosRows: string[][] = [
    ['ticker', 'period', 'ratio', 'value', 'formula', 'components', 'notes'],
  ];

  for (const company of reportModel.companies) {
    const periods = Array.from(company.canonicalPeriodMap.keys()).sort((a, b) => b.localeCompare(a));
    for (const period of periods) {
      for (const def of RATIO_EXPORT_DEFS) {
        const metric = company.metricsByKey.get(def.key);
        const value = period === company.snapshotPeriod
          ? metric?.current ?? null
          : period === company.priorPeriod
            ? metric?.prior ?? null
            : null;
        if (value === null || value === undefined) continue;
        ratiosRows.push([
          company.ticker,
          period,
          def.label,
          String(value),
          def.formula,
          ratioComponentsForPeriod(company, period, def.key),
          metric?.basis?.disclosureText || metric?.note || '',
        ]);
      }
    }
  }

  await Promise.all([
    writeFile(factsPath, toCSV(factsRows), 'utf8'),
    writeFile(metricsPath, toCSV(metricsRows), 'utf8'),
    writeFile(ratiosPath, toCSV(ratiosRows), 'utf8'),
  ]);

  return { factsPath, metricsPath, ratiosPath };
}

function ratioComponentsForPeriod(
  company: ReportModel['companies'][number],
  period: string,
  key: string,
): string {
  const values = company.canonicalPeriodMap.get(period) || {};
  const componentsByKey: Record<string, string[]> = {
    gross_margin: ['gross_profit', 'revenue'],
    operating_margin: ['operating_income', 'revenue'],
    net_margin: ['net_income', 'revenue'],
    roe: ['net_income', 'stockholders_equity'],
    roa: ['net_income', 'total_assets'],
    current_ratio: ['current_assets', 'current_liabilities'],
    quick_ratio: ['current_assets', 'inventory', 'current_liabilities'],
    de: ['total_debt', 'stockholders_equity'],
    asset_turnover: ['revenue', 'total_assets'],
  };
  const metricKeys = componentsByKey[key] || [];
  return metricKeys
    .filter(metricKey => values[metricKey] !== undefined && Number.isFinite(values[metricKey]))
    .map(metricKey => `${metricKey}=${values[metricKey]}`)
    .join(';');
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
