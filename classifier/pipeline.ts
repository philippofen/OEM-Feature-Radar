/**
 * classifier/pipeline.ts
 * ---------------------------------------------------------------------------
 * Orchestriert einen einzelnen `ChangeCandidate` durch:
 *   1. Claude-Klassifikation            (classify_feature.md – inline hier)
 *   2. GPT-4o-mini-Validator            (Zweit-Meinung)
 *   3. Dedup                            (Embedding + pgvector + Grauzone)
 *   4. Post-Generierung                 (generate_post.md – inline hier)
 *   5. Tag-Extraktion                   (extract_tags.md – inline hier)
 *
 * Ergebnis:
 *   - Bei Erfolg: `PipelineSuccess` mit feature_post-Feldern, bereit zum Insert.
 *   - Bei Ablehnung: `PipelineRejection` mit Grund (für change_candidates-Update).
 *
 * Der Aufrufer (scripts/run-daily.ts) schreibt die DB-Rows. Die Pipeline
 * selbst führt keine DB-Writes aus – sie bleibt pure, damit sie testbar ist.
 * Einzige Ausnahme: der Dedup-Check braucht einen DB-Zugriff, also bekommt
 * die Pipeline einen `DedupStore`-Port injiziert.
 * ---------------------------------------------------------------------------
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import type { UiInventory } from '../crawler/core/inventory';
import type { ChangeCandidate } from './diff';
import { callClaudeJson } from './claude';
import { callValidatorJson, embedText, EMBEDDING_DIM } from './openai';

// ---------------------------------------------------------------------------
// Versionierung (wird in change_candidates.classifier_version mitgeschrieben)
// ---------------------------------------------------------------------------

export const PIPELINE_VERSION = 'v1.0.0';

// Thresholds zentral, sodass Tuning in einer Datei passiert.
const CONFIDENCE_GATE = 0.75;
const DEDUP_AUTO_DUPLICATE = 0.92;      // >= ist sicher Duplikat
const DEDUP_UNIQUE_THRESHOLD = 0.78;    // < ist sicher unique
// Dazwischen = Grauzone → LLM-Dedup-Check

// ---------------------------------------------------------------------------
// Typen
// ---------------------------------------------------------------------------

export interface PipelineInput {
    candidate: ChangeCandidate;
    oldInventory: UiInventory | null;
    newInventory: UiInventory;
    oem: { slug: string; name: string; id: string };
    productArea: 'configurator' | 'new_sales' | 'used_sales';
    url: string;
    watchedUrlId: string;
    snapshotFromId: string | null;
    snapshotToId: string;
}

export interface ClassifierResult {
    verdict: 'feature' | 'removal' | 'irrelevant';
    category: string;
    reasoning: string;
    confidence: number;
}

export interface ValidatorResult {
    verdict: 'feature' | 'removal' | 'irrelevant';
    reasoning: string;
}

export interface GeneratedPost {
    title: string;
    short_description: string;
    old_vs_new: { old: string; new: string };
    slug: string;
}

export interface PipelineSuccess {
    status: 'published';
    post: {
        slug: string;
        oem_id: string;
        product_area: 'configurator' | 'new_sales' | 'used_sales';
        title: string;
        short_description: string;
        url_to_feature: string;
        old_snapshot_id: string | null;
        new_snapshot_id: string;
        old_vs_new: { old: string; new: string };
        confidence: number;
        evidence: Record<string, unknown>;
        embedding: number[];
        tags: string[];
    };
    classifier: ClassifierResult;
    validator: ValidatorResult;
}

export interface PipelineRejection {
    status: 'rejected';
    reason:
        | 'classifier_not_feature'
        | 'confidence_below_gate'
        | 'validator_disagreement'
        | 'duplicate'
        | 'pipeline_error';
    detail: string;
    classifier?: ClassifierResult;
    validator?: ValidatorResult;
}

export type PipelineOutput = PipelineSuccess | PipelineRejection;

// ---------------------------------------------------------------------------
// Dedup-Port (wird gegen Supabase implementiert)
// ---------------------------------------------------------------------------

export interface DedupStore {
    /**
     * Sucht die ähnlichsten feature_posts im 60-Tage-Fenster für denselben OEM
     * und denselben product_area. Gibt Liste mit Cosine-Similarity sortiert
     * absteigend zurück.
     */
    findSimilar(args: {
        embedding: number[];
        oemId: string;
        productArea: string;
        windowDays: number;
        limit: number;
    }): Promise<{ id: string; title: string; short_description: string; similarity: number; daysOld: number }[]>;
}

// ---------------------------------------------------------------------------
// Standard-DedupStore gegen Supabase (kann im Test ersetzt werden)
// ---------------------------------------------------------------------------

export function makeSupabaseDedupStore(sb: SupabaseClient): DedupStore {
    return {
        async findSimilar({ embedding, oemId, productArea, windowDays, limit }) {
            // Wir nutzen eine Postgres-RPC-Funktion `match_feature_posts`
            // (siehe db/schema.sql – optional; alternativ direkter SQL-Call).
            // Um dependencies zu minimieren, machen wir hier einen Full-Fetch
            // mit Filter und berechnen Cosine-Similarity clientseitig.
            //
            // Für mehr als ~5000 Posts sollte auf eine RPC-basierte Lösung
            // umgestellt werden. Für das MVP reicht das.
            const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();
            const { data, error } = await sb
                .from('feature_posts')
                .select('id, title, short_description, embedding, published_at')
                .eq('oem_id', oemId)
                .eq('product_area', productArea)
                .gte('published_at', since)
                .limit(500);

            if (error) throw new Error(`Dedup-Query fehlgeschlagen: ${error.message}`);
            if (!data) return [];

            const results = data
                .filter((r): r is typeof r & { embedding: number[] } =>
                    Array.isArray(r.embedding) && r.embedding.length === EMBEDDING_DIM
                )
                .map((r) => {
                    const sim = cosineSim(embedding, r.embedding);
                    const daysOld =
                        (Date.now() - new Date(r.published_at).getTime()) / (1000 * 60 * 60 * 24);
                    return {
                        id: r.id as string,
                        title: r.title as string,
                        short_description: r.short_description as string,
                        similarity: sim,
                        daysOld: Math.round(daysOld),
                    };
                })
                .sort((a, b) => b.similarity - a.similarity)
                .slice(0, limit);

            return results;
        },
    };
}

// ---------------------------------------------------------------------------
// Öffentliche API
// ---------------------------------------------------------------------------

export async function runPipeline(
    input: PipelineInput,
    dedup: DedupStore
): Promise<PipelineOutput> {
    try {
        // --- 1. Klassifikation (Claude) ---
        const classifier = await classifyWithClaude(input);

        if (classifier.verdict === 'irrelevant') {
            return {
                status: 'rejected',
                reason: 'classifier_not_feature',
                detail: `Claude: ${classifier.reasoning}`,
                classifier,
            };
        }
        if (classifier.confidence < CONFIDENCE_GATE) {
            return {
                status: 'rejected',
                reason: 'confidence_below_gate',
                detail: `confidence=${classifier.confidence.toFixed(2)} < ${CONFIDENCE_GATE}`,
                classifier,
            };
        }

        // --- 2. Validator (GPT-4o-mini) ---
        const validator = await validateWithOpenAI(input, classifier);
        if (validator.verdict !== classifier.verdict) {
            return {
                status: 'rejected',
                reason: 'validator_disagreement',
                detail: `Claude=${classifier.verdict}, Validator=${validator.verdict}`,
                classifier,
                validator,
            };
        }

        // --- 3. Post vorgenerieren (Claude) ---
        const generated = await generatePostWithClaude(input, classifier);

        // --- 4. Embedding + Dedup ---
        const embeddingText =
            `${generated.title}\n${generated.short_description}\n${generated.old_vs_new.old}\n${generated.old_vs_new.new}`;
        const embedding = await embedText(embeddingText);

        const neighbors = await dedup.findSimilar({
            embedding,
            oemId: input.oem.id,
            productArea: input.productArea,
            windowDays: 60,
            limit: 5,
        });

        const top = neighbors[0];
        if (top) {
            if (top.similarity >= DEDUP_AUTO_DUPLICATE) {
                return {
                    status: 'rejected',
                    reason: 'duplicate',
                    detail: `auto-duplicate of ${top.id} (sim=${top.similarity.toFixed(3)}, ${top.daysOld}d alt)`,
                    classifier,
                    validator,
                };
            }
            if (top.similarity > DEDUP_UNIQUE_THRESHOLD) {
                // Grauzone → LLM-Dedup-Check
                const isDup = await dedupeCheckWithClaude({
                    newTitle: generated.title,
                    newDescription: generated.short_description,
                    existingTitle: top.title,
                    existingDescription: top.short_description,
                    daysAgo: top.daysOld,
                    oem: input.oem.name,
                    area: input.productArea,
                });
                if (isDup) {
                    return {
                        status: 'rejected',
                        reason: 'duplicate',
                        detail: `llm-dedupe match with ${top.id} (sim=${top.similarity.toFixed(3)})`,
                        classifier,
                        validator,
                    };
                }
            }
        }

        // --- 5. Tags ---
        const tags = await extractTagsWithClaude(generated, classifier.category, input.productArea);

        // --- 6. Erfolgs-Objekt zusammenstellen ---
        return {
            status: 'published',
            classifier,
            validator,
            post: {
                slug: ensureSlug(generated.slug, input.oem.slug),
                oem_id: input.oem.id,
                product_area: input.productArea,
                title: generated.title,
                short_description: generated.short_description,
                url_to_feature: input.url,
                old_snapshot_id: input.snapshotFromId,
                new_snapshot_id: input.snapshotToId,
                old_vs_new: generated.old_vs_new,
                confidence: classifier.confidence,
                evidence: {
                    candidate_type: input.candidate.candidate_type,
                    fingerprint: input.candidate.fingerprint,
                    raw_diff: input.candidate.raw_diff,
                    classifier_category: classifier.category,
                    classifier_reasoning: classifier.reasoning,
                    validator_reasoning: validator.reasoning,
                    pipeline_version: PIPELINE_VERSION,
                },
                embedding,
                tags,
            },
        };
    } catch (err) {
        return {
            status: 'rejected',
            reason: 'pipeline_error',
            detail: err instanceof Error ? err.message : String(err),
        };
    }
}

// ---------------------------------------------------------------------------
// Schritt 1: Klassifikation (Claude)
// ---------------------------------------------------------------------------

async function classifyWithClaude(input: PipelineInput): Promise<ClassifierResult> {
    const prompt = buildClassifyPrompt(input);
    const raw = await callClaudeJson<{
        verdict: string;
        category: string;
        reasoning: string;
        confidence: number;
    }>(prompt, { maxTokens: 400, temperature: 0 });

    return {
        verdict: normalizeVerdict(raw.verdict),
        category: String(raw.category ?? 'unknown').slice(0, 60),
        reasoning: String(raw.reasoning ?? '').slice(0, 800),
        confidence: clamp01(Number(raw.confidence)),
    };
}

function buildClassifyPrompt(input: PipelineInput): string {
    const oldFrag = fragmentForCandidate(input.candidate, input.oldInventory, 'old');
    const newFrag = fragmentForCandidate(input.candidate, input.newInventory, 'new');

    return `Du bist ein nüchterner Product-Analyst für Automobil-OEM-Websites im deutschen Markt.
Deine einzige Aufgabe: Entscheide, ob die unten gezeigte Änderung ein NEUES FEATURE,
eine große ENTFERNUNG eines Features, oder IRRELEVANT ist.

Kontext:
- OEM: ${input.oem.name}
- URL: ${input.url}
- Produktbereich: ${input.productArea}
- Kandidatentyp (vorgefiltert): ${input.candidate.candidate_type}

Regeln für „neues Feature":
- Es muss ein sichtbarer, funktional interaktiver Block sein (Formular, Widget,
  Rechner, Modul, neuer Flow-Schritt, neue Eingabemöglichkeit, neuer CTA-Pfad).
- Reine Textänderungen, neue Bilder, neue Farben, neue Felgen, neue Modelljahrgänge,
  Preisänderungen, Copy-Anpassungen, CSS/Layout-Änderungen sind KEINE Features.
- Ein neues Modul, das lediglich eine bestehende Funktion umbenennt oder verschiebt,
  ist KEIN neues Feature.

Regeln für „große Entfernung":
- Ein zuvor prominentes interaktives Modul ist vollständig verschwunden.
- Muss auf einer relevanten Seite (Haupt-Flow) passiert sein.

Input:
--- ALT (Inventory-Fragment, Vortag) ---
${JSON.stringify(oldFrag, null, 2)}

--- NEU (Inventory-Fragment, heute) ---
${JSON.stringify(newFrag, null, 2)}

Antworte ausschließlich in diesem JSON-Format, ohne weiteren Text:

{
  "verdict": "feature" | "removal" | "irrelevant",
  "category": "<eine kurze Kategorie, z.B. 'new_interactive_module', 'new_flow_step', 'trade_in', 'finance_calc', 'chat_assistant', 'reservation_step', 'comparison_tool'>",
  "reasoning": "<2-4 Sätze, sachlich, deutsch>",
  "confidence": <Zahl 0.0 bis 1.0>
}

Sei streng. Im Zweifel „irrelevant". Wenn du dir nicht sicher bist, confidence unter 0.75.`;
}

// ---------------------------------------------------------------------------
// Schritt 2: Validator (GPT-4o-mini)
// ---------------------------------------------------------------------------

async function validateWithOpenAI(
    input: PipelineInput,
    claudeResult: ClassifierResult
): Promise<ValidatorResult> {
    const oldFrag = fragmentForCandidate(input.candidate, input.oldInventory, 'old');
    const newFrag = fragmentForCandidate(input.candidate, input.newInventory, 'new');

    const prompt = `Du bist ein unabhängiger zweiter Reviewer. Prüfe, ob die folgende Änderung
auf einer deutschen OEM-Website ein echtes neues Feature oder eine große Feature-Entfernung ist.

Regeln (identisch zum Hauptklassifikator):
- "feature": neuer sichtbarer, interaktiver Block (Formular, Rechner, Widget,
  neuer Flow-Step, neue Eingabemöglichkeit, neuer CTA-Pfad mit eigener Funktion).
- "removal": prominentes interaktives Modul komplett verschwunden.
- "irrelevant": reine Text-/Bild-/Farb-/Preis-/Layout-/Felgen-/Modelljahrgangs-Änderungen.

OEM: ${input.oem.name}
URL: ${input.url}
Produktbereich: ${input.productArea}
Kandidatentyp: ${input.candidate.candidate_type}

Vor-Einschätzung (nur zur Info, nicht übernehmen):
${claudeResult.verdict} (${claudeResult.confidence.toFixed(2)}) – ${claudeResult.reasoning}

--- ALT ---
${JSON.stringify(oldFrag)}

--- NEU ---
${JSON.stringify(newFrag)}

Gib exakt dieses JSON zurück:
{
  "verdict": "feature" | "removal" | "irrelevant",
  "reasoning": "<1-3 Sätze deutsch>"
}

Sei streng. Im Zweifel "irrelevant".`;

    const raw = await callValidatorJson<{ verdict: string; reasoning: string }>(prompt, {
        maxTokens: 200,
        temperature: 0,
    });

    return {
        verdict: normalizeVerdict(raw.verdict),
        reasoning: String(raw.reasoning ?? '').slice(0, 500),
    };
}

// ---------------------------------------------------------------------------
// Schritt 3: Post-Generierung
// ---------------------------------------------------------------------------

async function generatePostWithClaude(
    input: PipelineInput,
    classifier: ClassifierResult
): Promise<GeneratedPost> {
    const oldFrag = fragmentForCandidate(input.candidate, input.oldInventory, 'old');
    const newFrag = fragmentForCandidate(input.candidate, input.newInventory, 'new');

    const prompt = `Du schreibst kurze, sachliche Website-Posts für einen Feature-Radar-Service.
Zielgruppe: Business Developer, PMs, Agenturen. Ton: neutral, präzise, keine Werbesprache.

Input:
- OEM: ${input.oem.name}
- Produktbereich: ${input.productArea}
- Kategorie: ${classifier.category}
- URL: ${input.url}
- Begründung der Klassifikation: ${classifier.reasoning}

Faktisch belegte Änderung:
--- ALT ---
${JSON.stringify(oldFrag)}
--- NEU ---
${JSON.stringify(newFrag)}

Erzeuge einen Post in folgendem JSON-Format:

{
  "title": "<max 90 Zeichen, Muster: '<OEM> <Bereich>: <was ist neu>'>",
  "short_description": "<2-3 Sätze, max 350 Zeichen, beschreibt was neu ist und wo es zu finden ist. Keine Superlative, keine Meinung.>",
  "old_vs_new": {
    "old": "<1 Satz: was es vorher war oder dass es vorher nicht existierte>",
    "new": "<1-2 Sätze: was jetzt neu da ist>"
  },
  "slug": "<kebab-case, deutsch, max 80 Zeichen, enthält oem und kernbegriff>"
}

Vermeide Wörter wie „revolutionär", „innovativ", „erstmals", wenn nicht belegbar.
Halte dich ausschließlich an die gezeigten Fakten, keine Spekulation.
Antworte ausschließlich mit dem JSON.`;

    const raw = await callClaudeJson<{
        title: string;
        short_description: string;
        old_vs_new: { old: string; new: string };
        slug: string;
    }>(prompt, { maxTokens: 600, temperature: 0.3 });

    return {
        title: String(raw.title ?? '').slice(0, 90),
        short_description: String(raw.short_description ?? '').slice(0, 350),
        old_vs_new: {
            old: String(raw.old_vs_new?.old ?? '').slice(0, 300),
            new: String(raw.old_vs_new?.new ?? '').slice(0, 400),
        },
        slug: slugify(String(raw.slug ?? '')).slice(0, 80),
    };
}

// ---------------------------------------------------------------------------
// Schritt 4: Tag-Extraktion
// ---------------------------------------------------------------------------

const TAG_VOCAB = [
    'configurator', 'new_sales', 'used_sales',
    'trade_in', 'financing', 'reservation', 'comparison', 'search_filter',
    'vehicle_detail', 'chat_assistant', 'video_consult', 'ar_viewer',
    'voice_input', 'document_upload', 'lead_form', 'dealer_contact',
    'availability', 'test_drive_booking',
    'entry', 'step', 'summary', 'post_purchase',
    'new_module', 'new_step', 'removed_module', 'major_redesign',
];

async function extractTagsWithClaude(
    post: GeneratedPost,
    category: string,
    productArea: string
): Promise<string[]> {
    const prompt = `Du vergibst Tags für einen Feature-Post. Nutze ausschließlich Tags aus dieser
kontrollierten Liste:

Produktbereich: configurator, new_sales, used_sales
Feature-Typ: trade_in, financing, reservation, comparison, search_filter,
  vehicle_detail, chat_assistant, video_consult, ar_viewer, voice_input,
  document_upload, lead_form, dealer_contact, availability, test_drive_booking
Flow: entry, step, summary, post_purchase
Sonstige: new_module, new_step, removed_module, major_redesign

Post-Titel: ${post.title}
Post-Beschreibung: ${post.short_description}
Kategorie: ${category}
Produktbereich: ${productArea}

Wähle 3-6 passende Tags. Gib NUR ein JSON-Objekt mit Schlüssel "tags" zurück:

{"tags": ["configurator", "trade_in", "new_module"]}`;

    const raw = await callClaudeJson<{ tags: string[] }>(prompt, {
        maxTokens: 200,
        temperature: 0,
    });

    const allowed = new Set(TAG_VOCAB);
    const out = (raw.tags ?? [])
        .map((t) => String(t).toLowerCase().trim())
        .filter((t) => allowed.has(t));

    // Produktbereich immer als Tag erzwingen
    if (!out.includes(productArea) && allowed.has(productArea)) {
        out.unshift(productArea);
    }
    // Dedup & Limit
    return Array.from(new Set(out)).slice(0, 6);
}

// ---------------------------------------------------------------------------
// Dedup-Check (Grauzone, LLM)
// ---------------------------------------------------------------------------

async function dedupeCheckWithClaude(args: {
    newTitle: string;
    newDescription: string;
    existingTitle: string;
    existingDescription: string;
    daysAgo: number;
    oem: string;
    area: string;
}): Promise<boolean> {
    const prompt = `Du prüfst, ob zwei Feature-Beschreibungen dieselbe Neuerung beschreiben.

Post A (bestehend, ${args.daysAgo} Tage alt):
Titel: ${args.existingTitle}
Beschreibung: ${args.existingDescription}
OEM: ${args.oem}, Bereich: ${args.area}

Post B (neuer Kandidat):
Titel: ${args.newTitle}
Beschreibung: ${args.newDescription}
OEM: ${args.oem}, Bereich: ${args.area}

Gib exakt dieses JSON zurück:

{
  "is_duplicate": true | false,
  "reason": "<1 Satz>"
}

Regel: Nur wenn es sich um dieselbe funktionale Neuerung handelt (auch wenn leicht
anders formuliert), ist es ein Duplikat.`;

    const raw = await callClaudeJson<{ is_duplicate: boolean; reason: string }>(prompt, {
        maxTokens: 150,
        temperature: 0,
    });
    return !!raw.is_duplicate;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Baut aus einem Inventory ein kompaktes Fragment, das nur die für den
 * Kandidaten relevanten Informationen enthält. Das spart Tokens und
 * fokussiert das LLM.
 */
function fragmentForCandidate(
    candidate: ChangeCandidate,
    inv: UiInventory | null,
    side: 'old' | 'new'
): Record<string, unknown> {
    if (!inv) return { note: side === 'old' ? 'Kein Vortages-Snapshot verfügbar' : 'Snapshot fehlt' };

    const base = {
        url: inv.url,
        page_title: inv.page_title,
        text_length: inv.text_length,
    };

    switch (candidate.candidate_type) {
        case 'new_interactive_component':
        case 'removed_interactive_component':
        case 'new_section_with_form':
            return {
                ...base,
                interactive_components: inv.interactive_components,
                sections: inv.sections,
            };
        case 'new_flow_step':
        case 'removed_flow_step':
            return {
                ...base,
                steppers: inv.interactive_components.filter(
                    (c) => c.type === 'stepper' || c.type === 'tabs'
                ),
            };
        case 'new_cta_category':
            return {
                ...base,
                ctas: inv.ctas.filter((c) => c.prominence !== 'tertiary'),
            };
        case 'new_module_class':
            return {
                ...base,
                modules_detected: inv.modules_detected,
                interactive_components: inv.interactive_components,
            };
        default:
            return {
                ...base,
                headings: inv.headings,
                modules_detected: inv.modules_detected,
            };
    }
}

function normalizeVerdict(v: unknown): 'feature' | 'removal' | 'irrelevant' {
    const s = String(v ?? '').toLowerCase().trim();
    if (s === 'feature') return 'feature';
    if (s === 'removal') return 'removal';
    return 'irrelevant';
}

function clamp01(n: number): number {
    if (!Number.isFinite(n)) return 0;
    if (n < 0) return 0;
    if (n > 1) return 1;
    return n;
}

function slugify(s: string): string {
    return s
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

function ensureSlug(slug: string, oemSlug: string): string {
    const date = new Date().toISOString().slice(0, 10);
    let s = slugify(slug);
    if (!s.startsWith(oemSlug)) s = `${oemSlug}-${s}`;
    // Zeitstempel anhängen, um Slug-Kollisionen bei ähnlichen Features zu vermeiden
    return `${s}-${date}`.slice(0, 120);
}

function cosineSim(a: number[], b: number[]): number {
    if (a.length !== b.length) return 0;
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    if (na === 0 || nb === 0) return 0;
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
