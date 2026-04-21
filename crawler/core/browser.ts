/**
 * crawler/core/browser.ts
 * ---------------------------------------------------------------------------
 * Playwright-Launch + Page-Navigation + Cookie-Banner-Akzeptanz pro OEM.
 *
 * Designregeln:
 *  - Ein Browser pro Run (geteilt), eine frische Page pro URL.
 *  - Stealth-Plugin an: viele OEMs prÃ¼fen navigator.webdriver etc.
 *  - Navigation mit zwei Versuchen, networkidle + festem Puffer.
 *  - Cookie-Banner werden best-effort geschlossen; scheitert es, loggen
 *    wir das und crawlen trotzdem (Inventory-Filter verwirft dann meist
 *    die zu kleine Seite via isImplausibleSnapshot).
 * ---------------------------------------------------------------------------
 */

import { chromium as chromiumExtra } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import type { Browser, BrowserContext, Page } from 'playwright';

import { CRAWL_LIMITS } from '../../shared/config';

// Stealth einmalig aktivieren (Side-Effect).
chromiumExtra.use(StealthPlugin());

// ---------------------------------------------------------------------------
// Launch
// ---------------------------------------------------------------------------

export interface LaunchOptions {
    headless?: boolean;
    proxyUrl?: string | null;
}

export async function launchBrowser(opts: LaunchOptions = {}): Promise<Browser> {
    const { headless = true, proxyUrl = null } = opts;

    const browser = await chromiumExtra.launch({
        headless,
        args: [
            '--disable-blink-features=AutomationControlled',
            '--disable-dev-shm-usage',
            '--no-sandbox',
            '--disable-setuid-sandbox',
        ],
        proxy: proxyUrl ? { server: proxyUrl } : undefined,
    });

    return browser;
}

export async function newContext(browser: Browser): Promise<BrowserContext> {
    return browser.newContext({
        viewport: { width: 1440, height: 900 },
        deviceScaleFactor: 1,
        locale: 'de-DE',
        timezoneId: 'Europe/Berlin',
        userAgent:
            // Aktuelles Desktop-Chrome-UA. Bei Blocks tauschen.
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
            '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        extraHTTPHeaders: {
            'Accept-Language': 'de-DE,de;q=0.9,en;q=0.5',
        },
    });
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

export interface NavigationResult {
    success: boolean;
    httpStatus: number | null;
    loadTimeMs: number;
    error: string | null;
}

/**
 * Navigiert zur URL, wartet auf networkidle + festen Puffer, versucht
 * Cookie-Banner zu akzeptieren. Wirft nicht; gibt stattdessen ein
 * Ergebnisobjekt zurÃ¼ck.
 */
export async function navigate(
    page: Page,
    url: string,
    oemSlug: string
): Promise<NavigationResult> {
    const start = Date.now();
    let httpStatus: number | null = null;
    let lastError: string | null = null;

    for (let attempt = 0; attempt <= CRAWL_LIMITS.maxRetriesPerUrl; attempt++) {
        try {
            const response = await page.goto(url, {
                waitUntil: 'domcontentloaded',
                timeout: CRAWL_LIMITS.pageLoadTimeoutMs,
            });
            httpStatus = response?.status() ?? null;

            // Cookie-Banner best-effort
            await acceptCookies(page, oemSlug);

            // Lazy-loaded Inhalte nachladen lassen
            await page.waitForTimeout(CRAWL_LIMITS.postLoadWaitMs);

            // Soft-Scroll, damit unten angedockte Module auch rendern
            await softScroll(page);

            return {
                success: true,
                httpStatus,
                loadTimeMs: Date.now() - start,
                error: null,
            };
        } catch (err) {
            lastError = err instanceof Error ? err.message : String(err);
            if (attempt < CRAWL_LIMITS.maxRetriesPerUrl) {
                await page.waitForTimeout(1500 * (attempt + 1));
            }
        }
    }

    return {
        success: false,
        httpStatus,
        loadTimeMs: Date.now() - start,
        error: lastError,
    };
}

// ---------------------------------------------------------------------------
// Cookie-Banner-Helpers pro OEM
// ---------------------------------------------------------------------------

/**
 * Kandidaten-Selektoren, die wir der Reihe nach probieren. Erster Treffer
 * wird geklickt. Wenn nichts klickbar ist, geben wir auf und crawlen die
 * Seite trotzdem.
 *
 * Reihenfolge: OEM-spezifisch â†’ generisch.
 */
const COOKIE_SELECTORS: Record<string, string[]> = {
    bmw: [
        '#onetrust-accept-btn-handler',
        'button:has-text("Alle akzeptieren")',
        'button:has-text("Akzeptieren")',
    ],
    audi: [
        'button#cookie-accept-button',
        'button:has-text("Alle akzeptieren")',
        'button[data-testid="uc-accept-all-button"]',
        '[data-testid="uc-accept-all-button"]',
        'button:has-text("Akzeptieren und weiter")',
        'button:has-text("Akzeptieren")',
        '#onetrust-accept-btn-handler',
        'button[mode="primary"]:has-text("Alle akzeptieren")',
    ],
    mercedes: [
        '#onetrust-accept-btn-handler',
        'button:has-text("Alle akzeptieren")',
        'button:has-text("Zustimmen")',
        'button[data-test="cookie-accept-all"]',
    ],
    porsche: [
        'button:has-text("Alle akzeptieren")',
        'button:has-text("Akzeptieren")',
        'pcom-consent-banner >>> button:has-text("Akzeptieren")',
    ],
    vw: [
        'button[data-testid="uc-accept-all-button"]',
        'button:has-text("Alle akzeptieren")',
        'button:has-text("Zustimmen")',
        '#onetrust-accept-btn-handler',
    ],
    _generic: [
        '#onetrust-accept-btn-handler',
        'button:has-text("Alle akzeptieren")',
        'button:has-text("Akzeptieren")',
        'button:has-text("Zustimmen")',
        'button[aria-label*="akzeptier" i]',
    ],
};

async function acceptCookies(page: Page, oemSlug: string): Promise<void> {
    const selectors = [
        ...(COOKIE_SELECTORS[oemSlug] ?? []),
        ...COOKIE_SELECTORS._generic,
    ];

    for (const sel of selectors) {
        try {
            const locator = page.locator(sel).first();
            const count = await locator.count();
            if (count === 0) continue;
            if (!(await locator.isVisible())) continue;

            await locator.click({ timeout: 3000 });
            // Kurzer Puffer, damit Banner-Overlay abgebaut wird
            await page.waitForTimeout(800);
            return;
        } catch {
            // NÃ¤chster Selektor
        }
    }
    // Kein Banner gefunden oder nicht klickbar â€“ das ist ok.
}

// ---------------------------------------------------------------------------
// Hilfs-Utility: sanftes Scrollen fÃ¼r Lazy-Loading
// ---------------------------------------------------------------------------

async function softScroll(page: Page): Promise<void> {
    try {
        await page.evaluate(async () => {
            const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
            const distance = 600;
            const maxSteps = 8;
            for (let i = 0; i < maxSteps; i++) {
                window.scrollBy(0, distance);
                await delay(150);
            }
            window.scrollTo(0, 0);
        });
    } catch {
        // irrelevant â€“ war nur Best-Effort
    }
}
