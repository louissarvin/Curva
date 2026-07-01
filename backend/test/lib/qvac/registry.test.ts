/**
 * F12 registry loader tests.
 */

import { describe, expect, test, beforeAll } from 'bun:test';

const { loadRegistry, getModel, listModels, __resetForTest } = await import(
  '../../../src/lib/qvac/registry.ts'
);

beforeAll(() => {
  __resetForTest();
});

describe('QVAC registry', () => {
  test('loads and validates qvac-models.json', () => {
    const reg = loadRegistry();
    // Fix Wave C T3 dropped the three legacy pseudo-entries (bergamot-itid/
    // iten/enid) that pointed at a github release URL without binaries.
    // Schema bumped to 1.2.0; catalog is now the 12 EN-hub pairs.
    expect(reg.version).toBe('1.2.0');
    expect(typeof reg.generatedAt).toBe('string');
    expect(reg.models.length).toBe(12);
  });

  test('every shipped model is a Bergamot translate entry', () => {
    for (const m of loadRegistry().models) {
      expect(m.family).toBe('bergamot');
      expect(m.capabilities).toContain('translate');
      expect(m.license).toBe('MPL-2.0');
      expect(m.size).toBeGreaterThan(0);
      // Ship state per architect: URLs pending upstream.
      expect(m.status).toBe('pending-upstream');
    }
  });

  test('getModel returns the IT->EN demo model (Fix Wave C T3)', () => {
    // The old primary (bergamot-itid) was dropped; IT<->ID is now composed
    // from bergamot-it-en + bergamot-en-id via native modelConfig.pivotModel.
    const m = getModel('bergamot-it-en');
    expect(m).toBeDefined();
    expect(m?.name).toContain('Italian');
    expect(m?.sourceLangs).toEqual(['it']);
    expect(m?.targetLangs).toEqual(['en']);
  });

  test('getModel is undefined for unknown id', () => {
    expect(getModel('nonexistent')).toBeUndefined();
    expect(getModel('')).toBeUndefined();
    // Path traversal & garbage inputs — should not crash.
    expect(getModel('../etc/passwd')).toBeUndefined();
  });

  test('listModels filters by family', () => {
    expect(listModels({ family: 'bergamot' })).toHaveLength(12);
    expect(listModels({ family: 'whisper' })).toHaveLength(0);
  });

  test('listModels filters by capability', () => {
    expect(listModels({ capability: 'translate' })).toHaveLength(12);
    expect(listModels({ capability: 'stt' })).toHaveLength(0);
  });

  test('listModels combines filters', () => {
    expect(
      listModels({ family: 'bergamot', capability: 'translate' })
    ).toHaveLength(12);
    expect(
      listModels({ family: 'bergamot', capability: 'stt' })
    ).toHaveLength(0);
  });

  test('registry is frozen (no runtime mutation)', () => {
    const reg = loadRegistry();
    expect(Object.isFrozen(reg)).toBe(true);
    expect(Object.isFrozen(reg.models[0])).toBe(true);
  });

  test('contentDigest is null on pending-upstream entries', () => {
    for (const m of loadRegistry().models) {
      expect(m.contentDigest).toBeNull();
    }
  });
});
