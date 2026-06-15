import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { addStep } from './brausteuerung-logic.js';

// Feature: brausteuerung, Property 5: Hinzufügen wächst die Liste und erhält die Reihenfolge

/**
 * Generator für eine gültige Raststufe (gemäß design.md, Testing Strategy):
 *   name:        beliebiger String
 *   temperature: 0 ≤ t ≤ 100
 *   duration:    ganzzahlig 1 ≤ d ≤ 240
 */
const raststufe = fc.record({
  name: fc.string(),
  temperature: fc.double({ min: 0, max: 100, noNaN: true }),
  duration: fc.integer({ min: 1, max: 240 }),
});

describe('Property 5: Hinzufügen wächst die Liste und erhält die Reihenfolge', () => {
  it('hängt eine Folge gültiger Raststufen an, erhält Länge, Reihenfolge und Endposition', () => {
    fc.assert(
      fc.property(
        fc.array(raststufe),
        fc.array(raststufe, { minLength: 1 }),
        (startRecipe, stepsToAdd) => {
          // Tiefe Kopie der Startliste, um spätere Mutationsprüfung zu erlauben.
          const startSnapshot = JSON.parse(JSON.stringify(startRecipe));

          // Alle Stufen nacheinander anhängen (jeweils immutabel).
          let result = startRecipe;
          for (const step of stepsToAdd) {
            result = addStep(result, step);
          }

          // 1. Länge wuchs um die Anzahl der hinzugefügten Stufen.
          expect(result.length).toBe(startRecipe.length + stepsToAdd.length);

          // 2. Das zuletzt angehängte Element steht am Ende.
          expect(result[result.length - 1]).toBe(stepsToAdd[stepsToAdd.length - 1]);

          // 3. Relative Reihenfolge entspricht der Einfügereihenfolge:
          //    zuerst alle Start-Elemente, dann die hinzugefügten in Reihenfolge.
          const expectedOrder = [...startRecipe, ...stepsToAdd];
          expect(result.length).toBe(expectedOrder.length);
          for (let i = 0; i < expectedOrder.length; i++) {
            // Referenzgleichheit: kein Element wurde kopiert oder umsortiert.
            expect(result[i]).toBe(expectedOrder[i]);
          }

          // 4. Immutabilität: die ursprüngliche Eingabeliste wurde nicht mutiert.
          expect(startRecipe).toEqual(startSnapshot);
          expect(startRecipe.length).toBe(startSnapshot.length);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('einzelnes Anhängen wächst die Liste um genau eins und behält die Quelle bei', () => {
    fc.assert(
      fc.property(fc.array(raststufe), raststufe, (startRecipe, step) => {
        const startSnapshot = JSON.parse(JSON.stringify(startRecipe));
        const result = addStep(startRecipe, step);

        expect(result.length).toBe(startRecipe.length + 1);
        expect(result[result.length - 1]).toBe(step);
        // Reihenfolge der bestehenden Elemente bleibt unverändert.
        for (let i = 0; i < startRecipe.length; i++) {
          expect(result[i]).toBe(startRecipe[i]);
        }
        // Eingabeliste nicht mutiert.
        expect(startRecipe).toEqual(startSnapshot);
      }),
      { numRuns: 100 }
    );
  });
});
