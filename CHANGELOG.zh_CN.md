# 变更日志

[English](CHANGELOG.md)

本项目遵循 [Keep a Changelog](https://keepachangelog.com/) 格式。

## [2.2.0] - 2026-05-08

### 修复

- **`ctx.channelRuntime` 在 external plugin 中不可用：** `ChannelGatewayContext.channelRuntime` 在 external plugin 的 `startAccount` 回调中不存在，导致入站消息无法路由和回复。已将 `process-message.js` 中所有 `channelRuntime.*` 方法调用替换为 plugin-sdk 独立函数（`resolveAgentRoute`、`recordInboundSession`、`createReplyDispatcherWithTyping`、`dispatchReplyFromConfigWithSettledDispatcher`、`finalizeInboundContext`、`resolveStorePath`、`resolveHumanDelayConfig`、`createTypingCallbacks`）。

### 变更

- **External plugin 架构：** `process-message.js` 不再依赖 `channelRuntime` 对象，而是通过 `deps` 接收独立 SDK 函数（`commands`、`saveMedia`）。当 `channelRuntime.media.saveMediaBuffer` 不可用时，monitor 提供文件系统兜底方案。
- **Runtime 兼容桩：** `runtime.ts` 现导出空函数桩（`setWeixinRuntime`、`getWeixinRuntime` 等），避免插件注册时导入报错。这些是遗留死代码，将在后续版本移除。
- **Monitor 启动：** 移除 `resolveWeixinChannelRuntime` 轮询兜底；monitor 不再等待全局 runtime。

### 新增

- **命令授权兜底：** 当 `deps.commands` 不可用时（external plugin 无完整 runtime），使用空 runtime 优雅跳过命令级授权。配对模式下的 DM 访问仍通过发送者白名单强制执行。

## [2.1.9] - 2026-04-20

### 新增

- **外发 hook 支持：** 为所有外发路径（`sendText`、`sendMedia`、`process-message` 中的入站回复 `deliver`）接入 `message_sending`（发送前拦截/修改）和 `message_sent`（发送后通知）hook。hook 逻辑抽取至共享模块 `src/messaging/outbound-hooks.ts`。

### 变更

- **清理：** 移除 `sendWeixinOutbound` 签名中未使用的 `mediaUrl` 参数。

## [2.1.8] - 2026-04-07

### 变更

- **Markdown 过滤器：** `StreamingMarkdownFilter` 放开了更多 Markdown 格式的保留。

## [2.1.7] - 2026-04-07

### 修复

- **插件注册重入：** `channel.ts` 中将 `monitorWeixinProvider` 改为在 `startAccount` 内部懒加载（`await import(...)`），避免插件注册阶段提前拉取 monitor → process-message → command-auth 依赖链，导致 plugin/provider registry 重入。
- **初始化副作用：** `process-message.ts` 中将 `resolveSenderCommandAuthorizationWithRuntime` / `resolveDirectDmAuthorizationOutcome` 改为懒加载，避免模块初始化时触发宿主的 `ensureContextWindowCacheLoaded` 副作用，进而导致 `loadOpenClawPlugins` 重入。

### 变更

- **tool-call 外发路径：** `sendWeixinOutbound` 现在对发送文本应用 `StreamingMarkdownFilter`，与 `process-message` 中的 model-output 路径保持一致。

## [2.1.4] - 2026-04-03

### 变更

- **扫码登录：** 移除 `get_bot_qrcode` 的客户端超时，请求不再因固定时限被 abort（仍受服务端与网络栈限制）。

## [2.1.3] - 2026-04-02

### 新增

- **`StreamingMarkdownFilter`**（`src/messaging/markdown-filter.ts`）：外发文本由原先 `markdownToPlainText` 整段剥离 Markdown，改为流式逐字符过滤；**对 Markdown 从完全不支持变为部分支持**。

### 变更

- **外发文本：** `process-message` 在每次 `deliver` 时用 `StreamingMarkdownFilter`（`feed` / `flush`）处理回复，替代 `markdownToPlainText`。

### 移除

- 从 `src/messaging/send.ts` 删除 **`markdownToPlainText`**（相关用例从 `send.test.ts` 迁至 `markdown-filter.test.ts`）。

## [2.1.2] - 2026-04-02

### 变更

- **登录后配置刷新：** 每次微信登录成功后，在 `openclaw.json` 中更新 `channels.openclaw-weixin.channelConfigUpdatedAt`（ISO 8601），让网关从磁盘重新加载配置；不再写入空的 `accounts: {}` 占位。
- **扫码登录：** `get_bot_qrcode` 客户端超时由 5s 调整为 10s。
- **文档：** 卸载说明改为使用 `openclaw plugins uninstall @tencent-weixin/openclaw-weixin`，与插件 CLI 一致。
- **日志：** `debug-check` 日志不再输出 `stateDir` / `OPENCLAW_STATE_DIR`。

### 移除

- **`openclaw-weixin` 子命令**（删除 `src/weixin-cli.ts` 及 `index.ts` 中的注册）。请使用宿主自带的 `openclaw plugins uninstall …` 卸载流程。

### 修复

- 解决在 **OpenClaw 2026.3.31 及更新版本**上安装插件时出现的 **dangerous code pattern** 提示（宿主插件安装 / 静态检查）。
