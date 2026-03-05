import type { AnalysisContext, FinancialStatement, ProvenanceReceipt } from '@dolph/shared';

const ANNUAL_FORMS = new Set(['10-K', '20-F', '40-F']);

const CASH_OUTFLOW_METRICS = new Set([
  'capex',
  'capital_expenditures',
  'dividends_paid',
  'share_repurchases',
  'debt_repayment',
]);

export const SHARE_CHANGE_ALERT_THRESHOLD = 1.5;

export type CanonicalSourceKind = 'xbrl' | 'statement' | 'derived' | 'unknown';

export interface CanonicalFactSource {
  kind: CanonicalSourceKind;
  ticker: string;
  metric: string;
  period: string;
  form?: string;
  filed?: string;
  statementType?: FinancialStatement['statement_type'];
  provenance?: ProvenanceReceipt;
  detail?: string;
}

export interface CanonicalAnnualSeries {
  values: Map<string, Record<string, number>>;
  sources: Map<string, Record<string, CanonicalFactSource>>;
}

function finite(value: number | undefined): number | null {
  if (value === undefined) return null;
  return isFinite(value) ? value : null;
}

export function normalizeMetricValue(metric: string, value: number): number {
  if (!isFinite(value)) return value;
  if (CASH_OUTFLOW_METRICS.has(metric)) {
    return value > 0 ? -Math.abs(value) : value;
  }
  return value;
}

export function applyDerivedPeriodValues(
  values: Record<string, number>,
  sources?: Record<string, CanonicalFactSource>,
  ticker = 'UNKNOWN',
  period = '',
): void {
  const longTermDebt = finite(values['long_term_debt']);
  const shortTermDebt = finite(values['short_term_debt']);
  const totalDebt = finite(values['total_debt']);

  if (totalDebt === null && (longTermDebt !== null || shortTermDebt !== null)) {
    values['total_debt'] = (longTermDebt ?? 0) + (shortTermDebt ?? 0);
    if (sources) {
      sources['total_debt'] = {
        kind: 'derived',
        ticker,
        metric: 'total_debt',
        period,
        detail: 'Derived as long_term_debt + short_term_debt.',
      };
    }
  }

  const operatingCashFlow = finite(values['operating_cash_flow']);
  const capex = finite(values['capex']);
  if (operatingCashFlow !== null && capex !== null && values['free_cash_flow'] === undefined) {
    values['free_cash_flow'] = operatingCashFlow - Math.abs(capex);
    if (sources) {
      sources['free_cash_flow'] = {
        kind: 'derived',
        ticker,
        metric: 'free_cash_flow',
        period,
        detail: 'Derived as operating_cash_flow - abs(capex).',
      };
    }
  }
}

function ensureValueBucket(
  map: Map<string, Record<string, number>>,
  period: string,
): Record<string, number> {
  let bucket = map.get(period);
  if (!bucket) {
    bucket = {};
    map.set(period, bucket);
  }
  return bucket;
}

function ensureSourceBucket(
  map: Map<string, Record<string, CanonicalFactSource>>,
  period: string,
): Record<string, CanonicalFactSource> {
  let bucket = map.get(period);
  if (!bucket) {
    bucket = {};
    map.set(period, bucket);
  }
  return bucket;
}

/**
 * Build canonical annual values + source references for one ticker.
 *
 * Priority:
 * 1) XBRL company facts (has provenance receipts)
 * 2) Statement extraction fallback for uncovered metrics
 * 3) Deterministic derived metrics (total_debt, free_cash_flow)
 */
export function buildCanonicalAnnualSeries(
  context: AnalysisContext,
  ticker: string,
): CanonicalAnnualSeries {
  const values = new Map<string, Record<string, number>>();
  const sources = new Map<string, Record<string, CanonicalFactSource>>();

  // 1) Facts first: richer provenance and safer tag-level traceability
  for (const fact of context.facts[ticker]?.facts || []) {
    for (const period of fact.periods) {
      if (!ANNUAL_FORMS.has(period.form)) continue;
      if (!isFinite(period.value)) continue;
      const bucket = ensureValueBucket(values, period.period);
      const sourceBucket = ensureSourceBucket(sources, period.period);
      if (bucket[fact.metric] !== undefined) continue;
      bucket[fact.metric] = normalizeMetricValue(fact.metric, period.value);
      sourceBucket[fact.metric] = {
        kind: 'xbrl',
        ticker,
        metric: fact.metric,
        period: period.period,
        form: period.form,
        filed: period.filed,
        provenance: period.provenance,
      };
    }
  }

  // 2) Statement fallback fills gaps not present in facts
  for (const statement of context.statements[ticker] || []) {
    if (statement.period_type !== 'annual') continue;
    for (const period of statement.periods) {
      const bucket = ensureValueBucket(values, period.period);
      const sourceBucket = ensureSourceBucket(sources, period.period);
      for (const [metric, rawValue] of Object.entries(period.data)) {
        if (!isFinite(rawValue)) continue;
        if (bucket[metric] !== undefined) continue;
        bucket[metric] = normalizeMetricValue(metric, rawValue);
        sourceBucket[metric] = {
          kind: 'statement',
          ticker,
          metric,
          period: period.period,
          filed: period.filed,
          statementType: statement.statement_type,
          detail: 'Filled from deterministic statement extraction.',
        };
      }
    }
  }

  // 3) Add deterministic derived values + explicit derived source markers
  for (const [period, bucket] of values.entries()) {
    const sourceBucket = ensureSourceBucket(sources, period);
    applyDerivedPeriodValues(bucket, sourceBucket, ticker, period);
  }

  return { values, sources };
}

/**
 * Build a canonical annual period map for a ticker.
 * Priority:
 * 1) Company facts (with provenance)
 * 2) Structured statements fallback
 */
export function buildCanonicalAnnualPeriodMap(
  context: AnalysisContext,
  ticker: string,
): Map<string, Record<string, number>> {
  return buildCanonicalAnnualSeries(context, ticker).values;
}

export function buildCanonicalAnnualSourceMap(
  context: AnalysisContext,
  ticker: string,
): Map<string, Record<string, CanonicalFactSource>> {
  return buildCanonicalAnnualSeries(context, ticker).sources;
}

export function corporateActionEvidence(rawText: string): boolean {
  if (!rawText) return false;
  const text = rawText.toLowerCase();
  return /stock split|share split|split-adjusted|share issuance|equity offering|at-the-market|convertible|conversion|merger|acquisition/.test(text);
}

export function shareBasisDivergence(
  netIncome: number | null,
  epsDiluted: number | null,
  sharesOutstanding: number | null,
): number | null {
  if (netIncome === null || epsDiluted === null || sharesOutstanding === null) return null;
  if (!isFinite(netIncome) || !isFinite(epsDiluted) || !isFinite(sharesOutstanding) || epsDiluted === 0) {
    return null;
  }
  const impliedDilutedShares = netIncome / epsDiluted;
  if (!isFinite(impliedDilutedShares) || impliedDilutedShares <= 0 || sharesOutstanding <= 0) return null;
  return Math.abs(impliedDilutedShares - sharesOutstanding) / Math.max(impliedDilutedShares, sharesOutstanding);
}
