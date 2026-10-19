import { ReloadOutlined } from '@ant-design/icons';
import { Button, Select, Switch, Tag, Tooltip } from 'antd';
import { ProTable } from '@ant-design/pro-components';
import type { ProColumns } from '@ant-design/pro-components';
import React, { useCallback, useEffect, useState } from 'react';
import { PageHeader } from '@/components/QpCard';
import { fmtDuration, fmtNum, fmtTime } from '@/utils/format';
import {
  getUsageRecords,
  listUsers,
  type GatewayUser,
  type UsageRecord,
} from '@/services/qoderproxy';

const UsagePage: React.FC = () => {
  const [records, setRecords] = useState<UsageRecord[]>([]);
  const [users, setUsers] = useState<GatewayUser[]>([]);
  const [userId, setUserId] = useState<number | null>(null);
  const [limit, setLimit] = useState<number>(50);
  const [auto, setAuto] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await getUsageRecords({ limit, userId });
      setRecords(res.records);
    } catch {
      /* 错误提示由全局 errorHandler 处理 */
    } finally {
      setLoading(false);
    }
  }, [limit, userId]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    listUsers()
      .then((res) => setUsers(res.users))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!auto) return undefined;
    const timer = setInterval(load, 10_000);
    return () => clearInterval(timer);
  }, [auto, load]);

  const columns: ProColumns<UsageRecord>[] = [
    { title: '时间', dataIndex: 'ts', width: 170, render: (_, r) => fmtTime(r.ts, true) },
    {
      title: '用户',
      dataIndex: 'username',
      width: 110,
      ellipsis: true,
      render: (_, r) => r.username || '—',
    },
    {
      title: '账号',
      dataIndex: 'account_name',
      width: 120,
      ellipsis: true,
      render: (_, r) => r.account_name || '—',
    },
    {
      title: '模型',
      dataIndex: 'model',
      width: 150,
      ellipsis: true,
      render: (_, r) => <span className="font-mono text-[12px]">{r.model || '—'}</span>,
    },
    {
      title: '输入',
      dataIndex: 'input_tokens',
      width: 90,
      align: 'right',
      render: (_, r) => fmtNum(r.input_tokens),
    },
    {
      title: '输出',
      dataIndex: 'output_tokens',
      width: 90,
      align: 'right',
      render: (_, r) => fmtNum(r.output_tokens),
    },
    {
      title: '来源',
      dataIndex: 'token_source',
      width: 90,
      render: (_, r) =>
        r.token_source === 'actual' ? <Tag color="success">真实</Tag> : <Tag>估算</Tag>,
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 90,
      render: (_, r) =>
        r.status === 'error' ? (
          <Tooltip title={r.error_code || '请求失败'}>
            <Tag color="error">失败</Tag>
          </Tooltip>
        ) : (
          <Tag color="success">成功</Tag>
        ),
    },
    {
      title: '耗时',
      dataIndex: 'duration_ms',
      width: 90,
      align: 'right',
      render: (_, r) => fmtDuration(r.duration_ms),
    },
    {
      title: '流式',
      dataIndex: 'stream',
      width: 70,
      render: (_, r) => (r.stream ? '是' : '—'),
    },
  ];

  return (
    <div className="p-6">
      <PageHeader title="用量记录" description="网关调用明细，支持按用户筛选与自动刷新" />
      <ProTable<UsageRecord>
        rowKey="id"
        headerTitle="调用记录"
        columns={columns}
        dataSource={records}
        loading={loading}
        search={false}
        options={{ reload: false, density: true, setting: true }}
        scroll={{ x: 1100 }}
        toolBarRender={() => [
          <Select
            key="user"
            allowClear
            placeholder="全部用户"
            className="w-36"
            value={userId ?? undefined}
            onChange={(v) => setUserId(v ?? null)}
            options={users.map((u) => ({ label: u.username, value: u.id }))}
          />,
          <Select
            key="limit"
            className="w-32"
            value={limit}
            onChange={(v) => setLimit(v)}
            options={[50, 100, 200, 500].map((n) => ({ label: `最近 ${n} 条`, value: n }))}
          />,
          <span key="auto" className="flex items-center gap-1.5 text-xs text-gray-500">
            <Switch size="small" checked={auto} onChange={setAuto} />
            10s 自动刷新
          </span>,
          <Button key="refresh" icon={<ReloadOutlined />} onClick={load} loading={loading}>
            刷新
          </Button>,
        ]}
        pagination={{
          pageSize: 50,
          showSizeChanger: false,
          showTotal: (total) => `共 ${total} 条记录`,
        }}
      />
    </div>
  );
};

export default UsagePage;
