import {
  FireOutlined,
  ReloadOutlined,
  SettingOutlined,
} from '@ant-design/icons';
import type { ProColumns } from '@ant-design/pro-components';
import { ProTable } from '@ant-design/pro-components';
import { Button, InputNumber, Popconfirm, Select, Space, Switch, Tag, message } from 'antd';
import React, { useEffect, useState } from 'react';
import { PageHeader, SectionCard } from '@/components/QpCard';
import {
  clearWarmPool,
  dropDaemonPool,
  evictWarmPool,
  getDaemonPool,
  getRuntimeDefaults,
  getWarmPool,
  prewarmWarmPool,
  updateDaemonPoolConfig,
  updateModelDefaults,
  updateWarmPoolConfig,
  type DaemonPoolEntry,
  type DaemonPoolStats,
  type RuntimeDefaults,
  type WarmPoolKey,
  type WarmPoolStats,
} from '@/services/qoderproxy';

const WARM_ACCENT = '#0ea5e9';
const DAEMON_ACCENT = '#10b981';
const MODEL_ACCENT = '#8b5cf6';

/** 毫秒 → 人类可读时长（9.2s / 10分 / 4小时）。 */
const fmtMs = (ms: number | null | undefined) => {
  if (ms == null) return '-';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  if (m < 60) return s ? `${m}分${s}秒` : `${m}分`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}小时${m % 60}分` : `${Math.floor(h / 24)}天${h % 24}小时`;
};

/** 毫秒差 → 相对时间（刚刚 / 3 分钟前）。 */
const fmtAgo = (ms: number | null | undefined) => {
  if (ms == null) return '-';
  if (ms < 5000) return '刚刚';
  if (ms < 60_000) return `${Math.round(ms / 1000)} 秒前`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} 分钟前`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)} 小时前`;
  return `${Math.round(ms / 86_400_000)} 天前`;
};

/** 热池参数表单（展示用单位：秒/分钟，提交时换算为毫秒）。 */
interface PoolForm {
  size: number;
  maxTotal: number;
  ttlSec: number;
  readySec: number;
  keepaliveSec: number;
  windowMin: number;
}

const POOL_FORM_FIELDS: {
  key: keyof PoolForm;
  label: string;
  unit: string;
  min: number;
  max: number;
  hint: string;
}[] = [
  { key: 'size', label: '每指纹上限', unit: '个', min: 0, max: 50, hint: '同一指纹最多保留的热进程' },
  { key: 'maxTotal', label: '总进程上限', unit: '个', min: 0, max: 100, hint: '全部指纹热进程总和上限' },
  { key: 'ttlSec', label: 'TTL 销毁重建', unit: '秒', min: 30, max: 86400, hint: '热进程最长存活，到期销毁并重建' },
  { key: 'readySec', label: '可领取成熟期', unit: '秒', min: 0, max: 120, hint: '未满成熟期不发放，留在池内保温' },
  { key: 'keepaliveSec', label: '保温巡检间隔', unit: '秒', min: 0, max: 3600, hint: '0 = 关闭巡检' },
  { key: 'windowMin', label: '保温窗口', unit: '分钟', min: 0, max: 43200, hint: '0 = 永久保温；超窗指纹停止保温' },
];

const PoolsPage: React.FC = () => {
  // ── 对话预热池 ──
  const [poolStats, setPoolStats] = useState<WarmPoolStats | null>(null);
  const [poolKeys, setPoolKeys] = useState<WarmPoolKey[]>([]);
  const [poolLoading, setPoolLoading] = useState(false);
  const [poolForm, setPoolForm] = useState<PoolForm | null>(null);
  const [poolSaving, setPoolSaving] = useState(false);

  // ── 控制面 daemon 池 ──
  const [daemonStats, setDaemonStats] = useState<DaemonPoolStats | null>(null);
  const [daemonEntries, setDaemonEntries] = useState<DaemonPoolEntry[]>([]);
  const [daemonLoading, setDaemonLoading] = useState(false);
  const [daemonEnabled, setDaemonEnabled] = useState(true);
  const [daemonTtlSec, setDaemonTtlSec] = useState<number>(3600);
  const [daemonSaving, setDaemonSaving] = useState(false);

  // ── 模型参数 ──
  const [modelDefaults, setModelDefaults] = useState<RuntimeDefaults | null>(null);
  const [modelForm, setModelForm] = useState({
    reasoningEffort: '' as string,
    contextWindow: undefined as number | undefined,
    maxOutputTokens: undefined as number | undefined,
    timeoutSec: undefined as number | undefined,
  });
  const [modelSaving, setModelSaving] = useState(false);

  const loadPool = async () => {
    setPoolLoading(true);
    try {
      const res = await getWarmPool();
      setPoolStats(res.stats);
      setPoolKeys(res.keys);
      // 表单未在编辑时同步最新值，避免覆盖用户正在输入的内容
      setPoolForm((prev) =>
        prev
          ? prev
          : {
              size: res.stats.size,
              maxTotal: res.stats.maxTotal,
              ttlSec: Math.round(res.stats.ttlMs / 1000),
              readySec: Math.round(res.stats.readyMs / 1000),
              keepaliveSec: Math.round(res.stats.keepaliveMs / 1000),
              windowMin: Math.round(res.stats.keepaliveWindowMs / 60000),
            },
      );
    } catch {
      /* 加载失败静默，可手动刷新 */
    } finally {
      setPoolLoading(false);
    }
  };

  const loadDaemon = async () => {
    setDaemonLoading(true);
    try {
      const res = await getDaemonPool();
      setDaemonStats(res.stats);
      setDaemonEntries(res.entries);
      setDaemonEnabled(res.stats.enabled);
      setDaemonTtlSec(Math.round(res.stats.ttlMs / 1000));
    } catch {
      /* 加载失败静默，可手动刷新 */
    } finally {
      setDaemonLoading(false);
    }
  };

  const loadModel = async () => {
    try {
      const d = await getRuntimeDefaults();
      setModelDefaults(d);
      setModelForm({
        reasoningEffort: d.reasoningEffort ?? '',
        contextWindow: d.contextWindow ?? undefined,
        maxOutputTokens: d.maxOutputTokens ?? undefined,
        timeoutSec: d.timeoutMs != null ? Math.round(d.timeoutMs / 1000) : undefined,
      });
    } catch {
      /* 加载失败静默，可手动刷新 */
    }
  };

  useEffect(() => {
    loadPool();
    loadDaemon();
    loadModel();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── 热池操作 ──────────────────────────────────────────────────────────────
  const handlePrewarm = async (key?: string) => {
    try {
      const res = await prewarmWarmPool(key);
      message.success(
        res.warmed > 0 ? `已补位 ${res.warmed} 个热进程` : '无需补位：已达容量上限或暂无已知指纹',
      );
      await loadPool();
    } catch (error: any) {
      message.error(error?.message || '预热失败');
    }
  };

  const handleEvict = async (key: string) => {
    try {
      const res = await evictWarmPool(key);
      message.success(`已驱逐 ${res.killed} 个热进程，该指纹停止保温`);
      await loadPool();
    } catch (error: any) {
      message.error(error?.message || '驱逐失败');
    }
  };

  const handleClearPool = async () => {
    try {
      const res = await clearWarmPool();
      message.success(`热池已清空，释放 ${res.killed} 个热进程`);
      await loadPool();
    } catch (error: any) {
      message.error(error?.message || '清空失败');
    }
  };

  const handleSavePoolCfg = async () => {
    if (!poolForm) return;
    if (poolForm.ttlSec < 30) {
      message.error('TTL 销毁重建至少 30 秒');
      return;
    }
    setPoolSaving(true);
    try {
      const res = await updateWarmPoolConfig({
        size: poolForm.size,
        maxTotal: poolForm.maxTotal,
        ttlMs: poolForm.ttlSec * 1000,
        readyMs: poolForm.readySec * 1000,
        keepaliveMs: poolForm.keepaliveSec * 1000,
        keepaliveWindowMs: poolForm.windowMin * 60000,
      });
      setPoolStats(res.stats);
      message.success('池参数已生效并写入 .env，无需重启');
      await loadPool();
    } catch (error: any) {
      message.error(error?.message || '保存失败');
    } finally {
      setPoolSaving(false);
    }
  };

  // ── daemon 池操作 ─────────────────────────────────────────────────────────
  const handleSaveDaemonCfg = async () => {
    setDaemonSaving(true);
    try {
      const res = await updateDaemonPoolConfig({ enabled: daemonEnabled, ttlMs: daemonTtlSec * 1000 });
      setDaemonStats(res.stats);
      message.success('daemon 池参数已生效并写入 .env，无需重启');
      await loadDaemon();
    } catch (error: any) {
      message.error(error?.message || '保存失败');
    } finally {
      setDaemonSaving(false);
    }
  };

  const handleDropDaemon = async (key?: string) => {
    try {
      const res = await dropDaemonPool(key);
      message.success(
        res.dropped > 0 ? `已回收 ${res.dropped} 个常驻 daemon` : '没有可回收的常驻 daemon',
      );
      await loadDaemon();
    } catch (error: any) {
      message.error(error?.message || '回收失败');
    }
  };

  // ── 模型参数操作 ──────────────────────────────────────────────────────────
  const handleSaveModel = async () => {
    if (modelForm.timeoutSec != null && (modelForm.timeoutSec < 1 || modelForm.timeoutSec > 3600)) {
      message.error('单请求超时须为 1-3600 秒');
      return;
    }
    setModelSaving(true);
    try {
      const res = await updateModelDefaults({
        reasoningEffort: modelForm.reasoningEffort,
        contextWindow: modelForm.contextWindow ?? '',
        maxOutputTokens: modelForm.maxOutputTokens ?? '',
        timeoutMs: modelForm.timeoutSec != null ? modelForm.timeoutSec * 1000 : '',
      });
      setModelDefaults(res.defaults);
      message.success('模型参数已生效并写入 .env，无需重启');
      await loadModel();
    } catch (error: any) {
      message.error(error?.message || '保存失败');
    } finally {
      setModelSaving(false);
    }
  };

  // ── 热池指纹表列（AntD Pro 标准：定宽 + 单行省略） ────────────────────────
  const poolColumns: ProColumns<WarmPoolKey>[] = [
    {
      title: '指纹',
      dataIndex: 'key',
      width: 110,
      render: (_, r) => (
        <span className="font-mono text-[12px]" title={r.key}>
          {r.key.slice(0, 10)}…
        </span>
      ),
    },
    {
      title: '账号',
      width: 140,
      ellipsis: true,
      render: (_, r) =>
        r.accountName ? (
          <span title={`${r.accountName} (#${r.accountId})`}>{r.accountName}</span>
        ) : (
          <span className="text-gray-400">未知账号</span>
        ),
    },
    {
      title: '模式',
      dataIndex: 'stream',
      width: 80,
      render: (_, r) =>
        r.stream ? <Tag color="cyan" className="mr-0">流式</Tag> : <Tag className="mr-0">非流式</Tag>,
    },
    {
      title: '空闲进程',
      dataIndex: 'idle',
      width: 90,
      render: (_, r) => (
        <span className="font-mono text-[12px]">
          {r.idle}
          {r.immature > 0 && <span className="ml-1 text-amber-500">({r.immature} 成熟中)</span>}
        </span>
      ),
    },
    {
      title: '最老进程',
      dataIndex: 'oldestAgeMs',
      width: 90,
      render: (_, r) => <span className="font-mono text-[12px]">{fmtMs(r.oldestAgeMs)}</span>,
    },
    {
      title: '下次回收',
      dataIndex: 'nextReclaimMs',
      width: 90,
      render: (_, r) =>
        r.nextReclaimMs == null ? (
          <span className="text-gray-400">{r.idle === 0 ? '使用中' : '-'}</span>
        ) : (
          <span className="font-mono text-[12px]">{fmtMs(r.nextReclaimMs)}</span>
        ),
    },
    {
      title: '最近请求',
      dataIndex: 'lastSeenAgoMs',
      width: 100,
      render: (_, r) => <span className="text-[12px]">{fmtAgo(r.lastSeenAgoMs)}</span>,
    },
    {
      title: '操作',
      width: 130,
      render: (_, r) => (
        <Space size={4}>
          <Button
            type="link"
            size="small"
            className="px-1"
            disabled={r.idle >= (poolStats?.size ?? 1)}
            onClick={() => handlePrewarm(r.key)}
          >
            预热
          </Button>
          <Popconfirm
            title="驱逐该指纹？"
            description="杀掉其空闲热进程并停止保温，下次请求重新冷启动学习"
            onConfirm={() => handleEvict(r.key)}
          >
            <Button type="link" size="small" danger className="px-1">
              驱逐
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  // ── daemon 常驻条目表列 ───────────────────────────────────────────────────
  const daemonColumns: ProColumns<DaemonPoolEntry>[] = [
    {
      title: '指纹',
      dataIndex: 'key',
      width: 130,
      render: (_, r) => (
        <span className="font-mono text-[12px]" title={r.key}>
          {r.key.slice(0, 10)}…
        </span>
      ),
    },
    {
      title: '账号',
      width: 160,
      ellipsis: true,
      render: (_, r) =>
        r.accountName ? (
          <span title={`${r.accountName} (#${r.accountId})`}>{r.accountName}</span>
        ) : (
          <span className="text-gray-400">未知账号</span>
        ),
    },
    {
      title: '状态',
      dataIndex: 'state',
      width: 90,
      render: (_, r) =>
        r.state === 'ready' ? (
          <Tag color="success" className="mr-0">就绪</Tag>
        ) : (
          <Tag color="warning" className="mr-0">{r.state || '未知'}</Tag>
        ),
    },
    {
      title: '空闲时长',
      dataIndex: 'lastUsedAgoMs',
      width: 100,
      render: (_, r) => <span className="font-mono text-[12px]">{fmtMs(r.lastUsedAgoMs)}</span>,
    },
    {
      title: '下次回收',
      dataIndex: 'nextReclaimMs',
      width: 100,
      render: (_, r) => <span className="font-mono text-[12px]">{fmtMs(r.nextReclaimMs)}</span>,
    },
    {
      title: '操作',
      width: 90,
      render: (_, r) => (
        <Popconfirm
          title="回收该常驻 daemon？"
          description="下次模型/用量查询会自动重建（约 7s 初始化）"
          onConfirm={() => handleDropDaemon(r.key)}
        >
          <Button type="link" size="small" danger className="px-1">
            回收
          </Button>
        </Popconfirm>
      ),
    },
  ];

  return (
    <div className="p-6">
      <PageHeader
        title="进程池"
        description="对话预热池、控制面 daemon 池与全局模型参数的统一控制，保存后立即生效"
        extra={
          <Button
            icon={<ReloadOutlined />}
            onClick={() => {
              loadPool();
              loadDaemon();
              loadModel();
            }}
          >
            刷新全部
          </Button>
        }
      />
      <div className="flex flex-col gap-5">
        {/* ── 对话预热池 ─────────────────────────────────────────────────── */}
        <SectionCard
          title="对话预热池"
          accent={WARM_ACCENT}
          extra={
            <Space size={8}>
              <Button
                size="small"
                icon={<FireOutlined />}
                loading={poolLoading}
                onClick={() => handlePrewarm()}
              >
                立即预热全部
              </Button>
              <Popconfirm
                title="清空整个热池？"
                description="杀掉全部空闲热进程并停止所有保温，下次请求重新冷启动学习"
                onConfirm={handleClearPool}
              >
                <Button danger size="small">清空热池</Button>
              </Popconfirm>
              <Button size="small" icon={<ReloadOutlined />} loading={poolLoading} onClick={loadPool}>
                刷新
              </Button>
            </Space>
          }
        >
          {poolStats ? (
            <>
              <div className="grid grid-cols-2 gap-x-6 gap-y-3 md:grid-cols-4">
                {[
                  {
                    label: '状态',
                    value: poolStats.enabled ? (
                      <Tag color="success" className="mr-0">运行中</Tag>
                    ) : (
                      <Tag className="mr-0">已关闭</Tag>
                    ),
                  },
                  { label: '已登记指纹', value: String(poolStats.trackedSpecs) },
                  {
                    label: '空闲热进程',
                    value: (
                      <span className="font-mono">
                        {poolStats.idle} / {poolStats.maxTotal}
                      </span>
                    ),
                  },
                  { label: '每指纹上限', value: `${poolStats.size} 个` },
                  { label: 'TTL 销毁重建', value: fmtMs(poolStats.ttlMs) },
                  { label: '可领取成熟期', value: fmtMs(poolStats.readyMs) },
                  {
                    label: '保温巡检',
                    value: poolStats.keepaliveMs > 0 ? fmtMs(poolStats.keepaliveMs) : '已关闭',
                  },
                  {
                    label: '保温窗口',
                    value:
                      poolStats.keepaliveWindowMs > 0 ? fmtMs(poolStats.keepaliveWindowMs) : '永久',
                  },
                ].map((item) => (
                  <div key={item.label}>
                    <div className="text-[11px] text-gray-400">{item.label}</div>
                    <div className="mt-0.5 truncate text-[13px] text-gray-800">{item.value}</div>
                  </div>
                ))}
              </div>

              <div className="mt-5 border-t border-gray-100 pt-4">
                <div className="mb-3 flex items-center gap-1.5">
                  <SettingOutlined className="text-[13px] text-gray-500" />
                  <span className="text-[13px] font-medium text-gray-700">池参数</span>
                </div>
                <div className="grid grid-cols-2 gap-x-5 gap-y-4 md:grid-cols-3">
                  {POOL_FORM_FIELDS.map((f) => (
                    <div key={f.key}>
                      <div className="mb-1.5 text-xs font-medium text-gray-500">{f.label}</div>
                      <InputNumber
                        className="w-full"
                        precision={0}
                        min={f.min}
                        max={f.max}
                        value={poolForm ? poolForm[f.key] : undefined}
                        addonAfter={f.unit}
                        onChange={(v) =>
                          setPoolForm((prev) =>
                            prev ? ({ ...prev, [f.key]: v ?? f.min } as PoolForm) : prev,
                          )
                        }
                      />
                      <div className="mt-1 text-[10px] text-gray-400">{f.hint}</div>
                    </div>
                  ))}
                </div>
                <div className="mt-4 flex items-center justify-between">
                  <div className="rounded-lg bg-sky-50 px-3 py-2 text-[11px] leading-5 text-sky-700">
                    保存后立即生效并写入 .env，无需重启；缩小上限不会立刻杀进程，随 TTL
                    回收逐步收敛；TTL 新值对之后回收的进程生效。
                  </div>
                  <Button
                    type="primary"
                    size="small"
                    loading={poolSaving}
                    disabled={!poolForm}
                    onClick={handleSavePoolCfg}
                    className="ml-4 shrink-0"
                  >
                    保存并生效
                  </Button>
                </div>
              </div>

              <div className="mt-3">
                <ProTable<WarmPoolKey>
                  rowKey="key"
                  search={false}
                  options={false}
                  toolBarRender={false}
                  pagination={false}
                  size="small"
                  headerTitle="指纹列表"
                  columns={poolColumns}
                  dataSource={poolKeys}
                  loading={poolLoading}
                  scroll={{ x: 840 }}
                  locale={{ emptyText: '暂无已登记指纹（发生对话请求或启动预热后自动学习补位）' }}
                />
              </div>
            </>
          ) : (
            <div className="py-4 text-center text-xs text-gray-400">加载中…</div>
          )}
        </SectionCard>

        {/* ── 控制面 daemon 池 ───────────────────────────────────────────── */}
        <SectionCard
          title="控制面 daemon 池"
          accent={DAEMON_ACCENT}
          extra={
            <Space size={8}>
              <Popconfirm
                title="回收全部常驻 daemon？"
                description="下次模型/用量查询会自动重建（约 7s 初始化）"
                onConfirm={() => handleDropDaemon()}
              >
                <Button danger size="small" disabled={(daemonStats?.count ?? 0) === 0}>
                  回收全部
                </Button>
              </Popconfirm>
              <Button size="small" icon={<ReloadOutlined />} loading={daemonLoading} onClick={loadDaemon}>
                刷新
              </Button>
            </Space>
          }
        >
          {daemonStats ? (
            <>
              <div className="grid grid-cols-2 gap-x-6 gap-y-3 md:grid-cols-4">
                {[
                  {
                    label: '状态',
                    value: daemonStats.enabled ? (
                      <Tag color="success" className="mr-0">运行中</Tag>
                    ) : (
                      <Tag className="mr-0">已关闭</Tag>
                    ),
                  },
                  { label: '常驻 daemon', value: <span className="font-mono">{daemonStats.count}</span> },
                  { label: '空闲回收 TTL', value: fmtMs(daemonStats.ttlMs) },
                  {
                    label: '用途',
                    value: <span className="text-[12px]">模型目录 / 用量额度查询</span>,
                  },
                ].map((item) => (
                  <div key={item.label}>
                    <div className="text-[11px] text-gray-400">{item.label}</div>
                    <div className="mt-0.5 truncate text-[13px] text-gray-800">{item.value}</div>
                  </div>
                ))}
              </div>

              <div className="mt-5 border-t border-gray-100 pt-4">
                <div className="mb-3 flex items-center gap-1.5">
                  <SettingOutlined className="text-[13px] text-gray-500" />
                  <span className="text-[13px] font-medium text-gray-700">池参数</span>
                </div>
                <div className="flex flex-wrap items-end gap-5">
                  <div>
                    <div className="mb-1.5 text-xs font-medium text-gray-500">启用常驻池</div>
                    <Switch checked={daemonEnabled} onChange={setDaemonEnabled} />
                    <div className="mt-1 text-[10px] text-gray-400">
                      关闭后每次查询现起现用（约 7s 初始化）
                    </div>
                  </div>
                  <div className="w-56">
                    <div className="mb-1.5 text-xs font-medium text-gray-500">空闲回收 TTL</div>
                    <InputNumber
                      className="w-full"
                      precision={0}
                      min={10}
                      max={604800}
                      value={daemonTtlSec}
                      addonAfter="秒"
                      onChange={(v) => setDaemonTtlSec(v ?? 10)}
                    />
                    <div className="mt-1 text-[10px] text-gray-400">
                      空闲超过该时长自动回收，查询自动续期
                    </div>
                  </div>
                  <Button type="primary" size="small" loading={daemonSaving} onClick={handleSaveDaemonCfg}>
                    保存并生效
                  </Button>
                </div>
                <div className="mt-3 rounded-lg bg-emerald-50 px-3 py-2 text-[11px] leading-5 text-emerald-700">
                  每账号常驻一个 SDK daemon，模型目录与额度查询共用，免去每次约 7s 的
                  初始化（热查询 &lt;100ms）；保存立即生效并写入 .env，无需重启。
                </div>
              </div>

              <div className="mt-3">
                <ProTable<DaemonPoolEntry>
                  rowKey="key"
                  search={false}
                  options={false}
                  toolBarRender={false}
                  pagination={false}
                  size="small"
                  headerTitle="常驻条目"
                  columns={daemonColumns}
                  dataSource={daemonEntries}
                  loading={daemonLoading}
                  scroll={{ x: 670 }}
                  locale={{ emptyText: '暂无常驻 daemon（发生模型目录或用量查询后自动建立）' }}
                />
              </div>
            </>
          ) : (
            <div className="py-4 text-center text-xs text-gray-400">加载中…</div>
          )}
        </SectionCard>

        {/* ── 模型参数 ───────────────────────────────────────────────────── */}
        <SectionCard
          title="模型参数（全局默认）"
          accent={MODEL_ACCENT}
          extra={
            <Button size="small" icon={<ReloadOutlined />} onClick={loadModel}>
              刷新
            </Button>
          }
        >
          {modelDefaults ? (
            <>
              <div className="grid grid-cols-1 gap-x-5 gap-y-4 md:grid-cols-2 xl:grid-cols-4">
                <div>
                  <div className="mb-1.5 text-xs font-medium text-gray-500">思考深度</div>
                  <Select
                    className="w-full"
                    allowClear
                    placeholder="跟随请求 / 模型路由"
                    value={modelForm.reasoningEffort || undefined}
                    onChange={(v) => setModelForm((prev) => ({ ...prev, reasoningEffort: v ?? '' }))}
                    options={[
                      { value: 'low', label: 'low（更快）' },
                      { value: 'medium', label: 'medium（均衡）' },
                      { value: 'high', label: 'high（更深入）' },
                    ]}
                  />
                  <div className="mt-1 text-[10px] text-gray-400">留空 = 由请求或模型路由决定</div>
                </div>
                <div>
                  <div className="mb-1.5 text-xs font-medium text-gray-500">上下文窗口</div>
                  <InputNumber
                    className="w-full"
                    precision={0}
                    min={1024}
                    max={10_000_000}
                    placeholder="使用模型默认"
                    value={modelForm.contextWindow}
                    addonAfter="tokens"
                    onChange={(v) => setModelForm((prev) => ({ ...prev, contextWindow: v ?? undefined }))}
                  />
                  <div className="mt-1 text-[10px] text-gray-400">留空 = 使用模型默认窗口</div>
                </div>
                <div>
                  <div className="mb-1.5 text-xs font-medium text-gray-500">最大输出</div>
                  <InputNumber
                    className="w-full"
                    precision={0}
                    min={1}
                    max={1_000_000}
                    placeholder="使用模型默认"
                    value={modelForm.maxOutputTokens}
                    addonAfter="tokens"
                    onChange={(v) =>
                      setModelForm((prev) => ({ ...prev, maxOutputTokens: v ?? undefined }))
                    }
                  />
                  <div className="mt-1 text-[10px] text-gray-400">留空 = 不限制输出长度</div>
                </div>
                <div>
                  <div className="mb-1.5 text-xs font-medium text-gray-500">单请求超时</div>
                  <InputNumber
                    className="w-full"
                    precision={0}
                    min={1}
                    max={3600}
                    placeholder="600"
                    value={modelForm.timeoutSec}
                    addonAfter="秒"
                    onChange={(v) => setModelForm((prev) => ({ ...prev, timeoutSec: v ?? undefined }))}
                  />
                  <div className="mt-1 text-[10px] text-gray-400">CLI 子进程单请求上限，Agent 场景建议宽松</div>
                </div>
              </div>
              <div className="mt-4 flex items-center justify-between">
                <div className="rounded-lg bg-violet-50 px-3 py-2 text-[11px] leading-5 text-violet-700">
                  保存后立即生效并写入 .env，无需重启；密钥级 / 请求级设置优先于这里的全局默认。
                </div>
                <Button
                  type="primary"
                  size="small"
                  loading={modelSaving}
                  onClick={handleSaveModel}
                  className="ml-4 shrink-0"
                >
                  保存并生效
                </Button>
              </div>
            </>
          ) : (
            <div className="py-4 text-center text-xs text-gray-400">加载中…</div>
          )}
        </SectionCard>
      </div>
    </div>
  );
};

export default PoolsPage;
