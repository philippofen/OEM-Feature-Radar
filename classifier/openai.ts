/**
 * classifier/openai.ts
 * ---------------------------------------------------------------------------
 * OpenAI-Wrapper für zwei Aufgaben:
 *   1. Validator-Call mit GPT-4o-mini (günstige Zweit-Meinung zur
 *      Claude-Klassifikation).
 *   2. Embeddings mit text-embedding-3-small (für Dedup via pgvector).
 *
 * Wie bei claude.ts: dünn, stateless, JSON-strict, retry.
 * ---------------------------------------------------------------------------
 */

import OpenAI from 'openai';

export const OPENAI_MODEL_VALIDATOR = 'gpt-4o-mini';
export const OPENAI_MODEL_EMBEDDING = 'text-embedding-3-small';
export const EMBEDDING_DIM = 1536;

let client: OpenAI | null = null;

function getClient(): OpenAI {
    if (client) return client;
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('OPENAI_API_KEY nicht gesetzt');
    client = new OpenAI({ apiKey });
    return client;
}

// ---------------------------------------------------------------------------
// Validator-Call
// ---------------------------------------------------------------------------

export interface ValidatorJsonOptions {
    maxTokens?: number;
    temperature?: number;
    system?: string;
    maxRetries?: number;
}

export async function callValidatorJson<T = unknown>(
    userPrompt: string,
    opts: ValidatorJsonOptions = {}
): Promise<T> {
    const {
        maxTokens = 512,
        temperature = 0,
        system,
        maxRetries = 3,
    } = opts;

    const openai = getClient();

    let attempt = 0;
    let lastErr: unknown = null;

    while (attempt <= maxRetries) {
        try {
            const response = await openai.chat.completions.create({
                model: OPENAI_MODEL_VALIDATOR,
                max_tokens: maxTokens,
                temperature,
                response_format: { type: 'json_object' },
                messages: [
                    ...(system ? [{ role: 'system' as const, content: system }] : []),
                    { role: 'user' as const, content: userPrompt },
                ],
            });

            const text = response.choices[0]?.message?.content ?? '';
            if (!text) throw new Error('Leere Validator-Antwort');
            return JSON.parse(text) as T;
        } catch (err) {
            lastErr = err;
            if (!isRetryable(err) || attempt === maxRetries) break;
            const backoff = 800 * Math.pow(2, attempt) + Math.floor(Math.random() * 300);
            await sleep(backoff);
            attempt++;
        }
    }

    throw new Error(`Validator call failed: ${formatError(lastErr)}`);
}

// ---------------------------------------------------------------------------
// Embeddings
// ---------------------------------------------------------------------------

export async function embedText(text: string): Promise<number[]> {
    const openai = getClient();
    const input = text.slice(0, 8000); // harte Obergrenze, spart Kosten

    let attempt = 0;
    let lastErr: unknown = null;

    while (attempt <= 3) {
        try {
            const response = await openai.embeddings.create({
                model: OPENAI_MODEL_EMBEDDING,
                input,
            });
            const vec = response.data[0]?.embedding;
            if (!vec || vec.length !== EMBEDDING_DIM) {
                throw new Error(`Unerwartete Embedding-Dimension: ${vec?.length}`);
            }
            return vec;
        } catch (err) {
            lastErr = err;
            if (!isRetryable(err) || attempt === 3) break;
            const backoff = 800 * Math.pow(2, attempt) + Math.floor(Math.random() * 300);
            await sleep(backoff);
            attempt++;
        }
    }

    throw new Error(`Embedding failed: ${formatError(lastErr)}`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
