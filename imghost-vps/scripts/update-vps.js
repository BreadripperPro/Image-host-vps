'use strict';

// Application updates only. Never run configure-vps.js, reset credentials, or
// import a database here. The CLI paths intentionally match the fresh installer.
const fs = require('fs');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');

const MANAGED_ENTRIES = Object.freeze([
  'index.js', 'package.json', 'package-lock.json', 'config.example.json',
  'README.md', 'src', 'public', 'scripts', 'deploy'
]);
const CODE_DIRECTORIES = new Set(['src', 'public', 'scripts', 'deploy']);
const REPLACED_ENTRIES = [...MANAGED_ENTRIES, 'node_modules'];
const DEFAULTS = Object.freeze({
  targetDir: '/opt/imagehost',
  backupRoot: '/opt/imagehost-backups',
  serviceFile: '/etc/systemd/system/imagehost.service',
  nginxFile: '/etc/nginx/sites-available/imagehost',
  serviceName: 'imagehost'
});

function exists(file) { return fs.existsSync(file) || Boolean(lstat(file)); }
function lstat(file) {
  try { return fs.lstatSync(file); } catch (err) { if (err.code === 'ENOENT') return null; throw err; }
}
function inside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
function overlaps(a, b) { return inside(a, b) || inside(b, a); }
function assertRegular(file) {
  const stat = lstat(file);
  if (!stat || !stat.isFile() || stat.isSymbolicLink()) throw new Error(`Expected a regular file: ${file}`);
}
function assertDirectory(directory) {
  const stat = lstat(directory);
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(directory) !== path.resolve(directory)) {
    throw new Error(`Expected a real directory without symlink parents: ${directory}`);
  }
}
function assertTree(directory, allowInternalLinks = false) {
  function visit(file) {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) {
      if (!allowInternalLinks || !inside(directory, fs.realpathSync(file))) throw new Error(`Unsafe symlink in release: ${file}`);
    } else if (stat.isDirectory()) {
      for (const name of fs.readdirSync(file)) visit(path.join(file, name));
    } else if (!stat.isFile()) throw new Error(`Special files are not allowed in a release: ${file}`);
  }
  visit(directory);
}
function copy(source, destination) {
  fs.cpSync(source, destination, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
}
function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: options.cwd,
    input: options.input,
    encoding: 'utf8',
    stdio: options.capture ? ['ignore', 'pipe', 'inherit'] : ['ignore', 'inherit', 'inherit'],
    env: { ...process.env, ...options.env }
  }) || '';
}
function permissions(directory) {
  // Do not follow npm's internal .bin symlinks while setting modes.
  function visit(file) {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) return;
    fs.chmodSync(file, stat.isDirectory() || (stat.mode & 0o111) ? 0o750 : 0o640);
    if (stat.isDirectory()) for (const name of fs.readdirSync(file)) visit(path.join(file, name));
  }
  run('chown', ['-R', 'root:imagehost', directory]);
  visit(directory);
}
function configFor(directory) {
  // Run the new version's actual validator against a private copy of the saved
  // config. It performs no schema initialization or network operations.
  const configFile = require.resolve(path.join(directory, 'src', 'config.js'));
  // Rollback can restore two different versions at this same path. Do not
  // validate the recovered current version with a cached old config module.
  delete require.cache[configFile];
  const configLoader = require(configFile);
  const config = configLoader.load();
  const port = configLoader.resolvePort(config.port).port;
  return { ...config, port };
}
function protectUploads(targetDir, backupRoot, rawConfig) {
  const uploads = path.resolve(targetDir, rawConfig.uploadsDir || 'uploads');
  let realUploads = uploads;
  // Resolve existing parent links too, including when the last directory is new.
  let ancestor = uploads;
  while (!fs.existsSync(ancestor) && path.dirname(ancestor) !== ancestor) ancestor = path.dirname(ancestor);
  if (fs.existsSync(ancestor)) realUploads = path.resolve(fs.realpathSync(ancestor), path.relative(ancestor, uploads));
  if (overlaps(uploads, backupRoot) || overlaps(realUploads, backupRoot)) {
    throw new Error('uploadsDir overlaps the private backup directory; move uploads before updating.');
  }
  for (const name of [...REPLACED_ENTRIES, 'config.json', '.session-secret']) {
    const code = path.join(targetDir, name);
    if (overlaps(uploads, code) || overlaps(realUploads, code)) {
      throw new Error(`uploadsDir overlaps an application path (${name}); move uploads before updating.`);
    }
  }
}
function assertDestination(options) {
  assertDirectory(options.targetDir);
  assertRegular(path.join(options.targetDir, 'config.json'));
  for (const name of REPLACED_ENTRIES) {
    if (lstat(path.join(options.targetDir, name))?.isSymbolicLink()) throw new Error(`Refusing to replace a symlink: ${name}`);
  }
  for (const file of [options.serviceFile, options.nginxFile]) if (exists(file)) assertRegular(file);
  const config = JSON.parse(fs.readFileSync(path.join(options.targetDir, 'config.json'), 'utf8').replace(/^\uFEFF/, ''));
  protectUploads(options.targetDir, options.backupRoot, config);
  if (overlaps(options.backupRoot, options.targetDir)) throw new Error('The backup directory must be outside the installed application.');
}
function healthOnce(config, timeoutMs = 2000) {
  const host = config.host === '0.0.0.0' ? '127.0.0.1' : config.host === '::' ? '::1' : config.host;
  return new Promise((resolve) => {
    let request;
    let settled = false;
    const finish = (healthy) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (!healthy) request?.destroy();
      resolve(healthy);
    };
    // A socket timeout resets whenever bytes arrive. This absolute deadline
    // also bounds an incomplete response that keeps trickling data forever.
    const deadline = setTimeout(() => finish(false), timeoutMs);
    try {
      request = http.get({ hostname: host, port: config.port, path: '/api/health', timeout: timeoutMs,
        headers: { Host: new URL(config.domain).host, Connection: 'close' } }, (response) => {
        let body = '';
        response.on('data', (chunk) => {
          body += chunk;
          if (body.length > 1024) { response.destroy(); finish(false); }
        });
        response.on('error', () => finish(false));
        response.on('aborted', () => finish(false));
        response.on('end', () => {
          try { finish(response.statusCode === 200 && JSON.parse(body).ok === true); } catch { finish(false); }
        });
      });
      request.on('timeout', () => finish(false));
      request.on('error', () => finish(false));
    } catch { finish(false); }
  });
}
async function waitForHealth(config) {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    if (await healthOnce(config)) return;
    await new Promise((resolve) => setTimeout(resolve, 750));
  }
  throw new Error(`Application did not become healthy on its configured port ${config.port}.`);
}
function adapters(dependencies) { return { run, permissions, waitForHealth, log: console.log, ...dependencies }; }
function normalizeOptions(options) {
  const result = { ...DEFAULTS, ...options };
  for (const key of ['targetDir', 'backupRoot', 'serviceFile', 'nginxFile']) result[key] = path.resolve(result[key]);
  return result;
}
function writeSystemFile(source, destination) {
  fs.copyFileSync(source, destination);
  fs.chmodSync(destination, 0o644);
}
function makeBackup(options, deps, nginxIncluded) {
  if (exists(options.backupRoot)) assertDirectory(options.backupRoot);
  else {
    assertDirectory(path.dirname(options.backupRoot));
    fs.mkdirSync(options.backupRoot, { mode: 0o700 });
  }
  fs.chmodSync(options.backupRoot, 0o700);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = fs.mkdtempSync(path.join(options.backupRoot, `${stamp}-`));
  fs.chmodSync(backupDir, 0o700);
  const app = path.join(backupDir, 'app');
  fs.mkdirSync(app, { mode: 0o700 });
  const entries = REPLACED_ENTRIES.filter((name) => exists(path.join(options.targetDir, name)));
  for (const name of entries) copy(path.join(options.targetDir, name), path.join(app, name));
  const serviceIncluded = exists(options.serviceFile);
  if (serviceIncluded) copy(options.serviceFile, path.join(backupDir, 'imagehost.service'));
  const nginxExisted = nginxIncluded && exists(options.nginxFile);
  if (nginxExisted) copy(options.nginxFile, path.join(backupDir, 'nginx.conf'));
  let wasActive = true;
  try { deps.run('systemctl', ['is-active', '--quiet', options.serviceName]); } catch { wasActive = false; }
  const metadata = { version: 1, targetDir: options.targetDir, entries, serviceIncluded, nginxIncluded, nginxExisted, wasActive };
  fs.writeFileSync(path.join(backupDir, 'metadata.json'), JSON.stringify(metadata, null, 2) + '\n', { mode: 0o600 });
  deps.log(`Previous application backup: ${backupDir}`);
  return { backupDir, metadata };
}
function restoreFiles(options, backupDir, metadata, deps) {
  for (const name of REPLACED_ENTRIES) {
    const destination = path.join(options.targetDir, name);
    fs.rmSync(destination, { recursive: true, force: true });
    if (metadata.entries.includes(name)) {
      copy(path.join(backupDir, 'app', name), destination);
      deps.permissions(destination);
    }
  }
  if (metadata.serviceIncluded) writeSystemFile(path.join(backupDir, 'imagehost.service'), options.serviceFile);
  else fs.rmSync(options.serviceFile, { force: true });
  if (metadata.nginxIncluded) {
    if (metadata.nginxExisted) writeSystemFile(path.join(backupDir, 'nginx.conf'), options.nginxFile);
    else fs.rmSync(options.nginxFile, { force: true });
  }
}
async function restoreInstallation(options, backupDir, metadata, deps, verifyInactive = false) {
  deps.run('systemctl', ['stop', options.serviceName]);
  restoreFiles(options, backupDir, metadata, deps);
  deps.run('systemctl', ['daemon-reload']);
  if (metadata.wasActive || verifyInactive) {
    deps.run('systemctl', ['restart', options.serviceName]);
    await deps.waitForHealth(configFor(options.targetDir));
    deps.run('systemctl', ['is-active', '--quiet', options.serviceName]);
  }
  // A separate broken Nginx site must not prevent the old backend restarting.
  if (metadata.nginxIncluded) {
    deps.run('nginx', ['-t']);
    deps.run('systemctl', ['reload', 'nginx']);
  }
}

async function updateInstallation(input, dependencies = {}) {
  const options = normalizeOptions(input);
  const deps = adapters(dependencies);
  options.sourceDir = path.resolve(options.sourceDir);
  assertDirectory(options.sourceDir);
  assertDestination(options);
  if (overlaps(options.sourceDir, options.targetDir) || overlaps(options.sourceDir, options.backupRoot)) {
    throw new Error('Upload the release into a separate directory outside the installation and backups.');
  }
  for (const name of MANAGED_ENTRIES) {
    const source = path.join(options.sourceDir, name);
    if (CODE_DIRECTORIES.has(name)) { assertDirectory(source); assertTree(source); }
    else assertRegular(source);
  }
  const work = fs.mkdtempSync(path.join(path.dirname(options.targetDir), '.imagehost-update-'));
  fs.chmodSync(work, 0o700);
  const stage = path.join(work, 'app');
  fs.mkdirSync(stage, { mode: 0o700 });
  let backup;
  let touched = false;
  try {
    for (const name of MANAGED_ENTRIES) copy(path.join(options.sourceDir, name), path.join(stage, name));
    assertTree(stage); // Check the private copy again before executing anything.
    copy(path.join(options.targetDir, 'config.json'), path.join(stage, 'config.json'));
    fs.chmodSync(path.join(stage, 'config.json'), 0o600);
    const config = configFor(stage);
    deps.log('Preparing dependencies and checking the new release; the current app is still running.');
    deps.run('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], {
      cwd: stage, env: { npm_config_cache: path.join(work, 'npm-cache'), NODE_ENV: 'production' }
    });
    assertDirectory(path.join(stage, 'node_modules'));
    assertTree(path.join(stage, 'node_modules'), true);
    deps.run(process.execPath, ['scripts/check.js'], { cwd: stage });
    if (options.refreshNginx) {
      deps.run('nginx', ['-t']); // Refuse an already-broken proxy before downtime.
      const candidate = deps.run(process.execPath, ['scripts/nginx-config.js'], { cwd: stage, capture: true });
      if (!candidate.trim()) throw new Error('The generated Nginx configuration is empty.');
      fs.writeFileSync(path.join(work, 'nginx.conf'), candidate, { mode: 0o600 });
    }
    for (const name of REPLACED_ENTRIES) deps.permissions(path.join(stage, name));
    backup = makeBackup(options, deps, Boolean(options.refreshNginx));
    const previousUnit = path.join(options.targetDir, 'deploy', 'imagehost.service');
    const refreshService = !exists(options.serviceFile) || (lstat(previousUnit)?.isFile() &&
      !lstat(previousUnit).isSymbolicLink() && fs.readFileSync(previousUnit).equals(fs.readFileSync(options.serviceFile)));
    touched = true;
    deps.log('Installing the new release and restarting imagehost.');
    deps.run('systemctl', ['stop', options.serviceName]);
    for (const name of REPLACED_ENTRIES) {
      const destination = path.join(options.targetDir, name);
      fs.rmSync(destination, { recursive: true, force: true });
      fs.renameSync(path.join(stage, name), destination);
    }
    if (refreshService) writeSystemFile(path.join(options.targetDir, 'deploy', 'imagehost.service'), options.serviceFile);
    else deps.log('Keeping the customized systemd unit; the new bundled unit is in deploy/imagehost.service.');
    if (options.refreshNginx) {
      writeSystemFile(path.join(work, 'nginx.conf'), options.nginxFile);
      deps.run('nginx', ['-t']);
    }
    deps.run('systemctl', ['daemon-reload']);
    deps.run('systemctl', ['restart', options.serviceName]);
    await deps.waitForHealth(config);
    deps.run('systemctl', ['is-active', '--quiet', options.serviceName]);
    if (options.refreshNginx) deps.run('systemctl', ['reload', 'nginx']);
    deps.log('Update complete. Configuration, uploads, session secret and database were preserved.');
    return { backupDir: backup.backupDir, rolledBack: false, refreshedNginx: Boolean(options.refreshNginx) };
  } catch (error) {
    if (touched) {
      deps.log('Update failed; restoring the previous application.');
      try {
        await restoreInstallation(options, backup.backupDir, backup.metadata, deps);
      } catch (rollbackError) {
        throw new Error(`Update failed: ${error.message}\nAutomatic restore also failed: ${rollbackError.message}\nBackup: ${backup.backupDir}`);
      }
      throw new Error(`Update failed; previous application restored. ${error.message}`);
    }
    throw error;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

async function rollbackInstallation(input, dependencies = {}) {
  const options = normalizeOptions(input);
  const deps = adapters(dependencies);
  assertDestination(options);
  const backupDir = path.resolve(options.backupDir);
  assertDirectory(options.backupRoot);
  assertDirectory(backupDir);
  if (!inside(options.backupRoot, backupDir) || backupDir === options.backupRoot) throw new Error('Choose a backup inside the imagehost backup directory.');
  assertRegular(path.join(backupDir, 'metadata.json'));
  const metadata = JSON.parse(fs.readFileSync(path.join(backupDir, 'metadata.json'), 'utf8'));
  if (metadata.version !== 1 || metadata.targetDir !== options.targetDir || !Array.isArray(metadata.entries) ||
      metadata.entries.some((entry) => !REPLACED_ENTRIES.includes(entry)) ||
      typeof metadata.wasActive !== 'boolean' || typeof metadata.serviceIncluded !== 'boolean' ||
      typeof metadata.nginxIncluded !== 'boolean' || typeof metadata.nginxExisted !== 'boolean') {
    throw new Error('Invalid or incompatible backup metadata.');
  }
  assertDirectory(path.join(backupDir, 'app'));
  for (const entry of metadata.entries) {
    const file = path.join(backupDir, 'app', entry);
    if (CODE_DIRECTORIES.has(entry) || entry === 'node_modules') { assertDirectory(file); assertTree(file, entry === 'node_modules'); }
    else assertRegular(file);
  }
  if (metadata.serviceIncluded) assertRegular(path.join(backupDir, 'imagehost.service'));
  if (metadata.nginxExisted) assertRegular(path.join(backupDir, 'nginx.conf'));
  // Keep a way back even when the selected old release fails with today's config.
  const current = makeBackup(options, deps, metadata.nginxIncluded);
  try {
    await restoreInstallation(options, backupDir, metadata, deps, true);
  } catch (error) {
    try { await restoreInstallation(options, current.backupDir, current.metadata, deps); }
    catch (restoreError) { throw new Error(`Rollback failed: ${error.message}\nRestoring the current version also failed: ${restoreError.message}\nBackup: ${current.backupDir}`); }
    throw new Error(`Rollback failed; current application restored. ${error.message}`);
  }
  deps.log('Previous application restored. Database and uploaded files were not rolled back.');
  return { backupDir: current.backupDir, restoredFrom: backupDir };
}

async function main(args = process.argv.slice(2)) {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
    console.log('Usage: bash /root/imagehost-update/deploy/update.sh [--refresh-nginx]\n       bash /root/imagehost-update/deploy/update.sh --rollback /opt/imagehost-backups/BACKUP_NAME\n\nUpload a complete release to a separate directory. Updates /opt/imagehost; preserves config, secrets, uploads and database.');
    return;
  }
  const refreshNginx = args.length === 1 && args[0] === '--refresh-nginx';
  const rollback = args.length === 2 && args[0] === '--rollback';
  if (args.length && !refreshNginx && !rollback) throw new Error('Unknown arguments. Run with --help.');
  if (process.platform !== 'linux' || process.getuid() !== 0) throw new Error('Run deploy/update.sh as root on the Debian VPS.');
  const osRelease = fs.readFileSync('/etc/os-release', 'utf8');
  if (!/^ID=(?:debian|"debian")$/m.test(osRelease) || !/^VERSION_ID=(?:13|"13")$/m.test(osRelease)) throw new Error('This updater targets an existing Debian 13 installation.');
  // Direct node invocation would omit the shell's flock and allow two writers.
  const lock = fs.statSync('/run/imagehost-update/lock');
  let descriptor;
  try { descriptor = fs.fstatSync(9); } catch { throw new Error('Run through deploy/update.sh so the update lock is held.'); }
  if (!descriptor.isFile() || descriptor.ino !== lock.ino || descriptor.dev !== lock.dev) throw new Error('Run through deploy/update.sh so the update lock is held.');
  const options = { sourceDir: path.resolve(__dirname, '..'), refreshNginx };
  if (rollback) await rollbackInstallation({ ...options, backupDir: args[1] });
  else await updateInstallation(options);
}

if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
module.exports = { updateInstallation, rollbackInstallation, MANAGED_ENTRIES, healthOnce };
