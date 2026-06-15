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
  TIMER: "timer.brau_raststufe",
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
  it("triggert die Automation brausteuerung_manueller_wechsel", () => {
    const card = makeCard();
    const hass = makeHass();
    card.hass = hass;

    card._nextStep();

    expect(
      findCall(hass.callService, "automation", "trigger", {
        entity_id: ENTITY.AUTOMATION_MANUELLER_WECHSEL,
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
    // Bei aktivem Button trägt das title-Attribut den Start-Hinweis und der
    // ?disabled-Wert ist falsy (rendert als leer, nicht als "true").
    expect(out).toContain("Brauprozess starten");
    expect(out).not.toContain("?disabled=true");
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
