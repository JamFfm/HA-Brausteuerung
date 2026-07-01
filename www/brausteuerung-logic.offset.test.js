import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  resolveSafetyOffset,
  DEFAULT_SAFETY_OFFSET,
  MIN_SAFETY_OFFSET,
  MAX_SAFETY_OFFSET,
} from './brausteuerung-logic.js';

// Feature: brausteuerung, resolveSafetyOffset: sicherer Fallback des
// Sicherheits-Offsets (Req 9.5) — relevant für Persistenz nach Neustart/Update,
// wenn ein frisch angelegter Helfer (ohne initial:) noch keinen gültigen Wert hat.

describe('resolveSafetyOffset — gültige Werte (0..20 °C) werden übernommen', () => {
  it('gibt gültige Zahlen unverändert zurück (Zahl und String-Eingabe)', () => {
    fc.assert(
      fc.property(
        fc.double({ min: MIN_SAFETY_OFFSET, max: MAX_SAFETY_OFFSET, noNaN: true }),
        (v) => {
          expect(resolveSafetyOffset(v)).toBe(v);
          // HA liefert State-Werte als String.
          expect(resolveSafetyOffset(String(v))).toBe(v);
        }
      ),
      { numRuns: 200 }
    );
  });
});

describe('resolveSafetyOffset — ungültige/fehlende Werte fallen auf 10 °C zurück', () => {
  it('liefert den sicheren Default für fehlende, nicht-numerische oder bereichsfremde Werte', () => {
    const invalids = [
      undefined,
      null,
      '',
      '   ',
      'unknown',
      'unavailable',
      'abc',
      NaN,
      Infinity,
      -Infinity,
      -1,
      -0.1,
      20.1,
      100,
    ];
    for (const v of invalids) {
      expect(resolveSafetyOffset(v)).toBe(DEFAULT_SAFETY_OFFSET);
    }
    expect(DEFAULT_SAFETY_OFFSET).toBe(10);
  });

  it('Werte oberhalb von 20 °C oder unterhalb von 0 °C ⇒ Default 10 °C', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.double({ min: MAX_SAFETY_OFFSET + 0.001, max: 1000, noNaN: true }),
          fc.double({ min: -1000, max: MIN_SAFETY_OFFSET - 0.001, noNaN: true })
        ),
        (v) => {
          expect(resolveSafetyOffset(v)).toBe(DEFAULT_SAFETY_OFFSET);
        }
      ),
      { numRuns: 200 }
    );
  });
});
