// 假 worker：校验 stdin 上的逐字身份前缀，打印结果，然后 sleep 指定毫秒。
// 用法: node fake-worker.mjs <sleepMs> <expectedName> [exitCode]
const sleepMs = Number(process.argv[2] ?? 1500);
const name = process.argv[3] ?? '';
const exitCode = Number(process.argv[4] ?? 0);

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  input += chunk;
});
process.stdin.on('end', async () => {
  const prefix = `<system-reminder>
You are teammate "${name}".
Your Team Lead is named "lead".
Use list_agents({}) to find your teammates and their names.
To message your Team Lead, use send_message({ target: "lead", message: "..." }).
To message another teammate, use send_message({ target: "<teammate name>", message: "..." }).
</system-reminder>

`;
  console.log(`FAKE-WORKER prefix-exact=${input.startsWith(prefix)} prompt-bytes=${Buffer.byteLength(input, 'utf8')}`);
  const deadline = Date.now() + sleepMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  console.log('FAKE-WORKER done');
  process.exit(exitCode);
});
