import type {
  AnalysisContext,
  ReportSection,
  StructuredNarrativeParagraph,
  StructuredNarrativePayload,
  StructuredNarrativeSection,
} from '@dolph/shared';
import type { AnalysisInsights } from './analyzer.js';
import type { CanonicalReportPackage } from './canonical-report-package.js';
import type { CompanyReportModel, ReportModel } from './report-model.js';
import { SINGLE_REPORT_SECTIONS, COMPARISON_REPORT_SECTIONS } from './prompts/narrative.js';
import { classifyChangeMeaning, formatCompactCurrency, formatCompactShares } from '@dolph/shared';

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

interface NarrativeSectionBuild {
  content: string;
  paragraphs: StructuredNarrativeParagraph[];
}

function fmtPct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function fmtRatio(value: number): string {
  return `${value.toFixed(2)}x`;
}

function fmtCurrency(value: number): string {
  return formatCompactCurrency(value, { smallDecimals: 0, smartDecimals: true });
}

function fmtValue(value: number, unit: string): string {
  if (unit === '%') return fmtPct(value);
  if (unit === 'x') return fmtRatio(value);
  if (unit === 'USD') return fmtCurrency(value);
  if (unit === 'USD/share' || unit === 'USD/shares') return `$${value.toFixed(2)}`;
  if (unit === 'shares') return formatCompactShares(value);
  return `${value}`;
}

function metric(
  company: CompanyReportModel | null,
  insights: AnalysisInsights,
  name: string,
  key?: string,
): MetricPoint | undefined {
  const byKey = key ? company?.metricsByKey.get(key) : undefined;
  const byLabel = company?.metricsByLabel.get(name);
  const m = byKey || byLabel || insights.keyMetrics[name];
  const current = m?.current;
  if (current === null || current === undefined || !isFinite(current)) return undefined;
  return {
    current,
    prior: m.prior,
    change: m.change,
    unit: m.unit,
  };
}

function extractFacts(company: CompanyReportModel | null, insights: AnalysisInsights): NarrativeFacts {
  return {
    revenue: metric(company, insights, 'Revenue', 'revenue'),
    netIncome: metric(company, insights, 'Net Income', 'net_income'),
    operatingIncome: metric(company, insights, 'Operating Income', 'operating_income'),
    operatingMargin: metric(company, insights, 'Operating Margin', 'operating_margin'),
    netMargin: metric(company, insights, 'Net Margin', 'net_margin'),
    grossMargin: metric(company, insights, 'Gross Margin', 'gross_margin'),
    debtToEquity: metric(company, insights, 'Debt-to-Equity', 'de'),
    currentRatio: metric(company, insights, 'Current Ratio', 'current_ratio'),
    quickRatio: metric(company, insights, 'Quick Ratio', 'quick_ratio'),
    operatingCashFlow: metric(company, insights, 'Operating Cash Flow', 'operating_cash_flow'),
    freeCashFlow: metric(company, insights, 'Free Cash Flow', 'fcf'),
    capex: metric(company, insights, 'Capital Expenditures', 'capex'),
    roe: metric(company, insights, 'Return on Equity', 'roe'),
    roa: metric(company, insights, 'Return on Assets', 'roa'),
  };
}

function sectionFromParagraphs(paragraphs: StructuredNarrativeParagraph[]): NarrativeSectionBuild {
  return {
    content: paragraphs.map(paragraph => paragraph.text).join('\n\n').trim(),
    paragraphs,
  };
}

function sectionFromBlocks(blocks: Array<{ heading?: string; text: string; fact_ids: string[] }>): NarrativeSectionBuild {
  const paragraphs: StructuredNarrativeParagraph[] = [];
  for (const block of blocks) {
    paragraphs.push({ text: block.text, fact_ids: uniqueFactIds(block.fact_ids) });
  }
  return sectionFromParagraphs(paragraphs);
}

function uniqueFactIds(ids: string[]): string[] {
  return Array.from(new Set(ids.filter(Boolean)));
}

function firstAvailableFactIds(
  company: CompanyReportModel | null,
  insights: AnalysisInsights,
  candidates: string[],
): string[] {
  const canonical = insights.canonicalFacts || {};
  const out = candidates.filter(candidate => {
    const companyMetric = company?.metricsByKey.get(candidate);
    if (companyMetric && companyMetric.current !== null) return true;
    return !!canonical[candidate] && canonical[candidate]!.current !== null;
  });
  if (out.length > 0) return uniqueFactIds(out);
  return uniqueFactIds(candidates.filter(candidate => !!canonical[candidate] || !!company?.metricsByKey.get(candidate)));
}

function flagFactIds(flag: string, company: CompanyReportModel | null, insights: AnalysisInsights): string[] {
  const lower = flag.toLowerCase();
  if (lower.includes('leverage') || lower.includes('debt')) return firstAvailableFactIds(company, insights, ['de', 'total_debt', 'stockholders_equity']);
  if (lower.includes('liquidity')) return firstAvailableFactIds(company, insights, ['current_ratio', 'quick_ratio']);
  if (lower.includes('cash')) return firstAvailableFactIds(company, insights, ['operating_cash_flow', 'fcf']);
  if (lower.includes('margin') || lower.includes('profit')) return firstAvailableFactIds(company, insights, ['gross_margin', 'operating_margin', 'net_margin', 'net_income']);
  if (lower.includes('revenue')) return firstAvailableFactIds(company, insights, ['revenue']);
  return firstAvailableFactIds(company, insights, ['revenue', 'net_income']);
}

function strengthFactIds(metricKey: string, company: CompanyReportModel | null, insights: AnalysisInsights): string[] {
  switch (metricKey) {
    case 'revenue_growth':
      return firstAvailableFactIds(company, insights, ['revenue']);
    case 'current_ratio':
      return firstAvailableFactIds(company, insights, ['current_ratio', 'quick_ratio']);
    default:
      return firstAvailableFactIds(company, insights, [metricKey]);
  }
}

function buildSingleExecutiveSummary(
  ticker: string,
  company: CompanyReportModel | null,
  insights: AnalysisInsights,
): NarrativeSectionBuild {
  const f = extractFacts(company, insights);
  const period = insights.snapshotPeriod || 'latest annual period';
  const paragraphs: StructuredNarrativeParagraph[] = [];

  const p1Parts: string[] = [];
  const p1Facts: string[] = [];
  if (f.revenue && f.netIncome) {
    p1Parts.push(
      `${ticker} generated ${fmtCurrency(f.revenue.current)} in revenue${formatChangeSuffix(f.revenue)} and ${fmtCurrency(f.netIncome.current)} in net income${formatChangeSuffix(f.netIncome)} for ${period}.`,
    );
    p1Facts.push('revenue', 'net_income');
    // Margin context integrated into the revenue paragraph
    const marginBits: string[] = [];
    if (f.operatingMargin) {
      marginBits.push(`an operating margin of ${fmtPct(f.operatingMargin.current)}`);
      p1Facts.push('operating_margin');
    }
    if (f.netMargin) {
      marginBits.push(`a net margin of ${fmtPct(f.netMargin.current)}`);
      p1Facts.push('net_margin');
    }
    if (marginBits.length > 0) {
      p1Parts.push(`The period closed with ${marginBits.join(' and ')}.`);
    }
    const revenueChangeIsMeaningful = classifyChangeMeaning(f.revenue.current, f.revenue.prior) === 'ok';
    const netIncomeChangeIsMeaningful = classifyChangeMeaning(f.netIncome.current, f.netIncome.prior) === 'ok';
    if (f.revenue.change !== null && f.netIncome.change !== null && revenueChangeIsMeaningful && netIncomeChangeIsMeaningful) {
      if (f.revenue.change > 0.1 && f.netIncome.change > 0.1) {
        p1Parts.push('Revenue and earnings both expanded at a double-digit pace, consistent with improving operating leverage or favorable demand conditions.');
      } else if (f.revenue.change > 0.05 && f.netIncome.change < -0.05) {
        p1Parts.push('Top-line growth did not translate to the bottom line, pointing to cost inflation or margin compression that warrants attention.');
      } else if (f.revenue.change < -0.05 && f.netIncome.change > 0) {
        p1Parts.push('Earnings held up despite falling revenue, likely reflecting cost reductions, though sustained top-line decline limits how long that dynamic can persist.');
      } else if (f.revenue.change < -0.05 && f.netIncome.change < -0.05) {
        p1Parts.push('Both revenue and earnings contracted, indicating a challenging operating environment across the period.');
      }
    }
  } else if (f.revenue) {
    p1Parts.push(`${ticker} generated ${fmtCurrency(f.revenue.current)} in revenue${formatChangeSuffix(f.revenue)} for ${period}.`);
    p1Facts.push('revenue');
    if (f.operatingMargin || f.netMargin) {
      const bits: string[] = [];
      if (f.operatingMargin) { bits.push(`an operating margin of ${fmtPct(f.operatingMargin.current)}`); p1Facts.push('operating_margin'); }
      if (f.netMargin) { bits.push(`a net margin of ${fmtPct(f.netMargin.current)}`); p1Facts.push('net_margin'); }
      p1Parts.push(`The period closed with ${bits.join(' and ')}.`);
    }
  } else {
    p1Parts.push(`${ticker} has limited annual coverage in the locked period; analysis relies on the verified statement tables below.`);
    p1Facts.push(...firstAvailableFactIds(company, insights, ['revenue', 'net_income']));
  }
  paragraphs.push({ text: p1Parts.join(' '), fact_ids: uniqueFactIds(p1Facts) });

  const p2Parts: string[] = [];
  const p2Facts: string[] = [];
  const cashStress = !!(
    (f.operatingCashFlow && f.operatingCashFlow.current < 0)
    || (f.freeCashFlow && f.freeCashFlow.current < 0)
  );
  if (f.debtToEquity && f.currentRatio) {
    const leverage = f.debtToEquity.current;
    const liquidity = f.currentRatio.current;
    const negativeEquity = leverage < 0;
    p2Facts.push(...firstAvailableFactIds(company, insights, ['de', 'current_ratio']));
    if (negativeEquity) {
      // Negative equity makes D/E ratio interpretation misleading — explain directly
      p2Parts.push(`Stockholders' equity is negative, producing a debt-to-equity ratio of ${fmtRatio(leverage)} that does not lend itself to conventional leverage interpretation.`);
      p2Parts.push(`The current ratio of ${fmtRatio(liquidity)} provides a more reliable near-term solvency reference.`);
      p2Facts.push(...firstAvailableFactIds(company, insights, ['stockholders_equity']));
    } else if (leverage < 0.3 && liquidity >= 1.5 && !cashStress) {
      p2Parts.push(`Debt-to-equity of ${fmtRatio(leverage)} and a current ratio of ${fmtRatio(liquidity)} indicate a conservatively capitalized balance sheet with room for opportunistic deployment.`);
    } else if (leverage < 0.3 && liquidity >= 1.5) {
      p2Parts.push(`Debt-to-equity of ${fmtRatio(leverage)} and a current ratio of ${fmtRatio(liquidity)} suggest low structural leverage, though negative operating or free cash flow limits the practical benefit of that headroom.`);
      p2Facts.push(...firstAvailableFactIds(company, insights, ['operating_cash_flow', 'fcf']));
    } else if (leverage > 2) {
      p2Parts.push(`At ${fmtRatio(leverage)} debt-to-equity, the capital structure carries above-average leverage that increases refinancing and interest-rate sensitivity.`);
      if (liquidity < 1.0) {
        p2Parts.push(`A current ratio below 1.0x (${fmtRatio(liquidity)}) adds near-term liquidity pressure to the leverage concern.`);
      } else {
        p2Parts.push(`The current ratio of ${fmtRatio(liquidity)} provides some near-term coverage.`);
      }
    } else {
      p2Parts.push(`Debt-to-equity of ${fmtRatio(leverage)} and a current ratio of ${fmtRatio(liquidity)} reflect a moderate capital structure without extreme positioning in either direction.`);
    }
  } else if (f.currentRatio) {
    p2Facts.push('current_ratio');
    if (cashStress) {
      p2Parts.push(`The current ratio of ${fmtRatio(f.currentRatio.current)} provides baseline coverage, but negative operating or free cash flow limits the practical liquidity cushion.`);
      p2Facts.push(...firstAvailableFactIds(company, insights, ['operating_cash_flow', 'fcf']));
    } else {
      p2Parts.push(`The current ratio stands at ${fmtRatio(f.currentRatio.current)}, providing a baseline liquidity reference.`);
    }
  }
  if (f.quickRatio && p2Parts.length > 0) {
    p2Facts.push('quick_ratio');
    if (cashStress) {
      p2Parts.push(`The quick ratio of ${fmtRatio(f.quickRatio.current)} still shows current-asset coverage after excluding inventory, but it does not offset the current cash burn.`);
    } else {
      p2Parts.push(`The quick ratio of ${fmtRatio(f.quickRatio.current)} confirms liquidity depth after excluding inventory from the coverage calculation.`);
    }
  }
  if (p2Parts.length > 0) {
    paragraphs.push({ text: p2Parts.join(' '), fact_ids: uniqueFactIds(p2Facts) });
  }

  const p3Parts: string[] = [];
  const p3Facts: string[] = [];
  if (f.operatingCashFlow && f.freeCashFlow) {
    p3Facts.push('operating_cash_flow', 'fcf');
    p3Parts.push(`Operating cash flow of ${fmtCurrency(f.operatingCashFlow.current)}${formatChangeSuffix(f.operatingCashFlow)} converted to ${fmtCurrency(f.freeCashFlow.current)} in free cash flow${formatChangeSuffix(f.freeCashFlow)}.`);
    if (f.capex) {
      p3Facts.push('capex');
      const capexIntensity = f.revenue ? (Math.abs(f.capex.current) / f.revenue.current * 100).toFixed(1) : null;
      const capexNote = capexIntensity ? ` (${capexIntensity}% of revenue)` : '';
      p3Parts.push(`Capital expenditures totaled ${fmtCurrency(Math.abs(f.capex.current))}${capexNote}.`);
      if (f.revenue) p3Facts.push('revenue');
    }
    if (f.operatingCashFlow.current > 0 && f.freeCashFlow.current > 0 && f.netIncome && f.netIncome.current > 0) {
      const cfoToNi = f.operatingCashFlow.current / f.netIncome.current;
      p3Facts.push('net_income');
      if (cfoToNi > 1.2) {
        p3Parts.push('Cash generation exceeded reported earnings, indicating strong accrual-to-cash conversion.');
      } else if (cfoToNi < 0.7 && cfoToNi > 0) {
        p3Parts.push('Reported earnings significantly outpaced cash generation, suggesting working capital consumption or accrual timing effects worth monitoring.');
      }
    }
  } else if (f.operatingCashFlow) {
    p3Facts.push('operating_cash_flow');
    p3Parts.push(`Operating cash flow was ${fmtCurrency(f.operatingCashFlow.current)}${formatChangeSuffix(f.operatingCashFlow)}.`);
  } else {
    p3Facts.push(...firstAvailableFactIds(company, insights, ['operating_cash_flow', 'fcf', 'revenue']));
    p3Parts.push('Cash-flow data is limited in the locked annual period.');
  }
  if (p3Parts.length > 0) {
    paragraphs.push({ text: p3Parts.join(' '), fact_ids: uniqueFactIds(p3Facts) });
  }

  return sectionFromParagraphs(paragraphs.filter(paragraph => paragraph.text.trim().length > 0));
}

function buildSingleTrendAnalysis(company: CompanyReportModel | null, insights: AnalysisInsights): NarrativeSectionBuild {
  if (insights.topTrends.length === 0) {
    return sectionFromParagraphs([
      {
        text: 'Annual trend coverage is limited in this run; interpretation relies on current-period statement consistency.',
        fact_ids: firstAvailableFactIds(company, insights, ['revenue', 'net_income']),
      },
    ]);
  }

  const blocks = insights.topTrends.slice(0, 4).map(trend => {
    const cagrText = trend.cagr !== null ? `${fmtPct(trend.cagr)} CAGR` : 'CAGR unavailable';
    const latestText = trend.latestValue !== null ? fmtCurrency(trend.latestValue) : 'N/A';
    return {
      text: `${trend.displayName} stands at ${latestText} (${cagrText}). ${trend.description}`,
      fact_ids: [trend.metric],
    };
  });
  return sectionFromBlocks(blocks);
}

function buildSingleRiskFactors(
  company: CompanyReportModel | null,
  insights: AnalysisInsights,
): NarrativeSectionBuild {
  const lines: Array<{ heading?: string; text: string; fact_ids: string[] }> = insights.redFlags.length === 0
    ? [{
      text: 'No major quantitative red flags are active in the locked annual snapshot, although margin durability and cash conversion still warrant routine monitoring.',
      fact_ids: firstAvailableFactIds(company, insights, ['operating_margin', 'fcf', 'operating_cash_flow']),
    }]
    : insights.redFlags.slice(0, 5).map(flag => ({
      text: `${flag.flag}: ${flag.detail}`,
      fact_ids: flagFactIds(flag.flag, company, insights),
    }));

  if (insights.redFlags.length > 0) {
    lines.unshift({
      text: 'The following governed risk signals are active in the locked annual basis and should frame interpretation of the current results.',
      fact_ids: firstAvailableFactIds(company, insights, ['revenue', 'net_income']),
    });
  }

  return sectionFromBlocks(lines);
}

function buildSingleAnalystNotes(
  ticker: string,
  company: CompanyReportModel | null,
  insights: AnalysisInsights,
): NarrativeSectionBuild {
  const strengths = insights.strengths.slice(0, 3);
  const blocks: Array<{ heading?: string; text: string; fact_ids: string[] }> = [];

  // Strengths section (unique to analyst notes — risk factors are in the separate risk section)
  blocks.push({ text: strengths.length === 0
    ? `${ticker}'s profile is balanced without a dominant quantitative outperformance signal in the current period.`
    : strengths[0]!.detail, fact_ids: strengths.length === 0 ? firstAvailableFactIds(company, insights, ['revenue', 'net_income']) : strengthFactIds(strengths[0]!.metric, company, insights) });
  for (const strength of strengths.slice(1)) {
    blocks.push({ text: strength.detail, fact_ids: strengthFactIds(strength.metric, company, insights) });
  }

  // Methodology note (no duplication of risk factors — those are in the Risk Factors section)
  blocks.push({
    text: `Analysis is anchored to the locked annual period ending ${insights.snapshotPeriod ?? 'N/A'}${insights.priorPeriod ? `, with prior-period comparisons drawn from ${insights.priorPeriod}` : ''}. Metrics without required inputs remain intentionally unfilled rather than estimated.`,
    fact_ids: firstAvailableFactIds(company, insights, ['revenue', 'net_income']),
  });

  return sectionFromBlocks(blocks);
}

function buildComparisonExecutiveSummary(
  context: AnalysisContext,
  reportModel: ReportModel | null,
  insights: Record<string, AnalysisInsights>,
): NarrativeSectionBuild {
  const summaries = context.tickers.map(t => {
    const i = insights[t];
    const company = reportModel?.companiesByTicker.get(t) || null;
    const facts = extractFacts(company, i);
    return {
      ticker: t,
      revenue: facts.revenue?.current ?? null,
      revenueChange: facts.revenue?.change ?? null,
      revenuePrior: facts.revenue?.prior ?? null,
      netIncome: facts.netIncome?.current ?? null,
      netMargin: facts.netMargin?.current ?? null,
      debtToEquity: facts.debtToEquity?.current ?? null,
      freeCashFlow: facts.freeCashFlow?.current ?? null,
      period: i.snapshotPeriod ?? 'N/A',
    };
  });

  const paragraphs: StructuredNarrativeParagraph[] = [];
  const periods = summaries.map(s => s.period).filter(p => p !== 'N/A');
  const uniquePeriods = [...new Set(periods)];
  const periodNote = uniquePeriods.length === 1
    ? `based on ${uniquePeriods[0]} annual filings`
    : `using each company's most recent annual filing`;
  paragraphs.push({
    text: `The following comparison of ${context.tickers.join(', ')} is ${periodNote}, covering revenue scale, profitability, leverage, and cash generation.`,
    fact_ids: ['revenue', 'net_income', 'de', 'fcf'],
  });

  for (const s of summaries) {
    const parts: string[] = [];
    const factIds = ['revenue'];
    const rev = s.revenue !== null ? fmtCurrency(s.revenue) : null;
    const ni = s.netIncome !== null ? fmtCurrency(s.netIncome) : null;
    const revChg = formatChangeSuffixFromValues(s.revenueChange, s.revenue, s.revenuePrior, 'USD');

    if (rev && ni) {
      parts.push(`${s.ticker} generated ${rev} in revenue${revChg} and ${ni} in net income (${s.period}).`);
      factIds.push('net_income');
    } else if (rev) {
      parts.push(`${s.ticker} generated ${rev} in revenue${revChg} (${s.period}).`);
    } else {
      parts.push(`${s.ticker} has limited data coverage for the locked period.`);
    }

    const profileBits: string[] = [];
    if (s.netMargin !== null) {
      profileBits.push(`net margin of ${fmtPct(s.netMargin)}`);
      factIds.push('net_margin');
    }
    if (s.debtToEquity !== null) {
      profileBits.push(`debt-to-equity of ${fmtRatio(s.debtToEquity)}`);
      factIds.push('de');
    }
    if (s.freeCashFlow !== null) {
      profileBits.push(`free cash flow of ${fmtCurrency(s.freeCashFlow)}`);
      factIds.push('fcf');
    }
    if (profileBits.length > 0) {
      parts.push(`Key profile markers include ${profileBits.join(', ')}.`);
    }

    paragraphs.push({ text: parts.join(' '), fact_ids: uniqueFactIds(factIds) });
  }

  const revenueLeader = [...summaries].filter(s => s.revenue !== null).sort((a, b) => (b.revenue ?? 0) - (a.revenue ?? 0))[0];
  const marginLeader = [...summaries].filter(s => s.netMargin !== null).sort((a, b) => (b.netMargin ?? 0) - (a.netMargin ?? 0))[0];
  if (revenueLeader && marginLeader && revenueLeader.ticker !== marginLeader.ticker) {
    paragraphs.push({
      text: `${revenueLeader.ticker} leads the peer set on absolute revenue, while ${marginLeader.ticker} carries the highest net margin — a classic scale-versus-efficiency divergence.`,
      fact_ids: ['revenue', 'net_margin'],
    });
  } else if (revenueLeader) {
    paragraphs.push({
      text: `${revenueLeader.ticker} leads the peer set on annual revenue.`,
      fact_ids: ['revenue'],
    });
  }

  return sectionFromParagraphs(paragraphs);
}

function buildRelativeStrengths(
  context: AnalysisContext,
  reportModel: ReportModel | null,
  insights: Record<string, AnalysisInsights>,
): NarrativeSectionBuild {
  const blocks: Array<{ heading?: string; text: string; fact_ids: string[] }> = [];
  for (const ticker of context.tickers) {
    const strengths = insights[ticker]?.strengths || [];
    blocks.push({
      text: strengths.length === 0
        ? `No clear quantitative outperformance signal is active for ${ticker} in the current period lock.`
        : strengths[0]!.detail,
      fact_ids: strengths.length === 0
        ? firstAvailableFactIds(reportModel?.companiesByTicker.get(ticker) || null, insights[ticker]!, ['revenue', 'net_income'])
        : strengthFactIds(strengths[0]!.metric, reportModel?.companiesByTicker.get(ticker) || null, insights[ticker]!),
    });
    for (const strength of strengths.slice(1, 4)) {
      blocks.push({ text: strength.detail, fact_ids: strengthFactIds(strength.metric, reportModel?.companiesByTicker.get(ticker) || null, insights[ticker]!) });
    }
  }
  return sectionFromBlocks(blocks);
}

function buildComparisonRisk(
  context: AnalysisContext,
  reportModel: ReportModel | null,
  insights: Record<string, AnalysisInsights>,
): NarrativeSectionBuild {
  const blocks: Array<{ heading?: string; text: string; fact_ids: string[] }> = [
    {
      text: 'Risk signals below are drawn from each peer\'s locked annual data; metrics not reported by a peer are excluded rather than imputed.',
      fact_ids: ['revenue', 'de', 'fcf'],
    },
  ];
  for (const ticker of context.tickers) {
    const flags = insights[ticker]?.redFlags || [];
    if (flags.length === 0) {
      blocks.push({
        text: `${ticker}: No quantitative red flags surfaced for the locked annual period.`,
        fact_ids: firstAvailableFactIds(reportModel?.companiesByTicker.get(ticker) || null, insights[ticker]!, ['revenue', 'net_income']),
      });
      continue;
    }
    blocks.push({
      text: `${ticker}: ${flags.slice(0, 2).map(f => f.detail).join(' ')}`,
      fact_ids: uniqueFactIds(flags.slice(0, 2).flatMap(flag => flagFactIds(flag.flag, reportModel?.companiesByTicker.get(ticker) || null, insights[ticker]!))),
    });
  }
  return sectionFromBlocks(blocks);
}

function buildComparisonNotes(
  context: AnalysisContext,
  reportModel: ReportModel | null,
  insights: Record<string, AnalysisInsights>,
): NarrativeSectionBuild {
  const blocks: Array<{ heading?: string; text: string; fact_ids: string[] }> = [
    {
      text: 'All peer data is drawn from locked annual filings. Where a metric is absent for one peer, it is excluded from comparison rather than estimated.',
      fact_ids: ['revenue', 'net_income', 'de', 'fcf'],
    },
  ];
  for (const ticker of context.tickers) {
    const strengths = insights[ticker]?.strengths ?? [];
    const flags = insights[ticker]?.redFlags ?? [];
    const parts: string[] = [];
    if (strengths.length > 0) {
      parts.push(`${strengths.length} strength signal${strengths.length > 1 ? 's' : ''}`);
    }
    if (flags.length > 0) {
      parts.push(`${flags.length} watch item${flags.length > 1 ? 's' : ''}`);
    }
    const summary = parts.length > 0 ? parts.join(' and ') : 'no material signals either way';
    blocks.push({
      text: `${ticker}: ${summary}.`,
      fact_ids: firstAvailableFactIds(reportModel?.companiesByTicker.get(ticker) || null, insights[ticker]!, ['revenue', 'net_income']),
    });
  }
  return sectionFromBlocks(blocks);
}

function buildNarrativeSection(
  sectionId: string,
  context: AnalysisContext,
  reportModel: ReportModel | null,
  insights: Record<string, AnalysisInsights>,
): NarrativeSectionBuild {
  if (context.type === 'single') {
    const ticker = context.tickers[0]!;
    const tickerInsights = insights[ticker] || {
      snapshotPeriod: null,
      priorPeriod: null,
      topTrends: [],
      redFlags: [],
      strengths: [],
      keyMetrics: {},
      canonicalFacts: {},
    } as AnalysisInsights;
    const company = reportModel?.companiesByTicker.get(ticker) || null;

    switch (sectionId) {
      case 'executive_summary':
        return buildSingleExecutiveSummary(ticker, company, tickerInsights);
      case 'trend_analysis':
        return buildSingleTrendAnalysis(company, tickerInsights);
      case 'risk_factors':
        return buildSingleRiskFactors(company, tickerInsights);
      case 'analyst_notes':
        return buildSingleAnalystNotes(ticker, company, tickerInsights);
      default:
        return sectionFromParagraphs([]);
    }
  }

  switch (sectionId) {
    case 'executive_summary':
      return buildComparisonExecutiveSummary(context, reportModel, insights);
    case 'relative_strengths':
      return buildRelativeStrengths(context, reportModel, insights);
    case 'risk_factors':
      return buildComparisonRisk(context, reportModel, insights);
    case 'analyst_notes':
      return buildComparisonNotes(context, reportModel, insights);
    default:
      return sectionFromParagraphs([]);
  }
}

export function generateDeterministicNarrative(
  contextOrPackage: AnalysisContext | CanonicalReportPackage,
  insightsArg?: Record<string, AnalysisInsights>,
): { sections: ReportSection[]; llmCallCount: number; narrative: StructuredNarrativePayload } {
  const context = isCanonicalPackage(contextOrPackage)
    ? contextOrPackage.context
    : contextOrPackage;
  const insights = isCanonicalPackage(contextOrPackage)
    ? contextOrPackage.insights
    : (insightsArg || {});
  const reportModel = isCanonicalPackage(contextOrPackage)
    ? contextOrPackage.reportModel
    : null;
  const defs = context.type === 'comparison' ? COMPARISON_REPORT_SECTIONS : SINGLE_REPORT_SECTIONS;
  const sections: ReportSection[] = [];
  const narrativeSections: StructuredNarrativeSection[] = [];

  for (const def of defs) {
    if (def.deterministic) {
      sections.push({ id: def.id, title: def.title, content: '' });
      continue;
    }

    const built = buildNarrativeSection(def.id, context, reportModel, insights);
    sections.push({
      id: def.id,
      title: def.title,
      content: built.content.trim(),
    });
    narrativeSections.push({
      id: def.id,
      title: def.title,
      rendered_content: built.content.trim(),
      paragraphs: built.paragraphs,
    });
  }

  return {
    sections,
    llmCallCount: 0,
    narrative: {
      mode: 'deterministic',
      sections: narrativeSections,
    },
  };
}

function isCanonicalPackage(
  value: AnalysisContext | CanonicalReportPackage,
): value is CanonicalReportPackage {
  return typeof value === 'object' && value !== null && 'reportModel' in value && 'insights' in value;
}

function formatChangeSuffix(point: MetricPoint | undefined): string {
  if (!point) return '';
  return formatChangeSuffixFromValues(point.change, point.current, point.prior, point.unit);
}

function formatChangeSuffixFromValues(
  change: number | null,
  current: number | null,
  prior: number | null,
  unit: string,
): string {
  if (change === null || current === null || !isFinite(change) || !isFinite(current)) return '';

  const meaning = classifyChangeMeaning(current, prior);
  if (meaning === 'ok') return ` (${fmtPct(change)} YoY)`;
  if (prior === null || !isFinite(prior)) return '';

  const priorText = fmtValue(prior, unit);
  if (meaning === 'sign_flip') {
    return ` versus ${priorText} in the prior period`;
  }
  if (meaning === 'tiny_base' || meaning === 'zero_base') {
    return ` versus ${priorText} in the prior period (base too small for a meaningful percentage comparison)`;
  }
  return '';
}
