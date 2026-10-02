# agent-teams —— 给 Codex 用的「智能体团队」Skill

一句话：让 Codex 里**一个会话自己带一支有名有姓的 agent 团队**干活——具名 teammate、持久消息、共享任务板，消息与任务状态挺过崩溃。

这套协议**逆向自 DeepSeek Harness 内置的实验性 Agent Teams 插件族**（九工具协议、结果形状、28 个错误码、上限都 1:1 对齐），Codex 本身没有 teammate 工具，所以包里自带一个零依赖的持久化 store + 用 `codex exec` 子进程当 teammate。

---

## 1. 前置要求

| 项 | 要求 |
|---|---|
| **Codex**（CLI 或桌面端） | 版本需支持 `~/.codex/skills/<名字>/SKILL.md` 这套技能机制 |
| **Node.js** | **≥ 18**（store 零 npm 依赖，只用 `node:` 内置模块） |
| 工作目录 | 所有成员共享同一个 cwd，**没有 worktree 隔离** |

## 2. 安装（30 秒）

把 `agent-teams\` 这**一个目录**整个复制到 Codex 的全局技能根：

| 平台 | 目标路径 |
|---|---|
| Windows | `%USERPROFILE%\.codex\skills\agent-teams\` |
| macOS / Linux | `~/.codex/skills/agent-teams/` |

复制完应该长这样（`SKILL.md` 必须在**这一层**）：

```
.codex/skills/agent-teams/
├── SKILL.md
├── references/   （protocol.md / team-model.md / task-board.md / codex-runtime.md）
└── scripts/      （agent-team.mjs / README.md）
```

然后**新开一个 Codex 会话**——技能是在会话启动时加载的，已经开着的会话看不到它。

验证装好了：在 Codex 里问一句「你有哪些 skill？」或直接说下面第 3 节那句话。

## 3. 怎么用

**不需要自己敲命令**（那些命令是 Codex 里的 agent 内部调的）。你只要：

1. 新开一个 Codex 会话；
2. 说一句话，例如：

   - 「用 agent 团队做这件事：把 `xxx` 拆成几路并行，最后要独立复核。」
   - 「开三个 teammate 分别查 A、B、C，第四个独立验证他们的结论。」

**触发词**：agent 团队 / 多智能体 / 并行分工 / 开几个 agent / Agent Teams。不提这些词它不会自作主张开团队（这是硬规则）。

它会自己完成三步：**切分**成互不共享写状态的任务（标清改哪些文件、依赖谁）→ **派活**给具名 teammate → **盯进度**并在给你结论前等齐所有人。

## 4. 可选：在你自己机器上跑一遍自测

`extras\selftest.mjs` 是原作者的 162 条断言黑盒自测（不消耗模型额度，用假 worker 驱动 store）。

跑之前改 **`selftest.mjs` 第 7、8 行**这两个常量为你自己的路径：

```js
const SCRIPT = 'C:\\Users\\UserX\\.codex\\skills\\agent-teams\\scripts\\agent-team.mjs';  // 改成你的 SKILL 路径
const TMP    = 'D:\\ai\\agent-teams-verify\\tmp-store-builder';                            // 改成任意空目录
```

然后：

```powershell
node extras\selftest.mjs      # 期望 TOTAL pass=162 fail=0, exit 0
```

（`extras\` 里的文件是原作者的测试材料，路径常量写死在他的机器上，所以必须改这两行；`agent-teams\` 里的 skill 本身没有任何机器相关硬编码，复制即用。）

## 5. 注意事项

- **每个 teammate 是一次真实的模型调用**，会消耗额度。按独立工作流的数量开（通常 3–4 个：几个干活 + 一个独立复核），默认上限 8 个。
- **`codex` 可能不在 PATH**：脚本会按 `--worker-cmd` → `AGENT_TEAM_WORKER_CMD` → `CODEX_CLI_PATH` → 常见安装目录的顺序自动定位可执行文件；找不到会明确报错，不要裸写 `codex exec`。
- **文档里的 `C:\Users\UserX\...` 路径是"逆向来源出处"的标注**（原作者机器上被逆向的 DSH 插件源码位置），**不是运行时依赖**——在你机器上这些路径不存在是正常的，不用管。唯一需要改的是 `extras\selftest.mjs` 那两行。
- **`.agent-team/` 建议加进 `.gitignore`**：团队状态（`journal.jsonl` 是唯一真源）默认写在当前工作目录下。
- **Lead 的身份恒为字面量 `lead`**；`init --lead-name` 只是展示标签、不产生第二个身份，**建议不要用**（相关设计说明见 `references/codex-runtime.md` §4.1）。
- 需要**独立工作目录 / 远端成员 / 自动合并 / 文件锁**的场景本方案不支持，请改用 `git worktree` + 多个独立会话。

## 6. 卸载

删掉 `.codex/skills/agent-teams/` 即可；项目里的 `.agent-team/` 目录也一并删掉（那就是全部状态）。

---

更细的内容：`agent-teams/SKILL.md`（入口与硬规则）、`agent-teams/scripts/README.md`（CLI 速查、store 布局、worker 接线、冷恢复）、`agent-teams/references/`（协议/团队模型/任务板/Codex 映射）；本包的验证与溯源见同目录 `VERIFICATION.md`。
