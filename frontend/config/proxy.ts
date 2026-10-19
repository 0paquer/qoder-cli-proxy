/**
 * @name 本地开发代理
 * 开发时把 /admin、/v1 转发到本地 qoder-proxy 服务（默认端口见项目 .env 的 PORT）。
 * 生产环境（umi build）代理不生效，前端与代理服务同源部署，无需代理。
 */
const target = process.env.QODER_PROXY_PORT
  ? `http://127.0.0.1:${process.env.QODER_PROXY_PORT}`
  : 'http://127.0.0.1:13000';

export default {
  dev: {
    '/admin/': {
      target,
      changeOrigin: true,
    },
    '/v1/': {
      target,
      changeOrigin: true,
    },
  },
};
