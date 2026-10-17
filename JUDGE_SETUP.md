# Judge setup

Prerequisites: **Node.js 24 or later**, npm and a browser. Start in a newly extracted folder with no .env or inherited API credentials. The local route needs no account, key, card, billing or payment. One server owns a data directory; stop with Ctrl+C before restarting.

## Credential-free LOCAL_TEST

**Linux: use a non-root user BEFORE these commands and keep Chromium sandboxing enabled. Never add --no-sandbox or disable chromiumSandbox.** Follow [Playwright browser/dependency instructions](https://playwright.dev/docs/browsers) for missing system libraries. Administrative dependency installation is separate from running the app as non-root.

Windows PowerShell, in the extracted scopeproof folder:

```powershell
node --version
npm ci
npx playwright install chromium
npm run build
npm run test:unit
npm test
npm run local
```

macOS/Linux POSIX shell, same folder:

```sh
node --version
npm ci
npx playwright install chromium
npm run build
npm run test:unit
npm test
npm run local
```

Open http://localhost:3000 and confirm **Local test · no money moves**. AI stays unavailable without keys; manual criteria work. If port 3000 is occupied, use `$env:PORT='3100'; npm run local` (PowerShell) or `PORT=3100 npm run local` (POSIX), then open http://localhost:3100. Fresh local state is saved under data/local_test.

If the download is blocked, record that limitation. A trusted compatible existing executable can be selected with `$env:PREVIEW_BROWSER_PATH='C:\path\to\chrome.exe'` (PowerShell) or `export PREVIEW_BROWSER_PATH='/path/to/chromium'` (POSIX). Reused/substitute testing is not proof of the documented download. Browser-required tests do not pass merely because test:unit passed.

## Full UI journey

1. Create the default fictional Juniper Bakery project. Save both full private links, including seller recovery. Link holders have role access, not verified identity. Keep the seller link private; use a separate client tab/context.
2. Choose **Use manual checklist**, save the default four requirements and confirm as seller. Open the client link and confirm that exact scope.
3. Seller Review & pay → **Try the fictional bakery fixtures** → upload v1. Reload the client. Wrong booking destination must FAIL and acceptance stays blocked.
4. Upload v2 and reload the client. With working Chromium all four observations pass. Review the sanitized preview, check the design/exact-version acknowledgment and accept v2. If checks are unavailable they stay review-required with a separate unmeasured-check acknowledgment, never a browser pass.
5. **Create local test order** → **Approve & complete local test**. Confirm local/no-money receipt and download v2.
6. Upload v3 as seller. Reload the client receipt and download again: accepted version stays v2. Compare SHA-256 using `Get-FileHash -Algorithm SHA256 <file>` (PowerShell), `shasum -a 256 <file>` (macOS), or `sha256sum <file>` (Linux); both v2 files must match.
7. Restart the same local server and reopen full links in fresh contexts. Tokenless addresses grant no access. Seller/client links expire after up to seven days; download links after one hour and refresh through authorized receipt access.

Fixtures ship in the archive; optional regeneration: npm run fixtures. npm test runs all controlled/API/browser regressions. npm run test:unit deliberately makes Chromium unavailable to test honest fallback and overlaps the full suite. Neither needs provider credentials. A matching destination does not prove booking functionality; subjective design remains the client’s decision.

## Optional native Gemini Free Tier

This is separate from the credential-free route. Copy .env.example to private .env (`Copy-Item .env.example .env` or `cp .env.example .env`). Set AI_PROVIDER=GEMINI and server-only GEMINI_API_KEY. Set GEMINI_FREE_TIER_CONFIRMED=true only after checking that key’s project is unbilled Free Tier. The flag is an operator assertion, not an app billing check. Do not attach billing, buy credits or enable paid fallback.

The example selects the model; its default constant is in server/compiler.ts and environment/provider selection in server/ai-config.ts. Check current [API-key setup](https://ai.google.dev/gemini-api/docs/api-key) and [pricing/data terms](https://ai.google.dev/gemini-api/docs/pricing). Access/quotas can change: stop on failure rather than silently changing models/billing. Free Tier inputs may improve Google products; use fictional briefs.

Restart after .env changes. Explicitly choose Draft requirements with AI once and review quotes, unanswered questions and human-review rows. Both roles still confirm corrected saved scope. Unsafe output rejects the whole draft. No automatic retries, repair calls or model/provider fallback. npm run local can use explicitly configured Gemini, but its payment stays LOCAL_TEST.

A new judge uses their own eligible free provider account/key for this route. If they cannot provision one, request an owner-assisted private live session; do not put the owner's key or capability links in a public repository. This private alternative has not yet been exercised by a new judge. Manual mode and saved output establish neither new-judge live access nor a new model call.

## Optional PayPal sandbox — test funds only

1. In [PayPal sandbox accounts](https://developer.paypal.com/sandbox-testing/accounts), create a Business seller, separate Personal buyer and REST sandbox app attached to that seller. The historical India-merchant test used a US Personal buyer; this is a synthetic profile, not production-availability advice. Use test accounts/funds, never real cards/live accounts.
2. In private .env set PAYMENT_MODE=PAYPAL_SANDBOX, PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET and PAYPAL_MERCHANT_ID from that same seller/app. Keep HOST=127.0.0.1 and PUBLIC_URL matching the browser origin. No credentials ship here.
3. Stop LOCAL_TEST, then npm start. Ordinary startup defaults to sandbox and never silently falls back. Missing configuration leaves source locked. Never copy the builder’s .env/data into public source.
4. Complete bilateral scope/v2 acceptance; a human test buyer approves. The server verifies seller, amount, order and completed capture. Return URLs prove nothing. Upload v3 and compare accepted-v2 bytes.
5. Pending/UNKNOWN permits status retrieval only. Do not create another project/order to bypass uncertainty. Cancel/404 is not non-payment proof. General replacement is unsupported; narrow trusted-server-audited recovery is not a client assertion override.

Incoming webhooks require HTTPS callback, Webhook ID and signature verification. No real incoming webhook is demonstrated; mock events are not payment proof. Single Node process/local merchant/private SQLite are the assumptions; public multi-tenant deployment and auth hardening are outside this route.
