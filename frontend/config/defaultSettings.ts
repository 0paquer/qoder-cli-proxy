import type { ProLayoutProps } from '@ant-design/pro-components';

/**
 * @name
 */
const Settings: ProLayoutProps & {
  logo?: string;
} = {
  navTheme: 'light',
  colorPrimary: '#4f46e5',
  layout: 'mix',
  contentWidth: 'Fluid',
  fixedHeader: true,
  fixSiderbar: true,
  colorWeak: false,
  title: 'Qoder CLI Proxy',
  logo:
    "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 48 48'><defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'><stop offset='0' stop-color='%234f46e5'/><stop offset='1' stop-color='%239333ea'/></linearGradient></defs><rect width='48' height='48' rx='10' fill='url(%23g)'/><text x='24' y='33' font-family='Arial,sans-serif' font-size='26' font-weight='bold' fill='white' text-anchor='middle'>Q</text></svg>",
  iconfontUrl: '',
  token: {
    // 参见ts声明，demo 见文档，通过token 修改样式
    //https://procomponents.ant.design/components/layout#%E9%80%9A%E8%BF%87-token-%E4%BF%AE%E6%94%B9%E6%A0%B7%E5%BC%8F
    pageContainer: {
      colorBgPageContainer: '#f4f6fb',
      // 内容留白由页面自身的 p-6 控制，避免 ProLayout 默认 40/32 再叠加
      paddingBlockPageContainerContent: 0,
      paddingInlinePageContainerContent: 0,
    },
    header: {
      heightLayoutHeader: 56,
      colorBgHeader: '#ffffff',
      colorHeaderTitle: '#111827',
      colorTextRightActionsItem: '#4b5563',
    },
    sider: {
      colorMenuBackground: '#ffffff',
      colorTextMenu: '#4b5563',
      colorTextMenuSelected: '#4f46e5',
      colorTextMenuActive: '#4f46e5',
      colorTextMenuItemHover: '#4f46e5',
      colorBgMenuItemHover: '#f4f6fb',
      colorBgMenuItemSelected: '#eef2ff',
      colorBgMenuItemActive: '#eef2ff',
    },
  },
};

export default Settings;
