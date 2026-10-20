import type { Settings as LayoutSettings } from '@ant-design/pro-components';
import type { RequestConfig, RunTimeLayoutConfig } from '@umijs/max';
import { history } from '@umijs/max';
import { UserOutlined } from '@ant-design/icons';
import React from 'react';
import { message } from 'antd';
import { AvatarDropdown, ErrorBoundary, OfflineBanner } from '@/components';
import { clearToken, getMe, type Me } from '@/services/qoderproxy';
import defaultSettings from '../config/defaultSettings';
import { errorConfig } from './requestErrorConfig';

const loginPath = '/user/login';

/**
 * 会话空闲时长（与服务端 SESSION_IDLE_MINUTES 对齐）。
 * 服务端：30 分钟内无任何已认证请求即过期；客户端提前 1 分钟主动登出，
 * 抢在服务端 401 之前把用户送到登录页，避免请求报错噪音。
 */
const SESSION_IDLE_MS = 29 * 60 * 1000;

/**
 * 空闲自动登出守卫：只统计真实用户交互（点击/键盘/滚动/移动），
 * 页面自身的轮询请求不计入活动——用户离开电脑后到点即踢回登录页。
 */
const setupIdleSessionGuard = () => {
  if (typeof window === 'undefined') return;
  const w = window as typeof window & { __sessionIdleGuard?: boolean };
  if (w.__sessionIdleGuard) return;
  w.__sessionIdleGuard = true;

  let lastActivity = Date.now();
  const touch = () => {
    lastActivity = Date.now();
  };
  ['pointerdown', 'keydown', 'wheel', 'touchstart', 'pointermove'].forEach((event) => {
    window.addEventListener(event, touch, { passive: true });
  });

  setInterval(() => {
    const { pathname } = history.location;
    const onLogin = pathname === loginPath || pathname === `/ui${loginPath}`;
    if (!localStorage.getItem('qoder_proxy_token') || onLogin) return;
    if (Date.now() - lastActivity < SESSION_IDLE_MS) return;
    clearToken();
    message.info('登录已超时，请重新登录');
    history.replace(loginPath);
  }, 30 * 1000);
};

/**
 * history.location.pathname 在生产构建带 base 前缀（/ui/user/login），
 * 直接与 loginPath 严格比较永远不相等——登录页 boot 也会跑 /admin/me
 * （无 token 时 401 → 改写 URL 为 login?redirect=/ui/user/login 自我指涉，
 * 登录成功后读该参数会再次跳回登录页，即「首击不跳转、二击才跳」的根因）。
 */
const isLoginPath = (p: string) => p === loginPath || p === `/ui${loginPath}`;

/**
 * @see https://umijs.org/docs/api/runtime-config#getinitialstate
 * */
export async function getInitialState(): Promise<{
  settings?: Partial<LayoutSettings>;
  currentUser?: Me;
  fetchUserInfo?: () => Promise<Me | undefined>;
}> {
  setupIdleSessionGuard();

  const fetchUserInfo = async (): Promise<Me | undefined> => {
    try {
      const me = await getMe({ skipErrorHandler: true });
      if (me?.ok) return me;
      clearToken();
    } catch (_error) {
      clearToken();
    }
    const { pathname, search, hash } = history.location;
    if (!isLoginPath(pathname)) {
      history.replace(
        `${loginPath}?redirect=${encodeURIComponent(pathname + search + hash)}`,
      );
    }
    return undefined;
  };

  // 如果不是登录页面，校验会话
  if (!isLoginPath(history.location.pathname)) {
    const currentUser = await fetchUserInfo();
    return {
      fetchUserInfo,
      currentUser,
      settings: defaultSettings as Partial<LayoutSettings>,
    };
  }
  return {
    fetchUserInfo,
    settings: defaultSettings as Partial<LayoutSettings>,
  };
}

// ProLayout 支持的api https://procomponents.ant.design/components/layout
export const layout: RunTimeLayoutConfig = ({ initialState }) => {
  return {
    avatarProps: {
      title: initialState?.currentUser?.username || '管理员',
      icon: <UserOutlined />,
      style: {
        background: 'linear-gradient(135deg, #4f46e5, #9333ea)',
        color: '#fff',
        fontWeight: 600,
      },
      render: (_, avatarChildren) => <AvatarDropdown>{avatarChildren}</AvatarDropdown>,
    },
    footerRender: () => (
      <div className="flex items-center justify-center gap-2 pb-6 pt-1 text-xs text-gray-400">
        <span
          className="inline-block h-1.5 w-1.5 rounded-full"
          style={{ background: 'linear-gradient(135deg, #4f46e5, #9333ea)' }}
        />
        <span>Qoder CLI Proxy v{__APP_VERSION__} · 多账号网关控制台</span>
      </div>
    ),
    onPageChange: () => {
      const { location } = history;
      // 如果没有登录，重定向到 login。
      // 本地仍有 token 时不弹回：登录页提交 currentUser 与 SPA 导航之间
      // 存在时序窗口，守卫若只看 initialState 快照会把刚跳转的请求弹回。
      // 无效 token 由 getInitialState 的 fetchUserInfo 统一清理，此处
      // 只兜底「完全无凭据」的情况。
      if (
        !initialState?.currentUser &&
        !localStorage.getItem('qoder_proxy_token') &&
        !isLoginPath(location.pathname)
      ) {
        history.replace(
          `${loginPath}?redirect=${encodeURIComponent(location.pathname + location.search)}`,
        );
      }
    },
    // Replace ProLayout's default ErrorBoundary with our offline-aware version,
    // so chunk load errors show friendly messages instead of "Something went wrong."
    ErrorBoundary,
    menuHeaderRender: undefined,
    ...initialState?.settings,
  };
};

/**
 * @name request 配置，可以配置错误处理
 * 它基于 axios 提供了一套统一的网络请求和错误处理方案。
 * @doc https://umijs.org/docs/max/request#配置
 */
export const request: RequestConfig = {
  ...errorConfig,
};

export function rootContainer(container: React.ReactNode) {
  return (
    <>
      <OfflineBanner />
      <ErrorBoundary>{container}</ErrorBoundary>
    </>
  );
}
