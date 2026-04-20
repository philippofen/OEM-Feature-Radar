# OEM Feature Radar DE

Täglicher Feature-Monitor für die deutschen Websites von BMW, Audi,
Mercedes-Benz, Porsche und VW – in den Bereichen **Fahrzeugkonfigurator**
und **Neu-/Gebrauchtwagenverkauf**.

System findet sichtbare, funktional neue Features (oder große Entfernungen),
klassifiziert sie mit Claude + GPT-4o-mini als Zweitmeinung, dedupliziert per
Embedding und veröffentlicht kurze Posts auf einer öffentlichen Website.

---

## Setup (lokal)

### 1. Voraussetzungen

- Node.js 20+
- npm (oder pnpm)
- Supabase-Projekt (DB + Storage)
- Anthropic API Key
- OpenAI API Key

### 2. Install

```bash
npm install
npx playwright install chromium --with-deps
```

### 3. Supabase vorbereiten

Im Supabase-SQL-Editor ausführen:

```bash
db/schema.sql
```

Dann im Storage einen Bucket anlegen:

- Name: `oem-snapshots`
- Public: **ja** (für Screenshot-URLs im Frontend)

### 4. ENV konfigurieren

```bash
cp .env.example .env
# Werte eintragen
```

### 5. Seed

```bash
npm run seed
```

Legt OEMs, Tag-Vokabular und je 8 URLs für BMW und Audi an.

### 6. Erster Testlauf

```bash
# Nur BMW, kein Post publishen (Kandidaten nur loggen)
npx tsx scripts/run-daily.ts --oem bmw --dry-run

# Nur Audi, mit Publishing
npm run run:daily:audi
```

Der erste Run erzeugt nur Baseline-Snapshots (keine Posts, da kein Vortag
vorhanden). Ab dem zweiten Run entstehen Kandidaten.

---

## Betrieb (GitHub Actions)

Die Action `daily-crawl.yml` läuft täglich um 06:00 UTC und crawlt alle
fünf OEMs parallel als Matrix-Jobs.

### Secrets einrichten

Unter **Repo → Settings → Secrets and variables → Actions**:

| Secret | Beschreibung |
|---|---|
| `SUPABASE_URL` | Supabase Project URL |
| `SUPABASE_SERVICE_KEY` | Service-Role-Key (NICHT anon) |
| `ANTHROPIC_API_KEY` | Anthropic API Key |
| `OPENAI_API_KEY` | OpenAI API Key |
| `PROXY_URL` | Optional: Residential-Proxy-URL (erst scharf schalten, wenn OEMs blocken) |

Optional als Variable: `STORAGE_BUCKET` (Default: `oem-snapshots`).

### Manuelle Ausführung

Über die Actions-UI → "Daily OEM Crawl" → "Run workflow":
- OEM-Filter für einen einzelnen Slug oder alle
- Dry-Run-Toggle

---

## Projekt-Struktur

```
oem-radar/
├── .github/workflows/daily-crawl.yml   # Cron-Trigger + Matrix
├── crawler/
│   └── core/
│       ├── browser.ts                   # Playwright-Launch + Cookie-Banner
│       ├── snapshot.ts                  # DOM/Screenshot/Text → Storage
│       └── inventory.ts                 # UI-Inventory-JSON-Extraktion
├── classifier/
│   ├── diff.ts                          # Deterministische Diff-Engine
│   ├── claude.ts                        # Anthropic-Wrapper
│   ├── openai.ts                        # GPT-4o-mini + Embeddings
│   └── pipeline.ts                      # Orchestrierung pro Kandidat
├── scripts/
│   └── run-daily.ts                     # Haupt-Einstiegspunkt
├── db/
│   ├── schema.sql                       # Postgres-Schema
│   └── seed.ts                          # OEMs + URLs + Tags seeden
├── shared/
│   └── config.ts                        # ENV + Limits
├── .env.example
├── package.json
├── tsconfig.json
└── README.md
```

---

## Quality-Gates (fest im Code)

Ein Kandidat wird nur publiziert, wenn **alle** Bedingungen erfüllt sind:

1. Claude: `verdict=feature` und `confidence >= 0.75`
2. GPT-4o-mini: gleiche Verdict-Klasse
3. Embedding-Ähnlichkeit zu allen Posts der letzten 60 Tage (gleicher OEM + Bereich) unter 0.92; Grauzone 0.78–0.92 → LLM-Dedup-Check
4. Pro OEM+Bereich pro Run max. 3 Posts (Redesign-Schutz)

Schieberegler sitzen zentral in `shared/config.ts` und `classifier/pipeline.ts`
(Konstanten `CONFIDENCE_GATE`, `DEDUP_AUTO_DUPLICATE`, `DEDUP_UNIQUE_THRESHOLD`,
`PIPELINE_LIMITS`).

---

## Frontend

Das Public Frontend wird in **Lovable** gebaut, liest direkt aus Supabase.
Tabellen, die RLS-public lesbar sind: `feature_posts (is_visible=true)`,
`tags`, `post_tags`. Insert auf `newsletter_subscribers` ist für anonyme
Nutzer erlaubt (kein Read).

---

## Troubleshooting

**„Keine Kandidaten, obwohl Seite sich geändert hat"**
→ Erwartbar, wenn die Änderung rein textlich/kosmetisch ist. Die Diff-Engine
ist absichtlich streng. Siehe `classifier/diff.ts` → harte Ausschlussregeln.

**„OEM blockt mit 403 / CAPTCHA"**
→ `PROXY_URL` mit Residential-Proxy setzen (Scrapfly, Bright Data). Wenn
auch das nicht reicht: Request-Intervall in `CRAWL_LIMITS.perOemRateDelayMs`
erhöhen.

**„Snapshot ist leer / Consent-Wall"**
→ Cookie-Banner-Selektor für diesen OEM in `crawler/core/browser.ts`
erweitern. Dann erneut laufen lassen.

**„Posts doppelt"**
→ Ähnlichkeitsschwellen in `classifier/pipeline.ts` anpassen
(`DEDUP_AUTO_DUPLICATE`). Embedding-Feld in älteren Posts prüfen.
