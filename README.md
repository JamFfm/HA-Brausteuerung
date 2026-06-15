# Under Construction, not running jet
#
#
# 🍺 Brausteuerung für Home Assistant

Die Brausteuerung ist eine auf Home Assistant basierende Sudhaus-/Maischesteuerung
für Hobbybrauer. Sie ist für den Betrieb auf einem **Raspberry Pi 4** ausgelegt und
ermöglicht das Erstellen und automatische Abarbeiten von Braurezepten mit mehreren
Raststufen.

Jede Raststufe besteht aus einem Namen, einer Solltemperatur und einer Haltezeit.
Die Steuerung liest die Ist-Temperatur aus einer Home-Assistant-Temperatursensor-
Entität, regelt einen Heizungs-Aktor (Schalter) per Hysterese auf die Solltemperatur
und wechselt nach Ablauf der Haltezeit automatisch zur nächsten Raststufe. Die
Bedienung erfolgt über eine Custom Lovelace Card.

> ⚠️ **Sicherheit zuerst:** Diese Software ersetzt **keinen** unabhängigen
> Hardware-Schutz. Bitte lies vor der Inbetriebnahme den Abschnitt
> [Wichtige Sicherheitshinweise](#-wichtige-sicherheitshinweise).

---

## Lieferbestandteile

Die Brausteuerung besteht aus den folgenden Dateien:

| Datei | Beschreibung |
|---|---|
| `www/brausteuerung-card.js` | Die Custom Lovelace Card als JavaScript-Modul (LitElement). |
| `www/brausteuerung-logic.js` | Reines Logikmodul, das die Card importiert. **Muss zusammen mit der Card im selben Ordner liegen** (Import `./brausteuerung-logic.js`). |
| `configuration.yaml` | Die benötigten Home-Assistant-Helfer (Single Source of Truth für den Zustand). |
| `automations.yaml` | Die Steuerungslogik als 5 Home-Assistant-Automationen. |
| `README.md` | Diese Installationsanleitung. |

Die 5 Automationen in `automations.yaml`:

| Automation | Aufgabe |
|---|---|
| `brausteuerung_raststufe` | Heizt auf, hält per Hysterese während der Haltezeit, wechselt die Stufe und schließt nach der letzten Rast ab. |
| `brausteuerung_notaus` | Schaltet die Heizung aus und bricht den Timer ab, sobald der Status `running` verlässt (Stop). |
| `brausteuerung_manueller_wechsel` | Durch die Card ausgelöst: bricht den Timer ab und springt zur nächsten Rast bzw. schließt bei der letzten Rast ab. |
| `brausteuerung_uebertemperatur` | Schaltet bei Übertemperatur die Heizung aus, setzt den Status auf `paused` und benachrichtigt. |
| `brausteuerung_komm_verlust` | Schaltet bei Kommunikationsverlust zum Sensor die Heizung aus und benachrichtigt. |

---

## Voraussetzungen

- **Home Assistant** (z. B. auf einem Raspberry Pi 4), mit Zugriff auf die
  Konfigurationsdateien (`configuration.yaml`, `automations.yaml`) und das
  `www/`-Verzeichnis.
- Eine **Temperatursensor-Entität** der Domäne `sensor.*`, die die Ist-Temperatur
  der Maische liefert (z. B. `sensor.ds18b20_maische`).
- Ein **Heizungs-Aktor** der Domäne `switch.*`, der das Heizelement schaltet
  (z. B. `switch.shelly_heizstab`).
- Optional **Node.js** — nur erforderlich, um die mitgelieferten Entwickler-Tests
  lokal auszuführen (siehe [Entwicklung & Tests](#entwicklung--tests)). Für den
  reinen Betrieb der Brausteuerung wird Node.js **nicht** benötigt.

---

## Installation

### 1. Card und Logikmodul kopieren

Kopiere **beide** Dateien in das `www/`-Verzeichnis deiner Home-Assistant-
Konfiguration (`<config>/www/`):

```
<config>/www/brausteuerung-card.js
<config>/www/brausteuerung-logic.js
```

Beide Dateien **müssen im selben Ordner** liegen, da die Card das Logikmodul über
einen relativen Import einbindet:

```javascript
import { ... } from './brausteuerung-logic.js';
```

Liegt `brausteuerung-logic.js` nicht neben der Card, kann der Browser den Import
nicht auflösen und die Karte bleibt leer.

### 2. Als Lovelace-Ressource einbinden

Gehe zu **Einstellungen → Dashboards → Ressourcen → Ressource hinzufügen** und
trage ein:

- **URL:** `/local/brausteuerung-card.js`
- **Typ:** `JavaScript-Modul` (`module`)

> Das Verzeichnis `<config>/www/` ist in Home Assistant unter dem URL-Pfad
> `/local/` erreichbar. Das Logikmodul muss **nicht** separat als Ressource
> eingetragen werden — es wird automatisch durch den relativen Import der Card
> nachgeladen.

### 3. Helfer anlegen

Übernimm die Einträge aus `configuration.yaml` in deine Home-Assistant-
Konfiguration. Falls du bereits `input_text`-, `input_select`-, `input_number`-
oder `timer`-Abschnitte hast, füge die Einträge dort ein (Domänenschlüssel nicht
doppeln).

Folgende Helfer werden angelegt:

| Helfer | Domäne | Inhalt |
|---|---|---|
| `brau_rezept_json` | `input_text` | Rezept als JSON-Array (max. 255 Zeichen). |
| `brau_sensor_entity` | `input_text` | Entity-ID des Temperatursensors. |
| `brau_heater_entity` | `input_text` | Entity-ID des Heizungs-Aktors. |
| `brau_status` | `input_select` | Betriebszustand: `idle` / `running` / `paused` / `done`. |
| `brau_aktuelle_stufe` | `input_number` | Index der aktiven Raststufe (0–20). |
| `brau_solltemperatur` | `input_number` | Aktive Solltemperatur in °C (0–100). |
| `brau_sicherheits_offset` | `input_number` | Sicherheits-Offset über der Solltemperatur in °C (0–20, **Default 5**). |
| `brau_raststufe` | `timer` | Haltezeit-Timer der aktiven Raststufe. |

Anschließend **Konfiguration prüfen und neu laden** bzw. Home Assistant neu
starten: **Entwicklerwerkzeuge → YAML → Konfiguration prüfen**, danach die Helfer
(bzw. „Alle YAML-Konfigurationen") neu laden oder Home Assistant neu starten.

### 4. Automationen hinzufügen

Übernimm die Einträge aus `automations.yaml` in deine Automationen. Die Datei ist
eine YAML-Liste; hänge die 5 Automationen als zusätzliche Listeneinträge an. Lade
anschließend die Automationen neu (**Entwicklerwerkzeuge → YAML → Automationen neu
laden**) oder starte Home Assistant neu.

Die 5 Automationen und ihre Aufgaben sind oben unter
[Lieferbestandteile](#lieferbestandteile) beschrieben.

### 5. Karte zum Dashboard hinzufügen

Füge im Dashboard eine manuelle Karte hinzu (**Karte hinzufügen → Manuell**):

```yaml
type: custom:brausteuerung-card
```

Konfiguriere danach über das ⚙️-Symbol auf der Karte die Entitäten:

1. Klicke auf der Karte auf **⚙️**.
2. Trage im **Sensor**-Feld die Entity-ID deines Temperatursensors ein
   (Domäne `sensor.*`, z. B. `sensor.ds18b20_maische`). Während des Tippens
   werden passende Entitäten vorgeschlagen.
3. Trage im **Heizung**-Feld die Entity-ID deines Heizungs-Aktors ein
   (Domäne `switch.*`, z. B. `switch.shelly_heizstab`).
4. Speichern. Die Auswahl wird persistent in Home Assistant gespeichert.

---

## Bedienung

### Rezept / Raststufen anlegen

Gib für jede Raststufe Folgendes ein:

- **Name** — optional. Bleibt das Feld leer, vergibt die Card automatisch den
  Standardnamen `Rast N` (mit `N` = Position der Rast).
- **Solltemperatur** — gültig sind Werte von **0 °C bis 100 °C**.
- **Haltezeit** — gültig sind **ganze Minuten größer als 0**.

Ungültige Eingaben (Solltemperatur außerhalb 0–100 °C, Haltezeit ≤ 0 oder keine
ganze Zahl) werden **nicht** übernommen; das Rezept bleibt unverändert.

Raststufen können vor dem Start über **✎** editiert und über **✕** gelöscht werden.
Die Reihenfolge der Rasten bleibt dabei erhalten und entspricht der
Abarbeitungsreihenfolge.

> **255-Zeichen-Grenze:** Das Rezept wird als JSON-String im Helfer
> `input_text.brau_rezept_json` gespeichert. `input_text` ist auf **255 Zeichen**
> begrenzt. Überschreitet das serialisierte Rezept diese Grenze, lehnt die Card das
> Hinzufügen/Speichern ab und das bisher gespeicherte Rezept bleibt unverändert.
> In der Praxis sind damit ca. 4–5 Rasten mit kurzen Namen möglich. Tipp: kürzere
> Namen verwenden oder weniger Rasten anlegen.

### Brauprozess steuern

- **▶ Start** — startet mit der ersten Raststufe und setzt den Status auf `running`.
  Start ist nur verfügbar, wenn das Rezept mindestens eine Raststufe enthält **und**
  eine gültige Ist-Temperatur vorliegt.
- **⏹ Stop** — schaltet die Heizung sofort aus und bricht den laufenden Timer ab.
- **⏭ Nächste Rast** — manueller Stufenwechsel: bricht den laufenden Timer ab und
  springt zur nächsten Rast. Auf der letzten Rast wird damit der Brauprozess
  abgeschlossen (Heizung aus, Status `done`, Benachrichtigung).

---

## Regelung & Sicherheit

### Hysterese-Band (1,0 °C)

Während der Haltephase regelt die Steuerung die Ist-Temperatur mit einem
Hystereseband von **1,0 °C** unterhalb der Solltemperatur:

- Ist-Temperatur **< Soll − 1,0 °C** → Heizung **AN**
- Ist-Temperatur **≥ Soll** → Heizung **AUS**
- Ist-Temperatur **im Band** (Soll − 1,0 °C ≤ Ist < Soll) → Zustand bleibt
  unverändert

### Sicherheits-Offset und Übertemperaturschutz

Der Helfer `input_number.brau_sicherheits_offset` (Default **5 °C**) definiert den
Abstand oberhalb der Solltemperatur, ab dem eine Übertemperatur erkannt wird. Der
**Sicherheitsschwellwert** berechnet sich als:

```
Schwellwert = Solltemperatur + Sicherheits-Offset
```

Dieser Schwellwert wird auf der Karte angezeigt. Überschreitet die Ist-Temperatur
den Schwellwert, schaltet die Automation `brausteuerung_uebertemperatur` die
Heizung sofort aus, setzt den Status auf `paused` (wodurch die Regelschleifen
terminieren) und erzeugt eine Benachrichtigung. Die Fortsetzung erfordert eine
bewusste Benutzeraktion.

### Kommunikationsverlust

Liefert die konfigurierte Sensor-Entität während eines laufenden Prozesses
(`running`) für eine definierte Dauer den Wert `unavailable` oder `unknown`,
schaltet die Automation `brausteuerung_komm_verlust` die Heizung aus und erzeugt
eine Benachrichtigung. So wird unkontrolliertes Aufheizen ohne gültigen Messwert
verhindert.

Die Toleranzdauer ist über die Konstante **`KOMM_VERLUST_DAUER` (Default 30 s)**
festgelegt. Kurze Aussetzer lösen also nicht aus. Soll die Dauer angepasst werden,
ist ausschließlich der `for: { seconds: 30 }`-Wert im Trigger der Automation
`brausteuerung_komm_verlust` in `automations.yaml` zu ändern.

---

## ⚠️ Wichtige Sicherheitshinweise

Die Brausteuerung steuert reale Hardware mit hohen Temperaturen. Die folgenden
Hinweise sind **zwingend** zu beachten:

- **Unabhängiger Hardware-Übertemperaturschutz (erforderlich):** Zusätzlich zur
  Software-Überwachung ist ein vom System **unabhängiger** Hardware-
  Übertemperaturschutz (z. B. ein mechanischer Temperaturbegrenzer / STB) zu
  verwenden. Er muss unabhängig von Home Assistant, der Sensor-Entität und den
  Automationen wirken.
- **Physische Abschaltbarkeit bei HA-Ausfall (erforderlich):** Der Heizungs-Aktor
  **muss** bei einem Ausfall von Home Assistant physisch abschalten können. Wähle
  einen Aktor, der im stromlosen bzw. nicht angesteuerten Zustand öffnet
  (Heizung aus), sodass ein Software- oder Verbindungsausfall nicht zu
  unkontrolliertem Heizen führt.
- Betreibe die Anlage **nie unbeaufsichtigt**.

---

## Entwicklung & Tests

Die reine Card-Logik (`www/brausteuerung-logic.js`) ist mit
[Vitest](https://vitest.dev/) und Property-Tests via
[fast-check](https://github.com/dubzzz/fast-check) abgedeckt. Für die
Ausführung der Tests ist **Node.js erforderlich**.

```bash
# Abhängigkeiten installieren
npm install

# Tests einmalig ausführen
npm run test:run
```

Die Tests prüfen u. a. Rezept-Validierung, Serialisierung (255-Zeichen-Grenze),
die Hysterese-Schaltlogik und die Sicherheitsinvariante (Heizung aus bei Gefahr).
Für den Betrieb der Brausteuerung in Home Assistant sind diese Schritte **nicht**
notwendig.
