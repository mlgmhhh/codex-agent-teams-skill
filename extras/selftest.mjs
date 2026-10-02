// 黑盒自测：只用 shell 调用 agent-team.mjs，断言退出码 / JSON / 目录副作用。
// 运行: node selftest.mjs
import { spawnSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const SCRIPT = 'C:\\Users\\UserX\\.codex\\skills\\agent-teams\\scripts\\agent-team.mjs';
const TMP = 'D:\\ai\\agent-teams-verify\\tmp-store-builder';
const FAKE = `${TMP}/fake-worker.mjs`;
const FAIL = `${TMP}/fail-worker.mjs`;

const lines = [];
let pass = 0;
let fail = 0;

function cli(args, env) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    cwd: TMP,
    env: env === undefined ? process.env : { ...process.env, ...env },
  });
  let json;
  try {
    json = JSON.parse((result.stdout ?? '').trim());
  } catch {
    json = undefined;
  }
  return {
    code: result.status,
    stdout: (result.stdout ?? '').trim(),
    stderr: (result.stderr ?? '').trim(),
    json,
    error: result.error,
  };
}

function check(label, condition, detail) {
  const ok = Boolean(condition);
  if (ok) pass += 1;
  else fail += 1;
  lines.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : `  :: ${detail}`}`);
  return ok;
}

function brief(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (text === undefined) return 'undefined';
  return text.length > 240 ? `${text.slice(0, 240)}...` : text;
}

function fresh(name) {
  const dir = path.join(TMP, name);
  fs.rmSync(dir, { recursive: true, force: true });
  return dir;
}

function codeOf(result) {
  return result.json?.error?.code;
}

const workerCmd = (extra = '') => `node ${FAKE} ${extra}`.trim();

// ---------------------------------------------------------------- 主 store
const dir = fresh('store-main');
lines.push(`### store-main = ${dir}`);

let r = cli(['init', '--dir', dir]);
check('init → {teamId,lead,limits}', r.code === 0 && r.json?.lead === 'lead' && typeof r.json?.teamId === 'string' && r.json?.limits?.maxMembers === 8, brief(r.json));
const initJson = r.json;
check('init created journal/workers/team.json', fs.existsSync(path.join(dir, 'journal.jsonl')) && fs.existsSync(path.join(dir, 'workers')) && fs.existsSync(path.join(dir, 'team.json')));
r = cli(['init', '--dir', dir]);
check('init 幂等（第二次同 teamId）', r.code === 0 && r.json?.teamId === initJson.teamId, brief(r.json?.teamId));

// worker-1: 后台常驻（running）
r = cli(['spawn_teammate', '--dir', dir, '--name', 'worker-1', '--description', '常驻假 worker', '--prompt', 'do the task', '--worker-cmd', workerCmd('60000 worker-1'), '--context', 'fork']);
check('spawn_teammate（后台）→ running', r.code === 0 && r.json?.member?.status === 'running' && r.json?.member?.target === 'worker-1', brief(r.json));
check('spawn_teammate 回落的 provider/context', r.json?.member?.provider === 'codex-exec-fork' && r.json?.member?.context === 'fork');

// worker-sync: --run-sync 前台跑完（active 但 pid 已死 → inactive）
r = cli(['spawn_teammate', '--dir', dir, '--name', 'worker-sync', '--description', '同步假 worker', '--prompt', 'sync task', '--worker-cmd', workerCmd('300 worker-sync'), '--run-sync']);
check('spawn_teammate --run-sync → inactive(已退出)', r.code === 0 && r.json?.member?.status === 'inactive', brief(r.json));

r = cli(['list_agents', '--dir', dir]);
const agents = r.json ?? [];
const byTarget = Object.fromEntries(agents.map((a) => [a.target, a]));
check('list_agents 是 MEMBER_VIEW[]（首行 lead）', r.code === 0 && Array.isArray(agents) && agents[0]?.role === 'lead' && agents[0]?.target === 'lead', brief(agents));
check('list_agents worker-1=running, worker-sync=inactive', byTarget['worker-1']?.status === 'running' && byTarget['worker-sync']?.status === 'inactive', brief(agents.map((a) => `${a.target}:${a.status}`)));

// 身份前缀逐字校验（worker 自己打印到 log）
const log = fs.readFileSync(path.join(dir, 'workers', 'worker-1.log'), 'utf8');
check('身份前缀逐字（startsWith 完整前缀）', log.includes('prefix-exact=true'), brief(log.split('\n')[0]));

// ------------------------------------------------------------ mailbox
r = cli(['send_message', '--dir', dir, '--target', 'worker-1', '--message', 'hello running']);
check('send_message → running target = accepted', r.code === 0 && r.json?.status === 'accepted' && /^team-message-/.test(r.json?.messageId ?? ''), brief(r.json));
const acceptedId = r.json?.messageId;

r = cli(['send_message', '--dir', dir, '--target', 'worker-sync', '--message', 'hello inactive']);
check('send_message → inactive target = queued', r.code === 0 && r.json?.status === 'queued', brief(r.json));
const queuedId = r.json?.messageId;

r = cli(['inbox', '--dir', dir, '--target', 'worker-1']);
check('accepted 后 inbox 仍有 1 条（发送侧不替目标宣称已投递）', r.code === 0 && r.json?.messages?.length === 1 && r.json.messages[0].messageId === acceptedId, brief(r.json));
r = cli(['journal', '--dir', dir, '--limit', '200']);
let eventTypes = (r.json?.events ?? []).map((e) => e.type);
check('accepted 之后 journal 里还没有 message/delivered', !eventTypes.includes('message/delivered'), brief([...new Set(eventTypes)]));
r = cli(['inbox', '--dir', dir, '--target', 'worker-1', '--all']);
check('inbox --all 读取该 target 全部历史消息', r.code === 0 && r.json?.messages?.length === 1 && r.json.messages[0].messageId === acceptedId, brief(r.json));
const mirror = fs
  .readFileSync(path.join(dir, 'workers', 'worker-1.inbox.jsonl'), 'utf8')
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line));
check('收件箱镜像 workers/<name>.inbox.jsonl 含 accepted 消息（delivery=push）', mirror.some((m) => m.messageId === acceptedId && m.delivery === 'push'), brief(mirror));
r = cli(['inbox', '--dir', dir, '--target', 'worker-1', '--ack']);
check('inbox --ack 是唯一让消息离开 inbox 的动作', r.code === 0 && r.json?.messages?.length === 1, brief(r.json));
r = cli(['inbox', '--dir', dir, '--target', 'worker-1']);
check('ack 后不再返回该消息', r.code === 0 && r.json?.messages?.length === 0, brief(r.json));
r = cli(['journal', '--dir', dir, '--limit', '200']);
eventTypes = (r.json?.events ?? []).map((e) => e.type);
check('只有 --ack 之后 journal 才出现 message/delivered', eventTypes.includes('message/delivered'), brief(eventTypes.filter((t) => t.startsWith('message'))));

r = cli(['inbox', '--dir', dir, '--target', 'worker-sync']);
check('queued 消息出现在 inbox（queued-minus-delivered）', r.code === 0 && r.json?.messages?.length === 1 && r.json.messages[0].messageId === queuedId && r.json.messages[0].text === 'hello inactive' && r.json.messages[0].from === 'lead', brief(r.json));
r = cli(['inbox', '--dir', dir, '--target', 'worker-sync', '--ack']);
check('inbox --ack 落 delivered 并返回该消息', r.code === 0 && r.json?.messages?.length === 1, brief(r.json));
r = cli(['inbox', '--dir', dir, '--target', 'worker-sync']);
check('inbox --ack 后不重复投递', r.code === 0 && r.json?.messages?.length === 0, brief(r.json));
r = cli(['inbox', '--dir', dir, '--target', 'worker-sync', '--all']);
check('--ack 后 --all 仍可读全量（journal 回放）', r.code === 0 && r.json?.messages?.length === 1, brief(r.json));

// mailbox 权限：worker 不能读 lead 的 inbox
r = cli(['inbox', '--dir', dir, '--as', 'worker-1', '--target', 'lead']);
check('inbox 越权读他人 → TEAM_LEAD_REQUIRED', r.code === 2 && codeOf(r) === 'TEAM_LEAD_REQUIRED', brief(r.json));
// 给自己发消息
r = cli(['send_message', '--dir', dir, '--as', 'worker-1', '--target', 'worker-1', '--message', 'x']);
check('send_message 自消息 → TEAM_SELF_MESSAGE', r.code === 2 && codeOf(r) === 'TEAM_SELF_MESSAGE', brief(r.json));
// 目标不存在
r = cli(['send_message', '--dir', dir, '--target', 'ghost', '--message', 'x']);
check('send_message 未知目标 → TEAM_MEMBER_NOT_FOUND', r.code === 2 && codeOf(r) === 'TEAM_MEMBER_NOT_FOUND', brief(r.json));
// teammate 给 lead 发消息（lead 默认 inactive → queued）
r = cli(['send_message', '--dir', dir, '--as', 'worker-1', '--target', 'lead', '--message', 'from worker']);
check('teammate → lead 默认 queued', r.code === 0 && r.json?.status === 'queued', brief(r.json));
r = cli(['inbox', '--dir', dir, '--target', 'lead', '--ack']);
check('lead 用 inbox --target lead 收走 teammate 消息', r.code === 0 && r.json?.messages?.length === 1 && r.json.messages[0].from === 'worker-1', brief(r.json));

// ------------------------------------------------------------ 任务板
r = cli(['team_task_create', '--dir', dir, '--subject', 'task one', '--description', 'first task', '--write-scopes', 'src', '--blocked-by', '']);
check('team_task_create → pending/revision 1/ready/no ownerName', r.code === 0 && r.json?.status === 'pending' && r.json?.revision === 1 && r.json?.ready === true && !('ownerName' in (r.json ?? {})) && r.json?.id === 'task-1', brief(r.json));
r = cli(['team_task_create', '--dir', dir, '--subject', 'task two', '--description', 'second task', '--blocked-by', 'task-1', '--write-scopes', 'src/lib']);
check('blocked_by 已存在任务 → ready=false', r.code === 0 && r.json?.id === 'task-2' && r.json.ready === false && r.json.blockedBy[0] === 'task-1', brief(r.json));

r = cli(['team_task_list', '--dir', dir]);
check('team_task_list 默认 limit 50、无 nextCursor', r.code === 0 && r.json?.tasks?.length === 2 && !('nextCursor' in (r.json ?? {})), brief(r.json?.tasks?.map((t) => t.id)));
r = cli(['team_task_list', '--dir', dir, '--limit', '1']);
check('team_task_list --limit 1 → nextCursor=1', r.code === 0 && r.json?.tasks?.length === 1 && r.json?.nextCursor === 1, brief(r.json));
r = cli(['team_task_list', '--dir', dir, '--cursor', '1', '--limit', '1']);
check('team_task_list --cursor 1 → 第 2 条且无 nextCursor', r.code === 0 && r.json?.tasks?.[0]?.id === 'task-2' && !('nextCursor' in (r.json ?? {})), brief(r.json));
r = cli(['team_task_list', '--dir', dir, '--status', 'pending', '--ready', 'false']);
check('按 status+ready 过滤', r.code === 0 && r.json?.tasks?.length === 1 && r.json.tasks[0].id === 'task-2', brief(r.json));
r = cli(['team_task_list', '--dir', dir, '--owner', 'unowned']);
check('--owner unowned 过滤', r.code === 0 && r.json?.tasks?.length === 2, brief(r.json?.tasks?.length));
r = cli(['team_task_list', '--dir', dir, '--cursor', '-1']);
check('cursor 非法 → INVALID_CURSOR / exit 1', r.code === 1 && codeOf(r) === 'INVALID_CURSOR', brief(r.json));
r = cli(['team_task_list', '--dir', dir, '--limit', '101']);
check('limit 101 → INVALID_LIMIT / exit 1', r.code === 1 && codeOf(r) === 'INVALID_LIMIT', brief(r.json));

r = cli(['team_task_get', '--dir', dir, '--task-id', 'task-1']);
check('team_task_get', r.code === 0 && r.json?.id === 'task-1' && r.json?.revision === 1, brief(r.json));
r = cli(['team_task_get', '--dir', dir, '--task-id', 'task-99']);
check('team_task_get 不存在 → TEAM_TASK_NOT_FOUND', r.code === 2 && codeOf(r) === 'TEAM_TASK_NOT_FOUND', brief(r.json));

// claim / blocked / CAS
r = cli(['team_task_update', '--dir', dir, '--task-id', 'task-1', '--expected-revision', '1', '--action', 'claim', '--as', 'worker-1']);
check('worker claim task-1 → in_progress/ownerName=worker-1/rev2', r.code === 0 && r.json?.status === 'in_progress' && r.json?.ownerName === 'worker-1' && r.json?.revision === 2 && r.json?.ready === false, brief(r.json));
r = cli(['team_task_update', '--dir', dir, '--task-id', 'task-2', '--expected-revision', '1', '--action', 'claim', '--as', 'worker-1']);
check('claim 未就绪任务 → TEAM_TASK_BLOCKED', r.code === 2 && codeOf(r) === 'TEAM_TASK_BLOCKED', brief(r.json));
r = cli(['team_task_update', '--dir', dir, '--task-id', 'task-1', '--expected-revision', '1', '--action', 'complete', '--as', 'worker-1']);
check('过期 CAS → TEAM_TASK_STALE_REVISION', r.code === 2 && codeOf(r) === 'TEAM_TASK_STALE_REVISION', brief(r.json));
r = cli(['team_task_update', '--dir', dir, '--task-id', 'task-1', '--expected-revision', '2', '--action', 'claim']);
check('lead claim 已被 worker 占用的任务 → TEAM_TASK_ALREADY_CLAIMED', r.code === 2 && codeOf(r) === 'TEAM_TASK_ALREADY_CLAIMED', brief(r.json));
r = cli(['team_task_update', '--dir', dir, '--task-id', 'task-1', '--expected-revision', '2', '--action', 'complete', '--as', 'worker-sync']);
check('非 owner 变更 → TEAM_TASK_UNAUTHORIZED', r.code === 2 && codeOf(r) === 'TEAM_TASK_UNAUTHORIZED', brief(r.json));
r = cli(['team_task_update', '--dir', dir, '--task-id', 'task-1', '--expected-revision', '2', '--action', 'complete', '--as', 'worker-1']);
check('complete → completed/rev3 且保留 ownerName', r.code === 0 && r.json?.status === 'completed' && r.json?.revision === 3 && r.json?.ownerName === 'worker-1', brief(r.json));
r = cli(['team_task_update', '--dir', dir, '--task-id', 'task-2', '--expected-revision', '1', '--action', 'claim', '--as', 'worker-1']);
check('blocker 完成后可 claim（ready 派生）', r.code === 0 && r.json?.status === 'in_progress', brief(r.json));
r = cli(['team_task_update', '--dir', dir, '--task-id', 'task-2', '--expected-revision', '2', '--action', 'release', '--as', 'worker-1']);
check('release → pending 且移除 ownerName', r.code === 0 && r.json?.status === 'pending' && !('ownerName' in (r.json ?? {})), brief(r.json));
r = cli(['team_task_update', '--dir', dir, '--task-id', 'task-2', '--expected-revision', '3', '--action', 'complete']);
check('complete 非 in_progress（lead）→ TEAM_TASK_INVALID_TRANSITION', r.code === 2 && codeOf(r) === 'TEAM_TASK_INVALID_TRANSITION', brief(r.json));
r = cli(['team_task_update', '--dir', dir, '--task-id', 'task-2', '--expected-revision', '3', '--action', 'claim', '--as', 'worker-1']);
check('重新 claim（释放后）', r.code === 0 && r.json?.ownerName === 'worker-1', brief(r.json));
r = cli(['team_task_update', '--dir', dir, '--task-id', 'task-2', '--expected-revision', '4', '--action', 'complete', '--as', 'worker-1']);
check('complete → completed', r.code === 0 && r.json?.status === 'completed', brief(r.json));
r = cli(['team_task_update', '--dir', dir, '--task-id', 'task-2', '--expected-revision', '5', '--action', 'reopen', '--as', 'worker-1']);
check('reopen completed → pending 且无 owner', r.code === 0 && r.json?.status === 'pending' && !('ownerName' in (r.json ?? {})), brief(r.json));
r = cli(['team_task_update', '--dir', dir, '--task-id', 'task-2', '--expected-revision', '6', '--action', 'reopen']);
check('reopen 非 completed → TEAM_TASK_INVALID_TRANSITION', r.code === 2 && codeOf(r) === 'TEAM_TASK_INVALID_TRANSITION', brief(r.json));
r = cli(['team_task_update', '--dir', dir, '--task-id', 'task-2', '--expected-revision', '6', '--action', 'edit', '--subject', 'renamed']);
check('edit', r.code === 0 && r.json?.subject === 'renamed' && r.json?.revision === 7, brief(r.json));
r = cli(['team_task_update', '--dir', dir, '--task-id', 'task-2', '--expected-revision', '7', '--action', 'edit']);
check('edit 未给字段 → TEAM_INVALID_ARGUMENT', r.code === 2 && codeOf(r) === 'TEAM_INVALID_ARGUMENT', brief(r.json));
r = cli(['team_task_update', '--dir', dir, '--task-id', 'task-2', '--expected-revision', '7', '--action', 'set_dependencies']);
check('set_dependencies 未给 blocked_by → TEAM_INVALID_ARGUMENT', r.code === 2 && codeOf(r) === 'TEAM_INVALID_ARGUMENT', brief(r.json));
r = cli(['team_task_update', '--dir', dir, '--task-id', 'task-2', '--expected-revision', '7', '--action', 'frobnicate']);
check('未知 action → TEAM_INVALID_ARGUMENT', r.code === 2 && codeOf(r) === 'TEAM_INVALID_ARGUMENT', brief(r.json));

// lead 的 reassign
r = cli(['team_task_update', '--dir', dir, '--task-id', 'task-2', '--expected-revision', '7', '--action', 'reassign', '--owner', 'worker-1']);
check('reassign --owner → in_progress + ownerName', r.code === 0 && r.json?.ownerName === 'worker-1' && r.json?.status === 'in_progress', brief(r.json));
r = cli(['team_task_update', '--dir', dir, '--task-id', 'task-2', '--expected-revision', '8', '--action', 'reassign', '--owner', '']);
check('reassign --owner "" → 清空 owner 回到 pending', r.code === 0 && r.json?.status === 'pending' && !('ownerName' in (r.json ?? {})), brief(r.json));
r = cli(['team_task_update', '--dir', dir, '--task-id', 'task-2', '--expected-revision', '9', '--action', 'reassign', '--as', 'worker-1', '--owner', 'worker-sync']);
check('非 lead reassign → TEAM_LEAD_REQUIRED', r.code === 2 && codeOf(r) === 'TEAM_LEAD_REQUIRED', brief(r.json));

// DAG：成环 / 自依赖 / 重复 / 缺失
r = cli(['team_task_create', '--dir', dir, '--subject', 't3', '--description', 'third']);
const t3 = r.json?.id;
r = cli(['team_task_create', '--dir', dir, '--subject', 't4', '--description', 'fourth']);
const t4 = r.json?.id;
r = cli(['team_task_update', '--dir', dir, '--task-id', t4, '--expected-revision', '1', '--action', 'set_dependencies', '--blocked-by', t3]);
check('set_dependencies 正常', r.code === 0 && r.json?.blockedBy?.[0] === t3, brief(r.json));
r = cli(['team_task_update', '--dir', dir, '--task-id', t3, '--expected-revision', '1', '--action', 'set_dependencies', '--blocked-by', t4]);
check('成环 → TEAM_TASK_DEPENDENCY_CYCLE', r.code === 2 && codeOf(r) === 'TEAM_TASK_DEPENDENCY_CYCLE', brief(r.json));
r = cli(['team_task_create', '--dir', dir, '--subject', 't5', '--description', 'fifth']);
const t5 = r.json?.id;
r = cli(['team_task_update', '--dir', dir, '--task-id', t5, '--expected-revision', '1', '--action', 'set_dependencies', '--blocked-by', t5]);
check('自依赖 → TEAM_TASK_DEPENDENCY_CYCLE', r.code === 2 && codeOf(r) === 'TEAM_TASK_DEPENDENCY_CYCLE', brief(r.json));
r = cli(['team_task_create', '--dir', dir, '--subject', 't6', '--description', 'sixth', '--blocked-by', `${t3},${t3}`]);
check('重复 blocker → TEAM_INVALID_ARGUMENT', r.code === 2 && codeOf(r) === 'TEAM_INVALID_ARGUMENT', brief(r.json));
r = cli(['team_task_create', '--dir', dir, '--subject', 't6', '--description', 'sixth', '--blocked-by', 'task-999']);
check('缺失 blocker → TEAM_TASK_NOT_FOUND', r.code === 2 && codeOf(r) === 'TEAM_TASK_NOT_FOUND', brief(r.json));

// write scope 规范化 + 重叠警告
r = cli(['team_task_create', '--dir', dir, '--subject', 'ws', '--description', 'ws', '--write-scopes', 'C:/abs']);
check('绝对盘符 write scope → TEAM_INVALID_WRITE_SCOPE', r.code === 2 && codeOf(r) === 'TEAM_INVALID_WRITE_SCOPE', brief(r.json));
r = cli(['team_task_create', '--dir', dir, '--subject', 'ws', '--description', 'ws', '--write-scopes', '../up']);
check('.. write scope → TEAM_INVALID_WRITE_SCOPE', r.code === 2 && codeOf(r) === 'TEAM_INVALID_WRITE_SCOPE', brief(r.json));
r = cli(['team_task_create', '--dir', dir, '--subject', 'ws', '--description', 'ws', '--write-scopes', 'src\\lib\\']);
check('反斜杠+尾斜杠被规范化', r.code === 0 && r.json?.writeScopes?.[0] === 'src/lib', brief(r.json));
const wsId = r.json?.id;
r = cli(['team_task_update', '--dir', dir, '--task-id', wsId, '--expected-revision', '1', '--action', 'claim', '--as', 'worker-sync']);
check('重叠警告：claim 第二个重叠任务', r.code === 0, brief(r.json));
r = cli(['team_task_list', '--dir', dir]);
const warned = (r.json?.tasks ?? []).filter((t) => (t.writeScopeWarnings ?? []).length > 0);
check('writeScopeWarnings 文案与去重（只对 in_progress 重叠）', warned.length >= 1 && warned.some((t) => t.writeScopeWarnings[0].startsWith('write scopes overlap with task-')), brief(warned.map((t) => [t.id, t.writeScopeWarnings])));

// tombstone
r = cli(['team_task_update', '--dir', dir, '--task-id', t3, '--expected-revision', '1', '--action', 'delete']);
check('有依赖者 → TEAM_TASK_HAS_DEPENDENTS', r.code === 2 && codeOf(r) === 'TEAM_TASK_HAS_DEPENDENTS', brief(r.json));
r = cli(['team_task_update', '--dir', dir, '--task-id', t5, '--expected-revision', '1', '--action', 'delete']);
check('delete → status deleted / rev2', r.code === 0 && r.json?.status === 'deleted', brief(r.json));
r = cli(['team_task_list', '--dir', dir]);
check('tombstone 不出现在 list', !(r.json?.tasks ?? []).some((t) => t.id === t5), brief(r.json?.tasks?.map((t) => t.id)));
r = cli(['team_task_get', '--dir', dir, '--task-id', t5]);
check('team_task_get 返回 deleted tombstone', r.code === 0 && r.json?.status === 'deleted', brief(r.json));
r = cli(['team_task_update', '--dir', dir, '--task-id', t5, '--expected-revision', '2', '--action', 'delete']);
check('重复 delete（revision 已更新）→ TEAM_TASK_DELETED（不幂等）', r.code === 2 && codeOf(r) === 'TEAM_TASK_DELETED', brief(r.json));
r = cli(['team_task_update', '--dir', dir, '--task-id', t5, '--expected-revision', '1', '--action', 'delete']);
check('已删除任务 + 过期 revision → 先报 STALE_REVISION', r.code === 2 && codeOf(r) === 'TEAM_TASK_STALE_REVISION', brief(r.json));
r = cli(['team_task_update', '--dir', dir, '--task-id', t5, '--expected-revision', '2', '--action', 'claim']);
check('对已删除任务做其他 action → TEAM_TASK_DELETED', r.code === 2 && codeOf(r) === 'TEAM_TASK_DELETED', brief(r.json));
r = cli(['team_task_create', '--dir', dir, '--subject', 'after tombstone', '--description', 'id 不复用']);
check('task id 不复用（tombstone 之后仍推进）', r.code === 0 && r.json?.id !== t5 && Number(r.json?.id.split('-')[1]) > Number(t5.split('-')[1]), brief(r.json?.id));

// 无效参数
r = cli(['team_task_create', '--dir', dir, '--subject', '   ', '--description', 'x']);
check('空 subject → TEAM_INVALID_ARGUMENT', r.code === 2 && codeOf(r) === 'TEAM_INVALID_ARGUMENT', brief(r.json));
r = cli(['team_task_create', '--dir', dir, '--subject', 'x'.repeat(201), '--description', 'x']);
check('subject 超 200 → TEAM_INVALID_ARGUMENT', r.code === 2 && codeOf(r) === 'TEAM_INVALID_ARGUMENT', brief(r.json));
r = cli(['team_task_create', '--dir', dir, '--subject', 'x', '--description', 'y'.repeat(16385)]);
check('description 超 16384 → TEAM_INVALID_ARGUMENT', r.code === 2 && codeOf(r) === 'TEAM_INVALID_ARGUMENT', brief(r.json));

// 成员名校验/重名/上限
r = cli(['spawn_teammate', '--dir', dir, '--name', 'Bad_Name', '--description', 'd', '--prompt', 'p']);
check('非法成员名 → TEAM_INVALID_MEMBER_NAME', r.code === 2 && codeOf(r) === 'TEAM_INVALID_MEMBER_NAME', brief(r.json));
r = cli(['spawn_teammate', '--dir', dir, '--name', 'lead', '--description', 'd', '--prompt', 'p']);
check('名字等于 lead → TEAM_INVALID_MEMBER_NAME', r.code === 2 && codeOf(r) === 'TEAM_INVALID_MEMBER_NAME', brief(r.json));
r = cli(['spawn_teammate', '--dir', dir, '--name', 'a'.repeat(65), '--description', 'd', '--prompt', 'p']);
check('名字超 64 → TEAM_INVALID_MEMBER_NAME', r.code === 2 && codeOf(r) === 'TEAM_INVALID_MEMBER_NAME', brief(r.json));
r = cli(['spawn_teammate', '--dir', dir, '--name', 'worker-1', '--description', 'd', '--prompt', 'p', '--worker-cmd', workerCmd('10000 worker-1')]);
check('重名 → TEAM_MEMBER_NAME_TAKEN', r.code === 2 && codeOf(r) === 'TEAM_MEMBER_NAME_TAKEN', brief(r.json));
r = cli(['spawn_teammate', '--dir', dir, '--as', 'worker-1', '--name', 'nope', '--description', 'd', '--prompt', 'p']);
check('非 lead spawn → TEAM_LEAD_REQUIRED', r.code === 2 && codeOf(r) === 'TEAM_LEAD_REQUIRED', brief(r.json));
r = cli(['spawn_teammate', '--dir', dir, '--name', 'fail-1', '--description', 'd', '--prompt', 'p', '--worker-cmd', `node ${FAIL}`, '--run-sync']);
check('worker 启动即失败 → TEAM_PROVISIONING_CONFLICT / exit 2', r.code === 2 && codeOf(r) === 'TEAM_PROVISIONING_CONFLICT', brief(r.json));
r = cli(['list_agents', '--dir', dir]);
const failedRow = (r.json ?? []).find((a) => a.target === 'fail-1');
check('失败成员落 failed 且保留名字/diagnostics', failedRow?.status === 'failed' && failedRow.diagnostics.length === 1, brief(failedRow));
r = cli(['spawn_teammate', '--dir', dir, '--name', 'fail-1', '--description', 'd', '--prompt', 'p', '--worker-cmd', workerCmd('1000 fail-1')]);
check('失败名字不可复用 → TEAM_MEMBER_NAME_TAKEN', r.code === 2 && codeOf(r) === 'TEAM_MEMBER_NAME_TAKEN', brief(r.json));

// interrupt + wait_agent
r = cli(['interrupt_agent', '--dir', dir, '--target', 'lead']);
check('interrupt lead → TEAM_INVALID_TARGET', r.code === 2 && codeOf(r) === 'TEAM_INVALID_TARGET', brief(r.json));
r = cli(['interrupt_agent', '--dir', dir, '--target', 'ghost']);
check('interrupt 未知目标 → TEAM_MEMBER_NOT_FOUND', r.code === 2 && codeOf(r) === 'TEAM_MEMBER_NOT_FOUND', brief(r.json));
r = cli(['interrupt_agent', '--dir', dir, '--as', 'worker-1', '--target', 'worker-sync']);
check('非 lead interrupt → TEAM_LEAD_REQUIRED', r.code === 2 && codeOf(r) === 'TEAM_LEAD_REQUIRED', brief(r.json));
r = cli(['interrupt_agent', '--dir', dir, '--target', 'worker-1']);
check('interrupt running worker → previousStatus=running', r.code === 0 && r.json?.previousStatus === 'running', brief(r.json));
r = cli(['list_agents', '--dir', dir]);
check('interrupt 后 worker-1 → inactive', (r.json ?? []).find((a) => a.target === 'worker-1')?.status === 'inactive', brief(r.json?.map((a) => `${a.target}:${a.status}`)));

r = cli(['wait_agent', '--dir', dir, '--timeout-ms', '10000']);
check('wait_agent 无活跃同伴 → noProgress/no-active-peer', r.code === 0 && r.json?.timedOut === false && r.json?.noProgress?.reason === 'no-active-peer', brief(r.json));
r = cli(['wait_agent', '--dir', dir, '--timeout-ms', '5000']);
check('timeout-ms 越界 → TEAM_INVALID_TIMEOUT', r.code === 2 && codeOf(r) === 'TEAM_INVALID_TIMEOUT', brief(r.json));
r = cli(['spawn_teammate', '--dir', dir, '--name', 'waiter', '--description', 'd', '--prompt', 'p', '--worker-cmd', workerCmd('30000 waiter')]);
check('spawn waiter（用于 wait_agent 的 timedOut 路径）', r.code === 0 && r.json?.member?.status === 'running', brief(r.json));
const t0 = Date.now();
r = cli(['wait_agent', '--dir', dir, '--timeout-ms', '10000']);
check('wait_agent 有活跃同伴且无变化 → timedOut=true（约 10s）', r.code === 0 && r.json?.timedOut === true, `elapsed=${Date.now() - t0}ms ${brief(r.json)}`);
// 有变化路径：后台 spawn 一个会在 ~1.5s 后退出的 worker，wait 期间日志出现 delivered
const sent = cli(['send_message', '--dir', dir, '--target', 'worker-sync', '--message', 'wake']);
check('wait 前造一次 pending 消息', sent.code === 0 && sent.json?.status === 'queued', brief(sent.json));
const t1 = Date.now();
r = cli(['wait_agent', '--dir', dir, '--timeout-ms', '10000'], { AGENT_TEAM_LEAD_RUNNING: '' });
check('wait_agent 有活跃同伴 → 变化/超时二选一（不报错）', r.code === 0 && typeof r.json?.timedOut === 'boolean', `elapsed=${Date.now() - t1}ms ${brief(r.json)}`);
cli(['interrupt_agent', '--dir', dir, '--target', 'waiter']);

// 变化路径：后台起一个 2.5s 后自然退出的 worker，wait_agent 应观察到 running → inactive
r = cli(['spawn_teammate', '--dir', dir, '--name', 'shortlived', '--description', 'd', '--prompt', 'p', '--worker-cmd', workerCmd('2500 shortlived')]);
check('spawn shortlived（2.5s 后自然退出）→ running', r.code === 0 && r.json?.member?.status === 'running', brief(r.json));
const t2 = Date.now();
r = cli(['wait_agent', '--dir', dir, '--timeout-ms', '10000']);
check('wait_agent 观察到同伴退出 → timedOut=false', r.code === 0 && r.json?.timedOut === false, `elapsed=${Date.now() - t2}ms ${brief(r.json)}`);
r = cli(['list_agents', '--dir', dir]);
check('短命 worker 退出后 → inactive', (r.json ?? []).find((a) => a.target === 'shortlived')?.status === 'inactive', brief(r.json?.map((a) => `${a.target}:${a.status}`)));

// -------------------------------------------------- 并行 CAS（真并发）
const dirCas = fresh('store-cas');
cli(['init', '--dir', dirCas]);
cli(['team_task_create', '--dir', dirCas, '--subject', 'cas', '--description', 'cas']);
const casResults = await Promise.all(
  [0, 1, 2, 3, 4].map(
    () =>
      new Promise((resolve) => {
        const child = spawn(process.execPath, [SCRIPT, 'team_task_update', '--dir', dirCas, '--task-id', 'task-1', '--expected-revision', '1', '--action', 'claim', '--as', 'lead'], { cwd: TMP });
        let out = '';
        child.stdout.on('data', (d) => {
          out += d;
        });
        child.on('exit', (code) => {
          let parsed;
          try {
            parsed = JSON.parse(out.trim());
          } catch {
            parsed = undefined;
          }
          resolve({ code, code: code, errorCode: parsed?.error?.code, status: parsed?.status });
        });
      }),
  ),
);
const okCount = casResults.filter((x) => x.status === 'in_progress').length;
const staleCount = casResults.filter((x) => x.errorCode === 'TEAM_TASK_STALE_REVISION').length;
check('5 个并发 CAS：恰好 1 个成功、其余 STALE_REVISION', okCount === 1 && staleCount === 4, brief(casResults.map((x) => x.status ?? x.errorCode)));
const casFinal = cli(['team_task_get', '--dir', dirCas, '--task-id', 'task-1']);
check('并发后 revision 只前进一次（=2）', casFinal.json?.revision === 2, brief(casFinal.json?.revision));

// --------------------------- run-sync 与"冷恢复"的竞争（journal 必须保持自洽）
const dirRace = fresh('store-race');
cli(['init', '--dir', dirRace]);
const raceSpawn = spawn(
  process.execPath,
  [SCRIPT, 'spawn_teammate', '--dir', dirRace, '--name', 'racer', '--description', 'd', '--prompt', 'p', '--worker-cmd', workerCmd('5000 racer'), '--run-sync'],
  { cwd: TMP },
);
let raceStdout = '';
raceSpawn.stdout.on('data', (d) => {
  raceStdout += d;
});
await new Promise((resolve) => setTimeout(resolve, 3600)); // 超过 PROVISIONING_STALE_MS(3000)
r = cli(['list_agents', '--dir', dirRace]);
check('run-sync 进行中：并发 list_agents 不把在跑的成员误判为 failed', (r.json ?? []).find((a) => a.target === 'racer')?.status === 'provisioning', brief(r.json?.map((a) => `${a.target}:${a.status}`)));
r = cli(['journal', '--dir', dirRace, '--limit', '20']);
check('竞争期没有落下 member/failed（journal 自洽）', !(r.json?.events ?? []).some((e) => e.type === 'member/failed'), brief((r.json?.events ?? []).map((e) => e.type)));
await new Promise((resolve) => raceSpawn.on('exit', resolve));
const raceResult = JSON.parse(raceStdout.trim());
check('run-sync 结束后成员为 active（报告 inactive）', raceResult?.member?.status === 'inactive', brief(raceResult?.member));
r = cli(['list_agents', '--dir', dirRace]);
check('竞争后 journal 仍可回放（成员 active）', r.code === 0 && (r.json ?? []).find((a) => a.target === 'racer')?.status === 'inactive', brief(r.json?.map((a) => `${a.target}:${a.status}`)));

// -------------------------------------------------- 上限
const dirLimits = fresh('store-limits');
r = cli(['init', '--dir', dirLimits, '--max-members', '1', '--max-tasks', '1', '--max-pending-per-member', '1', '--max-message-bytes', '4096']);
check('init 自定义上限', r.code === 0 && r.json?.limits?.maxMembers === 1 && r.json?.limits?.maxMessageBytes === 4096, brief(r.json?.limits));
r = cli(['spawn_teammate', '--dir', dirLimits, '--name', 'only-one', '--description', 'd', '--prompt', 'p', '--worker-cmd', workerCmd('300 only-one'), '--run-sync']);
check('spawn 第一个成员', r.code === 0, brief(r.json?.member?.status));
r = cli(['spawn_teammate', '--dir', dirLimits, '--name', 'too-many', '--description', 'd', '--prompt', 'p', '--worker-cmd', workerCmd('300 too-many'), '--run-sync']);
check('成员上限 → TEAM_MEMBER_LIMIT', r.code === 2 && codeOf(r) === 'TEAM_MEMBER_LIMIT', brief(r.json));
r = cli(['team_task_create', '--dir', dirLimits, '--subject', 'a', '--description', 'a']);
check('创建第一个任务', r.code === 0 && r.json?.id === 'task-1', brief(r.json?.id));
r = cli(['team_task_create', '--dir', dirLimits, '--subject', 'b', '--description', 'b']);
check('任务上限 → TEAM_TASK_LIMIT', r.code === 2 && codeOf(r) === 'TEAM_TASK_LIMIT', brief(r.json));
r = cli(['send_message', '--dir', dirLimits, '--target', 'only-one', '--message', 'm1']);
check('send #1 到 inactive 成员 → queued', r.code === 0 && r.json?.status === 'queued', brief(r.json));
r = cli(['send_message', '--dir', dirLimits, '--target', 'only-one', '--message', 'm2']);
check('pending 达上限 → TEAM_MAILBOX_FULL', r.code === 2 && codeOf(r) === 'TEAM_MAILBOX_FULL', brief(r.json));
const dirBig = fresh('store-bigmsg');
cli(['init', '--dir', dirBig, '--max-message-bytes', '200']);
cli(['spawn_teammate', '--dir', dirBig, '--name', 'm', '--description', 'd', '--prompt', 'p', '--worker-cmd', workerCmd('300 m'), '--run-sync']);
r = cli(['send_message', '--dir', dirBig, '--target', 'm', '--message', 'x'.repeat(200)]);
check('消息超 maxMessageBytes → TEAM_MESSAGE_TOO_LARGE', r.code === 2 && codeOf(r) === 'TEAM_MESSAGE_TOO_LARGE', brief(r.json));
r = cli(['send_message', '--dir', dirBig, '--target', 'm', '--message', 'short']);
check('短消息在同一上限下通过（计量含 sender 前缀）', r.code === 0, brief(r.json));
r = cli(['init', '--dir', fresh('store-badcfg'), '--max-members', '0']);
check('max-members 0 → TEAM_INVALID_CONFIG', r.code === 2 && codeOf(r) === 'TEAM_INVALID_CONFIG', brief(r.json));

// -------------------------------------------------- 权限 / 用法 / 锁 / 运维命令
r = cli(['team_task_list', '--dir', dir, '--as', 'ghost']);
check('未知调用方 → TEAM_NOT_MEMBER', r.code === 2 && codeOf(r) === 'TEAM_NOT_MEMBER', brief(r.json));
r = cli(['list_agents', '--dir', fresh('store-absent')]);
check('未初始化 → E_NOT_INITIALIZED / exit 1', r.code === 1 && codeOf(r) === 'E_NOT_INITIALIZED', brief(r.json));
r = cli(['bogus_command', '--dir', dir]);
check('未知子命令 → E_USAGE / exit 1', r.code === 1 && codeOf(r) === 'E_USAGE', brief(r.json));
r = cli(['spawn_teammate', '--dir', dir, '--description', 'd', '--prompt', 'p']);
check('缺 --name → E_USAGE / exit 1', r.code === 1 && codeOf(r) === 'E_USAGE', brief(r.json));
r = cli([], undefined);
check('无命令 → exit 1 + usage', r.code === 1 && r.stdout.includes('用法'), brief(r.stdout.split('\n')[0]));

// 陈旧锁回收
const dirLock = fresh('store-lock');
cli(['init', '--dir', dirLock]);
fs.mkdirSync(path.join(dirLock, 'lock'), { recursive: true });
const past = new Date(Date.now() - 120_000);
fs.utimesSync(path.join(dirLock, 'lock'), past, past);
r = cli(['team_task_create', '--dir', dirLock, '--subject', 'locked', '--description', 'locked']);
check('陈旧锁按 mtime 回收后写入成功', r.code === 0 && r.json?.id === 'task-1', brief(r.json));
// 锁超时
fs.mkdirSync(path.join(dirLock, 'lock'), { recursive: true });
r = cli(['team_task_create', '--dir', dirLock, '--subject', 'x', '--description', 'x'], { AGENT_TEAM_LOCK_TIMEOUT_MS: '400', AGENT_TEAM_LOCK_STALE_MS: '600000' });
check('新鲜锁 + 短超时 → E_LOCK_TIMEOUT / exit 1', r.code === 1 && codeOf(r) === 'E_LOCK_TIMEOUT', brief(r.json));
fs.rmSync(path.join(dirLock, 'lock'), { recursive: true, force: true });

// 冷恢复：伪造一个 provisioning 成员（无 pid），list_agents 应把它结算成 failed
const dirRecover = fresh('store-recover');
cli(['init', '--dir', dirRecover]);
const staleEvent = { seq: 1, time: new Date(Date.now() - 60_000).toISOString(), type: 'member/provisioning', data: { name: 'ghost-worker', description: 'd', context: 'fresh', provider: 'codex-exec' } };
fs.appendFileSync(path.join(dirRecover, 'journal.jsonl'), `${JSON.stringify(staleEvent)}\n`);
r = cli(['list_agents', '--dir', dirRecover]);
check('冷恢复：遗留 provisioning → failed', (r.json ?? []).find((a) => a.target === 'ghost-worker')?.status === 'failed', brief(r.json));

// 运维命令
r = cli(['status', '--dir', dir]);
check('status 摘要形状', r.code === 0 && r.json?.lead?.target === 'lead' && typeof r.json?.members?.total === 'number' && typeof r.json?.tasks?.total === 'number', brief(r.json));
r = cli(['journal', '--dir', dir, '--limit', '3']);
check('journal --limit 3', r.code === 0 && r.json?.events?.length === 3 && r.json.total >= 3, brief(r.json?.total));
r = cli(['journal', '--dir', dir, '--limit', '0']);
check('journal --limit 0 → E_USAGE / exit 1', r.code === 1 && codeOf(r) === 'E_USAGE', brief(r.json));
r = cli(['--help']);
check('--help → exit 0 + usage', r.code === 0 && r.stdout.includes('spawn_teammate'));

// -------------------------------------------------- codex 可执行文件解析
const dirCodex = fresh('store-codex');
cli(['init', '--dir', dirCodex]);
r = cli(['spawn_teammate', '--dir', dirCodex, '--name', 'c1', '--description', 'd', '--prompt', 'p'], { CODEX_CLI_PATH: 'D:/definitely/not/here/codex.exe' });
check('CODEX_CLI_PATH 指向缺失文件 → E_CODEX_NOT_FOUND / exit 1', r.code === 1 && codeOf(r) === 'E_CODEX_NOT_FOUND', brief(r.json));
r = cli(['spawn_teammate', '--dir', dirCodex, '--name', 'c2', '--description', 'd', '--prompt', 'p']);
const launch = JSON.parse(fs.readFileSync(path.join(dirCodex, 'workers', 'c2.launch.json'), 'utf8'));
check('未给 --worker-cmd 时自动定位 codex（launch.json 含 codex 可执行文件）', /codex(\.exe)?"/i.test(launch.command) || /codex(\.exe)?\s/i.test(launch.command), brief(launch.command));
check('默认 worker 命令含 exec 与 -C <cwd>', launch.command.includes(' exec ') && launch.command.includes('-C '), brief(launch.command));
check('prompt 文件存在且含逐字身份前缀', fs.readFileSync(path.join(dirCodex, 'workers', 'c2.prompt.txt'), 'utf8').startsWith('<system-reminder>\nYou are teammate "c2".'));
r = cli(['interrupt_agent', '--dir', dirCodex, '--target', 'c2']);
check('清理：interrupt 自动定位出来的 codex worker', r.code === 0, brief(r.json));

// ============================================================================
// task-7 回归：verifier 缺陷 D-4（lead 名遮蔽）/ D-5（init 幂等吞非法 limits）/ D-6（两处顺序）
// ============================================================================
const dirFix = fresh('store-fix-d4');
r = cli(['init', '--dir', dirFix, '--lead-name', 'Bad_Name']);
check('D-4① init --lead-name 非法形态 → TEAM_INVALID_MEMBER_NAME exit 2（领域错误通道）', r.code === 2 && codeOf(r) === 'TEAM_INVALID_MEMBER_NAME', brief(r.json));
r = cli(['init', '--dir', dirFix, '--lead-name', 'alice']);
check('D-4① init --lead-name alice（合法形态）成功', r.code === 0 && r.json?.lead === 'alice', brief(r.json));
r = cli(['spawn_teammate', '--dir', dirFix, '--name', 'alice', '--description', 'collide', '--prompt', 'p', '--run-sync', '--worker-cmd', workerCmd('100 alice')]);
check('D-4② 与 Lead 同名的成员被拒 → TEAM_MEMBER_NAME_TAKEN exit 2', r.code === 2 && codeOf(r) === 'TEAM_MEMBER_NAME_TAKEN', brief(r.json));
r = cli(['journal', '--dir', dirFix, '--limit', '10']);
check('D-4② 被拒时不落任何 member/* 事件（未创建同名成员）', !(r.json?.events ?? []).some((e) => e.type.startsWith('member/')), brief((r.json?.events ?? []).map((e) => e.type)));
r = cli(['list_agents', '--dir', dirFix]);
check('D-4② roster 只有 lead 一行（无同名 shadow）', (r.json ?? []).length === 1 && r.json[0].target === 'lead', brief(r.json));
// lead 显示名为 alice 时，普通 teammate 仍必须可建、可寻址、且只是 teammate（不是 Lead）
r = cli(['spawn_teammate', '--dir', dirFix, '--name', 'bob', '--description', 'd', '--prompt', 'p', '--run-sync', '--worker-cmd', workerCmd('100 bob')]);
check('D-4 补充：lead 显示名为 alice 时普通 teammate 仍可创建', r.code === 0 && r.json?.member?.target === 'bob', brief(r.json));
r = cli(['send_message', '--dir', dirFix, '--target', 'bob', '--message', 'hi bob']);
check('D-4 补充：原 teammate 可寻址（不会被解析成 Lead）', r.code === 0 && ['accepted', 'queued'].includes(r.json?.status), brief(r.json));
r = cli(['spawn_teammate', '--dir', dirFix, '--as', 'bob', '--name', 'carol', '--description', 'd', '--prompt', 'p']);
check('D-4 补充：--as bob 是 teammate 身份 → TEAM_LEAD_REQUIRED', r.code === 2 && codeOf(r) === 'TEAM_LEAD_REQUIRED', brief(r.json));
// 已存在的 teammate 走另两条 Lead-only 路径也必须失败（身份 → 存在性 → CAS → deleted → 授权）
r = cli(['team_task_create', '--dir', dirFix, '--subject', 'd4', '--description', 'd4']);
check('D-4 补充：为 reassign 断言准备一个任务', r.code === 0 && r.json?.id === 'task-1', brief(r.json?.id));
r = cli(['interrupt_agent', '--dir', dirFix, '--as', 'bob', '--target', 'lead']);
check('D-4③ 已存在 teammate 调 interrupt → TEAM_LEAD_REQUIRED（不是 Lead）', r.code === 2 && codeOf(r) === 'TEAM_LEAD_REQUIRED', brief(r.json));
r = cli(['team_task_update', '--dir', dirFix, '--as', 'bob', '--task-id', 'task-1', '--expected-revision', '1', '--action', 'reassign', '--owner', 'lead']);
check('D-4③ 已存在 teammate 调 reassign → TEAM_LEAD_REQUIRED（不是 Lead）', r.code === 2 && codeOf(r) === 'TEAM_LEAD_REQUIRED', brief(r.json));
// D-4 的三条 Lead-only 路径都不允许被 --as <lead 显示名> 冒充
r = cli(['spawn_teammate', '--dir', dirFix, '--as', 'alice', '--name', 'bob', '--description', 'd', '--prompt', 'p', '--run-sync', '--worker-cmd', workerCmd('100 bob')]);
check('D-4③ spawn_teammate --as <lead 名> 不再是 Lead → TEAM_NOT_MEMBER', r.code === 2 && codeOf(r) === 'TEAM_NOT_MEMBER', brief(r.json));
r = cli(['interrupt_agent', '--dir', dirFix, '--as', 'alice', '--target', 'lead']);
check('D-4③ interrupt_agent --as <lead 名> → TEAM_NOT_MEMBER', r.code === 2 && codeOf(r) === 'TEAM_NOT_MEMBER', brief(r.json));
r = cli(['team_task_update', '--dir', dirFix, '--as', 'alice', '--task-id', 'task-1', '--expected-revision', '1', '--action', 'reassign', '--owner', 'lead']);
check('D-4③ reassign --as <lead 名> → TEAM_NOT_MEMBER（Lead-only 校验不可绕过）', r.code === 2 && codeOf(r) === 'TEAM_NOT_MEMBER', brief(r.json));
r = cli(['send_message', '--dir', dirFix, '--as', 'alice', '--target', 'lead', '--message', 'x']);
check('D-4③ send_message --as <lead 名> → TEAM_NOT_MEMBER', r.code === 2 && codeOf(r) === 'TEAM_NOT_MEMBER', brief(r.json));
// 默认配置下官方行为不变
r = cli(['spawn_teammate', '--dir', dir, '--name', 'lead', '--description', 'd', '--prompt', 'p']);
check('D-4 默认配置 --name lead 仍是 TEAM_INVALID_MEMBER_NAME（官方行为）', r.code === 2 && codeOf(r) === 'TEAM_INVALID_MEMBER_NAME', brief(r.json));
// D-4③ 遗留/手写 journal 里的同名成员必须报错而不是静默解析
const dirLegacy = fresh('store-fix-d4-legacy');
cli(['init', '--dir', dirLegacy, '--lead-name', 'alice']);
fs.appendFileSync(
  path.join(dirLegacy, 'journal.jsonl'),
  `${JSON.stringify({ seq: 1, time: new Date().toISOString(), type: 'member/provisioning', data: { name: 'alice', description: 'legacy', context: 'fresh', provider: 'codex-exec' } })}\n`,
);
r = cli(['list_agents', '--dir', dirLegacy]);
check('D-4③ journal 中与 Lead 同名的成员 → E_JOURNAL_CORRUPT / exit 1（不静默解析）', r.code === 1 && codeOf(r) === 'E_JOURNAL_CORRUPT', brief(r.json));

// D-5：init 幂等路径也要校验参数
const dirFix5 = fresh('store-fix-d5');
cli(['init', '--dir', dirFix5]);
r = cli(['init', '--dir', dirFix5, '--max-members', '0']);
check('D-5 幂等路径仍校验 limits → TEAM_INVALID_CONFIG exit 2', r.code === 2 && codeOf(r) === 'TEAM_INVALID_CONFIG', brief(r.json));
r = cli(['init', '--dir', dirFix5, '--max-members', '16']);
check('D-5 幂等路径合法新参数被忽略（同 teamId、既有 limits 不变）', r.code === 0 && r.json?.limits?.maxMembers === 8, brief(r.json));
r = cli(['init', '--dir', dirFix5, '--lead-name', 'Bad_Name']);
check('D-5 幂等路径也校验 --lead-name 命名规则 → TEAM_INVALID_MEMBER_NAME exit 2', r.code === 2 && codeOf(r) === 'TEAM_INVALID_MEMBER_NAME', brief(r.json));

// D-6①：未知 action 在 存在性 → revision → deleted 之后才校验
const dirFix6 = fresh('store-fix-d6');
cli(['init', '--dir', dirFix6]);
r = cli(['team_task_update', '--dir', dirFix6, '--task-id', 'task-99', '--expected-revision', '1', '--action', 'frobnicate']);
check('D-6① 未知 action × 不存在任务 → 先 TEAM_TASK_NOT_FOUND', r.code === 2 && codeOf(r) === 'TEAM_TASK_NOT_FOUND', brief(r.json));
cli(['team_task_create', '--dir', dirFix6, '--subject', 'd6', '--description', 'd6']);
r = cli(['team_task_update', '--dir', dirFix6, '--task-id', 'task-1', '--expected-revision', '99', '--action', 'frobnicate']);
check('D-6① 未知 action × 过期 revision → 先 TEAM_TASK_STALE_REVISION', r.code === 2 && codeOf(r) === 'TEAM_TASK_STALE_REVISION', brief(r.json));
r = cli(['team_task_update', '--dir', dirFix6, '--task-id', 'task-1', '--expected-revision', '1', '--action', 'frobnicate']);
check('D-6① 未知 action × revision 正确 → TEAM_INVALID_ARGUMENT', r.code === 2 && codeOf(r) === 'TEAM_INVALID_ARGUMENT', brief(r.json));
r = cli(['team_task_update', '--dir', dirFix6, '--as', 'ghost', '--task-id', 'task-99', '--expected-revision', '1', '--action', 'frobnicate']);
check('D-6① 身份校验仍在最前 → TEAM_NOT_MEMBER', r.code === 2 && codeOf(r) === 'TEAM_NOT_MEMBER', brief(r.json));
// D-6②：成员身份 → 过滤 → cursor/limit
r = cli(['team_task_list', '--dir', dirFix6, '--cursor', '-1', '--as', 'ghost']);
check('D-6② cursor 非法 × 未知身份 → 先 TEAM_NOT_MEMBER', r.code === 2 && codeOf(r) === 'TEAM_NOT_MEMBER', brief(r.json));
r = cli(['team_task_list', '--dir', dirFix6, '--limit', '101', '--as', 'ghost']);
check('D-6② limit 非法 × 未知身份 → 先 TEAM_NOT_MEMBER', r.code === 2 && codeOf(r) === 'TEAM_NOT_MEMBER', brief(r.json));
r = cli(['team_task_list', '--dir', dirFix6, '--cursor', '-1']);
check('D-6② 身份合法时 cursor 非法仍 → INVALID_CURSOR exit 1', r.code === 1 && codeOf(r) === 'INVALID_CURSOR', brief(r.json));
r = cli(['team_task_list', '--dir', dirFix6, '--limit', '0']);
check('D-6② 身份合法时 limit 非法仍 → INVALID_LIMIT exit 1', r.code === 1 && codeOf(r) === 'INVALID_LIMIT', brief(r.json));

lines.push('');
lines.push(`TOTAL pass=${pass} fail=${fail}`);
process.stdout.write(`${lines.join('\n')}\n`);
process.exitCode = fail === 0 ? 0 : 1;
