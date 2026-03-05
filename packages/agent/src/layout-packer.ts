export interface LayoutModule {
  id: string;
  html: string;
  units: number;
  primary?: boolean;
  splitAllowed?: boolean;
  priority?: number;
}

export interface PackedPage {
  modules: LayoutModule[];
  estimatedFill: number;
}

export interface LayoutPackOptions {
  pageCapacityUnits: number;
  minFill: number;
  minPrimaryModules: number;
  allowSingleModulePage?: boolean;
  expansionModules?: LayoutModule[];
}

export function packDeterministicPages(
  modules: LayoutModule[],
  options: LayoutPackOptions,
): PackedPage[] {
  if (modules.length === 0) return [];

  const sanitized = modules
    .filter(m => m.html.trim().length > 0)
    .map(m => ({
      ...m,
      units: Math.max(1, Number.isFinite(m.units) ? Math.round(m.units) : 1),
      primary: m.primary ?? true,
      priority: m.priority ?? 50,
    }));

  const expansionPool = [...(options.expansionModules || [])]
    .filter(m => m.html.trim().length > 0)
    .map(m => ({
      ...m,
      units: Math.max(1, Number.isFinite(m.units) ? Math.round(m.units) : 1),
      primary: m.primary ?? false,
      priority: m.priority ?? 90,
    }))
    .sort((a, b) => (a.priority ?? 90) - (b.priority ?? 90));

  const pages: LayoutModule[][] = greedyChunk(sanitized, options.pageCapacityUnits);
  rebalancePages(pages, options.pageCapacityUnits, options.minFill, options.minPrimaryModules, expansionPool);
  topUpUnderfilledPages(pages, options.pageCapacityUnits, options.minFill, expansionPool);
  enforceModuleDensity(pages, options.pageCapacityUnits, options.minPrimaryModules, !!options.allowSingleModulePage);
  mergeSparseTailPages(pages, options.pageCapacityUnits, options.minFill, !!options.allowSingleModulePage);

  return pages
    .filter(page => page.length > 0)
    .map(page => ({
      modules: page,
      estimatedFill: estimateFill(page, options.pageCapacityUnits),
    }));
}

function greedyChunk(modules: LayoutModule[], capacity: number): LayoutModule[][] {
  const pages: LayoutModule[][] = [];
  let current: LayoutModule[] = [];
  let used = 0;

  for (const mod of modules) {
    if (current.length > 0 && used + mod.units > capacity) {
      pages.push(current);
      current = [];
      used = 0;
    }
    current.push(mod);
    used += mod.units;
  }
  if (current.length > 0) pages.push(current);
  return pages;
}

function rebalancePages(
  pages: LayoutModule[][],
  capacity: number,
  minFill: number,
  minPrimaryModules: number,
  expansionPool: LayoutModule[],
): void {
  for (let i = 0; i < pages.length; i++) {
    while (i < pages.length - 1 && estimateFill(pages[i]!, capacity) < minFill) {
      const current = pages[i]!;
      const next = pages[i + 1]!;
      const moved = moveBestFitFromNext(current, next, capacity, minPrimaryModules);
      if (moved) {
        if (next.length === 0) {
          pages.splice(i + 1, 1);
        }
        continue;
      }

      if (injectExpansion(current, expansionPool, capacity)) {
        continue;
      }

      if (canMerge(current, next, capacity)) {
        current.push(...next);
        pages.splice(i + 1, 1);
        continue;
      }

      break;
    }
  }
}

function moveBestFitFromNext(
  current: LayoutModule[],
  next: LayoutModule[],
  capacity: number,
  minPrimaryModules: number,
): boolean {
  if (next.length === 0) return false;

  const currentUnits = pageUnits(current);
  const nextPrimaryCount = countPrimary(next);

  const candidates = next
    .map((mod, idx) => ({ mod, idx }))
    .filter(({ mod }) => currentUnits + mod.units <= capacity)
    .filter(({ mod }) => {
      if (mod.primary && nextPrimaryCount <= minPrimaryModules) return false;
      return true;
    })
    .sort((a, b) => {
      if ((a.mod.priority ?? 50) !== (b.mod.priority ?? 50)) {
        return (a.mod.priority ?? 50) - (b.mod.priority ?? 50);
      }
      return b.mod.units - a.mod.units;
    });

  if (candidates.length === 0) return false;

  const picked = candidates[0]!;
  current.push(picked.mod);
  next.splice(picked.idx, 1);
  return true;
}

function injectExpansion(current: LayoutModule[], pool: LayoutModule[], capacity: number): boolean {
  const used = pageUnits(current);
  const idx = pool.findIndex(m => used + m.units <= capacity);
  if (idx < 0) return false;
  const [picked] = pool.splice(idx, 1);
  if (!picked) return false;
  current.push(picked);
  return true;
}

function topUpUnderfilledPages(
  pages: LayoutModule[][],
  capacity: number,
  minFill: number,
  expansionPool: LayoutModule[],
): void {
  for (const page of pages) {
    while (estimateFill(page, capacity) < minFill) {
      const injected = injectExpansion(page, expansionPool, capacity);
      if (!injected) break;
    }
  }
}

function canMerge(a: LayoutModule[], b: LayoutModule[], capacity: number): boolean {
  return pageUnits(a) + pageUnits(b) <= capacity;
}

function enforceModuleDensity(
  pages: LayoutModule[][],
  capacity: number,
  minPrimaryModules: number,
  allowSingleModulePage: boolean,
): void {
  if (allowSingleModulePage) return;

  for (let i = 0; i < pages.length; i++) {
    const page = pages[i]!;
    if (countPrimary(page) >= minPrimaryModules) continue;

    if (i > 0 && canMerge(pages[i - 1]!, page, capacity)) {
      pages[i - 1]!.push(...page);
      pages.splice(i, 1);
      i--;
      continue;
    }

    if (i < pages.length - 1 && canMerge(page, pages[i + 1]!, capacity)) {
      page.push(...pages[i + 1]!);
      pages.splice(i + 1, 1);
      continue;
    }
  }
}

function mergeSparseTailPages(
  pages: LayoutModule[][],
  capacity: number,
  minFill: number,
  allowSingleModulePage: boolean,
): void {
  if (pages.length < 2) return;
  if (allowSingleModulePage) return;

  const last = pages[pages.length - 1]!;
  const prev = pages[pages.length - 2]!;
  if (estimateFill(last, capacity) >= minFill) return;

  if (canMerge(prev, last, capacity)) {
    prev.push(...last);
    pages.pop();
  }
}

function pageUnits(modules: LayoutModule[]): number {
  return modules.reduce((sum, mod) => sum + Math.max(1, mod.units), 0);
}

function countPrimary(modules: LayoutModule[]): number {
  return modules.reduce((sum, mod) => sum + (mod.primary ? 1 : 0), 0);
}

function estimateFill(modules: LayoutModule[], capacity: number): number {
  if (capacity <= 0) return 0;
  const ratio = pageUnits(modules) / capacity;
  return Math.max(0, Math.min(1, ratio));
}
