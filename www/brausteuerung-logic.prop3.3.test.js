import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { editStep, removeStep, isValidRaststufe } from './brausteuerung-logic.js';

// Feature: brausteuerung, Property 6: Editieren und Löschen erhalten die Reihenfolge

/**
 * Generator für eine einzelne gültige Raststufe gemäß design.md (Testing Strategy):
 *   { name: string, temperature: double 0..100, duration: integer 1..240 }
 */
const raststufe = fc.record({
  name: fc.string(),
  temperature: fc.double({ min: 0, max: 100, noNaN: true }),
  duration: fc.integer({ min: 1, max: 240 }),
});

/** Generator für ein nicht-leeres Braurezept (geordnete Liste von Raststufen). */
const nonEmptyRezept = fc.array(raststufe, { minLength: 1, maxLength: 12 });

/**
 * Generator für ein nicht-leeres Rezept zusammen mit einem gültigen Index `i`
 * im Bereich [0, length - 1].
 */
const rezeptUndIndex = nonEmptyRezept.chain((recipe) =>
  fc.record({
    recipe: fc.constant(recipe),
    index: fc.integer({ min: 0, max: recipe.length - 1 }),
  })
);

/**
 * Generator für eine UNGÜLTIGE Raststufe: entweder Temperatur außerhalb von
 * [0, 100] (bzw. NaN) ODER Haltezeit nicht-ganzzahlig / <= 0. Mindestens eine
 * der beiden Bedingungen verletzt die Gültigkeit gemäß {@link isValidRaststufe}.
 */
const invalidRaststufe = fc
  .record({
    name: fc.string(),
    // Temperatur: gültig oder ungültig (außerhalb 0..100 oder NaN).
    temperature: fc.oneof(
      fc.double({ min: 0, max: 100, noNaN: true }),
      fc.double({ min: 100.0001, max: 1000, noNaN: true }),
      fc.double({ min: -1000, max: -0.0001, noNaN: true }),
      fc.constant(Number.NaN)
    ),
    // Haltezeit: gültig (int > 0) oder ungültig (<= 0 oder nicht-ganzzahlig).
    duration: fc.oneof(
      fc.integer({ min: 1, max: 240 }),
      fc.integer({ min: -240, max: 0 }),
      fc.double({ min: 0.1, max: 240, noNaN: true }).filter((d) => !Number.isInteger(d))
    ),
  })
  // Sicherstellen, dass die erzeugte Stufe tatsächlich ungültig ist.
  .filter((step) => !isValidRaststufe(step.name, step.temperature, step.duration));

/** Tiefe Kopie zur Prüfung der Immutabilität der Eingabeliste. */
const deepCopy = (value) => JSON.parse(JSON.stringify(value));

describe('Property 6: Editieren und Löschen erhalten die Reihenfolge', () => {
  // Teil 1: editStep mit gültigen Werten ersetzt nur das Element an Index i.
  it('editStep ersetzt ausschließlich das Element an Index i; Länge und übrige Elemente unverändert', () => {
    fc.assert(
      fc.property(rezeptUndIndex, raststufe, ({ recipe, index }, newStep) => {
        const before = deepCopy(recipe);
        const result = editStep(recipe, index, newStep);

        // Länge bleibt erhalten.
        expect(result.length).toBe(recipe.length);
        // Das Element an Index i wurde durch die neuen Werte ersetzt.
        expect(result[index]).toEqual(newStep);
        // Alle anderen Elemente sind unverändert.
        for (let j = 0; j < recipe.length; j++) {
          if (j !== index) {
            expect(result[j]).toEqual(before[j]);
          }
        }
        // Eingabeliste wurde nicht mutiert.
        expect(recipe).toEqual(before);
      }),
      { numRuns: 100 }
    );
  });

  // Teil 2: removeStep entfernt nur das Element an Index i, Reihenfolge bleibt.
  it('removeStep entfernt ausschließlich Element an Index i, Länge -1, Reihenfolge der Übrigen bleibt', () => {
    fc.assert(
      fc.property(rezeptUndIndex, ({ recipe, index }) => {
        const before = deepCopy(recipe);
        const result = removeStep(recipe, index);

        // Länge um genau 1 verringert.
        expect(result.length).toBe(recipe.length - 1);

        // Relative Reihenfolge der verbleibenden Elemente bleibt erhalten:
        // result entspricht before ohne das Element an Position index.
        const expected = before.filter((_, j) => j !== index);
        expect(result).toEqual(expected);

        // Eingabeliste wurde nicht mutiert.
        expect(recipe).toEqual(before);
      }),
      { numRuns: 100 }
    );
  });

  // Teil 3: editStep mit ungültigen Werten lässt die Liste vollständig unverändert.
  it('editStep mit ungültigen Werten lässt die Liste vollständig unverändert', () => {
    fc.assert(
      fc.property(rezeptUndIndex, invalidRaststufe, ({ recipe, index }, badStep) => {
        const before = deepCopy(recipe);
        const result = editStep(recipe, index, badStep);

        // Liste bleibt inhaltlich vollständig unverändert.
        expect(result).toEqual(before);
        // Eingabeliste wurde nicht mutiert.
        expect(recipe).toEqual(before);
      }),
      { numRuns: 100 }
    );
  });
});
