/**
 * 用真实会话数据回归验证 JS 检测核心，并与 Python 基准逐项比对。
 *
 * 用法：node verify-detect.mjs [--core <从 client.js 抽取的 region 文件>]
 * 默认直接 import ./loop-detect.mjs。
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CALIB = path.join(HERE, '校准');

async function loadDetector() {
  const coreArgIndex = process.argv.indexOf('--core');
  const file = coreArgIndex >= 0 && process.argv[coreArgIndex + 1]
    ? process.argv[coreArgIndex + 1]
    : path.join(HERE, 'loop-detect.mjs');
  if (!existsSync(file)) {
    console.error(`找不到检测核心：${file}`);
    console.error('请用 --core 指定，或先跑 extract-core.mjs 从插件 client.js 里抽取。');
    process.exit(1);
  }
  const module = await import(pathToFileURL(file).href);
  return { LoopDetector: module.LoopDetector, source: file };
}

/**
 * 读一份会话语料（`.jsonl`）。
 *
 * ⚠️ **这些语料不在公开仓库里**：它们来自真实会话（含推理全文、IP、路径等
 * 私人信息），已被仓库根的 `.gitignore` 排除。所以 clone 下来的公开仓库
 * 天生没有它们 —— 这不是错误，是刻意的隐私决定。
 *
 * 因此返回值是 `null`（而不是抛 ENOENT）：调用方据此**跳过**依赖语料的用例，
 * 并明确告知「这一段在公开仓库里跑不了」，而不是让整个套件崩在半路。
 */
function readJsonl(file) {
  if (!existsSync(file)) return null;
  const rows = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    rows.push(JSON.parse(line));
  }
  return rows;
}

const { LoopDetector: Detector, source } = await loadDetector();
const baselineFile = path.join(CALIB, 'python-baseline.json');
if (!existsSync(baselineFile)) {
  console.error(`缺少校准基准：${baselineFile}`);
  console.error('该文件描述「检测判据在真实语料上的预期表现」，是第 2 段的对照表。');
  process.exit(1);
}
const baseline = JSON.parse(readFileSync(baselineFile, 'utf8'));

/** 这套语料在不在（公开仓库里没有，属正常，不是故障）。 */
const haveCorpus = baseline.every((e) => existsSync(path.join(CALIB, `${e.key}.jsonl`)));

let failures = 0;
console.log(`检测核心来源：${source}\n`);

if (!haveCorpus) {
  console.log('='.repeat(126));
  console.log('未检测到会话语料（验证/校准/*.jsonl）—— 本段**全部跳过**。');
  console.log('');
  console.log('这是刻意的隐私决定，不是故障：语料来自真实会话（含推理全文、内网 IP、');
  console.log('本机路径等私人信息），发布时已被 .gitignore 排除。');
  console.log('');
  console.log('想在本机跑完整第 2 段，需要自备同样形状的语料文件：');
  console.log('  验证/校准/pos-XXX.jsonl   ← 已知会打转的会话（每行 {turn, step, text}）');
  console.log('  验证/校准/neg-XXX.jsonl   ← 已知不打转的会话');
  console.log('并同步更新 python-baseline.json 里的 key 与预期值。');
  console.log('='.repeat(126));
}

console.log('样本            段数   行数(Py/JS)      最高频行        次数(Py/JS)      占比(Py/JS)     run(Py/JS)  判定(Py/JS)');
console.log('-'.repeat(126));

for (const expected of baseline) {
  const rows = haveCorpus ? readJsonl(path.join(CALIB, expected.key + '.jsonl')) : null;
  if (rows === null) continue;
  const detector = new Detector();
  rows.forEach((row, index) => {
    // 补一个换行，让「段末尾未换行的行」也计入，与 Python 语义对齐。
    detector.feed(`${row.turn}:${row.step}:${index}`, (row.text ?? '') + '\n');
  });
  const stats = detector.stats();
  const ratioDiff = Math.abs(stats.ratio - expected.ratio);
  // Python 基准的 best_run 对「只有一行的段」记为 0（它只在相邻比较时更新），
  // JS 记为 1；两者在阈值 100 面前等价，这里当作同一档。
  const runSame = expected.run === stats.bestRun
    || (expected.run < 2 && stats.bestRun < 2);
  const ok = stats.loopy === expected.loopy
    && runSame
    && stats.topCount === expected.count
    && stats.lines === expected.lines
    && stats.topLine === expected.line
    && ratioDiff < 1e-6;
  if (!ok) failures += 1;
  const verdict = (s) => (s ? '打转' : 'ok');
  console.log(
    `${expected.key.padEnd(15)}`
    + `${String(rows.length).padStart(4)}   `
    + `${String(expected.lines).padStart(6)}/${String(stats.lines).padEnd(6)}  `
    + `${JSON.stringify(expected.line).padEnd(14)} `
    + `${String(expected.count).padStart(6)}/${String(stats.topCount).padEnd(6)}  `
    + `${expected.ratio.toFixed(4)}/${stats.ratio.toFixed(4)}  `
    + `${String(expected.run).padStart(4)}/${String(stats.bestRun).padEnd(4)}  `
    + `${verdict(expected.loopy)}/${verdict(stats.loopy)}  ${ok ? '' : '  <<< 不一致'}`,
  );
}

// 增量正确性：同一段反复喂「不断增长的前缀 + 最后一次性喂全文」，结果必须一致。
// 语料缺失（公开仓库的正常状态）时跳过 —— 这条本来就要一份足够大的真实语料才有意义。
const sample = haveCorpus ? readJsonl(path.join(CALIB, `${baseline[0].key}.jsonl`)) : null;
if (sample === null) {
  console.log('\n增量喂入与一次性喂入一致：（语料缺失，跳过）');
} else {
  const incremental = new Detector();
  const oneShot = new Detector();
  sample.forEach((row, index) => {
    const key = `${row.turn}:${row.step}:${index}`;
    const text = (row.text ?? '') + '\n';
    oneShot.feed(key, text);
    for (let cut = 1; cut < text.length; cut += Math.max(1, Math.floor(text.length / 7))) {
      incremental.feed(key, text.slice(0, cut));
    }
    incremental.feed(key, text);
  });
  const a = incremental.stats();
  const b = oneShot.stats();
  const incrementalOk = a.loopy === b.loopy && a.bestRun === b.bestRun
    && a.topCount === b.topCount && a.lines === b.lines && a.chars === b.chars;
  console.log(`\n增量喂入与一次性喂入一致：${incrementalOk ? '是' : '否'}`);
  if (!incrementalOk) {
    failures += 1;
    console.log('  增量:', JSON.stringify({ ...a, topLine: undefined }));
    console.log('  一次:', JSON.stringify({ ...b, topLine: undefined }));
  }
}

// 最短长度门槛：不足 minChars 的文本不得判定。
const tiny = new Detector();
tiny.feed('t', '好。\n'.repeat(2000));
const tinyStats = tiny.stats();
const gateOk = tinyStats.tooShort === true && tinyStats.loopy === false;
console.log(`最短长度门槛（2000 行但仅 6000 字符不判定）：${gateOk ? '通过' : '失败'}`);
if (!gateOk) failures += 1;

console.log(`\n${failures === 0 ? '全部通过' : `有 ${failures} 项不一致`}`);
process.exit(failures === 0 ? 0 : 1);
