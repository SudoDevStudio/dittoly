/**
 * Types for a Dittoly module's TypeScript source (module.ts). They describe the `ctx` the sandbox runner
 * (sandbox-runtime/runner.mjs) passes to each action, and are global so a module needs no import statement:
 * module code may not import anything. Git sync writes this file to a synced repository as types/dittoly.d.ts.
 */

declare global {
  /** What `new ctx.ActionError(...)` makes: throw it to fail an action. */
  interface ModuleActionError extends Error {
    readonly code: string;
    readonly retryable: boolean;
  }
  /** A snake_case code (up to 40 characters); retryable only for 429 and 5xx answers. */
  interface ModuleActionErrorConstructor {
    new (code: string, options?: { retryable?: boolean }): ModuleActionError;
  }

  type HttpMethod = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

  /** A multipart part: text, or a file given as a data URL (e.g. a screenshot). */
  type MultipartPart = { name: string; value: string } | { name: string; filename: string; dataUrl: string };

  interface HttpRequest {
    method?: HttpMethod;
    /** https only, on a host the manifest declares. */
    url: string;
    headers?: Record<string, string>;
    /** Sent as JSON. */
    json?: unknown;
    /** Sent as is. */
    body?: string;
    /** Sent as a multipart form (10 MB at most). */
    multipart?: MultipartPart[];
    /** A credential id from the manifest; the runtime attaches it. */
    credential?: string;
  }

  interface HttpResponse {
    status: number;
    ok: boolean;
    /** Only content-type, location, link, retry-after, x-total, x-next-page and etag. */
    headers: Record<string, string>;
    body: string;
    json(): unknown;
  }

  interface DbResult {
    rows: Record<string, unknown>[];
    rowCount: number;
    truncated: boolean;
  }

  /** The Playwright-like subset browser scripts get as ctx.page. */
  interface BrowserLocator {
    locator(selector: string): BrowserLocator;
    getByRole(role: string, options?: { name?: string | RegExp; exact?: boolean }): BrowserLocator;
    getByText(text: string | RegExp, options?: { exact?: boolean }): BrowserLocator;
    getByLabel(text: string | RegExp, options?: { exact?: boolean }): BrowserLocator;
    getByPlaceholder(text: string | RegExp, options?: { exact?: boolean }): BrowserLocator;
    getByTestId(id: string): BrowserLocator;
    getByAltText(text: string | RegExp, options?: { exact?: boolean }): BrowserLocator;
    getByTitle(text: string | RegExp, options?: { exact?: boolean }): BrowserLocator;
    first(): BrowserLocator;
    last(): BrowserLocator;
    nth(index: number): BrowserLocator;
    filter(options: { hasText?: string | RegExp; hasNotText?: string | RegExp }): BrowserLocator;
    click(options?: Record<string, unknown>): Promise<void>;
    dblclick(options?: Record<string, unknown>): Promise<void>;
    fill(value: string): Promise<void>;
    press(key: string): Promise<void>;
    pressSequentially(text: string, options?: { delay?: number }): Promise<void>;
    check(): Promise<void>;
    uncheck(): Promise<void>;
    selectOption(value: string | string[]): Promise<string[]>;
    hover(): Promise<void>;
    focus(): Promise<void>;
    clear(): Promise<void>;
    textContent(): Promise<string | null>;
    innerText(): Promise<string>;
    inputValue(): Promise<string>;
    getAttribute(name: string): Promise<string | null>;
    isVisible(): Promise<boolean>;
    isHidden(): Promise<boolean>;
    isChecked(): Promise<boolean>;
    isEnabled(): Promise<boolean>;
    isDisabled(): Promise<boolean>;
    count(): Promise<number>;
    allTextContents(): Promise<string[]>;
    allInnerTexts(): Promise<string[]>;
    waitFor(options?: { state?: 'attached' | 'detached' | 'visible' | 'hidden'; timeout?: number }): Promise<void>;
    /** A data URL. */
    screenshot(options?: Record<string, unknown>): Promise<string>;
    scrollIntoViewIfNeeded(): Promise<void>;
    /** Types the member's own credential; the script never sees it. */
    fillSecret(credential: string, options?: { part?: 'username' | 'password' }): Promise<void>;
  }

  interface BrowserPage extends Pick<BrowserLocator, 'locator' | 'getByRole' | 'getByText' | 'getByLabel' | 'getByPlaceholder' | 'getByTestId' | 'getByAltText' | 'getByTitle'> {
    goto(url: string, options?: Record<string, unknown>): Promise<void>;
    reload(): Promise<void>;
    goBack(): Promise<void>;
    goForward(): Promise<void>;
    url(): Promise<string>;
    title(): Promise<string>;
    content(): Promise<string>;
    waitForURL(url: string | RegExp, options?: { timeout?: number }): Promise<void>;
    waitForLoadState(state?: 'load' | 'domcontentloaded' | 'networkidle'): Promise<void>;
    waitForTimeout(ms: number): Promise<void>;
    /** A data URL. */
    screenshot(options?: Record<string, unknown>): Promise<string>;
    setViewportSize(size: { width: number; height: number }): Promise<void>;
    /** Asks the run's member to take over in the live view; waits until they press Continue. */
    askForHelp(message: string): Promise<void>;
    keyboard: { press(key: string): Promise<void>; type(text: string): Promise<void> };
  }

  interface Matchers {
    toBe(value: unknown): void;
    toEqual(value: unknown): void;
    toBeTruthy(): void;
    toBeFalsy(): void;
    toBeDefined(): void;
    toBeNull(): void;
    toContain(value: unknown): void;
    toMatch(value: string | RegExp): void;
    toHaveLength(length: number): void;
    toBeGreaterThan(n: number): void;
    toBeGreaterThanOrEqual(n: number): void;
    toBeLessThan(n: number): void;
    toBeLessThanOrEqual(n: number): void;
  }

  interface BrowserMatchers {
    toBeVisible(options?: { timeout?: number }): Promise<void>;
    toBeHidden(options?: { timeout?: number }): Promise<void>;
    toBeChecked(options?: { timeout?: number }): Promise<void>;
    toBeEnabled(options?: { timeout?: number }): Promise<void>;
    toBeDisabled(options?: { timeout?: number }): Promise<void>;
    toHaveText(text: string | RegExp, options?: { timeout?: number }): Promise<void>;
    toContainText(text: string | RegExp, options?: { timeout?: number }): Promise<void>;
    toHaveValue(value: string | RegExp, options?: { timeout?: number }): Promise<void>;
    toHaveCount(count: number, options?: { timeout?: number }): Promise<void>;
    toHaveAttribute(name: string, value: string | RegExp, options?: { timeout?: number }): Promise<void>;
    toHaveTitle(title: string | RegExp, options?: { timeout?: number }): Promise<void>;
    toHaveURL(url: string | RegExp, options?: { timeout?: number }): Promise<void>;
  }

  /** The second argument of every action. */
  interface ModuleContext {
    http: { request(req: HttpRequest): Promise<HttpResponse> };
    smtp: {
      send(m: { endpoint: string; to: string | string[]; cc?: string | string[]; bcc?: string | string[]; replyTo?: string; subject: string; text?: string; html?: string }): Promise<{ accepted: string[]; rejected: string[] }>;
    };
    amqp: { publish(m: { endpoint: string; exchange: string; routingKey: string; message: unknown; headers?: Record<string, string>; persistent?: boolean }): Promise<unknown> };
    mqtt: { publish(m: { endpoint: string; topic: string; message: unknown; qos?: 0 | 1; retain?: boolean }): Promise<unknown> };
    ws: { exchange(m: { endpoint: string; path: string; send?: unknown[]; maxMessages?: number; maxMs?: number }): Promise<{ messages: string[]; closed: boolean }> };
    sse: { read(m: { endpoint: string; path: string; maxEvents?: number; maxMs?: number }): Promise<{ status: number; events: { event: string; data: string; id?: string }[] }> };
    /** A query the manifest declares, by id, with its parameters. */
    db: { query(m: { endpoint: string; query: string; params?: Record<string, unknown> }): Promise<DbResult> };
    /**
     * The team data tables the manifest declares in "tables", by name (always the run's team's). A row is an object of
     * the table's columns, its key column included. put and delete: tables declared "write", in write actions only.
     */
    tables: {
      get(table: string, key: string): Promise<Record<string, unknown> | null>;
      list(table: string, options?: { where?: { column: string; equals: unknown }; limit?: number }): Promise<Record<string, unknown>[]>;
      put(table: string, key: string, values: Record<string, unknown>): Promise<Record<string, unknown>>;
      delete(table: string, key: string): Promise<boolean>;
    };
    /** Browser scripts only (a manifest with a "browser" section). */
    readonly page: BrowserPage;
    expect(target: BrowserPage | BrowserLocator, options?: { timeout?: number }): BrowserMatchers & { not: BrowserMatchers };
    expect(value: unknown): Matchers & { not: Matchers };
    /** The organization's values for the settings the manifest declares. */
    readonly settings: Readonly<Record<string, string>>;
    ActionError: ModuleActionErrorConstructor;
  }

  /** What a module exports: one function per manifest action, same names. */
  type ModuleActions = Record<string, (input: never, ctx: ModuleContext) => Promise<unknown>>;
}

export {};
