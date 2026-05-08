// This module is kept for backward compatibility. The Weixin plugin now uses
// plugin-sdk standalone functions and no longer calls these at runtime.

/** @deprecated No-op. Remove calls after verifying the plugin works without it. */
export function setWeixinRuntime() {}

/** @deprecated No-op. */
export function getWeixinRuntime() {
  throw new Error("Weixin runtime no longer used");
}

/** @deprecated No-op. */
export async function waitForWeixinRuntime() {
  throw new Error("Weixin runtime no longer used");
}

/** @deprecated No-op. */
export async function resolveWeixinChannelRuntime() {
  throw new Error("Weixin runtime no longer used");
}
