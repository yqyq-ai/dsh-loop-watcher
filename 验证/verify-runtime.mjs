/**
 * 运行期逻辑的回归验证：用「真实会话数据合成出来的 snapshot」跑
 * readTurnReasoning → LoopDetector，检查插件真正会走的这条链路。
 *
 * 用法：node verify-runtime.mjs [--core <抽取出来的 .mjs>]
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CALIB = path.join(HERE, '校准');

async function loadCore() {
  const index = process.argv.indexOf('--core');
  const file = index >= 0 ? process.argv[index + 1] : path.join(HERE, 'loop-detect.mjs');
  if (!existsSync(file)) {
    console.error(`找不到检测核心：${file}`);
    process.exit(1);
  }
  const module = await import(pathToFileURL(file).href);
  return { module, file };
}

const { module: core, file: coreFile } = await loadCore();
const { LoopDetector, readTurnReasoning, buildGuardDraftPrompt, shortSessionId, findGuardNotices, isFreshNotice, locateInChat, loadAlert, parkAlert, isDismissed, markDismissed, normalizeAlert, scanGuardSeqs, countOf, mergeCount, countLevel, resolveExportTool, hasExportTool, setExportToolPath, EXPORT_TOOL_DEFAULT, EXPORT_TOOL_STORAGE_KEY } = core;

let failures = 0;
function check(name, ok, detail) {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? `  ${detail}` : ''}`);
  if (!ok) failures += 1;
}

/** 造一个 store，同时支持 values() 与 get()（真实 store 两者都有）。 */
function makeStore(nodes) {
  return {
    // 运行时的 store 同时有 values / keys / get；keys 是「定位」按钮拿到 nodeKey 的来源，
    // 所以这里必须一起提供，否则测的就是另一条降级路径。
    keys: () => nodes.keys(),
    values: () => nodes.values(),
    get: (key) => nodes.get(key),
  };
}

function assistantNode(turn, step, reasoning, status = 'running') {
  // ⚠️ seq 放在节点上的 anchorSeq，**不是** data 里 —— 这是 DSH 的真实形状：
  //    chatNode(context, kind, anchorSeq, data)，而 assistant-step 的 data 只有
  //    status/turn/step/blocks/time/usage/finalNode。曾经测的是 data.seq（不存在的字段），
  //    于是「按 seq 反推 turn」这条定位退路一直是坏的却测不出来。
  return {
    kind: 'assistant-step',
    key: `${turn}:${step}`,
    anchorSeq: undefined, // 由下面的 helper 覆盖
    data: {
      status,
      turn,
      step,
      blocks: [
        { kind: 'reasoning', text: reasoning },
        { kind: 'text', text: '答案正文不该被计入。' },
        { kind: 'tool-call', callId: 'x' },
      ],
    },
  };
}

/** 造一个带 anchorSeq 的 assistant 节点（DSH 里的真实形状）。 */
function stepNode(turn, step, anchorSeq, reasoning = '推理') {
  return { ...assistantNode(turn, step, reasoning), anchorSeq };
}

console.log(`检测核心：${coreFile}\n`);

// ---------------------------------------------------------------- 纯结构用例
console.log('一、readTurnReasoning 的结构处理');

{
  const nodes = new Map([
    ['1:1', assistantNode(1, 1, '第一轮的推理\n', 'settled')],
    ['2:1', assistantNode(2, 1, '第二轮推理甲\n', 'settled')],
    ['2:2', assistantNode(2, 2, '第二轮推理乙\n', 'running')],
  ]);
  const snapshot = { nodes: makeStore(nodes), order: [...nodes.keys()] };
  const current = readTurnReasoning(snapshot);
  check('只取最大 turn', current !== null && current.turn === 2, `turn=${current && current.turn}`);
  check('段数 = 该 turn 的 step 数', current !== null && current.segments.length === 2,
    `segments=${current && current.segments.length}`);
  check('running 判定为真', current !== null && current.running === true);
  check('只累计 reasoning 块',
    current !== null && current.segments.every((segment) => !segment.text.includes('答案正文')));
}

{
  const nodes = new Map([['2:1', assistantNode(2, 1, '都结束了\n', 'settled')]]);
  const snapshot = { nodes: makeStore(nodes), order: ['2:1'] };
  const current = readTurnReasoning(snapshot);
  check('全部 settled 时 running = false', current !== null && current.running === false);
}

{
  // 只有 order + get，没有 values()：走回退路径。
  const nodes = new Map([['3:1', assistantNode(3, 1, '回退路径\n')]]);
  const store = { get: (key) => nodes.get(key) };
  const snapshot = { nodes: store, order: ['3:1'] };
  const current = readTurnReasoning(snapshot);
  check('store 没有 values() 时退回 order + get',
    current !== null && current.turn === 3 && current.segments.length === 1);
}

{
  const snapshot = { nodes: makeStore(new Map()), order: [] };
  check('空快照返回 null', readTurnReasoning(snapshot) === null);
  check('没有 nodes 时返回 null', readTurnReasoning({}) === null);
  check('snapshot 为 null 时返回 null', readTurnReasoning(null) === null);
}

{
  const nodes = new Map([['1:1', { kind: 'user', key: '1:1', data: { turn: 9 } }]]);
  const snapshot = { nodes: makeStore(nodes), order: ['1:1'] };
  check('只有非 assistant-step 节点时返回 null', readTurnReasoning(snapshot) === null);
}

// ---------------------------------------------------------------- 真实数据用例
console.log('\n二、用真实会话数据合成 snapshot 跑整条链路');

function loadTurn(key, turn) {
  const rows = [];
  for (const line of readFileSync(path.join(CALIB, `${key}.jsonl`), 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    const row = JSON.parse(line);
    if (row.turn === turn) rows.push(row);
  }
  return rows;
}

/** 模拟流式增长：把每个 step 的文本分 8 次喂进去，最后再喂完整文本。 */
function runTurn(key, turn) {
  const rows = loadTurn(key, turn);
  const nodes = new Map();
  rows.forEach((row, index) => {
    nodes.set(`${turn}:${index}`, assistantNode(turn, index, ''));
  });
  const snapshot = { nodes: makeStore(nodes), order: [...nodes.keys()] };
  const detector = new LoopDetector();
  let hitAt = null;
  const steps = 8;
  for (let slice = 1; slice <= steps; slice += 1) {
    rows.forEach((row, index) => {
      const text = row.text ?? '';
      const cut = Math.floor((text.length * slice) / steps);
      nodes.set(`${turn}:${index}`, assistantNode(turn, index, text.slice(0, cut)));
    });
    const current = readTurnReasoning(snapshot);
    if (current === null || !current.running) continue;
    for (const segment of current.segments) detector.feed(segment.key, segment.text);
    const stats = detector.stats();
    if (stats.loopy && hitAt === null) hitAt = { slice, chars: stats.chars, stats };
  }
  rows.forEach((row, index) => nodes.set(`${turn}:${index}`, assistantNode(turn, index, row.text ?? '')));
  const current = readTurnReasoning(snapshot);
  for (const segment of current.segments) detector.feed(segment.key, segment.text);
  return { detector, final: detector.stats(), hitAt, segments: current.segments.length };
}

/**
 * 真实语料 cases（语料不在公开仓库里，见下方 hasRealCorpus 的说明）。
 *
 * key 用**中性名**（pos-sample-1 / neg-sample-1…）而不是真实会话短 ID：
 * 真实 ID 会关联到作者机器 .dsh/sessions 里的会话，属私人元数据。
 * 在本机跑时，把 验证/校准/<key>.jsonl 放好即可（key 自己定，这里同步改）。
 */
const realCases = [
  ['pos-sample-1', 3],
  ['pos-sample-2', 13],
  ['neg-sample-1', 1],
  ['neg-sample-2', 87],
  ['neg-sample-3', 13],
  ['neg-sample-4', 5],
];
const hasRealCorpus = realCases.every(([key]) => existsSync(path.join(CALIB, `${key}.jsonl`)));

if (!hasRealCorpus) {
  console.log('\n二、用真实会话数据合成 snapshot 跑整条链路');
  console.log('  （跳过：公开仓库不含私人会话语料 验证/校准/*.jsonl，这是刻意的隐私决定。');
  console.log('    在本机自备同形状语料并改 realCases 里的 key 即可启用本段。）');
}

if (hasRealCorpus) {
  const [pos1Key, pos1Turn] = realCases[0];
  const result = runTurn(pos1Key, pos1Turn);
  check(`正样本 turn ${pos1Turn} 判定打转`, result.final.loopy === true,
    `chars=${result.final.chars} count=${result.final.topCount} 占比=${result.final.ratio.toFixed(3)}`);
  check(`正样本 turn ${pos1Turn} 在喂入早期就命中（不是等到最后）`,
    result.hitAt !== null && result.hitAt.slice <= 8,
    result.hitAt ? `第 ${result.hitAt.slice}/8 次采样首次命中，约 ${result.hitAt.chars} 字` : '从未命中');

  const [pos2Key, pos2Turn] = realCases[1];
  const result2 = runTurn(pos2Key, pos2Turn);
  check(`正样本 turn ${pos2Turn} 判定打转`, result2.final.loopy === true,
    `count=${result2.final.topCount} 占比=${result2.final.ratio.toFixed(3)}`);
}

if (hasRealCorpus) {
  for (const [key, turn] of realCases.slice(2)) {
    const result = runTurn(key, turn);
    check(`${key} turn ${turn} 不得误报`, result.final.loopy === false,
      `count=${result.final.topCount} 占比=${result.final.ratio.toFixed(3)} run=${result.final.bestRun}`);
  }
}

// ---------------------------------------------------------------- 交接指令
console.log('\n三、交接指令');

{
  // ⚠️ 这里一律用**一眼可辨的合成值**（deadbeef / 00000000 这类），不要用真实会话 ID：
  // 断言只验「短 ID 提取」与「指令里含传入的 ID」，具体是什么值毫无意义。
  // 真实 UUID 会关联到作者机器 .dsh/sessions 里的真实会话，属私人元数据。
  check('短 ID 提取（带 session- 前缀）',
    shortSessionId('session-deadbeef-0000-4000-8000-000000000001') === 'deadbeef');
  check('短 ID 提取（不带前缀）',
    shortSessionId('00000000-0000-4000-8000-000000000002') === '00000000');
  const prompt = buildGuardDraftPrompt('session-abcdef01-0000-4000-8000-000000000003');
  check('含会话 ID', prompt.includes('session-abcdef01-0000-4000-8000-000000000003'));
  // 合并后：导出工具路径**来自配置**，不再是写死的字面路径。
  // 默认未配置（空串）时，指令里那条导出命令自然不含某个人的私有路径。
  check('含导出命令与短 ID',
    prompt.includes('export abcdef01 ') && prompt.includes('--detail brief'),
    JSON.stringify(prompt.split('\n').find((l) => l.includes('export')) ?? ''));
  check('默认未配置时**不再**出现任何人的私有路径',
    !prompt.includes('C:\\Users\\') && !prompt.includes('导出会话.cmd'),
    '（这条断言盯住开源硬伤：私有路径不得回流到代码里）');
  check('含 brief 档', prompt.includes('--detail brief'));
  check('要求新会话自己写交接文档', prompt.includes('交接文档-') && prompt.includes('由你接手'));
  check('含「打转部分不可信」的提醒', prompt.includes('不可信'));
  check('收尾只回 3 行', prompt.includes('只回 3 行'));
}

// ---------------------------------------------------------------- 上游守卫通知
console.log('\n四、认上游守卫（@mrweicodes/dsh-loop-guard）注入的通知');

{
  const nodes = new Map([
    ['a', {
      kind: 'context',
      key: 'a',
      data: {
        seq: 10,
        source: { kind: 'loop-guard', form: 'notice', summary: '已连续重复 5,569 次 / 44,995 字符' },
        content: [{ type: 'text', text: '你正在重复相同的推理而没有行动。停止空转，继续推进任务。' }],
      },
    }],
    ['b', {
      kind: 'context',
      key: 'b',
      data: { seq: 11, source: { kind: 'agent-instructions' }, content: [{ type: 'text', text: 'AGENTS.md 全文' }] },
    }],
    ['c', stepNode(1, 1, 9, '正常推理\n')],
  ]);
  const snapshot = { nodes: makeStore(nodes), order: [...nodes.keys()] };
  const found = findGuardNotices(snapshot);
  check('只认出 source.kind === loop-guard 的那条', found.length === 1 && found[0].seq === 10,
    `found=${found.length}`);
  check('带出它的 summary', found[0] !== undefined && found[0].summary.includes('5,569'));
  check('带出它的正文', found[0] !== undefined && found[0].text.includes('停止空转'));
  check('别的 context 注入（如 AGENTS.md）不算', found.every((item) => !item.text.includes('AGENTS.md')));
  check('带出定位锚点：节点 key', found[0] !== undefined && found[0].nodeKey === 'a', `nodeKey=${found[0] && found[0].nodeKey}`);
  check('带出定位锚点：反推所属轮次', found[0] !== undefined && found[0].turn === 1, `turn=${found[0] && found[0].turn}`);
}

{
  // 通知本身不带 turn，必须由「seq 不大于它的最后一个 assistant-step」反推出来 ——
  // 这是「定位」按钮在 nodeKey 落空时唯一的退路。seq 读的是节点的 anchorSeq（DSH 真实形状）。
  const nodes = new Map([
    ['1:1', stepNode(1, 1, 1, 'a')],
    ['n1', { kind: 'context', key: 'n1', anchorSeq: 2, data: { seq: 2, source: { kind: 'loop-guard', summary: 'turn1' }, content: [] } }],
    ['2:1', stepNode(2, 1, 3, 'b')],
    ['n2', { kind: 'context', key: 'n2', anchorSeq: 4, data: { seq: 4, source: { kind: 'loop-guard', summary: 'turn2' }, content: [] } }],
  ]);
  const found = findGuardNotices({ nodes: makeStore(nodes), order: [...nodes.keys()] });
  check('按 seq 反推出正确的轮次', found.length === 2 && found[0].turn === 1 && found[1].turn === 2,
    `turns=${found.map((item) => item.turn).join(',')}`);
  check('通知自身的 seq 也优先读 anchorSeq', found[0].seq === 2 && found[1].seq === 4,
    `seqs=${found.map((item) => item.seq).join(',')}`);
}

{
  // 回归：assistant-step 的 data 里没有 seq（DSH 把它放在节点 anchorSeq 上）。
  // 曾经读 data.seq → 恒为 undefined → turn 永远 null → 定位退路静默失效。
  const nodes = new Map([
    ['s1', stepNode(7, 1, 100, '推理')],
    ['n1', {
      kind: 'turn-trigger',
      key: 'n1',
      anchorSeq: 101,
      data: { seq: 101, time: 1792043519314, source: { kind: 'loop-guard', summary: 'x' }, content: [] },
    }],
  ]);
  const found = findGuardNotices({ nodes: makeStore(nodes), order: [...nodes.keys()] });
  check('data 里没有 seq 的 assistant-step 也能反推出轮次',
    found.length === 1 && found[0].turn === 7, `turn=${found[0] && found[0].turn}`);
}

{
  // 真实数据回放：上游守卫截断后注入的那条通知，按 DSH 的节点形状存档。
  // 这是最有分量的一条 —— 它不是构造出来的形状，而是照真会话的字段复刻的
  // （会话 ID 已脱敏，形状与字段保持真实）。
  // 当年就是在这里挂的：节点类型是 turn-trigger，而代码只认 context。
  const fixture = path.join(CALIB, 'real-notice-shape.json');
  if (!existsSync(fixture)) {
    check('真实通知回放（缺 fixture）', false, fixture);
  } else {
    const real = JSON.parse(readFileSync(fixture, 'utf8'));
    const nodes = new Map([
      [real.node.key, real.node],
      ...real.stepNodes.map((s) => [s.key, s]),
    ]);
    const found = findGuardNotices({ nodes: makeStore(nodes), order: [...nodes.keys()] });
    check('真实通知（turn-trigger 形态）认得出', found.length === 1, `found=${found.length}`);
    check('真实通知：seq 取自 anchorSeq', found[0] && found[0].seq === real.event.seq);
    check('真实通知：带出上游 summary',
      found[0] && found[0].summary === real.node.data.source.summary, `${found[0] && found[0].summary}`);
    check('真实通知：反推所属轮次', found[0] && found[0].turn === 2, `turn=${found[0] && found[0].turn}`);
    check('真实通知：判定为「新」→ 会弹横幅', isFreshNotice(found[0], real.mountedAt) === true);
  }
}

{
  const nodes = new Map([
    ['x', { kind: 'context', key: 'x', data: { seq: 20, source: { kind: 'loop-guard', summary: 'later' }, content: [] } }],
    ['y', { kind: 'context', key: 'y', data: { seq: 5, source: { kind: 'loop-guard', summary: 'earlier' }, content: [] } }],
  ]);
  const snapshot = { nodes: makeStore(nodes), order: ['x', 'y'] };
  const found = findGuardNotices(snapshot);
  check('按 seq 升序（最新一条在最后）',
    found.length === 2 && found[0].summary === 'earlier' && found[1].summary === 'later');
}

{
  check('没有 nodes 时返回空数组', findGuardNotices({}).length === 0);
  check('snapshot 为 null 时返回空数组', findGuardNotices(null).length === 0);
  check('store 为空时返回空数组', findGuardNotices({ nodes: makeStore(new Map()), order: [] }).length === 0);
}

// ---- 回归：2026-10-15 实测「守卫开火了但横幅没弹」的两个真 bug ----
{
  // Bug 1：曾按 node.kind === 'context' 过滤。DSH 的 messageDefinition.buildViewNode 会把
  // 「唤醒下一轮」的通知物化成 turn-trigger，于是通知被整个丢掉。
  // 契约只有一个：source.kind === 'loop-guard'。节点类型是展示层实现细节，会变。
  const mk = (key, kind, seq, sourceKind = 'loop-guard') => [key, {
    kind,
    key,
    data: {
      seq,
      time: 1792043519314,
      source: { kind: sourceKind, form: 'notice', summary: `notice-${kind}` },
      content: [{ type: 'text', text: '被中途截断' }],
    },
  }];
  const nodes = new Map([
    mk('n1', 'context', 1),
    mk('n2', 'turn-trigger', 2),          // ← 实测通知就是这个类型
    mk('n3', 'steering', 3),
    mk('n4', 'user', 4, 'user'),          // 真实使用者消息：节点类型同为 user，靠 source.kind 区分
  ]);
  const found = findGuardNotices({ nodes: makeStore(nodes), order: [...nodes.keys()] });
  check('不依赖 node.kind：turn-trigger 形态的通知也认得出',
    found.length === 3 && found.some((item) => item.seq === 2), `found=${found.map((i) => i.seq).join(',')}`);
  check('context 形态照旧认得出', found.some((item) => item.seq === 1));
  check('steering 形态也认得出', found.some((item) => item.seq === 3));
  check('真实使用者消息（source.kind=user）不会误报', found.every((item) => item.seq !== 4));
  check('带出事件时间（供新鲜度判断）', found[0].time === 1792043519314, `time=${found[0].time}`);
}

{
  // Bug 2：曾用「本次挂载第一次看到通知 → 只登记不弹」，导致每个会话的**第一次**循环
  // 永远弹不出横幅（表现为「完全不通知」）。正确判据是事件时间 vs 挂载时间。
  const mountedAt = 1792043519000;
  const fresh = { seq: 33, time: 1792043519332 };
  const stale = { seq: 5, time: 1792043400000 };
  check('挂载之后发生的通知 → 算新（会弹）', isFreshNotice(fresh, mountedAt) === true);
  check('挂载之前就存在的通知 → 算历史（不弹）', isFreshNotice(stale, mountedAt) === false);
  check('容差内（时钟抖动）仍算新', isFreshNotice({ seq: 1, time: mountedAt - 1000 }, mountedAt) === true);
  check('没有时间戳时偏向算新（宁可多弹，不可静默失效）',
    isFreshNotice({ seq: 1, time: 0 }, mountedAt) === true);
  check('空值安全', isFreshNotice(null, mountedAt) === false);
}

// ---------------------------------------------------------------- 「定位」按钮
console.log('\n五、定位按钮（locateInChat）');

{
  /** 极简 DOM 替身：只需要 querySelector / querySelectorAll / classList / scrollTo。 */
  const makeRow = (attrs, scrollable = true) => {
    const classes = new Set();
    const parent = {
      clientHeight: 600,
      scrollHeight: scrollable ? 4000 : 600,
      scrollTop: 0,
      scrolledIntoView: false,
      scrollTo: function scrollTo(options) { this.scrollTop = options.top; },
    };
    return {
      classes,
      parentElement: parent,
      offsetTop: 1234,
      classList: {
        add: (name) => classes.add(name),
        remove: (name) => classes.delete(name),
      },
      closest: () => null,
      scrollIntoView: () => { parent.scrolledIntoView = true; },
      dataset: { ...attrs },
    };
  };
  const KEY_ROW = makeRow({ chatNodeKey: 'node-a', chatTurn: '2' });
  const EXACT_ROW = makeRow({ chatNodeKey: 'node-b', chatTurn: '7' });
  const LATER_ROW = makeRow({ chatNodeKey: 'node-c', chatTurn: '9' });
  const rows = [EXACT_ROW, LATER_ROW];

  globalThis.window = {
    CSS: { escape: (value) => value },
    localStorage: {
      store: new Map(),
      getItem(key) { return this.store.has(key) ? this.store.get(key) : null; },
      setItem(key, value) { this.store.set(key, String(value)); },
      removeItem(key) { this.store.delete(key); },
    },
  };
  globalThis.document = {
    querySelectorAll: () => [KEY_ROW, ...rows],
    querySelector: (selector) => {
      const match = /^\[data-chat-turn="(.+)"\]$/.exec(selector);
      if (match === null) throw new Error(`意外的选择器：${selector}`);
      return rows.find((row) => row.dataset.chatTurn === match[1]) ?? null;
    },
  };

  const fired = [];
  const later = (fn) => fired.push(fn);

  const keyHit = locateInChat({ nodeKey: 'node-a', turn: 2 }, later);
  check('优先用 nodeKey 精确命中', keyHit === true && KEY_ROW.classes.has('dsh-loop-guard-located'));
  check('滚到目标并闪一下', KEY_ROW.parentElement.scrollTop > 0 && fired.length === 1);
  fired.shift()();

  const turnHit = locateInChat({ nodeKey: 'missing', turn: 7 }, later);
  check('nodeKey 落空时退回该轮', turnHit === true && EXACT_ROW.classes.has('dsh-loop-guard-located'));

  const fallback = locateInChat({ nodeKey: '', turn: 8 }, later);
  check('该轮未挂载时退到之后最近的一轮', fallback === true && LATER_ROW.classes.has('dsh-loop-guard-located'));

  const nothing = locateInChat({ nodeKey: '', turn: null }, later);
  check('两个锚点都没有时返回 false（不瞎滚）', nothing === false);

  // 找不到可滚动祖先时（DSH 的滚动容器没有标记，几何判断也可能落空）必须退回 scrollIntoView，
  // 否则「定位」会静默什么都不做。
  const PLAIN_ROW = makeRow({ chatNodeKey: 'node-d', chatTurn: '12' }, false);
  globalThis.document.querySelectorAll = () => [PLAIN_ROW];
  const plain = locateInChat({ nodeKey: 'node-d', turn: 12 }, later);
  check('没有可滚动祖先时退回 scrollIntoView',
    plain === true && PLAIN_ROW.parentElement.scrolledIntoView === true);
}

// ---------------------------------------------------------------- 横幅的存续规则
console.log('\n六、横幅只在它发生的会话里显示，且只有点 × 才消失');

{
  const alertOf = (sessionId, seq) => normalizeAlert(sessionId, {
    seq,
    summary: `loop in ${sessionId}`,
    text: '正文',
    nodeKey: `${sessionId}-node`,
    turn: 3,
  });

  check('一开始没有待处理横幅', loadAlert('A') === null);
  check('别的会话看不到 A 的横幅', loadAlert('B') === null);

  parkAlert('A', alertOf('A', 10));
  check('A 的横幅停住了（换会话也不丢）', loadAlert('A') !== null && loadAlert('A').seq === 10);
  check('它不会串到别的会话去', loadAlert('B') === null);

  // 关键回归：B 会话此时也打转，**不能**把 A 的横幅挤掉。
  parkAlert('B', alertOf('B', 20));
  check('B 的横幅各存各的', loadAlert('B').seq === 20 && loadAlert('A').seq === 10,
    `A=${loadAlert('A').seq} B=${loadAlert('B').seq}`);

  markDismissed('A', 10);
  parkAlert('A', null);
  check('点了 × 之后 A 不再有横幅', loadAlert('A') === null);
  check('B 不受影响', loadAlert('B').seq === 20);

  // 关掉之后又来一条新的，必须还能弹（否则一次误关就永久哑了）。
  parkAlert('A', alertOf('A', 11));
  check('关掉后新的一条仍会弹', loadAlert('A') !== null && loadAlert('A').seq === 11);
  check('但已关掉的那条不会复活', isDismissed('A', 10) && !isDismissed('A', 11));

  // 轮询每 700ms 把它当成「同一条」的关键：seq 相等就判定为已在显示。
  const again = loadAlert('A');
  check('再读一次是同一条（轮询据此不重复弹）', again !== null && again.seq === 11);
  check('写的和读的是同一份', loadAlert('A').summary === 'loop in A');

  // 不按时间过期（要求就是「只有点 × 才消失」），所以只按数量封顶，防止无限堆积。
  for (let i = 0; i < 30; i += 1) parkAlert(`S${i}`, alertOf(`S${i}`, 100 + i));
  let alive = 0;
  for (let i = 0; i < 30; i += 1) if (loadAlert(`S${i}`) !== null) alive += 1;
  check('横幅按会话数封顶（不会无限堆积）', alive <= 20, `alive=${alive}`);
  check('最近的那条一定还在', loadAlert('S29') !== null);
  check('最老的那条被挤掉（FIFO，不会无限长）', loadAlert('S0') === null);
}

// ---------------------------------------------------------------- 打断计数徽章
console.log('\n七、「本对话已打断 N 次」计数（scanGuardSeqs / mergeCount / countLevel）');

{
  // 干净的 localStorage：这一节测的是持久化行为，不能受前面几节影响。
  globalThis.window = {
    localStorage: {
      store: new Map(),
      getItem(key) { return this.store.has(key) ? this.store.get(key) : null; },
      setItem(key, value) { this.store.set(key, String(value)); },
      removeItem(key) { this.store.delete(key); },
    },
  };

  const noticeNode = (key, seq, kind = 'turn-trigger') => [key, {
    kind, key, anchorSeq: seq,
    data: { seq, time: 1792043519314, source: { kind: 'loop-guard', summary: 'x' }, content: [] },
  }];
  const userNode = (key, seq) => [key, {
    kind: 'user', key, anchorSeq: seq,
    data: { seq, source: { kind: 'user' }, content: [{ type: 'text', text: '你好' }] },
  }];
  const snap = (pairs) => {
    const nodes = new Map(pairs);
    return { nodes: makeStore(nodes), order: [...nodes.keys()] };
  };

  // --- 轻扫：只认 loop-guard，不误伤使用者消息 ---
  {
    const s = snap([
      userNode('u1', 1),
      noticeNode('n1', 2),
      noticeNode('n2', 3, 'context'),
      userNode('u2', 4),
      noticeNode('n3', 5, 'steering'),
    ]);
    const seqs = scanGuardSeqs(s);
    check('轻扫只取 loop-guard 通知的 seq',
      seqs.length === 3 && seqs.join(',') === '2,3,5', `seqs=${seqs.join(',')}`);
    check('轻扫不误伤使用者消息（source.kind=user）', !seqs.includes(1) && !seqs.includes(4));
    check('轻扫认得出 context / turn-trigger / steering 三种形态', seqs.length === 3);
    check('轻扫不反推轮次（返回的是纯数字数组）', seqs.every((item) => typeof item === 'number'));
  }

  // --- 边界：没有 nodes / 空 store ---
  {
    check('没有 nodes 时轻扫返回空数组', scanGuardSeqs({}).length === 0);
    check('snapshot 为 null 时轻扫返回空数组', scanGuardSeqs(null).length === 0);
    check('空 store 时轻扫返回空数组', scanGuardSeqs(snap([])).length === 0);
    // seq 拿不到（既无 anchorSeq 也无 data.seq）时跳过，不肯猜一个假编号。
    const noSeq = snap([['x', { kind: 'context', key: 'x', data: { source: { kind: 'loop-guard' }, content: [] } }]]);
    check('seq 两个来源都没有时跳过（宁可漏计也不猜）', scanGuardSeqs(noSeq).length === 0);
  }

  // --- 累计：只增不减 ---
  {
    check('一开始计数为 0', countOf('S1') === 0);
    check('并进 2 条 → 计数 2', mergeCount('S1', [2, 3]) === 2, `count=${countOf('S1')}`);
    check('重复并同一批 → 计数不变（去重）', mergeCount('S1', [2, 3]) === 2);
    check('再来一条新的 → 计数 3', mergeCount('S1', [2, 3, 9]) === 3);
    check('按会话分开记', countOf('S2') === 0 && countOf('S1') === 3);

    // 关键回归：历史分页把早期节点卸下后，轻扫只能看见最近的 seq ——
    // 此时**绝不能**把计数改小（否则翻一下历史计数就倒退，徽章失去可信度）。
    check('历史被卸下（只扫到最近一条）后计数不倒退',
      mergeCount('S1', [9]) === 3, `count=${countOf('S1')}`);
    check('扫到空批次也不清计数', mergeCount('S1', []) === 3);
    check('刷新页面后从 localStorage 读回同一个数（持久化）', countOf('S1') === 3);
  }

  // --- 脏数据不能把徽章打崩 ---
  {
    globalThis.window.localStorage.setItem('dsh-loop-guard:count', '{not json');
    check('localStorage 内容损坏时退回 0（不抛异常）', countOf('S9') === 0);
    globalThis.window.localStorage.setItem('dsh-loop-guard:count', '[1,2,3]');
    check('存成数组时也退回 0（不把数组当表用）', countOf('S9') === 0);
    globalThis.window.localStorage.setItem('dsh-loop-guard:count',
      JSON.stringify({ S9: { seqs: [1, 'x', null, -5, 7], updated: 0 } }));
    check('单条记录里的非法 seq 被过滤（只留正整数）',
      mergeCount('S9', []) === 2, `count=${countOf('S9')}`);
  }

  // --- 上界：seq 数与会话数都封顶 ---
  {
    const many = Array.from({ length: 500 }, (_, i) => i + 1);
    const kept = mergeCount('BIG', many);
    check('单个会话的 seq 数封顶（保留最近的）', kept <= 400, `kept=${kept}`);
    check('封顶后保留的是最大的那些 seq', kept === 400 && countOf('BIG') === 400);
    globalThis.window.localStorage.setItem('dsh-loop-guard:count', '{}');
    for (let i = 0; i < 40; i += 1) mergeCount(`M${i}`, [i + 1]);
    let alive = 0;
    for (let i = 0; i < 40; i += 1) if (countOf(`M${i}`) > 0) alive += 1;
    check('会话数封顶（不会无限堆积）', alive <= 30, `alive=${alive}`);
    check('最近的那个会话一定还在', countOf('M39') === 1);
  }

  // --- 档位：0 次是中性「健康」态，1~2 次温和，3 次及以上告警 ---
  {
    check('0 次 → none（中性健康态，仍会渲染）', countLevel(0) === 'none', `level=${countLevel(0)}`);
    check('1 次 → mild', countLevel(1) === 'mild');
    check('2 次 → mild', countLevel(2) === 'mild');
    check('3 次 → severe（跨过「上下文可能已经脏了」的门槛）', countLevel(3) === 'severe');
    check('10 次 → 仍是 severe（不会溢出成别的值）', countLevel(10) === 'severe');
    check('负数 / 非数字不会崩', countLevel(-1) === 'none' && countLevel(NaN) === 'none');
  }
}

// ---------------------------------------------------------------- 导出工具路径（本轮重点）
console.log('\n八、导出工具路径可配置（未配置则隐藏交接 UI）');

{
  /**
   * 这一段验证：把原先写死在代码里的导出工具路径改成可配置之后，
   * 未配置时交接相关 UI 自动隐藏，但横幅与计数照常工作。
   *
   * 断言分两半：
   *   a) 解析逻辑（localStorage 优先 / 退回常量 / 异常安全）
   *   b) 门控判据本身（hasExportTool）
   */
  const storage = {
    map: new Map(),
    getItem(k) { return this.map.has(k) ? this.map.get(k) : null; },
    setItem(k, v) { this.map.set(k, String(v)); },
    removeItem(k) { this.map.delete(k); },
  };
  globalThis.window = { localStorage: storage };

  check('默认常量是空串（开源默认不猜任何人的路径）', EXPORT_TOOL_DEFAULT === '', JSON.stringify(EXPORT_TOOL_DEFAULT));
  check('配置键名与包名一致',
    EXPORT_TOOL_STORAGE_KEY === 'dsh-loop-watcher:export-tool', EXPORT_TOOL_STORAGE_KEY);

  // --- 未配置：走隐藏分支 ---
  setExportToolPath(resolveExportTool());
  check('未配置时 hasExportTool() === false（→ 交接 UI 隐藏）', hasExportTool() === false);

  // --- 从 localStorage 读到配置 ---
  storage.setItem(EXPORT_TOOL_STORAGE_KEY, 'D:\\tools\\导出会话.cmd');
  check('localStorage 有值时解析出该值',
    resolveExportTool() === 'D:\\tools\\导出会话.cmd', resolveExportTool());

  setExportToolPath(resolveExportTool());
  check('配上之后 hasExportTool() === true（→ 交接 UI 出现）', hasExportTool() === true);

  // --- 配置里只有空白 = 视为未配置（不能因为一个空格就让按钮出现） ---
  storage.setItem(EXPORT_TOOL_STORAGE_KEY, '   ');
  check('配置为纯空白时视为未配置（退回常量）',
    resolveExportTool() === EXPORT_TOOL_DEFAULT, JSON.stringify(resolveExportTool()));

  // --- 清掉配置后回到默认 ---
  storage.removeItem(EXPORT_TOOL_STORAGE_KEY);
  check('删掉配置后回到默认空串', resolveExportTool() === '');

  // --- localStorage 整个不可用：必须退回常量，而不是抛 ---
  globalThis.window = {
    localStorage: {
      getItem() { throw new Error('storage disabled'); },
      setItem() { throw new Error('storage disabled'); },
      removeItem() { throw new Error('storage disabled'); },
    },
  };
  let threw = null;
  let fallback = null;
  try { fallback = resolveExportTool(); } catch (error) { threw = error; }
  check('localStorage 不可用时不抛异常', threw === null, threw && threw.message);
  check('localStorage 不可用时退回常量（空串 → 交接 UI 隐藏）', fallback === '');

  // --- 配置值经 setExportToolPath 注入后，指令里就用它 ---
  // 路径与会话 ID 都用合成值：这条验的是「用配置值而非私有路径」，具体值无关。
  setExportToolPath('E:\\somewhere\\export-session.cmd');
  const withTool = buildGuardDraftPrompt('session-cafebabe-0000-4000-8000-000000000004');
  check('配好后，指令里带上配置的路径（而不是任何人的私有路径）',
    withTool.includes('E:\\somewhere\\export-session.cmd'), withTool.split('\n').find((l) => l.includes('export')) ?? '');
  check('配好后指令里仍含短 ID 与 brief 档',
    withTool.includes('export cafebabe ') && withTool.includes('--detail brief'));

  // --- 收尾：复位，免得影响别的用例 ---
  setExportToolPath(EXPORT_TOOL_DEFAULT);
}

console.log(`\n${failures === 0 ? '全部通过' : `有 ${failures} 项失败`}`);
process.exit(failures === 0 ? 0 : 1);
