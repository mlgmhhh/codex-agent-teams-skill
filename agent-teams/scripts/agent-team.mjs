#!/usr/bin/env node
/**
 * agent-team.mjs — Codex 侧的持久化 Agent Teams store（零 npm 依赖，Node >= 18）。
 *
 * 官方 DSH 内置 Agent Teams 插件把「Lead 会话日志」当作唯一真源，roster / mailbox /
 * 任务板每次读取都从中回放派生。Codex 没有 teammate 工具，所以这里用同一个原则做
 * 文件 store：
 *
 *   journal.jsonl  唯一真源（append-only 事件日志，逐行 JSON）
 *   team.json      仅存 teamId / lead / limits / createdAt（不可变配置）
 *   lock/          mkdir 互斥锁（CAS 与所有写操作在此串行）
 *   workers/       <name>.log（worker stdout/stderr）、<name>.pid（存活判定）
 *
 * teammate 用 `codex exec` 子进程实现，初始 prompt（含逐字身份前缀）从 stdin 送入。
 *
 * 分层：
 *   0. 常量 / 错误类型
 *   1. 日志层   —— 读写 team.json 与 journal.jsonl、mkdir 锁、CAS 的事务边界
 *   2. 派生层   —— 从事件流回放 roster / mailbox / task board 与全部视图
 *   3. 校验层   —— 官方 requiredText / writeScope / memberName / 依赖图校验
 *   4. worker 层 —— codex exec 子进程生命周期
 *   5. 命令层   —— 9 个官方工具名子命令 + init/inbox/status/journal 运维命令
 *   6. CLI 层   —— 参数解析、退出码、stdout JSON 输出
 *
 * 退出码：0 成功；1 用法/环境错误；2 领域错误（stdout 打印 TEAM_* 错误对象）。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/* ==========================================================================
 * 0. 常量 / 错误码 / 错误类型
 * ========================================================================*/

const STORE_VERSION = 1;
const DEFAULT_DIR = '.agent-team';

/** 官方 profile 实际生效的上限（cordis.patch.yml:20-24）。 */
const DEFAULT_LIMITS = Object.freeze({
  maxMembers: 8,
  maxTasks: 256,
  maxPendingMessagesPerMember: 64,
  maxMessageBytes: 65536,
});

const MAX_SUBJECT = 200;
const MAX_DESCRIPTION = 16384;
const MEMBER_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const TASK_ID_PATTERN = /^task-(\d+)$/u;

const WAIT_DEFAULT_MS = 30_000;
const WAIT_MIN_MS = 10_000;
const WAIT_MAX_MS = 3_600_000;
const ACTIVE_WAIT_STATUSES = Object.freeze(['running', 'provisioning']);

/** 逐字取自 tool-agent-team/lib/index.js:29（no-active-peer 的固定诊断文本）。 */
const NO_ACTIVE_PEER_MESSAGE =
  'No other Team member is running or provisioning. wait_agent cannot make progress or wake inactive teammates. Re-list with list_agents and team_task_list, then use send_message to wake each required inactive teammate before waiting again.';

const EVENT = Object.freeze({
  MEMBER_PROVISIONING: 'member/provisioning',
  MEMBER_ACTIVE: 'member/active',
  MEMBER_FAILED: 'member/failed',
  MESSAGE_QUEUED: 'message/queued',
  MESSAGE_DELIVERED: 'message/delivered',
  TASK_CREATED: 'task/created',
  TASK_UPDATED: 'task/updated',
  TASK_DELETED: 'task/deleted',
});

const STATUS_FILTERS = Object.freeze(['pending', 'in_progress', 'completed']);

/**
 * 官方源码中出现的 `TEAM_[A-Z_]+` 字面量共 29 个 token，其中 `TEAM_POLICY`
 * 是 systemPrompt 的 section 名（lib/index.js:239）而不是错误码，因此错误码共 28 个。
 * 单进程 CLI 模型下 TEAM_DISPOSED / TEAM_DISPOSAL_TIMEOUT / TEAM_WAIT_ABORTED
 * 不可达，保留常量以便错误码表完整。
 */
const TEAM_CODES = Object.freeze({
  INVALID_TIMEOUT: 'TEAM_INVALID_TIMEOUT',
  WAIT_ABORTED: 'TEAM_WAIT_ABORTED',
  DISPOSED: 'TEAM_DISPOSED',
  DISPOSAL_TIMEOUT: 'TEAM_DISPOSAL_TIMEOUT',
  INVALID_ARGUMENT: 'TEAM_INVALID_ARGUMENT',
  INVALID_WRITE_SCOPE: 'TEAM_INVALID_WRITE_SCOPE',
  INVALID_MEMBER_NAME: 'TEAM_INVALID_MEMBER_NAME',
  INVALID_CONFIG: 'TEAM_INVALID_CONFIG',
  INVALID_TARGET: 'TEAM_INVALID_TARGET',
  NOT_MEMBER: 'TEAM_NOT_MEMBER',
  LEAD_REQUIRED: 'TEAM_LEAD_REQUIRED',
  SELF_MESSAGE: 'TEAM_SELF_MESSAGE',
  MAILBOX_FULL: 'TEAM_MAILBOX_FULL',
  MESSAGE_TOO_LARGE: 'TEAM_MESSAGE_TOO_LARGE',
  MEMBER_NOT_FOUND: 'TEAM_MEMBER_NOT_FOUND',
  MEMBER_NAME_TAKEN: 'TEAM_MEMBER_NAME_TAKEN',
  MEMBER_LIMIT: 'TEAM_MEMBER_LIMIT',
  PROVISIONING_CONFLICT: 'TEAM_PROVISIONING_CONFLICT',
  TASK_NOT_FOUND: 'TEAM_TASK_NOT_FOUND',
  TASK_LIMIT: 'TEAM_TASK_LIMIT',
  TASK_STALE_REVISION: 'TEAM_TASK_STALE_REVISION',
  TASK_DELETED: 'TEAM_TASK_DELETED',
  TASK_UNAUTHORIZED: 'TEAM_TASK_UNAUTHORIZED',
  TASK_ALREADY_CLAIMED: 'TEAM_TASK_ALREADY_CLAIMED',
  TASK_BLOCKED: 'TEAM_TASK_BLOCKED',
  TASK_INVALID_TRANSITION: 'TEAM_TASK_INVALID_TRANSITION',
  TASK_HAS_DEPENDENTS: 'TEAM_TASK_HAS_DEPENDENTS',
  TASK_DEPENDENCY_CYCLE: 'TEAM_TASK_DEPENDENCY_CYCLE',
});

/** 领域错误：exit 2，stdout 输出 {"error":{"code":"TEAM_..."}}。 */
class TeamError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'TeamError';
    this.code = code;
    this.domain = true;
  }
}

/** 用法 / 环境错误：exit 1。code 不用 TEAM_ 前缀，避免污染官方错误码集合。 */
class CliError extends Error {
  constructor(message, code = 'E_USAGE') {
    super(message);
    this.name = 'CliError';
    this.code = code;
    this.domain = false;
  }
}

function errorMessage(error) {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return String(error);
}

/* ==========================================================================
 * 1. 日志层：team.json / journal.jsonl / mkdir 锁
 * ========================================================================*/

function envPositiveInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function envTruthy(name) {
  const raw = process.env[name];
  if (raw === undefined) return false;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

const LOCK_TIMEOUT_MS = envPositiveInt('AGENT_TEAM_LOCK_TIMEOUT_MS', 20_000);
const LOCK_STALE_MS = envPositiveInt('AGENT_TEAM_LOCK_STALE_MS', 30_000);
const WORKER_GRACE_MS = envPositiveInt('AGENT_TEAM_WORKER_GRACE_MS', 600);
const PROVISIONING_STALE_MS = envPositiveInt('AGENT_TEAM_PROVISIONING_STALE_MS', 3_000);
const WAIT_POLL_MS = 200;

function storePaths(dir) {
  return {
    dir,
    team: path.join(dir, 'team.json'),
    journal: path.join(dir, 'journal.jsonl'),
    lock: path.join(dir, 'lock'),
    workers: path.join(dir, 'workers'),
  };
}

function ensureDir(target) {
  fs.mkdirSync(target, { recursive: true });
}

function resolveDir(options) {
  const raw = optionString(options, 'dir') ?? process.env.AGENT_TEAM_DIR ?? DEFAULT_DIR;
  const text = String(raw).trim();
  if (text.length === 0) throw new CliError('--dir must be non-empty', 'E_USAGE');
  return path.resolve(text);
}

function writeFileAtomic(file, text) {
  const temp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temp, text);
  fs.renameSync(temp, file);
}

function readTeamFile(paths) {
  if (!fs.existsSync(paths.team)) {
    throw new CliError(
      `team store is not initialized at ${paths.dir}; run "agent-team.mjs init" first`,
      'E_NOT_INITIALIZED',
    );
  }
  let team;
  try {
    team = JSON.parse(fs.readFileSync(paths.team, 'utf8'));
  } catch (error) {
    throw new CliError(`cannot read ${paths.team}: ${errorMessage(error)}`, 'E_JOURNAL_CORRUPT');
  }
  if (
    team === null ||
    typeof team !== 'object' ||
    typeof team.teamId !== 'string' ||
    typeof team.lead !== 'string' ||
    team.limits === null ||
    typeof team.limits !== 'object'
  ) {
    throw new CliError(`${paths.team} is not a valid team file`, 'E_JOURNAL_CORRUPT');
  }
  return team;
}

/**
 * 读取并解析 journal.jsonl。
 * 崩溃可能发生在一次 append 的中途，因此**只容忍尾部**那一行残片；中间行坏掉即视为损坏。
 */
function readJournalEvents(journalFile) {
  if (!fs.existsSync(journalFile)) return [];
  const text = fs.readFileSync(journalFile, 'utf8');
  const lines = text.split('\n');
  const events = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim().length === 0) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      const isTail = lines.slice(index + 1).every((rest) => rest.trim().length === 0);
      if (isTail) break;
      throw new CliError(`journal is corrupt at line ${index + 1}: ${errorMessage(error)}`, 'E_JOURNAL_CORRUPT');
    }
    if (parsed === null || typeof parsed !== 'object' || !Number.isSafeInteger(parsed.seq) || typeof parsed.type !== 'string') {
      throw new CliError(`journal line ${index + 1} is not a Team event`, 'E_JOURNAL_CORRUPT');
    }
    events.push(parsed);
  }
  return events;
}

/**
 * 追加事件。写一条 fsync 一条批次：官方 `appendAndFlush` 的语义是"返回前已持久"，
 * 而 mailbox 的正确性依赖 `message/queued` 一定先于任何投递尝试落盘 —— 也就是
 * "queued 就已经持久、绝不能重发"这条规则在存储层的实现。
 */
function appendEvents(paths, events, entries) {
  if (entries.length === 0) return events;
  let seq = events.length > 0 ? events[events.length - 1].seq : 0;
  const lines = [];
  const appended = [];
  for (const entry of entries) {
    seq += 1;
    const event = { seq, time: new Date().toISOString(), type: entry.type, data: entry.data };
    lines.push(JSON.stringify(event));
    appended.push(event);
  }
  const fd = fs.openSync(paths.journal, 'a');
  try {
    fs.writeSync(fd, `${lines.join('\n')}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  return [...events, ...appended];
}

const SLEEP_BUFFER = new Int32Array(new SharedArrayBuffer(4));

function sleepSync(ms) {
  Atomics.wait(SLEEP_BUFFER, 0, 0, ms);
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * 陈旧锁回收：持锁进程被 kill 会留下永久 lock 目录。按 mtime 判定，并在删除前
 * 重新 stat 比对 mtime——把"回收了别人刚创建的新锁"这个 TOCTOU 窗口压到最小。
 */
function reclaimStaleLock(lockDir) {
  try {
    const before = fs.statSync(lockDir).mtimeMs;
    if (Date.now() - before <= LOCK_STALE_MS) return false;
    const after = fs.statSync(lockDir).mtimeMs;
    if (after !== before) return false;
    fs.rmSync(lockDir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * mkdir 锁：mkdir 是各平台上唯一的原子"创建即获锁"原语（跨平台、无第三方依赖）。
 * 自旋 + 指数退避到 50ms + 总超时；同步实现，因为事务体全是同步文件操作。
 */
function withLock(paths, body) {
  const lockDir = paths.lock;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let delay = 5;
  for (;;) {
    try {
      fs.mkdirSync(lockDir);
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') {
        throw new CliError(`cannot acquire lock ${lockDir}: ${errorMessage(error)}`, 'E_LOCK_FAILED');
      }
      if (reclaimStaleLock(lockDir)) continue;
      if (Date.now() >= deadline) {
        throw new CliError(`timed out after ${LOCK_TIMEOUT_MS}ms waiting for lock ${lockDir}`, 'E_LOCK_TIMEOUT');
      }
      sleepSync(Math.min(delay, 50));
      delay = Math.min(delay * 2, 50);
    }
  }
  try {
    return body();
  } finally {
    try {
      fs.rmSync(lockDir, { recursive: true, force: true });
    } catch {
      /* 锁目录已消失（陈旧锁回收）时无需处理 */
    }
  }
}

function openStore(options) {
  const dir = resolveDir(options);
  const paths = storePaths(dir);
  const team = readTeamFile(paths);
  return { dir, paths, team };
}

/** 只读快照：读日志 → 回放 → 交给回调。 */
function readState(store, body) {
  const events = readJournalEvents(store.paths.journal);
  const state = deriveState(store.team, events);
  return body(state, events);
}

/**
 * 事务：所有写操作的唯一入口。锁内重新读日志（而不是复用锁外的快照），
 * 这是 CAS 成立的前提——`expectedRevision` 必须与锁内看到的最新 revision 比较。
 */
function transact(store, body) {
  ensureDir(store.paths.dir);
  return withLock(store.paths, () => {
    const events = readJournalEvents(store.paths.journal);
    const state = deriveState(store.team, events);
    return body(state, events, store.paths);
  });
}

/* ==========================================================================
 * 2. 派生层：从事件流回放 roster / mailbox / 任务板
 * ========================================================================*/

function corrupt(detail) {
  return new CliError(`journal is not replayable: ${detail}`, 'E_JOURNAL_CORRUPT');
}

/**
 * 回放一条事件到 state。这里重复了官方 projection 的不变量检查（名字不可复用、
 * 成员身份字段不可变、任务 revision 连续、delivered 必须先 queued），
 * 因为 journal 是唯一真源：真源内部不自洽时必须显式报错而不是静默产生错状态。
 */
function applyEvent(state, event) {
  state.seq = event.seq;
  state.lastTime = event.time;
  const data = event.data ?? {};
  switch (event.type) {
    case EVENT.MEMBER_PROVISIONING: {
      const name = data.name;
      if (typeof name !== 'string' || name.length === 0) throw corrupt(`member name is missing (seq ${event.seq})`);
      // Lead 的名字（可寻址身份 `lead` 与 team.lead 显示名）被 Lead 独占：journal 里出现同名成员
      // 时**必须报错**而不是静默解析，否则 `--as <该名字>` 会冒充 Lead、`--target <该名字>` 会解析成 Lead。
      if (name === 'lead' || name === state.lead) {
        throw new CliError(
          `journal declares teammate "${name}", but that name is reserved for the Team Lead`,
          'E_JOURNAL_CORRUPT',
        );
      }
      if (state.byMemberName.has(name)) throw corrupt(`teammate name "${name}" is reused (seq ${event.seq})`);
      const member = {
        name,
        description: data.description,
        context: data.context,
        provider: data.provider,
        phase: 'provisioning',
        error: undefined,
        provisionedAt: event.time,
      };
      state.members.push(member);
      state.byMemberName.set(name, member);
      return;
    }
    case EVENT.MEMBER_ACTIVE:
    case EVENT.MEMBER_FAILED: {
      const member = state.byMemberName.get(data.name);
      if (member === undefined) throw corrupt(`teammate "${data.name}" settled before provisioning (seq ${event.seq})`);
      if (member.phase !== 'provisioning') {
        throw corrupt(`teammate "${data.name}" has an invalid ${member.phase} -> ${event.type} transition (seq ${event.seq})`);
      }
      member.phase = event.type === EVENT.MEMBER_ACTIVE ? 'active' : 'failed';
      member.error = event.type === EVENT.MEMBER_FAILED ? String(data.error ?? 'provisioning failed') : undefined;
      return;
    }
    case EVENT.MESSAGE_QUEUED: {
      const messageId = data.messageId;
      if (typeof messageId !== 'string' || messageId.length === 0) throw corrupt(`message id is missing (seq ${event.seq})`);
      if (state.messageById.has(messageId)) throw corrupt(`message "${messageId}" was queued twice (seq ${event.seq})`);
      const message = {
        messageId,
        from: data.from,
        target: data.target,
        text: data.text,
        queuedAt: data.queuedAt ?? event.time,
      };
      state.messages.push(message);
      state.messageById.set(messageId, message);
      return;
    }
    case EVENT.MESSAGE_DELIVERED: {
      if (!state.messageById.has(data.messageId)) {
        throw corrupt(`message "${data.messageId}" was delivered before queueing (seq ${event.seq})`);
      }
      state.delivered.add(data.messageId);
      return;
    }
    case EVENT.TASK_CREATED:
    case EVENT.TASK_UPDATED:
    case EVENT.TASK_DELETED: {
      const task = data.task;
      if (task === null || typeof task !== 'object' || typeof task.id !== 'string') {
        throw corrupt(`task snapshot is missing (seq ${event.seq})`);
      }
      const index = state.taskIndex.has(task.id) ? state.taskIndex.get(task.id) : -1;
      const prior = index >= 0 ? state.tasks[index] : undefined;
      if (event.type === EVENT.TASK_CREATED) {
        if (prior !== undefined) throw corrupt(`task "${task.id}" was created twice (seq ${event.seq})`);
        if (task.revision !== 1) throw corrupt(`task "${task.id}" must begin at revision 1 (seq ${event.seq})`);
      } else {
        if (prior === undefined) throw corrupt(`task "${task.id}" was changed before creation (seq ${event.seq})`);
        if (task.revision !== prior.revision + 1) throw corrupt(`task "${task.id}" revision is not contiguous (seq ${event.seq})`);
      }
      const published = normalizeTaskRecord(task);
      if (index >= 0) state.tasks[index] = published;
      else {
        state.taskIndex.set(task.id, state.tasks.length);
        state.tasks.push(published);
      }
      const match = TASK_ID_PATTERN.exec(task.id);
      if (match !== null) {
        state.nextTaskNumber = Math.max(state.nextTaskNumber, Number(match[1]) + 1);
      }
      return;
    }
    default:
      throw corrupt(`unknown event type "${event.type}" (seq ${event.seq})`);
  }
}

function normalizeTaskRecord(task) {
  const record = {
    id: task.id,
    revision: task.revision,
    subject: task.subject,
    description: task.description,
    status: task.status,
    blockedBy: Array.isArray(task.blockedBy) ? [...task.blockedBy] : [],
    writeScopes: Array.isArray(task.writeScopes) ? [...task.writeScopes] : [],
  };
  if (typeof task.owner === 'string' && task.owner.length > 0) record.owner = task.owner;
  return record;
}

function deriveState(team, events) {
  const state = {
    teamId: team.teamId,
    lead: team.lead,
    limits: team.limits,
    members: [],
    byMemberName: new Map(),
    messages: [],
    messageById: new Map(),
    delivered: new Set(),
    tasks: [],
    taskIndex: new Map(),
    nextTaskNumber: 1,
    seq: 0,
    lastTime: null,
  };
  for (const event of events) applyEvent(state, event);
  return state;
}

function taskById(state, id) {
  const index = state.taskIndex.get(id);
  return index === undefined ? undefined : state.tasks[index];
}

/** 官方 task-view.js:18-20：所有 blocker 都 completed 即为 ready（与自身 status 无关）。 */
function taskReady(state, task) {
  return task.blockedBy.every((id) => taskById(state, id)?.status === 'completed');
}

/** 官方 task-view.js:9-11：两个规范化前缀在路径分量上互相包含即视为重叠。 */
function scopesOverlap(left, right) {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

/**
 * 官方 task-view.js:30-56。注意 `ready` 只有在 pending 时才有意义：
 * in_progress / completed 的任务即使没有 blocker 也返回 false。
 */
function projectTaskView(state, task) {
  const ownerName = task.owner;
  const warnings = new Set();
  for (const other of state.tasks) {
    if (other.id === task.id || other.status !== 'in_progress') continue;
    if (task.writeScopes.some((left) => other.writeScopes.some((right) => scopesOverlap(left, right)))) {
      warnings.add(`write scopes overlap with ${other.id}`);
    }
  }
  return {
    id: task.id,
    revision: task.revision,
    subject: task.subject,
    description: task.description,
    status: task.status,
    ...(ownerName === undefined ? {} : { ownerName }),
    blockedBy: [...task.blockedBy],
    writeScopes: [...task.writeScopes],
    ready: task.status === 'pending' && taskReady(state, task),
    writeScopeWarnings: [...warnings],
  };
}

/* ---- worker 存活判定 ---- */

const SCRIPT_PATH = fileURLToPath(import.meta.url);
/** 内部子命令：spawn_teammate 用它把自己再拉起一次当 worker launcher（见 startWorker 注释）。 */
const WORKER_LAUNCHER_COMMAND = '_worker_launcher';

function workerPidPath(paths, name) {
  return path.join(paths.workers, `${name}.pid`);
}

function workerLogPath(paths, name) {
  return path.join(paths.workers, `${name}.log`);
}

function workerPromptPath(paths, name) {
  return path.join(paths.workers, `${name}.prompt.txt`);
}

function workerLaunchPath(paths, name) {
  return path.join(paths.workers, `${name}.launch.json`);
}

function workerResultPath(paths, name) {
  return path.join(paths.workers, `${name}.launch-result.json`);
}

/** worker 侧投递文件：message/delivered 的镜像，可从 journal 完整重建（不是第二份真源）。 */
function workerInboxPath(paths, name) {
  return path.join(paths.workers, `${name}.inbox.jsonl`);
}

/**
 * 追加投递文件。它是 worker 侧的"本地收件箱镜像"：push（发送时 target 正在 running）与
 * pull（inbox --ack）两条路径都会追加，方便 worker 直接读整个文件。
 * 该文件是**派生快照**：始终可由 journal 重建，不参与任何状态推导；它也不表示已投递——
 * delivered 只由 `inbox --ack` 产生。
 */
function appendInboxMirror(paths, target, messages, delivery) {
  if (target === 'lead' || messages.length === 0) return;
  ensureDir(paths.workers);
  const deliveredAt = new Date().toISOString();
  const lines = messages.map((message) =>
    JSON.stringify({
      messageId: message.messageId,
      from: message.from,
      text: message.text,
      queuedAt: message.queuedAt,
      deliveredAt,
      delivery,
    }),
  );
  fs.appendFileSync(workerInboxPath(paths, target), `${lines.join('\n')}\n`);
}

function readWorkerRecord(paths, name) {
  try {
    const parsed = JSON.parse(fs.readFileSync(workerPidPath(paths, name), 'utf8'));
    if (parsed !== null && typeof parsed === 'object' && Number.isSafeInteger(parsed.pid)) return parsed;
  } catch {
    /* pid 文件缺失或损坏都等价于"无法证明存活" */
  }
  return undefined;
}

/** 信号 0：只做存在性/权限探测。EPERM 说明进程存在但不属于当前用户。 */
function isProcessAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function workerRunning(paths, name) {
  const record = readWorkerRecord(paths, name);
  return record !== undefined && isProcessAlive(record.pid);
}

function clearWorkerRecord(paths, name, pid) {
  const record = readWorkerRecord(paths, name);
  if (record === undefined) return;
  if (pid !== undefined && record.pid !== pid) return;
  try {
    fs.rmSync(workerPidPath(paths, name), { force: true });
  } catch {
    /* 尽力清理 */
  }
}

/* ---- 视图 ---- */

/**
 * 官方 roster.js:118-132 + 449-451：failed / provisioning 直接由 phase 决定，
 * active 由 pid 存活推导 running / inactive。
 */
function memberStatusOf(paths, member) {
  if (member.phase === 'failed') return 'failed';
  if (member.phase === 'active') return workerRunning(paths, member.name) ? 'running' : 'inactive';
  return 'provisioning';
}

function memberView(paths, member) {
  return {
    target: member.name,
    role: 'teammate',
    status: memberStatusOf(paths, member),
    ...(member.description === undefined ? {} : { description: member.description }),
    ...(member.provider === undefined ? {} : { provider: member.provider }),
    ...(member.context === undefined ? {} : { context: member.context }),
    diagnostics: member.error === undefined ? [] : [member.error],
  };
}

/**
 * Lead 行。官方里 Lead 就是持有日志的活 Agent，可用性来自它的 turn 状态；
 * 独立 CLI 进程无法观测那个 turn，所以规则是：【推断】
 *   - 这次调用就是 Lead 自己发起的（--as lead）→ running（确实有一个 Lead turn 在执行）；
 *   - 否则由 AGENT_TEAM_LEAD_RUNNING 环境变量声明，默认 inactive。
 * 由此 teammate 给 lead 的消息默认走 queued，必须由 Lead 用 `inbox --target lead --ack` 取走。
 */
function leadStatusFor(callerName) {
  if (callerName === 'lead') return 'running';
  return envTruthy('AGENT_TEAM_LEAD_RUNNING') ? 'running' : 'inactive';
}

function leadView(callerName) {
  return { target: 'lead', role: 'lead', status: leadStatusFor(callerName), diagnostics: [] };
}

function listMemberViews(state, paths, callerName) {
  return [leadView(callerName), ...state.members.map((member) => memberView(paths, member))];
}

/** wait_agent 的变化指纹：日志 seq 覆盖所有已落盘事件，成员状态覆盖 pid 生死变化。 */
function stateDigest(state, paths) {
  const parts = [`seq:${state.seq}`, `lead:${envTruthy('AGENT_TEAM_LEAD_RUNNING') ? 'running' : 'inactive'}`];
  for (const member of state.members) parts.push(`m:${member.name}:${memberStatusOf(paths, member)}`);
  for (const task of state.tasks) parts.push(`t:${task.id}:${task.revision}:${task.status}:${task.owner ?? '-'}`);
  for (const message of state.messages) parts.push(`q:${message.messageId}:${state.delivered.has(message.messageId) ? 'd' : 'q'}`);
  return parts.join('|');
}

/* ==========================================================================
 * 3. 校验层（逐字对齐官方 validation.js / roster.js / task-board.js）
 * ========================================================================*/

/** 官方 validation.js:10-18。 */
function requiredText(value, field, maxLength) {
  if (typeof value !== 'string') throw new TeamError(`${field} must be non-empty`, TEAM_CODES.INVALID_ARGUMENT);
  const text = value.trim();
  if (text.length === 0) throw new TeamError(`${field} must be non-empty`, TEAM_CODES.INVALID_ARGUMENT);
  if (text.length > maxLength) {
    throw new TeamError(`${field} exceeds ${maxLength} characters`, TEAM_CODES.INVALID_ARGUMENT);
  }
  return text;
}

/** 官方 roster.js:10 + 418-423：lower-kebab-case、≤64 字符、永不为 "lead"。不做 trim。 */
function memberName(value) {
  if (typeof value !== 'string' || !MEMBER_NAME_PATTERN.test(value) || value.length > 64 || value === 'lead') {
    throw new TeamError(
      'teammate name must be lower-kebab-case, at most 64 characters, and not "lead"',
      TEAM_CODES.INVALID_MEMBER_NAME,
    );
  }
  return value;
}

/** 官方 validation.js:24-32。write scope 只是提示，不是锁。 */
function writeScope(value) {
  if (typeof value !== 'string') {
    throw new TeamError(`invalid workspace-relative write scope ${JSON.stringify(value)}`, TEAM_CODES.INVALID_WRITE_SCOPE);
  }
  const normalized = value.replaceAll('\\', '/').replace(/^\.\//u, '').replace(/\/+$/u, '');
  const segments = normalized.split('/');
  if (
    normalized.length === 0 ||
    normalized.startsWith('/') ||
    /^[a-z]:/iu.test(normalized) ||
    segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')
  ) {
    throw new TeamError(`invalid workspace-relative write scope ${JSON.stringify(value)}`, TEAM_CODES.INVALID_WRITE_SCOPE);
  }
  return normalized;
}

/** 官方 task-board.js:214-216。 */
function normalizeWriteScopes(values) {
  return [...new Set(values.map((value) => writeScope(value)))];
}

/**
 * Lead 的**可寻址身份**恒为字面量 `"lead"`：官方 `resolveActiveMember` 也把 `lead` 硬编码
 * （roster.js:18-21），`team.lead`（`init --lead-name`）只是写进 team.json 的 Lead 显示名，
 * **不构成第二个身份别名**。
 *
 * 为什么不让 `team.lead` 也算 Lead 身份（D-4）：那样一旦出现同名 teammate，`--as <该名字>`
 * 就会被 callerMembership 静默当成 Lead、绕过 spawn/interrupt/reassign 的 Lead-only 校验，
 * 同时 `send_message --target <该名字>` 会把队友解析成 Lead（TEAM_SELF_MESSAGE，队友不可寻址）。
 * 现在身份空间无歧义：`lead` = Lead，其余名字只能是 teammate 名，且 teammate 名不允许等于
 * Lead 的显示名（见 cmdSpawnTeammate）。
 */
function isLeadIdentity(name) {
  return name === 'lead';
}

/** 官方 roster.js:18-27。 */
function resolveActiveMember(state, rawName) {
  const name = String(rawName).trim();
  if (name.length === 0) throw new TeamError('active teammate "" not found', TEAM_CODES.MEMBER_NOT_FOUND);
  if (isLeadIdentity(name)) return { name: 'lead', role: 'lead' };
  const member = state.byMemberName.get(name);
  if (member === undefined || member.phase !== 'active') {
    throw new TeamError(`active teammate "${name}" not found`, TEAM_CODES.MEMBER_NOT_FOUND);
  }
  return { name, role: 'teammate', member };
}

/** 官方 roster.js:64-98 的简化：只有活跃成员（或 provisioning 中的成员）才算调用方。 */
function callerMembership(state, asRaw) {
  const name = (asRaw === undefined ? 'lead' : String(asRaw)).trim();
  if (name.length === 0) throw new CliError('--as must be non-empty', 'E_USAGE');
  if (isLeadIdentity(name)) return { name: 'lead', role: 'lead', isLead: true };
  const member = state.byMemberName.get(name);
  if (member === undefined || (member.phase !== 'active' && member.phase !== 'provisioning')) {
    throw new TeamError(`agent "${name}" is not a member of an active Agent Team`, TEAM_CODES.NOT_MEMBER);
  }
  return { name, role: 'teammate', isLead: false, member };
}

function requireLead(membership, message) {
  if (!membership.isLead) throw new TeamError(message, TEAM_CODES.LEAD_REQUIRED);
}

/** 官方 task-board.js:196-212。 */
function dependencies(state, values, self) {
  const seen = new Set();
  const result = [];
  for (const id of values) {
    if (self !== undefined && id === self) {
      throw new TeamError('a team task cannot block itself', TEAM_CODES.TASK_DEPENDENCY_CYCLE);
    }
    if (seen.has(id)) throw new TeamError(`duplicate blocker "${id}"`, TEAM_CODES.INVALID_ARGUMENT);
    const task = taskById(state, id);
    if (task === undefined || task.status === 'deleted') {
      throw new TeamError(`blocker task "${id}" not found`, TEAM_CODES.TASK_NOT_FOUND);
    }
    seen.add(id);
    result.push(id);
  }
  return result;
}

/**
 * 官方 task-graph.js:21-61：把 candidate 代入后校验整张活跃任务图
 * （自依赖 / 重复 blocker / 缺失 blocker / 成环）。
 */
function assertTaskGraph(state, candidate) {
  const tasks = new Map(state.tasks.map((task) => [task.id, task]));
  tasks.set(candidate.id, candidate);
  for (const task of tasks.values()) {
    if (task.status === 'deleted') continue;
    const seen = new Set();
    for (const blockerId of task.blockedBy) {
      if (blockerId === task.id) {
        throw new TeamError(`team task "${task.id}" cannot block itself`, TEAM_CODES.TASK_DEPENDENCY_CYCLE);
      }
      if (seen.has(blockerId)) {
        throw new TeamError(`team task "${task.id}" repeats blocker "${blockerId}"`, TEAM_CODES.INVALID_ARGUMENT);
      }
      const blocker = tasks.get(blockerId);
      if (blocker === undefined || blocker.status === 'deleted') {
        throw new TeamError(`blocker task "${blockerId}" for "${task.id}" is missing or deleted`, TEAM_CODES.TASK_NOT_FOUND);
      }
      seen.add(blockerId);
    }
  }
  const visiting = new Set();
  const visited = new Set();
  const visit = (id) => {
    if (visiting.has(id)) {
      throw new TeamError(`task dependency cycle includes "${id}"`, TEAM_CODES.TASK_DEPENDENCY_CYCLE);
    }
    if (visited.has(id)) return;
    const task = tasks.get(id);
    if (task === undefined || task.status === 'deleted') return;
    visiting.add(id);
    for (const blockerId of task.blockedBy) visit(blockerId);
    visiting.delete(id);
    visited.add(id);
  };
  for (const task of tasks.values()) visit(task.id);
}

/* ==========================================================================
 * 4. worker 层：codex exec 子进程
 * ========================================================================*/

/**
 * 身份前缀逐字取自 tool-agent-team/lib/index.js:276-284（结尾是 `</system-reminder>` + 两个换行，
 * 名字处为 `${args.name.trim()}`）。SDK 把它与被拆开的第一个 user 内容块拼在一起。
 */
function buildWorkerPrompt(name, prompt) {
  const prefix = `<system-reminder>
You are teammate "${name.trim()}".
Your Team Lead is named "lead".
Use list_agents({}) to find your teammates and their names.
To message your Team Lead, use send_message({ target: "lead", message: "..." }).
To message another teammate, use send_message({ target: "<teammate name>", message: "..." }).
</system-reminder>

`;
  return `${prefix}${prompt}`;
}

function isFile(candidate) {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/** 在 PATH 上按 PATHEXT 探测可执行文件（不依赖 where/which 子进程）。 */
function findOnPath(names) {
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter((dir) => dir.trim().length > 0);
  const extensions = process.platform === 'win32'
    ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter((ext) => ext.length > 0)
    : [''];
  for (const dir of dirs) {
    for (const name of names) {
      for (const ext of extensions) {
        const candidate = path.join(dir, `${name}${ext}`);
        if (isFile(candidate)) return candidate;
      }
    }
  }
  return undefined;
}

/** 常见安装位置。%LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\codex.exe 的 hash 目录名不可预测。 */
function codexInstallCandidates() {
  const candidates = [];
  const { LOCALAPPDATA, ProgramFiles } = process.env;
  const ProgramFilesX86 = process.env['ProgramFiles(x86)'];
  if (LOCALAPPDATA !== undefined) {
    const binRoot = path.join(LOCALAPPDATA, 'OpenAI', 'Codex', 'bin');
    try {
      const entries = fs
        .readdirSync(binRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => ({ name: entry.name, mtime: fs.statSync(path.join(binRoot, entry.name)).mtimeMs }))
        .sort((left, right) => right.mtime - left.mtime);
      for (const entry of entries) {
        candidates.push(path.join(binRoot, entry.name, process.platform === 'win32' ? 'codex.exe' : 'codex'));
      }
    } catch {
      /* 目录不存在即跳过 */
    }
  }
  const home = os.homedir();
  candidates.push(path.join(home, '.codex', 'bin', 'codex.exe'));
  candidates.push(path.join(home, '.codex', 'bin', 'codex'));
  candidates.push(path.join(home, '.local', 'bin', 'codex'));
  for (const root of [ProgramFiles, ProgramFilesX86]) {
    if (root !== undefined) candidates.push(path.join(root, 'Codex', 'codex.exe'));
  }
  if (process.platform !== 'win32') {
    candidates.push('/usr/local/bin/codex', '/usr/bin/codex', '/opt/homebrew/bin/codex');
  }
  return candidates;
}

/**
 * 解析 codex 可执行文件。裸写 `codex exec ...` 在本机不可用（codex 不在 PATH），
 * 所以显式探测；找不到就**报明确错误**，绝不静默退回裸 `codex`。
 */
function resolveCodexExecutable() {
  const configured = process.env.CODEX_CLI_PATH;
  if (configured !== undefined && configured.trim().length > 0) {
    const candidate = configured.trim();
    if (!isFile(candidate)) {
      throw new CliError(`CODEX_CLI_PATH points to a missing file: ${candidate}`, 'E_CODEX_NOT_FOUND');
    }
    return candidate;
  }
  const onPath = findOnPath(['codex']);
  if (onPath !== undefined) return onPath;
  for (const candidate of codexInstallCandidates()) {
    if (isFile(candidate)) return candidate;
  }
  throw new CliError(
    'cannot locate the codex CLI: not in --worker-cmd, AGENT_TEAM_WORKER_CMD, CODEX_CLI_PATH, PATH, or the ' +
      'common install locations. Pass an explicit worker command, e.g. ' +
      '--worker-cmd "codex exec --skip-git-repo-check -C <cwd>"',
    'E_CODEX_NOT_FOUND',
  );
}

/**
 * worker 命令优先级：--worker-cmd > AGENT_TEAM_WORKER_CMD > 自动定位的 codex。
 * 返回值是**单个 shell 命令字符串**；prompt（含身份前缀）只从 stdin 送入，
 * 绝不给位置参数——否则 codex exec 会把 stdin 当作追加的 <stdin> 块。
 */
function resolveWorkerCommand(options) {
  const explicit = optionString(options, 'worker-cmd') ?? process.env.AGENT_TEAM_WORKER_CMD;
  if (explicit !== undefined) {
    const text = String(explicit).trim();
    if (text.length === 0) throw new CliError('--worker-cmd must be non-empty', 'E_USAGE');
    return text;
  }
  const executable = resolveCodexExecutable();
  return `"${executable}" exec --skip-git-repo-check -C "${process.cwd()}"`;
}

function waitForExit(child) {
  return new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve({ exited: true, code, signal }));
    child.once('error', (error) => resolve({ exited: true, code: null, signal: null, error: errorMessage(error) }));
  });
}

function waitForExitOrTimeout(child, ms) {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ exited: false });
    }, ms);
    child.once('exit', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exited: true, code, signal });
    });
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exited: true, code: null, signal: null, error: errorMessage(error) });
    });
  });
}

/**
 * 启动 worker。启动成功与否必须**在返回前**判定（官方 spawnAdmitted 在
 * `startContinuable` resolve 之前不会写 `active`），所以后台模式用一段宽限期
 * 观察是否立刻退出：立刻非零退出 → 视为 provisioning 失败。
 *
 * 为什么后台模式不能直接 spawn worker（本机 Windows 实测，三种组合都验过）：
 *   - 直接 spawn 的子进程会在 CLI 进程退出时一起消失（无论 unref）；
 *   - `detached: true` 的进程虽然存活，但它的子孙**拿不到继承的 stdin/stdout/stderr**
 *     （连 shell 自己的重定向都无效），prompt 与日志都到不了 worker；
 *   - 只有"经 cmd.exe 拉起的孙进程"既存活又能拿到句柄。
 * 所以这里让 agent-team.mjs 把自己再拉起一次当 launcher（`_worker_launcher`）：
 *   CLI --(detached 直启, stdio ignore)--> launcher（存活）
 *   launcher --(shell:true, stdio=[promptFile, logFile, logFile])--> worker
 * launcher 的存活期与 worker 完全一致，因此 pid 文件里记它的 pid 就等价于记 worker 的存活；
 * launcher 退出时删除 pid 文件并写下 `launch-result.json`（退出码/启动错误）。
 */
async function startWorker(paths, name, promptText, workerCommand, runSync) {
  ensureDir(paths.workers);
  const promptFile = workerPromptPath(paths, name);
  const logFile = workerLogPath(paths, name);
  const pidFile = workerPidPath(paths, name);
  const resultFile = workerResultPath(paths, name);
  // prompt（含逐字身份前缀）落文件：worker 的 stdin 就是这个文件，
  // 既不依赖句柄继承，也留下可复核的痕迹。
  fs.writeFileSync(promptFile, buildWorkerPrompt(name, promptText));
  fs.rmSync(resultFile, { force: true });

  if (runSync) {
    return startWorkerSync(paths, name, workerCommand, promptFile, logFile);
  }

  const launchFile = workerLaunchPath(paths, name);
  fs.writeFileSync(
    launchFile,
    `${JSON.stringify(
      { command: workerCommand, cwd: process.cwd(), promptFile, logFile, pidFile, resultFile },
      null,
      2,
    )}\n`,
  );

  let launcher;
  try {
    launcher = spawn(process.execPath, [SCRIPT_PATH, WORKER_LAUNCHER_COMMAND, launchFile], {
      shell: false,
      cwd: process.cwd(),
      env: process.env,
      windowsHide: true,
      detached: true,
      stdio: 'ignore',
    });
  } catch (error) {
    return { started: false, error: errorMessage(error) };
  }

  const outcome = await waitForExitOrTimeout(launcher, WORKER_GRACE_MS);
  if (!outcome.exited) {
    // launcher 还活着 => worker 还在跑。unref 让 CLI 立刻可以退出。
    launcher.unref();
    return { started: true, pid: launcher.pid };
  }
  const result = readLauncherResult(resultFile);
  if (result === undefined) {
    return {
      started: false,
      error: `worker launcher exited with code ${outcome.code === null ? 'unknown' : outcome.code} before reporting a result`,
    };
  }
  if (result.spawnError !== undefined || result.exitCode !== 0) {
    return { started: false, error: describeLauncherFailure(result) };
  }
  return { started: true, exitedImmediately: true };
}

/** --run-sync：worker 是前台直接子进程，退出码即结论（仅供测试/一次性 worker）。 */
async function startWorkerSync(paths, name, workerCommand, promptFile, logFile) {
  const logFd = fs.openSync(logFile, 'a');
  let promptFd;
  try {
    promptFd = fs.openSync(promptFile, 'r');
  } catch (error) {
    fs.closeSync(logFd);
    return { started: false, error: errorMessage(error) };
  }
  let child;
  try {
    child = spawn(workerCommand, {
      shell: true,
      cwd: process.cwd(),
      env: process.env,
      windowsHide: true,
      detached: false,
      stdio: [promptFd, logFd, logFd],
    });
  } catch (error) {
    fs.closeSync(promptFd);
    fs.closeSync(logFd);
    return { started: false, error: errorMessage(error) };
  }
  fs.closeSync(promptFd);
  fs.closeSync(logFd);
  // run-sync 期间也要留下 pid 记录：否则并发的 list_agents 会把"还在跑的 provisioning 成员"
  // 当成崩溃遗留物结算成 failed，而 run-sync 结束时又要写 active —— journal 会自相矛盾。
  if (child.pid !== undefined) {
    fs.writeFileSync(
      workerPidPath(paths, name),
      `${JSON.stringify({ pid: child.pid, startedAt: new Date().toISOString(), command: workerCommand, mode: 'run-sync' })}\n`,
    );
  }
  const outcome = await waitForExit(child);
  clearWorkerRecord(paths, name, child.pid);
  return {
    started: outcome.exited && outcome.code === 0 && outcome.error === undefined,
    exitCode: outcome.code,
    signal: outcome.signal,
    error: outcome.error,
  };
}

function readLauncherResult(resultFile) {
  try {
    return JSON.parse(fs.readFileSync(resultFile, 'utf8'));
  } catch {
    return undefined;
  }
}

function describeLauncherFailure(result) {
  if (result.spawnError !== undefined) return result.spawnError;
  const code = result.exitCode === null || result.exitCode === undefined ? 'unknown' : result.exitCode;
  return result.signal ? `worker exited with signal ${result.signal}` : `worker exited with code ${code}`;
}

function describeWorkerFailure(outcome) {
  if (outcome.error !== undefined) return outcome.error;
  const code = outcome.exitCode === null || outcome.exitCode === undefined ? 'unknown' : outcome.exitCode;
  return outcome.signal ? `worker exited with signal ${outcome.signal}` : `worker exited with code ${code}`;
}

/**
 * 内部子命令 `_worker_launcher <optionsFile>`：以"存活孙进程"身份持有 worker，
 * 把 prompt/log 句柄交给它，并用自身 pid 代表 worker 的生命周期。
 * 不读取 store、不打印 stdout（stdio 已被父进程置为 ignore）。
 */
function runWorkerLauncher(optionsFile) {
  let options;
  try {
    options = JSON.parse(fs.readFileSync(optionsFile, 'utf8'));
  } catch (error) {
    process.stderr.write(`worker launcher cannot read ${optionsFile}: ${errorMessage(error)}\n`);
    process.exit(1);
  }
  let logFd;
  let promptFd;
  try {
    logFd = fs.openSync(options.logFile, 'a');
    promptFd = fs.openSync(options.promptFile, 'r');
  } catch (error) {
    try {
      fs.closeSync(logFd);
    } catch {
      /* 未打开 */
    }
    settleWorkerLaunch(options, { spawnError: errorMessage(error) }, 1);
    return;
  }
  fs.writeFileSync(
    options.pidFile,
    `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), command: options.command })}\n`,
  );

  let child;
  try {
    child = spawn(options.command, {
      shell: true,
      cwd: options.cwd,
      env: process.env,
      windowsHide: true,
      detached: false,
      stdio: [promptFd, logFd, logFd],
    });
  } catch (error) {
    fs.closeSync(promptFd);
    fs.closeSync(logFd);
    settleWorkerLaunch(options, { spawnError: errorMessage(error) }, 1);
    return;
  }
  fs.closeSync(promptFd);
  fs.closeSync(logFd);

  // 外部（interrupt_agent）可能直接杀这个进程：带走 worker，别留孤儿。
  const forward = () => {
    try {
      child.kill('SIGTERM');
    } catch {
      /* worker 已经退出 */
    }
  };
  process.on('SIGTERM', forward);
  process.on('SIGINT', forward);

  let settled = false;
  const settle = (result, exitCode) => {
    if (settled) return;
    settled = true;
    settleWorkerLaunch(options, result, exitCode);
  };
  child.on('error', (error) => settle({ spawnError: errorMessage(error) }, 1));
  child.on('exit', (code, signal) => settle({ exitCode: code, signal, workerPid: child.pid }, 0));
}

function settleWorkerLaunch(options, result, exitCode) {
  try {
    fs.writeFileSync(options.resultFile, `${JSON.stringify(result)}\n`);
  } catch {
    /* 结果文件写不进去也不能让 launcher 悬挂 */
  }
  try {
    fs.rmSync(options.pidFile, { force: true });
  } catch {
    /* 尽力清理 */
  }
  process.exit(exitCode);
}

/** interrupt 的存储侧动作：杀掉 worker 进程树（turn 级粒度不可得，见 README）。 */
function stopWorkerProcess(paths, name) {
  const record = readWorkerRecord(paths, name);
  if (record === undefined || !isProcessAlive(record.pid)) return;
  try {
    if (process.platform === 'win32') {
      // launcher -> cmd.exe -> worker：/T 杀整棵子树
      spawnSync('taskkill', ['/PID', String(record.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } else {
      // launcher 以 detached 启动，是独立进程组的组长 → 整组终止
      try {
        process.kill(-record.pid, 'SIGTERM');
      } catch {
        process.kill(record.pid, 'SIGTERM');
      }
    }
  } catch {
    /* 进程已经消失或权限不足：视图层会按 pid 存活重新推导 */
  }
  clearWorkerRecord(paths, name, record.pid);
}

/**
 * 冷恢复：创建中途崩溃（provisioning 已落盘但 worker 没起来）会把成员永久钉在
 * provisioning。读命令在确认"没有存活 worker 且 provisioning 已超过阈值"时补一条
 * member/failed（锁内二次校验 phase，避免与其他进程竞争重复落盘）。
 */
function reconcileStuckProvisioning(store, asName) {
  const stale = readState(store, (state) => {
    // 先用调用方身份把关（TEAM_NOT_MEMBER），再考虑写任何恢复事件
    callerMembership(state, asName);
    return state.members
      .filter((member) => {
        if (member.phase !== 'provisioning') return false;
        if (workerRunning(store.paths, member.name)) return false;
        const age = Date.now() - Date.parse(member.provisionedAt);
        return !Number.isFinite(age) || age > PROVISIONING_STALE_MS;
      })
      .map((member) => member.name);
  });
  if (stale.length === 0) return;
  transact(store, (state, events, paths) => {
    for (const name of stale) {
      const member = state.byMemberName.get(name);
      if (member === undefined || member.phase !== 'provisioning') continue;
      appendEvents(paths, events, [
        {
          type: EVENT.MEMBER_FAILED,
          data: { name, error: 'provisioning did not leave a live worker process' },
        },
      ]);
    }
    return undefined;
  });
}

/* ==========================================================================
 * 5. 命令层
 * ========================================================================*/

function cmdInit(options) {
  const dir = resolveDir(options);
  const paths = storePaths(dir);
  ensureDir(paths.dir);
  ensureDir(paths.workers);
  if (!fs.existsSync(paths.journal)) fs.writeFileSync(paths.journal, '');

  // 参数**先校验**，幂等路径同样校验（D-5）：静默吞掉非法配置比"行为变了一点"更危险。
  // 合法但与既有配置不同的值仍会被忽略（limits/lead 属于不可变配置）。
  // `--lead-name` 与 roster 成员名同规则（`^[a-z0-9]+(?:-[a-z0-9]+)*$`、≤64）：它只是 Lead 的
  // **纯展示标签**（Lead 的可寻址 target 与身份恒为 `lead`），但必须是合法名字，否则会与
  // teammate 名空间产生歧义。违反命名规则属于**领域错误**（与 maxMembers 非正数同类）→
  // TEAM_INVALID_MEMBER_NAME + exit 2；不复用官方那句写死 `not "lead"` 的文案。
  const lead = String(optionString(options, 'lead-name') ?? 'lead').trim();
  if (lead.length === 0 || lead.length > 64 || !MEMBER_NAME_PATTERN.test(lead)) {
    throw new TeamError(
      'Team Lead name must be lower-kebab-case, at most 64 characters',
      TEAM_CODES.INVALID_MEMBER_NAME,
    );
  }
  const limits = {
    maxMembers: positiveLimit(options, 'max-members', 'maxMembers', DEFAULT_LIMITS.maxMembers),
    maxTasks: positiveLimit(options, 'max-tasks', 'maxTasks', DEFAULT_LIMITS.maxTasks),
    maxPendingMessagesPerMember: positiveLimit(
      options,
      'max-pending-per-member',
      'maxPendingMessagesPerMember',
      DEFAULT_LIMITS.maxPendingMessagesPerMember,
    ),
    maxMessageBytes: positiveLimit(options, 'max-message-bytes', 'maxMessageBytes', DEFAULT_LIMITS.maxMessageBytes),
  };

  // init 幂等：已初始化时返回既有团队配置（同一 teamId），不改写 lead/limits。
  if (fs.existsSync(paths.team)) {
    const existing = readTeamFile(paths);
    return { teamId: existing.teamId, lead: existing.lead, limits: existing.limits };
  }

  const team = {
    version: STORE_VERSION,
    teamId: randomUUID(),
    lead,
    createdAt: new Date().toISOString(),
    limits,
  };
  writeFileAtomic(paths.team, `${JSON.stringify(team, null, 2)}\n`);
  return { teamId: team.teamId, lead: team.lead, limits: team.limits };
}

function positiveLimit(options, optionKey, fieldName, fallback) {
  const raw = optionString(options, optionKey);
  const value = raw === undefined ? fallback : Number(raw.trim());
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TeamError(`${fieldName} must be a positive safe integer`, TEAM_CODES.INVALID_CONFIG);
  }
  return value;
}

async function cmdSpawnTeammate(store, options) {
  const name = memberName(requiredOptionText(options, 'name'));
  const description = requiredText(requiredOptionText(options, 'description'), 'description', 200);
  const prompt = readTextOption(options, 'prompt', 'prompt-file', 'prompt');
  const context = String(optionString(options, 'context') ?? 'fresh');
  if (context !== 'fresh' && context !== 'fork') {
    throw new CliError('--context must be fresh or fork', 'E_USAGE');
  }
  const provider = context === 'fork' ? 'codex-exec-fork' : 'codex-exec';
  const workerCommand = resolveWorkerCommand(options);
  if (context === 'fork') {
    // codex exec resume/fork 不接受 -s/--sandbox、-C/--cd、-p/--profile，且 store 无法持有
    // Lead 会话 id；因此这只是一个被记录的标记，worker 实际上仍是 fresh 进程。绝不假装等价。
    process.stderr.write(
      '[agent-team] warning: --context fork only records context="fork"; this store cannot resume Lead history, '
        + 'so the worker still starts as a fresh codex exec process. See scripts/README.md.\n',
    );
  }

  // 1) 先落 provisioning 并 flush（官方 roster.js:241-250：名字由第一条 provisioning 记录永久保留）。
  transact(store, (state, events, paths) => {
    const membership = callerMembership(state, options.as);
    requireLead(membership, 'only the Team Lead can create teammates');
    // D-4：Lead 的名字被 Lead 独占，**在落 member/provisioning 之前**就拒绝（绝不创建同名成员）。
    // 否则该队友既不可寻址（`--target <name>` 会解析成 Lead → TEAM_SELF_MESSAGE），又会让
    // `--as <name>` 静默拿到 Lead 身份、绕过 spawn/interrupt/reassign 的 Lead-only 校验。
    // 默认 `--name lead` 更早一步就被 memberName() 拦成 TEAM_INVALID_MEMBER_NAME（官方行为）。
    if (name === 'lead' || name === state.lead) {
      throw new TeamError(
        `teammate name "${name}" is already used by the Team Lead in this Team`,
        TEAM_CODES.MEMBER_NAME_TAKEN,
      );
    }
    if (state.byMemberName.has(name)) {
      throw new TeamError(`teammate name "${name}" was already used in this Team`, TEAM_CODES.MEMBER_NAME_TAKEN);
    }
    if (state.members.length >= state.limits.maxMembers) {
      throw new TeamError(`Team member limit ${state.limits.maxMembers} reached`, TEAM_CODES.MEMBER_LIMIT);
    }
    appendEvents(paths, events, [
      { type: EVENT.MEMBER_PROVISIONING, data: { name, description, context, provider } },
    ]);
    return undefined;
  });

  // 2) 锁外启动 worker：进程启动可能很慢，绝不能占着全局锁。
  const outcome = await startWorker(store.paths, name, prompt, workerCommand, options['run-sync'] === true);

  // 3) 落终态。失败时记录 durable failed（名字保留），并以 TEAM_PROVISIONING_CONFLICT 退出。
  if (!outcome.started) {
    const detail = describeWorkerFailure(outcome);
    transact(store, (state, events, paths) => {
      const member = state.byMemberName.get(name);
      if (member !== undefined && member.phase === 'provisioning') {
        appendEvents(paths, events, [
          { type: EVENT.MEMBER_FAILED, data: { name, error: `initial prompt was not accepted: ${detail}` } },
        ]);
      }
      return undefined;
    });
    throw new TeamError(
      `teammate "${name}" initial prompt was not durably accepted: ${detail}`,
      TEAM_CODES.PROVISIONING_CONFLICT,
    );
  }

  return transact(store, (state, events, paths) => {
    const member = state.byMemberName.get(name);
    if (member === undefined) throw new TeamError(`provisioned teammate "${name}" disappeared`, TEAM_CODES.PROVISIONING_CONFLICT);
    if (member.phase === 'provisioning') {
      appendEvents(paths, events, [{ type: EVENT.MEMBER_ACTIVE, data: { name } }]);
      return { member: memberView(store.paths, { ...member, phase: 'active' }) };
    }
    return { member: memberView(store.paths, member) };
  });
}

function cmdListAgents(store, options) {
  reconcileStuckProvisioning(store, options.as);
  return readState(store, (state) => {
    const membership = callerMembership(state, options.as);
    return listMemberViews(state, store.paths, membership.isLead ? 'lead' : membership.name);
  });
}

function cmdSendMessage(store, options) {
  const target = requiredOptionText(options, 'target').trim();
  const text = readTextOption(options, 'message', 'message-file', 'message', { allowEmpty: true });

  return transact(store, (state, events, paths) => {
    const membership = callerMembership(state, options.as);
    const resolved = resolveActiveMember(state, target);
    if (resolved.name === membership.name && resolved.role === membership.role) {
      throw new TeamError('a Team member cannot message itself', TEAM_CODES.SELF_MESSAGE);
    }
    const pending = state.messages.filter(
      (message) => message.target === resolved.name && !state.delivered.has(message.messageId),
    );
    if (pending.length >= state.limits.maxPendingMessagesPerMember) {
      throw new TeamError(
        `teammate "${resolved.name}" has ${pending.length} pending messages`,
        TEAM_CODES.MAILBOX_FULL,
      );
    }
    const messageId = `team-message-${randomUUID()}`;
    // 官方 mailbox.js:119：上限按"完整 sender-framed 投递内容"的 UTF-8 字节数计算。
    const framed = [
      { type: 'text', text: `Team message ${messageId} from ${membership.name}:` },
      { type: 'text', text },
    ];
    if (Buffer.byteLength(JSON.stringify(framed), 'utf8') > state.limits.maxMessageBytes) {
      throw new TeamError(`team message exceeds ${state.limits.maxMessageBytes} bytes`, TEAM_CODES.MESSAGE_TOO_LARGE);
    }
    // queued 先落盘：即便随后投递失败也已经持久，调用方绝不能因为 queued 而重发。
    const queuedAt = new Date().toISOString();
    const record = { messageId, from: membership.name, target: resolved.name, text, queuedAt };
    appendEvents(paths, events, [
      {
        type: EVENT.MESSAGE_QUEUED,
        data: record,
      },
    ]);
    const targetStatus =
      resolved.role === 'lead'
        ? leadStatusFor(membership.name)
        : memberStatusOf(paths, resolved.member);
    if (targetStatus !== 'running') return { messageId, status: 'queued' };
    // target 正在跑：投递（写投递文件）并返回 accepted。
    // 这里**故意不落 message/delivered**：官方只在目标会话持久持有该消息身份之后才 markDelivered
    // （agent-team/lib/index.js:945-965：先 flush(target) 再复查 targetRecorded）。
    // Codex 上没有目标侧会话日志可查，唯一可信的目标侧持久证据就是 worker 自己调 `inbox --ack`；
    // 让发送侧替目标宣称已投递，等于用"进程还活着"冒充"消息已被持有"——worker 可能在读到之前
    // 崩溃，那条消息就永久消失了。所以 accepted 只表示"已经交给目标"，消息仍然留在 inbox 里。
    appendInboxMirror(paths, resolved.name, [record], 'push');
    return { messageId, status: 'accepted' };
  });
}

async function cmdWaitAgent(store, options) {
  const timeoutMs = readTimeoutOption(options);
  const snapshot = readState(store, (state) => {
    const membership = callerMembership(state, options.as);
    const statuses = state.members.map((member) => ({
      name: member.name,
      status: memberStatusOf(store.paths, member),
    }));
    return { digest: stateDigest(state, store.paths), caller: membership.name, statuses };
  });

  // 官方"跳过等待的捷径"：没有 running/provisioning 的同伴时立即 noProgress，从不唤醒 inactive 成员。
  const hasActivePeer = snapshot.statuses.some(
    (entry) => entry.name !== snapshot.caller && ACTIVE_WAIT_STATUSES.includes(entry.status),
  );
  if (!hasActivePeer) {
    return { timedOut: false, noProgress: { reason: 'no-active-peer', message: NO_ACTIVE_PEER_MESSAGE } };
  }

  const deadline = Date.now() + timeoutMs;
  let digest = snapshot.digest;
  while (Date.now() < deadline) {
    await sleep(Math.max(1, Math.min(WAIT_POLL_MS, deadline - Date.now())));
    const next = readState(store, (state) => stateDigest(state, store.paths));
    if (next !== digest) return { timedOut: false };
    digest = next;
  }
  return { timedOut: true };
}

function cmdInterruptAgent(store, options) {
  const target = requiredOptionText(options, 'target').trim();
  return readState(store, (state) => {
    const membership = callerMembership(state, options.as);
    requireLead(membership, 'only the Team Lead can interrupt teammates');
    const resolved = resolveActiveMember(state, target);
    if (resolved.role === 'lead') {
      throw new TeamError('the Team Lead cannot interrupt itself', TEAM_CODES.INVALID_TARGET);
    }
    const status = memberStatusOf(store.paths, resolved.member);
    if (status !== 'running') {
      // 官方：没有活 Agent 就直接返回 inactive，不做任何事（也不清 inbox、不释放任务 owner）。
      return { previousStatus: 'inactive' };
    }
    stopWorkerProcess(store.paths, resolved.name);
    return { previousStatus: 'running' };
  });
}

function cmdTaskCreate(store, options) {
  const subject = requiredText(requiredOptionText(options, 'subject'), 'subject', MAX_SUBJECT);
  const description = requiredText(requiredOptionText(options, 'description'), 'description', MAX_DESCRIPTION);
  const blockedBy = splitList(optionString(options, 'blocked-by'));
  const writeScopes = splitList(optionString(options, 'write-scopes'));

  return transact(store, (state, events, paths) => {
    callerMembership(state, options.as);
    const active = state.tasks.filter((task) => task.status !== 'deleted').length;
    if (active >= state.limits.maxTasks) {
      throw new TeamError(`Team task limit ${state.limits.maxTasks} reached`, TEAM_CODES.TASK_LIMIT);
    }
    const id = `task-${state.nextTaskNumber}`;
    if (taskById(state, id) !== undefined) {
      throw new TeamError('Team task id space exhausted', TEAM_CODES.TASK_LIMIT);
    }
    const task = {
      id,
      revision: 1,
      subject,
      description,
      status: 'pending',
      blockedBy: dependencies(state, blockedBy ?? [], undefined),
      writeScopes: normalizeWriteScopes(writeScopes ?? []),
    };
    assertTaskGraph(state, task);
    appendEvents(paths, events, [{ type: EVENT.TASK_CREATED, data: { task } }]);
    return projectTaskView(state, task);
  });
}

function cmdTaskGet(store, options) {
  const taskId = parseTaskIdOption(requiredOptionText(options, 'task-id'));
  return readState(store, (state) => {
    callerMembership(state, options.as);
    const task = taskById(state, taskId);
    if (task === undefined) throw new TeamError(`team task "${taskId}" not found`, TEAM_CODES.TASK_NOT_FOUND);
    return projectTaskView(state, task);
  });
}

function cmdTaskList(store, options) {
  // --status / --ready 属于 schema 级校验，官方在工具 schema 层就会拒绝，放在最前。
  const status = optionString(options, 'status');
  if (status !== undefined && !STATUS_FILTERS.includes(status)) {
    throw new CliError('--status must be pending, in_progress, or completed', 'E_USAGE');
  }
  const owner = optionString(options, 'owner');
  const ready = parseBooleanOption(options, 'ready');

  // 官方顺序（tool-agent-team/lib/index.js:434-441）：先取调用者（listTasks 做成员校验）→ 过滤
  // → 才校验 cursor/limit → 再切片。因此 `--as ghost` 必须先报 TEAM_NOT_MEMBER。
  const views = readState(store, (state) => {
    callerMembership(state, options.as);
    return state.tasks.filter((task) => task.status !== 'deleted').map((task) => projectTaskView(state, task));
  });
  const filtered = views.filter(
    (task) =>
      (status === undefined || task.status === status) &&
      (owner === undefined || (owner === 'unowned' ? task.ownerName === undefined : task.ownerName === owner)) &&
      (ready === undefined || task.ready === ready),
  );

  // 官方 :437-438 抛的是普通 Error（不是 TeamError，也没有 TEAM_* 码）：这里映射为
  // 非 TEAM_ 前缀的专用码 + 退出码 1（见 README「与官方的差异」第 6 条）。
  const cursor = Number(optionString(options, 'cursor') ?? 0);
  const limit = Number(optionString(options, 'limit') ?? 50);
  if (!Number.isSafeInteger(cursor) || cursor < 0) {
    throw new CliError('cursor must be a non-negative safe integer', 'INVALID_CURSOR');
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new CliError('limit must be an integer from 1 through 100', 'INVALID_LIMIT');
  }
  return {
    tasks: filtered.slice(cursor, cursor + limit),
    ...(cursor + limit < filtered.length ? { nextCursor: cursor + limit } : {}),
  };
}

/**
 * 官方 task-board.js:109-185 的 action 矩阵。CAS 与授权顺序刻意照抄：
 * 存在性 → revision → deleted（在 switch 之前，所以重复 delete 也报 TEAM_TASK_DELETED）→ 授权 → 迁移。
 */
function computeNextTask(state, membership, current, action, request) {
  const lead = membership.role === 'lead';
  const owner = current.owner !== undefined && current.owner === membership.name;
  const authorizeOwner = () => {
    if (!lead && !owner) {
      throw new TeamError('task mutation requires its owner or Team Lead', TEAM_CODES.TASK_UNAUTHORIZED);
    }
  };
  const withoutOwner = (task) => {
    const { owner: _owner, ...rest } = task;
    return rest;
  };

  switch (action) {
    case 'claim': {
      if (current.owner !== undefined && current.owner !== membership.name) {
        throw new TeamError(`team task "${current.id}" is owned by another member`, TEAM_CODES.TASK_ALREADY_CLAIMED);
      }
      if (current.status !== 'pending' || !taskReady(state, current)) {
        throw new TeamError(`team task "${current.id}" is not ready to claim`, TEAM_CODES.TASK_BLOCKED);
      }
      return { ...current, status: 'in_progress', owner: membership.name };
    }
    case 'release': {
      authorizeOwner();
      if (current.status !== 'in_progress') {
        throw new TeamError('only an in-progress task can be released', TEAM_CODES.TASK_INVALID_TRANSITION);
      }
      return { ...withoutOwner(current), status: 'pending' };
    }
    case 'edit': {
      authorizeOwner();
      if (request.subject === undefined && request.description === undefined && request.writeScopes === undefined) {
        throw new TeamError('task edit requires subject, description, or write_scopes', TEAM_CODES.INVALID_ARGUMENT);
      }
      const next = { ...current };
      if (request.subject !== undefined) next.subject = requiredText(request.subject, 'subject', MAX_SUBJECT);
      if (request.description !== undefined) {
        next.description = requiredText(request.description, 'description', MAX_DESCRIPTION);
      }
      if (request.writeScopes !== undefined) next.writeScopes = normalizeWriteScopes(request.writeScopes);
      return next;
    }
    case 'set_dependencies': {
      authorizeOwner();
      if (request.blockedBy === undefined) {
        throw new TeamError('set_dependencies requires blocked_by', TEAM_CODES.INVALID_ARGUMENT);
      }
      return { ...current, blockedBy: dependencies(state, request.blockedBy, current.id) };
    }
    case 'complete': {
      authorizeOwner();
      if (current.status !== 'in_progress') {
        throw new TeamError('only an in-progress task can complete', TEAM_CODES.TASK_INVALID_TRANSITION);
      }
      // 官方在 complete 时**保留** ownerId（只有 release/reopen/清空 reassign 才移除）。
      return { ...current, status: 'completed' };
    }
    case 'reopen': {
      authorizeOwner();
      if (current.status !== 'completed') {
        throw new TeamError('only a completed task can reopen', TEAM_CODES.TASK_INVALID_TRANSITION);
      }
      return { ...withoutOwner(current), status: 'pending' };
    }
    case 'reassign': {
      if (!lead) throw new TeamError('only the Team Lead can reassign tasks', TEAM_CODES.LEAD_REQUIRED);
      if (current.status !== 'pending' && current.status !== 'in_progress') {
        throw new TeamError('only a pending or in-progress task can be reassigned', TEAM_CODES.TASK_INVALID_TRANSITION);
      }
      if (request.owner === undefined || request.owner.trim().length === 0) {
        return { ...withoutOwner(current), status: 'pending' };
      }
      if (!taskReady(state, current)) {
        throw new TeamError(`team task "${current.id}" is blocked`, TEAM_CODES.TASK_BLOCKED);
      }
      const assignee = resolveActiveMember(state, request.owner);
      return { ...current, status: 'in_progress', owner: assignee.name };
    }
    case 'delete': {
      authorizeOwner();
      // delete 不检查自身 readiness（官方 :1606-1615 只做授权 + 依赖者检查）。
      const dependent = state.tasks.find(
        (task) => task.status !== 'deleted' && task.id !== current.id && task.blockedBy.includes(current.id),
      );
      if (dependent !== undefined) {
        throw new TeamError(`team task "${current.id}" still blocks "${dependent.id}"`, TEAM_CODES.TASK_HAS_DEPENDENTS);
      }
      return { ...current, status: 'deleted' };
    }
    default:
      // 未知 action 落到 switch default（官方 lib/index.js:1617 同位置）：
      // 此时已经过 存在性 → CAS → deleted 检查，因此报错顺序与官方一致。
      throw new TeamError(`unsupported task action ${String(action)}`, TEAM_CODES.INVALID_ARGUMENT);
  }
}

function cmdTaskUpdate(store, options) {
  const taskId = parseTaskIdOption(requiredOptionText(options, 'task-id'));
  const expectedRevision = parseRequiredInteger(requiredOptionText(options, 'expected-revision'), 'expected-revision');
  // 未知 action **不在这里**校验：官方把它交给 action switch 的 default，因此顺序是
  // 存在性 → revision → deleted → `TEAM_INVALID_ARGUMENT`（见 computeNextTask 的 default 分支）。
  const action = requiredOptionText(options, 'action').trim();
  const request = {
    subject: optionString(options, 'subject'),
    description: optionString(options, 'description'),
    blockedBy: splitList(optionString(options, 'blocked-by')),
    writeScopes: splitList(optionString(options, 'write-scopes')),
    owner: optionString(options, 'owner'),
  };

  return transact(store, (state, events, paths) => {
    const membership = callerMembership(state, options.as);
    const current = taskById(state, taskId);
    if (current === undefined) throw new TeamError(`team task "${taskId}" not found`, TEAM_CODES.TASK_NOT_FOUND);
    // CAS：expectedRevision 必须等于锁内看到的最新 revision，过期即拒绝。
    if (current.revision !== expectedRevision) {
      throw new TeamError(
        `stale team task "${current.id}" revision ${expectedRevision}; current revision is ${current.revision}`,
        TEAM_CODES.TASK_STALE_REVISION,
      );
    }
    if (current.status === 'deleted') {
      throw new TeamError(`team task "${current.id}" is deleted`, TEAM_CODES.TASK_DELETED);
    }
    const next = computeNextTask(state, membership, current, action, request);
    const task = { ...next, revision: current.revision + 1 };
    assertTaskGraph(state, task);
    appendEvents(paths, events, [
      { type: action === 'delete' ? EVENT.TASK_DELETED : EVENT.TASK_UPDATED, data: { task } },
    ]);
    return projectTaskView(state, task);
  });
}

function toInboxEntry(message) {
  return { messageId: message.messageId, from: message.from, text: message.text, queuedAt: message.queuedAt };
}

function cmdInbox(store, options) {
  const target = requiredOptionText(options, 'target').trim();
  const ack = options.ack === true;
  const all = options.all === true;
  const collect = (state) => {
    const membership = callerMembership(state, options.as);
    const resolved = resolveActiveMember(state, target);
    // 非 Lead 只能读自己的 inbox；Lead 可以代收任何成员（会丢消息的成员也能被捞出）。
    if (!membership.isLead && resolved.name !== membership.name) {
      throw new TeamError('only the Team Lead can read another member inbox', TEAM_CODES.LEAD_REQUIRED);
    }
    const addressed = state.messages.filter((message) => message.target === resolved.name);
    const pending = addressed.filter((message) => !state.delivered.has(message.messageId));
    return { resolved, addressed, pending };
  };
  const pick = (collected) => (all ? collected.addressed : collected.pending);

  if (!ack) {
    // 读不改变任何状态：没 ack 的消息会一直留在 inbox 里（不会丢，也不会被重复"产生"新记录）。
    return readState(store, (state) => ({ messages: pick(collect(state)).map(toInboxEntry) }));
  }
  return transact(store, (state, events, paths) => {
    const collected = collect(state);
    // `--ack` 是唯一产生 message/delivered 的路径：只有目标自己确认"我已经拿到这条消息"，
    // 发送侧永远不替目标宣称已投递（见 cmdSendMessage 里的注释）。
    appendEvents(
      paths,
      events,
      collected.pending.map((message) => ({
        type: EVENT.MESSAGE_DELIVERED,
        data: { messageId: message.messageId, target: collected.resolved.name },
      })),
    );
    appendInboxMirror(paths, collected.resolved.name, collected.pending, 'pull');
    return { messages: pick(collected).map(toInboxEntry) };
  });
}

function cmdStatus(store, options) {
  reconcileStuckProvisioning(store, options.as);
  return readState(store, (state) => {
    const membership = callerMembership(state, options.as);
    const views = listMemberViews(state, store.paths, membership.isLead ? 'lead' : membership.name);
    const counts = { running: 0, inactive: 0, provisioning: 0, failed: 0 };
    for (const view of views.slice(1)) counts[view.status] += 1;
    const tasks = { total: 0, pending: 0, in_progress: 0, completed: 0, deleted: 0 };
    for (const task of state.tasks) {
      if (task.status === 'deleted') {
        tasks.deleted += 1;
        continue;
      }
      tasks.total += 1;
      tasks[task.status] += 1;
    }
    return {
      lead: { target: 'lead', status: views[0].status },
      members: {
        total: state.members.length,
        ...counts,
        targets: state.members.map((member) => member.name),
      },
      tasks: { ...tasks, nextTaskNumber: state.nextTaskNumber, limit: state.limits.maxTasks },
    };
  });
}

function cmdJournal(store, options) {
  const raw = optionString(options, 'limit');
  const limit = raw === undefined ? 20 : Number(raw.trim());
  if (!Number.isSafeInteger(limit) || limit < 1) throw new CliError('--limit must be a positive integer', 'E_USAGE');
  const events = readJournalEvents(store.paths.journal);
  return { events: events.slice(Math.max(0, events.length - limit)), total: events.length };
}

/* ==========================================================================
 * 6. CLI 层
 * ========================================================================*/

const COMMANDS = new Set([
  'init',
  'spawn_teammate',
  'list_agents',
  'send_message',
  'wait_agent',
  'interrupt_agent',
  'team_task_create',
  'team_task_list',
  'team_task_get',
  'team_task_update',
  'inbox',
  'status',
  'journal',
]);

const BOOLEAN_FLAGS = new Set(['json', 'ack', 'all', 'run-sync', 'help']);

const USAGE = `agent-team.mjs — 持久化 Agent Teams store（零依赖，Node >= 18）

用法: node agent-team.mjs <command> [options]

全局选项:
  --dir <path>         store 目录（也可用环境变量 AGENT_TEAM_DIR，默认 .agent-team）
  --as <name>          调用方身份，默认 lead
  --json               默认即输出 JSON（保留开关）

工具命令（官方工具名 + 官方 snake_case 参数）:
  init                 --lead-name --max-members --max-tasks --max-pending-per-member --max-message-bytes
  spawn_teammate       --name --description (--prompt | --prompt-file) [--context fresh|fork]
                       [--worker-cmd <cmd>] [--run-sync]
  list_agents          （无参数）→ MEMBER_VIEW[]
  send_message         --target (--message | --message-file)
  wait_agent           [--timeout-ms 10000..3600000]
  interrupt_agent      --target
  team_task_create     --subject --description [--blocked-by a,b] [--write-scopes a,b]
  team_task_list       [--status] [--owner <target>|unowned] [--ready true|false] [--cursor n] [--limit n]
  team_task_get        --task-id
  team_task_update     --task-id --expected-revision --action claim|release|edit|set_dependencies|complete|reopen|reassign|delete
                       [--subject] [--description] [--blocked-by a,b] [--write-scopes a,b] [--owner]

运维命令（脚本自有，官方是领域 API 而非模型工具）:
  inbox                --target [--ack] [--all]（--ack 标记 delivered；--all 读该 target 的全部历史消息）
  status               （无参数）紧凑摘要
  journal              [--limit n] 最近事件行

退出码: 0 成功 | 1 用法/环境错误 | 2 领域错误（stdout: {"error":{"code":"TEAM_...","message":"..."}}）
`;

function normalizeKey(key) {
  return key.replaceAll('_', '-');
}

function parseArgv(argv) {
  const options = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (typeof token !== 'string' || !token.startsWith('--')) {
      options._.push(token);
      continue;
    }
    const equals = token.indexOf('=');
    if (equals >= 0) {
      options[normalizeKey(token.slice(2, equals))] = token.slice(equals + 1);
      continue;
    }
    const key = normalizeKey(token.slice(2));
    const next = argv[index + 1];
    if (BOOLEAN_FLAGS.has(key)) {
      if (next === 'true' || next === 'false') {
        options[key] = next === 'true';
        index += 1;
      } else {
        options[key] = true;
      }
      continue;
    }
    if (next === undefined || (typeof next === 'string' && next.startsWith('--'))) {
      throw new CliError(`option --${key} requires a value`, 'E_USAGE');
    }
    options[key] = next;
    index += 1;
  }
  return options;
}

function optionString(options, key) {
  const value = options[normalizeKey(key)];
  if (value === undefined || value === true) return undefined;
  return String(value);
}

function requiredOptionText(options, key) {
  const value = optionString(options, key);
  if (value === undefined) throw new CliError(`--${normalizeKey(key)} is required`, 'E_USAGE');
  return value;
}

/** --prompt/--message 支持内联值或 @file 形式（--prompt-file / --message-file）。 */
function readTextOption(options, key, fileKey, label, config = {}) {
  const inline = optionString(options, key);
  const file = optionString(options, fileKey);
  if (inline !== undefined && file !== undefined) {
    throw new CliError(`provide either --${key} or --${fileKey}, not both`, 'E_USAGE');
  }
  let text;
  if (file !== undefined) {
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (error) {
      throw new CliError(`cannot read ${file}: ${errorMessage(error)}`, 'E_USAGE');
    }
  } else if (inline !== undefined) {
    text = inline;
  } else {
    throw new CliError(`--${key} or --${fileKey} is required`, 'E_USAGE');
  }
  if (config.allowEmpty !== true && text.trim().length === 0) {
    throw new CliError(`--${label} must be non-empty`, 'E_USAGE');
  }
  return text;
}

function splitList(raw) {
  if (raw === undefined) return undefined;
  const text = String(raw);
  if (text.trim().length === 0) return [];
  return text
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function parseBooleanOption(options, key) {
  const raw = optionString(options, key);
  if (raw === undefined) return undefined;
  const text = raw.trim().toLowerCase();
  if (text === 'true' || text === '1') return true;
  if (text === 'false' || text === '0') return false;
  throw new CliError(`--${key} must be true or false`, 'E_USAGE');
}

function parseRequiredInteger(raw, key) {
  const text = String(raw).trim();
  if (!/^[+-]?\d+$/u.test(text)) throw new CliError(`--${key} must be an integer`, 'E_USAGE');
  const value = Number(text);
  if (!Number.isSafeInteger(value)) throw new CliError(`--${key} must be a safe integer`, 'E_USAGE');
  return value;
}

/** 官方 TeamTaskId 只拒绝"后缀不是安全整数"的形状，其它形状留给 TASK_NOT_FOUND。 */
function parseTaskIdOption(raw) {
  const text = String(raw).trim();
  if (text.length === 0) throw new CliError('--task-id must be non-empty', 'E_USAGE');
  const match = TASK_ID_PATTERN.exec(text);
  if (match !== null && !Number.isSafeInteger(Number(match[1]))) {
    throw new CliError('numeric task id suffix must be a safe integer', 'E_USAGE');
  }
  return text;
}

function readTimeoutOption(options) {
  const raw = optionString(options, 'timeout-ms');
  const value = raw === undefined ? WAIT_DEFAULT_MS : Number(raw.trim());
  if (!Number.isSafeInteger(value) || value < WAIT_MIN_MS || value > WAIT_MAX_MS) {
    throw new TeamError('timeoutMs must be an integer from 10000 through 3600000', TEAM_CODES.INVALID_TIMEOUT);
  }
  return value;
}

function requireCommandStore(options) {
  return openStore(options);
}

async function runCommand(command, options) {
  switch (command) {
    case 'init':
      return cmdInit(options);
    case 'spawn_teammate':
      return await cmdSpawnTeammate(requireCommandStore(options), options);
    case 'list_agents':
      return cmdListAgents(requireCommandStore(options), options);
    case 'send_message':
      return cmdSendMessage(requireCommandStore(options), options);
    case 'wait_agent':
      return await cmdWaitAgent(requireCommandStore(options), options);
    case 'interrupt_agent':
      return cmdInterruptAgent(requireCommandStore(options), options);
    case 'team_task_create':
      return cmdTaskCreate(requireCommandStore(options), options);
    case 'team_task_list':
      return cmdTaskList(requireCommandStore(options), options);
    case 'team_task_get':
      return cmdTaskGet(requireCommandStore(options), options);
    case 'team_task_update':
      return cmdTaskUpdate(requireCommandStore(options), options);
    case 'inbox':
      return cmdInbox(requireCommandStore(options), options);
    case 'status':
      return cmdStatus(requireCommandStore(options), options);
    case 'journal':
      return cmdJournal(requireCommandStore(options), options);
    default:
      throw new CliError(`unknown command "${command}"`, 'E_USAGE');
  }
}

function writeResult(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
  // 安全网：万一还有没 unref 的句柄（例如外部环境注入的），最多 1.5s 后强制退出，避免 CLI 悬挂。
  const force = setTimeout(() => process.exit(process.exitCode ?? 0), 1500);
  force.unref();
}

function report(error) {
  const domain = error instanceof TeamError;
  const code = domain
    ? error.code
    : error instanceof CliError
      ? error.code
      : 'E_INTERNAL';
  writeResult({ error: { code, message: errorMessage(error) } });
  process.exitCode = domain ? 2 : 1;
}

async function main() {
  const argv = process.argv.slice(2);
  // 内部 launcher 入口：spawn_teammate 用 detached 方式把自己再拉起一次（见 startWorker）。
  if (argv[0] === WORKER_LAUNCHER_COMMAND) {
    if (argv.length !== 2) {
      process.stderr.write(`${WORKER_LAUNCHER_COMMAND} requires exactly one options file\n`);
      process.exitCode = 1;
      return;
    }
    runWorkerLauncher(argv[1]);
    return;
  }
  if (argv.length === 0) {
    process.stdout.write(USAGE);
    process.exitCode = 1;
    return;
  }
  if (argv[0] === '--help' || argv[0] === '-h' || argv[0] === 'help') {
    process.stdout.write(USAGE);
    process.exitCode = 0;
    return;
  }
  const command = argv[0];
  let options;
  try {
    options = parseArgv(argv.slice(1));
  } catch (error) {
    report(error);
    return;
  }
  if (options.help === true) {
    process.stdout.write(USAGE);
    process.exitCode = 0;
    return;
  }
  if (options._.length > 0) {
    report(new CliError(`unexpected positional argument "${options._[0]}"`, 'E_USAGE'));
    return;
  }
  if (!COMMANDS.has(command)) {
    report(new CliError(`unknown command "${command}"`, 'E_USAGE'));
    return;
  }
  try {
    const result = await runCommand(command, options);
    writeResult(result);
    process.exitCode = 0;
  } catch (error) {
    report(error);
  }
}

main().catch((error) => {
  report(error);
});
