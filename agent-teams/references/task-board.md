# 共享任务板（task board）

本文件说明 Agent Teams 任务板的数据模型、CAS 语义、8 个 action 的状态机、DAG 校验与 advisory write scope。所有论断来自官方源码，末尾为引用约定。

## 1. 引用约定

本文的行号引用使用以下短名（对应官方源码真源，只读）：

| 短名 | 实际路径 |
|---|---|
| `agent-team/lib/index.js:N` | `C:\Users\UserX\.dsh\profiles\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\dsh-experimental-agent-team\lib\index.js:N`（打包产物） |
| `agent-team/lib/types/<m>.js:N` | 上述包内 `lib/types/<m>.js:N`（同名模块源，与打包产物语义一致） |
| `tools/lib/index.js:N` | `...\@deepseek-ai\dsh-experimental-tool-agent-team\lib\index.js:N` |
| `README.zh.md:N` | `...\@deepseek-ai\dsh-experimental-agent-team\README.zh.md:N` |
| `profile/cordis.patch.yml:N` | `...\@deepseek-ai\dsh-experimental-agent-team-profile\cordis.patch.yml:N` |

## 2. TASK_VIEW：模型可见的任务形状

任务在**持久层**是完整版本化快照（`TeamTaskSnapshot`），在**模型可见层**是派生视图 `TASK_VIEW`。视图永远是"快照 + 当前 state 派生"的结果，不是存储的值。

| 字段 | 类型 | 语义 | 来源 |
|---|---|---|---|
| `id` | string | 形如 `task-<n>` | `agent-team/lib/types/task-board.js:39` |
| `revision` | int ≥ 1 | 单调递增；创建时恒为 1 | `agent-team/lib/types/task-board.js:45` |
| `subject` | string | 必填，trim 后 1–200 字符 | `agent-team/lib/types/task-board.js:46`、`validation.js:10-18` |
| `description` | string | 必填，trim 后 1–16384 字符 | `agent-team/lib/types/task-board.js:47` |
| `status` | enum | `pending` \| `in_progress` \| `completed` \| `deleted` | `agent-team/lib/types/projection.js:60` |
| `ownerName?` | string | **可选**；无 owner 时整字段缺失 | `agent-team/lib/types/task-view.js:52` |
| `blockedBy` | string[] | 直接 blocker 的 task id 列表 | `agent-team/lib/types/task-view.js:50` |
| `writeScopes` | string[] | 规范化去重后的 workspace 相对前缀 | `agent-team/lib/types/task-view.js:51` |
| `ready` | bool | 见第 4 节，**不是**"blocker 都完成" | `agent-team/lib/types/task-view.js:53` |
| `writeScopeWarnings` | string[] | advisory 重叠警告 | `agent-team/lib/types/task-view.js:54` |

关键点：

- **`ownerId` 永不外露。** 派生视图只输出 `ownerName`，且 `ownerName` 由持久 `ownerId` 反查得到：`ownerId === state.id`（即 Lead 会话 id）时是字面量 `'lead'`；否则在 roster 里按 `id` 找 `name`；找不到时该字段整体缺失（`agent-team/lib/types/task-view.js:31-35`、`agent-team/lib/types/task-view.js:52`）。
- 工具层 `TASK_VIEW_SCHEMA` 声明 `additionalProperties: false`，除 `ownerName` 外全部 `required`（`tools/lib/index.js:80-132`）。
- 因此 `reassign` 把 owner 指到 `"lead"` 时，视图里出现 `ownerName: "lead"`，而任务确实挂在 Lead 会话 id 上（`agent-team/lib/types/roster.js:20-21` 把 `"lead"` 解析为 `root.id`）。
- 视图是**派生**的：`getTask` / `listTasks` 每次调用都从当前 state 重新投影（`agent-team/lib/types/task-board.js:63-82`）。所以兄弟任务的状态变化会改变**已存在任务**的 `ready` 与 `writeScopeWarnings`，而**不会**改变它的 `revision`。

## 3. CAS：revision 与 expectedRevision

- 每次成功的变更都写入 `revision = current.revision + 1`（`agent-team/lib/types/task-board.js:186-189`），并把整份新快照作为一条 `team/task` 事件 append + flush（`agent-team/lib/types/task-board.js:191`、`agent-team/lib/types/journal.js:53-61`）。
- 回放层强制 revision **连续**：新 id 必须 `revision === 1`；已有 id 必须 `revision === prior + 1`（`agent-team/lib/types/projection.js:212-217`）。任何跳号会让整个投影进入 `failure`（`agent-team/lib/types/projection.js:171-174`）。
- `team_task_update` 的 `expected_revision` 是**必填**的 CAS 前置条件（`tools/lib/index.js:467-471`）。不等即拒：`TEAM_TASK_STALE_REVISION`，消息含旧值与当前值（`agent-team/lib/types/task-board.js:97-99`）。
- 事务串行化：同一 Lead 的所有 read-check-append 走同一条 promise 尾链（`agent-team/lib/types/journal.js:34-46`）。这保证**单进程内**不会两个成员同时基于同一 revision 提交；**不是**跨进程共识（见第 9 节）。

### 3.1 update 的检查顺序（动手前必读）

所有 8 个 action 共享同一段前置检查，顺序固定，**先命中先抛**：

| 序 | 检查 | 错误码 | 来源 |
|---|---|---|---|
| 0 | 调用者不是活跃 Team 成员 | `TEAM_NOT_MEMBER` | `agent-team/lib/types/roster.js:55`（在事务之前，`agent-team/lib/index.js:1809`） |
| 1 | 按 `task_id` 找不到任务 | `TEAM_TASK_NOT_FOUND` | `agent-team/lib/types/task-board.js:95-96` |
| 2 | `revision !== expected_revision` | `TEAM_TASK_STALE_REVISION` | `agent-team/lib/types/task-board.js:97-99` |
| 3 | `status === 'deleted'` | `TEAM_TASK_DELETED` | `agent-team/lib/types/task-board.js:100-101` |
| 4 | 进入 action switch，做授权与状态检查 | 见第 5 节 | `agent-team/lib/types/task-board.js:109-185` |

推论（务必记住）：

- **顺序 2 早于顺序 3。** 对已删除任务用过期 revision 提交，报的是 `TEAM_TASK_STALE_REVISION`，不是 `TEAM_TASK_DELETED`。
- **`delete` 不幂等。** 顺序 3 对所有 action 生效，**包括再次 `delete`**：对已 `deleted` 的任务再 delete 得到 `TEAM_TASK_DELETED`。源码里没有任何 delete 例外分支。
- 变更成功后还会跑一次全图校验（`agent-team/lib/types/task-board.js:190`），理论上可能再抛出第 7 节的图错误码，但正常路径上不会。

## 4. ready 的判定

完整定义只有一行：

```
ready = (task.status === 'pending') && task.blockedBy.every(id => state.tasks.find(t => t.id === id)?.status === 'completed')
```

`agent-team/lib/types/task-view.js:18-20` 与 `agent-team/lib/types/task-view.js:53`。

由此得到三个容易写错的事实：

1. **非 `pending` 的任务 `ready` 恒为 `false`**，即使它 `blockedBy` 为空。`in_progress` / `completed` / `deleted` 一律 `ready: false`。
2. `blockedBy` 为空数组时 `every` 返回 `true`，所以一个无依赖的 `pending` 任务 `ready: true`。
3. readiness 只统计**直接** blocker 的 `status === 'completed'`，不做递归求值。传递性来自"blocker 必须先 in_progress 才能 completed"这条状态机约束，而不是 readiness 函数本身。【推断】

`team_task_list` 的 `ready` 过滤器作用在派生视图上（`tools/lib/index.js:434`），所以 `--ready true` 只会返回"pending 且依赖已完成"的任务。

## 5. action 矩阵（8 个 action，逐条来自源码）

`authorizeOwner()` 的语义：调用者是其 owner **或** Team Lead 才放行，否则 `TEAM_TASK_UNAUTHORIZED`（`agent-team/lib/types/task-board.js:104-107`）。`lead` = `membership.role === 'lead'`，`owner` = `current.ownerId === caller.id`（`agent-team/lib/types/task-board.js:102-103`）。

| action | 合法前置状态 | 谁可以调用 | 成功后的状态迁移 | 可能的错误码 | 备注 |
|---|---|---|---|---|---|
| `claim` | `pending` 且 `ready === true`；且 owner 为空或就是自己 | **任意成员**（含 Lead）。此分支**不**调用 `authorizeOwner` | `pending` → `in_progress`；`ownerId = caller.id` | `TEAM_TASK_ALREADY_CLAIMED`（有 owner 且非自己）、`TEAM_TASK_BLOCKED`（`status !== 'pending'` 或 `!ready`） | 先判 ALREADY_CLAIMED 再判 BLOCKED（`task-board.js:111-116`）。任务是自己的但已 `completed` → 报 `TEAM_TASK_BLOCKED` |
| `release` | `in_progress` | owner 或 Lead | `in_progress` → `pending`；**删除** `ownerId` | `TEAM_TASK_UNAUTHORIZED`、`TEAM_TASK_INVALID_TRANSITION` | 授权先于状态检查（`task-board.js:119-123`） |
| `edit` | **任意**非 `deleted` 状态 | owner 或 Lead | 状态不变；按给定字段局部替换 | `TEAM_TASK_UNAUTHORIZED`、`TEAM_INVALID_ARGUMENT`（三个字段都缺 / 文本空 / 超长）、`TEAM_INVALID_WRITE_SCOPE` | 只接受 `subject`(≤200)、`description`(≤16384)、`write_scopes`（`task-board.js:125-138`）。`blocked_by` 与 `owner` 被**静默忽略**。可编辑 in_progress / completed 任务 |
| `set_dependencies` | **任意**非 `deleted` 状态 | owner 或 Lead | 状态不变；**整体替换** `blockedBy` | `TEAM_TASK_UNAUTHORIZED`、`TEAM_INVALID_ARGUMENT`（`blocked_by` 未提供 / 重复 id）、`TEAM_TASK_NOT_FOUND`（blocker 不存在或已删除）、`TEAM_TASK_DEPENDENCY_CYCLE`（自依赖或成环） | 无状态限制：可给 in_progress / completed 任务加依赖。传空数组即清空依赖（`task-board.js:139-144`） |
| `complete` | `in_progress` | owner 或 Lead | `in_progress` → `completed`；**保留** `ownerId` | `TEAM_TASK_UNAUTHORIZED`、`TEAM_TASK_INVALID_TRANSITION` | `task-board.js:145-150`。owner 不会被自动释放 |
| `reopen` | `completed` | owner 或 Lead | `completed` → `pending`；**删除** `ownerId` | `TEAM_TASK_UNAUTHORIZED`、`TEAM_TASK_INVALID_TRANSITION` | `task-board.js:151-156`。不检查依赖者；重新 `ready` 仍取决于 blocker |
| `reassign` | `pending` 或 `in_progress` | **仅 Lead** | `owner` 缺失/空 → `pending` 且删除 `ownerId`；`owner` 非空且 `ready` → `in_progress`，`ownerId = assignee.id` | `TEAM_LEAD_REQUIRED`（先判，`task-board.js:158-159`）、`TEAM_TASK_INVALID_TRANSITION`、`TEAM_TASK_BLOCKED`（非空 owner 但 `!ready`）、`TEAM_MEMBER_NOT_FOUND` | 非 Lead 对 `completed` 任务 reassign 报 `TEAM_LEAD_REQUIRED` 而非 INVALID_TRANSITION。**清空 owner 的那条路径不检查 readiness**（`task-board.js:163-166`）。`owner: "lead"` 合法，目标解析为 Lead 会话 id（`roster.js:18-27`） |
| `delete` | **任意**非 `deleted` 状态 | owner 或 Lead | 任意状态 → `deleted`（tombstone） | `TEAM_TASK_UNAUTHORIZED`、`TEAM_TASK_HAS_DEPENDENTS` | 只做 owner 授权 + 依赖者检查（`task-board.js:173-181`）。**不检查自身 readiness，绝不报 `TEAM_TASK_BLOCKED`**。已完成任务也能删。再次 delete → `TEAM_TASK_DELETED` |
| （未知 action） | — | — | — | `TEAM_INVALID_ARGUMENT` | `task-board.js:182-184`。工具层 `enum` 已封闭该集合（`tools/lib/index.js:472-486`），模型无法触达 |

`TEAM_TASK_BLOCKED` 全书只有**两个**触发点：`claim`（`agent-team/lib/types/task-board.js:114-116`）与"`reassign` 给了非空 owner 且 `!taskReady`"（`agent-team/lib/types/task-board.js:167-168`）。

另外三点作用域提醒：

- `TEAM_TASK_STALE_REVISION` / `TEAM_TASK_DELETED` / `TEAM_TASK_NOT_FOUND` 对**全部 8 个 action** 生效（第 3.1 节）。
- `TEAM_TASK_UNAUTHORIZED` 只覆盖 `release` / `edit` / `set_dependencies` / `complete` / `reopen` / `delete` 六个分支；`claim` 与 `reassign` 不经过 `authorizeOwner`。
- `create` 不分 action：任何活跃成员都能建任务，建出来永远是**无 owner 的 `pending`**，`revision = 1`（`agent-team/lib/types/task-board.js:26`、`:43-51`）。

### 5.1 状态机总览

```
              create
                │
                ▼
   ┌────────> pending ──claim──> in_progress ──complete──> completed
   │            │  ▲                  │                        │
   │  reassign  │  │  release         │  delete                │ reopen
   │ (清空owner)│  └──────────────────┘     │                  │
   └────────────┘                            ▼                  └──> pending
                                          deleted (tombstone)
```

`delete` 可从 `pending` / `in_progress` / `completed` 任意一个状态出发；`edit` 与 `set_dependencies` 不改变状态，因此不出现在上图。

## 6. writeScopes：规范化、去重与 advisory 重叠

### 6.1 规范化规则（`agent-team/lib/types/validation.js:24-32`）

按顺序执行：

1. `\` 全部替换为 `/`。
2. 剥掉**至多一个**开头的 `./`。
3. 剥掉末尾所有 `/`。
4. 若满足以下任一条件即 `TEAM_INVALID_WRITE_SCOPE`：结果为空串；以 `/` 开头；匹配 `/^[a-z]:/iu`（盘符，大小写不敏感）；任一 `/` 分段为空串、`"."`、`".."`。

因此：`a/` 合法（等价 `a`）；`./a` 合法；`a//b` 非法（空段）；`a/../b` 非法；`"."` 非法；`C:\x`、`/abs` 非法。规则**不**校验 `~`、空格、`*` 等字符——只有上述四类被拒。创建与 `edit` 都走同一个函数（`agent-team/lib/types/task-board.js:50`、`:136`、`:213-216`）。

### 6.2 去重

`writeScopes()` 用 `new Set(values.map(writeScope))` 去重，保留首次出现顺序（`agent-team/lib/types/task-board.js:213-216`）。

### 6.3 重叠警告（advisory，绝不阻止）

- 重叠判定：`l === r || l.startsWith(r + '/') || r.startsWith(l + '/')`（`agent-team/lib/types/task-view.js:9-11`），即"相等或互为路径前缀"。
- 只在**另一个任务 `status === 'in_progress'`** 且 id 不同时比较（`agent-team/lib/types/task-view.js:38`）。
- 警告文本固定为 ``write scopes overlap with ${other.id}``，用 `Set` 去重（`agent-team/lib/types/task-view.js:36`、`:41`、`:54`）。
- 该警告在**投影时**计算，被查看任务自己处于什么状态都会算（一个 `pending` 任务也可能带警告），且**不**阻止 `claim`、**不**授予任何写权限（`README.zh.md:139`）。
- 因为不是 claim 时门禁，重叠的两个任务完全可能都已经 `in_progress`——警告只是事后提示。**write scope 不是锁。**

## 7. DAG 校验

`assertTaskGraphCandidate(current, candidate)` 把 candidate 覆盖进当前全量任务后，**校验整张图**（`agent-team/lib/types/task-graph.js:21-61`）：

| 违规 | 检测 | 抛出的图错误 | 映射到命令错误码 |
|---|---|---|---|
| 自依赖 | `blockerId === task.id` | `cycle` | `TEAM_TASK_DEPENDENCY_CYCLE` |
| 重复 blocker | 同一任务的 `seen` 集合命中 | `duplicate` | `TEAM_INVALID_ARGUMENT` |
| blocker 缺失 | `tasks.get(id)` 为 `undefined` **或**其 `status === 'deleted'` | `missing` | `TEAM_TASK_NOT_FOUND` |
| 成环 | DFS：`visiting` 集合命中 | `cycle` | `TEAM_TASK_DEPENDENCY_CYCLE` |

映射表在 `agent-team/lib/types/task-board.js:8-12`，转换点 `agent-team/lib/types/task-board.js:217-228`。校验时跳过 `status === 'deleted'` 的任务（`agent-team/lib/types/task-graph.js:25-26`、`:51-52`）。

写 blocker 时还有一道**更早**的逐项检查，在 `dependencies()` 里（`agent-team/lib/types/task-board.js:195-212`），顺序为：自依赖 → 重复 → 存在性。所以：

- `create` 阶段自依赖不可达（`self` 为 `undefined`，`id === undefined` 恒假），但 blocker 缺失/已删除在这里就报 `TEAM_TASK_NOT_FOUND`（`agent-team/lib/types/task-board.js:49`、`:204-207`）。
- `set_dependencies` 传自己的 id → 立即 `TEAM_TASK_DEPENDENCY_CYCLE`（`agent-team/lib/types/task-board.js:200-201`）。
- 传递成环（如 A→B→C→A）只能被全图 DFS 抓到。

同一套校验在**回放侧**再跑一次（`agent-team/lib/types/projection.js:218`）：若日志里出现非法图，整个 Team 投影会置为 `failure`（`agent-team/lib/types/projection.js:158-174`），此后所有读取都抛错。这是"日志即真源 + 提交前校验"的双保险。

## 8. 上限、id 空间与 tombstone

### 8.1 maxTasks

`create` 先数**非 deleted** 任务，达到上限即 `TEAM_TASK_LIMIT`（`agent-team/lib/types/task-board.js:35-38`）：

```
active = state.tasks.filter(t => t.status !== 'deleted').length
if (active >= maxTasks) throw TEAM_TASK_LIMIT
```

上限来源：profile 实际配 `maxTasks: 256`（`profile/cordis.patch.yml:21`），包默认 `DEFAULT_MAX_TASKS = 256`（`agent-team/lib/index.js:1670`），配置项必须是正整数否则 `TEAM_INVALID_CONFIG`（`agent-team/lib/index.js:1675-1677`）。

### 8.2 id 形态与耗尽

- id 由 `task-${state.nextTaskNumber}` 生成（`agent-team/lib/types/task-board.js:39`）。
- `nextTaskNumber` 初值 1（`agent-team/lib/types/projection.js:109`），每提交一条 `team/task` 事件按 `max(当前, n + 1)` 单调推进（`agent-team/lib/types/projection.js:219-224`）。
- 关键：推进依据是**事件里的 id**，与任务是否被删除无关。**tombstone 照样消耗编号。**
- 若生成的 id 在 `state.tasks`（**含 tombstone**）中已存在，报 `TEAM_TASK_LIMIT`，消息为 `Team task id space exhausted`（`agent-team/lib/types/task-board.js:40-42`）。
- 触发路径：当编号抵达 `Number.MAX_SAFE_INTEGER` 时 `nextTaskNumber` 不再前进（`agent-team/lib/types/projection.js:223`），下一次 create 必然撞上同一 id → `TEAM_TASK_LIMIT`。所以 id 空间耗尽的语义是"**绝不复用最后一个 id**"，而不是"随便复用"（`README.zh.md:139`）。
- id 形状校验另在 schema 层：非空字符串都接受，但**若**匹配 `/^task-(\d+)$/` 则数字后缀必须是安全整数（`agent-team/lib/types/projection.js:11-15`）。

### 8.3 tombstone 语义

| 行为 | 结果 | 来源 |
|---|---|---|
| `team_task_list` | 不返回已删除任务 | `agent-team/lib/types/task-board.js:79-81`；wire 视图同样过滤，`projection.js:290` |
| `team_task_get` | **仍可读到** tombstone（`status: 'deleted'`） | `agent-team/lib/types/task-board.js:58`、`:63-69` |
| 占 `maxTasks` | **不占** | `agent-team/lib/types/task-board.js:35` |
| id 复用 | **永不复用** | `agent-team/lib/types/projection.js:219-224` |
| 再变更 | 任何 action（含再 delete）都报 `TEAM_TASK_DELETED` | `agent-team/lib/types/task-board.js:100-101` |
| 作为 blocker | 引用已删除任务即 `TEAM_TASK_NOT_FOUND` | `agent-team/lib/types/task-graph.js:36-37` |
| 删除时仍有依赖者 | `TEAM_TASK_HAS_DEPENDENTS`（只检查非 deleted 且 `blockedBy` 含它的任务） | `agent-team/lib/types/task-board.js:175-178` |

`team_task_list` 的 `status` 过滤器枚举里**没有** `deleted`（`tools/lib/index.js:405-412`），所以无法用 `status=deleted` 列出 tombstone，只能按 id 用 `team_task_get` 取。

### 8.4 分页

先按 `status` / `owner`（`unowned` 匹配 `ownerName === undefined`）/ `ready` 过滤，再 `slice(cursor, cursor + limit)`，仅当 `cursor + limit < filtered.length` 时返回 `nextCursor: cursor + limit`（`tools/lib/index.js:434-442`）。`cursor` 必须是非负安全整数、`limit` 必须 1–100，否则抛**普通 `Error`**（不是 `TeamError`）（`tools/lib/index.js:437-438`）。

## 9. 边界与限制

- **单进程内归属。** 事务串行化只覆盖同一进程的同一 Lead（`agent-team/lib/types/journal.js:34-46`）；不支持多进程并发操作同一 Team（`README.zh.md:32`）。
- **不会自动释放 owner。** 成员失活、`interrupt_agent`、进程退出、任务失败，都不会释放任务 owner（`README.zh.md:209`）。要移交必须显式 `reassign` 或 `release`。
- **readiness 不会启动任何人。** blocker 完成不会自动唤醒 owner，也不会自动启动 pending 任务的执行者。
- **CAS 是乐观并发控制，不是锁。** 过期提交被拒，调用方必须重新 `get` 并用新 revision 重试。
- 任务状态与 roster/mailbox 一样，从 Lead 会话日志回放派生；`team/task` 事件**不进入**模型对话历史（`README.zh.md:147`、`README.zh.md:191`）。
