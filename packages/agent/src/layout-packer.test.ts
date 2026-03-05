import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { packDeterministicPages, type LayoutModule } from './layout-packer.js';

describe('layout packer', () => {
  it('moves modules forward and merges sparse tail pages when possible', () => {
    const modules: LayoutModule[] = [
      { id: 'a', html: '<div>A</div>', units: 12, primary: true, priority: 1 },
      { id: 'b', html: '<div>B</div>', units: 8, primary: true, priority: 2 },
      { id: 'c', html: '<div>C</div>', units: 4, primary: true, priority: 3 },
    ];

    const packed = packDeterministicPages(modules, {
      pageCapacityUnits: 24,
      minFill: 0.75,
      minPrimaryModules: 2,
    });

    assert.equal(packed.length, 1);
    assert.equal(packed[0]?.modules.length, 3);
    assert.ok((packed[0]?.estimatedFill ?? 0) >= 0.75);
  });

  it('injects deterministic expansion modules for underfilled pages', () => {
    const modules: LayoutModule[] = [
      { id: 'a', html: '<div>A</div>', units: 8, primary: true, priority: 1 },
      { id: 'b', html: '<div>B</div>', units: 4, primary: true, priority: 2 },
    ];
    const expansions: LayoutModule[] = [
      { id: 'x1', html: '<div>X1</div>', units: 4, primary: false, priority: 10 },
      { id: 'x2', html: '<div>X2</div>', units: 4, primary: false, priority: 20 },
    ];

    const packed = packDeterministicPages(modules, {
      pageCapacityUnits: 20,
      minFill: 0.75,
      minPrimaryModules: 2,
      expansionModules: expansions,
    });

    assert.equal(packed.length, 1);
    const ids = (packed[0]?.modules || []).map(m => m.id);
    assert.ok(ids.includes('x1'));
    assert.ok((packed[0]?.estimatedFill ?? 0) >= 0.75);
  });
});
