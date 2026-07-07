#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const PROJECT_ID = 'tripplanner-80a4f';
const REGION = 'asia-east1';
const CODEBASE = 'tripmate-push';
const FIRESTORE_INDEXES_FILE = 'firestore.indexes.json';
const FUNCTIONS = [
  'notifyTripRootWrite',
  'notifyTripChildWrite',
];
const FUNCTION_ARTIFACT_TARGETS = [
  {
    serviceId: 'notifytriprootwrite',
    packageName: 'tripplanner--80a4f__asia--east1__notify_trip_root_write',
  },
  {
    serviceId: 'notifytripchildwrite',
    packageName: 'tripplanner--80a4f__asia--east1__notify_trip_child_write',
  },
];
const POLL_MS = 15_000;
const READY_TIMEOUT_MS = 20 * 60_000;
const DELETE_BATCH_SIZE = 500;
const PRODUCTION_BRANCH = 'main';
const ROOT_DIR = path.resolve(import.meta.dirname, '..');

function abort(message) {
  console.error(message);
  process.exit(1);
}

const rawArgs = process.argv.slice(2);
const ALLOWED_EXACT_ARGS = new Set([
  '--help',
  '--dry-run',
  '--artifacts-only',
  '--revisions-only',
  '--functions-only',
  '--worker-only',
  '--clear-notifications-only',
]);
const isAllowedArg = (arg) =>
  ALLOWED_EXACT_ARGS.has(arg) || arg.startsWith('--confirm-clear-notifications=');
const unknownArgs = rawArgs.filter((arg) => !isAllowedArg(arg));
if (unknownArgs.length > 0) {
  abort(
    `[deploy:prod] ABORT: unknown argument(s): ${unknownArgs.join(', ')}\n` +
      'Run `npm run deploy:prod -- --help` for supported flags.',
  );
}

const args = new Set(rawArgs);
const dryRun = args.has('--dry-run');
const artifactsOnly = args.has('--artifacts-only');
const revisionsOnly = args.has('--revisions-only');
const functionsOnly = args.has('--functions-only');
const workerOnly = args.has('--worker-only');
const clearNotificationsOnly = args.has('--clear-notifications-only');
const clearNotificationsConfirmArg = rawArgs.find((arg) =>
  arg.startsWith('--confirm-clear-notifications='),
);
const clearNotificationsConfirm =
  clearNotificationsConfirmArg
    ?.split('=')
    .slice(1)
    .join('=') ?? '';

if (args.has('--help')) {
  console.log(`
Usage:
  npm run deploy:prod
  npm run deploy:prod -- --dry-run
  npm run functions:deploy
  npm run worker:deploy
  npm run functions:artifacts:keep-one
  npm run functions:revisions:keep-one
  npm run notifications:clear -- --confirm-clear-notifications=${PROJECT_ID}

Options:
  --artifacts-only             Prune Cloud Functions runtime images only.
  --revisions-only             Prune Cloud Run revisions only.
  --clear-notifications-only   Delete all notification inbox docs.
  --confirm-clear-notifications=${PROJECT_ID}
                                Required for real notification cleanup.
  --functions-only             Deploy Functions only.
  --worker-only                Deploy Cloudflare Worker only.
  --dry-run                    Print commands without changing remote state.

Real production actions require main == origin/main and a clean worktree.
`);
  process.exit(0);
}

const modeCount = [
  artifactsOnly,
  revisionsOnly,
  functionsOnly,
  workerOnly,
  clearNotificationsOnly,
].filter(Boolean).length;
if (modeCount > 1) {
  abort(
    '[deploy:prod] ABORT: use only one of --artifacts-only / --revisions-only / ' +
      '--functions-only / --worker-only / --clear-notifications-only.',
  );
}

if (clearNotificationsConfirmArg && !clearNotificationsOnly) {
  abort(
    '[deploy:prod] ABORT: --confirm-clear-notifications is only valid with ' +
      '--clear-notifications-only.',
  );
}

function bin(name) {
  return process.platform === 'win32' ? `${name}.cmd` : name;
}

function git(commandArgs, options = {}) {
  const result = spawnSync(
    'git',
    commandArgs,
    {
      cwd: ROOT_DIR,
      encoding: 'utf8',
      stdio: options.stdio ?? 'pipe',
      shell: false,
    },
  );

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    abort(`[deploy:prod] ABORT: git ${commandArgs.join(' ')} failed.`);
  }

  return (result.stdout ?? '').trim();
}

function assertProductionGitRef() {
  if (dryRun) {
    console.log('production git gate: dry run skips checks');
    return;
  }

  const currentBranch = git(['branch', '--show-current']);
  if (currentBranch !== PRODUCTION_BRANCH) {
    abort(
      `[deploy:prod] ABORT: production deploy must run from ` +
        `\`${PRODUCTION_BRANCH}\`, current branch is \`${currentBranch || '(detached)'}\`.`,
    );
  }

  git(['fetch', '--quiet', 'origin', PRODUCTION_BRANCH], { stdio: 'ignore' });

  const head = git(['rev-parse', 'HEAD']);
  const originHead = git(['rev-parse', `origin/${PRODUCTION_BRANCH}`]);
  if (head !== originHead) {
    abort(
      `[deploy:prod] ABORT: local HEAD must equal origin/${PRODUCTION_BRANCH} before production deploy.\n` +
        `    HEAD: ${head}\n` +
        `    origin/${PRODUCTION_BRANCH}: ${originHead}`,
    );
  }

  const status = git(['status', '--porcelain']);
  if (status.length > 0) {
    abort(
      `[deploy:prod] ABORT: worktree must be clean before production deploy.\n` +
        status
          .split('\n')
          .slice(0, 20)
          .map((line) => `    ${line}`)
          .join('\n'),
    );
  }
}

function gcloudBin() {
  if (process.env.GCLOUD_BIN) {
    return process.env.GCLOUD_BIN;
  }

  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA;
    const candidates = [
      localAppData && path.join(localAppData, 'Google', 'CloudSDK-575', 'google-cloud-sdk', 'bin', 'gcloud.cmd'),
      localAppData && path.join(localAppData, 'Google', 'CloudSDK', 'google-cloud-sdk', 'bin', 'gcloud.cmd'),
    ].filter(Boolean);
    const existing = candidates.find((candidate) => fs.existsSync(candidate));
    if (existing) {
      return existing;
    }
  }

  return bin('gcloud');
}

function run(command, commandArgs, options = {}) {
  const line = [command, ...commandArgs].join(' ');
  console.log(`\n$ ${line}`);

  if (dryRun) {
    return { ok: true, output: '' };
  }

  const isCmdShim = process.platform === 'win32' && command.toLowerCase().endsWith('.cmd');
  const result = spawnSync(
    isCmdShim ? (process.env.ComSpec ?? 'cmd.exe') : command,
    isCmdShim ? ['/d', '/s', '/c', command, ...commandArgs] : commandArgs,
    {
      cwd: ROOT_DIR,
      encoding: 'utf8',
      stdio: options.capture ? 'pipe' : 'inherit',
      shell: false,
    },
  );

  if (result.error) {
    throw result.error;
  }

  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  const output = `${stdout}${stderr}`;
  if (options.capture && options.printOutput !== false && output.length > 0) {
    process.stdout.write(output);
  }

  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(`Command failed (${result.status}): ${line}`);
  }

  return { ok: result.status === 0, output, stdout, stderr };
}

function firebase(commandArgs, options = {}) {
  return run(bin('npx'), ['-y', 'firebase-tools@latest', ...commandArgs], {
    capture: true,
    ...options,
  });
}

function gcloud(commandArgs, options = {}) {
  return run(gcloudBin(), commandArgs, {
    capture: true,
    printOutput: false,
    ...options,
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, dryRun ? 0 : ms));
}

function parseJsonOutput(output, label = 'Command', root = 'any') {
  const start = root === 'object' ? output.indexOf('{') : output.search(/[\[{]/);
  if (start === -1) {
    throw new Error(`${label} did not return JSON.`);
  }

  const opener = output[start];
  const closer = opener === '{' ? '}' : ']';
  const end = output.lastIndexOf(closer);
  if (end <= start) {
    throw new Error(`${label} did not return complete JSON.`);
  }

  return JSON.parse(output.slice(start, end + 1));
}

function isDeploy409(output) {
  return /HTTP Error: 409/i.test(output);
}

function readJsonFile(fileName) {
  return JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '..', fileName), 'utf8'));
}

function normalizedIndexFields(index) {
  return (index.fields ?? [])
    .filter((field) => field.fieldPath !== '__name__')
    .map((field) => ({
      fieldPath: field.fieldPath,
      order: field.order ?? null,
      arrayConfig: field.arrayConfig ?? null,
      vectorConfig: field.vectorConfig ?? null,
    }));
}

function collectionGroupOfIndex(index) {
  if (typeof index.collectionGroup === 'string' && index.collectionGroup.length > 0) {
    return index.collectionGroup;
  }

  const match = typeof index.name === 'string'
    ? index.name.match(/\/collectionGroups\/([^/]+)\/indexes\//)
    : null;
  return match?.[1] ?? index.collectionGroup;
}

function indexKey(index) {
  return JSON.stringify({
    collectionGroup: collectionGroupOfIndex(index),
    queryScope: index.queryScope,
    fields: normalizedIndexFields(index),
  });
}

function indexLabel(index) {
  const fields = normalizedIndexFields(index)
    .map((field) => {
      const mode = field.arrayConfig ?? field.order ?? 'VECTOR';
      return `${field.fieldPath},${mode}`;
    })
    .join(' ');
  return `(${index.collectionGroup}/${index.queryScope}) ${fields}`;
}

function localCompositeIndexes() {
  return readJsonFile(FIRESTORE_INDEXES_FILE).indexes ?? [];
}

function readyRemoteCompositeIndexKeys() {
  const indexes = parseJsonOutput(
    gcloud([
      'firestore',
      'indexes',
      'composite',
      'list',
      '--project',
      PROJECT_ID,
      '--format=json',
    ]).stdout,
  );
  return new Set(
    indexes
      .filter((index) => index.state === 'READY')
      .map(indexKey),
  );
}

function preflightGcloud({ firestore = false, cloudRun = false, artifacts = false } = {}) {
  if (dryRun) {
    console.log('gcloud preflight: dry run skips checks');
    return;
  }

  readGcloudAccessToken();

  if (firestore) {
    readyRemoteCompositeIndexKeys();
  }

  if (cloudRun) {
    parseJsonOutput(
      gcloud([
        'run',
        'services',
        'list',
        '--region',
        REGION,
        '--project',
        PROJECT_ID,
        '--format=json',
      ]).stdout,
    );
  }

  if (artifacts) {
    parseJsonOutput(
      gcloud([
        'artifacts',
        'repositories',
        'describe',
        'gcf-artifacts',
        '--location',
        REGION,
        '--project',
        PROJECT_ID,
        '--format=json',
      ]).stdout,
    );
  }

  console.log('gcloud preflight: ready');
}

async function firebaseDeployWith409Retry(label, commandArgs) {
  const startedAt = Date.now();

  for (;;) {
    const result = firebase(commandArgs, { allowFailure: true });
    if (result.ok) {
      return;
    }

    if (!isDeploy409(result.output)) {
      throw new Error(`${label} failed.`);
    }

    if (Date.now() - startedAt > READY_TIMEOUT_MS) {
      throw new Error(`${label} kept returning 409 for ${READY_TIMEOUT_MS / 60_000} minutes.`);
    }

    console.log(`${label} returned 409; retrying after ${POLL_MS / 1000}s...`);
    await sleep(POLL_MS);
  }
}

async function waitUntil(label, check) {
  if (dryRun) {
    console.log(`${label}: dry run skips polling`);
    return;
  }

  const startedAt = Date.now();

  for (;;) {
    if (await check()) {
      console.log(`${label}: ready`);
      return;
    }

    if (Date.now() - startedAt > READY_TIMEOUT_MS) {
      throw new Error(`${label}: timed out after ${READY_TIMEOUT_MS / 60_000} minutes.`);
    }

    console.log(`${label}: waiting ${POLL_MS / 1000}s...`);
    await sleep(POLL_MS);
  }
}

async function deployIndexes() {
  await firebaseDeployWith409Retry('Firestore indexes deploy',
    ['deploy', '--only', 'firestore:indexes', '--project', PROJECT_ID],
  );

  const expectedIndexes = localCompositeIndexes();
  await waitUntil('firestore composite indexes', async () => {
    const readyKeys = readyRemoteCompositeIndexKeys();
    const missing = expectedIndexes.filter((index) => !readyKeys.has(indexKey(index)));
    if (missing.length > 0) {
      console.log(
        `Waiting for ${missing.length} composite index(es): ${missing.map(indexLabel).join('; ')}`,
      );
      return false;
    }
    return true;
  });
}

function listFunctions() {
  if (dryRun) {
    return FUNCTIONS.map((id) => ({
      id,
      state: 'ACTIVE',
      eventTrigger: {},
      codebase: CODEBASE,
    }));
  }

  const result = firebase(['functions:list', '--project', PROJECT_ID, '--json']);
  return parseJsonOutput(result.output, 'Firebase CLI', 'object').result ?? [];
}

function isExpectedFunctionReady(fn) {
  return fn?.state === 'ACTIVE' && fn?.eventTrigger && fn?.codebase === CODEBASE;
}

async function waitForFunctionReady(name) {
  await waitUntil(`function ${name}`, async () => {
    const fn = listFunctions().find((item) => item.id === name);
    return isExpectedFunctionReady(fn);
  });
}

async function waitForAllFunctionsReady() {
  await waitUntil('functions', async () => {
    const byName = new Map(listFunctions().map((fn) => [fn.id, fn]));
    return FUNCTIONS.every((name) => isExpectedFunctionReady(byName.get(name)));
  });
}

async function deployFunction(name) {
  const target = `functions:${CODEBASE}:${name}`;
  await firebaseDeployWith409Retry(`Function deploy ${name}`,
    ['deploy', '--only', target, '--project', PROJECT_ID, '--force'],
  );

  await waitForFunctionReady(name);
}

async function deployFunctions() {
  const existing = listFunctions();
  const byName = new Map(existing.map((fn) => [fn.id, fn]));
  const allReady = FUNCTIONS.every((name) => isExpectedFunctionReady(byName.get(name)));

  if (allReady) {
    const target = `functions:${CODEBASE}`;
    await firebaseDeployWith409Retry('Functions deploy',
      ['deploy', '--only', target, '--project', PROJECT_ID, '--force'],
    );

    await waitForAllFunctionsReady();
    return;
  }

  console.log('Some functions are missing or not ACTIVE; deploying one function at a time.');
  for (const name of FUNCTIONS) {
    await deployFunction(name);
  }
}

// Retired functions must be explicitly deleted, not left to implicit codebase
// prune: a targeted `functions:codebase:name` deploy (the path taken when the
// new functions don't exist yet) prunes NOTHING, so old triggers would stay
// live and double-fire the same Firestore write with a different event.id that
// `_pushEvents` can't dedupe.
//
// Runs as post-deploy HYGIENE — after the whole critical path (functions +
// rules + pages), never before it — so a housekeeping error can't leave a
// split-brain release (new functions live, this release's rules/pages never
// shipped). The new functions are already ACTIVE by the time we get here, so
// the old ones staying live until now costs only a brief old+new overlap where
// one write can double-notify; it self-heals the moment the delete lands.
// functions:delete still THROWS on failure (surfaces the double-fire risk;
// retryable because the old functions are still listable next run); only the
// artifact-package cleanup below is downgraded to a warning (its retry signal
// dies with the function, so throwing would strand not retry).
// ponytail: no maintenance-mode gate — negligible at this scale; add one here
// if the overlap window ever needs to be zero.
// Scoped to our codebase so it can never touch functions outside tripmate-push.
// After cutover the retired set is empty → idempotent no-op.
async function retireUnexpectedFunctions() {
  if (dryRun) {
    console.log('retire functions: dry run skips deletion');
    return;
  }

  const retired = listFunctions()
    .filter((fn) => fn?.codebase === CODEBASE && !FUNCTIONS.includes(fn.id))
    .map((fn) => fn.id);

  if (retired.length === 0) {
    console.log('No retired functions to delete.');
    return;
  }

  console.log(`Deleting retired functions in codebase ${CODEBASE}: ${retired.join(', ')}`);
  const result = firebase(
    ['functions:delete', ...retired, '--project', PROJECT_ID, '--region', REGION, '--force'],
    { allowFailure: true },
  );
  if (!result.ok) {
    throw new Error(`Failed to delete retired functions: ${retired.join(', ')}`);
  }

  // functions:delete removes the function + its Cloud Run service but leaves the
  // build images in Artifact Registry, and pruneFunctionArtifactsToOne only
  // sweeps the CURRENT targets — so a retired function's images would accrue
  // cost forever. Delete the whole retired package (all versions). Best-effort:
  // it may already be gone. Package name mirrors gcloud's gcf-artifacts scheme
  // (project/region '-'→'--', function id camelCase→snake_case) — verified
  // against the previous FUNCTION_ARTIFACT_TARGETS; tied to that naming.
  for (const id of retired) {
    const pkg = `${PROJECT_ID.replace(/-/g, '--')}__${REGION.replace(/-/g, '--')}__${id.replace(/([A-Z])/g, '_$1').toLowerCase()}`;
    const res = gcloud(
      ['artifacts', 'packages', 'delete', pkg, '--repository', 'gcf-artifacts', '--location', REGION, '--project', PROJECT_ID, '--quiet'],
      { allowFailure: true },
    );
    if (res.ok) {
      console.log(`Deleted retired artifact package ${pkg}`);
    } else if (/NOT_FOUND|was not found|does not exist/i.test(res.output)) {
      console.log(`Retired artifact package ${pkg} already absent`);
    } else {
      // Real error (IAM / API-disabled / network / quota) — surface it LOUDLY
      // but do NOT throw. The function is already deleted, so 'retired' can't
      // re-derive this package on a re-run (its retry signal is gone); throwing
      // would only strand the images AND, running before rules/pages, abort the
      // release. Warn for manual cleanup instead of masking it as "absent".
      console.warn(`[WARN] Retired artifact package ${pkg} NOT deleted (non-NOT_FOUND error); delete it manually to avoid image cost:\n${res.output}`);
    }
  }
}

async function googleFetch(url, init) {
  const token = readGcloudAccessToken();
  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'x-goog-user-project': PROJECT_ID,
      ...(init?.headers ?? {}),
    },
  });
  const text = await response.text();
  const data = text.length > 0 ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(`Google API ${response.status}: ${JSON.stringify(data)}`);
  }
  return data;
}

async function pruneCloudRunRevisionsToLatest() {
  console.log('\nPruning Cloud Run revisions to one revision per function...');
  if (dryRun) {
    console.log('Dry run: skipped Cloud Run revision pruning.');
    return;
  }

  let deleted = 0;

  for (const { serviceId } of FUNCTION_ARTIFACT_TARGETS) {
    const service = parseJsonOutput(
      gcloud([
        'run',
        'services',
        'describe',
        serviceId,
        '--region',
        REGION,
        '--project',
        PROJECT_ID,
        '--format=json',
      ]).stdout,
    );
    const revisions = parseJsonOutput(
      gcloud([
        'run',
        'revisions',
        'list',
        '--service',
        serviceId,
        '--region',
        REGION,
        '--project',
        PROJECT_ID,
        '--format=json',
      ]).stdout,
    );
    const keep = new Set([
      service.status?.latestReadyRevisionName,
      service.status?.latestCreatedRevisionName,
    ].filter(Boolean));

    for (const target of service.spec?.traffic ?? []) {
      if (target.percent > 0 && target.revisionName) {
        keep.add(target.revisionName);
      }
    }

    if (revisions.length <= keep.size) {
      console.log(`${serviceId}: ${revisions.length} revision(s), nothing to prune.`);
      continue;
    }

    for (const revision of revisions) {
      const revisionName = revision.metadata?.name;
      if (!revisionName || keep.has(revisionName)) {
        continue;
      }

      deleted += 1;
      gcloud([
        'run',
        'revisions',
        'delete',
        revisionName,
        '--region',
        REGION,
        '--project',
        PROJECT_ID,
        '--quiet',
      ]);
    }
  }

  console.log(`Cloud Run revision prune complete: ${deleted} old revision(s) deleted.`);
}

function artifactDigestFromImage(image, packageName) {
  const marker = `${packageName}@`;
  const markerIndex = image.indexOf(marker);
  if (markerIndex === -1) {
    return null;
  }

  const digest = image.slice(markerIndex + marker.length);
  if (!digest.startsWith('sha256:')) {
    return null;
  }

  return digest;
}

function artifactDigestFromVersionName(versionName) {
  if (typeof versionName !== 'string') {
    return null;
  }

  const digest = versionName.split('/versions/').pop();
  return digest?.startsWith('sha256:') ? digest : null;
}

function listCloudRunRevisionImages(serviceId) {
  const revisions = parseJsonOutput(
    gcloud([
      'run',
      'revisions',
      'list',
      '--service',
      serviceId,
      '--region',
      REGION,
      '--project',
      PROJECT_ID,
      '--format=json',
    ]).stdout,
  );

  return revisions
    .map((revision) => revision.status?.imageDigest ?? revision.spec?.containers?.[0]?.image)
    .filter(Boolean);
}

function runtimeArtifactVersionsInUse(serviceId, packageName) {
  return new Set(
    listCloudRunRevisionImages(serviceId)
      .map((image) => artifactDigestFromImage(image, packageName))
      .filter(Boolean),
  );
}

async function pruneFunctionArtifactsToOne() {
  console.log('\nPruning Cloud Functions runtime images to one version per function...');
  if (dryRun) {
    console.log('Dry run: skipped Artifact Registry pruning.');
    return;
  }

  let deleted = 0;

  for (const { serviceId, packageName } of FUNCTION_ARTIFACT_TARGETS) {
    const versions = parseJsonOutput(
      gcloud([
        'artifacts',
        'versions',
        'list',
        '--package',
        packageName,
        '--repository',
        'gcf-artifacts',
        '--location',
        REGION,
        '--project',
        PROJECT_ID,
        '--format=json',
      ]).stdout,
    );
    if (versions.length <= 1) {
      console.log(`${packageName}: ${versions.length} version(s), nothing to prune.`);
      continue;
    }

    const keep = runtimeArtifactVersionsInUse(serviceId, packageName);
    if (keep.size === 0) {
      throw new Error(`${serviceId}: no Cloud Run runtime image digest found; refusing to prune artifacts.`);
    }

    for (const version of versions) {
      const versionDigest = artifactDigestFromVersionName(version.name);
      if (!versionDigest) {
        throw new Error(`${packageName}: invalid Artifact Registry version name: ${version.name}`);
      }

      if (!keep.has(versionDigest)) {
        gcloud([
          'artifacts',
          'versions',
          'delete',
          versionDigest,
          '--package',
          packageName,
          '--repository',
          'gcf-artifacts',
          '--location',
          REGION,
          '--project',
          PROJECT_ID,
          '--delete-tags',
          '--quiet',
        ]);
        deleted += 1;
      }
    }
  }

  console.log(`Artifact prune complete: ${deleted} old runtime image version(s) deleted.`);
}

async function deployRules() {
  await firebaseDeployWith409Retry('Firestore rules deploy',
    ['deploy', '--only', 'firestore:rules', '--project', PROJECT_ID],
  );
}

function preflightWorkerDeploy() {
  // Cloudflare auth gate. `wrangler whoami` is NOT reliable by exit code alone:
  // v4.106 prints "You are not authenticated" but EXITS 0 when no credentials
  // are present (only a malformed/rejected token exits non-zero), so a missing
  // CLOUDFLARE_API_TOKEN — the common CI failure — would sail through. Inspect
  // the output too. ponytail: string-match ceiling — if a future wrangler
  // reworks the message this fails OPEN (deploy proceeds, same as before the
  // gate existed), never falsely blocks a good deploy.
  const auth = run(bin('npm'), ['--workspace', 'workers/ocr', 'run', 'whoami'], { capture: true, allowFailure: true });
  if (!auth.ok || /not authenticated/i.test(auth.output)) {
    abort(
      '[deploy:prod] ABORT: Cloudflare Worker auth check failed. ' +
        'Run `wrangler login` or set CLOUDFLARE_API_TOKEN before deploying.',
    );
  }
  // Bundle/config validation before touching remote state.
  run(bin('npm'), ['--workspace', 'workers/ocr', 'run', 'deploy', '--', '--dry-run']);
}

function deployWorker() {
  run(bin('npm'), ['--workspace', 'workers/ocr', 'run', 'deploy']);
}

function readGcloudAccessToken() {
  const result = gcloud(['auth', 'print-access-token'], { printOutput: false });
  const token = result.stdout.trim();
  if (!token) {
    throw new Error('gcloud access token not found. Run `gcloud auth login`.');
  }
  return token;
}

async function queryNotificationDocNames() {
  const parent = `projects/${PROJECT_ID}/databases/(default)/documents`;
  const rows = await googleFetch(`https://firestore.googleapis.com/v1/${parent}:runQuery`, {
    method: 'POST',
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId: 'notifications', allDescendants: true }],
        limit: DELETE_BATCH_SIZE,
      },
    }),
  });

  return rows.map((row) => row.document?.name).filter(Boolean);
}

async function deleteNotificationDocs(names) {
  if (names.length === 0) {
    return;
  }

  const parent = `projects/${PROJECT_ID}/databases/(default)/documents`;
  await googleFetch(`https://firestore.googleapis.com/v1/${parent}:batchWrite`, {
    method: 'POST',
    body: JSON.stringify({
      writes: names.map((name) => ({ delete: name })),
    }),
  });
}

async function clearNotifications() {
  console.log('\nClearing existing notification inbox docs...');
  if (dryRun) {
    console.log('Dry run: skipped notification cleanup.');
    return;
  }
  if (clearNotificationsConfirm !== PROJECT_ID) {
    throw new Error(
      `Refusing to clear notifications. Re-run with --confirm-clear-notifications=${PROJECT_ID}`,
    );
  }

  let deleted = 0;
  for (;;) {
    const names = await queryNotificationDocNames();
    if (names.length === 0) {
      break;
    }
    await deleteNotificationDocs(names);
    deleted += names.length;
    console.log(`Deleted ${deleted} notification doc(s)...`);
  }

  console.log(`Notification cleanup complete: ${deleted} deleted.`);
}

function buildPages() {
  run(bin('npm'), ['run', 'deploy:pages', '--', '--build-only']);
}

function deployPages() {
  run(bin('npm'), ['run', 'deploy:pages', '--', '--deploy-only']);
}

async function main() {
  assertProductionGitRef();

  if (clearNotificationsOnly) {
    await clearNotifications();
    return;
  }

  if (artifactsOnly) {
    await pruneFunctionArtifactsToOne();
    return;
  }

  if (revisionsOnly) {
    await pruneCloudRunRevisionsToLatest();
    return;
  }

  if (functionsOnly) {
    preflightGcloud({ cloudRun: true, artifacts: true });
    await deployFunctions();
    await retireUnexpectedFunctions();
    await pruneCloudRunRevisionsToLatest();
    await pruneFunctionArtifactsToOne();
    return;
  }

  if (workerOnly) {
    preflightWorkerDeploy();
    deployWorker();
    return;
  }

  buildPages();
  preflightGcloud({ firestore: true, cloudRun: true, artifacts: true });
  preflightWorkerDeploy();
  await deployIndexes();
  deployWorker();
  await deployFunctions();
  await deployRules();
  deployPages();

  // Post-deploy hygiene: retire old functions + prune revisions/images. Kept
  // AFTER the critical path so a cost/cleanup error can never abort the
  // functions/rules/pages release above.
  await retireUnexpectedFunctions();
  await pruneCloudRunRevisionsToLatest();
  await pruneFunctionArtifactsToOne();
}

await main();
