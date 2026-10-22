// Headless Chrome over the DevTools pipe, for browser-check, import and PDF export.
// findChrome, executable/findOnPath, PipeCdp and the launch arguments are adapted from archify
// (bin/visual-check.mjs, https://github.com/tt-a1i/archify), MIT License,
// Copyright (c) 2026 tt-a1i (Archify), Copyright (c) 2025 Cocoon AI.
// Added here: persistent event listeners and capture of console errors, exceptions and failed loads.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME_ENV = 'LEARNDOC_CHROME';
const CHROME_NO_SANDBOX_ENV = 'LEARNDOC_CHROME_NO_SANDBOX';
const STARTUP_TIMEOUT_MS = 90000;

function executable(file, platform = process.platform) {
  if (!file) return null;
  try {
    fs.accessSync(file, platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
    return path.resolve(file);
  } catch {
    return null;
  }
}

function findOnPath(command, env, platform, resolveExecutable) {
  const pathApi = platform === 'win32' ? path.win32 : path;
  const directories = String(env.PATH || '').split(pathApi.delimiter).filter(Boolean);
  const extensions = platform === 'win32'
    ? String(env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)
    : [''];
  for (const directory of directories) {
    for (const extension of extensions) {
      const resolved = resolveExecutable(pathApi.join(directory, `${command}${extension}`), platform);
      if (resolved) return resolved;
    }
  }
  return null;
}

// -> absolute path of a Chrome/Chromium executable, or null. LEARNDOC_CHROME (even empty) wins.
export function findChrome({ env = process.env, platform = process.platform, resolveExecutable = executable } = {}) {
  if (Object.hasOwn(env, CHROME_ENV)) return resolveExecutable(env[CHROME_ENV], platform);
  const fixed = [];
  const commands = [];
  if (platform === 'darwin') {
    fixed.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    );
  } else if (platform === 'win32') {
    for (const root of [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter(Boolean)) {
      fixed.push(
        path.win32.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.win32.join(root, 'Chromium', 'Application', 'chrome.exe'),
      );
    }
    commands.push('chrome', 'google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser');
  } else {
    commands.push('google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser');
  }
  for (const candidate of fixed) {
    const resolved = resolveExecutable(candidate, platform);
    if (resolved) return resolved;
  }
  for (const command of commands) {
    const resolved = findOnPath(command, env, platform, resolveExecutable);
    if (resolved) return resolved;
  }
  return null;
}

// CDP over --remote-debugging-pipe: fd 3 = commands to Chrome, fd 4 = replies/events, NUL-delimited JSON.
class PipeCdp {
  constructor(child, failureDetails) {
    this.child = child;
    this.failureDetails = failureDetails;
    this.nextId = 1;
    this.buffer = '';
    this.pending = new Map();
    this.waiters = [];
    this.listeners = new Map();
    this.closedError = null;
    this.writePipe = child.stdio[3];
    this.readPipe = child.stdio[4];
    this.readPipe.setEncoding('utf8');
    this.readPipe.on('data', (chunk) => this.consume(chunk));
    this.writePipe.on('error', (error) => this.failAll(this.failure('write pipe', error)));
    this.readPipe.on('error', (error) => this.failAll(this.failure('read pipe', error)));
    this.readPipe.once('close', () => this.failAll(this.failure('read pipe', new Error('stream closed'))));
    child.once('error', (error) => this.failAll(this.failure('process launch', error)));
    child.once('close', (code, signal) => {
      this.failAll(this.failure('process exit', new Error(`Chrome closed with ${signal ? `signal ${signal}` : `exit code ${code}`}`)));
    });
  }

  failure(stage, error) {
    const details = this.failureDetails();
    const failure = new Error([`Chrome DevTools ${stage} failed: ${error?.message || String(error)}`, details].filter(Boolean).join('\n'));
    if (error?.code) failure.code = error.code;
    return failure;
  }

  consume(chunk) {
    this.buffer += chunk;
    let boundary;
    while ((boundary = this.buffer.indexOf('\0')) >= 0) {
      const raw = this.buffer.slice(0, boundary);
      this.buffer = this.buffer.slice(boundary + 1);
      if (!raw) continue;
      let message;
      try {
        message = JSON.parse(raw);
      } catch (error) {
        this.failAll(new Error(`Chrome DevTools returned invalid JSON: ${error.message}`));
        continue;
      }
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) continue;
        clearTimeout(pending.timer);
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(`${pending.method}: ${message.error.message}`));
        else pending.resolve(message.result || {});
        continue;
      }
      for (const listener of this.listeners.get(message.method) || []) listener(message.params || {}, message.sessionId);
      for (const waiter of [...this.waiters]) {
        if (waiter.method !== message.method || (waiter.sessionId && waiter.sessionId !== message.sessionId)) continue;
        clearTimeout(waiter.timer);
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        waiter.resolve(message.params || {});
      }
    }
  }

  on(method, listener) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(listener);
  }

  send(method, params = {}, sessionId = undefined, timeoutMs = 15000) {
    if (this.closedError) return Promise.reject(this.closedError);
    const id = this.nextId++;
    const message = { id, method, params, ...(sessionId ? { sessionId } : {}) };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(this.failure('protocol timeout', new Error(`${method}: timed out after ${timeoutMs}ms`)));
      }, timeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
      this.writePipe.write(`${JSON.stringify(message)}\0`, (error) => {
        if (error) this.failAll(this.failure('write pipe', error));
      });
    });
  }

  waitFor(method, sessionId, timeoutMs = 15000) {
    if (this.closedError) return Promise.reject(this.closedError);
    return new Promise((resolve, reject) => {
      const waiter = { method, sessionId, resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        reject(this.failure('event timeout', new Error(`${method}: event timed out after ${timeoutMs}ms`)));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  failAll(error) {
    this.closedError ??= error;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.pending.clear();
    this.waiters = [];
  }
}

function chromeArgs(profileRoot, { env = process.env, extraArgs = [] } = {}) {
  const args = [
    '--headless=new',
    '--remote-debugging-pipe',
    '--disable-gpu',
    '--hide-scrollbars',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-default-apps',
    '--disable-sync',
    '--metrics-recording-only',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--force-device-scale-factor=1',
    `--user-data-dir=${profileRoot}`,
    ...extraArgs,
    'about:blank',
  ];
  const rootUser = typeof process.getuid === 'function' && process.getuid() === 0;
  if (rootUser || env[CHROME_NO_SANDBOX_ENV] === '1') args.unshift('--no-sandbox');
  return args;
}

const remoteObjectText = (arg) => (arg.type === 'string' ? arg.value : arg.description ?? (arg.value !== undefined ? JSON.stringify(arg.value) : arg.type));

// One headless Chrome with one attached page. `problems` collects console errors, uncaught exceptions,
// and failed or HTTP-error loads of resources from the origin last passed to navigate().
// `extraArgs` are added to the Chrome command line (import uses them to cut off the network).
export class ChromeBrowser {
  constructor(chromePath, { env = process.env, extraArgs = [] } = {}) {
    this.profileRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'learndoc-chrome-'));
    this.stderr = '';
    this.problems = [];
    this.origin = null;
    this.requests = new Map();
    this.child = spawn(chromePath, chromeArgs(this.profileRoot, { env, extraArgs }), { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-8000);
    });
    this.cdp = new PipeCdp(this.child, () => {
      const stderr = this.stderr.trim();
      return stderr ? `Chrome stderr:\n${stderr}` : '';
    });
    this.listen();
    this.sessionPromise = this.attach();
    this.sessionPromise.catch(() => {});
  }

  sameOrigin(url) {
    try {
      return Boolean(this.origin) && new URL(url).origin === this.origin;
    } catch {
      return false;
    }
  }

  listen() {
    const add = (problem) => this.problems.push(problem);
    this.cdp.on('Runtime.consoleAPICalled', ({ type, args = [], stackTrace }) => {
      if (type !== 'error' && type !== 'assert') return;
      const frame = stackTrace?.callFrames?.[0];
      add({ kind: 'console', message: args.map(remoteObjectText).join(' '), ...(frame ? { url: frame.url, line: frame.lineNumber + 1 } : {}) });
    });
    this.cdp.on('Runtime.exceptionThrown', ({ exceptionDetails: details }) => {
      add({
        kind: 'exception',
        message: details.exception?.description || details.text,
        ...(details.url ? { url: details.url, line: details.lineNumber + 1 } : {}),
      });
    });
    this.cdp.on('Log.entryAdded', ({ entry }) => {
      // Network errors also arrive as Network events with more detail; keep the rest.
      if (entry.level === 'error' && entry.source !== 'network') add({ kind: 'log', message: entry.text, ...(entry.url ? { url: entry.url } : {}) });
    });
    this.cdp.on('Network.requestWillBeSent', ({ requestId, request }) => this.requests.set(requestId, request.url));
    this.cdp.on('Network.responseReceived', ({ response }) => {
      if (response.status >= 400 && this.sameOrigin(response.url)) {
        add({ kind: 'network', message: `HTTP ${response.status}`, url: response.url });
      }
    });
    this.cdp.on('Network.loadingFailed', ({ requestId, errorText, canceled }) => {
      const url = this.requests.get(requestId);
      if (!canceled && url && this.sameOrigin(url)) add({ kind: 'network', message: errorText, url });
    });
  }

  async attach() {
    const targets = await this.cdp.send('Target.getTargets', {}, undefined, STARTUP_TIMEOUT_MS);
    let target = targets.targetInfos?.find((item) => item.type === 'page');
    if (!target) target = await this.cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await this.cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
    for (const domain of ['Page', 'Runtime', 'Log', 'Network']) await this.cdp.send(`${domain}.enable`, {}, sessionId);
    return sessionId;
  }

  async navigate(url, timeoutMs = 15000) {
    const sessionId = await this.sessionPromise;
    this.origin = new URL(url).origin;
    const loaded = this.cdp.waitFor('Page.loadEventFired', sessionId, timeoutMs);
    loaded.catch(() => {});
    const navigation = await this.cdp.send('Page.navigate', { url }, sessionId);
    if (navigation.errorText) throw new Error(`Chrome navigation failed: ${navigation.errorText}`);
    await loaded;
  }

  // Requests whose URL matches any pattern (e.g. 'https://*') fail inside the browser.
  async blockUrls(patterns) {
    await this.cdp.send('Network.setBlockedURLs', { urls: patterns }, await this.sessionPromise);
  }

  // Runs `source` in every new document (and frame) before the page's own scripts.
  async addInitScript(source) {
    await this.cdp.send('Page.addScriptToEvaluateOnNewDocument', { source }, await this.sessionPromise);
  }

  // Page scripts on or off for the following navigations.
  async setScriptsEnabled(enabled) {
    await this.cdp.send('Emulation.setScriptExecutionDisabled', { value: !enabled }, await this.sessionPromise);
  }

  async evaluate(expression, { awaitPromise = false, timeoutMs = 15000 } = {}) {
    const sessionId = await this.sessionPromise;
    const response = await this.cdp.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true }, sessionId, timeoutMs);
    if (response.exceptionDetails) {
      throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text || 'Runtime.evaluate failed');
    }
    return response.result?.value;
  }

  // The current page as PDF bytes. Printing uses print media and fires beforeprint/afterprint.
  async printToPdf(options = {}, timeoutMs = 120000) {
    const params = { printBackground: true, preferCSSPageSize: true, ...options };
    const { data } = await this.cdp.send('Page.printToPDF', params, await this.sessionPromise, timeoutMs);
    return Buffer.from(data, 'base64');
  }

  async close() {
    if (this.child.exitCode === null && this.child.signalCode === null) {
      const exited = new Promise((resolve) => this.child.once('exit', resolve));
      this.cdp.send('Browser.close').catch(() => {});
      const timer = setTimeout(() => this.child.kill('SIGKILL'), 1500);
      await exited;
      clearTimeout(timer);
    }
    fs.rmSync(this.profileRoot, { recursive: true, force: true, maxRetries: 3 });
  }
}
