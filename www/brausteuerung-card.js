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
  reorderStep,
  isSensorValid,
  isValidHysteresis,
  resolveHysteresis,
  resolveSafetyOffset,
  upsertRecipe,
  removeRecipe,
  findRecipe,
  parseLibrary,
  serializeLibrary,
  canStart,
  computeSafetyThreshold,
  clampGraphHours,
  buildHistoryGraphConfig,
  translate,
  resolveLanguage,
  resolveUnit,
  DEFAULT_GRAPH_HOURS,
  Status,
} from "./brausteuerung-logic.js?v=2.5.1";

// ---------------------------------------------------------------------------
// Versionierung / Cache-Busting (Req 11.5, 11.6)
// ---------------------------------------------------------------------------
// Zentrale, beim Update hochzuzählende Versionsangabe. Sie wird an drei Stellen
// konsistent gehalten:
//   1. Lovelace-Ressourcen-URL: /local/brausteuerung-card.js?v=<VERSION>
//      (vom Benutzer beim Update gepflegt — bustet die Einstiegsdatei)
//   2. VERSION-Konstante (hier) — angezeigt in window.customCards
//   3. Query des internen Logik-Imports oben (`?v=...`) — bustet das Modul
// Der statische Import-Spezifizierer muss ein String-Literal sein; daher ist
// die Versionsnummer dort fest eingetragen und MUSS bei einem Update gemeinsam
// mit VERSION hochgezählt werden.
const VERSION = "2.5.1";

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
  HYSTERESIS: "input_number.brau_hysterese",
  TIMER: "timer.brau_raststufe",
  // Sprache der Oberfläche (Req 14): en / de.
  LANGUAGE: "input_select.brau_language",
  // Temperatureinheit der Beschriftungen (Req 15): °C / °F (nur Anzeige).
  UNIT: "input_select.brau_unit",
  // Taster (input_button), den die Card zum manuellen Stufenwechsel „drückt".
  NAECHSTE_RAST_BUTTON: "input_button.brau_naechste_rast",
  // Automationen, die von der Card per `automation.trigger` ausgelöst werden.
  AUTOMATION_RASTSTUFE: "automation.brausteuerung_raststufe",
});

// Key der Rezept-Bibliothek im HA-Benutzerspeicher (frontend user_data, Req 12.7).
const LIBRARY_KEY = "brausteuerung_recipes";

// Key der Graph-Einstellungen (gewählte Anzeigedauer) im HA-Benutzerspeicher (Req 13).
const GRAPH_SETTINGS_KEY = "brausteuerung_graph_settings";

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
      // Rezept-Bibliothek (Req 12) — asynchron aus dem HA-Benutzerspeicher.
      _library: { type: Array },
      _showLibrary: { type: Boolean },
      // Temperaturverlauf-Graph (Req 13): gewählte Anzeigedauer in Stunden.
      _graphHours: { type: Number },
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
    this._library = [];
    this._showLibrary = false;
    // Temperaturverlauf-Graph (Req 13): Die Card bettet die native
    // Home-Assistant-`history-graph`-Karte ein (echte Recorder-Historie).
    // `_graphHours` steuert `hours_to_show`; `_graphCard` ist das eingebettete
    // Karten-Element.
    this._graphHours = DEFAULT_GRAPH_HOURS;
    this._graphCard = null;
    this._graphCardSensor = null;
    this._graphCardHours = null;
    this._graphCardLang = null;
    this._graphCardUnit = null;
    this._graphCardLoading = false;
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
  // Lifecycle — Echtzeit-Countdown-Tick (Req 4.7)
  // =========================================================================

  /**
   * Startet beim Einhängen der Card den 1-Sekunden-Intervall-Tick, der die
   * Countdown-Anzeige der verbleibenden Haltezeit sekundengenau aktualisiert.
   */
  connectedCallback() {
    super.connectedCallback();
    this._startCountdownTick();
    // Rezept-Bibliothek asynchron aus dem HA-Benutzerspeicher laden (Req 12.8).
    this._loadLibrary();
    // Gewählte Anzeigedauer (hours_to_show) aus dem HA-Benutzerspeicher laden (Req 13.3).
    this._loadGraphSettings();
  }

  /** Räumt den Intervall-Tick beim Aushängen der Card auf (Req 4.7). */
  disconnectedCallback() {
    super.disconnectedCallback();
    this._stopCountdownTick();
  }

  /**
   * Liefert die effektive Anzeigedauer (`hours_to_show`) des Graphen (Req 13).
   *
   * Läuft ein Brauvorgang, wird das Fenster auf den **Startzeitpunkt** begrenzt:
   * `hours_to_show` = Zeit seit dem Start (Wechsel des Status auf `running`),
   * gedeckelt auf die vom Benutzer gewählte Dauer. Dadurch beginnen **beide**
   * Linien (Ist + Soll) beim Brauvorgang; ältere Werte liegen außerhalb des
   * Fensters und werden nicht angezeigt — ganz ohne Datenbank-Löschung.
   * Außerhalb eines laufenden Prozesses gilt die gewählte Dauer (1–4 h).
   *
   * @returns {number} Anzeigedauer in Stunden (fraktional möglich).
   */
  _effectiveGraphHours() {
    const selected = clampGraphHours(this._graphHours);
    if (this._status !== Status.RUNNING) {
      return selected;
    }
    const st = this.hass?.states[ENTITY.STATUS];
    if (!st || st.state !== "running" || !st.last_changed) {
      return selected;
    }
    const startMs = Date.parse(st.last_changed);
    if (!Number.isFinite(startMs)) {
      return selected;
    }
    const sinceH = (Date.now() - startMs) / 3600000;
    // Mindestfensterbreite (1 min), damit der Graph zu Beginn nicht entartet.
    const MIN_H = 1 / 60;
    return Math.min(selected, Math.max(sinceH, MIN_H));
  }

  /**
   * Synchronisiert die eingebettete `history-graph`-Karte mit der aktuellen
   * Konfiguration (Sensor + effektive Anzeigedauer) — in-place über `setConfig`,
   * damit kein Flackern durch Neuerzeugen entsteht (Req 13). Aktualisiert nur,
   * wenn sich der Sensor geändert hat ODER sich die effektive Dauer um mind.
   * ~1 min verschoben hat (drosselt das Nachführen des Fensters bei laufendem
   * Brauvorgang).
   */
  _syncGraphCard() {
    if (!this._graphCard) return;
    const sensorChanged = this._configuredSensor !== this._graphCardSensor;
    const langChanged = this._lang !== this._graphCardLang;
    const unitChanged = this._unit !== this._graphCardUnit;
    const desiredHours = this._effectiveGraphHours();
    const hoursChanged =
      !Number.isFinite(this._graphCardHours) ||
      Math.abs(desiredHours - this._graphCardHours) >= 1 / 60;
    if (!sensorChanged && !langChanged && !unitChanged && !hoursChanged) return;
    try {
      this._graphCard.setConfig(this._graphCardConfig());
      if (this.hass) this._graphCard.hass = this.hass;
      this._graphCardSensor = this._configuredSensor;
      this._graphCardHours = desiredHours;
      this._graphCardLang = this._lang;
      this._graphCardUnit = this._unit;
    } catch (err) {
      // setConfig nicht möglich — bestehende Karte beibehalten.
    }
  }

  /**
   * Hält die eingebettete `history-graph`-Karte aktuell (Req 13): reicht das
   * jeweils neue `hass`-Objekt an das Kind weiter und baut die Karte neu auf,
   * wenn sich Sensor oder Anzeigedauer geändert haben.
   * @param {Map} changed Geänderte Properties (LitElement).
   */
  updated(changed) {
    if (!this._graphCard) return;
    if (changed.has("hass") && this.hass) {
      this._graphCard.hass = this.hass;
    }
    // Fenster an Sensor/effektive Dauer anpassen (begrenzt bei laufendem
    // Brauvorgang auf den Startzeitpunkt).
    this._syncGraphCard();
  }

  /**
   * Startet den Sekunden-Tick (idempotent). Da `_remainingHoldSeconds` aus
   * `finishes_at - now` berechnet wird, genügt ein lokaler Re-Render pro
   * Sekunde, um den Countdown laufen zu lassen — ohne auf `hass`-Updates zu
   * warten. Der Tick erzwingt ein Re-Render nur, wenn gerade ein Timer läuft
   * und weder Settings-Panel offen noch eine Rast in Bearbeitung ist (damit
   * aktive Eingabefelder erhalten bleiben, Req 7.1/7.2).
   */
  _startCountdownTick() {
    if (this._countdownTimer) return;
    this._countdownTimer = setInterval(() => {
      if (this._showSettings || this._editIndex >= 0) return;
      if (this._remainingHoldSeconds !== null) {
        this.requestUpdate();
      }
    }, 1000);
  }

  /** Stoppt und verwirft den Sekunden-Tick. */
  _stopCountdownTick() {
    if (this._countdownTimer) {
      clearInterval(this._countdownTimer);
      this._countdownTimer = null;
    }
  }

  // =========================================================================
  // Temperaturverlauf-Graph (Req 13) — eingebettete native history-graph-Karte
  // =========================================================================

  /**
   * Liefert die Konfiguration der eingebetteten `history-graph`-Karte: Ist-
   * Temperatur (konfigurierter Sensor) und Solltemperatur (in Rot) über die
   * effektive Anzeigedauer (bei laufendem Brauvorgang auf den Startzeitpunkt
   * begrenzt) (Req 13).
   * @returns {Object} history-graph-Kartenkonfiguration.
   */
  _graphCardConfig() {
    const unit = this._unit;
    return buildHistoryGraphConfig(
      this._configuredSensor,
      ENTITY.SETPOINT,
      this._effectiveGraphHours(),
      {
        actual: `${this._t("graph_actual")} (${unit})`,
        setpoint: `${this._t("graph_setpoint")} (${unit})`,
      }
    );
  }

  /**
   * Erzeugt die eingebettete native `history-graph`-Karte einmalig über
   * `window.loadCardHelpers()` (asynchron, idempotent). Die Karte liest die
   * echte Recorder-Historie und aktualisiert sich selbst; wir reichen nur das
   * `hass`-Objekt durch. Ohne konfigurierten Sensor wird nichts erzeugt.
   * @returns {Promise<void>}
   */
  async _ensureGraphCard() {
    if (this._graphCard || this._graphCardLoading) return;
    if (typeof window === "undefined" || typeof window.loadCardHelpers !== "function") {
      return;
    }
    if (!this.hass || !this._configuredSensor) return;
    this._graphCardLoading = true;
    try {
      const helpers = await window.loadCardHelpers();
      const el = helpers.createCardElement(this._graphCardConfig());
      el.hass = this.hass;
      this._graphCard = el;
      this._graphCardSensor = this._configuredSensor;
      this._graphCardHours = this._effectiveGraphHours();
      this._graphCardLang = this._lang;
      this._graphCardUnit = this._unit;
    } catch (err) {
      // history-graph konnte nicht erstellt werden — Platzhalter bleibt sichtbar.
    } finally {
      this._graphCardLoading = false;
      this.requestUpdate();
    }
  }

  /**
   * Lädt die gewählte Anzeigedauer (`hours_to_show`) aus dem HA-Benutzerspeicher
   * (Req 13.3). Fehlende/ungültige Werte fallen auf den Default (2 h) zurück.
   * Idempotenter Schutz. Nach dem Laden wird die eingebettete Karte ggf. neu
   * aufgebaut, damit die Dauer greift.
   * @returns {Promise<void>}
   */
  async _loadGraphSettings() {
    if (this._graphSettingsLoaded) return;
    const conn = this.hass?.connection;
    if (!conn || typeof conn.sendMessagePromise !== "function") {
      return;
    }
    try {
      const result = await conn.sendMessagePromise({
        type: "frontend/get_user_data",
        key: GRAPH_SETTINGS_KEY,
      });
      const value = result?.value;
      const parsed = typeof value === "string" ? JSON.parse(value) : value;
      if (parsed && typeof parsed === "object") {
        this._graphHours = clampGraphHours(parsed.hours);
        this._syncGraphCard();
      }
      this._graphSettingsLoaded = true;
    } catch (err) {
      // Einstellungen nicht verfügbar: Defaults beibehalten.
    }
  }

  /**
   * Persistiert die gewählte Anzeigedauer im HA-Benutzerspeicher (Req 13.3).
   * @returns {Promise<void>}
   */
  async _persistGraphSettings() {
    const conn = this.hass?.connection;
    if (!conn || typeof conn.sendMessagePromise !== "function") {
      return;
    }
    try {
      await conn.sendMessagePromise({
        type: "frontend/set_user_data",
        key: GRAPH_SETTINGS_KEY,
        value: JSON.stringify({ hours: this._graphHours }),
      });
      this._graphSettingsLoaded = true;
    } catch (err) {
      // Persistenz fehlgeschlagen: Einstellung bleibt zumindest lokal aktiv.
    }
  }

  /**
   * Setzt die Anzeigedauer des Graphen in Stunden (1–4), persistiert sie und
   * baut die eingebettete Karte mit dem neuen `hours_to_show` neu auf (Req 13.3).
   * @param {number|string} hours Gewünschte Anzeigedauer in Stunden.
   */
  /**
   * Setzt die Anzeigedauer des Graphen in Stunden (1–4), persistiert sie und
   * aktualisiert die eingebettete Karte (Req 13.3).
   * @param {number|string} hours Gewünschte Anzeigedauer in Stunden.
   */
  _setGraphHours(hours) {
    this._graphHours = clampGraphHours(hours);
    this._syncGraphCard();
    this._persistGraphSettings();
  }

  // =========================================================================
  // Rezept-Bibliothek (Req 12) — HA-Benutzerspeicher via WebSocket-API
  // =========================================================================

  /**
   * Lädt die Rezept-Bibliothek aus dem HA-Benutzerspeicher (Req 12.8).
   *
   * Liest `frontend/get_user_data` (Key `brausteuerung_recipes`), parst den
   * Rohwert robust über `parseLibrary` und setzt `_library`. Ist `hass` bzw.
   * die WebSocket-Verbindung noch nicht verfügbar oder schlägt der Aufruf fehl,
   * bleibt der zuletzt bekannte `_library`-Zustand erhalten (Req 12.10). Wird
   * nur einmal erfolgreich geladen (idempotenter Schutz über `_libraryLoaded`).
   * @returns {Promise<void>}
   */
  async _loadLibrary() {
    if (this._libraryLoaded) return;
    const conn = this.hass?.connection;
    if (!conn || typeof conn.sendMessagePromise !== "function") {
      return; // hass/Verbindung noch nicht bereit — späterer Aufruf lädt nach.
    }
    try {
      const result = await conn.sendMessagePromise({
        type: "frontend/get_user_data",
        key: LIBRARY_KEY,
      });
      this._library = parseLibrary(result?.value);
      this._libraryLoaded = true;
    } catch (err) {
      // Benutzerspeicher nicht verfügbar: letzten Zustand behalten (Req 12.10).
      this._setError(this._t("err_lib_load"));
    }
  }

  /**
   * Persistiert die Bibliothek im HA-Benutzerspeicher (Req 12.7, 12.10).
   *
   * Bei Erfolg wird `_library` auf den neuen Stand gesetzt. Schlägt der Aufruf
   * fehl, bleibt der zuletzt bekannte `_library`-Zustand erhalten und es wird
   * eine Fehlermeldung angezeigt.
   * @param {Array} library Zu speichernde Bibliothek.
   * @returns {Promise<boolean>} `true`, wenn persistiert wurde.
   */
  async _persistLibrary(library) {
    const conn = this.hass?.connection;
    if (!conn || typeof conn.sendMessagePromise !== "function") {
      this._setError(this._t("err_lib_save"));
      return false;
    }
    try {
      await conn.sendMessagePromise({
        type: "frontend/set_user_data",
        key: LIBRARY_KEY,
        value: serializeLibrary(library),
      });
      this._library = library;
      this._libraryLoaded = true;
      if (this._errorMessage) this._errorMessage = "";
      return true;
    } catch (err) {
      this._setError(this._t("err_lib_save"));
      return false;
    }
  }

  /**
   * Speichert das aktive Rezept unter einem Namen in der Bibliothek (Req 12.1, 12.2).
   *
   * Existiert der (getrimmte) Name bereits, wird nur nach ausdrücklicher
   * Bestätigung überschrieben (`confirmOverwrite`). Ohne Bestätigung bleibt die
   * Bibliothek unverändert und es wird signalisiert, dass eine Bestätigung
   * nötig ist.
   * @param {string} name Rezeptname.
   * @param {boolean} confirmOverwrite Ob ein vorhandenes Rezept überschrieben werden darf.
   * @returns {Promise<{ok: boolean, needsConfirm?: boolean}>}
   */
  async _saveRecipeToLibrary(name, confirmOverwrite = false) {
    const trimmed = (name ?? "").trim();
    if (trimmed === "") {
      this._setError(this._t("err_enter_name"));
      return { ok: false };
    }
    const exists = !!findRecipe(this._library, trimmed);
    if (exists && !confirmOverwrite) {
      // Überschreiben erfordert Bestätigung (Req 12.2).
      return { ok: false, needsConfirm: true };
    }
    const newLib = upsertRecipe(this._library, trimmed, this._recipe);
    const ok = await this._persistLibrary(newLib);
    return { ok };
  }

  /**
   * Lädt ein Bibliotheks-Rezept als aktives Rezept (Req 12.4, 12.5, 12.9).
   *
   * Während eines laufenden Prozesses gesperrt (Req 12.9). Überschreitet das
   * Rezept die 255-Zeichen-Grenze des aktiven Speichers, wird das Laden
   * abgelehnt und ein Hinweis angezeigt; das aktive Rezept bleibt unverändert
   * (Req 12.5).
   * @param {string} name Name des zu ladenden Rezepts.
   * @returns {boolean} `true`, wenn geladen wurde.
   */
  _loadRecipeFromLibrary(name) {
    if (this._status === Status.RUNNING) {
      return false;
    }
    const recipe = findRecipe(this._library, name);
    if (!recipe) {
      this._setError(this._t("err_recipe_not_found"));
      return false;
    }
    const steps = Array.isArray(recipe.steps) ? recipe.steps : [];
    if (!canPersistRecipe(steps)) {
      this._setError(this._t("err_recipe_too_large_load"));
      return false;
    }
    return this._persistRecipe(steps);
  }

  /**
   * Löscht ein Rezept aus der Bibliothek (Req 12.6).
   * @param {string} name Name des zu löschenden Rezepts.
   * @returns {Promise<boolean>}
   */
  async _deleteRecipeFromLibrary(name) {
    const newLib = removeRecipe(this._library, name);
    return this._persistLibrary(newLib);
  }

  /** Schaltet die Sichtbarkeit des Rezeptverwaltungs-Panels um (Req 12.3). */
  _toggleLibrary() {
    this._showLibrary = !this._showLibrary;
    this._errorMessage = "";
    // Beim Öffnen sicherstellen, dass die Bibliothek geladen ist.
    if (this._showLibrary) {
      this._libraryLoaded = false;
      this._loadLibrary();
    }
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

  /**
   * Aktuelle Oberflächensprache (Req 14): aus dem Helfer
   * `input_select.brau_language`; Default Englisch bei fehlendem/ungültigem Wert.
   * @returns {string} 'en' oder 'de'.
   */
  get _lang() {
    return resolveLanguage(this.hass?.states[ENTITY.LANGUAGE]?.state);
  }

  /**
   * Übersetzt einen Schlüssel in die aktuelle Oberflächensprache (Req 14).
   * @param {string} key Übersetzungsschlüssel.
   * @param {Object<string,(string|number)>} [vars] Platzhalterwerte.
   * @returns {string} Übersetzter Text.
   */
  _t(key, vars) {
    return translate(this._lang, key, vars);
  }

  /**
   * Gewählte Temperatureinheit für die Beschriftungen (Req 15): aus dem Helfer
   * `input_select.brau_unit`; Default `°C`. Reine Anzeige, keine Umrechnung.
   * @returns {string} '°C' oder '°F'.
   */
  get _unit() {
    return resolveUnit(this.hass?.states[ENTITY.UNIT]?.state);
  }

  /**
   * Setzt die Temperatureinheit über den Helfer `input_select.brau_unit` (Req 15).
   * @param {string} unit '°C' oder '°F'.
   */
  _setUnit(unit) {
    if (!this.hass) return;
    this.hass.callService("input_select", "select_option", {
      entity_id: ENTITY.UNIT,
      option: resolveUnit(unit),
    });
  }

  /**
   * Setzt die Oberflächensprache über den Helfer `input_select.brau_language`
   * (Req 14). Wirkt sofort auf die Card und — da der Helfer die Single Source of
   * Truth ist — auch auf die Benachrichtigungstexte der Automationen.
   * @param {string} lang Sprachcode ('en'/'de').
   */
  _setLanguage(lang) {
    if (!this.hass) return;
    this.hass.callService("input_select", "select_option", {
      entity_id: ENTITY.LANGUAGE,
      option: resolveLanguage(lang),
    });
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
    const offset = resolveSafetyOffset(this.hass?.states[ENTITY.SAFETY_OFFSET]?.state);
    return computeSafetyThreshold(soll, offset);
  }

  /**
   * Aktuell geltendes Hystereseband in °C (Req 4.9, 4.10).
   *
   * Liest den Wert aus `input_number.brau_hysterese`. Bei fehlendem,
   * nicht-numerischem oder außerhalb des gültigen Bereichs (`0 < v <= 5`)
   * liegendem Wert wird der Default 1,0 °C verwendet (`resolveHysteresis`).
   * @returns {number} Hystereseband in °C.
   */
  get _hysteresis() {
    return resolveHysteresis(this.hass?.states[ENTITY.HYSTERESIS]?.state);
  }

  /**
   * State-Objekt des konfigurierten Heizungs-Aktors (oder `null`).
   * @returns {Object|null} HA-State-Objekt des Heizungs-Aktors.
   */
  get _heaterState() {
    const heater = this._configuredHeater;
    if (!this.hass || !heater) return null;
    return this.hass.states[heater] ?? null;
  }

  /**
   * Echtzeit-Zustand des Heizungs-Aktors (Req 5.6, 5.7).
   * @returns {boolean} `true`, wenn der Aktor eingeschaltet ist.
   */
  get _isHeaterOn() {
    return this._heaterState?.state === "on";
  }

  /**
   * Verbleibende Haltezeit der aktiven Raststufe in Sekunden (Req 4.7).
   *
   * Quelle ist die HA-`timer`-Entität `timer.brau_raststufe`. Bei laufendem
   * Timer (`active`) liefert das Attribut `finishes_at` den Endzeitpunkt; die
   * Restzeit wird daraus relativ zur aktuellen Uhrzeit berechnet, sodass die
   * Anzeige sekundengenau (über den eigenen Intervall-Tick) herunterzählt.
   * Liegt kein laufender Timer vor oder fehlt `finishes_at`, wird `null`
   * zurückgegeben (keine Countdown-Anzeige).
   *
   * @returns {number|null} Verbleibende Sekunden (>= 0) oder `null`.
   */
  get _remainingHoldSeconds() {
    const timer = this.hass?.states[ENTITY.TIMER];
    if (!timer || timer.state !== "active") {
      return null;
    }
    const finishesAt = timer.attributes?.finishes_at;
    if (!finishesAt) {
      return null;
    }
    const finishMs = Date.parse(finishesAt);
    if (Number.isNaN(finishMs)) {
      return null;
    }
    const remainingMs = finishMs - Date.now();
    return Math.max(0, Math.round(remainingMs / 1000));
  }

  // =========================================================================
  // Render-Stabilität (Req 7.1, 7.2) — Logik liegt im reinen Logikmodul
  // =========================================================================
  shouldUpdate(changedProps) {
    // Ist das Bibliotheks-Panel offen, sollen reine hass-Updates die aktive
    // Namenseingabe nicht zerstören; Änderungen an Panel-Status/Bibliothek/
    // Fehlermeldung lösen jedoch ein Re-Render aus (Req 7, Req 12).
    if (this._showLibrary) {
      return (
        changedProps.has("_showLibrary") ||
        changedProps.has("_library") ||
        changedProps.has("_localRecipe") ||
        changedProps.has("_showSettings") ||
        changedProps.has("_editIndex")
      );
    }
    // Eine frisch geladene/aktualisierte Bibliothek soll auch sonst sichtbar werden.
    if (changedProps.has("_library")) {
      return true;
    }
    // Geänderte Anzeigedauer soll den Verlauf neu aufbauen — außer es wird
    // gerade eine Rast editiert (Req 7).
    if (this._editIndex < 0 && changedProps.has("_graphHours")) {
      return true;
    }
    // Reine hass-Updates nur während der Inline-Bearbeitung einer Rast
    // unterdrücken (damit aktive Eingabefelder erhalten bleiben, Req 7.1/7.2).
    // Ist NUR das Settings-Panel offen, weiterhin auf hass-Updates rendern,
    // damit der Heizungs-Schalter (Farbe/Flamme) live aktualisiert — die
    // Settings-Eingabefelder binden an stabile Getter und bleiben erhalten.
    if (this._editIndex >= 0) {
      return (
        changedProps.has("_showSettings") ||
        changedProps.has("_editIndex") ||
        changedProps.has("_localRecipe")
      );
    }
    return true;
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
      this._setError(this._t("err_recipe_too_large"));
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
      this._setError(this._t("err_invalid_step_add"));
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
      this._setError(this._t("err_invalid_step_edit"));
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

  /**
   * Verschiebt die Rast an Position `i` in der Reihenfolge nach oben oder unten
   * (Req 3.7) und persistiert die neue Reihenfolge. Während eines laufenden
   * Prozesses ist das Umsortieren gesperrt (Req 3.8 — die Abarbeitung folgt der
   * zum Startzeitpunkt vorliegenden Reihenfolge).
   *
   * @param {number} i        Index der zu verschiebenden Rast.
   * @param {-1|1} direction  `-1` = nach oben, `+1` = nach unten.
   */
  _moveStep(i, direction) {
    if (this._status === Status.RUNNING) {
      return;
    }
    const current = this._recipe;
    const newRecipe = reorderStep(current, i, direction);
    // Keine Änderung (z. B. an den Listengrenzen): nichts persistieren.
    // reorderStep liefert in diesem Fall dieselbe Referenz wie die Eingabe.
    if (newRecipe === current) {
      return;
    }
    this._persistRecipe(newRecipe);
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
    // Kein Löschen der Historie nötig: Das Graph-Zeitfenster wird bei laufendem
    // Brauvorgang automatisch auf den Startzeitpunkt begrenzt, sodass beide
    // Linien (Ist + Soll) beim Brauvorgang beginnen (Req 13, _effectiveGraphHours).
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
   * Manueller Stufenwechsel (Req 8.5–8.7): „drückt" den Taster
   * `input_button.brau_naechste_rast`. Die Automation
   * `brausteuerung_manueller_wechsel` reagiert darauf und wechselt phasenabhängig
   * (Haltephase: Timer beenden; Aufheizphase: Stufe erhöhen) bzw. schließt bei
   * der letzten Rast ab. Bewusst `input_button.press` statt `automation.trigger`,
   * damit der breite Event-Trigger der Raststufen-Automation nicht mitfeuert und
   * die laufende Rast neu startet.
   */
  _nextStep() {
    if (!this.hass) return;
    this.hass.callService("input_button", "press", {
      entity_id: ENTITY.NAECHSTE_RAST_BUTTON,
    });
  }

  /**
   * Schaltet den konfigurierten Heizungs-Aktor manuell um (Req 5.8): ist er
   * aktuell aus, wird `switch.turn_on` aufgerufen, sonst `switch.turn_off`.
   *
   * Es gibt bewusst KEINEN Konflikt-Lock: Während eines laufenden Brauprozesses
   * darf die Hysterese-Regelung der Automation den manuell gesetzten Zustand
   * gemäß Regelung wieder überschreiben (Req 5.9). Bei Fehlschlag des
   * Service-Aufrufs wird ein Hinweis angezeigt; der reale Zustand wird weiter
   * aus dem `hass`-State gelesen, sodass keine Anzeige-Diskrepanz entsteht.
   */
  _toggleHeater() {
    if (!this.hass) return;
    const heater = this._configuredHeater;
    if (!heater) {
      this._setError(this._t("err_no_heater"));
      return;
    }
    const service = this._isHeaterOn ? "turn_off" : "turn_on";
    try {
      this.hass.callService("switch", service, { entity_id: heater });
    } catch (err) {
      this._setError(this._t("err_heater_toggle"));
    }
  }

  /**
   * Speichert das in der Card eingestellte Hystereseband (Req 4.9).
   *
   * Akzeptiert nur gültige Werte (`0 < v <= 5` °C, geprüft über
   * `isValidHysteresis`) und persistiert sie über `input_number.set_value`
   * nach `input_number.brau_hysterese`. Ungültige Eingaben werden abgelehnt;
   * der zuletzt gespeicherte Wert bleibt unverändert und es wird ein
   * Fehlerhinweis angezeigt.
   *
   * @param {number|string} value Eingegebenes Hystereseband in °C.
   * @returns {boolean} `true`, wenn persistiert wurde; sonst `false`.
   */
  _saveHysteresis(value) {
    if (!this.hass) return false;
    const num = typeof value === "string" ? Number(value) : value;
    if (!isValidHysteresis(num)) {
      this._setError(this._t("err_invalid_hysteresis"));
      return false;
    }
    this._errorMessage = "";
    this.hass.callService("input_number", "set_value", {
      entity_id: ENTITY.HYSTERESIS,
      value: num,
    });
    return true;
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
    const hyst = this._q("#settings-hysteresis")?.value ?? "";
    // Hysterese zuerst validieren: bei ungültiger Eingabe Panel offen lassen
    // und einen Fehlerhinweis anzeigen, ohne die Entitäten zu speichern.
    if (hyst !== "" && !this._saveHysteresis(hyst)) {
      return;
    }
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
        this._setError(this._t("err_entity_save_retry"));
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
      .header-actions {
        display: flex;
        align-items: center;
        gap: 4px;
      }
      .lang-select {
        padding: 2px 4px;
        border: 1px solid var(--divider-color, #ccc);
        border-radius: 4px;
        background: var(--card-background-color, #fff);
        color: var(--primary-text-color, #000);
        font-size: 0.8em;
        cursor: pointer;
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
      .status-right {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-shrink: 0;
      }
      .heater-toggle {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        padding: 2px 10px;
        border-radius: 12px;
        font-size: 0.8em;
        font-weight: 600;
        cursor: pointer;
        border: 1px solid var(--divider-color, #ccc);
        background: var(--secondary-background-color, #f0f0f0);
        color: var(--secondary-text-color);
      }
      .heater-toggle.on {
        background: var(--error-color, #e74c3c);
        color: #fff;
        border-color: var(--error-color, #e74c3c);
      }
      .heater-toggle .flame {
        filter: none;
      }
      .status-countdown {
        font-size: 0.95em;
        font-weight: 600;
        color: var(--primary-color, #03a9f4);
        margin-bottom: 8px;
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
        box-sizing: border-box;
        border: 1px solid var(--divider-color, #ccc);
        border-radius: 4px;
        padding: 6px 8px;
        background: var(--card-background-color, #fff);
        color: var(--primary-text-color, #000);
      }

      /* Temperaturverlauf-Graph (Req 13) */
      .graph {
        margin-top: 12px;
        padding-top: 8px;
        border-top: 1px solid var(--divider-color, #e0e0e0);
      }
      .graph-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 6px;
      }
      .graph-title {
        font-weight: 500;
        font-size: 0.95em;
      }
      .graph-hours-label {
        font-size: 0.85em;
        color: var(--secondary-text-color);
      }
      .graph-hours {
        margin-left: 4px;
        padding: 2px 6px;
        border: 1px solid var(--divider-color, #ccc);
        border-radius: 4px;
        background: var(--card-background-color, #fff);
        color: var(--primary-text-color, #000);
      }
      .graph-svg {
        width: 100%;
        height: auto;
        aspect-ratio: 400 / 160;
        display: block;
        overflow: visible;
        background: var(--secondary-background-color, #fafafa);
        border-radius: 4px;
      }
      .graph-temp {
        stroke: var(--primary-color, #03a9f4);
        stroke-width: 2;
      }
      .graph-soll {
        stroke: var(--error-color, #e74c3c);
        stroke-width: 2;
        stroke-dasharray: 4 3;
      }
      .graph-axis {
        fill: var(--secondary-text-color, #888);
        color: var(--secondary-text-color, #888);
        font-size: 11px;
      }
      .graph-axis-title {
        fill: var(--secondary-text-color, #888);
        color: var(--secondary-text-color, #888);
        font-size: 11px;
        font-weight: 600;
      }
      .graph-axis-line {
        stroke: var(--divider-color, #ccc);
        stroke-width: 1;
      }
      .graph-grid {
        stroke: var(--divider-color, #e0e0e0);
        stroke-width: 0.5;
        opacity: 0.6;
      }
      .graph-legend {
        display: flex;
        gap: 16px;
        margin-top: 4px;
        font-size: 0.8em;
        color: var(--secondary-text-color);
      }
      .legend-item {
        display: inline-flex;
        align-items: center;
        gap: 4px;
      }
      .swatch {
        display: inline-block;
        width: 14px;
        height: 3px;
        border-radius: 2px;
      }
      .swatch.temp {
        background: var(--primary-color, #03a9f4);
      }
      .swatch.soll {
        background: var(--error-color, #e74c3c);
      }
      .graph-toggle {
        display: flex;
        align-items: center;
        gap: 6px;
        margin-top: 8px;
        font-size: 0.85em;
        color: var(--secondary-text-color);
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
          <h2>${this._t("app_title")}</h2>
          <div class="header-actions">
            <select
              class="lang-select"
              title=${this._t("language_tt")}
              @change=${(e) => this._setLanguage(e.target.value)}
            >
              <option value="en" ?selected=${this._lang === "en"}>EN</option>
              <option value="de" ?selected=${this._lang === "de"}>DE</option>
            </select>
            <button
              class="icon-btn"
              title=${this._t("manage_recipes_tt")}
              @click=${() => this._toggleLibrary()}
            >
              📋
            </button>
            <button
              class="icon-btn"
              title=${this._t("settings_tt")}
              @click=${() => this._toggleSettings()}
            >
              ⚙️
            </button>
          </div>
        </div>

        ${this._renderStatusBlock()}

        ${this._showLibrary
          ? this._renderLibrary(running)
          : this._showSettings
          ? this._renderSettings()
          : this._renderRecipe(recipe, running, active, showStatusMarkers)}

        ${this._showSettings || this._showLibrary ? "" : this._renderControls(recipe, running)}

        ${this._showSettings || this._showLibrary ? "" : this._renderGraph()}

        ${this._errorMessage
          ? html`<div class="error">${this._errorMessage}</div>`
          : ""}
      </ha-card>
    `;
  }

  /**
   * Render des Rezeptverwaltungs-Panels (Req 12): Liste der Bibliotheks-Rezepte
   * mit „Laden"/„Löschen" je Eintrag sowie ein Namensfeld mit „Speichern unter…"
   * für das aktive Rezept. Während eines laufenden Prozesses sind verändernde
   * Aktionen, die das aktive Rezept ersetzen würden, deaktiviert (Req 12.9).
   *
   * @param {boolean} running Ob ein Prozess läuft.
   * @returns {import("lit").TemplateResult}
   */
  _renderLibrary(running) {
    const library = Array.isArray(this._library) ? this._library : [];
    return html`
      <div class="settings">
        <h3>${this._t("manage_recipes_title")}</h3>

        ${library.length === 0
          ? html`<div class="placeholder">${this._t("no_saved_recipes")}</div>`
          : html`
              <ul class="steps">
                ${library.map(
                  (r) => html`
                    <li class="step">
                      <span class="step-info">
                        <span class="step-name">${r.name}</span>
                        <span class="step-detail">${this._t("rests_count", { n: (r.steps || []).length })}</span>
                      </span>
                      <span class="step-actions">
                        <button
                          class="btn btn-primary btn-s"
                          title=${this._t("load_recipe_tt")}
                          ?disabled=${running}
                          @click=${() => this._loadRecipeFromLibrary(r.name)}
                        >
                          ${this._t("load")}
                        </button>
                        <button
                          class="btn btn-danger btn-s"
                          title=${this._t("delete_from_library_tt")}
                          @click=${() => this._deleteRecipeFromLibrary(r.name)}
                        >
                          🗑
                        </button>
                      </span>
                    </li>
                  `
                )}
              </ul>
            `}

        <label class="field-label" for="library-name">
          ${this._t("save_current_as")}
        </label>
        <input
          id="library-name"
          class="field"
          type="text"
          placeholder=${this._t("recipe_name_placeholder")}
        />
        <div class="settings-actions">
          <button
            class="btn btn-primary"
            ?disabled=${running}
            @click=${() => this._onSaveRecipeClick()}
          >
            ${this._t("save_as")}
          </button>
          <button class="btn" @click=${() => this._toggleLibrary()}>
            ${this._t("close")}
          </button>
        </div>
      </div>
    `;
  }

  /**
   * Liest den Namen aus dem Eingabefeld und speichert das aktive Rezept in der
   * Bibliothek. Existiert der Name bereits, wird vor dem Überschreiben eine
   * Bestätigung eingeholt (Req 12.2).
   */
  async _onSaveRecipeClick() {
    const nameEl = this._q("#library-name");
    const name = nameEl ? nameEl.value : "";
    const res = await this._saveRecipeToLibrary(name, false);
    if (res.needsConfirm) {
      const ok = typeof window !== "undefined" && typeof window.confirm === "function"
        ? window.confirm(this._t("overwrite_confirm", { name: name.trim() }))
        : true;
      if (ok) {
        await this._saveRecipeToLibrary(name, true);
      }
    } else if (res.ok && nameEl) {
      nameEl.value = "";
    }
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
        <span class="temp-hint">${this._t("no_sensor")}</span>
      `;
    } else if (!this._isSensorValid) {
      // Req 1.3: Sensor liefert unknown/unavailable/nicht-numerisch.
      tempContent = html`
        <span class="temp-hint">${this._t("invalid_sensor")}</span>
        <span class="temp-sensor-id">${this._configuredSensor}</span>
      `;
    } else {
      // Req 1.1: gültige Ist-Temperatur anzeigen. Einheit ist die gewählte
      // Anzeigeeinheit (Req 15 — reine Beschriftung, keine Umrechnung).
      const temp = this._currentTemp;
      tempContent = html`
        <span class="temp-value">${temp.state} ${this._unit}</span>
      `;
    }

    return html`
      <div class="status-block">
        <div class="status-temp">${tempContent}</div>
        <div class="status-right">
          ${this._renderHeaterState()}
          <span class="status-badge status-${status}">${this._t("status_" + status)}</span>
        </div>
      </div>
      <div class="status-threshold">
        ${Number.isFinite(threshold)
          ? this._t("safety_shutoff", { v: threshold, unit: this._unit })
          : this._t("safety_shutoff_none")}
      </div>
      <div class="status-threshold">
        ${this._t("hysteresis_status", { v: this._hysteresis, unit: this._unit })}
      </div>
      ${this._renderCountdown()}
    `;
  }

  /**
   * Render des Echtzeit-Zustands des Heizungs-Aktors neben der Ist-Temperatur
   * (Req 5.6) inkl. farbigem Flammensymbol, wenn der Aktor eingeschaltet ist
   * (Req 5.7), sowie eines Schalt-Buttons für das manuelle Umschalten (Req 5.8).
   *
   * Ist kein Heizungs-Aktor konfiguriert, wird nichts angezeigt.
   *
   * @returns {import("lit").TemplateResult|string}
   */
  _renderHeaterState() {
    if (!this._configuredHeater) {
      return "";
    }
    const on = this._isHeaterOn;
    return html`
      <button
        class="heater-toggle ${on ? "on" : "off"}"
        title=${on ? this._t("heater_turn_off_tt") : this._t("heater_turn_on_tt")}
        @click=${() => this._toggleHeater()}
      >
        ${on
          ? html`<span class="flame">🔥</span> ${this._t("heater_on")}`
          : html`${this._t("heater_off")}`}
      </button>
    `;
  }

  /**
   * Render des sekundengenauen Echtzeit-Countdowns der verbleibenden Haltezeit
   * (Req 4.7). Wird nur angezeigt, wenn ein Raststufen-Timer aktiv läuft.
   *
   * @returns {import("lit").TemplateResult|string}
   */
  _renderCountdown() {
    const remaining = this._remainingHoldSeconds;
    if (remaining === null) {
      return "";
    }
    const mm = Math.floor(remaining / 60);
    const ss = remaining % 60;
    const formatted = `${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
    return html`
      <div class="status-countdown">${this._t("remaining_hold", { v: formatted })}</div>
    `;
  }

  /**
   * Render des Temperaturverlauf-Graphen (Req 13.1, 13.2). Zeichnet die
   * aufgezeichnete Ist-Temperatur und — sofern vorhanden — die Solltemperatur
   * in einer anderen Farbe als SVG-Polyline. Darunter befinden sich die
   * Bedienelemente zur Wahl der Anzeigedauer (1–4 h, Req 13.3) und zur
   * Daueranzeige der aktuellen Temperatur ohne aktiven Brauvorgang (Req 13.4).
   *
   * @returns {import("lit").TemplateResult}
   */
  _renderGraph() {
    // Native history-graph-Karte einbetten (echte Recorder-Historie). Beim
    // ersten Aufruf asynchron erzeugen; bis dahin einen Platzhalter zeigen.
    this._ensureGraphCard();

    const hoursSelector = html`
      <div class="graph-header">
        <span class="graph-title">${this._t("graph_title")}</span>
        <label class="graph-hours-label">
          ${this._t("duration")}
          <select
            class="graph-hours"
            @change=${(e) => this._setGraphHours(e.target.value)}
          >
            ${[1, 2, 3, 4].map(
              (h) => html`<option value=${h} ?selected=${this._graphHours === h}>${h} h</option>`
            )}
          </select>
        </label>
      </div>
    `;

    let body;
    if (!this._configuredSensor) {
      body = html`<div class="placeholder">${this._t("select_sensor_first")}</div>`;
    } else if (this._graphCard) {
      // Das eingebettete Karten-Element direkt rendern (Lit akzeptiert DOM-Nodes).
      body = this._graphCard;
    } else {
      body = html`<div class="placeholder">${this._t("loading_graph")}</div>`;
    }

    return html`
      <div class="graph">
        ${hoursSelector}
        ${body}
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
            ${this._t("next_rest")}
          </button>
          <button class="btn btn-danger" @click=${() => this._stop()}>
            ${this._t("stop")}
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
          title=${startDisabled ? this._t("start_disabled_tt") : this._t("start_tt")}
          @click=${() => this._start()}
        >
          ${this._t("start")}
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
          ? html`<div class="placeholder">${this._t("no_rests")}</div>`
          : html`
              <ol class="steps">
                ${recipe.map((step, i) => this._renderStep(step, i, running, active, showMarkers, recipe.length))}
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
                ${this._t("clear_all")}
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
   * @param {number} total         Gesamtzahl der Rasten (für Verschiebe-Grenzen).
   * @returns {import("lit").TemplateResult}
   */
  _renderStep(step, i, running, active, showMarkers, total) {
    if (this._editIndex === i) {
      return html`
        <li class="step editing">
          <div class="edit-row">
            <input
              id="edit-name"
              type="text"
              placeholder=${this._t("name_optional")}
              .value=${step.name ?? ""}
            />
            <input
              id="edit-temp"
              type="number"
              min="0"
              max="100"
              step="0.5"
              placeholder=${this._unit}
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
              ${this._t("save")}
            </button>
            <button class="btn" @click=${() => this._cancelEdit()}>
              ${this._t("cancel")}
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
          <span class="step-detail">${this._t("step_detail", { temp: step.temperature, dur: step.duration, unit: this._unit })}</span>
        </span>
        <span class="step-actions">
          <button
            class="icon-btn"
            title=${this._t("move_up_tt")}
            ?disabled=${running || i === 0}
            @click=${() => this._moveStep(i, -1)}
          >
            ▲
          </button>
          <button
            class="icon-btn"
            title=${this._t("move_down_tt")}
            ?disabled=${running || i === total - 1}
            @click=${() => this._moveStep(i, 1)}
          >
            ▼
          </button>
          <button
            class="icon-btn"
            title=${this._t("edit_tt")}
            ?disabled=${running}
            @click=${() => this._beginEdit(i)}
          >
            ✎
          </button>
          <button
            class="icon-btn"
            title=${this._t("delete_tt")}
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
          placeholder=${this._t("name_optional")}
          ?disabled=${running}
        />
        <input
          id="new-temp"
          type="number"
          min="0"
          max="100"
          step="0.5"
          placeholder=${this._unit}
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
          ${this._t("add_rest")}
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
        <h3>${this._t("settings_tt")}</h3>

        <label class="field-label" for="settings-sensor">${this._t("sensor_label")}</label>
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

        <label class="field-label" for="settings-heater">${this._t("heater_label")}</label>
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

        <label class="field-label" for="settings-hysteresis">
          ${this._t("hysteresis_label", { unit: this._unit })}
        </label>
        <input
          id="settings-hysteresis"
          class="field"
          type="number"
          min="0.1"
          max="5"
          step="0.1"
          placeholder="1.0"
          .value=${String(this._hysteresis)}
        />

        <label class="field-label" for="settings-unit">${this._t("unit_label")}</label>
        <select
          id="settings-unit"
          class="field"
          @change=${(e) => this._setUnit(e.target.value)}
        >
          <option value="°C" ?selected=${this._unit === "°C"}>°C</option>
          <option value="°F" ?selected=${this._unit === "°F"}>°F</option>
        </select>

        <div class="settings-actions">
          <button class="btn btn-primary" @click=${() => this._saveSettings()}>
            ${this._t("save")}
          </button>
          <button class="btn" @click=${() => this._toggleSettings()}>
            ${this._t("close")}
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

  /** @returns {string} Oberflächensprache aus dem Helfer (Default en). */
  get _lang() {
    return resolveLanguage(this.hass?.states?.[ENTITY.LANGUAGE]?.state);
  }

  render() {
    const t = (key) => translate(this._lang, key);
    return html`
      <div style="padding:8px;">
        <p style="font-size:0.9em;color:var(--secondary-text-color);">
          ${t("editor_note")}
        </p>
        <label style="font-size:0.85em;">${t("editor_sensor")}</label>
        <input
          style="width:100%;padding:8px;margin-bottom:8px;border:1px solid #ccc;border-radius:4px;box-sizing:border-box;"
          .value=${this._config?.sensor_entity || ""}
          @change=${(e) => this._fire("sensor_entity", e.target.value)}
          placeholder="sensor.brau_temperatur"
        />
        <label style="font-size:0.85em;">${t("editor_heater")}</label>
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
// Registrierung (idempotent — verhindert "already been used"-DOMException,
// falls das Modul von Home Assistant mehrfach ausgewertet wird)
// ============================================================================
if (!customElements.get("brausteuerung-card")) {
  customElements.define("brausteuerung-card", BrausteuerungCard);
}
if (!customElements.get("brausteuerung-card-editor")) {
  customElements.define("brausteuerung-card-editor", BrausteuerungCardEditor);
}

window.customCards = window.customCards || [];
if (!window.customCards.some((c) => c.type === "brausteuerung-card")) {
  window.customCards.push({
    type: "brausteuerung-card",
    name: `Brew Control / Brausteuerung (v${VERSION})`,
    description:
      "Brew/mash control for homebrewers — Brausteuerung für Hobbybrauer (EN/DE)",
  });
}

// Versionshinweis in der Browser-Konsole (hilft beim Verifizieren nach Updates).
console.info(`%c brausteuerung-card %c v${VERSION} `,
  "color:white;background:#03a9f4;font-weight:700",
  "color:#03a9f4;background:white;font-weight:700");
