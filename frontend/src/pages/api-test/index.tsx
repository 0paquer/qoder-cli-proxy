import {
  CheckCircleOutlined,
  CloseCircleOutlined,
  CodeOutlined,
  CopyOutlined,
  DatabaseOutlined,
  EditOutlined,
  FieldTimeOutlined,
  KeyOutlined,
  RobotOutlined,
  SendOutlined,
} from '@ant-design/icons';
import { Button, Input, Modal, Select, Tag, message } from 'antd';
import React, { useEffect, useRef, useState } from 'react';
import { PageHeader, SectionCard } from '@/components/QpCard';

interface ModelOption {
  id: string;
  name: string;
  rate?: number | null;
  isFree?: boolean;
}

/** 模型下拉标签：附 credit 倍率（rate=null 表示目录无数据，不显示）。 */
const modelLabel = (m: ModelOption) => {
  if (m.isFree) return `${m.name}（免费 · ${m.rate ?? '?'}x）`;
  if (m.rate != null) return `${m.name}（${m.rate}x）`;
  return m.name;
};

/** 默认选中：优先免费模型，其次 credit 倍率最低者；无倍率数据取第一个。 */
const pickDefaultModel = (list: ModelOption[]) => {
  const rated = list.filter((m) => m.rate != null);
  if (!rated.length) return list[0]?.id;
  const best = [...rated].sort((a, b) => {
    if (a.isFree !== b.isFree) return a.isFree ? -1 : 1;
    return (a.rate ?? 0) - (b.rate ?? 0);
  })[0];
  return best.id;
};

interface CallResult {
  ok: boolean;
  status: number;
  ms: number;
  usage: string;
  text: string;
}

/** API 密钥调用测试：浏览器直连同源 /v1/chat/completions，走完整网关链路。 */
const ApiTestPage: React.FC = () => {
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState<string>('qoder-cn');
  const [models, setModels] = useState<ModelOption[]>([]);
  const [modelsNote, setModelsNote] = useState<string>('');
  const [prompt, setPrompt] = useState('你好，请回复「调用成功」');
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<CallResult | null>(null);
  const [exampleOpen, setExampleOpen] = useState(false);
  // 用户手动选过模型后，密钥变化触发列表刷新不再覆盖其选择
  const userPickedRef = useRef(false);

  // 密钥防抖：停止输入 600ms 后按当前密钥重新加载模型列表
  const [debouncedKey, setDebouncedKey] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedKey(apiKey.trim()), 600);
    return () => clearTimeout(timer);
  }, [apiKey]);

  // 模型列表来自网关 /v1/models：带密钥时返回该密钥可用账号的真实模型
  useEffect(() => {
    if (!debouncedKey) {
      setModelsNote('');
      return;
    }
    let cancelled = false;
    setModelsNote('加载中…');
    fetch('/v1/models', { headers: { Authorization: `Bearer ${debouncedKey}` } })
      .then(async (r) => {
        const d = await r.json().catch(() => null);
        if (cancelled) return;
        if (!r.ok) {
          setModelsNote(`加载失败：HTTP ${r.status} ${d?.error?.message ?? ''}`.trim());
          return;
        }
        const list: ModelOption[] = (d?.data ?? []).map((m: any) => ({
          id: String(m.id),
          name: String(m.name || m.id),
          rate: typeof m.rate === 'number' ? m.rate : null,
          isFree: Boolean(m.is_free),
        }));
        if (!list.length) {
          setModelsNote('该密钥暂无可用模型（检查账号授权与验证状态）');
          return;
        }
        setModels(list);
        setModelsNote(d?.source === 'account' ? `已按密钥加载 ${list.length} 个可用模型` : '');
        // 默认选中低倍率模型（免费优先，省 credits）；用户手动选过则保留
        setModel((cur) =>
          userPickedRef.current && list.some((m) => m.id === cur)
            ? cur
            : (pickDefaultModel(list) ?? cur),
        );
      })
      .catch(() => {
        if (!cancelled) setModelsNote('模型列表加载失败（网络错误）');
      });
    return () => {
      cancelled = true;
    };
  }, [debouncedKey]);

  // 发送中重入保护：ref 同步读取，防输入框回车/双击在同帧内并发触发 run
  const sendingRef = useRef(false);

  const run = async () => {
    if (sendingRef.current) return;
    const key = apiKey.trim();
    if (!key) {
      message.warning('请输入 API 密钥');
      return;
    }
    sendingRef.current = true;
    setSending(true);
    setResult(null);
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 180_000);
    try {
      const res = await fetch('/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model,
          stream: false,
          messages: [{ role: 'user', content: prompt || 'ping' }],
        }),
        signal: controller.signal,
      });
      const ms = Date.now() - started;
      const raw = await res.text();
      let text = raw;
      let usage = '';
      try {
        const body = JSON.parse(raw);
        if (res.ok) {
          text = body?.choices?.[0]?.message?.content ?? raw;
          const u = body?.usage;
          if (u) {
            usage = `输入 ${u.prompt_tokens ?? '-'} / 输出 ${u.completion_tokens ?? '-'} tokens`;
          }
        } else {
          text = body?.error?.message ?? body?.message ?? raw;
        }
      } catch {
        /* 非 JSON 响应保留原文 */
      }
      setResult({ ok: res.ok, status: res.status, ms, usage, text });
    } catch (e: any) {
      setResult({
        ok: false,
        status: 0,
        ms: Date.now() - started,
        usage: '',
        text: e?.name === 'AbortError' ? '请求超时（180s），可稍后重试' : e?.message || '网络错误',
      });
    } finally {
      clearTimeout(timer);
      setSending(false);
    }
  };

  // ── 调用示例：随表单填写动态生成 ───────────────────────────────────────────
  const copyText = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      message.success(`${label}已复制`);
    } catch {
      message.error('复制失败，请手动选择复制');
    }
  };

  const effectiveKey = apiKey.trim() || 'qk-你的API密钥';
  const effectivePrompt = prompt.trim() || '你好';
  const callUrl = `${window.location.origin}/v1/chat/completions`;
  const bodyJson = JSON.stringify(
    { model, stream: false, messages: [{ role: 'user', content: effectivePrompt }] },
    null,
    2,
  );
  const curlCommand = [
    `curl -X POST "${callUrl}" \\`,
    `  -H "Authorization: Bearer ${effectiveKey}" \\`,
    '  -H "Content-Type: application/json" \\',
    `  -d '${bodyJson}'`,
  ].join('\n');

  const ExampleBlock: React.FC<{ label: string; text: string; copyLabel: string }> = ({
    label,
    text,
    copyLabel,
  }) => (
    <div>
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-xs font-medium text-gray-500">{label}</span>
        <Button
          type="text"
          size="small"
          icon={<CopyOutlined />}
          className="text-xs text-gray-400"
          onClick={() => copyText(text, copyLabel)}
        >
          复制
        </Button>
      </div>
      <pre className="max-h-72 overflow-auto rounded-lg border border-gray-100 bg-gray-50 p-4 font-mono text-[12px] leading-5 break-all whitespace-pre-wrap text-gray-800">
        {text}
      </pre>
    </div>
  );

  return (
    <div className="p-6">
      <PageHeader
        title="调用测试"
        description="使用 API 密钥走真实网关链路（鉴权 → 调度 → 配额）验证调用可用性"
      />
      <SectionCard title="测试请求" accent="#4f46e5">
        <div className="rounded-xl border border-gray-100 bg-[#f8f9fe] p-4">
          <div className="flex flex-wrap items-start gap-3">
            <div className="min-w-[280px] flex-1">
              <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-gray-500">
                <KeyOutlined className="text-indigo-400" />
                API 密钥
              </div>
              <Input
                placeholder="qk-..."
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                onPressEnter={run}
                autoComplete="off"
              />
            </div>
            <div className="w-64">
              <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-gray-500">
                <RobotOutlined className="text-indigo-400" />
                模型
              </div>
              <Select
                className="w-full"
                value={model}
                onChange={(v) => {
                  userPickedRef.current = true;
                  setModel(v);
                }}
                options={(models.length ? models : [{ id: 'qoder-cn', name: 'qoder-cn' }]).map(
                  (m) => ({ value: m.id, label: modelLabel(m) }),
                )}
              />
              {modelsNote ? (
                <div className="mt-1 text-xs text-gray-400">{modelsNote}</div>
              ) : null}
            </div>
          </div>
          <div className="mt-3">
            <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-gray-500">
              <EditOutlined className="text-indigo-400" />
              提示词
            </div>
            <Input.TextArea
              rows={3}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="发送给模型的消息"
            />
          </div>
          <div className="mt-3 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Button type="primary" icon={<SendOutlined />} loading={sending} onClick={run}>
                发送测试
              </Button>
              <Button icon={<CodeOutlined />} onClick={() => setExampleOpen(true)}>
                调用示例
              </Button>
            </div>
            <span className="text-xs text-gray-400">
              非流式单轮对话；密钥可在「用户密钥」页生成或查看
            </span>
          </div>
        </div>
      </SectionCard>

      <Modal
        title="调用示例"
        open={exampleOpen}
        onCancel={() => setExampleOpen(false)}
        footer={null}
        width={880}
        styles={{ body: { maxHeight: '70vh', overflowY: 'auto', paddingTop: 12 } }}
      >
        <div className="mb-3 text-xs text-gray-400">随上方填写内容实时更新</div>
        <div className="space-y-4">
          <ExampleBlock label="调用地址" text={`POST ${callUrl}`} copyLabel="调用地址" />
          <ExampleBlock
            label="请求头"
            text={`Authorization: Bearer ${effectiveKey}\nContent-Type: application/json`}
            copyLabel="请求头"
          />
          <ExampleBlock label="请求体（JSON）" text={bodyJson} copyLabel="请求体" />
          <ExampleBlock label="cURL 命令" text={curlCommand} copyLabel="cURL 命令" />
        </div>
      </Modal>

      <div className="mt-5">
        <SectionCard
          title="调用结果"
          accent={result ? (result.ok ? '#10b981' : '#ef4444') : '#4f46e5'}
        >
          {result ? (
            <>
              <div className="mb-3 flex flex-wrap items-center gap-2">
                {result.ok ? (
                  <Tag icon={<CheckCircleOutlined />} color="success">
                    成功 · HTTP {result.status}
                  </Tag>
                ) : (
                  <Tag icon={<CloseCircleOutlined />} color="error">
                    失败{result.status ? ` · HTTP ${result.status}` : ' · 网络错误'}
                  </Tag>
                )}
                <Tag icon={<FieldTimeOutlined />}>{(result.ms / 1000).toFixed(1)}s</Tag>
                {result.usage ? (
                  <Tag icon={<DatabaseOutlined />} color="geekblue">
                    {result.usage}
                  </Tag>
                ) : null}
              </div>
              <pre className="max-h-96 overflow-auto rounded-lg border border-gray-100 bg-gray-50 p-4 font-mono text-[12px] leading-5 whitespace-pre-wrap text-gray-800">
                {result.text}
              </pre>
            </>
          ) : (
            <div className="flex flex-col items-center justify-center gap-2.5 py-10 text-center">
              <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-500 to-purple-500 text-[18px] text-white shadow-[0_8px_20px_rgba(99,102,241,0.35)]">
                <CodeOutlined />
              </div>
              <div className="text-[13px] text-gray-400">
                填写上方表单并发送后，这里会展示网关返回结果
              </div>
            </div>
          )}
        </SectionCard>
      </div>
    </div>
  );
};

export default ApiTestPage;
