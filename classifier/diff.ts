/**
 * classifier/diff.ts
 * ---------------------------------------------------------------------------
 * Deterministische Diff-Engine zwischen zwei UI-Inventories.
 *
 * Input:  (oldInventory, newInventory)  – beide vom Typ `UiInventory`
 * Output: Array von `ChangeCandidate`-Rohdaten
 *
 * Aufgabe:
 *   1. Kandidaten aus strukturellen Unterschieden ableiten.
 *   2. Harte Ausschlussregeln (Stufe 1) anwenden.
 *   3. Kandidaten sind bewusst *konservativ*: lieber keinen Kandidaten als
 *      einen schwach begründeten. Die LLM-Stufe ist teuer, also filtern wir
 *      hier aggressiv.
 *
 * Die Engine kennzeichnet nur `candidate_type` und `raw_diff`. Die eigentliche
 * Feature-ja/nein-Entscheidung trifft die Classifier-Pipeline (siehe
 * classifier/pipeline.ts).
 * ---------------------------------------------------------------------------
 */

import type {
    UiInventory,
    InteractiveComponent,
} from '../crawler/core/inventory';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CandidateType =
    | 'new_interactive_component'
    | 'new_flow_step'
    | 'new_section_with_form'
    | 'new_cta_category'
    | 'new_module_class'
    | 'removed_flow_step'
    | 'removed_interactive_component';

export interface ChangeCandidate {
    candidate_type: CandidateType;
    raw_diff: {
        before: unknown;
        after: unknown;
        context?: Record<string, unknown>;
    };
    /** Kompakter String, der diesen Kandidaten für Dedup stabil identifiziert. */
    fingerprint: string;
}

// ---------------------------------------------------------------------------
// Öffentliche API
// ---------------------------------------------------------------------------

/**
 * Erzeugt Kandidaten aus dem Übergang `oldInv` → `newInv`.
 * Der Aufrufer muss sicherstellen, dass beide Inventories dieselbe URL
 * beschreiben. Wenn `oldInv` fehlt (erster Snapshot), wird ein leeres Array
 * zurückgegeben – bei Erstbeobachtung gibt es keine Features, nur einen
 * Baseline.
 */
export function diffInventories(
    oldInv: UiInventory | null,
    newInv: UiInventory
): ChangeCandidate[] {
    // Keine Kandidaten bei Erstbeobachtung
    if (!oldInv) return [];

    // Plausibilitätscheck: Wenn der neue Snapshot defekt aussieht, keine Kandidaten.
    if (isImplausibleSnapshot(oldInv, newInv)) return [];

    const candidates: ChangeCandidate[] = [];

    candidates.push(...diffInteractiveComponents(oldInv, newInv));
    candidates.push(...diffStepperSteps(oldInv, newInv));
    candidates.push(...diffCtas(oldInv, newInv));
    candidates.push(...diffModules(oldInv, newInv));
    candidates.push(...diffSections(oldInv, newInv));

    // Deduplizieren nach Fingerprint (manche Regeln überschneiden sich minimal)
    const seen = new Set<string>();
    const out: ChangeCandidate[] = [];
    for (const c of candidates) {
        if (seen.has(c.fingerprint)) continue;
        seen.add(c.fingerprint);
        out.push(c);
    }
    return out;
}

// ---------------------------------------------------------------------------
// Stufe 1: Harte Ausschlussregeln auf Snapshot-Ebene
// ---------------------------------------------------------------------------

function isImplausibleSnapshot(oldInv: UiInventory, newInv: UiInventory): boolean {
    // Neuer Snapshot hat Fehler -> ignorieren
    if (newInv.error) return true;

    // Neuer Snapshot ist extrem klein -> wahrscheinlich Error-Page oder Consent-Wall
    if (newInv.text_length > 0 && newInv.text_length < 500) return true;

    // Text-Kollaps um >60% -> möglicher Redirect / Error / Wall
    if (oldInv.text_length > 2000 && newInv.text_length > 0) {
        const ratio = newInv.text_length / oldInv.text_length;
        if (ratio < 0.4) return true;
    }

    // Seite hatte vorher Inhalte, jetzt keine Headings -> wahrscheinlich defekt
    if (oldInv.headings.length >= 3 && newInv.headings.length === 0) return true;

    return false;
}

// ---------------------------------------------------------------------------
// Einzel-Regeln
// ---------------------------------------------------------------------------

/**
 * Neue interaktive Komponenten: forms, stepper, tabs, iframe_widgets.
 * Wir matchen über einen stabilen Key pro Komponente.
 */
function diffInteractiveComponents(
    oldInv: UiInventory,
    newInv: UiInventory
): ChangeCandidate[] {
    const oldKeys = new Map<string, InteractiveComponent>();
    const newKeys = new Map<string, InteractiveComponent>();

    for (const c of oldInv.interactive_components) oldKeys.set(componentKey(c), c);
    for (const c of newInv.interactive_components) newKeys.set(componentKey(c), c);

    const result: ChangeCandidate[] = [];

    // Neu hinzugekommene Komponenten
    for (const [key, comp] of newKeys) {
        if (oldKeys.has(key)) continue;

        // Ausschlussregeln:
        // - Form mit <=1 relevantem Feld -> zu dünn
        if (comp.type === 'form' && (comp.fields?.length ?? 0) < 2) continue;

        // - Select mit <5 Optionen und keinem Label -> kosmetisch
        if (comp.type === 'select' && !comp.label && (comp.options_count ?? 0) < 5) continue;

        // - iframe_widget ohne module_hint -> unbrauchbares Signal
        if (comp.type === 'iframe_widget' && !comp.module_hint) continue;

        const isFormLikeSales = comp.type === 'form' && (comp.fields?.length ?? 0) >= 2;

        result.push({
            candidate_type: isFormLikeSales ? 'new_section_with_form' : 'new_interactive_component',
            raw_diff: {
                before: null,
                after: comp,
                context: { section_hint: findSectionForComponent(comp, newInv) },
            },
            fingerprint: `newcomp:${key}`,
        });
    }

    // Entfernte Komponenten (nur als echte Removal kennzeichnen, wenn prominent)
    for (const [key, comp] of oldKeys) {
        if (newKeys.has(key)) continue;

        // Ausschlüsse: nur prominente Komponenten als Removal melden
        const isProminent =
            comp.type === 'form' && (comp.fields?.length ?? 0) >= 3 ||
            comp.type === 'stepper' && (comp.steps_visible?.length ?? 0) >= 3 ||
            comp.type === 'iframe_widget';

        if (!isProminent) continue;

        result.push({
            candidate_type: 'removed_interactive_component',
            raw_diff: {
                before: comp,
                after: null,
            },
            fingerprint: `remcomp:${key}`,
        });
    }

    return result;
}

/**
 * Stepper-Schritt neu oder entfernt (innerhalb eines bestehenden Steppers).
 * Das ist ein starkes Feature-Signal – neuer Flow-Step.
 */
function diffStepperSteps(oldInv: UiInventory, newInv: UiInventory): ChangeCandidate[] {
    const result: ChangeCandidate[] = [];

    const oldSteppers = oldInv.interactive_components.filter((c) => c.type === 'stepper');
    const newSteppers = newInv.interactive_components.filter((c) => c.type === 'stepper');

    // Match über module_hint, Fallback auf Reihenfolge
    for (let i = 0; i < newSteppers.length; i++) {
        const ns = newSteppers[i];
        const os = oldSteppers.find((o) => o.module_hint && o.module_hint === ns.module_hint)
            ?? oldSteppers[i];
        if (!os) continue;

        const oldSteps = new Set((os.steps_visible ?? []).map((s) => s.toLowerCase()));
        const newSteps = new Set((ns.steps_visible ?? []).map((s) => s.toLowerCase()));

        const added = [...newSteps].filter((s) => !oldSteps.has(s));
        const removed = [...oldSteps].filter((s) => !newSteps.has(s));

        for (const step of added) {
            result.push({
                candidate_type: 'new_flow_step',
                raw_diff: {
                    before: { steps: [...oldSteps] },
                    after: { new_step: step, steps: [...newSteps] },
                    context: { stepper_hint: ns.module_hint ?? null },
                },
                fingerprint: `newstep:${ns.module_hint ?? 'anon'}:${step}`,
            });
        }
        for (const step of removed) {
            result.push({
                candidate_type: 'removed_flow_step',
                raw_diff: {
                    before: { removed_step: step, steps: [...oldSteps] },
                    after: { steps: [...newSteps] },
                    context: { stepper_hint: ns.module_hint ?? null },
                },
                fingerprint: `remstep:${ns.module_hint ?? 'anon'}:${step}`,
            });
        }
    }

    return result;
}

/**
 * Neue CTA-Kategorie: neuer prominenter CTA mit einem target_pattern, das
 * es vorher gar nicht gab. Reine Textänderung auf bestehendem Pfad zählt
 * explizit NICHT.
 */
function diffCtas(oldInv: UiInventory, newInv: UiInventory): ChangeCandidate[] {
    const oldPatterns = new Set(
        oldInv.ctas
            .filter((c) => c.prominence !== 'tertiary')
            .map((c) => c.target_pattern)
            .filter((p): p is string => typeof p === 'string' && p.length > 0)
    );

    const result: ChangeCandidate[] = [];
    const newPrimary = newInv.ctas.filter(
        (c) => c.prominence === 'primary' || c.prominence === 'secondary'
    );

    const seenPatterns = new Set<string>();
    for (const c of newPrimary) {
        if (!c.target_pattern) continue;
        if (oldPatterns.has(c.target_pattern)) continue;
        if (seenPatterns.has(c.target_pattern)) continue;
        seenPatterns.add(c.target_pattern);

        // Ausschluss: reine Sprachwechsel, Cookie-Links, Login etc.
        if (isIrrelevantCtaTarget(c.target_pattern)) continue;
        if (isGenericCtaText(c.text)) continue;

        result.push({
            candidate_type: 'new_cta_category',
            raw_diff: {
                before: null,
                after: c,
            },
            fingerprint: `newcta:${c.target_pattern}`,
        });
    }

    return result;
}

/**
 * Neue Modul-Klasse: data-component / data-module / data-widget-Werte,
 * die vorher nicht existierten. Nur ungewöhnliche, aussagekräftige Werte
 * zählen (lange, nicht-triviale Strings).
 */
function diffModules(oldInv: UiInventory, newInv: UiInventory): ChangeCandidate[] {
    const oldSet = new Set(oldInv.modules_detected);
    const result: ChangeCandidate[] = [];

    for (const m of newInv.modules_detected) {
        if (oldSet.has(m)) continue;
        if (!isMeaningfulModuleName(m)) continue;

        result.push({
            candidate_type: 'new_module_class',
            raw_diff: {
                before: null,
                after: { module: m },
            },
            fingerprint: `newmod:${m}`,
        });
    }

    return result;
}

/**
 * Neue Section mit Formular: H2-Heading, das vorher gar nicht existierte,
 * und jetzt zusammen mit einem Formular auftritt.
 */
function diffSections(oldInv: UiInventory, newInv: UiInventory): ChangeCandidate[] {
    const oldHeadings = new Set(
        oldInv.sections.map((s) => normalizeHeading(s.heading))
    );
    const result: ChangeCandidate[] = [];

    for (const s of newInv.sections) {
        const key = normalizeHeading(s.heading);
        if (oldHeadings.has(key)) continue;
        if (!s.has_form && !s.has_iframe) continue;
        if (s.interactive_count < 2) continue;

        result.push({
            candidate_type: 'new_section_with_form',
            raw_diff: {
                before: null,
                after: s,
            },
            fingerprint: `newsec:${key}`,
        });
    }

    return result;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function componentKey(c: InteractiveComponent): string {
    // Priorität: module_hint > (type + label) > (type + field-signature) > (type + stepcount)
    if (c.module_hint) return `${c.type}|${c.module_hint}`;
    if (c.label) return `${c.type}|L:${c.label.toLowerCase()}`;
    if (c.type === 'form' && c.fields) {
        const sig = c.fields
            .map((f) => `${f.input_type}:${f.label.toLowerCase()}`)
            .sort()
            .join(',');
        return `form|F:${sig}`;
    }
    if (c.type === 'stepper' || c.type === 'tabs') {
        const sig = (c.steps_visible ?? []).map((s) => s.toLowerCase()).sort().join(',');
        return `${c.type}|S:${sig}`;
    }
    if (c.type === 'select') {
        return `select|O:${c.options_count ?? 0}`;
    }
    return `${c.type}|anon`;
}

function normalizeHeading(h: string): string {
    return h.toLowerCase().replace(/\s+/g, ' ').trim();
}

function findSectionForComponent(
    _comp: InteractiveComponent,
    _inv: UiInventory
): string | null {
    // Platzhalter für spätere Präzisierung. Aktuell kein verlässlicher Link
    // Komponente -> Section, weil wir im Browser-Kontext keine Parent-Beziehung
    // mitgeben. Wird nur als Hinweis für das LLM genutzt.
    return null;
}

function isIrrelevantCtaTarget(pattern: string): boolean {
    const p = pattern.toLowerCase();
    return (
        p.includes('/cookie') ||
        p.includes('/consent') ||
        p.includes('/impressum') ||
        p.includes('/datenschutz') ||
        p.includes('/agb') ||
        p.includes('/login') ||
        p.includes('/logout') ||
        p.includes('/my') ||
        p.includes('/newsletter') ||
        p === '/' ||
        p === ''
    );
}

function isGenericCtaText(text: string): boolean {
    const t = text.toLowerCase().trim();
    return [
        'mehr',
        'mehr erfahren',
        'weiter',
        'zurück',
        'schließen',
        'akzeptieren',
        'ablehnen',
        'einstellungen',
        'details',
    ].includes(t);
}

function isMeaningfulModuleName(m: string): boolean {
    if (m.length < 5 || m.length > 60) return false;
    // Ausschluss generischer Namen
    const generic = new Set([
        'button',
        'link',
        'image',
        'container',
        'wrapper',
        'row',
        'col',
        'column',
        'item',
        'list',
        'text',
        'headline',
        'headline-text',
        'footer',
        'header',
        'navigation',
    ]);
    if (generic.has(m)) return false;
    // Muss entweder Bindestrich/Unterstrich haben ODER Fachbegriff sein
    if (!/[-_]/.test(m) && m.length < 10) return false;
    return true;
}
