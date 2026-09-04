# Prisma

Eine private Depot-App als statische Seite. Alle Zahlen liegen ausschließlich
verschlüsselt in `data.enc.json` (AES-256-GCM, Schlüssel via PBKDF2-SHA256 mit
250.000 Runden aus einer Passphrase). Ohne die Passphrase enthält dieses
Repository keine lesbaren Depotdaten.

Entschlüsselt wird ausschließlich im Browser (WebCrypto), nichts wird an einen
Server gesendet.

Unverschlüsselt lesbar bleiben nur zwei Angaben in `data.enc.json`: das Datum des
letzten Berichts und die Anzahl der Berichte. Alles Übrige – Positionen, Kurse,
Beträge – steckt im Chiffretext.

* `index.html` – die App
* `data.enc.json` – verschlüsselte Berichte, wird täglich neu erzeugt
* `icon-*.png`, `manifest.webmanifest` – Symbol und Web-App-Metadaten

Keine Anlageberatung.
