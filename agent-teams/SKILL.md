---
name: agent-teams
description: 用一支小型具名 agent 团队并行推进同一工作区的工作——具名 teammate、持久消息、共享任务板、CAS 任务所有权。Use when the user asks to 使用 Agent Teams / 开一支 agent 团队 / 多智能体协作 / 并行分工 / 让几个 agent 一起做, or when a task splits into independent workstreams that need a durable shared task board and messages that survive restarts. 本 skill 是 DeepSeek Harness 内置实验性 Agent Teams 插件族的逆向移植：同一套九工具协议，落到 Codex 上由 scripts/agent-team.mjs + codex exec 承载。
---

# Agent Teams（Codex 移植版）

## 这是什么

一支**小型具名 agent 团队**跑在同一个工作目录里。当前会话是 **Lead**；你按用户的明确要求创建具名 **teammate**，与它们交换**持久消息**，并在**共享任务板**上协调任务。消息与任务状态挺过崩溃、reload 与中断——离线的 teammate 恢复后会收到排队中的消息。

这套协议逆向自 DeepSeek Harness 内置的实验性 Agent Teams 插件族（`dsh-experimental-agent-team` + `dsh-experimental-tool-agent-team`），**九工具协议、结果形状、错误码与上限都与官方一致**。Codex 本身没有 teammate 工具，所以本 skill 自带一个零依赖的持久化 store：

```bash
node "$HOME/.codex/skills/agent-teams/scripts/agent-team.mjs" <command> [options]
# Windows: node "$env:USERPROFILE\.codex\skills\agent-teams\scripts\agent-team.mjs" <command>
```

每个 teammate 是一个 `codex exec` 子进程；`journal.jsonl` 是唯一真源，roster / mailbox / 任务状态每次都从中回放派生。

**环境前提**：Node ≥ 18；store 零 npm 依赖（只用 `node:` 内置模块）。**`codex` 通常不在 PATH**——脚本会按 `--worker-cmd` → `AGENT_TEAM_WORKER_CMD` → `CODEX_CLI_PATH` → 常见安装目录探测的顺序解析可执行文件，都找不到会明确报错。别裸写 `codex exec`。

**teammate 只能用 store 内那份 CLI 副本。** `init` 会把一份逐字节一致的副本放到 `<dir>/bin/agent-team.mjs`（`init` 结果的 `teammateCli` 就是它的绝对路径）。**不要让 teammate 去跑 `~/.codex/skills/...` 里的原件**：worker 沙箱只覆盖 workdir，而 skill 原件在它之外；Windows 上 `C:\Users\<你>` 通常是 junction，node 解析它会直接 `EPERM: operation not permitted`。默认 worker 命令已经带上 `--sandbox workspace-write -C <cwd> --add-dir <dir>`（`codex exec` **不带 `--sandbox` 时默认 read-only**，teammate 会写不了 store）。**自己传 `--worker-cmd` 时，这两件事由你负责。**

**核心原则：持久日志，派生状态。** 所有协作状态先落盘再报告成功。**已经返回 `queued` 的消息绝不重发**——它已经安全存储。

## 何时用 / 何时不用

**用**（且只在这些情况下用）：
- 用户**明确**要求开团队、用 teammate、多 agent 并行。
- 任务能切成 **2 个以上互不共享写状态**的工作流，且切分本身要留痕（谁做什么、依赖谁、改哪些文件）。
- 需要**挺过中断**的委派：teammate 可能跑很久，消息与任务状态不能在 reload 后丢。
- 需要**只读侦察 + 独立验证**这类天然可并行的组合（例如"三个人分头查三个子系统，第四个人独立复核"）。

**不用**：
- 用户没提团队/teammate。**普通任务绝不自行触发委派**——这是官方策略的硬规则。
- 只有一个工作流，或子任务互相强依赖（改同一个文件、必须串行推理）。
- 需要**独立工作目录**、worktree 隔离、跨机器成员、自动合并或文件锁——本方案**不支持**（见下）。
- 需要**跨进程 exactly-once** 投递保证——本方案只给"重试 + 目标去重"。

## 硬规则（不可协商）

1. **只在用户明确要求时才创建 teammate。** 用户没说要团队，就不要开团队。
2. **只有 Lead 能创建与中断 teammate。** 只有 Lead 能 `reassign` 任务。这些由 `--as` 身份校验强制执行。
3. **共享同一个 cwd 与文件系统**，编辑对所有成员立即可见。
4. **写工作必须切成不相交的 scope**，并把预期写入范围记在任务上（`--write-scopes`）。**write-scope 重叠只是警告，不是锁**——它绝不阻止任何操作。真正的互斥靠你在派活时保证。
5. **优先 read/edit/write 改文件。** 若文件操作返回 `FS_STALE_VERSION`，先读回最新内容，把改动重放到新内容上再重试。
6. **Bash、formatter、codegen 不受文件版本保护。** 它们能绕过检查，必须显式协调，由 Lead 检查最终 diff 并跑测试。
7. **`inactive` 只表示"当前没有轮次在执行"**，不代表任务完成、成功、失败或在等别人。
8. **`queued` 就是已持久。** 收到 `queued` 后**绝不重发**。
9. **任务流程固定**：`team_task_list` → `team_task_get` → 用**当前 revision** `claim` → 做事 → `complete`。**readiness 从不自动启动 owner**——任务就绪不会唤醒任何人。
10. **`wait_agent` 前先 `list_agents`。** 没有 `running`/`provisioning` 的成员时它立即返回 `noProgress`；先用 `send_message` 唤醒必需的 teammate，再等待。
11. **`wait_agent` 只观察调用之后发生的变化，从不唤醒成员。** 唤醒或超时后**重新列出**状态，不要轮询。
12. **Lead 在给出最终答复前，必须等齐所有必需的 teammate。**
13. **任务所有权永不自动释放。** 成员失活、被中断、进程退出、干砸了都不会释放 owner。要换人必须 Lead 显式 `reassign`。

官方策略原文（`team:policy`，逐字）收录在 [references/protocol.md](references/protocol.md)。

## 九个工具

子命令名与参数名**与官方工具完全一致**（便于对照与排错）。`--dir` 默认 `.agent-team`，`--as` 默认 `lead`；输出是紧凑 JSON，领域错误输出 `{"error":{"code":"TEAM_*","message":"..."}}` 并以退出码 2 结束。

**Lead 的身份与寻址 target 恒为字面量 `lead`**（与官方一致：Lead 的模型可见名字恒为 `lead`）。`--as lead` 是表达 Lead 身份的唯一方式。`init --lead-name <n>` **只是 `team.json` 里的展示标签，不产生第二个身份别名**——它不改变 Lead 的寻址 target，也不让 `--as <n>` 生效（那会报 `TEAM_NOT_MEMBER`）；**推荐不要使用**。任何 teammate **不允许**与 Lead 同名：`spawn_teammate` 会报 `TEAM_MEMBER_NAME_TAKEN`。`init` 对已初始化 store 是**幂等**的（返回同一 teamId、不改既有 limits），但**照样校验参数**：非法 limits 报 `TEAM_INVALID_CONFIG`、非法 `--lead-name` 报 `TEAM_INVALID_MEMBER_NAME`（均 exit 2）。

| 工具 | 关键参数 | 返回 | 权限 |
|---|---|---|---|
| `spawn_teammate` | `--name` `--description` `--prompt`/`--prompt-file` `--context fresh\|fork` `--worker-cmd` `--run-sync` | `{member}` | **仅 Lead** |
| `send_message` | `--target` `--message`/`--message-file` | `{messageId, status: accepted\|queued}` | 任意成员 |
| `list_agents` | — | `MEMBER_VIEW[]` | 任意成员 |
| `wait_agent` | `--timeout-ms`（10000–3600000，默认 30000） | `{timedOut, noProgress?}` | 任意成员 |
| `interrupt_agent` | `--target` | `{previousStatus}` | **仅 Lead** |
| `team_task_create` | `--subject` `--description` `--blocked-by` `--write-scopes` | `TASK_VIEW` | 任意成员 |
| `team_task_list` | `--status` `--owner`(`unowned`) `--ready` `--cursor` `--limit`(1–100) | `{tasks, nextCursor?}` | 任意成员 |
| `team_task_get` | `--task-id` | `TASK_VIEW` | 任意成员 |
| `team_task_update` | `--task-id` `--expected-revision` `--action` + 动作参数 | `TASK_VIEW` | 见 action 矩阵 |

运维命令（官方是领域 API 而非模型工具）：`init`、`inbox --target <t> [--ack]`、`status`、`journal --limit n`。

`spawn_teammate` 的身份前缀是给 teammate 的固定开场白（`You are teammate "<name>".` / `Your Team Lead is named "lead".` …），由脚本自动加在 `--prompt` 之前。

**仔细读这几份，不要凭印象猜字段：**
- [references/protocol.md](references/protocol.md) —— 九工具完整协议、结果 schema、28 个错误码全表、策略原文。
- [references/team-model.md](references/team-model.md) —— 身份、roster 生命周期、mailbox 投递语义、持久性与 dispose、上限。
- [references/task-board.md](references/task-board.md) —— 任务字段、CAS、8 个 action 的完整矩阵、DAG readiness、tombstone。
- [references/codex-runtime.md](references/codex-runtime.md) —— `codex exec` 真实用法、store 布局、推荐 worker-cmd、冷恢复、与官方的差异。
- [scripts/README.md](scripts/README.md) —— CLI 速查与示例。

## Lead 的运行循环

```bash
TEAM=node "$HOME/.codex/skills/agent-teams/scripts/agent-team.mjs"

# 0. 一次性初始化（每个工作区一次）
$TEAM init --max-members 8 --max-tasks 256

# 1. 先切分，再开工：把每个工作流写成任务，标清依赖与写入范围
$TEAM team_task_create --subject "逆向协议文档" \
  --description "产出 protocol.md 与 team-model.md；验收：字段与源码逐项一致" \
  --write-scopes "references/protocol.md,references/team-model.md" --as lead

# 2. 创建 teammate，把任务写进 prompt（它要自己 claim）
#    --bootstrap 会追加一段引导：store 内副本的绝对路径 + 调用循环（强烈建议加）
#    不传 --worker-cmd 时用默认命令（已含 --sandbox workspace-write -C <cwd> --add-dir <dir>）
$TEAM spawn_teammate --name protocol-scribe --description "逆向协议文档" --bootstrap \
  --prompt "领取 task-1：用 team_task_get 读它，用当前 revision claim，做完 complete。写入范围只有 references/protocol.md 与 references/team-model.md。完成后 send_message 向 lead 汇报。"

# 3. 巡查与推进
$TEAM list_agents
$TEAM team_task_list --ready true
$TEAM send_message --target protocol-scribe --message "补充：错误码要不多不少，别照抄我的清单"

# 4. 等待变化（先确认有 running/provisioning 的成员）
$TEAM wait_agent --timeout-ms 60000

# 5. 唤醒或超时后重新列出，再决定下一步
$TEAM list_agents && $TEAM team_task_list
```

**teammate 一侧**（`codex exec` 进程内）读自己的 inbox 并回话：

```bash
$TEAM inbox --target protocol-scribe --ack      # --ack 才落 delivered；不 ack 则下次仍会读到
$TEAM send_message --target lead --message "task-1 完成：..." --as protocol-scribe
$TEAM team_task_update --task-id task-1 --expected-revision 3 --action complete --as protocol-scribe
```

**冷恢复**：worker 进程死了，`list_agents` 会把它显示成 `inactive`；`send_message` 给它会返回 `queued`（已持久）。用 `--run-sync` 或重新 `spawn_teammate` 前先确认名字没被占用（名字永不复用，含 failed 的）。

## 收尾前的自检

给出最终答复前逐条过：

- [ ] 所有必需的 teammate 都已经停下（`list_agents` 里没有还在为本次目标 running 的成员）。
- [ ] 任务板上没有遗留的 `in_progress`：要么 `complete`，要么 `release`，要么明确写进"未完成"交回用户。
- [ ] 每个 `queued` 的消息都**没有被重发**。
- [ ] 确认没有两个成员写重叠文件；有重叠的话**由 Lead 检查最终 diff**。
- [ ] 用到的临时文件、store 目录（`.agent-team/`）是否要保留、清理或加进 `.gitignore`——问清楚或写明白。
- [ ] 报告的结论来自你**自己核验过的证据**，不是 teammate 的自我汇报。

## 边界（不要承诺做不到的事）

| 做不到 | 原因 |
|---|---|
| 独立工作目录 / worktree / 远端成员 / merge / 文件锁 | 全员共享一个 cwd，store 不做隔离 |
| 嵌套团队、重命名、删除成员、名字复用 | roster 扁平且不可变 |
| 自动释放任务 owner | 失活/中断/退出/失败都不释放，必须 Lead `reassign` |
| 跨进程 exactly-once 投递 | 只有"重试 + 目标侧去重" |
| 强制阻止重叠写入 | write-scope 只警告；Bash/formatter/codegen 绕过一切检查 |
| 浏览器 roster / 任务板 UI | 官方有 `dsh-experimental-client-ui-agent-team`，本次移植**不含** Web 呈现 |

真正需要强隔离时，改用 `git worktree` + 多个独立 Codex 会话，而不是本 skill。
