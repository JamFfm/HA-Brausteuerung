import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  isValidHysteresis,
  resolveHysteresis,
  HYSTERESIS_BAND,
  MIN_HYSTERESIS,
  MAX_HYSTERESIS,
} from './brausteuerung-logic.js';

// Feature: brausteuerung, Property 15: Validierung und Anzeige des Hysteresebandes

/**
 * Validates: Requirements 4.9, 4.10
 *
 * Property 15 (siehe design.md): Ein Eingabewert ist genau dann ein gültiges
 * Hystereseband, wenn er eine Zahl mit 0 < v <= 5 ist. `resolveHysteresis`
 * leitet den anzuwendenden/angezeigten Wert ab: gültige Werte werden
 * übernommen, ungültige (nicht-numerisch, <= 0, > 5) fallen auf den Default
 * HYSTERESIS_BAND (1,0) zurück.
 */

describe('Property 15: Validierung und Anzeige des Hysteresebandes', () => {
  // Teil 1: Gültige Werte (0 < v <= 5) werden akzeptiert und unverändert abgeleitet.
  it('akzeptiert gültige Werte (0 < v <= 5) und gibt sie unverändert zurück', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: MAX_HYSTERESIS, noNaN: true }).filter((v) => v > 0 && v <= MAX_HYSTERESIS),
        (v) => {
          expect(isValidHysteresis(v)).toBe(true);
          expect(resolveHysteresis(v)).toBe(v);
          // String-Eingabe (wie aus HA-State) wird ebenfalls korrekt geparst.
          expect(resolveHysteresis(String(v))).toBe(v);
        }
      ),
      { numRuns: 100 }
    );
  });

  // Teil 2: Werte <= 0 oder > 5 sind ungültig und werden auf den Default abgebildet.
  it('lehnt Werte <= 0 oder > 5 ab und fällt auf den Default 1,0 zurück', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.double({ min: -1000, max: 0, noNaN: true }), // <= 0 (inkl. 0)
          fc.double({ min: MAX_HYSTERESIS + 0.0001, max: 1000, noNaN: true }) // > 5
        ),
        (v) => {
          // 0 selbst ist ungültig (Bereich ist > 0).
          expect(isValidHysteresis(v)).toBe(false);
          expect(resolveHysteresis(v)).toBe(HYSTERESIS_BAND);
        }
      ),
      { numRuns: 100 }
    );
  });

  // Teil 3: Nicht-numerische / fehlende Werte sind ungültig und ergeben den Default.
  it('behandelt nicht-numerische oder fehlende Werte als ungültig (Default 1,0)', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.constant(null),
          fc.constant(undefined),
          fc.constant('unknown'),
          fc.constant('unavailable'),
          fc.constant(''),
          fc.constant(Number.NaN),
          fc.string().filter((s) => Number.isNaN(Number(s)) || s.trim() === '')
        ),
        (v) => {
          expect(isValidHysteresis(typeof v === 'number' ? v : Number(v))).toBe(false);
          expect(resolveHysteresis(v)).toBe(HYSTERESIS_BAND);
        }
      ),
      { numRuns: 100 }
    );
  });

  // Teil 4: Exakte Bandgrenzen — untere Grenze 0 ungültig, obere Grenze 5 gültig.
  it('behandelt die Bandgrenzen korrekt: 0 ungültig, 5 gültig', () => {
    expect(isValidHysteresis(MIN_HYSTERESIS)).toBe(false); // 0 ist nicht > 0
    expect(resolveHysteresis(MIN_HYSTERESIS)).toBe(HYSTERESIS_BAND);
    expect(isValidHysteresis(MAX_HYSTERESIS)).toBe(true); // 5 ist <= 5
    expect(resolveHysteresis(MAX_HYSTERESIS)).toBe(MAX_HYSTERESIS);
  });
});
