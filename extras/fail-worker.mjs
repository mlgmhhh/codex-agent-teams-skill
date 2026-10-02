// 失败 worker：立刻非零退出，模拟 codex exec 启动即失败。
process.stderr.write('FAIL-WORKER: refusing to start\n');
process.exit(3);
