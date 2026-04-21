import 'dotenv/config';
/**
 * db/seed.ts
 * ---------------------------------------------------------------------------
 * Seeded die 5 OEMs, ein kontrolliertes Tag-Vokabular und je 8 Ziel-URLs für
 * BMW und Audi (deutsche Websites).
 *
 * Aufruf:
 *   pnpm tsx db/seed.ts
 *
 * ENV erforderlich:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_KEY   (Service-Role, NICHT anon)
 *
 * Idempotent: upsertet auf (slug) bzw. (oem_id, url).
 * ---------------------------------------------------------------------------
 */

import { createClient } from '@supabase/supabase-js';

type ProductArea = 'configurator' | 'new_sales' | 'used_sales';
type PageType =
    | 'configurator_entry'
    | 'config_step'
    | 'listing'
    | 'detail'
    | 'finance'
    | 'contact'
    | 'landing';

interface OemSeed {
    slug: string;
    name: string;
    base_url: string;
}

interface UrlSeed {
    oem_slug: string;
    url: string;
    product_area: ProductArea;
    page_type: PageType;
    notes?: string;
}

interface TagSeed {
    slug: string;
    label: string;
    group: 'product_area' | 'feature_type' | 'flow' | 'other';
}

// ---------------------------------------------------------------------------
// OEMs
// ---------------------------------------------------------------------------
const OEMS: OemSeed[] = [
    { slug: 'bmw',       name: 'BMW',            base_url: 'https://www.bmw.de' },
    { slug: 'audi',      name: 'Audi',           base_url: 'https://www.audi.de' },
    { slug: 'mercedes',  name: 'Mercedes-Benz',  base_url: 'https://www.mercedes-benz.de' },
    { slug: 'porsche',   name: 'Porsche',        base_url: 'https://www.porsche.com/germany' },
    { slug: 'vw',        name: 'Volkswagen',     base_url: 'https://www.volkswagen.de' },
];

// ---------------------------------------------------------------------------
// Ziel-URLs BMW (8) und Audi (8)
// Hinweis: OEM-URLs ändern sich gelegentlich. Nach erstem Crawl validieren
// und in der DB nachziehen. Alle URLs sind auf die DE-Website gerichtet.
// ---------------------------------------------------------------------------
const URLS: UrlSeed[] = [
    // -------------------- BMW --------------------
    {
        oem_slug: 'bmw',
        url: 'https://www.bmw.de/de/neufahrzeuge.html',
        product_area: 'new_sales',
        page_type: 'landing',
        notes: 'Einstiegsseite Neufahrzeuge',
    },
    {
        oem_slug: 'bmw',
        url: 'https://www.bmw.de/de/fastlane.html',
        product_area: 'new_sales',
        page_type: 'listing',
        notes: 'BMW Fastlane – sofort verfügbare Neuwagen',
    },
    {
        oem_slug: 'bmw',
        url: 'https://www.bmw.de/de/topics/fascination-bmw/bmw-premium-selection.html',
        product_area: 'used_sales',
        page_type: 'landing',
        notes: 'BMW Premium Selection – Gebrauchtwagen',
    },
    {
        oem_slug: 'bmw',
        url: 'https://www.bmwgebrauchtwagen.de/',
        product_area: 'used_sales',
        page_type: 'listing',
        notes: 'Gebrauchtwagenbörse BMW',
    },
    {
        oem_slug: 'bmw',
        url: 'https://configure.bmw.de/de_DE/configurator',
        product_area: 'configurator',
        page_type: 'configurator_entry',
        notes: 'Konfigurator Einstieg',
    },
    {
        oem_slug: 'bmw',
        url: 'https://www.bmw.de/de/neufahrzeuge/bmw-3er-reihe.html',
        product_area: 'new_sales',
        page_type: 'detail',
        notes: 'Musterfahrzeug 3er – Übersicht',
    },
    {
        oem_slug: 'bmw',
        url: 'https://www.bmw.de/de/finanzierung.html',
        product_area: 'new_sales',
        page_type: 'finance',
        notes: 'Finanzierung Übersicht',
    },
    {
        oem_slug: 'bmw',
        url: 'https://www.bmw.de/de/footer/service-navigation/haendlersuche.html',
        product_area: 'new_sales',
        page_type: 'contact',
        notes: 'Händlersuche',
    },

    // -------------------- Audi --------------------
    {
        oem_slug: 'audi',
        url: 'https://www.audi.de/de/brand/de/neuwagen.html',
        product_area: 'new_sales',
        page_type: 'landing',
        notes: 'Neuwagen Übersicht',
    },
    {
        oem_slug: 'audi',
        url: 'https://www.audi.de/de/brand/de/neuwagen/alle-modelle.html',
        product_area: 'new_sales',
        page_type: 'listing',
        notes: 'Alle Neuwagen-Modelle',
    },
    {
        oem_slug: 'audi',
        url: 'https://www.audi.de/de/brand/de/gebrauchtwagen.html',
        product_area: 'used_sales',
        page_type: 'landing',
        notes: 'Gebrauchtwagen / Audi Gebrauchtwagen :plus',
    },
    {
        oem_slug: 'audi',
        url: 'https://gebrauchtwagen.audi.de/',
        product_area: 'used_sales',
        page_type: 'listing',
        notes: 'Audi Gebrauchtwagenbörse',
    },
    {
        oem_slug: 'audi',
        url: 'https://www.audi.de/de/brand/de/neuwagen/a4.html',
        product_area: 'new_sales',
        page_type: 'detail',
        notes: 'Musterfahrzeug A4 – Modellseite',
    },
    {
        oem_slug: 'audi',
        url: 'https://konfigurator.audi.de/',
        product_area: 'configurator',
        page_type: 'configurator_entry',
        notes: 'Konfigurator Einstieg',
    },
    {
        oem_slug: 'audi',
        url: 'https://www.audi.de/de/brand/de/kundenbereich/finanzierung.html',
        product_area: 'new_sales',
        page_type: 'finance',
        notes: 'Finanzierung Übersicht',
    },
    {
        oem_slug: 'audi',
        url: 'https://www.audi.de/de/brand/de/kundenbereich/audi-partnersuche.html',
        product_area: 'new_sales',
        page_type: 'contact',
        notes: 'Partnersuche / Händler',
    },
];

// ---------------------------------------------------------------------------
// Tags (kontrolliertes Vokabular – identisch zum Klassifikator-Prompt)
// ---------------------------------------------------------------------------
const TAGS: TagSeed[] = [
    // product_area
    { slug: 'configurator', label: 'Konfigurator',  group: 'product_area' },
    { slug: 'new_sales',    label: 'Neuwagen',      group: 'product_area' },
    { slug: 'used_sales',   label: 'Gebrauchtwagen',group: 'product_area' },

    // feature_type
    { slug: 'trade_in',             label: 'Inzahlungnahme',        group: 'feature_type' },
    { slug: 'financing',            label: 'Finanzierung',          group: 'feature_type' },
    { slug: 'reservation',          label: 'Reservierung',          group: 'feature_type' },
    { slug: 'comparison',           label: 'Vergleich',             group: 'feature_type' },
    { slug: 'search_filter',        label: 'Suche / Filter',        group: 'feature_type' },
    { slug: 'vehicle_detail',       label: 'Fahrzeugdetail',        group: 'feature_type' },
    { slug: 'chat_assistant',       label: 'Chat-Assistent',        group: 'feature_type' },
    { slug: 'video_consult',        label: 'Video-Beratung',        group: 'feature_type' },
    { slug: 'ar_viewer',            label: 'AR-Viewer',             group: 'feature_type' },
    { slug: 'voice_input',          label: 'Spracheingabe',         group: 'feature_type' },
    { slug: 'document_upload',      label: 'Dokumenten-Upload',     group: 'feature_type' },
    { slug: 'lead_form',            label: 'Lead-Formular',         group: 'feature_type' },
    { slug: 'dealer_contact',       label: 'Händlerkontakt',        group: 'feature_type' },
    { slug: 'availability',         label: 'Verfügbarkeit',         group: 'feature_type' },
    { slug: 'test_drive_booking',   label: 'Probefahrt-Buchung',    group: 'feature_type' },

    // flow
    { slug: 'entry',         label: 'Einstieg',       group: 'flow' },
    { slug: 'step',          label: 'Flow-Schritt',   group: 'flow' },
    { slug: 'summary',       label: 'Zusammenfassung',group: 'flow' },
    { slug: 'post_purchase', label: 'Nach-Kauf',      group: 'flow' },

    // other
    { slug: 'new_module',     label: 'Neues Modul',     group: 'other' },
    { slug: 'new_step',       label: 'Neuer Schritt',   group: 'other' },
    { slug: 'removed_module', label: 'Entferntes Modul',group: 'other' },
    { slug: 'major_redesign', label: 'Großes Redesign', group: 'other' },
];

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_KEY;

    if (!url || !key) {
        console.error('FEHLER: SUPABASE_URL und SUPABASE_SERVICE_KEY müssen gesetzt sein.');
        process.exit(1);
    }

    const sb = createClient(url, key, { auth: { persistSession: false } });

    console.log('→ Seeding OEMs...');
    const { data: oemRows, error: oemErr } = await sb
        .from('oems')
        .upsert(OEMS, { onConflict: 'slug' })
        .select('id, slug');

    if (oemErr) {
        console.error('OEM-Upsert fehlgeschlagen:', oemErr);
        process.exit(1);
    }
    const oemIdBySlug = new Map<string, string>(oemRows!.map((r) => [r.slug, r.id]));
    console.log(`  ✓ ${oemRows!.length} OEMs angelegt/aktualisiert.`);

    console.log('→ Seeding Tags...');
    // Kleine Anpassung: "group" ist reserviertes Keyword -> als Property hier ok,
    // Supabase mappt das 1:1 auf Spalte "group".
    const { error: tagErr } = await sb
        .from('tags')
        .upsert(TAGS, { onConflict: 'slug' });
    if (tagErr) {
        console.error('Tag-Upsert fehlgeschlagen:', tagErr);
        process.exit(1);
    }
    console.log(`  ✓ ${TAGS.length} Tags angelegt/aktualisiert.`);

    console.log('→ Seeding watched_urls...');
    const urlRows = URLS.map((u) => {
        const oemId = oemIdBySlug.get(u.oem_slug);
        if (!oemId) throw new Error(`Unbekannter OEM-Slug: ${u.oem_slug}`);
        return {
            oem_id: oemId,
            url: u.url,
            product_area: u.product_area,
            page_type: u.page_type,
            notes: u.notes ?? null,
            is_active: true,
        };
    });

    const { error: urlErr } = await sb
        .from('watched_urls')
        .upsert(urlRows, { onConflict: 'oem_id,url' });

    if (urlErr) {
        console.error('watched_urls-Upsert fehlgeschlagen:', urlErr);
        process.exit(1);
    }
    console.log(`  ✓ ${urlRows.length} URLs angelegt/aktualisiert.`);

    console.log('\nFertig.');
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
