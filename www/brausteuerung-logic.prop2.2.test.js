// Feature: brausteuerung, Property 3: Eingabe-Validierung von Solltemperatur und Haltezeit
//
// Validates: Requirements 2.2, 2.3, 2.4
//
// Property 3: Für jede Kombination aus Solltemperatur `t` und Haltezeit `d` gilt:
// Die Raststufe ist genau dann gültig, wenn `t` eine Zahl mit 0 ≤ t ≤ 100 ist UND
// `d` eine Ganzzahl mit `d > 0` ist. Ist die Eingabe ungültig, lässt das
// Hinzufügen (Add-Flow) die Rezeptliste unverändert.

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { isValidRaststufe, addStep } from './brausteuerung-logic.js';

/**
 * Referenz-Spezifikation der Gültigkeit, unabhängig von der Implementierung
 * formuliert (Req 2.2, 2.3): temp ist endliche Zahl mit 0 ≤ temp ≤ 100 UND
 * dur ist Ganzzahl > 0.
 */
function expectedValid(temp, dur) {
  const tempValid =
    typeof temp === 'number' &&
    Number.isFinite(temp) &&
    temp >= 0 &&
    temp <= 100;
  const durValid = Number.isInteger(dur) && dur > 0;
  return tempValid && durValid;
}

/**
 * Generator für Solltemperaturen: Mischung aus gültigen In-Range-Werten,
 * Out-of-Range-Werten, negativen Werten, NaN/Infinity und nicht-numerischen
 * Werten — deckt den Eingaberaum bewusst breit ab.
 */
const tempArb = fc.oneof(
  // gültiger Bereich 0..100
  fc.double({ min: 0, max: 100, noNaN: true }),
  // exakte Bandgrenzen
  fc.constantFrom(0, 100),
  // außerhalb des Bereichs (zu hoch / negativ)
  fc.double({ min: 100.0001, max: 1000, noNaN: true }),
  fc.double({ min: -1000, max: -0.0001, noNaN: true }),
  // Sonderwerte
  fc.constantFrom(NaN, Infinity, -Infinity),
  // nicht-numerische Werte
  fc.string(),
  fc.constantFrom(null, undefined)
);

/**
 * Generator für Haltezeiten: Mischung aus gültigen positiven Ganzzahlen,
 * 0, negativen Ganzzahlen, nicht-ganzzahligen (Dezimal-)Werten, NaN und
 * nicht-numerischen Werten.
 */
const durArb = fc.oneof(
  // gültig: Ganzzahl > 0
  fc.integer({ min: 1, max: 240 }),
  // 0 und negative Ganzzahlen (ungültig)
  fc.integer({ min: -240, max: 0 }),
  // nicht-ganzzahlige Dezimalwerte (ungültig)
  fc.double({ min: 0.0001, max: 240, noNaN: true }).filter((d) => !Number.isInteger(d)),
  // Sonderwerte
  fc.constantFrom(NaN, Infinity, -Infinity),
  // nicht-numerische Werte
  fc.string(),
  fc.constantFrom(null, undefined)
);

/**
 * Generator für ein bereits bestehendes (gültiges) Rezept.
 */
const validStepArb = fc.record({
  name: fc.string(),
  temperature: fc.double({ min: 0, max: 100, noNaN: true }),
  duration: fc.integer({ min: 1, max: 240 }),
});
const recipeArb = fc.array(validStepArb, { maxLength: 5 });

describe('Property 3: Eingabe-Validierung von Solltemperatur und Haltezeit', () => {
  it('isValidRaststufe ist genau dann true, wenn temp Zahl in [0,100] und dur Ganzzahl > 0', () => {
    fc.assert(
      fc.property(fc.string(), tempArb, durArb, (name, temp, dur) => {
        expect(isValidRaststufe(name, temp, dur)).toBe(expectedValid(temp, dur));
      }),
      { numRuns: 100 }
    );
  });

  it('Hinzufügen ungültiger Werte lässt die Rezeptliste unverändert (Add-Flow)', () => {
    fc.assert(
      fc.property(recipeArb, fc.string(), tempArb, durArb, (recipe, name, temp, dur) => {
        const valid = isValidRaststufe(name, temp, dur);
        // Add-Flow: Nur bei gültiger Eingabe wird angehängt; sonst bleibt die Liste gleich.
        const result = valid
          ? addStep(recipe, { name, temperature: temp, duration: dur })
          : recipe;

        if (valid) {
          // Gültig: genau ein Element mehr, das angehängte Element steht am Ende.
          expect(result.length).toBe(recipe.length + 1);
          expect(result[result.length - 1]).toEqual({
            name,
            temperature: temp,
            duration: dur,
          });
          // Bestehende Elemente bleiben in Reihenfolge erhalten.
          expect(result.slice(0, recipe.length)).toEqual(recipe);
        } else {
          // Ungültig: Liste unverändert.
          expect(result).toEqual(recipe);
          expect(result.length).toBe(recipe.length);
        }
      }),
      { numRuns: 100 }
    );
  });
});
