/**
 * crawler/core/inventory.ts
 * ---------------------------------------------------------------------------
 * Extrahiert aus einer gerenderten Playwright-Seite ein strukturiertes
 * UI-Inventory-JSON. Dieses Inventory ist der primäre Input für die Diff-Engine.
 *
 * Designprinzipien:
 *  - NIEMALS werfen. Bei jedem Fehler wird ein Inventory mit `error`-Feld
 *    zurückgegeben, sodass die Pipeline weiterlaufen kann.
 *  - Kein DOM-Rauschen: Stil-Klassen, auto-generierte IDs, Bildpfade,
 *    Tracking-Parameter werden nicht als Signal aufgenommen.
 *  - Serialisierbar: alles, was aus page.evaluate zurückkommt, muss JSON-fähig
 *    sein (daher keine DOM-Referenzen, keine Funktionen, keine Symbole).
 *
 * Output-Schema: siehe Interface `UiInventory` unten.
 * ---------------------------------------------------------------------------
 */

import type { Page } from 'playwright';

// ---------------------------------------------------------------------------
// Types (müssen 1:1 zum Datenmodell `snapshots.inventory` passen)
// ---------------------------------------------------------------------------

export interface UiInventory {
    url: string;
    captured_at: string;            // ISO-8601
    page_title: string;
    headings: string[];             // z. B. "H1: Neuwagen", "H2: Finanzierung"
    ctas: CtaDescriptor[];
    interactive_components: InteractiveComponent[];
    sections: SectionDescriptor[];
    route_patterns_detected: string[];
    modules_detected: string[];     // normalisierte Modul-/Widget-Kennungen
    text_length: number;            // grober Plausibilitätscheck (Fehlerseiten)
    error?: string;                 // nur gesetzt, wenn Extraktion (teilweise) fehlschlug
}

export interface CtaDescriptor {
    text: string;
    role: 'button' | 'link';
    prominence: 'primary' | 'secondary' | 'tertiary';
    target_pattern?: string;         // href-Pfad normalisiert
}

export interface InteractiveComponent {
    type: 'form' | 'select' | 'stepper' | 'tabs' | 'slider' | 'input_group' | 'iframe_widget';
    label?: string;
    fields?: { label: string; input_type: string }[];
    options_count?: number;
    steps_visible?: string[];
    module_hint?: string;            // falls über data-Attribut oder Klasse identifizierbar
}

export interface SectionDescriptor {
    heading: string;
    has_form: boolean;
    has_iframe: boolean;
    interactive_count: number;
}

// ---------------------------------------------------------------------------
// Öffentliche API
// ---------------------------------------------------------------------------

/**
 * Extrahiert das Inventory aus einer bereits navigierten, gerenderten Seite.
 * Ruft niemals throw auf.
 */
export async function extractInventory(page: Page): Promise<UiInventory> {
    const capturedAt = new Date().toISOString();
    const url = page.url();

    try {
        // Vor dem Evaluate: Haupt-Rendering abwarten. Der Aufrufer sollte
        // `networkidle` bereits abgewartet haben; wir geben trotzdem noch
        // einen kurzen Puffer für Lazy-Loaded-Komponenten.
        await page.waitForTimeout(1500);

        const raw = await page.evaluate(extractorInBrowser);

        // Normalisierung im Node-Kontext (raw kommt strukturiert aber roh zurück)
        const inventory: UiInventory = {
            url,
            captured_at: capturedAt,
            page_title: sanitizeText(raw.page_title, 200),
            headings: (raw.headings ?? [])
                .map((h: string) => sanitizeText(h, 200))
                .filter((h: string) => h.length > 0)
                .slice(0, 120),
            ctas: normalizeCtas(raw.ctas ?? []),
            interactive_components: normalizeComponents(raw.interactive_components ?? []),
            sections: normalizeSections(raw.sections ?? []),
            route_patterns_detected: dedupStrings(
                (raw.route_patterns_detected ?? []).map((p: string) =>
                    sanitizeText(p, 200)
                )
            ).slice(0, 80),
            modules_detected: dedupStrings(
                (raw.modules_detected ?? []).map((m: string) => sanitizeText(m, 80))
            ).slice(0, 80),
            text_length: typeof raw.text_length === 'number' ? raw.text_length : 0,
        };

        return inventory;
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
            url,
            captured_at: capturedAt,
            page_title: '',
            headings: [],
            ctas: [],
            interactive_components: [],
            sections: [],
            route_patterns_detected: [],
            modules_detected: [],
            text_length: 0,
            error: `inventory_extraction_failed: ${msg.slice(0, 500)}`,
        };
    }
}

// ---------------------------------------------------------------------------
// Browser-seitige Extraktion (wird serialisiert und im Page-Kontext ausgeführt)
// ---------------------------------------------------------------------------
// WICHTIG: Diese Funktion läuft komplett im Browser. Keine Imports, keine
// Closures auf Node-Variablen. Alles, was zurückgegeben wird, muss JSON-fähig
// sein. Keine TypeScript-Types zur Laufzeit verfügbar.

function extractorInBrowser(): {
    page_title: string;
    headings: string[];
    ctas: {
        text: string;
        role: 'button' | 'link';
        prominence: 'primary' | 'secondary' | 'tertiary';
        target_pattern?: string;
    }[];
    interactive_components: {
        type: string;
        label?: string;
        fields?: { label: string; input_type: string }[];
        options_count?: number;
        steps_visible?: string[];
        module_hint?: string;
    }[];
    sections: { heading: string; has_form: boolean; has_iframe: boolean; interactive_count: number }[];
    route_patterns_detected: string[];
    modules_detected: string[];
    text_length: number;
} {
    const safe = <T>(fn: () => T, fallback: T): T => {
        try { return fn(); } catch { return fallback; }
    };

    const isVisible = (el: Element): boolean => {
        try {
            const r = (el as HTMLElement).getBoundingClientRect();
            if (r.width < 1 || r.height < 1) return false;
            const s = window.getComputedStyle(el as HTMLElement);
            if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
            return true;
        } catch { return false; }
    };

    const cleanText = (t: string | null | undefined): string =>
        (t ?? '').replace(/\s+/g, ' ').trim();

    // ---- Title + Headings ----
    const page_title = cleanText(document.title);

    const headings: string[] = [];
    safe(() => {
        document.querySelectorAll('h1, h2, h3').forEach((el) => {
            if (!isVisible(el)) return;
            const level = el.tagName.toUpperCase();
            const text = cleanText(el.textContent);
            if (text.length > 0 && text.length < 200) {
                headings.push(`${level}: ${text}`);
            }
        });
    }, null);

    // ---- CTAs (Buttons und prominente Links) ----
    const ctas: {
        text: string;
        role: 'button' | 'link';
        prominence: 'primary' | 'secondary' | 'tertiary';
        target_pattern?: string;
    }[] = [];

    const classifyProminence = (el: Element): 'primary' | 'secondary' | 'tertiary' => {
        const cls = (el.getAttribute('class') || '').toLowerCase();
        const hasPrimary = /\b(primary|cta--primary|btn-primary|main-cta|hero-cta)\b/.test(cls);
        const hasSecondary = /\b(secondary|btn-secondary|cta--secondary)\b/.test(cls);
        if (hasPrimary) return 'primary';
        if (hasSecondary) return 'secondary';

        // Heuristik: große Buttons above the fold
        const rect = (el as HTMLElement).getBoundingClientRect();
        if (rect.top < 1200 && rect.width > 140 && rect.height > 36) return 'primary';
        return 'tertiary';
    };

    const normalizeHref = (href: string | null): string | undefined => {
        if (!href) return undefined;
        try {
            const u = new URL(href, window.location.href);
            // Query/Fragment weg, Pfad behalten. Nur erste 2 Pfadebenen.
            const parts = u.pathname.split('/').filter(Boolean).slice(0, 3);
            return '/' + parts.join('/');
        } catch { return undefined; }
    };

    safe(() => {
        document.querySelectorAll('button, a[role="button"]').forEach((el) => {
            if (!isVisible(el)) return;
            const text = cleanText((el as HTMLElement).innerText);
            if (text.length < 2 || text.length > 80) return;
            ctas.push({
                text,
                role: 'button',
                prominence: classifyProminence(el),
            });
        });

        document.querySelectorAll('a[href]').forEach((el) => {
            if (!isVisible(el)) return;
            const text = cleanText((el as HTMLElement).innerText);
            if (text.length < 3 || text.length > 80) return;
            // Nur Links, die nach CTA aussehen (Klassen-Heuristik oder große Darstellung)
            const cls = (el.getAttribute('class') || '').toLowerCase();
            const looksLikeCta = /\b(btn|button|cta|action)\b/.test(cls);
            const rect = (el as HTMLElement).getBoundingClientRect();
            const bigEnough = rect.width > 100 && rect.height > 32;
            if (!looksLikeCta && !bigEnough) return;

            ctas.push({
                text,
                role: 'link',
                prominence: classifyProminence(el),
                target_pattern: normalizeHref(el.getAttribute('href')),
            });
        });
    }, null);

    // Deduplicate CTAs by (text, role, target_pattern)
    const ctaSeen = new Set<string>();
    const ctasDedup = ctas.filter((c) => {
        const key = `${c.role}|${c.text}|${c.target_pattern ?? ''}`;
        if (ctaSeen.has(key)) return false;
        ctaSeen.add(key);
        return true;
    }).slice(0, 80);

    // ---- Interactive Components ----
    const interactive_components: {
        type: string;
        label?: string;
        fields?: { label: string; input_type: string }[];
        options_count?: number;
        steps_visible?: string[];
        module_hint?: string;
    }[] = [];

    const getLabelFor = (input: Element): string => {
        const id = input.getAttribute('id');
        if (id) {
            const lab = document.querySelector(`label[for="${CSS.escape(id)}"]`);
            if (lab) return cleanText((lab as HTMLElement).innerText);
        }
        const aria = input.getAttribute('aria-label');
        if (aria) return cleanText(aria);
        const placeholder = input.getAttribute('placeholder');
        if (placeholder) return cleanText(placeholder);
        // Parent-Label
        const parent = input.closest('label');
        if (parent) return cleanText((parent as HTMLElement).innerText);
        return '';
    };

    const moduleHint = (el: Element): string | undefined => {
        // data-component / data-module / data-testid Attribute bevorzugen
        for (const attr of ['data-component', 'data-module', 'data-widget', 'data-testid']) {
            const v = el.getAttribute(attr);
            if (v) return v.toLowerCase().slice(0, 80);
        }
        return undefined;
    };

    safe(() => {
        // Forms
        document.querySelectorAll('form').forEach((form) => {
            if (!isVisible(form)) return;
            const fields: { label: string; input_type: string }[] = [];
            form.querySelectorAll('input, select, textarea').forEach((inp) => {
                if (!isVisible(inp)) return;
                const tag = inp.tagName.toLowerCase();
                const type = tag === 'input'
                    ? (inp.getAttribute('type') || 'text').toLowerCase()
                    : tag;
                if (['hidden', 'submit', 'button', 'reset'].includes(type)) return;
                const label = getLabelFor(inp) || type;
                fields.push({ label: label.slice(0, 80), input_type: type });
            });
            if (fields.length === 0) return;
            interactive_components.push({
                type: 'form',
                label: cleanText(form.getAttribute('aria-label') || '') || undefined,
                fields: fields.slice(0, 30),
                module_hint: moduleHint(form),
            });
        });

        // Selects außerhalb von Forms
        document.querySelectorAll('select').forEach((sel) => {
            if (!isVisible(sel)) return;
            if (sel.closest('form')) return; // bereits in form erfasst
            interactive_components.push({
                type: 'select',
                label: getLabelFor(sel) || undefined,
                options_count: sel.querySelectorAll('option').length,
                module_hint: moduleHint(sel),
            });
        });

        // Stepper / Wizard (klassenbasierte Heuristik)
        document.querySelectorAll(
            '[class*="stepper" i], [class*="wizard" i], [class*="steps" i], nav[aria-label*="step" i]'
        ).forEach((el) => {
            if (!isVisible(el)) return;
            const steps: string[] = [];
            el.querySelectorAll('li, [role="listitem"], [class*="step-item" i]').forEach((step) => {
                if (!isVisible(step)) return;
                const t = cleanText((step as HTMLElement).innerText);
                if (t && t.length < 60) steps.push(t);
            });
            if (steps.length >= 2) {
                interactive_components.push({
                    type: 'stepper',
                    steps_visible: steps.slice(0, 15),
                    module_hint: moduleHint(el),
                });
            }
        });

        // Tabs
        document.querySelectorAll('[role="tablist"]').forEach((el) => {
            if (!isVisible(el)) return;
            const tabs: string[] = [];
            el.querySelectorAll('[role="tab"]').forEach((t) => {
                if (!isVisible(t)) return;
                const txt = cleanText((t as HTMLElement).innerText);
                if (txt) tabs.push(txt);
            });
            if (tabs.length >= 2) {
                interactive_components.push({
                    type: 'tabs',
                    steps_visible: tabs.slice(0, 15),
                    module_hint: moduleHint(el),
                });
            }
        });

        // iFrames als Widget-Indikator (z. B. eingebettete Finanzierungsrechner)
        document.querySelectorAll('iframe').forEach((fr) => {
            if (!isVisible(fr)) return;
            const src = fr.getAttribute('src') || '';
            if (!src) return;
            let pattern = '';
            try {
                const u = new URL(src, window.location.href);
                pattern = u.hostname + u.pathname.split('/').slice(0, 3).join('/');
            } catch { pattern = src.slice(0, 80); }
            interactive_components.push({
                type: 'iframe_widget',
                module_hint: pattern.slice(0, 80),
            });
        });
    }, null);

    // ---- Sections (H2-basiert) ----
    const sections: { heading: string; has_form: boolean; has_iframe: boolean; interactive_count: number }[] = [];
    safe(() => {
        document.querySelectorAll('section, [class*="section" i]').forEach((sec) => {
            if (!isVisible(sec)) return;
            const h = sec.querySelector('h1, h2, h3');
            const heading = h ? cleanText((h as HTMLElement).innerText) : '';
            if (!heading) return;
            sections.push({
                heading: heading.slice(0, 140),
                has_form: !!sec.querySelector('form'),
                has_iframe: !!sec.querySelector('iframe'),
                interactive_count: sec.querySelectorAll(
                    'button, select, input:not([type="hidden"]), textarea, [role="tab"]'
                ).length,
            });
        });
    }, null);

    // ---- Route-Patterns (aus internen Links) ----
    const routePatterns = new Set<string>();
    safe(() => {
        document.querySelectorAll('a[href]').forEach((a) => {
            const href = a.getAttribute('href');
            if (!href) return;
            try {
                const u = new URL(href, window.location.href);
                if (u.hostname !== window.location.hostname) return;
                const parts = u.pathname.split('/').filter(Boolean).slice(0, 2);
                if (parts.length === 0) return;
                routePatterns.add('/' + parts.join('/'));
            } catch { /* ignore */ }
        });
    }, null);

    // ---- Modules detected (Sammlung aus data-component usw.) ----
    const modulesSet = new Set<string>();
    safe(() => {
        document.querySelectorAll(
            '[data-component], [data-module], [data-widget], [data-testid]'
        ).forEach((el) => {
            for (const attr of ['data-component', 'data-module', 'data-widget', 'data-testid']) {
                const v = el.getAttribute(attr);
                if (v && v.length < 80) modulesSet.add(v.toLowerCase());
            }
        });
    }, null);

    // ---- Text length ----
    const text_length = safe(() => (document.body?.innerText ?? '').length, 0);

    return {
        page_title,
        headings,
        ctas: ctasDedup,
        interactive_components: interactive_components.slice(0, 80),
        sections: sections.slice(0, 60),
        route_patterns_detected: Array.from(routePatterns).slice(0, 80),
        modules_detected: Array.from(modulesSet).slice(0, 80),
        text_length,
    };
}

// ---------------------------------------------------------------------------
// Normalisierung im Node-Kontext
// ---------------------------------------------------------------------------

function sanitizeText(s: unknown, maxLen: number): string {
    if (typeof s !== 'string') return '';
    return s.replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function dedupStrings(arr: string[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const s of arr) {
        if (s.length === 0 || seen.has(s)) continue;
        seen.add(s);
        out.push(s);
    }
    return out;
}

function normalizeCtas(raw: unknown[]): CtaDescriptor[] {
    const out: CtaDescriptor[] = [];
    for (const r of raw) {
        if (!r || typeof r !== 'object') continue;
        const obj = r as Record<string, unknown>;
        const text = sanitizeText(obj.text, 80);
        const role = obj.role === 'button' ? 'button' : 'link';
        const prom = obj.prominence;
        const prominence: CtaDescriptor['prominence'] =
            prom === 'primary' || prom === 'secondary' ? prom : 'tertiary';
        if (text.length === 0) continue;
        out.push({
            text,
            role,
            prominence,
            target_pattern: sanitizeText(obj.target_pattern, 200) || undefined,
        });
    }
    return out.slice(0, 80);
}

function normalizeComponents(raw: unknown[]): InteractiveComponent[] {
    const validTypes = new Set<InteractiveComponent['type']>([
        'form', 'select', 'stepper', 'tabs', 'slider', 'input_group', 'iframe_widget',
    ]);
    const out: InteractiveComponent[] = [];
    for (const r of raw) {
        if (!r || typeof r !== 'object') continue;
        const obj = r as Record<string, unknown>;
        const type = obj.type as InteractiveComponent['type'];
        if (!validTypes.has(type)) continue;

        const comp: InteractiveComponent = { type };
        const label = sanitizeText(obj.label, 120);
        if (label) comp.label = label;

        if (Array.isArray(obj.fields)) {
            comp.fields = (obj.fields as unknown[])
                .map((f) => {
                    if (!f || typeof f !== 'object') return null;
                    const fo = f as Record<string, unknown>;
                    return {
                        label: sanitizeText(fo.label, 80),
                        input_type: sanitizeText(fo.input_type, 40),
                    };
                })
                .filter((f): f is { label: string; input_type: string } =>
                    f !== null && f.input_type.length > 0
                )
                .slice(0, 30);
        }

        if (typeof obj.options_count === 'number') comp.options_count = obj.options_count;

        if (Array.isArray(obj.steps_visible)) {
            comp.steps_visible = (obj.steps_visible as unknown[])
                .map((s) => sanitizeText(s, 60))
                .filter((s) => s.length > 0)
                .slice(0, 15);
        }

        const hint = sanitizeText(obj.module_hint, 80);
        if (hint) comp.module_hint = hint;

        out.push(comp);
    }
    return out.slice(0, 80);
}

function normalizeSections(raw: unknown[]): SectionDescriptor[] {
    const out: SectionDescriptor[] = [];
    for (const r of raw) {
        if (!r || typeof r !== 'object') continue;
        const obj = r as Record<string, unknown>;
        const heading = sanitizeText(obj.heading, 140);
        if (!heading) continue;
        out.push({
            heading,
            has_form: !!obj.has_form,
            has_iframe: !!obj.has_iframe,
            interactive_count: typeof obj.interactive_count === 'number' ? obj.interactive_count : 0,
        });
    }
    return out.slice(0, 60);
}
