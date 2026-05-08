import { getUpdates } from "../api/api.js";
import { WeixinConfigManager } from "../api/config-cache.js";
import { SESSION_EXPIRED_ERRCODE, pauseSession, getRemainingPauseMs } from "../api/session-guard.js";
import { processOneMessage } from "../messaging/process-message.js";
import path from "node:path";
import { promises as fs } from "node:fs";
import { getSyncBufFilePath, loadGetUpdatesBuf, saveGetUpdatesBuf } from "../storage/sync-buf.js";
import { logger } from "../util/logger.js";
import { redactBody } from "../util/redact.js";

const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;
const MAX_CONSECUTIVE_FAILURES = 3;
const BACKOFF_DELAY_MS = 30_000;
const RETRY_DELAY_MS = 2_000;
/**
 * Long-poll loop: getUpdates -> normalize -> recordInboundSession -> dispatchReplyFromConfig.
 * Runs until abort.
 */
export async function monitorWeixinProvider(opts) {
    const { baseUrl, cdnBaseUrl, token, accountId, config, abortSignal, longPollTimeoutMs, setStatus, } = opts;
    const log = opts.runtime?.log ?? (() => { });
    const errLog = opts.runtime?.error ?? ((m) => log(m));
    const aLog = logger.withAccount(accountId);
    // channelRuntime comes from ctx.channelRuntime (ChannelGatewayContext) and provides
    // plugin-sdk commands + media save via the processMessageDeps bridge.
    // processOneMessage uses plugin-sdk standalone functions and handles missing commands gracefully.
    const channelRuntime = opts.channelRuntime ?? null;
    aLog.info(`channelRuntime: ${channelRuntime ? "available" : "not available"}`);
    const syncFilePath = getSyncBufFilePath(accountId);
    aLog.debug(`syncFilePath: ${syncFilePath}`);
    const previousGetUpdatesBuf = loadGetUpdatesBuf(syncFilePath);
    let getUpdatesBuf = previousGetUpdatesBuf ?? "";
    if (previousGetUpdatesBuf) {
        log(`[weixin] resuming from previous sync buf (${getUpdatesBuf.length} bytes)`);
        aLog.debug(`Using previous get_updates_buf (${getUpdatesBuf.length} bytes)`);
    }
    else {
        log(`[weixin] no previous sync buf, starting fresh`);
        aLog.info(`No previous get_updates_buf found, starting fresh`);
    }
    const configManager = new WeixinConfigManager({ baseUrl, token }, log);
    let nextTimeoutMs = longPollTimeoutMs ?? DEFAULT_LONG_POLL_TIMEOUT_MS;
    let consecutiveFailures = 0;
    while (!abortSignal?.aborted) {
        try {
            aLog.debug(`getUpdates: get_updates_buf=${getUpdatesBuf.substring(0, 50)}..., timeoutMs=${nextTimeoutMs}`);
            const resp = await getUpdates({
                baseUrl,
                token,
                get_updates_buf: getUpdatesBuf,
                timeoutMs: nextTimeoutMs,
            });
            aLog.debug(`getUpdates response: ret=${resp.ret}, msgs=${resp.msgs?.length ?? 0}, get_updates_buf_length=${resp.get_updates_buf?.length ?? 0}`);
            if (resp.longpolling_timeout_ms != null && resp.longpolling_timeout_ms > 0) {
                nextTimeoutMs = resp.longpolling_timeout_ms;
                aLog.debug(`Updated next poll timeout: ${nextTimeoutMs}ms`);
            }
            const isApiError = (resp.ret !== undefined && resp.ret !== 0) ||
                (resp.errcode !== undefined && resp.errcode !== 0);
            if (isApiError) {
                const isSessionExpired = resp.errcode === SESSION_EXPIRED_ERRCODE || resp.ret === SESSION_EXPIRED_ERRCODE;
                if (isSessionExpired) {
                    pauseSession(accountId);
                    const pauseMs = getRemainingPauseMs(accountId);
                    errLog(`weixin getUpdates: session expired (errcode ${SESSION_EXPIRED_ERRCODE}), pausing bot for ${Math.ceil(pauseMs / 60_000)} min`);
                    aLog.error(`getUpdates: session expired (errcode=${resp.errcode} ret=${resp.ret}), pausing all requests for ${Math.ceil(pauseMs / 60_000)} min`);
                    consecutiveFailures = 0;
                    await sleep(pauseMs, abortSignal);
                    continue;
                }
                consecutiveFailures += 1;
                errLog(`weixin getUpdates failed: ret=${resp.ret} errcode=${resp.errcode} errmsg=${resp.errmsg ?? ""} (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES})`);
                aLog.error(`getUpdates failed: ret=${resp.ret} errcode=${resp.errcode} errmsg=${resp.errmsg} response=${redactBody(JSON.stringify(resp))}`);
                if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
                    errLog(`weixin getUpdates: ${MAX_CONSECUTIVE_FAILURES} consecutive failures, backing off 30s`);
                    aLog.error(`getUpdates: ${MAX_CONSECUTIVE_FAILURES} consecutive failures, backing off 30s`);
                    consecutiveFailures = 0;
                    await sleep(BACKOFF_DELAY_MS, abortSignal);
                }
                else {
                    await sleep(RETRY_DELAY_MS, abortSignal);
                }
                continue;
            }
            consecutiveFailures = 0;
            setStatus?.({ accountId, lastEventAt: Date.now() });
            if (resp.get_updates_buf != null && resp.get_updates_buf !== "") {
                saveGetUpdatesBuf(syncFilePath, resp.get_updates_buf);
                getUpdatesBuf = resp.get_updates_buf;
                aLog.debug(`Saved new get_updates_buf (${getUpdatesBuf.length} bytes)`);
            }
            const list = resp.msgs ?? [];
            for (const full of list) {
                aLog.info(`inbound message: from=${full.from_user_id} types=${full.item_list?.map((i) => i.type).join(",") ?? "none"}`);
                const now = Date.now();
                setStatus?.({ accountId, lastEventAt: now, lastInboundAt: now });
                // allowFrom filtering is delegated to processOneMessage via the framework
                // authorization pipeline (resolveSenderCommandAuthorizationWithRuntime).
                const fromUserId = full.from_user_id ?? "";
                const cachedConfig = await configManager.getForUser(fromUserId, full.context_token);
                // Fallback saveMedia when channelRuntime.media is not available (external plugin).
                const saveMediaBuffer = channelRuntime?.media?.saveMediaBuffer ?? (async (buf, contentType, _direction, _maxBytes, filename) => {
                    const ext = filename ? path.extname(filename) : ".bin";
                    const tmpDir = path.join("/tmp", "openclaw-weixin-media", accountId);
                    await fs.mkdir(tmpDir, { recursive: true });
                    const filePath = path.join(tmpDir, `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
                    await fs.writeFile(filePath, Buffer.from(buf));
                    aLog.debug(`saveMedia fallback: saved to ${filePath}`);
                    return { mediaPath: filePath };
                });
                await processOneMessage(full, {
                    accountId,
                    config,
                    commands: channelRuntime?.commands,
                    saveMedia: saveMediaBuffer,
                    baseUrl,
                    cdnBaseUrl,
                    token,
                    typingTicket: cachedConfig.typingTicket,
                    log: opts.runtime?.log ?? (() => { }),
                    errLog,
                });
            }
        }
        catch (err) {
            if (abortSignal?.aborted) {
                aLog.info(`Monitor stopped (aborted)`);
                return;
            }
            consecutiveFailures += 1;
            errLog(`weixin getUpdates error (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}): ${String(err)}`);
            aLog.error(`getUpdates error: ${String(err)}, stack=${err.stack}`);
            if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
                errLog(`weixin getUpdates: ${MAX_CONSECUTIVE_FAILURES} consecutive failures, backing off 30s`);
                aLog.error(`getUpdates: ${MAX_CONSECUTIVE_FAILURES} consecutive failures, backing off 30s`);
                consecutiveFailures = 0;
                await sleep(30_000, abortSignal);
            }
            else {
                await sleep(2000, abortSignal);
            }
        }
    }
    aLog.info(`Monitor ended`);
}
function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
        const t = setTimeout(resolve, ms);
        signal?.addEventListener("abort", () => {
            clearTimeout(t);
            reject(new Error("aborted"));
        }, { once: true });
    });
}
//# sourceMappingURL=monitor.js.map