/**
 * dsh-loop-watcher Host half。
 *
 * **Host 半刻意什么都不做。** 本插件的全部行为都在 Client 半，原因（合并自两个原插件）：
 *
 *   - 打转通知与计数：数据来自页面里的 `useChat` 快照（`assistant-step` 节点的推理块
 *     与上游注入的 `source.kind === 'loop-guard'` 消息），这两样只在浏览器里拿得到。
 *   - 中止当前回合：Client 服务 `ctx.sessions.binding(id).session.cancel()`。
 *   - 交接：新建会话与写草稿都是纯浏览器侧能力（`uiWorkspace` 服务 + localStorage）；
 *     「导出旧会话」刻意**不**由插件代劳，而是让新会话自己去跑导出命令（它手上有 pwsh），
 *     这样插件不必引入 Python 依赖、也不必用 node:zlib 重写一套 zstd + JSONL 解析。
 *
 * 静态安装的 bundle **拿不到** dynamic package 的 `harness.handle` / `host.call` 通道，
 * 所以也没有「client 调 host 自定义方法」这条路可走 —— 保留这个空壳只是让 bundle
 * patch 有一行可插入。
 */

export function apply() {
  // 无 Host 侧资源：全部行为都在 Client 半。
}
