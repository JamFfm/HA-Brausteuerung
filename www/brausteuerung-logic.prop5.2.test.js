import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { hysteresisDecision, HYSTERESIS_BAND } from './brausteuerung-logic.js';

// Feature: brausteuerung, Property 7: Hysterese-Schaltlogik ist korrekt und monoton

/**
 * Validates: Requirements 4.1, 4.3
 *
 * Property 7 (siehe design.md, Hysterese-Modell): Für jede Ist-Temperatur `ist`,
 * Solltemperatur `soll` und jeden vorherigen Heizzustand gilt in der Haltephase:
 *   - ist < soll - 1.0          ⇒ Heizung AN  (true)
 *   - ist >= soll               ⇒ Heizung AUS (false)
 *   - soll - 1.0 <= ist < soll  ⇒ Entscheidung = vorheriger Zustand (unverändert)
 * Zusätzlich Monotonie: bei festem `soll` und festem Vorzustand führt ein Absenken
 * von `ist` nie von AN zu AUS, und ein Anheben von `ist` nie von AUS zu AN.
 */

// Solltemperatur in einem realistischen Bereich (°C). noNaN, damit Vergleiche definiert sind.
const sollGen = fc.double({ min: 0, max: 100, noNaN: true });

// Vorheriger Heizzustand.
const prevStateGen = fc.boolean();

// Ist-Temperatur, die unterhalb/innerhalb/oberhalb des Hysteresebandes liegt,
// inklusive der exakten Bandgrenzen (soll - HYSTERESIS_BAND und soll). Der
// Generator liefert eine Funktion, die aus `soll` einen `ist`-Wert erzeugt.
const istFromSollGen = fc.oneof(
  // Unterhalb des Bandes: ist < soll - 1.0
  fc.double({ min: 0.0001, max: 50, noNaN: true }).map((delta) => (soll) => soll - HYSTERESIS_BAND - delta),
  // Exakte untere Bandgrenze: ist == soll - 1.0 (im Band ⇒ unverändert)
  fc.constant((soll) => soll - HYSTERESIS_BAND),
  // Innerhalb des Bandes: soll - 1.0 < ist < soll
  fc.double({ min: 0, max: 1, noNaN: true })
    .filter((f) => f > 0 && f < 1)
    .map((f) => (soll) => soll - HYSTERESIS_BAND * f),
  // Exakte obere Bandgrenze: ist == soll (⇒ AUS)
  fc.constant((soll) => soll),
  // Oberhalb: ist > soll
  fc.double({ min: 0.0001, max: 50, noNaN: true }).map((delta) => (soll) => soll + delta)
);

describe('Property 7: Hysterese-Schaltlogik ist korrekt und monoton', () => {
  // Teil 1: ist < soll - 1.0 ⇒ Heizung AN (true), unabhängig vom Vorzustand.
  it('schaltet AN, wenn ist < soll - HYSTERESIS_BAND', () => {
    fc.assert(
      fc.property(sollGen, fc.double({ min: 0.0001, max: 50, noNaN: true }), prevStateGen, (soll, delta, prevState) => {
        const ist = soll - HYSTERESIS_BAND - delta;
        expect(hysteresisDecision(ist, soll, prevState)).toBe(true);
      }),
      { numRuns: 100 }
    );
  });

  // Teil 2: ist >= soll ⇒ Heizung AUS (false), unabhängig vom Vorzustand.
  it('schaltet AUS, wenn ist >= soll', () => {
    fc.assert(
      fc.property(sollGen, fc.double({ min: 0, max: 50, noNaN: true }), prevStateGen, (soll, delta, prevState) => {
        const ist = soll + delta; // delta >= 0 ⇒ ist >= soll (inkl. exakte Grenze soll)
        expect(hysteresisDecision(ist, soll, prevState)).toBe(false);
      }),
      { numRuns: 100 }
    );
  });

  // Teil 3: soll - 1.0 <= ist < soll ⇒ Entscheidung = vorheriger Zustand (unverändert).
  it('bleibt unverändert (== prevState), wenn soll - HYSTERESIS_BAND <= ist < soll', () => {
    fc.assert(
      // f in (0, 1]: ist = soll - HYSTERESIS_BAND * f liegt in [soll - 1.0, soll).
      // f = 0 ist ausgeschlossen, da ist = soll dann zur Grenze "ist >= soll ⇒ AUS"
      // gehört (siehe Teil 2) und nicht zum "unverändert"-Band.
      fc.property(sollGen, fc.double({ min: 0, max: 1, noNaN: true }).filter((f) => f > 0 && f <= 1), prevStateGen, (soll, f, prevState) => {
        const ist = soll - HYSTERESIS_BAND * f;
        // Gleitkomma-Schutz: Bei extремen (subnormalen) `soll`-Werten kann
        // `soll - HYSTERESIS_BAND * f` auf `soll` zurückrunden und damit aus dem
        // offenen Band [soll - 1.0, soll) fallen. Nur tatsächlich im Band
        // liegende Werte prüfen (sonst greift Teil 1/2).
        fc.pre(ist >= soll - HYSTERESIS_BAND && ist < soll);
        expect(hysteresisDecision(ist, soll, prevState)).toBe(prevState);
      }),
      { numRuns: 100 }
    );
  });

  // Teil 4: Monotonie. Bei festem soll und festem Vorzustand ist die Entscheidung
  // monoton nicht-steigend in ist: für ist1 < ist2 gilt decision(ist1) >= decision(ist2)
  // (true=AN=1 > false=AUS=0). Das bedeutet:
  //   - Absenken von ist (ist2 -> ist1) führt nie von AN zu AUS.
  //   - Anheben von ist (ist1 -> ist2) führt nie von AUS zu AN.
  it('ist monoton in ist: ist1 < ist2 ⇒ decision(ist1) wird nie AUS, wenn decision(ist2) AN', () => {
    fc.assert(
      fc.property(sollGen, istFromSollGen, istFromSollGen, prevStateGen, (soll, mkA, mkB, prevState) => {
        const a = mkA(soll);
        const b = mkB(soll);
        const lower = Math.min(a, b);
        const higher = Math.max(a, b);

        const decLower = hysteresisDecision(lower, soll, prevState);
        const decHigher = hysteresisDecision(higher, soll, prevState);

        // decision(lower) >= decision(higher), kodiert als true >= false.
        // Anheben darf nie OFF->ON: wenn decLower == false (AUS), dann decHigher == false.
        if (decLower === false) {
          expect(decHigher).toBe(false);
        }
        // Absenken darf nie ON->OFF: wenn decHigher == true (AN), dann decLower == true.
        if (decHigher === true) {
          expect(decLower).toBe(true);
        }
      }),
      { numRuns: 100 }
    );
  });
});
