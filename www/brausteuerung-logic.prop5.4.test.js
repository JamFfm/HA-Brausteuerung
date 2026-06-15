import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { heatingDecision, computeSafetyThreshold, Status } from './brausteuerung-logic.js';

// Feature: brausteuerung, Property 9: Sicherheitsinvariante — Heizung AUS bei Gefahr

/**
 * Property 9 (Validates: Requirements 9.1, 9.2, 10.1)
 *
 * Für JEDEN Systemzustand gilt: Wenn die Ist-Temperatur den
 * Sicherheitsschwellwert (`soll + offset`) überschreitet ODER kein gültiger
 * Sensorwert vorliegt, dann ist die Heizentscheidung IMMER AUS
 * (`heater === false`) — unabhängig von Vorzustand, Sollwert, Offset oder Phase.
 *
 * Zusatz-Eigenschaft: Liegt ein gültiger Sensorwert vor UND besteht
 * Übertemperatur (`ist > soll + offset`), so signalisiert das Ergebnis
 * zusätzlich den Statuswechsel nach `paused`.
 */

// Basis-Generatoren über den relevanten Eingaberaum.
const istArb = fc.double({ min: 0, max: 150, noNaN: true });
const sollArb = fc.double({ min: 0, max: 150, noNaN: true });
const offsetArb = fc.double({ min: 0, max: 20, noNaN: true });

// Zufälliger Systemzustand (kann Gefahr oder Normalbetrieb sein).
const randomState = fc.record({
  ist: istArb,
  soll: sollArb,
  offset: offsetArb,
  sensorValid: fc.boolean(),
  prevState: fc.boolean(),
});

// Gezielt Übertemperatur: ist liegt deutlich oberhalb von soll + offset,
// Sensor ist gültig (sonst greift bereits die Sensor-Invariante).
const overtemperatureState = fc
  .record({
    soll: sollArb,
    offset: offsetArb,
    excess: fc.double({ min: 0.001, max: 50, noNaN: true }),
    prevState: fc.boolean(),
  })
  .map(({ soll, offset, excess, prevState }) => ({
    ist: soll + offset + excess,
    soll,
    offset,
    sensorValid: true,
    prevState,
  }));

// Gezielt ungültiger Sensor: sensorValid === false bei beliebigen Temperaturen.
const invalidSensorState = fc.record({
  ist: istArb,
  soll: sollArb,
  offset: offsetArb,
  sensorValid: fc.constant(false),
  prevState: fc.boolean(),
});

// Vereinigung aller Generatoren, damit die Invariante über zufällige,
// Übertemperatur- und Sensorausfall-Zustände gleichermaßen geprüft wird.
const anyState = fc.oneof(randomState, overtemperatureState, invalidSensorState);

describe('Property 9: Sicherheitsinvariante — Heizung AUS bei Gefahr', () => {
  it('Gefahr (Übertemperatur ODER ungültiger Sensor) ⇒ Heizung IMMER AUS', () => {
    fc.assert(
      fc.property(anyState, (state) => {
        const danger =
          state.ist > computeSafetyThreshold(state.soll, state.offset) ||
          state.sensorValid === false;

        if (danger) {
          const result = heatingDecision(state);
          expect(result.heater).toBe(false);
        }
      }),
      { numRuns: 200 }
    );
  });

  it('explizite Übertemperatur-Zustände schalten die Heizung AUS', () => {
    fc.assert(
      fc.property(overtemperatureState, (state) => {
        const result = heatingDecision(state);
        expect(result.heater).toBe(false);
      }),
      { numRuns: 100 }
    );
  });

  it('explizite Sensorausfall-Zustände schalten die Heizung AUS', () => {
    fc.assert(
      fc.property(invalidSensorState, (state) => {
        const result = heatingDecision(state);
        expect(result.heater).toBe(false);
      }),
      { numRuns: 100 }
    );
  });

  it('gültiger Sensor UND Übertemperatur ⇒ status === paused', () => {
    fc.assert(
      fc.property(overtemperatureState, (state) => {
        // overtemperatureState garantiert sensorValid === true und ist > soll+offset.
        const result = heatingDecision(state);
        expect(result.heater).toBe(false);
        expect(result.status).toBe(Status.PAUSED);
      }),
      { numRuns: 100 }
    );
  });
});
