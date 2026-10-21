export default [
  {
    path: '/user',
    layout: false,
    routes: [
      {
        name: '登录',
        path: '/user/login',
        component: './user/login',
      },
    ],
  },
  {
    path: '/',
    redirect: '/dashboard',
  },
  {
    name: '仪表盘',
    icon: 'dashboard',
    path: '/dashboard',
    component: './dashboard',
    access: 'canAdmin',
  },
  {
    name: '账号管理',
    icon: 'cloud',
    path: '/accounts',
    component: './accounts',
    access: 'canAdmin',
  },
  {
    name: '用户密钥',
    icon: 'team',
    path: '/users',
    component: './users',
    access: 'canAdmin',
  },
  {
    name: '用量记录',
    icon: 'barChart',
    path: '/usage',
    component: './usage',
    access: 'canAdmin',
  },
  {
    name: '测试对话',
    icon: 'comment',
    path: '/playground',
    component: './playground',
    access: 'canAdmin',
  },
  {
    name: '调用测试',
    icon: 'thunderbolt',
    path: '/api-test',
    component: './api-test',
  },
  {
    name: '进程池',
    icon: 'hdd',
    path: '/pools',
    component: './pools',
    access: 'canAdmin',
  },
  {
    name: '系统日志',
    icon: 'fileText',
    path: '/logs',
    component: './logs',
    access: 'canAdmin',
  },
  {
    name: '系统设置',
    icon: 'setting',
    path: '/settings',
    component: './settings',
    access: 'canAdmin',
  },
  {
    component: './exception/404',
    layout: false,
    path: '*',
  },
];
