import type { RequestOptions } from '@@/plugin-request/request';
import type { RequestConfig } from '@umijs/max';
import { history } from '@umijs/max';
import { message } from 'antd';
import { clearToken, getToken } from '@/services/qoderproxy';

const loginPath = '/user/login';

/**
 * @name 请求错误处理
 * 后端非 2xx 错误形如 {error:{message,type,code}}；401 时清 token 并跳登录。
 */
export const errorConfig: RequestConfig = {
  errorConfig: {
    errorHandler: (error: any, opts: any) => {
      if (opts?.skipErrorHandler) throw error;

      const status = error?.response?.status;
      if (status === 401) {
        clearToken();
        if (window.location.pathname !== loginPath) {
          history.replace(loginPath);
        }
        return;
      }

      const apiMessage =
        error?.response?.data?.error?.message ||
        (typeof error?.response?.data === 'string' ? error.response.data : undefined) ||
        error?.message;
      message.error(apiMessage || '请求失败，请重试');
    },
  },

  // 请求拦截器：附加 Bearer token
  requestInterceptors: [
    (config: RequestOptions) => {
      const token = getToken();
      if (token) {
        config.headers = { ...config.headers, Authorization: `Bearer ${token}` };
      }
      return config;
    },
  ],

  // 响应拦截器
  responseInterceptors: [],
};
