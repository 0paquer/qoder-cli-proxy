import { PlusOutlined } from '@ant-design/icons';
import type { ActionType, ProColumns } from '@ant-design/pro-components';
import { ProTable } from '@ant-design/pro-components';
import {
  Button,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Progress,
  Select,
  Space,
  Switch,
  Tag,
  Tooltip,
  message,
} from 'antd';
import React, { useRef, useState } from 'react';
import { PageHeader } from '@/components/QpCard';
import { fmtTime } from '@/utils/format';
import {
  createAccount,
  deleteAccount,
  fetchAccountUsage,
  listAccounts,
  updateAccount,
  updateAccountPat,
  verifyAccount,
  type Account,
  type AccountUsage,
} from '@/services/qoderproxy';

const verifyTag = (s: Account['verifyStatus']) => {
  if (s === 'verified') return <Tag color="success">已验证</Tag>;
  if (s === 'failed') return <Tag color="error">验证失败</Tag>;
  return <Tag>未验证</Tag>;
};

const AccountPage: React.FC = () => {
  const actionRef = useRef<ActionType>(undefined);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Account | null>(null);
  const [saving, setSaving] = useState(false);
  const [patTarget, setPatTarget] = useState<Account | null>(null);
  const [patValue, setPatValue] = useState('');
  const [patSaving, setPatSaving] = useState(false);
  const [verifyingId, setVerifyingId] = useState<number | null>(null);
  const [usageTarget, setUsageTarget] = useState<Account | null>(null);
  const [usageLoading, setUsageLoading] = useState(false);
  const [usageData, setUsageData] = useState<AccountUsage | null>(null);
  // 行级额度缓存：页面加载后后台串行补齐（服务端 60s 缓存 + 快照防止 CLI 风暴）
  const [usageMap, setUsageMap] = useState<Record<number, AccountUsage>>({});
  const usageMapRef = useRef<Record<number, AccountUsage>>({});
  const usageInFlightRef = useRef<Set<number>>(new Set());
  const usageFailedRef = useRef<Set<number>>(new Set());
  const [form] = Form.useForm();

  const reload = () => actionRef.current?.reload();

  const putUsage = (id: number, usage: AccountUsage) => {
    usageMapRef.current = { ...usageMapRef.current, [id]: usage };
    setUsageMap(usageMapRef.current);
  };

  /** 串行补齐缺失的账号额度，不阻塞表格渲染；失败账号本轮标记避免重复请求。 */
  const refreshMissingUsage = async (accounts: Account[]) => {
    for (const acc of accounts) {
      if (!acc.enabled || acc.quota) continue;
      if (usageMapRef.current[acc.id]) continue;
      if (usageInFlightRef.current.has(acc.id) || usageFailedRef.current.has(acc.id)) continue;
      usageInFlightRef.current.add(acc.id);
      try {
        const res = await fetchAccountUsage(acc.id);
        if (res.ok && res.usage) putUsage(acc.id, res.usage);
        else usageFailedRef.current.add(acc.id);
      } catch {
        usageFailedRef.current.add(acc.id);
      } finally {
        usageInFlightRef.current.delete(acc.id);
      }
    }
  };

  const openCreate = () => {
    setEditing(null);
    form.setFieldsValue({
      name: '',
      backendType: 'cn',
      baseUrl: '',
      pat: '',
      weight: 1,
      maxConcurrency: 0,
      remark: '',
    });
    setModalOpen(true);
  };

  const openEdit = (acc: Account) => {
    setEditing(acc);
    form.setFieldsValue({
      name: acc.name,
      backendType: acc.backendType,
      baseUrl: acc.baseUrl ?? '',
      weight: acc.weight,
      maxConcurrency: acc.maxConcurrency,
      remark: acc.remark ?? '',
    });
    setModalOpen(true);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const values = await form.validateFields();
      if (editing) {
        await updateAccount(editing.id, {
          name: values.name,
          backendType: values.backendType,
          baseUrl: values.baseUrl,
          weight: values.weight,
          maxConcurrency: values.maxConcurrency,
          remark: values.remark,
        });
        message.success('账号已更新');
      } else {
        await createAccount(values);
        message.success('账号已创建');
      }
      setModalOpen(false);
      reload();
    } catch (error: any) {
      if (error?.errorFields) return; // 表单校验失败已内联标红，不额外弹错
      message.error(error?.message || '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const handleSavePat = async () => {
    if (!patTarget || !patValue.trim()) {
      message.warning('请输入 PAT');
      return;
    }
    setPatSaving(true);
    try {
      await updateAccountPat(patTarget.id, patValue.trim());
      message.success('PAT 已更新，需要重新验证');
      setPatTarget(null);
      setPatValue('');
      reload();
    } catch (error: any) {
      message.error(error?.message || '保存失败');
    } finally {
      setPatSaving(false);
    }
  };

  const handleVerify = async (acc: Account) => {
    setVerifyingId(acc.id);
    try {
      const res = await verifyAccount(acc.id);
      if (res.ok) {
        message.success(`验证通过（${(res.durationMs ?? 0) / 1000}s）`);
      } else {
        message.error(`验证失败：${res.error || '未知错误'}`);
      }
      reload();
    } catch (error: any) {
      message.error(error?.message || '验证失败');
    } finally {
      setVerifyingId(null);
    }
  };

  const handleViewUsage = async (acc: Account) => {
    setUsageTarget(acc);
    setUsageData(null);
    setUsageLoading(true);
    try {
      const res = await fetchAccountUsage(acc.id);
      if (res.ok && res.usage) {
        setUsageData(res.usage);
        putUsage(acc.id, res.usage);
      } else {
        message.error('额度查询失败');
        setUsageTarget(null);
      }
    } catch (error: any) {
      message.error(error?.message || '额度查询失败');
      setUsageTarget(null);
    } finally {
      setUsageLoading(false);
    }
  };

  const columns: ProColumns<Account>[] = [
    { title: '名称', dataIndex: 'name', width: 150, ellipsis: true },
    {
      title: '类型',
      dataIndex: 'backendType',
      width: 90,
      render: (_, r) => (
        <Tag color={r.backendType === 'global' ? 'purple' : 'blue'}>
          {r.backendType === 'global' ? 'Global' : 'CN'}
        </Tag>
      ),
    },
    {
      title: '接入点',
      dataIndex: 'baseUrl',
      width: 180,
      ellipsis: true,
      render: (_, r) =>
        r.baseUrl ? <span className="font-mono text-[12px]">{r.baseUrl}</span> : '默认',
    },
    { title: '权重', dataIndex: 'weight', width: 70, align: 'right' },
    {
      title: '并发上限',
      dataIndex: 'maxConcurrency',
      width: 90,
      align: 'right',
      render: (_, r) => (Number(r.maxConcurrency) === 0 ? '不限' : r.maxConcurrency),
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
              await updateAccount(r.id, { enabled: checked });
              message.success(checked ? '已启用' : '已停用');
              reload();
            } catch (error: any) {
              message.error(error?.message || '操作失败');
            }
          }}
        />
      ),
    },
    {
      title: 'PAT',
      dataIndex: 'patFingerprint',
      width: 90,
      render: (_, r) =>
        r.patFingerprint ? (
          <Tooltip title={`指纹 ${r.patFingerprint}`}>
            <Tag color="geekblue">已配置</Tag>
          </Tooltip>
        ) : (
          <Tag color="warning">未配置</Tag>
        ),
    },
    {
      title: '验证状态',
      dataIndex: 'verifyStatus',
      width: 100,
      render: (_, r) => (
        <Tooltip title={r.verifiedAt ? `验证时间 ${fmtTime(r.verifiedAt, true)}` : undefined}>
          {verifyTag(r.verifyStatus)}
        </Tooltip>
      ),
    },
    {
      title: '剩余额度',
      dataIndex: 'quota',
      width: 190,
      render: (_, r) => {
        const usage = usageMap[r.id];
        const q =
          usage && usage.buckets.length > 0
            ? {
                remaining: usage.buckets.reduce((s, b) => s + b.remaining, 0),
                total: usage.buckets.reduce((s, b) => s + b.total, 0),
                isQuotaExceeded: Boolean(usage.isQuotaExceeded),
                buckets: usage.buckets,
              }
            : r.quota;
        if (!q?.total) return <span className="text-xs text-gray-300">—</span>;
        const usedPct = Math.round(((q.total - q.remaining) / q.total) * 100);
        const danger = q.isQuotaExceeded || usedPct >= 100;
        return (
          <Tooltip title={q.buckets.map((b) => `${b.label}：剩 ${b.remaining} / ${b.total}`).join('；')}>
            <div className="min-w-0">
              <div className="flex items-center gap-1 text-xs">
                <span className={danger ? 'font-medium text-red-500' : 'font-medium'}>
                  剩 {q.remaining}
                </span>
                <span className="text-gray-400">/ {q.total} credits</span>
                {danger ? <Tag color="error" className="mr-0">超限</Tag> : null}
              </div>
              <Progress
                percent={usedPct}
                size="small"
                status={danger ? 'exception' : undefined}
              />
            </div>
          </Tooltip>
        );
      },
    },
    {
      title: '冷却至',
      dataIndex: 'cooldownUntil',
      width: 110,
      render: (_, r) => {
        if (!r.cooldownUntil) return '—';
        const until = new Date(
          String(r.cooldownUntil).includes('T')
            ? r.cooldownUntil
            : `${String(r.cooldownUntil).replace(' ', 'T')}Z`,
        );
        if (Number.isNaN(until.getTime()) || until.getTime() <= Date.now()) return '—';
        return (
          <Tag color="error" className="mr-0">
            {fmtTime(r.cooldownUntil, true)}
          </Tag>
        );
      },
    },
    {
      title: '最近使用',
      dataIndex: 'lastUsedAt',
      width: 110,
      render: (_, r) => fmtTime(r.lastUsedAt),
    },
    { title: '备注', dataIndex: 'remark', width: 140, ellipsis: true },
    {
      title: '操作',
      valueType: 'option',
      width: 300,
      fixed: 'right',
      render: (_, r) => (
        <Space size={4}>
          <Button type="link" size="small" className="px-1" onClick={() => openEdit(r)}>
            编辑
          </Button>
          <Button
            type="link"
            size="small"
            className="px-1"
            onClick={() => {
              setPatTarget(r);
              setPatValue('');
            }}
          >
            PAT
          </Button>
          <Button
            type="link"
            size="small"
            className="px-1"
            loading={verifyingId === r.id}
            disabled={verifyingId !== null && verifyingId !== r.id}
            onClick={() => handleVerify(r)}
          >
            验证
          </Button>
          <Button
            type="link"
            size="small"
            className="px-1"
            disabled={usageLoading}
            onClick={() => handleViewUsage(r)}
          >
            额度
          </Button>
          <Popconfirm
            title="确认删除该账号？"
            description="关联的授权记录将一并移除"
            onConfirm={async () => {
              try {
                await deleteAccount(r.id);
                message.success('账号已删除');
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
      <PageHeader title="账号管理" description="Qoder 账号接入、PAT 验证与调度参数" />
      <ProTable<Account>
        rowKey="id"
        headerTitle="Qoder 账号"
        columns={columns}
        actionRef={actionRef}
        search={false}
        options={{ reload: true, density: true, setting: true }}
        pagination={{ defaultPageSize: 10, showSizeChanger: false, showTotal: (t) => `共 ${t} 条` }}
        scroll={{ x: 1700 }}
        toolBarRender={() => [
          <Button key="new" type="primary" icon={<PlusOutlined />} onClick={openCreate}>
            新建账号
          </Button>,
        ]}
        request={async () => {
          const res = await listAccounts();
          // 后台串行补齐缺失额度（服务端快照缺失时才逐个现查），不阻塞渲染
          void refreshMissingUsage(res.accounts);
          return { data: res.accounts, success: true, total: res.accounts.length };
        }}
      />

      <Modal
        title={editing ? `编辑账号：${editing.name}` : '新建账号'}
        open={modalOpen}
        width={720}
        confirmLoading={saving}
        onOk={handleSave}
        onCancel={() => setModalOpen(false)}
        destroyOnHidden
      >
        {/* 两列布局压缩纵向高度：短字段各占一格，PAT 长输入独占整行 */}
        <Form form={form} layout="vertical" className="pt-2">
          <div className="grid grid-cols-2 gap-x-6">
            <Form.Item
              label="名称"
              name="name"
              rules={[{ required: true, message: '请输入账号名称' }]}
            >
              <Input placeholder="例如：work-account-1" />
            </Form.Item>
            <Form.Item label="后端类型" name="backendType" rules={[{ required: true }]}>
              <Select
                options={[
                  { label: 'CN（qoder.com.cn）', value: 'cn' },
                  { label: 'Global（qoder.com）', value: 'global' },
                ]}
              />
            </Form.Item>
            <Form.Item label="接入点" name="baseUrl" extra="留空使用官方默认接入点">
              <Input placeholder="https://..." />
            </Form.Item>
            <Form.Item
              label="权重"
              name="weight"
              extra="0 表示不参与调度"
              initialValue={1}
            >
              <InputNumber min={0} max={100} className="w-full" />
            </Form.Item>
            <Form.Item
              label="并发上限"
              name="maxConcurrency"
              extra="0 表示不限制"
              initialValue={0}
            >
              <InputNumber min={0} max={100} className="w-full" />
            </Form.Item>
            <Form.Item label="备注" name="remark">
              <Input placeholder="选填" />
            </Form.Item>
            {!editing && (
              <Form.Item
                label="PAT"
                name="pat"
                rules={[{ required: true, message: '请输入 PAT' }]}
                extra="加密存储，不会再次显示"
                className="col-span-2 [&_.ant-form-item-extra]:mt-1"
              >
                <Input.TextArea rows={2} placeholder="粘贴 Qoder Personal Access Token" />
              </Form.Item>
            )}
          </div>
        </Form>
      </Modal>

      <Modal
        title={`更新 PAT：${patTarget?.name ?? ''}`}
        open={patTarget !== null}
        width={520}
        confirmLoading={patSaving}
        onOk={handleSavePat}
        onCancel={() => setPatTarget(null)}
        destroyOnHidden
      >
        <Input.TextArea
          rows={3}
          value={patValue}
          onChange={(e) => setPatValue(e.target.value)}
          placeholder="粘贴新的 Personal Access Token"
          className="mt-3"
        />
        <div className="mt-2 text-xs text-gray-400">保存后验证状态将重置为「未验证」</div>
      </Modal>

      <Modal
        title={`账号额度：${usageTarget?.name ?? ''}`}
        open={usageTarget !== null}
        width={520}
        footer={null}
        onCancel={() => {
          setUsageTarget(null);
          setUsageData(null);
        }}
        destroyOnHidden
      >
        {usageLoading || !usageData ? (
          <div className="py-12 text-center text-gray-400">正在查询（首次约 10 秒，零 credits 消耗）…</div>
        ) : (
          <div className="pt-2">
            <div className="mb-4 flex items-center gap-2">
              <Tag color={usageData.isQuotaExceeded ? 'error' : 'success'}>
                {usageData.isQuotaExceeded ? '配额已耗尽' : '配额正常'}
              </Tag>
              {usageData.expiresAt ? (
                <span className="text-xs text-gray-400">
                  重置时间：{new Date(usageData.expiresAt).toLocaleString()}
                </span>
              ) : null}
            </div>
            {usageData.buckets.map((b) => (
              <div key={b.label} className="mb-4">
                <div className="mb-1 flex justify-between text-sm">
                  <span>{b.label}</span>
                  <span className="text-gray-500">
                    已用 {b.used} / {b.total} credits（剩 {b.remaining}）
                  </span>
                </div>
                <Progress
                  percent={b.percentage}
                  status={b.percentage >= 100 ? 'exception' : 'normal'}
                />
              </div>
            ))}
            <div className="text-xs text-gray-400">查询走控制协议，不消耗对话额度；结果缓存 60 秒。</div>
          </div>
        )}
      </Modal>
    </div>
  );
};

export default AccountPage;
