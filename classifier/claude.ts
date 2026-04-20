/**
 * classifier/claude.ts
 * ---------------------------------------------------------------------------
 * Dünner Wrapper um das Anthropic Messages-API.
 *
 * Liefert zwei Funktionen:
 *   - callClaudeJson(): Prompt rein, JSON raus. Retry auf Rate-Limits.
 *   - CLAUDE_MODEL:     zentrale Modell-Konstante.
 *
 * Designregeln:
 *   - Kein State, keine Caches. Jeder Call ist autark.
 *   - JSON wird strikt geparst. Wenn das Modell Text drumherum produziert,
 *     extrahieren wir das erste vollständige JSON-Objekt.
 *   - Fehler werfen; der Aufrufer (pipeline.ts) entscheidet über Fallbacks.
 * ---------------------------------------------------------------------------
 */

import Anthropic from '@anthropic-ai/sdk';

export const CLAUDE_MODEL = 'claude-sonnet-4-5-20250929';
// Hinweis: Modell-String bei Bedarf in shared/config.ts zentralisieren.
// Für das MVP hier hart, um eine Abhängigkeit zu sparen.

let client: Anthropic | null = null;

function getClient(): Anthropic {
    if (client) return client;
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY nicht gesetzt');
    client = new Anthropic({ apiKey });
    return client;
}

export interface ClaudeJsonOptions {
    /** Max Tokens der Antwort. Klein halten – unsere Prompts sind strukturiert. */
    maxTokens?: number;
    /** Temperatur. Für Klassifikation 0, für Post-Generierung 0.3. */
    temperature?: number;
    /** Optional: System-Prompt. */
    system?: string;
    /** Max Retries bei 429/5xx. Default 3. */
    maxRetries?: number;
}

/**
 * Schickt einen User-Prompt an Claude und erzwingt ein JSON-Objekt als Antwort.
 * Wenn das Modell Text drumherum generiert, wird das erste vollständige
 * JSON-Objekt geparst.
 */
export async function callClaudeJson<T = unknown>(
    userPrompt: string,
    opts: ClaudeJsonOptions = {}
): Promise<T> {
    const {
        maxTokens = 1024,
        temperature = 0,
        system,
        maxRetries = 3,
    } = opts;

    const anthropic = getClient();

    let attempt = 0;
    let lastErr: unknown = null;

    while (attempt <= maxRetries) {
        try {
            const response = await anthropic.messages.create({
                model: CLAUDE_MODEL,
                max_tokens: maxTokens,
                temperature,
                system,
                messages: [{ role: 'user', content: userPrompt }],
            });

            // Text-Content-Blöcke zusammensetzen
            const text = response.content
                .filter((b): b is Anthropic.TextBlock => b.type === 'text')
                .map((b) => b.text)
                .join('\n');

            return parseFirstJson<T>(text);
        } catch (err) {
            lastErr = err;
            if (!isRetryable(err) || attempt === maxRetries) break;
            const backoff = 1000 * Math.pow(2, attempt) + Math.floor(Math.random() * 300);
            await sleep(backoff);
            attempt++;
        }
    }

    throw new Error(`Claude call failed: ${formatError(lastErr)}`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseFirstJson<T>(text: string): T {
    // Schneller Pfad
    const trimmed = text.trim();
    try {
        return JSON.parse(trimmed) as T;
    } catch {
        /* weiter unten versuchen */
    }

    // Fallback: erstes balanciertes {...}-Objekt finden
    const start = trimmed.indexOf('{');
    if (start < 0) throw new Error(`Keine JSON-Öffnung in Antwort: ${trimmed.slice(0, 200)}`);

    let depth = 0;
    let inStr = false;
    let escape = false;

    for (let i = start; i < trimmed.length; i++) {
        const ch = trimmed[i];

        if (inStr) {
            if (escape) { escape = false; continue; }
            if (ch === '\\') { escape = true; continue; }
            if (ch === '"') inStr = false;
            continue;
        }

        if (ch === '"') { inStr = true; continue; }
        if (ch === '{') depth++;
        else if (ch === '}') {
            depth--;
            if (depth === 0) {
                const slice = trimmed.slice(start, i + 1);
                return JSON.parse(slice) as T;
            }
        }
    }

    throw new Error(`Kein balanciertes JSON in Antwort: ${trimmed.slice(0, 200)}`);
}

function isRetryable(err: unknown): boolean {
    if (!err || typeof err !== 'object') return false;
    const anyErr = err as { status?: number; message?: string };
    if (anyErr.status === 429) return true;
    if (anyErr.status && anyErr.status >= 500 && anyErr.status < 600) return true;
    const msg = (anyErr.message ?? '').toLowerCase();
    return msg.includes('timeout') || msg.includes('econnreset');
}

function formatError(err: unknown): string {
    if (!err) return 'unknown';
    if (err instanceof Error) return err.message;
    return String(err);
}

function sleep(ms: number): Promise<void> {
    return new Promise((res) => setTimeout(res, ms));
}
