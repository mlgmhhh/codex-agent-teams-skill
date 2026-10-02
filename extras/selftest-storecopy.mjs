/**
 * 针对 2026-10-02 真实-worker 缺口的三项修复做锁定测试（不消耗模型额度）：
 *   F1  store 内自带 CLI 副本（`<dir>/bin/agent-team.mjs`），且与原件逐字节一致、被破坏后自动修复
 *   F2  默认 worker 命令必须显式 `--sandbox workspace-write` + `--add-dir <store>`（原来默认是 read-only）
 *   F3  `--bootstrap` 生成的命令模板必须是"子命令在前"（--dir 前置 = E_USAGE）
 *
 * 用 stub codex（`CODEX_CLI_PATH` 指向一个只退出的 .cmd）来观察 F2 生成的命令，
 * 因此**不会**发起任何真实模型调用。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const SCRIPT = 'C:\\Users\\UserX\\.codex\\skills\\agent-teams\\scripts\\agent-team.mjs';
const ROOT = 'D:\\ai\\agent-teams-verify\\fix-tests\\work';

let pass = 0;
let fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS  ${name}${detail ? '  :: ' + detail : ''}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? '  :: ' + detail : ''}`); }
}
function run(args, env = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    cwd: ROOT,
  });
}
function fresh(sub) {
  const dir = path.join(ROOT, sub, '.agent-team');
  fs.rmSync(path.join(ROOT, sub), { recursive: true, force: true });
  fs.mkdirSync(path.join(ROOT, sub), { recursive: true });
  return dir;
}

fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(ROOT, { recursive: true });
const sourceBytes = fs.readFileSync(SCRIPT);

/* ---- F1：store 内 CLI 副本 ---- */
{
  const dir = fresh('f1');
  const r = run(['init', '--dir', dir]);
  const json = JSON.parse(r.stdout.trim().split('\n').pop());
  const copy = path.join(dir, 'bin', 'agent-team.mjs');
  check('F1 init 结果含 teammateCli', typeof json.teammateCli === 'string' && json.teammateCli.length > 0, json.teammateCli);
  check('F1 teammateCli 指向 <dir>/bin/agent-team.mjs', json.teammateCli === copy, json.teammateCli);
  check('F1 副本存在', fs.existsSync(copy));
  check('F1 副本与原件逐字节一致', fs.readFileSync(copy).equals(sourceBytes));

  fs.writeFileSync(copy, 'broken');
  run(['init', '--dir', dir]);
  check('F1b 副本被破坏后 init 自动修复', fs.readFileSync(copy).equals(sourceBytes));

  fs.rmSync(copy);
  run(['init', '--dir', dir]);
  check('F1c 副本被删除后 init 重新生成', fs.existsSync(copy) && fs.readFileSync(copy).equals(sourceBytes));
}

/* ---- F2 + F3：默认 worker 命令与 bootstrap 模板 ---- */
{
  const stub = path.join(ROOT, 'stub-codex.cmd');
  fs.writeFileSync(stub, '@echo off\r\nexit /b 0\r\n');

  const dir = fresh('f2');
  run(['init', '--dir', dir]);
  // 用后台路径（不加 --run-sync）：startWorker 会把生成的命令写进 workers/<name>.launch.json，
  // 而 run-sync 路径不写 launch.json 且会在退出时删掉 .pid。
  const r = run(
    ['spawn_teammate', '--dir', dir, '--name', 'stubbot', '--description', 'd', '--prompt', 'do the thing', '--bootstrap'],
    { CODEX_CLI_PATH: stub },
  );
  check('F2 用 stub codex 能跑通 spawn', r.status === 0 || /member/.test(r.stdout), (r.stdout || r.stderr || '').trim().slice(0, 120));

  const launchFile = path.join(dir, 'workers', 'stubbot.launch.json');
  let command = '';
  if (fs.existsSync(launchFile)) {
    try { command = JSON.parse(fs.readFileSync(launchFile, 'utf8')).command ?? ''; } catch { command = ''; }
  }
  check('F2 拿到默认 worker 命令', command.length > 0, command.slice(0, 160));
  check('F2 默认命令含 --sandbox workspace-write', /--sandbox workspace-write/.test(command), command.slice(0, 200));
  check('F2 默认命令含 -C <cwd>', /(^|\s)-C\s/.test(command), command.slice(0, 200));
  check('F2 默认命令含 --add-dir <store>', command.includes('--add-dir') && command.includes(dir), command.slice(0, 240));

  const promptFile = path.join(dir, 'workers', 'stubbot.prompt.txt');
  const prompt = fs.readFileSync(promptFile, 'utf8');
  check('F3 身份前缀仍在 prompt 最前（逐字）', prompt.startsWith('<system-reminder>\nYou are teammate "stubbot".'), JSON.stringify(prompt.slice(0, 46)));
  check('F3 prompt 含 bootstrap 段', prompt.includes('--- team bootstrap') && prompt.includes('--- end bootstrap ---'));
  check('F3 bootstrap 用 store 内副本路径', prompt.includes(path.join(dir, 'bin', 'agent-team.mjs')));
  check('F3 bootstrap 子命令在前（不再 --dir 前置）', /agent-team\.mjs"\s+(inbox|team_task_list|team_task_update|send_message)\s/.test(prompt), (prompt.match(/.*inbox --target.*/) ?? [''])[0].trim().slice(0, 140));
  check('F3 不存在 --dir 前置的错误写法', !/agent-team\.mjs"\s+--dir/.test(prompt));

  /* ---- 警告：prompt 不提 store 内副本时应提示 ---- */
  const dir2 = fresh('f3warn');
  run(['init', '--dir', dir2]);
  const w = run(
    ['spawn_teammate', '--dir', dir2, '--name', 'nowarnbot', '--description', 'd', '--prompt', 'run node C:\\Users\\x\\.codex\\skills\\agent-teams\\scripts\\agent-team.mjs status', '--worker-cmd', `"${stub}"`],
  );
  check('F3warn 未用 --bootstrap 且指向 skill 路径时给出警告', /store-local CLI|CANNOT run/.test(w.stderr || ''), (w.stderr || '').split('\n')[0].slice(0, 140));
}

console.log(`\nTOTAL pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 2);
