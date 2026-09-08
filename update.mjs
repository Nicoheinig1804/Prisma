// Prisma – tägliche Aktualisierung.
// Läuft in GitHub Actions: entschlüsselt data.enc.json, holt Kurse, rechnet,
// hängt einen neuen Bericht an, verschlüsselt wieder.
//
// Aufruf:  PRISMA_PASSPHRASE="..." node update.mjs
// Testlauf ohne Schreiben:  PRISMA_PASSPHRASE="..." node update.mjs --dry

import { readFileSync, writeFileSync } from "node:fs";
import crypto from "node:crypto";

const PASS = process.env.PRISMA_PASSPHRASE;
const DRY = process.argv.includes("--dry");
if (!PASS || PASS.length < 8) {
  console.error("FEHLER: PRISMA_PASSPHRASE fehlt oder ist zu kurz.");
  process.exit(1);
}
const ITER = 250000;
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36";

/* ---------------- Ver- und Entschlüsseln ---------------- */
function entschluesseln(paket, pass) {
  const key = crypto.pbkdf2Sync(pass, Buffer.from(paket.salt, "base64"), paket.iter, 32, "sha256");
  const roh = Buffer.from(paket.ct, "base64");
  const ct = roh.subarray(0, roh.length - 16);
  const tag = roh.subarray(roh.length - 16);
  const d = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(paket.iv, "base64"));
  d.setAuthTag(tag);
  return JSON.parse(Buffer.concat([d.update(ct), d.final()]).toString("utf8"));
}

function verschluesseln(daten, pass) {
  const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12);
  const key = crypto.pbkdf2Sync(pass, salt, ITER, 32, "sha256");
  const c = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(Buffer.from(JSON.stringify(daten), "utf8")), c.final(), c.getAuthTag()]);
  const stand = (daten.berichte || []).map(b => b.datum).sort().pop() || null;
  return {
    v: 1, kdf: "PBKDF2-SHA256", iter: ITER,
    salt: salt.toString("base64"), iv: iv.toString("base64"), ct: ct.toString("base64"),
    stand, berichte: (daten.berichte || []).length, erzeugt: new Date().toISOString()
  };
}

/* ---------------- Kurse ---------------- */
async function holen(url) {
  const r = await fetch(url, { headers: { "User-Agent": UA, "Accept": "application/json" } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

// ISIN -> Börsenkürzel. Deutsche Notierungen bevorzugt, damit der Kurs in Euro steht.
const RANG = [".DE", ".F", ".SG", ".BE", ".MU", ".DU", ".HM", ".VI", ".AS", ".MI", ".PA", ".L"];

// Rückfallebene, falls die ISIN-Suche nicht antwortet. Nur allgemein bekannte Kürzel.
const NOTFALL = {
  world: ["EUNL.DE", "IWDA.AS"],
  aw:    ["VWCE.DE", "VWRA.L"],
  nvda:  ["NVD.DE", "NVDA"],
  pltr:  ["PTX.DE", "PLTR"],
  orcl:  ["ORC.DE", "ORCL"]
};

async function symbolFinden(isin) {
  const j = await holen(`https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(isin)}&quotesCount=25&newsCount=0`);
  const treffer = (j.quotes || []).map(q => q.symbol).filter(Boolean);
  if (!treffer.length) return null;
  for (const suffix of RANG) {
    const s = treffer.find(x => x.endsWith(suffix));
    if (s) return s;
  }
  return treffer[0];
}

async function kursHolen(symbol) {
  const j = await holen(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=5d&interval=1d`);
  const m = j?.chart?.result?.[0]?.meta;
  if (!m || typeof m.regularMarketPrice !== "number") throw new Error("kein Kurs im Ergebnis");
  return { preis: m.regularMarketPrice, waehrung: m.currency, zeit: m.regularMarketTime || null };
}

let EURUSD = null;
async function nachEuro(betrag, waehrung) {
  if (!waehrung || waehrung === "EUR") return betrag;
  if (waehrung === "GBp") return (betrag / 100) / (await gbpEur());
  if (EURUSD === null) {
    const j = await holen("https://query1.finance.yahoo.com/v8/finance/chart/EURUSD=X?range=5d&interval=1d");
    EURUSD = j?.chart?.result?.[0]?.meta?.regularMarketPrice || null;
  }
  if (waehrung === "USD" && EURUSD) return betrag / EURUSD;
  throw new Error(`Währung ${waehrung} nicht umrechenbar`);
}
async function gbpEur() {
  const j = await holen("https://query1.finance.yahoo.com/v8/finance/chart/EURGBP=X?range=5d&interval=1d");
  const k = j?.chart?.result?.[0]?.meta?.regularMarketPrice;
  if (!k) throw new Error("EURGBP fehlt");
  return k;
}

/* ---------------- Texte ---------------- */
const TIPPS = JSON.parse(readFileSync("tipps.json", "utf8"));

function tippWaehlen(berichte) {
  const schon = new Set(berichte.slice(-20).map(b => b?.tipp?.titel).filter(Boolean));
  const frei = TIPPS.filter(t => !schon.has(t.titel));
  const pool = frei.length ? frei : TIPPS;
  const tag = Math.floor(Date.now() / 86400000);
  return pool[tag % pool.length];
}

function schlagzeile(pct, best, schlecht) {
  const a = Math.abs(pct ?? 0);
  if (pct == null) return "Erster Stand – ab morgen gibt es einen Vergleich.";
  if (a < 0.15) return "Ein ruhiger Tag – das Depot steht praktisch still.";
  if (a < 0.7) return pct > 0
    ? `Leicht im Plus, getragen von ${best}.`
    : `Leicht im Minus, vor allem wegen ${schlecht}.`;
  if (a < 2) return pct > 0
    ? `Ein guter Tag: ${best} zieht das Depot nach oben.`
    : `Ein schwacher Tag: ${schlecht} drückt am stärksten.`;
  return pct > 0
    ? `Deutlich im Plus – ${best} führt die Bewegung an.`
    : `Deutlich im Minus – ${schlecht} verliert am meisten.`;
}

/* ---------------- Hauptlauf ---------------- */
const paket = JSON.parse(readFileSync("data.enc.json", "utf8"));
const daten = entschluesseln(paket, PASS);
const stamm = daten.stammdaten || {};
const berichte = (daten.berichte || []).slice().sort((a, b) => (a.datum < b.datum ? -1 : 1));
const vorher = berichte[berichte.length - 1] || null;
const heute = new Date().toISOString().slice(0, 10);

const hinweise = [];
const positionen = [];

for (const p of (stamm.positionen || [])) {
  const alt = vorher?.positionen?.find(x => x.key === p.key) || null;
  let kurs = null, quelle = null;
  try {
    const kandidaten = [];
    if (p.symbol) kandidaten.push(p.symbol);
    if (p.isin) {
      try {
        const s = await symbolFinden(p.isin);
        if (s) kandidaten.push(s);
      } catch (e) { console.log(`  ${p.key.padEnd(6)} ISIN-Suche fehlgeschlagen: ${e.message}`); }
    }
    kandidaten.push(...(NOTFALL[p.key] || []));
    if (!kandidaten.length) throw new Error("kein Börsenkürzel bekannt");

    let letzter = null;
    for (const sym of kandidaten) {
      try {
        const k = await kursHolen(sym);
        kurs = await nachEuro(k.preis, k.waehrung);
        quelle = `${sym} (${k.waehrung})`;
        console.log(`  ${p.key.padEnd(6)} ${sym.padEnd(12)} ${kurs.toFixed(4)} EUR`);
        break;
      } catch (e) { letzter = e; }
    }
    if (kurs == null) throw letzter || new Error("kein Kurs erhältlich");
  } catch (e) {
    kurs = alt?.kurs ?? null;
    hinweise.push(`${p.name}: Kurs konnte nicht geholt werden (${e.message}) – Wert vom letzten Bericht übernommen.`);
    console.log(`  ${p.key.padEnd(6)} FEHLER: ${e.message}`);
  }
  const wert = kurs != null && p.shares != null
    ? Math.round(kurs * p.shares * 100) / 100
    : (alt?.wert ?? 0);
  positionen.push({
    key: p.key, name: p.name, sub: p.sub, kind: p.kind,
    shares: p.shares, kurs: kurs != null ? Math.round(kurs * 100) / 100 : null,
    wert, invested: p.invested
  });
}

const wert = Math.round(positionen.reduce((s, p) => s + p.wert, 0) * 100) / 100;
const eingezahlt = stamm.eingezahltStand ?? (vorher?.eingezahlt ?? 0);
const tagEuro = vorher ? Math.round((wert - vorher.wert) * 100) / 100 : null;
const tagPct = vorher && vorher.wert ? Math.round((tagEuro / vorher.wert) * 10000) / 100 : null;

// Stärkste und schwächste Position seit dem letzten Bericht
let best = "den ETFs", schlecht = "den ETFs";
if (vorher?.positionen) {
  const bew = positionen.map(p => {
    const a = vorher.positionen.find(x => x.key === p.key);
    return a && a.wert > 0 ? { name: p.name, d: (p.wert - a.wert) / a.wert } : null;
  }).filter(Boolean).sort((x, y) => y.d - x.d);
  if (bew.length) { best = bew[0].name; schlecht = bew[bew.length - 1].name; }
}

// Nach einer Sparplan-Ausführung stimmen Stückzahlen und Einzahlung nicht mehr
const tag = new Date().getUTCDate();
const nachAusfuehrung = tag > (stamm.sparplanTag ?? 16);
if (nachAusfuehrung && !stamm.aktualisiertNachAusfuehrung) {
  hinweise.push("Seit der letzten Sparplan-Ausführung sind die Stückzahlen nicht nachgetragen – frag Claude nach einem Abgleich mit der App.");
}

const bericht = {
  datum: heute,
  kursstand: "Kurse über Yahoo Finance, deutsche Notierungen; Zeitstempel je Papier unterschiedlich.",
  vorlaeufig: nachAusfuehrung,
  vorlaufhinweis: nachAusfuehrung ? "Stückzahlen stammen von vor der letzten Sparplan-Ausführung." : "",
  schlagzeile: schlagzeile(tagPct, best, schlecht),
  dek: "Automatisch erzeugter Tagesstand. Die Einordnung in der Analyse aktualisiert Claude, wenn du danach fragst.",
  wert, eingezahlt, sparrate: stamm.sparrate ?? 40,
  tagPct, tagEuro, hinweise,
  tipp: tippWaehlen(berichte),
  positionen
};

const alteOhneHeute = berichte.filter(b => b.datum !== heute);
daten.berichte = [...alteOhneHeute, bericht].slice(-400);

console.log(`\nDepotwert ${wert.toFixed(2)} EUR (${tagPct == null ? "kein Vergleich" : tagPct.toFixed(2) + " %"}), ${hinweise.length} Hinweise, ${daten.berichte.length} Berichte gespeichert.`);

if (DRY) { console.log("Testlauf – nichts geschrieben."); process.exit(0); }
writeFileSync("data.enc.json", JSON.stringify(verschluesseln(daten, PASS)));
console.log("data.enc.json aktualisiert.");
