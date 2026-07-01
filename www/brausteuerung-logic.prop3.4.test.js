import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { reorderStep } from './brausteuerung-logic.js';

// Feature: brausteuerung, Property 14: Umsortieren erhält die Raststufen als Permutation

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
 * im Bereich [0, length - 1] und einer Richtung dir ∈ {-1, +1}.
 */
const rezeptIndexRichtung = nonEmptyRezept.chain((recipe) =>
  fc.record({
    recipe: fc.constant(recipe),
    index: fc.integer({ min: 0, max: recipe.length - 1 }),
    direction: fc.constantFrom(-1, 1),
  })
);

/** Tiefe Kopie zur Prüfung der Immutabilität der Eingabeliste. */
const deepCopy = (value) => JSON.parse(JSON.stringify(value));

/**
 * Erzeugt ein Multiset-Signatur (sortierte serialisierte Elemente), um zu
 * prüfen, dass zwei Listen dieselben Elemente in beliebiger Reihenfolge haben.
 */
const multiset = (list) => list.map((e) => JSON.stringify(e)).sort();

describe('Property 14: Umsortieren erhält die Raststufen als Permutation', () => {
  // Teil 1: Ergebnis ist stets eine Permutation der Eingabe (gleiche Länge,
  // gleiches Multiset) — unabhängig von Index/Richtung/Grenzen.
  it('reorderStep liefert stets eine Permutation: gleiche Länge und gleiches Multiset', () => {
    fc.assert(
      fc.property(rezeptIndexRichtung, ({ recipe, index, direction }) => {
        const before = deepCopy(recipe);
        const result = reorderStep(recipe, index, direction);

        // Gleiche Länge.
        expect(result.length).toBe(recipe.length);
        // Gleiches Multiset von Raststufen — keine gehen verloren oder hinzu.
        expect(multiset(result)).toEqual(multiset(before));
        // Eingabeliste wurde nicht mutiert.
        expect(recipe).toEqual(before);
      }),
      { numRuns: 100 }
    );
  });

  // Teil 2: Liegt der Tausch innerhalb der Grenzen, sind genau die Positionen
  // i und i+dir vertauscht und alle übrigen unverändert.
  it('reorderStep vertauscht innerhalb der Grenzen genau i und i+dir, sonst unverändert', () => {
    fc.assert(
      fc.property(rezeptIndexRichtung, ({ recipe, index, direction }) => {
        const target = index + direction;
        // Nur Fälle innerhalb der Grenzen prüfen.
        fc.pre(target >= 0 && target < recipe.length);

        const before = deepCopy(recipe);
        const result = reorderStep(recipe, index, direction);

        // Positionen i und target sind getauscht.
        expect(result[index]).toEqual(before[target]);
        expect(result[target]).toEqual(before[index]);
        // Alle übrigen Positionen unverändert.
        for (let j = 0; j < before.length; j++) {
          if (j !== index && j !== target) {
            expect(result[j]).toEqual(before[j]);
          }
        }
      }),
      { numRuns: 100 }
    );
  });

  // Teil 3: An den Listengrenzen (erste Rast nach oben, letzte Rast nach unten)
  // bleibt die Liste unverändert.
  it('reorderStep an den Grenzen lässt die Liste unverändert', () => {
    fc.assert(
      fc.property(nonEmptyRezept, (recipe) => {
        const before = deepCopy(recipe);

        // Erste Rast nach oben (-1): unverändert.
        expect(reorderStep(recipe, 0, -1)).toEqual(before);
        // Letzte Rast nach unten (+1): unverändert.
        expect(reorderStep(recipe, recipe.length - 1, 1)).toEqual(before);

        // Eingabeliste wurde nicht mutiert.
        expect(recipe).toEqual(before);
      }),
      { numRuns: 100 }
    );
  });

  // Teil 4: Ungültiger Index oder ungültige Richtung lässt die Liste unverändert.
  it('reorderStep mit ungültigem Index oder ungültiger Richtung lässt die Liste unverändert', () => {
    fc.assert(
      fc.property(
        nonEmptyRezept,
        fc.oneof(
          fc.integer({ min: -50, max: -1 }),
          fc.integer({ min: 1000, max: 1050 })
        ),
        fc.constantFrom(-1, 1),
        (recipe, badIndex, direction) => {
          const before = deepCopy(recipe);
          // Ungültiger Index.
          expect(reorderStep(recipe, badIndex, direction)).toEqual(before);
          // Ungültige Richtung (0) bei sonst gültigem Index.
          expect(reorderStep(recipe, 0, 0)).toEqual(before);
          expect(recipe).toEqual(before);
        }
      ),
      { numRuns: 100 }
    );
  });
});
