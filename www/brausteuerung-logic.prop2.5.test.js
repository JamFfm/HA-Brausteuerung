import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  canPersistRecipe,
  serializeRecipe,
  MAX_RECIPE_JSON_LENGTH,
} from './brausteuerung-logic.js';

// Feature: brausteuerung, Property 2: 255-Zeichen-Grenze wird durchgesetzt

/**
 * Generator für eine einzelne Raststufe gemäß design.md (Testing Strategy):
 *   { name: string, temperature: double 0..100, duration: integer 1..240 }
 */
const raststufe = fc.record({
  name: fc.string(),
  temperature: fc.double({ min: 0, max: 100, noNaN: true }),
  duration: fc.integer({ min: 1, max: 240 }),
});

/**
 * UNDERSHOOT: kleine Rezepte mit kurzen Namen liegen praktisch immer unter der
 * 255-Zeichen-Grenze.
 */
const undershootRecipe = fc.array(
  fc.record({
    name: fc.string({ maxLength: 3 }),
    temperature: fc.double({ min: 0, max: 100, noNaN: true }),
    duration: fc.integer({ min: 1, max: 240 }),
  }),
  { maxLength: 2 }
);

/**
 * OVERSHOOT (viele Stufen): große Arrays vieler Raststufen überschreiten die
 * Grenze zuverlässig.
 */
const overshootManySteps = fc.array(raststufe, { minLength: 10, maxLength: 60 });

/**
 * OVERSHOOT (langer Name): eine einzelne Raststufe mit sehr langem Namen
 * sprengt die Grenze.
 */
const overshootLongName = fc.record({
  name: fc.string({ minLength: 256, maxLength: 600 }),
  temperature: fc.double({ min: 0, max: 100, noNaN: true }),
  duration: fc.integer({ min: 1, max: 240 }),
}).map((step) => [step]);

/**
 * Gemischter Generator, der beide Seiten der Grenze gezielt abdeckt: kleine
 * Rezepte (undershoot), viele Stufen und lange Namen (overshoot) sowie
 * beliebige Rezepte.
 */
const mixedRecipe = fc.oneof(
  undershootRecipe,
  overshootManySteps,
  overshootLongName,
  fc.array(raststufe)
);

describe('Property 2: 255-Zeichen-Grenze wird durchgesetzt', () => {
  it('canPersistRecipe(recipe) ist genau dann true, wenn serializeRecipe(recipe).length <= 255', () => {
    fc.assert(
      fc.property(mixedRecipe, (recipe) => {
        const length = serializeRecipe(recipe).length;
        const withinLimit = length <= MAX_RECIPE_JSON_LENGTH;
        // Persistenz-Entscheidung muss exakt der Längengrenze entsprechen.
        expect(canPersistRecipe(recipe)).toBe(withinLimit);
        // Über der Grenze MUSS die Funktion ablehnen (returns false).
        if (length > MAX_RECIPE_JSON_LENGTH) {
          expect(canPersistRecipe(recipe)).toBe(false);
        }
      }),
      { numRuns: 100 }
    );
  });

  it('MAX_RECIPE_JSON_LENGTH ist die erwartete Grenze von 255 Zeichen', () => {
    expect(MAX_RECIPE_JSON_LENGTH).toBe(255);
  });

  it('lehnt overshoot-Rezepte (viele Stufen) zuverlässig ab', () => {
    fc.assert(
      fc.property(overshootManySteps, (recipe) => {
        // Ein Array von >= 10 Raststufen überschreitet die Grenze stets.
        expect(serializeRecipe(recipe).length).toBeGreaterThan(
          MAX_RECIPE_JSON_LENGTH
        );
        expect(canPersistRecipe(recipe)).toBe(false);
      }),
      { numRuns: 100 }
    );
  });
});
