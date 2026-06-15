/**
 * brausteuerung-card.js
 *
 * Custom Lovelace Card der Brausteuerung (LitElement-basiert).
 *
 * Diese Card ist ein vollständiger Neuaufbau gemäß design.md ("Components and
 * Interfaces", Abschnitt 1). Sie enthält KEINE eigene Parse-/Validierungs-/
 * Hysterese-/Sicherheitslogik mehr, sondern nutzt ausschließlich die reinen
 * Funktionen aus `brausteuerung-logic.js`. Dadurch ist die gesamte
 * sicherheitsrelevante Logik property-getestet und entkoppelt von HA/DOM.
 *
 * Aufbaustand (Task 8.1 — Grundgerüst und Logikanbindung):
 *   - Reaktive Properties, lesende Getter, Logikanbindung
 *   - shouldUpdate (Render-Stabilität, Req 7.1/7.2)
 *   - Persistenzschutz mit 255-Zeichen-Prüfung (_persistRecipe)
 *   - Card-Registrierung, getStubConfig/getConfigElement
 *   - render(): nur Platzhalter — die vollständige UI folgt in:
 *       * Task 8.2: Rezept- und Entitäts-UI (Liste, Formular, Settings-Panel)
 *       * Task 8.3: Anzeige Temperatur/Status/Schwellwert
 *       * Task 8.4: Prozesssteuerung (_start/_stop/_nextStep) und Persistenzschutz
 *
 * LitElement wird NICHT von einem externen CDN geladen, sondern aus dem von
 * Home Assistant bereits registrierten `ha-panel-lovelace`-Element abgeleitet.
 *
 * @module brausteuerung-card
 */

import {
  parseRecipe,
  serializeRecipe,
  canPersistRecipe,
  isValidRaststufe,
  resolveStepName,
  isSensorValid,
  canStart,
  computeSafetyThreshold,
  shouldUpdateDecision,
  Status,
} from "./brausteuerung-logic.js";

// LitElement-Basisklasse aus Home Assistant beziehen (kein externes CDN).
const LitElement = Object.getPrototypeOf(customElements.get("ha-panel-lovelace"));
const html = LitElement.prototype.html;
const css = LitElement.prototype.css;

// ---------------------------------------------------------------------------
// Helfer-Entity-IDs (Single Source of Truth des Zustands, siehe design.md)
// ---------------------------------------------------------------------------
const ENTITY = Object.freeze({
  RECIPE_JSON: "input_text.brau_rezept_json",
  SENSOR_ENTITY: "input_text.brau_sensor_entity",
  HEATER_ENTITY: "input_text.brau_heater_entity",
  STATUS: "input_select.brau_status",
  CURRENT_STEP: "input_number.brau_aktuelle_stufe",
  SETPOINT: "input_number.brau_solltemperatur",
  SAFETY_OFFSET: "input_number.brau_sicherheits_offset",
  TIMER: "timer.brau_raststufe",
  // Automationen, die von der Card per `automation.trigger` ausgelöst werden.
  AUTOMATION_RASTSTUFE: "automation.brausteuerung_raststufe",
  AUTOMATION_MANUELLER_WECHSEL: "automation.brausteuerung_manueller_wechsel",
});

// Wartezeit zwischen Wiederholversuchen des Persistenzschutzes (Req 5.3).
const PERSIST_RETRY_DELAY_MS = 2000;

class BrausteuerungCard extends LitElement {
  static get properties() {
    return {
      hass: { type: Object },
      _config: { type: Object },
      _showSettings: { type: Boolean },
      _editIndex: { type: Number },
      _localRecipe: { type: Array },
      // Lokale Felder für den Persistenzschutz der Entitätsauswahl (Req 5.3).
      _sensorEntity: { type: String },
      _heaterEntity: { type: String },
      _errorMessage: { type: String },
    };
  }

  constructor() {
    super();
    this._config = {};
    this._showSettings = false;
    this._editIndex = -1;
    this._localRecipe = [];
    this._sensorEntity = "";
    this._heaterEntity = "";
    this._errorMessage = "";
  }

  setConfig(config) {
    this._config = config || {};
    this._sensorEntity = this._config.sensor_entity || "";
    this._heaterEntity = this._config.heater_entity || "";
  }

  getCardSize() {
    return 5;
  }

  static getConfigElement() {
    return document.createElement("brausteuerung-card-editor");
  }

  static getStubConfig() {
    return { sensor_entity: "", heater_entity: "" };
  }

  // =========================================================================
  // Lesende Getter (keine Seiteneffekte) — siehe design.md "Lesende Getter"
  // =========================================================================

  /**
   * Parst das Rezept-JSON aus dem Helfer; bei Parse-Fehler `[]` (Error Handling).
   * @returns {Array} Aktuelles Braurezept.
   */
  get _recipe() {
    return parseRecipe(
      this.hass?.states[ENTITY.RECIPE_JSON]?.state ?? "[]"
    );
  }

  /** @returns {string} Aktueller Betriebsstatus (idle/running/paused/done). */
  get _status() {
    return this.hass?.states[ENTITY.STATUS]?.state ?? "idle";
  }

  /** @returns {number} Index der aktuell aktiven Raststufe. */
  get _currentStep() {
    const raw = this.hass?.states[ENTITY.CURRENT_STEP]?.state;
    const parsed = parseInt(raw, 10);
    return Number.isNaN(parsed) ? 0 : parsed;
  }

  /** @returns {string} Zustand des Raststufen-Timers. */
  get _timerState() {
    return this.hass?.states[ENTITY.TIMER]?.state ?? "idle";
  }

  /**
   * Konfigurierte Sensor-Entität: bevorzugt persistierten Helferwert, fällt
   * sonst auf den lokalen/Config-Wert zurück.
   * @returns {string} Entity-ID des Sensors.
   */
  get _configuredSensor() {
    const e = this.hass?.states[ENTITY.SENSOR_ENTITY];
    if (e && e.state && e.state !== "unknown" && e.state !== "") {
      return e.state;
    }
    return this._sensorEntity || this._config.sensor_entity || "";
  }

  /**
   * Konfigurierter Heizungs-Aktor: bevorzugt persistierten Helferwert, fällt
   * sonst auf den lokalen/Config-Wert zurück.
   * @returns {string} Entity-ID des Schalters.
   */
  get _configuredHeater() {
    const e = this.hass?.states[ENTITY.HEATER_ENTITY];
    if (e && e.state && e.state !== "unknown" && e.state !== "") {
      return e.state;
    }
    return this._heaterEntity || this._config.heater_entity || "";
  }

  /**
   * State-Objekt der konfigurierten Sensor-Entität (oder `null`).
   * @returns {Object|null} HA-State-Objekt des Sensors.
   */
  get _currentTemp() {
    const sensor = this._configuredSensor;
    if (!this.hass || !sensor) return null;
    return this.hass.states[sensor] ?? null;
  }

  /**
   * Prüft die Gültigkeit des aktuellen Sensorwerts (Req 1.3).
   * @returns {boolean} `true`, wenn der Sensorwert eine endliche Zahl ist.
   */
  get _isSensorValid() {
    return isSensorValid(this._currentTemp?.state);
  }

  /**
   * Sicherheitsschwellwert `soll + offset` zur Anzeige (Req 9.3).
   * @returns {number} Berechneter Schwellwert.
   */
  get _safetyThreshold() {
    const soll = Number(this.hass?.states[ENTITY.SETPOINT]?.state);
    const offset = Number(this.hass?.states[ENTITY.SAFETY_OFFSET]?.state);
    return computeSafetyThreshold(soll, offset);
  }

  // =========================================================================
  // Render-Stabilität (Req 7.1, 7.2) — Logik liegt im reinen Logikmodul
  // =========================================================================
  shouldUpdate(changedProps) {
    return shouldUpdateDecision(this._showSettings, this._editIndex, changedProps);
  }

  // =========================================================================
  // Persistenz mit 255-Zeichen-Schutz (Req 2.4) — vor dem Schreiben prüfen
  // =========================================================================
  /**
   * Persistiert ein Rezept in den HA-Helfer. Vor dem Schreiben wird die
   * 255-Zeichen-Grenze geprüft (canPersistRecipe). Bei Überschreitung wird
   * nicht geschrieben, eine Fehlermeldung gesetzt und ein Re-Render angefordert.
   *
   * @param {Array} recipe Das zu persistierende Rezept.
   * @returns {boolean} `true`, wenn persistiert wurde; sonst `false`.
   */
  _persistRecipe(recipe) {
    if (!canPersistRecipe(recipe)) {
      this._setError(
        "Rezept zu groß (max. 255 Zeichen). Bitte kürzere Namen oder weniger Rasten verwenden."
      );
      return false;
    }
    this._errorMessage = "";
    this.hass.callService("input_text", "set_value", {
      entity_id: ENTITY.RECIPE_JSON,
      value: serializeRecipe(recipe),
    });
    return true;
  }

  /**
   * Setzt eine Fehlermeldung und erzwingt ein Re-Render — auch während eine
   * Rast editiert wird oder das Settings-Panel offen ist. `shouldUpdate`
   * blockiert in diesen Modi reine `hass`-/`_errorMessage`-Änderungen, lässt
   * aber Änderungen an `_localRecipe` durch (siehe shouldUpdateDecision).
   * Durch das Erneuern der `_localRecipe`-Referenz wird der Fehlerhinweis daher
   * zuverlässig sichtbar.
   *
   * @param {string} message Anzuzeigende Fehlermeldung.
   */
  _setError(message) {
    this._errorMessage = message;
    this._localRecipe = this._localRecipe.slice();
  }

  // =========================================================================
  // Aktionen — Rezept-/Entitäts-UI (Task 8.2)
  // =========================================================================
  // Validierung über isValidRaststufe(name, temp, dur); Anzeigename über
  // resolveStepName(name, position). Die Prozesssteuerung (_start/_stop/
  // _nextStep) und der Persistenzschutz der Entitätsauswahl sind weiter unten
  // implementiert (Task 8.4).

  /** @returns {HTMLElement|null} Element aus dem Shadow-DOM (oder `null`). */
  _q(selector) {
    return this.renderRoot?.querySelector(selector) ?? null;
  }

  /**
   * Liest die Werte aus dem Eingabeformular für neue Rasten.
   * @returns {{name: string, temp: string, dur: string}} Rohwerte der Felder.
   */
  _readNewInputs() {
    return {
      name: this._q("#new-name")?.value ?? "",
      temp: this._q("#new-temp")?.value ?? "",
      dur: this._q("#new-dur")?.value ?? "",
    };
  }

  /**
   * Liest die Werte aus der Inline-Bearbeitungszeile.
   * @returns {{name: string, temp: string, dur: string}} Rohwerte der Felder.
   */
  _readEditInputs() {
    return {
      name: this._q("#edit-name")?.value ?? "",
      temp: this._q("#edit-temp")?.value ?? "",
      dur: this._q("#edit-dur")?.value ?? "",
    };
  }

  /**
   * Fügt eine neue Raststufe ans Ende des Rezepts an (Req 2.1, 2.4, 2.5).
   *
   * Ungültige Eingaben (Temperatur außerhalb 0–100 oder Haltezeit keine
   * Ganzzahl > 0) werden nicht übernommen; stattdessen wird ein Fehlerhinweis
   * angezeigt und die Felder bleiben erhalten. Bei Erfolg wird ein leerer Name
   * über resolveStepName auf den Standardnamen aufgelöst und die Felder
   * geleert.
   */
  _addStep() {
    if (this._status === Status.RUNNING) {
      return;
    }
    const { name, temp, dur } = this._readNewInputs();
    const temperature = Number(temp);
    const duration = Number(dur);
    if (!isValidRaststufe(name, temperature, duration)) {
      this._setError(
        "Ungültige Eingabe: Solltemperatur muss 0–100 °C sein, Haltezeit eine ganze Zahl > 0 Minuten."
      );
      return;
    }
    const resolvedName = resolveStepName(name, this._recipe.length + 1);
    const step = { name: resolvedName, temperature, duration };
    const newRecipe = [...this._recipe, step];
    if (this._persistRecipe(newRecipe)) {
      this._clearNewInputs();
    }
  }

  /** Leert das Eingabeformular für neue Rasten. */
  _clearNewInputs() {
    const nameEl = this._q("#new-name");
    const tempEl = this._q("#new-temp");
    const durEl = this._q("#new-dur");
    if (nameEl) nameEl.value = "";
    if (tempEl) tempEl.value = "";
    if (durEl) durEl.value = "";
  }

  /**
   * Beginnt die Bearbeitung der Rast an Position `i` (Req 3.1).
   * @param {number} i Index der zu bearbeitenden Rast.
   */
  _beginEdit(i) {
    if (this._status === Status.RUNNING) {
      return;
    }
    this._errorMessage = "";
    this._editIndex = i;
  }

  /** Bricht die laufende Bearbeitung ab und verwirft die Änderungen (Req 3.4). */
  _cancelEdit() {
    this._editIndex = -1;
    this._errorMessage = "";
  }

  /**
   * Übernimmt die bearbeitete Rast `i`, wenn die Eingabe gültig ist
   * (Req 3.2, 3.4). Bei ungültiger Eingabe bleibt die Bearbeitung offen, die
   * bisherigen Werte werden beibehalten und ein Fehlerhinweis angezeigt.
   *
   * @param {number} i Index der bearbeiteten Rast.
   */
  _saveEdit(i) {
    const { name, temp, dur } = this._readEditInputs();
    const temperature = Number(temp);
    const duration = Number(dur);
    if (!isValidRaststufe(name, temperature, duration)) {
      this._setError(
        "Ungültige Eingabe: Änderung verworfen. Solltemperatur 0–100 °C, Haltezeit ganze Zahl > 0."
      );
      return;
    }
    const resolvedName = resolveStepName(name, i + 1);
    const editedStep = { name: resolvedName, temperature, duration };
    const newRecipe = this._recipe.map((existing, idx) =>
      idx === i ? editedStep : existing
    );
    if (this._persistRecipe(newRecipe)) {
      this._editIndex = -1;
    }
  }

  /**
   * Entfernt die Rast an Position `i` (Req 3.3). Die Reihenfolge der
   * verbleibenden Rasten bleibt erhalten.
   * @param {number} i Index der zu entfernenden Rast.
   */
  _remove(i) {
    if (this._status === Status.RUNNING) {
      return;
    }
    const newRecipe = this._recipe.filter((_, idx) => idx !== i);
    this._persistRecipe(newRecipe);
  }

  /** Entfernt alle Rasten aus dem Rezept (Req 3.6). */
  _clear() {
    if (this._status === Status.RUNNING) {
      return;
    }
    this._persistRecipe([]);
  }

  /** Schaltet die Sichtbarkeit des Settings-Panels um (Req 5.1, 6.1). */
  _toggleSettings() {
    this._showSettings = !this._showSettings;
    this._errorMessage = "";
  }

  // =========================================================================
  // Prozesssteuerung (Task 8.4) — Start/Stop/Nächste Rast (Req 8.3–8.7)
  // =========================================================================

  /**
   * Startet den Brauprozess (Req 8.3): setzt die aktuelle Stufe auf 0, den
   * Status auf `running` und triggert die Regel-Automation
   * `brausteuerung_raststufe`. Wird nur ausgeführt, wenn `canStart` erfüllt
   * ist (Rezept ≥ 1 Rast UND gültiger Sensorwert — Req 8.1, 8.2).
   */
  _start() {
    if (!this.hass) return;
    if (!canStart(this._recipe, this._isSensorValid)) {
      return;
    }
    this._errorMessage = "";
    this.hass.callService("input_number", "set_value", {
      entity_id: ENTITY.CURRENT_STEP,
      value: 0,
    });
    this.hass.callService("input_select", "select_option", {
      entity_id: ENTITY.STATUS,
      option: Status.RUNNING,
    });
    this.hass.callService("automation", "trigger", {
      entity_id: ENTITY.AUTOMATION_RASTSTUFE,
    });
  }

  /**
   * Stoppt den Brauprozess (Req 8.4): Status auf `idle`, Heizungs-Aktor aus
   * (sofern konfiguriert) und der laufende Raststufen-Timer wird abgebrochen.
   */
  _stop() {
    if (!this.hass) return;
    this._errorMessage = "";
    this.hass.callService("input_select", "select_option", {
      entity_id: ENTITY.STATUS,
      option: Status.IDLE,
    });
    const heater = this._configuredHeater;
    if (heater) {
      this.hass.callService("switch", "turn_off", {
        entity_id: heater,
      });
    }
    this.hass.callService("timer", "cancel", {
      entity_id: ENTITY.TIMER,
    });
  }

  /**
   * Löst den manuellen Wechsel zur nächsten Raststufe aus (Req 8.5–8.7),
   * indem die Automation `brausteuerung_manueller_wechsel` getriggert wird.
   * Die Automation bricht den Timer ab und wechselt bzw. schließt ab.
   */
  _nextStep() {
    if (!this.hass) return;
    this.hass.callService("automation", "trigger", {
      entity_id: ENTITY.AUTOMATION_MANUELLER_WECHSEL,
    });
  }

  // =========================================================================
  // Persistenzschutz der Entitätsauswahl (Req 5.3) — Task 8.4
  // =========================================================================

  /**
   * Speichert die in den Settings-Feldern gewählten Entitäten (Req 5.2, 6.4).
   *
   * Die gewählten Werte werden sofort lokal gehalten (`_sensorEntity`/
   * `_heaterEntity`), sodass die Oberfläche die Auswahl unabhängig vom
   * Persistenzergebnis weiter anzeigt (Req 5.3, 5.4). Anschließend werden
   * beide Werte über `_persistEntitySetting` mit Wiederholversuch in die
   * HA-Helfer geschrieben.
   */
  _saveSettings() {
    const sensor = this._q("#settings-sensor")?.value ?? "";
    const heater = this._q("#settings-heater")?.value ?? "";
    // Lokal halten als Single Source of Truth, bis die Persistenz gelingt.
    this._sensorEntity = sensor;
    this._heaterEntity = heater;
    this._errorMessage = "";
    this._showSettings = false;
    // Persistieren mit Retry-Schutz (Req 5.3); Fehler hält den lokalen Wert.
    this._persistEntitySetting(ENTITY.SENSOR_ENTITY, sensor);
    this._persistEntitySetting(ENTITY.HEATER_ENTITY, heater);
  }

  /**
   * Persistiert genau einen Entitäts-Helferwert mit Wiederholschutz (Req 5.3).
   *
   * Schlägt `callService` fehl, wird eine Fehlermeldung gesetzt, der lokal
   * gehaltene Wert bleibt unverändert (die Getter zeigen ihn weiter an) und
   * nach einer kurzen Verzögerung erfolgt ein erneuter Versuch — so lange, bis
   * das Speichern gelingt. Bei Erfolg wird die Fehlermeldung gelöscht.
   *
   * @param {string} entityId Ziel-Helfer (`input_text.*`).
   * @param {string} value    Zu speichernder Wert (Entity-ID).
   * @returns {Promise<void>}
   */
  async _persistEntitySetting(entityId, value) {
    if (!this.hass) return;
    // Wiederholt, bis `callService` erfolgreich auflöst (Req 5.3).
    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        await this.hass.callService("input_text", "set_value", {
          entity_id: entityId,
          value,
        });
        // Erfolg: Fehlerhinweis entfernen und beenden.
        if (this._errorMessage) {
          this._errorMessage = "";
          this._localRecipe = this._localRecipe.slice();
        }
        return;
      } catch (err) {
        // Fehlschlag: lokalen Wert behalten, Hinweis anzeigen, erneut versuchen.
        this._setError(
          "Speichern der Entitätsauswahl fehlgeschlagen. Auswahl bleibt erhalten, neuer Versuch läuft…"
        );
        await new Promise((resolve) =>
          setTimeout(resolve, PERSIST_RETRY_DELAY_MS)
        );
      }
    }
  }

  static get styles() {
    return css`
      :host {
        display: block;
      }
      ha-card {
        padding: 16px;
      }
      .header {
        display: flex;
        align-items: center;
        justify-content: space-between;
      }
      .header h2 {
        margin: 0;
      }
      .placeholder {
        color: var(--secondary-text-color);
        font-size: 0.9em;
        padding: 8px 0;
      }
      .error {
        margin-top: 8px;
        padding: 8px 12px;
        border-radius: 4px;
        background: var(--error-color, #e74c3c);
        color: white;
        font-size: 0.9em;
      }

      /* Status-/Temperaturblock (Task 8.3) */
      .status-block {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        margin: 8px 0 4px;
      }
      .status-temp {
        display: flex;
        flex-direction: column;
        min-width: 0;
      }
      .temp-value {
        font-size: 2em;
        font-weight: 600;
        line-height: 1.1;
        color: var(--primary-text-color, #000);
      }
      .temp-hint {
        font-size: 1.05em;
        font-weight: 500;
        color: var(--warning-color, #ff9800);
      }
      .temp-sensor-id {
        font-size: 0.8em;
        color: var(--secondary-text-color);
      }
      .status-badge {
        flex-shrink: 0;
        padding: 2px 10px;
        border-radius: 12px;
        font-size: 0.8em;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.03em;
        background: var(--secondary-background-color, #f0f0f0);
        color: var(--secondary-text-color);
      }
      .status-badge.status-running {
        background: var(--primary-color, #03a9f4);
        color: var(--text-primary-color, #fff);
      }
      .status-badge.status-paused {
        background: var(--warning-color, #ff9800);
        color: #fff;
      }
      .status-badge.status-done {
        background: var(--success-color, #4caf50);
        color: #fff;
      }
      .status-threshold {
        font-size: 0.85em;
        color: var(--secondary-text-color);
        margin-bottom: 8px;
      }

      /* Buttons */
      .btn {
        padding: 6px 12px;
        border: 1px solid var(--divider-color, #ccc);
        border-radius: 4px;
        background: var(--card-background-color, #fff);
        color: var(--primary-text-color, #000);
        cursor: pointer;
        font-size: 0.9em;
      }
      .btn:hover {
        background: var(--secondary-background-color, #f0f0f0);
      }
      .btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
      .btn-primary {
        background: var(--primary-color, #03a9f4);
        color: var(--text-primary-color, #fff);
        border-color: var(--primary-color, #03a9f4);
      }
      .btn-danger {
        background: var(--error-color, #e74c3c);
        color: #fff;
        border-color: var(--error-color, #e74c3c);
      }
      .icon-btn {
        border: none;
        background: none;
        cursor: pointer;
        font-size: 1.1em;
        padding: 2px 6px;
        color: var(--primary-text-color, #000);
      }
      .icon-btn:disabled {
        opacity: 0.4;
        cursor: not-allowed;
      }

      /* Recipe list */
      .steps {
        list-style: none;
        margin: 8px 0;
        padding: 0;
      }
      .step {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 8px;
        border-radius: 4px;
        border: 1px solid var(--divider-color, #e0e0e0);
        margin-bottom: 6px;
      }
      .step .marker {
        width: 1.2em;
        text-align: center;
        font-weight: bold;
      }
      .step-info {
        display: flex;
        flex-direction: column;
        flex: 1;
        min-width: 0;
      }
      .step-name {
        font-weight: 500;
      }
      .step-detail {
        font-size: 0.85em;
        color: var(--secondary-text-color);
      }
      .step-actions {
        display: flex;
        gap: 2px;
      }
      /* Aktiv / abgeschlossen / verbleibend (Req 4.6) */
      .step.active {
        border-color: var(--primary-color, #03a9f4);
        background: var(--primary-color, #03a9f4);
        color: var(--text-primary-color, #fff);
      }
      .step.active .step-detail {
        color: var(--text-primary-color, #fff);
      }
      .step.done {
        opacity: 0.6;
      }
      .step.done .step-name {
        text-decoration: line-through;
      }
      .step.remaining {
        opacity: 0.95;
      }
      .step.editing {
        flex-direction: column;
        align-items: stretch;
      }
      .edit-row,
      .add-form {
        display: flex;
        gap: 6px;
        align-items: center;
      }
      .add-form {
        margin-top: 8px;
      }
      .edit-actions,
      .settings-actions,
      .recipe-actions {
        display: flex;
        gap: 6px;
        margin-top: 8px;
      }
      .recipe-actions {
        justify-content: flex-end;
      }
      .controls {
        display: flex;
        gap: 8px;
        margin-top: 12px;
      }
      .controls .btn {
        flex: 1;
        font-size: 1em;
        padding: 10px 12px;
      }
      input[type="text"],
      input[type="number"] {
        padding: 6px 8px;
        border: 1px solid var(--divider-color, #ccc);
        border-radius: 4px;
        box-sizing: border-box;
        background: var(--card-background-color, #fff);
        color: var(--primary-text-color, #000);
      }
      .add-form input[type="text"],
      .edit-row input[type="text"] {
        flex: 2;
        min-width: 0;
      }
      .add-form input[type="number"],
      .edit-row input[type="number"] {
        flex: 1;
        min-width: 0;
        width: 4em;
      }

      /* Settings panel */
      .settings h3 {
        margin: 8px 0;
      }
      .field-label {
        display: block;
        font-size: 0.85em;
        color: var(--secondary-text-color);
        margin-top: 8px;
      }
      .field {
        width: 100%;
        margin-top: 4px;
      }
    `;
  }

  render() {
    const recipe = this._recipe;
    const running = this._status === Status.RUNNING;
    const active = this._currentStep;
    const showStatusMarkers =
      this._status === Status.RUNNING || this._status === Status.PAUSED;

    return html`
      <ha-card>
        <div class="header">
          <h2>🍺 Brausteuerung</h2>
          <button
            class="icon-btn"
            title="Einstellungen"
            @click=${() => this._toggleSettings()}
          >
            ⚙️
          </button>
        </div>

        ${this._renderStatusBlock()}

        ${this._showSettings ? this._renderSettings() : this._renderRecipe(recipe, running, active, showStatusMarkers)}

        ${this._showSettings ? "" : this._renderControls(recipe, running)}

        ${this._errorMessage
          ? html`<div class="error">${this._errorMessage}</div>`
          : ""}
      </ha-card>
    `;
  }

  /**
   * Render des Status-/Temperaturblocks (Task 8.3): Ist-Temperatur der
   * konfigurierten Sensor-Entität (Req 1.1), Hinweise bei fehlendem Sensor
   * (Req 1.4) bzw. ungültigem Sensorwert (Req 1.3), ein kleiner Status-Badge
   * (idle/running/paused/done — Prozessvisibilität, Req 4.6) sowie der
   * Sicherheitsschwellwert `soll + offset` (Req 9.3).
   *
   * Logik der Temperaturanzeige:
   *   - kein Sensor konfiguriert       → „⚠️ Kein Sensor gesetzt" (Req 1.4)
   *   - Sensor konfiguriert, ungültig  → „⚠️ Kein gültiger Sensorwert" (Req 1.3)
   *   - gültiger Sensorwert            → „{state} {unit}" (Req 1.1)
   *
   * @returns {import("lit").TemplateResult}
   */
  _renderStatusBlock() {
    const status = this._status;
    const threshold = this._safetyThreshold;

    let tempContent;
    if (!this._configuredSensor) {
      // Req 1.4: keine Sensor-Entität ausgewählt.
      tempContent = html`
        <span class="temp-hint">⚠️ Kein Sensor gesetzt</span>
      `;
    } else if (!this._isSensorValid) {
      // Req 1.3: Sensor liefert unknown/unavailable/nicht-numerisch.
      tempContent = html`
        <span class="temp-hint">⚠️ Kein gültiger Sensorwert</span>
        <span class="temp-sensor-id">${this._configuredSensor}</span>
      `;
    } else {
      // Req 1.1: gültige Ist-Temperatur anzeigen (inkl. Einheit, falls vorhanden).
      const temp = this._currentTemp;
      const unit = temp?.attributes?.unit_of_measurement ?? "°C";
      tempContent = html`
        <span class="temp-value">${temp.state} ${unit}</span>
      `;
    }

    return html`
      <div class="status-block">
        <div class="status-temp">${tempContent}</div>
        <span class="status-badge status-${status}">${status}</span>
      </div>
      <div class="status-threshold">
        ${Number.isFinite(threshold)
          ? html`🛡 Sicherheitsabschaltung bei ${threshold} °C`
          : html`🛡 Sicherheitsabschaltung bei —`}
      </div>
    `;
  }

  /**
   * Render der Prozesssteuerung (Task 8.4): Start-/Stop-/„Nächste Rast"-Buttons
   * abhängig vom Status und der Start-Verfügbarkeit (`canStart`).
   *
   * - Status `running` → „⏹ Stop" und „⏭ Nächste Rast" (Req 8.4, 8.5).
   * - sonst            → „▶ Start"; deaktiviert, solange `canStart` nicht
   *                      erfüllt ist (Rezept ≥ 1 Rast UND gültiger Sensorwert —
   *                      Req 8.1, 8.2, 8.3).
   *
   * @param {Array} recipe   Aktuelles Rezept.
   * @param {boolean} running Ob ein Prozess läuft.
   * @returns {import("lit").TemplateResult}
   */
  _renderControls(recipe, running) {
    if (running) {
      return html`
        <div class="controls">
          <button class="btn btn-primary" @click=${() => this._nextStep()}>
            ⏭ Nächste Rast
          </button>
          <button class="btn btn-danger" @click=${() => this._stop()}>
            ⏹ Stop
          </button>
        </div>
      `;
    }

    const startDisabled = !canStart(recipe, this._isSensorValid);
    return html`
      <div class="controls">
        <button
          class="btn btn-primary"
          ?disabled=${startDisabled}
          title=${startDisabled
            ? "Start benötigt mindestens eine Rast und einen gültigen Sensorwert."
            : "Brauprozess starten"}
          @click=${() => this._start()}
        >
          ▶ Start
        </button>
      </div>
    `;
  }

  /**
   * Render der Rezeptansicht: Raststufenliste mit Bearbeiten-/Löschen-Aktionen
   * sowie das Eingabeformular für neue Rasten (Req 3.1, 3.5, 4.6).
   *
   * @param {Array} recipe            Aktuelles Rezept.
   * @param {boolean} running         Ob ein Prozess läuft (Aktionen deaktiviert).
   * @param {number} active           Index der aktiven Rast.
   * @param {boolean} showMarkers     Ob Aktiv-/Fertig-Markierungen anzuzeigen sind.
   * @returns {import("lit").TemplateResult}
   */
  _renderRecipe(recipe, running, active, showMarkers) {
    return html`
      <div class="recipe">
        ${recipe.length === 0
          ? html`<div class="placeholder">Noch keine Raststufen. Unten eine Rast hinzufügen.</div>`
          : html`
              <ol class="steps">
                ${recipe.map((step, i) => this._renderStep(step, i, running, active, showMarkers))}
              </ol>
            `}
      </div>

      ${this._renderAddForm(running)}

      ${recipe.length > 0
        ? html`
            <div class="recipe-actions">
              <button
                class="btn btn-danger"
                ?disabled=${running}
                @click=${() => this._clear()}
              >
                🗑 Alle löschen
              </button>
            </div>
          `
        : ""}
    `;
  }

  /**
   * Render einer einzelnen Raststufe — entweder als Anzeigezeile oder, wenn
   * `_editIndex === i`, als Inline-Bearbeitungszeile (Req 3.1, 3.2, 4.6).
   *
   * @param {Object} step          Die Raststufe.
   * @param {number} i             Index der Rast.
   * @param {boolean} running      Ob ein Prozess läuft.
   * @param {number} active        Index der aktiven Rast.
   * @param {boolean} showMarkers  Ob Aktiv-/Fertig-Markierungen anzuzeigen sind.
   * @returns {import("lit").TemplateResult}
   */
  _renderStep(step, i, running, active, showMarkers) {
    if (this._editIndex === i) {
      return html`
        <li class="step editing">
          <div class="edit-row">
            <input
              id="edit-name"
              type="text"
              placeholder="Name (optional)"
              .value=${step.name ?? ""}
            />
            <input
              id="edit-temp"
              type="number"
              min="0"
              max="100"
              step="0.5"
              placeholder="°C"
              .value=${String(step.temperature ?? "")}
            />
            <input
              id="edit-dur"
              type="number"
              min="1"
              step="1"
              placeholder="min"
              .value=${String(step.duration ?? "")}
            />
          </div>
          <div class="edit-actions">
            <button class="btn btn-primary" @click=${() => this._saveEdit(i)}>
              ✓ Speichern
            </button>
            <button class="btn" @click=${() => this._cancelEdit()}>
              ✕ Abbrechen
            </button>
          </div>
        </li>
      `;
    }

    // Aktiv-/Fertig-/Verbleibend-Markierung (Req 4.6).
    let stateClass = "";
    let marker = "";
    if (showMarkers) {
      if (i < active) {
        stateClass = "done";
        marker = "✓";
      } else if (i === active) {
        stateClass = "active";
        marker = "▶";
      } else {
        stateClass = "remaining";
      }
    }

    return html`
      <li class="step ${stateClass}">
        <span class="marker">${marker}</span>
        <span class="step-info">
          <span class="step-name">${step.name}</span>
          <span class="step-detail">${step.temperature} °C · ${step.duration} min</span>
        </span>
        <span class="step-actions">
          <button
            class="icon-btn"
            title="Bearbeiten"
            ?disabled=${running}
            @click=${() => this._beginEdit(i)}
          >
            ✎
          </button>
          <button
            class="icon-btn"
            title="Löschen"
            ?disabled=${running}
            @click=${() => this._remove(i)}
          >
            🗑
          </button>
        </span>
      </li>
    `;
  }

  /**
   * Render des Eingabeformulars für neue Rasten (Req 2.1). Während eines
   * laufenden Prozesses sind die Felder und der Hinzufügen-Button deaktiviert
   * (Req 3.5).
   *
   * @param {boolean} running Ob ein Prozess läuft.
   * @returns {import("lit").TemplateResult}
   */
  _renderAddForm(running) {
    return html`
      <div class="add-form">
        <input
          id="new-name"
          type="text"
          placeholder="Name (optional)"
          ?disabled=${running}
        />
        <input
          id="new-temp"
          type="number"
          min="0"
          max="100"
          step="0.5"
          placeholder="°C"
          ?disabled=${running}
        />
        <input
          id="new-dur"
          type="number"
          min="1"
          step="1"
          placeholder="min"
          ?disabled=${running}
        />
        <button
          class="btn btn-primary"
          ?disabled=${running}
          @click=${() => this._addStep()}
        >
          ＋ Rast
        </button>
      </div>
    `;
  }

  /**
   * Render des Settings-Panels mit `<datalist>`-Autovervollständigung für
   * Sensor (`sensor.*`) und Heizung (`switch.*`) (Req 5.1, 6.1, 6.3, 7.3).
   *
   * Es werden bewusst `<input list=...>`-Felder mit `<datalist>` verwendet,
   * damit die Auswahlliste sich bei Auswahl nicht schließt und Eingaben nicht
   * verworfen werden. Die Felder lösen KEIN `requestUpdate` aus; `shouldUpdate`
   * unterdrückt zudem Re-Renders durch reine `hass`-Änderungen, solange das
   * Panel offen ist — die aktiven Eingabefelder bleiben dadurch erhalten.
   *
   * @returns {import("lit").TemplateResult}
   */
  _renderSettings() {
    const states = this.hass?.states ?? {};
    const entityIds = Object.keys(states);
    const sensorIds = entityIds.filter((id) => id.startsWith("sensor."));
    const switchIds = entityIds.filter((id) => id.startsWith("switch."));

    return html`
      <div class="settings">
        <h3>Einstellungen</h3>

        <label class="field-label" for="settings-sensor">Temperatursensor</label>
        <input
          id="settings-sensor"
          class="field"
          type="text"
          list="sensor-options"
          placeholder="sensor.brau_temperatur"
          .value=${this._configuredSensor}
        />
        <datalist id="sensor-options">
          ${sensorIds.map((id) => html`<option value=${id}></option>`)}
        </datalist>

        <label class="field-label" for="settings-heater">Heizungs-Aktor</label>
        <input
          id="settings-heater"
          class="field"
          type="text"
          list="switch-options"
          placeholder="switch.brau_heizung"
          .value=${this._configuredHeater}
        />
        <datalist id="switch-options">
          ${switchIds.map((id) => html`<option value=${id}></option>`)}
        </datalist>

        <div class="settings-actions">
          <button class="btn btn-primary" @click=${() => this._saveSettings()}>
            ✓ Speichern
          </button>
          <button class="btn" @click=${() => this._toggleSettings()}>
            ✕ Schließen
          </button>
        </div>
      </div>
    `;
  }
}

// ============================================================================
// Card Editor (Lovelace-Konfigurationselement für Fallback-Defaults)
// Vollständige Felder werden bei Bedarf in späteren Tasks ergänzt.
// ============================================================================
class BrausteuerungCardEditor extends LitElement {
  static get properties() {
    return { hass: { type: Object }, _config: { type: Object } };
  }

  setConfig(config) {
    this._config = config || {};
  }

  render() {
    return html`
      <div style="padding:8px;">
        <p style="font-size:0.9em;color:var(--secondary-text-color);">
          Sensor und Heizung werden direkt in der Karte über ⚙️ konfiguriert.
          Die Werte hier sind nur Fallback-Defaults.
        </p>
        <label style="font-size:0.85em;">Sensor Entity</label>
        <input
          style="width:100%;padding:8px;margin-bottom:8px;border:1px solid #ccc;border-radius:4px;box-sizing:border-box;"
          .value=${this._config?.sensor_entity || ""}
          @change=${(e) => this._fire("sensor_entity", e.target.value)}
          placeholder="sensor.brau_temperatur"
        />
        <label style="font-size:0.85em;">Heater Entity</label>
        <input
          style="width:100%;padding:8px;border:1px solid #ccc;border-radius:4px;box-sizing:border-box;"
          .value=${this._config?.heater_entity || ""}
          @change=${(e) => this._fire("heater_entity", e.target.value)}
          placeholder="switch.brau_heizung"
        />
      </div>
    `;
  }

  _fire(key, value) {
    this.dispatchEvent(
      new CustomEvent("config-changed", {
        detail: { config: { ...this._config, [key]: value } },
        bubbles: true,
        composed: true,
      })
    );
  }
}

// ============================================================================
// Registrierung
// ============================================================================
customElements.define("brausteuerung-card", BrausteuerungCard);
customElements.define("brausteuerung-card-editor", BrausteuerungCardEditor);

window.customCards = window.customCards || [];
window.customCards.push({
  type: "brausteuerung-card",
  name: "Brausteuerung",
  description: "Braurezept-Eingabe und Steuerung für Hobbybrauer",
});
