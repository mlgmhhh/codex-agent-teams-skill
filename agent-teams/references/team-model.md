# Agent Teams 团队模型参考

本文件描述 Agent Teams 的**领域语义**：身份、持久日志、roster 生命周期、mailbox、interrupt、dispose、上限与已知限制。
工具层的参数与结果形状见 [protocol.md](protocol.md)，任务板细节见 [task-board.md](task-board.md)。

行号别名与 [protocol.md](protocol.md) 第 0 节相同（`tool-agent-team/lib/index.js`、`agent-team/lib/index.js`、`agent-team/lib/types/x.js`、`agent-team/lib/invariant.js`、`profile/cordis.patch.yml`、`agent-team/README.zh.md`）。

## 1. 身份模型

- **Team 是隐式的、不是创建出来的对象**：每个普通运行时 root Session 都是一个隐式 Team 的 Lead，`TeamId === SessionId`；不存在"创建 Team"事件，持久状态从第一条成员/消息/任务记录开始（`agent-team/lib/index.js:293-295`、`agent-team/README.zh.md:129`）。
- `TeamTaskId` / `TeamMessageId` 与 `TeamId` 一样只是 brand 包装，不改变字符串本身（`agent-team/lib/index.js:301-303`、`agent-team/lib/index.js:309-311`）。
- **调用方 Agent 本身就是权限凭证**：每个服务方法都接收"确切的实时调用方 `Agent`"，`tryMembership` 会先用 `ctx.agents.get(agent.id) !== agent` 判定该身份是否仍然实时（`agent-team/lib/index.js:398`、`agent-team/README.zh.md:107`）。过期或伪造的 Agent 直接不算成员。
- 成员关系解析 `tryMembership`（`agent-team/lib/index.js:397-430`）：
  1. Agent 有 `session.header.parentSession`，且父 Agent 仍在注册表里 → 在 Lead 的 roster 中按 id 找该成员；若 `phase` 是 `active` 或 `provisioning`，返回 `{role: "teammate"}`（`agent-team/lib/index.js:404-410`）。
  2. 该 Agent 自身带 subagent descriptor（provider 自有的子代理）→ 不算 Team 成员，返回 `undefined`（`agent-team/lib/index.js:411`、`agent-team/lib/index.js:420`、`agent-team/lib/index.js:723-725`）。
  3. 其它情况一律是 Lead：`{root: agent, id: TeamId(agent.id), role: "lead", name: "lead"}`（`agent-team/lib/index.js:412-426`）。
- `membership()` 是抛错版本，非成员报 `TEAM_NOT_MEMBER`（`agent-team/lib/index.js:387-391`）。
- **Lead 的模型可见名字恒为 `"lead"`**；`resolveActiveMember` 先把入参 `trim()`，遇到 `"lead"` 直接映射到 root 的 id，否则在 roster 里找 `phase === "active"` 的队友，找不到报 `TEAM_MEMBER_NOT_FOUND`（`agent-team/lib/index.js:350-362`）。
- `listMembers` 的展示顺序是 Lead 行在前、teammate 按创建顺序（`agent-team/lib/index.js:436-463`）。成员行的 `status` 推导规则是 `failed` > `provisioning` > 实时可用性，而可用性只看 `agent.status === "running"`，否则 `inactive`（`agent-team/lib/index.js:454`、`agent-team/lib/index.js:728-730`）。**`inactive` 与 Agent 是否已加载无关**，只表示当前没有轮次在执行（`agent-team/README.zh.md:63`）。

## 2. 持久日志，派生状态

这是整个实现的中心原则：**Lead 会话日志是唯一真源；roster、mailbox 与任务状态每次读取都从中回放**（`agent-team/README.zh.md:105`、`agent-team/README.zh.md:147`）。

- `TeamJournal.transact(rootId, op)` 用一条 Promise 尾链把**同一个 Lead** 的读-检查-追加操作串行化（`agent-team/lib/index.js:140-149`）；`appendAndFlush` 的顺序是 `session.append` → `sessions.flush` → `onCommit(root)`，即**先落盘、后通知**（`agent-team/lib/index.js:156-160`）。
- Team 只有 4 类会话事件，均为 `version: 2`：`team/member`、`team/task`、`team/message/queued`、`team/message/delivered`（`agent-team/lib/index.js:1235-1237`、`agent-team/lib/types/types.d.ts:186-213`）。
- 这些事件**只存在于日志**，从不进入会话表面，因此派生模型历史（发给模型的对话）不受协作记录影响（`agent-team/README.zh.md:147`）；顺序与时间由会话事件的 `seq`/`time` 负责。
- `agentTeam` 投影的 key 为 `agentTeam`、`stateVersion: 4`，其 `apply` 是纯函数：解码 + 校验 + 替换被触及的集合（`agent-team/lib/index.js:1429-1439`、`agent-team/lib/index.js:1269-1284`）。
- 投影是**严格**的，违反不变量的记录会写入 `failure`，之后所有事件都不再改变状态（失败是终态的）（`agent-team/lib/index.js:1270`、`agent-team/lib/index.js:1277-1284`、`agent-team/lib/index.js:1414-1427`）。强制的结构性约束包括：
  - 新成员必须先以 `provisioning` 出现；已存在成员的 `name`/`provider`/`context` 不可变；只允许 `provisioning → active|failed`，不允许回到 `provisioning`（`agent-team/lib/index.js:1298-1304`）。
  - 新任务 revision 必须为 1，且之后每次 +1 连续递增（`agent-team/lib/index.js:1314-1315`）。
  - 同一条消息不能 queued 两次、不能重复 delivered、不能 delivered 早于 queued、target 不能改（`agent-team/lib/index.js:1331`、`agent-team/lib/index.js:1339-1341`）。
  - 名字不能在同一 Team 内被另一个成员复用（`agent-team/lib/index.js:1297-1298`）。
- `agent-team/lib/invariant.js` 是把上述约束变成运行时不变式的伴生插件：它挂在 `internal/dispatch` 的 `session/event` 上，在 append 前把候选事件对照已提交前缀回放，一旦得到 `failure` 就让运行时报错（`agent-team/lib/invariant.js:484-502`、`agent-team/README.zh.md:147`）。
- 客户端广播粒度：`teamProjectionView` 用 `members`/`tasks` 两个集合引用做缓存键，**仅邮箱变化会复用旧视图引用、不产生 frame**（`agent-team/lib/index.js:1406-1427`、`agent-team/README.zh.md:177`）。

## 3. 进程内归属保证

- 所有协作都在单一进程内；保证是**重试 + 去重**，绝不是跨进程共识（`agent-team/README.zh.md:106`、`agent-team/README.zh.md:133`、`agent-team/README.zh.md:210`）。
- 机制上确实如此：串行化用的是进程内的 Promise 尾链（`agent-team/lib/index.js:141-149`、`agent-team/lib/index.js:878-890`），去重用进程内 `inFlightMessages`/`inFlightDispatches` Set（`agent-team/lib/index.js:742-744`、`agent-team/lib/index.js:852-862`）加目标会话的持久消息身份（`agent-team/lib/index.js:967-969`）。
- 【推断】因为没有任何跨进程锁或仲裁，两个 harness 进程同时操作同一个 Lead 会话日志不在支持范围内（README 明确列为已知限制，`agent-team/README.zh.md:210`）。
- 【待确认】进程崩溃时"已追加但未 flush"的 Team 事件如何恢复，取决于会话持久化实现，官方 Team 文档未逐字规定。

## 4. roster 生命周期

### 4.1 创建（`spawn`/`spawnAdmitted`，`agent-team/lib/index.js:470-479`、`agent-team/lib/index.js:544-614`）

固定顺序：

1. 准入检查：`lifecycle.disposed` 时直接报 `TEAM_DISPOSED`（`agent-team/lib/index.js:471`）。
2. 解析调用方成员关系；非 Lead 报 `TEAM_LEAD_REQUIRED`（`agent-team/lib/index.js:545-546`）。
3. 合并 `request.signal` 与 runtime lifecycle signal（`agent-team/lib/index.js:547-548`）。
4. 校验名字（`memberName`）与 `description`（去空格后非空、≤ 200 字符），生成 `childId = randomUUID()`，构造 `phase: "provisioning"` 的成员快照（`agent-team/lib/index.js:550-560`）。
5. 在 Lead 日志事务里：名字已存在 → `TEAM_MEMBER_NAME_TAKEN`；roster 条目数达 `maxMembers` → `TEAM_MEMBER_LIMIT`；否则**追加并 flush 一条 `provisioning` 记录**（`agent-team/lib/index.js:561-570`）。
6. 让配置的 provider 创建预留 child（`subagents.startContinuable`），并 `checkpointInitialPrompt` 确认初始 user 消息已被**持久接受**（`agent-team/lib/index.js:573-583`、`agent-team/lib/index.js:616-650`）。
7. 落终态：`settleProvisioning` 只在当前仍是 `provisioning` 时追加 `active`/`failed`，因此恢复与 creator 竞争时只会有一个终态生效（`agent-team/lib/index.js:599-613`、`agent-team/lib/index.js:708-721`）。

失败路径：provider 抛错 → 追加 `failed` 成员（带 `error` 文本）→ 释放该 child → 若期间已被恢复对账为 `active` 则改报 `TEAM_PROVISIONING_CONFLICT`；创建失败与失败记录失败同时发生时报 `AggregateError`（`agent-team/lib/index.js:584-598`）。

### 4.2 名字规则与永不复用

- 合法名字匹配 `^[a-z0-9]+(?:-[a-z0-9]+)*$`（**形态定义**：名字正则常量在 `agent-team/lib/index.js:342`）、长度 ≤ 64、且不能是 `lead`，否则 `TEAM_INVALID_MEMBER_NAME`（抛出点 `agent-team/lib/index.js:704`）。
- 重名检查针对**整个 roster**，包括 `phase: "failed"` 的条目，所以**失败的 teammate 也永久保留名字，任何名字都永不复用**（`agent-team/lib/index.js:563`、`agent-team/lib/index.js:1297-1298`、`agent-team/README.zh.md:61`、`agent-team/README.zh.md:129`）。这个规则同样由投影不变量兜底（`agent-team/lib/index.js:1297-1298`）。

### 4.3 恢复对账（`reconcileProvisioning`，`agent-team/lib/index.js:652-686`）

任何 Lead Agent 启动时（`agent/created` 或构造期遍历）都会调度一次恢复（`agent-team/lib/index.js:1723-1725`、`agent-team/lib/index.js:1740`、`agent-team/lib/index.js:1840-1848`）。对账只处理仍是 `provisioning` 的成员：

- 该成员已经在 Agent 注册表里 → 跳过（`agent-team/lib/index.js:656`）。
- 否则读取 child 自己持久化的会话（`readPersistedSession`，`agent-team/lib/index.js:248-260`），判据全部满足才算 `active`：`header.parentSession === root.id`、subagent descriptor 的 `mode === "continuable"`、`descriptor.provider === member.provider`、且后缀里存在**已接受的初始用户消息**（`agent-team/lib/index.js:660-665`）。
- 任一不满足 → 追加 `failed`，`error` 分别是 `"persisted child Session does not match the provisioned continuation"`、`"provisioning did not leave a resumable child Session"` 或 `"child Session recovery failed: …"`（`agent-team/lib/index.js:657-668`）。
- ⚠️ 恢复不复活已 `failed` 的成员，也不会复用名字。

### 4.4 状态与展示

- 持久阶段只有三种：`provisioning`、`active`、`failed`（`agent-team/lib/types/types.d.ts:30`）；模型看到的 `running`/`inactive` 是**实时可用性**，不是持久阶段（`agent-team/lib/types/types.d.ts:42-52`）。
- `failed` 的 `error` 会作为唯一的 `diagnostics` 条目暴露给模型（`agent-team/lib/index.js:459`）。
- roster 是**扁平且不可变**的：只能由 Lead 创建直接 teammate，不支持嵌套 Team、重命名、删除或名字复用（`agent-team/README.zh.md:208`）。
- 只有 Lead 能创建或中断 teammate（`agent-team/README.zh.md:65`）。

## 5. 持久 mailbox

### 5.1 入队与投递（`sendAdmitted`，`agent-team/lib/index.js:815-850`）

1. 解析调用方成员关系，`structuredClone` 内容（`agent-team/lib/index.js:816-819`）。
2. 在 Lead 日志事务里：解析 target（必须 `active`，否则 `TEAM_MEMBER_NOT_FOUND`，抛出点 `agent-team/lib/index.js:357`）；`target.id === caller.id` → `TEAM_SELF_MESSAGE`；该 target 的 pending（queued 且未 delivered）数达 `maxPendingMessagesPerMember` → `TEAM_MAILBOX_FULL`（`agent-team/lib/index.js:823-826`）。
3. 生成 `id = team-message-<uuid>`、`senderId`、`senderName`、`targetId`、`content`；把**加前缀后的完整投递内容**序列化，UTF-8 字节数超过 `maxMessageBytes` → `TEAM_MESSAGE_TOO_LARGE`（`agent-team/lib/index.js:827-834`）。
4. **先追加并 flush `team/message/queued`**，然后才在同一个事务里启动投递（`agent-team/lib/index.js:835-843`）。
5. 事务返回后等待投递结果：投递成功返回 `accepted`，否则返回 `queued`（`agent-team/lib/index.js:845-849`）。

对应政策原句："A successful send is already durable even when its result says queued; do not resend it."（`tool-agent-team/lib/index.js:27`）

### 5.2 投递路径与投递顺序

- 投递按 **target 本地**串行化（Promise 尾链按 `targetId` 分桶），并且总是按持久队列顺序把该 target 的 pending 消息一路投到 `message` 为止（`agent-team/lib/index.js:878-890`、`agent-team/lib/index.js:892-907`）。
- 目标是 Lead（`message.targetId === root.id`）：构造带 `team-message` source 的 user 消息后**直接 `root.steer(input)`**（`agent-team/lib/index.js:921-927`）。
- 目标是 teammate：走 continuation owner 的 **host-only Steer 路径** `steerHostSubagentPrompt`，该路径授权 Lead→child 这条边并**冷恢复 inactive target**（`agent-team/lib/index.js:937`、`dsh-subagent/lib/types/internal.js:55-57`、`dsh-subagent/lib/index.js:1824`）。README 强调这条路径保真保留 Team 发送者 source，sibling 消息不会伪装成 Lead（`agent-team/README.zh.md:135`）。
- 投递前会先折叠目标会话的**持久 inbox 与历史**做去重：`targetRecorded` 命中就直接补记 delivered（`agent-team/lib/index.js:911-912`、`agent-team/lib/index.js:967-969`）。

### 5.3 确认（delivered）与崩溃边界

- **只有目标会话在 pending inbox 或已记录历史中持久持有该消息身份后**才写 `team/message/delivered`：先 `sessions.flush(target)`，再复查 `targetRecorded`，通过才 `markDelivered`（`agent-team/lib/index.js:945-950`、`agent-team/lib/index.js:952-965`）。`markDelivered` 自己幂等（已 delivered 直接返回）。
- `messageAccepted` 同时检查 `user/message` 历史与折叠后的 inbox（`next-turn` + `next-step`）（`agent-team/lib/index.js:265-284`）。这正是"inbox 已接受但模型尚未 claim 时崩溃不会重复投递"的机制（`agent-team/README.zh.md:133`）。
- 恢复（`recoverFor`）对每个新启动的成员重投 **queued-minus-delivered** 的消息；Lead 恢复时覆盖全部未确认消息，teammate 只覆盖发给自己的（`agent-team/lib/index.js:796-806`）。
- 读取不到离线目标的持久日志时**保持 queued**（返回 `undefined` → 不确认），绝不猜测已投递（`agent-team/lib/index.js:929-936`、`agent-team/lib/index.js:978-986`）。
- 投递异常只记 warn 并把消息留在 queued，不让 `send_message` 本身失败（`agent-team/lib/index.js:939-942`）。
- 模型看到的投递内容首块是固定前缀 `Team message <id> from <senderName>:`，随后原样附加发送者内容块（`agent-team/lib/index.js:971-976`、`agent-team/README.zh.md:187`）。
- **该保证是进程内重试 + 目标会话去重，不是跨进程 exactly-once**（`agent-team/README.zh.md:133`、`agent-team/README.zh.md:210`）。

## 6. interrupt 与 wait

### 6.1 `interrupt`

- 仅 Lead：非 Lead 报 `TEAM_LEAD_REQUIRED`（`agent-team/lib/index.js:504-505`）。
- 目标是 Lead 自己（名字解析为 `lead`）报 `TEAM_INVALID_TARGET`（`agent-team/lib/index.js:508`）。
- 目标不在 Agent 注册表里 → 返回 `{ previousStatus: "inactive" }`，不做任何事（`agent-team/lib/index.js:509-510`）。
- 否则先采样 `previousStatus`，再调 `subagents.interrupt(targetId, {kind: "ancestor", agent: caller})`；底层以 `{ keepInbox: true }` 只取消当前 turn（`agent-team/lib/index.js:511-516`、`dsh-subagent/lib/index.js:855`）。
- `keepInbox` 的含义是**保留排队未消费的 inbox**；`interrupt` **既不释放任务 owner，也不删除持久 mail**（`agent-team/README.zh.md:143`、`agent-team/README.zh.md:85`）。任务归属只在 `release`/`reopen`/`reassign` 时变化（见 [task-board.md](task-board.md)）。

### 6.2 `wait`

- 语义：等待**本次调用之后**的下一条团队变化——roster、task、mailbox 或实时状态边；只报告是否超时，调用方随后重新读取状态（`agent-team/README.zh.md:83`、`agent-team/README.zh.md:143`）。
- 参数区间 `10000..3600000` 毫秒；越界由 `TeamActivity.wait` 抛 `TEAM_INVALID_TIMEOUT`（`agent-team/lib/index.js:47-48`）。
- 等待者按 TeamId 分桶，每个等待最多被释放一次（超时/取消/通知竞争时后来者让位）（`agent-team/lib/index.js:51-88`）。
- 唤醒来源：journal 每次提交 → `activity.notify(TeamId(root.id))`（`agent-team/lib/index.js:1714-1716`）；成员 `agent/status` 变化也会通知（`agent-team/lib/index.js:1726-1729`）。
- runtime dispose 会 `close()` 等待器（唤醒全部），此后新的 `wait` 立即返回 `{ timedOut: false }`（`agent-team/lib/index.js:101-105`、`agent-team/lib/index.js:50`）。
- 取消语义：进入等待前 `signal.throwIfAborted()` 直接抛调用方原因；等待期间取消则保留 `Error` 原因，非 `Error` 原因包成 `TEAM_WAIT_ABORTED`（`agent-team/lib/index.js:49`、`agent-team/lib/index.js:68-73`）。
- **`wait_agent` 从不唤醒 inactive 成员**：工具层的 `noProgress` 捷径与 policy 文本都明确这一点（`tool-agent-team/lib/index.js:333`、`tool-agent-team/lib/index.js:343-349`）。

## 7. dispose

`disposeRuntime` 的固定顺序（`agent-team/lib/index.js:1855-1867`）：

1. `lifecycle.close()` —— 关闭准入、以 `TEAM_DISPOSED` 作为 abort reason 中止已获准的可中断工作（`agent-team/lib/index.js:201-203`）。
2. `activity.close()` —— 释放所有当前等待者（`agent-team/lib/index.js:101-105`）。
3. 有界等待已获准的 **roster 创建事务**（`agent-team/lib/index.js:1859`）。
4. 有界等待已获准的 **mailbox dispatch/ack 事务**（`agent-team/lib/index.js:1860`）。
5. 对每个 live Lead 调 `stopTeammates`，释放 roster 中**确切的 live direct child 及其后代**（`agent-team/lib/index.js:1861-1865`、`agent-team/lib/index.js:522-542`）。

- 等待由 `disposalTimeoutMs` 封顶，超时报 `TEAM_DISPOSAL_TIMEOUT`（`agent-team/lib/index.js:223-235`）。
- 结算时会吞掉"就是这次取消"的拒绝（`isCancellation` 沿 `cause` 链识别 `TEAM_DISPOSED`），其它失败进入 `failures`，最终以 `AggregateError` 明确失败（`agent-team/lib/index.js:188-199`、`agent-team/lib/index.js:209-217`、`agent-team/lib/index.js:1866`）。
- **Lead 的非 Team continuable child 不受影响**：只释放 roster 里登记过的 child id（`agent-team/lib/index.js:522-534`、`agent-team/README.zh.md:155`）。

## 8. 配置与上限

| 字段 | 代码默认值 | README 默认值 | profile 实际值 | 含义 |
|---|---|---|---|---|
| `maxMembers` | `16` | `16` | **`8`** | 一支 Team 最多保留的 teammate 条目数，**含失败的** |
| `maxTasks` | `256` | `256` | **`256`** | 任务板上最多的**未删除**任务数 |
| `maxPendingMessagesPerMember` | `64` | `64` | **`64`** | 单个 target 最多可 queued-minus-delivered 的消息数 |
| `maxMessageBytes` | `65536` | `65,536` | **`65536`** | 单条**完整带前缀投递内容**的最大 UTF-8 字节数 |
| `disposalTimeoutMs` | `5000` | `5,000` | **`5000`** | 关闭清理允许的时间（毫秒） |

来源：代码默认值 `agent-team/lib/index.js:1669-1673`（`DEFAULT_*` 常量）与 `agent-team/lib/index.js:1688-1694`（Config schema）；README 默认值表 `agent-team/README.zh.md:49-55`；profile 实际值 `profile/cordis.patch.yml:20-24`（与 README 一致，`maxMembers` 被调低到 8）。

- 校验路径：Config schema 先要求正数，随后 `positiveLimit` 再要求**正的安全整数**，否则 `TEAM_INVALID_CONFIG`（`agent-team/lib/index.js:1675-1678`、`agent-team/lib/index.js:1705-1711`）。
- `tool-agent-team` 只有两项配置：`freshProvider` 默认 `spawn`、`forkProvider` 默认 `fork`（`tool-agent-team/lib/index.js:16-19`、`tool-agent-team/lib/index.js:533-537`；profile 显式给出同值，`profile/cordis.patch.yml:28-30`）。
- profile 层还会禁用旧的 subagent 控件：`tool-subagent-control`、`tool-subagent-list-agents`、`tool-subagent`、`tool-subagent-fork`（`profile/cordis.patch.yml:4-14`）。Workflow 的 `agent()`（fresh 一次性子代理）仍然可用（`dsh-experimental-agent-team-profile/README.zh.md:49`、`dsh-experimental-agent-team-profile/README.zh.md:91`）。

## 9. 已知限制

领域包（`agent-team/README.zh.md:202-210`）：

- **完整视图广播**——每次 roster 或任务变化都会把完整 roster 与未删除任务板（含描述）发给所有已连接浏览器，即使它在看别的 Session。
- **实验原型，无稳定性承诺**。
- **单进程、共享 checkout**——成员共享 cwd、修改立即可见；不提供 worktree、远端成员、merge 或文件锁。
- **write scope 仅作提示**——Bash、formatter、代码生成器与直接外部写入可以绕过文件版本检查；Lead 必须协调 owner 并检查最终 diff。
- **扁平且不可变的 roster**——只有 Lead 能创建直接 teammate；无嵌套 Team、无重命名、无删除、无名字复用。
- **不会自动释放 owner**——成员不活动、interrupt、进程退出与工作失败都不会释放任务 owner。
- **mailbox 不保证跨进程 exactly-once**——不支持多个 harness 进程并发操作同一 Team。

工具包（`tool-agent-team/README.zh.md:142-149`）：

- **一次性子代理工具可见性**——进程内一次性子代理在发布后才获得 subagent descriptor，Team 安装可能一度把它们误认作 Lead 并暴露策略与工具；descriptor 到位后调用会被拒绝。
- 提示词策略**只负责协调，不负责 confinement**；不会自主创建 Team；不提供 Web 控制；schema 在孵化期可自由变更。
- 【推断】一次 `wait_agent` 只保证观察到"某一处"变化，不保证把期间所有变化都汇报给调用方；调用方必须重新 list/get（policy 与工具描述都要求 re-list）。

profile 层（`dsh-experimental-agent-team-profile/README.zh.md:105-109`）：仅显式启用、默认关闭；共享 checkout；Web 预设仍可在预设作用域挂载旧控件；依赖 `dsh-base`。

## 10. 为什么浏览器 UI 不在本 skill 范围内

`dsh-experimental-client-ui-agent-team` 只做**只读呈现**：从共享 Session store 读 Lead Session 的 `agentTeam` 投影，渲染 roster 与任务板，并允许导航到 teammate 会话（`dsh-experimental-client-ui-agent-team/README.zh.md:12`、`dsh-experimental-client-ui-agent-team/README.zh.md:32-40`）。

- 它**不存储 Team 状态**、不注册面向模型的输入、不提供任何生命周期或工作区控制——不能 spawn/rename/delete/interrupt，write scope 仍只是提示性 metadata（同文件 `dsh-experimental-client-ui-agent-team/README.zh.md:12`、`dsh-experimental-client-ui-agent-team/README.zh.md:78`、`dsh-experimental-client-ui-agent-team/README.zh.md:88-92`）。
- 它**没有 mailbox timeline**，投影只承载 roster 与任务（同文件 `dsh-experimental-client-ui-agent-team/README.zh.md:88`）。
- 因此本 skill 的 Codex 侧只复刻"领域服务 + 工具表面"两层的可观察语义；UI 层没有任何协议价值，只有渲染细节。参见 [codex-runtime.md](codex-runtime.md) 的差异与取舍。

## 11. 交叉引用

- 9 个工具的完整协议、结果 schema、`team:policy` 与身份前缀原文、28 个错误码：见 [protocol.md](protocol.md)。
- 任务字段、CAS、action 矩阵、DAG readiness、tombstone：见 [task-board.md](task-board.md)。
- Codex 侧运行时映射（`codex exec`、store 布局、CLI 速查、冷恢复）：见 [codex-runtime.md](codex-runtime.md)。
