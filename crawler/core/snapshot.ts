/**
 * crawler/core/snapshot.ts
 * ---------------------------------------------------------------------------
 * Erzeugt pro URL einen Snapshot-Triplett (DOM-HTML, Screenshot, Text) und
 * lädt die Dateien in Supabase Storage hoch. Die DB-Row für `snapshots`
 * wird vom Aufrufer (run-daily) erzeugt, damit diese Datei sich auf
 * Dateioperationen konzentriert.
 *
 * Storage-Pfad-Schema:
 *   <bucket>/<oem_slug>/<yyyy-mm-dd>/<url_hash>/<dom.html|screenshot.png>
 * ---------------------------------------------------------------------------
 */

import type { Page } from 'playwright';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createHash } from 'node:crypto';

export interface SnapshotArtifacts {
    domHtml: string;
    screenshot: Buffer;
    textExtract: string;
}

export interface UploadedSnapshot {
    domHtmlPath: string;
    screenshotPath: string;
    screenshotPublicUrl: string | null;
    textLength: number;
    sizeBytes: { dom: number; screenshot: number };
}

/**
 * Extrahiert die drei Artefakte aus einer bereits navigierten Seite. Wirft
 * nicht; bei Teil-Fehler werden leere Strings/Buffers zurückgegeben und die
 * Pipeline entscheidet weiter.
 */
export async function captureArtifacts(page: Page): Promise<SnapshotArtifacts> {
    let domHtml = '';
    let screenshot: Buffer = Buffer.alloc(0);
    let textExtract = '';

    try {
        domHtml = await page.content();
    } catch { /* leer lassen */ }

    try {
        // Full-page PNG. JPEG wäre kleiner, aber PNG ist robuster bei Diff-Reviews.
        screenshot = await page.screenshot({ fullPage: true, type: 'png' });
    } catch { /* leer lassen */ }

    try {
        textExtract = await page.evaluate(() =>
            (document.body?.innerText ?? '').slice(0, 200_000)
        );
    } catch { /* leer lassen */ }

    return { domHtml, screenshot, textExtract };
}

/**
 * Lädt Artefakte nach Supabase Storage. Gibt die Pfade zurück, die dann in
 * der `snapshots`-Row gespeichert werden.
 */
export async function uploadArtifacts(
    sb: SupabaseClient,
    bucket: string,
    oemSlug: string,
    url: string,
    capturedAt: Date,
    artifacts: SnapshotArtifacts
): Promise<UploadedSnapshot> {
    const datePart = capturedAt.toISOString().slice(0, 10);
    const urlHash = hashUrl(url);
    const base = `${oemSlug}/${datePart}/${urlHash}`;

    const domPath = `${base}/dom.html`;
    const screenshotPath = `${base}/screenshot.png`;

    // DOM
    if (artifacts.domHtml.length > 0) {
        const { error } = await sb.storage
            .from(bucket)
            .upload(domPath, Buffer.from(artifacts.domHtml, 'utf8'), {
                contentType: 'text/html; charset=utf-8',
                upsert: true,
            });
        if (error) throw new Error(`DOM-Upload fehlgeschlagen (${domPath}): ${error.message}`);
    }

    // Screenshot
    if (artifacts.screenshot.length > 0) {
        const { error } = await sb.storage
            .from(bucket)
            .upload(screenshotPath, artifacts.screenshot, {
                contentType: 'image/png',
                upsert: true,
            });
        if (error) throw new Error(`Screenshot-Upload fehlgeschlagen (${screenshotPath}): ${error.message}`);
    }

    // Public-URL (nur wenn Bucket öffentlich ist; sonst null – das ist ok
    // fürs MVP, Lovable würde dann signed URLs ziehen)
    let publicUrl: string | null = null;
    try {
        const { data } = sb.storage.from(bucket).getPublicUrl(screenshotPath);
        publicUrl = data?.publicUrl ?? null;
    } catch { /* ignore */ }

    return {
        domHtmlPath: artifacts.domHtml.length > 0 ? domPath : '',
        screenshotPath: artifacts.screenshot.length > 0 ? screenshotPath : '',
        screenshotPublicUrl: publicUrl,
        textLength: artifacts.textExtract.length,
        sizeBytes: {
            dom: Buffer.byteLength(artifacts.domHtml, 'utf8'),
            screenshot: artifacts.screenshot.length,
        },
    };
}

/**
 * Stabiler, kurzer Hash der URL – für Storage-Pfade.
 */
function hashUrl(url: string): string {
    return createHash('sha1').update(url).digest('hex').slice(0, 12);
}
