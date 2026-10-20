/**
 * 「本对话已打断 N 次」计数徽章的**运行时**验证。
 *
 * 与 verify-runtime.mjs 的分工：
 *   - verify-runtime.mjs 验的是**纯逻辑**（scanGuardSeqs / mergeCount / countOf / countLevel），
 *     把 `#region loop-guard-count` 从 client.js 里抽出来直接跑。
 *   - 本文件验的是**加载 → 注册 → 渲染 → 交互**这条链：用替身 module loader 真正执行插件的
 *     client.js，从 `apply(ctx)` 里把**真实的**组件函数截获下来，再用一个忠实模拟 React
 *     渲染循环的替身喂数据，看它到底渲染出什么、点击后发生什么。
 *
 * ## 这一层验的是什么、不验什么（如实写清，别把替身当浏览器）
 *
 * 【验】client.js 能被真实形态的 loader 执行；注册进了哪个插槽、order 多少、locale/样式是否登记；
 *      组件在「0 次 / 1 次 / 3 次 / 换会话 / 演练」下渲染出的元素树与属性；
 *      **700ms 轮询把计数累加并重渲染**这条最容易写错的链路；
 *      历史分页把早期节点卸下后计数**不倒退**；点击会走定位并给出反馈文案。
 * 【不验】真实浏览器里的排版观感、CSS 变量解析、真实 React 调度与并发特性、真实 localStorage
 *      配额行为。这些仍需在页面上用演练模式（`self-test = 'count'`）肉眼确认。
 *
 * 用法：node verify-badge.mjs [client.js 路径]
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** 默认指向仓库根（即插件本体）的 client.js；也可用第一个参数覆盖。 */
const DEFAULT_CLIENT = path.join(HERE, '..', 'lib', 'client.js');
const clientPath = process.argv[2] ?? DEFAULT_CLIENT;

let failures = 0;
function check(name, ok, detail) {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail !== undefined ? `  ${detail}` : ''}`);
  if (!ok) failures += 1;
}

// ------------------------------------------------------------------ 替身：React
/**
 * 替身 React。
 *
 * 忠实实现本组件用到的语义，**足够真**才验得动：
 *   - hooks 按**每个组件实例**一份、按调用顺序编号（与真实规则一致）；
 *   - `setState` 标记脏，由 `settle()` 驱动重渲染，直到不再有状态变化；
 *   - `useEffect` 在渲染后按顺序执行，依赖变化才重跑，卸载时执行 cleanup；
 *   - `useCallback` 按依赖数组决定是否换新引用。
 *
 * 刻意**不**实现：并发渲染、Suspense、memo、context。本组件一个都没用到。
 */
function createFakeReact() {
  let current = null;

  function createInstance() {
    const slots = [];
    let cursor = 0;
    let dirty = false;
    /**
     * ⚠️ 这两个数组**必须分开**：
     *   - `pending`：本次渲染新登记、**待执行**的 effect 函数；
     *   - `cleanups`：已执行过的 effect 交回来的**卸载函数**。
     * 第一版把两者塞进同一个数组，结果第二轮 settle 误跑了上一轮的 cleanup
     * （把刚注册的 setInterval 清掉了），表现为「轮询永远不触发」。
     * 这是测试替身的 bug，不是插件的 —— 记在这里免得以后又踩。
     */
    const pending = [];
    const cleanups = [];
    return {
      beginRender() { cursor = 0; },
      isDirty: () => dirty,
      clearDirty() { dirty = false; },
      takePending() { const list = pending.slice(); pending.length = 0; return list; },
      hooks: {
        useState(initial) {
          const index = cursor;
          cursor += 1;
          if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
          return [slots[index], (next) => {
            const value = typeof next === 'function' ? next(slots[index]) : next;
            if (!Object.is(value, slots[index])) {
              slots[index] = value;
              dirty = true;
            }
          }];
        },
        useRef(initial) {
          const index = cursor;
          cursor += 1;
          if (!(index in slots)) slots[index] = { current: initial };
          return slots[index];
        },
        useCallback(fn, deps) {
          const index = cursor;
          cursor += 1;
          const previous = slots[index];
          const changed = previous === undefined
            || !Array.isArray(deps)
            || !Array.isArray(previous.deps)
            || deps.length !== previous.deps.length
            || deps.some((value, i) => !Object.is(value, previous.deps[i]));
          if (changed) slots[index] = { fn, deps };
          return slots[index].fn;
        },
        useEffect(fn, deps) {
          const index = cursor;
          cursor += 1;
          const previous = slots[index];
          if (previous !== undefined && Array.isArray(deps) && Array.isArray(previous.deps)
            && deps.length === previous.deps.length
            && deps.every((value, i) => Object.is(value, previous.deps[i]))) {
            return;
          }
          slots[index] = { deps };
          pending.push(fn);
        },
      },
      hookCount: () => cursor,
      /** 跑掉这次新登记的 effect，把它们的 cleanup 收好。 */
      runPendingEffects() {
        let ran = 0;
        for (const fn of this.takePending()) {
          ran += 1;
          const cleanup = fn();
          if (typeof cleanup === 'function') cleanups.push(cleanup);
        }
        return ran;
      },
      unmount() {
        for (const fn of cleanups) {
          try { fn(); } catch { /* 单条 cleanup 失败不该打断整体卸载 */ }
        }
        cleanups.length = 0;
      },
    };
  }

  return {
    createInstance,
    /** 渲染一棵树（把 hooks 指向当前实例）。 */
    render(instance, renderFn) {
      current = instance;
      instance.beginRender();
      const result = renderFn();
      return result;
    },
    get hooks() { return current.hooks; },
    // 组件里写的是 `React.useState(...)`，所以这些方法必须挂在 React 对象本身上，
    // 再委托给**当前正在渲染的那个实例**的 hooks —— 与真实 React 的分派方式一致。
    useState(...args) { return current.hooks.useState(...args); },
    useRef(...args) { return current.hooks.useRef(...args); },
    useCallback(...args) { return current.hooks.useCallback(...args); },
    useEffect(...args) { return current.hooks.useEffect(...args); },
    createElement(type, props, ...children) {
      const flat = [];
      for (const child of children) {
        if (Array.isArray(child)) flat.push(...child.flat(Infinity));
        else if (child !== null && child !== undefined && child !== false) flat.push(child);
      }
      return { type, props: { ...(props ?? {}), children: flat } };
    },
  };
}

// ------------------------------------------------------------------ 替身：DOM 与宿主
function makeStorage() {
  const store = new Map();
  return {
    store,
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
    clear: () => store.clear(),
  };
}

const intervals = [];
const timeouts = [];
const styleElements = [];
const fakeReact = createFakeReact();

let loaded = null;
const storage = makeStorage();

globalThis.window = {
  localStorage: storage,
  setInterval: (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; },
  clearInterval: (id) => { if (id) intervals[id - 1] = null; },
  setTimeout: (fn, ms) => { timeouts.push({ fn, ms }); return timeouts.length; },
  clearTimeout: (id) => { if (id) timeouts[id - 1] = null; },
  __ModuleLoader__: {
    load({ id, factory }) {
      // 工厂拿到的是 require **函数**（真实 loader 亦然），只认 'react'。
      const require = (name) => {
        if (name === 'react') return fakeReact;
        throw new Error(`替身 require 不认识：${name}`);
      };
      loaded = { id, exports: factory(require) };
    },
  },
};

globalThis.document = {
  getElementById: () => null,
  createElement: () => {
    const element = { id: '', textContent: '' };
    styleElements.push(element);
    return element;
  },
  head: { appendChild: () => {} },
  querySelectorAll: () => [],
  querySelector: () => null,
};

/** 跑一遍还活着的轮询回调（= 页面里过去了 700ms）。 */
function flushPolls() {
  for (const item of intervals) if (item !== null) item.fn();
}
/** 跑一遍还挂着的延时回调（= 「3 秒后把提示收掉」）。 */
function flushTimeouts() {
  const pending = timeouts.splice(0, timeouts.length);
  for (const item of pending) if (item !== null) item.fn();
}
/** 清掉所有定时器与实例（用例之间互不污染）。 */
function resetHost() {
  intervals.length = 0;
  timeouts.length = 0;
}

// ------------------------------------------------------------------ 元素树工具
function textOf(element) {
  if (typeof element === 'string' || typeof element === 'number') return String(element);
  if (element === null || element === undefined) return '';
  if (Array.isArray(element)) return element.map(textOf).join('');
  return (element.props?.children ?? []).map(textOf).join('');
}

function findElement(element, predicate) {
  if (element === null || element === undefined || typeof element === 'string') return null;
  if (Array.isArray(element)) {
    for (const child of element) {
      const hit = findElement(child, predicate);
      if (hit !== null) return hit;
    }
    return null;
  }
  if (predicate(element)) return element;
  for (const child of element.props?.children ?? []) {
    const hit = findElement(child, predicate);
    if (hit !== null) return hit;
  }
  return null;
}

const isButton = (element) => element.type === 'button';

// ------------------------------------------------------------------ 执行插件
console.log(`被验插件：${clientPath}\n`);

const source = readFileSync(clientPath, 'utf8');

const registrations = [];
const localeCalls = [];
const effects = [];
let loadError = null;

try {
  // 真正执行 client.js —— 这一步顺带验了「文件是合法可执行的 client 模块」。
  // eslint-disable-next-line no-eval
  (0, eval)(source);
} catch (error) {
  loadError = error;
}

check('client.js 被 module loader 加载且不抛异常',
  loadError === null && loaded !== null && loaded.id === 'dsh-loop-watcher',
  loadError ? loadError.message : (loaded && loaded.id));
if (loadError !== null) {
  console.log('\n加载失败，后续无法进行。');
  process.exit(1);
}

check('exports 暴露 apply', typeof loaded.exports?.apply === 'function');
check('exports 暴露 inject（含 slots）',
  Array.isArray(loaded.exports?.inject) && loaded.exports.inject.includes('slots'));

// ---- 合并专项：横幅按钮与交接菜单必须共用**同一条**交接链路 ----
// 2026-10-17 改：横幅按钮原来自己拼一份「写交接文档、只回 3 行」的提示词塞进
// 输入框，而菜单项早就改成「隐藏注入 + 直接接着活干」—— 同一个插件里两条
// 交接路径给出互相矛盾的工作方式。现在两个入口都走 runHandover。
// 只测函数体不测调用点的话，「横幅又各写一套」这种回归咬不住，所以用源码级断言盯死。
{
  // 横幅的 draftHandover 调用的就是交接总流程 runHandover（同一份实现）
  const draftCall = /const draftHandover = React\.useCallback\(\(\) => \{[\s\S]{0,400}?runHandover\(/.exec(source);
  check('横幅按钮复用 runHandover（与菜单项同一条链路，不再自己拼提示词）',
    draftCall !== null, draftCall ? 'runHandover' : null);
  // 交接菜单的 runHandover 用的仍然是那份「直接接着干」的指令（带 title 参数）
  const menuCall = /const prompt = buildHandoverPrompt\(sessionId, title\);/.exec(source);
  check('交接菜单调用的是 buildHandoverPrompt（直接接着干）',
    menuCall !== null, menuCall ? 'buildHandoverPrompt' : null);
  // 旧的「写交接文档」指令函数已停用：定义还在（备查），但**不能再有调用点**
  const oldDefined = /function buildGuardDraftPrompt\(sessionId\) \{/.test(source);
  const oldCalled = /=\s*buildGuardDraftPrompt\(sessionId\)\s*;/.test(source);
  check('旧的 buildGuardDraftPrompt 已无调用点（停在定义、不再被任何入口使用）',
    oldDefined && !oldCalled, `defined=${oldDefined} called=${oldCalled}`);
  // 标题精修：交接成功后要调 session.rename()，且注入段头必须带「交接对话：」
  check('交接成功后调用 session.rename() 精修标题',
    /renameHandoverSession\(ctx, newSessionId/.test(source));
  check('注入段头带 HANDOVER_TITLE_PREFIX（标题 fallback 才不会变成指令原文）',
    /text: `\$\{HANDOVER_TITLE_PREFIX\}\\n\$\{text\}`/.test(source));
}

const ctx = {
  effect(fn) { effects.push(fn); },
  locale: {
    register: (ns, dict) => { localeCalls.push({ ns, dict }); },
    // 真实宿主一定有 locale.bind（插件多处用到）。假 ctx 缺它会在 apply 里抛，
    // 那样测出来的就不是插件行为而是替身缺陷了。
    bind: (ns) => (key) => `[${ns}.${key}]`,
  },
  slots: {
    inject(slotName, register) {
      // 真实实现会在插槽存在时调用这个回调；本插件注册的两个插槽都已存在（已用
      // cordis_inspect_query Slots.listSubTree 确认过），所以这里直接调用。
      register();
      return { dispose() {} };
    },
    register(options, Component) {
      registrations.push({ options, Component });
      return { dispose() {} };
    },
  },
  get() { return undefined; },
};

loaded.exports.apply(ctx);

// ctx.effect 是懒执行的（真实语义：宿主就绪后才跑）。手动跑一遍，才验得到
// 「字典与样式确实被登记了」—— 否则测的只是「有没有把 effect 交出去」，弱得多。
let effectError = null;
for (const fn of effects) {
  try {
    fn();
  } catch (error) {
    effectError = error;
  }
}
check('apply 交出的 effect 全部能正常执行', effectError === null, effectError && effectError.message);

// 2026-10-17 起交接菜单与隐形 helper 改为**常驻注册**（未配导出工具时交接仍可用，
// 指令不含导出命令），并新增设置页注册 —— 所以固定是 5 条。
check('注册了 5 个插槽条目（横幅 + 徽章 + 交接菜单 + 预填 helper + 设置页）',
  registrations.length === 5
  && registrations.map((item) => item.options.id).join(',') === [
    'loop-guard-notify',
    'loop-guard-count',
    'dsh-session-handover.handover',
    'dsh-session-handover.prefill',
    'loop-watcher-settings',
  ].join(','),
  registrations.map((item) => item.options.id).join(', '));

const badge = registrations.find((item) => item.options.id === 'loop-guard-count');
const banner = registrations.find((item) => item.options.id === 'loop-guard-notify');

// 徽章的位置：2026-10-16 共挪过两次（使用者三次看着界面给反馈），最终要求是
// **紧贴「后台任务」右边、跟在那一组动态条目末尾**（既不能夹在模式选择器和后台任务中间，
// 也不能越过文件夹/更多按钮跑到整行最右 —— 那两种都被使用者否掉了）。
//
// 布局事实（读自 DSH 的 ui-conversation 源码，见 参考资料\ui-conversation-client.js:16462-16512）：
//   titleCluster{ crumbs, headerActions } + headerUtilities + headerCorner
// 后台任务 job-list(order 20) 在 headerActions 组内，是该组 order 最大的；
//   → 留在 headerActions 且 order > 20 才会**紧跟它右边**；
//   → 若挂 headerUtilities，就会越过文件夹按钮跑到整行最右（就是被否掉的「太右边」）。
// 另外 headerActions 里还有个 agent-preset(模式选择器, order -10)：order 必须 > -10 且 > 20，
//   否则会落到模式选择器左边或中间。
check('徽章挂在后台任务所在的 conversation.session.header.actions',
  badge !== undefined && badge.options.name === 'conversation.session.header.actions',
  badge && badge.options.name);
check('徽章 order(100) > 后台任务的 20 → 紧贴后台任务右边',
  badge !== undefined && badge.options.order > 20, badge && String(badge.options.order));
check('徽章 order 也 > 模式选择器的 -10（不会落到模式选择器左边或中间）',
  badge !== undefined && badge.options.order > -10);
check('徽章**没有**挂到 headerUtilities（那会越过文件夹按钮 → 使用者否掉的「太右边」）',
  badge !== undefined && badge.options.name !== 'conversation.session.header.utilities');
check('徽章 id 与横幅不同（不互相顶掉）',
  badge !== undefined && banner !== undefined && badge.options.id !== banner.options.id);
check('徽章声明了 locale（文案走字典，不硬编码）',
  badge !== undefined && badge.options.locale !== undefined, badge && String(badge.options.locale));

check('注册了 locale 字典（zh + en）', localeCalls.length === 1
  && localeCalls[0].dict.zh !== undefined && localeCalls[0].dict.en !== undefined);

const COUNT_KEYS = ['count.label', 'count.title', 'count.titleSevere',
  'count.located', 'count.locateFailed', 'count.selfTest'];
check('zh 字典带上了计数徽章的全部词条',
  COUNT_KEYS.every((key) => typeof localeCalls[0]?.dict?.zh?.[key] === 'string'),
  COUNT_KEYS.filter((key) => typeof localeCalls[0]?.dict?.zh?.[key] !== 'string').join(','));
check('en 字典带上了计数徽章的全部词条',
  COUNT_KEYS.every((key) => typeof localeCalls[0]?.dict?.en?.[key] === 'string'),
  COUNT_KEYS.filter((key) => typeof localeCalls[0]?.dict?.en?.[key] !== 'string').join(','));
check('zh 的 label 含 {n} 占位符（次数要被插进文案里）',
  localeCalls[0]?.dict?.zh?.['count.label']?.includes('{n}'),
  localeCalls[0]?.dict?.zh?.['count.label']);
check('样式表被挂上（含徽章那几条规则）',
  styleElements.length === 1
  && styleElements[0].textContent.includes('.dsh-loop-guard-badge')
  && styleElements[0].textContent.includes('data-level="severe"'),
  styleElements.length ? `${styleElements[0].textContent.length} 字符` : '没挂样式');

// ---- 布局回归：反馈提示绝不能占布局流 ----
// 它所在插槽 headerUtilities 是 flex:none（不收缩）、标题 titleCluster 是 flex:1（会收缩）。
// 提示文案二十多字，若内联进流里，点一下徽章就会把会话标题挤窄 3 秒。
// 这条断言盯住「必须绝对定位」这个结论，别以后被好心改成 inline。
{
  const css = styleElements.length ? styleElements[0].textContent : '';
  const noticeRule = /\.dsh-loop-guard-badge-notice\s*\{([^}]*)\}/.exec(css);
  const body = noticeRule === null ? '' : noticeRule[1];
  check('反馈提示用 position:absolute（不占布局流、不挤标题）',
    /position:\s*absolute/.test(body), body.replace(/\s+/g, ' ').trim().slice(0, 90));
  check('反馈提示有 max-width / width 约束（不会横向撑破标题行）',
    /(max-width|width):/.test(body));
  check('徽章包裹层是 flex:none（不被压缩，保证始终完整显示在最右）',
    /\.dsh-loop-guard-badge-wrap\s*\{[^}]*flex:\s*none/.test(css));
}

if (badge === undefined) {
  console.log('\n徽章没有注册成功，后续无法进行。');
  process.exit(1);
}

// ------------------------------------------------------------------ 挂载替身
const dict = localeCalls[0].dict.zh;
const t = (key) => dict[key] ?? key;

/** 造一个 snapshot：只含 loop-guard 通知（外加可选的其它节点）。 */
function snapshotWithSeqs(seqs, extra = []) {
  const nodes = new Map(extra);
  seqs.forEach((seq, i) => {
    nodes.set(`n${i}`, {
      kind: 'turn-trigger',
      key: `n${i}`,
      anchorSeq: seq,
      data: {
        seq,
        time: Date.now(),
        turn: i + 1,
        source: { kind: 'loop-guard', summary: `cut ${seq}` },
        content: [{ type: 'text', text: '被截断' }],
      },
    });
  });
  return {
    nodes: {
      keys: () => nodes.keys(),
      values: () => nodes.values(),
      get: (key) => nodes.get(key),
    },
    order: [...nodes.keys()],
  };
}

/**
 * 挂载徽章组件。返回一个可控句柄：
 *   - `element`：最近一次渲染的元素树（用 getter 读，因为会重渲染）；
 *   - `setSnapshot()`：换掉快照并重渲染（模拟 DSH 推新数据）；
 *   - `settle()`：跑到状态稳定（渲染 → 跑 effect → 有变化再渲染）；
 *   - `click()`：点按钮；
 *   - `unmount()`：执行 cleanup。
 *
 * 这一步是**模块级替身**，但被渲染的是插件里那份**真组件**。
 */
function mountBadge(sessionId) {
  const instance = fakeReact.createInstance();
  let snapshot = snapshotWithSeqs([]);
  const props = {
    sessionId,
    t,
    useChat: () => snapshot,
    useWorkspaces: () => ({}),
    useInput: () => ({ draft: '' }),
    inputActions: { setDraft() {} },
  };

  let element = null;
  let renderCount = 0;
  let lastRounds = 0;

  const renderOnce = () => {
    element = fakeReact.render(instance, () => badge.Component(props));
    renderCount += 1;
    return element;
  };

  /**
   * 模拟 React 的提交阶段 + 被动 effect：渲染 → 跑这次新登记的 effect →
   * 若 effect 里 setState 了就再渲染一轮。最多 12 轮防死循环。
   *
   * 返回**跑到稳定用了几轮渲染**：1 轮 = 没有 setState 引发额外渲染（好）；
   * 2 轮以上 = 有状态真的变了。用这个数判断「有没有多余重渲染」比数总渲染次数准，
   * 因为 settle 自己至少要渲染一次。
   */
  const settle = () => {
    for (let round = 1; round <= 12; round += 1) {
      instance.clearDirty();
      renderOnce();
      const ran = instance.runPendingEffects();
      if (ran === 0 && !instance.isDirty()) {
        lastRounds = round;
        return element;
      }
    }
    lastRounds = 12;
    return element;
  };

  settle();

  return {
    get element() { return element; },
    get renderCount() { return renderCount; },
    get rounds() { return lastRounds; },
    get hookCount() { return instance.hookCount(); },
    props,
    settle,
    /**
     * 换快照并重渲染。
     *
     * 必须重渲染 —— 真实 DSH 里 `useChat` 是**外部 store 订阅**，快照变了就会重渲染，
     * 组件正是靠这一点在渲染时把 `latest.current = snapshot` 更新掉的。
     * 只换闭包变量不重渲染，测的就是一个真实环境里不存在的时序（第一版替身就栽在这）。
     */
    setSnapshot(next) { snapshot = next; return settle(); },
    /** 让轮询跑一轮，再 settle（= 页面里过去了 700ms 且 React 完成了更新）。 */
    tick() { flushPolls(); return settle(); },
    click() {
      const button = findElement(element, isButton);
      if (button === null) throw new Error('没有可点的按钮');
      button.props.onClick();
      return settle();
    },
    unmount() { instance.unmount(); },
  };
}

const levelOf = (view) => {
  const button = findElement(view.element, isButton);
  return button === null ? null : button.props['data-level'];
};
const buttonOf = (view) => findElement(view.element, isButton);

// ============================================================ 用例
console.log('\n一、渲染：次数决定显示与档位');

{
  resetHost();
  const view = mountBadge('session-zero');
  // 2026-10-16 按实测反馈改：原来 0 次返回 null，导致使用者分不清「健康」与「插件没生效」。
  // 现在 0 次也渲染一条中性的「未被打断」状态 —— 它本身就是一条健康状态。
  check('0 次时也渲染（否则分不清「健康」与「插件没生效」）', view.element !== null, String(view.element));
  const button = buttonOf(view);
  check('0 次文案是「本对话未被打断」', textOf(button) === '本对话未被打断',
    JSON.stringify(textOf(button)));
  check('0 次档位是 none（中性色，不是 warn/error）', levelOf(view) === 'none', String(levelOf(view)));
  check('0 次的悬停说明「状态正常」', button.props.title.includes('正常'), button.props.title);
  check('0 次时不再有「已打断 0 次」这种别扭措辞',
    !textOf(button).includes('打断 0 次') && !textOf(button).includes('0 次'),
    JSON.stringify(textOf(button)));
  check('0 次没有 data-self-test 标记（不是演练）', button.props['data-self-test'] === undefined);
  view.unmount();
}

{
  resetHost();
  storage.clear();
  const view = mountBadge('session-one');
  // 挂载时 store 里已有 1 条通知：700ms 后轮询应当把它计上并显示出来。
  view.setSnapshot(snapshotWithSeqs([7]));
  check('轮询前显示的是「未被打断」中性态', textOf(buttonOf(view)) === '本对话未被打断',
    JSON.stringify(textOf(buttonOf(view))));
  view.tick();
  check('轮询扫到 1 条通知后变成有次数的徽章', view.element !== null);
  check('计数写进了计数表（不只是显示）', storage.getItem('dsh-loop-guard:count') !== null,
    String(storage.getItem('dsh-loop-guard:count')).slice(0, 80));
  const button = buttonOf(view);
  check('文案形如「本对话已打断 1 次」',
    button !== null && textOf(button) === '本对话已打断 1 次', button && JSON.stringify(textOf(button)));
  check('1 次 → data-level=mild', levelOf(view) === 'mild', String(levelOf(view)));
  check('真实计数不带演练标记（不是虚线样式）',
    button !== null && button.props['data-self-test'] === undefined);
  check('次数单独一层 span.badge-count（比两侧文字更显眼）',
    findElement(view.element, (node) => node.props?.className === 'dsh-loop-guard-badge-count') !== null);
  check('有 title 与 aria-label（悬停解释 + 无障碍）',
    button !== null && typeof button.props.title === 'string'
    && button.props.title.length > 0 && button.props['aria-label'] === button.props.title);
  check('有 role/status 之类的语义或至少是个真 button',
    button !== null && button.type === 'button');
  view.unmount();
}

{
  resetHost();
  storage.clear();
  const view = mountBadge('session-three');
  view.setSnapshot(snapshotWithSeqs([1, 2, 3]));
  view.tick();
  check('3 条通知 → 计数 3', textOf(buttonOf(view)) === '本对话已打断 3 次',
    JSON.stringify(textOf(buttonOf(view))));
  check('3 次 → data-level=severe（跨过「上下文可能脏了」的门槛）',
    levelOf(view) === 'severe', String(levelOf(view)));
  check('3 次的悬停文案换成「建议换新会话」那条',
    buttonOf(view).props.title.includes('换一个新会话'), buttonOf(view).props.title);
  check('1 次的悬停文案与 3 次不同（档位真的换了文案）',
    dict['count.title'] !== dict['count.titleSevere']);
  view.unmount();
}

console.log('\n二、轮询累加：数字只增不减');

{
  resetHost();
  storage.clear();
  const view = mountBadge('session-accum');
  view.setSnapshot(snapshotWithSeqs([1]));
  view.tick();
  check('先来 1 条 → 1', textOf(buttonOf(view)) === '本对话已打断 1 次');

  view.setSnapshot(snapshotWithSeqs([1, 2]));
  view.tick();
  check('又来 1 条 → 2', textOf(buttonOf(view)) === '本对话已打断 2 次',
    JSON.stringify(textOf(buttonOf(view))));

  // 关键回归：历史分页把早期节点卸下，store 里只剩最近那条。
  // 若实现是「数当前 store 里的条数」，这里会从 2 掉回 1 —— 那徽章就不可信了。
  view.setSnapshot(snapshotWithSeqs([2]));
  view.tick();
  check('历史被卸下（store 只剩 1 条）后计数不倒退 → 仍是 2',
    textOf(buttonOf(view)) === '本对话已打断 2 次', JSON.stringify(textOf(buttonOf(view))));

  view.setSnapshot(snapshotWithSeqs([]));
  view.tick();
  check('store 清空也不清计数 → 仍是 2', textOf(buttonOf(view)) === '本对话已打断 2 次');
  // 没有新数据时不该有 setState 引发的额外渲染（否则每 700ms 白重渲染一次）。
  check('没有新数据时一轮渲染就稳定（不触发多余重渲染）', view.rounds === 1,
    `rounds=${view.rounds}`);

  // 重复扫到同一批不重复计数。
  view.setSnapshot(snapshotWithSeqs([1, 2]));
  view.tick();
  check('重复扫到同一批 seq 不重复计数 → 仍是 2',
    textOf(buttonOf(view)) === '本对话已打断 2 次');
  view.unmount();
}

console.log('\n三、按会话隔离');

{
  resetHost();
  storage.clear();
  const a = mountBadge('session-A');
  a.setSnapshot(snapshotWithSeqs([1, 2, 3]));
  a.tick();
  check('A 会话计数 3', textOf(buttonOf(a)) === '本对话已打断 3 次');

  const b = mountBadge('session-B');
  check('切到 B 会话：显示 B 自己的中性态，**不显示 A 的 3 次**',
    b.element !== null && textOf(buttonOf(b)) === '本对话未被打断',
    JSON.stringify(textOf(buttonOf(b))));
  b.setSnapshot(snapshotWithSeqs([9]));
  b.tick();
  check('B 会话只算自己的 1 次', textOf(buttonOf(b)) === '本对话已打断 1 次',
    JSON.stringify(textOf(buttonOf(b))));
  check('B 的计数没有把 A 的算进来', !textOf(buttonOf(b)).includes('3'));

  a.unmount();
  b.unmount();

  // 切回 A：应当记住 3 次（不靠 store，靠计数表）。
  const a2 = mountBadge('session-A');
  a2.setSnapshot(snapshotWithSeqs([]));
  a2.settle();
  check('切回 A 会话仍记得 3 次（计数表持久化）',
    textOf(buttonOf(a2)) === '本对话已打断 3 次', JSON.stringify(textOf(buttonOf(a2))));
  a2.unmount();
}

console.log('\n四、演练模式（self-test = count）');

{
  resetHost();
  storage.clear();
  storage.setItem('dsh-loop-guard:self-test', 'count');
  const view = mountBadge('session-selftest');
  view.settle();
  check('演练模式下即使计数为 0 也会渲染', view.element !== null);
  const button = buttonOf(view);
  check('演练值取 3（跨过 severe 门槛，一次演练就能看到告警配色）',
    textOf(button) === '本对话已打断 3 次' && levelOf(view) === 'severe',
    `${textOf(button)} / ${levelOf(view)}`);
  check('演练模式带 data-self-test 标记（虚线边框，区别于真实计数）',
    button.props['data-self-test'] === 'true');
  check('演练**没有**写进计数表（不污染真实统计）',
    storage.getItem('dsh-loop-guard:count') === null,
    String(storage.getItem('dsh-loop-guard:count')));
  check('演练模式给出了「这是演示值」的说明文案',
    textOf(view.element).includes('演示值'), JSON.stringify(textOf(view.element)));
  // 说明是延时的：真的等到它跑完，再确认会自己收掉（不长期占位）。
  flushTimeouts();
  const after = view.settle();
  check('说明文案 3 秒后自己收掉（不长期占位）',
    !textOf(after).includes('演示值') || !textOf(after).includes('演练'),
    JSON.stringify(textOf(after)));
  storage.removeItem('dsh-loop-guard:self-test');
  view.unmount();
}

console.log('\n五、点击 = 定位到最近一次打断处');

{
  resetHost();
  storage.clear();

  // 造两条「聊天区行」，一条属于 nodeKey n0、一条 n1（最近的那条）。
  const makeRow = (key, turn) => {
    const classes = new Set();
    return {
      dataset: { chatNodeKey: key, chatTurn: String(turn) },
      classes,
      classList: { add: (name) => classes.add(name), remove: (name) => classes.delete(name) },
      parentElement: null,
      offsetTop: 10,
      scrollIntoView() { this.scrolled = true; },
    };
  };
  const rowA = makeRow('n0', 1);
  const rowB = makeRow('n1', 2);
  const rows = [rowA, rowB];
  globalThis.document.querySelectorAll = () => rows;
  globalThis.document.querySelector = (selector) => {
    const match = /^\[data-chat-turn="(.+)"\]$/.exec(selector);
    return match === null ? null : (rows.find((r) => r.dataset.chatTurn === match[1]) ?? null);
  };

  const view = mountBadge('session-click');
  view.setSnapshot(snapshotWithSeqs([11, 12]));
  view.tick();
  check('点击前徽章已渲染', view.element !== null);

  let threw = null;
  try { view.click(); } catch (error) { threw = error; }
  check('点击定位不抛异常', threw === null, threw && threw.message);
  check('点的是**最近**那条（n1，不是更早的 n0）',
    rowB.classes.has('dsh-loop-guard-located') && !rowA.classes.has('dsh-loop-guard-located'),
    `n0=${rowA.classes.size} n1=${rowB.classes.size}`);
  check('给了「已定位」的反馈文案',
    textOf(view.element).includes('最近一次打断'), JSON.stringify(textOf(view.element)));

  // 定位落空时也必须给出反馈，不能静默什么都不做。
  globalThis.document.querySelectorAll = () => [];
  globalThis.document.querySelector = () => null;
  const view2 = mountBadge('session-click-miss');
  view2.setSnapshot(snapshotWithSeqs([21]));
  view2.tick();
  let threw2 = null;
  try { view2.click(); } catch (error) { threw2 = error; }
  check('定位落空时不抛异常', threw2 === null, threw2 && threw2.message);
  check('定位落空时也给出反馈（提示先向上滚动加载）',
    textOf(view2.element).includes('向上滚动'), JSON.stringify(textOf(view2.element)));

  view.unmount();
  view2.unmount();
}

console.log('\n六、hooks 规则与容错');

{
  resetHost();
  storage.clear();
  const a = mountBadge('session-hooks-a');       // 0 次（提前 return null 的那条路径）
  const b = mountBadge('session-hooks-b');       // 有次数（真的渲染那条路径）
  b.setSnapshot(snapshotWithSeqs([1]));
  b.tick();
  check('0 次与有次数时 hook 条数一致（提前 return 没有跳过 hook）',
    a.hookCount === b.hookCount && a.hookCount > 0, `${a.hookCount} vs ${b.hookCount}`);
  a.unmount();
  b.unmount();
}

{
  resetHost();
  storage.clear();
  // 计数表被写坏时必须能自己爬起来，而不是把整个会话头搞崩。
  storage.setItem('dsh-loop-guard:count', '{坏掉的 JSON');
  storage.setItem('dsh-loop-guard:alert', '也不是 JSON');
  let threw = null;
  let view = null;
  try {
    view = mountBadge('session-broken');
    view.setSnapshot(snapshotWithSeqs([5]));
    view.tick();
  } catch (error) { threw = error; }
  check('计数表内容损坏时不抛异常（退回从 0 开始）', threw === null, threw && threw.message);
  check('损坏后仍能正常记上新的 1 次',
    view !== null && textOf(buttonOf(view)) === '本对话已打断 1 次',
    view && JSON.stringify(textOf(buttonOf(view))));
  if (view !== null) view.unmount();
}

{
  resetHost();
  storage.clear();
  // localStorage 完全不可用（隐私模式 / 配额满 / 非回环地址）时：
  // **「只增不减」这个保证不能跟着一起失效** —— 否则计数会退化成「当前 store 里的条数」，
  // 历史一被卸下数字就往下掉。内存兜底必须补上这个洞。
  const brokenStore = {
    getItem() { throw new Error('storage disabled'); },
    setItem() { throw new Error('storage disabled'); },
    removeItem() { throw new Error('storage disabled'); },
  };
  globalThis.window.localStorage = brokenStore;
  let threw = null;
  let view = null;
  try {
    view = mountBadge('session-nostorage');
    view.setSnapshot(snapshotWithSeqs([1, 2]));
    view.tick();
  } catch (error) { threw = error; }
  check('localStorage 完全不可用时不抛异常', threw === null, threw && threw.message);
  check('localStorage 不可用时徽章仍能根据当前 store 显示',
    view !== null && view.element !== null, view && String(view.element));
  check('localStorage 不可用时计数正确 = 2',
    view !== null && textOf(buttonOf(view)) === '本对话已打断 2 次',
    view && JSON.stringify(textOf(buttonOf(view))));

  // 关键：storage 写不进的情况下，历史被卸下（store 只剩 1 条）也**不能倒退**。
  if (view !== null) {
    view.setSnapshot(snapshotWithSeqs([2]));
    view.tick();
    check('localStorage 不可用 + 历史被卸下 → 计数仍不倒退（内存兜底生效）',
      textOf(buttonOf(view)) === '本对话已打断 2 次',
      JSON.stringify(textOf(buttonOf(view))));
    view.setSnapshot(snapshotWithSeqs([]));
    view.tick();
    check('localStorage 不可用 + store 清空 → 计数仍保留', textOf(buttonOf(view)) === '本对话已打断 2 次');
    view.unmount();
  }
  globalThis.window.localStorage = storage;
}

console.log(`\n${failures === 0 ? '全部通过' : `有 ${failures} 项失败`}`);
process.exit(failures === 0 ? 0 : 1);
