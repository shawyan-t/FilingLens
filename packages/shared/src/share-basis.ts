/**
 * Unified share-basis cross-validation.
 *
 * One contract: if period-end shares_outstanding diverges > 50% from
 * EPS-implied diluted shares, fall back to weighted_avg_shares_diluted.
 */

const DIVERGENCE_THRESHOLD = 0.50;

/**
 * Cross-validate shares_outstanding against EPS-implied share count.
 * Returns the best available share count, or null if unavailable.
 */
export function crossValidatedShareCount(v: Record<string, number>): number | null {
  const shares = finitePositive(v['shares_outstanding']);
  if (shares === null) return null;

  const netIncome = finiteNonZero(v['net_income']);
  const epsDiluted = finiteNonZero(v['eps_diluted']);

  if (netIncome !== null && epsDiluted !== null) {
    const impliedShares = netIncome / epsDiluted;
    if (isFinite(impliedShares) && impliedShares > 0) {
      const divergence = Math.abs(impliedShares - shares) / Math.max(impliedShares, shares);
      if (divergence > DIVERGENCE_THRESHOLD) {
        const dilutedShares = finitePositive(v['weighted_avg_shares_diluted']);
        if (dilutedShares !== null) return dilutedShares;
      }
    }
  }

  return shares;
}

/**
 * Returns true if shares_outstanding materially diverges from EPS-implied shares.
 */
export function shareCountDiverges(v: Record<string, number>): boolean {
  const shares = finitePositive(v['shares_outstanding']);
  if (shares === null) return false;

  const netIncome = finiteNonZero(v['net_income']);
  const epsDiluted = finiteNonZero(v['eps_diluted']);

  if (netIncome !== null && epsDiluted !== null) {
    const impliedShares = netIncome / epsDiluted;
    if (isFinite(impliedShares) && impliedShares > 0) {
      const divergence = Math.abs(impliedShares - shares) / Math.max(impliedShares, shares);
      return divergence > DIVERGENCE_THRESHOLD;
    }
  }

  return false;
}

function finitePositive(v: number | undefined | null): number | null {
  if (v == null || !isFinite(v) || v <= 0) return null;
  return v;
}

function finiteNonZero(v: number | undefined | null): number | null {
  if (v == null || !isFinite(v) || v === 0) return null;
  return v;
}
