import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  upsertRecipe,
  removeRecipe,
  findRecipe,
  parseLibrary,
  serializeLibrary,
} from './brausteuerung-logic.js';

// Feature: brausteuerung, Property 16: Bibliotheksoperationen sind konsistent und roundtrip-sicher

/**
 * Validates: Requirements 12.1, 12.2, 12.6, 12.7, 12.11
 */

const raststufe = fc.record({
  name: fc.string(),
  temperature: fc.double({ min: 0, max: 100, noNaN: true }),
  duration: fc.integer({ min: 1, max: 240 }),
});

// Nicht-leerer (getrimmter) Rezeptname.
const recipeName = fc.string({ minLength: 1, maxLength: 20 }).filter((s) => s.trim() !== '');

const bibliotheksRezept = fc.record({
  name: recipeName,
  steps: fc.array(raststufe, { maxLength: 6 }),
});

/** Bibliothek mit eindeutigen (getrimmten) Namen erzeugen. */
const uniqueLibrary = fc.array(bibliotheksRezept, { maxLength: 8 }).map((arr) => {
  const seen = new Set();
  const out = [];
  for (const r of arr) {
    const key = r.name.trim();
    if (!seen.has(key)) {
      seen.add(key);
      out.push({ name: key, steps: r.steps });
    }
  }
  return out;
});

const deepCopy = (v) => JSON.parse(JSON.stringify(v));

describe('Property 16: Bibliotheksoperationen sind konsistent und roundtrip-sicher', () => {
  // Hinzufügen eines neuen Namens: Anzahl +1, auffindbar.
  it('upsertRecipe mit neuem Namen wächst um 1 und ist auffindbar', () => {
    fc.assert(
      fc.property(uniqueLibrary, recipeName, fc.array(raststufe, { maxLength: 6 }), (lib, name, steps) => {
        const key = name.trim();
        // Sicherstellen, dass der Name noch nicht existiert.
        fc.pre(!lib.some((r) => r.name.trim() === key));
        const before = deepCopy(lib);
        const result = upsertRecipe(lib, name, steps);

        expect(result.length).toBe(lib.length + 1);
        const found = findRecipe(result, name);
        expect(found).toBeTruthy();
        expect(found.steps).toEqual(steps);
        // Eingabe unverändert (Immutabilität).
        expect(lib).toEqual(before);
      }),
      { numRuns: 100 }
    );
  });

  // Ersetzen eines vorhandenen Namens: Anzahl unverändert, Eindeutigkeit erhalten.
  it('upsertRecipe mit vorhandenem Namen ersetzt ohne Längenänderung und erhält Eindeutigkeit', () => {
    fc.assert(
      fc.property(uniqueLibrary, fc.array(raststufe, { maxLength: 6 }), (lib, newSteps) => {
        fc.pre(lib.length >= 1);
        const target = lib[0].name;
        const result = upsertRecipe(lib, target, newSteps);

        expect(result.length).toBe(lib.length);
        // Genau dieser Eintrag wurde ersetzt.
        expect(findRecipe(result, target).steps).toEqual(newSteps);
        // Namen weiterhin eindeutig.
        const keys = result.map((r) => r.name.trim());
        expect(new Set(keys).size).toBe(keys.length);
      }),
      { numRuns: 100 }
    );
  });

  // Leerer Name lässt die Bibliothek unverändert.
  it('upsertRecipe mit leerem/whitespace-Namen lässt die Bibliothek unverändert', () => {
    fc.assert(
      fc.property(uniqueLibrary, fc.constantFrom('', '   ', '\t'), fc.array(raststufe), (lib, name, steps) => {
        expect(upsertRecipe(lib, name, steps)).toEqual(lib);
      }),
      { numRuns: 50 }
    );
  });

  // Entfernen: genau das benannte Rezept weg, Reihenfolge erhalten.
  it('removeRecipe entfernt genau das benannte Rezept und erhält die Reihenfolge', () => {
    fc.assert(
      fc.property(uniqueLibrary, (lib) => {
        fc.pre(lib.length >= 1);
        const target = lib[0].name;
        const result = removeRecipe(lib, target);

        expect(result.length).toBe(lib.length - 1);
        expect(findRecipe(result, target)).toBeUndefined();
        // Relative Reihenfolge der übrigen erhalten.
        const expected = lib.filter((r) => r.name.trim() !== target.trim());
        expect(result.map((r) => r.name)).toEqual(expected.map((r) => r.name));
      }),
      { numRuns: 100 }
    );
  });

  // Unbekannter Name => unverändert.
  it('removeRecipe mit unbekanntem Namen lässt die Bibliothek unverändert', () => {
    fc.assert(
      fc.property(uniqueLibrary, recipeName, (lib, name) => {
        fc.pre(!lib.some((r) => r.name.trim() === name.trim()));
        expect(removeRecipe(lib, name)).toEqual(lib);
      }),
      { numRuns: 100 }
    );
  });

  // Roundtrip: parseLibrary(serializeLibrary(lib)) tief gleich lib.
  it('parseLibrary(serializeLibrary(lib)) ist tief gleich lib', () => {
    fc.assert(
      fc.property(uniqueLibrary, (lib) => {
        expect(parseLibrary(serializeLibrary(lib))).toEqual(lib);
      }),
      { numRuns: 100 }
    );
  });

  // Beschädigter Rohwert => leere Bibliothek.
  it('parseLibrary liefert [] bei beschädigtem/kein-Array Rohwert', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.constant(null),
          fc.constant(undefined),
          fc.constant('{nicht json'),
          fc.constant('42'),
          fc.constant('"text"'),
          fc.integer(),
          fc.record({ foo: fc.string() })
        ),
        (raw) => {
          expect(parseLibrary(raw)).toEqual([]);
        }
      ),
      { numRuns: 50 }
    );
  });
});
