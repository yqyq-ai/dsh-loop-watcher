/**
 * dsh-loop-watcher Client half —— 打转的**通知器 + 计数器 + 交接器**。
 *
 * 本文件是**两个插件合并**的产物（2026-10-16）：
 *   - dsh-loop-guard       → 横幅通知、会话头「已打断 N 次」计数徽章
 *   - dsh-session-handover → 会话「...」菜单里的一键交接
 * 合并理由：两者本来就是同一条工作流的两半 —— **打转之后，紧接着就是交接**。
 *
 * ## 检测与切断**不在**这里
 *
 * 检测与切断交给上游守卫 `@mrweicodes/dsh-loop-guard`：它挂在 host 侧 `llm/stream` 上，
 * 能从流内部切断，比在回合层面判定更准、也更早。上游每切断一次就注入一条
 * `source.kind === 'loop-guard'` 的消息，本插件只**读**那条消息，不碰它代码、不抢判定。
 *
 * ⚠️ **不装上游 = 横幅与计数永远不出现**（没有数据来源）。本插件是补位性质的。
 * 自带检测（`OWN_DETECTION`）默认关闭；单独使用时可以打开，见常量区。
 *
 * ## 导出工具路径与交接前缀（开源相关）
 *
 * 交接功能需要「旧会话导出工具」，该路径**不写死在代码里**：默认空。
 * 未配置时交接照常可用（指令不含导出命令），只是新会话要自己想办法找上文。
 * 「交接前缀提示词」的开关与正文也都可以在**设置页**（侧边栏 → 设置 → 打转守望）
 * 里改，或按 `EXPORT_TOOL_DEFAULT` / `PREFILL_TEXT_DEFAULT` 上方注释改常量。
 *
 * ## 数据来源（均已核对运行时契约）
 *   - 推理文本：`useChat` 快照 → `nodes`（节点 store）里 `kind === 'assistant-step'`
 *     的节点，其 `data.blocks` 中 `kind === 'reasoning'` 的 `text`。
 *   - 中止：Client 服务 `sessions` → `binding(id).session.cancel()`。
 *   - 预填：slot 注入的 `inputActions.setDraft()`。
 *   - 新建会话：Client 服务 `uiWorkspace` → `connectWorkspace()` / `openSession()`。
 */

window.__ModuleLoader__.load({
  id: 'dsh-loop-watcher',
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const React = require('react');
    const h = React.createElement;

    const NS = 'loop-watcher';
    const STYLE_ID = 'dsh-loop-watcher-style';
    const MODE_STORAGE_KEY = 'dsh-loop-guard:mode';
    const SELF_TEST_KEY = 'dsh-loop-guard:self-test';
    const LOG_STORAGE_KEY = 'dsh-loop-guard:log';
    /**
     * 本插件**自己**的检测：默认关闭。
     *
     * 上游守卫 `@mrweicodes/dsh-loop-guard` 挂在 host 侧 `llm/stream` 上，能从流内部
     * 切断，比我们准、也比我们早；两边各判一次只会让行为不可预测。
     * 所以默认分工是：**它负责检测与切断，本插件负责通知与交接**。
     * 单独使用本插件（不装上游）时，把这里改成 true 即可恢复自带检测。
     */
    const OWN_DETECTION = false;
    /** 扫上游通知的间隔（毫秒）。 */
    const NOTICE_POLL_MS = 700;
    /**
     * 「本对话已打断 N 次」徽章挂在哪个插槽、排在第几位 —— **想挪位置只改这两个常量**。
     *
     * 2026-10-16 一共挪过两次，把这一行的真实结构记在这里，免得下次又要重读 DSH 布局源码：
     *
     *   titleRow（一行 flex）
     *     ├─ titleCluster（flex:1，吃掉剩余宽度）
     *     │    ├─ crumbs         ← 会话标题
     *     │    └─ headerActions  ← 子智能体(-30)、模式选择器(-10)、后台任务(20)
     *     │                         ← **徽章挂这里，order 100 = 紧跟后台任务右边**
     *     ├─ headerUtilities     ← 整组在这一组右边：open-in-app 文件夹(-10)、下载会话日志(0)
     *     └─ headerCorner        ← 最右角（single 插槽，被自带折叠按钮占用，挂进去会顶掉它）
     *
     * 位置取舍（目标：紧贴「后台任务」那一组动态条目的末尾）：
     *   ① order -5 留在 headerActions：落在「模式选择器」和「后台任务」**中间**，偏左了；
     *   ② 改挂 headerUtilities + order 100：越过文件夹/更多按钮跑到**整行最右**，偏右了
     *      （越过文件夹/更多按钮，跑到整行最右，偏右了）；
     *   ③ **现在**：回到 headerActions + order 100 > 后台任务的 20 → 紧贴「后台任务」右边，
     *      也就是那一组动态条目的末尾。后台任务有没有在跑，它都跟在这一组最后。
     */
    const COUNT_SLOT = 'conversation.session.header.actions';
    const COUNT_ORDER = 100;
    /** 采样间隔（毫秒）。 */
    const SAMPLE_INTERVAL_MS = 1000;
    /** 连续多少次采样都命中才动作（方案的「连续确认」，防瞬时抖动）。 */
    const CONFIRM_SAMPLES = 2;

    // ==================== 交接功能的常量（合并自 dsh-session-handover） ====================
    //
    // ⚠️ 这几个常量的值**刻意与原插件完全一致**：合并后的行为要与使用者现在用的一模一样（零回退）。

    /** 会话「...」菜单里那一行所在插槽。 */
    const MENU_SLOT = 'sidebar.workspaces.session.menu.item';
    /** 保持原 id：菜单项与回归用例都认它。 */
    const MENU_ID = 'dsh-session-handover.handover';
    /** 排在「归档会话」（400）之后，自成一组。 */
    const MENU_ORDER = 500;

    /**
     * 隐形 helper 的挂载点。**会话作用域**，且 standardProps 里有
     * `inputActions`（真正的活写入口）—— 选它就是为了这个。
     */
    const DOCK_SLOT = 'conversation.input.dock';
    const DOCK_ID = 'dsh-session-handover.prefill';
    /** 排在别人后面，渲染为空，不需要争位置。 */
    const DOCK_ORDER = 900;

    /**
     * 设置页（2026-10-17 新增）：注册一个 `settings.section` 就是一个独立设置页，
     * 从侧边栏「设置」的左列进入。交接前缀的开关、前缀正文、导出工具路径都在这里改。
     */
    const SETTINGS_SLOT = 'settings.section';
    const SETTINGS_ID = 'loop-watcher-settings';
    const SETTINGS_ORDER = 30;

    // ==================== 交接会话的标题前缀 ====================
    /**
     * 交接出来的新会话，标题默认会变成「【交接模式】你现在接手的是」这种难看的东西
     * —— 因为 DSH 的标题 fallback 是**取第一条人类消息的开头几个词**，
     * 而隐藏指令恰好被拼在内容最前面。
     *
     * 解法（2026-10-17，实测源码后定）：
     *   1. 注入时在**指令最前面**加一个标记段 `HANDOVER_TITLE_PREFIX`；
     *      标题 fallback 取开头词 → 标题自然变成「交接对话：<你写的内容>」。
     *      这条路径完全不需要任何宿主 API，**零失败风险**。
     *   2. 交接成功后**再**调 `session.rename()` 精修一次：把标题改成
     *      「<旧会话标题>(2)」式，或「交接对话：<旧会话标题>」式。
     *      而且 `rename` 会写入 `source.kind: 'user'`，DSH 随即**停止自动生成标题**，
     *      所以 fallback 那个略丑的标题**不会被后续覆盖**，重命名失败也不影响它。
     *
     * 所以：fallback 是**主路径**（零风险），rename 只是精修（失败有 fallback 顶着）。
     */
    const HANDOVER_TITLE_PREFIX = '交接对话：';

    const zh = {
      'banner.title': '当前思考可能正在打转',
      'banner.detail': '最高频短句「{line}」出现 {count} 次，占 {ratio}%（推理共 {chars} 字 / {lines} 行）',
      'banner.detailRun': '出现连续重复 {run} 行（推理共 {chars} 字 / {lines} 行）',
      'banner.advice': '建议：停止 → 开新会话 → 让新会话读旧会话记录写交接文档。',
      'action.stopAndDraft': '停止并生成交接指令',
      'action.stopOnly': '只停止',
      'action.ignore': '忽略本轮',
      'mode.label': '自动中断',
      'mode.on': '开',
      'mode.off': '关',
      'notice.stoppedAndDrafted': '已中断，交接指令已预填。开新会话后粘贴发送即可。',
      'notice.stopped': '已中断当前回合。',
      'notice.stopFailed': '没能取到会话连接，请手动点界面的「停止」。',
      'notice.drafted': '交接指令已预填，请手动停止当前回合。',
      'notice.ignored': '已忽略本轮提醒。',
      'notice.modeOff': '自动中断已关闭：只提醒，不动手。',
      'notice.modeOn': '自动中断已开启：下次确认打转会自动停止并预填指令。',
      'notice.selfTest': '自检模式：这是演示横幅，点按钮仍会真的停止当前回合。',
      'notice.selfTestGuard': '自检模式（守卫链路）：这是演练横幅，按钮都是真的，但「定位」在演示里找不到目标。',
      'guard.title': '检测到一次思考循环，已被上游守卫打断',
      'guard.noSummary': '（上游没给摘要，可在会话历史的轨迹视图里找到那条「上下文」消息）',
      'guard.advice': '被截断的那段推理没有进入历史，任务通常可以继续。若上下文已经很脏，可以停止并换新会话。',
      'action.draft': '生成交接指令',
      'action.locate': '定位到循环处',
      'action.dismiss': '关闭提醒',
      'action.close': '关闭（只有点它会消失）',
      'notice.draftedOnly': '已新建会话并把交接指令备好，在输入框里写你要交接的内容即可。',
      'notice.draftFailed': '没能开始交接（找不到这个会话所在的工作区）。',
      'notice.located': '已定位到那条循环打断处（闪一下的就是它）。',
      'notice.locateFailed': '没找到对应的聊天区行 —— 它可能在更早的历史里，先向上滚动加载，再点一次。',
      'count.label': '本对话已打断 {n} 次',
      'count.labelHealthy': '本对话未被打断',
      'count.title': '这个会话没有被打断过，状态正常。',
      'count.titleWarn': '这个会话被上游守卫打断过 {n} 次。点一下可以定位到最近一次打断的地方。',
      'count.titleSevere': '这个会话被打断过 {n} 次，上下文可能已经比较脏了 —— 建议考虑换一个新会话接着做。点一下可以定位到最近一次打断的地方。',
      'count.located': '已定位到最近一次打断处（闪一下的就是它）。',
      'count.locateFailed': '没找到对应的聊天区行 —— 它可能在更早的历史里，先向上滚动加载，再点一次。',
      'count.noTarget': '这个会话还没有被打断过，没有可定位的地方。',
      'count.selfTest': '（演练）这条计数是演示值，没有写进记录；真实次数会随守卫每次切断自己长上去。',
      'handover.label': '交接对话',
      'handover.busy': '正在准备交接…',
      'handover.noWorkspace': '找不到这个会话所在的工作区，无法交接。',
      'handover.connectFailed': '新建会话失败',
      'handover.exportFailed': '交接指令没能预填进输入框，已改为直接发送。',
      'handover.prefilled': '已新建会话：输入框上方有蓝色标记，你直接输入要交接给它的内容，发送时会自动带上交接指令。',
      'handover.badge': '已经进入交接对话',
      'handover.badgeHint': '交接指令已就绪（不占输入框）——你输入的内容会以「用户追加」单独一段发出去',
      'handover.titleDefault': '交接对话：手上任务',
      'handover.renamed': '新会话标题已改为「{title}」。',
      'settings.groupNotify': '横幅提醒',
      'settings.groupCount': '计数徽章',
      'settings.groupHandover': '交接对话',
      'settings.groupExport': '旧会话导出工具',
      'settings.bannerDraftTitle': '横幅上显示「生成交接指令」',
      'settings.bannerDraftDesc': '关掉后，横幅只保留「停止 / 关闭提醒」，交接改用会话「...」菜单里的「交接对话」一行。',
      'settings.countSevereTitle': '变红的打断次数',
      'settings.countSevereDesc': '会话被打断几次就把徽章标成红色（建议考虑换新会话）。1 = 一被打断就红，默认 3。',
      'settings.countSevereHint': '当前：{n} 次',
      'settings.exportNote': '这一项不是遗留设置：本插件不自带导出工具。若你装了上游守卫，它的包里有一个会话分析脚本（node_modules/@mrweicodes/dsh-loop-guard/tools/analyze-session.mjs），可以直接当导出工具用；也可以填任何「吃一个会话短 ID、吐出可读文本」的脚本。',
      'settings.exportCandidate': '上游守卫里的候选脚本：{path}',
      'settings.nav': '打转守望',
      'settings.title': '打转守望（loop-watcher）',
      'settings.desc': '把上游守卫的静默打转切断变成横幅提醒与计数徽章，并提供一键交接。',
      'settings.prefillTitle': '「交接对话」前缀提示词',
      'settings.prefillDesc': '开启后，一键交接预填的指令前会加上这段前缀（新会话据此进入接手状态，而不是一句一句重新解释背景）。改完自动保存，立即生效。',
      'settings.prefillToggle': '启用前缀提示词',
      'settings.prefillPlaceholder': '留空则不注入任何前缀。',
      'settings.saved': '已保存。',
      'settings.reset': '恢复默认',
      'settings.exportTitle': '旧会话导出工具路径（可选）',
      'settings.exportDesc': '配置后，交接指令会带上一条「导出旧会话」的命令；留空则指令不含导出命令，交接仍可用。',
      'settings.exportPlaceholder': '例如 D:\\工具\\导出会话.cmd',
    };

    const en = {
      'banner.title': 'The current reasoning may be looping',
      'banner.detail': 'Most frequent short line "{line}" appeared {count} times — {ratio}% of {lines} lines ({chars} chars)',
      'banner.detailRun': '{run} identical lines in a row — {lines} lines ({chars} chars) total',
      'banner.advice': 'Suggested: stop → open a clean session → have it read the old session log and write the handover.',
      'action.stopAndDraft': 'Stop and draft handover',
      'action.stopOnly': 'Stop only',
      'action.ignore': 'Ignore this turn',
      'mode.label': 'Auto-stop',
      'mode.on': 'on',
      'mode.off': 'off',
      'notice.stoppedAndDrafted': 'Stopped. The handover prompt is in the composer — open a new session and send it.',
      'notice.stopped': 'Stopped the current turn.',
      'notice.stopFailed': 'No live session binding — use the UI Stop button instead.',
      'notice.drafted': 'Handover prompt is in the composer; stop the turn manually.',
      'notice.ignored': 'Ignoring this turn.',
      'notice.modeOff': 'Auto-stop is off: warn only.',
      'notice.modeOn': 'Auto-stop is on: the next confirmed loop stops the turn and drafts the prompt.',
      'notice.selfTest': 'Self-test: this is a demo banner; its buttons still stop the current turn for real.',
      'notice.selfTestGuard': 'Self-test (guard path): a drill banner with real buttons, but Locate has no target in a drill.',
      'guard.title': 'A reasoning loop was detected and cut by the upstream guard',
      'guard.noSummary': '(the upstream guard gave no summary; look for the context row in the session trajectory)',
      'guard.advice': 'The cut reasoning never entered history, so the task usually carries on. Stop and hand over only if the context is too dirty.',
      'action.draft': 'Draft handover',
      'action.locate': 'Locate the loop',
      'action.dismiss': 'Dismiss',
      'action.close': 'Close (this is the only way it disappears)',
      'notice.draftedOnly': 'A new Session is armed with the handover instruction - type what to hand over in the composer.',
      'notice.draftFailed': 'Could not start the handover (the Workspace of this Session was not found).',
      'notice.located': 'Jumped to the loop break (the flashing row is it).',
      'notice.locateFailed': 'No matching transcript row - it may sit in older history; scroll up to load, then try again.',
      'count.label': '{n} interruptions in this chat',
      'count.labelHealthy': 'No interruptions yet',
      'count.title': 'This session has not been interrupted; it looks healthy.',
      'count.titleWarn': 'The upstream guard cut this session {n} time(s). Click to jump to the most recent break.',
      'count.titleSevere': 'This session was cut {n} times - the context may be dirty; consider a fresh session. Click to jump to the most recent break.',
      'count.located': 'Jumped to the most recent break (the flashing row is it).',
      'count.locateFailed': 'No matching transcript row - it may sit in older history; scroll up to load, then try again.',
      'count.noTarget': 'This session has not been interrupted yet, so there is nothing to locate.',
      'count.selfTest': '(drill) This number is a demo and was not recorded; the real count grows by itself on every guard cut.',
      'handover.label': 'Hand over',
      'handover.busy': 'Preparing handover…',
      'handover.noWorkspace': 'Could not find the Workspace this Session belongs to, so the handover was not started.',
      'handover.connectFailed': 'Could not start a new Session',
      'handover.exportFailed': 'The instruction could not be prefilled, so it was sent directly instead.',
      'handover.prefilled': 'New Session armed: the handover instruction rides along with your first message — just type what to hand over.',
      'handover.badge': 'Handover armed',
      'handover.badgeHint': 'The handover instruction is hidden here (not in the composer) — what you type is sent as a separate "用户追加" section',
      'handover.titleDefault': 'Handover: current task',
      'handover.renamed': 'New Session title is now "{title}".',
      'settings.groupNotify': 'Banner',
      'settings.groupCount': 'Counter badge',
      'settings.groupHandover': 'Handover',
      'settings.groupExport': 'Old-session export tool',
      'settings.bannerDraftTitle': 'Show "Draft handover" on the banner',
      'settings.bannerDraftDesc': 'When off, the banner keeps only "Stop" and "Dismiss"; use the "Hand over" row in the Session "..." menu instead.',
      'settings.countSevereTitle': 'Turns red at',
      'settings.countSevereDesc': 'How many interruptions before the badge turns red (suggesting a fresh session). 1 = red on the first cut; default 3.',
      'settings.countSevereHint': 'Currently: {n}',
      'settings.exportNote': 'Not a leftover: this plugin ships no export tool. If you installed the upstream guard, its package contains a session analyzer (node_modules/@mrweicodes/dsh-loop-guard/tools/analyze-session.mjs) that works here; any script taking a session short ID and emitting readable text also works.',
      'settings.exportCandidate': 'Candidate script inside the upstream guard: {path}',
      'settings.nav': 'Loop Watcher',
      'settings.title': 'Loop Watcher',
      'settings.desc': 'Turns the upstream guard\u0027s silent loop cuts into a banner and a counter badge, and offers one-click handover.',
      'settings.prefillTitle': 'Handover prefix prompt',
      'settings.prefillDesc': 'When enabled, the prefilled takeover instruction starts with this prefix. Saved automatically, effective immediately.',
      'settings.prefillToggle': 'Enable prefix prompt',
      'settings.prefillPlaceholder': 'Leave empty to inject no prefix.',
      'settings.saved': 'Saved.',
      'settings.reset': 'Reset to default',
      'settings.exportTitle': 'Old-session export tool path (optional)',
      'settings.exportDesc': 'When set, the handover instruction includes the export command; when empty the instruction still works without it.',
      'settings.exportPlaceholder': 'e.g. D:\\tools\\export-session.cmd',
    };

    const STYLE = `
.dsh-loop-guard-root {
  background: var(--dsw-alias-bg-layer-1, rgba(127,127,127,.08));
  border: 1px solid var(--dsw-alias-state-warn-primary, rgba(214,158,46,.55));
  border-radius: var(--dsw-radius-lg, 10px);
  box-sizing: border-box;
  color: var(--dsw-alias-label-primary, inherit);
  display: flex;
  flex-direction: column;
  font-size: 13px;
  gap: 8px;
  margin: 0 0 8px;
  padding: 10px 34px 10px 12px;
  position: relative;
  width: 100%;
}
/* 横幅唯一的关闭入口：不点它，换会话、刷新页面都还在。 */
.dsh-loop-guard-close {
  align-items: center;
  background: transparent;
  border: 0;
  border-radius: 6px;
  color: var(--dsw-alias-label-secondary, inherit);
  cursor: pointer;
  display: flex;
  font: inherit;
  font-size: 16px;
  height: 22px;
  justify-content: center;
  line-height: 1;
  padding: 0;
  position: absolute;
  right: 8px;
  top: 8px;
  width: 22px;
}
.dsh-loop-guard-close:hover {
  background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,.16));
  color: var(--dsw-alias-label-primary, inherit);
}
.dsh-loop-guard-close:focus-visible {
  outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-brand-primary, #4f8cff));
  outline-offset: 1px;
}
/* 「定位」后闪一下目标，让人一眼看到滚到了哪一条。 */
.dsh-loop-guard-located {
  animation: dsh-loop-guard-flash 2.4s ease-out 1;
}
@keyframes dsh-loop-guard-flash {
  0%, 55% {
    box-shadow: inset 0 0 0 2px var(--dsw-alias-state-warn-primary, #d69e2e);
  }
  100% {
    box-shadow: inset 0 0 0 2px rgba(0, 0, 0, 0);
  }
}
.dsh-loop-guard-row {
  align-items: flex-start;
  display: flex;
  gap: 10px;
  min-width: 0;
}
.dsh-loop-guard-icon {
  color: var(--dsw-alias-state-warn-primary, #d69e2e);
  flex: none;
  font-size: 15px;
  line-height: 20px;
}
.dsh-loop-guard-text {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.dsh-loop-guard-title {
  color: var(--dsw-alias-label-primary, inherit);
  font-weight: 500;
  line-height: 20px;
}
.dsh-loop-guard-detail {
  color: var(--dsw-alias-label-secondary, inherit);
  font-size: 12px;
  line-height: 18px;
  overflow-wrap: anywhere;
}
.dsh-loop-guard-advice {
  color: var(--dsw-alias-label-secondary, inherit);
  font-size: 12px;
  line-height: 18px;
}
.dsh-loop-guard-actions {
  align-items: center;
  display: flex;
  flex: none;
  flex-wrap: wrap;
  gap: 6px;
  justify-content: flex-end;
}
.dsh-loop-guard-button {
  background: transparent;
  border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.4));
  border-radius: 999px;
  color: var(--dsw-alias-label-primary, inherit);
  cursor: pointer;
  font: inherit;
  font-size: 12px;
  line-height: 18px;
  padding: 3px 12px;
  white-space: nowrap;
}
.dsh-loop-guard-button:hover {
  background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,.14));
}
.dsh-loop-guard-button:focus-visible {
  outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-brand-primary, #4f8cff));
  outline-offset: 1px;
}
.dsh-loop-guard-button[data-primary] {
  border-color: var(--dsw-alias-state-warn-primary, rgba(214,158,46,.7));
  color: var(--dsw-alias-state-warn-primary, inherit);
}
.dsh-loop-guard-mode {
  align-items: center;
  color: var(--dsw-alias-label-secondary, inherit);
  display: inline-flex;
  font-size: 12px;
  gap: 5px;
  white-space: nowrap;
}
.dsh-loop-guard-switch {
  background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,.2));
  border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.4));
  border-radius: 999px;
  cursor: pointer;
  font: inherit;
  font-size: 12px;
  line-height: 16px;
  padding: 1px 8px;
}
.dsh-loop-guard-switch[aria-checked="true"] {
  border-color: var(--dsw-alias-brand-primary, #4f8cff);
  color: var(--dsw-alias-brand-primary, #4f8cff);
}
.dsh-loop-guard-notice {
  border-top: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.25));
  color: var(--dsw-alias-label-secondary, inherit);
  font-size: 12px;
  line-height: 18px;
  padding-top: 6px;
}
/* 会话头右侧的「本对话已打断 N 次」徽章（2026-10-16 新增）。
   按次数分三档着色，让「这个对话现在还健不健康」一眼可判。 */
.dsh-loop-guard-badge {
  align-items: center;
  background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,.12));
  border: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.3));
  border-radius: 999px;
  color: var(--dsw-alias-label-secondary, inherit);
  cursor: pointer;
  display: inline-flex;
  flex: none;
  font: inherit;
  font-size: 12px;
  gap: 5px;
  line-height: 16px;
  padding: 2px 9px;
  white-space: nowrap;
}
.dsh-loop-guard-badge:hover {
  background: var(--dsw-alias-bg-layer-1, rgba(127,127,127,.2));
}
.dsh-loop-guard-badge:focus-visible {
  outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-brand-primary, #4f8cff));
  outline-offset: 1px;
}
.dsh-loop-guard-badge[data-level="mild"] {
  border-color: var(--dsw-alias-state-warn-primary, rgba(214,158,46,.5));
  color: var(--dsw-alias-state-warn-primary, inherit);
}
/* 0 次：中性「健康」态。刻意做得比 warn/error 更淡，让异常次数自己跳出来。 */
.dsh-loop-guard-badge[data-level="none"] {
  border-color: var(--dsw-alias-border-l1, rgba(127,127,127,.3));
  color: var(--dsw-alias-label-secondary, inherit);
}
.dsh-loop-guard-badge[data-level="none"] .dsh-loop-guard-badge-dot {
  background: var(--dsw-alias-state-success-primary, #48bb78);
  opacity: .9;
}
.dsh-loop-guard-badge[data-level="severe"] {
  border-color: var(--dsw-alias-state-error-primary, rgba(229,62,62,.6));
  color: var(--dsw-alias-state-error-primary, inherit);
}
/* 演练模式下用虚线边框区别于真实计数，免得被误当成真打断过。 */
.dsh-loop-guard-badge[data-self-test="true"] {
  border-style: dashed;
}
.dsh-loop-guard-badge-dot {
  background: currentColor;
  border-radius: 50%;
  flex: none;
  height: 6px;
  opacity: .85;
  width: 6px;
}
/* 数字单独给一点字重，扫一眼就能读到次数。 */
.dsh-loop-guard-badge-count {
  font-variant-numeric: tabular-nums;
  font-weight: 600;
}
/* 徽章外层的包裹：徽章本身是 inline-flex，反馈提示浮在它下方。 */
.dsh-loop-guard-badge-wrap {
  align-items: center;
  display: inline-flex;
  flex: none;
  position: relative;
}
/*
 * 点击后的反馈提示。
 *
 * ⚠️ 必须 position:absolute —— 不能占布局流。
 * 它所在的 headerUtilities 是 flex:none（不收缩），而标题所在的 titleCluster 是
 * flex:1（会收缩）。提示文案有二十多个字，若按普通流内联，就会出现「点一下徽章、
 * 会话标题被挤窄 3 秒」的抖动。绝对定位让它浮在徽章下方，宽度由 max-width 定死，
 * 对整行布局零影响。
 *
 * 另一个坑：本段在 JS 的模板字符串里，注释中**不能出现反引号**（会提前结束模板串，
 * 报 SyntaxError: Unexpected identifier）—— 2026-10-16 实际踩到并被 node --check 拦下。
 */
.dsh-loop-guard-badge-notice {
  background: var(--dsw-alias-bg-overlay, var(--dsw-alias-bg-layer-2, rgba(40,40,40,.96)));
  border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.4));
  border-radius: var(--dsw-radius-md, 8px);
  box-sizing: border-box;
  color: var(--dsw-alias-label-primary, inherit);
  font-size: 12px;
  line-height: 16px;
  max-width: 260px;
  padding: 6px 9px;
  position: absolute;
  right: 0;
  top: calc(100% + 6px);
  white-space: normal;
  width: max-content;
  z-index: 30;
}`;

    // #region loop-guard-env
    /**
     * 旧会话导出工具的路径 —— **默认留空；留空则交接相关 UI 自动隐藏**。
     *
     * 为什么这样做：
     *   早期的版本把一条固定路径写死在代码里。
     *   那只对写代码的那台机器可用，对**其他任何人**都是指向不存在路径的死命令：
     *   点一下按钮只会得到一条跑不通的命令，还会让人以为插件坏了。
     *   所以这里把「路径」与「代码」彻底分开。
     *
     * 配置方式（**优先读 localStorage**，这样插件升级不会把你的设置冲掉）：
     *
     *   1) 页面控制台执行一次（推荐，改完刷新页面生效）：
     *        localStorage.setItem('dsh-loop-watcher:export-tool', 'D:\\你的目录\\导出会话.cmd')
     *
     *   2) 或直接改下面这个常量。
     *
     * 留空时：横幅上的「生成交接指令」与菜单里的「交接对话」**都不出现**，
     * 但**横幅通知与计数徽章照常工作** —— 那两项不依赖导出工具。
     */
    const EXPORT_TOOL_DEFAULT = '';
    const EXPORT_TOOL_STORAGE_KEY = 'dsh-loop-watcher:export-tool';

    /** 当前生效的导出工具路径；apply() 时解析一次。空串 = 未配置。 */
    let exportToolPath = EXPORT_TOOL_DEFAULT;

    /** 解析导出工具路径：localStorage 优先，其次常量。异常一律退回常量。 */
    function resolveExportTool() {
      try {
        const value = window.localStorage.getItem(EXPORT_TOOL_STORAGE_KEY);
        if (typeof value === 'string' && value.trim() !== '') return value.trim();
      } catch {
        // 隐私模式等情况下读不到 localStorage，退回常量。
      }
      return EXPORT_TOOL_DEFAULT;
    }

    /** 是否配好了导出工具 —— 交接相关 UI 全靠它决定显不显示。 */
    function hasExportTool() {
      return exportToolPath.trim() !== '';
    }

    /**
     * 上游守卫自带的会话分析脚本**候选路径**（纯常量，不是探测函数）。
     *
     * 「导出工具路径」看着像遗留物，但它不是：
     * 它仍然有用，只是多数 Windows 用户不再需要手工配 —— 上游
     * `@mrweicodes/dsh-loop-guard` 包里有一个 `tools/analyze-session.mjs`，
     * 能直接把 DSH 会话文件（`.jsonl` / `.v4.jsonl.zstd`）转成可读文本。
     *
     * ⚠️ **它不是我们所讲的「导出工具」**：输出是打转分析报告而非完整交接素材，
     * 所以只作为**建议值**在设置页里提示（见 SettingsSection 里的候选路径行），
     * **绝不自动填进路径** —— 填错了会让新会话拿到跑不通的命令。
     *
     * 之所以是常量而不是函数：浏览器半无法 stat 文件系统，写个假探测函数
     * 只会给出不可靠结论（上一版就犯过这个错，被独立验收抓出来是死代码）。
     */
    const UPSTREAM_ANALYZER_HINT = 'node_modules/@mrweicodes/dsh-loop-guard/tools/analyze-session.mjs';

    /**
     * 设置导出工具路径。**唯一的写入点**（apply 时调一次），也供回归测试注入。
     *
     * 之所以单独开一个函数而不是直接赋值：回归测试要把 `exportToolPath` 设成
     * 一个样本路径，才能验「接手指令里确实带上了配置的路径」。
     */
    function setExportToolPath(value) {
      exportToolPath = typeof value === 'string' ? value : EXPORT_TOOL_DEFAULT;
      return exportToolPath;
    }

    function warn(message, error) {
      try {
        console.warn(`[loop-watcher] ${message}`, error);
      } catch {
        // 日志失败不影响功能。
      }
    }
    // #endregion loop-guard-env

    // #region handover-prefill（2026-10-17 新增：前缀提示词的开关与正文）
    /**
     * 「交接对话」的**前缀提示词**。
     *
     * 设计动机（使用者原话）：前缀要**注入到指令最前面**，但**不能占输入框** ——
     * 预填的接手指令已经很长，若再把前缀直接拼进去让使用者改，输入框就没地方写自己的话了。
     * 所以前缀是「插件在组装指令时自动加上的」，使用者在**设置页**改它，而不是在对话框里。
     *
     * 存储与导出工具路径同一套策略：localStorage 优先（升级不丢设置），常量兜底；
     * 开关独立成一个键（关了就不注入，前缀正文保留）。
     */
    const PREFILL_TEXT_DEFAULT = [
      '【交接模式】你现在接手的是上一个会话没做完的任务。',
      '要求：',
      '1. 先把下面指令里的素材读完，搞清楚任务目标与已完成的部分，再动手；',
      '2. 直接接着做，不要重新开始，不要写"交接文档"这类中间产物；',
      '3. 边做边简短汇报每一步在做什么、结果如何；',
      '4. 确实卡住、或需要我拿主意时才问我。',
    ].join('\n');
    const PREFILL_ENABLED_KEY = 'dsh-loop-watcher:prefill-enabled';
    const PREFILL_TEXT_KEY = 'dsh-loop-watcher:prefill-text';

    /** 当前生效的前缀配置；apply() 时解析一次。enabled=false 时不注入前缀。 */
    const prefillConfig = { enabled: true, text: PREFILL_TEXT_DEFAULT };

    /** 读取一个 localStorage 字符串；异常返回 null（调用方自行兜底）。 */
    function readStoredString(key) {
      try {
        const value = window.localStorage.getItem(key);
        return typeof value === 'string' ? value : null;
      } catch {
        return null;
      }
    }

    /**
     * 解析前缀配置。语义要分清三种情况：
     *   - 开关键没写过 → 默认**开**；写过按 '1'/'0' 判。
     *   - 正文键**没写过** → 用内置默认前缀（新装即有前缀，符合「注入关键提示词」的初衷）；
     *   - 写过但是空白 → 使用者**明确**清空过 → 不注入（''），刷新后也不会复活。
     * 单独抽出来是为了回归测试能传入假 storage。
     */
    function resolvePrefillConfig(storage) {
      const read = (key) => {
        if (storage) return typeof storage.getItem === 'function' ? storage.getItem(key) : null;
        return readStoredString(key);
      };
      const rawEnabled = read(PREFILL_ENABLED_KEY);
      const rawText = read(PREFILL_TEXT_KEY);
      return {
        enabled: rawEnabled === null ? true : rawEnabled === '1',
        text: rawText === null
          ? PREFILL_TEXT_DEFAULT
          : (rawText.trim() !== '' ? rawText : ''),
      };
    }

    /**
     * 设置前缀配置。**唯一的写入点**（apply 时调一次 + 设置页保存时调）。
     *
     * 与 setExportToolPath 同样的取舍：写内存是立即生效的（下一次交接就用新值），
     * localStorage 写失败时如实返回 false，设置页据此提示「保存失败」。
     * 两个键**总是成对落盘**（包括空白正文）—— 空白也是使用者的一次明确决定，
     * 不能靠「键不存在」表达，否则刷新后又回到内置默认前缀。
     *
     * @param enabled - 是否注入前缀。
     * @param text - 前缀正文；空白串按「不注入」处理。
     * @param persist - 是否写 localStorage（设置页保存时为 true）。
     */
    function setPrefillConfig(enabled, text, persist) {
      const cleanText = typeof text === 'string' ? text : '';
      prefillConfig.enabled = enabled === true;
      prefillConfig.text = cleanText.trim() !== '' ? cleanText : '';
      if (!persist) return true;
      try {
        window.localStorage.setItem(PREFILL_ENABLED_KEY, prefillConfig.enabled ? '1' : '0');
        window.localStorage.setItem(PREFILL_TEXT_KEY, prefillConfig.text);
        return true;
      } catch (error) {
        warn('保存交接前缀设置失败', error);
        return false;
      }
    }

    /**
     * 组装「要注入的前缀」：开关开着**且**正文非空才返回正文，否则返回空串。
     * 交接指令与设置页的「当前是否注入」提示都用这一个判据。
     */
    function getPrefillText() {
      return prefillConfig.enabled && prefillConfig.text.trim() !== '' ? prefillConfig.text : '';
    }

    // #region loop-watcher-ui-config（2026-10-17 新增：两个 UI 偏好设置）
    /**
     * 两个「纯偏好」设置：计数徽章阈值、横幅的交接按钮。
     *
     * 与 prefill 同一套策略：localStorage 优先（升级不丢设置），常量兜底；
     * 解析与写入各自独立成函数，方便回归测试注入假 storage。
     */
    /** 计数徽章「变红」的次数门槛。1 = 一被打断就红；2 / 3 是默认。 */
    const COUNT_SEVERE_DEFAULT = 3;
    const COUNT_SEVERE_KEY = 'dsh-loop-watcher:count-severe';
    /** 横幅上「生成交接指令」按钮显不显示（有人只用菜单项，觉得横幅上碍眼）。 */
    const BANNER_DRAFT_DEFAULT = true;
    const BANNER_DRAFT_KEY = 'dsh-loop-watcher:banner-draft';

    const uiConfig = {
      countSevere: COUNT_SEVERE_DEFAULT,
      bannerDraft: BANNER_DRAFT_DEFAULT,
    };

    /**
     * 解析一个「数字型」设置：读到的必须是有限正整数，否则退回默认。
     * 手改 localStorage 改坏了也不该把徽章打崩。
     */
    function resolveCountSevere(storage) {
      const read = (key) => {
        if (storage) return typeof storage.getItem === 'function' ? storage.getItem(key) : null;
        return readStoredString(key);
      };
      const raw = read(COUNT_SEVERE_KEY);
      if (raw === null) return COUNT_SEVERE_DEFAULT;
      const value = Number(raw);
      return Number.isFinite(value) && value >= 1 && Number.isInteger(value)
        ? value
        : COUNT_SEVERE_DEFAULT;
    }

    /** 解析「横幅交接按钮」开关：未写 = 默认开；'0' = 关；其它值按开处理。 */
    function resolveBannerDraft(storage) {
      const read = (key) => {
        if (storage) return typeof storage.getItem === 'function' ? storage.getItem(key) : null;
        return readStoredString(key);
      };
      const raw = read(BANNER_DRAFT_KEY);
      return raw === null ? BANNER_DRAFT_DEFAULT : raw !== '0';
    }

    /** 写入两个 UI 偏好（内存立即生效 + 落盘）。异常一律 warn，不影响使用。 */
    function setUiConfig(patch) {
      if (typeof patch.countSevere === 'number') uiConfig.countSevere = patch.countSevere;
      if (typeof patch.bannerDraft === 'boolean') uiConfig.bannerDraft = patch.bannerDraft;
      try {
        if (typeof patch.countSevere === 'number') {
          window.localStorage.setItem(COUNT_SEVERE_KEY, String(patch.countSevere));
        }
        if (typeof patch.bannerDraft === 'boolean') {
          window.localStorage.setItem(BANNER_DRAFT_KEY, patch.bannerDraft ? '1' : '0');
        }
        return true;
      } catch (error) {
        warn('保存界面偏好失败', error);
        return false;
      }
    }

    /** 当前生效的红线阈值（徽章档位判定用）。 */
    function severeThreshold() {
      const value = Number(uiConfig.countSevere);
      return Number.isFinite(value) && value >= 1 ? Math.floor(value) : COUNT_SEVERE_DEFAULT;
    }
    // #endregion loop-watcher-ui-config
    // #endregion handover-prefill

    // #region loop-detect-core
    /**
     * 打转判据（与 `导出会话.py` 顶部常量、插件方案第 4.2 节一致，已用真实会话校准）：
     *   主判据：某个长度 <= 12 的行出现 >= 1000 次，且占全部行数 >= 5%
     *   辅判据：相邻完全相同的行连续 >= 100 行
     *   命中任一即判定打转；另有最短长度门槛（全文 < 8000 字不判定）。
     *
     * 实现要点：
     *   - 只处理新追加的文本（推理会长到几十万字，全量重扫会拖垮页面）；
     *   - 每个 assistant step 是一段，段内算连续重复、段间不延续；
     *   - 段内容被改写（llm/retry）时能精确撤销旧贡献。
     */
    const DEFAULT_DETECT_OPTIONS = Object.freeze({
      minChars: 8000,
      runThreshold: 100,
      shortLineMax: 12,
      countThreshold: 1000,
      ratioThreshold: 0.05,
      countAnyLineLength: false,
    });

    function newSegment() {
      return {
        text: '',
        processed: 0,
        pending: '',
        lastLine: null,
        run: 0,
        bestRun: 0,
        lines: 0,
        counter: new Map(),
      };
    }

    class LoopDetector {
      constructor(options = {}) {
        this.options = { ...DEFAULT_DETECT_OPTIONS, ...options };
        this.segments = new Map();
        this.chars = 0;
        this.totalLines = 0;
        this.counter = new Map();
      }

      reset() {
        this.segments.clear();
        this.counter.clear();
        this.chars = 0;
        this.totalLines = 0;
      }

      dropSegment(key) {
        const segment = this.segments.get(key);
        if (segment === undefined) return;
        this.segments.delete(key);
        this.chars -= segment.text.length;
        this.totalLines -= segment.lines;
        for (const [line, count] of segment.counter) {
          const left = (this.counter.get(line) ?? 0) - count;
          if (left > 0) this.counter.set(line, left);
          else this.counter.delete(line);
        }
      }

      /** 喂入某一段的全量文本（可以是同一段不断增长的内容）。 */
      feed(key, fullText) {
        const text = typeof fullText === 'string' ? fullText : '';
        let segment = this.segments.get(key);
        if (segment !== undefined
          && !(text.length >= segment.processed && text.startsWith(segment.text))) {
          this.dropSegment(key);
          segment = undefined;
        }
        if (segment === undefined) {
          segment = newSegment();
          this.segments.set(key, segment);
        }
        if (text.length > segment.processed) {
          this.consume(segment, text.slice(segment.processed));
          segment.processed = text.length;
        }
        this.chars += text.length - segment.text.length;
        segment.text = text;
      }

      consume(segment, delta) {
        const buffer = segment.pending + delta;
        const parts = buffer.split('\n');
        segment.pending = parts.pop() ?? '';
        const shortMax = this.options.shortLineMax;
        const anyLength = this.options.countAnyLineLength;
        for (const raw of parts) {
          const line = raw.trim();
          if (line === '') continue;
          this.totalLines += 1;
          segment.lines += 1;
          if (anyLength || line.length <= shortMax) {
            segment.counter.set(line, (segment.counter.get(line) ?? 0) + 1);
            this.counter.set(line, (this.counter.get(line) ?? 0) + 1);
          }
          if (segment.lastLine === line) segment.run += 1;
          else {
            segment.lastLine = line;
            segment.run = 1;
          }
          if (segment.run > segment.bestRun) segment.bestRun = segment.run;
        }
      }

      stats() {
        let bestRun = 0;
        for (const segment of this.segments.values()) {
          if (segment.bestRun > bestRun) bestRun = segment.bestRun;
        }
        let topLine = '';
        let topCount = 0;
        for (const [line, count] of this.counter) {
          if (count > topCount) {
            topLine = line;
            topCount = count;
          }
        }
        const ratio = this.totalLines > 0 ? topCount / this.totalLines : 0;
        const tooShort = this.chars < this.options.minChars;
        const byRun = bestRun >= this.options.runThreshold;
        const byCount = topCount >= this.options.countThreshold
          && ratio >= this.options.ratioThreshold;
        return {
          chars: this.chars,
          lines: this.totalLines,
          segments: this.segments.size,
          bestRun,
          topLine,
          topCount,
          ratio,
          tooShort,
          byRun,
          byCount,
          loopy: !tooShort && (byRun || byCount),
        };
      }
    }
    // #endregion loop-detect-core

    // #region loop-guard-helpers
    /** 从一个 assistant-step 节点取出推理文本。 */
    function reasoningTextOf(node) {
      const blocks = node && node.data ? node.data.blocks : null;
      if (!Array.isArray(blocks)) return '';
      let out = '';
      for (const block of blocks) {
        if (block && block.kind === 'reasoning' && typeof block.text === 'string') {
          out += `${block.text}\n`;
        }
      }
      return out;
    }

    /**
     * 收集节点 store 里的 `[key, node]` 对。
     *
     * 保住 key 是为了「定位」：聊天区每个流程项都带 `data-chat-node-key`（它等于 routedNode.key，
     * 也就是 store 的键），所以只要手里有 key，就能在 DOM 里把那一条找出来滚过去。
     */
    function nodeEntries(snapshot) {
      const store = snapshot && snapshot.nodes;
      if (!store) return null;
      try {
        if (typeof store.values === 'function' && typeof store.keys === 'function') {
          return Array.from(store.keys(), (key) => [key, store.get(key)]);
        }
        if (typeof store.values === 'function') return Array.from(store.values(), (node) => [null, node]);
      } catch (error) {
        warn('读取节点 store 失败', error);
      }
      const order = snapshot.order;
      if (!Array.isArray(order) || typeof store.get !== 'function') return null;
      const out = [];
      for (const key of order) {
        const node = store.get(key);
        if (node) out.push([key, node]);
      }
      return out;
    }

    /** 只要节点本身（自带检测的推理读取用不到 key）。 */
    function allNodes(snapshot) {
      const entries = nodeEntries(snapshot);
      return entries === null ? null : entries.map(([, node]) => node);
    }

    /**
     * 取「当前正在运行的 turn」的推理文本 —— 只看最大的 turn 号，
     * 绝不把历史里已经打完转的旧数据算进来（否则老会话一打开就误报）。
     */
    function readTurnReasoning(snapshot) {
      const nodes = allNodes(snapshot);
      if (nodes === null) return null;
      let maxTurn = -1;
      for (const node of nodes) {
        if (node && node.kind === 'assistant-step' && node.data
          && typeof node.data.turn === 'number' && node.data.turn > maxTurn) {
          maxTurn = node.data.turn;
        }
      }
      if (maxTurn < 0) return null;
      const segments = [];
      let running = false;
      for (const node of nodes) {
        if (!node || node.kind !== 'assistant-step' || !node.data) continue;
        if (node.data.turn !== maxTurn) continue;
        if (node.data.status === 'running') running = true;
        segments.push({ key: `${maxTurn}:${node.data.step}`, text: reasoningTextOf(node) });
      }
      if (segments.length === 0) return null;
      return { turn: maxTurn, running, segments };
    }

    /** 会话 ID 前 8 位（导出工具接受的短 ID）。 */
    function shortSessionId(sessionId) {
      const text = String(sessionId ?? '');
      const match = /[0-9a-f]{8}/i.exec(text);
      return match ? match[0] : text.slice(0, 8);
    }

    function todayStamp() {
      const now = new Date();
      const pad = (value) => String(value).padStart(2, '0');
      return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    }

    /**
     * 交接指令。素材由**新会话**自己导出：它手上有 pwsh 工具，
     * 比插件去起外部进程更简单，也让导出路径由真正读文件的那个会话拿到。
     */
    function buildGuardDraftPrompt(sessionId) {
      const short = shortSessionId(sessionId);
      return [
        `上一个会话（${sessionId}）的思考链打转了，由你接手。`,
        '',
        '第一步，执行这条命令，把旧会话导出成可读素材（brief 档约 2~3 万 token）：',
        '',
        '```powershell',
        "$env:PYTHONIOENCODING='utf-8'",
        `& "${exportToolPath}" export ${short} --detail brief`,
        '```',
        '',
        '它会打印导出文件的绝对路径（形如 `<工具目录>\\导出\\<短ID>-<时间>.md`）。读那个文件，',
        `据此写一份交接文档到当前工作目录下的 \`交接文档-${todayStamp()}.md\`，内容：`,
        '1. 任务目标（用使用者自己的话）',
        '2. 已完成到哪一步、产出文件在哪',
        '3. 关键文件与路径',
        '4. 踩过的坑与已验证的结论',
        '5. 下一步该做什么（含不确定项）',
        '',
        '注意：导出文件里标注了"打转"的部分，其结论不可信，只能当作"试过什么"的线索，',
        '你要自己判断哪些结论站得住。',
        '',
        '写完只回 3 行：成功/失败、文档绝对路径、失败原因。',
      ].join('\n');
    }

    // #region loop-guard-parked
    /**
     * 横幅的「停车位」—— 放在模块作用域，比组件 state 活得久。
     *
     * 本插件所有其他常量都是不可变的，唯独这一处必须有状态：换会话会把这棵组件树整个卸载，
     * 存在组件里的提醒会跟着消失。模块作用域在一次页面加载内不会被清掉，再配合 localStorage，
     * 就同时扛住了「换会话」和「刷新页面」两种情况。
     *
     * 存的是**一张按会话分的表**，不是单个值：这样 A 会话的提醒在切到 B 会话时不会被 B 冲掉，
     * 切回 A 仍然原样在那儿 —— 也就是「只在它发生的那个会话里显示」。
     *
     * 下面这些常量在本区域内重复声明（而不是引用外面的同名常量），是为了这段代码被单独抽出来跑时也自洽。
     */
    const ALERT_STORAGE_KEY = 'dsh-loop-guard:alert';
    const DISMISSED_STORAGE_KEY = 'dsh-loop-guard:dismissed';
    const DISMISSED_SESSION_LIMIT = 50;
    /**
     * 最多同时留几个会话的横幅。
     *
     * 按数量封顶**而不是按时间过期**：要求是「只有点 × 才消失」，加个 7 天自动过期
     * 就等于替你把它关了。超出的按写入顺序丢最早的（对象保留插入顺序）。
     */
    const ALERT_SESSION_LIMIT = 20;

    let parkedAlerts = {};

    function storage() {
      try {
        return window.localStorage;
      } catch {
        return null;
      }
    }

    function readParkedAlerts() {
      try {
        const store = storage();
        const raw = store === null ? null : store.getItem(ALERT_STORAGE_KEY);
        if (raw === null) return {};
        const value = JSON.parse(raw);
        return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
      } catch {
        return {};
      }
    }

    function writeParkedAlerts(value) {
      try {
        const store = storage();
        if (store === null) return;
        if (value === null) store.removeItem(ALERT_STORAGE_KEY);
        else store.setItem(ALERT_STORAGE_KEY, JSON.stringify(value));
      } catch {
        // 非回环地址下可能写不进去：模块作用域那份仍然有效，只是刷新后会丢。
      }
    }

    function readDismissedMap() {
      try {
        const store = storage();
        const raw = store === null ? null : store.getItem(DISMISSED_STORAGE_KEY);
        const value = raw === null ? null : JSON.parse(raw);
        return value && typeof value === 'object' ? value : {};
      } catch {
        return {};
      }
    }

    /** 这是不是「已经点过 ×」的那条通知。 */
    function isDismissed(sessionId, seq) {
      return readDismissedMap()[String(sessionId)] === seq;
    }

    function markDismissed(sessionId, seq) {
      try {
        const map = readDismissedMap();
        map[String(sessionId)] = seq;
        const keys = Object.keys(map);
        for (const key of keys.slice(0, Math.max(0, keys.length - DISMISSED_SESSION_LIMIT))) delete map[key];
        const store = storage();
        if (store !== null) store.setItem(DISMISSED_STORAGE_KEY, JSON.stringify(map));
      } catch {
        // 写不进去也不致命：本会话内存里那份（parkedAlerts）已经清掉了。
      }
    }

    /** 记下某个会话当前要显示的横幅；传 null 表示清掉它（点 × 时）。 */
    function parkAlert(sessionId, value) {
      const key = String(sessionId ?? '');
      if (value === null) {
        delete parkedAlerts[key];
      } else {
        delete parkedAlerts[key];
        parkedAlerts[key] = value;
        const keys = Object.keys(parkedAlerts);
        for (const stale of keys.slice(0, Math.max(0, keys.length - ALERT_SESSION_LIMIT))) {
          delete parkedAlerts[stale];
        }
      }
      writeParkedAlerts(parkedAlerts);
    }

    /**
     * 取该会话当前**还没被关掉**的横幅。
     *
     * 先看内存那份，再回落到 localStorage —— 后者是为了扛住「刷新页面」，
     * 也顺带扛住「换会话时组件被卸载，而某次写入偏偏失败」。
     */
    function loadAlert(sessionId) {
      const key = String(sessionId ?? '');
      const merged = { ...readParkedAlerts(), ...parkedAlerts };
      const value = merged[key];
      if (value === undefined || value === null) return null;
      if (typeof value !== 'object' || typeof value.seq !== 'number') return null;
      if (isDismissed(key, value.seq)) return null;
      return value;
    }

    function normalizeAlert(sessionId, notice) {
      return {
        sessionId: String(sessionId ?? ''),
        seq: typeof notice.seq === 'number' ? notice.seq : 0,
        time: typeof notice.time === 'number' ? notice.time : 0,
        summary: typeof notice.summary === 'string' ? notice.summary : '',
        text: typeof notice.text === 'string' ? notice.text : '',
        nodeKey: typeof notice.nodeKey === 'string' ? notice.nodeKey : '',
        turn: typeof notice.turn === 'number' ? notice.turn : null,
      };
    }
    // #endregion loop-guard-parked

    /** 本插件所有时间判定的容差（毫秒）：机器时钟微小抖动不至于把新通知判成旧的。 */
    const FRESH_TOLERANCE_MS = 2000;

    /**
     * 这条通知是不是「本组件挂载之后才发生的」—— 只弹这种。
     *
     * ## 为什么用事件时间，而不是「本次挂载第几次看到」（2026-10-15 修的真 bug）
     *
     * 原来写的是「本次挂载第一次看到通知 → 只登记、不弹」，本意是「打开老会话别为历史通知弹」。
     * 但它判断的是**本次挂载内第几次见到通知**，不是**通知发生在挂载之前还是之后**。
     * 后果：新会话里守卫开火时，那正好是本次挂载第一次看到通知 → 被当成历史 → **永远不弹**。
     * 于是任何会话里的第一次循环都弹不出来，只有第二次才会 —— 实际使用中表现为「完全不通知」。
     *
     * 事件本身带 `time`（epoch 毫秒，与 `Date.now()` 同一时钟），拿它跟挂载时刻比才是正解。
     * 拿不到时间时**偏向「算新」**：宁可多弹一次（点 × 即可），也不要又静默失效。
     */
    function isFreshNotice(notice, mountedAt) {
      if (!notice) return false;
      const time = typeof notice.time === 'number' ? notice.time : 0;
      if (time > 0) return time >= mountedAt - FRESH_TOLERANCE_MS;
      return true;
    }

    /** 把一条消息的 content 部件拼成纯文本。 */
    function plainTextOf(content) {
      if (typeof content === 'string') return content;
      if (!Array.isArray(content)) return '';
      let out = '';
      for (const part of content) {
        if (part && part.type === 'text' && typeof part.text === 'string') out += part.text;
      }
      return out;
    }

    /**
     * 找上游守卫（`@mrweicodes/dsh-loop-guard`）注入的通知。
     *
     * 它每切断一次流，就 `agent.steer` / `agent.inject` 一条消息，并给这条消息打上
     * `source.kind === 'loop-guard'`（源码里的 `PLUGIN_SOURCE`）。这条消息物化在节点
     * store 里，所以这里读得到 —— 它负责切断，我们负责让你知道。
     *
     * ## 为什么**不**按 `node.kind` 过滤（2026-10-15 修的真实 bug）
     *
     * 曾经这里写的是 `node.kind !== 'context'`，结果通知全被丢掉、横幅一次都没弹过。
     * 根因在 DSH 的 `messageDefinition.buildViewNode`：
     *
     *     context.state.kind === 'context' && … && context.state.waking === true
     *       ? 'turn-trigger'      // ← 同一条通知，"唤醒下一轮"时类型会变成这个
     *       : context.state.kind
     *
     * 也就是说**同一条通知既可能是 `context`，也可能是 `turn-trigger`**，取决于它有没有
     * 被当成唤醒下一轮的消息。节点类型是 DSH 展示层的实现细节，已经改过一次
     * （0.1.7 起 context 不再渲染），以后还会改。
     *
     * 稳定的契约只有一个：**消息上的 `source.kind === 'loop-guard'`**（上游自己的常量）。
     * 所以这里只认它，不看节点类型 —— 用户消息的 source.kind 是 `'user'`，不会误伤。
     */
    function findGuardNotices(snapshot) {
      const entries = nodeEntries(snapshot);
      if (entries === null) return [];
      // 先把「(seq, turn)」排好，用来把通知反推回它所属的那一轮。
      // 通知本身不带 turn，而 `data-chat-turn` 是定位退路唯一的抓手 ——
      // 取 seq 不大于通知 seq 的最后一个 assistant-step，就是通知发生时正在跑的那一轮。
      // 每 700ms 的轮询都会走到这里，所以只做一次轻扫；反推 turn 只在真有通知时才扫第二遍。
      //
      // ⚠️ seq 要读 `node.anchorSeq`，**不是** `node.data.seq`（2026-10-15 修的第三个 bug）：
      //    DSH 的 `chatNode(context, kind, anchorSeq, data)` 把 seq 放在节点上；
      //    assistant-step 的 `data` 里只有 status/turn/step/blocks/time/usage，
      //    压根没有 seq —— 原来读 data.seq 恒为 undefined，turn 永远是 null，定位退路从未生效。
      const seqOf = (node) => {
        if (typeof node.anchorSeq === 'number') return node.anchorSeq;
        if (node.data && typeof node.data.seq === 'number') return node.data.seq;
        return null;
      };
      const turnAt = (seq) => {
        let turn = null;
        let best = -Infinity;
        for (const [, node] of entries) {
          if (!node || node.kind !== 'assistant-step' || !node.data) continue;
          const stepSeq = seqOf(node);
          const stepTurn = node.data.turn;
          if (stepSeq === null || typeof stepTurn !== 'number') continue;
          if (stepSeq > seq) continue;
          if (stepSeq > best) {
            best = stepSeq;
            turn = stepTurn;
          }
        }
        return turn;
      };
      const out = [];
      for (const [key, node] of entries) {
        if (!node || !node.data) continue;
        const source = node.data.source;
        // 字面量写在这儿（而不是引用外面的常量），是为了这段代码被单独抽出来跑时也自洽。
        // 只认 source.kind —— 不看 node.kind，理由见上面的注释。
        if (!source || source.kind !== 'loop-guard') continue;
        const seq = seqOf(node) ?? 0;
        out.push({
          seq,
          // 事件时间（epoch 毫秒）：用来区分「刚发生」与「挂载前就在历史里」，见 isFreshNotice。
          time: typeof node.data.time === 'number' ? node.data.time : 0,
          summary: typeof source.summary === 'string' ? source.summary : '',
          text: plainTextOf(node.data.content),
          // 定位用锚点：节点 key（对上 `data-chat-node-key`）与它所属的 turn（对上 `data-chat-turn`）。
          nodeKey: typeof key === 'string' && key !== '' ? key : '',
          turn: typeof node.data.turn === 'number' ? node.data.turn : turnAt(seq),
        });
      }
      out.sort((left, right) => left.seq - right.seq);
      return out;
    }
    // #endregion loop-guard-helpers

    // #region loop-guard-count
    /**
     * 「本对话已打断 N 次」的计数。
     *
     * ## 计数从哪来
     *
     * 只数 `source.kind === 'loop-guard'` 的节点 —— 和横幅认的是同一个契约。
     * 一条通知 = 上游守卫切断一次流，所以「通知条数」就是「打断次数」。
     *
     * ## 为什么不直接数当前 store 里的条数
     *
     * 聊天区有**历史分页**：早期节点会被卸下，当前 store 可能只剩最近几条。
     * 若直接数，计数会在翻历史时**倒退**（本来 7 次，翻一下变 3 次），
     * 那这个徽章就没有可信度了。所以按会话记住**见过的所有通知 seq**，
     * 计数取这个集合的大小 —— 只增不减。
     *
     * ## 为什么只算轻量的一面
     *
     * 轮询每 700ms 跑一次，`findGuardNotices` 会为每条通知反推一次轮次（O(通知数 × 节点数)）。
     * 计数只需要 seq，不需要轮次，所以这里单开一个只做一次轻扫的函数；
     * 要定位时（点击那一下）才走 `findGuardNotices`。
     *
     * 下面这些常量在本区域内重复声明（而不是引用外面的同名常量），
     * 是为了这段代码被单独抽出来跑时也自洽。
     */
    const COUNT_STORAGE_KEY = 'dsh-loop-guard:count';
    /** 最多留几个会话的计数（按数量封顶，不做时间过期）。 */
    const COUNT_SESSION_LIMIT = 30;
    /** 每个会话最多记多少个 seq。正常会话到不了这个量级，纯粹防无界增长。 */
    const COUNT_SEQ_LIMIT = 400;

    function countStorage() {
      try {
        return window.localStorage;
      } catch {
        return null;
      }
    }

    /**
     * 轻量扫一遍：只把 loop-guard 通知的 seq 取出来，**不反推轮次**。
     *
     * seq 读 `node.anchorSeq`，回落到 `node.data.seq`（与 `findGuardNotices` 同一套读法）。
     * 两个都拿不到时返回 0 —— 调用方会跳过它，宁可漏计也不猜一个假的编号。
     */
    function scanGuardSeqs(snapshot) {
      const entries = nodeEntries(snapshot);
      if (entries === null) return [];
      const out = [];
      for (const [, node] of entries) {
        if (!node || !node.data) continue;
        const source = node.data.source;
        if (!source || source.kind !== 'loop-guard') continue;
        const seq = typeof node.anchorSeq === 'number'
          ? node.anchorSeq
          : (typeof node.data.seq === 'number' ? node.data.seq : 0);
        if (seq > 0) out.push(seq);
      }
      return out;
    }

    /**
     * 计数表的内存兜底（与横幅那套 `parkedAlerts` 同一思路）。
     *
     * 为什么必须有它：**「只增不减」这个保证不能依赖 localStorage 可用**。
     * 若 localStorage 被禁（隐私模式 / 配额满 / 非回环地址），每一次 `readCountMap`
     * 都返回空表 —— 计数就会退化成「当前 store 里的条数」，历史一被卸下数字就往下掉，
     * 正是本功能要避免的那件事。所以内存里留一份，读时与磁盘那份取并集。
     *
     * 生命周期：一次页面加载。刷新后若 localStorage 仍不可用则从 0 重新累计 ——
     * 这是物理限制，不装作能扛住。
     */
    let memoryCounts = {};

    function readCountMap() {
      // 先读磁盘那份；任何异常都退回空表，但**内存那份始终参与合并**。
      let stored = {};
      try {
        const store = countStorage();
        const raw = store === null ? null : store.getItem(COUNT_STORAGE_KEY);
        if (raw !== null) {
          const value = JSON.parse(raw);
          if (value && typeof value === 'object' && !Array.isArray(value)) {
            // 只保留形状对得上的条目（手改过 localStorage 也不至于把徽章打崩）。
            for (const [key, entry] of Object.entries(value)) {
              if (!entry || typeof entry !== 'object') continue;
              const seqs = Array.isArray(entry.seqs)
                ? entry.seqs.filter((seq) => Number.isSafeInteger(seq) && seq > 0)
                : [];
              stored[key] = { seqs, updated: typeof entry.updated === 'number' ? entry.updated : 0 };
            }
          }
        }
      } catch {
        stored = {};
      }
      // 与内存那份取并集：磁盘不可用时就是内存那份，可用时两者一致（并集不会变小）。
      const out = { ...stored };
      for (const [key, entry] of Object.entries(memoryCounts)) {
        const current = out[key];
        if (current === undefined) {
          out[key] = { seqs: entry.seqs.slice(), updated: entry.updated };
          continue;
        }
        const merged = new Set(current.seqs);
        for (const seq of entry.seqs) merged.add(seq);
        out[key] = {
          seqs: [...merged].sort((left, right) => left - right),
          updated: Math.max(current.updated, entry.updated),
        };
      }
      return out;
    }

    function writeCountMap(map) {
      // 内存那份**无条件**更新：它是 localStorage 不可用时的唯一依靠。
      memoryCounts = map;
      try {
        const store = countStorage();
        if (store === null) return;
        store.setItem(COUNT_STORAGE_KEY, JSON.stringify(map));
      } catch {
        // 写不进也不致命：上面那份内存副本已经保证了本次加载内计数只增不减。
      }
    }

    /** 该会话当前记下的通知 seq 集合（读，不写）。 */
    function countOf(sessionId) {
      const entry = readCountMap()[String(sessionId ?? '')];
      return entry ? entry.seqs.length : 0;
    }

    /**
     * 把这一轮扫到的 seq 并进该会话的记录，返回**并集大小**（= 打断次数）。
     *
     * 只增不减：这是「翻历史时计数不倒退」的实现点。seq 去重后按大小排序，
     * 超出上限时丢最小的那些（保留最近的、也保住总数上界）。
     */
    function mergeCount(sessionId, seqs) {
      const key = String(sessionId ?? '');
      const map = readCountMap();
      const entry = map[key] ?? { seqs: [], updated: 0 };
      const merged = new Set(entry.seqs);
      let added = false;
      for (const seq of seqs) {
        if (!Number.isSafeInteger(seq) || seq <= 0) continue;
        if (!merged.has(seq)) {
          merged.add(seq);
          added = true;
        }
      }
      const list = [...merged].sort((left, right) => left - right);
      const kept = list.length > COUNT_SEQ_LIMIT ? list.slice(list.length - COUNT_SEQ_LIMIT) : list;
      const next = { seqs: kept, updated: added ? Date.now() : entry.updated };
      if (added || entry.seqs.length !== kept.length) {
        // 重新插入一次，让对象顺序 = 最近更新顺序（下面按插入顺序丢最老的会话）。
        delete map[key];
        map[key] = next;
        const keys = Object.keys(map);
        for (const stale of keys.slice(0, Math.max(0, keys.length - COUNT_SESSION_LIMIT))) {
          delete map[stale];
        }
        writeCountMap(map);
      }
      return kept.length;
    }

    /**
     * 次数 → 徽章档位：0 次也算一档（中性），1..threshold-1 mild，>=threshold severe。
     *
     * `threshold` 由设置页给（默认 3）。**本函数自带兜底**、不引用外部常量 ——
     * 因为它会被 extract-core.mjs 单独抽出去跑回归，抽出去的代码必须自洽。
     */
    function countLevel(count, threshold) {
      const line = Number.isFinite(threshold) && threshold >= 1 ? Math.floor(threshold) : 3;
      if (!(count > 0)) return 'none';
      return count >= line ? 'severe' : 'mild';
    }
    // #endregion loop-guard-count

    // #region loop-guard-locate
    /**
     * 「定位」：把那条通知对应的聊天区流程项滚进视野并高亮一下。
     *
     * 为什么是 DOM 而不是某个导航服务：Client 侧**没有** chat / conversation 服务
     * （`ctx.get('chat')` 取不到，inspect 的服务目录里也没有），插件的 standardProps 里没有导航能力。
     * 但聊天区每个流程项都带 `data-chat-node-key` / `data-chat-turn`（ChatView 渲染时写死的），
     * 所以查询 DOM 是这里唯一可行、也足够稳的路子。
     *
     * 两条路径，按可靠性排序：
     *   1) `[data-chat-node-key="<key>"]` —— 精确命中那一条。上游注入的通知是 `context` 节点，
     *      DSH 0.1.7 起**不渲染**它，所以这条通常只在「那段思考被展开过」时才成立；
     *   2) `[data-chat-turn="<turn>"]` —— 退回到那一轮，一定存在（除非它被历史分页卸下了，
     *      那种情况下先提示上滑加载）。
     */
    function locateInChat(notice, later) {
      if (typeof document === 'undefined' || notice === null || notice === undefined) return false;
      const ring = (element) => {
        element.classList.add('dsh-loop-guard-located');
        later(() => element.classList.remove('dsh-loop-guard-located'), 2400);
      };
      const intoView = (element) => {
        // 往上找真正的滚动容器。不能写死名字：DSH 的聊天滚动容器**没有** data-chat-* 标记
        // （实测整个 UI 包里只有 anchor-key / flow-key / node-key / turn 这几个），
        // 所以按「有没有超出可视高度」这个几何事实来判断，找不到就退回 scrollIntoView。
        const scrollParent = (node) => {
          let current = node.parentElement;
          while (current) {
            if (current.clientHeight > 0 && current.scrollHeight > current.clientHeight) return current;
            current = current.parentElement;
          }
          return null;
        };
        const scroller = scrollParent(element);
        if (scroller !== null && typeof scroller.scrollTop === 'number') {
          const offset = element.offsetTop - scroller.clientHeight / 3;
          scroller.scrollTo({ top: Math.max(0, offset), behavior: 'smooth' });
        } else {
          element.scrollIntoView({ block: 'center', behavior: 'smooth' });
        }
        ring(element);
        return true;
      };
      const key = typeof notice.nodeKey === 'string' ? notice.nodeKey : '';
      const escape = window.CSS && typeof window.CSS.escape === 'function'
        ? window.CSS.escape
        : (value) => value.replace(/["\\]/g, '\\$&');
      const rows = document.querySelectorAll('[data-chat-node-key], [data-chat-turn]');
      if (key !== '') {
        for (const element of rows) {
          if (element.dataset && element.dataset.chatNodeKey === key) return intoView(element);
        }
      }
      if (typeof notice.turn === 'number') {
        const exact = document.querySelector(`[data-chat-turn="${escape(String(notice.turn))}"]`);
        // 精确那一轮被历史分页卸下时，退到第一个「不早于它」的已挂载行。
        if (exact !== null) return intoView(exact);
        for (const element of rows) {
          const turn = Number(element.dataset ? element.dataset.chatTurn : NaN);
          if (Number.isSafeInteger(turn) && turn >= notice.turn) return intoView(element);
        }
      }
      return false;
    }
    // #endregion loop-guard-locate

    function readMode() {
      try {
        return window.localStorage.getItem(MODE_STORAGE_KEY) === 'interrupt'
          ? 'interrupt'
          : 'notify';
      } catch {
        return 'notify';
      }
    }

    /**
     * 自检模式。在页面控制台执行其一，再刷新页面：
     *
     *   localStorage.setItem('dsh-loop-guard:self-test', 'guard')
     *     → 演练**上游守卫那条链路**：弹出与真实通知同形的横幅
     *       （带定位/关闭/生成交接指令三个按钮）。验证「读通知 → 弹横幅」通了。
     *
     *   localStorage.setItem('dsh-loop-guard:self-test', '1')
     *     → 演练**自带检测那条链路**：弹一条示例统计的横幅。
     *
     *   localStorage.setItem('dsh-loop-guard:self-test', 'count')
     *     → 演练**会话头那个计数徽章**：显示示例次数（不写进记录）。
     *
     * 删掉这个键（或设为别的值）即恢复。
     *
     * 为什么要分开：几条链路读的是完全不同的数据（守卫通知 vs assistant-step 推理 vs 累计计数），
     * 曾经「自带检测能弹、守卫通知弹不出来」静默了几轮才被发现。分开演练，一眼看出是哪条坏了。
     */
    function readSelfTest() {
      try {
        const value = window.localStorage.getItem(SELF_TEST_KEY);
        if (value === 'guard') return 'guard';
        if (value === 'count') return 'count';
        return value === '1' ? 'stats' : null;
      } catch {
        return null;
      }
    }

    /**
     * 自检模式下徽章要显示的次数。
     *
     * 用 3 而不是 1：**跨过 severe 那道门槛**，这样一次演练就能看到告警配色，
     * 不用先制造两次假打断。
     */
    const COUNT_SELF_TEST = 3;

    function writeMode(mode) {
      try {
        window.localStorage.setItem(MODE_STORAGE_KEY, mode);
      } catch {
        // 非回环地址下可能写不进去，仅内存生效。
      }
    }

    /** 命中日志：方便过几天回看误报率（最近 100 条）。 */
    function logHit(sessionId, turn, stats) {
      try {
        const raw = window.localStorage.getItem(LOG_STORAGE_KEY);
        const list = raw ? JSON.parse(raw) : [];
        list.push({
          at: new Date().toISOString(),
          sessionId: String(sessionId ?? ''),
          turn,
          chars: stats.chars,
          lines: stats.lines,
          bestRun: stats.bestRun,
          topLine: stats.topLine,
          topCount: stats.topCount,
          ratio: Number(stats.ratio.toFixed(4)),
          byRun: stats.byRun,
          byCount: stats.byCount,
        });
        while (list.length > 100) list.shift();
        window.localStorage.setItem(LOG_STORAGE_KEY, JSON.stringify(list));
      } catch (error) {
        warn('写命中日志失败', error);
      }
    }

    /** 中止当前回合：Client 服务 sessions → binding(id).session.cancel()。 */
    function cancelSession(ctx, sessionId) {
      try {
        const sessions = typeof ctx.get === 'function' ? ctx.get('sessions') : undefined;
        if (!sessions || typeof sessions.binding !== 'function') return false;
        const binding = sessions.binding(sessionId);
        const session = binding ? binding.session : null;
        if (!session || typeof session.cancel !== 'function') return false;
        const result = session.cancel();
        if (result && typeof result.catch === 'function') result.catch(() => {});
        return true;
      } catch (error) {
        warn('取消失败', error);
        return false;
      }
    }

    function formatCount(value) {
      try {
        return Number(value).toLocaleString('zh-CN');
      } catch {
        return String(value);
      }
    }

    function LoopGuardBanner(props) {
      const {
        sessionId, cancelSession: cancel, useChat, useInput, inputActions, t,
      } = props;
      const snapshot = useChat((state) => state);
      const input = useInput((state) => state);
      const latest = React.useRef(null);
      latest.current = snapshot;
      const draftRef = React.useRef('');
      draftRef.current = input && typeof input.draft === 'string' ? input.draft : '';

      const [alert, setAlert] = React.useState(null);
      const [demo, setDemo] = React.useState(null);
      // 换会话会把整棵组件卸载重建：模块作用域里存着的那条提醒仍然在（按会话分），这里把它捞回来。
      const [guardAlert, setGuardAlert] = React.useState(() => loadAlert(sessionId));
      const [notice, setNotice] = React.useState('');
      const [mode, setMode] = React.useState(readMode);

      const detector = React.useRef(null);
      const confirm = React.useRef(0);
      const actedTurn = React.useRef(null);
      const ignoredTurn = React.useRef(null);
      const loggedTurn = React.useRef(null);
      /** 已经「看过」的通知 seq，按会话记 —— 只用来判断有没有新的一条。 */
      const seenGuardSeq = React.useRef(new Map());
      /** 轮询在定时器里跑，读不到最新的 state，所以另存一份 ref。 */
      const guardAlertRef = React.useRef(guardAlert);
      guardAlertRef.current = guardAlert;
      const modeRef = React.useRef(mode);
      const timers = React.useRef([]);
      if (detector.current === null) detector.current = new LoopDetector();
      modeRef.current = mode;

      const say = React.useCallback((key) => {
        setNotice(typeof t === 'function' ? t(key) : key);
      }, [t]);

      const later = React.useCallback((fn, delay) => {
        const id = window.setTimeout(() => {
          timers.current = timers.current.filter((item) => item !== id);
          fn();
        }, delay);
        timers.current.push(id);
      }, []);

      /**
       * 把「当前要显示的横幅」同步到模块作用域 + localStorage。
       *
       * 这是第 1 条要求的核心：**提醒只在它发生的那个会话里显示，且只有点 × 才会消失**。
       * 组件被卸载（换会话）、页面被刷新都不再影响它 —— 换回来还在，直到你手动关掉。
       *
       * 同时负责反过来的一件事：切回那个会话时，组件是新建的（state 是 null），
       * 这里把停车位里的那条捞回屏幕上。
       */
      React.useEffect(() => {
        if (guardAlert === null) return;
        parkAlert(sessionId, normalizeAlert(sessionId, guardAlert));
      }, [guardAlert, sessionId]);

      /**
       * 横幅上的「生成交接指令」。
       *
       * **2026-10-17 改**：原来这里自己拼一份「让新会话写交接文档、只回 3 行」的
       * 提示词塞进输入框；而菜单项的「交接对话」早就改成了**隐藏注入 + 直接接着活干**。
       * 同一个插件里两条交接路径给出两套互相矛盾的工作方式，使用者会困惑，
       * 而且旧那份还要他「再开第三个会话」才真正开始干活。
       *
       * 现在**两个入口共用同一个 `runHandover`**：开新会话 + 登记隐藏指令 +
       * 标题精修，一次做完。旧函数 `buildGuardDraftPrompt` 随之停用。
       *
       * @returns 是否成功交接（有 uiWorkspace 服务才算成功）。
       */
      const draftHandover = React.useCallback(() => {
        const ctx = ctxRef.current;
        if (ctx === null || ctx === undefined) return false;
        const result = runHandover(ctx, sessionId, '');
        if (result && typeof result.then === 'function') {
          result.then((outcome) => outcome && outcome.ok === true);
        }
        return true;
      }, [sessionId]);

      /** 「定位」：滚到那条通知所在的聊天区流程项，并闪一下。 */
      const locate = React.useCallback(() => {
        if (guardAlert === null) return;
        const ok = locateInChat(guardAlert, later);
        say(ok ? 'notice.located' : 'notice.locateFailed');
      }, [guardAlert, later, say]);

      const stopAndDraft = React.useCallback(() => {
        const stopped = typeof cancel === 'function' ? cancel() : false;
        // 先停、再预填：等界面从「运行中」回到空闲，草稿不会被状态刷新冲掉。
        later(() => {
          const drafted = draftHandover();
          if (stopped && drafted) say('notice.stoppedAndDrafted');
          else if (stopped) say('notice.stopped');
          else if (drafted) say('notice.drafted');
          else say('notice.stopFailed');
        }, 600);
        if (!stopped) say('notice.stopFailed');
      }, [cancel, draftHandover, later, say]);

      const stopOnly = React.useCallback(() => {
        const stopped = typeof cancel === 'function' ? cancel() : false;
        say(stopped ? 'notice.stopped' : 'notice.stopFailed');
      }, [cancel, say]);

      /**
       * 「×」——这是唯一能让横幅消失的动作。
       *
       * 关掉之后要记两件事：① 停车位清空，换会话回来也不复现；
       * ② 记下「这条 seq 我关过了」，否则 700ms 后那轮询又把它当成一条新通知弹回来。
       */
      const dismiss = React.useCallback(() => {
        if (guardAlert !== null) markDismissed(sessionId, guardAlert.seq);
        parkAlert(sessionId, null);
        setGuardAlert(null);
        setDemo(null);
        setNotice('');
      }, [guardAlert, sessionId]);

      const ignore = React.useCallback(() => {
        ignoredTurn.current = alert ? alert.turn : null;
        if (alert === null && guardAlert !== null) {
          // 上游那条已经替我们停住了调用，这里的「忽略」等价于点 ×。
          dismiss();
          return;
        }
        setAlert(null);
        say('notice.ignored');
      }, [alert, dismiss, guardAlert, say]);

      /** 上游已经替我们停住了那一次调用，这里只需要把交接指令递出去。 */
      const draftOnly = React.useCallback(() => {
        const drafted = draftHandover();
        say(drafted ? 'notice.draftedOnly' : 'notice.draftFailed');
      }, [draftHandover, say]);

      const toggleMode = React.useCallback(() => {
        setMode((current) => {
          const next = current === 'interrupt' ? 'notify' : 'interrupt';
          writeMode(next);
          say(next === 'interrupt' ? 'notice.modeOn' : 'notice.modeOff');
          return next;
        });
      }, [say]);

      React.useEffect(() => {
        // 默认不跑自带检测：上游守卫在流内部切断，比这里准也更早（见 OWN_DETECTION）。
        if (!OWN_DETECTION) return undefined;
        const timer = window.setInterval(() => {
          const current = readTurnReasoning(latest.current);
          const engine = detector.current;
          if (current === null || !current.running) {
            engine.reset();
            confirm.current = 0;
            // 已经是 null 时 React 自己跳过重渲染。
            setAlert(null);
            return;
          }
          if (engine.turn !== current.turn) {
            engine.reset();
            engine.turn = current.turn;
            confirm.current = 0;
            setAlert(null);
          }
          for (const segment of current.segments) engine.feed(segment.key, segment.text);
          const stats = engine.stats();
          if (!stats.loopy) {
            confirm.current = 0;
            return;
          }
          confirm.current += 1;
          if (confirm.current < CONFIRM_SAMPLES) return;
          confirm.current = 0;
          setAlert({ turn: current.turn, stats });
          if (loggedTurn.current !== current.turn) {
            loggedTurn.current = current.turn;
            logHit(sessionId, current.turn, stats);
          }
          const skip = ignoredTurn.current === current.turn
            || actedTurn.current === current.turn;
          if (modeRef.current === 'interrupt' && !skip) {
            actedTurn.current = current.turn;
            const stopped = typeof cancel === 'function' ? cancel() : false;
            later(() => {
              const drafted = draftHandover();
              if (stopped && drafted) say('notice.stoppedAndDrafted');
              else if (stopped) say('notice.stopped');
              else if (drafted) say('notice.drafted');
              else say('notice.stopFailed');
            }, 600);
          }
        }, SAMPLE_INTERVAL_MS);
        return () => window.clearInterval(timer);
      }, [cancel, draftHandover, later, say, sessionId]);

      // 上游守卫的通知：一发现**新的**就弹横幅（它自己不报警，这正是本插件存在的理由）。
      //
      // 三条分支的分工：
      //   a) 本会话已经有一条待处理横幅（可能来自上一次挂载）→ 只更新它，不重复弹；
      //   b) 这条通知发生在本次挂载之前 → 是历史，登记后不弹（打开老会话不该被历史轰炸）；
      //   c) 这条通知发生在本次挂载之后 → 弹出来，并停进 localStorage（换会话/刷新都不丢）。
      //
      // ⚠️ (b) 判的是**事件时间**，不是「本次挂载第几次看到」—— 后者会让每个会话的
      //    第一次循环永远弹不出来（2026-10-15 修的真 bug，详见 isFreshNotice）。
      React.useEffect(() => {
        const mountedAt = Date.now();
        const timer = window.setInterval(() => {
          const found = findGuardNotices(latest.current);
          if (found.length === 0) return;
          const newest = found[found.length - 1];
          const already = guardAlertRef.current;
          if (already !== null) {
            // (a) 不点 × 就不动：仍是同一条就什么都不做，换了一条只替换内容。
            if (newest.seq !== already.seq) setGuardAlert(newest);
            return;
          }
          if (newest.seq === seenGuardSeq.current.get(sessionId)) return;
          seenGuardSeq.current.set(sessionId, newest.seq);
          // (b) 挂载前就存在 → 历史，不弹。
          if (!isFreshNotice(newest, mountedAt)) return;
          // (c) 关过就不复活；否则弹出来。
          if (!isDismissed(sessionId, newest.seq)) setGuardAlert(newest);
          setNotice('');
        }, NOTICE_POLL_MS);
        return () => window.clearInterval(timer);
      }, [sessionId]);

      React.useEffect(() => {
        const mode = readSelfTest();
        if (mode === null) return;
        if (mode === 'guard') {
          // 演练**上游守卫那条链路**：造一条和真通知同形的横幅。
          // 之所以需要它：2026-10-15 之前，守卫通知在真实循环里一次都没弹出来过
          // （三个 bug 叠加），而当时只能靠"等一个真循环"来发现。这条演练能在 5 秒内验证
          // 「读通知 → 弹横幅 → 定位/关闭按钮」整条路径是通的，不必等真打转。
          setGuardAlert({
            seq: -1,
            time: Date.now(),
            summary: '（演练）已截断重复的思考内容（513 字符）',
            text: '你的思考内容已连续重复 513 个字符而没有进展，因此响应被中途截断。',
            nodeKey: '',
            turn: null,
          });
          say('notice.selfTestGuard');
          return;
        }
        setDemo({
          turn: -1,
          stats: {
            chars: 128400,
            lines: 4210,
            segments: 12,
            bestRun: 3,
            topLine: '好。',
            topCount: 2104,
            ratio: 0.4997,
            byRun: false,
            byCount: true,
          },
        });
        say('notice.selfTest');
      }, [say]);

      React.useEffect(() => () => {
        for (const id of timers.current) window.clearTimeout(id);
        timers.current = [];
      }, []);

      if (alert === null && demo === null && guardAlert === null) return null;

      const label = (key, fallback) => (typeof t === 'function' ? t(key) : fallback);
      // 两种来源：上游守卫的通知（默认）与本插件自带的检测（OWN_DETECTION 打开时）。
      const fromGuard = guardAlert !== null;
      const stats = fromGuard ? null : (alert ?? demo).stats;
      const detail = fromGuard
        ? (guardAlert.summary || label('guard.noSummary', ''))
        : stats.byRun
          ? label('banner.detailRun', '')
            .replace('{run}', formatCount(stats.bestRun))
            .replace('{chars}', formatCount(stats.chars))
            .replace('{lines}', formatCount(stats.lines))
          : label('banner.detail', '')
            .replace('{line}', stats.topLine)
            .replace('{count}', formatCount(stats.topCount))
            .replace('{ratio}', `${(stats.ratio * 100).toFixed(1)}%`)
            .replace('{chars}', formatCount(stats.chars))
            .replace('{lines}', formatCount(stats.lines));

      const button = (key, fallback, onClick, primary) => h('button', {
        type: 'button',
        className: 'dsh-loop-guard-button',
        ...(primary ? { 'data-primary': 'true' } : {}),
        onClick,
      }, label(key, fallback));

      /**
       * 右上角的 ×。它是横幅**唯一**的关闭入口：不点它，换会话、刷新页面都还在。
       * 之所以不自动消失，是因为「刚才那一步是不是真的在打转」这件事只有你有资格判断，
       * 自动消失等于替你做了这个判断。
       */
      const closeButton = h('button', {
        type: 'button',
        className: 'dsh-loop-guard-close',
        title: label('action.close', 'Close'),
        'aria-label': label('action.close', 'Close'),
        onClick: dismiss,
      }, '\u00d7');

      return h('div', { className: 'dsh-loop-guard-root', role: 'status', 'aria-live': 'polite' },
        closeButton,
        h('div', { className: 'dsh-loop-guard-row' },
          h('span', { className: 'dsh-loop-guard-icon', 'aria-hidden': true }, '⚠'),
          h('div', { className: 'dsh-loop-guard-text' },
            h('div', { className: 'dsh-loop-guard-title' },
              label(fromGuard ? 'guard.title' : 'banner.title', 'Loop')),
            h('div', { className: 'dsh-loop-guard-detail' }, detail),
            h('div', { className: 'dsh-loop-guard-advice' },
              label(fromGuard ? 'guard.advice' : 'banner.advice', '')),
          ),
          h('div', { className: 'dsh-loop-guard-actions' },
            OWN_DETECTION ? h('span', { className: 'dsh-loop-guard-mode' },
              label('mode.label', 'Auto-stop'),
              h('button', {
                type: 'button',
                className: 'dsh-loop-guard-switch',
                role: 'switch',
                'aria-checked': mode === 'interrupt' ? 'true' : 'false',
                onClick: toggleMode,
              }, label(mode === 'interrupt' ? 'mode.on' : 'mode.off', mode === 'interrupt' ? 'on' : 'off')),
            ) : null,
            fromGuard ? button('action.locate', 'Locate', locate, false) : null,
            fromGuard
              ? button('action.dismiss', 'Dismiss', dismiss, false)
              : button('action.ignore', 'Ignore', ignore, false),
            fromGuard ? null : button('action.stopOnly', 'Stop', stopOnly, false),
            /**
             * 「生成交接指令」按钮 —— 两个条件都满足才渲染：
             *   ① 配了导出工具（没配时指令里那条命令跑不通，点了只会以为插件坏了）；
             *   ② 设置页没关掉它（有人只用会话菜单那一行，觉得横幅上碍眼）。
             * 只停止 / 关闭提醒这些按钮**不受影响**。
             */
            (hasExportTool() && uiConfig.bannerDraft)
              ? (fromGuard
                ? button('action.draft', 'Draft handover', draftOnly, true)
                : button('action.stopAndDraft', 'Stop + draft', stopAndDraft, true))
              : null,
          ),
        ),
        notice ? h('div', { className: 'dsh-loop-guard-notice' }, notice) : null,
      );
    }

    // #region 接手指令

    /**
     * 拼「接手指令」全文。
     *
     * 目标是**一步到位接手干活**，不是「先写一份交接文档」：
     *   - 前缀提示词 → 配置区决定（见 handover-prefill），注入在**最前面**，
     *     在设置页改它，不占输入框；
     *   - 素材怎么来 → **配置了导出工具**才落成一条新会话自己能跑的导出命令
     *     （用 `-o` 写进当前工作目录，避开跨目录写触发的沙箱提权）；
     *     没配置时这段整个不出现，指令照样成立（新会话靠「读素材抓重点」
     *     的方法论与上下文线索接手，只是少一条现成命令）；
     *   - 读完素材 → **直接接着把任务做完**，不产出交接文档这种中间物；
     *   - 汇报方式 → 边做边简短汇报，不要憋到最后才吭声。
     *
     * @param sessionId - 被交接的旧会话。
     * @param title - 旧会话标题（可能是空串）。
     */
    function buildHandoverPrompt(sessionId, title) {
      const short = shortSessionId(sessionId);
      const name = title && title.trim() !== '' ? title.trim() : '（无标题）';
      const prefill = getPrefillText();
      const lines = [];
      if (prefill !== '') lines.push(prefill, '');
      lines.push(`上一个会话（${name}，ID ${sessionId}）需要交接给你。`);
      if (hasExportTool()) {
        lines.push(
          '',
          '第一步，执行这条命令，把旧会话导出成可读素材（brief 档约 2~3 万 token）：',
          '',
          '```powershell',
          "$env:PYTHONIOENCODING='utf-8'",
          `& "${exportToolPath}" export ${short} --detail brief -o ".\\旧会话素材-${short}.md"`,
          '```',
          '',
          '> `-o` 把素材写进**当前工作目录**（不指定的话它会写到 DSH工具 目录，',
          '> 跨目录写会被沙箱拦下来问一次权限 —— 用 `-o` 就没这麻烦）。',
          '',
          '它会打印导出文件的绝对路径。读那个文件，然后**直接把这个任务接着做完**。',
          '',
        );
      } else {
        lines.push(
          '',
          '这个会话的上文需要你自己找：根据任务性质，检查相关的工作目录、产物文件与记忆库线索，',
          '把已完成的部分弄清楚后**直接接着做**。',
          '',
        );
      }
      lines.push(
        '素材里要抓的重点：',
        '1. 任务目标到底是什么（以使用者自己的话为准）',
        '2. 已经做完到哪一步、产出文件在哪',
        '3. 关键文件与路径',
        '4. 踩过的坑与已验证的结论（**别重复踩**）',
        '5. 还剩什么没做（含不确定项）',
        '',
        '注意：素材里标注了"打转"的部分（会话记录或导出文件里会有这类标记），其结论不可信，',
        '只能当作"试过什么"的线索，',
        '你要自己判断哪些结论站得住 —— **但不要因此停下来问我，自己判断后往下做**。',
        '',
        '工作方式：**边做边简短汇报**（每完成一个有意义的步骤说一句在做什么、结果如何），',
        '不要闷头干到最后才出声；也不要用长篇报告打断节奏。',
        '',
        '不要写"交接文档"这类中间产物，除非这个任务本身需要那个文件。',
        '确实卡住、或需要我拿主意时才问我。',
      );
      return lines.join('\n');
    }


    // #region 待交接登记表
    /**
     * 「哪个会话还带着一条待注入的交接指令」的登记表（内存主存）。
     *
     * 2026-10-17 起它不再驱动「预填输入框」，而是驱动两件事：
     *   - 胶囊（HandoverDock）的显隐；
     *   - 注入器（armInjector）第一次发送时拼指令。
     * localStorage（PENDING_KEY）只存最近一条，用于刷新页面后恢复。
     */
    const pendingHandovers = new Map();

    // #endregion

    // #region 交接主流程

    /**
     * 当前 Client context 的落点。
     *
     * 组件在 `apply` 之前就定义了，而组件的事件回调需要一个 ctx；
     * 用这个引用在 `apply` 时补上，避免把 ctx 塞进 slot 的 inject face
     * （inject face 是给「投影后的数据」用的，塞服务进去会绕开它的契约）。
     */
    const ctxRef = { current: null };

    /** 简易提示条：插到 body 上，几秒后自己消失。 */
    function toast(message) {
      if (typeof document === 'undefined') return;
      try {
        const el = document.createElement('div');
        el.textContent = message;
        el.setAttribute('role', 'status');
        el.style.cssText = [
          'position:fixed',
          'left:50%',
          'bottom:88px',
          'transform:translateX(-50%)',
          'z-index:2147483000',
          'max-width:min(560px,80vw)',
          'padding:10px 14px',
          'border-radius:10px',
          'font-size:13px',
          'line-height:20px',
          'color:var(--dsw-alias-label-primary,#e8e8e8)',
          'background:var(--dsw-alias-bg-elevated,rgba(32,33,36,.96))',
          'border:1px solid var(--dsw-alias-line-secondary,rgba(255,255,255,.14))',
          'box-shadow:0 8px 24px rgba(0,0,0,.32)',
          'pointer-events:none',
        ].join(';');
        document.body.appendChild(el);
        window.setTimeout(() => {
          el.remove();
        }, 4200);
      } catch {
        // 提示失败不影响主流程。
      }
    }

    /**
     * 交接总流程。**唯一一处实现**，菜单项与自检都调它。
     *
     * @param ctx - Client Cordis context。
     * @param sessionId - 被交接的会话。
     * @param title - 该会话的显示标题。
     */
    async function runHandover(ctx, sessionId, title) {
      const t = ctx.locale.bind(NS);
      const uiWorkspace = ctx.get('uiWorkspace');
      const sessions = ctx.get('sessions');
      if (uiWorkspace === undefined) {
        toast(t('handover.noWorkspace'));
        return { ok: false, reason: 'no-ui-workspace' };
      }

      // ---- 1. 找原会话所在的工作区 ----
      const workspaceId = WorkspaceLookup.workspaceOfSession(sessionId);
      if (workspaceId === undefined) {
        toast(t('handover.noWorkspace'));
        return { ok: false, reason: 'no-workspace' };
      }

      const prompt = buildHandoverPrompt(sessionId, title);
      let newSessionId;
      try {
        newSessionId = await uiWorkspace.connectWorkspace(workspaceId);
      } catch (error) {
        toast(`${t('handover.connectFailed')} (${error instanceof Error ? error.message : String(error)})`);
        return { ok: false, reason: 'connect-failed' };
      }
      if (newSessionId === undefined || newSessionId === null) {
        return { ok: false, reason: 'no-session-id' };
      }

      uiWorkspace.openSession(newSessionId);

      // ---- 3. 隐藏注入：指令不再预填进输入框 ----
      //
      // **不再把指令预填进输入框**（那会占满输入框，使用者没法写自己的话）。
      // 改为：
      //   a) 在登记表里记下「这个会话有一条待注入的交接指令」；
      //   b) composer 上方显示一个蓝色胶囊「已经进入交接对话」（HandoverBadge）；
      //   c) 使用者在输入框里**继续写自己的提示词**；
      //   d) 第一次发送时（send/queue/steer 都算），注入器把隐藏指令拼在实际
      //      发送内容**前面**，然后销掉登记项、胶囊消失。
      // localStorage 兜底：刷新页面后胶囊靠它恢复（helper 挂载时读）。
      try {
        window.localStorage.setItem(PENDING_KEY, JSON.stringify({ sessionId: newSessionId, prompt }));
      } catch (error) {
        warn('登记待注入交接指令失败', error);
      }
      pendingHandovers.set(newSessionId, prompt);
      // 广播：目标会话的胶囊（可能早就挂载着 —— connectWorkspace 复用空白会话）
      // 收到通知立刻显示，不依赖组件重挂载。
      notifyPendingHandover();

      // ---- 4. 标题精修 ----
      //
      // 标题 fallback 已经会给出「交接对话：<你的原话>」（注入段头带来的，见
      // HANDOVER_TITLE_PREFIX）。这里再精修一次，改成**带旧会话标题**的版本 ——
      // 因为「接手哪个任务」用旧标题最准确：数字后缀（"xxx 2"）看不出任务内容，
      // 而旧标题就是那个任务的浓缩描述。
      //
      // 失败就静默：fallback 那个标题已经够看，不因此中断交接。
      const source = title && String(title).trim() !== '' ? String(title).trim() : '';
      const refined = source !== ''
        ? `${HANDOVER_TITLE_PREFIX}${source}`
        : t('handover.titleDefault');
      renameHandoverSession(ctx, newSessionId, refined).then((ok) => {
        if (ok) toast(t('handover.renamed').replace('{title}', refined));
      });

      toast(t('handover.prefilled'));
      return { ok: true, sessionId: newSessionId, mode: 'armed' };
    }

    // #endregion

    // #region 隐藏注入器（2026-10-17：接手指令不再进输入框）
    /**
     * 「待注入交接指令」登记表与发送拦截。
     *
     * 数据面：
     *   - `pendingHandovers`（Map<sessionId, prompt>）是**内存主存**；
     *   - `PENDING_KEY`（localStorage）存同一份，刷新页面后胶囊与注入靠它恢复。
     *     只存一条（最近一次交接）：一次交接 = 一个新会话，旧指令若没发送就作废。
     *
     * 注入面：包装 binding.session.prompt —— 使用者的文字原样进队列，我们在
     * 内容数组**最前面**拼上隐藏指令（同为 text block，宿主原样透传）。
     * 只包一次（`HANDOVER_INJECT_MARK` 防重入）；注入后销登记 + 清 localStorage。
     */
    const PENDING_KEY = 'dsh-loop-watcher:pending-handover';
    const HANDOVER_INJECT_MARK = '__dsh_loop_watcher_injected__';

    /**
     * 登记表订阅器：登记/恢复/清除都广播一次，胶囊组件订阅它刷新显隐。
     *
     * **为什么要订阅而不是靠组件自身重渲染**：`connectWorkspace` 会**复用已存在的
     * 空白会话**（实测 2026-10-17），那个会话的 HandoverDock 早就挂载着，
     * `[sessionId]` 依赖不变、挂载 effect 不会重跑 —— 交接后胶囊永远不出现。
     * 有了这条推送，挂载着也没关系：登记一发生，组件立刻收到通知。
     */
    const pendingHandoverListeners = new Set();

    function notifyPendingHandover() {
      for (const listener of [...pendingHandoverListeners]) {
        try {
          listener();
        } catch (error) {
          warn('胶囊订阅回调失败', error);
        }
      }
    }

    /** 从 localStorage 恢复登记（页面刷新后调一次）。返回是否恢复了一条。 */
    function restorePendingHandover() {
      try {
        const raw = window.localStorage.getItem(PENDING_KEY);
        if (raw === null) return false;
        const stored = JSON.parse(raw);
        if (stored === null || typeof stored !== 'object') return false;
        if (typeof stored.sessionId !== 'string' || typeof stored.prompt !== 'string') return false;
        if (stored.sessionId === '' || stored.prompt === '') return false;
        const existed = pendingHandovers.has(stored.sessionId);
        pendingHandovers.set(stored.sessionId, stored.prompt);
        if (!existed || pendingHandovers.get(stored.sessionId) !== stored.prompt) notifyPendingHandover();
        return true;
      } catch {
        return false;
      }
    }

    /** 某会话是否带着待注入的交接指令（胶囊渲染用）。 */
    function hasPendingHandover(sessionId) {
      return typeof sessionId === 'string' && pendingHandovers.has(sessionId);
    }

    /** 清掉某会话的登记（内存 + localStorage）。 */
    function clearPendingHandover(sessionId) {
      const existed = pendingHandovers.delete(sessionId);
      try {
        const raw = window.localStorage.getItem(PENDING_KEY);
        if (raw !== null) {
          const stored = JSON.parse(raw);
          if (stored && stored.sessionId === sessionId) window.localStorage.removeItem(PENDING_KEY);
        }
      } catch {
        // localStorage 不可用就只清内存。
      }
      if (existed) notifyPendingHandover();
    }

    /**
     * 给会话的 `session.prompt` 挂上注入器。
     *
     * 时机：胶囊挂载时（HandoverDock 的 effect）。包装层做的事：
     *   1. 若这次调用已经带注入标记 → 直接放行（我们自己的合并调用）；
     *   2. 第一次真实调用 → 把隐藏指令作为首个 text block 拼进 content，
     *      打上标记再调原方法（防我们拼的这条再次被拦）；
     *   3. 注入动作本身成功后销登记 —— 不管 prompt 调用结果如何（内容已经
     *      进入队列/会话，重注入反而会重复）。
     * `queue` / `steer` 两种投递模式都走 session.prompt，所以都被覆盖。
     *
     * **段落结构**：
     *   第一段 = 交接指令全文；
     *   第二段 = `用户追加：` 段头 + 使用者自己写的文字。
     * 原来把用户文字直接作为下一个 text block 贴上，两段糊在一起分不清谁是谁。
     */
    function armInjector(binding, sessionId) {
      const session = binding ? binding.session : undefined;
      if (session === undefined || typeof session.prompt !== 'function') return false;
      const plain = session;
      // 已 arm 过（标记是 boolean，无论 true/false）就不再包第二层 —— 双层包装
      // 不会出错（外层注入后打标记，内层看到标记直接放行），但没有意义，还会
      // 让「第二次发送不再注入」依赖内外层配合。这里直接幂等返回。
      if (typeof plain[HANDOVER_INJECT_MARK] === 'boolean') return true;
      const original = session.prompt.bind(session);
      session.prompt = function patchedPrompt(content, mode, signal, requestId) {
        if (plain[HANDOVER_INJECT_MARK] === true) {
          return original(content, mode, signal, requestId);
        }
        const text = pendingHandovers.get(sessionId);
        if (typeof text !== 'string' || text === '') {
          return original(content, mode, signal, requestId);
        }
        plain[HANDOVER_INJECT_MARK] = true;
        const blocks = Array.isArray(content) ? content : [];
        /**
         * 段头是**主路径**，不是装饰：DSH 的标题 fallback 取「第一条人类消息的
         * 开头几个词」。指令拼在最前面，所以开头必须是 `交接对话：`，
         * 否则标题会变成「【交接模式】你现在接手的是」这种没人认得的东西。
         *
         * 你自己写的话接着写在 `用户追加：` 段里，于是 fallback 标题读起来就是
         * 「交接对话：<你写的那句话>」—— 已经够用了；rename 再把它精修成
         * 「交接对话：<旧会话标题>」。两条路谁成都不影响标题能看。
         */
        const merged = [{ type: 'text', text: `${HANDOVER_TITLE_PREFIX}\n${text}` }];
        // 使用者自己写的文字：所有 text block 合成一段，段头固定「用户追加：」。
        // 空草稿/纯附件时不加这一段（不留一个空段头）。
        let userText = '';
        for (const block of blocks) {
          if (block && block.type === 'text' && typeof block.text === 'string') {
            userText += (userText === '' ? '' : '\n') + block.text;
          }
        }
        if (userText.trim() !== '') merged.push({ type: 'text', text: `\n用户追加：${userText}` });
        // 附件等非文本块保持原顺序（不与文字混排）。
        for (const block of blocks) {
          if (block && block.type === 'text') continue;
          merged.push(block);
        }
        clearPendingHandover(sessionId);
        return original(merged, mode, signal, requestId);
      };
      plain[HANDOVER_INJECT_MARK] = false;
      return true;
    }

    /**
     * 给交接出来的新会话取一个像样的标题。
     *
     * **为什么不直接靠它**：`rename` 走 Host 的 `sessionController.rename`
     * （`sessions.binding(id).session.rename()`），可能因为会话还没激活、连接
     * 未就绪而失败。所以它只是**精修**：真正的标题已经由注入段头的
     * `HANDOVER_TITLE_PREFIX` 兜住（DSH 的标题 fallback 取第一条消息的开头词）。
     *
     * 顺序：先精修，失败也不报错 —— fallback 那个标题已经够用。
     *
     * @param ctx - Client Cordis context。
     * @param sessionId - 新会话。
     * @param title - 想要的标题。
     */
    async function renameHandoverSession(ctx, sessionId, title) {
      try {
        const sessions = ctx ? ctx.get('sessions') : undefined;
        const binding = sessions && typeof sessions.binding === 'function'
          ? sessions.binding(sessionId)
          : undefined;
        const session = binding ? binding.session : undefined;
        if (session === undefined || typeof session.rename !== 'function') return false;
        const result = session.rename(title);
        if (result && typeof result.then === 'function') await result;
        return true;
      } catch (error) {
        warn('重命名交接会话失败（标题已由 fallback 兜住）', error);
        return false;
      }
    }

    /**
     * 注入标记挂在 session 对象自己的属性位上 —— 判断用 `=== true / === false`，
     * undefined = 还没 arm 过。arm 后 session.prompt 是我们替换过的方法，
     * 其他代码（包括宿主 composer）调它都会先走到注入逻辑。
     */

    /** 胶囊文案兜底（ctx 未就绪或翻译缺键时用）。 */
    const BADGE_FALLBACK = { 'handover.badge': '已经进入交接对话', 'handover.badgeHint': '交接指令已就绪（不占输入框）——你输入的内容会以「用户追加」单独一段发出去' };
    // #endregion 隐藏注入器

    // #region 工作区查找

    /**
     * 当前工作区快照的落点。
     *
     * `useWorkspaces` 是 slot 的 standardProps（React hook），而 `runHandover`
     * 是普通异步函数、不能在 hook 外面调它。所以菜单项把快照同步存到这里，
     * 点下去时直接读 —— 菜单项是 root 作用域，一直挂着，快照是新鲜的。
     *
     * 快照形状（ui-workspace 的 WorkspacePicker 运行时源码核实过）：
     *   { items: WorkspaceView[], phase: 'pending' | 'ready' }
     */
    const WorkspaceLookup = {
      items: [],
      set(items) {
        this.items = Array.isArray(items) ? items : [];
      },
      /**
       * 找某个会话所在的工作区。
       *
       * 缓存是组件 effect 填的；菜单只能在渲染之后被点开，所以正常路径一定命中。
       * 若没命中（工作区快照还没就绪），如实报错，**不猜**一个工作区出来。
       *
       * @param sessionId - 目标会话。
       */
      workspaceOfSession(sessionId) {
        return this.findIn(this.items, sessionId);
      },
      findIn(items, sessionId) {
        for (const workspace of items) {
          if (!workspace || !Array.isArray(workspace.sessionIds)) continue;
          if (workspace.sessionIds.indexOf(sessionId) !== -1) return workspace.workspaceId;
        }
        return undefined;
      },
    };

    // #endregion

    // #region 菜单项

    /**
     * 菜单里的那一行。
     *
     * 只渲染一个 `role="menuitem"` 按钮：slot 目录明确说「any such button joins them」
     * （列表的键盘走查与焦点返还是读 DOM 的）。样式抄宿主行，只引用主题 token。
     */
    function HandoverRow(props) {
      const { sessionId, displayTitle, useMenuOpenState, useWorkspaces, t } = props;
      const [, setMenuOpen] = useMenuOpenState();
      const items = useWorkspaces((state) => state.items);
      const [busy, setBusy] = React.useState(false);

      // 把最新快照同步到模块作用域的查找器（见 WorkspaceLookup 的注释）。
      // 放在 effect 里而不是渲染中：渲染必须无副作用。
      React.useEffect(() => {
        WorkspaceLookup.set(items);
      }, [items]);

      const onSelect = React.useCallback(() => {
        setMenuOpen(false);
        setBusy(true);
        Promise.resolve(runHandover(ctxRef.current, sessionId, displayTitle)).finally(() => {
          setBusy(false);
        });
      }, [setMenuOpen, sessionId, displayTitle]);

      return h(
        'button',
        {
          type: 'button',
          role: 'menuitem',
          disabled: busy,
          onClick: onSelect,
          style: ROW_STYLE,
          onMouseEnter: (event) => {
            event.currentTarget.style.background = 'var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08))';
          },
          onMouseLeave: (event) => {
            event.currentTarget.style.background = 'transparent';
          },
        },
        busy ? t('handover.busy') : t('handover.label'),
      );
    }

    /**
     * 挂在 `conversation.input.dock` 的 helper（会话作用域）。
     *
     * 2026-10-17 起它做三件事（接手指令**不再预填进输入框**）：
     *   1. 挂载时若 localStorage 里有待注入登记而内存没有（刷新页面场景）→ 恢复；
     *   2. 给本会话的 `session.prompt` 挂注入器（第一次发送时把隐藏指令拼进内容）；
     *   3. 本会话有登记 → 渲染蓝色胶囊「已经进入交接对话」（输入框上方一条窄带，
     *      不占输入框本身）；注入完成后随登记消失。
     */
    function HandoverDock(props) {
      const { sessionId, inputActions, useSessions } = props;
      const [armed, setArmed] = React.useState(false);
      const [pending, setPending] = React.useState(() => hasPendingHandover(sessionId));

      // 登记表订阅：登记/清除/恢复都会广播到这里，胶囊即时显隐。
      // 这条是主刷新路径（connectWorkspace 复用空白会话时组件不会重挂载，
      // 只能靠推送）；sessionId 变化时的 useState 初值只是兜底。
      React.useEffect(() => {
        const listener = () => setPending(hasPendingHandover(sessionId));
        pendingHandoverListeners.add(listener);
        listener();
        return () => {
          pendingHandoverListeners.delete(listener);
        };
      }, [sessionId]);

      React.useEffect(() => {
        if (typeof sessionId !== 'string') return;
        // 刷新页面恢复：localStorage 有、内存没有 → 收回内存（广播会带刷新胶囊）。
        restorePendingHandover();

        // arm 注入器：binding 可能晚一点才有，重试几次。
        let cancelled = false;
        let timer = null;
        const sessions = ctxRef.current ? ctxRef.current.get('sessions') : undefined;
        const attempt = (triesLeft) => {
          if (cancelled) return;
          if (hasPendingHandover(sessionId)) {
            const binding = sessions ? sessions.binding(sessionId) : undefined;
            if (armInjector(binding, sessionId)) {
              setArmed(true);
              return;
            }
          }
          if (triesLeft > 0) timer = window.setTimeout(() => attempt(triesLeft - 1), 120);
        };
        attempt(20);

        return () => {
          cancelled = true;
          if (timer !== null) window.clearTimeout(timer);
        };
      }, [sessionId]);

      // 保留 prop 引用检查：inputActions 不再用于预填，但它的存在代表输入面已就绪。
      void inputActions;
      void useSessions;

      if (!pending) return null;
      return h('div', { className: 'dsh-lw-handover-badge', role: 'status' },
        h('span', { className: 'dsh-lw-handover-badge-dot', 'aria-hidden': true }),
        t_safe(ctxRef.current, 'handover.badge'),
        h('span', { className: 'dsh-lw-handover-badge-hint' }, t_safe(ctxRef.current, 'handover.badgeHint')),
      );
    }

    /** 设置页/胶囊共用的安全翻译：ctx 还没就绪时回退中文文案。 */
    function t_safe(ctx, key) {
      try {
        const bind = ctx ? ctx.locale.bind(NS) : null;
        return bind ? bind(key) : (BADGE_FALLBACK[key] ?? zh[key] ?? key);
      } catch {
        return BADGE_FALLBACK[key] ?? zh[key] ?? key;
      }
    }

    /** 宿主菜单行的观感：只引用 --dsw-alias-* token，不写死颜色。 */
    const ROW_STYLE = {
      display: 'block',
      width: '100%',
      textAlign: 'left',
      padding: '7px 12px',
      border: 'none',
      borderRadius: 6,
      background: 'transparent',
      color: 'var(--dsw-alias-label-primary,inherit)',
      font: 'inherit',
      fontSize: 13,
      lineHeight: '20px',
      cursor: 'pointer',
    };

    // #region 设置页（分组卡片式布局）
    /**
     * 一行「标题 + 说明 + 右侧控件」。
     *
     * 抽出来是因为四张卡都是这个结构，各写一遍容易走样（对齐、间距、可点区域）。
     * `control` 由调用方给（开关 / 数字 / 输入框），本组件只管排版。
     */
    function SettingsRow(props) {
      const { title, desc, control } = props;
      return h('div', { className: 'dsh-lw-settings-row' },
        h('div', { className: 'dsh-lw-settings-rowtext' },
          h('div', { className: 'dsh-lw-settings-rowtitle' }, title),
          desc ? h('div', { className: 'dsh-lw-settings-rowdesc' }, desc) : null,
        ),
        control ?? null,
      );
    }

    /**
     * 滑杆式开关（aria role=switch，圆钮在轨道里滑动）。
     *
     * 从 ON/OFF 文字按钮改成滑杆开关 ——
     * 与 DSH 自己的设置项观感一致。轨道与圆钮都走 --dsw-alias-* token，
     * 明暗主题各自成立；过渡用 transform，不触发重排。
     */
    function SettingsSwitch(props) {
      const { checked, onChange, ariaLabel } = props;
      return h('button', {
        type: 'button',
        role: 'switch',
        'aria-checked': checked ? 'true' : 'false',
        'aria-label': ariaLabel,
        className: 'dsh-lw-settings-slider',
        onClick: () => onChange(!checked),
      },
      h('span', { className: 'dsh-lw-settings-slider-knob', 'aria-hidden': true }));
    }

    /**
     * 「打转守望」设置页：四张分组卡片（横幅 / 计数徽章 / 交接 / 导出工具）。
     *
     * 保存策略：**即时保存**（改开关 / 失焦即写 localStorage + 内存），写失败时提示。
     */
    function SettingsSection(props) {
      const { t } = props;
      const [enabled, setEnabled] = React.useState(() => prefillConfig.enabled);
      // 未配置时 prefillConfig.text 已经是内置默认前缀（resolvePrefillConfig 的语义），
      // 所以这里直接用；空串就是「使用者明确清空过」，如实显示。
      const [text, setText] = React.useState(() => prefillConfig.text);
      const [exportPath, setExportPath] = React.useState(() => exportToolPath);
      const [bannerDraft, setBannerDraft] = React.useState(() => uiConfig.bannerDraft);
      const [countSevere, setCountSevere] = React.useState(() => severeThreshold());
      const [savedTick, setSavedTick] = React.useState(0);

      const commit = React.useCallback((patch) => {
        const next = patch ?? {};
        if (typeof next.enabled === 'boolean' || typeof next.text === 'string') {
          setPrefillConfig(
            typeof next.enabled === 'boolean' ? next.enabled : prefillConfig.enabled,
            typeof next.text === 'string' ? next.text : prefillConfig.text,
            true,
          );
        }
        if (typeof next.exportPath === 'string') {
          setExportToolPath(next.exportPath.trim());
          try {
            if (next.exportPath.trim() !== '') window.localStorage.setItem(EXPORT_TOOL_STORAGE_KEY, next.exportPath.trim());
            else window.localStorage.removeItem(EXPORT_TOOL_STORAGE_KEY);
          } catch (error) {
            warn('保存导出工具路径失败', error);
          }
        }
        if (typeof next.bannerDraft === 'boolean' || typeof next.countSevere === 'number') {
          setUiConfig({
            ...(typeof next.bannerDraft === 'boolean' ? { bannerDraft: next.bannerDraft } : {}),
            ...(typeof next.countSevere === 'number' ? { countSevere: next.countSevere } : {}),
          });
        }
        setSavedTick((value) => value + 1);
      }, []);

      /** 一张卡片：分组标题 + 内容。 */
      const card = (groupKey, ...children) => h('div', { className: 'dsh-lw-settings-card' },
        h('div', { className: 'dsh-lw-settings-group' }, t(groupKey)),
        ...children,
      );

      return h('div', { className: 'dsh-lw-settings' },
        h('div', { className: 'dsh-lw-settings-head' },
          h('div', { className: 'dsh-lw-settings-title' }, t('settings.title')),
          h('div', { className: 'dsh-lw-settings-desc' }, t('settings.desc')),
          savedTick > 0 ? h('span', { className: 'dsh-lw-settings-saved', role: 'status' }, t('settings.saved')) : null,
        ),

        // ---- 卡片一：横幅提醒 ----
        card('settings.groupNotify',
          h(SettingsRow, {
            title: t('settings.bannerDraftTitle'),
            desc: t('settings.bannerDraftDesc'),
            control: h(SettingsSwitch, {
              checked: bannerDraft,
              ariaLabel: t('settings.bannerDraftTitle'),
              onChange: (next) => {
                setBannerDraft(next);
                commit({ bannerDraft: next });
              },
            }),
          }),
        ),

        // ---- 卡片二：计数徽章 ----
        card('settings.groupCount',
          h(SettingsRow, {
            title: t('settings.countSevereTitle'),
            desc: t('settings.countSevereDesc'),
            control: h('div', { className: 'dsh-lw-settings-stepper' },
              h('button', {
                type: 'button',
                className: 'dsh-lw-settings-stepper-btn',
                'aria-label': `${t('settings.countSevereTitle')} −`,
                disabled: countSevere <= 1,
                onClick: () => {
                  const next = Math.max(1, countSevere - 1);
                  setCountSevere(next);
                  commit({ countSevere: next });
                },
              }, '−'),
              h('span', { className: 'dsh-lw-settings-stepper-value', role: 'status' },
                t('settings.countSevereHint').replace('{n}', String(countSevere))),
              h('button', {
                type: 'button',
                className: 'dsh-lw-settings-stepper-btn',
                'aria-label': `${t('settings.countSevereTitle')} +`,
                disabled: countSevere >= 99,
                onClick: () => {
                  const next = Math.min(99, countSevere + 1);
                  setCountSevere(next);
                  commit({ countSevere: next });
                },
              }, '+'),
            ),
          }),
        ),

        // ---- 卡片三：交接对话 ----
        card('settings.groupHandover',
          h(SettingsRow, {
            title: t('settings.prefillTitle'),
            desc: t('settings.prefillDesc'),
            control: h(SettingsSwitch, {
              checked: enabled,
              ariaLabel: t('settings.prefillToggle'),
              onChange: (next) => {
                setEnabled(next);
                commit({ enabled: next, text });
              },
            }),
          }),
          h('textarea', {
            className: 'dsh-lw-settings-textarea',
            value: text,
            placeholder: t('settings.prefillPlaceholder'),
            spellCheck: false,
            rows: 8,
            onChange: (event) => setText(event.target.value),
            onBlur: () => commit({ enabled, text }),
          }),
          h('div', { className: 'dsh-lw-settings-actions' },
            h('button', {
              type: 'button',
              className: 'dsh-lw-settings-btn',
              onClick: () => {
                setText(PREFILL_TEXT_DEFAULT);
                commit({ enabled, text: PREFILL_TEXT_DEFAULT });
              },
            }, t('settings.reset')),
          ),
        ),

        // ---- 卡片四：导出工具路径（可选）----
        card('settings.groupExport',
          h(SettingsRow, {
            title: t('settings.exportTitle'),
            desc: t('settings.exportDesc'),
          }),
          h('input', {
            className: 'dsh-lw-settings-input',
            type: 'text',
            value: exportPath,
            placeholder: t('settings.exportPlaceholder'),
            spellCheck: false,
            onChange: (event) => setExportPath(event.target.value),
            onBlur: () => commit({ exportPath }),
          }),
          // 2026-10-17 加：说明这一项不是遗留物，并给出上游守卫自带的候选脚本。
          // 只提示、不自动填 —— 上游那个脚本输出的是打转分析报告而非完整交接素材，
          // 自动填进去会让新会话拿到「跑通了但内容不对」的命令，比不填更难排查。
          h('div', { className: 'dsh-lw-settings-note' }, t('settings.exportNote')),
          h('div', { className: 'dsh-lw-settings-note dsh-lw-settings-hintpath' },
            t('settings.exportCandidate').replace('{path}', UPSTREAM_ANALYZER_HINT),
          ),
        ),
      );
    }

    /**
     * 设置页样式：分组卡片 + 滑杆开关 + 步进器。
     *
     * 全部引用 --dsw-alias-* token，明暗主题各自成立，不写死颜色。
     * 卡片给足圆角与内边距，组标题用小号弱化字 —— 与 DSH 自己的设置分区观感对齐。
     */
    const SETTINGS_STYLE = `
.dsh-lw-settings { display: flex; flex-direction: column; gap: 18px; padding: 20px 28px 32px; max-width: 760px; }
.dsh-lw-settings-head { align-items: baseline; display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 2px; }
.dsh-lw-settings-title { color: var(--dsw-alias-label-primary, inherit); font-size: 16px; font-weight: 500; line-height: 24px; }
.dsh-lw-settings-desc { color: var(--dsw-alias-label-tertiary, inherit); font-size: 12px; line-height: 18px; }
.dsh-lw-settings-saved { color: var(--dsw-alias-state-success-primary, #48bb78); font-size: 12px; line-height: 18px; }
/* 一张分组卡片：底色 + 圆角 + 分隔线，组内行距收紧。 */
.dsh-lw-settings-card {
  background: var(--dsw-alias-bg-layer-1, rgba(127,127,127,.05));
  border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.22));
  border-radius: var(--dsw-radius-lg, 10px);
  display: flex; flex-direction: column; gap: 14px; padding: 16px 18px;
}
.dsh-lw-settings-group {
  color: var(--dsw-alias-label-secondary, inherit);
  font-size: 12px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase;
}
.dsh-lw-settings-row { align-items: center; display: flex; gap: 16px; }
.dsh-lw-settings-rowtext { display: flex; flex: 1 1 auto; flex-direction: column; gap: 4px; min-width: 0; }
.dsh-lw-settings-rowtitle { color: var(--dsw-alias-label-primary, inherit); font-size: 14px; line-height: 22px; }
.dsh-lw-settings-rowdesc { color: var(--dsw-alias-label-tertiary, inherit); font-size: 12px; line-height: 18px; white-space: pre-wrap; }
/* 滑杆开关：轨道在关态是中性灰，开态填品牌色；圆钮**始终是实心白**，
   靠轨道颜色的反差来表示状态（原版圆钮
   用 label-primary，在暗色主题下是个没轮廓的白块，看不出「按到什么程度」）。 */
.dsh-lw-settings-slider {
  background: var(--dsw-alias-bg-module-platform, rgba(127,127,127,.24));
  border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.45));
  border-radius: 999px; cursor: pointer; flex: none;
  height: 22px; padding: 0; position: relative; transition: background .16s ease, border-color .16s ease; width: 40px;
}
.dsh-lw-settings-slider-knob {
  background: #ffffff;
  border-radius: 50%;
  box-shadow: 0 1px 3px rgba(0,0,0,.35);
  height: 16px; left: 2px; position: absolute; top: 2px;
  transition: transform .16s ease; width: 16px;
}
.dsh-lw-settings-slider[aria-checked="true"] {
  background: var(--dsw-alias-brand-primary, #4f8cff);
  border-color: var(--dsw-alias-brand-primary, #4f8cff);
}
.dsh-lw-settings-slider[aria-checked="true"] .dsh-lw-settings-slider-knob { transform: translateX(18px); }
.dsh-lw-settings-slider:hover { border-color: var(--dsw-alias-brand-primary, rgba(79,140,255,.55)); }
.dsh-lw-settings-slider:focus-visible {
  outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-brand-primary, #4f8cff));
  outline-offset: 2px;
}
/* 数字步进器：− N + */
.dsh-lw-settings-stepper { align-items: center; display: flex; flex: none; gap: 8px; }
.dsh-lw-settings-stepper-btn {
  background: var(--dsw-alias-bg-module-platform, rgba(127,127,127,.16));
  border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.4));
  border-radius: 6px; color: var(--dsw-alias-label-primary, inherit);
  cursor: pointer; font: inherit; font-size: 15px; height: 26px; line-height: 1; width: 26px;
}
.dsh-lw-settings-stepper-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.28)); }
.dsh-lw-settings-stepper-btn:disabled { cursor: not-allowed; opacity: .45; }
.dsh-lw-settings-stepper-value {
  color: var(--dsw-alias-label-secondary, inherit); font-size: 12px;
  min-width: 64px; text-align: center; white-space: nowrap;
}
/* 卡片内的补充说明（弱化小字，与输入框之间留一点呼吸空间）。 */
.dsh-lw-settings-note {
  color: var(--dsw-alias-label-tertiary, inherit);
  font-size: 12px; line-height: 18px;
  overflow-wrap: anywhere; white-space: pre-wrap;
}
/* 候选脚本路径：等宽 + 一格淡底，让它看起来「可以抄走」。 */
.dsh-lw-settings-hintpath {
  background: var(--dsw-alias-bg-module-platform, rgba(127,127,127,.12));
  border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.22));
  border-radius: var(--dsw-radius-md, 8px);
  color: var(--dsw-alias-label-secondary, inherit);
  font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  padding: 6px 10px;
}
.dsh-lw-settings-textarea {
  background: var(--dsw-alias-bg-module-platform, rgba(127,127,127,.12));
  border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.4));
  border-radius: var(--dsw-radius-md, 8px);
  box-sizing: border-box; color: var(--dsw-alias-label-primary, inherit);
  font: inherit; font-size: 13px; line-height: 20px; min-height: 120px;
  padding: 10px 12px; resize: vertical; width: 100%;
}
.dsh-lw-settings-textarea:focus { border-color: var(--dsw-alias-brand-primary, #4f8cff); outline: none; }
.dsh-lw-settings-input {
  background: var(--dsw-alias-bg-module-platform, rgba(127,127,127,.12));
  border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.4));
  border-radius: var(--dsw-radius-md, 8px);
  box-sizing: border-box; color: var(--dsw-alias-label-primary, inherit);
  font: inherit; font-size: 13px; height: 34px; line-height: 20px; padding: 0 12px; width: 100%;
}
.dsh-lw-settings-input:focus { border-color: var(--dsw-alias-brand-primary, #4f8cff); outline: none; }
.dsh-lw-settings-actions { display: flex; gap: 8px; }
.dsh-lw-settings-btn {
  background: transparent; border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.4));
  border-radius: 999px; color: var(--dsw-alias-label-secondary, inherit); cursor: pointer;
  font: inherit; font-size: 12px; line-height: 18px; padding: 3px 12px;
}
.dsh-lw-settings-btn:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.14)); }
/* 交接胶囊（2026-10-17）：composer 上方一条窄带，蓝底示「指令已就绪」。
   蓝色取品牌 token（与图二里文件 chip 同族）；hint 是暗一档的说明文字。 */
.dsh-lw-handover-badge {
  align-items: center;
  background: var(--dsw-alias-bg-layer-1, rgba(79,140,255,.08));
  border: 1px solid var(--dsw-alias-brand-primary, rgba(79,140,255,.55));
  border-radius: 999px;
  color: var(--dsw-alias-brand-primary, #4f8cff);
  display: flex;
  font-size: 13px;
  gap: 8px;
  line-height: 20px;
  margin: 0 0 6px;
  padding: 4px 14px;
  width: fit-content;
  max-width: 100%;
}
.dsh-lw-handover-badge-dot {
  background: var(--dsw-alias-brand-primary, #4f8cff);
  border-radius: 50%;
  flex: none;
  height: 7px;
  width: 7px;
}
.dsh-lw-handover-badge-hint {
  color: var(--dsw-alias-label-tertiary, inherit);
  font-size: 12px;
  font-weight: 400;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
`;
    // #endregion 设置页

    // #endregion

    const inject = ['slots', 'locale'];

    /**
     * 会话头右侧的「本对话已打断 N 次」徽章。
     *
     * 位置见 `COUNT_SLOT` / `COUNT_ORDER` 的注释：落在标题行最右（后台任务、模式选择器
     * 都在它左边）。放哪儿只由那两个常量决定，这里不管布局。
     *
     * 数据来源与横幅完全一致（都认 `source.kind === 'loop-guard'`），只是这里只数个数、
     * 不弹任何东西。0 次时**整个不渲染**，不给正常对话添视觉噪音。
     *
     * 点击 = 定位到最近一次打断处，复用横幅那套 `locateInChat`（nodeKey 优先、退到轮次）。
     */
    function LoopGuardCounter(props) {
      const { sessionId, t, useChat } = props;
      const snapshot = useChat((state) => state);
      const latest = React.useRef(null);
      latest.current = snapshot;

      // 初值直接读持久化那份：切到这个会话时若已经打断过，第一帧就显示出来，
      // 不用等 700ms 轮询（否则会闪一下「从无到有」）。
      const [count, setCount] = React.useState(() => countOf(sessionId));
      const [notice, setNotice] = React.useState('');
      const timers = React.useRef([]);

      /**
       * 演练模式（`localStorage['dsh-loop-guard:self-test'] = 'count'`）。
       *
       * 只在**渲染时**叠加一个演示值，**不写进记录** —— 演练完把键删掉刷新，
       * 真实计数原样回来。这样既能在 5 秒内看清徽章长什么样，又不会污染真实统计。
       */
      const selfTest = readSelfTest() === 'count';
      const shown = selfTest ? Math.max(count, COUNT_SELF_TEST) : count;
      /**
       * `locateLatest` 是 useCallback（依赖里没有 count），闭包会捕获**首次渲染**的 count。
       * 点它时需要知道「现在到底有没有可定位的打断」，所以另存一份 ref 读最新值。
       */
      const shownRef = React.useRef(shown);
      shownRef.current = shown;

      const later = React.useCallback((fn, delay) => {
        const id = window.setTimeout(() => {
          timers.current = timers.current.filter((item) => item !== id);
          fn();
        }, delay);
        timers.current.push(id);
      }, []);

      React.useEffect(() => () => {
        for (const id of timers.current) window.clearTimeout(id);
        timers.current = [];
      }, []);

      /** 轮询累计。三个要点：
       *   1) 只扫 seq，不反推轮次 —— 这条路径每 700ms 跑一次，要够便宜；
       *   2) 扫到空数组时**不动**记录 —— 历史被卸下时不能把计数抹掉；
       *   3) 只在数字真的变了才 setState，避免每 700ms 触发一次重渲染。
       */
      React.useEffect(() => {
        setCount(countOf(sessionId));
        const timer = window.setInterval(() => {
          const seqs = scanGuardSeqs(latest.current);
          if (seqs.length === 0) return;
          const next = mergeCount(sessionId, seqs);
          setCount((current) => (current === next ? current : next));
        }, NOTICE_POLL_MS);
        return () => window.clearInterval(timer);
      }, [sessionId]);

      /** 演练模式下顺带把「这是演示值」说清楚，免得使用者以为真被打断了 3 次。 */
      React.useEffect(() => {
        if (!selfTest) return;
        sayNotice(t, setNotice, later, 'count.selfTest');
      }, [later, selfTest, t]);

      const locateLatest = React.useCallback(() => {
        const found = findGuardNotices(latest.current);
        if (found.length === 0) {
          // 0 次（或历史还没加载出来）时没有可定位的目标，说清楚而不是静默。
          sayNotice(t, setNotice, later, shownRef.current > 0 ? 'count.locateFailed' : 'count.noTarget');
          return;
        }
        const ok = locateInChat(found[found.length - 1], later);
        sayNotice(t, setNotice, later, ok ? 'count.located' : 'count.locateFailed');
      }, [later, t]);

      const label = (key, fallback) => (typeof t === 'function' ? t(key) : fallback);
      // 阈值从设置来（默认 3），不再是写死的数字 —— 可在设置页调整。
      const level = countLevel(shown, severeThreshold());
      /**
       * 文案分三档：
       *   none   → 「本对话未被打断」（中性，证明插件活着、状态健康）
       *   mild   → 「本对话已打断 N 次」（warn 色）
       *   severe → 同上，悬停换成「建议换新会话」
       *
       * 0 次也显示是一个**刻意的设计决定**（2026-10-16 按实测反馈改）：
       * 原来 0 次什么都不渲染，结果使用者分不清「现在是健康的」与「插件根本没生效」——
       * 而这正是本次交付时真实卡住的地方。既然做的是「健康状态指示」，0 也是一条状态。
       */
      const template = level === 'none'
        ? label('count.labelHealthy', 'No interruptions yet')
        : label('count.label', 'Interruptions: {n}');
      const title = (level === 'severe'
        ? label('count.titleSevere', '')
        : level === 'mild'
          ? label('count.titleWarn', '')
          : label('count.title', 'This session looks healthy.')).replace('{n}', formatCount(shown));
      // 把 {n} 拆出来单独包一层，好让数字比两侧文字更显眼；模板里没有 {n} 就整段直出。
      const parts = template.split('{n}');
      const textNodes = parts.length === 2
        ? [
          h('span', { key: 'before' }, parts[0]),
          h('span', { key: 'count', className: 'dsh-loop-guard-badge-count' }, formatCount(shown)),
          h('span', { key: 'after' }, parts[1]),
        ]
        : [h('span', { key: 'text' }, template)];

      return h('span', { className: 'dsh-loop-guard-badge-wrap' },
        h('button', {
          type: 'button',
          className: 'dsh-loop-guard-badge',
          'data-level': level,
          ...(selfTest ? { 'data-self-test': 'true' } : {}),
          title,
          'aria-label': title,
          onClick: locateLatest,
        },
        h('span', { className: 'dsh-loop-guard-badge-dot', 'aria-hidden': true }),
        ...textNodes),
        notice ? h('span', { className: 'dsh-loop-guard-badge-notice', role: 'status' }, notice) : null,
      );
    }

    /** 徽章自己的提示语：3 秒后自动收掉（它只是个反馈，不该长期占位）。 */
    function sayNotice(t, setNotice, later, key) {
      try {
        setNotice(typeof t === 'function' ? t(key) : key);
      } catch {
        // 翻译失败不影响计数本身。
        return;
      }
      later(() => setNotice(''), 3000);
    }

    function apply(ctx) {
      ctxRef.current = ctx;
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-loop-watcher: dictionaries');

      // 导出工具路径：本页加载时解析一次（改 localStorage 后刷新页面即生效）。
      setExportToolPath(resolveExportTool());
      // 交接前缀：同样在加载时解析一次（设置页保存会同时更新内存与 localStorage）。
      {
        const resolved = resolvePrefillConfig();
        prefillConfig.enabled = resolved.enabled;
        prefillConfig.text = resolved.text;
      }
      // 界面偏好（计数阈值 / 横幅交接按钮）：同样在加载时解析一次。
      {
        uiConfig.countSevere = resolveCountSevere();
        uiConfig.bannerDraft = resolveBannerDraft();
      }
      // 待注入的交接指令：刷新页面后从 localStorage 收回内存（胶囊与注入都认它）。
      restorePendingHandover();

      if (typeof document !== 'undefined' && !document.getElementById(STYLE_ID)) {
        const style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = `${STYLE}\n${SETTINGS_STYLE}`;
        document.head.appendChild(style);
        ctx.effect(() => () => style.remove(), 'dsh-loop-watcher: styles');
      }

      ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
        name: 'conversation.input.dock',
        id: 'loop-guard-notify',
        order: 2,
        locale: NS,
        inject: (sessionId) => ({
          cancelSession: () => cancelSession(ctx, sessionId),
        }),
      }, LoopGuardBanner));

      // 「本对话已打断 N 次」徽章：挂到会话标题行**最右**（模式选择器与后台任务都在
      // headerActions 里，而 headerUtilities 整组在它右边，见 COUNT_SLOT 的注释）。
      ctx.slots.inject(COUNT_SLOT, () => ctx.slots.register({
        name: COUNT_SLOT,
        id: 'loop-guard-count',
        order: COUNT_ORDER,
        locale: NS,
      }, LoopGuardCounter));

      // ---- 交接功能的两条注册（合并自 dsh-session-handover）----
      // 2026-10-17 起改为**常驻注册**：未配置导出工具时交接照常可用
      // （指令不含导出命令，新会话靠指令里的方法论接手），
      // 只有横幅上的「生成交接指令」按钮仍按 hasExportTool() 显隐（按钮文案
      // 本来就是「生成指令」，没工具时给一条跑不通的命令没有意义）。
      ctx.slots.inject(MENU_SLOT, () => ctx.slots.register(
        {
          name: MENU_SLOT,
          id: MENU_ID,
          order: MENU_ORDER,
          locale: NS,
        },
        HandoverRow,
      ));

      // 隐形 helper：会话作用域，负责把登记好的草稿填进**那个会话**的输入框。
      // 这是预填的主路径（不依赖时序），见 pendingHandovers 的注释。
      ctx.slots.inject(DOCK_SLOT, () => ctx.slots.register(
        {
          name: DOCK_SLOT,
          id: DOCK_ID,
          order: DOCK_ORDER,
          locale: NS,
        },
        HandoverDock,
      ));

      // ---- 设置页（2026-10-17 新增）----
      // 一个 settings.section 就是一个独立设置页：侧边栏「设置」→ 左列「打转守望」。
      //
      // ⚠️ `label` 必须是**函数**（`() => t('nav')`），不能写字面量键名。
      // 2026-10-17 实测：写成字面量 'settings.nav' 时，侧栏会**直接把键名显示出来**
      // （使用者截图里那一行就是 `settings.nav`）—— slot 对 string 形态不做翻译。
      // 出货插件（模型 / 账户 / Agent 预设）三处全是 `label: () => t("nav")`。
      const t = ctx.locale.bind(NS);
      ctx.slots.inject(SETTINGS_SLOT, () => ctx.slots.register(
        {
          name: SETTINGS_SLOT,
          id: SETTINGS_ID,
          order: SETTINGS_ORDER,
          label: () => t('settings.nav'),
          locale: NS,
        },
        SettingsSection,
      ));
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
