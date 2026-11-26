'use strict';

// Exercise actual file staging/swaps/rollback with temporary installations.
// Only package installation, service commands and health probes are substituted.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { updateInstallation, rollbackInstallation, MANAGED_ENTRIES } = require('./update-vps');

const CONFIG_SOURCE = fs.readFileSync(path.join(__dirname, '../src/config.js'), 'utf8');

function write(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
}

function makeRelease(directory, version) {
  write(path.join(directory, 'index.js'), `'use strict';\n// ${version} application\n`);
  write(path.join(directory, 'package.json'), JSON.stringify({ name: 'imagehost-update-fixture', version: '1.0.0', private: true }));
  write(path.join(directory, 'package-lock.json'), JSON.stringify({ name: 'imagehost-update-fixture', version: '1.0.0', lockfileVersion: 3, packages: { '': { name: 'imagehost-update-fixture', version: '1.0.0' } } }));
  write(path.join(directory, 'config.example.json'), '{}\n');
  write(path.join(directory, 'README.md'), `${version} instructions\n`);
  write(path.join(directory, 'src/config.js'), CONFIG_SOURCE);
  write(path.join(directory, 'src/version.js'), `module.exports = ${JSON.stringify(version)};\n`);
  write(path.join(directory, 'public/index.html'), `<p>${version}</p>\n`);
  write(path.join(directory, 'scripts/check.js'), `'use strict';\n// ${version} syntax checker\n`);
  write(path.join(directory, 'scripts/nginx-config.js'), `'use strict';\n// ${version} Nginx renderer\n`);
  write(path.join(directory, 'deploy/imagehost.service'), `[Unit]\nDescription=${version} imagehost\n`);
  write(path.join(directory, 'deploy/nginx.conf'), `# ${version} Nginx template\n`);
}

function fixture(t, { uploadsDir = 'uploads' } = {}) {
  let root = fs.mkdtempSync(path.join(os.tmpdir(), 'imagehost-update-test-'));
  try { fs.realpathSync(root); }
  catch (error) {
    fs.rmSync(root, { recursive: true, force: true });
    if (!['EPERM', 'EACCES'].includes(error.code)) throw error;
    // Some Windows sandboxes allow temporary files but deny traversing the
    // AppData ancestor for realpath. Keep the same isolated fixture locally.
    root = fs.mkdtempSync(path.join(__dirname, '../.update-test-'));
  }
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const targetDir = path.join(root, 'installed');
  const sourceDir = path.join(root, 'uploaded-release');
  const backupRoot = path.join(root, 'backups');
  const serviceFile = path.join(root, 'systemd/imagehost.service');
  const nginxFile = path.join(root, 'nginx/imagehost');
  makeRelease(targetDir, 'old');
  makeRelease(sourceDir, 'new');
  const config = {
    database: { host: '127.0.0.1', port: 3306, database: 'imagehost', user: 'imagehost', password: 'b67ba95da39c4310f48efbc8f7a6b8cd' },
    domain: 'https://images.fixture.test', host: '127.0.0.1', port: 24680,
    uploadsDir, trustProxy: true, phpMyAdminEnabled: true,
    nginx: { httpPort: 8080, httpsPort: 8443, sslCertificate: null, sslCertificateKey: null },
    codeGenerator: { enabled: true, url: 'https://codes.example.com', sharedSecret: 'a'.repeat(64) }
  };
  write(path.join(targetDir, 'config.json'), JSON.stringify(config, null, 2) + '\n');
  write(path.join(targetDir, '.session-secret'), 'existing-session-secret-do-not-change\n');
  write(path.join(targetDir, 'uploads/old-image.bin'), Buffer.from([0, 128, 255, 42]));
  write(path.join(targetDir, 'node_modules/fixture-dependency/version.txt'), 'old dependency\n');
  write(path.join(targetDir, 'public/removed-in-new-release.txt'), 'stale public asset\n');
  write(path.join(targetDir, 'private-note.txt'), 'local unmanaged file\n');
  const serviceBefore = fs.readFileSync(path.join(targetDir, 'deploy/imagehost.service'), 'utf8');
  write(serviceFile, serviceBefore);
  write(nginxFile, 'existing custom Nginx configuration\n');
  // These uploaded runtime files must never replace the live installation.
  write(path.join(sourceDir, 'config.json'), '{"overwritten":true}\n');
  write(path.join(sourceDir, '.session-secret'), 'wrong uploaded secret\n');
  write(path.join(sourceDir, 'uploads/unwanted-image.bin'), 'not a release asset\n');
  write(path.join(sourceDir, 'node_modules/fixture-dependency/version.txt'), 'untrusted uploaded dependency\n');

  const options = { sourceDir, targetDir, backupRoot, serviceFile, nginxFile, serviceName: 'imagehost', refreshNginx: false };
  const events = [];
  const state = { healthFailure: null, npmFailure: null, nginxFailures: new Map(), nginxChecks: 0, restartFailures: [], healthConfigs: [] };
  const dependencies = {
    log(message) { events.push({ action: 'log', message }); },
    permissions(directory) { events.push({ action: 'permissions', directory }); },
    run(command, args, runOptions = {}) {
      const name = path.basename(command).replace(/\.(?:cmd|exe)$/i, '');
      events.push({ action: 'command', command: name, args: [...args], cwd: runOptions.cwd });
      if (name === 'npm') {
        if (state.npmFailure) throw state.npmFailure;
        assert.equal(args[0], 'ci');
        for (const flag of ['--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund']) assert.ok(args.includes(flag));
        assert.ok(runOptions.cwd && runOptions.cwd !== targetDir, 'dependencies are installed away from the live app');
        write(path.join(runOptions.cwd, 'node_modules/fixture-dependency/version.txt'), 'new locked dependency\n');
        return '';
      }
      if (name === 'node') {
        if (args.some((arg) => /(?:^|[\\/])nginx-config\.js$/.test(arg))) return 'generated Nginx configuration\n';
        if (args.some((arg) => /(?:^|[\\/])check\.js$/.test(arg))) return 'Syntax checks passed.\n';
      }
      if (name === 'systemctl') {
        if (args[0] === 'restart' && state.restartFailures.length) throw state.restartFailures.shift();
        return '';
      }
      if (name === 'nginx' && args.includes('-t')) {
        state.nginxChecks++;
        if (state.nginxFailures.has(state.nginxChecks)) throw state.nginxFailures.get(state.nginxChecks);
        return '';
      }
      throw new Error(`Unexpected updater command in test: ${name} ${args.join(' ')}`);
    },
    async waitForHealth(healthConfig) {
      events.push({ action: 'health' });
      state.healthConfigs.push(healthConfig);
      if (state.healthFailure) {
        const failure = state.healthFailure;
        state.healthFailure = null;
        throw failure;
      }
    }
  };
  return { root, options, targetDir, sourceDir, backupRoot, serviceFile, serviceBefore, nginxFile, config, events, state, dependencies };
}

function textAt(directory, relative) { return fs.readFileSync(path.join(directory, relative), 'utf8'); }
function commands(f, command, verb) {
  return f.events.filter((event) => event.action === 'command' && event.command === command && (!verb || event.args[0] === verb));
}
function liveSnapshot(f) {
  const files = ['index.js', 'src/version.js', 'public/index.html', 'public/removed-in-new-release.txt',
    'node_modules/fixture-dependency/version.txt', 'config.json', '.session-secret', 'uploads/old-image.bin', 'private-note.txt'];
  return Object.fromEntries(files.map((file) => [file, fs.existsSync(path.join(f.targetDir, file)) ? fs.readFileSync(path.join(f.targetDir, file)).toString('hex') : null]));
}
function assertNeverStopped(f) {
  assert.equal(commands(f, 'systemctl', 'stop').length, 0);
  assert.equal(commands(f, 'systemctl', 'restart').length, 0);
}
function directoryLink(t, destination, link) {
  fs.mkdirSync(destination, { recursive: true });
  try { fs.symlinkSync(destination, link, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) {
      t.skip('Creating symlinks is unavailable on this host');
      return false;
    }
    throw error;
  }
  return true;
}

test('update installs the full release while preserving configuration, secrets, uploads and custom files', async (t) => {
  const f = fixture(t);
  const configBefore = textAt(f.targetDir, 'config.json');
  const imageBefore = fs.readFileSync(path.join(f.targetDir, 'uploads/old-image.bin'));
  const result = await updateInstallation(f.options, f.dependencies);
  assert.equal(result.rolledBack, false);
  assert.equal(result.refreshedNginx, false);
  assert.ok(result.backupDir && fs.statSync(result.backupDir).isDirectory());
  assert.ok(MANAGED_ENTRIES.includes('public') && MANAGED_ENTRIES.includes('src'));
  assert.match(textAt(f.targetDir, 'index.js'), /new application/);
  assert.equal(textAt(f.targetDir, 'node_modules/fixture-dependency/version.txt'), 'new locked dependency\n');
  assert.equal(textAt(f.targetDir, 'config.json'), configBefore);
  assert.equal(textAt(f.targetDir, '.session-secret'), 'existing-session-secret-do-not-change\n');
  assert.deepEqual(fs.readFileSync(path.join(f.targetDir, 'uploads/old-image.bin')), imageBefore);
  assert.equal(textAt(f.targetDir, 'private-note.txt'), 'local unmanaged file\n');
  assert.equal(fs.existsSync(path.join(f.targetDir, 'uploads/unwanted-image.bin')), false);
  assert.equal(fs.existsSync(path.join(f.targetDir, 'public/removed-in-new-release.txt')), false);
  assert.equal(fs.readFileSync(f.nginxFile, 'utf8'), 'existing custom Nginx configuration\n');
  assert.match(fs.readFileSync(f.serviceFile, 'utf8'), /new imagehost/);
  assert.equal(f.state.healthConfigs.at(-1).port, 24680);
  assert.equal(f.state.healthConfigs.at(-1).host, '127.0.0.1');
  const stopIndex = f.events.findIndex((event) => event.command === 'systemctl' && event.args[0] === 'stop');
  const checkIndex = f.events.findIndex((event) => event.command === 'node' && event.args.some((arg) => /check\.js$/.test(arg)));
  assert.ok(checkIndex >= 0 && stopIndex > checkIndex, 'release validation happens before downtime');
  assert.equal(commands(f, 'nginx').length, 0);
});

test('an incomplete uploaded release is rejected before touching the live app', async (t) => {
  const f = fixture(t);
  const before = liveSnapshot(f);
  fs.rmSync(path.join(f.sourceDir, 'src'), { recursive: true });
  await assert.rejects(updateInstallation(f.options, f.dependencies));
  assert.deepEqual(liveSnapshot(f), before);
  assertNeverStopped(f);
});

test('a customized systemd unit and local drop-ins are retained during updates', async (t) => {
  const f = fixture(t);
  const customUnit = '[Service]\nReadWritePaths=/srv/imagehost-custom-uploads\n';
  const dropIn = path.join(f.root, 'systemd/imagehost.service.d/override.conf');
  write(f.serviceFile, customUnit);
  write(dropIn, '[Service]\nMemoryMax=256M\n');
  await updateInstallation(f.options, f.dependencies);
  assert.equal(fs.readFileSync(f.serviceFile, 'utf8'), customUnit);
  assert.equal(fs.readFileSync(dropIn, 'utf8'), '[Service]\nMemoryMax=256M\n');
  assert.match(textAt(f.targetDir, 'deploy/imagehost.service'), /new imagehost/);
  assert.equal(f.state.healthConfigs.length, 1);
});

test('source links cannot smuggle files into the root-run updater', async (t) => {
  const f = fixture(t);
  if (!directoryLink(t, path.join(f.root, 'outside-source'), path.join(f.sourceDir, 'src/link'))) return;
  const before = liveSnapshot(f);
  await assert.rejects(updateInstallation(f.options, f.dependencies));
  assert.deepEqual(liveSnapshot(f), before);
  assertNeverStopped(f);
});

test('dependency preparation failure leaves the running installation intact', async (t) => {
  const f = fixture(t);
  const before = liveSnapshot(f);
  f.state.npmFailure = new Error('simulated locked dependency install failure');
  await assert.rejects(updateInstallation(f.options, f.dependencies), /simulated locked dependency install failure/);
  assert.deepEqual(liveSnapshot(f), before);
  assertNeverStopped(f);
});

test('failed health check restores previous code, dependencies and service unit', async (t) => {
  const f = fixture(t);
  const before = liveSnapshot(f);
  f.state.healthFailure = new Error('simulated new release health failure');
  await assert.rejects(updateInstallation(f.options, f.dependencies), /simulated new release health failure/);
  assert.deepEqual(liveSnapshot(f), before);
  assert.equal(fs.readFileSync(f.serviceFile, 'utf8'), f.serviceBefore);
  assert.equal(fs.readFileSync(f.nginxFile, 'utf8'), 'existing custom Nginx configuration\n');
  assert.ok(commands(f, 'systemctl', 'restart').length >= 2, 'previous service is restarted after recovery');
  assert.ok(f.state.healthConfigs.length >= 2, 'recovered installation is checked too');
});

test('optional Nginx refresh rolls back all application and infrastructure changes if validation fails', async (t) => {
  const f = fixture(t);
  const before = liveSnapshot(f);
  f.state.nginxFailures.set(2, new Error('simulated Nginx candidate validation failure'));
  await assert.rejects(updateInstallation({ ...f.options, refreshNginx: true }, f.dependencies), /simulated Nginx candidate validation failure/);
  assert.deepEqual(liveSnapshot(f), before);
  assert.equal(fs.readFileSync(f.serviceFile, 'utf8'), f.serviceBefore);
  assert.equal(fs.readFileSync(f.nginxFile, 'utf8'), 'existing custom Nginx configuration\n');
  assert.ok(commands(f, 'nginx').length >= 3, 'the restored Nginx configuration is validated after preflight and candidate checks');
  assert.ok(f.state.healthConfigs.length >= 1, 'the restored app starts and passes health checks');
});

test('an already-invalid Nginx configuration blocks a refresh without stopping the running app', async (t) => {
  const f = fixture(t);
  const before = liveSnapshot(f);
  f.state.nginxFailures.set(1, new Error('simulated existing proxy configuration failure'));
  await assert.rejects(updateInstallation({ ...f.options, refreshNginx: true }, f.dependencies), /simulated existing proxy configuration failure/);
  assert.deepEqual(liveSnapshot(f), before);
  assert.equal(fs.readFileSync(f.serviceFile, 'utf8'), f.serviceBefore);
  assert.equal(fs.readFileSync(f.nginxFile, 'utf8'), 'existing custom Nginx configuration\n');
  assertNeverStopped(f);
});

test('an unrelated proxy failure during recovery still allows the restored backend to restart', async (t) => {
  const f = fixture(t);
  const before = liveSnapshot(f);
  f.state.nginxFailures.set(2, new Error('simulated candidate failure'));
  f.state.nginxFailures.set(3, new Error('simulated unrelated proxy failure during recovery'));
  await assert.rejects(updateInstallation({ ...f.options, refreshNginx: true }, f.dependencies), (error) => {
    assert.match(error.message, /simulated candidate failure/);
    assert.match(error.message, /simulated unrelated proxy failure during recovery/);
    return true;
  });
  assert.deepEqual(liveSnapshot(f), before);
  assert.equal(fs.readFileSync(f.serviceFile, 'utf8'), f.serviceBefore);
  assert.equal(fs.readFileSync(f.nginxFile, 'utf8'), 'existing custom Nginx configuration\n');
  assert.equal(f.state.healthConfigs.length, 1, 'the restored backend passes its health check');
  const restartIndex = f.events.findIndex((event) => event.command === 'systemctl' && event.args[0] === 'restart');
  const lastNginxIndex = f.events.findLastIndex((event) => event.command === 'nginx');
  assert.ok(restartIndex >= 0 && restartIndex < lastNginxIndex, 'backend restart is attempted before proxy recovery validation');
});

test('configurable upload directories overlapping managed application files are refused', async (t) => {
  for (const uploadsDir of ['.', 'public/user-images', 'src/user-images', 'node_modules/user-images']) {
    const f = fixture(t, { uploadsDir });
    const before = liveSnapshot(f);
    await assert.rejects(updateInstallation(f.options, f.dependencies), undefined, `must refuse uploadsDir=${uploadsDir}`);
    assert.deepEqual(liveSnapshot(f), before);
    assertNeverStopped(f);
  }
});

test('uploads cannot overlap the private backup directory', async (t) => {
  const f = fixture(t);
  f.config.uploadsDir = path.join(f.backupRoot, 'user-images');
  write(path.join(f.targetDir, 'config.json'), JSON.stringify(f.config, null, 2) + '\n');
  const before = liveSnapshot(f);
  await assert.rejects(updateInstallation(f.options, f.dependencies), /uploadsDir.*backup/i);
  assert.deepEqual(liveSnapshot(f), before);
  assertNeverStopped(f);
});

test('a managed destination symlink is rejected without changing its external target', async (t) => {
  const f = fixture(t);
  const outside = path.join(f.root, 'outside-target');
  fs.rmSync(path.join(f.targetDir, 'public'), { recursive: true });
  if (!directoryLink(t, outside, path.join(f.targetDir, 'public'))) return;
  write(path.join(outside, 'keep.txt'), 'external data\n');
  await assert.rejects(updateInstallation(f.options, f.dependencies));
  assert.equal(textAt(outside, 'keep.txt'), 'external data\n');
  assertNeverStopped(f);
});

test('an uploaded release inside the installed tree or its ancestor is rejected', async (t) => {
  const f = fixture(t);
  const nested = path.join(f.targetDir, 'incoming');
  makeRelease(nested, 'nested');
  const before = liveSnapshot(f);
  await assert.rejects(updateInstallation({ ...f.options, sourceDir: nested }, f.dependencies));
  await assert.rejects(updateInstallation({ ...f.options, sourceDir: f.root }, f.dependencies));
  assert.deepEqual(liveSnapshot(f), before);
  assertNeverStopped(f);
});

test('manual rollback restores the saved release while retaining records and configuration created after update', async (t) => {
  const f = fixture(t);
  const result = await updateInstallation(f.options, f.dependencies);
  write(path.join(f.targetDir, 'uploads/after-update.bin'), 'new user image\n');
  const changedConfig = { ...f.config, port: 24681 };
  const changedText = JSON.stringify(changedConfig, null, 2) + '\n';
  write(path.join(f.targetDir, 'config.json'), changedText);
  await rollbackInstallation({ ...f.options, backupDir: result.backupDir }, f.dependencies);
  assert.match(textAt(f.targetDir, 'index.js'), /old application/);
  assert.equal(textAt(f.targetDir, 'node_modules/fixture-dependency/version.txt'), 'old dependency\n');
  assert.equal(textAt(f.targetDir, 'config.json'), changedText);
  assert.equal(textAt(f.targetDir, 'uploads/after-update.bin'), 'new user image\n');
  assert.equal(textAt(f.targetDir, '.session-secret'), 'existing-session-secret-do-not-change\n');
  assert.equal(fs.readFileSync(f.serviceFile, 'utf8'), f.serviceBefore);
  assert.equal(f.state.healthConfigs.at(-1).port, 24681);
});

test('an unsuccessful automatic service recovery reports both failures', async (t) => {
  const f = fixture(t);
  f.state.restartFailures = [new Error('simulated new release restart failure'), new Error('simulated recovery restart failure')];
  await assert.rejects(updateInstallation(f.options, f.dependencies), (error) => {
    assert.match(error.message, /simulated new release restart failure/);
    assert.match(error.message, /simulated recovery restart failure/);
    return true;
  });
  assert.match(textAt(f.targetDir, 'index.js'), /old application/);
  assert.equal(textAt(f.targetDir, 'config.json'), JSON.stringify(f.config, null, 2) + '\n');
});

test('failed manual rollback reloads the current validator when recovering the current version', async (t) => {
  const f = fixture(t);
  // Represent an older validator that is incompatible with today's config.
  fs.appendFileSync(path.join(f.targetDir, 'src/config.js'), '\nmodule.exports.load = () => { throw new Error("old validator rejected current settings"); };\n');
  const result = await updateInstallation(f.options, f.dependencies);
  await assert.rejects(rollbackInstallation({ ...f.options, backupDir: result.backupDir }, f.dependencies), (error) => {
    assert.match(error.message, /Rollback failed; current application restored/);
    assert.match(error.message, /old validator rejected current settings/);
    assert.doesNotMatch(error.message, /Restoring the current version also failed/);
    return true;
  });
  assert.match(textAt(f.targetDir, 'index.js'), /new application/);
  assert.equal(f.state.healthConfigs.at(-1).port, f.config.port);
});
