import {
  BarChartOutlined,
  CloudServerOutlined,
  LockOutlined,
  SafetyCertificateOutlined,
  UserOutlined,
} from '@ant-design/icons';
import { useModel } from '@umijs/max';
import { Button, Checkbox, Form, Input, message, Modal } from 'antd';
import React, { useState } from 'react';
import {
  changePassword,
  clearToken,
  getMe,
  getRememberedLogin,
  login,
  setRememberedLogin,
  setToken,
  type Me,
} from '@/services/qoderproxy';

const FEATURES = [
  {
    icon: <CloudServerOutlined />,
    title: '多账号统一接入',
    desc: 'PAT 加密存储，按权重与并发上限智能调度',
  },
  {
    icon: <SafetyCertificateOutlined />,
    title: '密钥级管控',
    desc: 'API Key 粒度的账号授权、配额与调用配置',
  },
  {
    icon: <BarChartOutlined />,
    title: '用量全链路可视',
    desc: '请求、Token、错误与耗时明细一目了然',
  },
];

const LoginPage: React.FC = () => {
  const { setInitialState } = useModel('@@initialState');
  const [loading, setLoading] = useState(false);
  // 首次渲染同步读取一次；仅作表单预填，不自动登录
  const [remembered] = useState(getRememberedLogin);
  // 强制首登改密：登录响应 mustChangePassword=true 时弹不可关闭的改密弹窗
  const [mustChangePw, setMustChangePw] = useState(false);
  const [pwUsername, setPwUsername] = useState('');
  const [pwRemember, setPwRemember] = useState(false);
  const [pwChanging, setPwChanging] = useState(false);
  const [pwForm] = Form.useForm<{ newPassword: string; confirm: string }>();

  // 登录收尾：管理员校验 → 记住凭据 → 跳转。直接登录与改密弹窗两条路径共用。
  const finishLogin = async (username: string, password: string | null, remember: boolean) => {
    let me: Me | undefined;
    try {
      const got = await getMe({ skipErrorHandler: true });
      if (got?.ok) me = got;
    } catch {
      /* 会话信息获取失败不阻断登录 */
    }
    // 非管理员账号：除 /me 外所有 /admin/* 接口均要求 admin 角色，
    // 放行只会造成"登录成功 → 全页 401 → 静默踢回"的循环，这里直接拦截并提示
    const role = me?.user?.role ?? me?.role;
    if (me?.ok && role && role !== 'admin') {
      clearToken();
      message.warning('该账号无控制台权限，请使用 admin 账号登录');
      return;
    }
    // 会话信息拿不到就别跳转：currentUser 为空会被 onPageChange 守卫
    // 立刻弹回登录页，表现为"登录成功却不跳转"
    if (!me) {
      clearToken();
      message.error('登录成功但会话信息获取失败，请重试');
      return;
    }
    setInitialState((s) => ({ ...s, currentUser: me }));
    // 仅在完整登录成功（含管理员校验通过）后更新记住的凭据
    setRememberedLogin(remember && password ? { username, password } : null);
    message.success('登录成功');
    // redirect 参数来自 getInitialState/onPageChange，值含生产 base 前缀（/ui），
    // 而 history.replace 会自动拼 base——先剥掉，避免 /ui/ui/... 双拼落到空白页
    const BASE = process.env.NODE_ENV === 'production' ? '/ui' : '';
    const raw = new URLSearchParams(window.location.search).get('redirect') || '';
    const stripped =
      BASE && (raw === BASE || raw.startsWith(`${BASE}/`))
        ? raw.slice(BASE.length) || '/'
        : raw;
    // 历史 bug 遗留的自我指涉 redirect（如 redirect=/ui/user/login）指向
    // 登录页自身，不能作为跳转目标，否则首击登录后又回到登录页
    const isLoginPage = (p: string) => p === '/user/login' || p === '/ui/user/login';
    const target =
      stripped.startsWith('/') && !stripped.startsWith('//') && !isLoginPage(stripped)
        ? stripped
        : '/dashboard';
    // 整页跳转而非 SPA history.replace：SPA 链路里 initialState 的
    // useState 批处理与 ProLayout onPageChange 守卫之间存在多层时序，
    // 实测偶发首击不跳转（自动测试 7 次中 3 次复现，flushSync 也不彻底）。
    // 整页加载走 getInitialState → fetchUserInfo 启动链路，完全确定；
    // 延迟 300ms 让「登录成功」提示可见。
    setTimeout(() => {
      window.location.replace(`${BASE}${target}`);
    }, 300);
  };

  const handleSubmit = async (values: {
    username: string;
    password: string;
    remember?: boolean;
  }) => {
    setLoading(true);
    try {
      const res = await login(values.username, values.password);
      if (!res.ok || !res.token) {
        message.error(res.error || '登录失败');
        return;
      }
      setToken(res.token);

      // 强制首登改密：仍在使用初始默认密码时先弹不可关闭的改密弹窗，
      // 改密成功后再走统一登录收尾（服务端 adminGuard 同步强制拦截）
      if (res.mustChangePassword) {
        setPwUsername(values.username);
        setPwRemember(Boolean(values.remember));
        pwForm.resetFields();
        setMustChangePw(true);
        return;
      }

      await finishLogin(values.username, values.password, Boolean(values.remember));
    } catch (error: any) {
      message.error(error?.response?.data?.error?.message || error?.message || '登录失败');
    } finally {
      setLoading(false);
    }
  };

  // 强制改密弹窗提交：成功后用新密码继续登录收尾
  const handleChangePw = async (values: { newPassword: string }) => {
    setPwChanging(true);
    try {
      await changePassword(pwUsername, values.newPassword);
      message.success('密码修改成功');
      setMustChangePw(false);
      await finishLogin(pwUsername, values.newPassword, pwRemember);
    } catch (error: any) {
      message.error(error?.response?.data?.error?.message || error?.message || '修改失败，请重试');
    } finally {
      setPwChanging(false);
    }
  };

  const brandMark = (
    <div className="flex items-center gap-3">
      <div
        className="flex h-11 w-11 items-center justify-center rounded-[12px] bg-white/15 text-xl font-bold text-white backdrop-blur"
        style={{ boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.25)' }}
      >
        Q
      </div>
      <div>
        <div className="text-[17px] font-semibold text-white">Qoder CLI Proxy</div>
        <div className="text-xs text-white/60">多账号网关控制台</div>
      </div>
    </div>
  );

  return (
    <div className="flex min-h-screen bg-[#f4f6fb]">
      {/* 左侧品牌区 */}
      <div
        className="relative hidden w-[44%] flex-col justify-between overflow-hidden p-12 lg:flex"
        style={{ background: 'linear-gradient(155deg, #4338ca 0%, #6d28d9 55%, #9333ea 100%)' }}
      >
        {/* 装饰光斑 */}
        <div className="pointer-events-none absolute -left-24 -top-24 h-80 w-80 rounded-full bg-white/10 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-32 -right-16 h-96 w-96 rounded-full bg-white/10 blur-3xl" />
        <div className="pointer-events-none absolute left-1/3 top-1/2 h-56 w-56 rounded-full bg-white/5 blur-2xl" />

        <div className="relative">{brandMark}</div>

        <div className="relative">
          <h1 className="text-3xl font-semibold leading-snug text-white">
            一个入口，
            <br />
            管理全部 Qoder 账号。
          </h1>
          <div className="mt-10 space-y-6">
            {FEATURES.map((f) => (
              <div key={f.title} className="flex items-start gap-4">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] bg-white/15 text-[17px] text-white backdrop-blur">
                  {f.icon}
                </div>
                <div>
                  <div className="text-[15px] font-medium text-white">{f.title}</div>
                  <div className="mt-0.5 text-[13px] leading-5 text-white/65">{f.desc}</div>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="relative text-xs text-white/50">
          OpenAI / Anthropic 兼容协议 · 本地部署 · 数据不出本机
        </div>
      </div>

      {/* 右侧表单区 */}
      <div className="flex flex-1 items-center justify-center px-6 py-10">
        <div className="w-full max-w-[400px]">
          {/* 窄屏时显示品牌 */}
          <div className="mb-8 flex justify-center lg:hidden">
            <div
              className="flex h-14 w-14 items-center justify-center rounded-[12px] text-2xl font-bold text-white"
              style={{ background: 'linear-gradient(135deg, #4f46e5, #9333ea)' }}
            >
              Q
            </div>
          </div>
          <div className="rounded-[10px] border border-gray-100/80 bg-white px-8 py-9 shadow-[0_8px_30px_rgba(79,70,229,0.10)]">
            <h2 className="text-xl font-semibold text-gray-900">欢迎回来</h2>
            <p className="mb-7 mt-1 text-sm text-gray-500">登录以管理 Qoder 网关</p>
            <Form
              onFinish={handleSubmit}
              size="large"
              requiredMark={false}
              initialValues={{
                username: remembered?.username,
                password: remembered?.password,
                remember: Boolean(remembered),
              }}
            >
              <Form.Item
                name="username"
                rules={[{ required: true, message: '请输入用户名' }]}
              >
                <Input
                  prefix={<UserOutlined className="text-gray-400" />}
                  placeholder="用户名"
                  autoComplete="username"
                />
              </Form.Item>
              <Form.Item
                name="password"
                rules={[{ required: true, message: '请输入密码' }]}
              >
                <Input.Password
                  prefix={<LockOutlined className="text-gray-400" />}
                  placeholder="密码"
                  autoComplete="current-password"
                />
              </Form.Item>
              <Form.Item name="remember" valuePropName="checked" className="mb-5">
                <Checkbox className="text-sm text-gray-500">记住密码</Checkbox>
              </Form.Item>
              <Form.Item className="mb-0 pt-1">
                <Button
                  type="primary"
                  htmlType="submit"
                  loading={loading}
                  block
                  style={{ background: 'linear-gradient(135deg, #4f46e5, #9333ea)' }}
                >
                  登录
                </Button>
              </Form.Item>
            </Form>
          </div>
          <p className="mt-5 text-center text-xs text-gray-400">
            账号由管理员在「用户密钥」页创建
          </p>
        </div>
      </div>

      {/* 强制首登改密弹窗：不可关闭，改密成功后才放行进入控制台 */}
      <Modal
        title="首次登录，请修改初始密码"
        open={mustChangePw}
        closable={false}
        maskClosable={false}
        keyboard={false}
        footer={null}
        width={420}
        centered
      >
        <p className="mb-4 mt-1 text-sm text-gray-500">
          当前账号仍在使用初始默认密码，为保障安全必须先设置新密码，才能继续使用控制台。
        </p>
        <Form form={pwForm} layout="vertical" onFinish={handleChangePw}>
          <Form.Item
            name="newPassword"
            label="新密码"
            rules={[
              { required: true, message: '请输入新密码' },
              { min: 8, message: '新密码至少 8 位' },
              {
                validator: (_rule, value: string | undefined) =>
                  value === 'admin123'
                    ? Promise.reject(new Error('新密码不能与初始默认密码相同'))
                    : Promise.resolve(),
              },
            ]}
          >
            <Input.Password placeholder="至少 8 位" autoComplete="new-password" />
          </Form.Item>
          <Form.Item
            name="confirm"
            label="确认新密码"
            dependencies={['newPassword']}
            rules={[
              { required: true, message: '请再次输入新密码' },
              ({ getFieldValue }) => ({
                validator(_rule, value: string | undefined) {
                  if (!value || value === getFieldValue('newPassword')) return Promise.resolve();
                  return Promise.reject(new Error('两次输入的密码不一致'));
                },
              }),
            ]}
          >
            <Input.Password placeholder="再次输入新密码" autoComplete="new-password" />
          </Form.Item>
          <Button
            type="primary"
            htmlType="submit"
            loading={pwChanging}
            block
            style={{ background: 'linear-gradient(135deg, #4f46e5, #9333ea)' }}
          >
            确认修改并进入控制台
          </Button>
        </Form>
      </Modal>
    </div>
  );
};

export default LoginPage;
