import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { nextStepTransition, Status } from './brausteuerung-logic.js';

// Feature: brausteuerung, Property 8: Stufenindex-Übergänge sind wohldefiniert (manuell == automatisch)

/**
 * Property 8 (Validates: Requirements 4.4, 4.5, 8.6, 8.7)
 *
 * Für jeden Rezeptstand mit aktuellem Index `i` und Rezeptlänge `len` gilt —
 * unabhängig davon, ob der Wechsel automatisch (Timerablauf) oder manuell
 * ausgelöst wird:
 *   - i + 1 <  len ⇒ neuer Index = i + 1, Status RUNNING, done false, nie > len.
 *   - i + 1 >= len ⇒ Status DONE, done true, keine weitere Stufe aktiviert.
 *   - Manueller und automatischer Wechsel erzeugen für denselben Ausgangszustand
 *     denselben Übergang. Da `nextStepTransition` die einzige gemeinsam genutzte
 *     Funktion ist, wird dies als Determinismus modelliert: zwei Aufrufe mit
 *     identischem Ausgangszustand liefern identische Ergebnisse (toEqual).
 */

// Generator: Rezeptlänge >= 1 und ein gültiger Index in [0, length - 1].
const lengthAndIndex = fc
  .integer({ min: 1, max: 50 })
  .chain((length) =>
    fc.record({
      length: fc.constant(length),
      index: fc.integer({ min: 0, max: length - 1 }),
    })
  );

describe('Property 8: Stufenindex-Übergänge sind wohldefiniert (manuell == automatisch)', () => {
  it('Teil 1: nicht-letzte Stufe erhöht den Index um genau eins und bleibt RUNNING', () => {
    fc.assert(
      fc.property(lengthAndIndex, ({ index, length }) => {
        fc.pre(index + 1 < length);
        const result = nextStepTransition(index, length);

        expect(result.index).toBe(index + 1);
        // Index überschreitet die Rezeptlänge nie.
        expect(result.index).toBeLessThan(length);
        expect(result.index).toBeLessThanOrEqual(length);
        expect(result.status).toBe(Status.RUNNING);
        expect(result.done).toBe(false);
      }),
      { numRuns: 100 }
    );
  });

  it('Teil 2: letzte Stufe führt in den Status DONE ohne weitere Stufe', () => {
    fc.assert(
      fc.property(lengthAndIndex, ({ index, length }) => {
        fc.pre(index + 1 >= length);
        const result = nextStepTransition(index, length);

        expect(result.status).toBe(Status.DONE);
        expect(result.done).toBe(true);
        // Keine weitere Stufe aktiviert: der Index überschreitet length nicht.
        expect(result.index).toBeLessThanOrEqual(length);
        expect(result.index).toBe(index);
      }),
      { numRuns: 100 }
    );
  });

  it('Teil 3: manueller == automatischer Wechsel — derselbe Ausgangszustand liefert denselben Übergang', () => {
    fc.assert(
      fc.property(lengthAndIndex, ({ index, length }) => {
        // "automatisch" (Timerablauf) und "manuell" nutzen dieselbe Funktion.
        const automatic = nextStepTransition(index, length);
        const manual = nextStepTransition(index, length);

        expect(manual).toEqual(automatic);
      }),
      { numRuns: 100 }
    );
  });

  it('über den gesamten Indexbereich [0, length-1] gilt die Übergangsdefinition', () => {
    fc.assert(
      fc.property(lengthAndIndex, ({ index, length }) => {
        const result = nextStepTransition(index, length);

        if (index + 1 < length) {
          expect(result).toEqual({ index: index + 1, status: Status.RUNNING, done: false });
        } else {
          expect(result).toEqual({ index, status: Status.DONE, done: true });
        }
      }),
      { numRuns: 100 }
    );
  });
});
