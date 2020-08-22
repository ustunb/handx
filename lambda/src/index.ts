import { spawnSync } from 'child_process';
import { createHmac }from 'crypto';
import { readFileSync, writeFileSync } from 'fs';
import { request } from 'https';

import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { Octokit } from '@octokit/rest';
import { createAppAuth } from '@octokit/auth-app';
import { EventPayloads } from '@octokit/webhooks';
import * as Chromium from 'chrome-aws-lambda';
import { Browser } from 'puppeteer-core';

type AppPush = EventPayloads.WebhookPayloadPush & EventPayloads.WebhookPayloadInstallation;

const X_HUB_SIGNATURE = 'X-Hub-Signature';
const ALGORITHM = 'sha1';
const X_GITHUB_EVENT = 'X-GitHub-Event';
const X_GITHUB_HOST = 'X-GitHub-Enterprise-Host';

const SITES: { [_: string]: string|undefined } = JSON.parse(process.env.SITES!);

export async function handler(req: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  validateSignature(req);
  
  const event = req.headers[X_GITHUB_EVENT];
  const body = JSON.parse(req.body!);
  
  switch (event) {
    case 'ping':
      return { statusCode: 200, body: body.zen };
    case 'integration_installation':
      return { statusCode: 200, body: 'OK' };
    case 'installation':
      return { statusCode: 200, body: 'OK' };
    case 'push':
      return handlePush(req.headers[X_GITHUB_HOST], body);
  }
  
  return { statusCode: 404, body: `unexpected ${event} event` };
};

function validateSignature(req: APIGatewayProxyEvent): void {
  const signature = req.headers[X_HUB_SIGNATURE];
  if ( ! signature) { throw new Error(`missing ${X_HUB_SIGNATURE}`)}
  const [ sign_algo, sign_hmac ] = signature.split('=', 2);
  if (sign_algo !== ALGORITHM) { throw new Error(`expected ${ALGORITHM} ${X_HUB_SIGNATURE}`); }
  const hmac = createHmac(ALGORITHM, process.env.WEBHOOK_SECRET!).update(req.body!, 'utf8').digest('hex');
  if (sign_hmac !== hmac) { throw new Error(`invalid ${X_HUB_SIGNATURE}`); }
}

async function handlePush(host: string, req: AppPush): Promise<APIGatewayProxyResult> {
  const delivery = SITES[req.repository.full_name];
  if ( ! delivery) {
    return { statusCode: 404, body: `unknown repo ${req.repository.full_name}` };
  }
  if (req.ref !== `refs/heads/${req.repository.default_branch}`) {
    return { statusCode: 200, body: `ignoring non-default ${req.ref}` };
  }
  
  const octokit = new Octokit({
    baseUrl: `https://${host}/api/v3`,
    authStrategy: createAppAuth,
    auth: {
      id: process.env.GITHUB_APP_ID,
      privateKey: process.env.GITHUB_PRIVATE_KEY,
      installationId: req.installation.id,
    },
  });
  const { token } = await octokit.auth({
    type: 'installation',
    installationId: req.installation.id,
  }) as any;
  
  const rev = req.after.substr(0, 7);
  
  const src = `/tmp/in-${rev}`;
  spawnSync('mkdir', [ '-p', src ], { encoding: 'utf8', stdio: 'inherit' });
  const url = req.repository.clone_url.replace('://', `://x-access-token:${token}@`);
  // TODO clone to the actual depth
  spawnSync('git', [ 'clone', `--depth`, '10', url, '.' ], { cwd: src, encoding: 'utf8', stdio: 'inherit' });
  
  const updated = findUpdated(req.before, req.after, src);
  
  if (updated.size === 0) {
    return { statusCode: 200, body: 'no updates' };
  }
  
  const out = `/tmp/out-${rev}`;
  spawnSync('mkdir', [ '-p', `${out}/.handx` ], { encoding: 'utf8', stdio: 'inherit' });
  for (const path of updated) {
    const dirs = findDirs(`${src}/${path}/handout`);
    spawnSync('mkdir', [
      '-p', `${out}/${path}`, ...dirs.map(dir => `${out}/${path}/${dir}`) ], { encoding: 'utf8', stdio: 'inherit' });
  }
  
  for (const path of updated) {
    const files = findFiles(`${src}/${path}/handout`);
    for (const file of files) {
      if (needsRender(file, `${src}/${path}/handout`)) {
        await doRender(file, path, src, out);
      } else if (needsFix(file)) {
        doCopy(file, path, src, out);
      } else {
        spawnSync('cp', [
          `${src}/${path}/handout/${file}`, `${out}/${path}/${file}` ], { encoding: 'utf8', stdio: 'inherit' });
      }
    }
  }
  
  spawnSync('/var/task/bin/tar', [
    'cvf', '.tar', '.handx', ...updated ], { cwd: out, stdio: 'inherit' });
  const tar = readFileSync(`${out}/.tar`);
  const hmac = createHmac(ALGORITHM, process.env.WEBHOOK_SECRET!).update(tar).digest('hex');
  const deliver = request(delivery, {
    method: 'POST',
    headers: {
      'Content-Length': tar.byteLength,
      'X-Handx-Signature': `${ALGORITHM}=${hmac}`,
      'X-Handx-Revision': rev,
    },
  });
  const done = new Promise((resolve, reject) => {
    deliver.once('response', resolve);
    deliver.once('error', reject);
  });
  deliver.end(tar);
  
  await done;
  
  return { statusCode: 200, body: JSON.stringify([ ...updated ]) };
}

function findUpdated(before: string, after: string, cwd: string): Set<string> {
  const { stdout, error } = spawnSync('git', [
    'diff', '--name-only', before, after ], { cwd, encoding: 'utf8' });
  if (error) { throw error; }
  return new Set(stdout.split('\n').map(line => line?.match(/(.*)\/handout\//)?.[1]).filter(nonnull));
}

function findDirs(cwd: string): string[] {
  const { stdout, error } = spawnSync('/var/task/bin/find', [
    '-L', '.', '-mindepth', '1', '-type', 'd' ], { cwd, encoding: 'utf8' });
  if (error) { throw error; }
  return stdout.split('\n').map(line => line?.match(/^\.\/(.*)/)?.[1]).filter(nonnull);
}

function findFiles(cwd: string): string[] {
  const { stdout, error } = spawnSync('/var/task/bin/find', [
    '-L', '.', '-type', 'f' ], { cwd, encoding: 'utf8' });
  if (error) { throw error; }
  return stdout.split('\n').map(line => line?.match(/^\.\/(.*)/)?.[1]).filter(nonnull);
}

function needsRender(file: string, cwd: string): boolean {
  if ( ! file.endsWith('.html')) { return false; }
  const { status, error } = spawnSync('grep', [
    '-q', 'handout-page.js', file ], { cwd, encoding: 'utf8' });
  if (error) { throw error; }
  return status === 0;
}

let BROWSER: Promise<Browser>|null = null;

async function doRender(file: string, path: string, src: string, out: string) {
  const [ kind, handout, part ] = `${path}/${file.replace('.html', '')}`.split('/');
  const deliver = `?handout-deliver=${kind}/${handout}/${part || ''}/`;
  if ( ! BROWSER) {
    BROWSER = Chromium.executablePath.then(executablePath => Chromium.puppeteer.launch({
      args: Chromium.args,
      defaultViewport: Chromium.defaultViewport,
      executablePath,
      headless: Chromium.headless,
      ignoreHTTPSErrors: true,
    }));
  }
  const browser = await BROWSER;
  const page = await browser.newPage();
  await page.goto(`file://${src}/${path}/handout/${file}${deliver}`, { waitUntil: 'networkidle0' });
  const result = await page.content();
  // TODO programmatic access instead?
  const regex = /^HANDOUT_DELIVERY\t([^ ]+) (.*)\n/m;
  const delivered = result.match(regex);
  if (delivered) {
    const [ id, meta ] = delivered.slice(1);
    writeFileSync(`${out}/.handx/${id}.json`, fixRelative(path, meta));
  }
  writeFileSync(`${out}/${path}/${file}`, fixRelative(path, result.replace(regex, '')));
}

function doCopy(file: string, path: string, src: string, out: string) {
  const text = readFileSync(`${src}/${path}/handout/${file}`, { encoding: 'utf8' });
  writeFileSync(`${out}/${path}/${file}`, fixRelative(path, text));
}

function needsFix(file: string): boolean {
  return file.endsWith('.html') || file.endsWith('.shtml') || file.endsWith('.svg');
}

function fixRelative(path: string, text: string): string {
  // fix paths to site CSS & JavaScript
  // ="../../../web/handout/handout-file" -> ="../../web/handout-file"
  const noHandout = text.replace(/(="[^"]*)\/\.\.\/([^"]*)\/handout\/([^"]*")/g, '$1/$2/$3');
  
  // fix paths to index files
  // ="../../web/index.html" -> ="../../web/", ="dir/index.html" -> ="dir/"
  const noIndex = noHandout.replace(/(="(?:[^":]+\/)*)index\.s?html([^"]*")/g, '$1$2');
  
  if (path !== 'home') { return noIndex; }
  // fix relative paths from home page
  // ="../web/something" -> ="web/something"
  return noIndex.replace(/(=")\.\.\/([^"]*")/g, '$1$2');
}

function nonnull<T>(value: T): value is NonNullable<T> {
  return value !== null && value !== undefined;
}