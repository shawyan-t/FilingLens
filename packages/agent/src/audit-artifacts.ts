import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type {
  AuditArtifactManifest,
  Report,
} from '@dolph/shared';
import type { AnalysisContext } from '@dolph/shared';
import type { AnalysisInsights } from './analyzer.js';
import type { DeterministicQAResult } from './deterministic-qa.js';
import type { ReportModel } from './report-model.js';

interface AuditArtifactInput {
  report: Report;
  context: AnalysisContext;
  insights: Record<string, AnalysisInsights>;
  reportModel: ReportModel;
  qa: DeterministicQAResult;
  outputDir: string;
  pdfPath?: string | null;
}

export async function writeAuditArtifacts(input: AuditArtifactInput): Promise<AuditArtifactManifest> {
  const timestamp = new Date(input.report.generated_at)
    .toISOString()
    .replace(/[:.]/g, '-')
    .slice(0, 19);
  const slug = input.report.tickers.join('-');
  const artifactDir = resolve(input.outputDir, `${slug}-${timestamp}-audit`);
  await mkdir(artifactDir, { recursive: true });

  const files: Record<string, string> = {};

  // 1. QA result
  await writeJson(
    artifactDir,
    'qa-result.json',
    {
      status: input.qa.pass ? 'pass' : 'fail',
      pass: input.qa.pass,
      failures: input.qa.failures,
      mappingFixes: input.qa.mappingFixes,
      recomputedMetrics: input.qa.recomputedMetrics,
      periodBasis: input.qa.periodBasis,
    },
    files,
  );

  // 2. Source manifest
  await writeJson(
    artifactDir,
    'source-manifest.json',
    {
      sources: input.report.sources,
      provenance: input.report.provenance || {},
      filings: Object.fromEntries(
        input.reportModel.companies.map(company => [company.ticker, company.filingReferences]),
      ),
    },
    files,
  );

  // 3. Canonical ledger
  await writeJson(
    artifactDir,
    'canonical-ledger.json',
    Object.fromEntries(
      input.reportModel.companies.map(company => [
        company.ticker,
        Object.fromEntries(
          Array.from(company.canonicalPeriodMap.entries()).map(([period, values]) => [period, values]),
        ),
      ]),
    ),
    files,
  );

  return {
    directory: artifactDir,
    generated_at: input.report.generated_at,
    files,
  };
}

async function writeJson(
  dir: string,
  name: string,
  data: unknown,
  files: Record<string, string>,
): Promise<void> {
  const path = resolve(dir, name);
  await writeFile(path, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  files[name] = path;
}
