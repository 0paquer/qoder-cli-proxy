import {
  DeleteOutlined,
  FireOutlined,
  PlusOutlined,
  ReloadOutlined,
  UndoOutlined,
} from '@ant-design/icons';
import type { ProColumns } from '@ant-design/pro-components';
import { ProTable } from '@ant-design/pro-components';
import { Button, Input, InputNumber, Modal, Popconfirm, Select, Space, Tag, message } from 'antd';
import React, { useEffect, useState } from 'react';
import { PageHeader, SectionCard } from '@/components/QpCard';
import {
  clearWarmPool,
  evictWarmPool,
  getEnvConfig,
  getRuntimeStatus,
  getWarmPool,
  prewarmWarmPool,
  restartServer,
  updateEnv,
  type RuntimeStatus,
  type WarmPoolKey,
  type WarmPoolStats,
} from '@/services/qoderproxy';

const ENV_ACCENT = '#9333ea';
const STATUS_ACCENT = '#f59e0b';
const POOL_ACCENT = '#0ea5e9';
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

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

/** 已由其他模块接管、不在设置页暴露的配置项 */
const HIDDEN_ENV_PREFIXES = [/^QODERCN_/]; // 接入参数已迁移至 API Key 维度（用户密钥页配置）
const HIDDEN_ENV_KEYS = new Set([
  'ADMIN_USERNAME', // 遗留变量：登录账号在「用户密钥」页管理，改此值不生效
  'ADMIN_PASSWORD',
]);

/** 已知变量的元信息：中文名、说明、控件类型 */
const ENV_META: Record<string, { label: string; desc: string; type?: 'enum' | 'number'; options?: string[] }> = {
  BIND_HOST: { label: '监听地址', desc: '0.0.0.0 允许局域网访问；127.0.0.1 仅本机' },
  CLI_BACKEND: { label: 'CLI 线路', desc: 'cn=国内版；global=国际版', type: 'enum', options: ['cn', 'global'] },
  PORT: { label: '监听端口', desc: 'HTTP 端口（1-65535），保存后自动重启生效', type: 'number' },
};

/** 值含敏感语义的变量用密码框展示（主要覆盖自定义变量） */
const isSecretKey = (key: string) => /TOKEN|KEY|SECRET|PASSWORD|PAT/i.test(key);

const formatUptime = (seconds: number) => {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (d > 0) return `${d}天${h}小时`;
  if (h > 0) return `${h}小时${m}分`;
  if (m > 0) return `${m}分${s}秒`;
  return `${s}秒`;
};

const SettingsPage: React.FC = () => {
  const [envConfig, setEnvConfig] = useState<Record<string, string>>({});
  const [original, setOriginal] = useState<Record<string, string>>({});
  const [pendingDeletes, setPendingDeletes] = useState<string[]>([]);
  const [search, setSearch] = useState('');
  const [envSaving, setEnvSaving] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [newKeyInput, setNewKeyInput] = useState('');
  const [newValueInput, setNewValueInput] = useState('');
  const [status, setStatus] = useState<RuntimeStatus | null>(null);
  const [poolStats, setPoolStats] = useState<WarmPoolStats | null>(null);
  const [poolKeys, setPoolKeys] = useState<WarmPoolKey[]>([]);
  const [poolLoading, setPoolLoading] = useState(false);

  const load = async () => {
    try {
      const envRes = await getEnvConfig();
      const config = envRes.config || {};
      setEnvConfig(config);
      setOriginal(config);
    } catch {
      /* 错误提示由全局 errorHandler 处理 */
    }
  };

  const loadStatus = async () => {
    try {
      const res = await getRuntimeStatus();
      setStatus(res.status ?? null);
    } catch {
      /* 状态卡加载失败静默，可手动刷新 */
    }
  };

  const loadPool = async () => {
    setPoolLoading(true);
    try {
      const res = await getWarmPool();
      setPoolStats(res.stats);
      setPoolKeys(res.keys);
    } catch {
      /* 热池卡加载失败静默，可手动刷新 */
    } finally {
      setPoolLoading(false);
    }
  };

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

  useEffect(() => {
    load();
    loadStatus();
    loadPool();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── 脏值计算 ──────────────────────────────────────────────────────────────
  const changedKeys = Object.keys(envConfig).filter(
    (k) => !(k in original) || envConfig[k] !== original[k],
  );
  const changedExistingCount = changedKeys.filter((k) => k in original).length;
  const newCount = changedKeys.length - changedExistingCount;
  const hasChanges = changedKeys.length > 0 || pendingDeletes.length > 0;

  const visibleEntries = Object.entries(envConfig)
    .filter(
      ([key]) =>
        !HIDDEN_ENV_KEYS.has(key) && !HIDDEN_ENV_PREFIXES.some((re) => re.test(key)),
    )
    .filter(([key]) => {
      const q = search.trim().toLowerCase();
      if (!q) return true;
      const meta = ENV_META[key];
      return (
        key.toLowerCase().includes(q) || (meta?.label || '').toLowerCase().includes(q)
      );
    });

  // ── 行为 ─────────────────────────────────────────────────────────────────
  const handleSaveEnv = async () => {
    if (!hasChanges) return;
    if (changedKeys.includes('PORT')) {
      const port = Number(envConfig.PORT);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        message.error('PORT 必须为 1-65535 的整数');
        return;
      }
    }
    setEnvSaving(true);
    try {
      const updates = Object.fromEntries(
        changedKeys.map((k) => [k, String(envConfig[k] ?? '')]),
      );
      await updateEnv(updates, pendingDeletes);
      message.success('已保存，服务正在重启，请稍后刷新页面查看最新状态');
      setOriginal(envConfig);
      setPendingDeletes([]);
    } catch (error: any) {
      message.error(error?.message || '保存失败');
    } finally {
      setEnvSaving(false);
    }
  };

  const revertKey = (key: string) => {
    setEnvConfig((prev) => {
      const next = { ...prev };
      if (!(key in original)) {
        delete next[key]; // 新增变量：还原即移除
      } else {
        next[key] = original[key];
      }
      return next;
    });
  };

  const revertAll = () => {
    setEnvConfig({ ...original });
    setPendingDeletes([]);
  };

  const handleDelete = (key: string) => {
    if (!(key in original)) {
      setEnvConfig((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
      return;
    }
    setPendingDeletes((prev) => [...prev, key]);
    setEnvConfig((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  };

  const undoDelete = (key: string) => {
    setPendingDeletes((prev) => prev.filter((k) => k !== key));
    setEnvConfig((prev) => ({ ...prev, [key]: original[key] ?? '' }));
  };

  const handleAdd = () => {
    const key = newKeyInput.trim();
    if (!ENV_KEY_RE.test(key)) {
      message.warning('变量名仅允许字母、数字与下划线，且不以数字开头');
      return;
    }
    if (key in envConfig) {
      message.warning('该变量已存在');
      return;
    }
    // 重新添加一个"待删除"的原有变量：撤出删除集合，否则保存时 updates/deletes 会冲突
    setPendingDeletes((prev) => prev.filter((k) => k !== key));
    setEnvConfig((prev) => ({ ...prev, [key]: newValueInput }));
    setAddOpen(false);
    setNewKeyInput('');
    setNewValueInput('');
  };

  const handleRestart = async () => {
    try {
      await restartServer({});
      message.info('重启指令已发送，服务正在重启，请稍候刷新页面');
    } catch {
      message.info('重启指令已发送（服务响应中断属正常现象），请稍候刷新页面');
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

  // ── 渲染 ─────────────────────────────────────────────────────────────────
  const renderControl = (key: string, value: string) => {
    const meta = ENV_META[key];
    if (meta?.type === 'enum') {
      return (
        <Select
          className="w-full font-mono text-[12px]"
          value={value}
          onChange={(v) => setEnvConfig((prev) => ({ ...prev, [key]: v }))}
          options={(meta.options || []).map((v) => ({ value: v, label: v }))}
        />
      );
    }
    if (meta?.type === 'number') {
      return (
        <InputNumber
          className="w-full font-mono text-[12px]"
          value={value === '' ? undefined : Number(value)}
          min={key === 'PORT' ? 1 : undefined}
          max={key === 'PORT' ? 65535 : undefined}
          precision={0}
          onChange={(v) => setEnvConfig((prev) => ({ ...prev, [key]: v == null ? '' : String(v) }))}
        />
      );
    }
    if (isSecretKey(key)) {
      return (
        <Input.Password
          className="font-mono text-[12px]"
          value={value ?? ''}
          autoComplete="new-password"
          onChange={(e) => setEnvConfig((prev) => ({ ...prev, [key]: e.target.value }))}
        />
      );
    }
    return (
      <Input
        className="font-mono text-[12px]"
        value={value ?? ''}
        autoComplete="off"
        onChange={(e) => setEnvConfig((prev) => ({ ...prev, [key]: e.target.value }))}
      />
    );
  };

  return (
    <div className="p-6">
      <PageHeader
        title="系统设置"
        description="环境变量与服务生命周期管理，改动保存后自动重启生效"
      />
      <div className="flex flex-col gap-5">
        <SectionCard
          title="环境变量"
          accent={ENV_ACCENT}
          extra={
            <div className="flex items-center gap-2">
              <Input
                size="small"
                allowClear
                placeholder="搜索变量名"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-36"
              />
              <Button size="small" icon={<PlusOutlined />} onClick={() => setAddOpen(true)}>
                新增变量
              </Button>
              <Button
                type="primary"
                size="small"
                loading={envSaving}
                disabled={!hasChanges}
                onClick={handleSaveEnv}
              >
                保存全部
              </Button>
            </div>
          }
        >
          {hasChanges && (
            <div className="mb-3 flex items-center justify-between rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700">
              <span>
                {changedExistingCount > 0 && `${changedExistingCount} 项已修改`}
                {newCount > 0 && `${changedExistingCount > 0 ? ' · ' : ''}${newCount} 项新增`}
                {pendingDeletes.length > 0 &&
                  `${changedKeys.length > 0 ? ' · ' : ''}${pendingDeletes.length} 项待删除`}
                ，保存后服务将自动重启生效
              </span>
              <Button type="text" size="small" className="text-xs text-amber-700" onClick={revertAll}>
                全部还原
              </Button>
            </div>
          )}
          <div className="grid grid-cols-1 gap-2 xl:grid-cols-2">
            {visibleEntries.map(([key, value]) => {
              const meta = ENV_META[key];
              const isNew = !(key in original);
              const isDirty = isNew || value !== original[key];
              const isPendingDelete = pendingDeletes.includes(key);
              return (
                <div
                  key={key}
                  className={`flex items-start gap-3 rounded-lg px-3 py-2.5 transition-colors ${
                    isPendingDelete
                      ? 'bg-red-50/70'
                      : isDirty
                        ? 'bg-amber-50/80'
                        : 'bg-gray-50/80 hover:bg-gray-50'
                  }`}
                >
                  <div className="w-60 min-w-0 shrink-0 pt-0.5">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate font-mono text-[12px] text-gray-700" title={key}>
                        {key}
                      </span>
                      {isNew && (
                        <Tag color="processing" className="mr-0 shrink-0 text-[10px] leading-4">
                          新增
                        </Tag>
                      )}
                      {isPendingDelete && (
                        <Tag color="error" className="mr-0 shrink-0 text-[10px] leading-4">
                          待删除
                        </Tag>
                      )}
                      {isDirty && !isNew && !isPendingDelete && (
                        <span className="shrink-0 text-[10px] text-amber-600">已修改</span>
                      )}
                    </div>
                    <div className="mt-0.5 text-[11px] leading-4 text-gray-400">
                      {meta ? `${meta.label} · ${meta.desc}` : '自定义环境变量'}
                    </div>
                  </div>
                  <div className="min-w-0 flex-1 pt-0.5">
                    {isPendingDelete ? (
                      <div className="truncate font-mono text-[12px] text-gray-400 line-through">
                        {original[key]}
                      </div>
                    ) : (
                      renderControl(key, value)
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-0.5 pt-0.5">
                    {isPendingDelete ? (
                      <Button
                        type="text"
                        size="small"
                        icon={<UndoOutlined />}
                        className="text-xs text-gray-500"
                        onClick={() => undoDelete(key)}
                      >
                        撤销
                      </Button>
                    ) : (
                      <>
                        {isDirty && (
                          <Button
                            type="text"
                            size="small"
                            icon={<UndoOutlined />}
                            className="text-xs text-gray-400"
                            title="还原修改"
                            onClick={() => revertKey(key)}
                          />
                        )}
                        <Popconfirm title={`删除 ${key}？`} onConfirm={() => handleDelete(key)}>
                          <Button
                            type="text"
                            size="small"
                            danger
                            icon={<DeleteOutlined />}
                            title="删除变量"
                          />
                        </Popconfirm>
                      </>
                    )}
                  </div>
                </div>
              );
            })}
            {visibleEntries.length === 0 && (
              <div className="col-span-full py-8 text-center text-xs text-gray-400">
                {search ? '没有匹配的变量' : '暂无可见环境变量'}
              </div>
            )}
          </div>
        </SectionCard>

        <SectionCard
          title="运行状态"
          accent={STATUS_ACCENT}
          extra={
            <Button size="small" icon={<ReloadOutlined />} onClick={loadStatus}>
              刷新
            </Button>
          }
        >
          {status ? (
            <div className="grid grid-cols-2 gap-x-6 gap-y-3 md:grid-cols-4">
              {[
                { label: '服务版本', value: status.version ? `v${status.version}` : '-' },
                { label: 'Node 版本', value: status.nodeVersion },
                { label: '运行时长', value: formatUptime(status.uptimeSeconds) },
                { label: '启动时间', value: new Date(status.startedAt).toLocaleString() },
                { label: '监听地址', value: `${status.bindHost}:${status.port}` },
                { label: '进程 PID', value: String(status.pid) },
                {
                  label: 'CLI 线路',
                  value:
                    status.cliBackend === 'global' ? (
                      <Tag color="purple" className="mr-0">国际版</Tag>
                    ) : (
                      <Tag color="cyan" className="mr-0">国内版</Tag>
                    ),
                },
              ].map((item) => (
                <div key={item.label}>
                  <div className="text-[11px] text-gray-400">{item.label}</div>
                  <div className="mt-0.5 truncate text-[13px] text-gray-800" title={typeof item.value === 'string' ? item.value : undefined}>
                    {item.value}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="py-4 text-center text-xs text-gray-400">加载中…</div>
          )}
          <div className="mt-5 flex items-center justify-between border-t border-gray-100 pt-4">
            <div className="text-xs text-gray-400">
              参数修改保存后会自动重启，一般无需手动操作；手动重启将中断进行中的请求。
            </div>
            <Popconfirm title="确认重启代理服务？" onConfirm={handleRestart}>
              <Button danger>重启服务</Button>
            </Popconfirm>
          </div>
        </SectionCard>

        <SectionCard
          title="预热进程池"
          accent={POOL_ACCENT}
          extra={
            <Button size="small" icon={<ReloadOutlined />} onClick={loadPool}>
              刷新
            </Button>
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
                      poolStats.keepaliveWindowMs > 0
                        ? fmtMs(poolStats.keepaliveWindowMs)
                        : '永久',
                  },
                ].map((item) => (
                  <div key={item.label}>
                    <div className="text-[11px] text-gray-400">{item.label}</div>
                    <div className="mt-0.5 truncate text-[13px] text-gray-800">{item.value}</div>
                  </div>
                ))}
              </div>

              <div className="mt-5 flex items-center justify-between border-t border-gray-100 pt-4">
                <div className="text-xs text-gray-400">
                  按「账号 × 流式/推理参数」指纹保温；TTL 到期销毁的同时自动重建，驱逐后由下次请求重新学习。
                </div>
                <Space size={8}>
                  <Popconfirm
                    title="清空整个热池？"
                    description="杀掉全部空闲热进程并停止所有保温，下次请求重新冷启动学习"
                    onConfirm={handleClearPool}
                  >
                    <Button danger size="small">清空热池</Button>
                  </Popconfirm>
                  <Button
                    type="primary"
                    size="small"
                    icon={<FireOutlined />}
                    onClick={() => handlePrewarm()}
                  >
                    立即预热全部
                  </Button>
                </Space>
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
      </div>

      <Modal
        title="新增环境变量"
        open={addOpen}
        onCancel={() => setAddOpen(false)}
        onOk={handleAdd}
        okText="添加"
        width={480}
        destroyOnHidden
      >
        <div className="space-y-3 pt-1">
          <div>
            <div className="mb-1.5 text-xs font-medium text-gray-500">变量名</div>
            <Input
              placeholder="例如 ENABLE_CACHE"
              value={newKeyInput}
              onChange={(e) => setNewKeyInput(e.target.value)}
              onPressEnter={handleAdd}
              autoComplete="off"
            />
          </div>
          <div>
            <div className="mb-1.5 text-xs font-medium text-gray-500">值</div>
            <Input.TextArea
              rows={2}
              placeholder="变量值"
              value={newValueInput}
              onChange={(e) => setNewValueInput(e.target.value)}
            />
          </div>
          <div className="text-[11px] text-gray-400">
            变量名仅允许字母、数字与下划线，且不以数字开头；保存后服务自动重启生效。
          </div>
        </div>
      </Modal>
    </div>
  );
};

export default SettingsPage;
