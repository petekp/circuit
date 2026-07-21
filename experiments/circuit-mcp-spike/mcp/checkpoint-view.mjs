import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';

const MAX_PATH_CHARS = 4_096;
const MAX_REQUEST_BYTES = 256 * 1024;
const MAX_REVIEW_INPUTS = 32;
const MAX_REVIEW_INPUT_BYTES = 512 * 1024;
const MAX_REVIEW_TOTAL_BYTES = 2 * 1024 * 1024;
const MAX_PROMPT_CHARS = 4_000;
const MAX_CHOICE_ID_CHARS = 128;
const MAX_CHOICE_LABEL_CHARS = 200;
const MAX_CHOICE_DESCRIPTION_CHARS = 2_000;
const READ_CHUNK_BYTES = 64 * 1024;
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;
const NONBLOCK = constants.O_NONBLOCK ?? 0;
const SHA256 = /^[a-f0-9]{64}$/;

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pathIsInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function boundedString(value, label, maxChars) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  if (value.length > maxChars) throw new Error(`${label} is too long.`);
  return value;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function fileIdentity(stat) {
  return { device: stat.dev, inode: stat.ino };
}

function sameFileIdentity(left, right) {
  return left.device === right.dev && left.inode === right.ino;
}

function changedPathError(label) {
  return new Error(`${label} changed while Circuit was reading it.`);
}

function safeRelativePath(value, label) {
  boundedString(value, label, MAX_PATH_CHARS);
  if (path.isAbsolute(value) || value.includes('\\') || value.includes('\0')) {
    throw new Error(`${label} must be a normalized run-relative path.`);
  }
  const parts = value.split('/');
  if (
    parts.some((part) => part.length === 0 || part === '.' || part === '..') ||
    path.posix.normalize(value) !== value
  ) {
    throw new Error(`${label} must be a normalized run-relative path.`);
  }
  return value;
}

async function canonicalRunFolder(runFolder) {
  const resolved = path.resolve(boundedString(runFolder, 'Run folder', MAX_PATH_CHARS));
  const stat = await lstat(resolved, { bigint: true });
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error('Run folder must be a real directory.');
  }
  const canonical = await realpath(resolved);
  if (canonical !== resolved) throw new Error('Run folder must not cross a symbolic link.');
  return {
    absolute: canonical,
    identity: fileIdentity(stat),
  };
}

async function safeFilePath(runFolder, value, label, allowAbsolute) {
  boundedString(value, label, MAX_PATH_CHARS);
  let candidate;
  if (path.isAbsolute(value)) {
    if (!allowAbsolute) throw new Error(`${label} must be a run-relative path.`);
    candidate = path.resolve(value);
  } else {
    const relative = safeRelativePath(value, label);
    candidate = path.resolve(runFolder.absolute, relative);
  }
  if (!pathIsInside(runFolder.absolute, candidate) || candidate === runFolder.absolute) {
    throw new Error(`${label} must stay inside the run folder.`);
  }

  const relative = path.relative(runFolder.absolute, candidate);
  const parts = relative.split(path.sep);
  const chain = [
    {
      absolute: runFolder.absolute,
      identity: runFolder.identity,
      kind: 'directory',
    },
  ];
  let current = runFolder.absolute;
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    const stat = await lstat(current, { bigint: true });
    if (stat.isSymbolicLink()) throw new Error(`${label} must not cross a symbolic link.`);
    if (index < parts.length - 1 && !stat.isDirectory()) {
      throw new Error(`${label} has a non-directory parent.`);
    }
    if (index === parts.length - 1 && !stat.isFile()) {
      throw new Error(`${label} must be a regular file.`);
    }
    chain.push({
      absolute: current,
      identity: fileIdentity(stat),
      kind: index < parts.length - 1 ? 'directory' : 'file',
    });
  }
  const canonical = await realpath(candidate);
  if (canonical !== candidate || !pathIsInside(runFolder.absolute, canonical)) {
    throw new Error(`${label} must stay inside the run folder without symbolic links.`);
  }
  return {
    absolute: canonical,
    relative: relative.split(path.sep).join('/'),
    chain,
  };
}

async function assertPathChainUnchanged(file, label) {
  for (const entry of file.chain) {
    let stat;
    try {
      stat = await lstat(entry.absolute, { bigint: true });
    } catch (error) {
      if (error?.code === 'ENOENT') throw changedPathError(label);
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error(`${label} must not cross a symbolic link.`);
    if (entry.kind === 'directory' ? !stat.isDirectory() : !stat.isFile()) {
      throw changedPathError(label);
    }
    if (!sameFileIdentity(entry.identity, stat)) throw changedPathError(label);
  }
}

async function readBoundedHandle(handle, maxBytes, label) {
  const chunks = [];
  let totalBytes = 0;
  while (true) {
    const bytesToRead = Math.min(READ_CHUNK_BYTES, maxBytes - totalBytes + 1);
    const buffer = Buffer.allocUnsafe(bytesToRead);
    const { bytesRead } = await handle.read(buffer, 0, bytesToRead, totalBytes);
    if (bytesRead === 0) break;
    totalBytes += bytesRead;
    if (totalBytes > maxBytes) throw new Error(`${label} is too large.`);
    chunks.push(buffer.subarray(0, bytesRead));
  }
  return Buffer.concat(chunks, totalBytes).toString('utf8');
}

async function readBoundedFile(file, maxBytes, label) {
  let handle;
  try {
    handle = await open(file.absolute, constants.O_RDONLY | NO_FOLLOW | NONBLOCK);
    const stat = await handle.stat({ bigint: true });
    if (!stat.isFile()) throw new Error(`${label} must be a regular file.`);
    if (stat.size > BigInt(maxBytes)) throw new Error(`${label} is too large.`);
    await assertPathChainUnchanged(file, label);
    const expectedFile = file.chain.at(-1);
    if (expectedFile === undefined || !sameFileIdentity(expectedFile.identity, stat)) {
      throw changedPathError(label);
    }
    const body = await readBoundedHandle(handle, maxBytes, label);
    const finalStat = await handle.stat({ bigint: true });
    if (!sameFileIdentity(expectedFile.identity, finalStat)) throw changedPathError(label);
    if (finalStat.size > BigInt(maxBytes)) throw new Error(`${label} is too large.`);
    await assertPathChainUnchanged(file, label);
    return body;
  } catch (error) {
    if (error?.code === 'ELOOP') throw new Error(`${label} must not be a symbolic link.`);
    throw error;
  } finally {
    await handle?.close();
  }
}

function parseJson(body, label) {
  try {
    return JSON.parse(body);
  } catch {
    throw new Error(`${label} is not valid JSON.`);
  }
}

function choiceIds(value, label) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) {
    throw new Error(`${label} must contain 1 through 32 choices.`);
  }
  const result = value.map((choice, index) =>
    boundedString(choice, `${label}[${index}]`, MAX_CHOICE_ID_CHARS),
  );
  if (new Set(result).size !== result.length) throw new Error(`${label} contains duplicates.`);
  return result;
}

function sameStrings(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function packetChoices(reviewMaterial) {
  const found = new Map();
  for (const item of reviewMaterial) {
    const packet = isRecord(item.content) ? item.content.checkpoint_packet : undefined;
    if (!isRecord(packet) || !Array.isArray(packet.choices)) continue;
    for (const choice of packet.choices) {
      if (!isRecord(choice) || typeof choice.id !== 'string') continue;
      found.set(choice.id, choice);
    }
  }
  return found;
}

function normalizedChoices(request, allowedChoices, reviewMaterial) {
  if (!Array.isArray(request.choices) || request.choices.length > 32) {
    throw new Error('Checkpoint request choices are invalid.');
  }
  const byId = new Map();
  for (const [index, raw] of request.choices.entries()) {
    if (!isRecord(raw)) throw new Error(`Checkpoint request choice ${index} is invalid.`);
    const id = boundedString(raw.id, `Checkpoint request choice ${index} id`, MAX_CHOICE_ID_CHARS);
    if (byId.has(id)) throw new Error('Checkpoint request choices contain duplicates.');
    byId.set(id, raw);
  }
  const packets = packetChoices(reviewMaterial);
  return allowedChoices.map((id) => {
    const raw = byId.get(id);
    if (raw === undefined) throw new Error(`Checkpoint request is missing choice '${id}'.`);
    const packet = packets.get(id);
    const labelSource = raw.label ?? packet?.label ?? id;
    const descriptionSource =
      raw.description ?? packet?.description ?? `Continue this run with '${id}'.`;
    return {
      id,
      label: boundedString(labelSource, `Checkpoint choice '${id}' label`, MAX_CHOICE_LABEL_CHARS),
      description: boundedString(
        descriptionSource,
        `Checkpoint choice '${id}' description`,
        MAX_CHOICE_DESCRIPTION_CHARS,
      ),
    };
  });
}

async function reviewMaterial(runFolder, request) {
  const context = request.execution_context;
  if (!isRecord(context) || !Array.isArray(context.review_inputs)) {
    throw new Error('Checkpoint request is missing its review inputs.');
  }
  if (context.review_inputs.length > MAX_REVIEW_INPUTS) {
    throw new Error('Checkpoint request has too many review inputs.');
  }
  const seen = new Set();
  const material = [];
  let totalBytes = 0;
  for (const [index, identity] of context.review_inputs.entries()) {
    if (!isRecord(identity)) throw new Error(`Checkpoint review input ${index} is invalid.`);
    const relative = safeRelativePath(identity.path, `Checkpoint review input ${index} path`);
    const expectedHash = boundedString(
      identity.sha256,
      `Checkpoint review input ${index} hash`,
      64,
    );
    if (!SHA256.test(expectedHash)) {
      throw new Error(`Checkpoint review input ${index} hash is invalid.`);
    }
    if (seen.has(relative)) throw new Error('Checkpoint review inputs contain duplicate paths.');
    seen.add(relative);
    const file = await safeFilePath(
      runFolder,
      relative,
      `Checkpoint review input '${relative}'`,
      false,
    );
    const body = await readBoundedFile(
      file,
      MAX_REVIEW_INPUT_BYTES,
      `Checkpoint review input '${relative}'`,
    );
    totalBytes += Buffer.byteLength(body);
    if (totalBytes > MAX_REVIEW_TOTAL_BYTES) {
      throw new Error('Checkpoint review inputs are too large in total.');
    }
    if (sha256(body) !== expectedHash) {
      throw new Error(`Checkpoint review input '${relative}' changed after the request was made.`);
    }
    material.push({
      path: relative,
      content: parseJson(body, `Checkpoint review input '${relative}'`),
    });
  }
  return material;
}

export async function checkpointViewForJob(job) {
  const checkpoint = job?.final?.checkpoint;
  if (!isRecord(checkpoint)) return undefined;
  const runFolder = await canonicalRunFolder(job.runFolder);
  const stepId = boundedString(checkpoint.step_id, 'Checkpoint step id', 256);
  const allowedChoices = choiceIds(checkpoint.allowed_choices, 'Checkpoint allowed choices');
  const expectedRequestHash = boundedString(
    checkpoint.request_sha256,
    'Checkpoint request hash',
    64,
  );
  if (!SHA256.test(expectedRequestHash)) throw new Error('Checkpoint request hash is invalid.');
  const requestFile = await safeFilePath(
    runFolder,
    checkpoint.request_path,
    'Checkpoint request path',
    true,
  );
  const requestBody = await readBoundedFile(requestFile, MAX_REQUEST_BYTES, 'Checkpoint request');
  if (sha256(requestBody) !== expectedRequestHash) {
    throw new Error('Checkpoint request changed after Circuit paused.');
  }
  const request = parseJson(requestBody, 'Checkpoint request');
  if (!isRecord(request) || request.schema_version !== 1 || request.step_id !== stepId) {
    throw new Error('Checkpoint request does not match the waiting run.');
  }
  const requestChoices = choiceIds(request.allowed_choices, 'Checkpoint request allowed choices');
  if (!sameStrings(requestChoices, allowedChoices)) {
    throw new Error('Checkpoint request choices do not match the waiting run.');
  }
  const material = await reviewMaterial(runFolder, request);
  const safeDefault = request.safe_default_choice;
  if (safeDefault !== undefined && !allowedChoices.includes(safeDefault)) {
    throw new Error('Checkpoint safe default is not an allowed choice.');
  }
  return {
    step_id: stepId,
    prompt: boundedString(request.prompt, 'Checkpoint prompt', MAX_PROMPT_CHARS),
    request_path: requestFile.relative,
    request_sha256: expectedRequestHash,
    allowed_choices: allowedChoices,
    choices: normalizedChoices(request, allowedChoices, material),
    ...(safeDefault === undefined ? {} : { safe_default_choice: safeDefault }),
    review_material: material,
  };
}
