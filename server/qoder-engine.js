/**
 * 引擎出口：统一由 Agent SDK 驱动对话执行。
 *
 *   server/qoder-session.js —— @qoder-ai/qoder-agent-sdk（SDK 底层经
 *   spawnQoderCLIProcess 钩子拉起 qoderclicn 进程，warm pool 预热）。
 *
 * 其余导出（getCliBackend / buildChildEnv 等）回落到 cli-runtime；
 * 方法用动态属性查找包装，保证运行时对 sdkEngine 的方法替换
 * （测试 mock、热更新）仍然生效。
 */
const runtime = require('./cli-runtime');
const sdkEngine = require('./qoder-session');

module.exports = Object.assign(Object.create(runtime), {
  runQoderCnCli(options) {
    return sdkEngine.runQoderCnCli(options);
  },
  runQoderCnCliStream(options) {
    return sdkEngine.runQoderCnCliStream(options);
  },
  /** 账号额度查询（控制协议，零 token）。返回 { ok, usage } 或 { ok:false, error }。 */
  loadAccountUsage(options) {
    return sdkEngine.loadAccountUsage(options);
  },
  /** 模型目录查询（含 credit 倍率 priceFactor）。返回 { ok, models } 或 { ok:false, error }。 */
  loadModelCatalog(options) {
    return sdkEngine.loadModelCatalog(options);
  },
});
