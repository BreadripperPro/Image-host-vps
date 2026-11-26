# Private code generator — Cloudflare Worker

A private web page for generating one-use image-upload and management codes.
Cloudflare Access signs you in; the VPS creates the codes and stores their hashes.
The Worker has no database, SSH or filesystem credentials.

Deploy through **GitHub's website and the Cloudflare dashboard**. No local
Node.js, Wrangler login or deployment commands are needed for this route.

## 1. Prepare the VPS and domains

Follow the [VPS installation guide](../imghost-vps/README.md) first. This guide uses:

| Purpose | Example |
| --- | --- |
| Public image host | `https://images.example.com` |
| Private generator | `https://codes.example.com` |
| Worker name | `imagehost-codegen` |
| VPS listeners | Nginx `80`/`443`, Node `127.0.0.1:3000`, MariaDB `127.0.0.1:3306` |

Replace both example domains with domains you control. Use Cloudflare proxied
DNS for the image host and **Full (strict)** SSL/TLS with a valid origin
certificate. Keep Node and MariaDB on loopback; the Worker calls only public
HTTPS on port `443`. If your VPS needs a nonstandard HTTPS port, set a scoped
Cloudflare **Origin Rule** for the image hostname. Keep that port out of the
Worker's public URLs and leave the generator hostname outside that rule.

Generate a new shared secret over SSH on the VPS:

```bash
openssl rand -hex 32
```

Keep the output private. Add or update this object in `/opt/imagehost/config.json`,
preserving all other configuration, and restart with `systemctl restart imagehost`:

```json
"codeGenerator": {
  "enabled": true,
  "url": "https://codes.example.com",
  "sharedSecret": "PASTE_NEW_RANDOM_HEX_SECRET_HERE"
}
```

The same secret will be a Worker **runtime secret** in step 4. Never commit it,
your VPS `config.json`, database password, session secret or uploads to GitHub.
Keep `/api/admin/codes` on the image hostname free of interactive Access login
and redirects: this endpoint uses its own machine credential. Keep Access on
the generator hostname instead. The public upload/image URLs stay public.

## 2. Upload and configure the Worker in GitHub

Create a GitHub repository and use **Add file → Upload files**. A public repository
can contain this sanitized source; keep private settings out of either public
or private repositories. Upload only:

- `src/` and `test/`
- `package.json`, `package-lock.json`, `wrangler.jsonc`, `.gitignore`, `README.md`

Do not upload `node_modules/`, `.npm/`, `.wrangler/`, `.env*`, `.dev.vars*`,
logs, VPS configuration or other runtime files. Browser uploads do not enforce
`.gitignore`; select the intended files yourself.

In GitHub's web editor, edit `wrangler.jsonc` before committing:

| Setting | What to enter |
| --- | --- |
| `name` | `imagehost-codegen`, or your chosen Worker name |
| `routes[0].pattern` | Your generator hostname, for example `codes.example.com` |
| `vars.PUBLIC_ORIGIN` | `https://codes.example.com` using that same hostname |
| `vars.IMAGEHOST_ORIGIN` | `https://images.example.com` using your image hostname |
| `vars.ALLOWED_EMAILS` | Optional comma-separated exact emails; empty lets Access decide |

Use two distinct canonical HTTPS origins with no trailing slash, credentials,
port, path, query or fragment. Invalid or missing settings fail closed. The UI
links and API destination are derived from these settings. Keep `workers_dev`
and `preview_urls` set to `false`. Do not add `CODEGEN_SHARED_SECRET` to this file.

## 3. Connect the repository in Cloudflare

In **Workers & Pages**, create a Worker from the GitHub repository. For an existing
Worker, connect the repository under **Settings → Builds**. Authorize only the
repository you intend to deploy and use these settings:

| Setting | Value |
| --- | --- |
| Worker name | Match `name` in `wrangler.jsonc` |
| Production branch | Your release branch, usually `main` |
| Root directory | Repository root if you uploaded Worker contents only; `codegen-cf` if both project folders are in the repository |
| Build command | `npm run check && npm test` |
| Deploy command | `npm run deploy` |

Use Node.js `22` or newer for builds; set the build variable `NODE_VERSION=22`
if needed. Keep development dependencies enabled, since Wrangler is one of them.
Do not set `NODE_ENV=production`. Save and deploy, then check the deployment result.
Turn off non-production/preview branch builds if enabled.

## 4. Add the runtime secret and Access protection

Open your Worker's **Settings → Variables and Secrets**. Add:

| Field | Value |
| --- | --- |
| Type | **Secret** |
| Name | `CODEGEN_SHARED_SECRET` |
| Value | Exactly the hex secret in VPS `codeGenerator.sharedSecret` |

Save/deploy when prompted. This belongs in runtime settings, not **Settings →
Builds**: a build-only secret is unavailable during code generation.

Check **Domains & Routes** for your generator custom domain. Resolve a DNS
conflict only for that hostname if Cloudflare reports one. Cloudflare serves its
HTTPS; no extra VPS listener or certificate is needed for the Worker domain.
Confirm `workers.dev` and version-preview URLs remain disabled.

Enable automatic **Cloudflare Access** protection for this Worker with **All
traffic** and your intended human sign-in policy. Ensure every route on the
generator hostname is covered, including assets and `/api/codes`. Do not use
Everyone or Bypass. The Worker requires trusted `ctx.access.getIdentity()` with
an email on every route, and refuses forged `Cf-Access-*` headers. If you use a
hostname-based Access application, also ensure the Worker receives that trusted
platform identity; a login page alone does not replace the runtime check.

## 5. Test and use

Open your actual generator URL, sign in, and test both Generate and Copy buttons.
Use each resulting code on its corresponding image-host page. In an incognito
window, confirm Access requires sign-in before the generator is shown. The
preview hostname and plain `wrangler dev` cannot bypass this protection.

- Upload codes permit one upload and follow `uploadTokenTtlHours` on the VPS.
- Management codes permit one login and follow `managementTokenTtlMinutes`.
- A new code replaces the prior code of its type. A new management code also
  signs out the previous management session.
- **Retry request** reuses the same request ID after an interruption. If the
  first request already issued a code, the VPS refuses the duplicate; generate
  a new code. No plaintext codes are stored for redisplay.
- Codes are not cached or saved in local storage. Your clipboard still contains
  a copied code; treat it as private. Respect any rate-limit waiting period.

## 6. Updates and recovery

Commit changed source files to the connected production branch through GitHub;
Cloudflare runs the checks and deploys. Wait for success and test the real URL.
Keep your Worker name, origins, runtime secret and Access settings consistent.
Update the VPS separately using its [update guide](../imghost-vps/README.md#6-update-an-existing-vps).

| Symptom | Check |
| --- | --- |
| Generator HTTP `403` | Access identity, optional email allowlist, configured public origin |
| Generator HTTP `503` before the page loads | Both origin settings and a runtime secret of 64–128 hex characters |
| API redirected or blocked | Access/WAF and redirects on `images.example.com/api/admin/codes`; the API must respond directly |
| VPS rejected HTTP origin connection | Full (strict), HTTPS Nginx routing and VPS `trustProxy` |
| VPS rejected generator credential | Match the runtime secret to `codeGenerator.sharedSecret`, then restart the VPS app |
| Image host cannot be reached | DNS, firewall, scoped Origin Rules, Nginx and `journalctl -u imagehost` |

The Worker never follows an upstream redirect or exposes the VPS response body.
Tests use mock identities and origin responses; they do not validate your live
Access policy, TLS or routing. For local source checks, use `npm ci`, `npm run
check`, then `npm test` with Node.js 22+. No real credentials are required.

To disable remote generation, set VPS `codeGenerator.enabled` to `false` and
restart the service. To rotate the shared secret, generate a new one and update
both private runtime locations. SSH code generation remains available.
