import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { computeSafetyThreshold } from './brausteuerung-logic.js';

// Feature: brausteuerung, Property 13: Anzeige des Sicherheitsschwellwerts

/**
 * Property 13: Anzeige des Sicherheitsschwellwerts (Validates: Requirements 9.3)
 *
 * Für jede Solltemperatur `soll` und jedes Sicherheits-Offset `offset` gilt:
 * Der angezeigte Sicherheitsschwellwert ist gleich `soll + offset`.
 *
 * Generatoren gemäß design.md (Testing Strategy):
 *   - soll:   double 0..100 (noNaN)
 *   - offset: double 0..20  (noNaN)
 */
describe('Property 13: Anzeige des Sicherheitsschwellwerts', () => {
  it('computeSafetyThreshold(soll, offset) === soll + offset für beliebige soll/offset', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 100, noNaN: true }),
        fc.double({ min: 0, max: 20, noNaN: true }),
        (soll, offset) => {
          const result = computeSafetyThreshold(soll, offset);
          // Reine Addition: exakte Gleichheit mit soll + offset.
          expect(result).toBe(soll + offset);
        }
      ),
      { numRuns: 100 }
    );
  });
});
