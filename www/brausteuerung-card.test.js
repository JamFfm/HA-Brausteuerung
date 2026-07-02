// @vitest-environment jsdom
//
// Unit-/Mock-Tests für die Card-Interaktionen (Task 8.5).
//
// Validates: Requirements 5.2, 5.3, 5.5, 6.3, 6.4, 8.3, 8.5, 7.3
//
// -----------------------------------------------------------------------------
// Lade-Strategie / Einschränkung
// -----------------------------------------------------------------------------
// `brausteuerung-card.js` leitet seine Basisklasse zur Ladezeit aus dem von
// Home Assistant registrierten Element `ha-panel-lovelace` ab:
//
//   const LitElement = Object.getPrototypeOf(customElements.get("ha-panel-lovelace"));
//   const html = LitElement.prototype.html;
//   const css  = LitElement.prototype.css;
//
// Unter Node/jsdom existiert weder HA noch das echte LitElement. Wir können das
// echte Card-Modul dennoch laden, indem wir VOR dem (dynamischen) Import ein
// Fake-`ha-panel-lovelace` registrieren, dessen Prototyp-Kette eine minimale
// Fake-LitElement-Basisklasse mit `html`-/`css`-Tag-Funktionen bereitstellt.
//
// Das echte LitElement-Rendering (Shadow-DOM, reaktive Updates) steht damit
// NICHT zur Verfügung. Stattdessen liefert unsere `html`-Tag-Funktion einen
// flach zusammengesetzten String des gerenderten Templates. Render-Tests prüfen
// daher den TEXTINHALT des Templates (Hinweise, Schwellwert, Button-Zustände,
// datalist), nicht echte DOM-Knoten. Die Interaktionsmethoden (`_start`,
// `_stop`, `_nextStep`, `_persistEntitySetting`, `_saveSettings`) sind reine
// JS-Logik und werden direkt auf der ECHTEN Card-Klasse gegen ein gemocktes
// `hass` (mit `vi.fn()`-Spy für `callService`) getestet.
// -----------------------------------------------------------------------------

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";

// Entity-IDs (Single Source of Truth des Zustands) — Spiegel von ENTITY in der Card.
const ENTITY = Object.freeze({
  RECIPE_JSON: "input_text.brau_rezept_json",
  SENSOR_ENTITY: "input_text.brau_sensor_entity",
  HEATER_ENTITY: "input_text.brau_heater_entity",
  STATUS: "input_select.brau_status",
  CURRENT_STEP: "input_number.brau_aktuelle_stufe",
  SETPOINT: "input_number.brau_solltemperatur",
  SAFETY_OFFSET: "input_number.brau_sicherheits_offset",
  HYSTERESIS: "input_number.brau_hysterese",
  TIMER: "timer.brau_raststufe",
  NAECHSTE_RAST_BUTTON: "input_button.brau_naechste_rast",
  AUTOMATION_RASTSTUFE: "automation.brausteuerung_raststufe",
  AUTOMATION_MANUELLER_WECHSEL: "automation.brausteuerung_manueller_wechsel",
});

// Wartezeit des Persistenz-Retry-Loops (Spiegel von PERSIST_RETRY_DELAY_MS).
const PERSIST_RETRY_DELAY_MS = 2000;

// -----------------------------------------------------------------------------
// Fake-LitElement-Basis: flacht das gerenderte Template zu einem durchsuchbaren
// String ab. Event-Handler (Funktionen) werden ausgelassen; verschachtelte
// `html`-Ergebnisse und Arrays werden rekursiv zusammengeführt.
// -----------------------------------------------------------------------------
function renderValue(value) {
  if (value == null || value === false) return "";
  if (Array.isArray(value)) return value.map(renderValue).join("");
  if (typeof value === "object" && "_html" in value) return value._html;
  if (typeof value === "function") return ""; // Event-Handler etc.
  return String(value);
}

function htmlTag(strings, ...values) {
  let out = "";
  for (let i = 0; i < strings.length; i++) {
    out += strings[i];
    if (i < values.length) out += renderValue(values[i]);
  }
  return { _html: out };
}

function cssTag() {
  // Styles werden in den Tests nicht ausgewertet.
  return "";
}

class FakeLitElement extends HTMLElement {
  // requestUpdate wird von der getesteten Logik nicht benötigt, aber als
  // No-op bereitgestellt, falls künftige Methoden sie aufrufen.
  requestUpdate() {}
}
FakeLitElement.prototype.html = htmlTag;
FakeLitElement.prototype.css = cssTag;

// ha-panel-lovelace so registrieren, dass Object.getPrototypeOf(...) auf
// FakeLitElement zeigt.
class FakeHaPanelLovelace extends FakeLitElement {}

let CardClass;

beforeAll(async () => {
  if (!customElements.get("ha-panel-lovelace")) {
    customElements.define("ha-panel-lovelace", FakeHaPanelLovelace);
  }
  // Dynamischer Import NACH der Registrierung, damit die Modul-Top-Level-Logik
  // (LitElement-Ableitung, customElements.define) erfolgreich durchläuft.
  await import("./brausteuerung-card.js");
  CardClass = customElements.get("brausteuerung-card");
});

// -----------------------------------------------------------------------------
// Hilfsfunktionen
// -----------------------------------------------------------------------------

/** Baut ein gemocktes hass-Objekt mit States-Map und callService-Spy. */
function makeHass(stateOverrides = {}, callService = vi.fn(() => Promise.resolve())) {
  const states = {
    [ENTITY.RECIPE_JSON]: {
      state: JSON.stringify([{ name: "Maischen", temperature: 67, duration: 60 }]),
    },
    [ENTITY.STATUS]: { state: "idle" },
    [ENTITY.CURRENT_STEP]: { state: "0" },
    [ENTITY.SETPOINT]: { state: "67" },
    [ENTITY.SAFETY_OFFSET]: { state: "5" },
    [ENTITY.SENSOR_ENTITY]: { state: "sensor.brau_temp" },
    [ENTITY.HEATER_ENTITY]: { state: "switch.brau_heizung" },
    [ENTITY.TIMER]: { state: "idle" },
    "sensor.brau_temp": {
      state: "65.0",
      attributes: { unit_of_measurement: "°C" },
    },
    ...stateOverrides,
  };
  return { states, callService };
}

/** Erzeugt eine frische, hochgestufte Card-Instanz. */
function makeCard() {
  return document.createElement("brausteuerung-card");
}

/** Findet einen callService-Aufruf anhand domain/service/teilweisem data-Match. */
function findCall(spy, domain, service, dataMatch = {}) {
  return spy.mock.calls.find(([d, s, data]) => {
    if (d !== domain || s !== service) return false;
    return Object.entries(dataMatch).every(([k, v]) => data && data[k] === v);
  });
}

// =============================================================================
// 1. Prozesssteuerung: _start (Req 8.3)
// =============================================================================
describe("_start() — Brauprozess starten (Req 8.3)", () => {
  it("setzt Stufe 0, Status running und triggert die Raststufen-Automation", () => {
    const card = makeCard();
    const hass = makeHass();
    card.hass = hass;

    card._start();

    // Stufe auf Index 0 setzen
    expect(
      findCall(hass.callService, "input_number", "set_value", {
        entity_id: ENTITY.CURRENT_STEP,
        value: 0,
      })
    ).toBeTruthy();

    // Status auf "running"
    expect(
      findCall(hass.callService, "input_select", "select_option", {
        entity_id: ENTITY.STATUS,
        option: "running",
      })
    ).toBeTruthy();

    // Regel-Automation triggern
    expect(
      findCall(hass.callService, "automation", "trigger", {
        entity_id: ENTITY.AUTOMATION_RASTSTUFE,
      })
    ).toBeTruthy();

    expect(hass.callService).toHaveBeenCalledTimes(3);
  });

  it("startet NICHT, wenn das Rezept leer ist (canStart false)", () => {
    const card = makeCard();
    const hass = makeHass({ [ENTITY.RECIPE_JSON]: { state: "[]" } });
    card.hass = hass;

    card._start();

    expect(hass.callService).not.toHaveBeenCalled();
  });

  it("startet NICHT, wenn kein gültiger Sensorwert vorliegt", () => {
    const card = makeCard();
    const hass = makeHass({ "sensor.brau_temp": { state: "unavailable" } });
    card.hass = hass;

    card._start();

    expect(hass.callService).not.toHaveBeenCalled();
  });
});

// =============================================================================
// 2. Prozesssteuerung: _stop (Req 8.4)
// =============================================================================
describe("_stop() — Brauprozess stoppen (Req 8.4)", () => {
  it("setzt Status idle, schaltet den konfigurierten Heizungs-Aktor aus und bricht den Timer ab", () => {
    const card = makeCard();
    const hass = makeHass({ [ENTITY.STATUS]: { state: "running" } });
    card.hass = hass;

    card._stop();

    expect(
      findCall(hass.callService, "input_select", "select_option", {
        entity_id: ENTITY.STATUS,
        option: "idle",
      })
    ).toBeTruthy();

    expect(
      findCall(hass.callService, "switch", "turn_off", {
        entity_id: "switch.brau_heizung",
      })
    ).toBeTruthy();

    expect(
      findCall(hass.callService, "timer", "cancel", {
        entity_id: ENTITY.TIMER,
      })
    ).toBeTruthy();

    expect(hass.callService).toHaveBeenCalledTimes(3);
  });

  it("ruft switch.turn_off NICHT auf, wenn kein Heizungs-Aktor konfiguriert ist", () => {
    const card = makeCard();
    const hass = makeHass({ [ENTITY.HEATER_ENTITY]: { state: "" } });
    card.hass = hass;

    card._stop();

    expect(findCall(hass.callService, "switch", "turn_off")).toBeFalsy();
    // Status idle und Timer-Abbruch werden dennoch ausgeführt.
    expect(
      findCall(hass.callService, "input_select", "select_option", {
        entity_id: ENTITY.STATUS,
        option: "idle",
      })
    ).toBeTruthy();
    expect(findCall(hass.callService, "timer", "cancel")).toBeTruthy();
  });
});

// =============================================================================
// 3. Prozesssteuerung: _nextStep (Req 8.5)
// =============================================================================
describe("_nextStep() — manueller Stufenwechsel (Req 8.5)", () => {
  it("drückt den Taster input_button.brau_naechste_rast", () => {
    const card = makeCard();
    const hass = makeHass();
    card.hass = hass;

    card._nextStep();

    expect(
      findCall(hass.callService, "input_button", "press", {
        entity_id: ENTITY.NAECHSTE_RAST_BUTTON,
      })
    ).toBeTruthy();
    expect(hass.callService).toHaveBeenCalledTimes(1);
  });
});

// =============================================================================
// 4. Speichern der Entitätsauswahl: _saveSettings (Req 5.2, 6.4)
// =============================================================================
describe("_saveSettings() — Entitätsauswahl speichern (Req 5.2, 6.4)", () => {
  it("hält Auswahl lokal, schließt das Panel und persistiert Sensor und Heizung", () => {
    const card = makeCard();
    const hass = makeHass();
    card.hass = hass;
    card._showSettings = true;

    // _q liest normalerweise aus dem (hier nicht gerenderten) Shadow-DOM.
    // Wir stubben es, um die Formularwerte bereitzustellen.
    card._q = (selector) => {
      if (selector === "#settings-sensor") return { value: "sensor.neuer_temp" };
      if (selector === "#settings-heater") return { value: "switch.neue_heizung" };
      return null;
    };

    card._saveSettings();

    // Lokal gehaltene Werte (Single Source of Truth bis Persistenz gelingt).
    expect(card._sensorEntity).toBe("sensor.neuer_temp");
    expect(card._heaterEntity).toBe("switch.neue_heizung");
    expect(card._showSettings).toBe(false);

    // Persistenz beider Helferwerte über input_text.set_value.
    expect(
      findCall(hass.callService, "input_text", "set_value", {
        entity_id: ENTITY.SENSOR_ENTITY,
        value: "sensor.neuer_temp",
      })
    ).toBeTruthy();
    expect(
      findCall(hass.callService, "input_text", "set_value", {
        entity_id: ENTITY.HEATER_ENTITY,
        value: "switch.neue_heizung",
      })
    ).toBeTruthy();
  });
});

// =============================================================================
// 5. Persistenzschutz: _persistEntitySetting Retry-Loop (Req 5.3, 5.5)
// =============================================================================
describe("_persistEntitySetting() — Persistenzschutz mit Retry (Req 5.3, 5.5)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("behält den lokalen Wert bei Fehler, zeigt Fehlermeldung und wiederholt bis zum Erfolg", async () => {
    const card = makeCard();
    // callService: erster Versuch schlägt fehl, zweiter Versuch gelingt.
    const callService = vi
      .fn()
      .mockRejectedValueOnce(new Error("HA nicht erreichbar"))
      .mockResolvedValueOnce(undefined);
    card.hass = makeHass({}, callService);

    // Lokaler Wert, der trotz Fehlschlag erhalten bleiben muss (Req 5.3).
    card._sensorEntity = "sensor.gehalten";

    const promise = card._persistEntitySetting(ENTITY.SENSOR_ENTITY, "sensor.gehalten");

    // Ersten (fehlschlagenden) Versuch abarbeiten.
    await vi.advanceTimersByTimeAsync(0);
    expect(callService).toHaveBeenCalledTimes(1);
    // Fehlermeldung gesetzt, lokaler Wert unverändert erhalten.
    expect(card._errorMessage).not.toBe("");
    expect(card._sensorEntity).toBe("sensor.gehalten");

    // Retry-Verzögerung abwarten -> zweiter Versuch gelingt.
    await vi.advanceTimersByTimeAsync(PERSIST_RETRY_DELAY_MS);
    await promise;

    expect(callService).toHaveBeenCalledTimes(2);
    // Beide Versuche zielen auf denselben Helfer mit demselben Wert.
    expect(callService).toHaveBeenNthCalledWith(2, "input_text", "set_value", {
      entity_id: ENTITY.SENSOR_ENTITY,
      value: "sensor.gehalten",
    });
    // Nach Erfolg ist die Fehlermeldung gelöscht.
    expect(card._errorMessage).toBe("");
    // Lokaler Wert weiterhin erhalten.
    expect(card._sensorEntity).toBe("sensor.gehalten");
  });

  it("speichert beim ersten Versuch ohne Fehlermeldung, wenn callService sofort gelingt", async () => {
    const card = makeCard();
    const callService = vi.fn(() => Promise.resolve());
    card.hass = makeHass({}, callService);

    const promise = card._persistEntitySetting(ENTITY.HEATER_ENTITY, "switch.x");
    await vi.advanceTimersByTimeAsync(0);
    await promise;

    expect(callService).toHaveBeenCalledTimes(1);
    expect(card._errorMessage).toBe("");
  });
});

// =============================================================================
// 6. Render-Tests: Sensor-Hinweise und Temperaturanzeige (Req 8.3 / 1.x)
// =============================================================================
describe("render() — Sensor-Hinweise und Temperaturanzeige", () => {
  it("zeigt 'Kein Sensor gesetzt', wenn keine Sensor-Entität konfiguriert ist (Req 1.4)", () => {
    const card = makeCard();
    card.hass = makeHass({ [ENTITY.SENSOR_ENTITY]: { state: "" } });

    const out = card.render()._html;
    expect(out).toContain("Kein Sensor gesetzt");
  });

  it("zeigt 'Kein gültiger Sensorwert', wenn der Sensor unavailable ist (Req 1.3)", () => {
    const card = makeCard();
    card.hass = makeHass({ "sensor.brau_temp": { state: "unavailable" } });

    const out = card.render()._html;
    expect(out).toContain("Kein gültiger Sensorwert");
  });

  it("zeigt die Ist-Temperatur inkl. Einheit bei gültigem Sensorwert (Req 1.1)", () => {
    const card = makeCard();
    card.hass = makeHass({
      "sensor.brau_temp": { state: "64.5", attributes: { unit_of_measurement: "°C" } },
    });

    const out = card.render()._html;
    expect(out).toContain("64.5");
    expect(out).toContain("°C");
    expect(out).not.toContain("Kein gültiger Sensorwert");
  });
});

// =============================================================================
// 7. Render-Tests: Schwellwert-Anzeige (Req 8.3 / 9.3)
// =============================================================================
describe("render() — Sicherheitsschwellwert (Req 9.3)", () => {
  it("zeigt soll + offset als Abschaltschwelle an", () => {
    const card = makeCard();
    // soll 67 + offset 5 = 72
    card.hass = makeHass();

    const out = card.render()._html;
    expect(out).toContain("Sicherheitsabschaltung bei 72");
  });

  it("zeigt '—', wenn kein gültiger Schwellwert berechnet werden kann", () => {
    const card = makeCard();
    card.hass = makeHass({ [ENTITY.SETPOINT]: { state: "unknown" } });

    const out = card.render()._html;
    expect(out).toContain("Sicherheitsabschaltung bei —");
  });
});

// =============================================================================
// 8. Render-Tests: Button-Zustände (Req 8.3)
// =============================================================================
describe("render() — Button-Zustände", () => {
  it("aktiviert den Start-Button bei gültigem Rezept und Sensorwert", () => {
    const card = makeCard();
    card.hass = makeHass(); // Rezept mit 1 Rast, Sensor 65.0 gültig, Status idle

    const out = card.render()._html;
    expect(out).toContain("▶ Start");
    // Der aktive Start-Button trägt den Start-Hinweis als title; der
    // disabled-Hinweis darf NICHT erscheinen (der Button ist nicht gesperrt).
    expect(out).toContain("Brauprozess starten");
    expect(out).not.toContain("Start benötigt mindestens eine Rast");
  });

  it("deaktiviert den Start-Button bei leerem Rezept", () => {
    const card = makeCard();
    card.hass = makeHass({ [ENTITY.RECIPE_JSON]: { state: "[]" } });

    const out = card.render()._html;
    expect(out).toContain("▶ Start");
    // Deaktiviert: ?disabled rendert truthy und der title-Hinweis erscheint.
    expect(out).toContain("?disabled=true");
    expect(out).toContain("Start benötigt mindestens eine Rast");
  });

  it("zeigt 'Nächste Rast' und 'Stop' während eines laufenden Prozesses (Req 8.5)", () => {
    const card = makeCard();
    card.hass = makeHass({ [ENTITY.STATUS]: { state: "running" } });

    const out = card.render()._html;
    expect(out).toContain("⏭ Nächste Rast");
    expect(out).toContain("⏹ Stop");
    expect(out).not.toContain("▶ Start");
  });
});

// =============================================================================
// 9. Render-Tests: datalist-Autovervollständigung im Settings-Panel
//    (Req 5.5, 6.3, 7.3)
// =============================================================================
describe("render() — datalist-Verhalten im Settings-Panel (Req 6.3, 7.3)", () => {
  it("bietet sensor.*- und switch.*-Entitäten als <datalist>-Optionen an", () => {
    const card = makeCard();
    card.hass = makeHass({
      "sensor.kessel": { state: "70" },
      "switch.pumpe": { state: "off" },
    });
    card._showSettings = true;

    const out = card.render()._html;

    // datalist statt schließendem <select> -> Liste bleibt bei Auswahl offen (Req 7.3).
    expect(out).toContain("<datalist");
    expect(out).toContain('id="sensor-options"');
    expect(out).toContain('id="switch-options"');

    // Eingabefelder referenzieren die datalists.
    expect(out).toContain('list="sensor-options"');
    expect(out).toContain('list="switch-options"');

    // Vorschläge enthalten die passenden Domänen-Entitäten.
    // (Die <option>-Werte sind im Template unquoted: value=${id}.)
    expect(out).toContain("value=sensor.kessel");
    expect(out).toContain("value=switch.pumpe");
  });
});

// =============================================================================
// 10. Umsortieren der Raststufen: _moveStep (Req 3.7, 3.8)
// =============================================================================
describe("_moveStep() — Reihenfolge ändern und persistieren (Req 3.7, 3.8)", () => {
  const dreiRasten = JSON.stringify([
    { name: "A", temperature: 50, duration: 10 },
    { name: "B", temperature: 60, duration: 20 },
    { name: "C", temperature: 70, duration: 30 },
  ]);

  it("verschiebt eine Rast nach unten und persistiert die neue Reihenfolge", () => {
    const card = makeCard();
    const hass = makeHass({ [ENTITY.RECIPE_JSON]: { state: dreiRasten } });
    card.hass = hass;

    card._moveStep(0, 1); // A nach unten -> B, A, C

    const call = findCall(hass.callService, "input_text", "set_value", {
      entity_id: ENTITY.RECIPE_JSON,
    });
    expect(call).toBeTruthy();
    const persisted = JSON.parse(call[2].value);
    expect(persisted.map((s) => s.n)).toEqual(["B", "A", "C"]);
  });

  it("verschiebt eine Rast nach oben und persistiert die neue Reihenfolge", () => {
    const card = makeCard();
    const hass = makeHass({ [ENTITY.RECIPE_JSON]: { state: dreiRasten } });
    card.hass = hass;

    card._moveStep(2, -1); // C nach oben -> A, C, B

    const call = findCall(hass.callService, "input_text", "set_value", {
      entity_id: ENTITY.RECIPE_JSON,
    });
    const persisted = JSON.parse(call[2].value);
    expect(persisted.map((s) => s.n)).toEqual(["A", "C", "B"]);
  });

  it("persistiert nichts an den Listengrenzen (erste Rast nach oben)", () => {
    const card = makeCard();
    const hass = makeHass({ [ENTITY.RECIPE_JSON]: { state: dreiRasten } });
    card.hass = hass;

    card._moveStep(0, -1);

    expect(findCall(hass.callService, "input_text", "set_value")).toBeFalsy();
  });

  it("verschiebt NICHT während eines laufenden Prozesses (Req 3.8)", () => {
    const card = makeCard();
    const hass = makeHass({
      [ENTITY.RECIPE_JSON]: { state: dreiRasten },
      [ENTITY.STATUS]: { state: "running" },
    });
    card.hass = hass;

    card._moveStep(0, 1);

    expect(findCall(hass.callService, "input_text", "set_value")).toBeFalsy();
  });
});

// =============================================================================
// 11. Manuelles Schalten des Heizungs-Aktors: _toggleHeater (Req 5.8)
// =============================================================================
describe("_toggleHeater() — manuelles Schalten (Req 5.8)", () => {
  it("ruft switch.turn_on auf, wenn der Aktor aktuell aus ist", () => {
    const card = makeCard();
    const hass = makeHass({ "switch.brau_heizung": { state: "off" } });
    card.hass = hass;

    card._toggleHeater();

    expect(
      findCall(hass.callService, "switch", "turn_on", {
        entity_id: "switch.brau_heizung",
      })
    ).toBeTruthy();
  });

  it("ruft switch.turn_off auf, wenn der Aktor aktuell an ist", () => {
    const card = makeCard();
    const hass = makeHass({ "switch.brau_heizung": { state: "on" } });
    card.hass = hass;

    card._toggleHeater();

    expect(
      findCall(hass.callService, "switch", "turn_off", {
        entity_id: "switch.brau_heizung",
      })
    ).toBeTruthy();
  });

  it("schaltet nicht und meldet einen Fehler, wenn kein Heizungs-Aktor konfiguriert ist", () => {
    const card = makeCard();
    const hass = makeHass({ [ENTITY.HEATER_ENTITY]: { state: "" } });
    card.hass = hass;
    // Fallback-Defaults ebenfalls leer halten.
    card._heaterEntity = "";
    card._config = {};

    card._toggleHeater();

    expect(findCall(hass.callService, "switch", "turn_on")).toBeFalsy();
    expect(findCall(hass.callService, "switch", "turn_off")).toBeFalsy();
    expect(card._errorMessage).not.toBe("");
  });
});

// =============================================================================
// 12. Render-Tests: Heizungs-Zustand und Flammensymbol (Req 5.6, 5.7)
// =============================================================================
describe("render() — Heizungs-Zustand und Flammensymbol (Req 5.6, 5.7)", () => {
  it("zeigt 'AN' und das Flammensymbol, wenn der Heizungs-Aktor eingeschaltet ist (Req 5.7)", () => {
    const card = makeCard();
    card.hass = makeHass({ "switch.brau_heizung": { state: "on" } });

    const out = card.render()._html;
    expect(out).toContain("🔥");
    expect(out).toContain("AN");
  });

  it("zeigt 'AUS' ohne Flammensymbol, wenn der Heizungs-Aktor ausgeschaltet ist (Req 5.6)", () => {
    const card = makeCard();
    card.hass = makeHass({ "switch.brau_heizung": { state: "off" } });

    const out = card.render()._html;
    expect(out).toContain("AUS");
    expect(out).not.toContain("🔥");
  });
});

// =============================================================================
// 13. Render-Tests: Echtzeit-Countdown der Haltezeit (Req 4.7)
// =============================================================================
describe("render() — Echtzeit-Countdown der Haltezeit (Req 4.7)", () => {
  it("zeigt die verbleibende Haltezeit sekundengenau bei laufendem Timer", () => {
    const card = makeCard();
    // Timer aktiv, endet in 90 Sekunden -> 01:30
    const finishesAt = new Date(Date.now() + 90_000).toISOString();
    card.hass = makeHass({
      [ENTITY.STATUS]: { state: "running" },
      [ENTITY.TIMER]: { state: "active", attributes: { finishes_at: finishesAt } },
    });

    const out = card.render()._html;
    expect(out).toContain("Verbleibende Haltezeit");
    expect(out).toContain("01:30");
  });

  it("zeigt keinen Countdown, wenn kein Timer aktiv ist", () => {
    const card = makeCard();
    card.hass = makeHass({ [ENTITY.TIMER]: { state: "idle" } });

    const out = card.render()._html;
    expect(out).not.toContain("Verbleibende Haltezeit");
  });
});

// =============================================================================
// 14. Hystereseband: _saveHysteresis (Req 4.9)
// =============================================================================
describe("_saveHysteresis() — Hystereseband speichern (Req 4.9)", () => {
  it("persistiert einen gültigen Wert (0 < v <= 5) nach input_number.brau_hysterese", () => {
    const card = makeCard();
    const hass = makeHass();
    card.hass = hass;

    const ok = card._saveHysteresis(2.5);

    expect(ok).toBe(true);
    expect(
      findCall(hass.callService, "input_number", "set_value", {
        entity_id: ENTITY.HYSTERESIS,
        value: 2.5,
      })
    ).toBeTruthy();
  });

  it("akzeptiert auch eine String-Eingabe (wie aus dem Eingabefeld)", () => {
    const card = makeCard();
    const hass = makeHass();
    card.hass = hass;

    const ok = card._saveHysteresis("1.5");

    expect(ok).toBe(true);
    expect(
      findCall(hass.callService, "input_number", "set_value", {
        entity_id: ENTITY.HYSTERESIS,
        value: 1.5,
      })
    ).toBeTruthy();
  });

  it("persistiert NICHT bei ungültigem Wert (<= 0 oder > 5) und meldet einen Fehler", () => {
    const card = makeCard();
    const hass = makeHass();
    card.hass = hass;

    expect(card._saveHysteresis(0)).toBe(false);
    expect(card._saveHysteresis(6)).toBe(false);
    expect(card._saveHysteresis("abc")).toBe(false);

    expect(findCall(hass.callService, "input_number", "set_value", {
      entity_id: ENTITY.HYSTERESIS,
    })).toBeFalsy();
    expect(card._errorMessage).not.toBe("");
  });
});

// =============================================================================
// 15. Render-Tests: Anzeige des Hysteresebandes (Req 4.10)
// =============================================================================
describe("render() — Anzeige des Hysteresebandes (Req 4.10)", () => {
  it("zeigt das konfigurierte Hystereseband an", () => {
    const card = makeCard();
    card.hass = makeHass({ [ENTITY.HYSTERESIS]: { state: "2.0" } });

    const out = card.render()._html;
    expect(out).toContain("Hysterese: 2 °C");
  });

  it("zeigt den Default 1 °C an, wenn kein gültiger Helferwert vorliegt", () => {
    const card = makeCard();
    card.hass = makeHass({ [ENTITY.HYSTERESIS]: { state: "unknown" } });

    const out = card.render()._html;
    expect(out).toContain("Hysterese: 1 °C");
  });
});

// =============================================================================
// 16. Versionierung / Cache-Busting (Req 11.5)
// =============================================================================
describe("Versionierung / Cache-Busting (Req 11.5)", () => {
  it("registriert die Card mit einer Versionsangabe in window.customCards", () => {
    const entry = (window.customCards || []).find(
      (c) => c.type === "brausteuerung-card"
    );
    expect(entry).toBeTruthy();
    // Der Anzeigename enthält die Version im Format "(vX.Y)" bzw. "(vX.Y.Z)".
    expect(entry.name).toMatch(/\(v\d+\.\d+(?:\.\d+)?\)/);
  });

  it("lädt das Logikmodul über eine versionierte Import-URL (Cache-Busting)", async () => {
    // Quelltext der Card lesen und prüfen, dass der interne Import die
    // ?v=-Query trägt und die Versionsnummer mit der VERSION-Konstante
    // übereinstimmt.
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const cardPath = path.resolve(process.cwd(), "www/brausteuerung-card.js");
    const source = await fs.readFile(cardPath, "utf8");

    const versionMatch = source.match(/const VERSION = "(\d+\.\d+(?:\.\d+)?)"/);
    expect(versionMatch).toBeTruthy();
    const version = versionMatch[1];

    // Der interne Logik-Import muss exakt dieselbe Version als Query tragen.
    expect(source).toContain(`./brausteuerung-logic.js?v=${version}`);
  });
});

// =============================================================================
// 17. Rezeptverwaltung / Rezept-Bibliothek (Req 12)
// =============================================================================
const LIBRARY_KEY = "brausteuerung_recipes";

/**
 * Baut ein hass-Mock mit WebSocket-Verbindung. `getValue` liefert den Rohwert
 * für frontend/get_user_data; set-Aufrufe werden im Spy erfasst.
 */
function makeHassWithConnection(stateOverrides = {}, getValue = "[]") {
  const hass = makeHass(stateOverrides);
  const sendMessagePromise = vi.fn((msg) => {
    if (msg.type === "frontend/get_user_data") {
      return Promise.resolve({ value: getValue });
    }
    if (msg.type === "frontend/set_user_data") {
      return Promise.resolve();
    }
    return Promise.resolve();
  });
  hass.connection = { sendMessagePromise };
  return hass;
}

describe("Rezept-Bibliothek — Laden/Speichern via user_data (Req 12.7, 12.8, 12.10)", () => {
  it("_loadLibrary liest frontend/get_user_data mit dem Bibliotheks-Key und setzt _library", async () => {
    const card = makeCard();
    const lib = [{ name: "Helles", steps: [{ name: "R1", temperature: 55, duration: 15 }] }];
    card.hass = makeHassWithConnection({}, JSON.stringify(lib));
    card._libraryLoaded = false;

    await card._loadLibrary();

    expect(card.hass.connection.sendMessagePromise).toHaveBeenCalledWith({
      type: "frontend/get_user_data",
      key: LIBRARY_KEY,
    });
    expect(card._library).toEqual(lib);
  });

  it("_persistLibrary schreibt frontend/set_user_data mit serialisierter Bibliothek", async () => {
    const card = makeCard();
    card.hass = makeHassWithConnection();
    const lib = [{ name: "Weizen", steps: [] }];

    const ok = await card._persistLibrary(lib);

    expect(ok).toBe(true);
    expect(card.hass.connection.sendMessagePromise).toHaveBeenCalledWith({
      type: "frontend/set_user_data",
      key: LIBRARY_KEY,
      value: JSON.stringify(lib),
    });
    expect(card._library).toEqual(lib);
  });

  it("_persistLibrary behält bei Fehler die bestehende Bibliothek und meldet einen Fehler (Req 12.10)", async () => {
    const card = makeCard();
    const hass = makeHass();
    hass.connection = {
      sendMessagePromise: vi.fn(() => Promise.reject(new Error("kaputt"))),
    };
    card.hass = hass;
    card._library = [{ name: "Alt", steps: [] }];

    const ok = await card._persistLibrary([{ name: "Neu", steps: [] }]);

    expect(ok).toBe(false);
    expect(card._library).toEqual([{ name: "Alt", steps: [] }]);
    expect(card._errorMessage).not.toBe("");
  });
});

describe("Rezept-Bibliothek — Speichern unter… mit Überschreib-Bestätigung (Req 12.1, 12.2)", () => {
  it("speichert das aktive Rezept unter neuem Namen", async () => {
    const card = makeCard();
    card.hass = makeHassWithConnection();
    card._library = [];

    const res = await card._saveRecipeToLibrary("Pils", false);

    expect(res.ok).toBe(true);
    const setCall = card.hass.connection.sendMessagePromise.mock.calls.find(
      ([m]) => m.type === "frontend/set_user_data"
    );
    expect(setCall).toBeTruthy();
    const saved = JSON.parse(setCall[0].value);
    expect(saved.find((r) => r.name === "Pils")).toBeTruthy();
  });

  it("verlangt Bestätigung bei vorhandenem Namen und persistiert ohne Bestätigung nicht (Req 12.2)", async () => {
    const card = makeCard();
    card.hass = makeHassWithConnection();
    card._library = [{ name: "Pils", steps: [] }];

    const res = await card._saveRecipeToLibrary("Pils", false);

    expect(res.ok).toBe(false);
    expect(res.needsConfirm).toBe(true);
    const setCall = card.hass.connection.sendMessagePromise.mock.calls.find(
      ([m]) => m.type === "frontend/set_user_data"
    );
    expect(setCall).toBeFalsy();
  });

  it("überschreibt nach Bestätigung", async () => {
    const card = makeCard();
    card.hass = makeHassWithConnection();
    card._library = [{ name: "Pils", steps: [{ name: "alt", temperature: 50, duration: 5 }] }];

    const res = await card._saveRecipeToLibrary("Pils", true);

    expect(res.ok).toBe(true);
    const setCall = card.hass.connection.sendMessagePromise.mock.calls.find(
      ([m]) => m.type === "frontend/set_user_data"
    );
    const saved = JSON.parse(setCall[0].value);
    // Genau ein "Pils"-Eintrag (Eindeutigkeit), mit dem aktiven Rezept als steps.
    expect(saved.filter((r) => r.name === "Pils").length).toBe(1);
  });

  it("lehnt leeren Namen ab", async () => {
    const card = makeCard();
    card.hass = makeHassWithConnection();
    card._library = [];

    const res = await card._saveRecipeToLibrary("   ", false);

    expect(res.ok).toBe(false);
    expect(card._errorMessage).not.toBe("");
  });
});

describe("Rezept-Bibliothek — Laden eines Rezepts als aktives Rezept (Req 12.4, 12.5, 12.9)", () => {
  it("schreibt die Schritte des gewählten Rezepts nach input_text.brau_rezept_json", () => {
    const card = makeCard();
    const hass = makeHassWithConnection();
    card.hass = hass;
    card._library = [
      { name: "Helles", steps: [{ name: "Eiweiß", temperature: 55, duration: 15 }] },
    ];

    const ok = card._loadRecipeFromLibrary("Helles");

    expect(ok).toBe(true);
    const call = findCall(hass.callService, "input_text", "set_value", {
      entity_id: ENTITY.RECIPE_JSON,
    });
    expect(call).toBeTruthy();
    // Persistiert wird die kompakte Form (n/t/d) im aktiven Rezept-Helfer.
    expect(JSON.parse(call[2].value)).toEqual([
      { n: "Eiweiß", t: 55, d: 15 },
    ]);
  });

  it("lehnt das Laden ab, wenn das Rezept die 255-Zeichen-Grenze überschreitet (Req 12.5)", () => {
    const card = makeCard();
    const hass = makeHassWithConnection();
    card.hass = hass;
    // Viele Rasten mit langen Namen -> JSON > 255 Zeichen.
    const bigSteps = Array.from({ length: 12 }, (_, i) => ({
      name: "SehrLangerRastnameNummer" + i,
      temperature: 60 + i,
      duration: 10 + i,
    }));
    card._library = [{ name: "Groß", steps: bigSteps }];

    const ok = card._loadRecipeFromLibrary("Groß");

    expect(ok).toBe(false);
    expect(findCall(hass.callService, "input_text", "set_value", {
      entity_id: ENTITY.RECIPE_JSON,
    })).toBeFalsy();
    expect(card._errorMessage).not.toBe("");
  });

  it("ist während eines laufenden Prozesses gesperrt (Req 12.9)", () => {
    const card = makeCard();
    const hass = makeHassWithConnection({ [ENTITY.STATUS]: { state: "running" } });
    card.hass = hass;
    card._library = [{ name: "Helles", steps: [{ name: "R1", temperature: 55, duration: 15 }] }];

    const ok = card._loadRecipeFromLibrary("Helles");

    expect(ok).toBe(false);
    expect(findCall(hass.callService, "input_text", "set_value", {
      entity_id: ENTITY.RECIPE_JSON,
    })).toBeFalsy();
  });
});

describe("Rezept-Bibliothek — Löschen (Req 12.6)", () => {
  it("entfernt das benannte Rezept und persistiert die reduzierte Bibliothek", async () => {
    const card = makeCard();
    card.hass = makeHassWithConnection();
    card._library = [
      { name: "Helles", steps: [] },
      { name: "Weizen", steps: [] },
    ];

    const ok = await card._deleteRecipeFromLibrary("Helles");

    expect(ok).toBe(true);
    const setCall = card.hass.connection.sendMessagePromise.mock.calls.find(
      ([m]) => m.type === "frontend/set_user_data"
    );
    const saved = JSON.parse(setCall[0].value);
    expect(saved.map((r) => r.name)).toEqual(["Weizen"]);
  });
});

describe("render() — Rezeptverwaltungs-Panel (Req 12.3, 12.9)", () => {
  it("zeigt die gespeicherten Rezeptnamen und deaktiviert 'Laden' während running", () => {
    const card = makeCard();
    card.hass = makeHassWithConnection({ [ENTITY.STATUS]: { state: "running" } });
    card._showLibrary = true;
    card._library = [{ name: "Helles", steps: [] }];

    const out = card.render()._html;
    expect(out).toContain("Rezepte verwalten");
    expect(out).toContain("Helles");
    // Während running ist der Laden-Button deaktiviert.
    expect(out).toContain("?disabled=true");
  });
});

// =============================================================================
// 18. Temperaturverlauf-Graph — eingebettete native history-graph-Karte (Req 13)
// =============================================================================
describe("Temperaturverlauf-Graph — Anzeigedauer (Req 13.3)", () => {
  it("_setGraphHours klemmt den Wert auf 1..4", () => {
    const card = makeCard();
    card.hass = makeHass();

    card._setGraphHours(3);
    expect(card._graphHours).toBe(3);

    card._setGraphHours(99);
    expect(card._graphHours).toBe(4);

    card._setGraphHours(0);
    expect(card._graphHours).toBe(1);
  });
});

describe("Temperaturverlauf-Graph — Fenster ab Startzeitpunkt (Req 13)", () => {
  it("nutzt ohne laufenden Brauvorgang die gewählte Dauer", () => {
    const card = makeCard();
    card.hass = makeHass({ [ENTITY.STATUS]: { state: "idle" } });
    card._graphHours = 3;
    expect(card._effectiveGraphHours()).toBe(3);
  });

  it("begrenzt bei laufendem Brauvorgang das Fenster auf die Zeit seit Start", () => {
    const card = makeCard();
    const start = new Date(Date.now() - 30 * 60000).toISOString(); // vor 30 min
    card.hass = makeHass({
      [ENTITY.STATUS]: { state: "running", last_changed: start },
    });
    card._graphHours = 2;
    // ~0.5 h seit Start, gedeckelt auf gewählte 2 h ⇒ ~0.5.
    expect(card._effectiveGraphHours()).toBeGreaterThan(0.4);
    expect(card._effectiveGraphHours()).toBeLessThan(0.6);
  });

  it("deckelt das Fenster auf die gewählte Dauer, wenn der Start länger zurückliegt", () => {
    const card = makeCard();
    const start = new Date(Date.now() - 5 * 3600000).toISOString(); // vor 5 h
    card.hass = makeHass({
      [ENTITY.STATUS]: { state: "running", last_changed: start },
    });
    card._graphHours = 2;
    expect(card._effectiveGraphHours()).toBe(2);
  });
});

describe("render() — Temperaturverlauf-Graph (Req 13)", () => {
  it("zeigt den Graph-Titel und die Dauer-Auswahl (1–4 h)", () => {
    const card = makeCard();
    card.hass = makeHass();

    const out = card.render()._html;
    expect(out).toContain("Temperaturverlauf");
    expect(out).toContain("1 h");
    expect(out).toContain("4 h");
  });

  it("zeigt einen Ladehinweis, solange die native Karte nicht bereit ist", () => {
    const card = makeCard();
    card.hass = makeHass();

    // In der Testumgebung existiert window.loadCardHelpers nicht, daher bleibt
    // die eingebettete Karte im Ladezustand.
    const out = card.render()._html;
    expect(out).toContain("Lade Temperaturverlauf");
  });

  it("fordert zur Sensorauswahl auf, wenn kein Sensor konfiguriert ist", () => {
    const card = makeCard();
    card.hass = makeHass({ [ENTITY.SENSOR_ENTITY]: { state: "" } });
    card._sensorEntity = "";

    const out = card.render()._html;
    expect(out).toContain("Temperatursensor auswählen");
  });
});
