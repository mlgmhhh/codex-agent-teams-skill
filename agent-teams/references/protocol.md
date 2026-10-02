# Agent Teams 协议参考：9 个模型可见工具

本文件是 `agent-teams` skill 的协议真源：工具名、参数、结果 schema、逐字策略文本与完整错误码表。
所有论断都直接核对自 DSH 官方实验性插件族的**已发布构建产物**（只读，未修改）。

## 0. 来源与行号约定

| 别名 | 磁盘路径（前缀 `C:\Users\UserX\.dsh\profiles\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\`） |
|---|---|
| `tool-agent-team/lib/index.js` | `dsh-experimental-tool-agent-team/lib/index.js`（557 行；9 个工具 schema 与 `team:policy` 全在这里） |
| `agent-team/lib/index.js` | `dsh-experimental-agent-team/lib/index.js`（1870 行；领域服务，内含 `lib/types/*` 各模块的合并实现） |
| `agent-team/lib/types/x.js` | `dsh-experimental-agent-team/lib/types/x.js`（拆出的单模块，与合并实现同源、行号不同） |
| `agent-team/lib/invariant.js` | `dsh-experimental-agent-team/lib/invariant.js`（不变式伴生插件入口） |
| `profile/cordis.patch.yml` | `dsh-experimental-agent-team-profile/cordis.patch.yml` |
| `agent-team/README.zh.md` | `dsh-experimental-agent-team/README.zh.md` |

下文所有 `文件:行号` 都指上表别名。`src/*.ts` 未随包发布，因此本文件不引用 TypeScript 源行号（【待确认】无法核对 TS 源）。

同一前缀下还有两个被引用的兄弟包（它们是 Team 领域复用的底层能力，不是 Team 包本身）：

| 别名 | 作用 |
|---|---|
| `dsh-subagent/lib/index.js`、`dsh-subagent/lib/types/internal.js` | continuable child 的 steer / interrupt / 冷恢复与 host 投递实现 |
| `dsh-llm/lib/types/error.js` | `HarnessError` 基类，定义稳定 `code` 的语义 |

## 1. 安装与作用域

- 插件名 `tool-agent-team`（`tool-agent-team/lib/index.js:7`），依赖 `agents`、`agentTeams`、`tools`、`systemPrompt` 四个服务（`tool-agent-team/lib/index.js:9-14`）。
- 配置只有两项：`freshProvider` 默认 `"spawn"`、`forkProvider` 默认 `"fork"`（`tool-agent-team/lib/index.js:16-19`、`tool-agent-team/lib/index.js:533-537`）。
- **工具不是全局注册的**，而是注册在**每个成员 Agent 自己的 `ctx`** 上：`maybeInstall` 遍历 `ctx.agents.list()` 并订阅 `agent/created`，仅当 `ctx.agentTeams.tryMembership(agent) !== undefined` 时安装；`agent/disposed` 与插件 HMR 会按逆序执行 disposer（`tool-agent-team/lib/index.js:539-554`）。
- 因此 **Lead 与每个 teammate 拿到完全相同的 9 个工具与同一段策略文本**，唯一区别是执行时的权限检查（`tool-agent-team/README.zh.md:28`、`tool-agent-team/README.zh.md:64`）。
- 没有 Team 成员关系的 provider 子代理（带 subagent descriptor）拿不到这些工具（`agent-team/lib/index.js:411`、`agent-team/lib/index.js:420`）。

## 2. 策略段 `team:policy`（逐字原文）

注册名 `team:policy`，顺序取 `systemPrompt.getSectionOrder("TEAM_POLICY")`，文本为常量 `POLICY`（`tool-agent-team/lib/index.js:21-27`、`tool-agent-team/lib/index.js:237-241`）：

```text
Agent Teams is available in this session, but create teammates only when the user explicitly asks to use Agent Teams or teammates.

The Team Lead and all teammates share the same working directory and filesystem. Edits are immediately visible to every member. Split write work into disjoint scopes, record expected write scopes on shared tasks, and use task dependencies when work must be ordered. Write-scope overlap is advisory, not a lock.

Prefer read/edit/write for file changes. If a file operation returns FS_STALE_VERSION, read the current file, rebase your intended change onto the new content, and retry. Bash, formatters, code generators, and scripts are not fully protected by the filesystem version guard; coordinate them explicitly and have the Lead review the final diff and run tests.

Use the target returned by spawn_teammate or list_agents for send_message and interrupt_agent, or as owner when assigning or filtering shared tasks. send_message steers a running target at its nearest step boundary and starts or resumes an inactive target. inactive means no turn is executing; it does not describe task completion, success, failure, or waiting for other agents. provisioning means member creation is in progress; failed means member creation failed. A delivered peer item starts with its stable message id and sender name. A successful send is already durable even when its result says queued; do not resend it. Shared-task workflow is list, get, claim with the current revision, perform the work, then complete. Task readiness never starts an owner. Before wait_agent, use list_agents and make sure another required member is running or provisioning; use send_message first when the required member is inactive. wait_agent observes only changes after that call starts, never wakes a member, and returns noProgress immediately when no other member can produce a change. Re-list after wakeup or timeout. The Lead must wait for required teammates before giving the final answer.
```

逐条要点（均出自上一段原文）：只在用户明确要求时创建成员；共享 cwd 与文件系统、编辑立刻可见；写工作切不相交 scope 并记在任务上、用任务依赖排序；**write-scope 重叠只是 advisory，不是锁**；优先 read/edit/write，遇 `FS_STALE_VERSION` 读最新再重放；Bash/formatter/codegen/脚本不受文件版本保护，必须显式协调并由 Lead 检查最终 diff、跑测试；`inactive` 只表示没有轮次在执行，不代表任务完成/成功/失败/等待；`provisioning` 表示创建中，`failed` 表示创建失败；投递的同侪消息以稳定 message id + 发送者名开头；**结果哪怕写着 `queued` 也已持久，绝不能重发**；任务流程 = list → get → 用当前 revision claim → 干活 → complete；readiness 从不自动启动 owner；`wait_agent` 前先 `list_agents` 确认有 running/provisioning 的成员，没有就先 `send_message` 唤醒；wait 只观察调用之后的变化、从不唤醒成员，无活跃同侪时立即 `noProgress`；唤醒或超时后重新列出；Lead 必须在给出最终答复前等待必需的 teammate。

## 3. teammate 身份前缀（逐字原文）

`spawn_teammate` 把身份前缀作为**第一个 user content block**，随后才是调用的 `prompt`（`tool-agent-team/lib/index.js:274-288`）。下面是源码模板的**逐字内容**（含 `${args.name.trim()}` 占位符，`tool-agent-team/lib/index.js:277`）；投递时该占位符被替换为**去空格后的队友名**，所以名字为 `reviewer` 的队友实际看到的是 `You are teammate "reviewer".`：

```text
<system-reminder>
You are teammate "${args.name.trim()}".
Your Team Lead is named "lead".
Use list_agents({}) to find your teammates and their names.
To message your Team Lead, use send_message({ target: "lead", message: "..." }).
To message another teammate, use send_message({ target: "<teammate name>", message: "..." }).
</system-reminder>

```

模板文本在 `</system-reminder>` 之后还有一个空行，即字面量以 `</system-reminder>\n\n` 结尾（`tool-agent-team/lib/index.js:282-284`）。README 记录的同一前缀见 `tool-agent-team/README.zh.md:128`；该前缀不含 Team id，也不含 provider/model。

## 4. 九个工具

参数用 schemastery 风格声明；下表的「required」= schema 中 `required: true`，「默认」= `execute` 里的实际兜底值（不是 schema 默认）。

### 4.1 `spawn_teammate`（`tool-agent-team/lib/index.js:242-294`）

描述原文：

```text
Create one named, durable teammate. Only the Team Lead may call this tool.
```

| 参数 | 类型 | required | 说明（描述原文） |
|---|---|---|---|
| `name` | string | 是 | `Unique lower-kebab-case teammate name.` |
| `description` | string | 是 | `Short description of the delegated responsibility.` |
| `prompt` | string | 是 | `Complete initial task for the teammate.` |
| `context` | string，enum `fresh`\|`fork` | 否 | `fresh starts without Lead history; fork inherits completed Lead turns. Defaults to fresh.` |

- 默认值在代码里生效：`const context = args.context ?? "fresh"`（`tool-agent-team/lib/index.js:270`）。
- provider 由 context 决定：`context === "fork" ? config.forkProvider : config.freshProvider`（`tool-agent-team/lib/index.js:290`）。
- 结果：`{ member: MEMBER_VIEW }`（`tool-agent-team/lib/index.js:267`、`tool-agent-team/lib/index.js:292`）。
- 权限：仅 Lead；非 Lead 由领域层报 `TEAM_LEAD_REQUIRED`（`agent-team/lib/index.js:546`）。

### 4.2 `send_message`（`tool-agent-team/lib/index.js:295-321`）

描述原文：

```text
Send one durable message to another Team member. A running target receives it at the nearest step boundary; an inactive target starts or resumes a turn.
```

| 参数 | 类型 | required | 说明（描述原文） |
|---|---|---|---|
| `target` | string | 是 | `Member target returned by spawn_teammate or list_agents, including lead.` |
| `message` | string | 是 | `Self-contained message for the target.` |

- `message` 被包成单个 `{ type: "text", text }` content block 传给 `sendMessage`（`tool-agent-team/lib/index.js:314-317`）。
- 结果：`{ messageId: string, status: "accepted" | "queued" }`（`tool-agent-team/lib/index.js:310`、`agent-team/lib/index.js:846-849`）。
- `messageId` 形如 `team-message-<uuid>`（`agent-team/lib/index.js:828`）。
- **`queued` 就已经持久**：先追加并 flush `team/message/queued`，再尝试投递（`agent-team/lib/index.js:820-844`）。

### 4.3 `list_agents`（`tool-agent-team/lib/index.js:322-330`）

描述原文：

```text
List the Lead and every durable teammate with an addressable target and current availability. inactive means no turn is executing, not a task result. provisioning and failed describe member creation.
```

- 参数：`{}`（无参数）。
- 结果：**直接是数组** `MEMBER_VIEW[]`，不是包装对象（`tool-agent-team/lib/index.js:326`、`tool-agent-team/lib/index.js:141-144`）。
- 成员顺序：Lead 行在前，teammate 按创建顺序（`agent-team/lib/index.js:439-461`）。

### 4.4 `wait_agent`（`tool-agent-team/lib/index.js:331-352`）

描述原文：

```text
Wait for the next teammate status, mailbox, or shared-task change after this call starts. This never wakes inactive members and returns noProgress immediately when no other member is running or provisioning. Re-list after wakeup or timeout instead of polling.
```

| 参数 | 类型 | required | 说明（描述原文） |
|---|---|---|---|
| `timeout_ms` | integer | 否 | `Wait duration in milliseconds, from 10000 through 3600000. Defaults to 30000.` |

- 兜底默认 `30000`（`tool-agent-team/lib/index.js:341`）。
- 合法区间 `10000..3600000` 的安全整数；**越界不会被工具层拦下**，而是转交领域层，由 `TeamActivity.wait` 抛 `TEAM_INVALID_TIMEOUT`（抛出点 `agent-team/lib/index.js:48`；工具层的原样转交在 `tool-agent-team/lib/index.js:342`，该行不含本码）。
- 捷径：仅当 timeout 合法、且 `listMembers` 中除调用者外**没有任何** `running`/`provisioning` 成员时，立即返回 `noProgress`；否则进入真正等待（`tool-agent-team/lib/index.js:343-350`）。活跃状态集合 = `{running, provisioning}`（`tool-agent-team/lib/index.js:28`）。
- `noProgress.reason` 固定常量 `"no-active-peer"`；`message` 为固定文本 `NO_ACTIVE_PEER_MESSAGE`（`tool-agent-team/lib/index.js:29`、`tool-agent-team/lib/index.js:343-349`）：

```text
No other Team member is running or provisioning. wait_agent cannot make progress or wake inactive teammates. Re-list with list_agents and team_task_list, then use send_message to wake each required inactive teammate before waiting again.
```

- 结果：`{ timedOut: boolean, noProgress?: { reason, message } }`（`tool-agent-team/lib/index.js:161-185`）。`noProgress` **只在跳过等待的捷径上出现**（`tool-agent-team/lib/index.js:160`）。
- 等待由三类边唤醒：Team 事件提交（journal commit 回调 `notify`）、成员 Agent 状态变化（`agent/status`）、以及 runtime dispose 释放等待者（`agent-team/lib/index.js:1714-1716`、`agent-team/lib/index.js:1726-1729`、`agent-team/lib/index.js:1712`）。
- 边界：`signal.throwIfAborted()` 在进入等待前先抛调用方自身的取消原因（`agent-team/lib/index.js:49`）；等待**期间**被取消且 reason 不是 `Error` 时抛 `TEAM_WAIT_ABORTED`（`agent-team/lib/index.js:68-73`）；runtime 已 dispose 后 `closed` 为真，等待直接返回 `{ timedOut: false }`（`agent-team/lib/index.js:50`、`agent-team/lib/index.js:101-105`）。

### 4.5 `interrupt_agent`（`tool-agent-team/lib/index.js:353-365`）

描述原文：

```text
Interrupt one teammate's current turn while preserving its pending inbox. Team Lead only.
```

| 参数 | 类型 | required | 说明（描述原文） |
|---|---|---|---|
| `target` | string | 是 | `Teammate target returned by spawn_teammate or list_agents.` |

- 结果：`{ previousStatus: "running" | "inactive" }`（`tool-agent-team/lib/index.js:186-194`）。
- `previousStatus` 是**取消前**采样的可用状态；目标不在 Agent 注册表里时直接返回 `inactive`（`agent-team/lib/index.js:509-516`）。
- 实际取消走 continuable-subagent 的 `interrupt`，authority 为 `{ kind: "ancestor", agent: caller }`（`agent-team/lib/index.js:512-515`），底层以 `{ keepInbox: true }` 只取消当前 turn（`dsh-subagent/lib/index.js:855`）。

### 4.6 `team_task_create`（`tool-agent-team/lib/index.js:366-400`）

描述原文：

```text
Create one unowned pending task on the shared Team task board.
```

| 参数 | 类型 | required | 说明（描述原文） |
|---|---|---|---|
| `subject` | string | 是 | `Concise task title.` |
| `description` | string | 是 | `Complete task details and acceptance criteria.` |
| `blocked_by` | string[] | 否 | `Task ids that must complete first.` |
| `write_scopes` | string[] | 否 | `Advisory workspace-relative file or directory prefixes this task expects to modify.` |

- 结果：`TASK_VIEW`（`tool-agent-team/lib/index.js:391`）。
- 创建出的任务固定 `status: "pending"`、`revision: 1`、无 owner（`agent-team/lib/index.js:1473-1481`、`agent-team/lib/index.js:1475`）。
- id 由单调计数生成 `task-<n>`（`agent-team/lib/index.js:1471`）；`subject` 上限 200 字符、`description` 上限 16384 字符，超长或去空格后为空报 `TEAM_INVALID_ARGUMENT`（`agent-team/lib/index.js:1476-1477`、`agent-team/lib/index.js:322-327`）。

### 4.7 `team_task_list`（`tool-agent-team/lib/index.js:401-444`）

描述原文：

```text
List shared tasks, including readiness, owner, revision, blockers, and write-scope warnings.
```

| 参数 | 类型 | required | 说明（描述原文） |
|---|---|---|---|
| `status` | string，enum `pending`\|`in_progress`\|`completed` | 否 | `Optional exact status filter.` |
| `owner` | string | 否 | `Optional member target from spawn_teammate or list_agents, matching ownerName; use unowned for tasks without an owner.` |
| `ready` | boolean | 否 | `Optional readiness filter.` |
| `cursor` | integer | 否 | `Zero-based result offset. Defaults to 0.` |
| `limit` | integer | 否 | `Number of rows, 1 through 100. Defaults to 50.` |

分页语义（`tool-agent-team/lib/index.js:434-442`），必须按此顺序理解：

1. 先用 `status`、`owner`（`unowned` ↔ `ownerName === undefined`，否则精确等于）、`ready` 三个条件过滤 `listTasks()` 的结果。
2. **然后**校验 `cursor`（非负安全整数）与 `limit`（1–100）；不合法抛**普通 `Error`**（`"cursor must be a non-negative safe integer"` / `"limit must be an integer from 1 through 100"`），**不是 `TeamError`、没有 `TEAM_*` 码**。
3. `tasks = filtered.slice(cursor, cursor + limit)`。
4. `nextCursor = cursor + limit`，**仅当** `cursor + limit < filtered.length` 时出现。

其它：`status` 枚举里**没有 `deleted`**，而 `listTasks()` 也从不返回 deleted 任务（`agent-team/lib/index.js:1512`）。结果：`{ tasks: TASK_VIEW[], nextCursor?: integer }`（`tool-agent-team/lib/index.js:195-206`）。

### 4.8 `team_task_get`（`tool-agent-team/lib/index.js:445-457`）

描述原文：

```text
Read the complete latest value of one shared task before changing or executing it.
```

| 参数 | 类型 | required | 说明（描述原文） |
|---|---|---|---|
| `task_id` | string | 是 | `Shared task id.` |

- 结果：`TASK_VIEW`（`tool-agent-team/lib/index.js:453`）。
- 与 list 不同，**get 会返回 `status: "deleted"` 的 tombstone**（`agent-team/lib/index.js:1497-1503`）；任务不存在报 `TEAM_TASK_NOT_FOUND`。

### 4.9 `team_task_update`（`tool-agent-team/lib/index.js:458-523`）

描述原文：

```text
Compare-and-set a shared task action using the latest revision from team_task_get or team_task_list.
```

| 参数 | 类型 | required | 说明（描述原文） |
|---|---|---|---|
| `task_id` | string | 是 | `Shared task id.` |
| `expected_revision` | integer | 是 | `Current task revision used as the CAS precondition.` |
| `action` | string，enum 见下 | 是 | `Task transition to apply.` |
| `subject` | string | 否 | `Replacement title for edit.` |
| `description` | string | 否 | `Replacement details for edit.` |
| `blocked_by` | string[] | 否 | `Complete blocker list for set_dependencies.` |
| `write_scopes` | string[] | 否 | `Replacement advisory write scopes for edit.` |
| `owner` | string | 否 | `Member target from spawn_teammate or list_agents for Lead-only reassign; omit to unassign.` |

`action` 枚举（`tool-agent-team/lib/index.js:475-484`）：`claim`、`release`、`edit`、`set_dependencies`、`complete`、`reopen`、`reassign`、`delete`。
结果：`TASK_VIEW`（`tool-agent-team/lib/index.js:510`）。每次成功变更把 `revision` 加一并写整份快照（`agent-team/lib/index.js:1619-1628`）。
CAS 前置检查顺序是**先 revision、后 deleted、再 action**（`agent-team/lib/index.js:1527-1528`）：revision 不匹配先报 `TEAM_TASK_STALE_REVISION`；任务已删除则任何 action（**包括再次 `delete`**）都报 `TEAM_TASK_DELETED`，因此 delete **不幂等**。

## 5. 结果 schema

`MEMBER_VIEW`（`tool-agent-team/lib/index.js:35-71`）：

| 字段 | 类型 | required |
|---|---|---|
| `target` | string | 是 |
| `role` | `lead` \| `teammate` | 是 |
| `status` | `running` \| `inactive` \| `provisioning` \| `failed` | 是 |
| `description` | string | 否 |
| `provider` | string | 否 |
| `context` | `fresh` \| `fork` | 否 |
| `model` | string | 否 |
| `diagnostics` | string[] | 是 |

- `additionalProperties: false`：结果里不会出现别的字段。
- **内部 `id` 与 `name` 不外露**：`modelMember` 丢掉 `id` 并把 `name` 改名为 `target`（`tool-agent-team/lib/index.js:73-79`），所以 `target` **就是**队友名字，可直接当作 `send_message.target` 或任务 `owner`/`ownerName`。
- Lead 行只有 `target`/`role`/`status`/`model?`/`diagnostics`，**没有** `description`/`provider`/`context`（`agent-team/lib/index.js:439-446`）。
- teammate 行的 `status` 优先级：`failed` > `provisioning` > 实时可用性（`running`/`inactive`）（`agent-team/lib/index.js:454`）；`diagnostics` 在失败时是 `[member.error]`，否则 `[]`（`agent-team/lib/index.js:459`）。
- `model` 的来源在两处不同：`list_agents` 取 `live?.options.model ?? root.options.model`，都取不到才省略字段（`agent-team/lib/index.js:449`）；`spawn_teammate` 的返回走 `memberView`，只看该 live Agent 自己的 model，**不回落 Lead**（`agent-team/lib/index.js:698`）。

`TASK_VIEW`（`tool-agent-team/lib/index.js:81-132`）：`id`(string, required)、`revision`(integer, required)、`subject`(string, required)、`description`(string, required)、`status`(`pending`\|`in_progress`\|`completed`\|`deleted`，required)、`ownerName`(string, 否)、`blockedBy`(string[], required)、`writeScopes`(string[], required)、`ready`(boolean, required)、`writeScopeWarnings`(string[], required)。同样 `additionalProperties: false`。

- `ownerName`：owner 就是 Lead 时为 `"lead"`，否则查成员名；无 owner 则省略字段（`agent-team/lib/index.js:1069`、`agent-team/lib/index.js:1083`）。
- **`ready` 的真实语义**：`task.status === "pending" && 所有 blocker 都 completed`（`agent-team/lib/index.js:1084`、`agent-team/lib/index.js:1056-1058`）。in_progress/completed 任务即使没有 blocker，`ready` 也是 `false`。
- `writeScopeWarnings` 只为**与其它 `in_progress` 任务**的 scope 重叠生成，形如 `write scopes overlap with task-<n>`，去重后成数组，**从不阻止任何操作**（`agent-team/lib/index.js:1070-1074`、`agent-team/lib/index.js:1047-1049`）。

其余结果 schema：`spawn_teammate` → `{ member: MEMBER_VIEW }`（`tool-agent-team/lib/index.js:133-140`）；`list_agents` → `MEMBER_VIEW[]`（`tool-agent-team/lib/index.js:141-144`）；`send_message` → `{ messageId, status }`（`tool-agent-team/lib/index.js:145-159`）；`wait_agent` → `{ timedOut, noProgress? }`（`tool-agent-team/lib/index.js:161-185`）；`interrupt_agent` → `{ previousStatus }`（`tool-agent-team/lib/index.js:186-194`）；`team_task_list` → `{ tasks, nextCursor? }`（`tool-agent-team/lib/index.js:195-206`）。

**渲染**：每个结果都被 `JSON.stringify` 成**紧凑 JSON** 放进单个 text block（`tool-agent-team/lib/index.js:214-222`）；`execute` 的返回值受声明的 output schema 约束。

## 6. 完整错误码表

下表是 `TEAM_*` 字面量的**全集（28 个）**，来自对 `agent-team/lib/index.js`、`agent-team/lib/types/*.js`（`activity`/`error`/`index`/`lifecycle`/`mailbox`/`projection`/`roster`/`task-board`/`task-graph`/`task-view`/`validation`/`invariant`）、`agent-team/lib/invariant.js`、`tool-agent-team/lib/index.js` 的逐一 grep；`tool-agent-team` 只出现 `TEAM_POLICY`（`tool-agent-team/lib/index.js:239` 的 section 名常量，不是错误码）与工具名。这些码都是 `TeamError extends HarnessError` 上的稳定 `code`，路由请用 `code`，不要解析 message（`agent-team/lib/index.js:13-18`、`dsh-llm/lib/types/error.js:12-20`）。

**「来源」列的读法**（三条）：① **硬约束**——「来源」列的**每一行都必须真的含该错误码字面量**，这是可机器证明的不变量，也是本文档自检的判据。② **抛出点优先**——该码被 `throw` 或被 Promise `reject` 的行是首选来源；`映射点`（下层先抛出自己的违规类别，再经映射表变成该码）、`构造点`（错误对象被构造，但经由 `abort()` 等非 `throw` 路径传播）等非抛出行**可以**列入，但**必须在同格显式标注其性质**（本表 `TEAM_TASK_DEPENDENCY_CYCLE` 行在「来源」列标注的映射点、`TEAM_DISPOSED` 行在「触发条件」列标注的构造点，都是合法范例）。③ **纯形态定义行不得进「来源」列**——只声明正则或约束、**不含**该码字面量的行（如 `agent-team/lib/index.js:342`）只能写进「触发条件」文本并标明性质（本表 `TEAM_INVALID_MEMBER_NAME` 行即范例）；**图校验违规点**（抛出的不是该码本身）同理，只写在「触发条件」列。

| 错误码 | 触发条件 | 来源 |
|---|---|---|
| `TEAM_INVALID_TIMEOUT` | `timeoutMs` 不是 `10000..3600000` 的安全整数（由 `TeamActivity.wait` 抛出；工具层会先把越界值原样转交） | `agent-team/lib/index.js:48` |
| `TEAM_WAIT_ABORTED` | 等待期间被取消，且 `signal.reason` 不是 `Error` | `agent-team/lib/index.js:71` |
| `TEAM_DISPOSED` | 服务正在 dispose：`spawn`/`send` 入口拦截、provisioning 被中止且 reason 不是 `Error`；也是 lifecycle abort 的 reason（**构造点**：`agent-team/lib/index.js:202` 构造该错误并由 `abort()` 携带，不经 `throw`） | `agent-team/lib/index.js:471`（抛出点）、`agent-team/lib/index.js:635`（抛出点）、`agent-team/lib/index.js:768`（抛出点） |
| `TEAM_DISPOSAL_TIMEOUT` | 一次 runtime 结算超过 `disposalTimeoutMs` | `agent-team/lib/index.js:227` |
| `TEAM_INVALID_ARGUMENT` | `subject`/`description`/成员 `description`/`provider` 去空格后为空或超长；重复 blocker；`edit` 未给 `subject`/`description`/`write_scopes` 任一；`set_dependencies` 未给 `blocked_by`；未知 action | `agent-team/lib/index.js:324`、`agent-team/lib/index.js:325`、`agent-team/lib/index.js:1555`、`agent-team/lib/index.js:1565`、`agent-team/lib/index.js:1617`、`agent-team/lib/index.js:1638` |
| `TEAM_INVALID_WRITE_SCOPE` | write scope 规范化后为空、以 `/` 开头、形如盘符 `x:`、或含空段/`.`/`..` | `agent-team/lib/index.js:336` |
| `TEAM_INVALID_MEMBER_NAME` | 名字不匹配 `^[a-z0-9]+(?:-[a-z0-9]+)*$`（**形态定义**：名字正则常量在 `agent-team/lib/index.js:342`）、长度 > 64、或等于 `lead` | `agent-team/lib/index.js:704`（抛出点） |
| `TEAM_INVALID_CONFIG` | 任一部署限制不是正的安全整数 | `agent-team/lib/index.js:1676` |
| `TEAM_INVALID_TARGET` | Lead 试图 interrupt 自己（名字解析为 `lead`） | `agent-team/lib/index.js:508` |
| `TEAM_NOT_MEMBER` | 调用 Agent 不属于任何活跃 Team | `agent-team/lib/index.js:389` |
| `TEAM_LEAD_REQUIRED` | 非 Lead 调用 spawn、interrupt 或 reassign | `agent-team/lib/index.js:546`、`agent-team/lib/index.js:505`、`agent-team/lib/index.js:1588` |
| `TEAM_SELF_MESSAGE` | 成员给自己发消息（`target.id === caller.id`） | `agent-team/lib/index.js:824` |
| `TEAM_MAILBOX_FULL` | 某 target 的 pending（queued 且未 delivered）消息数已达 `maxPendingMessagesPerMember` | `agent-team/lib/index.js:826` |
| `TEAM_MESSAGE_TOO_LARGE` | **加发送者前缀后的完整投递内容**序列化后 UTF-8 字节数超过 `maxMessageBytes` | `agent-team/lib/index.js:834` |
| `TEAM_MEMBER_NOT_FOUND` | 按名字找不到处于 `active` 的队友（含名字只存在于 `provisioning`/`failed` 记录的情况） | `agent-team/lib/index.js:357` |
| `TEAM_MEMBER_NAME_TAKEN` | 名字在本 Team 的 roster 里已存在——**包括 `failed` 的成员，名字永不复用** | `agent-team/lib/index.js:563` |
| `TEAM_MEMBER_LIMIT` | roster 条目数（含 failed）已达 `maxMembers` | `agent-team/lib/index.js:564` |
| `TEAM_PROVISIONING_CONFLICT` | `provisioning` 期间的成员记录消失；初始 prompt 未被持久接受；恢复把创建中的成员对账为 `failed`（或反向：creator 报错后恢复出 `active`） | `agent-team/lib/index.js:623`、`agent-team/lib/index.js:712`、`agent-team/lib/index.js:604`、`agent-team/lib/index.js:593` |
| `TEAM_TASK_NOT_FOUND` | 任务不存在（`get`/`update`），或 `blocked_by` 指向不存在/已删除的任务 | `agent-team/lib/index.js:1501`、`agent-team/lib/index.js:1526`、`agent-team/lib/index.js:1640` |
| `TEAM_TASK_LIMIT` | 非 deleted 任务数已达 `maxTasks`；或 `task-<n>` id 空间耗尽 | `agent-team/lib/index.js:1470`、`agent-team/lib/index.js:1472` |
| `TEAM_TASK_STALE_REVISION` | CAS 的 `expected_revision` 与当前 revision 不符（**优先级最高**，排在 deleted 检查之前） | `agent-team/lib/index.js:1527` |
| `TEAM_TASK_DELETED` | 对已删除（tombstone）任务做任何 update，**包括再次 `delete`**；revision 先匹配才会走到这里 | `agent-team/lib/index.js:1528` |
| `TEAM_TASK_UNAUTHORIZED` | 变更任务既不是 Lead、也不是该任务 owner | `agent-team/lib/index.js:1532` |
| `TEAM_TASK_ALREADY_CLAIMED` | 任务已被**别的**成员 claim | `agent-team/lib/index.js:1537` |
| `TEAM_TASK_BLOCKED` | `claim` 时任务非 `pending` 或还有未完成 blocker；`reassign` 时给了非空 owner 但任务仍未就绪（delete **不会**触发本码） | `agent-team/lib/index.js:1538`、`agent-team/lib/index.js:1597` |
| `TEAM_TASK_INVALID_TRANSITION` | 非法状态迁移：`release` 非 in_progress；`complete` 非 in_progress；`reopen` 非 completed；`reassign` 目标状态不是 pending/in_progress | `agent-team/lib/index.js:1547`、`agent-team/lib/index.js:1573`、`agent-team/lib/index.js:1581`、`agent-team/lib/index.js:1589` |
| `TEAM_TASK_HAS_DEPENDENTS` | `delete` 时仍有其它未删除任务把它列为 blocker | `agent-team/lib/index.js:1609` |
| `TEAM_TASK_DEPENDENCY_CYCLE` | 自依赖，或替换快照后在活跃任务图上成环（**图校验违规点**：`agent-team/lib/index.js:1027` 抛 `TeamTaskGraphError("cycle")`，抛出的不是本码） | `agent-team/lib/index.js:1637`（抛出点：自依赖）、`agent-team/lib/index.js:1446`（**映射点**：graph 层 `cycle` 违规 → 本码） |

**非 `TEAM_*` 的失败路径**（同样会影响调用方，文档与脚本都要复刻）：

- `team_task_list` 的 `cursor`/`limit` 非法 → 普通 `Error`（无 `code`），`tool-agent-team/lib/index.js:437-438`。
- 工具拿不到调用 Agent → 普通 `Error("<toolName> requires a calling Agent")`（`tool-agent-team/lib/index.js:226`）。
- 创建失败且持久失败记录也失败 → `AggregateError`（`agent-team/lib/index.js:595`）；dispose 清理失败 → `AggregateError`（`agent-team/lib/index.js:1866`）。
- 投影拒绝一条持久 Team 记录时不抛给模型，而是把 `failure` 留在 `agentTeam` 投影里（`agent-team/lib/index.js:1277-1283`、`agent-team/lib/index.js:1429-1439`）。

## 7. 交叉引用

- 团队模型（身份、roster、mailbox、dispose、限制）见 [team-model.md](team-model.md)。
- 任务板字段、CAS 与 action 矩阵、DAG readiness 见 [task-board.md](task-board.md)。
- Codex 侧如何用 `scripts/agent-team.mjs` 复刻这 9 个工具见 [codex-runtime.md](codex-runtime.md)。
