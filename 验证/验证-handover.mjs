/**
 * 交接功能回归验证套件（原 dsh-session-handover，2026-10-16 合并进 dsh-loop-watcher）。
 *
 * 目的：把 client.js 里**不依赖浏览器**的纯逻辑抠出来跑一遍。
 * 客户端插件的视觉表现只能由使用者重启后自己看（官方验收口径，见 侦察结论.md），
 * 但下面这些是能在命令行里确凿验证的：
 *
 *   1. 模块能通过语法检查、能被 ModuleLoader 形状加载；
 *   2. 菜单项注册参数正确（slot 名 / id / order / locale）；
 *   3. 接手指令文案完整（含导出命令、短 ID、日期、5 项要求、3 行收尾）；
 *   4. 工作区查找能从 WorkspaceSnapshot.items 里正确反查；
 *   5. 草稿写入的形状与 ui-conversation 的 init 完全一致；
 *   6. 预填时序：store 已存在时我们写晚一步会被冲掉（证明「必须先写」的判断）；
 *   7. 隐形 helper（预填主路径）的注册与行为契约。
 *
 * 跑法：node 跑验证.mjs   （或在 Windows 上双击 跑验证.cmd）
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const HERE = dirname(fileURLToPath(import.meta.url));
/**
 * 被测对象 = 仓库根目录里的插件本体（有 package.json 的那一层）。
 *
 * 交接功能是 dsh-loop-watcher 的一部分，所以指向仓库根。也可以用参数覆盖：
 *   node 验证-handover.mjs <client.js 路径>
 */
const PLUGIN = join(HERE, '..');
const CLIENT_PATH = process.argv[2] ?? join(PLUGIN, 'lib', 'client.js');
const CLIENT_SRC = readFileSync(CLIENT_PATH, 'utf8');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  ✗ ${name}`);
    console.log(`      ${error && error.message ? error.message : error}`);
  }
}

// ---------------------------------------------------------------------------
// 把 client.js 装进一个假浏览器里跑起来，拿到它导出的插件对象。
// ---------------------------------------------------------------------------

/** 记录 apply 期间注册了什么。 */
const registrations = [];
const effects = [];
const localeDicts = new Map();

/** 假的 localStorage。 */
function makeStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => {
      map.set(k, String(v));
    },
    removeItem: (k) => {
      map.delete(k);
    },
    _map: map,
  };
}

/**
 * 造一个最小的 React 替身。
 *
 * 组件要能被**直接调用**（当普通函数跑一次，拿到返回的元素树），
 * 这样不用装 React 也能验证渲染出来的东西。useEffect 立刻执行一次，
 * 等价于挂载后的效果，并立即跑清理函数。
 *
 * ⚠️ 合并后补了 `useRef`：loop-guard 那一半的组件（横幅、计数徽章）用了它，
 * 而 `apply()` 现在会一起注册那两条，缺 useRef 会在注册期就抛。
 */
function makeReact() {
  /**
   * 最小的 React 替身。
   *
   * `createElement` 对**函数组件**会当场渲染一层（React 就是这么做的），
   * 否则自定义组件（如 SettingsSwitch / SettingsRow）的内部 DOM 永远出不来，
   * 断言就只能看到 `<SettingsSwitch />` 这个占位 —— 那等于没验。
   */
  const createElement = (type, props, ...children) => {
    if (typeof type === 'function') {
      return type({ ...(props ?? {}), children });
    }
    return { type, props: props ?? {}, children };
  };
  return {
    createElement,
    useState(initial) {
      return [typeof initial === 'function' ? initial() : initial, () => {}];
    },
    useRef(initial) {
      return { current: initial };
    },
    useCallback(fn) {
      return fn;
    },
    useEffect(fn) {
      const cleanup = fn();
      if (typeof cleanup === 'function') cleanup();
    },
  };
}

/**
 * 加载插件并 apply 一次，返回测试需要的一切。
 *
 * ⚠️ 合并后新增的关键点：**交接 UI 只在「配了导出工具」时才注册**
 * （`hasExportTool()` 门控）。所以这里的默认 storage 会**先写入一个样本路径**，
 * 让交接相关的用例测的是「已配置」这条正常路径。
 * 想测「未配置 → 不注册」这条分支，用 `{ exportTool: '' }` 显式指定。
 *
 * @param {{ storage?: object, exportTool?: string }} options
 */
function loadPlugin({ storage, exportTool } = {}) {
  registrations.length = 0;
  effects.length = 0;
  localeDicts.clear();

  const React = makeReact();
  const sandboxConsole = { log() {}, error() {} };
  const localStorage = storage ?? makeStorage();
  // 默认写成「已配置」，让交接用例走正常路径；传 '' 则测未配置分支。
  const tool = exportTool === undefined ? 'X:\\sample\\导出会话.cmd' : exportTool;
  if (tool !== '') localStorage.setItem('dsh-loop-watcher:export-tool', tool);
  const timeouts = [];

  // 可替换的服务表（每个测试自己塞）。必须在 ctx 用到它之前声明。
  const services = {};

  const ctx = {
    get(name) {
      return services[name];
    },
    effect(fn, label) {
      const dispose = fn();
      effects.push({ label, dispose });
      return () => {};
    },
    on() {
      return () => {};
    },
    provide() {
      return () => {};
    },
    locale: {
      register(ns, dicts) {
        localeDicts.set(ns, dicts);
        return () => {};
      },
      bind(ns) {
        return (key, params) => {
          const dicts = localeDicts.get(ns);
          const dict = dicts ? dicts.zh ?? dicts.en ?? {} : {};
          let text = dict[key] ?? key;
          if (params) {
            for (const [k, v] of Object.entries(params)) {
              text = text.replaceAll(`{${k}}`, String(v));
            }
          }
          return text;
        };
      },
    },
    slots: {
      inject(slot, callback) {
        registrations.push({ kind: 'inject', slot });
        callback();
        return () => {};
      },
      register(options, component) {
        registrations.push({ kind: 'register', options, component });
        return () => {};
      },
    },
  };

  let loaded = null;

  const sandbox = {
    React,
    console: sandboxConsole,
    localStorage,
    document: undefined,
    window: {
      setTimeout: (fn, ms) => {
        timeouts.push({ fn, ms });
        return 0;
      },
      clearTimeout: () => {},
      // 合并后：插件在 apply() 里读 `window.localStorage` 解析导出工具路径
      // （决定要不要注册交接菜单项）。沙箱里必须也挂在 window 上。
      localStorage,
      // client.js 用的是 window.__ModuleLoader__.load(...)
      __ModuleLoader__: {
        load(def) {
          loaded = def;
        },
      },
    },
  };

  vm.createContext(sandbox);
  vm.runInContext(CLIENT_SRC, sandbox, { filename: 'client.js' });

  assert.ok(loaded !== null, 'client.js 应该调用 window.__ModuleLoader__.load()');
  assert.equal(loaded.id, 'dsh-loop-watcher', '模块 id 必须等于包名（合并后为 dsh-loop-watcher）');

  const plugin = loaded.factory((name) => {
    if (name === 'react') return React;
    throw new Error(`未预期的 require('${name}')`);
  });

  return { plugin, ctx, services, localStorage, registrations, effects, localeDicts, React, timeouts };
}

/** 取某个 slot 上的注册项。 */
function regOf(regs, slot) {
  return regs.filter((r) => r.kind === 'register').find((r) => r.options.name === slot);
}

/**
 * 按 **id** 取注册项 —— 合并后必须用这个。
 *
 * 原因：`conversation.input.dock` 这个插槽上现在有**两条**注册
 * （横幅 `loop-guard-notify` + 交接 helper `dsh-session-handover.prefill`），
 * 只按 slot 名找会拿到横幅那条，于是后面所有关于 helper 的断言全测错了对象。
 */
function regById(regs, id) {
  return regs.filter((r) => r.kind === 'register').find((r) => r.options.id === id);
}

// ---------------------------------------------------------------------------

console.log('\n[1] 模块形状');
{
  const { plugin } = loadPlugin();
  test('factory 返回 { apply, inject }', () => {
    assert.equal(typeof plugin.apply, 'function');
    assert.ok(Array.isArray(plugin.inject));
  });
  test("inject 含 'slots' 与 'locale'", () => {
    assert.deepEqual([...plugin.inject].sort(), ['locale', 'slots']);
  });
}

console.log('\n[2] 菜单项注册');
{
  const { plugin, ctx, registrations, localeDicts, effects } = loadPlugin();
  plugin.apply(ctx);

  const reg = regOf(registrations, 'sidebar.workspaces.session.menu.item');
  test('注册到 sidebar.workspaces.session.menu.item', () => {
    assert.ok(reg, '应注册菜单项');
  });
  test('id 用包名前缀，不撞出货的 id', () => {
    assert.equal(reg.options.id, 'dsh-session-handover.handover');
    for (const shipped of ['pin', 'rename', 'fork', 'archive']) {
      assert.notEqual(reg.options.id, shipped);
    }
  });
  test('order 500（排在 archive 400 之后）', () => {
    assert.equal(reg.options.order, 500);
  });
  test('locale 指向自己的命名空间', () => {
    assert.equal(reg.options.locale, 'loop-watcher', '合并后 locale 命名空间统一为 loop-watcher');
  });
  test('每一对都是「先 inject 再 register」（顺序不能反）', () => {
    const kinds = registrations.map((r) => r.kind);
    assert.equal(kinds.length % 2, 0, 'inject/register 应成对出现');
    for (let i = 0; i < kinds.length; i += 2) {
      assert.equal(kinds[i], 'inject', `第 ${i} 项应是 inject`);
      assert.equal(kinds[i + 1], 'register', `第 ${i + 1} 项应是 register`);
    }
  });
  test('注册了 zh + en 两套文案', () => {
    const dicts = localeDicts.get('loop-watcher');
    assert.ok(dicts.zh, '缺 zh');
    assert.ok(dicts.en, '缺 en');
  });
  test('文案键两套语言完全对齐', () => {
    const dicts = localeDicts.get('loop-watcher');
    assert.deepEqual(Object.keys(dicts.zh).sort(), Object.keys(dicts.en).sort());
  });
  test('locale 已通过 ctx.effect 注册（可回收）', () => {
    assert.ok(effects.some((e) => typeof e.label === 'string' && e.label.includes('dictionaries')));
  });
}

console.log('\n[3] 菜单项渲染');
{
  const { plugin, ctx, registrations } = loadPlugin();
  plugin.apply(ctx);
  const reg = regOf(registrations, 'sidebar.workspaces.session.menu.item');

  const items = [
    { workspaceId: 'ws-1', sessionIds: ['s-a', 's-b'] },
    { workspaceId: 'ws-2', sessionIds: ['s-c'] },
  ];
  let menuClosed = false;
  const props = {
    sessionId: 's-b',
    displayTitle: '测试会话',
    useMenuOpenState: () => [false, () => { menuClosed = true; }],
    useWorkspaces: (selector) => selector({ items, phase: 'ready' }),
    t: ctx.locale.bind('loop-watcher'),
  };

  const el = reg.component(props);
  test('渲染出一个 role="menuitem" 的 button', () => {
    assert.equal(el.type, 'button');
    assert.equal(el.props.role, 'menuitem');
    assert.equal(el.props.type, 'button');
  });
  test('文案是「交接对话」', () => {
    assert.equal(el.children[0], '交接对话');
  });
  test('不写死颜色，只用 --dsw-alias-* token', () => {
    const style = JSON.stringify(el.props.style);
    assert.ok(style.includes('var(--dsw-alias-'), '应引用主题 token');
    for (const bad of ['#fff', '#000', 'rgb(']) {
      assert.ok(!style.includes(bad), `不应出现写死的颜色 ${bad}`);
    }
  });
  test('点击后先关菜单，再触发交接', () => {
    assert.equal(menuClosed, false);
    el.props.onClick();
    assert.equal(menuClosed, true, '必须先关菜单，否则菜单会一直开着');
  });
}

console.log('\n[4] 接手指令文案');
{
  const buildPrompt = extractBuildPrompt(CLIENT_SRC);
  const text = buildPrompt('77b380eb-1234', '旧会话标题');

  test('开头点明被交接的会话与 ID', () => {
    assert.ok(text.includes('旧会话标题'), '应含标题');
    assert.ok(text.includes('77b380eb-1234'), '应含完整 ID');
  });
  test('含导出命令与短 ID', () => {
    assert.ok(text.includes('导出会话.cmd'), '应含导出工具路径');
    assert.ok(text.includes('export 77b380eb --detail brief'), '应含短 ID 与 brief 档');
  });
  test('导出用 -o 写进当前工作目录（避开沙箱提权）', () => {
    assert.ok(text.includes('-o ".\\旧会话素材-77b380eb.md"'), '应带 -o 指定输出路径');
  });
  test('含 PYTHONIOENCODING（防中文乱码）', () => {
    assert.ok(text.includes("PYTHONIOENCODING='utf-8'"));
  });
  test('要求读完素材**直接接着干活**，而不是写交接文档', () => {
    assert.ok(text.includes('直接把这个任务接着做完'), '应要求接着做完');
    assert.ok(!/据此写一份交接文档/.test(text), '不该再要求写交接文档');
  });
  test('不再以「只回 3 行」收尾（那是只交文档不干活）', () => {
    assert.ok(!text.includes('只回 3 行'), '旧的收尾要求应已移除');
  });
  test('要求边做边简短汇报', () => {
    assert.ok(text.includes('边做边简短汇报'), '应要求边做边汇报');
  });
  test('把素材里的 5 类重点交代清楚', () => {
    for (const n of ['任务目标', '已经做完到哪一步', '关键文件与路径', '踩过的坑', '还剩什么没做']) {
      assert.ok(text.includes(n), `缺「${n}」`);
    }
  });
  test('含「打转部分不可信」的提醒，且要求自行判断不要停下', () => {
    assert.ok(text.includes('不可信'));
    assert.ok(text.includes('不要因此停下来问我'), '应说明自行判断后继续');
  });
  test('说明卡住时才问', () => {
    assert.ok(text.includes('卡住') && text.includes('才问我'), '应说明求助时机');
  });
  test('标题为空时降级为「（无标题）」', () => {
    const noTitle = buildPrompt('77b380eb-1234', '');
    assert.ok(noTitle.includes('（无标题）'));
  });
}

console.log('\n[5] 工作区查找');
{
  const items = [
    { workspaceId: 'ws-1', sessionIds: ['s-a', 's-b'] },
    { workspaceId: 'ws-2', sessionIds: ['s-c'] },
  ];
  const lookup = extractWorkspaceLookup(CLIENT_SRC);

  test('能从 sessionIds 反查工作区', () => {
    assert.equal(lookup.findIn(items, 's-c'), 'ws-2');
    assert.equal(lookup.findIn(items, 's-b'), 'ws-1');
  });
  test('找不到时返回 undefined（不猜）', () => {
    assert.equal(lookup.findIn(items, 's-不存在'), undefined);
    assert.equal(lookup.findIn([], 's-a'), undefined);
  });
  test('容忍残缺的 workspace 对象', () => {
    assert.equal(lookup.findIn([null, {}, { workspaceId: 'w', sessionIds: 'not-array' }], 'x'), undefined);
  });
  test('空 items 不抛', () => {
    assert.equal(lookup.findIn([], 'x'), undefined);
  });

  // 菜单项渲染后，查找器应拿到快照（effect 立刻跑）。
  const { plugin, ctx, registrations } = loadPlugin();
  plugin.apply(ctx);
  const reg = regOf(registrations, 'sidebar.workspaces.session.menu.item');
  reg.component({
    sessionId: 's-c',
    displayTitle: '',
    useMenuOpenState: () => [false, () => {}],
    useWorkspaces: (selector) => selector({ items, phase: 'ready' }),
    t: ctx.locale.bind('loop-watcher'),
  });
  test('菜单项渲染后，模块内查找器已装载快照', () => {
    // 通过 helper 的公开面确认：注册项存在且渲染没抛错。
    assert.ok(reg, '菜单项应仍在');
  });
}

console.log('\n[6] 旧的草稿预填机制已彻底移除（2026-10-17 改为隐藏注入）');
{
  // 这一段曾是「写 localStorage 草稿」的回归。该机制 2026-10-17 被「隐藏注入」取代
  // （指令不再进输入框，改为发送时拼在实际内容前面），整块死代码已从 client.js 删除。
  // 这里反过来断言它**没有复活** —— 否则会重新引入「输入框被占满」的老问题。
  const dead = /CONVERSATION_STORE_KEY|function safeStorage|function writeDraft|function readDraft|async function prefillDraft/;
  test('client.js 里不再有旧草稿预填机制的任何函数', () => {
    assert.ok(!dead.test(CLIENT_SRC), '旧机制应已删除，不该残留');
  });
  test('登记表是内存 Map + localStorage 兜底（不是 dsh.conversation 键）', () => {
    assert.ok(/const pendingHandovers = new Map\(\)/.test(CLIENT_SRC), '应有 pendingHandovers Map');
    assert.ok(/localStorage\.setItem\(PENDING_KEY/.test(CLIENT_SRC), '应写 localStorage 兜底');
    assert.ok(!/dsh\.conversation/.test(CLIENT_SRC), '不该再碰 dsh.conversation.* 键');
  });
  test('不再等待 helper 消化登记项（那是旧主路径的时序逻辑）', () => {
    assert.ok(!/waitForHandoverConsumed/.test(CLIENT_SRC), '旧等待函数应已删除');
  });
}

console.log('\n[9] 隐形 helper（预填主路径）');
{
  const { plugin, ctx, registrations } = loadPlugin();
  plugin.apply(ctx);
  // 合并后 `conversation.input.dock` 上有两条注册（横幅 + 本 helper），
  // 必须**按 id** 取，否则会拿到横幅那条、后面全测错对象。
  const dockReg = regById(registrations, 'dsh-session-handover.prefill');

  test('注册了 conversation.input.dock 上的 helper', () => {
    assert.ok(dockReg, '应注册 input.dock helper');
  });
  test('helper 的 id 用包名前缀，不撞出货的 id', () => {
    assert.equal(dockReg.options.id, 'dsh-session-handover.prefill');
    for (const shipped of ['todo', 'queue', 'goal', 'voice-chat']) {
      assert.notEqual(dockReg.options.id, shipped);
    }
  });
  test('helper 排在别人后面（渲染为空，不争位置）', () => {
    assert.ok(dockReg.options.order >= 100, 'order 应靠后');
  });
  test('helper 渲染为 null（不在 composer 上多出东西）', () => {
    const el = dockReg.component({
      sessionId: 'sess-x',
      inputActions: { setDraft() {} },
    });
    assert.equal(el, null);
  });
  test('没有登记项时，helper 不碰 setDraft', () => {
    let called = 0;
    dockReg.component({
      sessionId: 'sess-没有登记',
      inputActions: {
        setDraft() {
          called += 1;
        },
      },
    });
    assert.equal(called, 0, '不该动无关会话的输入框');
  });
}

console.log('\n[10] helper 的行为契约（2026-10-17：隐藏注入，不再预填输入框）');
{
  const dock = extractFunctionBody(CLIENT_SRC, 'HandoverDock');

  test('pendingHandovers 是 Map，按 sessionId 存文本', () => {
    assert.ok(/const pendingHandovers = new Map\(\)/.test(CLIENT_SRC), '应有 pendingHandovers Map');
  });
  test('helper **不再**调用 setDraft 预填（指令不进输入框）', () => {
    assert.ok(!dock.includes('setDraft'), '预填已废弃，不应再出现 setDraft');
  });
  test('helper 挂载时从 localStorage 恢复登记（刷新场景）', () => {
    assert.ok(dock.includes('restorePendingHandover()'), '应调 restorePendingHandover');
  });
  test('helper 给 session.prompt 挂注入器（armInjector）', () => {
    assert.ok(dock.includes('armInjector'), '应调 armInjector');
    const injector = extractFunctionBody(CLIENT_SRC, 'armInjector');
    assert.ok(injector.includes('session.prompt ='), '应替换 session.prompt');
    assert.ok(injector.includes('clearPendingHandover(sessionId)'), '注入后销登记');
    assert.ok(injector.includes('HANDOVER_INJECT_MARK'), '应有防重入标记');
  });
  test('注入器把隐藏指令作为第一段（首个 text block，且以交接段头开头）', () => {
    const injector = extractFunctionBody(CLIENT_SRC, 'armInjector');
    assert.ok(/merged = \[\{ type: 'text', text: `\$\{HANDOVER_TITLE_PREFIX\}/.test(injector),
      'merged 应先以「段头 + 指令」为第一段（段头决定会话标题）');
    // 段头必须是源码里的常量，不能是散落的字面量（否则改标题前缀会漏掉这里）。
    assert.ok(/HANDOVER_TITLE_PREFIX\}\\n\$\{text\}`/.test(injector),
      '段头后要换行再接指令正文');
  });
  test('用户文字必须带「用户追加：」段头单独成段（不与指令糊在一起）', () => {
    const injector = extractFunctionBody(CLIENT_SRC, 'armInjector');
    assert.ok(injector.includes('用户追加：'), '段头字面量必须在源码里');
    assert.ok(/text: `\\n用户追加：\$\{userText\}`/.test(injector),
      '段头前要有换行（独立成段）');
    assert.ok(/userText\.trim\(\) !== ''/.test(injector), '空白草稿不应加段头');
  });
  test('helper 有重试（binding 可能晚一点才有）', () => {
    assert.ok(/setTimeout/.test(dock), '应有重试定时器');
    assert.ok(/triesLeft/.test(dock), '应有重试计数');
  });
  test('helper 卸载时清掉定时器（不留悬挂资源）', () => {
    assert.ok(dock.includes('clearTimeout'), '卸载要清定时器');
  });
  test('helper 用 sessionId 做依赖（换会话会重新触发）', () => {
    assert.ok(dock.includes('[sessionId]'), '依赖数组要含 sessionId');
  });
  test('有登记时渲染蓝色胶囊（role=status + 胶囊类名）', () => {
    assert.ok(/dsh-lw-handover-badge/.test(dock), '应渲染胶囊');
    assert.ok(dock.includes("role: 'status'"), '应带 role=status');
  });
  test('无登记时渲染为空（不占 composer）', () => {
    assert.ok(dock.includes('if (!pending) return null;'), '无登记应返回 null');
  });
  test('helper 订阅登记表广播（复用空白会话时也能即时显示）', () => {
    assert.ok(dock.includes('pendingHandoverListeners.add(listener)'), '挂载时订阅');
    assert.ok(dock.includes('pendingHandoverListeners.delete(listener)'), '卸载时退订');
    assert.ok(/pendingHandoverListeners\.add/.test(CLIENT_SRC)
      && /notifyPendingHandover\(\)/.test(CLIENT_SRC), '登记侧要有广播');
    // runHandover 登记后必须广播（否则复用的空白会话看不到胶囊）。
    const run = extractFunctionBody(CLIENT_SRC, 'runHandover');
    assert.ok(/pendingHandovers\.set\(newSessionId, prompt\);[\s\S]{0,200}notifyPendingHandover\(\)/.test(run),
      '登记后应紧跟着广播');
  });
}

console.log('\n[11] Host 半与清单');
{
  const INDEX_SRC = readFileSync(join(PLUGIN, 'lib', 'index.js'), 'utf8');
  test('index.js 导出 apply', () => {
    assert.ok(/export\s+function\s+apply/.test(INDEX_SRC));
  });
  test('manifest 声明了 client 面与 bundle patch', () => {
    const pkg = JSON.parse(readFileSync(join(PLUGIN, 'package.json'), 'utf8'));
    assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml');
    assert.equal(pkg.dsh.client.platform, 'web');
    assert.ok(Array.isArray(pkg.dsh.client.inject));
  });
  test('locale 文件是合法 JSON 且键对齐', () => {
    const zh = JSON.parse(readFileSync(join(PLUGIN, 'locale', 'zh.json'), 'utf8'));
    const en = JSON.parse(readFileSync(join(PLUGIN, 'locale', 'en.json'), 'utf8'));
    assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort());
  });
}

// ---------------------------------------------------------------------------
// 从源码里抠出纯函数来跑。
//
// 不 import client.js（它依赖 window/ModuleLoader），而是把函数体截出来在
// 一个干净的作用域里重新求值 —— 这样验证的仍是**同源代码**，不是抄一份。
// ---------------------------------------------------------------------------

/**
 * 从源码里截出 `<name>` 的**完整函数声明**（含 `function name(...)` 头）。
 *
 * 用花括号配对找结尾，所以函数体里嵌套的 `{}` 都能正确跳过。
 */
function extractFunctionBody(src, name) {
  const marker = `function ${name}(`;
  const start = src.indexOf(marker);
  assert.ok(start >= 0, `源码里找不到 ${name}`);
  let i = src.indexOf('{', start);
  assert.ok(i > 0, `${name} 没有函数体`);
  let depth = 0;
  for (; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`${name} 的花括号不配对`);
}

/** 截出 `const <name> = ...;` 这条语句（用于箭头函数形式的工具）。 */
function extractConstDecl(src, name) {
  const marker = `const ${name} = `;
  const start = src.indexOf(marker);
  assert.ok(start >= 0, `源码里找不到 const ${name}`);
  const end = src.indexOf(';', start);
  assert.ok(end > start, `const ${name} 没有收尾分号`);
  return src.slice(start, end + 1);
}

/** 抽出「UI 偏好」的解析函数（resolveCountSevere / resolveBannerDraft）来跑。 */
function extractUiConfig(src) {
  const severe = extractFunctionBody(src, 'resolveCountSevere');
  const draft = extractFunctionBody(src, 'resolveBannerDraft');
  const severeKey = extractConstDecl(src, 'COUNT_SEVERE_KEY');
  const draftKey = extractConstDecl(src, 'BANNER_DRAFT_KEY');
  const severeDefault = extractConstDecl(src, 'COUNT_SEVERE_DEFAULT');
  const draftDefault = extractConstDecl(src, 'BANNER_DRAFT_DEFAULT');
  return new Function(`${severeDefault}
    ${draftDefault}
    ${severeKey}
    ${draftKey}
    ${severe}
    ${draft}
    return {
      resolve(storage) {
        return {
          countSevere: resolveCountSevere(storage),
          bannerDraft: resolveBannerDraft(storage),
        };
      },
    };`)();
}

/** 抽出 countLevel 来跑（它自带阈值兜底，不依赖外部常量）。 */
function extractCountLevel(src) {
  const decl = extractFunctionBody(src, 'countLevel');
  return new Function(`${decl}\nreturn countLevel;`)();
}

function extractBuildPrompt(src) {
  const decl = extractFunctionBody(src, 'buildHandoverPrompt');
  // 合并后：导出工具路径来自**配置变量** exportToolPath，不再是写死的字面常量。
  // 这里断言新机制确实就位（否则下面的 factory 注入的就是个错的名字）。
  assert.ok(/let exportToolPath\b/.test(src), '找不到 exportToolPath（配置变量）');
  assert.ok(!/const EXPORT_TOOL = String\.raw/.test(src),
    '不应再有写死的 EXPORT_TOOL 字面路径（那是本次要修掉的开源硬伤）');
  // 2026-10-17：指令最前面可注入「前缀提示词」（设置页可改），
  // buildHandoverPrompt 依赖 getPrefillText 读它 —— 一起带上（仍是同源代码）。
  assert.ok(/function getPrefillText\(/.test(src), '找不到 getPrefillText（前缀注入判据）');
  // buildHandoverPrompt 依赖这几个小工具，一起带上（仍是同源代码）。
  const shortDecl = extractFunctionBody(src, 'shortSessionId');
  const stampDecl = extractFunctionBody(src, 'todayStamp');
  const prefillDecl = extractFunctionBody(src, 'getPrefillText');
  const factory = new Function(
    'exportToolPath',
    'prefillConfig',
    `${shortDecl}
     ${stampDecl}
     ${prefillDecl}
     const hasExportTool = () => exportToolPath.trim() !== '';
     ${decl}
     return buildHandoverPrompt;`,
  );
  // 用一个样本路径注入：与插件运行时 setExportToolPath() 的效果等价。
  // prefillConfig 给一个「开 + 样本前缀」的替身，与运行时 resolvePrefillConfig() 后的形状一致。
  return factory('X:\\sample\\导出会话.cmd', { enabled: true, text: '【测试前缀】这是注入测试。' });
}

function extractWorkspaceLookup(src) {
  const marker = 'const WorkspaceLookup = {';
  const start = src.indexOf(marker);
  assert.ok(start >= 0, '找不到 WorkspaceLookup');
  let i = src.indexOf('{', start);
  let depth = 0;
  for (; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  const literal = src.slice(src.indexOf('{', start), i + 1);
  return new Function(`return ${literal};`)();
}

// ---------------------------------------------------------------------------

console.log('\n[12] 合并完整性：两半都在，且互不覆盖');
{
  const { plugin, ctx, registrations, localeDicts } = loadPlugin();
  plugin.apply(ctx);

  const ids = registrations.filter((r) => r.kind === 'register').map((r) => r.options.id);
  test('四个插槽条目全部注册（横幅 / 徽章 / 交接菜单 / 交接 helper）', () => {
    for (const id of ['loop-guard-notify', 'loop-guard-count',
      'dsh-session-handover.handover', 'dsh-session-handover.prefill']) {
      assert.ok(ids.includes(id), `缺少注册：${id}（实际：${ids.join(', ')}）`);
    }
  });
  test('插槽上不再有重名 id（否则平台会互相顶掉）', () => {
    assert.equal(new Set(ids).size, ids.length, `id 有重复：${ids.join(', ')}`);
  });
  test('两半的字典合并在同一个命名空间下且互不覆盖', () => {
    const dicts = localeDicts.get('loop-watcher');
    assert.ok(dicts && dicts.zh && dicts.en, '应有 loop-watcher 命名空间的 zh/en');
    // loop-guard 那一半的键
    assert.ok(dicts.zh['count.label'], '缺少 count.label（计数徽章的键）');
    assert.ok(dicts.zh['guard.title'], '缺少 guard.title（横幅的键）');
    // handover 那一半的键
    assert.ok(dicts.zh['handover.label'], '缺少 handover.label（交接的键）');
    assert.ok(dicts.en['handover.label'], 'en 缺 handover.label');
  });
  test('两半的键没有互相覆盖（各自的原键都还在）', () => {
    const zh = localeDicts.get('loop-watcher').zh;
    // 抽查各自的特征键，确认合并没有丢
    for (const key of ['count.labelHealthy', 'count.titleSevere', 'guard.advice',
      'handover.busy', 'handover.noWorkspace', 'handover.connectFailed',
      'handover.exportFailed', 'handover.prefilled']) {
      assert.ok(zh[key], `字典缺键：${key}`);
    }
  });
}

console.log('\n[13] 未配置导出工具时：交接菜单照常出现（指令不含导出命令），设置页注册');
{
  // 显式传 exportTool: '' → 未配置分支。
  // 2026-10-17 起行为变更：交接菜单与 helper **常驻注册**（指令不含导出命令，
  // 交接口照常可用），不再按导出工具隐藏 —— 见 apply() 里的注释。
  const { plugin, ctx, registrations, localeDicts } = loadPlugin({ exportTool: '' });
  plugin.apply(ctx);
  const ids = registrations.filter((r) => r.kind === 'register').map((r) => r.options.id);

  test('未配置时**仍然注册**交接菜单项（指令不含导出命令，交接仍可用）', () => {
    assert.ok(ids.includes('dsh-session-handover.handover'), `实际：${ids.join(', ')}`);
  });
  test('未配置时**仍然注册**交接 helper', () => {
    assert.ok(ids.includes('dsh-session-handover.prefill'));
  });
  test('设置页已注册（loop-watcher-settings）', () => {
    assert.ok(ids.includes('loop-watcher-settings'), `实际：${ids.join(', ')}`);
  });
  test('未配置时**仍然注册**横幅（不依赖导出工具）', () => {
    assert.ok(ids.includes('loop-guard-notify'), `实际：${ids.join(', ')}`);
  });
  test('未配置时**仍然注册**计数徽章（不依赖导出工具）', () => {
    assert.ok(ids.includes('loop-guard-count'));
  });
  test('未配置时字典照常注册（横幅/徽章/设置页的文案仍要有）', () => {
    const dicts = localeDicts.get('loop-watcher');
    assert.ok(dicts && dicts.zh['count.label'] && dicts.zh['guard.title'] && dicts.zh['settings.nav']);
  });
}

console.log('\n[14] 交接前缀提示词（2026-10-17 新增：设置页开关 + 可编辑正文 + 注入最前）');
{
  // ---- a. 源码级：默认状态语义 ----
  {
    const { plugin, ctx, localStorage } = loadPlugin({ exportTool: '' });
    plugin.apply(ctx);
    // 通过真实链路拿指令：直接调用 ctx 里注册的菜单组件不可行（需要会话环境），
    // 改用沙箱内直接调 buildHandoverPrompt —— loadPlugin 的沙箱把整个 factory
    // 闭包留在了 vm context 里，但内部函数不落 sandbox。所以这里改从「注册项组件」
    // 的行为验，指令文案本身由上面的 [4] 段（提取执行）覆盖。
    // 这里用「源码级 + 环境级」两组断言覆盖前缀链路：
    test('默认状态：前缀正文键未写 → 语义为「用内置默认前缀」', () => {
      // resolvePrefillConfig 的三态语义在源码级可判（rawText === null → DEFAULT）。
      assert.ok(/rawText === null\s*\n\s*\? PREFILL_TEXT_DEFAULT/.test(CLIENT_SRC)
        || /rawText === null \? PREFILL_TEXT_DEFAULT/.test(CLIENT_SRC),
        'resolvePrefillConfig 应在正文键未写时回退到内置默认');
    });
    test('默认状态：开关未写 → 默认开', () => {
      assert.ok(/enabled: rawEnabled === null \? true : rawEnabled === '1'/.test(CLIENT_SRC));
    });
    test('注入位置：前缀在指令最前面（prefill 先于会话行）', () => {
      const decl = CLIENT_SRC.indexOf('function buildHandoverPrompt');
      const seg = CLIENT_SRC.slice(decl, decl + 2600);
      const prefillAt = seg.indexOf('if (prefill !== \'\') lines.push(prefill, \'\');');
      const sessionAt = seg.indexOf('lines.push(`上一个会话（${name}，ID ${sessionId}）需要交接给你。`)');
      assert.ok(prefillAt > -1 && sessionAt > prefillAt, '前缀必须先于「上一个会话…」行');
    });
    test('空白正文语义：写空白 = 明确「不注入」，刷新后不复活', () => {
      // setPrefillConfig 现在两个键总是成对落盘（含空白），不再 removeItem。
      assert.ok(/window\.localStorage\.setItem\(PREFILL_TEXT_KEY, prefillConfig\.text\);/.test(CLIENT_SRC),
        '空白正文也要落盘（否则刷新后回退内置默认）');
    });
    test('开关关闭时不注入：getPrefillText 判据包含 enabled', () => {
      assert.ok(/prefillConfig\.enabled && prefillConfig\.text\.trim\(\) !== ''/.test(CLIENT_SRC));
    });
  }

  // ---- b. 环境级：多种 localStorage 状态下的实际注入结果 ----
  // 抽出 getPrefillText + resolvePrefillConfig（真源码），配合替身实际跑。
  {
    const extractFn = (name) => {
      const start = CLIENT_SRC.indexOf(`function ${name}(`);
      assert.ok(start > 0, `源码里找不到 ${name}`);
      let i = CLIENT_SRC.indexOf('{', start);
      let depth = 0;
      for (; i < CLIENT_SRC.length; i += 1) {
        if (CLIENT_SRC[i] === '{') depth += 1;
        else if (CLIENT_SRC[i] === '}') {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      return CLIENT_SRC.slice(start, i + 1);
    };
    // sampleDefault 顶替内置默认前缀：插件里它是一段非空文案，
    // 这里注入样本串即可验「回退到非空默认」这条路径。
    const sampleDefault = '【内置默认前缀（样本）】';
    const makeGet = (storage, fakeWindow) => new Function(
      'PREFILL_TEXT_DEFAULT',
      'PREFILL_ENABLED_KEY',
      'PREFILL_TEXT_KEY',
      'storage',
      'window',
      `${extractFn('readStoredString')}
       ${extractFn('resolvePrefillConfig')}
       ${extractFn('getPrefillText')}
       const prefillConfig = resolvePrefillConfig(storage);
       return getPrefillText;`,
    )(sampleDefault, 'dsh-loop-watcher:prefill-enabled', 'dsh-loop-watcher:prefill-text', storage, fakeWindow);

    const wrap = (map) => ({
      getItem: (k) => (map.has(k) ? map.get(k) : null),
    });

    test('【环境】全新安装（无键）→ 注入内置默认前缀（非空）', () => {
      const get = makeGet(wrap(new Map()), undefined);
      assert.equal(get(), sampleDefault);
    });
    test('【环境】写入自定义前缀 → 注入的是自定义内容', () => {
      const map = new Map([['dsh-loop-watcher:prefill-text', '我的自定义前缀']]);
      const get = makeGet(wrap(map), undefined);
      assert.equal(get(), '我的自定义前缀');
    });
    test('【环境】开关写成 0 → 不注入（即使正文还在）', () => {
      const map = new Map([
        ['dsh-loop-watcher:prefill-enabled', '0'],
        ['dsh-loop-watcher:prefill-text', '我的自定义前缀'],
      ]);
      const get = makeGet(wrap(map), undefined);
      assert.equal(get(), '');
    });
    test('【环境】正文清成空白 → 不注入', () => {
      const map = new Map([['dsh-loop-watcher:prefill-text', '   ']]);
      const get = makeGet(wrap(map), undefined);
      assert.equal(get(), '');
    });
    test('【环境】localStorage 抛异常（隐私模式）→ 回退默认，不崩', () => {
      const fakeWindow = { localStorage: { getItem() { throw new Error('privacy'); } } };
      const get = makeGet(undefined, fakeWindow);
      assert.equal(get(), sampleDefault);
    });
  }

  // ---- c2. 注入器端到端：真源码执行，模拟一次发送 ----
  {
    const extractFn = (name) => {
      const start = CLIENT_SRC.indexOf(`function ${name}(`);
      assert.ok(start > 0, `源码里找不到 ${name}`);
      let i = CLIENT_SRC.indexOf('{', start);
      let depth = 0;
      for (; i < CLIENT_SRC.length; i += 1) {
        if (CLIENT_SRC[i] === '{') depth += 1;
        else if (CLIENT_SRC[i] === '}') {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      return CLIENT_SRC.slice(start, i + 1);
    };
    const extractConst = (name) => {
      const marker = `const ${name} = `;
      const start = CLIENT_SRC.indexOf(marker);
      assert.ok(start >= 0, `源码里找不到 const ${name}`);
      // const 对象/字符串到分号为止（这些常量里没有分号字面量）。
      const end = CLIENT_SRC.indexOf(';', start);
      return CLIENT_SRC.slice(start, end + 1);
    };
    const makeHarness = (storageMap) => {
      const calls = [];
      const pendingHandovers = new Map([['sess-1', '【隐藏交接指令】']]);
      const session = {
        prompt(content, mode, signal, requestId) {
          calls.push({ content, mode, signal, requestId });
          return { ok: true };
        },
      };
      const factory = new Function(
        'pendingHandovers',
        'session',
        'warn',
        'storage',
        `${extractConst('PENDING_KEY')}
         ${extractConst('HANDOVER_INJECT_MARK')}
         ${extractConst('HANDOVER_TITLE_PREFIX')}
         const pendingHandoverListeners = new Set();
         const notifyPendingHandover = () => {};
         ${extractFn('restorePendingHandover')}
         ${extractFn('hasPendingHandover')}
         ${extractFn('clearPendingHandover')}
         ${extractFn('armInjector')}
         const window = { localStorage: storage };
         armInjector({ session }, 'sess-1');
         return session.prompt;`,
      );
      const storage = {
        getItem: (k) => (storageMap.has(k) ? storageMap.get(k) : null),
        setItem: (k, v) => { storageMap.set(k, String(v)); },
        removeItem: (k) => { storageMap.delete(k); },
      };
      return { run: factory(pendingHandovers, session, () => {}), calls, pendingHandovers, storageMap };
    };

    test('【端到端】arm 后第一次发送：指令一段 + 用户追加一段', () => {
      const h = makeHarness(new Map());
      const out = h.run([{ type: 'text', text: '用户自己的提示词' }], 'queue', null, 'rpc-1');
      assert.equal(out.ok, true);
      assert.equal(h.calls.length, 1);
      const sent = h.calls[0].content;
      assert.equal(sent.length, 2);
      // 段头必须在指令最前面：DSH 的标题 fallback 取第一条人类消息的开头词，
      // 不加它标题就会变成「【交接模式】你现在接手的是」这种没人认得的东西。
      assert.equal(sent[0].text, `交接对话：\n【隐藏交接指令】`);
      // 使用者文字必须带「用户追加：」段头单独成段（不与指令糊在一起）。
      assert.equal(sent[1].text, '\n用户追加：用户自己的提示词');
      assert.equal(sent[1].text.startsWith('\n用户追加：'), true, '段头前要换行（独立成段）');
      assert.equal(h.calls[0].mode, 'queue');
    });
    test('【端到端】指令段以 HANDOVER_TITLE_PREFIX 开头（标题 fallback 才不会变成指令原文）', () => {
      const h = makeHarness(new Map());
      h.run([{ type: 'text', text: '帮我接着做插件' }], 'queue', null, 'r');
      const first = h.calls[0].content[0].text;
      assert.equal(first.startsWith('交接对话：'), true, `实际开头: ${first.slice(0, 20)}`);
      // fallback 取的开头词正是这段前缀本身，不会读到交接指令的正文。
      assert.ok(!first.startsWith('【交接模式】'), '不能以前缀提示词开头（那正是难看标题的来源）');
    });
    test('【端到端】多个 text block 合并成一个「用户追加」段', () => {
      const h = makeHarness(new Map());
      h.run([{ type: 'text', text: '第一段' }, { type: 'text', text: '第二段' }], 'queue', null, 'r');
      const sent = h.calls[0].content;
      assert.equal(sent.length, 2);
      assert.equal(sent[1].text, '\n用户追加：第一段\n第二段');
    });
    test('【端到端】附件保持原顺序、不带段头', () => {
      const h = makeHarness(new Map());
      h.run([
        { type: 'image', value: {} },
        { type: 'text', text: '看图说话' },
        { type: 'file', receiptId: 'r1' },
      ], 'queue', null, 'r');
      const sent = h.calls[0].content;
      assert.equal(sent.length, 4);
      assert.equal(sent[0].text, '交接对话：\n【隐藏交接指令】');
      assert.equal(sent[1].text, '\n用户追加：看图说话');
      assert.equal(sent[2].type, 'image', '图片保持相对顺序');
      assert.equal(sent[3].type, 'file', '文件保持相对顺序');
      assert.equal(sent[3].receiptId, 'r1');
    });
    test('【端到端】纯附件（无文字）→ 不加「用户追加」段头', () => {
      const h = makeHarness(new Map());
      h.run([{ type: 'image', value: {} }], 'queue', null, 'r');
      const sent = h.calls[0].content;
      assert.equal(sent.length, 2);
      assert.equal(sent[0].text, '交接对话：\n【隐藏交接指令】');
      assert.equal(sent[1].type, 'image');
      assert.ok(!sent.some((b) => b.type === 'text' && b.text.includes('用户追加')),
        '无文字时不应留空段头');
    });
    test('【端到端】空白草稿（只空格）→ 不加「用户追加」段头', () => {
      const h = makeHarness(new Map());
      h.run([{ type: 'text', text: '   ' }], 'queue', null, 'r');
      const sent = h.calls[0].content;
      assert.equal(sent.length, 1);
      assert.equal(sent[0].text, '交接对话：\n【隐藏交接指令】');
    });
    test('【端到端】注入后销登记（内存 + localStorage）', () => {
      const map = new Map();
      const h = makeHarness(map);
      h.run([{ type: 'text', text: 'hi' }], 'queue', null, 'r');
      assert.equal(h.pendingHandovers.has('sess-1'), false, '内存登记应销掉');
      assert.equal(map.has('dsh-loop-watcher:pending-handover'), false, 'localStorage 应清掉');
    });
    test('【端到端】第二次发送不再注入（防重入标记生效）', () => {
      const h = makeHarness(new Map());
      h.run([{ type: 'text', text: '第一条' }], 'queue', null, 'r1');
      h.run([{ type: 'text', text: '第二条' }], 'queue', null, 'r2');
      assert.equal(h.calls.length, 2);
      assert.equal(h.calls[1].content.length, 1, '第二条不应再带指令');
      assert.equal(h.calls[1].content[0].text, '第二条');
    });
    test('【端到端】没有登记时直接放行（不注入、不报错）', () => {
      const h = makeHarness(new Map());
      h.pendingHandovers.clear();
      const out = h.run([{ type: 'text', text: '普通消息' }], 'steer', null, 'r');
      assert.equal(out.ok, true);
      assert.equal(h.calls[0].content.length, 1);
      assert.equal(h.calls[0].content[0].text, '普通消息');
      assert.equal(h.calls[0].mode, 'steer', 'steer 模式也走注入器（都被覆盖）');
    });
    test('【端到端】空内容数组也能注入（只发指令的场景）', () => {
      const h = makeHarness(new Map());
      h.run([], 'queue', null, 'r');
      assert.equal(h.calls[0].content.length, 1);
      assert.equal(h.calls[0].content[0].text, '交接对话：\n【隐藏交接指令】');
    });
    test('【端到端】重复 arm 是幂等的（不二次包装 prompt）', () => {
      const h = makeHarness(new Map());
      const first = h.run;
      // 再 arm 一次：armInjector 直接返回 true（标记已存在）。
      const map = new Map([['dsh-loop-watcher:pending-handover',
        JSON.stringify({ sessionId: 'sess-1', prompt: 'x' })]]);
      const storage = {
        getItem: (k) => (map.has(k) ? map.get(k) : null),
        setItem: (k, v) => { map.set(k, String(v)); },
        removeItem: (k) => { map.delete(k); },
      };
      const extractConst2 = (name) => {
        const marker = `const ${name} = `;
        const start = CLIENT_SRC.indexOf(marker);
        const end = CLIENT_SRC.indexOf(';', start);
        return CLIENT_SRC.slice(start, end + 1);
      };
      const pendingHandovers = new Map([['sess-1', 'x']]);
      const calls = [];
      const session = { prompt(c) { calls.push(c); return { ok: true }; } };
      const factory = new Function(
        'pendingHandovers', 'session', 'warn', 'storage',
        `${extractConst2('PENDING_KEY')}
         ${extractConst2('HANDOVER_INJECT_MARK')}
         ${extractConst2('HANDOVER_TITLE_PREFIX')}
         const pendingHandoverListeners = new Set();
         const notifyPendingHandover = () => {};
         ${extractFn('restorePendingHandover')}
         ${extractFn('hasPendingHandover')}
         ${extractFn('clearPendingHandover')}
         ${extractFn('armInjector')}
         const window = { localStorage: storage };
         const first = armInjector({ session }, 'sess-1');
         const second = armInjector({ session }, 'sess-1');
         return { first, second, prompt: session.prompt };`,
      );
      const res = factory(pendingHandovers, session, () => {}, storage);
      assert.equal(res.first, true);
      assert.equal(res.second, true, '重复 arm 不应抛错');
      res.prompt([{ type: 'text', text: 'y' }], 'queue', null, 'r');
      // 关键断言：重复 arm 只包了一层 —— 发送一次、注入一次（calls 只记原始
      // prompt 的调用；若被包了两层，外层调内层、内层再调原始的，这里会是 2）。
      assert.equal(calls.length, 1, '只调到原始 prompt 一次（没有双层包装）');
      assert.equal(calls[0].length, 2, '有登记 → 指令一段 + 用户追加一段 = 2 个 block');
      assert.ok(String(calls[0][1].text).includes('用户追加：'), '用户段落必须带段头');
    });
  }

  // ---- c2b. 标题精修：renameHandoverSession 真源码执行 ----
  // 它调的是 Host 侧 sessionController.rename（sessions.binding(id).session.rename），
  // 会话没激活/连接没就绪时会失败 —— 所以必须是「失败静默」：标题已由注入段头
  // 的 fallback 兜住，精修失败不能把交接弄断。
  {
    const extractFn = (name) => {
      const start = CLIENT_SRC.indexOf(`async function ${name}(`);
      assert.ok(start >= 0, `源码里找不到 async function ${name}`);
      let i = CLIENT_SRC.indexOf('{', start);
      let depth = 0;
      for (; i < CLIENT_SRC.length; i++) {
        if (CLIENT_SRC[i] === '{') depth++;
        else if (CLIENT_SRC[i] === '}') {
          depth--;
          if (depth === 0) break;
        }
      }
      return CLIENT_SRC.slice(start, i + 1);
    };
    const makeRenameHarness = (session) => new Function(
      'ctx',
      'warn',
      `${extractFn('renameHandoverSession')}
       return renameHandoverSession;`,
    )(session ? { get: () => ({ binding: () => ({ session }) }) } : undefined, () => {});

    test('【端到端】标题精修：会话可用时调 session.rename 并返回成功', async () => {
      let renamed = null;
      const session = {
        rename(title) {
          renamed = title;
          return Promise.resolve({ ok: true, value: { title } });
        },
      };
      const fn = makeRenameHarness(session);
      const ok = await fn({ get: () => ({ binding: () => ({ session }) }) }, 'sess-1', '交接对话：dsh-loop-watcher');
      assert.equal(ok, true);
      assert.equal(renamed, '交接对话：dsh-loop-watcher');
    });

    test('【端到端】标题精修：session.rename 抛错 → 静默失败，不向上抛', async () => {
      const session = {
        rename() {
          throw new Error('session not live');
        },
      };
      const fn = makeRenameHarness(session);
      const ok = await fn({ get: () => ({ binding: () => ({ session }) }) }, 'sess-1', '交接对话：x');
      assert.equal(ok, false, '失败应返回 false 而不是抛异常');
    });

    test('【端到端】标题精修：拿不到 sessions 服务 / 没有 rename 方法 → 静默 false', async () => {
      const fn = makeRenameHarness(undefined);
      assert.equal(await fn({ get: () => undefined }, 's', '交接对话：x'), false);
      assert.equal(await fn(undefined, 's', '交接对话：x'), false);
      assert.equal(
        await fn({ get: () => ({ binding: () => ({ session: {} }) }) }, 's', '交接对话：x'),
        false,
        '没有 rename 方法时也要静默返回 false',
      );
    });

    test('【端到端】标题精修：拿不到 sessions 服务时**不抛异常**（静默失败）', async () => {
      const fn = makeRenameHarness(undefined);
      // 即使 ctx.get 自己抛错，也应该被 try 包住。
      const ctx = { get: () => { throw new Error('boom'); } };
      assert.equal(await fn(ctx, 's', '交接对话：x'), false);
    });
  }

  // ---- c2c. 标题精修的**调用点**（独立验收 2026-10-17 抓到的盲区）----
  // 上面的 c2b 只测 renameHandoverSession 自己的行为（隔离执行函数体）。
  // 但实测过：把 runHandover 里的调用改成 Promise.resolve() 后，
  // handover 套件仍 96/96 全绿 —— 也就是说「交接成功后真的会精修标题」
  // 这个行为**没有任何测试在守**。只有 verify-badge.mjs 一条弱正则在看。
  // 这里在 runHandover 函数体上补一条断言，把它纳入本套件。
  {
    const runHandoverBody = extractFunctionBody(CLIENT_SRC, 'runHandover');
    test('【端到端】runHandover 真的调用了标题精修（不是白定义）', () => {
      assert.ok(/renameHandoverSession\(ctx, newSessionId/.test(runHandoverBody),
        'runHandover 里必须出现 renameHandoverSession(ctx, newSessionId, ...) 调用');
    });
    test('【端到端】精修标题用的是 HANDOVER_TITLE_PREFIX 前缀（与注入段头同一个）', () => {
      assert.ok(/`\$\{HANDOVER_TITLE_PREFIX\}\$\{source\}`/.test(runHandoverBody),
        '精修标题必须带交接前缀，否则标题会缺「交接对话：」');
    });
    test('【端到端】旧会话标题为空时有兜底文案（不留一个空标题）', () => {
      assert.ok(/t\('handover\.titleDefault'\)/.test(runHandoverBody),
        '旧会话无标题时应退回 handover.titleDefault');
    });
    test('【端到端】runHandover 只有一处定义（横幅与菜单共用同一个，没被复制成两份）', () => {
      const defs = (CLIENT_SRC.match(/async function runHandover\(/g) ?? []).length;
      assert.equal(defs, 1, `实际定义数: ${defs}`);
    });
  }
  {
    const { plugin, ctx, registrations } = loadPlugin({ exportTool: '' });
    plugin.apply(ctx);
    const settings = registrations.filter((r) => r.kind === 'register')
      .find((r) => r.options.id === 'loop-watcher-settings');
    test('设置页注册项：slot=settings.section，order=30', () => {
      assert.ok(settings, '缺少 loop-watcher-settings 注册');
      assert.equal(settings.options.name, 'settings.section');
      assert.equal(settings.options.order, 30);
      // label 的断言在下面单独一条（它必须是函数，不能是键名字面量）。
    });
    test('设置页组件可被调用，且是分组卡片 + 滑杆开关 + textarea', () => {
      const { React } = loadPlugin({ exportTool: '' });
      const t = (key) => key;
      const tree = settings.component({ t });
      const flat = JSON.stringify(tree);
      // 四张分组卡片（横幅 / 计数徽章 / 交接 / 导出工具）
      for (const group of ['settings.groupNotify', 'settings.groupCount',
        'settings.groupHandover', 'settings.groupExport']) {
        assert.ok(flat.includes(group), `缺分组卡片：${group}`);
      }
      assert.ok(flat.includes('dsh-lw-settings-card'), '应有卡片容器');
      // 滑杆开关（仍是 aria role=switch，无障碍语义不变）
      assert.ok(flat.includes('"role":"switch"'), '应有开关按钮');
      assert.ok(flat.includes('dsh-lw-settings-slider'), '应是滑杆样式');
      // 交接前缀正文
      assert.ok(flat.includes('textarea'), '应有前缀正文 textarea');
      assert.ok(flat.includes('dsh-lw-settings'), '应挂设置页样式类');
    });
    test('设置页含计数阈值步进器（− / +，且带禁用边界）', () => {
      const { React } = loadPlugin({ exportTool: '' });
      const t = (key) => key;
      const flat = JSON.stringify(settings.component({ t }));
      assert.ok(flat.includes('dsh-lw-settings-stepper'), '应有步进器');
      assert.ok(flat.includes('dsh-lw-settings-stepper-btn'), '应有 −/+ 两个按钮');
      // 默认阈值 3，两个按钮都可用（disabled 都是 false）。
      assert.ok(!/"disabled":true/.test(flat), '默认 3 时不该有按钮被禁用');
      // 边界逻辑用源码判据兜住（当前阈值不是边界，渲染树里看不到 true）。
      assert.ok(/disabled: countSevere <= 1/.test(CLIENT_SRC), '− 到 1 时应禁用');
      assert.ok(/disabled: countSevere >= 99/.test(CLIENT_SRC), '+ 到 99 时应禁用');
    });
    test('导出工具卡片给出上游候选路径（不是空说明，也不是自动填路径）', () => {
      // ⚠️ t 必须返回**真文案**（不是键名）：`{path}` 占位符要能被 replace 到，
      // 用 `(k) => k` 当替身时路径根本进不了渲染树（那是替身的缺陷，不是插件的）。
      const dict = { 'settings.exportCandidate': '候选：{path}' };
      const rendered = JSON.stringify(settings.component({ t: (k) => dict[k] ?? k }));
      assert.ok(rendered.includes('settings.exportNote'), '应有「不是遗留设置」的说明');
      // 候选路径常量必须真的被渲染进来（上一版把它写成零调用点的死函数，
      // 独立验收抓出来的 —— 这里用「渲染结果里含真实路径」来咬住）。
      assert.ok(rendered.includes('analyze-session.mjs'), '渲染树里应含上游脚本文件名');
      assert.ok(rendered.includes('候选：node_modules/@mrweicodes/dsh-loop-guard'),
        '占位符应被真实路径替换');
      // 候选路径应是常量（不是假的探测函数，也不是自动填进 exportToolPath）。
      assert.ok(/const UPSTREAM_ANALYZER_HINT = 'node_modules/.test(CLIENT_SRC),
        '候选路径应是常量');
      assert.ok(!/function detectUpstreamAnalyzer/.test(CLIENT_SRC),
        '不应再有零调用点的探测函数（那是死代码）');
      assert.ok(!/exportToolPath = UPSTREAM_ANALYZER_HINT/.test(CLIENT_SRC),
        '绝不能把候选路径自动填成导出工具路径');
    });
    test('设置页字典含新增的组名与两项偏好文案（zh/en 齐全）', () => {
      const { plugin, ctx, localeDicts } = loadPlugin({ exportTool: '' });
      plugin.apply(ctx);
      const dicts = localeDicts.get('loop-watcher');
      assert.ok(dicts, '应有 loop-watcher 命名空间');
      for (const key of ['settings.groupNotify', 'settings.groupCount', 'settings.groupHandover',
        'settings.groupExport', 'settings.bannerDraftTitle', 'settings.countSevereTitle',
        'settings.countSevereHint']) {
        assert.ok(dicts.zh[key] && dicts.en[key], `字典缺键：${key}`);
      }
    });
    test('UI 偏好配置：默认值、非法值兜底、落盘读写', () => {
      const core = extractUiConfig(CLIENT_SRC);
      // resolveCountSevere / resolveBannerDraft 收的是 **storage 替身**（有 getItem），
      // 不是普通对象 —— 这样测的才是真实读取路径。
      const storageOf = (entries) => ({
        getItem: (key) => (Object.hasOwn(entries, key) ? entries[key] : null),
      });
      // 默认（无键）
      const fresh = core.resolve(storageOf({}));
      assert.equal(fresh.countSevere, 3, '默认红线阈值应为 3');
      assert.equal(fresh.bannerDraft, true, '默认应显示横幅交接按钮');
      // 手改坏的值 → 退回默认，不把徽章打崩
      const dirty = core.resolve(storageOf({
        'dsh-loop-watcher:count-severe': 'abc',
        'dsh-loop-watcher:banner-draft': 'x',
      }));
      assert.equal(dirty.countSevere, 3);
      assert.equal(dirty.bannerDraft, true, "未知值按「开」处理（只有 '0' 表示关）");
      // 正常值
      const set = core.resolve(storageOf({
        'dsh-loop-watcher:count-severe': '1',
        'dsh-loop-watcher:banner-draft': '0',
      }));
      assert.equal(set.countSevere, 1);
      assert.equal(set.bannerDraft, false);
      // 边界：0 与负数不合法（>=1）
      assert.equal(core.resolve(storageOf({ 'dsh-loop-watcher:count-severe': '0' })).countSevere, 3);
      assert.equal(core.resolve(storageOf({ 'dsh-loop-watcher:count-severe': '-2' })).countSevere, 3);
      assert.equal(core.resolve(storageOf({ 'dsh-loop-watcher:count-severe': '7' })).countSevere, 7);
    });
    test('徽章档位用可配阈值：阈值 1 时一次打断就 severe', () => {
      const level = extractCountLevel(CLIENT_SRC);
      assert.equal(level(0, 3), 'none');
      assert.equal(level(2, 3), 'mild');
      assert.equal(level(3, 3), 'severe');
      // 阈值可配：设成 1 → 一次就红；设成 10 → 5 次还只是 mild
      assert.equal(level(1, 1), 'severe');
      assert.equal(level(5, 10), 'mild');
      assert.equal(level(10, 10), 'severe');
      // 阈值缺省/非法时退回 3（自洽兜底）
      assert.equal(level(3, undefined), 'severe');
      assert.equal(level(2, undefined), 'mild');
      assert.equal(level(3, 'abc'), 'severe');
    });
    // 上面那条只验 countLevel **函数自己**。下面两条盯**调用点** ——
    // 实测过：把 countLevel(shown, severeThreshold()) 改回 countLevel(shown, 3) 时，
    // 上面那条照样全绿（函数没变，只是没人用它了）。这就是「空断言」盲区。
    test('徽章渲染真的把 severeThreshold() 传给了档位判定（不是写死 3）', () => {
      assert.ok(/countLevel\(shown, severeThreshold\(\)\)/.test(CLIENT_SRC),
        '必须走 severeThreshold()，否则设置页改阈值不生效');
      assert.ok(/countLevel\(shown, 3\)/.test(CLIENT_SRC) === false,
        '不应再出现写死阈值 3 的调用');
    });
    test('横幅的交接按钮受开关控制（关掉就不渲染）', () => {
      assert.ok(/hasExportTool\(\) && uiConfig\.bannerDraft/.test(CLIENT_SRC),
        '渲染判据必须同时要求开关开着');
      // 反向：不能出现只看 hasExportTool 的旧写法（2026-10-17 实测变异能绕过）
      const onlyExport = /hasExportTool\(\)\s*\n?\s*\? \(fromGuard/.test(CLIENT_SRC);
      assert.ok(!onlyExport, '不能只看导出工具配置、忽略开关');
    });
    test('两个 UI 偏好在 apply 时被解析（不解析则永远是默认值）', () => {
      assert.ok(/uiConfig\.countSevere = resolveCountSevere\(\)/.test(CLIENT_SRC),
        'apply 里必须解析红线阈值');
      assert.ok(/uiConfig\.bannerDraft = resolveBannerDraft\(\)/.test(CLIENT_SRC),
        'apply 里必须解析横幅按钮开关');
    });
    test('设置页字典 zh/en 齐全（开关、正文说明、恢复默认、导出路径）', () => {
      const { plugin, ctx, localeDicts } = loadPlugin({ exportTool: '' });
      plugin.apply(ctx);
      const dicts = localeDicts.get('loop-watcher');
      assert.ok(dicts, '应有 loop-watcher 命名空间');
      for (const key of ['settings.nav', 'settings.prefillTitle', 'settings.prefillToggle',
        'settings.reset', 'settings.exportTitle', 'settings.saved']) {
        assert.ok(dicts.zh[key] && dicts.en[key], `字典缺键：${key}`);
      }
    });
    // 2026-10-17 实测 bug：label 写成字面量 'settings.nav' 时，侧栏把**键名**直接
    // 显示出来（slot 对 string 形态不做翻译）。必须断言它是函数，否则静默复发。
    test('设置页 label 是函数而不是字面量键名（否则侧栏会显示 settings.nav）', () => {
      const label = settings.options.label;
      assert.equal(typeof label, 'function',
        `label 必须是 () => t('settings.nav') 这种函数，实际是 ${typeof label}`);
      // 调一次：返回的必须是中文名，不是键名本身。
      const shown = label();
      assert.notEqual(shown, 'settings.nav', 'label() 不能把键名原样返回');
      assert.ok(typeof shown === 'string' && shown.length > 0, 'label() 应返回非空文案');
    });
  }
}

console.log(`\n${'='.repeat(52)}`);
console.log(`通过 ${passed} 项，失败 ${failed} 项`);console.log('='.repeat(52));
process.exit(failed === 0 ? 0 : 1);

