#!/usr/bin/env tsx
/**
 * scripts/run-daily.ts
 * ---------------------------------------------------------------------------
 * End-to-End-Einstiegspunkt für den täglichen Crawl-Run.
 *
 * Ablauf (siehe Architektur Abschnitt 12):
 *   1. Crawl-Run-Row anlegen (status=running).
 *   2. Aktive URLs laden (optional per --oem filtern).
 *   3. Pro URL:
 *      - Playwright navigiert, Snapshot erzeugen, Uploads nach Storage.
 *      - Inventory extrahieren, snapshots-Row schreiben.
 *      - Letzten Vortages-Snapshot ziehen, diffen.
 *      - Pro Kandidat: pipeline.runPipeline -> Ergebnis in DB schreiben.
 *   4. Stats aktualisieren, Crawl-Run abschließen.
 *
 * CLI:
 *   pnpm tsx scripts/run-daily.ts                # alle OEMs
 *   pnpm tsx scripts/run-daily.ts --oem bmw      # nur BMW
 *   pnpm tsx scripts/run-daily.ts --oem audi
 *   pnpm tsx scripts/run-daily.ts --dry-run      # nichts publishen, nur loggen
 *
 * Exit-Codes:
 *   0  success oder partial_failure
 *   1  fatale Crashes (sollte nie passieren, Fehlertoleranz ist im Code)
 * ---------------------------------------------------------------------------
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Browser } from 'playwright';

import { loadConfig, CRAWL_LIMITS, PIPELINE_LIMITS } from '../shared/config';
import { launchBrowser, newContext, navigate } from '../crawler/core/browser';
import { captureArtifacts, uploadArtifacts } from '../crawler/core/snapshot';
import { extractInventory, type UiInventory } from '../crawler/core/inventory';
import { diffInventories } from '../classifier/diff';
import {
    runPipeline,
    makeSupabaseDedupStore,
    PIPELINE_VERSION,
    type PipelineInput,
    type PipelineOutput,
} from '../classifier/pipeline';

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface CliArgs {
    oem: string | null;
    dryRun: boolean;
}

function parseArgs(argv: string[]): CliArgs {
    const args: CliArgs = { oem: null, dryRun: false };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--oem' && argv[i + 1]) {
            args.oem = argv[i + 1].toLowerCase();
            i++;
        } else if (a === '--dry-run') {
            args.dryRun = true;
        }
    }
    return args;
}

// ---------------------------------------------------------------------------
// DB-Types (nur das, was wir in diesem Skript anfassen)
// ---------------------------------------------------------------------------

interface OemRow {
    id: string;
    slug: string;
    name: string;
}

interface WatchedUrlRow {
    id: string;
    oem_id: string;
    url: string;
    product_area: 'configurator' | 'new_sales' | 'used_sales';
    page_type: string;
    is_active: boolean;
}

interface SnapshotRow {
    id: string;
    watched_url_id: string;
    captured_at: string;
    inventory: UiInventory | Record<string, never>;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
    const cli = parseArgs(process.argv.slice(2));
    const cfg = loadConfig();
    const sb = createClient(cfg.supabaseUrl, cfg.supabaseServiceKey, {
        auth: { persistSession: false },
    });

    log('info', `Run start. oem=${cli.oem ?? 'all'} dryRun=${cli.dryRun} version=${PIPELINE_VERSION}`);

    // --- 1. Crawl-Run anlegen ---
    const { data: runData, error: runErr } = await sb
        .from('crawl_runs')
        .insert({ status: 'running', trigger: 'cron', stats: {} })
        .select('id')
        .single();
    if (runErr || !runData) {
        throw new Error(`crawl_runs-Insert fehlgeschlagen: ${runErr?.message}`);
    }
    const crawlRunId = runData.id as string;
    log('info', `crawl_run_id=${crawlRunId}`);

    const stats = {
        urls_crawled: 0,
        urls_failed: 0,
        snapshots_saved: 0,
        candidates_total: 0,
        candidates_accepted: 0,
        posts_published: 0,
        rejections_by_reason: {} as Record<string, number>,
    };

    let browser: Browser | null = null;

    try {
        // --- 2. OEMs + URLs laden ---
        const oems = await loadOems(sb, cli.oem);
        if (oems.length === 0) {
            log('warn', 'Keine OEMs gefunden, Run wird abgebrochen.');
            await finalizeRun(sb, crawlRunId, 'success', stats);
            return;
        }

        // --- 3. Browser starten ---
        browser = await launchBrowser({ headless: true, proxyUrl: cfg.proxyUrl });

        for (const oem of oems) {
            const oemStart = Date.now();
            log('info', `→ OEM: ${oem.name}`);

            const urls = await loadWatchedUrls(sb, oem.id);
            log('info', `  ${urls.length} URLs aktiv`);

            // Zähler pro (oem, area) für Max-Post-Gate
            const postsPerArea = new Map<string, number>();

            for (const wurl of urls) {
                // Run-Time-Safety: pro OEM harte Obergrenze
                if (Date.now() - oemStart > CRAWL_LIMITS.maxOemRunMs) {
                    log('warn', `  Zeit-Limit für ${oem.slug} überschritten, überspringe Rest.`);
                    break;
                }

                stats.urls_crawled++;
                try {
                    const context = await newContext(browser);
                    const page = await context.newPage();

                    const nav = await navigate(page, wurl.url, oem.slug);

                    if (!nav.success || (nav.httpStatus !== null && nav.httpStatus !== 200)) {
                        stats.urls_failed++;
                        log('warn', `  ✗ ${wurl.url} – status=${nav.httpStatus} err=${nav.error}`);

                        // Fehler-Snapshot trotzdem eintragen (für Debug)
                        await sb.from('snapshots').insert({
                            crawl_run_id: crawlRunId,
                            watched_url_id: wurl.id,
                            http_status: nav.httpStatus,
                            load_time_ms: nav.loadTimeMs,
                            error: nav.error ?? 'unknown',
                            inventory: {},
                        });

                        await context.close();
                        await sleep(CRAWL_LIMITS.perOemRateDelayMs);
                        continue;
                    }

                    // Snapshot-Artefakte + Upload
                    const artifacts = await captureArtifacts(page);
                    const uploaded = await uploadArtifacts(
                        sb,
                        cfg.storageBucket,
                        oem.slug,
                        wurl.url,
                        new Date(),
                        artifacts
                    );

                    const inventory = await extractInventory(page);

                    // Snapshot-Row schreiben
                    const { data: snapRow, error: snapErr } = await sb
                        .from('snapshots')
                        .insert({
                            crawl_run_id: crawlRunId,
                            watched_url_id: wurl.id,
                            dom_html_path: uploaded.domHtmlPath || null,
                            screenshot_path: uploaded.screenshotPath || null,
                            text_extract: artifacts.textExtract,
                            inventory,
                            http_status: nav.httpStatus,
                            load_time_ms: nav.loadTimeMs,
                        })
                        .select('id')
                        .single();

                    await context.close();

                    if (snapErr || !snapRow) {
                        stats.urls_failed++;
                        log('warn', `  ✗ snapshot-insert fehlgeschlagen: ${snapErr?.message}`);
                        await sleep(CRAWL_LIMITS.perOemRateDelayMs);
                        continue;
                    }
                    stats.snapshots_saved++;
                    const newSnapshotId = snapRow.id as string;

                    // --- Vortages-Snapshot laden ---
                    const prev = await loadPreviousSnapshot(sb, wurl.id, newSnapshotId);

                    // --- Diff ---
                    const candidates = diffInventories(
                        prev?.inventory && Object.keys(prev.inventory).length > 0
                            ? (prev.inventory as UiInventory)
                            : null,
                        inventory
                    ).slice(0, PIPELINE_LIMITS.maxCandidatesPerUrl);

                    stats.candidates_total += candidates.length;
                    if (candidates.length > 0) {
                        log('info', `  ${candidates.length} Kandidat(en) auf ${wurl.url}`);
                    }

                    // --- Pipeline pro Kandidat ---
                    const dedupStore = makeSupabaseDedupStore(sb);

                    for (const candidate of candidates) {
                        const areaKey = `${oem.slug}|${wurl.product_area}`;
                        const currentAreaCount = postsPerArea.get(areaKey) ?? 0;

                        const pipelineInput: PipelineInput = {
                            candidate,
                            oldInventory: (prev?.inventory as UiInventory | null) ?? null,
                            newInventory: inventory,
                            oem: { slug: oem.slug, name: oem.name, id: oem.id },
                            productArea: wurl.product_area,
                            url: wurl.url,
                            watchedUrlId: wurl.id,
                            snapshotFromId: prev?.id ?? null,
                            snapshotToId: newSnapshotId,
                        };

                        let result: PipelineOutput;
                        try {
                            result = await runPipeline(pipelineInput, dedupStore);
                        } catch (err) {
                            result = {
                                status: 'rejected',
                                reason: 'pipeline_error',
                                detail: err instanceof Error ? err.message : String(err),
                            };
                        }

                        // Kandidaten-Row in DB (immer, egal ob publish oder reject)
                        await writeCandidateRow(sb, pipelineInput, result, cli.dryRun);

                        if (result.status === 'published') {
                            // Max-Post-Gate
                            if (currentAreaCount >= PIPELINE_LIMITS.maxPostsPerOemAreaPerRun) {
                                log('warn', `  Max-Post-Gate: ${areaKey} hat ${currentAreaCount} Posts, weitere parken`);
                                continue;
                            }

                            if (!cli.dryRun) {
                                await publishPost(sb, result, uploaded.screenshotPublicUrl);
                                stats.posts_published++;
                                postsPerArea.set(areaKey, currentAreaCount + 1);
                            }
                            stats.candidates_accepted++;
                            log('info', `  ✓ Post: ${result.post.title}`);
                        } else {
                            const r = result.reason;
                            stats.rejections_by_reason[r] = (stats.rejections_by_reason[r] ?? 0) + 1;
                            log('debug', `  ✗ Kandidat verworfen (${r}): ${result.detail}`);
                        }
                    }

                    // Rate-Limit pro OEM
                    await sleep(CRAWL_LIMITS.perOemRateDelayMs);
                } catch (err) {
                    stats.urls_failed++;
                    log('error', `  ! unerwarteter Fehler bei ${wurl.url}: ${formatErr(err)}`);
                    await sleep(CRAWL_LIMITS.perOemRateDelayMs);
                }
            }
        }

        // --- 4. Abschluss ---
        const finalStatus = computeRunStatus(stats);
        await finalizeRun(sb, crawlRunId, finalStatus, stats);
        log('info', `Run done. status=${finalStatus} stats=${JSON.stringify(stats)}`);
    } catch (err) {
        log('error', `FATAL: ${formatErr(err)}`);
        await finalizeRun(sb, crawlRunId, 'failed', stats);
        process.exitCode = 1;
    } finally {
        if (browser) {
            try { await browser.close(); } catch { /* ignore */ }
        }
    }
}

// ---------------------------------------------------------------------------
// DB-Helfer
// ---------------------------------------------------------------------------

async function loadOems(sb: SupabaseClient, filterSlug: string | null): Promise<OemRow[]> {
    let q = sb.from('oems').select('id, slug, name');
    if (filterSlug) q = q.eq('slug', filterSlug);
    const { data, error } = await q;
    if (error) throw new Error(`OEM-Load: ${error.message}`);
    return (data ?? []) as OemRow[];
}

async function loadWatchedUrls(sb: SupabaseClient, oemId: string): Promise<WatchedUrlRow[]> {
    const { data, error } = await sb
        .from('watched_urls')
        .select('id, oem_id, url, product_area, page_type, is_active')
        .eq('oem_id', oemId)
        .eq('is_active', true);
    if (error) throw new Error(`watched_urls-Load: ${error.message}`);
    return (data ?? []) as WatchedUrlRow[];
}

/**
 * Lädt den letzten Snapshot einer URL VOR dem aktuellen. Wenn keiner
 * existiert, ist das der Erstkontakt → null.
 */
async function loadPreviousSnapshot(
    sb: SupabaseClient,
    watchedUrlId: string,
    excludeId: string
): Promise<SnapshotRow | null> {
    const { data, error } = await sb
        .from('snapshots')
        .select('id, watched_url_id, captured_at, inventory')
        .eq('watched_url_id', watchedUrlId)
        .neq('id', excludeId)
        .order('captured_at', { ascending: false })
        .limit(1);
    if (error) throw new Error(`prev-snapshot-Load: ${error.message}`);
    const row = data?.[0];
    return row ? (row as SnapshotRow) : null;
}

/**
 * Schreibt einen `change_candidates`-Eintrag – sowohl für akzeptierte
 * Kandidaten als auch für abgelehnte. Hilft später im Tuning der Thresholds.
 */
async function writeCandidateRow(
    sb: SupabaseClient,
    input: PipelineInput,
    result: PipelineOutput,
    dryRun: boolean
): Promise<void> {
    const base = {
        snapshot_from_id: input.snapshotFromId,
        snapshot_to_id: input.snapshotToId,
        watched_url_id: input.watchedUrlId,
        candidate_type: input.candidate.candidate_type,
        raw_diff: input.candidate.raw_diff,
        classifier_version: PIPELINE_VERSION,
    };

    if (result.status === 'published') {
        const row = {
            ...base,
            classifier_verdict: result.classifier.verdict === 'feature' ? 'feature' : 'removal',
            classifier_reasoning: result.classifier.reasoning,
            classifier_confidence: result.classifier.confidence,
            validator_verdict: result.validator.verdict,
            validator_reasoning: result.validator.reasoning,
            dedup_decision: 'unique',
            is_published: !dryRun,
        };
        await sb.from('change_candidates').insert(row);
    } else {
        const row: Record<string, unknown> = {
            ...base,
            classifier_verdict: result.classifier?.verdict ?? 'pending',
            classifier_reasoning: result.classifier?.reasoning ?? null,
            classifier_confidence: result.classifier?.confidence ?? null,
            validator_verdict: result.validator?.verdict ?? null,
            validator_reasoning: result.validator?.reasoning ?? null,
            rejection_reason: `${result.reason}: ${result.detail}`.slice(0, 500),
            is_published: false,
        };
        if (result.reason === 'duplicate') row.dedup_decision = 'duplicate';
        await sb.from('change_candidates').insert(row);
    }
}

/**
 * Publiziert einen erkannten Feature-Post: `feature_posts`-Row + Tag-Joins.
 */
async function publishPost(
    sb: SupabaseClient,
    result: Extract<PipelineOutput, { status: 'published' }>,
    screenshotPublicUrl: string | null
): Promise<void> {
    const post = result.post;

    // Insert in feature_posts
    const { data: inserted, error: insertErr } = await sb
        .from('feature_posts')
        .insert({
            slug: post.slug,
            oem_id: post.oem_id,
            product_area: post.product_area,
            title: post.title,
            short_description: post.short_description,
            url_to_feature: post.url_to_feature,
            old_snapshot_id: post.old_snapshot_id,
            new_snapshot_id: post.new_snapshot_id,
            old_vs_new: post.old_vs_new,
            screenshot_public_url: screenshotPublicUrl,
            confidence: post.confidence,
            evidence: post.evidence,
            embedding: post.embedding,
            is_visible: true,
        })
        .select('id')
        .single();

    if (insertErr || !inserted) {
        // Falls Slug-Kollision: Post nicht erzeugt, aber Candidate bleibt als Marker
        log('warn', `feature_posts-Insert fehlgeschlagen: ${insertErr?.message}`);
        return;
    }
    const postId = inserted.id as string;

    // Tags zuordnen
    if (post.tags.length > 0) {
        const { data: tagRows, error: tagErr } = await sb
            .from('tags')
            .select('id, slug')
            .in('slug', post.tags);
        if (tagErr) {
            log('warn', `tag-Load fehlgeschlagen: ${tagErr.message}`);
            return;
        }
        const joins = (tagRows ?? []).map((t) => ({ post_id: postId, tag_id: t.id }));
        if (joins.length > 0) {
            const { error: joinErr } = await sb.from('post_tags').insert(joins);
            if (joinErr) log('warn', `post_tags-Insert fehlgeschlagen: ${joinErr.message}`);
        }
    }
}

async function finalizeRun(
    sb: SupabaseClient,
    crawlRunId: string,
    status: 'success' | 'partial_failure' | 'failed',
    stats: Record<string, unknown>
): Promise<void> {
    await sb
        .from('crawl_runs')
        .update({
            status,
            finished_at: new Date().toISOString(),
            stats,
        })
        .eq('id', crawlRunId);
}

function computeRunStatus(stats: {
    urls_crawled: number;
    urls_failed: number;
}): 'success' | 'partial_failure' {
    if (stats.urls_crawled === 0) return 'success';
    const failRate = stats.urls_failed / stats.urls_crawled;
    return failRate > 0.3 ? 'partial_failure' : 'success';
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}

function formatErr(err: unknown): string {
    if (err instanceof Error) return `${err.name}: ${err.message}`;
    return String(err);
}

type LogLevel = 'debug' | 'info' | 'warn' | 'error';
const LEVEL_PRIORITY: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

function log(level: LogLevel, msg: string): void {
    const envLevel = (process.env.LOG_LEVEL as LogLevel) || 'info';
    if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[envLevel]) return;
    const ts = new Date().toISOString();
    const line = `[${ts}] ${level.toUpperCase()} ${msg}`;
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

main().catch((err) => {
    log('error', `UNCAUGHT: ${formatErr(err)}`);
    process.exit(1);
});
