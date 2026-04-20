/**
 * shared/config.ts
 * ---------------------------------------------------------------------------
 * Zentrale Konfig + ENV-Loader. Wird von allen Einstiegspunkten aufgerufen,
 * damit fehlende ENVs früh (und einheitlich) auffallen.
 * ---------------------------------------------------------------------------
 */

export interface AppConfig {
    supabaseUrl: string;
    supabaseServiceKey: string;
    anthropicApiKey: string;
    openaiApiKey: string;
    proxyUrl: string | null;
    storageBucket: string;
    logLevel: 'debug' | 'info' | 'warn' | 'error';
}

export function loadConfig(): AppConfig {
    const req = (name: string): string => {
        const v = process.env[name];
        if (!v || v.length === 0) {
            throw new Error(`Environment variable missing: ${name}`);
        }
        return v;
    };
    const opt = (name: string, fallback: string | null = null): string | null => {
        const v = process.env[name];
        return v && v.length > 0 ? v : fallback;
    };

    return {
        supabaseUrl: req('SUPABASE_URL'),
        supabaseServiceKey: req('SUPABASE_SERVICE_KEY'),
        anthropicApiKey: req('ANTHROPIC_API_KEY'),
        openaiApiKey: req('OPENAI_API_KEY'),
        proxyUrl: opt('PROXY_URL'),
        storageBucket: opt('STORAGE_BUCKET', 'oem-snapshots') ?? 'oem-snapshots',
        logLevel: (opt('LOG_LEVEL', 'info') as AppConfig['logLevel']) ?? 'info',
    };
}

// -----------------------------------------------------------------------------
// Operational Limits
// -----------------------------------------------------------------------------

export const CRAWL_LIMITS = {
    /** Pause zwischen Requests auf dieselbe OEM-Domain (ms). */
    perOemRateDelayMs: 5000,
    /** Harte Obergrenze Page-Load (ms). */
    pageLoadTimeoutMs: 45000,
    /** Wartezeit nach Netzwerk-Idle, um Lazy-Loading zu erfassen. */
    postLoadWaitMs: 2500,
    /** Max. Retries pro URL. */
    maxRetriesPerUrl: 2,
    /** Max. Gesamt-Zeit pro OEM-Run (ms). Sicherheitsnetz gegen hängende Jobs. */
    maxOemRunMs: 15 * 60 * 1000,
} as const;

export const PIPELINE_LIMITS = {
    /** Max. Kandidaten pro URL, die zur LLM-Stufe gehen (harte Obergrenze). */
    maxCandidatesPerUrl: 8,
    /**
     * Max. Posts pro OEM+Bereich pro Run. Wird dieser Wert überschritten,
     * landen alle weiteren Kandidaten in `pending_review` (Redesign-Verdacht).
     */
    maxPostsPerOemAreaPerRun: 3,
} as const;
