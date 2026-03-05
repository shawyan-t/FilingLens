import type { AnalysisContext, ReportSection } from '@dolph/shared';
import type { AnalysisInsights } from './analyzer.js';
import { SINGLE_REPORT_SECTIONS, COMPARISON_REPORT_SECTIONS } from './prompts/narrative.js';
import { formatCompactCurrency } from '@dolph/shared';

interface MetricPoint {
  current: number;
  prior: number | null;
  change: number | null;
  unit: string;
}

interface NarrativeFacts {
  revenue?: MetricPoint;
  netIncome?: MetricPoint;
  operatingIncome?: MetricPoint;
  operatingMargin?: MetricPoint;
  netMargin?: MetricPoint;
  grossMargin?: MetricPoint;
  debtToEquity?: MetricPoint;
  currentRatio?: MetricPoint;
  quickRatio?: MetricPoint;
  operatingCashFlow?: MetricPoint;
  freeCashFlow?: MetricPoint;
  capex?: MetricPoint;
  roe?: MetricPoint;
  roa?: MetricPoint;
}

function fmtPct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function fmtRatio(value: number): string {
  return `${value.toFixed(2)}x`;
}

function fmtCurrency(value: number): string {
  return formatCompactCurrency(value, { smallDecimals: 0, compactDecimals: 1 });
}

function metric(insights: AnalysisInsights, name: string): MetricPoint | undefined {
  const m = insights.keyMetrics[name];
  if (!m || !isFinite(m.current)) return undefined;
  return {
    current: m.current,
    prior: m.prior,
    change: m.change,
    unit: m.unit,
  };
}

function extractFacts(insights: AnalysisInsights): NarrativeFacts {
  return {
    revenue: metric(insights, 'Revenue'),
    netIncome: metric(insights, 'Net Income'),
    operatingIncome: metric(insights, 'Operating Income'),
    operatingMargin: metric(insights, 'Operating Margin'),
    netMargin: metric(insights, 'Net Margin'),
    grossMargin: metric(insights, 'Gross Margin'),
    debtToEquity: metric(insights, 'Debt-to-Equity'),
    currentRatio: metric(insights, 'Current Ratio'),
    quickRatio: metric(insights, 'Quick Ratio'),
    operatingCashFlow: metric(insights, 'Operating Cash Flow'),
    freeCashFlow: metric(insights, 'Free Cash Flow'),
    capex: metric(insights, 'Capital Expenditures'),
    roe: metric(insights, 'Return on Equity'),
    roa: metric(insights, 'Return on Assets'),
  };
}

function buildSingleExecutiveSummary(
  ticker: string,
  insights: AnalysisInsights,
): string {
  const f = extractFacts(insights);
  const period = insights.snapshotPeriod || 'latest annual period';
  const p1Parts: string[] = [];
  if (f.revenue && f.netIncome) {
    const revChange = f.revenue.change !== null ? ` (${fmtPct(f.revenue.change)} YoY)` : '';
    const niChange = f.netIncome.change !== null ? ` (${fmtPct(f.netIncome.change)} YoY)` : '';
    p1Parts.push(
      `${ticker} reports ${fmtCurrency(f.revenue.current)} revenue${revChange} and ${fmtCurrency(f.netIncome.current)} net income${niChange} for ${period}.`,
    );
  } else if (f.revenue) {
    p1Parts.push(`${ticker} reports ${fmtCurrency(f.revenue.current)} revenue for ${period}.`);
  } else {
    p1Parts.push(`${ticker} has limited period-coherent annual coverage in this run, so interpretation should stay close to the verified statement tables.`);
  }
  if (f.operatingMargin || f.netMargin) {
    const marginBits: string[] = [];
    if (f.operatingMargin) marginBits.push(`operating margin ${fmtPct(f.operatingMargin.current)}`);
    if (f.netMargin) marginBits.push(`net margin ${fmtPct(f.netMargin.current)}`);
    p1Parts.push(`Profitability is currently defined by ${marginBits.join(' and ')}.`);
  }

  const p2Parts: string[] = [];
  if (f.debtToEquity && f.currentRatio) {
    const leverage = f.debtToEquity.current;
    const liquidity = f.currentRatio.current;
    if (Math.abs(leverage) < 0.3 && liquidity >= 1.5) {
      p2Parts.push(`Balance-sheet posture is conservative at ${fmtRatio(leverage)} debt-to-equity with ${fmtRatio(liquidity)} current ratio.`);
    } else if (Math.abs(leverage) > 2) {
      p2Parts.push(`Leverage is elevated at ${fmtRatio(leverage)} debt-to-equity, which raises refinancing sensitivity despite current liquidity at ${fmtRatio(liquidity)}.`);
    } else {
      p2Parts.push(`Balance-sheet profile is mixed at ${fmtRatio(leverage)} debt-to-equity and ${fmtRatio(liquidity)} current ratio.`);
    }
  } else if (f.currentRatio) {
    p2Parts.push(`Current ratio is ${fmtRatio(f.currentRatio.current)} in the locked annual basis.`);
  }
  if (f.quickRatio) {
    p2Parts.push(`Quick ratio is ${fmtRatio(f.quickRatio.current)} on the same period basis.`);
  }

  const p3Parts: string[] = [];
  if (f.operatingCashFlow) {
    p3Parts.push(`Operating cash flow is ${fmtCurrency(f.operatingCashFlow.current)}${formatChangeSuffix(f.operatingCashFlow.change)}.`);
  }
  if (f.freeCashFlow) {
    p3Parts.push(`Free cash flow is ${fmtCurrency(f.freeCashFlow.current)}${formatChangeSuffix(f.freeCashFlow.change)}.`);
  }
  if (f.capex) {
    p3Parts.push(`Capital expenditures are ${fmtCurrency(Math.abs(f.capex.current))}, framing reinvestment intensity.`);
  }
  if (p3Parts.length === 0) {
    p3Parts.push('Cash-flow evidence is limited in the locked annual period, so funding durability remains unresolved.');
  }

  return [p1Parts.join(' '), p2Parts.join(' '), p3Parts.join(' ')].filter(Boolean).join('\n\n');
}

function buildSingleTrendAnalysis(insights: AnalysisInsights): string {
  if (insights.topTrends.length === 0) {
    return 'Annual trend coverage is limited in this run; interpretation relies on current-period statement consistency.';
  }

  const lines: string[] = [];
  for (const trend of insights.topTrends.slice(0, 4)) {
    const cagrText = trend.cagr !== null ? `${fmtPct(trend.cagr)} CAGR` : 'CAGR unavailable';
    const latestText = trend.latestValue !== null
      ? fmtCurrency(trend.latestValue)
      : 'N/A';
    lines.push(`### ${trend.displayName}`);
    lines.push(`${trend.displayName} is currently ${latestText} with ${cagrText}. ${trend.description}`);
    lines.push('');
  }
  return lines.join('\n').trim();
}

function buildSingleRiskFactors(insights: AnalysisInsights): string {
  if (insights.redFlags.length === 0) {
    return [
      '### Watch Items',
      '- No major quantitative red flags are active in the locked annual snapshot.',
      '- Continue monitoring margin durability and cash conversion in the next filing cycle.',
    ].join('\n');
  }

  return [
    '### Watch Items',
    ...insights.redFlags.slice(0, 5).map(flag => bullet(`**${flag.flag}:** ${flag.detail}`, ['risk_flag'])),
  ].join('\n');
}

function buildSingleAnalystNotes(
  ticker: string,
  insights: AnalysisInsights,
): string {
  const strengths = insights.strengths.slice(0, 3);
  const flags = insights.redFlags.slice(0, 3);
  const lines: string[] = [];

  lines.push('### What Stands Out');
  if (strengths.length === 0) {
    lines.push(bullet(`${ticker}'s profile is currently balanced without a dominant quantitative outperformance signal.`, ['strengths']));
  } else {
    for (const strength of strengths) {
      lines.push(bullet(strength.detail, [strength.metric]));
    }
  }

  lines.push('');
  lines.push('### Watch Items');
  if (flags.length === 0) {
    lines.push(bullet('No critical flags are active; monitor execution against current margin and cash benchmarks.', ['red_flags']));
  } else {
    for (const flag of flags) {
      lines.push(bullet(flag.detail, ['red_flags']));
    }
  }

  lines.push('');
  lines.push('### Analyst Interpretation');
  lines.push(bullet(`Current conclusions are anchored to a period-locked annual basis (${insights.snapshotPeriod ?? 'N/A'}).`, ['period_basis.current']));
  if (insights.priorPeriod) {
    lines.push(bullet(`Prior comparisons use ${insights.priorPeriod}; metrics without required inputs remain intentionally unfilled.`, ['period_basis.prior']));
  }

  return lines.join('\n');
}

function buildComparisonExecutiveSummary(
  context: AnalysisContext,
  insights: Record<string, AnalysisInsights>,
): string {
  const summaries = context.tickers.map(t => {
    const i = insights[t];
    const facts = extractFacts(i);
    return {
      ticker: t,
      revenue: facts.revenue?.current ?? null,
      netIncome: facts.netIncome?.current ?? null,
      netMargin: facts.netMargin?.current ?? null,
      debtToEquity: facts.debtToEquity?.current ?? null,
      period: i.snapshotPeriod ?? 'N/A',
    };
  });

  const lines: string[] = [];
  const snapshots = summaries.map(s => {
    const rev = s.revenue !== null ? fmtCurrency(s.revenue) : 'N/A';
    const ni = s.netIncome !== null ? fmtCurrency(s.netIncome) : 'N/A';
    const margin = s.netMargin !== null ? fmtPct(s.netMargin) : 'N/A';
    const de = s.debtToEquity !== null ? fmtRatio(s.debtToEquity) : 'N/A';
    return `${s.ticker} reports ${rev} revenue, ${ni} net income, ${margin} net margin, and ${de} debt-to-equity (period ${s.period})`;
  });
  if (snapshots.length > 0) {
    lines.push(`${snapshots.join('; ')}.`);
  }

  const revenueLeader = [...summaries]
    .filter(s => s.revenue !== null)
    .sort((a, b) => (b.revenue ?? 0) - (a.revenue ?? 0))[0];
  if (revenueLeader) {
    lines.push(`${revenueLeader.ticker} is the current scale leader by annual revenue in this peer set.`);
  }

  return lines.join('\n');
}

function buildRelativeStrengths(
  context: AnalysisContext,
  insights: Record<string, AnalysisInsights>,
): string {
  const lines: string[] = [];
  for (const ticker of context.tickers) {
    lines.push(`### ${ticker} — What Stands Out`);
    const strengths = insights[ticker]?.strengths || [];
    if (strengths.length === 0) {
      lines.push(bullet(`No clear quantitative outperformance signal is active for ${ticker} in the current period lock.`, [`${ticker}.strengths`]));
    } else {
      for (const strength of strengths.slice(0, 4)) {
        lines.push(bullet(strength.detail, [`${ticker}.${strength.metric}`]));
      }
    }
    lines.push('');
  }
  return lines.join('\n').trim();
}

function buildComparisonRisk(
  context: AnalysisContext,
  insights: Record<string, AnalysisInsights>,
): string {
  const lines = ['### Watch Items'];
  for (const ticker of context.tickers) {
    const flags = insights[ticker]?.redFlags || [];
    if (flags.length === 0) {
      lines.push(bullet(`**${ticker}:** No major quantitative red flag is active in the current annual snapshot.`, [`${ticker}.red_flags`]));
      continue;
    }
    lines.push(bullet(`**${ticker}:** ${flags.slice(0, 2).map(f => f.detail).join(' ')}`, [`${ticker}.red_flags`]));
  }
  return lines.join('\n');
}

function buildComparisonNotes(
  context: AnalysisContext,
  insights: Record<string, AnalysisInsights>,
): string {
  const lines = ['### Analyst Follow-Up'];
  for (const ticker of context.tickers) {
    const strengthCount = insights[ticker]?.strengths.length ?? 0;
    const riskCount = insights[ticker]?.redFlags.length ?? 0;
    lines.push(bullet(`**${ticker}:** ${strengthCount} strength signals and ${riskCount} active risk signals in the locked annual basis.`, [`${ticker}.strength_count`, `${ticker}.risk_count`]));
  }
  lines.push('');
  lines.push('Prioritize next-pass work on margin durability, balance-sheet flexibility, and cash conversion differentials across the peer set.');
  return lines.join('\n');
}

function buildNarrativeContent(
  sectionId: string,
  context: AnalysisContext,
  insights: Record<string, AnalysisInsights>,
): string {
  if (context.type === 'single') {
    const ticker = context.tickers[0]!;
    const tickerInsights = insights[ticker] || {
      snapshotPeriod: null,
      priorPeriod: null,
      topTrends: [],
      redFlags: [],
      strengths: [],
      keyMetrics: {},
    };

    switch (sectionId) {
      case 'executive_summary':
        return buildSingleExecutiveSummary(ticker, tickerInsights);
      case 'trend_analysis':
        return buildSingleTrendAnalysis(tickerInsights);
      case 'risk_factors':
        return buildSingleRiskFactors(tickerInsights);
      case 'analyst_notes':
        return buildSingleAnalystNotes(ticker, tickerInsights);
      default:
        return '';
    }
  }

  switch (sectionId) {
    case 'executive_summary':
      return buildComparisonExecutiveSummary(context, insights);
    case 'relative_strengths':
      return buildRelativeStrengths(context, insights);
    case 'risk_factors':
      return buildComparisonRisk(context, insights);
    case 'analyst_notes':
      return buildComparisonNotes(context, insights);
    default:
      return '';
  }
}

export function generateDeterministicNarrative(
  context: AnalysisContext,
  insights: Record<string, AnalysisInsights>,
): { sections: ReportSection[]; llmCallCount: number } {
  const defs = context.type === 'comparison' ? COMPARISON_REPORT_SECTIONS : SINGLE_REPORT_SECTIONS;

  const sections: ReportSection[] = defs.map(def => {
    if (def.deterministic) {
      return { id: def.id, title: def.title, content: '' };
    }
    return {
      id: def.id,
      title: def.title,
      content: buildNarrativeContent(def.id, context, insights).trim(),
    };
  });

  return { sections, llmCallCount: 0 };
}

function formatChangeSuffix(change: number | null): string {
  if (change === null || !isFinite(change)) return '';
  return ` (${fmtPct(change)} YoY)`;
}

function bullet(text: string, factIds: string[]): string {
  const ids = factIds.filter(Boolean).join(',');
  if (!ids) return `- ${text}`;
  return `- ${text} <!-- facts:${ids} -->`;
}
