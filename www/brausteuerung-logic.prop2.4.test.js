import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { serializeRecipe, parseRecipe } from './brausteuerung-logic.js';

// Feature: brausteuerung, Property 1: Rezept-Serialisierung ist ein Roundtrip

/**
 * Generator für eine einzelne Raststufe gemäß design.md (Testing Strategy):
 *   { name: string, temperature: double 0..100, duration: integer 1..240 }
 */
const raststufe = fc.record({
  name: fc.string(),
  temperature: fc.double({ min: 0, max: 100, noNaN: true }),
  duration: fc.integer({ min: 1, max: 240 }),
});

/** Generator für ein gültiges Braurezept (geordnete Liste von Raststufen). */
const braurezept = fc.array(raststufe);

describe('Property 1: Rezept-Serialisierung ist ein Roundtrip', () => {
  it('parseRecipe(serializeRecipe(recipe)) ist tief gleich dem Original (Daten und Reihenfolge)', () => {
    fc.assert(
      fc.property(braurezept, (recipe) => {
        const roundtripped = parseRecipe(serializeRecipe(recipe));
        expect(roundtripped).toEqual(recipe);
      }),
      { numRuns: 100 }
    );
  });
});
