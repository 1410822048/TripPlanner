#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const PROJECT_ID = 'tripplanner-80a4f';
const REGION = 'asia-east1';
const CODEBASE = 'tripmate-push';
const FIRESTORE_INDEXES_FILE = 'firestore.indexes.json';
const FUNCTIONS = [
  'notifyBookingWrite',
  'notifyExpenseWrite',
  'notifyMemberJoined',
  'notifySettlementWrite',
];
const FUNCTION_ARTIFACT_TARGETS = [
  {
    serviceId: 'notifybookingwrite',
    packageName: 'tripplanner--80a4f__asia--east1__notify_booking_write',
  },
  {
    serviceId: 'notifyexpensewrite',
    packageName: 'tripplanner--80a4f__asia--east1__notify_expense_write',
  },
  {
    serviceId: 'notifymemberjoined',
    packageName: 'tripplanner--80a4f__asia--east1__notify_member_joined',
  },
  {
    serviceId: 'notifysettlementwrite',
    packageName: 'tripplanner--80a4f__asia--east1__notify_settlement_write',
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
  --dry-run                    Print commands without changing remote state.

Real production actions require main == origin/main and a clean worktree.
`);
  process.exit(0);
}

const modeCount = [
  artifactsOnly,
  revisionsOnly,
  functionsOnly,
  clearNotificationsOnly,
].filter(Boolean).length;
if (modeCount > 1) {
  abort(
    '[deploy:prod] ABORT: use only one of --artifacts-only / --revisions-only / ' +
      '--functions-only / --clear-notifications-only.',
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

function indexKey(index) {
  return JSON.stringify({
    collectionGroup: index.collectionGroup,
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
    await pruneCloudRunRevisionsToLatest();
    await pruneFunctionArtifactsToOne();
    return;
  }

  buildPages();
  preflightGcloud({ firestore: true, cloudRun: true, artifacts: true });
  await deployIndexes();
  await deployFunctions();
  await pruneCloudRunRevisionsToLatest();
  await pruneFunctionArtifactsToOne();
  await deployRules();
  deployPages();
}

await main();
