export function renderPage(imagehostOrigin) {
  // Keep attribute interpolation safe even if this renderer is called directly.
  const escapedOrigin = String(imagehostOrigin).replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex, nofollow, noarchive">
  <title>Image Host · Private Code Generator</title>
  <link rel="stylesheet" href="/styles.css">
  <script src="/app.js" defer></script>
</head>
<body>
  <main class="wrap">
    <header>
      <span class="eyebrow">IMAGE HOST</span>
      <a class="logout" href="/cdn-cgi/access/logout">Sign out</a>
      <h1>Private code generator</h1>
      <p class="intro">Generate a one-time code, then use it on your image host.</p>
      <p class="access-note">Protected by Cloudflare Access</p>
    </header>

    <section class="card" aria-labelledby="uploadTitle">
      <div class="heading"><span class="badge">UPLOAD</span><h2 id="uploadTitle">Upload an image</h2></div>
      <p class="description">Creates a code for one upload. Any previous upload code is replaced.</p>
      <div class="actions">
        <button type="button" class="primary generate" id="uploadGenerate" data-type="upload">Generate upload code</button>
        <a href="${escapedOrigin}/" target="_blank" rel="noopener noreferrer">Open upload page <span aria-hidden="true">↗</span></a>
      </div>
      <p id="uploadStatus" class="status" role="status" aria-live="polite"></p>
      <div id="uploadResult" class="result" hidden>
        <label for="uploadCode">Your upload code</label>
        <div class="code-row">
          <input id="uploadCode" class="code" type="text" readonly spellcheck="false" autocomplete="off" aria-label="Generated upload code">
          <button type="button" id="uploadCopy" class="copy" data-type="upload" disabled>Copy code</button>
        </div>
        <p id="uploadExpiry" class="expiry"></p>
      </div>
    </section>

    <section class="card" aria-labelledby="managementTitle">
      <div class="heading"><span class="badge">MANAGE</span><h2 id="managementTitle">Manage your images</h2></div>
      <p class="description">Creates a code for one management login. Generating a new code signs out the previous management session.</p>
      <div class="actions">
        <button type="button" class="primary generate" id="managementGenerate" data-type="management">Generate management code</button>
        <a href="${escapedOrigin}/manage" target="_blank" rel="noopener noreferrer">Open manager <span aria-hidden="true">↗</span></a>
      </div>
      <p id="managementStatus" class="status" role="status" aria-live="polite"></p>
      <div id="managementResult" class="result" hidden>
        <label for="managementCode">Your management code</label>
        <div class="code-row">
          <input id="managementCode" class="code" type="text" readonly spellcheck="false" autocomplete="off" aria-label="Generated management code">
          <button type="button" id="managementCopy" class="copy" data-type="management" disabled>Copy code</button>
        </div>
        <p id="managementExpiry" class="expiry"></p>
      </div>
    </section>

    <footer>Codes are shown only in this session. A code may stop working sooner if it is used, replaced or revoked.</footer>
    <noscript><p class="status error">Enable JavaScript to generate and copy codes.</p></noscript>
  </main>
</body>
</html>`;
}

export const STYLES = `:root{color-scheme:dark;--bg:#0f1115;--panel:#171a21;--edge:#2a2f3a;--text:#e8eaed;--muted:#a2abba;--accent:#8ab4ff;--button:#315fc5;--error:#ffb4ab;--success:#88d9b1}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}button,input{font:inherit}.wrap{max-width:800px;margin:auto;padding:48px 24px 40px}header{margin-bottom:30px}.eyebrow{color:var(--accent);font-size:.75rem;font-weight:700;letter-spacing:.13em}.logout{float:right;font-size:.85rem}h1{font-size:clamp(1.7rem,5vw,2.25rem);line-height:1.2;letter-spacing:-.035em;margin:18px 0 10px}h2{font-size:1.15rem;line-height:1.35;margin:0}.intro{color:var(--muted);margin:0}.access-note{font-size:.8rem;color:var(--muted);margin:10px 0 0}.card{padding:26px;background:var(--panel);border:1px solid var(--edge);border-radius:12px;margin-bottom:20px}.heading{display:flex;gap:12px;align-items:center;flex-wrap:wrap}.badge{border:1px solid var(--edge);border-radius:5px;padding:3px 7px;font-size:.65rem;font-weight:700;letter-spacing:.08em;color:var(--accent)}.description{color:var(--muted);font-size:.92rem;margin:14px 0 20px;max-width:620px}.actions{display:flex;align-items:center;gap:18px;flex-wrap:wrap}a{color:var(--accent);text-underline-offset:3px;font-size:.9rem}button{padding:10px 15px;font-size:.9rem;line-height:1.4;font-weight:600;border:1px solid var(--edge);border-radius:7px;background:#242a35;color:var(--text);cursor:pointer}button.primary{background:var(--button);border-color:#4c77d8;color:white}button:hover:not(:disabled){filter:brightness(1.13)}button:disabled{opacity:.55;cursor:default}button:focus-visible,a:focus-visible,input:focus-visible{outline:2px solid var(--accent);outline-offset:4px}.status{font-size:.86rem;margin:14px 0 0;color:var(--muted)}.status:empty{display:none}.error{color:var(--error)}.success{color:var(--success)}.result{margin-top:20px;padding-top:18px;border-top:1px solid var(--edge)}label{display:block;color:var(--muted);font-size:.78rem;margin-bottom:8px}.code-row{display:flex;gap:12px;align-items:center;flex-wrap:wrap}.code{font:600 clamp(1.4rem,5vw,1.8rem)/1.4 ui-monospace,Consolas,monospace;letter-spacing:.08em;min-width:0;max-width:100%;width:12ch;background:transparent;border:0;padding:0;color:var(--text)}.expiry{color:var(--muted);font-size:.8rem;margin:10px 0 0}footer{font-size:.8rem;color:var(--muted);max-width:640px;padding-top:4px}[hidden]{display:none!important}@media(max-width:480px){.wrap{padding:28px 16px}.card{padding:20px}.actions{align-items:flex-start;gap:14px}.actions .primary{width:100%}}`;
