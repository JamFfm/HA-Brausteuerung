import { describe, it } from 'vitest';
import fc from 'fast-check';
import { resolveStepName } from './brausteuerung-logic.js';

// Feature: brausteuerung, Property 4: Leerer Name erhält Standardnamen aus der Position

describe('Property 4: Leerer Name erhält Standardnamen aus der Position', () => {
  // Validates: Requirements 2.5

  // Generator für Whitespace-only Strings (Leerzeichen, Tabs, Zeilenumbrüche).
  const whitespaceArb = fc
    .array(fc.constantFrom(' ', '\t', '\n', '\r', '\f', '\v'), { maxLength: 10 })
    .map((chars) => chars.join(''));

  // Generator für nicht-leere Namen (nach trim() nicht leer): mindestens ein
  // Nicht-Whitespace-Zeichen, optional von Whitespace umgeben.
  const nonEmptyNameArb = fc
    .string({ minLength: 1 })
    .filter((s) => s.trim() !== '');

  it('vergibt für leere/whitespace-only Namen exakt "Rast {position}"', () => {
    fc.assert(
      fc.property(whitespaceArb, fc.integer(), (name, position) => {
        return resolveStepName(name, position) === `Rast ${position}`;
      }),
      { numRuns: 100 },
    );
  });

  it('lässt nicht-leere Namen (nach trim) unverändert', () => {
    fc.assert(
      fc.property(nonEmptyNameArb, fc.integer(), (name, position) => {
        return resolveStepName(name, position) === name;
      }),
      { numRuns: 100 },
    );
  });
});
