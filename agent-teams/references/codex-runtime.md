# Codex 侧运行时映射

本文件说明为什么 Codex 需要自带 store、store 布局与 CLI 契约、**本机实跑勘定**的 `codex exec` flag、推荐 worker-cmd、`~/.codex/agents/*.toml` 角色定义映射、运行循环、冷恢复协议，以及与官方 Agent Teams 的差异。

本文件的 Codex flag 事实来自本机实跑（见第 5 节），不是抄文档。

## 1. 为什么 Codex 需要自带 store

DSH 的 Agent Teams 是**同进程领域服务**：roster / mailbox / task board / journal / projection 挂在运行时上，靠 Lead 会话日志当唯一真源，teammate 是进程内的 continuable child agent。Codex 侧没有等价物：

- **Codex 没有 `spawn_teammate` / `send_message` / `list_agents` / `wait_agent` / `interrupt_agent` 这五个工具，也没有共享任务板工具。** DSH 的 9 个工具全部来自 `@deepseek-ai/dsh-experimental-tool-agent-team`，Codex CLI 不加载它。
- **Codex 自己确实有 subagent 能力**（内置 agent `default` / `worker` / `explorer`，custom agent 定义在 `~/.codex/agents/*.toml`，全局设置 `[agents]`，CLI 里 `/agent` 切换 thread），但它是**会话内编排**：由 Codex 自己 spawn / steer / close，没有持久 mailbox、没有跨崩溃的团队任务板、没有 CAS 版本化任务、没有模型可调用的队友寻址。
- **`codex exec` 是无头一次性运行**，没有"队友名 + 收件箱 + 任务 owner"这一层。

所以 skill 必须自带一套**可运行的持久化团队 store**（`scripts/agent-team.mjs`）：用 `codex exec` 子进程当 teammate，用 append-only 文件日志当唯一真源，把官方 9 个工具的名字与语义复刻成 CLI 子命令。

一句话总结定位：**官方实现是"同进程 + 会话日志"；本 skill 是"子进程 + 文件 journal"。**

## 2. store 布局与 journal 事件类型

### 2.1 布局（`--dir`，默认 `.agent-team`）

```
<dir>/team.json        # { version, teamId, lead, createdAt, limits{...} }
<dir>/journal.jsonl    # 唯一真源：append-only 事件日志，每行一个 JSON
<dir>/lock             # CAS 串行化用的锁目录
<dir>/workers/<name>.log   # 每个 worker 的 stdout/stderr
<dir>/workers/<name>.pid   # worker 进程号（用于推导 running/inactive）
```

### 2.2 journal 事件行

```json
{"seq":1,"time":"2026-01-01T00:00:00.000Z","type":"member/provisioning","data":{"name":"reviewer","description":"...","context":"fresh","provider":"codex-exec"}}
```

事件 `type` 取值（封闭集合）：

| type | 语义 |
|---|---|
| `member/provisioning` | 成员已预留名字，worker 尚未确认启动 |
| `member/active` | worker 成功启动 |
| `member/failed` | worker 启动失败；**名字永久占用** |
| `message/queued` | 消息已持久入队（先落盘） |
| `message/delivered` | target 会话已持久持有该消息身份 |
| `task/created` | 任务创建，`revision = 1` |
| `task/updated` | 任务变更，`revision + 1` |
| `task/deleted` | tombstone |

`journal.jsonl` 是唯一真源，roster / mailbox / tasks **每次命令执行都从中回放派生**——对应官方的"持久日志，派生状态"原则（`agent-team/README.zh.md:105`）。派生状态不落盘，避免真源分叉。

### 2.3 与官方持久层的对应

| 官方 | 本 skill |
|---|---|
| `team/member` / `team/task` / `team/message/queued` / `team/message/delivered` 会话事件（写进 Lead 会话日志并 flush） | `member/*` / `task/*` / `message/*` 事件（写进 `journal.jsonl` 并 flush） |
| `team/task` 事件携带整份 `TeamTaskSnapshot`（`{version:2, teamId, task}`） | `task/created`、`task/updated`、`task/deleted` 拆成三种 type，payload 带完整快照 |
| 回放由 `sessionProjections` 的 `apply` 完成（`agent-team/lib/types/projection.js:184-248`） | 回放由脚本每次启动时顺序读 `journal.jsonl` 完成 |
| 事件**不进入**模型对话历史（`agent-team/README.zh.md:147`） | 同理：journal 只是文件，不污染任何 worker 的 prompt |

## 3. CLI 速查表

```
node scripts/agent-team.mjs <command> [options]
```

子命令名**就是**官方工具名，参数用官方 snake_case。

| 命令 | 参数 | 输出 |
|---|---|---|
| `init` | `--lead-name`(默认 `lead`；**纯展示标签**，见 §4.1，**推荐不要使用**)、`--max-members`(8)、`--max-tasks`(256)、`--max-pending-per-member`(64)、`--max-message-bytes`(65536) | `{teamId, lead, limits}` |
| `spawn_teammate` | `--name`(必填, lower-kebab-case)、`--description`(必填)、`--prompt` 或 `--prompt-file`(必填)、`--context fresh\|fork`(默认 fresh)、`--worker-cmd`、`--run-sync` | `{member: MEMBER_VIEW}` |
| `list_agents` | — | `MEMBER_VIEW[]` |
| `send_message` | `--target`(必填)、`--message` 或 `--message-file`(必填) | `{messageId, status}` |
| `wait_agent` | `--timeout-ms`(10000–3600000，默认 30000) | `{timedOut, noProgress?}` |
| `interrupt_agent` | `--target`(必填) | `{previousStatus}` |
| `team_task_create` | `--subject`、`--description`(必填)、`--blocked-by`(逗号分隔)、`--write-scopes`(逗号分隔) | TASK_VIEW |
| `team_task_list` | `--status`、`--owner`(或 `unowned`)、`--ready true\|false`、`--cursor`、`--limit` | `{tasks, nextCursor?}` |
| `team_task_get` | `--task-id`(必填) | TASK_VIEW |
| `team_task_update` | `--task-id`、`--expected-revision`、`--action`(必填)、`--subject`、`--description`、`--blocked-by`、`--write-scopes`、`--owner` | TASK_VIEW |
| `inbox` | `--target`(必填)、`--ack`(**唯一**产生 delivered 的路径)、`--all`(含已 ack 的历史消息；**脚本自有扩展**，官方无此命令) | `{messages:[{messageId,from,text,queuedAt}]}` |
| `status` | — | 紧凑摘要 `{lead, members, tasks}` |
| `journal` | `--limit n` | 最近事件行 |

全局选项：

- `--dir <path>`（或环境变量 `AGENT_TEAM_DIR`，默认 `.agent-team`）
- `--json`（**默认就输出 JSON**，该开关保留给未来人类可读模式）
- `--as <name>`（调用方身份，默认 `lead`）——用于复刻官方 owner / Lead 权限校验。**`--as lead` 是表达 Lead 身份的唯一方式**：Lead 的身份与寻址 target **恒为字面量 `lead`**，与官方一致（官方 `resolveActiveMember` 把 `lead` 硬编码，`roster.js:18-21`）。

`inbox` / `status` / `journal` / `init` 是**脚本自有的运维命令**：官方对应的是领域 API（`getTask`、`listTasks`，以及 roster 读取）而不是模型可见工具，所以没有同名工具可抄。任务板语义细节见 [任务板](task-board.md)，9 个工具协议见 [协议](protocol.md)、[团队模型](team-model.md)。

## 4. 退出码与身份

- 成功 `0`；用法错误 `1`；**领域错误 `2`**，并在 stdout 打印 `{"error":{"code":"TEAM_...","message":"..."}}`。
- 错误码取 [任务板](task-board.md) 与 [协议](protocol.md) 中的 `TEAM_*` 全表；`--as <name>` 决定 CAS 授权判定里的 `caller`，用于复刻 `TEAM_TASK_UNAUTHORIZED` / `TEAM_LEAD_REQUIRED`。
- **不信任 `--as` 的生产力**：它只是本地身份标签，没有认证。任何能跑脚本的人都能冒充 `lead`。【推断】

### 4.1 Lead 身份与 `--lead-name`（纯展示标签）

**Lead 的身份与寻址 target 恒为字面量 `lead`**，`--as lead` 是表达 Lead 身份的唯一方式（与官方一致：Lead 的模型可见名字恒为 `lead`）。`init --lead-name <n>` **只是写进 `team.json` 的展示标签，不产生第二个身份别名**——它不改变 Lead 的寻址 target，`--as <n>` 会报 `TEAM_NOT_MEMBER`，**推荐不要使用**（`scripts/agent-team.mjs:740-741`、`:1291`）。

| 行为 | 结果 | 来源 |
|---|---|---|
| `init --lead-name alice` | `{"lead":"alice"}`，exit 0；`team.json` 的 `lead` = `alice` | 实测 |
| `--as alice`（任意命令） | `TEAM_NOT_MEMBER`，exit 2 | 实测；`agent-team.mjs:749-751`、`:768-770` |
| `spawn_teammate --name alice`（与标签同名） | `TEAM_MEMBER_NAME_TAKEN`，exit 2；在落 `member/provisioning` **之前**即拒 | 实测；`agent-team.mjs:1363` |
| 遗留 journal 里出现与 Lead 同名的成员 | 回放直接报 `E_JOURNAL_CORRUPT`，**不静默解析** | `scripts/README.md` §7.16 |
| `--lead-name` 违反命名规则（非 `^[a-z0-9]+(?:-[a-z0-9]+)*$`、超 64、或空） | **`TEAM_INVALID_MEMBER_NAME`，exit 2**（领域错误，**不是** `E_USAGE` exit 1） | 实测；`agent-team.mjs:1291-1297` |
| `--lead-name lead` | 合法（即默认值） | 实测 |

**`init` 对已初始化的 store 幂等**：返回同一 `teamId`，不改写既有 `lead` / `limits`，合法的新参数被忽略。但**参数校验在幂等判定之前执行**，所以非法参数即使在幂等路径上**仍然报错**（`--max-members 0` → `TEAM_INVALID_CONFIG`、非法 `--lead-name` → `TEAM_INVALID_MEMBER_NAME`，均 exit 2）（`agent-team.mjs:1285-1297`、`:1311-1314`）。

## 5. 本机实跑的 Codex 事实

### 5.1 可执行文件与版本（实测）

| 项 | 实测值 |
|---|---|
| 可执行文件 | `C:\Users\UserX\AppData\Local\OpenAI\Codex\bin\be3fd7e5c1969ff6\codex.exe`（存在，324,622,128 字节） |
| `codex --version` | `codex-cli 0.159.0-alpha.12.1` |
| **`codex` 是否在 PATH** | **否。** `where.exe codex` 退出码 1，`Get-Command codex` 无结果 |

**结论（对 worker-cmd 很关键）：** 不能假设 `codex` 能被解析。默认 worker-cmd 必须用**绝对路径**，或由调用方显式提供 `--worker-cmd` / `AGENT_TEAM_WORKER_CMD`。_spec.md §4.4 里把默认写成裸 `codex exec ...`，在**本机**会直接失败——见第 10 节。

### 5.2 `codex exec --help` 实测可用 flag

以下全部逐字取自本机 `codex exec --help` 输出：

| flag | 值域 / 说明 |
|---|---|
| `-c, --config <key=value>` | 覆盖 `~/.codex/config.toml` 的值；dotted path；value 按 TOML 解析，解析失败当字面量 |
| `--enable <FEATURE>` / `--disable <FEATURE>` | 等价 `-c features.<name>=true\|false`，可重复 |
| `--strict-config` | config.toml 含本版不认识的字段时报错 |
| `-i, --image <FILE>...` | 给初始 prompt 附加图片 |
| `-m, --model <MODEL>` | 选择模型 |
| `--oss` / `--local-provider <OSS_PROVIDER>` | 开源 provider（`lmstudio` 或 `ollama`） |
| `-p, --profile <CONFIG_PROFILE_V2>` | 在基础配置上叠加 `$CODEX_HOME/<name>.config.toml` |
| `-s, --sandbox <SANDBOX_MODE>` | `read-only` \| `workspace-write` \| `danger-full-access` |
| `--approve-for-me` | 审批走自动 review，用 workspace-write 沙箱 |
| `--dangerously-bypass-approvals-and-sandbox` | 跳过全部确认且不沙箱（极危险） |
| `--dangerously-bypass-hook-trust` | 不要求持久化的 hook trust |
| `-C, --cd <DIR>` | 工作根目录 |
| `--worktree` | 在新建的托管 Git worktree 中运行 |
| `--add-dir <DIR>` | 额外可写目录 |
| `--thread-source <SOURCE>` | 新建/fork thread 的来源分类 |
| `--skip-git-repo-check` | 允许在 Git 仓库外运行 |
| `--ephemeral` | 不把 session 文件持久化到磁盘 |
| `--ignore-user-config` | 不加载 `$CODEX_HOME/config.toml`（auth 仍用 `CODEX_HOME`） |
| `--ignore-rules` | 不加载 execpolicy `.rules` |
| `--output-schema <FILE>` | 用 JSON Schema 约束模型最终响应形状 |
| `--color <COLOR>` | `always` \| `never` \| `auto`（默认 `auto`） |
| `--json` | 把事件按 **JSONL** 打到 stdout |
| `-o, --output-last-message <FILE>` | 把最后一条 agent 消息写进文件 |
| `-h, --help` / `-V, --version` | — |

### 5.3 prompt 与 stdin 的真实语义（逐字要点）

`codex exec` 的位置参数 `[PROMPT]`：

- 不提供（或传 `-`）时，**从 stdin 读**指令。
- 若 stdin 被管道送入**并且**同时给了 prompt，stdin 会作为一个 `<stdin>` 块**追加**。

因此 store 投递 prompt 的正确姿势是：**只走 stdin、不要同时给位置参数**，否则内容会被追加而非替换。

### 5.4 `codex exec` 的子命令（实测）

`codex exec` 有 4 个子命令：`resume`、`fork`、`review`、`help`。

| 子命令 | 用法 | 关键差异（实测 `--help` 对比） |
|---|---|---|
| `resume` | `codex exec resume [OPTIONS] [SESSION_ID] [PROMPT]` | 支持 `--last`（选最近 session）、`--all`（禁用 cwd 过滤）。**没有 `-s/--sandbox`、没有 `-C/--cd`、没有 `-p/--profile`、没有 `--color`。** |
| `fork` | `codex exec fork [OPTIONS] <SESSION_ID> [PROMPT]` | `SESSION_ID` **必填**；option 与 `resume` 同源但**少 `--last` 与 `--all`**（实测 `resume` 20 个 option / `fork` 18 个），同样无 `-s/--sandbox`、`-C/--cd`、`-p/--profile`、`--color`。 |
| `review` | — | 对当前仓库跑 code review（本 skill 不使用）。 |

**这是本 skill 最重要的一条接线约束：** `--context fork` 与"唤醒 inactive worker 续聊"两条路径若走 `exec resume` / `exec fork`，就**丢掉了 `--sandbox` 和 `--cd` 两个 flag**，只能靠默认值或 `-c` 覆盖。具体 config key 名称见第 10 节【待确认】。

### 5.5 顶层 `codex --help` 有、但 `codex exec` **没有**的 flag

对照两份实测输出，以下只存在于顶层（会转发给交互式 CLI），**不能**写进 worker-cmd：

- `-a, --ask-for-approval <APPROVAL_POLICY>`（`on-request` \| `never`）
- `--search`（启用 live web search）
- `--no-alt-screen`、`--no-daemon`、`--remote <ADDR>`、`--remote-auth-token-env <ENV_VAR>`

把 `-a never` 放进 `codex exec` 会直接报未知参数。无头 worker 要避免审批阻塞，应使用 `codex exec` 自己的 `-s`，或 `--dangerously-bypass-approvals-and-sandbox`（有风险，见 6.3）。

### 5.6 实跑观测：JSONL 事件形状与失败表现

在本机实际执行 `codex exec ... --json -o <file>`（prompt 走 stdin）观测到：

- stdout 是**逐行 JSON**，观测到的行形如 `{"type":"error","message":"..."}` 与 `{"type":"turn.failed","error":{"message":"..."}}`。事件 `type` 是点分/蛇形字符串，逐行独立可解析。
- 本机该次运行**未能完成 turn**：日志出现 `Reconnecting... 1/5` …`5/5`、`Falling back from WebSockets to HTTPS transport`、`workspace routing discovery timed out`、`workspace routing discovery failed`，并伴随 MCP 传输错误（`https://chatgpt.com/backend-api/ps/mcp` 请求失败）。进程退出码 `1`。
- turn 失败时 `-o` 指定的 last-message 文件**未被写出**（文件不存在）。因此 worker 结果读取必须容忍"没有 last message"。

这条观测对 store 有直接含义：**worker 失败要落 `member/failed` 而不是 `member/active` 之后的静默空结果**；`-o` 文件缺失即视为本 turn 无产出。

## 6. worker 接线：推荐 worker-cmd

三条都可直接复制，flag 全部经 `codex exec --help` 实证（见 5.2）。`<cwd>` 是共享工作目录，`<dir>` 是 `--dir`。prompt 一律走 **stdin**。

### 6.1 推荐 A（默认）：只读 reviewer / verifier

```powershell
& "C:\Users\UserX\AppData\Local\OpenAI\Codex\bin\be3fd7e5c1969ff6\codex.exe" exec --skip-git-repo-check -C <cwd> --sandbox read-only --json -o <dir>\workers\<name>.last.txt
```

只读 teammate（审查、核对、勘察）直接用这条。`--sandbox read-only` 保证它不能改文件，与官方"write scope 只是 advisory"形成互补：**这里是真的强制**。

### 6.2 推荐 B：写工作 worker（实现类 teammate）

```powershell
& "C:\Users\UserX\AppData\Local\OpenAI\Codex\bin\be3fd7e5c1969ff6\codex.exe" exec --skip-git-repo-check -C <cwd> --sandbox workspace-write --add-dir <dir> -m <model> --json -o <dir>\workers\<name>.last.txt
```

- `--sandbox workspace-write` 允许改工作目录；`--add-dir` 追加必要目录。
- `-m <model>` 用于让不同 teammate 跑不同模型（例如便宜的 worker 做机械活、贵的做设计）。
- 加 `--ephemeral` 可让一次性 teammate 不写 session 文件。

### 6.3 推荐 C：续聊 / fork 型 worker（注意 flag 缺失）

```powershell
& "..." exec resume --last --skip-git-repo-check --json -o <dir>\workers\<name>.last.txt "<message>"
& "..." exec fork <SESSION_ID> --skip-git-repo-check --json -o <dir>\workers\<name>.last.txt
```

用于"inactive teammate 收到排队消息后继续同一会话"。**必须知道**：这两个子命令实测**不接受 `-s/--sandbox` 与 `-C/--cd`**——cwd 与沙箱只能继承默认或经 `-c` 覆盖。`fork <SESSION_ID>` 正好对应 `spawn_teammate --context fork`。

**不要**为了省事把 `--dangerously-bypass-approvals-and-sandbox` 当默认：它会跳过全部确认且关闭沙箱（`codex exec --help` 原文标注 EXTREMELY DANGEROUS）。只在外部已经有隔离的环境里用。

### 6.4 默认值与覆盖顺序

默认（未给 `--worker-cmd`、也没有环境变量 `AGENT_TEAM_WORKER_CMD` 时）：

```
codex exec --skip-git-repo-check -C <cwd>
```

**本机必须替换**：`codex` 不在 PATH（5.1），这条默认会失败。建议优先级为 `--worker-cmd` > `AGENT_TEAM_WORKER_CMD` > 默认；并在默认里做一次可执行性探测，探测失败就报清晰错误而不是让 worker 静默 failed。【推断】

## 7. `~/.codex/agents/*.toml` 作为 teammate 角色定义

Codex 原生支持 custom agent 文件：`~/.codex/agents/` 放 personal agent，`.codex/agents/` 放 project-scoped agent，每个文件一个 agent。Codex 把这些文件当作 **spawned session 的配置层**加载。

### 7.1 本机真实样例

本机 `C:\Users\UserX\.codex\agents\` 下有 7 个真实文件：

```
chapter-extractor.toml      character-designer.toml     consistency-checker.toml
narrative-writer.toml       story-architect.toml        story-explorer.toml
story-researcher.toml
```

以 `narrative-writer.toml`（共 305 行）为例，前 7 行为：

```toml
name = "narrative-writer"
description = """
叙事文本创作与去AI味专家。负责正文写作（三维度揉进、感知/反应）、
情绪弧线执行、开篇/收尾、去AI味（禁用词替换、句式去套路、节奏调整）。
被 story-long-write（Phase 4-5）和 story-short-write（Phase 3-4）调用。
也可执行完整去AI味流程和格式合规检查。"""
developer_instructions = '''
# Narrative Writer -- 叙事写手
...
'''
```

三个字段的实际形态一目了然：`name` 单行字符串；`description` 用 `"""` 多行；`developer_instructions` 用 `'''` 多行（字面量风格，避免转义），后接一整套行为约束。

### 7.2 字段契约

必备（缺任一都不是合法 custom agent）：

| 字段 | 类型 | 用途 |
|---|---|---|
| `name` | string | Codex spawn / 引用该 agent 用的名字；**`name` 才是 source of truth**，文件名只是约定 |
| `description` | string | 给人看的"何时该用这个 agent"的说明 |
| `developer_instructions` | string | 定义 agent 行为的核心指令 |

可选：`nickname_candidates`(string[]，仅展示用)、`model`、`model_reasoning_effort`、`sandbox_mode`、`mcp_servers`、`skills.config`。省略时从 parent session 继承。此外还可以放其它受支持的 `config.toml` key。

内置 agent 名：`default`（通用兜底）、`worker`（实现/修复）、`explorer`（读密集的代码勘察）。custom agent 名与内置名冲突时 **custom 优先**。

全局 subagent 设置在同级 `[agents]` 段：`agents.max_threads`（默认 6）、`agents.max_depth`（默认 1）、`agents.job_max_runtime_seconds`。

### 7.3 映射到本 skill 的 teammate 角色

| TOML 字段 | 映射为 | 说明 |
|---|---|---|
| `name` | teammate 的 `name`（即 target） | 必须通过官方 `TEAM_INVALID_MEMBER_NAME` 同款校验：lower-kebab-case、≤64、≠ `lead`。`narrative-writer` 合规；Codex 允许 underscore 名（如 `pr_explorer`），**本 skill 必须拒绝或改写** |
| `description` | teammate 的 `description` | 直接进入 `MEMBER_VIEW.description` |
| `developer_instructions` | **注入 worker prompt 的核心行为约束** | 因为 `codex exec` 没有"按名字选 agent"的 flag（见 7.4），角色化只能靠 prompt |
| `model` / `sandbox_mode` | worker-cmd 的 `-m` / `--sandbox` | 由 store 在拼接 worker-cmd 时读取 |

推荐的角色化流程（【推断】的设计，非官方行为）：

1. 读 `~/.codex/agents/<role>.toml`，取出三个字段。
2. 用 `name` / `description` 作为 `spawn_teammate` 的入参。
3. 把 `developer_instructions` 插到 worker 初始 prompt 的最前面，再接官方身份前缀（`<system-reminder>You are teammate "<name>"...`）与本次任务指令。
4. 把 `sandbox_mode` / `model` 翻成 worker-cmd 的 `--sandbox` / `-m`。

### 7.4 【待确认】

- `codex exec --help`（实测）**没有** `--agent` / `--role` 之类选择器；`codex --help` 的 `agents` 子命令是"浏览活跃 agent session"，与本 topic 无关。因此**无法确认**能否让一次 headless `codex exec` 直接以某个 custom agent 身份启动。稳妥做法是 7.3 的 prompt 注入。
- `-p/--profile <CONFIG_PROFILE_V2>`（叠加 `$CODEX_HOME/<name>.config.toml`）是否是加载 custom agent 配置的间接入口：**未验证**。
- custom agent 文件里的 `sandbox_mode` 键名与 `codex exec -s` 的映射关系：**未验证**（`-c sandbox_mode=...` 是否生效未实测）。

## 8. 运行循环（Lead 视角）

```
init
 └─ spawn_teammate   × N    （每个角色一个；先落 member/provisioning 再起 worker）
      └─ team_task_create    （默认 unowned + pending，revision=1）
           └─ team_task_list → team_task_get → claim(expected_revision)
                └─ send_message（把任务 id 与要求发给 owner；queued 即持久，不要重发）
                     └─ list_agents 确认有 running/provisioning
                          └─ wait_agent 观察变化（从不唤醒 inactive）
                               └─ inbox --target <name> --ack   （读回报并标记 delivered）
                                    └─ team_task_get 复核 revision → complete / reopen / reassign
                                         └─ Lead 自己检查最终 diff 并跑验收测试
                                              └─ status / journal   （审计）
```

硬规则（与官方 `team:policy` 一致）：

- 只在用户明确要求团队时才 `spawn_teammate`。
- `wait_agent` **之前**必须 `list_agents`：没有 running/provisioning 的成员就先用 `send_message` 唤醒；`wait_agent` 从不唤醒 inactive 成员。
- `send_message` 返回 `queued` **就意味着已持久**，**绝不重发**。
- 任务流程固定为 list → get → 用**当前** revision claim → 做事 → complete。
- readiness 从不自动启动 owner。
- **Lead 必须在给出最终答复前等待必需的 teammate**，并亲自跑一遍验收。

## 9. 冷恢复与 `inbox --ack` 协议

### 9.1 状态推导

`running` / `inactive` 由 `workers/<name>.pid` 的存活推导：

- pid 文件存在且进程存活 → `running`
- pid 文件存在但进程已退出 → `inactive`
- 只有 `member/provisioning`、worker 尚未确认启动 → `provisioning`
- 启动失败 → `failed`（**名字永久占用**，重名报 `TEAM_MEMBER_NAME_TAKEN`）

`provisioning` 表示成员创建进行中；`failed` 表示创建失败。`inactive` **只表示没有轮次在执行**，不代表任务完成、成功、失败或"在等别人"。

### 9.2 send_message 的两段式投递（官方语义对齐）

1. 先 append `message/queued` 并 **flush**（此刻消息已持久）。
2. 再尝试投递：
   - target 是 `running` → 写收件箱镜像（投递文件）并返回 `{"status":"accepted"}`，**不落 `message/delivered`**。消息**始终留在 inbox**，直到目标自己 `inbox --ack`。理由：官方只在目标会话**持久持有**该消息身份之后才 `markDelivered`（`agent-team/lib/index.js:945-965`，`checkpointDelivered` → `targetRecorded` → `markDelivered`）；Codex 侧唯一可信的目标侧证据就是 worker 自己 ack（`scripts/agent-team.mjs:1434-1442`、`:1729-1747`）。
   - 否则返回 `{"status":"queued"}`，**不投递**。
3. 恢复时只处理 **queued-minus-delivered**，按目标与队列顺序投递；崩溃在"已入队但模型未取走"时不会重复投递。

### 9.3 `inbox --ack`

`inbox` 读取某 target 的未投递消息：`{"messages":[{"messageId","from","text","queuedAt"}]}`。**只有加了 `--ack`** 才把读到的消息标记为 delivered（append `message/delivered`）。不加 `--ack` 就是纯窥视，不改变状态。

### 9.4 冷恢复（进程重启后）

1. 读 `journal.jsonl` 全量回放 → roster / mailbox / tasks。
2. 用 pid 存活重算每个成员的 `running` / `inactive`。
3. 未 delivered 的消息仍在队列里，可被 `inbox --ack` 取走。
4. **任务 owner 不会自动释放。** 成员死掉后它的 in_progress 任务仍然挂着 owner——必须显式 `reassign`（Lead only，清空 owner 或换人）或 `release`（仅 owner 或 Lead）。
5. 因 `delete` 是 tombstone 而 id 不复用、`task-<n>` 编号单调不回退，跨重启也不会发生 id 撞车。

## 10. 与官方实现的差异表

| 维度 | 官方 Agent Teams（DSH） | 本 skill（Codex） | 取舍说明 |
|---|---|---|---|
| 进程模型 | 同进程 continuable child agent | `codex exec` 子进程 | 子进程能跨崩溃存活、能换模型；代价是失去进程内 steer |
| 唯一真源 | Lead **会话日志**（`session.append` + flush） | `journal.jsonl` append-only 文件 | 语义等价；文件日志可被外部直接审计 |
| 派生状态 | `sessionProjections` 增量回放 | 每次命令顺序重放 journal | 文件重放更慢但更简单、无 schema 注册 |
| 事务串行化 | 每个 Lead 一条 promise 尾链（`journal.js:34-46`） | `lock` 目录 `mkdir` 自旋 + 超时 + 陈旧锁按 mtime 回收 | 文件锁对**多进程**更友好，但仍是 advisory |
| exactly-once 边界 | 进程内重试 + 去重；**mailbox 不保证跨进程 exactly-once** | 文件锁 + queued/delivered 两段式；仍**不保证**跨进程 exactly-once | 两者都在同一 checkout 上假设单写者纪律 |
| 中断 | `interrupt_agent` 走 subagent interrupt + `keepInbox`，**只取消当前 turn**，不释放 task owner、不删 mail | 子进程只能 kill；**没有 keepInbox 语义**，除非 pending 消息已先落盘 | 差异明确：本 skill 的"中断后 inbox 还在"来自**先落 journal 再投递**，不是来自 kill 本身 |
| dispose | 关闭准入 → 等已获准事务 → 释放 roster 中确切的 live direct child 及后代 | 无 dispose；靠 `interrupt_agent`/kill + 陈旧 pid 回收 | 冷恢复靠第 9 节流程补齐 |
| Web UI | `dsh-experimental-client-ui-agent-team` 广播完整 roster 与未删除任务板 | **无 UI**；只有 `status` / `journal` 文本 | 官方 UI 不参与本次交付 |
| 唤醒/等待 | `wait_agent` 观察注册之后的下一处变化，从不唤醒成员 | 同语义（`wait_agent --timeout-ms`，10000–3600000，默认 30000） | — |
| 消息大小/容量 | `maxMessageBytes` / `maxPendingMessagesPerMember` | 同上限，同错误码（`TEAM_MESSAGE_TOO_LARGE` / `TEAM_MAILBOX_FULL`） | — |
| write scope | 规范化前缀 + advisory 重叠警告 | 同规则、同警告、**同样绝不阻止** | 强制隔离只能靠 Codex 的 `--sandbox`，那是另一层 |
| 角色定义 | 无（`spawn_teammate` 只收 description + prompt） | 可挂 `~/.codex/agents/*.toml` 的三字段做角色库 | 本 skill 的增强，非官方行为 |

## 11. 本机环境限制与待确认

**实测到的阻塞（影响可信度，必须如实记录）：**

- `codex` **不在 PATH**（5.1）→ _spec.md §4.4 的默认 worker-cmd 在本机不可用，必须换绝对路径或显式 `--worker-cmd`。
- `codex exec` 在本机**无法完成一次真实 turn**：网络侧 `workspace routing discovery failed` + MCP 传输失败（`https://chatgpt.com/backend-api/ps/mcp`）。因此"推荐 worker-cmd 能跑通并产出 last message"这一点**未被端到端验证**。已确证的只是：CLI 接受 5.2 全部 flag、正常加载 config 与 hook、按 `--json` 输出 JSONL、失败时退出码 1 且不写 `-o` 文件。

**待确认清单：**

1. 【待确认】`codex exec` 能否以某个 `~/.codex/agents/*.toml` 的 custom agent 身份启动（无 `--agent` flag 实证）。
2. 【待确认】`codex exec resume` / `fork` 缺 `-s/--sandbox` 与 `-C/--cd` 时，`-c` 覆盖 cwd 与沙箱的**确切 config key**（如 `-c sandbox_mode=...` 是否生效）。
3. 【待确认】`-p/--profile` 叠加的 `<name>.config.toml` 是否可以承载 custom agent 定义。
4. 【待确认】本机网络恢复后，推荐 worker-cmd 的完整成功路径（last message 写出、JSONL 事件类型全集）。
5. 【待确认】`wait_agent` 在纯文件 store 上的实现（轮询 vs 长时观察）与其 `noProgress: {reason:"no-active-peer"}` 精确触发条件。
6. 【推断】陈旧锁按 mtime 回收的**具体阈值**：官方没有对应物，阈值由脚本自定。
