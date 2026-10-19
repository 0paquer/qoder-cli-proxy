import { CopyOutlined, EyeOutlined, PlusOutlined } from '@ant-design/icons';
import type { ActionType, ProColumns } from '@ant-design/pro-components';
import { ProTable } from '@ant-design/pro-components';
import {
  Alert,
  Button,
  Checkbox,
  Drawer,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  message,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import React, { useEffect, useRef, useState } from 'react';
import { PageHeader } from '@/components/QpCard';
import { fmtNum, fmtTime, parseDbTime } from '@/utils/format';
import {
  createUser,
  createUserKey,
  deleteUser,
  getQuota,
  getRuntimeDefaults,
  listAccounts,
  listGrants,
  listUserKeys,
  listUsers,
  revealUserKey,
  revokeKey,
  updateGrants,
  updateKeyRuntime,
  updateQuota,
  updateUser,
  type Account,
  type ApiKey,
  type GatewayUser,
  type RuntimeDefaults,
  type QuotaUsage,
} from '@/services/qoderproxy';

const UsersPage: React.FC = () => {
  const actionRef = useRef<ActionType>(undefined);

  // ── 用户创建 / 编辑 ────────────────────────────────────────────────────────
  const [userModalOpen, setUserModalOpen] = useState(false);
  const [editingUser, setEditingUser] = useState<GatewayUser | null>(null);
  const [savingUser, setSavingUser] = useState(false);
  const [userForm] = Form.useForm();

  // ── 密钥 Drawer ────────────────────────────────────────────────────────────
  const [keysUser, setKeysUser] = useState<GatewayUser | null>(null);
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [keysLoading, setKeysLoading] = useState(false);
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const [creatingKey, setCreatingKey] = useState(false);
  const [viewingKey, setViewingKey] = useState<{ name: string; key: string } | null>(null);
  const [viewingKeyId, setViewingKeyId] = useState<number | null>(null);
  const [keyForm] = Form.useForm();

  // ── 密钥调用配置 Modal ─────────────────────────────────────────────────────
  const [runtimeKey, setRuntimeKey] = useState<ApiKey | null>(null);
  const [runtimeSaving, setRuntimeSaving] = useState(false);
  const [runtimeForm] = Form.useForm();
  // 调用配置的当前生效默认值，用于表单预填
  const [runtimeDefaults, setRuntimeDefaults] = useState<RuntimeDefaults | null>(null);

  // ── 授权 Modal ─────────────────────────────────────────────────────────────
  const [grantUser, setGrantUser] = useState<GatewayUser | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [grantIds, setGrantIds] = useState<number[]>([]);
  const [grantSaving, setGrantSaving] = useState(false);
  const [grantLoading, setGrantLoading] = useState(false);

  // ── 配额 Modal ─────────────────────────────────────────────────────────────
  const [quotaUser, setQuotaUser] = useState<GatewayUser | null>(null);
  const [quotaUsage, setQuotaUsage] = useState<QuotaUsage | null>(null);
  const [quotaSaving, setQuotaSaving] = useState(false);
  const [quotaLoading, setQuotaLoading] = useState(false);
  const [quotaForm] = Form.useForm();

  const reload = () => actionRef.current?.reload();

  const openCreate = () => {
    setEditingUser(null);
    userForm.setFieldsValue({ username: '', password: '', role: 'user' });
    setUserModalOpen(true);
  };

  const openEdit = (user: GatewayUser) => {
    setEditingUser(user);
    userForm.setFieldsValue({ username: user.username, role: user.role, password: '' });
    setUserModalOpen(true);
  };

  const handleSaveUser = async () => {
    setSavingUser(true);
    try {
      const values = await userForm.validateFields();
      if (editingUser) {
        const body: { role?: string; password?: string } = { role: values.role };
        if (values.password) body.password = values.password;
        await updateUser(editingUser.id, body);
        message.success('用户已更新');
      } else {
        await createUser(values);
        message.success('用户已创建');
      }
      setUserModalOpen(false);
      reload();
    } catch (error: any) {
      if (error?.errorFields) return; // 表单校验失败已内联标红，不额外弹错
      message.error(error?.message || '保存失败');
    } finally {
      setSavingUser(false);
    }
  };

  // ── 密钥 ───────────────────────────────────────────────────────────────────
  const loadKeys = async (userId: number) => {
    setKeysLoading(true);
    try {
      const res = await listUserKeys(userId);
      setKeys(res.keys);
    } catch (error: any) {
      // 兜底提示：调用处（openKeys/创建/吊销后刷新）不再单独接，避免 unhandled rejection
      message.error(error?.message || '密钥列表加载失败');
    } finally {
      setKeysLoading(false);
    }
  };

  const openKeys = (user: GatewayUser) => {
    setKeysUser(user);
    setCreatedKey(null);
    const d = runtimeDefaults;
    keyForm.setFieldsValue({
      name: '默认密钥',
      expiresInDays: 30,
      baseUrl: d?.baseUrl || undefined,
      reasoningEffort: d?.reasoningEffort ?? undefined,
      contextWindow: d?.contextWindow ?? undefined,
      maxOutputTokens: d?.maxOutputTokens ?? undefined,
      timeoutMs: d?.timeoutMs ?? undefined,
    });
    loadKeys(user.id);
  };

  const handleCreateKey = async () => {
    if (!keysUser || creatingKey) return;
    setCreatingKey(true);
    try {
      const values = await keyForm.validateFields();
      const res = await createUserKey(keysUser.id, {
        name: values.name,
        expiresInDays: values.expiresInDays ?? 0,
        runtime: {
          baseUrl: values.baseUrl || undefined,
          reasoningEffort: values.reasoningEffort || undefined,
          contextWindow: values.contextWindow ?? undefined,
          maxOutputTokens: values.maxOutputTokens ?? undefined,
          timeoutMs: values.timeoutMs ?? undefined,
        },
      });
      setCreatedKey(res.apiKey.key);
      loadKeys(keysUser.id);
      reload();
    } catch (error: any) {
      if (error?.errorFields) return; // 表单校验失败已内联标红
      message.error(error?.message || '创建失败');
    } finally {
      setCreatingKey(false);
    }
  };

  const openRuntime = (k: ApiKey) => {
    setRuntimeKey(k);
    // 只回填密钥自身的覆盖值；未覆盖的字段留空（placeholder 显示"使用全局默认"），
    // 否则预填默认值会让"继承"在点一次保存后变成显式覆盖
    runtimeForm.setFieldsValue({
      baseUrl: k.runtime?.baseUrl ?? undefined,
      reasoningEffort: k.runtime?.reasoningEffort ?? undefined,
      contextWindow: k.runtime?.contextWindow ?? undefined,
      maxOutputTokens: k.runtime?.maxOutputTokens ?? undefined,
      timeoutMs: k.runtime?.timeoutMs ?? undefined,
    });
  };

  const handleSaveRuntime = async () => {
    if (!runtimeKey || runtimeSaving) return;
    setRuntimeSaving(true);
    try {
      const values = await runtimeForm.validateFields();
      await updateKeyRuntime(runtimeKey.id, {
        baseUrl: values.baseUrl || undefined,
        reasoningEffort: values.reasoningEffort || undefined,
        contextWindow: values.contextWindow ?? undefined,
        maxOutputTokens: values.maxOutputTokens ?? undefined,
        timeoutMs: values.timeoutMs ?? undefined,
      });
      message.success('调用配置已更新');
      setRuntimeKey(null);
      if (keysUser) loadKeys(keysUser.id);
    } catch (error: any) {
      if (error?.errorFields) return; // 表单校验失败已内联标红
      message.error(error?.message || '保存失败');
    } finally {
      setRuntimeSaving(false);
    }
  };

  /** 查看完整密钥（后端 AES 解密；旧版仅哈希的密钥由后端拒绝并提示）。 */
  const handleViewKey = async (k: ApiKey) => {
    setViewingKeyId(k.id);
    try {
      const res = await revealUserKey(k.id);
      setViewingKey({ name: k.name, key: res.key });
    } catch (error: any) {
      message.error(error?.message || '查看失败');
    } finally {
      setViewingKeyId(null);
    }
  };

  /** 密钥调用配置表单项（创建与编辑共用，绑定各自的 Form）。 */
  const runtimeItems = (
    <>
      <Form.Item label="接入点" name="baseUrl" extra="留空使用账号/全局配置">
        <Input placeholder="https://..." autoComplete="off" />
      </Form.Item>
      <Form.Item label="推理力度" name="reasoningEffort">
        <Select
          allowClear
          placeholder="默认"
          options={[
            { label: 'low', value: 'low' },
            { label: 'medium', value: 'medium' },
            { label: 'high', value: 'high' },
          ]}
        />
      </Form.Item>
      <Form.Item label="上下文窗口" name="contextWindow">
        <InputNumber min={1} className="w-full" placeholder="默认" />
      </Form.Item>
      <Form.Item label="最大输出 Tokens" name="maxOutputTokens">
        <InputNumber min={1} className="w-full" placeholder="默认" />
      </Form.Item>
      <Form.Item label="超时（毫秒）" name="timeoutMs">
        <InputNumber min={1} className="w-full" placeholder="默认" />
      </Form.Item>
    </>
  );

  const keyStatus = (k: ApiKey): { label: string; color?: string } => {
    if (k.revokedAt) return { label: '已吊销', color: 'default' };
    const expires = parseDbTime(k.expiresAt);
    if (expires && expires.getTime() <= Date.now()) return { label: '已过期', color: 'warning' };
    return { label: '有效', color: 'success' };
  };

  const keyColumns: ColumnsType<ApiKey> = [
    { title: '名称', dataIndex: 'name', width: '14%', ellipsis: true },
    {
      title: '密钥前缀',
      dataIndex: 'keyPrefix',
      width: '16%',
      render: (v: string) => <span className="font-mono text-[12px]">{v}…</span>,
    },
    {
      title: '状态',
      key: 'status',
      width: '10%',
      render: (_, k) => <Tag color={keyStatus(k).color}>{keyStatus(k).label}</Tag>,
    },
    {
      title: '调用配置',
      key: 'runtime',
      width: '10%',
      render: (_, k) => (k.runtime ? <Tag color="geekblue">自定义</Tag> : <Tag>默认</Tag>),
    },
    {
      title: '创建时间',
      dataIndex: 'createdAt',
      width: '14%',
      render: (v: string) => fmtTime(v),
    },
    {
      title: '过期时间',
      dataIndex: 'expiresAt',
      width: '14%',
      render: (v: string | null) => (v ? fmtTime(v) : '永不过期'),
    },
    {
      title: '操作',
      key: 'action',
      width: '22%',
      render: (_, k) => (
        <Space size={0}>
          {!k.revokedAt && (
            <>
              <Button
                type="link"
                size="small"
                className="px-1"
                icon={<EyeOutlined />}
                loading={viewingKeyId === k.id}
                onClick={() => handleViewKey(k)}
              >
                查看
              </Button>
              <Button type="link" size="small" className="px-1" onClick={() => openRuntime(k)}>
                配置
              </Button>
            </>
          )}
          {k.revokedAt ? (
            <Popconfirm
              title="彻底删除该密钥记录？"
              onConfirm={async () => {
                if (!keysUser) return;
                try {
                  const res = await revokeKey(k.id, true);
                  if (res.warning) message.warning(res.warning);
                  message.success('密钥记录已删除');
                  loadKeys(keysUser.id);
                } catch (error: any) {
                  message.error(error?.message || '删除失败');
                }
              }}
            >
              <Button type="link" size="small" danger className="px-1">
                删除
              </Button>
            </Popconfirm>
          ) : (
            <Popconfirm
              title="确认吊销该密钥？"
              description="吊销后使用该密钥的客户端将立即失效"
              onConfirm={async () => {
                if (!keysUser) return;
                try {
                  const res = await revokeKey(k.id);
                  if (res.warning) message.warning(res.warning);
                  message.success('密钥已吊销');
                  loadKeys(keysUser.id);
                  reload();
                } catch (error: any) {
                  message.error(error?.message || '操作失败');
                }
              }}
            >
              <Button type="link" size="small" danger className="px-1">
                吊销
              </Button>
            </Popconfirm>
          )}
        </Space>
      ),
    },
  ];

  // ── 授权 ───────────────────────────────────────────────────────────────────
  const openGrants = async (user: GatewayUser) => {
    setGrantUser(user);
    setGrantIds([]);
    setGrantLoading(true);
    try {
      const [accRes, grantRes] = await Promise.all([listAccounts(), listGrants(user.id)]);
      setAccounts(accRes.accounts);
      setGrantIds(grantRes.accountIds);
    } catch (error: any) {
      // 加载失败立即关窗：grantIds 停留在空值，放行确认会清空该用户授权
      message.error(error?.message || '加载授权信息失败');
      setGrantUser(null);
    } finally {
      setGrantLoading(false);
    }
  };

  const handleSaveGrants = async () => {
    if (!grantUser) return;
    setGrantSaving(true);
    try {
      await updateGrants(grantUser.id, grantIds);
      message.success('授权已更新');
      setGrantUser(null);
      reload();
    } catch (error: any) {
      message.error(error?.message || '保存失败');
    } finally {
      setGrantSaving(false);
    }
  };

  // ── 配额 ───────────────────────────────────────────────────────────────────
  const openQuota = async (user: GatewayUser) => {
    setQuotaUser(user);
    setQuotaUsage(null);
    quotaForm.resetFields();
    setQuotaLoading(true);
    try {
      const res = await getQuota(user.id);
      setQuotaUsage(res.usage);
      quotaForm.setFieldsValue(res.quota ?? {});
    } catch (error: any) {
      // 加载失败立即关窗：表单为空/残留值，放行确认会写入错误配额
      message.error(error?.message || '加载配额失败');
      setQuotaUser(null);
    } finally {
      setQuotaLoading(false);
    }
  };

  const handleSaveQuota = async () => {
    if (!quotaUser || quotaSaving) return;
    setQuotaSaving(true);
    try {
      const values = await quotaForm.validateFields();
      await updateQuota(quotaUser.id, {
        dailyTokenLimit: values.dailyTokenLimit ?? null,
        dailyRequestLimit: values.dailyRequestLimit ?? null,
        monthlyTokenLimit: values.monthlyTokenLimit ?? null,
        monthlyRequestLimit: values.monthlyRequestLimit ?? null,
      });
      message.success('配额已更新');
      setQuotaUser(null);
      reload();
    } catch (error: any) {
      if (error?.errorFields) return; // 表单校验失败已内联标红
      message.error(error?.message || '保存失败');
    } finally {
      setQuotaSaving(false);
    }
  };

  useEffect(() => {
    listAccounts()
      .then((res) => setAccounts(res.accounts))
      .catch(() => {});
    getRuntimeDefaults()
      .then(setRuntimeDefaults)
      .catch(() => {});
  }, []);

  const columns: ProColumns<GatewayUser>[] = [
    { title: '用户名', dataIndex: 'username', width: 140, ellipsis: true },
    {
      title: '角色',
      dataIndex: 'role',
      width: 90,
      render: (_, r) => (
        <Tag color={r.role === 'admin' ? 'purple' : 'blue'}>
          {r.role === 'admin' ? '管理员' : '用户'}
        </Tag>
      ),
    },
    {
      title: '启用',
      dataIndex: 'enabled',
      width: 80,
      render: (_, r) => (
        <Switch
          checked={r.enabled}
          size="small"
          onChange={async (checked) => {
            try {
              await updateUser(r.id, { enabled: checked });
              message.success(checked ? '已启用' : '已禁用');
              reload();
            } catch (error: any) {
              message.error(error?.message || '操作失败');
            }
          }}
        />
      ),
    },
    { title: 'API 密钥', dataIndex: 'keyCount', width: 90, align: 'right' },
    { title: '授权账号', dataIndex: 'grantCount', width: 90, align: 'right' },
    {
      title: '配额',
      dataIndex: 'hasQuota',
      width: 90,
      render: (_, r) =>
        r.hasQuota ? <Tag color="processing">已设置</Tag> : <Tag>未设置</Tag>,
    },
    {
      title: '创建时间',
      dataIndex: 'createdAt',
      width: 120,
      render: (_, r) => fmtTime(r.createdAt),
    },
    {
      title: '操作',
      valueType: 'option',
      width: 300,
      fixed: 'right',
      render: (_, r) => (
        <Space size={2}>
          <Button type="link" size="small" className="px-1" onClick={() => openKeys(r)}>
            密钥
          </Button>
          <Button
            type="link"
            size="small"
            className="px-1"
            disabled={r.role === 'admin'}
            title={r.role === 'admin' ? '管理员可使用全部账号' : undefined}
            onClick={() => openGrants(r)}
          >
            授权
          </Button>
          <Button type="link" size="small" className="px-1" onClick={() => openQuota(r)}>
            配额
          </Button>
          <Button type="link" size="small" className="px-1" onClick={() => openEdit(r)}>
            编辑
          </Button>
          <Popconfirm
            title="确认删除该用户？"
            description="其密钥、授权与配额将一并移除"
            onConfirm={async () => {
              try {
                await deleteUser(r.id);
                message.success('用户已删除');
                reload();
              } catch (error: any) {
                message.error(error?.message || '删除失败');
              }
            }}
          >
            <Button type="link" size="small" danger className="px-1">
              删除
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div className="p-6">
      <PageHeader title="用户密钥" description="网关用户、API 密钥、账号授权与用量配额" />
      <ProTable<GatewayUser>
        rowKey="id"
        headerTitle="网关用户"
        columns={columns}
        actionRef={actionRef}
        search={false}
        options={{ reload: true, density: true, setting: true }}
        pagination={{ defaultPageSize: 10, showSizeChanger: false, showTotal: (t) => `共 ${t} 条` }}
        scroll={{ x: 1100 }}
        toolBarRender={() => [
          <Button key="new" type="primary" icon={<PlusOutlined />} onClick={openCreate}>
            新建用户
          </Button>,
        ]}
        request={async () => {
          const res = await listUsers();
          return { data: res.users, success: true, total: res.users.length };
        }}
      />

      {/* 用户创建 / 编辑 */}
      <Modal
        title={editingUser ? `编辑用户：${editingUser.username}` : '新建用户'}
        open={userModalOpen}
        width={480}
        confirmLoading={savingUser}
        onOk={handleSaveUser}
        onCancel={() => setUserModalOpen(false)}
        destroyOnHidden
      >
        <Form form={userForm} layout="vertical" className="pt-2">
          <Form.Item label="用户名" name="username" rules={[{ required: true }]}>
            <Input disabled={!!editingUser} autoComplete="off" />
          </Form.Item>
          <Form.Item
            label={editingUser ? '重置密码' : '密码'}
            name="password"
            rules={
              editingUser
                ? []
                : [
                    { required: true, message: '请输入密码' },
                    { min: 6, message: '密码至少 6 位' },
                  ]
            }
            extra={editingUser ? '留空表示不修改密码' : '至少 6 位'}
          >
            <Input.Password autoComplete="new-password" placeholder={editingUser ? '留空则不修改' : ''} />
          </Form.Item>
          <Form.Item label="角色" name="role" rules={[{ required: true }]}>
            <Select
              options={[
                { label: '用户', value: 'user' },
                { label: '管理员', value: 'admin' },
              ]}
            />
          </Form.Item>
        </Form>
      </Modal>

      {/* 查看完整密钥 Modal */}
      <Modal
        title={viewingKey ? `查看密钥：${viewingKey.name}` : '查看密钥'}
        open={viewingKey !== null}
        width={560}
        footer={null}
        onCancel={() => setViewingKey(null)}
        destroyOnHidden
      >
        {viewingKey && (
          <>
            <Space.Compact className="w-full">
              <Input readOnly value={viewingKey.key} className="font-mono text-[12px]" />
              <Button
                icon={<CopyOutlined />}
                onClick={() => {
                  navigator.clipboard
                    .writeText(viewingKey.key)
                    .then(() => message.success('已复制到剪贴板'))
                    .catch(() => message.warning('复制失败，请手动选择复制'));
                }}
              />
            </Space.Compact>
            <div className="mt-2 text-xs text-gray-400">请妥善保管，避免泄露给他人</div>
          </>
        )}
      </Modal>

      {/* 密钥 Drawer */}
      <Drawer
        title={keysUser ? `${keysUser.username} 的 API 密钥` : 'API 密钥'}
        open={keysUser !== null}
        width={720}
        onClose={() => setKeysUser(null)}
        destroyOnHidden
      >
        {createdKey && (
          <Alert
            type="success"
            showIcon
            className="mb-4"
            title="密钥已创建，可随时通过「查看」再次复制"
            description={
              <Space.Compact className="mt-1 w-full">
                <Input readOnly value={createdKey} className="font-mono text-[12px]" />
                <Button
                  icon={<CopyOutlined />}
                  onClick={() => {
                    navigator.clipboard
                      .writeText(createdKey)
                      .then(() => message.success('已复制到剪贴板'))
                      .catch(() => message.warning('复制失败，请手动选择复制'));
                  }}
                />
              </Space.Compact>
            }
          />
        )}
        <div className="mb-4 rounded-[8px] bg-gray-50 p-4">
          <Form form={keyForm} layout="vertical">
            <div className="grid grid-cols-[1fr_140px_auto] items-end gap-3">
              <Form.Item label="名称" name="name" className="!mb-0">
                <Input className="w-full" />
              </Form.Item>
              <Form.Item label="有效期（天）" name="expiresInDays" className="!mb-0">
                <InputNumber min={0} className="w-full" />
              </Form.Item>
              <Button type="primary" loading={creatingKey} onClick={handleCreateKey}>
                生成密钥
              </Button>
            </div>
            <div className="mt-4 border-t border-gray-200 pt-3">
              <div className="mb-2 text-xs font-medium text-gray-500">
                调用配置（已预填当前生效默认值，可修改；清空跟随账号/全局配置）
              </div>
              <div className="grid grid-cols-2 gap-x-4 xl:grid-cols-3">{runtimeItems}</div>
            </div>
          </Form>
          <div className="mt-1 text-xs text-gray-400">有效期填 0 表示永不过期</div>
        </div>
        <Table
          rowKey="id"
          columns={keyColumns}
          dataSource={keys}
          loading={keysLoading}
          pagination={false}
          size="small"
        />
      </Drawer>

      {/* 密钥调用配置 Modal */}
      <Modal
        title={`调用配置：${runtimeKey?.name ?? ''}`}
        open={runtimeKey !== null}
        width={520}
        confirmLoading={runtimeSaving}
        onOk={handleSaveRuntime}
        onCancel={() => setRuntimeKey(null)}
        destroyOnHidden
      >
        <Form form={runtimeForm} layout="vertical" className="pt-2">
          <div className="grid grid-cols-2 gap-x-4">{runtimeItems}</div>
          <div className="text-xs text-gray-400">全部留空 = 恢复使用账号/全局默认</div>
        </Form>
      </Modal>

      {/* 授权 Modal */}
      <Modal
        title={`授权账号：${grantUser?.username ?? ''}`}
        open={grantUser !== null}
        width={520}
        confirmLoading={grantSaving || grantLoading}
        onOk={handleSaveGrants}
        onCancel={() => setGrantUser(null)}
        destroyOnHidden
      >
        <div className="pt-1">
          <Checkbox.Group
            className="flex flex-col gap-2"
            value={grantIds}
            onChange={(values) => setGrantIds(values as number[])}
            options={accounts.map((a) => ({
              label: (
                <span>
                  {a.name}
                  <Tag color={a.backendType === 'global' ? 'purple' : 'blue'} className="ml-2">
                    {a.backendType === 'global' ? 'Global' : 'CN'}
                  </Tag>
                  {!a.enabled && <Tag color="default">已停用</Tag>}
                </span>
              ),
              value: a.id,
            }))}
          />
          {accounts.length === 0 && (
            <div className="py-4 text-center text-sm text-gray-400">暂无可授权的账号</div>
          )}
          <div className="mt-3 text-xs text-gray-400">
            普通用户只能调用被授权的账号；不勾选任何账号则该用户无法发起请求。管理员不受限制。
          </div>
        </div>
      </Modal>

      {/* 配额 Modal */}
      <Modal
        title={`用量配额：${quotaUser?.username ?? ''}`}
        open={quotaUser !== null}
        width={520}
        confirmLoading={quotaSaving || quotaLoading}
        onOk={handleSaveQuota}
        onCancel={() => setQuotaUser(null)}
        destroyOnHidden
      >
        <Form form={quotaForm} layout="vertical" className="pt-2">
          <div className="grid grid-cols-2 gap-x-4">
            <Form.Item label="每日 Token 上限" name="dailyTokenLimit">
              <InputNumber min={0} className="w-full" placeholder="不限" />
            </Form.Item>
            <Form.Item label="每日请求上限" name="dailyRequestLimit">
              <InputNumber min={0} className="w-full" placeholder="不限" />
            </Form.Item>
            <Form.Item label="每月 Token 上限" name="monthlyTokenLimit">
              <InputNumber min={0} className="w-full" placeholder="不限" />
            </Form.Item>
            <Form.Item label="每月请求上限" name="monthlyRequestLimit">
              <InputNumber min={0} className="w-full" placeholder="不限" />
            </Form.Item>
          </div>
          <div className="text-xs text-gray-400">留空表示不限制</div>
        </Form>
        {quotaUsage && (
          <div className="mt-3 rounded-[8px] bg-gray-50 p-3 text-xs text-gray-500">
            当前用量：今日 {fmtNum(quotaUsage.daily.requests)} 次请求 / {fmtNum(quotaUsage.daily.tokens)} tokens ·
            本月 {fmtNum(quotaUsage.monthly.requests)} 次请求 / {fmtNum(quotaUsage.monthly.tokens)} tokens
          </div>
        )}
      </Modal>
    </div>
  );
};

export default UsersPage;
