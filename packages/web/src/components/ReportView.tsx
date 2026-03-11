"use client";

import ReactMarkdown from "react-markdown";

interface ReportSection {
  id: string;
  title: string;
  content: string;
}

interface ReportViewProps {
  sections: ReportSection[];
  tickers: string[];
  generatedAt?: string;
}

interface ParsedTable {
  headers: string[];
  rows: string[][];
}

type ParsedBlock =
  | { type: "markdown"; content: string }
  | { type: "table"; table: ParsedTable };

function splitPipeRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((c) => c.trim());
}

function isTableSeparator(line: string): boolean {
  const cells = splitPipeRow(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function parseMarkdownWithTables(input: string): ParsedBlock[] {
  const lines = input.split("\n");
  const blocks: ParsedBlock[] = [];
  const markdownBuffer: string[] = [];

  const flushMarkdown = () => {
    const content = markdownBuffer.join("\n").trim();
    if (content.length > 0) {
      blocks.push({ type: "markdown", content });
    }
    markdownBuffer.length = 0;
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i] || "";
    const next = lines[i + 1] || "";
    const startsTable = line.includes("|") && isTableSeparator(next);

    if (!startsTable) {
      markdownBuffer.push(line);
      i += 1;
      continue;
    }

    flushMarkdown();

    const headers = splitPipeRow(line);
    const rows: string[][] = [];
    i += 2; // skip header + separator

    while (i < lines.length) {
      const rowLine = lines[i] || "";
      if (!rowLine.trim() || !rowLine.includes("|")) break;
      rows.push(splitPipeRow(rowLine));
      i += 1;
    }

    blocks.push({ type: "table", table: { headers, rows } });
  }

  flushMarkdown();
  return blocks;
}

export function ReportView({ sections, tickers, generatedAt }: ReportViewProps) {
  if (sections.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-neutral-600">
        <p>Report will appear here as it&apos;s generated...</p>
      </div>
    );
  }

  return (
    <div className="report-content">
      {/* Report Header */}
      <div className="mb-8 rounded-[24px] border border-border/60 bg-[linear-gradient(180deg,rgba(255,255,255,0.10),rgba(255,255,255,0.03))] px-6 py-5 shadow-[0_20px_48px_rgba(15,23,42,0.10),inset_0_1px_0_rgba(255,255,255,0.14)]">
        <h1 className="mb-1 text-2xl font-bold text-foreground">
          {tickers.length === 1
            ? `${tickers[0]} Financial Analysis`
            : `${tickers.join(" vs ")} Comparison`
          }
        </h1>
        {generatedAt && (
          <p className="text-sm text-muted-foreground">
            Generated {new Date(generatedAt).toLocaleString()}
          </p>
        )}
      </div>

      {/* Report Sections */}
      {sections.map((section) => (
        <div key={section.id} className="mb-6 rounded-[24px] border border-border/60 bg-[linear-gradient(180deg,rgba(255,255,255,0.09),rgba(255,255,255,0.02))] px-6 py-5 shadow-[0_18px_42px_rgba(15,23,42,0.08),inset_0_1px_0_rgba(255,255,255,0.12)]" id={section.id}>
          {parseMarkdownWithTables(`## ${section.title}\n\n${section.content}`).map((block, idx) => {
            if (block.type === "markdown") {
              return (
                <ReactMarkdown key={`${section.id}-md-${idx}`}>
                  {block.content}
                </ReactMarkdown>
              );
            }

            return (
              <div key={`${section.id}-tbl-${idx}`} className="report-table-wrap my-4 overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr>
                      {block.table.headers.map((header, hIdx) => (
                        <th
                          key={`${section.id}-h-${idx}-${hIdx}`}
                          className="text-left font-semibold"
                        >
                          {header}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {block.table.rows.map((row, rIdx) => (
                      <tr key={`${section.id}-r-${idx}-${rIdx}`}>
                        {row.map((cell, cIdx) => (
                          <td
                            key={`${section.id}-c-${idx}-${rIdx}-${cIdx}`}
                            className=""
                          >
                            {cell}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
