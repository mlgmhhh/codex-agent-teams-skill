# 验证与溯源记录

包：`agent-teams-skill-1.0.0`
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

对齐度承诺：**九个工具名与参数名、结果 schema 字段、28 个错误码、`team:policy` 与 teammate 身份前缀逐字文本、五项上限**均与官方构建产物一致。

## 2. 验证方式与结果

由一个**独立验证者**执行（它先从官方源码机器化抽取"神谕"，且明确不读被验证文档与规格；它拥有唯一的判 FAIL 权），共三轮：

| 轮次 | 范围 | 结果 |
|---|---|---|
| 阶段二 | 集合比对 71/71、引用审计、错误码表 28/28、action 矩阵 8/8、Codex flag 实测 19/19、frontmatter 解析、黑盒 E2E **203 项 / 15 场景** | **PASS-with-issues，真实 FAIL = 0** |
| 修复复验 | D-1~D-6 逐条收盘 + 回归对比 + 冻结校验 | **PASS，NO-REGRESSION：断言 203 → 238、场景 15 → 19** |
| 增量复验 | D-9/D-10 收盘 + 变更隔离（未变文件逐字节相同）+ 断言改严的反向变异自证 | **PASS，6/6，FAIL = 0** |

过程纪律（可复核）：**缺陷历史一条未删**（只改状态）；**未为了让修复通过而放宽任何断言**（唯一消失的旧断言 id 正是"编码缺陷行为"的那条，被更严的断言替换，未声明丢失 = 0）；修改验证断言时留下了旧/新规则并排 + 变严论证 + **反向自证**（构造一条故意违反新规则的样例，证明新断言变红、旧断言视而不见）。

Lead 自己也按交付文档里写的命令跑了 32 步端到端验收（幂等 init、`--lead-name` 走领域错误通道、未知 action 的三段判定顺序、`--as teammate` 被拒、`accepted→ack` 语义、delete 不幂等），全部符合预期。

## 3. 过程中发现并修掉的缺陷（10 条，全部闭环）

| 编号 | 严重度 | 问题 |
|---|---|---|
| D-1 | **MEDIUM** | 文档写「target running 时发送侧落 `message/delivered`」与实现相反 —— 正确语义是**只有目标侧 `inbox --ack` 才产生 delivered**（否则 worker 读前崩溃会永久丢消息）。**实现是对的，文档错** |
| D-4 | **MEDIUM** | `init --lead-name alice` 后 `--as alice` 会**静默通过 Lead-only 权限校验**（真正的权限旁路）。修法：Lead 身份收窄为字面量 `lead`，`--lead-name` 降为纯展示标签，且 teammate 不得与 Lead 同名 |
| D-2 | LOW | `codex exec fork` 与 `resume` 的 option 集合描述不精确（实测 resume 20 / fork 18，fork 少 `--last`、`--all`） |
| D-3 | LOW | 错误码表 2 行「来源」列指向判定机制行而非抛出该码的行（引用精度） |
| D-5 | LOW | `init` 幂等路径静默吞掉非法 limits（`--max-members 0` 返回 exit 0）。改为照常校验、报 `TEAM_INVALID_CONFIG` exit 2 |
| D-6 | LOW | 两处与官方的校验顺序差异（未知 action 的判定位置；`team_task_list` 的成员身份校验位置） |
| D-7 | 口径 | 作者自报行数不准（本机 `Get-Content .Count` 给错值，非交付缺陷） |
| D-8 | LOW | `codex-runtime.md` 缺 `--lead-name` 为纯展示标签的说明，与 `SKILL.md`/`README` 三方口径不一致 |
| D-9 | LOW | `protocol.md` 的约定段与 §6 表格自相矛盾（绝对句"机制行一律不进来源列"被自己的特例打脸）。改为与机器判据同构的表述 |
| D-10 | INFO | `SKILL.md` 未复述两个细节元素（缺 ≠ 矛盾） |

## 4. 未验证的范围（诚实清单）

1. **真实 `codex exec` worker 一跳未端到端验证**：在原作者机器上 `codex` 不在 PATH，且外层网络/MCP 故障（`workspace routing discovery failed`、MCP 到 `chatgpt.com` 传输失败），CLI 会接受全部 flag、正常加载 config/hook、按 `--json` 输出 JSONL，然后以 exit 1 失败且不写 `-o` last-message。**全部 238 项 E2E 都用假 worker 驱动 store，未伪造任何 codex 输出。**
2. `codex exec resume`/`fork` 在缺少 `-s`/`-C` 时用 `-c` 覆盖沙箱与 cwd 的确切 config key。
3. 以 `~/.codex/agents/*.toml` 里自定义 agent 身份启动 `codex exec` 的可行路径（`codex exec` 无 `--agent` 选择器）。
4. 跨进程 exactly-once 投递压测（本包只给"重试 + 目标侧去重"）。
5. `E_LOCK_FAILED` / `E_INTERNAL` 的触发路径。
6. 三个错误码（`TEAM_DISPOSED` / `TEAM_DISPOSAL_TIMEOUT` / `TEAM_WAIT_ABORTED`）在单进程一次性 CLI 下**不可达**，仅作常量保留。
7. 浏览器 roster / 任务板 UI：官方有 `dsh-experimental-client-ui-agent-team`，**本次移植不含** Web 呈现。

**已知简化**（均已在 `scripts/README.md` §7 逐条写明，非隐藏缺陷）：`--context fork` 仅记录不续聊；`interrupt_agent` 是进程级而非"只取消当前 turn"；Lead 可用性为【推断】；后台 worker 多一层内部 launcher；`inbox --all` 为脚本扩展；pid 复用无法识别；读命令可能因冷恢复结算而写 journal。

## 5. 冻结指纹（LF 行数 / sha256[:16]，UTF-8）

| 文件 | LF | sha256[:16] |
|---|---|---|
| `agent-teams/SKILL.md` | 149 | `fb4c0df9310fe3c8` |
| `agent-teams/references/protocol.md` | 323 | `819ac75af3c9a5ec` |
| `agent-teams/references/team-model.md` | 192 | `c34e1a762292fc15` |
| `agent-teams/references/task-board.md` | 216 | `836d494e99e163e6` |
| `agent-teams/references/codex-runtime.md` | 399 | `c314d9e87b4d63db` |
| `agent-teams/scripts/agent-team.mjs` | 2102 | `3894582db1ebe9b4` |
| `agent-teams/scripts/README.md` | 349 | `2da00c6c7394a576` |

锁定逐字块（在 `protocol.md` 内）：`team:policy` 1995 字符 sha256[:16] `06dc8c495496e6ef`；teammate 身份前缀 345 字符（含结尾两个换行）sha256[:16] `a4596949b911faaf`。

> 校验方法（本机 `Get-Content .Count` 数行会给出错值，请用 node）：
> ```powershell
> node -e "const fs=require('fs'),c=require('crypto');for(const f of process.argv.slice(1)){const b=fs.readFileSync(f);console.log((b.toString().match(/\n/g)||[]).length, c.createHash('sha256').update(b).digest('hex').slice(0,16), f)}" agent-teams/SKILL.md agent-teams/references/*.md agent-teams/scripts/*
> ```
