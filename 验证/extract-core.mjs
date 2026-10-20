/**
 * 从插件的 client.js 里抽出带 `#region loop-*` 标记的段落，写成可 import 的 .mjs，
 * 交给 verify-detect.mjs / verify-runtime.mjs 做回归验证 ——
 * 保证「验证的就是插件里真在跑的那份代码」。
 *
 * ⚠️ 合并为 dsh-loop-watcher 后的一处改名（2026-10-16）：
 *   原 loop-guard 的 `buildHandoverPrompt` 已改名为 **`buildGuardDraftPrompt`**。
 *   原因：合并进来 handover 的 `buildHandoverPrompt` 与它**同名但内容不同**
 *   （实测 816 vs 1179 字符，是两种不同的交接工作方式），两份都必须留。
 *   所以这里导出的是**改过名的那份**（横幅「生成交接指令」用的），
 *   菜单项用的那份由 `验证-handover.mjs` 单独验。
 *
 * 用法：node extract-core.mjs <client.js> <输出.mjs>
 */

import { readFileSync, writeFileSync } from 'node:fs';

const [, , source, target] = process.argv;
if (!source || !target) {
  console.error('用法：node extract-core.mjs <client.js> <输出.mjs>');
  process.exit(2);
}

const text = readFileSync(source, 'utf8');
const pattern = /\/\/ #region (loop-[a-z-]+)\n([\s\S]*?)\n[ \t]*\/\/ #endregion \1/g;
const parts = [];
const names = [];
for (const match of text.matchAll(pattern)) {
  names.push(match[1]);
  parts.push(`// ---- ${match[1]} ----\n${match[2]}`);
}
if (parts.length === 0) {
  console.error('没找到任何 `#region loop-*` 段落，请检查 client.js 的标记。');
  process.exit(1);
}

const exported = [
  'LoopDetector',
  'DEFAULT_DETECT_OPTIONS',
  'readTurnReasoning',
  // 合并时改过名：见文件头注释（与 handover 那份同名不同内容，两份都要留）。
  'buildGuardDraftPrompt',
  'shortSessionId',
  'findGuardNotices',
  'plainTextOf',
  'isFreshNotice',
  'locateInChat',
  'loadAlert',
  'parkAlert',
  'isDismissed',
  'markDismissed',
  'normalizeAlert',
  'scanGuardSeqs',
  'countOf',
  'mergeCount',
  'countLevel',
  // 导出工具路径的配置读写（合并后新增）—— 回归要验「未配置则隐藏交接 UI」这条分支。
  'resolveExportTool',
  'hasExportTool',
  'setExportToolPath',
  'EXPORT_TOOL_DEFAULT',
  'EXPORT_TOOL_STORAGE_KEY',
];
writeFileSync(
  target,
  `${parts.join('\n\n')}\n\nexport { ${exported.join(', ')} };\n`,
  'utf8',
);
console.log(`已抽出 ${parts.length} 段（${names.join(', ')}）-> ${target}`);
