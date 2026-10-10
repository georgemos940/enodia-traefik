// Every page, in sidebar order. A page module's default export:
//   {
//     render(ctx) -> { el, update?(event, data), destroy?() }
//   }
// ctx: { params: [...route groups], query: URLSearchParams, setCrumbs([[label, href?], ...]) }
// `route` matches the hash path without "#/" (default: the id); its groups become ctx.params.

export const PAGES = [
  { id: 'overview', title: 'Overview', icon: 'overview', group: '', route: /^(?:overview)?$/, load: () => import('./overview.js') },

  { id: 'routers', title: 'Routers', icon: 'router', group: 'Configuration', route: /^routers(?:\/(http|tcp|udp)\/(.+))?$/, load: () => import('./routers.js') },
  { id: 'services', title: 'Services', icon: 'service', group: 'Configuration', route: /^services(?:\/(http|tcp|udp)\/(.+))?$/, load: () => import('./services.js') },
  { id: 'middlewares', title: 'Middlewares', icon: 'middleware', group: 'Configuration', route: /^middlewares(?:\/(http|tcp)\/(.+))?$/, load: () => import('./middlewares.js') },
  { id: 'entrypoints', title: 'Entry points', icon: 'entrypoint', group: 'Configuration', route: /^entrypoints(?:\/(.+))?$/, load: () => import('./entrypoints.js') },
  { id: 'topology', title: 'Topology', icon: 'topology', group: 'Configuration', load: () => import('./topology.js') },

  { id: 'traffic', title: 'Live traffic', icon: 'traffic', group: 'Observe', load: () => import('./traffic.js') },
  { id: 'logs', title: 'Access log', icon: 'logs', group: 'Observe', load: () => import('./logs.js') },
  { id: 'certificates', title: 'Certificates', icon: 'cert', group: 'Observe', load: () => import('./certificates.js') },
  { id: 'health', title: 'Health checks', icon: 'health', group: 'Observe', load: () => import('./health.js') },
  { id: 'changes', title: 'Change history', icon: 'history', group: 'Observe', load: () => import('./changes.js') },

  { id: 'tester', title: 'Route tester', icon: 'tester', group: 'Tools', load: () => import('./tester.js') },
  { id: 'config', title: 'Static config', icon: 'config', group: 'Tools', load: () => import('./config.js') },
  { id: 'explorer', title: 'API explorer', icon: 'code', group: 'Tools', load: () => import('./explorer.js') },
  { id: 'settings', title: 'Setup & about', icon: 'layers', group: 'Tools', load: () => import('./settings.js') },
];
