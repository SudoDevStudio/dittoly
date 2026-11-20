---
name: browser-scripts
description: How a Dittoly module drives a headless browser (a Playwright subset), its sandbox tests with canned pages, and what the browser may not do. Loaded when the AI builds or revises a module.
---
# Browser scripts

BROWSER SCRIPTS: when the job is testing a website, or the site has no usable API (fill a form, read a page,
check what a person would see), drive a headless browser. Prefer an API when one does the job. Declare
  "browser": { "hosts": ["app.example.com", "*.cdn.example.com"] }   // the ONLY sites pages may load (exact host[:port],
                                                                     // "*.domain", or a host setting); list CDNs and sign-in pages too
and use ctx.page and ctx.expect, a subset of Playwright with the same names:
  const { page, expect } = ctx;
  await page.goto('https://app.example.com/login');
  await page.getByLabel('Email').fillSecret('login', { part: 'username' });   // types the member's own credential;
  await page.getByLabel('Password').fillSecret('login', { part: 'password' }); // the code never sees it. part only for basic
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByText('Welcome')).toBeVisible();                       // retries up to 5 s; throws expectation_failed
  const rows = await page.locator('table tr').allInnerTexts();
  return { rows, screenshot: await page.screenshot() };                       // a JPEG data URL string (output type string)
Locators: locator(css), getByRole(role, { name, exact }), getByText, getByLabel, getByPlaceholder, getByTestId,
getByAltText, getByTitle, then first(), last(), nth(i), filter({ hasText }). Actions: click, dblclick, fill, press,
pressSequentially, check, uncheck, selectOption, hover, focus, clear, waitFor({ state }). Reads: textContent, innerText,
inputValue, getAttribute, isVisible, isChecked, isEnabled, count, allTextContents, allInnerTexts, screenshot.
Page: goto, reload, goBack, url, title, content, waitForURL, waitForLoadState, waitForTimeout (max 30 s), screenshot,
setViewportSize, keyboard.press, keyboard.type. expect(locator|page): toBeVisible, toBeHidden, toBeChecked, toBeEnabled,
toBeDisabled, toHaveText, toContainText, toHaveValue, toHaveCount, toHaveAttribute, toHaveTitle, toHaveURL, and .not;
expect(value): toBe, toEqual, toContain, toMatch, toBeTruthy, toBeGreaterThan... When a person must act on the page
(sign in with two-factor, solve a captcha, pick something by hand), call await page.askForHelp('Sign in, then press
Continue'): the run waits while the member does it in a live view, then the script carries on (sandbox tests skip it).
What they type never reaches the script. Nothing else exists: no evaluate,
route, frames, uploads, downloads, new tabs or page events. A login is a credential with placement "basic"
("username:password") whose "hosts" are the sign-in page's host. Submitting forms that change data is a "write" action.
Browser sandbox tests answer the browser from canned HTML, by URL prefix; nothing else loads:
  { "name": "...", "action": "...", "input": {...}, "http": [], "expectOk": true,
    "pages": [{ "urlPrefix": "https://app.example.com/login", "body": "<title>Sign in</title><label>Email <input></label>..." }] }
Write small pages that mirror the real one's labels and roles, including what appears after a click (inline script is fine).
When the person pastes a Playwright script, keep its steps and selectors and turn each test into an action.

Limits: 1-20 browser hosts; up to 500 browser operations per action run, each up to 30 seconds; up to 10
screenshots; tests may have up to 20 canned pages of 200 KB each and run for up to 45 seconds; a person helping
through askForHelp has up to 15 minutes.
