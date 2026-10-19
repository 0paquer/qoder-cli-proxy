import React from 'react';

const GRADIENT_END = '#9333ea';

/** 统一页头：标题 + 描述 + 右侧页面级操作（如仪表盘的全局刷新；表格操作一律进 ProTable 工具栏）。 */
export const PageHeader: React.FC<{
  title: React.ReactNode;
  description?: React.ReactNode;
  extra?: React.ReactNode;
}> = ({ title, description, extra }) => (
  <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
    <div>
      <h1 className="text-[20px] font-semibold leading-7 text-gray-900">{title}</h1>
      {description ? <p className="mt-1 text-[13px] text-gray-500">{description}</p> : null}
    </div>
    {extra ? <div className="flex flex-wrap items-center gap-2">{extra}</div> : null}
  </div>
);

/** 统一卡片模板：白底 10px 圆角 + hover 软阴影。 */
export const SectionCard: React.FC<{
  title: React.ReactNode;
  extra?: React.ReactNode;
  accent?: string;
  bodyClassName?: string;
  children: React.ReactNode;
}> = ({ title, extra, bodyClassName, children }) => (
  <section className="overflow-hidden rounded-[10px] border border-gray-100/80 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.04)] transition-all hover:shadow-[0_10px_28px_rgba(15,23,42,0.07)]">
    <div className="flex flex-wrap items-center justify-between gap-2 px-5 pb-3 pt-4">
      <span className="text-[15px] font-semibold text-gray-800">{title}</span>
      {extra}
    </div>
    <div className={bodyClassName ?? 'px-5 pb-5'}>{children}</div>
  </section>
);

/** 概览指标卡：渐变图标徽章。 */
export const StatCard: React.FC<{
  label: string;
  value: React.ReactNode;
  hint?: React.ReactNode;
  accent?: string;
  icon?: React.ReactNode;
}> = ({ label, value, hint, accent = '#4f46e5', icon }) => (
  <div className="relative overflow-hidden rounded-[10px] border border-gray-100/80 bg-white px-5 py-4 shadow-[0_1px_2px_rgba(15,23,42,0.04)] transition-all hover:-translate-y-0.5 hover:shadow-[0_10px_24px_rgba(15,23,42,0.08)]">
    <div className="flex items-center justify-between gap-2">
      <div className="text-[13px] font-medium text-gray-500">{label}</div>
      {icon ? (
        <div
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[15px] text-white"
          style={{ background: `linear-gradient(135deg, ${accent}, ${GRADIENT_END})` }}
        >
          {icon}
        </div>
      ) : null}
    </div>
    <div className="mt-1.5 text-[26px] font-semibold leading-8 text-gray-900">{value}</div>
    {hint ? <div className="mt-1 text-[12px] text-gray-400">{hint}</div> : null}
  </div>
);
