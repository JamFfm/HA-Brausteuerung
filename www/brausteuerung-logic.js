/**
 * brausteuerung-logic.js
 *
 * Reines, Home-Assistant-freies Logikmodul der Brausteuerung.
 *
 * Dieses Modul enthält ausschließlich reine Funktionen (keine HA-Seiteneffekte,
 * kein DOM-Zugriff, keine `customElements`-/LitElement-Abhängigkeiten). Es ist
 * dadurch sowohl im Browser als auch in Vitest direkt importierbar und mit
 * fast-check property-testbar.
 *
 * Die konkreten Implementierungen werden in späteren Tasks gefüllt:
 *   - Task 2.1: isValidRaststufe, resolveStepName, serializeRecipe, parseRecipe, canPersistRecipe
 *   - Task 3.1: addStep, editStep, removeStep, clearRecipe
 *   - Task 5.1: hysteresisDecision, nextStepTransition, heatingDecision, computeSafetyThreshold
 *   - Task 6.1: isSensorValid, canStart, shouldUpdateDecision
 *
 * @module brausteuerung-logic
 */

// ---------------------------------------------------------------------------
// Konstanten (aus design.md)
// ---------------------------------------------------------------------------

/**
 * Maximale Länge des serialisierten Rezept-JSON (Limit von `input_text`).
 * @type {number}
 */
export const MAX_RECIPE_JSON_LENGTH = 255;

/**
 * Hystereseband in °C: Heizung schaltet AN, sobald die Ist-Temperatur
 * `HYSTERESIS_BAND` unter der Solltemperatur liegt (Req 4.3). Dient als
 * Default-Wert für das über die Card konfigurierbare Hystereseband (Req 4.9).
 * @type {number}
 */
export const HYSTERESIS_BAND = 1.0;

/**
 * Gültiger Wertebereich des konfigurierbaren Hysteresebandes in °C (Req 4.9):
 * größer als 0 °C bis maximal 5 °C.
 * @type {number}
 */
export const MIN_HYSTERESIS = 0;
/** @type {number} */
export const MAX_HYSTERESIS = 5;

/**
 * Untere und obere Grenze einer gültigen Solltemperatur in °C (Req 2.2).
 * @type {number}
 */
export const MIN_TEMPERATURE = 0;
/** @type {number} */
export const MAX_TEMPERATURE = 100;

/**
 * Mögliche Betriebszustände der Brausteuerung.
 * @readonly
 * @enum {string}
 */
export const Status = Object.freeze({
  IDLE: 'idle',
  RUNNING: 'running',
  PAUSED: 'paused',
  DONE: 'done',
});

/**
 * Heizentscheidung der Steuerungslogik.
 * @readonly
 * @enum {string}
 */
export const HeaterDecision = Object.freeze({
  ON: 'on',
  OFF: 'off',
  UNCHANGED: 'unchanged',
});

// ---------------------------------------------------------------------------
// Typdefinitionen
// ---------------------------------------------------------------------------

/**
 * Eine Raststufe eines Braurezepts.
 * @typedef {Object} Raststufe
 * @property {string} name        Anzeigename; leer ⇒ "Rast {position}".
 * @property {number} temperature Solltemperatur in °C (0 ≤ t ≤ 100).
 * @property {number} duration    Haltezeit in Minuten, ganzzahlig > 0.
 */

/**
 * Ein Braurezept als geordnete Liste von Raststufen.
 * @typedef {Raststufe[]} Braurezept
 */

/**
 * Ergebnis eines Stufenindex-Übergangs.
 * @typedef {Object} StepTransition
 * @property {number} index   Neuer (aktiver) Stufenindex.
 * @property {string} status  Resultierender Status (siehe {@link Status}).
 * @property {boolean} done    Ob das Rezept abgeschlossen ist.
 */

// ---------------------------------------------------------------------------
// Rezept-Eingabelogik (Task 2.1) — Validierung, Standardname, Serialisierung
// ---------------------------------------------------------------------------

/**
 * Prüft, ob eine Raststufe gültige Werte hat (Req 2.2, 2.3, 2.4).
 *
 * Gültig genau dann, wenn `temp` eine Zahl mit 0 ≤ temp ≤ 100 ist UND
 * `dur` eine Ganzzahl > 0 ist. Der Name wird nicht auf Gültigkeit geprüft
 * (siehe {@link resolveStepName}).
 *
 * @param {string} name Name der Raststufe (für Validität irrelevant).
 * @param {number} temp Solltemperatur in °C.
 * @param {number} dur  Haltezeit in Minuten.
 * @returns {boolean} `true`, wenn die Raststufe gültig ist.
 */
export function isValidRaststufe(name, temp, dur) {
  const tempValid =
    typeof temp === 'number' &&
    Number.isFinite(temp) &&
    temp >= MIN_TEMPERATURE &&
    temp <= MAX_TEMPERATURE;
  const durValid = Number.isInteger(dur) && dur > 0;
  return tempValid && durValid;
}

/**
 * Liefert den anzuzeigenden Namen einer Raststufe (Req 2.5).
 *
 * Ein leerer oder ausschließlich aus Whitespace bestehender Name wird durch
 * den Standardnamen `"Rast {position}"` ersetzt; ein nicht-leerer Name bleibt
 * unverändert.
 *
 * @param {string} name     Eingegebener Name.
 * @param {number} position Position der Raststufe (für den Standardnamen).
 * @returns {string} Der aufgelöste Anzeigename.
 */
export function resolveStepName(name, position) {
  if (typeof name === 'string' && name.trim() !== '') {
    return name;
  }
  return `Rast ${position}`;
}

/**
 * Serialisiert ein Braurezept zu einem JSON-String (Req 2.1, 2.6).
 *
 * @param {Braurezept} recipe Das zu serialisierende Rezept.
 * @returns {string} JSON-String des Rezepts.
 */
export function serializeRecipe(recipe) {
  return JSON.stringify(recipe);
}

/**
 * Parst einen JSON-String zu einem Braurezept.
 *
 * Bei Parse-Fehlern (leerer String, ungültiges JSON, beschädigter Wert)
 * wird ein leeres Rezept `[]` zurückgegeben (Error Handling im Design).
 *
 * @param {string} jsonString Serialisiertes Rezept.
 * @returns {Braurezept} Das geparste Rezept oder `[]` bei Fehler.
 */
export function parseRecipe(jsonString) {
  try {
    const parsed = JSON.parse(jsonString);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Prüft, ob ein Rezept persistiert werden darf (255-Zeichen-Grenze, Req 2.1, 2.4).
 *
 * @param {Braurezept} recipe Das zu prüfende Rezept.
 * @returns {boolean} `true`, wenn `JSON.stringify(recipe).length <= 255`.
 */
export function canPersistRecipe(recipe) {
  return JSON.stringify(recipe).length <= MAX_RECIPE_JSON_LENGTH;
}

// ---------------------------------------------------------------------------
// Rezept-Listenoperationen (Task 3.1)
// ---------------------------------------------------------------------------

/**
 * Hängt eine Raststufe ans Ende des Rezepts an (Req 2.1, 2.6).
 *
 * Erzeugt eine neue Liste; die Eingabeliste wird nicht mutiert. Die
 * Reihenfolge bleibt erhalten.
 *
 * @param {Braurezept} recipe Bestehendes Rezept.
 * @param {Raststufe} step    Anzuhängende Raststufe.
 * @returns {Braurezept} Neues Rezept mit angehängter Stufe.
 */
export function addStep(recipe, step) {
  return [...recipe, step];
}

/**
 * Ersetzt die Raststufe an Position `index` (Req 3.2, 3.4).
 *
 * Bei ungültigen Werten bleibt die Liste unverändert. Alle anderen Elemente
 * und die Listenlänge bleiben erhalten.
 *
 * @param {Braurezept} recipe Bestehendes Rezept.
 * @param {number} index      Zu ersetzender Index.
 * @param {Raststufe} step     Neue Werte der Raststufe.
 * @returns {Braurezept} Neues Rezept mit ersetzter (oder unveränderter) Stufe.
 */
export function editStep(recipe, index, step) {
  if (!Number.isInteger(index) || index < 0 || index >= recipe.length) {
    return recipe;
  }
  if (!step || !isValidRaststufe(step.name, step.temperature, step.duration)) {
    return recipe;
  }
  return recipe.map((existing, i) => (i === index ? step : existing));
}

/**
 * Entfernt die Raststufe an Position `index` (Req 3.3).
 *
 * Verringert die Länge um 1 und erhält die relative Reihenfolge der
 * verbleibenden Elemente.
 *
 * @param {Braurezept} recipe Bestehendes Rezept.
 * @param {number} index      Zu entfernender Index.
 * @returns {Braurezept} Neues Rezept ohne die entfernte Stufe.
 */
export function removeStep(recipe, index) {
  if (!Number.isInteger(index) || index < 0 || index >= recipe.length) {
    return recipe;
  }
  return recipe.filter((_, i) => i !== index);
}

/**
 * Liefert ein leeres Rezept (Req 3.6).
 *
 * @returns {Braurezept} Ein leeres Rezept `[]`.
 */
export function clearRecipe() {
  return [];
}

/**
 * Vertauscht die Raststufe an `index` mit ihrem Nachbarn in Richtung
 * `direction` und liefert eine neue, umsortierte Liste (Req 3.7).
 *
 * Die Eingabeliste wird nicht mutiert. An den Listengrenzen (erste Rast nach
 * oben, letzte Rast nach unten) sowie bei ungültigem `index` oder ungültiger
 * `direction` wird die Liste unverändert zurückgegeben. Die Operation ist eine
 * Transposition zweier benachbarter Elemente und damit stets eine Permutation
 * der Eingabe — es gehen keine Raststufen verloren oder hinzu.
 *
 * @param {Braurezept} recipe   Bestehendes Rezept.
 * @param {number} index        Index der zu verschiebenden Rast.
 * @param {-1|1} direction      Richtung: `-1` = nach oben, `+1` = nach unten.
 * @returns {Braurezept} Neues (umsortiertes) Rezept oder unveränderte Liste.
 */
export function reorderStep(recipe, index, direction) {
  if (!Array.isArray(recipe)) {
    return recipe;
  }
  if (direction !== -1 && direction !== 1) {
    return recipe;
  }
  if (!Number.isInteger(index) || index < 0 || index >= recipe.length) {
    return recipe;
  }
  const target = index + direction;
  if (target < 0 || target >= recipe.length) {
    return recipe;
  }
  const result = recipe.slice();
  const tmp = result[index];
  result[index] = result[target];
  result[target] = tmp;
  return result;
}

// ---------------------------------------------------------------------------
// Regelungs- und Sicherheitslogik (Task 5.1)
// ---------------------------------------------------------------------------

/**
 * Entscheidet die Heizungsschaltung in der Haltephase per Hysterese (Req 4.1, 4.3).
 *
 * - `ist < soll - HYSTERESIS_BAND` ⇒ {@link HeaterDecision.ON}
 * - `ist >= soll`                 ⇒ {@link HeaterDecision.OFF}
 * - sonst (im Band)               ⇒ vorheriger Zustand (unverändert)
 *
 * @param {number} ist       Ist-Temperatur in °C.
 * @param {number} soll      Solltemperatur in °C.
 * @param {boolean} prevState Vorheriger Heizzustand (`true` = AN).
 * @param {number} [hyst=HYSTERESIS_BAND] Hystereseband in °C; bei fehlendem oder
 *   ungültigem Wert wird der Default {@link HYSTERESIS_BAND} (1,0 °C) verwendet.
 * @returns {boolean} Neuer Heizzustand (`true` = AN).
 */
export function hysteresisDecision(ist, soll, prevState, hyst = HYSTERESIS_BAND) {
  const band = resolveHysteresis(hyst);
  if (ist < soll - band) {
    return true;
  }
  if (ist >= soll) {
    return false;
  }
  return prevState;
}

/**
 * Berechnet den Stufenindex-/Statusübergang (Req 4.4, 4.5, 8.6, 8.7).
 *
 * Identisch für manuellen und automatischen Wechsel:
 * - `index + 1 < length` ⇒ neuer Index `index + 1`, Status bleibt `running`.
 * - `index + 1 >= length` (letzte Rast) ⇒ Status `done`, keine weitere Stufe.
 *
 * @param {number} index  Aktueller Stufenindex.
 * @param {number} length Anzahl der Raststufen im Rezept.
 * @returns {StepTransition} Der resultierende Übergang.
 */
export function nextStepTransition(index, length) {
  if (index + 1 < length) {
    return { index: index + 1, status: Status.RUNNING, done: false };
  }
  return { index, status: Status.DONE, done: true };
}

/**
 * Sicherheitsinvariante der Heizentscheidung (Req 9.1, 9.2, 10.1).
 *
 * Liefert IMMER „Heizung AUS", wenn die Ist-Temperatur den
 * Sicherheitsschwellwert (`soll + offset`) überschreitet ODER kein gültiger
 * Sensorwert vorliegt. Bei erkannter Übertemperatur signalisiert das Ergebnis
 * zusätzlich den Statuswechsel nach `paused`. Andernfalls wird die reguläre
 * Hysterese-Entscheidung getroffen.
 *
 * Die genaue Signatur (Parameterobjekt vs. Einzelparameter) wird in Task 5.1
 * festgelegt; der Platzhalter dokumentiert die erwarteten Eingaben.
 *
 * @param {Object} params
 * @param {number} params.ist          Ist-Temperatur in °C.
 * @param {number} params.soll         Solltemperatur in °C.
 * @param {number} params.offset       Sicherheits-Offset in °C.
 * @param {boolean} params.sensorValid Ob ein gültiger Sensorwert vorliegt.
 * @param {boolean} params.prevState   Vorheriger Heizzustand.
 * @param {number} [params.hyst]       Konfiguriertes Hystereseband in °C (Default 1,0).
 * @returns {{heater: boolean, status?: string}} Heizentscheidung und ggf. Statuswechsel.
 */
export function heatingDecision(params) {
  const { ist, soll, offset, sensorValid, prevState, hyst } = params;

  // Ohne gültigen Sensorwert: Heizung IMMER AUS (Req 10.1).
  if (!sensorValid) {
    return { heater: false };
  }

  // Übertemperatur: Heizung AUS und Statuswechsel nach 'paused' (Req 9.1, 9.2).
  if (ist > computeSafetyThreshold(soll, offset)) {
    return { heater: false, status: Status.PAUSED };
  }

  // Regulärer Betrieb: Hysterese-Entscheidung mit konfiguriertem Band (Req 4.1, 4.3, 4.9).
  return { heater: hysteresisDecision(ist, soll, prevState, hyst) };
}

/**
 * Berechnet den Sicherheitsschwellwert für die Übertemperatur (Req 9.3).
 *
 * @param {number} soll   Solltemperatur in °C.
 * @param {number} offset Sicherheits-Offset in °C.
 * @returns {number} `soll + offset`.
 */
export function computeSafetyThreshold(soll, offset) {
  return soll + offset;
}

/**
 * Prüft, ob ein Eingabewert ein gültiges Hystereseband ist (Req 4.9).
 *
 * Gültig genau dann, wenn `value` eine endliche Zahl mit `0 < value <= 5` ist.
 *
 * @param {number} value Zu prüfendes Hystereseband in °C.
 * @returns {boolean} `true`, wenn der Wert ein gültiges Hystereseband ist.
 */
export function isValidHysteresis(value) {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value > MIN_HYSTERESIS &&
    value <= MAX_HYSTERESIS
  );
}

/**
 * Leitet das anzuwendende Hystereseband aus einem (möglicherweise ungültigen)
 * Rohwert ab (Req 4.9, 4.10). Gültige Werte (`0 < v <= 5`) werden als Zahl
 * übernommen; fehlende, nicht-numerische oder außerhalb des Bereichs liegende
 * Werte fallen auf den Default {@link HYSTERESIS_BAND} (1,0 °C) zurück.
 *
 * @param {string|number|null|undefined} rawValue Rohwert (z. B. Helferzustand).
 * @returns {number} Gültiges Hystereseband in °C (Default 1,0).
 */
export function resolveHysteresis(rawValue) {
  const num = typeof rawValue === 'string' ? Number(rawValue) : rawValue;
  return isValidHysteresis(num) ? num : HYSTERESIS_BAND;
}

// ---------------------------------------------------------------------------
// Zustands- und Eingabeprädikate (Task 6.1)
// ---------------------------------------------------------------------------

/**
 * Prüft, ob ein Sensor-Rohwert gültig ist (Req 1.3).
 *
 * `true` genau dann, wenn der Wert in eine endliche Zahl geparst werden kann;
 * `false` für `unknown`, `unavailable`, leere oder nicht-numerische Werte.
 *
 * @param {string|number|null|undefined} rawValue Sensor-Rohwert.
 * @returns {boolean} `true`, wenn der Wert eine endliche Zahl ist.
 */
export function isSensorValid(rawValue) {
  if (rawValue === null || rawValue === undefined) {
    return false;
  }
  if (typeof rawValue === 'number') {
    return Number.isFinite(rawValue);
  }
  if (typeof rawValue === 'string') {
    const trimmed = rawValue.trim();
    if (trimmed === '') {
      return false;
    }
    const lower = trimmed.toLowerCase();
    if (lower === 'unknown' || lower === 'unavailable') {
      return false;
    }
    return Number.isFinite(Number(trimmed));
  }
  return false;
}

/**
 * Prüft, ob der Brauprozess gestartet werden darf (Req 8.1, 8.2).
 *
 * `true` genau dann, wenn das Rezept mindestens eine Raststufe enthält UND
 * ein gültiger Sensorwert vorliegt.
 *
 * @param {Braurezept} recipe    Aktuelles Rezept.
 * @param {boolean} sensorValid  Ob ein gültiger Sensorwert vorliegt.
 * @returns {boolean} `true`, wenn die Start-Aktion verfügbar ist.
 */
export function canStart(recipe, sensorValid) {
  return Array.isArray(recipe) && recipe.length >= 1 && sensorValid === true;
}

/**
 * Render-Stabilitätsentscheidung für `shouldUpdate` der Card (Req 7.1, 7.2).
 *
 * Ist das Settings-Panel offen (`showSettings`) ODER wird eine Rast editiert
 * (`editIndex >= 0`), wird nur dann neu gerendert, wenn sich `_showSettings`,
 * `_editIndex` oder `_localRecipe` geändert haben — reine `hass`-Änderungen
 * lösen kein Re-Render aus. Andernfalls wird immer neu gerendert.
 *
 * @param {boolean} showSettings        Ob das Settings-Panel offen ist.
 * @param {number} editIndex            Index der editierten Rast (-1 = keine).
 * @param {Set<string>|Map<string, *>} changedProps Geänderte Properties (LitElement).
 * @returns {boolean} `true`, wenn ein Re-Render erfolgen soll.
 */
export function shouldUpdateDecision(showSettings, editIndex, changedProps) {
  if (showSettings || editIndex >= 0) {
    return (
      changedProps.has('_showSettings') ||
      changedProps.has('_editIndex') ||
      changedProps.has('_localRecipe')
    );
  }
  return true;
}
