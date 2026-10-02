# 验证与溯源记录

包：`agent-teams-skill-1.1.0`（1.0.0 → 1.1.0：修掉"真实 codex worker 无法与 store 通信"的缺口）
被验证对象：`agent-teams/` 下的 7 个文件（与打包内容**逐字节相同**，见文末指纹表）

---

## 1. 逆向来源

| 项 | 值 |
|---|---|
| 插件族 | `@deepseek-ai/dsh-experimental-agent-team`、`-tool-agent-team`、`-agent-team-profile`、`-client-ui-agent-team` |
| 宿主 | DeepSeek Harness（DSH），npm 包 `@deepseek-ai/dsh` 0.2.0-rc.2 |
| 源码位置 | `<DSH_HOME>\profiles\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\<包名>\` |
| 说明 | 该插件族**不在任何 preset 的 `plugins` 列表里**，由 `dsh-experimental-agent-team-profile/cordis.patch.yml` 以 patch 插入，同时禁用旧的 `tool-subagent*` 四件套 |

> 文档里出现的 `C:\Users\UserX\.dsh\...` 行号引用全部指向上面这个源码位置，是**溯源证据**，不是本包的运行时依赖。

对齐度承诺：**九个工具名与参数名、结果 schema 字段、28 个错误码、`team:policy` 与 teammate 身份前缀逐字文本、五项上限**均与官方构建产物一致。1.1.0 的三处修复**没有改动任何官方错误码或结果 schema**（改动前后 `TEAM_*` 字面量集合均为 37 个、差集为空，由独立验证者用修复前副本做完整 diff 证明）。

## 2. 验证方式与结果

由一个**独立验证者**执行（它先从官方源码机器化抽取"神谕"，且明确不读被验证文档与规格；它拥有唯一的判 FAIL 权），共四轮：

| 轮次 | 范围 | 结果 |
|---|---|---|
| 阶段二 | 集合比对 71/71、引用审计、错误码表 28/28、action 矩阵 8/8、Codex flag 实测 19/19、frontmatter 解析、黑盒 E2E **203 项 / 15 场景** | **PASS-with-issues，真实 FAIL = 0** |
| 修复复验 | D-1~D-6 逐条收盘 + 回归对比 + 冻结校验 | **PASS，NO-REGRESSION：断言 203 → 238、场景 15 → 19** |
| 增量复验 | D-9/D-10 收盘 + 变更隔离（未变文件逐字节相同）+ 断言改严的反向变异自证 | **PASS，6/6，FAIL = 0** |
| **真实-worker 修复轮** | D-11~D-13 三项修复 + 逐项正向/反向断言 + 回归 + **真实 codex worker 端到端** | **PASS，独立复核 47/0 断言、回归 162/162、HOP-OK，无新缺陷** |

**真实 worker 一跳（此前唯一未验证的环节）现已端到端通过**，且由独立验证者复现了一次（它特意把 store 放在 workdir **之外**，以证明 `--add-dir` 真的生效）：

```
sandbox: workspace-write [workdir, /tmp, $TMPDIR, D:\...\hop-store]   ← --add-dir 生效
task-1:  revision 1 pending → revision 2 in_progress(owner=realbot) → revision 3 completed
worker → send_message → Lead: inbox --target lead --ack 收到汇报，journal 落 message/delivered
```

过程纪律（可复核）：**缺陷历史一条未删**（只改状态）；**未为了让修复通过而放宽任何断言**（唯一消失的旧断言 id 正是"编码缺陷行为"的那条，被更严的断言替换，未声明丢失 = 0）；修改验证断言时留下了旧/新规则并排 + 变严论证 + **反向自证**。1.1.0 的独立验证者还用了两个额外手法：在验证目录里找到**修复前的旧副本**做完整 `git diff --no-index`（因此能枚举**全部**改动，而不只是开发者描述的部分），以及为每项修复写**反向断言**（例如证明"不带 `--sandbox` 的 `codex exec` 真的是 read-only"）。

## 3. 过程中发现并修掉的缺陷（13 条，全部闭环）

| 编号 | 严重度 | 问题 |
|---|---|---|
| D-1 | **MEDIUM** | 文档写「target running 时发送侧落 `message/delivered`」与实现相反 —— 正确语义是**只有目标侧 `inbox --ack` 才产生 delivered**（否则 worker 读前崩溃会永久丢消息）。**实现是对的，文档错** |
| D-4 | **MEDIUM** | `init --lead-name alice` 后 `--as alice` 会**静默通过 Lead-only 权限校验**（真正的权限旁路）。修法：Lead 身份收窄为字面量 `lead`，`--lead-name` 降为纯展示标签，且 teammate 不得与 Lead 同名 |
| **D-11** | **MEDIUM** | **真实 teammate 无法运行 store CLI**：worker 沙箱是 `workspace-write [workdir]`，而 CLI 原件在 `~/.codex/skills/` 之外；Windows 上 `C:\Users\<你>` 是 **junction**，node 加载脚本时向上 realpath 直接报 `EPERM: operation not permitted, stat 'C:\Users\<你>'`（`Module._findPath` → `realpathSync`）。修法：`init` 在 store 内放一份**逐字节一致**的 CLI 副本（`<dir>/bin/agent-team.mjs`，结果里给出 `teammateCli`），损坏/删除会自动重建 |
| **D-12** | **MEDIUM** | **默认 worker 命令没带 `--sandbox`**：实测 `codex exec` 不带它时默认 **`read-only`**，于是 teammate 能读 store 却创建不了 `<dir>/lock`、写不了 `journal.jsonl`，**每条写命令都失败**成 `E_LOCK_FAILED: EPERM ... mkdir '<dir>/lock'`。修法：默认命令显式 `--sandbox workspace-write -C <cwd> --add-dir <dir>` |
| **D-13** | LOW | `--bootstrap` 的初版模板把 `--dir` 写在子命令**之前**，而 CLI 要求 `agent-team.mjs <子命令> [选项]` → 每条命令都 `E_USAGE`（这个 bug 是**真实 worker 自己在汇报里指出来的**）。修法：模板改为子命令在前 |
| D-2 | LOW | `codex exec fork` 与 `resume` 的 option 集合描述不精确（实测 resume 20 / fork 18，fork 少 `--last`、`--all`） |
| D-3 | LOW | 错误码表 2 行「来源」列指向判定机制行而非抛出该码的行（引用精度） |
| D-5 | LOW | `init` 幂等路径静默吞掉非法 limits（`--max-members 0` 返回 exit 0）。改为照常校验、报 `TEAM_INVALID_CONFIG` exit 2 |
| D-6 | LOW | 两处与官方的校验顺序差异（未知 action 的判定位置；`team_task_list` 的成员身份校验位置） |
| D-7 | 口径 | 作者自报行数不准（本机 `Get-Content .Count` 给错值，非交付缺陷） |
| D-8 | LOW | `codex-runtime.md` 缺 `--lead-name` 为纯展示标签的说明，与 `SKILL.md`/`README` 三方口径不一致 |
| D-9 | LOW | `protocol.md` 的约定段与 §6 表格自相矛盾（绝对句"机制行一律不进来源列"被自己的特例打脸）。改为与机器判据同构的表述 |
| D-10 | INFO | `SKILL.md` 未复述两个细节元素（缺 ≠ 矛盾） |

**另有一处口径更正（不是缺陷，但影响过可信度）**：1.0.0 曾把"真实 worker 跑不通"记为**网络/MCP 故障**（`workspace routing discovery failed`、MCP 到 `chatgpt.com` 传输失败）。**那是误判** —— 真因是本机 **codex / git / node 默认都不读系统代理**（本机 `http://127.0.0.1:12450`）。设上 `HTTPS_PROXY` 后 `codex exec` 立刻可用（实测 22 秒返回）。已同步更正 `codex-runtime.md` §5.6/§11 与 `scripts/README.md` §7。

## 4. 未验证的范围（诚实清单）

1. `codex exec resume`/`fork` 在缺少 `-s`/`-C` 时用 `-c` 覆盖沙箱与 cwd 的确切 config key。
2. 以 `~/.codex/agents/*.toml` 里自定义 agent 身份启动 `codex exec` 的可行路径（`codex exec` 无 `--agent` 选择器）。
3. 跨进程 exactly-once 投递压测（本包只给"重试 + 目标侧去重"）。
4. `E_LOCK_FAILED` / `E_INTERNAL` 的触发路径。
5. 三个错误码（`TEAM_DISPOSED` / `TEAM_DISPOSAL_TIMEOUT` / `TEAM_WAIT_ABORTED`）在单进程一次性 CLI 下**不可达**，仅作常量保留。
6. 浏览器 roster / 任务板 UI：官方有 `dsh-experimental-client-ui-agent-team`，**本次移植不含** Web 呈现。
7. **仍未验证的真实-worker 边界**（独立验证者列出）：原始 `EPERM`(junction) 根因只做了正向证明（bootstrap 指向副本 + 副本逐字节一致 + 真实 worker 零 EPERM），未再单独复现报错；`store` 位于 workdir **之内**时的沙箱头；`--context fork` 的真实 worker 路径；唤醒 inactive teammate 的真实续聊；`--run-sync` + 真实 codex；跨平台（只在 Windows 验证）；多 worker 并发/长跑。
8. `--run-sync`、`_worker_launcher`、陈旧锁阈值等实现细节属【推断】实现，见 `scripts/README.md` §7。

**已知简化**（均已在 `scripts/README.md` §7 逐条写明，非隐藏缺陷）：`--context fork` 仅记录不续聊；`interrupt_agent` 是进程级而非"只取消当前 turn"；Lead 可用性为【推断】（因此 teammate 发给 `lead` 的消息默认是 `queued`，需 Lead `inbox --ack` 取走）；后台 worker 多一层内部 launcher；`inbox --all` 与 `--bootstrap` 是脚本扩展；pid 复用无法识别；读命令可能因冷恢复结算而写 journal；**只读沙箱的 teammate 无法与 store 通信**（写不了 lock/journal），要"只读审查"请用 `workspace-write --add-dir` + prompt 约束。

## 5. 冻结指纹（bytes / LF / sha256，UTF-8）

| 文件 | bytes | LF | sha256[:16] |
|---|---|---|---|
| `agent-teams/SKILL.md` | 12510 | 151 | `af7876559227a64e` |
| `agent-teams/references/protocol.md` | 30096 | 323 | `819ac75af3c9a5ec` |
| `agent-teams/references/team-model.md` | 23499 | 192 | `c34e1a762292fc15` |
| `agent-teams/references/task-board.md` | 19665 | 216 | `836d494e99e163e6` |
| `agent-teams/references/codex-runtime.md` | 31434 | 418 | `01792ca921ad2965` |
| `agent-teams/scripts/agent-team.mjs` | 90382 | 2229 | `910c125d37ba589d` |
| `agent-teams/scripts/README.md` | 28862 | 397 | `1867b3dd986cfd1a` |

锁定逐字块（在 `protocol.md` 内，1.1.0 **未改动**）：`team:policy` 1995 字符 sha256[:16] `06dc8c495496e6ef`；teammate 身份前缀 345 字符（含结尾两个换行）sha256[:16] `a4596949b911faaf`。

> 写作约定说明：文档原本约定每份 reference 150–400 行。`codex-runtime.md` 现为 **418 行**，超出 18 行 —— 这是**有意为之**：新增的 §6.0 记录的正是"teammate 只能用 store 内副本 + 必须显式 `--sandbox workspace-write`"这两条**硬前提**，没有它们真实 worker 会完全跑不通。宁可变长，也不把这类会让人踩坑的内容省掉。

> 校验方法（本机 `Get-Content .Count` 数行会给出错值，请用 node）：
> ```powershell
> node -e "const fs=require('fs'),c=require('crypto');for(const f of process.argv.slice(1)){const b=fs.readFileSync(f);console.log((b.toString().match(/\n/g)||[]).length, c.createHash('sha256').update(b).digest('hex').slice(0,16), f)}" agent-teams/SKILL.md agent-teams/references/*.md agent-teams/scripts/*
> ```
