/** 日志时间戳（服务器本地时间）：「11-06 16:41:25」 */
export function stamp(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 默认日志：带时间戳写到 stderr（stdout 留给 stdio 传输） */
export function stderrLog(msg: string): void {
  process.stderr.write(`${stamp()} ${msg}\n`);
}
