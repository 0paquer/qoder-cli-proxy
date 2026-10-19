import {
  ApiOutlined,
  NodeIndexOutlined,
  ReloadOutlined,
  ThunderboltOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import { ProTable } from '@ant-design/pro-components';
import type { ProColumns } from '@ant-design/pro-components';
import { Button, Spin, Tag, Tooltip } from 'antd';
import React, { useCallback, useEffect, useState } from 'react';
import { PageHeader, SectionCard, StatCard } from '@/components/QpCard';
import { fmtNum } from '@/utils/format';
import { getUsageOverview, type UsageOverview } from '@/services/qoderproxy';

const ACCENT = '#4f46e5';

const DashboardPage: React.FC = () => {
  const [data, setData] = useState<UsageOverview | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await getUsageOverview(14));
    } catch {
      /* 错误提示由全局 errorHandler 处理 */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const byDay = data?.byDay ?? [];
  const maxTokens = Math.max(1, ...byDay.map((d) => d.input_tokens + d.output_tokens));
  const inFlight = Object.values(data?.activeCounts ?? {}).reduce(
    (sum, n) => sum + (Number(n) || 0),
    0,
  );
  const activeAccounts = Object.entries(data?.activeCounts ?? {}).filter(
    ([, n]) => Number(n) > 0,
  ).length;

  const modelColumns: ProColumns<UsageOverview['byModel'][number]>[] = [
    {
      title: '模型',
      dataIndex: 'model',
      ellipsis: true,
      width: '40%',
      render: (_, r) => <span className="font-mono text-[12px]">{r.model || '—'}</span>,
    },
    { title: '请求', dataIndex: 'requests', width: '18%', align: 'right' },
    {
      title: 'Tokens（输入/输出）',
      key: 'tokens',
      width: '42%',
      align: 'right',
      render: (_, r) => `${fmtNum(r.input_tokens)} / ${fmtNum(r.output_tokens)}`,
    },
  ];

  const userColumns: ProColumns<UsageOverview['byUser'][number]>[] = [
    {
      title: '用户',
      dataIndex: 'username',
      ellipsis: true,
      width: '40%',
      render: (_, r) => r.username || '未知用户',
    },
    { title: '请求', dataIndex: 'requests', width: '18%', align: 'right' },
    {
      title: 'Tokens（输入/输出）',
      key: 'tokens',
      width: '42%',
      align: 'right',
      render: (_, r) => `${fmtNum(r.input_tokens)} / ${fmtNum(r.output_tokens)}`,
    },
  ];

  const accountColumns: ProColumns<UsageOverview['byAccount'][number]>[] = [
    {
      title: '账号',
      dataIndex: 'account_name',
      ellipsis: true,
      width: '34%',
      render: (_, r) => r.account_name || '未知账号',
    },
    { title: '请求', dataIndex: 'requests', width: '14%', align: 'right' },
    {
      title: 'Tokens',
      key: 'tokens',
      width: '24%',
      align: 'right',
      render: (_, r) => fmtNum(r.input_tokens + r.output_tokens),
    },
    {
      title: '错误',
      dataIndex: 'errors',
      width: '14%',
      align: 'right',
      render: (_, r) => (r.errors > 0 ? <span className="text-red-500">{fmtNum(r.errors)}</span> : '—'),
    },
    {
      title: '在途',
      key: 'inflight',
      width: '14%',
      align: 'right',
      render: (_, r) => {
        const n = Number(data?.activeCounts?.[String(r.account_id)] ?? 0);
        return n > 0 ? (
          <Tag color="processing" className="mr-0">
            {n}
          </Tag>
        ) : (
          '—'
        );
      },
    },
  ];

  return (
    <div className="p-6">
      <Spin spinning={loading}>
        <PageHeader
          title="仪表盘"
          description="网关调用概览，趋势统计窗口为近 14 天"
          extra={
            <Button icon={<ReloadOutlined />} onClick={load}>
              刷新
            </Button>
          }
        />

        <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
          <StatCard
            label="今日请求"
            value={fmtNum(data?.today?.requests)}
            accent={ACCENT}
            icon={<ThunderboltOutlined />}
          />
          <StatCard
            label="今日 Tokens"
            value={fmtNum(data?.today?.tokens)}
            accent="#9333ea"
            icon={<ApiOutlined />}
            hint="输入 + 输出"
          />
          <StatCard
            label="今日错误"
            value={fmtNum(data?.today?.errors)}
            accent="#ef4444"
            icon={<WarningOutlined />}
          />
          <StatCard
            label="在途请求"
            value={fmtNum(inFlight)}
            accent="#0ea5e9"
            icon={<NodeIndexOutlined />}
            hint={activeAccounts > 0 ? `${activeAccounts} 个账号正在处理` : '当前无并发请求'}
          />
        </div>

        <div className="mt-5">
          <SectionCard
            title="近 14 天 Token 用量"
            accent={ACCENT}
            extra={
              <span className="flex items-center gap-3 text-xs text-gray-400">
                <span className="flex items-center gap-1">
                  <i className="inline-block h-2 w-2 rounded-full" style={{ background: ACCENT }} />
                  输入
                </span>
                <span className="flex items-center gap-1">
                  <i
                    className="inline-block h-2 w-2 rounded-full"
                    style={{ background: '#9333ea' }}
                  />
                  输出
                </span>
              </span>
            }
          >
            {byDay.length === 0 ? (
              <div className="py-10 text-center text-sm text-gray-400">暂无数据</div>
            ) : (
              <div className="relative flex h-48 items-end gap-2 pt-2">
                {/* 横向网格基线 */}
                {[25, 50, 75].map((p) => (
                  <div
                    key={p}
                    className="pointer-events-none absolute inset-x-0 border-t border-dashed border-gray-100"
                    style={{ bottom: `${p + 10}%` }}
                  />
                ))}
                {byDay.map((d) => {
                  const total = d.input_tokens + d.output_tokens;
                  const h = (total / maxTokens) * 128;
                  const inH = total > 0 ? (d.input_tokens / total) * h : 0;
                  const outH = total > 0 ? (d.output_tokens / total) * h : 0;
                  return (
                    <div
                      key={d.date}
                      className="flex min-w-0 flex-1 flex-col items-center gap-1"
                    >
                      <Tooltip
                        title={`${d.date} · 请求 ${d.requests} · 输入 ${fmtNum(d.input_tokens)} · 输出 ${fmtNum(d.output_tokens)}`}
                      >
                        <div
                          className="group flex w-full max-w-[34px] cursor-default flex-col justify-end transition-opacity hover:opacity-80"
                          style={{ height: 128 }}
                        >
                          {outH > 0 && (
                            <div
                              className="w-full rounded-t-[3px]"
                              style={{
                                height: Math.max(outH, 2),
                                background: 'linear-gradient(180deg, #a855f7, #9333ea)',
                              }}
                            />
                          )}
                          {inH > 0 && (
                            <div
                              className="w-full"
                              style={{
                                height: Math.max(inH, 2),
                                background: 'linear-gradient(180deg, #6366f1, #4f46e5)',
                                borderRadius: outH > 0 ? 0 : '3px 3px 0 0',
                              }}
                            />
                          )}
                        </div>
                      </Tooltip>
                      <span className="w-full truncate text-center text-[10px] text-gray-400">
                        {d.date?.slice(5)}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </SectionCard>
        </div>

        <div className="mt-5">
          <ProTable
            headerTitle="模型用量（近 14 天）"
            rowKey={(r) => r.model || String(r.requests)}
            columns={modelColumns}
            dataSource={data?.byModel ?? []}
            search={false}
            options={false}
            pagination={false}
          />
        </div>

        <div className="mt-5 grid grid-cols-1 gap-5 xl:grid-cols-2">
          <ProTable
            headerTitle="用户用量（近 14 天）"
            rowKey={(r) => String(r.user_id ?? r.username ?? 'unknown')}
            columns={userColumns}
            dataSource={data?.byUser ?? []}
            search={false}
            options={false}
            pagination={false}
          />
          <ProTable
            headerTitle="账号用量（近 14 天）"
            rowKey={(r) => String(r.account_id)}
            columns={accountColumns}
            dataSource={data?.byAccount ?? []}
            search={false}
            options={false}
            pagination={false}
          />
        </div>
      </Spin>
    </div>
  );
};

export default DashboardPage;
