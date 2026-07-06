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
    // iten/enid). Wave 14 added the three STT registry constants
    // (whisper-tiny, vad-silero-5-1-2, parakeet-ctc-en). Wave 15 adds the
    // Supertonic multilingual TTS entry so the catalog is now 12 EN-hub
    // Bergamot pairs + 3 STT models + 1 TTS model = 16 entries.
    expect(reg.version).toBe('1.2.0');
    expect(typeof reg.generatedAt).toBe('string');
    expect(reg.models.length).toBe(16);
  });

  test('Wave 15 registers tts-supertonic family with the Supertonic multilingual model', () => {
    const tts = listModels({ family: 'tts-supertonic' });
    expect(tts).toHaveLength(1);
    expect(tts[0].id).toBe('tts-supertonic-multilingual');
    expect(tts[0].contentDigest).toBe(
      'sha256:139ba4f76ff1c703cd072030b4e28fa009593162dc686aa2b3ce588991179899'
    );
    expect(tts[0].capabilities).toContain('tts');
    expect(tts[0].size).toBe(121000000);
  });

  test('every Bergamot entry is a translate model with MPL-2.0 license', () => {
    const bergamots = listModels({ family: 'bergamot' });
    expect(bergamots).toHaveLength(12);
    for (const m of bergamots) {
      expect(m.family).toBe('bergamot');
      expect(m.capabilities).toContain('translate');
      expect(m.license).toBe('MPL-2.0');
      expect(m.size).toBeGreaterThan(0);
      expect(m.status).toBe('pending-upstream');
    }
  });

  test('Wave 14 STT entries are registered under whisper / parakeet / silero-vad families', () => {
    const whisper = listModels({ family: 'whisper' });
    const parakeet = listModels({ family: 'parakeet' });
    const vad = listModels({ family: 'silero-vad' });
    expect(whisper).toHaveLength(1);
    expect(parakeet).toHaveLength(1);
    expect(vad).toHaveLength(1);
    expect(whisper[0].id).toBe('whisper-tiny');
    expect(whisper[0].contentDigest).toBe(
      'sha256:be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21'
    );
    expect(parakeet[0].id).toBe('parakeet-ctc-en');
    expect(parakeet[0].contentDigest).toBe(
      'sha256:934a88915e4bbd87c067ea4a149d711238a516f75d336a74d47dc0a7828ddda4'
    );
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
    // Path traversal and garbage inputs must not crash.
    expect(getModel('../etc/passwd')).toBeUndefined();
  });

  test('listModels filters by family', () => {
    expect(listModels({ family: 'bergamot' })).toHaveLength(12);
    expect(listModels({ family: 'whisper' })).toHaveLength(1);
    expect(listModels({ family: 'llama' })).toHaveLength(0);
  });

  test('listModels filters by capability', () => {
    expect(listModels({ capability: 'translate' })).toHaveLength(12);
    expect(listModels({ capability: 'transcribe' })).toHaveLength(2);
    expect(listModels({ capability: 'vad' })).toHaveLength(1);
    expect(listModels({ capability: 'stt' })).toHaveLength(0);
  });

  test('listModels combines filters', () => {
    expect(
      listModels({ family: 'bergamot', capability: 'translate' })
    ).toHaveLength(12);
    expect(
      listModels({ family: 'bergamot', capability: 'stt' })
    ).toHaveLength(0);
    expect(
      listModels({ family: 'whisper', capability: 'transcribe' })
    ).toHaveLength(1);
  });

  test('registry is frozen (no runtime mutation)', () => {
    const reg = loadRegistry();
    expect(Object.isFrozen(reg)).toBe(true);
    expect(Object.isFrozen(reg.models[0])).toBe(true);
  });

  test('contentDigest is null on Bergamot pending-upstream entries', () => {
    for (const m of listModels({ family: 'bergamot' })) {
      expect(m.contentDigest).toBeNull();
    }
  });
});
