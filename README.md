# codex-agent-teams-skill

> 让 Codex（CLI / 桌面端）自己带一支**有名有姓的 agent 团队**干活——具名 teammate、持久消息、共享任务板，消息与任务状态挺过崩溃和重启。

这套协议**逆向自 DeepSeek Harness（DSH）内置的实验性 Agent Teams 插件族**：九个工具的名称与参数、结果结构、**28 个错误码**、五项上限、以及 `team:policy` 与 teammate 身份前缀的逐字文本，都与官方构建产物一致。

Codex 本身没有 teammate 工具，所以本仓库自带一个**零依赖的持久化 store**，用 `codex exec` 子进程充当 teammate。

```
                        Codex 会话（Lead）
                              │  node scripts/agent-team.mjs <命令>
                              ▼
        .agent-team/journal.jsonl   ← 唯一真源（append-only 事件日志）
                              │  每次读都回放派生
              ┌───────────────┼───────────────┐
              ▼               ▼               ▼
        roster(成员)     mailbox(消息)    任务板(CAS+revision)
              ▲
              │  同一支 CLI，--as <teammate>
        codex exec 子进程 = teammate（共享同一个 cwd）
```

---

## 特性

- **具名 teammate**：`spawn_teammate` 创建唯一小写名字的成员；名字永久保留、永不复用（含创建失败的）。
- **持久邮箱**：消息先落盘再投递。`queued` 就已经持久，**绝不重发**；`message/delivered` **只能由目标自己 `inbox --ack` 产生**（没有目标侧回执就不许替它宣称已投递）。
- **共享任务板**：任务带 `revision`，每次变更都是 compare-and-set，过期的编辑被拒绝而不是覆盖别人的成果；支持依赖（DAG）、`blocked-by` 未完成就不能 claim；`write-scopes` 重叠只告警不阻塞（**它不是锁**）。
- **挺过崩溃**：日志是唯一真源，换个进程重跑任意读命令即可恢复全部状态。
- **零 npm 依赖**：只用 `node:` 内置模块（`fs`/`path`/`os`/`crypto`/`child_process`）。Node ≥ 18。
- **跨平台**：Windows 优先（`mkdir` 锁、pid 存活探测、`taskkill /T /F`），同时可在 macOS / Linux 运行。
- **同一套词表**：CLI 子命令与官方工具名 1:1，方便对照文档与排错。

## 安装

把 `agent-teams/` 这**一个目录**复制到 Codex 的全局技能根：

| 平台 | 目标路径 |
|---|---|
| Windows | `%USERPROFILE%\.codex\skills\agent-teams\` |
| macOS / Linux | `~/.codex/skills/agent-teams/` |

```bash
git clone https://github.com/<你的账号>/codex-agent-teams-skill.git
# Windows PowerShell
Copy-Item -Recurse codex-agent-teams-skill\agent-teams "$env:USERPROFILE\.codex\skills\agent-teams"
# macOS / Linux
cp -r codex-agent-teams-skill/agent-teams ~/.codex/skills/agent-teams
```

然后**新开一个 Codex 会话**（技能在会话启动时加载，已开着的会话看不到它）。

细节与注意事项见 **[INSTALL.md](INSTALL.md)**。

## 怎么用

**不需要自己敲命令** —— 那些命令是 Codex 里的 agent 内部调的。你要做的只有两件：

1. 新开一个 Codex 会话；
2. 说一句话，例如：
   - 「用 agent 团队做这件事：把 `xxx` 拆成几路并行，最后要独立复核。」
   - 「开三个 teammate 分别查 A、B、C，第四个独立验证他们的结论。」

**触发词**：agent 团队 / 多智能体 / 并行分工 / 开几个 agent / Agent Teams。不提这些词，它不会自作主张开团队（这是官方策略的硬规则，也是本 skill 的第一条硬规则）。

## 命令速查

状态都在当前工作目录的 `.agent-team/` 下（建议加进 `.gitignore`）。

```powershell
$TEAM = "$env:USERPROFILE\.codex\skills\agent-teams\scripts\agent-team.mjs"

node $TEAM init                                   # 初始化（每个工作区一次，幂等）；结果里的 teammateCli 就是 teammate 要用的 CLI
node $TEAM spawn_teammate --name reviewer --description "审协议" --bootstrap --prompt "…"
node $TEAM list_agents                            # 成员与状态
node $TEAM send_message --target reviewer --message "先做第 1 节"
node $TEAM wait_agent --timeout-ms 300000         # 先 list 再 wait；不会唤醒 inactive 成员
node $TEAM team_task_create --subject "核对字段" --description "逐条比对" --write-scopes "a/b"
node $TEAM team_task_list --ready true
node $TEAM team_task_update --task-id task-1 --expected-revision 1 --action claim --as reviewer
node $TEAM inbox --target lead --ack              # Lead 收走回信
node $TEAM status                                 # 一屏摘要
```

九个工具名与参数名同官方：`spawn_teammate`、`send_message`、`list_agents`、`wait_agent`、`interrupt_agent`、`team_task_create/list/get/update`；另有 `init` / `inbox` / `status` / `journal` 四个运维命令（官方对应的是领域 API，不是模型可见工具）。

完整说明见 **[agent-teams/scripts/README.md](agent-teams/scripts/README.md)**。

## 目录结构

```
├── README.md                 本文件
├── INSTALL.md                安装、用法、注意事项（发给使用者看这份）
├── VERIFICATION.md           溯源 + 三轮验证结论 + 缺陷清单 + 未验证范围 + 冻结指纹
├── agent-teams/              ← 复制这个目录到 ~/.codex/skills/
│   ├── SKILL.md              入口：何时用/不用、硬规则、工具表、运行循环、收尾自检
│   ├── references/
│   │   ├── protocol.md       九工具完整协议、结果 schema、28 个错误码全表、逐字 policy
│   │   ├── team-model.md     身份、持久日志派生状态、roster 生命周期、mailbox、dispose、上限
│   │   ├── task-board.md     任务字段、CAS、8 个 action 矩阵、DAG readiness、tombstone
│   │   └── codex-runtime.md  Codex 侧映射：实测 flag、store 布局、推荐 worker-cmd、冷恢复
│   └── scripts/
│       ├── agent-team.mjs    持久化团队 store（零依赖，可执行）
│       └── README.md         CLI 速查、store 布局、worker 接线、与官方的差异与限制
└── extras/                   可选：在你自己机器上跑一遍黑盒自测
    ├── selftest.mjs          162 条断言（协议/CLI/任务板/上限/冷恢复），不消耗模型额度
    ├── selftest-storecopy.mjs 17 条断言：store 内 CLI 副本、默认 worker 沙箱 flag、--bootstrap 模板
    ├── fake-worker.mjs
    └── fail-worker.mjs
```

## 验证

本仓库的文档与脚本经过**三轮独立验证**（验证者先从官方源码机器化抽取"神谕"，且不读被验证文档）：

| 轮次 | 规模 | 结论 |
|---|---|---|
| protocol 一致性 + 黑盒 E2E | 集合比对 71/71、错误码 28/28、action 矩阵 8/8、E2E **203 项 / 15 场景** | FAIL = 0 |
| 修复复验 + 回归 | E2E **238 项 / 19 场景** | **NO-REGRESSION**，FAIL = 0 |
| 增量复验（含反向变异自证） | 变更隔离 + 冻结校验 | PASS，FAIL = 0 |

过程中发现并修掉 **10 条缺陷**（含 2 条 MEDIUM：一个真正的权限旁路、一处文档与实现相反的投递语义）。缺陷历史一条未删，全部在 **[VERIFICATION.md](VERIFICATION.md)**。

也在你自己的机器上验证（不花模型额度）：

```bash
# 先改 extras/selftest.mjs 与 extras/selftest-storecopy.mjs 顶部的路径常量为你的实际路径
node extras/selftest.mjs            # 期望 TOTAL pass=162 fail=0, exit 0
node extras/selftest-storecopy.mjs  # 期望 TOTAL pass=17 fail=0, exit 0
```

## 已知限制

诚实清单（完整版见 `agent-teams/scripts/README.md` §7 与 `VERIFICATION.md` §4）：

- **真实 `codex exec` worker 一跳已在作者机器上端到端验证通过**（2026-10-02，真实模型）：worker 启动 → 收到逐字身份前缀 → 认领任务（revision 1→2）→ 完成任务（2→3）→ 发消息给 Lead → Lead 确认收到。它需要三个前提，都已在 `--bootstrap` 与默认命令里处理好：① teammate 只用 **store 内 CLI 副本**（`init` 产出的 `<dir>/bin/agent-team.mjs`）——worker 沙箱只覆盖 workdir，而 skill 原件在 `~/.codex/skills/`，Windows 上 `C:\Users\<你>` 是 junction，node 解析它会 `EPERM`；② worker 命令必须显式 `--sandbox workspace-write`（`codex exec` 不带它时默认 **read-only**，teammate 会写不了 store）；③ 需要网络时设好代理（codex/git/node 都不读系统代理）。
- **只读沙箱的 teammate 无法与 store 通信**：它写不了 `lock`/`journal`，所以不能认领任务、也不能汇报。要"只读审查"，请给 `workspace-write --add-dir <store>` 并用 prompt 约束只读，而不是用 `--sandbox read-only`。
- **单进程、共享 checkout**：全员同一个 cwd，没有 worktree 隔离、没有文件锁、没有自动合并。需要强隔离请用 `git worktree` + 多个独立会话。
- **write-scope 只是提示**：Bash、formatter、代码生成器能绕过一切检查，必须由 Lead 检查最终 diff。
- **扁平且不可变的 roster**：只有 Lead 能创建直接 teammate；无嵌套团队、无重命名、无删除、无名字复用。
- **不会自动释放任务 owner**：成员失活、被中断、进程退出、干砸了都不释放，必须 Lead 显式 `reassign`。
- **mailbox 不保证跨进程 exactly-once**：只给"重试 + 目标侧去重"。同一 checkout 上多进程写是安全的（`mkdir` 锁），但投递语义仍是进程内判定。
- **`interrupt_agent` 是进程级**（杀 worker 进程树），没有官方那种"只取消当前 turn"的粒度。
- **`--context fork` 只是记录**：`codex exec resume/fork` 没有 `-s`/`-C`，所以实际仍是 fresh 进程。
- **三个错误码不可达**：`TEAM_DISPOSED` / `TEAM_DISPOSAL_TIMEOUT` / `TEAM_WAIT_ABORTED` 在单进程一次性 CLI 下无法触发，仅作常量保留。
- **无 Web UI**：官方有浏览器侧 roster/任务板（`dsh-experimental-client-ui-agent-team`），本次移植不含。

## 想自己核对这份逆向是否忠实？

文档里那些 `C:\Users\...` / `D:\ai\...` 绝对路径是**溯源标注**（"这条论断出自哪个文件的哪一行"），**不是运行时依赖** —— `agent-team.mjs` 里没有任何机器相关硬编码，复制即用。

要自己核对，先在你的机器上定位同一份源码（DSH 把实验插件嵌套装在嵌套 `node_modules` 里，**不在** profile 顶层）：

```bash
# DSH_HOME 默认 ~/.dsh
<DSH_HOME>/profiles/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/
  ├── dsh-experimental-agent-team/           # 领域服务（lib/index.js、lib/types/*）
  ├── dsh-experimental-tool-agent-team/      # 九个工具 schema + team:policy（lib/index.js）
  ├── dsh-experimental-agent-team-profile/   # profile patch 层
  └── dsh-experimental-client-ui-agent-team/ # 浏览器 UI（本次未移植）
```

文档每个文件开头都有一张「短名 → 绝对路径」对照表，把短名换成本机实际前缀即可逐条复核。校验冻结指纹（本机 `Get-Content .Count` 数行会给错值，请用 node）：

```bash
node -e "const fs=require('fs'),c=require('crypto');for(const f of process.argv.slice(1)){const b=fs.readFileSync(f);console.log((b.toString().match(/\n/g)||[]).length, c.createHash('sha256').update(b).digest('hex').slice(0,16), f)}" agent-teams/SKILL.md agent-teams/references/*.md agent-teams/scripts/*
```

## 许可

尚未指定许可证（默认保留所有权利）。如果你打算让别人自由使用/修改，请补一个 `LICENSE`（例如 MIT）——这是仓库所有者的决定，所以没有替你放。

---

**English TL;DR** — A Codex skill that runs a small named agent team in one session: named teammates, durable messages, a shared CAS task board, all state surviving crashes. Reverse-engineered from DeepSeek Harness's experimental Agent Teams plugin family (9 tools, 28 error codes, verbatim policy text, same limits). Codex has no teammate tool, so the repo ships a zero-dependency file-backed store that drives `codex exec` subprocesses as teammates. Requires Node ≥ 18 and a Codex build that supports `~/.codex/skills/<name>/SKILL.md`. Install: copy `agent-teams/` into your skills root and start a new Codex session. See [INSTALL.md](INSTALL.md) and [VERIFICATION.md](VERIFICATION.md).
