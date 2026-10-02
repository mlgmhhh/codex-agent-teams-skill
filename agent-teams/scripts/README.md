# scripts/ — Codex 侧的持久化 Agent Teams store

`agent-team.mjs` 把官方 DSH Agent Teams 插件（`dsh-experimental-agent-team` +
`dsh-experimental-tool-agent-team`）的协议语义落到 Codex 上：Codex 没有 teammate
工具，所以这里用**一个 append-only 文件日志当唯一真源**，用 `codex exec` 子进程当
teammate，用同一个 CLI 同时充当 Lead 与 teammate 的接口。

- **零 npm 依赖**：只用 `node:fs` / `node:path` / `node:os` / `node:crypto` / `node:child_process`。
- **Node >= 18**（用到 `node:` 前缀导入、`randomUUID`、`Atomics.wait`、`replaceAll`、顶层 await）。
- **Windows 优先**（mkdir 锁、pid 存活探测、`taskkill /T /F`），同时跨平台可用（无 bash 专有假设）。

```
node scripts/agent-team.mjs <command> [options]
```

## 1. 快速开始

```powershell
# 0) 初始化 store（默认目录 .agent-team，可用 --dir 或 AGENT_TEAM_DIR 覆盖）
node scripts/agent-team.mjs init

# 1) 创建一名 teammate（prompt 必填；worker 命令不写就用自动定位到的 codex）
node scripts/agent-team.mjs spawn_teammate --name reviewer `
  --description "审阅 protocol.md 的字段与错误码" `
  --prompt "读 references/protocol.md，逐条回源码核对字段名，把不一致列成清单。"

# 2) 看 roster（lead 行 + 每个 teammate 的 target / status / diagnostics）
node scripts/agent-team.mjs list_agents

# 3) 给 teammate 发消息（running → accepted；inactive → queued。accept 只表示"已交给目标"，
#    消息仍留在它的 inbox 里，只有它自己 `inbox --ack` 才算 delivered；queued 已持久，绝不重发）
node scripts/agent-team.mjs send_message --target reviewer --message "先只做第 1 节"

# 3b) 收对方的回信（--ack 是唯一让消息离开 inbox 的动作）
node scripts/agent-team.mjs inbox --target lead
node scripts/agent-team.mjs inbox --target lead --ack

# 4) 共享任务板
node scripts/agent-team.mjs team_task_create --subject "核对字段名" `
  --description "逐条比对 TASK_VIEW 字段" --write-scopes "agent-teams/references/protocol.md"
node scripts/agent-team.mjs team_task_list --ready true
node scripts/agent-team.mjs team_task_get --task-id task-1
node scripts/agent-team.mjs team_task_update --task-id task-1 --expected-revision 1 --action claim --as reviewer
node scripts/agent-team.mjs team_task_update --task-id task-1 --expected-revision 2 --action complete --as reviewer
```

## 2. store 布局（`--dir`，默认 `.agent-team`）

```
<dir>/team.json                     # { version, teamId, lead, createdAt, limits }
<dir>/journal.jsonl                 # 唯一真源：append-only 事件日志，每行一个 JSON
<dir>/lock/                         # mkdir 互斥锁（CAS 与所有写操作在此串行）
<dir>/workers/<name>.prompt.txt     # 送进 worker stdin 的完整 prompt（含逐字身份前缀）
<dir>/workers/<name>.log            # worker 的 stdout/stderr
<dir>/workers/<name>.pid            # { pid, startedAt, command }，用于推导 running/inactive
<dir>/workers/<name>.launch.json    # worker launcher 的启动参数（命令/文件路径）
<dir>/workers/<name>.launch-result.json  # launcher 收尾报告：{exitCode|spawnError, signal}
<dir>/workers/<name>.inbox.jsonl    # worker 侧收件箱镜像（push/pull 各追加一行，可从 journal 重建）
```

`team.json` 是不可变配置（`teamId`/`lead`/`limits`/`createdAt`），由 `init` 写入；
**roster / mailbox / 任务板每次读取都从 `journal.jsonl` 回放派生**，没有任何第二份
状态文件。删掉 `journal.jsonl` 等于清空团队；`workers/` 下除 `.log` / `.prompt.txt`
外的文件都是可重建的派生数据（`.pid` 生死、`inbox.jsonl` 镜像、`launch-result.json` 报告）。

### 事件类型（`journal.jsonl` 的 `type`）

| type | data | 语义 |
|---|---|---|
| `member/provisioning` | `{name, description, context, provider}` | 创建开始；**名字从此永久保留** |
| `member/active` | `{name}` | worker 成功接收初始 prompt |
| `member/failed` | `{name, error}` | 创建失败（名字仍永久保留，`diagnostics` 里带 error） |
| `message/queued` | `{messageId, from, target, text, queuedAt}` | 消息已持久（**queued 即成功**） |
| `message/delivered` | `{messageId, target}` | **目标自己确认已持有该消息** —— 只由 `inbox --ack` 产生 |
| `task/created` | `{task}` | 任务快照，`revision:1`、`status:"pending"`、无 owner |
| `task/updated` | `{task}` | 变更后的完整快照，`revision` 连续 +1 |
| `task/deleted` | `{task}` | tombstone 快照（`status:"deleted"`） |

回放时会校验不变量（名字不可复用、`provisioning -> active|failed` 单向、
任务 revision 连续、`delivered` 必须先 `queued`），不满足即报 `E_JOURNAL_CORRUPT`。
**只容忍文件末尾那一行残片**（进程在 append 中途被杀的痕迹）。

## 3. 命令参考

九个官方工具名做子命令、参数用官方 snake_case；另有 `init` / `inbox` / `status` /
`journal` 四个运维命令（官方对应的是领域 API，不是模型可见工具）。

| 命令 | 参数 | 输出 |
|---|---|---|
| `init` | `--lead-name`(lead，纯展示标签) `--max-members`(8) `--max-tasks`(256) `--max-pending-per-member`(64) `--max-message-bytes`(65536) | `{teamId, lead, limits}` |
| `spawn_teammate` | `--name` `--description` (`--prompt`\|`--prompt-file`) `--context fresh\|fork` `--worker-cmd` `--run-sync` | `{member: MEMBER_VIEW}` |
| `list_agents` | — | `MEMBER_VIEW[]` |
| `send_message` | `--target` (`--message`\|`--message-file`) | `{messageId, status: accepted\|queued}` |
| `wait_agent` | `--timeout-ms`(30000, 10000–3600000) | `{timedOut, noProgress?}` |
| `interrupt_agent` | `--target` | `{previousStatus}` |
| `team_task_create` | `--subject` `--description` `--blocked-by a,b` `--write-scopes a,b` | `TASK_VIEW` |
| `team_task_list` | `--status` `--owner`(或 `unowned`) `--ready true\|false` `--cursor` `--limit` | `{tasks, nextCursor?}` |
| `team_task_get` | `--task-id` | `TASK_VIEW`（含 deleted tombstone） |
| `team_task_update` | `--task-id` `--expected-revision` `--action` `--subject` `--description` `--blocked-by` `--write-scopes` `--owner` | `TASK_VIEW` |
| `inbox` | `--target` `[--ack]` `[--all]` | `{messages:[{messageId, from, text, queuedAt}]}` |
| `status` | — | `{lead, members{...}, tasks{...}}` 紧凑摘要 |
| `journal` | `--limit`(20) | `{events, total}` |

全局选项：`--dir <path>`（或 `AGENT_TEAM_DIR`，默认 `.agent-team`）、`--as <name>`
（调用方身份，默认 `lead`，用于复刻 owner/Lead 权限校验）、`--json`（**默认就输出
JSON**，该开关保留给未来的人类可读模式）。

`--blocked-by` / `--write-scopes` 是逗号分隔列表（每项去首尾空格，空项丢弃）；
也可用 `--task_id` 这种下划线写法，参数名里的 `_` 与 `-` 等价。

**`init` 的幂等语义**：对已初始化的 store 再跑 `init` 会返回**同一 `teamId`**、
**不修改既有 `lead`/`limits`**，合法但与既有配置不同的新参数（如 `--max-members 16`）**被忽略**；
但**参数仍会校验**——非法值报 `TEAM_INVALID_CONFIG`（例如 `--max-members 0`，exit 2）、
`--lead-name` 违反命名规则报 `TEAM_INVALID_MEMBER_NAME`（exit 2）。所以"幂等"≠"静默吞掉参数"。

### 退出码与错误输出

| 退出码 | 含义 | stdout |
|---|---|---|
| 0 | 成功 | 结果 JSON |
| 1 | 用法 / 环境错误 | `{"error":{"code":"E_...","message":"..."}}` |
| 2 | 领域错误 | `{"error":{"code":"TEAM_...","message":"..."}}` |

非 `TEAM_` 前缀的码：`E_USAGE`（缺参/未知命令/位置参数）、`E_NOT_INITIALIZED`、
`E_JOURNAL_CORRUPT`、`E_LOCK_TIMEOUT`、`E_LOCK_FAILED`、`E_CODEX_NOT_FOUND`、
`E_INTERNAL`，以及**刻意复刻官方两条非 TeamError 路径**的 `INVALID_CURSOR` /
`INVALID_LIMIT`（见第 7 节）。

## 4. worker 接线

worker 命令的解析顺序：

1. `--worker-cmd "<完整 shell 命令>"`
2. 环境变量 `AGENT_TEAM_WORKER_CMD`
3. 环境变量 `CODEX_CLI_PATH`（指向 codex 可执行文件）
4. 自动定位：`PATH` → `%LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\codex.exe` → `~/.codex/bin/codex`
   → `%ProgramFiles%\Codex\codex.exe` → `/usr/local/bin/codex` 等
5. 都找不到 → 报 `E_CODEX_NOT_FOUND` 并提示显式传 `--worker-cmd`，**不会静默退回裸 `codex`**

**prompt 只从 stdin 送入**，绝不追加位置参数：`codex exec` 只有在省略位置参数（或传 `-`）
时才从 stdin 读 prompt；同时给位置参数会让 stdin 变成追加的 `<stdin>` 块。送入的内容是
逐字身份前缀 + `--prompt` 正文：

```
<system-reminder>
You are teammate "<name>".
Your Team Lead is named "lead".
Use list_agents({}) to find your teammates and their names.
To message your Team Lead, use send_message({ target: "lead", message: "..." }).
To message another teammate, use send_message({ target: "<teammate name>", message: "..." }).
</system-reminder>

```

（前缀原文取自 `tool-agent-team/lib/index.js:276-284`，结尾是 `</system-reminder>` 加两个换行。）
它先写到 `workers/<name>.prompt.txt`，再把该文件作为 worker 的 **stdin**（fd 0）交给它——
worker 侧看到的仍然是"从 stdin 读到的 prompt"，而 store 侧留下一份可复核的原文。

### 后台 worker 为什么要多一层 launcher

`spawn_teammate` 默认后台启动，链路是：

```
agent-team.mjs --(spawn, detached, stdio=ignore)--> _worker_launcher（存活）
_worker_launcher --(shell, stdio=[promptFile, log, log])--> worker
```

原因（本机 Windows 逐项实测，三种组合都验过）：

| 组合 | CLI 退出后 worker 是否存活 | worker 能否拿到注入的 stdin/stdout |
|---|---|---|
| 直接 spawn（`detached: false`） | 否（随 CLI 一起消失，`unref` 无效） | 能 |
| 直接 spawn（`detached: true`） | 是 | **否**（连 shell 自身的重定向都无效） |
| 经 shell（`shell: true`）拉起的**孙进程** | 是 | 能 |

所以让脚本把自己再拉起一次当 launcher：launcher 用 `detached` 直启（因此存活），由它自己
用 shell 拉起 worker 并把 prompt/日志句柄交给 worker。launcher 的存活期与 worker 完全一致，
因此 `workers/<name>.pid` 里记 launcher 的 pid 就等价于记 worker 的存活；launcher 退出时会删掉
pid 文件并写下 `launch-result.json`，`spawn_teammate` 正是用它判断"启动成功 / 立刻失败"。
`--run-sync` 不走 launcher（前台直接跑 worker，退出码即结论）。

### 三个推荐用法

```powershell
# A) 默认：自动定位 codex，fresh 上下文，共享 cwd，跳过 git 仓库检查
node scripts/agent-team.mjs spawn_teammate --name builder --description "实现" --prompt "..."

# B) 显式沙箱与模型（-s / -C / -m 都是 codex exec 接受的 flag）
$env:AGENT_TEAM_WORKER_CMD = '"C:\Users\UserX\AppData\Local\OpenAI\Codex\bin\<hash>\codex.exe" exec --skip-git-repo-check -s workspace-write -C "D:\ai" -m <model>'
node scripts/agent-team.mjs spawn_teammate --name verifier --description "复测" --prompt "..."

# C) 任意本地程序当 worker（自测用假 worker 就是这条路径）
node scripts/agent-team.mjs spawn_teammate --name fake --description "假 worker" `
  --prompt "anything" --worker-cmd "node D:/ai/agent-teams-verify/tmp-store-builder/fake-worker.mjs 60000 fake"
```

`codex exec` 接受的 flag（本机 `--help` 实测，`board-scribe` 转述）：`-c/--config`、`--enable`、
`--disable`、`--strict-config`、`-i/--image`、`-m/--model`、`-p/--profile`、
`-s/--sandbox read-only|workspace-write|danger-full-access`、`-C/--cd`、`--add-dir`、`--worktree`、
`--skip-git-repo-check`、`--ephemeral`、`--ignore-user-config`、`--ignore-rules`、
`--output-schema`、`--color`、`--json`、`-o/--output-last-message`。
**不要**把只在顶层 `codex --help` 里的 `-a/--ask-for-approval`、`--search`、`--no-alt-screen`、
`--no-daemon`、`--remote` 放进 worker 命令——`codex exec` 会报未知参数。

`--run-sync` 让 `spawn_teammate` 前台等 worker 退出（退出码 0 视为成功）——只为测试与
一次性 worker 提供；常驻 teammate 不要用它，否则 Lead 会被 worker 阻塞。

## 5. Lead 端完整操作序列

```powershell
node scripts/agent-team.mjs init
node scripts/agent-team.mjs spawn_teammate --name reviewer --description "..." --prompt "..."
node scripts/agent-team.mjs list_agents                     # 确认 status=running/provisioning
node scripts/agent-team.mjs team_task_create --subject "..." --description "..." --write-scopes "..."
node scripts/agent-team.mjs send_message --target reviewer --message "target task: task-1"
node scripts/agent-team.mjs wait_agent --timeout-ms 300000   # 先 list_agents 再 wait；wait 从不唤醒成员
node scripts/agent-team.mjs list_agents                      # 唤醒/超时后重新列出
node scripts/agent-team.mjs team_task_list
node scripts/agent-team.mjs inbox --target lead --ack         # Lead 收走 teammate 回给 lead 的消息
node scripts/agent-team.mjs interrupt_agent --target reviewer # 需要时中断当前轮次（保留 inbox 与 owner）
```

worker 侧（teammate 自己跑；`--as` 用自己的名字表达身份）：

```powershell
node scripts/agent-team.mjs inbox --target reviewer --ack      # 取走待投递消息并确认
node scripts/agent-team.mjs inbox --target reviewer --all      # 读该 target 的全部历史消息（journal 回放）
node scripts/agent-team.mjs list_agents --as reviewer
node scripts/agent-team.mjs team_task_list --as reviewer
node scripts/agent-team.mjs team_task_update --task-id task-1 --expected-revision 1 --action claim --as reviewer
node scripts/agent-team.mjs send_message --as reviewer --target lead --message "task-1 完成"
```

worker 读消息的两条路（等价，都不依赖第二份真源）：

1. `inbox --target <me> [--ack]`：返回**尚未 ack 的消息**（queued-minus-delivered）。
   `--ack` 是唯一让消息离开 inbox 的动作。**发送侧的 `accepted` 不会替目标宣称已投递**：
   target 正在 running 时 `send_message` 返回 `accepted`，那条消息**仍留在 inbox 里**，
   直到目标自己 `--ack`。因此"绝不重复投递"的含义是"不会重复产生新的 message 记录"，
   而不是"读一次就消失"。
2. `workers/<me>.inbox.jsonl` 收件箱镜像：push（发送时 target 正在 running）与 pull
   （`inbox --ack`）各追加一行（`delivery: push|pull`），可以直接读整个文件拿到属于自己
   的全部消息。`inbox --target <me> --all` 是它的 journal 回放版本。

## 6. 冷恢复

- **进程崩了**：所有状态都在 `journal.jsonl`，换个进程重跑任意读命令即可看到全部 roster /
  mailbox / 任务板。
- **worker 死了**：`list_agents` 用 `workers/<name>.pid` 的 pid 存活推导 `inactive`；
  消息仍是 `queued`，用 `inbox --target <name> --ack` 取走即可（不会丢也不会重复投递）。
- **创建中途崩了**（`member/provisioning` 已落盘、worker 没起来）：读命令（`list_agents` /
  `status`）在确认"没有存活 worker 且 provisioning 已超过 `AGENT_TEAM_PROVISIONING_STALE_MS`（默认 3000ms）"
  后补一条 `member/failed`，把名字从 `provisioning` 结算掉；名字仍然不可复用。
- **锁没释放**：持锁进程被 kill 会留下 `lock/` 目录。所有写操作按 mtime 回收超过
  `AGENT_TEAM_LOCK_STALE_MS`（默认 30000ms）的陈旧锁；等待超过
  `AGENT_TEAM_LOCK_TIMEOUT_MS`（默认 20000ms）则报 `E_LOCK_TIMEOUT`。
- **pid 被回收**：pid 存活判定无法识别 pid 复用。若某个已死 teammate 被误判为 `running`，
  删掉 `workers/<name>.pid` 即可修正（本进程观察到的 worker 退出会自动清理该文件）。

## 7. 与官方实现的差异与限制（逐条）

1. **单进程假设**。官方明确"进程内归属：重试 + 去重，不是跨进程共识"。这里用 `mkdir` 锁把
   写操作串行化，因此**同一 checkout 上的多个 CLI 进程不会互相破坏状态**；mailbox 的
   `delivered` 语义则是"目标自己 `--ack`"（见下条），不依赖进程内状态。
2. **`message/delivered` 只能由目标侧的 `inbox --ack` 产生**。官方只在目标会话**持久持有**
   该消息身份之后才写 `team/message/delivered`（`agent-team/lib/index.js:945-965`：先
   `sessions.flush(target)`，再复查 `targetRecorded`，通过才 `markDelivered`）。Codex 上没有
   目标侧会话日志可查，**唯一可信的目标侧持久证据就是 worker 自己调 `inbox --ack`**。
   所以：`send_message` 对 `running` target 返回 `accepted`、对 `inactive` 返回 `queued`，
   **两种情况消息都留在 inbox 里**；发送侧只写 `message/queued` + 收件箱镜像，绝不替目标
   宣称已投递（否则 worker 在读到之前崩溃，消息就永久消失）。`inbox`（不带 `--all`）=
   queued-minus-delivered，`--ack` 是唯一让消息离开 inbox 的动作。**"绝不重复投递"的含义是
   不重复产生新的 message 记录，不是"读一次就消失"；而 `queued` 就已经持久，绝不重发**。
3. **Lead 可用性不可观测**（【推断】）。官方里 Lead 就是持有日志的活 Agent；独立 CLI 无法观测
   那个 turn。规则：本次调用由 Lead 自己发起（`--as lead`）时报告 `running`，否则由
   `AGENT_TEAM_LEAD_RUNNING=1` 声明，默认为 `inactive`。因此 teammate 发给 `lead` 的消息默认
   是 `queued`，需要 Lead 用 `inbox --target lead --ack` 取走。
4. **`interrupt_agent` 是进程级**。官方以 `keepInbox` 只取消当前 turn；这里杀掉 worker 进程树
   （Windows `taskkill /T /F`，POSIX `SIGTERM`），语义上等价于"这一轮不再继续"，但**没有 turn
   级粒度**。它同样既不释放任务 owner 也不删除持久 mail（与官方一致）。
5. **`--context fork` 只是记录**。`codex exec resume/fork` 没有 `-s/--sandbox`、`-C/--cd`、
   `-p/--profile`，而 store 也不持有 Lead 会话 id，所以 fork 路径的 worker **实际上仍是 fresh
   进程**；`spawn_teammate` 会向 stderr 打印警告，`context:"fork"` 只进 journal 与视图。
6. **`team_task_list` 的 cursor/limit 校验**：官方抛的是普通 `Error`（没有 `TEAM_*` 码，
   `tool-agent-team/lib/index.js:437-438`）。这里映射为 `INVALID_CURSOR` / `INVALID_LIMIT` +
   退出码 1，是刻意复刻"这两条不是领域错误"；它们的**校验时机**（身份 → 过滤 → cursor/limit）
   见第 17 条。
7. **重复 `delete` 不幂等**：官方在 action switch **之前**检查 `status === "deleted"`，所以对已删除
   任务再次 `delete`（revision 已更新到新值）报 `TEAM_TASK_DELETED`；revision 仍是旧值时先报
   `TEAM_TASK_STALE_REVISION`。这里照抄该顺序。
8. **`TEAM_DISPOSED` / `TEAM_DISPOSAL_TIMEOUT` / `TEAM_WAIT_ABORTED` 不可达**：它们属于
   长驻服务与取消信号，单进程一次性 CLI 没有对应路径；错误码常量保留在源码里但不触发。
9. **write scope 只是提示**。`writeScopeWarnings` 只报告与**其它 `in_progress` 任务**的路径分量
   重叠（`write scopes overlap with task-<n>`），**从不阻止任何操作**；绝对路径、盘符、
   `.`/`..`/空段一律报 `TEAM_INVALID_WRITE_SCOPE`。
10. **tombstone 语义**：`delete` 后任务不再出现在 `team_task_list`，但 `team_task_get` 仍返回
    `status:"deleted"` 的完整快照；id 不复用（`task-<n>` 单调递增），`maxTasks` 不占用。
11. **没有 worktree / 远端成员 / merge / 文件锁**：与官方一致，所有成员共享同一 cwd 与文件系统。
12. **真实 `codex exec` worker 一跳未在本机端到端验证**：本机 `codex` 不在 PATH（脚本会自动探测
    安装目录），且外层环境存在网络侧 `workspace routing discovery failed` 与 MCP 传输失败，
    无法跑通一次真实 worker turn。**自测全部使用 `--worker-cmd` 指向本地 node 假 worker**，
    没有伪造 codex 输出。
13. **`_worker_launcher` 是内部子命令**（【推断】实现细节）：`spawn_teammate` 后台启动时用它
    拉起 worker；它不读 store、不输出 stdout，参数只有一个 `launch.json` 路径。用户不应直接调用。
14. **`inbox --all` 是本 store 的扩展**：官方没有 inbox 命令（官方把消息 steer 进目标会话）。
    默认 `inbox` 只给"尚未 ack"的消息以严格复刻"绝不重复投递"，`--all` 让 worker 能按需回放
    属于自己的全部消息。
15. **可调的时间参数**：`AGENT_TEAM_LOCK_TIMEOUT_MS`（默认 20000）、`AGENT_TEAM_LOCK_STALE_MS`
    （默认 30000）、`AGENT_TEAM_WORKER_GRACE_MS`（默认 600，判断 worker 是否"启动即失败"的宽限期）、
    `AGENT_TEAM_PROVISIONING_STALE_MS`（默认 3000，冷恢复结算遗留 provisioning 的阈值）、
    `AGENT_TEAM_LEAD_RUNNING`（声明 Lead 正在 running）。慢机器上可调大前两者。
16. **Lead 的名字被 Lead 独占**。**`--lead-name` 是纯展示标签，不构成身份别名**：Lead 的唯一
    寻址 target 与身份**恒为 `lead`**（官方 `roster.js:18-21` 与 `team-model.md` §1 同样如此），
    `--as lead` 是**唯一**表达 Lead 身份的方式。`init --lead-name <n>` 只把该标签写进
    `team.json`，因此 `--as <该标签>` **不是** Lead，报 `TEAM_NOT_MEMBER`——`spawn_teammate` /
    `interrupt_agent` / `reassign` / `send_message` 的 Lead-only 校验无法用队友名或该标签绕过。
    与之配套的三条约束：
    ① `--lead-name` 必须满足与 teammate 名相同的命名规则（`^[a-z0-9]+(?:-[a-z0-9]+)*$`、≤64），
    违反即领域错误 `TEAM_INVALID_MEMBER_NAME`（exit 2，与 `--max-members 0` 同一类）；
    ② `spawn_teammate --name <该标签>` 在落 `member/provisioning` **之前**就被拒
    （`TEAM_MEMBER_NAME_TAKEN`），保证不存在与 Lead 同名的成员（否则该成员不可寻址：
    `--target <它>` 会解析成 Lead → `TEAM_SELF_MESSAGE`；默认配置下 `--name lead` 仍由名字形态
    校验先拦成官方的 `TEAM_INVALID_MEMBER_NAME`）；③ 手工/遗留 journal 里若出现同名成员，
    回放直接报 `E_JOURNAL_CORRUPT`，**不静默解析**；本 store 不提供改写身份的运维命令。
17. **两处校验顺序与官方对齐**：`team_task_update` 的未知 action 由 action switch 的 `default`
    报 `TEAM_INVALID_ARGUMENT`，因此顺序是 身份 → 存在性 → revision → deleted → action
    （官方 `lib/index.js:1617` 同位置）；`team_task_list` 的顺序是 身份（`TEAM_NOT_MEMBER`）
    → 过滤 → cursor/limit（官方 `tool-agent-team/lib/index.js:434-441`），其中
    `INVALID_CURSOR` / `INVALID_LIMIT` 仍是非 `TEAM_` 前缀 + exit 1（见第 6 条）。

## 8. 自测

黑盒自测脚本（不进 skill 目录）：`D:\ai\agent-teams-verify\tmp-store-builder\selftest.mjs`，
配套 `fake-worker.mjs`（读 stdin、校验逐字身份前缀、sleep）与 `fail-worker.mjs`（立刻非零退出）。
覆盖：init → spawn（后台 running / `--run-sync` inactive / 启动失败 failed → 重名拒绝）→
list_agents → send_message 的 accepted 与 queued 两条路径 → inbox `--ack` 不重复投递 →
任务 create/list/get/claim/release/reopen/edit/reassign/complete/delete 全流程 →
CAS 冲突（含 5 个真并发进程）→ 自依赖/成环/重复/缺失 blocker → write scope 规范化与重叠警告 →
tombstone → 上限（成员/任务/mailbox/消息字节）→ 28 个错误码可达子集 → 陈旧锁回收与锁超时 →
冷恢复（伪造遗留 provisioning）→ run-sync 与冷恢复的竞争 →
**D-4/D-5/D-6 回归**（同名成员被拒 + `--as <lead 名>` 不再是 Lead（spawn/interrupt/reassign/send 四条路径）
+ teammate 仍可寻址 + 遗留同名 journal 报 `E_JOURNAL_CORRUPT`；init 幂等仍校验非法 limits；
未知 action 的三段顺序；`team_task_list` 的身份优先顺序）。

当前断言数：**159 条，全部 PASS**（`node selftest.mjs` → `TOTAL pass=159 fail=0`）。

```powershell
node D:\ai\agent-teams-verify\tmp-store-builder\selftest.mjs
```
